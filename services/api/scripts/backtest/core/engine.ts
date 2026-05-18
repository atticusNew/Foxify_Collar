/**
 * Backtest engine — runs one ScenarioConfig and produces a ScorecardOutput.
 *
 * Methodology:
 *   1. For each pilot day, draw a regime from the historical distribution
 *      (or use a deterministic seed for reproducibility).
 *   2. For each position opened that day, draw a tier from the tier mix.
 *   3. Look up trigger rate, hedge cost, payout for that (tier, regime).
 *   4. Apply venue-specific hedge cost markup.
 *   5. Compute per-trade premium = (regime schedule rate) × (notional/1000).
 *   6. Compute expected payout = trigger rate × notional × tier%
 *   7. Compute TP recovery = trigger rate × hedge cost × tpRecoveryRate
 *   8. Aggregate per-tier per-regime metrics and produce scorecard.
 *
 * Determinism: when seed is provided, regime + tier draws are reproducible.
 * Default uses expected-value math (no random sampling) for stable comparison
 * across scenarios.
 *
 * Limitations:
 *   - Does not simulate intraday paths or trigger-event clustering
 *   - Does not simulate the TP system's decision tree (uses constant tpRecoveryRate)
 *   - Does not simulate multi-tenant cap interactions
 *   - Bot defense modeled as a flat per-day P&L delta, not a real adversary
 *
 * These limitations are acceptable for Bundle C economic ranking; the
 * harness output is the GATE 1 sign-off material, not a live-fire test.
 */

import type {
  ScenarioConfig,
  ScenarioScorecard,
  PerTierPerRegimeMetrics,
  BacktestRegime,
  RegimeDayCount
} from "./types";
import {
  HISTORICAL_TRIGGER_RATES,
  HISTORICAL_HEDGE_COST_PER_1K,
  HISTORICAL_REGIME_FRACTION,
  ATTICUS_HEDGE_CAP_USD
} from "./types";
import type { V7SlTier } from "../../../src/pilot/types";

const REGIMES: BacktestRegime[] = ["calm", "normal", "stress"];

const newPerTierMetrics = (): PerTierPerRegimeMetrics => ({
  trades: 0,
  totalPremium: 0,
  totalHedgeCost: 0,
  totalExpectedPayout: 0,
  totalTpRecovery: 0,
  netPnL: 0
});

export const runScenario = (config: ScenarioConfig): ScenarioScorecard => {
  const totalDays = config.endDay - config.startDay + 1;

  // Allocate days per regime by historical distribution (expected value).
  const daysByRegime: RegimeDayCount = {
    calm: Math.round(totalDays * HISTORICAL_REGIME_FRACTION.calm),
    normal: Math.round(totalDays * HISTORICAL_REGIME_FRACTION.normal),
    stress: Math.round(totalDays * HISTORICAL_REGIME_FRACTION.stress)
  };
  // Fix any rounding drift to match totalDays exactly
  const regimeDayTotal = daysByRegime.calm + daysByRegime.normal + daysByRegime.stress;
  if (regimeDayTotal !== totalDays) {
    daysByRegime.normal += totalDays - regimeDayTotal;
  }

  // Normalize tier mix in case it doesn't sum to 1
  const tierMixSum = config.launchedTiers.reduce(
    (s, t) => s + (config.tierMix[t] || 0),
    0
  );
  const normalizedTierMix: Partial<Record<V7SlTier, number>> = {};
  for (const t of config.launchedTiers) {
    normalizedTierMix[t] = (config.tierMix[t] || 0) / (tierMixSum || 1);
  }

  // Per-tier per-regime accumulator
  const perTierPerRegime: Map<string, PerTierPerRegimeMetrics> = new Map();
  const key = (t: V7SlTier, r: BacktestRegime) => `${t}|${r}`;

  let totalProtectionsOpened = 0;
  let totalNotionalUsd = 0;
  let totalTriggersFired = 0;
  let totalPremiumIncomeUsd = 0;
  let totalPayoutOutUsd = 0;
  let totalHedgeCostUsd = 0;
  let totalTpRecoveryUsd = 0;
  let worstSingleRegimeLossUsd = 0;

  for (const regime of REGIMES) {
    const daysInRegime = daysByRegime[regime];
    let regimePnL = 0;

    for (const tier of config.launchedTiers) {
      const tierFraction = normalizedTierMix[tier] || 0;
      if (tierFraction === 0) continue;

      // Number of trades in this tier × this regime over the pilot window
      const tradesInBucket = config.positionsPerDay * daysInRegime * tierFraction;
      const notionalInBucket = tradesInBucket * config.notionalPerPosition;

      // Premium income: regime rate × notional/$1k × trades
      const premiumPer1k = config.pricingSchedule[regime][tier];
      const totalPremium = (notionalInBucket / 1000) * premiumPer1k;

      // Hedge cost: BS hedge cost per $1k × notional/$1k × venue markup
      const venue = config.venueRouting[tier];
      const baseHedgePer1k = HISTORICAL_HEDGE_COST_PER_1K[tier][regime];
      const venueMarkup = config.venueCostMarkup[venue][tier] || 1.0;
      const totalHedgeCost = (notionalInBucket / 1000) * baseHedgePer1k * venueMarkup;

      // Expected payouts: trigger rate × payout amount × trades
      const triggerRate = HISTORICAL_TRIGGER_RATES[tier][regime];
      const payoutPerTrade = config.notionalPerPosition * (tier / 100);
      const totalExpectedPayout = tradesInBucket * triggerRate * payoutPerTrade;

      // TP recovery: trigger rate × hedge cost × recovery rate
      // (recover 68% of BS hedge cost on triggered trades; non-triggered = 0)
      const totalTpRecovery =
        tradesInBucket * triggerRate * (baseHedgePer1k * (config.notionalPerPosition / 1000)) *
        config.tpRecoveryRate;

      const netPnL =
        totalPremium - totalHedgeCost - totalExpectedPayout + totalTpRecovery;

      // Accumulate per-bucket
      const bucket = newPerTierMetrics();
      bucket.trades = tradesInBucket;
      bucket.totalPremium = totalPremium;
      bucket.totalHedgeCost = totalHedgeCost;
      bucket.totalExpectedPayout = totalExpectedPayout;
      bucket.totalTpRecovery = totalTpRecovery;
      bucket.netPnL = netPnL;
      perTierPerRegime.set(key(tier, regime), bucket);

      // Aggregate totals
      totalProtectionsOpened += tradesInBucket;
      totalNotionalUsd += notionalInBucket;
      totalTriggersFired += tradesInBucket * triggerRate;
      totalPremiumIncomeUsd += totalPremium;
      totalPayoutOutUsd += totalExpectedPayout;
      totalHedgeCostUsd += totalHedgeCost;
      totalTpRecoveryUsd += totalTpRecovery;
      regimePnL += netPnL;
    }

    if (regimePnL < worstSingleRegimeLossUsd) {
      worstSingleRegimeLossUsd = regimePnL;
    }
  }

  // Anti-bot defense: if enabled, neutralize bot's expected daily extraction
  // If disabled, bot extracts botExpectedPnLPerDay × totalDays from platform
  const botExpectedPnLUsd = config.antiBotDefenseEnabled
    ? 0
    : config.botExpectedPnLPerDay * totalDays;

  const netPlatformPnLUsd =
    totalPremiumIncomeUsd
    - totalHedgeCostUsd
    - totalPayoutOutUsd
    + totalTpRecoveryUsd
    - botExpectedPnLUsd;

  // Roll up per-tier and per-regime totals
  const perTierTotals: Partial<Record<V7SlTier, PerTierPerRegimeMetrics>> = {};
  const perRegimeTotals: Record<BacktestRegime, PerTierPerRegimeMetrics> = {
    calm: newPerTierMetrics(),
    normal: newPerTierMetrics(),
    stress: newPerTierMetrics()
  };

  for (const tier of config.launchedTiers) {
    perTierTotals[tier] = newPerTierMetrics();
  }

  for (const [k, v] of perTierPerRegime) {
    const [tierStr, regime] = k.split("|");
    const tier = Number(tierStr) as V7SlTier;

    const tierTotal = perTierTotals[tier]!;
    tierTotal.trades += v.trades;
    tierTotal.totalPremium += v.totalPremium;
    tierTotal.totalHedgeCost += v.totalHedgeCost;
    tierTotal.totalExpectedPayout += v.totalExpectedPayout;
    tierTotal.totalTpRecovery += v.totalTpRecovery;
    tierTotal.netPnL += v.netPnL;

    const regimeTotal = perRegimeTotals[regime as BacktestRegime];
    regimeTotal.trades += v.trades;
    regimeTotal.totalPremium += v.totalPremium;
    regimeTotal.totalHedgeCost += v.totalHedgeCost;
    regimeTotal.totalExpectedPayout += v.totalExpectedPayout;
    regimeTotal.totalTpRecovery += v.totalTpRecovery;
    regimeTotal.netPnL += v.netPnL;
  }

  const triggerRateBlended =
    totalProtectionsOpened > 0 ? totalTriggersFired / totalProtectionsOpened : 0;
  const capUtilizationPct =
    ATTICUS_HEDGE_CAP_USD > 0 ? (totalHedgeCostUsd / ATTICUS_HEDGE_CAP_USD) * 100 : 0;
  const pilotPnLPerDay = totalDays > 0 ? netPlatformPnLUsd / totalDays : 0;

  return {
    scenarioName: config.name,
    description: config.description,
    totalDays,
    daysByRegime,
    totalProtectionsOpened,
    totalNotionalUsd,
    totalTriggersFired,
    triggerRateBlended,
    totalPremiumIncomeUsd,
    totalPayoutOutUsd,
    totalHedgeCostUsd,
    totalTpRecoveryUsd,
    netPlatformPnLUsd,
    netPlatformPnLPerDayUsd: pilotPnLPerDay,
    perTierTotals,
    perRegimeTotals,
    worstSingleRegimeLossUsd,
    capUtilizationPct,
    botExpectedPnLUsd,
    botBlockedByDefense: config.antiBotDefenseEnabled,
    pilotPnLPerDay,
    pilotPnLProjected: netPlatformPnLUsd
  };
};
