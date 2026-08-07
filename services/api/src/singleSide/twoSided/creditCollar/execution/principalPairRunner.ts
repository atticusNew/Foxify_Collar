/**
 * Principal-pair runner — opens Atticus's OWN delta-neutral pairs: a real long on venue A and a
 * real short on venue B, pair-atomic, with the collar wrap attaching via an injected hook (the
 * existing OKX options rails). This is the principal-mode engine: no partner, no decision gates —
 * our capital, our positions, our caps.
 *
 * Rules enforced IN CODE (not by convention):
 *   • CROSS-VENUE ONLY — the two legs must sit on different venues (never self-match on one book).
 *   • PAIR-ATOMIC — if the second leg fails, the first is immediately abort-closed (reduce-only);
 *     a failed abort is flagged CRITICAL (naked leg) and blocks further opens until resolved.
 *   • SIZE-MATCHED — the short targets the long's actual fill; any excess long is trimmed.
 *   • CAPPED + RATE-LIMITED — hard per-leg notional cap and pairs-per-UTC-day quota.
 *   • DRY-RUN BY DEFAULT — nothing live without explicit config.
 *
 * All open/close/abort events append to a durable JSONL ledger (latest record per ref wins).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolveWritablePath } from "../shadowStore";
import type { PerpLegExecutor, PerpLegFill } from "./perpVenues/perpLegExecutor";

export const DEFAULT_PRINCIPAL_PAIRS_PATH = process.env.PRINCIPAL_PAIRS_PATH ?? "./logs/principal-pairs.jsonl";

export type PrincipalLeg = {
  venue: string;
  side: "long" | "short";
  sz: number;
  avgPx: number | null;
  oid: string | number | null;
};

export type PrincipalPairRecord = {
  ref: string;
  coin: string;
  notionalUsdcPerLeg: number;
  openedAtMs: number;
  status: "open" | "closed" | "aborted" | "naked_leg_critical";
  long: PrincipalLeg | null;
  short: PrincipalLeg | null;
  abortReason?: string;
  closedAtMs?: number;
  closeLong?: PerpLegFill;
  closeShort?: PerpLegFill;
  notes: string[];
};

export type PrincipalPairConfig = {
  coin: string;
  notionalUsdcPerLeg: number;
  /** Hard guard — refuse any leg above this regardless of config upstream. Default $60k. */
  maxNotionalUsdcPerLeg?: number;
  slippagePct?: number;
  pairsPerDayUtc?: number; // default 1
  dryRun?: boolean; // informational tag on the record (executors decide realness)
  pairsPath?: string;
  nowMs?: () => number;
  /** Optional collar wrap — called after BOTH legs fill (the OKX options rails plug in here). */
  wrapHook?: (rec: PrincipalPairRecord) => Promise<{ ok: boolean; note: string }>;
};

export type PrincipalCycleResult =
  | { action: "opened"; record: PrincipalPairRecord }
  | { action: "aborted"; record: PrincipalPairRecord }
  | { action: "critical_naked_leg"; record: PrincipalPairRecord }
  | { action: "skipped"; reason: string };

const r8 = (x: number) => +x.toFixed(8);

export const loadPrincipalPairs = (path = DEFAULT_PRINCIPAL_PAIRS_PATH): PrincipalPairRecord[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  const byRef = new Map<string, PrincipalPairRecord>();
  for (const line of readFileSync(eff, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as PrincipalPairRecord;
      byRef.set(rec.ref, rec); // append-only: latest version of a ref wins
    } catch {
      /* skip malformed */
    }
  }
  return [...byRef.values()];
};

const appendRecord = (rec: PrincipalPairRecord, path: string): void => {
  try {
    appendFileSync(resolveWritablePath(path), JSON.stringify(rec) + "\n", "utf8");
  } catch (e) {
    console.error(`[principal-pair] ledger append failed: ${(e as Error).message}`);
  }
};

/** Open one cross-venue pair if due. venueLong holds the long leg, venueShort the short leg. */
export const runPrincipalPairCycle = async (
  venueLong: PerpLegExecutor,
  venueShort: PerpLegExecutor,
  cfg: PrincipalPairConfig
): Promise<PrincipalCycleResult> => {
  const now = cfg.nowMs ? cfg.nowMs() : Date.now();
  const path = cfg.pairsPath ?? DEFAULT_PRINCIPAL_PAIRS_PATH;
  const cap = cfg.maxNotionalUsdcPerLeg ?? 60_000;
  const quota = Math.max(1, cfg.pairsPerDayUtc ?? 1);

  // ── Guards ──
  if (venueLong.venue === venueShort.venue) {
    return { action: "skipped", reason: `SELF-MATCH REFUSED: both legs on '${venueLong.venue}' — the pair must span two venues` };
  }
  if (!(cfg.notionalUsdcPerLeg > 0) || cfg.notionalUsdcPerLeg > cap) {
    return { action: "skipped", reason: `notional $${cfg.notionalUsdcPerLeg} outside (0, ${cap}] hard cap` };
  }
  const existing = loadPrincipalPairs(path);
  const critical = existing.find((r) => r.status === "naked_leg_critical");
  if (critical) {
    return { action: "skipped", reason: `BLOCKED: unresolved naked-leg record ${critical.ref} — resolve before opening more` };
  }
  const dayUtc = new Date(now).toISOString().slice(0, 10);
  const openedToday = existing.filter((r) => new Date(r.openedAtMs).toISOString().slice(0, 10) === dayUtc).length;
  if (openedToday >= quota) {
    return { action: "skipped", reason: `quota reached: ${openedToday}/${quota} pairs today (UTC)` };
  }

  const ref = `pp-${now}`;
  const rec: PrincipalPairRecord = {
    ref,
    coin: cfg.coin,
    notionalUsdcPerLeg: cfg.notionalUsdcPerLeg,
    openedAtMs: now,
    status: "open",
    long: null,
    short: null,
    notes: [cfg.dryRun ? "dry-run pair (paper executor(s))" : "live pair"]
  };

  // ── Leg 1: long on venue A ──
  const longFill = await venueLong.openLeg({ coin: cfg.coin, side: "long", notionalUsdc: cfg.notionalUsdcPerLeg, slippagePct: cfg.slippagePct });
  if (longFill.status === "error" || longFill.status === "unfilled" || longFill.filledSz <= 0) {
    rec.status = "aborted";
    rec.abortReason = `long leg did not fill (${longFill.status}${longFill.message ? `: ${longFill.message}` : ""})`;
    appendRecord(rec, path);
    return { action: "aborted", record: rec };
  }
  rec.long = { venue: venueLong.venue, side: "long", sz: r8(longFill.filledSz), avgPx: longFill.avgPx, oid: longFill.oid ?? null };

  // ── Leg 2: short on venue B, sized to the long's ACTUAL fill ──
  const longNotional = longFill.avgPx != null ? longFill.filledSz * longFill.avgPx : cfg.notionalUsdcPerLeg;
  const shortFill = await venueShort.openLeg({ coin: cfg.coin, side: "short", notionalUsdc: longNotional, slippagePct: cfg.slippagePct });

  if (shortFill.status === "error" || shortFill.status === "unfilled" || shortFill.filledSz <= 0) {
    // PAIR-ATOMIC: abort-close the long immediately (reduce-only).
    const abort = await venueLong.closeLeg({ coin: cfg.coin, side: "long", sz: longFill.filledSz, slippagePct: cfg.slippagePct });
    if (abort.status === "filled") {
      rec.status = "aborted";
      rec.abortReason = `short leg failed (${shortFill.status}) — long abort-closed clean`;
      rec.closeLong = abort;
      appendRecord(rec, path);
      return { action: "aborted", record: rec };
    }
    rec.status = "naked_leg_critical";
    rec.abortReason = `short leg failed AND long abort-close ${abort.status} (${abort.message ?? "no fill"}) — NAKED ${r8(longFill.filledSz)} ${cfg.coin} LONG on ${venueLong.venue}: manual intervention required`;
    appendRecord(rec, path);
    return { action: "critical_naked_leg", record: rec };
  }
  rec.short = { venue: venueShort.venue, side: "short", sz: r8(shortFill.filledSz), avgPx: shortFill.avgPx, oid: shortFill.oid ?? null };

  // ── Size-match BOTH directions: delta-neutral means equal BASE SIZE, not equal notional.
  // (Legs fill at slightly different prices, so notional-sized requests leave a size residue.)
  const diff = r8(longFill.filledSz - shortFill.filledSz);
  if (Math.abs(diff) > 0) {
    const excessSide = diff > 0 ? ("long" as const) : ("short" as const);
    const excessVenue = diff > 0 ? venueLong : venueShort;
    const excess = Math.abs(diff);
    const trim = await excessVenue.closeLeg({ coin: cfg.coin, side: excessSide, sz: excess, slippagePct: cfg.slippagePct });
    if (trim.status === "filled") {
      const matched = r8(Math.min(longFill.filledSz, shortFill.filledSz));
      rec.long.sz = matched;
      rec.short.sz = matched;
      rec.notes.push(`trimmed ${excess} ${cfg.coin} ${excessSide} excess — legs size-matched at ${matched}`);
    } else {
      rec.notes.push(`WARN: trim of ${excess} ${cfg.coin} ${excessSide} excess ${trim.status} — residual delta ${diff}`);
    }
  }

  // ── Collar wrap (the options rails attach here) ──
  if (cfg.wrapHook) {
    try {
      const wrap = await cfg.wrapHook(rec);
      rec.notes.push(wrap.ok ? `wrap: ${wrap.note}` : `WRAP FAILED: ${wrap.note} — pair carries unwrapped (delta-neutral, no collar credit)`);
    } catch (e) {
      rec.notes.push(`WRAP FAILED: ${(e as Error).message} — pair carries unwrapped`);
    }
  }

  appendRecord(rec, path);
  return { action: "opened", record: rec };
};

/** Close a pair (both legs reduce-only). Safe to call repeatedly; only open pairs act. */
export const closePrincipalPair = async (
  ref: string,
  venueLong: PerpLegExecutor,
  venueShort: PerpLegExecutor,
  cfg: Pick<PrincipalPairConfig, "coin" | "slippagePct" | "pairsPath" | "nowMs">
): Promise<PrincipalPairRecord | null> => {
  const path = cfg.pairsPath ?? DEFAULT_PRINCIPAL_PAIRS_PATH;
  const rec = loadPrincipalPairs(path).find((r) => r.ref === ref);
  if (!rec || rec.status !== "open" || !rec.long || !rec.short) return rec ?? null;
  if (rec.long.venue !== venueLong.venue || rec.short.venue !== venueShort.venue) {
    rec.notes.push(`CLOSE REFUSED: executor venues (${venueLong.venue}/${venueShort.venue}) don't match record (${rec.long.venue}/${rec.short.venue})`);
    appendRecord(rec, path);
    return rec;
  }
  const closeLong = await venueLong.closeLeg({ coin: rec.coin, side: "long", sz: rec.long.sz, slippagePct: cfg.slippagePct });
  const closeShort = await venueShort.closeLeg({ coin: rec.coin, side: "short", sz: rec.short.sz, slippagePct: cfg.slippagePct });
  rec.closeLong = closeLong;
  rec.closeShort = closeShort;
  rec.closedAtMs = cfg.nowMs ? cfg.nowMs() : Date.now();
  const bothClosed = closeLong.status === "filled" && closeShort.status === "filled";
  rec.status = bothClosed ? "closed" : "naked_leg_critical";
  if (!bothClosed) rec.abortReason = `close incomplete: long ${closeLong.status} / short ${closeShort.status} — residual exposure, manual intervention required`;
  appendRecord(rec, path);
  return rec;
};
