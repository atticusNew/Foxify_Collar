import Decimal from "decimal.js";
import type { PremiumRegimeRuntimeConfig } from "./config";

export type PremiumRegimeLevel = "normal" | "watch" | "stress";

export type PremiumRegimeMetrics = {
  sampleCount: number;
  triggerHitRatePct: number;
  subsidyUtilizationPct: number;
  treasuryDrawdownPct: number;
};

export type PremiumRegimeDecision = {
  regime: PremiumRegimeLevel;
  previousRegime: PremiumRegimeLevel;
  changed: boolean;
  reason: string;
  metrics: PremiumRegimeMetrics;
  holdMinutesRemaining: number;
};

export type PremiumRegimeOverlay = {
  applied: boolean;
  regime: PremiumRegimeLevel;
  basePremiumUsd: Decimal;
  adjustedPremiumUsd: Decimal;
  overlayUsd: Decimal;
  overlayPctOfBase: Decimal;
  multiplier: Decimal;
  addUsdPer1k: Decimal;
};

const regimeState = new Map<string, { regime: PremiumRegimeLevel; changedAtMs: number }>();

const meetsStressEnter = (metrics: PremiumRegimeMetrics, config: PremiumRegimeRuntimeConfig): boolean =>
  metrics.triggerHitRatePct >= config.enterStressTriggerHitRatePct ||
  metrics.subsidyUtilizationPct >= config.enterStressSubsidyUtilizationPct ||
  metrics.treasuryDrawdownPct >= config.enterStressTreasuryDrawdownPct;

const meetsWatchEnter = (metrics: PremiumRegimeMetrics, config: PremiumRegimeRuntimeConfig): boolean =>
  metrics.triggerHitRatePct >= config.enterWatchTriggerHitRatePct ||
  metrics.subsidyUtilizationPct >= config.enterWatchSubsidyUtilizationPct ||
  metrics.treasuryDrawdownPct >= config.enterWatchTreasuryDrawdownPct;

const canExitStress = (metrics: PremiumRegimeMetrics, config: PremiumRegimeRuntimeConfig): boolean =>
  metrics.triggerHitRatePct <= config.exitStressTriggerHitRatePct &&
  metrics.subsidyUtilizationPct <= config.exitStressSubsidyUtilizationPct &&
  metrics.treasuryDrawdownPct <= config.exitStressTreasuryDrawdownPct;

const canExitWatch = (metrics: PremiumRegimeMetrics, config: PremiumRegimeRuntimeConfig): boolean =>
  metrics.triggerHitRatePct <= config.exitWatchTriggerHitRatePct &&
  metrics.subsidyUtilizationPct <= config.exitWatchSubsidyUtilizationPct &&
  metrics.treasuryDrawdownPct <= config.exitWatchTreasuryDrawdownPct;

const proposeRegime = (metrics: PremiumRegimeMetrics, config: PremiumRegimeRuntimeConfig): PremiumRegimeLevel => {
  if (meetsStressEnter(metrics, config)) return "stress";
  if (meetsWatchEnter(metrics, config)) return "watch";
  return "normal";
};

export const resolvePremiumRegime = (params: {
  scopeKey: string;
  config: PremiumRegimeRuntimeConfig;
  metrics: PremiumRegimeMetrics;
  nowMs?: number;
}): PremiumRegimeDecision => {
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const stateKey = String(params.scopeKey || "default");
  const hasPreviousState = regimeState.has(stateKey);
  const previous = regimeState.get(stateKey) || { regime: "normal" as PremiumRegimeLevel, changedAtMs: nowMs };
  if (!params.config.enabled) {
    regimeState.set(stateKey, { regime: "normal", changedAtMs: nowMs });
    return {
      regime: "normal",
      previousRegime: previous.regime,
      changed: previous.regime !== "normal",
      reason: "premium_regime_disabled",
      metrics: params.metrics,
      holdMinutesRemaining: 0
    };
  }

  let next = proposeRegime(params.metrics, params.config);
  let reason = "thresholds";
  if (params.metrics.sampleCount < params.config.minSamples) {
    next = hasPreviousState ? previous.regime : "normal";
    reason = "insufficient_samples_hold";
  } else if (previous.regime === "stress" && next !== "stress") {
    if (!canExitStress(params.metrics, params.config)) {
      next = "stress";
      reason = "stress_exit_thresholds_not_met";
    }
  } else if (previous.regime === "watch" && next === "normal") {
    if (!canExitWatch(params.metrics, params.config)) {
      next = "watch";
      reason = "watch_exit_thresholds_not_met";
    }
  }

  const minDwellMs = Math.max(0, Number(params.config.minDwellMinutes || 0)) * 60_000;
  const elapsedMs = Math.max(0, nowMs - previous.changedAtMs);
  let holdMinutesRemaining = 0;
  if (hasPreviousState && next !== previous.regime && elapsedMs < minDwellMs) {
    holdMinutesRemaining = Math.ceil((minDwellMs - elapsedMs) / 60_000);
    next = previous.regime;
    reason = "min_dwell_hold";
  }

  const changed = next !== previous.regime;
  regimeState.set(stateKey, {
    regime: next,
    changedAtMs: changed ? nowMs : previous.changedAtMs
  });

  return {
    regime: next,
    previousRegime: previous.regime,
    changed,
    reason,
    metrics: params.metrics,
    holdMinutesRemaining
  };
};

export const applyPremiumRegimeOverlay = (params: {
  basePremiumUsd: Decimal;
  protectedNotionalUsd: Decimal;
  regime: PremiumRegimeLevel;
  config: PremiumRegimeRuntimeConfig;
  enabledForPricingMode: boolean;
}): PremiumRegimeOverlay => {
  const basePremiumUsd = new Decimal(params.basePremiumUsd);
  if (!params.enabledForPricingMode || params.regime === "normal" || basePremiumUsd.lte(0)) {
    return {
      applied: false,
      regime: params.regime,
      basePremiumUsd,
      adjustedPremiumUsd: basePremiumUsd,
      overlayUsd: new Decimal(0),
      overlayPctOfBase: new Decimal(0),
      multiplier: new Decimal(1),
      addUsdPer1k: new Decimal(0)
    };
  }

  const unitsPer1k = new Decimal(params.protectedNotionalUsd).div(1000);
  const addUsdPer1k = new Decimal(
    params.regime === "stress" ? params.config.stressAddUsdPer1k : params.config.watchAddUsdPer1k
  );
  const multiplier = new Decimal(
    params.regime === "stress" ? params.config.stressMultiplier : params.config.watchMultiplier
  );
  const addUsd = unitsPer1k.mul(addUsdPer1k);
  const scaledPremium = basePremiumUsd.mul(multiplier).plus(addUsd);
  const rawOverlayUsd = Decimal.max(new Decimal(0), scaledPremium.minus(basePremiumUsd));
  const capUsd = basePremiumUsd.mul(new Decimal(params.config.maxOverlayPctOfBasePremium));
  const overlayUsd = Decimal.min(rawOverlayUsd, capUsd);
  const adjustedPremiumUsd = basePremiumUsd.plus(overlayUsd);
  const overlayPctOfBase = basePremiumUsd.gt(0) ? overlayUsd.div(basePremiumUsd) : new Decimal(0);

  return {
    applied: overlayUsd.gt(0),
    regime: params.regime,
    basePremiumUsd,
    adjustedPremiumUsd,
    overlayUsd,
    overlayPctOfBase,
    multiplier,
    addUsdPer1k
  };
};

export const __resetPremiumRegimeStateForTests = (): void => {
  regimeState.clear();
};
