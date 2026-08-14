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
  /** HARD micro cap on the wrapped position's notional — a fat-fingered demo cannot scale. */
  maxPositionNotionalUsdc: number;
  maxWrapsPerDay: number;
  /** Minimum gap between wrap attempts (multi-take recording ≠ rapid-fire opens). */
  cooldownMs: number;
};

const num = (v: string | undefined, d: number) => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

export const parseDemoGuardsFromEnv = (env: Record<string, string | undefined>): DemoGuardsConfig => ({
  enabled: String(env.DEMO_ENABLED ?? "true").toLowerCase() === "true",
  executionMode: env.DEMO_EXECUTION === "okx_live" ? "okx_live" : env.DEMO_EXECUTION === "okx_demo" ? "okx_demo" : "paper",
  maxPositionNotionalUsdc: num(env.DEMO_MAX_NOTIONAL_USDC, 1_000),
  maxWrapsPerDay: num(env.DEMO_MAX_WRAPS_PER_DAY, 6),
  cooldownMs: num(env.DEMO_COOLDOWN_MS, 30_000)
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
  | "concluded";

export type DemoStage = { stage: DemoStageName; tsMs: number; note?: string };

export type DemoLeg = {
  role: "sell_call_cap" | "buy_put_floor";
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
    creditUsdc: number;
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
  status: "quoting" | "executing" | "active" | "failed" | "concluded";
  failReason: string | null;
  /** Set on a voluntary early close (toggle off): vesting freezes here — vested collected, rest clawed back. */
  concludedAtMs?: number | null;
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

/**
 * May a wrap open right now? Fail-closed on every rail: kill switch, position present, hard micro
 * cap, one wrap in flight/active at a time, daily quota, cooldown. Pure — the service feeds it the
 * live store contents.
 */
export const assessDemoWrap = (
  cfg: DemoGuardsConfig,
  nowMs: number,
  positionNotionalUsdc: number,
  existing: DemoWrapRecord[]
): DemoWrapAssessment => {
  if (!cfg.enabled) return { ok: false, reason: "demo disabled — DEMO_ENABLED kill switch is off" };
  if (!(positionNotionalUsdc > 0)) return { ok: false, reason: "no live position to wrap (size 0)" };
  if (positionNotionalUsdc > cfg.maxPositionNotionalUsdc) {
    return { ok: false, reason: `position notional $${round2(positionNotionalUsdc)} exceeds the demo hard cap $${cfg.maxPositionNotionalUsdc}` };
  }
  const inFlight = existing.find((r) => r.status === "quoting" || r.status === "executing");
  if (inFlight) return { ok: false, reason: `wrap ${inFlight.id} is still in flight — one at a time` };
  const active = existing.find((r) => r.status === "active");
  if (active) return { ok: false, reason: `wrap ${active.id} is already active — conclude or reset before wrapping again` };
  const today = existing.filter((r) => dayUtcOf(r.createdAtMs) === dayUtcOf(nowMs));
  if (today.length >= cfg.maxWrapsPerDay) return { ok: false, reason: `daily demo quota reached (${cfg.maxWrapsPerDay}/day)` };
  const last = existing[existing.length - 1];
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

export const demoPlanStrikes = (spot: number, floorPct = DEMO_FLOOR_PCT, capPct = DEMO_CAP_PCT): { putStrike: number; callStrike: number } => ({
  putStrike: spot * (1 - floorPct),
  callStrike: spot * (1 + capPct)
});

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
  expiresAtMs: number
): DemoLeg[] => [
  { role: "sell_call_cap", instId: paperInstId(q.legs.callStrike, "C", expiresAtMs), orderId: null, premiumUsdc: round2(q.legs.funding_leg_mid_usdc), real: false },
  { role: "buy_put_floor", instId: paperInstId(q.legs.putStrike, "P", expiresAtMs), orderId: null, premiumUsdc: round2(-q.legs.floor_leg_mid_usdc), real: false }
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
