/**
 * P2.5 — Volume Cover hedge manager (full 12-rule TP curve).
 *
 * Manages Atticus-retained hedge legs after Foxify close OR trigger.
 * Runs every VC_HM_TICK_MS (default 60s).
 *
 * Rules (priority order — first match wins):
 *   1.  Time-decay forced exit (expiry - now < 4h) — OVERRIDES all
 *   2.  Liquidity-aware defer (04:00-06:00 UTC, Asia thin) — skip tick
 *   3.  Gamma-zone hold (winner, |spot-strike|/spot < 0.5%) — HOLD
 *   4.  Active follow-through (winner, ≤30 min post-trigger) — HOLD
 *   5.  Trailing-max retracement (winner, current < running_max × 0.80) — sell
 *   6.  Theta-vs-momentum gate (winner, daily theta loss > 3h appreciation) — sell
 *   7.  Loser leg early exit (current < initial × 20% OR 4h grace) — sell
 *   8.  Reversal upgrade (loser, current > initial × 0.5 → near_atm) — re-state
 *   9.  Stale leg exit (stale_post_close, 1h elapsed) — sell
 *   10. Near-ATM gradual exit (near_atm, current < initial × 65% OR 5d remaining) — sell
 *   11. Vol-spike opportunistic sell (IV spike >25% in 60min, value > 1.2×) — sell
 *   12. Hard floor (current < initial × 10%) — sell
 *
 * Falls back to stub rules (1+7+12+W1) if VC_HM_USE_STUB=true (rollback lever).
 *
 * Telemetry: every tick emits volume_cover_hedge_leg_telemetry rows.
 * Dry-run mode (VC_HM_DRY_RUN=true) logs without selling.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { bsPut, bsCall } from "../pilot/blackScholes";
import {
  listRetainedHedgeLegs,
  markHedgeLegSold,
  updateHedgeLegTpState,
  finalizeSalvageProceedsForPosition,
  type HedgeLegRow,
  type RetainedRole
} from "./volumeCoverDb";
import { insertLedgerEntry } from "../pilot/capitalPoolLedger";
import type { HedgeExecutor, HedgeVenueChoice } from "./tightHedge";

// ──────────────────────────── Config ────────────────────────────

export type HedgeManagerConfig = {
  tickIntervalMs: number;
  /** If true, use stub rule set (1+7+12+W1) instead of full 12-rule curve. */
  useStub: boolean;
  /** Rule 1 — time-decay forced exit threshold (hours before expiry). */
  timeDecayExitHours: number;
  /** Rule 2 — Asia thin liquidity window UTC start hour (defer sells). */
  thinWindowUtcStart: number;
  /** Rule 2 — Asia thin liquidity window UTC end hour. */
  thinWindowUtcEnd: number;
  /** Rule 3 — gamma-zone band fraction. */
  gammaBandPct: number;
  /** Rule 4 — active follow-through window (minutes post-trigger). */
  followthroughMinutes: number;
  /** Rule 5 — trailing-max retracement threshold (1.0 - 0.80 = sell on 20% retrace). */
  trailRetracePct: number;
  /** Rule 6 — theta loss multiplier vs 3h appreciation. */
  thetaRateMult: number;
  /** Rule 7 — loser leg floor (fraction of initial cost). */
  loserFloorPct: number;
  /** Rule 7 — loser leg max grace period post-trigger (hours). */
  loserGraceHours: number;
  /** Rule 8 — loser reversal threshold (fraction of initial cost). */
  loserReversalPct: number;
  /** Rule 9 — stale leg exit hours after retention. */
  staleHours: number;
  /** Rule 10 — near-ATM floor + days remaining. */
  nearAtmFloorPct: number;
  nearAtmDaysRemaining: number;
  /** Rule 11 — vol spike fraction + value multiplier. */
  volSpikeIvPct: number;
  volSpikeValueMult: number;
  /** Rule 12 — hard floor (fraction of initial cost). */
  hardFloorPct: number;
  /** Rule W1 (stub-only) — winner time-cap (hours since retention). */
  stubWinnerTimecapHours: number;
  /** Risk-free rate for BS pricing. */
  riskFreeRate: number;
  /** Default IV when venue IV cache unavailable. */
  fallbackIv: number;
};

const DEFAULTS: HedgeManagerConfig = {
  tickIntervalMs: 60_000,
  useStub: false,
  timeDecayExitHours: 4,
  thinWindowUtcStart: 4,
  thinWindowUtcEnd: 6,
  gammaBandPct: 0.005,
  followthroughMinutes: 30,
  trailRetracePct: 0.20,
  thetaRateMult: 1.5,
  loserFloorPct: 0.20,
  loserGraceHours: 4,
  loserReversalPct: 0.5,
  staleHours: 1,
  nearAtmFloorPct: 0.65,
  nearAtmDaysRemaining: 5,
  volSpikeIvPct: 0.25,
  volSpikeValueMult: 1.2,
  hardFloorPct: 0.10,
  stubWinnerTimecapHours: 24,
  riskFreeRate: 0.045,
  // 45% annualized: realistic BTC ATM IV range is 35-55% in normal
  // markets. 65% is panic-only and inflates OTM leg values 2-5x.
  // Override via VC_HM_FALLBACK_IV; production should set explicitly
  // and / or wire a live IV source via spotIvSource.
  fallbackIv: 0.45
};

const readConfig = (): HedgeManagerConfig => {
  const cfg = { ...DEFAULTS };
  const env = process.env;
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const numAllowZero = (v: string | undefined, fallback: number): number => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  cfg.tickIntervalMs = num(env.VC_HM_TICK_MS, cfg.tickIntervalMs);
  cfg.useStub = (env.VC_HM_USE_STUB ?? "false").toLowerCase() === "true";
  cfg.timeDecayExitHours = num(env.VC_TP_TIME_EXIT_HOURS, cfg.timeDecayExitHours);
  cfg.thinWindowUtcStart = numAllowZero(env.VC_TP_THIN_WINDOW_UTC_START, cfg.thinWindowUtcStart);
  cfg.thinWindowUtcEnd = numAllowZero(env.VC_TP_THIN_WINDOW_UTC_END, cfg.thinWindowUtcEnd);
  cfg.gammaBandPct = num(env.VC_TP_GAMMA_BAND_PCT, cfg.gammaBandPct);
  cfg.followthroughMinutes = num(env.VC_TP_FOLLOWTHROUGH_MIN, cfg.followthroughMinutes);
  cfg.trailRetracePct = num(env.VC_TP_TRAIL_RETRACE_PCT, cfg.trailRetracePct);
  cfg.thetaRateMult = num(env.VC_TP_THETA_RATE_MULT, cfg.thetaRateMult);
  cfg.loserFloorPct = num(env.VC_TP_LOSER_FLOOR_PCT, cfg.loserFloorPct);
  cfg.loserGraceHours = num(env.VC_TP_LOSER_GRACE_HOURS, cfg.loserGraceHours);
  cfg.loserReversalPct = num(env.VC_TP_LOSER_REVERSAL_PCT, cfg.loserReversalPct);
  cfg.staleHours = num(env.VC_TP_STALE_HOURS, cfg.staleHours);
  cfg.nearAtmFloorPct = num(env.VC_TP_NEAR_ATM_FLOOR_PCT, cfg.nearAtmFloorPct);
  cfg.nearAtmDaysRemaining = num(env.VC_TP_NEAR_ATM_DAYS_REMAINING, cfg.nearAtmDaysRemaining);
  cfg.volSpikeIvPct = num(env.VC_TP_VOLSPIKE_IV_PCT, cfg.volSpikeIvPct);
  cfg.volSpikeValueMult = num(env.VC_TP_VOLSPIKE_VALUE_MULT, cfg.volSpikeValueMult);
  cfg.hardFloorPct = num(env.VC_TP_HARD_FLOOR_PCT, cfg.hardFloorPct);
  cfg.stubWinnerTimecapHours = num(env.VC_TP_STUB_WINNER_TIMECAP_HOURS, cfg.stubWinnerTimecapHours);
  cfg.riskFreeRate = num(env.VC_HM_RISK_FREE_RATE, cfg.riskFreeRate);
  cfg.fallbackIv = num(env.VC_HM_FALLBACK_IV, cfg.fallbackIv);
  return cfg;
};

// ──────────────────────────── Types ────────────────────────────

export type SpotIvSource = () => Promise<{
  spotBtcUsdc: number;
  ivAnnualized: number;
  asOfMs: number;
}>;

export type ManagerTickResult = {
  cycledAt: string;
  legsScanned: number;
  legsActioned: number;
  actions: Array<{
    legId: string;
    rule: string;
    action: "sold" | "dry_run" | "held";
    currentValueUsdc: number;
    initialCostUsdc: number;
  }>;
  skipped: boolean;
  skipReason?: string;
};

// ──────────────────────────── Schema ────────────────────────────

export const ensureHedgeManagerTelemetry = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_hedge_leg_telemetry (
      id BIGSERIAL PRIMARY KEY,
      leg_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      retained_role TEXT,
      current_value_usdc NUMERIC(20, 8),
      initial_cost_usdc NUMERIC(20, 8),
      spot_btc NUMERIC(20, 8),
      iv_annualized NUMERIC(8, 6),
      rule_evaluated TEXT NOT NULL,
      action TEXT NOT NULL,
      cycled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const safeIdx = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* idx exists */ }
  };
  await safeIdx(`CREATE INDEX idx_vc_hm_telem_leg ON volume_cover_hedge_leg_telemetry (leg_id, cycled_at DESC)`);
  await safeIdx(`CREATE INDEX idx_vc_hm_telem_time ON volume_cover_hedge_leg_telemetry (cycled_at DESC)`);
};

// ──────────────────────────── Tick logic ────────────────────────────

const computeLegValueUsdc = (params: {
  leg: HedgeLegRow;
  spotUsdc: number;
  ivAnnualized: number;
  riskFreeRate: number;
  nowMs: number;
}): number => {
  const { leg, spotUsdc, ivAnnualized, riskFreeRate, nowMs } = params;
  const expiryMs = new Date(leg.expiryIso).getTime();
  const T = Math.max(0, (expiryMs - nowMs) / (365.25 * 86_400_000));
  const perBtc =
    leg.optionKind === "put"
      ? bsPut(spotUsdc, leg.strikeUsdc, T, riskFreeRate, ivAnnualized)
      : bsCall(spotUsdc, leg.strikeUsdc, T, riskFreeRate, ivAnnualized);
  return Math.max(0, perBtc * leg.contracts);
};

type RuleDecision = {
  rule: string;
  fire: boolean;
  /** "defer" tells the caller to skip this leg this tick (no sell, no held telemetry). */
  defer?: boolean;
  /** "reclassify" upgrades a loser → near_atm without selling. */
  reclassifyTo?: RetainedRole;
  reason?: string;
};

/**
 * IV history per leg (in-memory; cleared on restart). Used by rule 11
 * (vol spike) which compares current IV to recent IV. First ~3 ticks
 * after restart can't fire rule 11 — acceptable.
 */
const ivHistory = new Map<string, Array<{ iv: number; ms: number }>>();
const recordIv = (legId: string, iv: number, ms: number, retainMs = 60 * 60_000): void => {
  const arr = ivHistory.get(legId) ?? [];
  arr.push({ iv, ms });
  // Keep only entries within retention window
  const cutoff = ms - retainMs;
  while (arr.length > 0 && arr[0].ms < cutoff) arr.shift();
  ivHistory.set(legId, arr);
};
const ivBaseline = (legId: string, atMostMsOld: number, nowMs: number): number | null => {
  const arr = ivHistory.get(legId);
  if (!arr || arr.length === 0) return null;
  // Find oldest entry within retention window (most stable baseline)
  const oldest = arr[0];
  if (nowMs - oldest.ms < atMostMsOld) return null; // not enough history yet
  return oldest.iv;
};

/**
 * Full 12-rule TP curve. See module-level comment for rule descriptions.
 * Returns first-match decision in priority order.
 */
const evaluateFullRules = (params: {
  leg: HedgeLegRow;
  currentValueUsdc: number;
  initialCostUsdc: number;
  spotUsdc: number;
  ivAnnualized: number;
  nowMs: number;
  cfg: HedgeManagerConfig;
}): RuleDecision => {
  const { leg, currentValueUsdc, initialCostUsdc, spotUsdc, ivAnnualized, nowMs, cfg } = params;
  const expiryMs = new Date(leg.expiryIso).getTime();
  const hoursToExpiry = (expiryMs - nowMs) / 3_600_000;
  const role = leg.retainedRole as RetainedRole | null;
  const retainedAtMs = leg.retainedAt ? new Date(leg.retainedAt).getTime() : nowMs;
  const hoursSinceRetention = (nowMs - retainedAtMs) / 3_600_000;
  const minutesSinceRetention = (nowMs - retainedAtMs) / 60_000;

  // Rule 1 — time-decay forced exit (OVERRIDES all)
  if (hoursToExpiry < cfg.timeDecayExitHours) {
    return { rule: "1_time_decay_exit", fire: true, reason: `${hoursToExpiry.toFixed(2)}h to expiry` };
  }

  // Rule 12 (hard floor) ALSO overrides rule 2. If value collapsed
  // below hardFloorPct of initial we must exit even in Asia thin
  // hours; otherwise a cliff drop during overnight could leak all
  // remaining salvage to expiry. Mirrors evaluateStubRules ordering.
  if (currentValueUsdc < initialCostUsdc * cfg.hardFloorPct) {
    return {
      rule: "12_hard_floor",
      fire: true,
      reason: `value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.hardFloorPct).toFixed(2)} (overrides rule 2)`
    };
  }

  // Rule 2 — Asia thin liquidity defer (rules 1 + 12 override)
  const utcHour = new Date(nowMs).getUTCHours();
  const inThinWindow = cfg.thinWindowUtcStart <= cfg.thinWindowUtcEnd
    ? utcHour >= cfg.thinWindowUtcStart && utcHour < cfg.thinWindowUtcEnd
    : utcHour >= cfg.thinWindowUtcStart || utcHour < cfg.thinWindowUtcEnd;
  if (inThinWindow) {
    return { rule: "2_thin_window_defer", fire: false, defer: true, reason: `UTC hour ${utcHour} in thin window` };
  }

  // Record IV for rule 11 baseline (do before early returns below so
  // history accumulates regardless of which rule fires).
  recordIv(leg.id, ivAnnualized, nowMs);

  // Rule 3 — gamma-zone hold (winner only): override 5-12 except rule 1
  const distFromStrikePct = Math.abs(spotUsdc - leg.strikeUsdc) / Math.max(1, spotUsdc);
  if (role === "winner_post_trigger" && distFromStrikePct < cfg.gammaBandPct) {
    return { rule: "3_gamma_zone_hold", fire: false, reason: `dist ${distFromStrikePct.toFixed(4)} < band ${cfg.gammaBandPct}` };
  }

  // Rule 4 — active follow-through (winner, ≤ followthroughMinutes post-trigger)
  if (role === "winner_post_trigger" && minutesSinceRetention <= cfg.followthroughMinutes) {
    return { rule: "4_active_followthrough", fire: false, reason: `${minutesSinceRetention.toFixed(1)}min since retention ≤ ${cfg.followthroughMinutes}` };
  }

  // Rule 11 — vol-spike opportunistic sell (across all roles)
  // If IV jumped > volSpikeIvPct in last 60min AND value > 1.2× initial: sell.
  const ivBase60min = ivBaseline(leg.id, 30 * 60_000, nowMs); // need ≥30min history
  if (
    ivBase60min !== null &&
    ivAnnualized > ivBase60min * (1 + cfg.volSpikeIvPct) &&
    currentValueUsdc > initialCostUsdc * cfg.volSpikeValueMult
  ) {
    return {
      rule: "11_vol_spike_sell",
      fire: true,
      reason: `IV ${ivAnnualized.toFixed(3)} > base ${ivBase60min.toFixed(3)} × (1+${cfg.volSpikeIvPct}); value ${currentValueUsdc.toFixed(2)} > ${(initialCostUsdc * cfg.volSpikeValueMult).toFixed(2)}`
    };
  }

  // Rule 5 — trailing-max retracement (winner)
  if (role === "winner_post_trigger") {
    const runningMax = Math.max(leg.runningMaxValueUsdc ?? 0, currentValueUsdc);
    if (runningMax > 0 && currentValueUsdc < runningMax * (1 - cfg.trailRetracePct)) {
      return {
        rule: "5_trail_retrace",
        fire: true,
        reason: `value ${currentValueUsdc.toFixed(2)} < ${(runningMax * (1 - cfg.trailRetracePct)).toFixed(2)} (max ${runningMax.toFixed(2)})`
      };
    }
  }

  // Rule 6 — theta-vs-momentum gate (winner)
  // Estimate daily theta loss: current_value × (1/days_to_expiry) × thetaRateMult.
  // Compare against recent 3h appreciation (lastValue → current).
  if (role === "winner_post_trigger" && leg.lastValueUsdc !== null && leg.lastValueAt) {
    const lastMs = new Date(leg.lastValueAt).getTime();
    const elapsedHrs = (nowMs - lastMs) / 3_600_000;
    if (elapsedHrs >= 1 && elapsedHrs <= 6) {
      const daysToExpiry = Math.max(0.1, hoursToExpiry / 24);
      const dailyThetaLoss = (currentValueUsdc / daysToExpiry) * cfg.thetaRateMult;
      const appreciation = currentValueUsdc - leg.lastValueUsdc;
      const appreciationPerDay = (appreciation / Math.max(0.1, elapsedHrs)) * 24;
      if (appreciationPerDay < dailyThetaLoss && dailyThetaLoss > 1) {
        return {
          rule: "6_theta_vs_momentum",
          fire: true,
          reason: `theta_loss/d ${dailyThetaLoss.toFixed(2)} > appreciation/d ${appreciationPerDay.toFixed(2)}`
        };
      }
    }
  }

  // Rule 7 — loser leg early exit
  if (role === "loser_post_trigger") {
    // 8 — reversal upgrade
    if (currentValueUsdc > initialCostUsdc * cfg.loserReversalPct) {
      return {
        rule: "8_loser_reversal_upgrade",
        fire: false,
        reclassifyTo: "near_atm_post_close",
        reason: `loser value ${currentValueUsdc.toFixed(2)} > ${(initialCostUsdc * cfg.loserReversalPct).toFixed(2)} (reversal)`
      };
    }
    if (currentValueUsdc < initialCostUsdc * cfg.loserFloorPct) {
      return {
        rule: "7_loser_floor",
        fire: true,
        reason: `loser value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.loserFloorPct).toFixed(2)}`
      };
    }
    if (hoursSinceRetention >= cfg.loserGraceHours) {
      return {
        rule: "7_loser_grace",
        fire: true,
        reason: `${hoursSinceRetention.toFixed(2)}h since retention ≥ grace ${cfg.loserGraceHours}`
      };
    }
  }

  // Rule 9 — stale leg exit
  if (role === "stale_post_close" && hoursSinceRetention >= cfg.staleHours) {
    return {
      rule: "9_stale_exit",
      fire: true,
      reason: `stale ${hoursSinceRetention.toFixed(2)}h ≥ ${cfg.staleHours}`
    };
  }

  // Rule 10 — near-ATM gradual exit
  if (role === "near_atm_post_close") {
    const daysToExpiry = hoursToExpiry / 24;
    if (currentValueUsdc < initialCostUsdc * cfg.nearAtmFloorPct) {
      return {
        rule: "10_near_atm_floor",
        fire: true,
        reason: `value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.nearAtmFloorPct).toFixed(2)}`
      };
    }
    if (daysToExpiry < cfg.nearAtmDaysRemaining) {
      return {
        rule: "10_near_atm_days_remaining",
        fire: true,
        reason: `${daysToExpiry.toFixed(2)}d remaining < ${cfg.nearAtmDaysRemaining}`
      };
    }
  }

  // Rule 12 — hard floor (last resort)
  if (currentValueUsdc < initialCostUsdc * cfg.hardFloorPct) {
    return {
      rule: "12_hard_floor",
      fire: true,
      reason: `value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.hardFloorPct).toFixed(2)}`
    };
  }

  return { rule: "no_match", fire: false };
};

/**
 * Stub rules (fallback path enabled via VC_HM_USE_STUB=true). Rules
 * 1+7+12+W1 only — used during initial Hour 0-36 launch window.
 */
const evaluateStubRules = (params: {
  leg: HedgeLegRow;
  currentValueUsdc: number;
  initialCostUsdc: number;
  nowMs: number;
  cfg: HedgeManagerConfig;
}): RuleDecision => {
  const { leg, currentValueUsdc, initialCostUsdc, nowMs, cfg } = params;
  const expiryMs = new Date(leg.expiryIso).getTime();
  const hoursToExpiry = (expiryMs - nowMs) / 3_600_000;

  if (hoursToExpiry < cfg.timeDecayExitHours) {
    return { rule: "1_time_decay_exit", fire: true, reason: `${hoursToExpiry.toFixed(2)}h to expiry` };
  }
  if (currentValueUsdc < initialCostUsdc * cfg.hardFloorPct) {
    return {
      rule: "12_hard_floor",
      fire: true,
      reason: `value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.hardFloorPct).toFixed(2)}`
    };
  }
  const role = leg.retainedRole as RetainedRole | null;
  const retainedAtMs = leg.retainedAt ? new Date(leg.retainedAt).getTime() : nowMs;
  const hoursSinceRetention = (nowMs - retainedAtMs) / 3_600_000;
  if (role === "loser_post_trigger") {
    if (currentValueUsdc < initialCostUsdc * cfg.loserFloorPct) {
      return { rule: "7_loser_floor", fire: true };
    }
    if (hoursSinceRetention >= cfg.loserGraceHours) {
      return { rule: "7_loser_grace", fire: true };
    }
  }
  if (
    (role === "winner_post_trigger" ||
      role === "near_atm_post_close" ||
      role === "stale_post_close") &&
    hoursSinceRetention >= cfg.stubWinnerTimecapHours
  ) {
    return { rule: "W1_stub_timecap", fire: true };
  }
  return { rule: "no_match", fire: false };
};

const insertTelemetry = async (
  pool: Pool,
  row: {
    legId: string;
    positionId: string;
    retainedRole: string | null;
    currentValueUsdc: number | null;
    initialCostUsdc: number;
    spotBtc: number | null;
    ivAnnualized: number | null;
    ruleEvaluated: string;
    action: "sold" | "dry_run" | "held" | "skip" | "error";
  }
): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO volume_cover_hedge_leg_telemetry
         (leg_id, position_id, retained_role, current_value_usdc, initial_cost_usdc,
          spot_btc, iv_annualized, rule_evaluated, action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.legId,
        row.positionId,
        row.retainedRole,
        row.currentValueUsdc,
        row.initialCostUsdc,
        row.spotBtc,
        row.ivAnnualized,
        row.ruleEvaluated,
        row.action
      ]
    );
  } catch {
    // Telemetry is best-effort; don't break the manager on insert failure.
  }
};

/**
 * Run one manager tick. Exposed for tests + manual /admin/hedge-manager/run.
 */
export const runOneHedgeManagerTick = async (params: {
  pool: Pool;
  executor: HedgeExecutor;
  spotIvSource: SpotIvSource;
  /** Test override of config / now. */
  cfg?: Partial<HedgeManagerConfig>;
  nowMs?: number;
  dryRun?: boolean;
}): Promise<ManagerTickResult> => {
  const cfg = { ...readConfig(), ...(params.cfg ?? {}) };
  const nowMs = params.nowMs ?? Date.now();
  const cycledAt = new Date(nowMs).toISOString();
  const dryRun = params.dryRun ?? process.env.VC_HM_DRY_RUN === "true";

  let spotIv: Awaited<ReturnType<SpotIvSource>>;
  try {
    spotIv = await params.spotIvSource();
  } catch (err) {
    return {
      cycledAt,
      legsScanned: 0,
      legsActioned: 0,
      actions: [],
      skipped: true,
      skipReason: `spot_iv_source_error: ${(err as Error).message}`
    };
  }

  const ageMs = nowMs - spotIv.asOfMs;
  if (ageMs > 5 * 60_000) {
    return {
      cycledAt,
      legsScanned: 0,
      legsActioned: 0,
      actions: [],
      skipped: true,
      skipReason: `stale_spot_iv: ${ageMs}ms`
    };
  }

  const legs = await listRetainedHedgeLegs(params.pool, {
    expiryAfterIso: new Date(nowMs - 5 * 60_000).toISOString()
  });

  const actions: ManagerTickResult["actions"] = [];
  let legsActioned = 0;

  for (const leg of legs) {
    const initialCostUsdc = leg.buyPriceUsdc * leg.contracts;
    const currentValueUsdc = computeLegValueUsdc({
      leg,
      spotUsdc: spotIv.spotBtcUsdc,
      ivAnnualized: spotIv.ivAnnualized || cfg.fallbackIv,
      riskFreeRate: cfg.riskFreeRate,
      nowMs
    });

    // Update running max + last value (used by rules 5 + 6).
    try {
      await updateHedgeLegTpState(params.pool, {
        legId: leg.id,
        currentValueUsdc
      });
    } catch {
      // best-effort
    }

    const decision = cfg.useStub
      ? evaluateStubRules({ leg, currentValueUsdc, initialCostUsdc, nowMs, cfg })
      : evaluateFullRules({
          leg,
          currentValueUsdc,
          initialCostUsdc,
          spotUsdc: spotIv.spotBtcUsdc,
          ivAnnualized: spotIv.ivAnnualized || cfg.fallbackIv,
          nowMs,
          cfg
        });

    // Handle reclassify (rule 8): upgrade loser → near_atm without selling.
    if (decision.reclassifyTo) {
      try {
        await params.pool.query(
          `UPDATE volume_cover_hedge_leg SET retained_role = $2 WHERE id = $1`,
          [leg.id, decision.reclassifyTo]
        );
      } catch (err) {
        console.warn(`[vc/hedgeManager] reclassify failed for leg ${leg.id}: ${(err as Error).message}`);
      }
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: decision.reclassifyTo,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "held"
      });
      actions.push({
        legId: leg.id,
        rule: decision.rule,
        action: "held",
        currentValueUsdc,
        initialCostUsdc
      });
      continue;
    }

    // Handle defer (rule 2): skip this leg this tick entirely.
    if (decision.defer) {
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: leg.retainedRole,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "skip"
      });
      actions.push({
        legId: leg.id,
        rule: decision.rule,
        action: "held",
        currentValueUsdc,
        initialCostUsdc
      });
      continue;
    }

    if (!decision.fire) {
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: leg.retainedRole,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "held"
      });
      actions.push({
        legId: leg.id,
        rule: decision.rule,
        action: "held",
        currentValueUsdc,
        initialCostUsdc
      });
      continue;
    }

    if (dryRun) {
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: leg.retainedRole,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "dry_run"
      });
      actions.push({
        legId: leg.id,
        rule: decision.rule,
        action: "dry_run",
        currentValueUsdc,
        initialCostUsdc
      });
      continue;
    }

    // Sell the leg via executor
    try {
      const sellResult = await params.executor.sellOptionLeg({
        venue: leg.venue as HedgeVenueChoice,
        optionKind: leg.optionKind,
        strikeUsdc: leg.strikeUsdc,
        expiryIso: leg.expiryIso,
        contractsBtc: leg.contracts
      });

      // Slippage observability: compare realized proceeds vs the
      // IV-implied current value the rule fired against. We do NOT
      // refuse the sell here because the order already filled at the
      // venue — refusing would create an orphan. Instead, emit a loud
      // alert when slippage exceeds VC_HM_SELL_SLIPPAGE_ALERT_PCT
      // (default 30%) so ops can investigate the IV model or venue
      // liquidity. This is a post-hoc, non-blocking guardrail.
      const slippageAlertPct = Number(process.env.VC_HM_SELL_SLIPPAGE_ALERT_PCT ?? 0.30);
      if (currentValueUsdc > 0) {
        const slippagePct = (currentValueUsdc - sellResult.totalProceedsUsdc) / currentValueUsdc;
        if (slippagePct > slippageAlertPct) {
          console.warn(
            `[VC ALERT] hedge_sell slippage > ${(slippageAlertPct * 100).toFixed(0)}% — ` +
              `legId=${leg.id} venue=${leg.venue} rule=${decision.rule} ` +
              `expected=${currentValueUsdc.toFixed(2)} ` +
              `actual=${sellResult.totalProceedsUsdc.toFixed(2)} ` +
              `slippagePct=${(slippagePct * 100).toFixed(1)}%`
          );
        }
      }

      await markHedgeLegSold(params.pool, {
        id: leg.id,
        sellPriceUsdc: sellResult.fillPriceUsdcPerBtc,
        sellOrderId: sellResult.orderId
      });
      // Ledger entry: hedge_sell_in
      try {
        await insertLedgerEntry(params.pool, {
          poolId: "atticus_hedge",
          protectionId: leg.positionId,
          entryType: "hedge_sell_in",
          amountUsdc: sellResult.totalProceedsUsdc,
          reference: `vc_hedge_sell_managed:${leg.id}`,
          metadata: {
            product: "volume_cover",
            rule: decision.rule,
            reason: decision.reason ?? null,
            retainedRole: leg.retainedRole,
            currentValueUsdc,
            initialCostUsdc,
            stub: true
          }
        });
      } catch (err) {
        console.warn(
          `[vc/hedgeManager] hedge_sell_in ledger failed for leg ${leg.id}: ${(err as Error).message}`
        );
      }
      // Finalize the position's salvage_event so Guard A (7d loss) and
      // Guard B (rolling salvage %) read realized proceeds, not the
      // 0-placeholder written at trigger time. Best-effort: ledger row
      // above is the canonical source of truth, this is the
      // guards-facing view.
      try {
        await finalizeSalvageProceedsForPosition(params.pool, {
          positionId: leg.positionId,
          proceedsUsdcDelta: sellResult.totalProceedsUsdc,
          legId: leg.id
        });
      } catch (err) {
        console.warn(
          `[vc/hedgeManager] finalizeSalvageProceeds failed for leg ${leg.id}: ${(err as Error).message}`
        );
      }
      legsActioned++;
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: leg.retainedRole,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "sold"
      });
      actions.push({
        legId: leg.id,
        rule: decision.rule,
        action: "sold",
        currentValueUsdc,
        initialCostUsdc
      });
    } catch (err) {
      console.warn(
        `[vc/hedgeManager] sellOptionLeg failed for leg ${leg.id}: ${(err as Error).message}`
      );
      await insertTelemetry(params.pool, {
        legId: leg.id,
        positionId: leg.positionId,
        retainedRole: leg.retainedRole,
        currentValueUsdc,
        initialCostUsdc,
        spotBtc: spotIv.spotBtcUsdc,
        ivAnnualized: spotIv.ivAnnualized,
        ruleEvaluated: decision.rule,
        action: "error"
      });
    }
  }

  return {
    cycledAt,
    legsScanned: legs.length,
    legsActioned,
    actions,
    skipped: false
  };
};

// ──────────────────────────── Lifecycle ────────────────────────────

let runningHandle: NodeJS.Timeout | null = null;

export const startHedgeManager = (params: {
  pool: Pool;
  executor: HedgeExecutor;
  spotIvSource: SpotIvSource;
}): { stop: () => void } => {
  if (runningHandle !== null) {
    console.warn(`[vc/hedgeManager] already running; ignoring start`);
    return { stop: () => stopHedgeManager() };
  }

  const cfg = readConfig();
  const tick = async () => {
    try {
      const result = await runOneHedgeManagerTick({
        pool: params.pool,
        executor: params.executor,
        spotIvSource: params.spotIvSource
      });
      if (result.legsActioned > 0) {
        console.log(
          `[vc/hedgeManager] tick: scanned=${result.legsScanned} actioned=${result.legsActioned}`
        );
      }
    } catch (err) {
      console.warn(`[vc/hedgeManager] tick error: ${(err as Error).message}`);
    }
  };

  // Initial tick after 5s so server boot completes
  runningHandle = setTimeout(function loop() {
    void tick();
    runningHandle = setTimeout(loop, cfg.tickIntervalMs);
  }, 5_000);

  return { stop: () => stopHedgeManager() };
};

export const stopHedgeManager = (): void => {
  if (runningHandle !== null) {
    clearTimeout(runningHandle);
    runningHandle = null;
  }
};

export const __resetHedgeManagerForTests = (): void => {
  stopHedgeManager();
  ivHistory.clear();
};
