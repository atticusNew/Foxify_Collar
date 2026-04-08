import Decimal from "decimal.js";
import type { V7Regime, V7SlTier, V7PremiumQuote } from "./types";
import { V7_SL_TIERS } from "./types";

/**
 * V7 Premium Schedule — USD per $1k notional, indexed by [slPct][regime].
 * Source: backtest_definitive_v7_results.txt, Section 2
 */
const V7_PREMIUM_SCHEDULE: Record<V7SlTier, Record<V7Regime, number | null>> = {
  1:  { calm: 5,  normal: 9,  stress: null },
  2:  { calm: 3,  normal: 6,  stress: 13 },
  3:  { calm: 2,  normal: 5,  stress: 12 },
  5:  { calm: 2,  normal: 4,  stress: 10 },
  10: { calm: 1,  normal: 2,  stress: 6 }
};

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

export const getV7PremiumPer1k = (slPct: V7SlTier, regime: V7Regime): number | null =>
  V7_PREMIUM_SCHEDULE[slPct]?.[regime] ?? null;

export const getV7PayoutPer10k = (slPct: V7SlTier): number =>
  V7_PAYOUT_PER_10K[slPct] ?? 0;

/**
 * Compute the V7 premium for a given SL tier, regime, and notional.
 * Returns the full quote including availability status.
 */
export const computeV7Premium = (params: {
  slPct: V7SlTier;
  regime: V7Regime;
  notionalUsd: number;
  dvol: number | null;
  regimeSource: "dvol" | "rvol";
}): V7PremiumQuote => {
  const premiumPer1k = getV7PremiumPer1k(params.slPct, params.regime);

  if (premiumPer1k === null) {
    return {
      available: false,
      slPct: params.slPct,
      regime: params.regime,
      premiumPer1kUsd: 0,
      premiumUsd: 0,
      payoutPer10kUsd: getV7PayoutPer10k(params.slPct),
      notionalUsd: params.notionalUsd,
      reason: "paused_in_stress",
      regimeSource: params.regimeSource,
      dvol: params.dvol
    };
  }

  const notional = new Decimal(params.notionalUsd);
  const premiumUsd = notional.div(1000).mul(premiumPer1k);

  return {
    available: true,
    slPct: params.slPct,
    regime: params.regime,
    premiumPer1kUsd: premiumPer1k,
    premiumUsd: premiumUsd.toNumber(),
    payoutPer10kUsd: getV7PayoutPer10k(params.slPct),
    notionalUsd: params.notionalUsd,
    regimeSource: params.regimeSource,
    dvol: params.dvol
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
export const getV7AvailableTiers = (regime: V7Regime): Array<{
  slPct: V7SlTier;
  premiumPer1kUsd: number | null;
  available: boolean;
  payoutPer10kUsd: number;
}> =>
  V7_SL_TIERS.map((slPct) => {
    const premiumPer1k = getV7PremiumPer1k(slPct, regime);
    return {
      slPct,
      premiumPer1kUsd: premiumPer1k,
      available: premiumPer1k !== null,
      payoutPer10kUsd: getV7PayoutPer10k(slPct)
    };
  });

/**
 * Generate the tier label stored in DB's tier_name column.
 */
export const slPctToTierLabel = (slPct: V7SlTier): string => `SL ${slPct}%`;
