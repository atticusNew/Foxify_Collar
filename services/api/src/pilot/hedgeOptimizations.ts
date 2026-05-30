import type { BullishTradingClient } from "./bullish";

export type HedgeOptimizationConfig = {
  autoRenewTenorEnabled: boolean;
  autoRenewTenorMultiplier: number;
  autoRenewMinDaysForExtended: number;

  rollOptimizationEnabled: boolean;
  rollSellMinProfitUsd: number;
  rollSellMinTimeValuePct: number;
  rollSellMaxDaysBeforeExpiry: number;
  rollSellMinDaysBeforeExpiry: number;
  rollSellOnlyWhenProfitable: boolean;

  batchHedgingEnabled: boolean;
  batchWindowSeconds: number;
  batchMaxPositions: number;
  batchMinNotionalUsd: number;

  dynamicStrikeEnabled: boolean;
  dynamicStrikeCalmMoneynessMin: number;
  dynamicStrikeCalmMoneynessMax: number;
  dynamicStrikeStressMoneynessMin: number;
  dynamicStrikeStressMoneynessMax: number;
  dynamicStrikeVolThresholdCalm: number;
  dynamicStrikeVolThresholdStress: number;
};

export const parseHedgeOptimizationConfig = (): HedgeOptimizationConfig => ({
  autoRenewTenorEnabled:
    envBool("PILOT_HEDGE_AUTO_RENEW_TENOR_ENABLED", false),
  autoRenewTenorMultiplier:
    envPositive("PILOT_HEDGE_AUTO_RENEW_TENOR_MULTIPLIER", 4),
  autoRenewMinDaysForExtended:
    envPositive("PILOT_HEDGE_AUTO_RENEW_MIN_DAYS_EXTENDED", 14),

  rollOptimizationEnabled:
    envBool("PILOT_HEDGE_ROLL_OPTIMIZATION_ENABLED", false),
  rollSellMinProfitUsd:
    envPositive("PILOT_HEDGE_ROLL_SELL_MIN_PROFIT_USD", 5),
  rollSellMinTimeValuePct:
    envPositive("PILOT_HEDGE_ROLL_SELL_MIN_TIME_VALUE_PCT", 10),
  rollSellMaxDaysBeforeExpiry:
    envPositive("PILOT_HEDGE_ROLL_SELL_MAX_DAYS_BEFORE_EXPIRY", 2),
  rollSellMinDaysBeforeExpiry:
    envPositive("PILOT_HEDGE_ROLL_SELL_MIN_DAYS_BEFORE_EXPIRY", 0.25),
  rollSellOnlyWhenProfitable:
    envBool("PILOT_HEDGE_ROLL_SELL_ONLY_WHEN_PROFITABLE", true),

  batchHedgingEnabled:
    envBool("PILOT_HEDGE_BATCH_ENABLED", false),
  batchWindowSeconds:
    envPositive("PILOT_HEDGE_BATCH_WINDOW_SECONDS", 30),
  batchMaxPositions:
    envPositive("PILOT_HEDGE_BATCH_MAX_POSITIONS", 50),
  batchMinNotionalUsd:
    envPositive("PILOT_HEDGE_BATCH_MIN_NOTIONAL_USD", 1000),

  dynamicStrikeEnabled:
    envBool("PILOT_HEDGE_DYNAMIC_STRIKE_ENABLED", false),
  dynamicStrikeCalmMoneynessMin:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_CALM_MONEYNESS_MIN", 0.86),
  dynamicStrikeCalmMoneynessMax:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_CALM_MONEYNESS_MAX", 0.93),
  dynamicStrikeStressMoneynessMin:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_STRESS_MONEYNESS_MIN", 0.92),
  dynamicStrikeStressMoneynessMax:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_STRESS_MONEYNESS_MAX", 0.98),
  dynamicStrikeVolThresholdCalm:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_VOL_THRESHOLD_CALM", 50),
  dynamicStrikeVolThresholdStress:
    envPositive("PILOT_HEDGE_DYNAMIC_STRIKE_VOL_THRESHOLD_STRESS", 80),
});

function envBool(key: string, fallback: boolean): boolean {
  const raw = String(process.env[key] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function envPositive(key: string, fallback: number): number {
  const parsed = Number(process.env[key] ?? String(fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type TenorDecision = {
  tenorDays: number;
  reason: string;
  extendedForAutoRenew: boolean;
  estimatedSavingsPct: number;
};

export function resolveOptimalTenor(params: {
  config: HedgeOptimizationConfig;
  requestedTenorDays: number;
  autoRenew: boolean;
  availableExpiries: Array<{ expiryMs: number; tenorDays: number }>;
}): TenorDecision {
  const { config, requestedTenorDays, autoRenew, availableExpiries } = params;

  if (!config.autoRenewTenorEnabled || !autoRenew) {
    return {
      tenorDays: requestedTenorDays,
      reason: "standard_tenor",
      extendedForAutoRenew: false,
      estimatedSavingsPct: 0
    };
  }

  const extendedDays = requestedTenorDays * config.autoRenewTenorMultiplier;
  if (extendedDays < config.autoRenewMinDaysForExtended) {
    return {
      tenorDays: requestedTenorDays,
      reason: "extended_below_minimum",
      extendedForAutoRenew: false,
      estimatedSavingsPct: 0
    };
  }

  const bestExpiry = availableExpiries
    .filter((e) => e.tenorDays >= extendedDays * 0.8 && e.tenorDays <= extendedDays * 1.5)
    .sort((a, b) => Math.abs(a.tenorDays - extendedDays) - Math.abs(b.tenorDays - extendedDays))[0];

  if (!bestExpiry) {
    return {
      tenorDays: requestedTenorDays,
      reason: "no_suitable_extended_expiry",
      extendedForAutoRenew: false,
      estimatedSavingsPct: 0
    };
  }

  const sqrtRatio = Math.sqrt(bestExpiry.tenorDays / requestedTenorDays);
  const cyclesCovered = Math.floor(bestExpiry.tenorDays / requestedTenorDays);
  const estimatedSavingsPct = Math.max(0, (1 - sqrtRatio / cyclesCovered) * 100);

  return {
    tenorDays: bestExpiry.tenorDays,
    reason: `extended_${cyclesCovered}x_cycles`,
    extendedForAutoRenew: true,
    estimatedSavingsPct: Math.round(estimatedSavingsPct)
  };
}

export type RollDecision = {
  shouldSell: boolean;
  reason: string;
  estimatedProceeds: number;
  guardrails: string[];
};

export function evaluateRollOpportunity(params: {
  config: HedgeOptimizationConfig;
  currentOptionSymbol: string;
  currentBidPrice: number | null;
  originalCost: number;
  btcQty: number;
  daysToExpiry: number;
  spotPrice: number;
  strikePrice: number;
}): RollDecision {
  const { config, currentBidPrice, originalCost, btcQty, daysToExpiry, spotPrice, strikePrice } = params;
  const guardrails: string[] = [];

  if (!config.rollOptimizationEnabled) {
    return { shouldSell: false, reason: "roll_optimization_disabled", estimatedProceeds: 0, guardrails: ["toggle_off"] };
  }

  if (daysToExpiry > config.rollSellMaxDaysBeforeExpiry) {
    guardrails.push(`too_early:${daysToExpiry.toFixed(1)}d_remaining>${config.rollSellMaxDaysBeforeExpiry}d_max`);
    return { shouldSell: false, reason: "too_early_to_roll", estimatedProceeds: 0, guardrails };
  }

  if (daysToExpiry < config.rollSellMinDaysBeforeExpiry) {
    guardrails.push(`too_late:${daysToExpiry.toFixed(1)}d_remaining<${config.rollSellMinDaysBeforeExpiry}d_min`);
    return { shouldSell: false, reason: "too_close_to_expiry_let_settle", estimatedProceeds: 0, guardrails };
  }

  if (!currentBidPrice || currentBidPrice <= 0) {
    guardrails.push("no_bid_available");
    return { shouldSell: false, reason: "no_bid_to_sell_into", estimatedProceeds: 0, guardrails };
  }

  const currentValue = currentBidPrice * btcQty;
  const intrinsicValue = Math.max(0, strikePrice - spotPrice) * btcQty;
  const timeValue = Math.max(0, currentValue - intrinsicValue);
  const timeValuePct = currentValue > 0 ? (timeValue / currentValue) * 100 : 0;
  const profit = currentValue - originalCost;

  guardrails.push(`bid=$${currentBidPrice.toFixed(0)}`);
  guardrails.push(`value=$${currentValue.toFixed(2)}`);
  guardrails.push(`intrinsic=$${intrinsicValue.toFixed(2)}`);
  guardrails.push(`time_value=$${timeValue.toFixed(2)}(${timeValuePct.toFixed(0)}%)`);
  guardrails.push(`profit=$${profit.toFixed(2)}`);
  guardrails.push(`original_cost=$${originalCost.toFixed(2)}`);

  if (config.rollSellOnlyWhenProfitable && profit < config.rollSellMinProfitUsd) {
    guardrails.push(`below_min_profit:$${profit.toFixed(2)}<$${config.rollSellMinProfitUsd}`);
    return { shouldSell: false, reason: "below_minimum_profit_threshold", estimatedProceeds: currentValue, guardrails };
  }

  if (timeValuePct < config.rollSellMinTimeValuePct) {
    guardrails.push(`time_value_too_low:${timeValuePct.toFixed(0)}%<${config.rollSellMinTimeValuePct}%`);
    if (intrinsicValue <= 0) {
      return { shouldSell: false, reason: "otm_with_low_time_value_let_expire", estimatedProceeds: currentValue, guardrails };
    }
  }

  if (profit >= config.rollSellMinProfitUsd) {
    guardrails.push("SELL_TRIGGER:profit_above_threshold");
    return { shouldSell: true, reason: "profitable_roll", estimatedProceeds: currentValue, guardrails };
  }

  if (intrinsicValue > 0 && timeValuePct >= config.rollSellMinTimeValuePct) {
    guardrails.push("SELL_TRIGGER:itm_with_time_value");
    return { shouldSell: true, reason: "itm_capture_remaining_time_value", estimatedProceeds: currentValue, guardrails };
  }

  return { shouldSell: false, reason: "no_sell_trigger_met", estimatedProceeds: currentValue, guardrails };
}

export type BatchEntry = {
  requestId: string;
  protectionType: "long" | "short";
  notionalUsd: number;
  btcQty: number;
  drawdownFloorPct: number;
  triggerPrice: number;
  premiumPer1k: number;
  createdAt: number;
};

export type BatchDecision = {
  mode: "immediate" | "batched";
  reason: string;
  batchId: string | null;
  pendingCount: number;
  totalBtcQty: number;
  totalNotionalUsd: number;
};

export class HedgeBatchManager {
  private pending: Map<string, BatchEntry[]> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private config: HedgeOptimizationConfig;
  private onFlush: ((batchId: string, entries: BatchEntry[]) => Promise<void>) | null = null;

  constructor(config: HedgeOptimizationConfig) {
    this.config = config;
  }

  setFlushHandler(handler: (batchId: string, entries: BatchEntry[]) => Promise<void>): void {
    this.onFlush = handler;
  }

  addToQueue(entry: BatchEntry): BatchDecision {
    if (!this.config.batchHedgingEnabled) {
      return {
        mode: "immediate",
        reason: "batch_hedging_disabled",
        batchId: null,
        pendingCount: 0,
        totalBtcQty: entry.btcQty,
        totalNotionalUsd: entry.notionalUsd
      };
    }

    const batchKey = entry.protectionType;
    const existing = this.pending.get(batchKey) || [];
    existing.push(entry);
    this.pending.set(batchKey, existing);

    if (existing.length >= this.config.batchMaxPositions) {
      this.flushBatch(batchKey);
      return {
        mode: "batched",
        reason: "batch_full",
        batchId: batchKey + "_" + Date.now(),
        pendingCount: 0,
        totalBtcQty: existing.reduce((s, e) => s + e.btcQty, 0),
        totalNotionalUsd: existing.reduce((s, e) => s + e.notionalUsd, 0)
      };
    }

    if (!this.timers.has(batchKey)) {
      const timer = setTimeout(() => {
        this.flushBatch(batchKey);
      }, this.config.batchWindowSeconds * 1000);
      timer.unref?.();
      this.timers.set(batchKey, timer);
    }

    const totalBtcQty = existing.reduce((s, e) => s + e.btcQty, 0);
    const totalNotional = existing.reduce((s, e) => s + e.notionalUsd, 0);

    return {
      mode: "batched",
      reason: `queued_${existing.length}_of_${this.config.batchMaxPositions}`,
      batchId: batchKey,
      pendingCount: existing.length,
      totalBtcQty,
      totalNotionalUsd: totalNotional
    };
  }

  private async flushBatch(batchKey: string): Promise<void> {
    const entries = this.pending.get(batchKey) || [];
    this.pending.delete(batchKey);
    const timer = this.timers.get(batchKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(batchKey);

    if (entries.length === 0) return;

    const batchId = `batch_${batchKey}_${Date.now()}`;
    console.log(`[HedgeBatch] Flushing ${entries.length} positions (${batchId}), total ${entries.reduce((s, e) => s + e.btcQty, 0).toFixed(4)} BTC`);

    if (this.onFlush) {
      try {
        await this.onFlush(batchId, entries);
      } catch (error) {
        console.error(`[HedgeBatch] Flush failed for ${batchId}:`, (error as Error)?.message || error);
      }
    }
  }

  forceFlushAll(): void {
    for (const key of this.pending.keys()) {
      void this.flushBatch(key);
    }
  }

  getQueueStatus(): Record<string, { count: number; totalBtcQty: number; totalNotionalUsd: number; oldestMs: number }> {
    const status: Record<string, { count: number; totalBtcQty: number; totalNotionalUsd: number; oldestMs: number }> = {};
    for (const [key, entries] of this.pending) {
      const oldest = Math.min(...entries.map((e) => e.createdAt));
      status[key] = {
        count: entries.length,
        totalBtcQty: entries.reduce((s, e) => s + e.btcQty, 0),
        totalNotionalUsd: entries.reduce((s, e) => s + e.notionalUsd, 0),
        oldestMs: Date.now() - oldest
      };
    }
    return status;
  }
}

export type VolRegime = "calm" | "neutral" | "stress";

export type DynamicStrikeDecision = {
  regime: VolRegime;
  targetMoneynessMin: number;
  targetMoneynessMax: number;
  reason: string;
  estimatedVol: number | null;
};

export function resolveDynamicStrikeRange(params: {
  config: HedgeOptimizationConfig;
  recentVolatilityPct: number | null;
  isShort: boolean;
}): DynamicStrikeDecision {
  const { config, recentVolatilityPct, isShort } = params;

  if (!config.dynamicStrikeEnabled) {
    return {
      regime: "neutral",
      targetMoneynessMin: isShort ? 1.02 : 0.88,
      targetMoneynessMax: isShort ? 1.10 : 0.96,
      reason: "dynamic_strike_disabled",
      estimatedVol: recentVolatilityPct
    };
  }

  const vol = recentVolatilityPct ?? 55;
  let regime: VolRegime;

  if (vol <= config.dynamicStrikeVolThresholdCalm) {
    regime = "calm";
  } else if (vol >= config.dynamicStrikeVolThresholdStress) {
    regime = "stress";
  } else {
    regime = "neutral";
  }

  if (isShort) {
    const ranges: Record<VolRegime, [number, number]> = {
      calm: [1.0 + (1.0 - config.dynamicStrikeCalmMoneynessMax), 1.0 + (1.0 - config.dynamicStrikeCalmMoneynessMin)],
      neutral: [1.02, 1.08],
      stress: [1.0 + (1.0 - config.dynamicStrikeStressMoneynessMax), 1.0 + (1.0 - config.dynamicStrikeStressMoneynessMin)]
    };
    const [min, max] = ranges[regime];
    return { regime, targetMoneynessMin: min, targetMoneynessMax: max, reason: `${regime}_vol_${vol.toFixed(0)}pct_call`, estimatedVol: vol };
  }

  const ranges: Record<VolRegime, [number, number]> = {
    calm: [config.dynamicStrikeCalmMoneynessMin, config.dynamicStrikeCalmMoneynessMax],
    neutral: [0.90, 0.96],
    stress: [config.dynamicStrikeStressMoneynessMin, config.dynamicStrikeStressMoneynessMax]
  };

  const [min, max] = ranges[regime];
  return { regime, targetMoneynessMin: min, targetMoneynessMax: max, reason: `${regime}_vol_${vol.toFixed(0)}pct_put`, estimatedVol: vol };
}
