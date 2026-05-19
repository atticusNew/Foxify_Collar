/**
 * WS#8 (Bundle C cutover, rev 6) — Operational guardrails.
 *
 * Pre-emptive (block-before-loss) and reactive (loss-already-happening)
 * guards that protect platform capital independently from the existing
 * circuit breaker, hedge budget cap, and per-tier concentration cap.
 *
 * All guards are pure functions returning a verdict. Wiring into the
 * activate path / hedge cycle happens in follow-up commits so each guard
 * is independently reviewable.
 *
 * Wave 1 (this commit, ship at cutover):
 *   - Foxify pool minimum balance kill-switch
 *   - Aggregate open liability cap
 *   - Reconciliation drift halt
 *
 * Wave 2 (next commit, ship Day 8 of pilot):
 *   - High-DVOL pause (DVOL > 100)
 *   - Bullish API health degradation pause
 *   - Daily premium velocity cap
 *
 * All guards have env kill-switches: PILOT_GUARD_<NAME>_ENABLED=false
 * disables individually; PILOT_GUARDS_ALL_DISABLED=true disables all.
 */

export type GuardVerdict = {
  allowed: boolean;
  reason: string | null;
  message: string | null;
  details?: Record<string, unknown>;
};

const ALLOWED: GuardVerdict = {
  allowed: true,
  reason: null,
  message: null
};

const guardsAllDisabled = (): boolean =>
  String(process.env.PILOT_GUARDS_ALL_DISABLED ?? "false").toLowerCase() === "true";

const isGuardEnabled = (envName: string, defaultEnabled = true): boolean => {
  if (guardsAllDisabled()) return false;
  const raw = String(process.env[envName] ?? String(defaultEnabled)).toLowerCase();
  return raw === "true";
};

// ── Wave 1 ──

/**
 * Foxify pool minimum balance kill-switch.
 *
 * Block new activations if Foxify pool balance falls below the
 * configured floor. Default floor: $0 (effectively disabled until
 * Foxify pre-funds; gate engages once pool is non-empty).
 *
 * Env: PILOT_GUARD_FOXIFY_POOL_MIN_USDC (default 0)
 *      PILOT_GUARD_FOXIFY_POOL_KILL_ENABLED (default true)
 */
export const checkFoxifyPoolMinBalance = (params: {
  foxifyPoolBalanceUsdc: number;
  projectedPayoutLiabilityUsdc: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_FOXIFY_POOL_KILL_ENABLED", true)) return ALLOWED;
  const minFloor = Number(process.env.PILOT_GUARD_FOXIFY_POOL_MIN_USDC ?? "0");
  // If Foxify pool is at $0 and not yet pre-funded, the guard does
  // nothing (the pool isn't being relied on). Once pre-funded, the
  // floor must be respected.
  const projectedBalance = params.foxifyPoolBalanceUsdc - params.projectedPayoutLiabilityUsdc;
  if (params.foxifyPoolBalanceUsdc > 0 && projectedBalance < minFloor) {
    return {
      allowed: false,
      reason: "foxify_pool_below_min_balance",
      message: `Foxify capital pool would drop below $${minFloor} after this trade. New activations paused until top-up.`,
      details: {
        currentBalanceUsdc: params.foxifyPoolBalanceUsdc,
        projectedAfterUsdc: projectedBalance,
        minFloorUsdc: minFloor
      }
    };
  }
  return ALLOWED;
};

/**
 * Aggregate open liability cap.
 *
 * Sum of (active protection notional × payout%) must stay <= Foxify pool
 * × coverage factor (default 0.8). Prevents a scenario where every
 * active protection triggers simultaneously and the pool can't pay.
 *
 * If Foxify pool balance is $0 (rev 6 default), the guard short-circuits
 * to allowed (no payout backstop required since Atticus eats the payout
 * via hedge proceeds). Once Foxify pre-funds, the guard engages.
 *
 * Env: PILOT_GUARD_AGGREGATE_LIABILITY_COVERAGE_PCT (default 0.8)
 *      PILOT_GUARD_AGGREGATE_LIABILITY_ENABLED (default true)
 */
export const checkAggregateLiabilityCap = (params: {
  foxifyPoolBalanceUsdc: number;
  totalActivePayoutLiabilityUsdc: number;
  newPayoutLiabilityUsdc: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_AGGREGATE_LIABILITY_ENABLED", true)) return ALLOWED;
  if (params.foxifyPoolBalanceUsdc <= 0) return ALLOWED; // pool not yet relied on
  const coveragePct = Number(process.env.PILOT_GUARD_AGGREGATE_LIABILITY_COVERAGE_PCT ?? "0.8");
  const maxAllowedLiability = params.foxifyPoolBalanceUsdc * coveragePct;
  const projectedTotalLiability =
    params.totalActivePayoutLiabilityUsdc + params.newPayoutLiabilityUsdc;
  if (projectedTotalLiability > maxAllowedLiability) {
    return {
      allowed: false,
      reason: "aggregate_liability_exceeds_pool_coverage",
      message: `New trade would push aggregate active payout liability above ${(coveragePct * 100).toFixed(0)}% of Foxify pool. Wait for an active protection to close first.`,
      details: {
        foxifyPoolBalanceUsdc: params.foxifyPoolBalanceUsdc,
        coveragePct,
        maxAllowedLiabilityUsdc: maxAllowedLiability,
        currentLiabilityUsdc: params.totalActivePayoutLiabilityUsdc,
        newLiabilityUsdc: params.newPayoutLiabilityUsdc,
        projectedTotalUsdc: projectedTotalLiability
      }
    };
  }
  return ALLOWED;
};

/**
 * Reconciliation drift halt.
 *
 * Compare DB-tracked Atticus pool balance against the Bullish/Deribit
 * account-statement balance. If drift > tolerance, halt new activations
 * until operator reconciles. Catches accounting bugs / missing ledger
 * entries early before they snowball.
 *
 * Env: PILOT_GUARD_RECONCILIATION_DRIFT_PCT (default 0.01 = 1%)
 *      PILOT_GUARD_RECONCILIATION_ENABLED (default true)
 */
export const checkReconciliationDrift = (params: {
  dbTrackedBalanceUsdc: number;
  venueReportedBalanceUsdc: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_RECONCILIATION_ENABLED", true)) return ALLOWED;
  if (params.venueReportedBalanceUsdc <= 0) return ALLOWED; // no venue data
  const tolerancePct = Number(process.env.PILOT_GUARD_RECONCILIATION_DRIFT_PCT ?? "0.01");
  const driftAbs = Math.abs(params.dbTrackedBalanceUsdc - params.venueReportedBalanceUsdc);
  const driftPct = driftAbs / params.venueReportedBalanceUsdc;
  if (driftPct > tolerancePct) {
    return {
      allowed: false,
      reason: "reconciliation_drift_exceeded",
      message: `Internal balance vs venue balance drift ${(driftPct * 100).toFixed(2)}% > ${(tolerancePct * 100).toFixed(2)}% tolerance. Activations paused until operator reconciles.`,
      details: {
        dbTrackedBalanceUsdc: params.dbTrackedBalanceUsdc,
        venueReportedBalanceUsdc: params.venueReportedBalanceUsdc,
        driftAbs,
        driftPct,
        tolerancePct
      }
    };
  }
  return ALLOWED;
};

// ── Wave 2 ──

/**
 * High-DVOL pause.
 *
 * DVOL > threshold (default 100, extreme crisis) = halt new sales for
 * cooldown period. Prevents underwriting new protections during black-swan
 * vol events where pricing model assumptions break down.
 *
 * Env: PILOT_GUARD_DVOL_HIGH_THRESHOLD (default 100)
 *      PILOT_GUARD_DVOL_HIGH_COOLDOWN_HOURS (default 1)
 *      PILOT_GUARD_DVOL_HIGH_ENABLED (default true)
 */
export const checkHighDvolPause = (params: {
  currentDvol: number;
  lastDvolThresholdCrossingMs: number | null;
  nowMs?: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_DVOL_HIGH_ENABLED", true)) return ALLOWED;
  const threshold = Number(process.env.PILOT_GUARD_DVOL_HIGH_THRESHOLD ?? "100");
  const cooldownHours = Number(process.env.PILOT_GUARD_DVOL_HIGH_COOLDOWN_HOURS ?? "1");
  const nowMs = params.nowMs ?? Date.now();

  if (params.currentDvol >= threshold) {
    return {
      allowed: false,
      reason: "high_dvol_extreme_pause",
      message: `BTC volatility (${params.currentDvol.toFixed(1)}) is in extreme-crisis territory (>=${threshold}). New sales paused for safety.`,
      details: { currentDvol: params.currentDvol, threshold }
    };
  }
  // Cooldown: stay paused for N hours after last crossing
  if (params.lastDvolThresholdCrossingMs !== null) {
    const elapsedHours = (nowMs - params.lastDvolThresholdCrossingMs) / 3600_000;
    if (elapsedHours < cooldownHours) {
      const remainingMin = Math.ceil((cooldownHours - elapsedHours) * 60);
      return {
        allowed: false,
        reason: "high_dvol_cooldown",
        message: `Volatility-pause cooldown active. ~${remainingMin} minutes remaining.`,
        details: { remainingMinutes: remainingMin, cooldownHours }
      };
    }
  }
  return ALLOWED;
};

/**
 * Bullish API health degradation pause.
 *
 * If Bullish API has > X% 5xx rate over last 5 minutes OR p95 latency
 * > Y seconds, halt new sales until health restored. Prevents fills at
 * stale prices when venue is degraded.
 *
 * Env: PILOT_GUARD_BULLISH_HEALTH_5XX_RATE_MAX (default 0.10 = 10%)
 *      PILOT_GUARD_BULLISH_HEALTH_P95_LATENCY_MS_MAX (default 5000)
 *      PILOT_GUARD_BULLISH_HEALTH_ENABLED (default true)
 */
export const checkBullishApiHealth = (params: {
  recent5xxRate: number;
  recentP95LatencyMs: number;
  sampleCount: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_BULLISH_HEALTH_ENABLED", true)) return ALLOWED;
  // Need minimum sample count to make a reliable health call
  const minSamples = Number(process.env.PILOT_GUARD_BULLISH_HEALTH_MIN_SAMPLES ?? "10");
  if (params.sampleCount < minSamples) return ALLOWED;

  const max5xxRate = Number(process.env.PILOT_GUARD_BULLISH_HEALTH_5XX_RATE_MAX ?? "0.10");
  const maxLatencyMs = Number(process.env.PILOT_GUARD_BULLISH_HEALTH_P95_LATENCY_MS_MAX ?? "5000");

  if (params.recent5xxRate > max5xxRate) {
    return {
      allowed: false,
      reason: "bullish_api_5xx_rate_high",
      message: `Bullish 5xx error rate ${(params.recent5xxRate * 100).toFixed(1)}% > ${(max5xxRate * 100).toFixed(1)}% threshold. Sales paused until venue recovers.`,
      details: { recent5xxRate: params.recent5xxRate, max5xxRate, sampleCount: params.sampleCount }
    };
  }
  if (params.recentP95LatencyMs > maxLatencyMs) {
    return {
      allowed: false,
      reason: "bullish_api_latency_high",
      message: `Bullish p95 latency ${params.recentP95LatencyMs}ms > ${maxLatencyMs}ms threshold. Sales paused.`,
      details: { recentP95LatencyMs: params.recentP95LatencyMs, maxLatencyMs, sampleCount: params.sampleCount }
    };
  }
  return ALLOWED;
};

/**
 * Daily premium velocity cap.
 *
 * If today's accumulated premium income > cap × historical average,
 * slow new activations (raise cooldowns or block). Catches a runaway
 * scenario where unusual demand floods the platform faster than risk
 * model assumptions support.
 *
 * Env: PILOT_GUARD_PREMIUM_VELOCITY_MAX_RATIO (default 3.0 = 3x avg)
 *      PILOT_GUARD_PREMIUM_VELOCITY_ENABLED (default true)
 */
export const checkPremiumVelocity = (params: {
  todayPremiumIncomeUsdc: number;
  rollingAvgPremiumIncomeUsdc: number;
}): GuardVerdict => {
  if (!isGuardEnabled("PILOT_GUARD_PREMIUM_VELOCITY_ENABLED", true)) return ALLOWED;
  if (params.rollingAvgPremiumIncomeUsdc <= 0) return ALLOWED; // no baseline yet
  const maxRatio = Number(process.env.PILOT_GUARD_PREMIUM_VELOCITY_MAX_RATIO ?? "3.0");
  const currentRatio = params.todayPremiumIncomeUsdc / params.rollingAvgPremiumIncomeUsdc;
  if (currentRatio > maxRatio) {
    return {
      allowed: false,
      reason: "premium_velocity_exceeded",
      message: `Today's premium income ($${params.todayPremiumIncomeUsdc.toFixed(0)}) is ${currentRatio.toFixed(1)}x the rolling average ($${params.rollingAvgPremiumIncomeUsdc.toFixed(0)}). Risk model integrity check — slowing new activations.`,
      details: {
        todayPremiumIncomeUsdc: params.todayPremiumIncomeUsdc,
        rollingAvgPremiumIncomeUsdc: params.rollingAvgPremiumIncomeUsdc,
        currentRatio,
        maxRatio
      }
    };
  }
  return ALLOWED;
};

/**
 * Compose all enabled Wave 1 guards into a single check.
 * Returns the FIRST blocking verdict, or ALLOWED if all pass.
 */
export const checkWave1Guards = (params: {
  foxifyPoolBalanceUsdc: number;
  totalActivePayoutLiabilityUsdc: number;
  newPayoutLiabilityUsdc: number;
  dbTrackedAtticusBalanceUsdc: number | null;
  venueReportedAtticusBalanceUsdc: number | null;
}): GuardVerdict => {
  const v1 = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: params.foxifyPoolBalanceUsdc,
    projectedPayoutLiabilityUsdc: params.newPayoutLiabilityUsdc
  });
  if (!v1.allowed) return v1;

  const v2 = checkAggregateLiabilityCap({
    foxifyPoolBalanceUsdc: params.foxifyPoolBalanceUsdc,
    totalActivePayoutLiabilityUsdc: params.totalActivePayoutLiabilityUsdc,
    newPayoutLiabilityUsdc: params.newPayoutLiabilityUsdc
  });
  if (!v2.allowed) return v2;

  if (params.dbTrackedAtticusBalanceUsdc !== null && params.venueReportedAtticusBalanceUsdc !== null) {
    const v3 = checkReconciliationDrift({
      dbTrackedBalanceUsdc: params.dbTrackedAtticusBalanceUsdc,
      venueReportedBalanceUsdc: params.venueReportedAtticusBalanceUsdc
    });
    if (!v3.allowed) return v3;
  }

  return ALLOWED;
};

/**
 * Compose all enabled Wave 2 guards into a single check.
 */
export const checkWave2Guards = (params: {
  currentDvol: number;
  lastDvolThresholdCrossingMs: number | null;
  bullishHealth: { recent5xxRate: number; recentP95LatencyMs: number; sampleCount: number };
  todayPremiumIncomeUsdc: number;
  rollingAvgPremiumIncomeUsdc: number;
}): GuardVerdict => {
  const v1 = checkHighDvolPause({
    currentDvol: params.currentDvol,
    lastDvolThresholdCrossingMs: params.lastDvolThresholdCrossingMs
  });
  if (!v1.allowed) return v1;

  const v2 = checkBullishApiHealth(params.bullishHealth);
  if (!v2.allowed) return v2;

  const v3 = checkPremiumVelocity({
    todayPremiumIncomeUsdc: params.todayPremiumIncomeUsdc,
    rollingAvgPremiumIncomeUsdc: params.rollingAvgPremiumIncomeUsdc
  });
  if (!v3.allowed) return v3;

  return ALLOWED;
};
