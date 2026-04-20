import Decimal from "decimal.js";
import type { V7Regime, V7SlTier, V7PremiumQuote } from "./types";
import { V7_SL_TIERS } from "./types";
import {
  getCurrentPricingRegime,
  getPremiumPer1kForRegime,
  type PricingRegime
} from "./pricingRegime";

/**
 * V7 Tiered Premium Schedule — USD per $1k notional, 1-day rolling tenor.
 * Pricing curve: charge more for tight SL (expensive to hedge), less for wide SL.
 *
 * 2026-04-19 — Design A (regime-adjusted dynamic pricing).
 *   The platform now consults pricingRegime.ts at quote time to pick a
 *   schedule based on a 1-hour rolling DVOL average. Trader experience
 *   remains "fixed price + instant payout" — the price quoted is locked
 *   when activated. The schedule simply adjusts for market conditions
 *   so the platform doesn't sell calm-priced product into a stress
 *   regime. Capped at $9/$1k for the 2% tier (CEO trader-acceptance
 *   ceiling). See docs/cfo-report/ and services/api/src/pilot/pricingRegime.ts.
 *
 * The static V7_RATE_PER_1K below is retained as a LEGACY FALLBACK for
 * any code path that didn't go through pricingRegime (e.g., tests, the
 * /pilot/protections endpoint that displays a default rate when no
 * quote has been requested yet). Production pricing is via
 * computeV7Premium → getPremiumPer1kForRegime.
 */
const V7_RATE_PER_1K: Record<V7SlTier, number> = {
  1: 6,
  2: 6,
  3: 5,
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

/**
 * Get the per-$1k premium rate for a tier. Default behavior: consult
 * the live pricing regime (Design A). Pass `useLegacyStaticRate=true`
 * to bypass the regime classifier and return the static fallback —
 * only meaningful in tests.
 */
export const getV7PremiumPer1k = (
  slPct: V7SlTier,
  options?: { useLegacyStaticRate?: boolean }
): number => {
  if (options?.useLegacyStaticRate) return V7_RATE_PER_1K[slPct];
  const regime = getCurrentPricingRegime().regime;
  return getPremiumPer1kForRegime(slPct, regime);
};

export const getV7TenorDays = (slPct: V7SlTier): number =>
  V7_TENOR_DAYS[slPct];

export const getV7PayoutPer10k = (slPct: V7SlTier): number =>
  V7_PAYOUT_PER_10K[slPct] ?? 0;

/**
 * Compute the V7 premium for a given SL tier, regime, and notional.
 *
 * Design A pricing path:
 *   1. If a pricing regime is available (live DVOL feed), use the
 *      regime-specific schedule.
 *   2. If only the legacy V7Regime is supplied, map to PricingRegime.
 *   3. Fall back to the static V7_RATE_PER_1K only if no regime info
 *      is available (e.g., tests that bypass the regime classifier).
 *
 * Returns the full quote including the resolved regime label and
 * the rolling DVOL window the price was computed against — both are
 * persisted on the protection record so we can audit "what regime was
 * I in when this trade was priced?"
 */
export const computeV7Premium = (params: {
  slPct: V7SlTier;
  regime?: V7Regime;
  notionalUsd: number;
  dvol?: number | null;
  regimeSource?: "dvol" | "rvol";
  /**
   * Optional explicit pricing regime override. When provided, takes
   * precedence over the live regime classifier. Used by tests and by
   * routes that want to lock a specific regime for a quote ID.
   */
  pricingRegimeOverride?: PricingRegime;
}): V7PremiumQuote => {
  let pricingRegime: PricingRegime;
  let dvolForLog: number | null = params.dvol ?? null;

  if (params.pricingRegimeOverride) {
    pricingRegime = params.pricingRegimeOverride;
  } else {
    const status = getCurrentPricingRegime(params.dvol);
    pricingRegime = status.regime;
    if (status.dvol !== null) dvolForLog = status.dvol;
  }

  const premiumPer1k = getPremiumPer1kForRegime(params.slPct, pricingRegime);
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
    dvol: dvolForLog
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

export const getV7AvailableTiers = (
  _legacyRegime?: V7Regime,
  pricingRegimeOverride?: PricingRegime
): Array<{
  slPct: V7SlTier;
  premiumPer1kUsd: number;
  tenorDays: number;
  available: boolean;
  payoutPer10kUsd: number;
}> => {
  // Picks the active pricing regime in this order of preference:
  //   1. explicit override (used by tests / locked-quote replay)
  //   2. Design A live classifier
  //
  // The legacy V7Regime parameter (calm/normal/stress) is intentionally
  // IGNORED. The legacy classifier's "calm" upper boundary is 40 while
  // Design A's "low" upper boundary is 50, so DVOL values in the
  // 40-50 band are classified differently by each — the legacy says
  // "normal" (→ moderate pricing $7) while Design A says "low"
  // ($6 pricing). Using the legacy mapping caused the widget to display
  // "Volatility: Low" alongside the moderate $7 schedule (deployed
  // 2026-04-19, observed at DVOL 42.4 → low label + $7 price).
  // The fix: always source pricing from Design A.
  const pricingRegime: PricingRegime =
    pricingRegimeOverride ?? getCurrentPricingRegime().regime;
  return V7_LAUNCHED_TIERS.map((slPct) => ({
    slPct,
    premiumPer1kUsd: getPremiumPer1kForRegime(slPct, pricingRegime),
    tenorDays: V7_TENOR_DAYS[slPct],
    available: true,
    payoutPer10kUsd: getV7PayoutPer10k(slPct)
  }));
};

/**
 * Generate the tier label stored in DB's tier_name column.
 */
export const slPctToTierLabel = (slPct: V7SlTier): string => `SL ${slPct}%`;
