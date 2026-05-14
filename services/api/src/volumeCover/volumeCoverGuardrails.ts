/**
 * Volume Cover guardrails.
 *
 * Three NEW guards specific to this product:
 *   A — Cumulative Atticus loss kill-switch (rolling 7d)
 *   B — Live salvage rate auto-throttle (rolling 5 triggers)
 *   C — Daily trigger-count surge pause (rolling 24h)
 *
 * Composed with the existing pilot guards (Wave 1 + Wave 2 from
 * pilot/operationalGuardrails) and circuit breaker into a single
 * verdict via checkAllGuardsForVolumeCoverActivate.
 *
 * All three NEW guards have env kill-switches:
 *   VOLUME_COVER_GUARD_LOSS_KILL_ENABLED       (default true)
 *   VOLUME_COVER_GUARD_SALVAGE_THROTTLE_ENABLED (default true)
 *   VOLUME_COVER_GUARD_TRIGGER_SURGE_ENABLED   (default true)
 *   VOLUME_COVER_GUARDS_ALL_DISABLED           (default false; override)
 *
 * All thresholds env-tunable (see each guard).
 */

import type { GuardVerdict } from "../pilot/operationalGuardrails";
import {
  checkWave1Guards,
  checkWave2Guards
} from "../pilot/operationalGuardrails";
import { isCircuitBreakerActive } from "../pilot/circuitBreaker";

const ALLOWED: GuardVerdict = {
  allowed: true,
  reason: null,
  message: null
};

// In-process state for halt flags. Persisted via DB for durability across
// restarts could be a future improvement; for MVP, restart resets halt
// to false (operator must re-trip if condition still active).
let manualHaltActive = false;
let manualHaltReason: string | null = null;

let triggerSurgePauseUntilMs: number | null = null;

const guardsAllDisabled = (): boolean =>
  String(process.env.VOLUME_COVER_GUARDS_ALL_DISABLED ?? "false").toLowerCase() === "true";

const isGuardEnabled = (envName: string, defaultEnabled = true): boolean => {
  if (guardsAllDisabled()) return false;
  const raw = String(process.env[envName] ?? String(defaultEnabled)).toLowerCase();
  return raw === "true";
};

// ────────────────────── Manual halt ──────────────────────

export const setManualHalt = (params: { halted: boolean; reason?: string }): void => {
  manualHaltActive = params.halted;
  manualHaltReason = params.halted ? (params.reason ?? "operator_halt") : null;
};

export const getManualHalt = (): { halted: boolean; reason: string | null } => ({
  halted: manualHaltActive,
  reason: manualHaltReason
});

const checkManualHalt = (): GuardVerdict => {
  if (!manualHaltActive) return ALLOWED;
  return {
    allowed: false,
    reason: "manual_halt",
    message: `New activations halted by operator: ${manualHaltReason ?? "no reason given"}`,
    details: { reason: manualHaltReason }
  };
};

// ────────────────────── Guard A: Cumulative loss kill-switch ──────────────────────

/**
 * Trip when 7-day rolling Atticus net loss on Volume Cover ≥ kill threshold.
 * Default: $5,000 (40% of $12k working capital cap).
 *
 * Action: hard halt all new activations until manual reset.
 *
 * Env: VOLUME_COVER_GUARD_LOSS_KILL_USDC (default 5000)
 *      VOLUME_COVER_GUARD_LOSS_KILL_ENABLED (default true)
 */
export const checkCumulativeLossKill = (params: {
  rolling7dayAtticusLossUsdc: number;
}): GuardVerdict => {
  if (!isGuardEnabled("VOLUME_COVER_GUARD_LOSS_KILL_ENABLED", true)) return ALLOWED;
  const threshold = Number(process.env.VOLUME_COVER_GUARD_LOSS_KILL_USDC ?? "5000");
  if (params.rolling7dayAtticusLossUsdc >= threshold) {
    return {
      allowed: false,
      reason: "cumulative_loss_kill_switch",
      message: `Atticus 7-day loss on Volume Cover ($${params.rolling7dayAtticusLossUsdc.toFixed(0)}) >= kill threshold ($${threshold}). New activations halted until manual reset.`,
      details: {
        rolling7dayLossUsdc: params.rolling7dayAtticusLossUsdc,
        thresholdUsdc: threshold
      }
    };
  }
  return ALLOWED;
};

// ────────────────────── Guard B: Salvage rate auto-throttle ──────────────────────

/**
 * Tier the response based on rolling-5-trigger salvage rate.
 *
 * Returns one of three states:
 *   - normal: salvage ≥ throttle threshold, all activations allowed
 *   - throttle: salvage in [halt, throttle), per-cell throttle reduced
 *   - halt: salvage < halt threshold, all activations blocked
 *
 * If sample size < min (default 3), defers to "normal" (insufficient
 * data; let normal flow continue, salvage tracker accumulates).
 *
 * Env: VOLUME_COVER_GUARD_SALVAGE_THROTTLE_PCT (default 0.85)
 *      VOLUME_COVER_GUARD_SALVAGE_HALT_PCT    (default 0.70)
 *      VOLUME_COVER_GUARD_SALVAGE_MIN_SAMPLES (default 3)
 *      VOLUME_COVER_GUARD_SALVAGE_THROTTLE_ENABLED (default true)
 */
export type SalvageGuardState = "normal" | "throttle" | "halt";

export const checkSalvageRate = (params: {
  rolling5TriggerSalvagePct: number | null;
  rolling5TriggerSampleCount: number;
}): GuardVerdict & { state: SalvageGuardState } => {
  if (!isGuardEnabled("VOLUME_COVER_GUARD_SALVAGE_THROTTLE_ENABLED", true)) {
    return { ...ALLOWED, state: "normal" };
  }
  const minSamples = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_MIN_SAMPLES ?? "3");
  const throttlePct = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_THROTTLE_PCT ?? "0.85");
  const haltPct = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_HALT_PCT ?? "0.70");

  if (
    params.rolling5TriggerSalvagePct === null ||
    params.rolling5TriggerSampleCount < minSamples
  ) {
    return { ...ALLOWED, state: "normal" };
  }

  if (params.rolling5TriggerSalvagePct < haltPct) {
    return {
      allowed: false,
      reason: "salvage_rate_below_halt",
      message: `Live salvage rate ${(params.rolling5TriggerSalvagePct * 100).toFixed(1)}% < halt threshold ${(haltPct * 100).toFixed(0)}%. All Volume Cover activations halted; operator review required.`,
      details: {
        salvagePct: params.rolling5TriggerSalvagePct,
        haltPct,
        sampleCount: params.rolling5TriggerSampleCount
      },
      state: "halt"
    };
  }

  if (params.rolling5TriggerSalvagePct < throttlePct) {
    // Throttle, but don't block: returning ALLOWED here lets caller
    // apply per-cell throttling externally (see throttle helper below)
    return {
      ...ALLOWED,
      state: "throttle",
      details: {
        salvagePct: params.rolling5TriggerSalvagePct,
        throttlePct,
        sampleCount: params.rolling5TriggerSampleCount,
        note: "throttle_state_active"
      }
    };
  }

  return { ...ALLOWED, state: "normal" };
};

/**
 * When salvage guard is in "throttle" state, per-cell throttle drops
 * to this lower limit (overriding the cell row's throttle_max_per_day).
 */
export const getThrottleStateMaxPerDay = (state: SalvageGuardState): number | null => {
  if (state === "throttle") {
    return Number(process.env.VOLUME_COVER_THROTTLE_LOW_PER_DAY ?? "3");
  }
  return null;
};

// ────────────────────── Guard C: Trigger-count surge pause ──────────────────────

/**
 * If >N triggers in any rolling 24h window, pause new activations
 * for cooldown duration. Likely indicates regime shift or model break.
 *
 * Env: VOLUME_COVER_GUARD_TRIGGER_COUNT_24H_MAX (default 5)
 *      VOLUME_COVER_GUARD_TRIGGER_PAUSE_MINUTES (default 30)
 *      VOLUME_COVER_GUARD_TRIGGER_SURGE_ENABLED (default true)
 */
export const checkTriggerSurge = (params: {
  rolling24hTriggerCount: number;
  nowMs?: number;
}): GuardVerdict => {
  if (!isGuardEnabled("VOLUME_COVER_GUARD_TRIGGER_SURGE_ENABLED", true)) return ALLOWED;
  const maxCount = Number(process.env.VOLUME_COVER_GUARD_TRIGGER_COUNT_24H_MAX ?? "5");
  const pauseMinutes = Number(process.env.VOLUME_COVER_GUARD_TRIGGER_PAUSE_MINUTES ?? "30");
  const nowMs = params.nowMs ?? Date.now();

  if (params.rolling24hTriggerCount > maxCount) {
    triggerSurgePauseUntilMs = nowMs + pauseMinutes * 60_000;
    return {
      allowed: false,
      reason: "trigger_surge_pause",
      message: `${params.rolling24hTriggerCount} triggers in last 24h > max ${maxCount}. Pausing new activations for ${pauseMinutes} minutes; operator paged.`,
      details: {
        triggerCount: params.rolling24hTriggerCount,
        maxCount,
        pauseUntilIso: new Date(triggerSurgePauseUntilMs).toISOString()
      }
    };
  }

  // Still within active pause from a prior trip
  if (triggerSurgePauseUntilMs !== null && nowMs < triggerSurgePauseUntilMs) {
    const remainingMin = Math.ceil((triggerSurgePauseUntilMs - nowMs) / 60_000);
    return {
      allowed: false,
      reason: "trigger_surge_cooldown",
      message: `Trigger-surge pause active. ~${remainingMin} minutes remaining.`,
      details: {
        remainingMinutes: remainingMin,
        pauseUntilIso: new Date(triggerSurgePauseUntilMs).toISOString()
      }
    };
  }

  return ALLOWED;
};

// ────────────────────── Composer ──────────────────────

export type VolumeCoverGuardCheckParams = {
  // Wave 1 inputs
  foxifyPoolBalanceUsdc: number;
  totalActivePayoutLiabilityUsdc: number;
  newPayoutLiabilityUsdc: number;
  dbTrackedAtticusBalanceUsdc: number | null;
  venueReportedAtticusBalanceUsdc: number | null;
  // Wave 2 inputs
  currentDvol: number;
  lastDvolThresholdCrossingMs: number | null;
  bullishHealth: { recent5xxRate: number; recentP95LatencyMs: number; sampleCount: number };
  todayPremiumIncomeUsdc: number;
  rollingAvgPremiumIncomeUsdc: number;
  // Volume Cover-specific inputs
  rolling7dayAtticusLossUsdc: number;
  rolling5TriggerSalvagePct: number | null;
  rolling5TriggerSampleCount: number;
  rolling24hTriggerCount: number;
};

export type VolumeCoverGuardVerdict = GuardVerdict & {
  salvageState: SalvageGuardState;
  /** If non-null, caller must apply this as the per-cell throttle override */
  throttleOverridePerDay: number | null;
};

/**
 * Run all guards in order. Returns FIRST blocking verdict, or ALLOWED
 * with salvage state + throttle override metadata.
 *
 * Order is intentional:
 *   1. Manual halt (operator override beats everything)
 *   2. Circuit breaker (equity drawdown — protects platform first)
 *   3. Wave 1 (Foxify pool / aggregate liability / reconciliation drift)
 *   4. Wave 2 (DVOL / Bullish health / premium velocity)
 *   5. Volume Cover Guard A (cumulative loss kill — same severity as circuit breaker)
 *   6. Volume Cover Guard B (salvage rate; halt or throttle)
 *   7. Volume Cover Guard C (trigger surge pause)
 */
export const checkAllGuardsForVolumeCoverActivate = (
  params: VolumeCoverGuardCheckParams
): VolumeCoverGuardVerdict => {
  const wrapAllowed = (state: SalvageGuardState): VolumeCoverGuardVerdict => ({
    ...ALLOWED,
    salvageState: state,
    throttleOverridePerDay: getThrottleStateMaxPerDay(state)
  });

  const wrapBlocked = (verdict: GuardVerdict, state: SalvageGuardState = "normal"): VolumeCoverGuardVerdict => ({
    ...verdict,
    salvageState: state,
    throttleOverridePerDay: getThrottleStateMaxPerDay(state)
  });

  // 1. Manual halt
  const halt = checkManualHalt();
  if (!halt.allowed) return wrapBlocked(halt);

  // 2. Circuit breaker
  if (isCircuitBreakerActive()) {
    return wrapBlocked({
      allowed: false,
      reason: "circuit_breaker_active",
      message: "Equity circuit breaker is tripped. New Volume Cover activations blocked until cooldown or manual reset.",
      details: {}
    });
  }

  // 3. Wave 1
  const wave1 = checkWave1Guards({
    foxifyPoolBalanceUsdc: params.foxifyPoolBalanceUsdc,
    totalActivePayoutLiabilityUsdc: params.totalActivePayoutLiabilityUsdc,
    newPayoutLiabilityUsdc: params.newPayoutLiabilityUsdc,
    dbTrackedAtticusBalanceUsdc: params.dbTrackedAtticusBalanceUsdc,
    venueReportedAtticusBalanceUsdc: params.venueReportedAtticusBalanceUsdc
  });
  if (!wave1.allowed) return wrapBlocked(wave1);

  // 4. Wave 2
  const wave2 = checkWave2Guards({
    currentDvol: params.currentDvol,
    lastDvolThresholdCrossingMs: params.lastDvolThresholdCrossingMs,
    bullishHealth: params.bullishHealth,
    todayPremiumIncomeUsdc: params.todayPremiumIncomeUsdc,
    rollingAvgPremiumIncomeUsdc: params.rollingAvgPremiumIncomeUsdc
  });
  if (!wave2.allowed) return wrapBlocked(wave2);

  // 5. Volume Cover Guard A
  const guardA = checkCumulativeLossKill({
    rolling7dayAtticusLossUsdc: params.rolling7dayAtticusLossUsdc
  });
  if (!guardA.allowed) return wrapBlocked(guardA);

  // 6. Volume Cover Guard B
  const guardB = checkSalvageRate({
    rolling5TriggerSalvagePct: params.rolling5TriggerSalvagePct,
    rolling5TriggerSampleCount: params.rolling5TriggerSampleCount
  });
  if (guardB.state === "halt") return wrapBlocked(guardB, "halt");

  // 7. Volume Cover Guard C
  const guardC = checkTriggerSurge({
    rolling24hTriggerCount: params.rolling24hTriggerCount
  });
  if (!guardC.allowed) return wrapBlocked(guardC, guardB.state);

  // All passed — propagate salvage state for throttle decision
  return wrapAllowed(guardB.state);
};

// ────────────────────── Test helpers ──────────────────────

export const __resetVolumeCoverGuardrailsForTests = (): void => {
  manualHaltActive = false;
  manualHaltReason = null;
  triggerSurgePauseUntilMs = null;
};
