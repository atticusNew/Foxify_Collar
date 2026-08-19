/**
 * PAYOUT LEDGER — the persistent record of what each trader is owed and what has been paid.
 *
 * Every concluded wrap cycle (expiry / knockout / early close) accrues EXACTLY ONE entry here, and
 * an entry can be paid EXACTLY ONCE — the ledger is the idempotency boundary between "the engine
 * concluded a cycle" and "USDC left the hot wallet". Statuses:
 *
 *   accrued   → owed, not yet picked up
 *   queued    → picked up by a payout pass (persisted BEFORE the send fires, so a crash mid-send
 *               leaves a visible queued row that is NEVER auto-resent — see processPayoutLedger)
 *   paid      → the send succeeded (tx broadcast)
 *   confirmed → the send is final (receipt / simulated)
 *   failed    → the send failed; auto-retried only when the sender GUARANTEED nothing went out
 *               (retriable), otherwise held for manual on-chain verification + requeuePayout
 *
 * STRUCTURAL third-party protection (approved decision 5): the payout address is not a parameter —
 * accrueWrapPayout derives it from the wrap record's verified position-owner account, so no caller
 * can route a payout anywhere else.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";
import type { CyclePayable, DemoWrapRecord } from "../demoWrap";

const round2 = (x: number) => +x.toFixed(2);

export const DEFAULT_PAYOUT_LEDGER_PATH = process.env.DEMO_PAYOUT_LEDGER_PATH ?? "./logs/demo-payout-ledger.json";

export type PayoutStatus = "accrued" | "queued" | "paid" | "confirmed" | "failed";

export type PayoutEntry = {
  /** = wrap id: a wrap concludes exactly once, so the id doubles as the idempotency key. */
  id: string;
  wrapId: string;
  /** The verified HL position owner — the ONLY address this entry can ever pay. */
  account: string;
  amountUsdc: number;
  reason: CyclePayable["kind"];
  creditUsdc: number;
  floorPayoutUsdc: number;
  status: PayoutStatus;
  attempts: number;
  /** Set when a failed send is safe to retry automatically (sender guaranteed nothing broadcast). */
  retriable: boolean;
  txHash: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  paidAtMs: number | null;
  notes: string[];
};

// ── Store (JSON array, same convention as the wrap store) ─────────────────────

export const loadPayoutLedger = (path = DEFAULT_PAYOUT_LEDGER_PATH): PayoutEntry[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PayoutEntry[]) : [];
  } catch {
    return [];
  }
};

export const savePayoutLedger = (entries: PayoutEntry[], path = DEFAULT_PAYOUT_LEDGER_PATH): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(entries, null, 1), "utf8");
  } catch (e) {
    console.error(`[payout-ledger] save failed: ${(e as Error).message}`);
  }
};

// ── Status transitions (an entry can never be paid twice) ─────────────────────

const ALLOWED: Record<PayoutStatus, PayoutStatus[]> = {
  accrued: ["queued"],
  queued: ["paid", "failed"],
  paid: ["confirmed"],
  confirmed: [],
  failed: ["queued", "accrued"] // accrued = manual requeue after on-chain verification
};

/** Apply a status transition or refuse it. Refusals are the double-pay guard — never bypass. */
export const transitionPayout = (entry: PayoutEntry, to: PayoutStatus, nowMs: number, note?: string): boolean => {
  if (!ALLOWED[entry.status].includes(to)) return false;
  entry.status = to;
  entry.updatedAtMs = nowMs;
  if (note) entry.notes.push(note);
  return true;
};

// ── Accrual (idempotent per wrap) ─────────────────────────────────────────────

const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

export type AccrualResult =
  | { ok: true; entry: PayoutEntry; created: boolean }
  | { ok: false; reason: string };

/**
 * Accrue the payable for a concluded wrap. Idempotent: a second call for the same wrap returns the
 * existing entry untouched. The payout address is the record's account, period. Dust below one
 * cent is skipped (nothing to send). Mutates `entries` in place; the caller persists.
 */
export const accrueWrapPayout = (
  entries: PayoutEntry[],
  rec: DemoWrapRecord,
  payable: CyclePayable,
  nowMs: number
): AccrualResult => {
  const existing = entries.find((e) => e.wrapId === rec.id);
  if (existing) return { ok: true, entry: existing, created: false };
  if (!isEvmAddress(rec.account)) return { ok: false, reason: `not a payable address: ${rec.account}` };
  const amountUsdc = round2(payable.totalUsdc);
  if (!(amountUsdc >= 0.01)) return { ok: false, reason: `nothing to pay this cycle ($${amountUsdc.toFixed(2)})` };
  const entry: PayoutEntry = {
    id: rec.id,
    wrapId: rec.id,
    account: rec.account,
    amountUsdc,
    reason: payable.kind,
    creditUsdc: round2(payable.creditUsdc),
    floorPayoutUsdc: round2(payable.floorPayoutUsdc),
    status: "accrued",
    attempts: 0,
    retriable: false,
    txHash: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    paidAtMs: null,
    notes: [`accrued on ${payable.kind}`]
  };
  entries.push(entry);
  return { ok: true, entry, created: true };
};

// ── Payout processing ─────────────────────────────────────────────────────────

export type PayoutSendResult =
  | { ok: true; txHash: string; confirmed: boolean }
  | { ok: false; error: string; /** true ONLY when the sender guarantees nothing was broadcast. */ retriable: boolean };

export type PayoutSender = {
  kind: string; // "simulated" | "arbitrum_usdc"
  send: (toAddress: string, amountUsdc: number, idempotencyKey: string) => Promise<PayoutSendResult>;
};

/** USDC that already left (or is leaving) the wallet in nowMs's UTC day. */
export const dailyOutflowUsdc = (entries: PayoutEntry[], nowMs: number): number => {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return round2(
    entries
      .filter((e) => (e.status === "paid" || e.status === "confirmed" || e.status === "queued") && e.updatedAtMs != null)
      .filter((e) => new Date(e.status === "queued" ? e.updatedAtMs : e.paidAtMs ?? e.updatedAtMs).toISOString().slice(0, 10) === day)
      .reduce((s, e) => s + e.amountUsdc, 0)
  );
};

export type PayoutProcessOptions = {
  /** Hard per-day outflow cap in USDC — a compromised or runaway loop drains at most this. */
  dailyCapUsdc: number;
  maxAttempts?: number; // default 10
  /** Persist callback fired after an entry is marked queued and after every terminal update. */
  persist?: (entries: PayoutEntry[]) => void;
};

export type PayoutProcessSummary = { sent: number; confirmed: number; deferred: number; failed: number; skippedStale: number };

const lastNote = (e: PayoutEntry): string | undefined => e.notes[e.notes.length - 1];

/**
 * One payout pass: send every payable entry through the sender, never twice.
 *   - accrued entries (and retriable failures under the attempt cap) are sent
 *   - entries found ALREADY queued were interrupted mid-send on a previous run — they are parked
 *     as non-retriable failures for manual on-chain verification (requeuePayout), never auto-resent
 *   - the per-day outflow cap defers whatever does not fit today
 * Mutates entries in place and persists via opts.persist at each state change.
 */
export const processPayoutLedger = async (
  entries: PayoutEntry[],
  sender: PayoutSender,
  nowMs: number,
  opts: PayoutProcessOptions
): Promise<PayoutProcessSummary> => {
  const maxAttempts = opts.maxAttempts ?? 10;
  const persist = opts.persist ?? (() => undefined);
  const summary: PayoutProcessSummary = { sent: 0, confirmed: 0, deferred: 0, failed: 0, skippedStale: 0 };

  // Stale queued rows = a previous pass crashed between queue and outcome. The tx MAY have gone
  // out — auto-resending risks a double pay, so park them for manual verification instead.
  for (const e of entries) {
    if (e.status === "queued") {
      transitionPayout(e, "failed", nowMs, "stale queued entry from an interrupted pass — verify on-chain, then requeuePayout; NOT auto-resent");
      e.retriable = false;
      summary.skippedStale++;
    }
  }
  if (summary.skippedStale > 0) persist(entries);

  let outflow = dailyOutflowUsdc(entries, nowMs);
  for (const e of entries) {
    const retryable = e.status === "failed" && e.retriable && e.attempts < maxAttempts;
    if (e.status !== "accrued" && !retryable) continue;

    if (outflow + e.amountUsdc > opts.dailyCapUsdc) {
      const note = `deferred — daily outflow cap $${opts.dailyCapUsdc} would be exceeded ($${outflow.toFixed(2)} already out)`;
      if (lastNote(e) !== note) e.notes.push(note);
      summary.deferred++;
      continue;
    }

    // Queue + persist BEFORE the send: a crash between here and the outcome leaves a queued row
    // that the stale sweep above parks — money can never silently move twice.
    if (e.status === "failed") transitionPayout(e, "queued", nowMs, `retry ${e.attempts + 1}/${maxAttempts}`);
    else transitionPayout(e, "queued", nowMs);
    e.attempts += 1;
    persist(entries);

    let res: PayoutSendResult;
    try {
      res = await sender.send(e.account, e.amountUsdc, e.id);
    } catch (err) {
      // A throw is an UNKNOWN outcome (timeout, transport error) — the tx may have broadcast.
      // Never auto-retry unknowns; park for manual on-chain verification.
      res = { ok: false, error: `sender threw: ${(err as Error).message}`, retriable: false };
    }
    if (res.ok) {
      transitionPayout(e, "paid", nowMs, `paid via ${sender.kind} · tx ${res.txHash}`);
      e.txHash = res.txHash;
      e.paidAtMs = nowMs;
      outflow = round2(outflow + e.amountUsdc);
      summary.sent++;
      if (res.confirmed) {
        transitionPayout(e, "confirmed", nowMs);
        summary.confirmed++;
      }
    } else {
      transitionPayout(e, "failed", nowMs, `send failed: ${res.error}${res.retriable ? " (will retry)" : " — manual verification required"}`);
      e.retriable = res.retriable;
      summary.failed++;
    }
    persist(entries);
  }
  return summary;
};

/**
 * Manual ops action: re-arm a failed entry AFTER verifying on-chain that the previous attempt did
 * not pay. The only path back to the send queue for non-retriable failures. Returns the entry to
 * `accrued` (not `queued`) so the next pass sends it with the full queue-then-send crash safety.
 */
export const requeuePayout = (entries: PayoutEntry[], id: string, nowMs: number): boolean => {
  const e = entries.find((x) => x.id === id);
  if (!e || e.status !== "failed") return false;
  e.retriable = false;
  return transitionPayout(e, "accrued", nowMs, "manually requeued after on-chain verification");
};
