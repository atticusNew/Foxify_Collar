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
    /** Set when the hedge's min clip exceeds the wrapped position (e.g. OKX 0.01 BTC lots vs a micro HL leg). */
    sizeNote: string | null;
  } | null;
  legs: DemoLeg[];
  vesting: { fullCreditUsdc: number; startMs: number; endMs: number } | null;
  stages: DemoStage[];
  status: "quoting" | "executing" | "active" | "failed" | "concluded";
  failReason: string | null;
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

// ── Credit scaling ────────────────────────────────────────────────────────────

/**
 * The product prices $baseCredit on $baseNotional (e.g. $80 on $50k). A demo position is micro, so
 * the target scales proportionally — same collar geometry, honest economics — with a small floor so
 * the solver always has a positive target.
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
  const tenorMs = Math.max(1, endMs - startMs);
  const elapsedMs = Math.max(0, nowMs - startMs);
  const fraction = vestedTimeFraction(Math.min(elapsedMs, tenorMs), tenorMs, "linear");
  return {
    fullCreditUsdc: round2(fullCreditUsdc),
    vestedUsdc: round2(fullCreditUsdc * fraction),
    fraction: +fraction.toFixed(4),
    elapsedMs,
    remainingMs: Math.max(0, endMs - nowMs),
    fullyVested: nowMs >= endMs
  };
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
