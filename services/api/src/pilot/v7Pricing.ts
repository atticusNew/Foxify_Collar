import Decimal from "decimal.js";
import type { V7Regime, V7SlTier, V7PremiumQuote } from "./types";
import { V7_SL_TIERS } from "./types";

/**
 * V7 Tiered Premium Schedule — USD per $1k notional, 1-day rolling tenor.
 * Pricing curve: charge more for tight SL (expensive to hedge), less for wide SL.
 *
 * 2026-04-18 — 2% SL raised from $5 → $6/$1k. Rationale:
 *   At 1-DTE, the 2% strike concentrates ~80% of the schedule's DVOL
 *   sensitivity (gamma is highest near-the-money on short tenors). Black-
 *   Scholes hedge cost on a 2% put crosses the $5 premium at DVOL ≈ 52
 *   and the $6 premium at DVOL ≈ 62. Today's spot DVOL is ~43, so $5
 *   was profitable now; the bump buys 10 DVOL points of breakeven
 *   headroom before live pilot. Wider tiers (3/5/10%) are far less
 *   gamma-sensitive and remain unchanged. See docs/cfo-report/.
 */
const V7_RATE_PER_1K: Record<V7SlTier, number> = {
  1: 6,
  2: 6,
  3: 4,
  5: 3,
  10: 2
};

const V7_TENOR_DAYS: Record<V7SlTier, number> = {
  1: 1,
  2: 1,
  3: 1,
  5: 1,
  10: 1
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

export const getV7PremiumPer1k = (slPct: V7SlTier): number =>
  V7_RATE_PER_1K[slPct];

export const getV7TenorDays = (slPct: V7SlTier): number =>
  V7_TENOR_DAYS[slPct];

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
  const premiumPer1k = V7_RATE_PER_1K[params.slPct];
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
export const V7_LAUNCHED_TIERS: readonly V7SlTier[] = [2, 3, 5, 10] as const;

export const getV7AvailableTiers = (_regime?: V7Regime): Array<{
  slPct: V7SlTier;
  premiumPer1kUsd: number;
  tenorDays: number;
  available: boolean;
  payoutPer10kUsd: number;
}> =>
  V7_LAUNCHED_TIERS.map((slPct) => ({
    slPct,
    premiumPer1kUsd: V7_RATE_PER_1K[slPct],
    tenorDays: V7_TENOR_DAYS[slPct],
    available: true,
    payoutPer10kUsd: getV7PayoutPer10k(slPct)
  }));

/**
 * Generate the tier label stored in DB's tier_name column.
 */
export const slPctToTierLabel = (slPct: V7SlTier): string => `SL ${slPct}%`;
