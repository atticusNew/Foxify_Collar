/**
 * DEMO WRAP — the engine half of the "one toggle on the venue, everything real behind it" demo.
 *
 * The demo has two surfaces:
 *   VENUE SIDE  — the real Hyperliquid UI with a "Protect" toggle rendered locally by a browser
 *                 extension (demo/hl-protect-extension). The toggle is the ONLY staged pixel and is
 *                 disclosed as such; it exists to show exact placement inside a live venue's flow.
 *   ATTICUS SIDE — this module + creditCollarDemoService: reads the REAL venue position, prices the
 *                 REAL collar off the live OKX book, and (in okx modes) executes REAL hedge legs
 *                 through the same production path as the canary. Nothing behind the toggle is mocked.
 *
 * This module is the pure, testable core: guardrails (kill switch, hard micro-notional cap, daily
 * quota, cooldown, one-wrap-at-a-time), the wrap record/state machine, credit-target scaling, the
 * vesting readout, and the disk store. The HTTP/venue wiring lives in the service script.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveWritablePath } from "./shadowStore";
import type { PerpSide } from "./creditCollarPricer";
import { vestedTimeFraction } from "./creditVesting";

const round2 = (x: number) => +x.toFixed(2);

export const DEFAULT_DEMO_STORE_PATH = process.env.DEMO_STORE_PATH ?? "./logs/demo-wraps.json";

/** paper = model quote off the live book, no venue orders · okx_demo/okx_live = real execution path. */
export type DemoExecutionMode = "paper" | "okx_demo" | "okx_live";

export type DemoGuardsConfig = {
  /** Master kill switch (DEMO_ENABLED). Off ⟹ the wrap endpoint refuses everything. */
  enabled: boolean;
  executionMode: DemoExecutionMode;
  /** HARD micro cap on ONE wrap's notional — a fat-fingered demo cannot scale. */
  maxPositionNotionalUsdc: number;
  maxWrapsPerDay: number;
  /** Minimum gap between wrap attempts PER ACCOUNT (multi-take recording ≠ rapid-fire opens). */
  cooldownMs: number;
  /** Pilot book cap: total notional across all open (in-flight + active) wraps. */
  maxBookNotionalUsdc: number;
  /** Pilot book cap: how many wraps may be open (in-flight + active) at once, across all accounts. */
  maxActiveWraps: number;
};

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export const parseDemoGuardsFromEnv = (env: Record<string, string | undefined>): DemoGuardsConfig => ({
  enabled: String(env.DEMO_ENABLED ?? "true").toLowerCase() === "true",
  executionMode: env.DEMO_EXECUTION === "okx_live" ? "okx_live" : env.DEMO_EXECUTION === "okx_demo" ? "okx_demo" : "paper",
  maxPositionNotionalUsdc: num(env.DEMO_MAX_NOTIONAL_USDC, 1_000),
  maxWrapsPerDay: num(env.DEMO_MAX_WRAPS_PER_DAY, 6),
  cooldownMs: num(env.DEMO_COOLDOWN_MS, 30_000),
  maxBookNotionalUsdc: num(env.DEMO_MAX_BOOK_NOTIONAL_USDC, 25_000),
  maxActiveWraps: num(env.DEMO_MAX_ACTIVE_WRAPS, 25)
});

// ── Wrap record ───────────────────────────────────────────────────────────────

export type DemoStageName =
  | "wrap_requested"   // toggle flipped — request landed
  | "position_read"    // real venue position read (coin/side/size/entry/mark)
  | "quoted"           // collar solved off the live options book
  | "hedge_executing"  // real hedge legs going out (okx modes)
  | "hedge_locked"     // legs filled/booked — the protection exists
  | "green_light"      // client may rely on the wrap from here
  | "vesting"          // credit vesting over the tenor
  | "failed"
  | "knocked_out"      // Design B: mark touched the cap — legs closed, cycle over, re-arms at new spot
  | "concluded";

export type DemoStage = { stage: DemoStageName; tsMs: number; note?: string };

export type DemoLeg = {
  /** Long-perp wrap: sell_call_cap + buy_put_floor. Short-perp wrap (mirror): sell_put_cap + buy_call_floor. */
  role: "sell_call_cap" | "buy_put_floor" | "sell_put_cap" | "buy_call_floor";
  instId: string | null;
  orderId: string | null;
  /** Signed premium in USDC: + collected (sold), − paid (bought). */
  premiumUsdc: number;
  /** true = a real venue order stands behind this row; false = model quote off the live book. */
  real: boolean;
};

export type DemoWrapRecord = {
  id: string;
  createdAtMs: number;
  clientVenue: string; // "hyperliquid"
  account: string;     // the account whose position is wrapped (shown on the video)
  position: {
    coin: string;
    side: PerpSide;
    szBase: number;
    entryPx: number | null;
    markPx: number;
    notionalUsdc: number;
  };
  quote: {
    spot: number;
    putStrike: number;
    callStrike: number;
    floorPct: number;
    capPct: number;
    /** ONE-NUMBER RULE: after hedge_locked this is the REALIZED credit (every surface shows it). */
    creditUsdc: number;
    /** The indicative quote at toggle time, kept for the labeled "quoted → filled" history. */
    quotedCreditUsdc?: number | null;
    /** Side-aware display strikes: floor = the protective strike (put for long, CALL for short). */
    floorStrike?: number;
    capStrike?: number;
    floorPctUsed: number;
    tenorDays: number;
  } | null;
  hedge: {
    venue: string; // "okx_model" | "okx_demo" | "okx_live"
    mode: DemoExecutionMode;
    netCreditUsdc: number | null;
    venueFeeUsdc: number | null;
    contracts: number | null;
    /** Uncovered remainder when the position is not an integer OKX lot (floor, never round up). */
    sizeNote: string | null;
  } | null;
  legs: DemoLeg[];
  vesting: { fullCreditUsdc: number; startMs: number; endMs: number } | null;
  stages: DemoStage[];
  status: "quoting" | "executing" | "active" | "failed" | "knocked_out" | "concluded";
  failReason: string | null;
  /** Set on a voluntary early close (toggle off): vesting freezes here — vested collected, rest clawed back. */
  concludedAtMs?: number | null;
  /** Design B knockout record: set when mark touched the cap and the cycle ended early. */
  knockout?: KnockoutInfo | null;
};

export type KnockoutInfo = {
  touchedAtMs: number;
  /** The mark print that touched the cap. */
  markPx: number;
  capStrike: number;
  /** Net USD realized closing both hedge legs (okx lanes); null in paper (no venue legs). House-side bookkeeping. */
  unwindValueUsdc: number | null;
};

export const newDemoWrap = (
  id: string,
  nowMs: number,
  clientVenue: string,
  account: string,
  position: DemoWrapRecord["position"]
): DemoWrapRecord => ({
  id,
  createdAtMs: nowMs,
  clientVenue,
  account,
  position,
  quote: null,
  hedge: null,
  legs: [],
  vesting: null,
  stages: [
    { stage: "wrap_requested", tsMs: nowMs },
    { stage: "position_read", tsMs: nowMs, note: `${position.side} ${position.szBase} ${position.coin} @ mark $${round2(position.markPx)} (≈$${round2(position.notionalUsdc)})` }
  ],
  status: "quoting",
  failReason: null
});

export const pushStage = (rec: DemoWrapRecord, stage: DemoStageName, tsMs: number, note?: string): DemoWrapRecord => {
  rec.stages.push(note != null ? { stage, tsMs, note } : { stage, tsMs });
  return rec;
};

export const failWrap = (rec: DemoWrapRecord, tsMs: number, reason: string): DemoWrapRecord => {
  rec.status = "failed";
  rec.failReason = reason;
  return pushStage(rec, "failed", tsMs, reason);
};

/**
 * Live hedge refused — keep the runner summary, drop canary "day skipped" / empty "pair unwound",
 * and surface the venue's own error (50111 must not look like a missing option).
 */
export const wrapRefuseFromLive = (summary: string, venueErrors: string[] = []): string => {
  const base = String(summary || "hedge did not fill")
    .replace(/\s*—\s*day skipped/gi, "")
    .replace(/\s*\(pair unwound\)/gi, "")
    .trim();
  const err = venueErrors.find((e) => String(e).trim()) ?? "";
  if (/50111|Invalid OK-ACCESS-KEY/i.test(err)) {
    return "wrap refused: OKX rejected the API key (50111 Invalid OK-ACCESS-KEY) — check live key, passphrase, and no extra quotes in env";
  }
  return err ? `wrap refused: ${base} — ${err}` : `wrap refused: ${base}`;
};

// ── Guardrails ────────────────────────────────────────────────────────────────

export type DemoWrapAssessment = { ok: true } | { ok: false; reason: string };

const dayUtcOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const isOpen = (r: DemoWrapRecord) => r.status === "quoting" || r.status === "executing" || r.status === "active";

/**
 * May a wrap open right now? Fail-closed on every rail: kill switch, position present, hard per-wrap
 * cap, book caps (open-wrap count + total open notional), daily quota, cooldown. Pure — the service
 * feeds it the live store contents.
 *
 * ACCOUNT SCOPING (Stage A, pilot multi-client): when `account` is given, one-at-a-time and cooldown
 * apply PER ACCOUNT — different clients wrap concurrently; one client cannot double-wrap the same
 * position. When omitted (legacy single-account demo), those rails stay global, unchanged.
 */
export const assessDemoWrap = (
  cfg: DemoGuardsConfig,
  nowMs: number,
  positionNotionalUsdc: number,
  existing: DemoWrapRecord[],
  account?: string,
  /** Renewal lane: an auto-renew of an expired wrap skips the daily NEW-wrap quota (book caps still bind). */
  renewal = false
): DemoWrapAssessment => {
  if (!cfg.enabled) return { ok: false, reason: "demo disabled — DEMO_ENABLED kill switch is off" };
  if (!(positionNotionalUsdc > 0)) return { ok: false, reason: "no live position to wrap (size 0)" };
  if (positionNotionalUsdc > cfg.maxPositionNotionalUsdc) {
    return { ok: false, reason: `position notional $${round2(positionNotionalUsdc)} exceeds the per-wrap hard cap $${cfg.maxPositionNotionalUsdc}` };
  }
  const mine = account != null ? existing.filter((r) => r.account === account) : existing;
  const inFlight = mine.find((r) => r.status === "quoting" || r.status === "executing");
  if (inFlight) return { ok: false, reason: `wrap ${inFlight.id} is still in flight — one at a time${account != null ? " per account" : ""}` };
  const active = mine.find((r) => r.status === "active");
  if (active) return { ok: false, reason: `wrap ${active.id} is already active${account != null ? ` on ${account}` : ""} — conclude or reset before wrapping again` };
  const open = existing.filter(isOpen);
  if (open.length >= cfg.maxActiveWraps) {
    return { ok: false, reason: `book is full — ${open.length} open wraps (cap ${cfg.maxActiveWraps})` };
  }
  const openNotional = open.reduce((s, r) => s + (r.position?.notionalUsdc ?? 0), 0);
  if (openNotional + positionNotionalUsdc > cfg.maxBookNotionalUsdc) {
    return { ok: false, reason: `book notional cap — $${round2(openNotional)} open + $${round2(positionNotionalUsdc)} would exceed $${cfg.maxBookNotionalUsdc}` };
  }
  const today = existing.filter((r) => dayUtcOf(r.createdAtMs) === dayUtcOf(nowMs));
  if (!renewal && today.length >= cfg.maxWrapsPerDay) return { ok: false, reason: `daily demo quota reached (${cfg.maxWrapsPerDay}/day)` };
  const last = mine[mine.length - 1];
  if (last && nowMs - last.createdAtMs < cfg.cooldownMs) {
    return { ok: false, reason: `cooldown — ${Math.ceil((cfg.cooldownMs - (nowMs - last.createdAtMs)) / 1000)}s until the next wrap` };
  }
  return { ok: true };
};

// ── OKX lot cover (floor, never round up) ─────────────────────────────────────

/** OKX coin-margined BTC option contract size. */
export const OKX_OPTION_LOT_BTC = 0.01;

export type CoveredLots =
  | { ok: true; coveredBtc: number; lots: number; remainderBtc: number }
  | { ok: false; reason: string };

/**
 * Whole lots that FIT inside the position. Never round up (that would sell extra options the
 * trader does not hold). Below one lot there is no listed clip — refuse with a human line.
 */
export const coverOkxLots = (szBase: number, lotBtc = OKX_OPTION_LOT_BTC): CoveredLots => {
  const sz = Math.abs(szBase);
  if (!(sz > 0) || !(lotBtc > 0)) return { ok: false, reason: "no live position to wrap (size 0)" };
  const lots = Math.floor(sz / lotBtc + 1e-12);
  if (lots < 1) {
    return {
      ok: false,
      reason: `wrap refused: this position is ${sz} BTC; OKX options trade in ${lotBtc} BTC lots (minimum one lot)`
    };
  }
  const coveredBtc = +(lots * lotBtc).toFixed(8);
  const remainderBtc = +Math.max(0, sz - coveredBtc).toFixed(8);
  return { ok: true, coveredBtc, lots, remainderBtc };
};

export const uncoveredSizeNote = (szBase: number, covered: Extract<CoveredLots, { ok: true }>): string | null =>
  covered.remainderBtc > 1e-8
    ? `protecting ${covered.coveredBtc} of ${szBase} BTC (${covered.lots} × ${OKX_OPTION_LOT_BTC}); remainder unwrapped`
    : null;

/** Direct-client collar geometry: floor/cap in spot space. Not a $50k Foxify credit target. */
export const DEMO_FLOOR_PCT = 0.06;
/** Stay off ATM (σ-floor-ish overnight); do not tighten to manufacture a tape credit. */
export const DEMO_CAP_PCT = 0.015;

/**
 * Side-aware geometry: protection sits ~floorPct on the LOSS side, the cap ~capPct on the PROFIT
 * side. Long: buy put 6% below / sell call 1.5% above. Short (mirror): buy call 6% above / sell
 * put 1.5% below — a short profits when price falls, so its loss side is UP.
 */
export const demoPlanStrikes = (
  spot: number,
  side: PerpSide = "long",
  floorPct = DEMO_FLOOR_PCT,
  capPct = DEMO_CAP_PCT
): { putStrike: number; callStrike: number } =>
  side === "long"
    ? { putStrike: round2(spot * (1 - floorPct)), callStrike: round2(spot * (1 + capPct)) }
    : { putStrike: round2(spot * (1 - capPct)), callStrike: round2(spot * (1 + floorPct)) };

// ── Credit scaling (GTM illustration only — not the live demo solver) ─────────

/**
 * Illustrative $80 on $50k (~16 bps) from the old Foxify tape. Direct-client wraps do NOT use this
 * as a solver target; they take listed OKX touch credit on floored lots. Kept for GTM / one-pagers.
 */
export const scaledCreditTarget = (baseCreditUsdc: number, baseNotionalUsdc: number, notionalUsdc: number, minUsdc = 0.5): number => {
  if (!(baseNotionalUsdc > 0) || !(notionalUsdc > 0)) return minUsdc;
  return Math.max(minUsdc, round2((baseCreditUsdc * notionalUsdc) / baseNotionalUsdc));
};

// ── Paper legs (model quote off the live book — labeled, never dressed as fills) ──

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export const paperInstId = (strikeUsd: number, kind: "C" | "P", expiresAtMs: number): string => {
  const d = new Date(expiresAtMs);
  return `BTC-USD-${String(d.getUTCDate()).padStart(2, "0")}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}-${Math.round(strikeUsd)}-${kind} (model)`;
};

export const paperLegsFromQuote = (
  q: { legs: { putStrike: number; callStrike: number; floor_leg_mid_usdc: number; funding_leg_mid_usdc: number } },
  expiresAtMs: number,
  side: PerpSide = "long"
): DemoLeg[] =>
  side === "long"
    ? [
        { role: "sell_call_cap", instId: paperInstId(q.legs.callStrike, "C", expiresAtMs), orderId: null, premiumUsdc: round2(q.legs.funding_leg_mid_usdc), real: false },
        { role: "buy_put_floor", instId: paperInstId(q.legs.putStrike, "P", expiresAtMs), orderId: null, premiumUsdc: round2(-q.legs.floor_leg_mid_usdc), real: false }
      ]
    : [
        { role: "sell_put_cap", instId: paperInstId(q.legs.putStrike, "P", expiresAtMs), orderId: null, premiumUsdc: round2(q.legs.funding_leg_mid_usdc), real: false },
        { role: "buy_call_floor", instId: paperInstId(q.legs.callStrike, "C", expiresAtMs), orderId: null, premiumUsdc: round2(-q.legs.floor_leg_mid_usdc), real: false }
      ];

// ── Vesting readout ───────────────────────────────────────────────────────────

export type DemoVestingStatus = {
  fullCreditUsdc: number;
  vestedUsdc: number;
  fraction: number;    // [0,1]
  elapsedMs: number;
  remainingMs: number; // 0 once fully vested
  fullyVested: boolean;
};

export const demoVestingStatus = (rec: DemoWrapRecord, nowMs: number): DemoVestingStatus | null => {
  if (!rec.vesting) return null;
  const { fullCreditUsdc, startMs, endMs } = rec.vesting;
  // A voluntary early close freezes the clock: vested-to-close is collected, the rest clawed back.
  const effNowMs = rec.concludedAtMs != null ? Math.min(nowMs, rec.concludedAtMs) : nowMs;
  const tenorMs = Math.max(1, endMs - startMs);
  const elapsedMs = Math.max(0, effNowMs - startMs);
  const fraction = vestedTimeFraction(Math.min(elapsedMs, tenorMs), tenorMs, "linear");
  return {
    fullCreditUsdc: round2(fullCreditUsdc),
    vestedUsdc: round2(fullCreditUsdc * fraction),
    fraction: +fraction.toFixed(4),
    elapsedMs,
    remainingMs: Math.max(0, endMs - effNowMs),
    fullyVested: effNowMs >= endMs
  };
};

/**
 * Voluntary early close (the toggle flipped OFF): conclude the wrap NOW — the client collects the
 * credit vested to this moment, the unvested remainder is clawed back, and the hedge unwinds
 * (paper lane: bookkeeping only; okx lanes surface the unwind in their own ledgers).
 * Returns the frozen vesting readout, or null when there is nothing active to close.
 */
export const concludeWrapEarly = (rec: DemoWrapRecord, nowMs: number): DemoVestingStatus | null => {
  if (rec.status !== "active" || !rec.vesting) return null;
  rec.concludedAtMs = nowMs;
  rec.status = "concluded";
  const v = demoVestingStatus(rec, nowMs)!;
  pushStage(
    rec,
    "concluded",
    nowMs,
    `voluntary early close — collected $${v.vestedUsdc.toFixed(2)} vested of $${v.fullCreditUsdc.toFixed(2)} (${(v.fraction * 100).toFixed(1)}%); unvested $${round2(v.fullCreditUsdc - v.vestedUsdc).toFixed(2)} clawed back · hedge unwound`
  );
  return v;
};

/**
 * Natural expiry: the tenor ran to the listed fixing — credit fully vested, hedge legs settle at
 * the venue print (nothing to unwind). Persists what buildState previously only displayed.
 */
export const concludeAtExpiry = (rec: DemoWrapRecord, nowMs: number): boolean => {
  if (rec.status !== "active" || !rec.vesting || nowMs < rec.vesting.endMs) return false;
  rec.status = "concluded";
  rec.concludedAtMs = rec.vesting.endMs;
  pushStage(rec, "concluded", nowMs, `expired at the listed fixing — $${round2(rec.vesting.fullCreditUsdc)} earned in full`);
  return true;
};

// ── Design B knockout (approved decision 1) ───────────────────────────────────
// If mark TOUCHES the cap (no buffer), protection ends for that cycle: both hedge legs close
// immediately, the wrap is marked knocked_out, and the account re-arms at new spot on the next
// renewal tick while the toggle stays on. The trader keeps the perp and every gain to the cap;
// the credit realizes vested-to-touch (paid at cycle conclusion, decision 2 — never upfront).

/** Side-aware cap strike of a quoted wrap: the SOLD wing on the profit side. */
export const wrapCapStrike = (rec: DemoWrapRecord): number | null =>
  rec.quote == null ? null : rec.quote.capStrike ?? (rec.position.side === "long" ? rec.quote.callStrike : rec.quote.putStrike);

/** Side-aware floor strike of a quoted wrap: the BOUGHT protective wing on the loss side. */
export const wrapFloorStrike = (rec: DemoWrapRecord): number | null =>
  rec.quote == null ? null : rec.quote.floorStrike ?? (rec.position.side === "long" ? rec.quote.putStrike : rec.quote.callStrike);

/** Mark-price TOUCH of the cap, no buffer: at-or-through counts. Long caps above; short caps below. */
export const capTouched = (side: PerpSide, capStrike: number, markPx: number): boolean =>
  side === "long" ? markPx >= capStrike : markPx <= capStrike;

/**
 * Knock the wrap out at the touch: terminal state, vesting frozen at the touch (credit realizes
 * vested-to-touch), knockout metadata recorded. The caller is responsible for having closed the
 * venue legs FIRST (okx lanes) — this function is pure bookkeeping. Returns the frozen vesting
 * readout, or null when there is nothing active to knock out.
 */
export const knockoutWrap = (
  rec: DemoWrapRecord,
  nowMs: number,
  markPx: number,
  unwindValueUsdc: number | null = null
): DemoVestingStatus | null => {
  if (rec.status !== "active" || !rec.vesting) return null;
  const capStrike = wrapCapStrike(rec);
  if (capStrike == null) return null;
  rec.status = "knocked_out";
  rec.concludedAtMs = nowMs;
  rec.knockout = { touchedAtMs: nowMs, markPx: round2(markPx), capStrike, unwindValueUsdc };
  const v = demoVestingStatus(rec, nowMs)!;
  pushStage(
    rec,
    "knocked_out",
    nowMs,
    `cap $${capStrike} touched at mark $${round2(markPx)} — protection ended for this cycle; hedge legs closed; ` +
      `credit $${v.vestedUsdc.toFixed(2)} vested-to-touch of $${v.fullCreditUsdc.toFixed(2)} · re-arms at new spot if protection stays on`
  );
  return v;
};

// ── Cycle settlement (what the trader is OWED at conclusion) ──────────────────

/**
 * Floor payout at natural expiry: the protective wing expired in the money — the loss below the
 * floor (long) / above it (short) is covered on the wrapped size. Zero when the settle print
 * stayed inside the floor.
 */
export const floorPayoutUsdc = (side: PerpSide, floorStrike: number, settlePx: number, coveredBtc: number): number => {
  if (!(coveredBtc > 0) || !(floorStrike > 0) || !(settlePx > 0)) return 0;
  const perBtc = side === "long" ? Math.max(0, floorStrike - settlePx) : Math.max(0, settlePx - floorStrike);
  return round2(perBtc * coveredBtc);
};

export type CyclePayable = {
  kind: "expiry" | "knockout" | "early_close";
  /** Vested credit owed for the cycle (full at expiry, vested-to-touch on knockout, vested-to-close early). */
  creditUsdc: number;
  /** Protective-wing payout when the cycle expired through the floor (natural expiry only). */
  floorPayoutUsdc: number;
  totalUsdc: number;
};

/**
 * What is the trader owed for a CONCLUDED cycle? Pure. Returns null while the wrap is still open
 * (credit is paid at conclusion, never upfront) or when it failed before vesting existed.
 * `settlePx` is the expiry settle print (mark proxy in paper mode) used for the floor payout.
 */
export const cyclePayable = (rec: DemoWrapRecord, settlePx?: number | null): CyclePayable | null => {
  if (!rec.vesting) return null;
  const v = demoVestingStatus(rec, rec.concludedAtMs ?? rec.vesting.endMs);
  if (!v) return null;
  if (rec.status === "knocked_out") {
    return { kind: "knockout", creditUsdc: v.vestedUsdc, floorPayoutUsdc: 0, totalUsdc: v.vestedUsdc };
  }
  if (rec.status !== "concluded" || rec.concludedAtMs == null) return null;
  const natural = rec.concludedAtMs >= rec.vesting.endMs;
  if (!natural) {
    return { kind: "early_close", creditUsdc: v.vestedUsdc, floorPayoutUsdc: 0, totalUsdc: v.vestedUsdc };
  }
  const floorStrike = wrapFloorStrike(rec);
  const coveredBtc = (rec.hedge?.contracts ?? 0) * OKX_OPTION_LOT_BTC;
  const floorUsdc = floorStrike != null && settlePx != null ? floorPayoutUsdc(rec.position.side, floorStrike, settlePx, coveredBtc) : 0;
  return { kind: "expiry", creditUsdc: v.fullCreditUsdc, floorPayoutUsdc: floorUsdc, totalUsdc: round2(v.fullCreditUsdc + floorUsdc) };
};

// ── Auto-renew (protection is a STATE, not a button) ─────────────────────────
// The toggle ON persists a per-account preference; while it is on, an expired wrap re-quotes at
// the morning book and re-wraps (fresh record, fresh terms, same guard chain). A book that can't
// fund a credit ⟹ an honest skip: the account is visibly unprotected and the loop retries on a
// throttle. Toggle OFF / early close clears the preference. Nothing renews for accounts that never
// opted in — pulling this code cannot surprise-renew an old wrap.

export const DEFAULT_PROTECTION_STORE_PATH = process.env.DEMO_PROTECTION_STORE_PATH ?? "./logs/demo-protection.json";

export type ProtectionPref = { on: boolean; sinceMs: number; lastRenewAttemptMs?: number };
export type ProtectionPrefs = Record<string, ProtectionPref>; // key = account, lowercase

export const loadProtectionPrefs = (path = DEFAULT_PROTECTION_STORE_PATH): ProtectionPrefs => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return {};
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProtectionPrefs) : {};
  } catch {
    return {};
  }
};

export const saveProtectionPrefs = (prefs: ProtectionPrefs, path = DEFAULT_PROTECTION_STORE_PATH): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(prefs, null, 1), "utf8");
  } catch (e) {
    console.error(`[demo-wrap] protection prefs save failed: ${(e as Error).message}`);
  }
};

export type RenewalAction = "expire_and_renew" | "retry_wrap" | "none";

/**
 * Deterministic per-account renewal anchor inside [0, windowMs): every wrapped account expires at
 * the SAME listed fixing (daily options share one expiry), so an unstaggered loop would batch every
 * renewal onto one tick and stack the whole book on one strike. Spreading re-wraps across the
 * window lands them on different strikes as spot moves — the natural de-concentration the
 * per-strike cap relies on (approved decision 7). FNV-1a over the lowercased account.
 */
export const renewalStaggerOffsetMs = (account: string, windowMs: number): number => {
  if (!(windowMs > 0)) return 0;
  let h = 0x811c9dc5;
  for (const ch of account.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % Math.floor(windowMs);
};

/**
 * What should the renewal loop do for one account right now? Pure.
 *   expire_and_renew — the active wrap ran past its listed expiry PLUS this account's stagger
 *                      anchor: conclude it, settle it, re-wrap now.
 *   retry_wrap       — protection is on but nothing is open (a knockout, a skip-day refuse, or a
 *                      cleared store): try again. Knockouts re-arm on the very next tick (the
 *                      touch already de-staggered them — spot moved); other retries throttle so
 *                      quote probes don't hammer the venue.
 *   none             — off, in flight, still vesting, or inside the stagger window / retry throttle.
 */
export const renewalDecision = (
  pref: ProtectionPref | undefined,
  latest: DemoWrapRecord | null,
  nowMs: number,
  retryMs: number,
  staggerOffsetMs = 0
): RenewalAction => {
  if (!pref?.on) return "none";
  if (latest && (latest.status === "quoting" || latest.status === "executing")) return "none";
  if (latest && latest.status === "active") {
    return latest.vesting != null && nowMs >= latest.vesting.endMs + staggerOffsetMs ? "expire_and_renew" : "none";
  }
  if (latest && latest.status === "knocked_out") {
    // Re-arm at new spot on the next tick. The first attempt after the touch skips the throttle
    // (lastRenewAttemptMs predates the knockout); a refused re-arm then throttles like any skip-day.
    return pref.lastRenewAttemptMs == null || pref.lastRenewAttemptMs < (latest.concludedAtMs ?? 0) || nowMs - pref.lastRenewAttemptMs >= retryMs
      ? "retry_wrap"
      : "none";
  }
  // failed / concluded / nothing yet — retry on the throttle
  return pref.lastRenewAttemptMs == null || nowMs - pref.lastRenewAttemptMs >= retryMs ? "retry_wrap" : "none";
};

// ── Store (tiny JSON array — records mutate through stages, demo scale is small) ──

export const loadDemoWraps = (path = DEFAULT_DEMO_STORE_PATH): DemoWrapRecord[] => {
  const eff = resolveWritablePath(path);
  if (!existsSync(eff)) return [];
  try {
    const parsed = JSON.parse(readFileSync(eff, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as DemoWrapRecord[]) : [];
  } catch {
    return [];
  }
};

export const saveDemoWraps = (records: DemoWrapRecord[], path = DEFAULT_DEMO_STORE_PATH): void => {
  try {
    writeFileSync(resolveWritablePath(path), JSON.stringify(records, null, 1), "utf8");
  } catch (e) {
    console.error(`[demo-wrap] save failed: ${(e as Error).message}`);
  }
};
