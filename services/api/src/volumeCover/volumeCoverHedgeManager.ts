/**
 * P1f — Volume Cover hedge manager (STUB).
 *
 * Manages Atticus-retained hedge legs after Foxify close OR trigger.
 * Runs every VC_HM_TICK_MS (default 60s). For each retained leg:
 *   1. Fetch current spot + IV
 *   2. Compute current option value via Black-Scholes
 *   3. Apply TP rules in priority order
 *   4. On match: sell leg via executor, mark sold, ledger hedge_sell_in,
 *      finalize salvage event if last leg of a triggered position
 *
 * STUB rules deployed Hour 0-36 (full 12-rule curve in P2.5):
 *   1.  Time-decay forced exit (expiry - now < 4h)
 *   7.  Loser leg early exit (current < initial × 20% OR 4h post-trigger)
 *   12. Hard floor (current < initial × 10%)
 *   W1. Stub winner-side time-cap (winner_post_trigger ≥ 24h elapsed)
 *
 * Telemetry: every tick logs to volume_cover_hedge_leg_telemetry
 * (capped 7-day retention via daily housekeeping).
 *
 * Dry-run mode (VC_HM_DRY_RUN=true): logs would-fire actions WITHOUT
 * selling. Used in staging smoke + before flipping live.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { bsPut, bsCall } from "../pilot/blackScholes";
import {
  listRetainedHedgeLegs,
  markHedgeLegSold,
  type HedgeLegRow,
  type RetainedRole
} from "./volumeCoverDb";
import { insertLedgerEntry } from "../pilot/capitalPoolLedger";
import type { HedgeExecutor, HedgeVenueChoice } from "./tightHedge";

// ──────────────────────────── Config ────────────────────────────

export type HedgeManagerConfig = {
  tickIntervalMs: number;
  /** Rule 1 — time-decay forced exit threshold (hours before expiry). */
  timeDecayExitHours: number;
  /** Rule 7 — loser leg floor (fraction of initial cost). */
  loserFloorPct: number;
  /** Rule 7 — loser leg max grace period post-trigger (hours). */
  loserGraceHours: number;
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
  timeDecayExitHours: 4,
  loserFloorPct: 0.20,
  loserGraceHours: 4,
  hardFloorPct: 0.10,
  stubWinnerTimecapHours: 24,
  riskFreeRate: 0.045,
  fallbackIv: 0.65
};

const readConfig = (): HedgeManagerConfig => {
  const cfg = { ...DEFAULTS };
  const env = process.env;
  const num = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  cfg.tickIntervalMs = num(env.VC_HM_TICK_MS, cfg.tickIntervalMs);
  cfg.timeDecayExitHours = num(env.VC_TP_TIME_EXIT_HOURS, cfg.timeDecayExitHours);
  cfg.loserFloorPct = num(env.VC_TP_LOSER_FLOOR_PCT, cfg.loserFloorPct);
  cfg.loserGraceHours = num(env.VC_TP_LOSER_GRACE_HOURS, cfg.loserGraceHours);
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
  reason?: string;
};

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

  // Rule 1 — time-decay forced exit (overrides everything)
  if (hoursToExpiry < cfg.timeDecayExitHours) {
    return { rule: "1_time_decay_exit", fire: true, reason: `${hoursToExpiry.toFixed(2)}h to expiry` };
  }

  // Rule 12 — hard floor
  if (currentValueUsdc < initialCostUsdc * cfg.hardFloorPct) {
    return { rule: "12_hard_floor", fire: true, reason: `value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.hardFloorPct).toFixed(2)}` };
  }

  // Role-specific rules
  const role = leg.retainedRole as RetainedRole | null;
  const retainedAtMs = leg.retainedAt ? new Date(leg.retainedAt).getTime() : nowMs;
  const hoursSinceRetention = (nowMs - retainedAtMs) / 3_600_000;

  if (role === "loser_post_trigger") {
    // Rule 7a — value below loser floor
    if (currentValueUsdc < initialCostUsdc * cfg.loserFloorPct) {
      return { rule: "7_loser_floor", fire: true, reason: `loser value ${currentValueUsdc.toFixed(2)} < ${(initialCostUsdc * cfg.loserFloorPct).toFixed(2)}` };
    }
    // Rule 7b — grace expired
    if (hoursSinceRetention >= cfg.loserGraceHours) {
      return { rule: "7_loser_grace", fire: true, reason: `${hoursSinceRetention.toFixed(2)}h since retention ≥ grace ${cfg.loserGraceHours}` };
    }
  }

  if (role === "winner_post_trigger") {
    // Rule W1 (stub-only) — time cap on winner
    if (hoursSinceRetention >= cfg.stubWinnerTimecapHours) {
      return { rule: "W1_stub_winner_timecap", fire: true, reason: `${hoursSinceRetention.toFixed(2)}h since retention ≥ ${cfg.stubWinnerTimecapHours}` };
    }
  }

  // For near_atm_post_close / stale_post_close in stub: also evaluate
  // simple time-cap (24h) so retained-on-close legs eventually clear.
  if (role === "near_atm_post_close" || role === "stale_post_close") {
    if (hoursSinceRetention >= cfg.stubWinnerTimecapHours) {
      return { rule: "W1_stub_close_timecap", fire: true, reason: `${hoursSinceRetention.toFixed(2)}h since retention ≥ ${cfg.stubWinnerTimecapHours}` };
    }
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

    const decision = evaluateStubRules({ leg, currentValueUsdc, initialCostUsdc, nowMs, cfg });

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

export const __resetHedgeManagerForTests = (): void => stopHedgeManager();
