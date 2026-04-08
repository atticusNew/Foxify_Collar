import Decimal from "decimal.js";
import type { V7Regime, V7SlTier, V7PremiumQuote } from "./types";
import { V7_SL_TIERS } from "./types";

/**
 * V7 Premium: flat $8 per $1k notional, all tiers, all conditions.
 * 1-day rolling tenor. Source: backtest_1day_tenor_results.txt
 */
const V7_FLAT_PREMIUM_PER_1K = 8;

/**
 * Payout per $10k position, indexed by SL%.
 * Payout = notional × (slPct / 100)
 */
const V7_PAYOUT_PER_10K: Record<V7SlTier, number> = {
  1: 100,
  2: 200,
  3: 300,
  5: 500,
  10: 1000
};

export const isValidSlTier = (slPct: number): slPct is V7SlTier =>
  (V7_SL_TIERS as readonly number[]).includes(slPct);

export const getV7PremiumPer1k = (slPct: V7SlTier, _regime?: V7Regime): number =>
  V7_FLAT_PREMIUM_PER_1K;

export const getV7PayoutPer10k = (slPct: V7SlTier): number =>
  V7_PAYOUT_PER_10K[slPct] ?? 0;

/**
 * Compute the V7 premium for a given SL tier, regime, and notional.
 * Returns the full quote including availability status.
 */
export const computeV7Premium = (params: {
  slPct: V7SlTier;
  regime?: V7Regime;
  notionalUsd: number;
  dvol?: number | null;
  regimeSource?: "dvol" | "rvol";
}): V7PremiumQuote => {
  const premiumPer1k = V7_FLAT_PREMIUM_PER_1K;
  const notional = new Decimal(params.notionalUsd);
  const premiumUsd = notional.div(1000).mul(premiumPer1k);

  return {
    available: true,
    slPct: params.slPct,
    regime: params.regime ?? "normal",
    premiumPer1kUsd: premiumPer1k,
    premiumUsd: premiumUsd.toNumber(),
    payoutPer10kUsd: getV7PayoutPer10k(params.slPct),
    notionalUsd: params.notionalUsd,
    regimeSource: params.regimeSource ?? "rvol",
    dvol: params.dvol ?? null
  };
};

/**
 * Compute drawdown floor percentage from SL tier.
 * slPct 2 → drawdownFloorPct 0.02
 */
export const slPctToDrawdownFloor = (slPct: V7SlTier): Decimal =>
  new Decimal(slPct).div(100);

/**
 * Compute payout for a given notional and SL%.
 * payout = notional × (slPct / 100)
 */
export const computeV7Payout = (notionalUsd: Decimal, slPct: V7SlTier): Decimal =>
  notionalUsd.mul(new Decimal(slPct).div(100));

/**
 * Get the trigger price given entry price and SL%.
 * For long protection: trigger = entry × (1 - slPct/100)
 */
export const computeV7TriggerPrice = (
  entryPrice: Decimal,
  slPct: V7SlTier,
  protectionType: "long" | "short" = "long"
): Decimal => {
  const move = new Decimal(slPct).div(100);
  return protectionType === "short"
    ? entryPrice.mul(new Decimal(1).plus(move))
    : entryPrice.mul(new Decimal(1).minus(move));
};

/**
 * Get the option strike for hedging. Strike = trigger price.
 * For a long protection put hedge: strike = entry × (1 - slPct/100)
 */
export const computeV7HedgeStrike = (
  entryPrice: Decimal,
  slPct: V7SlTier,
  protectionType: "long" | "short" = "long"
): Decimal => computeV7TriggerPrice(entryPrice, slPct, protectionType);

/**
 * Get all available tiers for a given regime with their premiums.
 */
export const getV7AvailableTiers = (_regime?: V7Regime): Array<{
  slPct: V7SlTier;
  premiumPer1kUsd: number;
  available: boolean;
  payoutPer10kUsd: number;
}> =>
  V7_SL_TIERS.map((slPct) => ({
    slPct,
    premiumPer1kUsd: V7_FLAT_PREMIUM_PER_1K,
    available: true,
    payoutPer10kUsd: getV7PayoutPer10k(slPct)
  }));

/**
 * Generate the tier label stored in DB's tier_name column.
 */
export const slPctToTierLabel = (slPct: V7SlTier): string => `SL ${slPct}%`;
