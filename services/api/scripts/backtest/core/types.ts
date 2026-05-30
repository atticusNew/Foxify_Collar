/**
 * Backtest harness core types (WS#9 of Bundle C cutover).
 *
 * Designed to be a single config object describing a complete pilot
 * scenario, with a deterministic engine that produces a comparable
 * scorecard. Run dozens of scenarios side-by-side from one CLI.
 */

import type { V7SlTier } from "../../../src/pilot/types";

export type BacktestRegime = "calm" | "normal" | "stress";

/** Per-tier per-regime per-$1k premium schedule. */
export type BacktestPricingSchedule = Record<BacktestRegime, Record<V7SlTier, number>>;

/** Hedge venue routing decision per tier. */
export type BacktestVenue = "bullish" | "deribit";
export type BacktestVenueRouting = Record<V7SlTier, BacktestVenue>;

/** Per-tier per-regime hedge cost markup vs Deribit baseline.
 * E.g. Bullish at +15% on hedge cost relative to Deribit. */
export type BacktestVenueCostMarkup = Record<BacktestVenue, Record<V7SlTier, number>>;

export type ScenarioConfig = {
  /** Human-readable scenario name (e.g. "current_baseline", "P3_full_bundle_c") */
  name: string;
  description: string;

  /** Pricing schedule per regime and tier */
  pricingSchedule: BacktestPricingSchedule;

  /** Which tiers are launched (offerable to traders) */
  launchedTiers: readonly V7SlTier[];

  /** Tier mix assumption — what % of trades go in each tier */
  tierMix: Partial<Record<V7SlTier, number>>;

  /** Venue routing per tier */
  venueRouting: BacktestVenueRouting;

  /** Venue hedge cost markup vs Deribit BS price (Bullish typically +15%) */
  venueCostMarkup: BacktestVenueCostMarkup;

  /** Position sizing */
  positionsPerDay: number;
  notionalPerPosition: number;

  /** Pilot duration */
  startDay: number;
  endDay: number;

  /** TP recovery rate as % of BS hedge cost (R1 baseline 68%) */
  tpRecoveryRate: number;

  /** Anti-bot defense: subtracts bot expected P&L from platform losses */
  antiBotDefenseEnabled: boolean;
  /** Estimated bot expected P&L per day at current pricing if no defense */
  botExpectedPnLPerDay: number;
};

export type RegimeDayCount = Record<BacktestRegime, number>;

export type PerTierPerRegimeMetrics = {
  trades: number;
  totalPremium: number;
  totalHedgeCost: number;
  totalExpectedPayout: number;
  totalTpRecovery: number;
  netPnL: number;
};

export type ScenarioScorecard = {
  scenarioName: string;
  description: string;
  totalDays: number;
  daysByRegime: RegimeDayCount;

  // Volume
  totalProtectionsOpened: number;
  totalNotionalUsd: number;

  // Trigger statistics
  totalTriggersFired: number;
  triggerRateBlended: number;

  // Economics — totals
  totalPremiumIncomeUsd: number;
  totalPayoutOutUsd: number;
  totalHedgeCostUsd: number;
  totalTpRecoveryUsd: number;
  netPlatformPnLUsd: number;
  netPlatformPnLPerDayUsd: number;

  // Per-tier breakdown
  perTierTotals: Partial<Record<V7SlTier, PerTierPerRegimeMetrics>>;

  // Per-regime breakdown
  perRegimeTotals: Record<BacktestRegime, PerTierPerRegimeMetrics>;

  // Risk metrics
  worstSingleRegimeLossUsd: number;
  capUtilizationPct: number; // % of $12k Atticus cap consumed

  // Bot defense (synthetic adversary)
  botExpectedPnLUsd: number;
  botBlockedByDefense: boolean;

  // Computed fields for ranking
  pilotPnLPerDay: number;
  pilotPnLProjected: number;
};

/**
 * Historical trigger rates per tier per regime, sourced from
 * docs/pilot-reports/backtest_1day_tiered_results.txt
 * (1-day tenor, 1,558 historical days).
 *
 * These are the empirical foundation for the harness. NOT derived from
 * BS — these are the actual trigger rates observed in 1,558 days of
 * historical BTC closes.
 */
export const HISTORICAL_TRIGGER_RATES: Record<V7SlTier, Record<BacktestRegime, number>> = {
  1:  { calm: 0.469, normal: 0.653, stress: 0.693 },
  2:  { calm: 0.233, normal: 0.372, stress: 0.483 },
  3:  { calm: 0.126, normal: 0.218, stress: 0.307 },
  5:  { calm: 0.036, normal: 0.085, stress: 0.113 },
  // 7% interpolated between 5% and 10% from the geometric distribution
  // of the trigger-rate curve. Will be replaced with empirical data once
  // pilot generates n>=10 7% triggers.
  7:  { calm: 0.018, normal: 0.045, stress: 0.060 },
  10: { calm: 0.009, normal: 0.011, stress: 0.020 }
};

/**
 * Historical hedge cost per $1k notional, per tier per regime.
 * Source: backtest_1day_tiered_results.txt (Hedge column, market IV).
 *
 * For Bullish, multiply by venueCostMarkup.bullish[tier] (typically +15%
 * blended average per the 2026-05-13 live comparison).
 */
export const HISTORICAL_HEDGE_COST_PER_1K: Record<V7SlTier, Record<BacktestRegime, number>> = {
  1:  { calm: 2.01, normal: 4.63, stress: 9.00 },
  2:  { calm: 0.54, normal: 2.15, stress: 5.68 },
  3:  { calm: 0.11, normal: 0.88, stress: 3.38 },
  5:  { calm: 0.00, normal: 0.10, stress: 0.99 },
  // 7% interpolated between 5% and 10%; will be empirically updated
  7:  { calm: 0.00, normal: 0.05, stress: 0.50 },
  10: { calm: 0.00, normal: 0.00, stress: 0.01 }
};

/**
 * Historical regime distribution (1,558 days):
 *   Calm:    467 days (30.0%)
 *   Normal:  790 days (50.7%)
 *   Stress:  300 days (19.3%)
 *
 * Matches CFO §3.2.
 */
export const HISTORICAL_REGIME_FRACTION: Record<BacktestRegime, number> = {
  calm: 0.30,
  normal: 0.51,
  stress: 0.19
};

/**
 * Atticus capital cap (rev 6 lock).
 */
export const ATTICUS_HEDGE_CAP_USD = 12000;
