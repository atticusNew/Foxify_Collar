/**
 * Perp Protect — underwriter premium build-up (Decimal money math; pure + testable).
 *
 * Perp Protect is SOLD as a product and hedged with the real cross-venue option underneath — it is
 * NOT a pass-through of the raw ask. The retail premium is a transparent build-up over Atticus's
 * hedge cost, so every cent maps to a real cost and any future adjustment is explainable to the
 * partner (never a mystery bump):
 *
 *   retail = hedge_cost
 *          + slippage_buffer   (we pay the ASK and may not fill there; scales with book spread)
 *          + tail_load         (gap / pooled-tail risk; larger for spreads that re-expose)
 *          + capital_charge    (cost of underwriting capital over the tenor)
 *          + atticus_margin    (sustainable profit line)
 *
 * Because the hedge is sourced at the CHEAPEST qualifying ask across venues (vs Bybit's single
 * book), a healthy, sustainable load can still land at/under Bybit's "~2% of margin" headline.
 *
 * Money math uses Decimal (precision rule); geometry/strikes stay `number` elsewhere. Conforms to
 * the engine's `PremiumPricer` via `makePerpProtectPricer`.
 */

import Decimal from "decimal.js";
import type { OptionPriceCtx, PremiumBreakdown, PremiumPricer } from "./perpProtectQuote";

export type PerpProtectPricingConfig = {
  /** slippage% = clamp(slippageK × spread%, minSlippagePct, maxSlippagePct). */
  slippageK: number;
  minSlippagePct: number;
  maxSlippagePct: number;
  /** Assumed book spread when a venue gave no spread signal (conservative). */
  assumedSpreadPctWhenUnknown: number;
  /** tail_load = notional × tailLoadBps/1e4 (× spreadTailMultiplier for spread structures). */
  tailLoadBps: number;
  spreadTailMultiplier: number;
  /** capital_charge = notional × capitalBpsPerYear/1e4 × tenorDays/365. */
  capitalBpsPerYear: number;
  /** atticus_margin = (hedge + slippage + tail + capital) × atticusMarginPct. */
  atticusMarginPct: number;
  /** Floor so tiny hedge costs still carry a real, sustainable price. */
  minPremiumUsdc: number;
};

/** Lean but production-grade defaults (≈15–25% all-in load over the cheapest cross-venue ask). */
export const DEFAULT_PRICING_CONFIG: PerpProtectPricingConfig = {
  slippageK: 0.5,
  minSlippagePct: 0.01,
  maxSlippagePct: 0.1,
  assumedSpreadPctWhenUnknown: 0.06,
  tailLoadBps: 5,
  spreadTailMultiplier: 2.5,
  capitalBpsPerYear: 100,
  atticusMarginPct: 0.12,
  minPremiumUsdc: 1
};

export const pricingConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PerpProtectPricingConfig => {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const d = DEFAULT_PRICING_CONFIG;
  return {
    slippageK: num(env.PERP_PROTECT_SLIPPAGE_K, d.slippageK),
    minSlippagePct: num(env.PERP_PROTECT_MIN_SLIPPAGE_PCT, d.minSlippagePct),
    maxSlippagePct: num(env.PERP_PROTECT_MAX_SLIPPAGE_PCT, d.maxSlippagePct),
    assumedSpreadPctWhenUnknown: num(env.PERP_PROTECT_ASSUMED_SPREAD_PCT, d.assumedSpreadPctWhenUnknown),
    tailLoadBps: num(env.PERP_PROTECT_TAIL_LOAD_BPS, d.tailLoadBps),
    spreadTailMultiplier: num(env.PERP_PROTECT_SPREAD_TAIL_MULT, d.spreadTailMultiplier),
    capitalBpsPerYear: num(env.PERP_PROTECT_CAPITAL_BPS_PER_YEAR, d.capitalBpsPerYear),
    atticusMarginPct: num(env.PERP_PROTECT_ATTICUS_MARGIN_PCT, d.atticusMarginPct),
    minPremiumUsdc: num(env.PERP_PROTECT_MIN_PREMIUM_USDC, d.minPremiumUsdc)
  };
};

const clampD = (x: Decimal, lo: number, hi: number): Decimal => Decimal.max(lo, Decimal.min(hi, x));
const num2 = (d: Decimal): number => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

/**
 * Turn a cross-venue hedge cost into a transparent retail premium build-up. Pure; Decimal money.
 */
export const computeRetailPremium = (
  hedgeCostUsdc: number,
  ctx: OptionPriceCtx,
  cfg: PerpProtectPricingConfig = DEFAULT_PRICING_CONFIG
): PremiumBreakdown => {
  const hedge = new Decimal(Math.max(0, hedgeCostUsdc));
  const notional = new Decimal(Math.max(0, ctx.notionalUsdc));
  const tenorDays = new Decimal(Math.max(0, ctx.tenorDays));

  // Slippage buffer: scales with the book's relative spread (we pay the ask, may not fill there).
  const spreadPct = ctx.spreadPct != null && ctx.spreadPct >= 0 ? ctx.spreadPct : cfg.assumedSpreadPctWhenUnknown;
  const slippagePct = clampD(new Decimal(cfg.slippageK).mul(spreadPct), cfg.minSlippagePct, cfg.maxSlippagePct);
  const slippage = hedge.mul(slippagePct);

  // Tail load: bps of notional; spreads retain band/gap tail risk → multiplier.
  const tailMult = ctx.structure === "spread" ? cfg.spreadTailMultiplier : 1;
  const tail = notional.mul(cfg.tailLoadBps).div(10_000).mul(tailMult);

  // Capital charge: cost of underwriting capital over the tenor.
  const capital = notional.mul(cfg.capitalBpsPerYear).div(10_000).mul(tenorDays.div(365));

  // Atticus margin: the sustainable profit line over the loaded cost.
  const loadedCost = hedge.add(slippage).add(tail).add(capital);
  const margin = loadedCost.mul(cfg.atticusMarginPct);

  let retail = loadedCost.add(margin);
  if (retail.lessThan(cfg.minPremiumUsdc)) retail = new Decimal(cfg.minPremiumUsdc);

  return {
    hedge_cost_usdc: num2(hedge),
    slippage_buffer_usdc: num2(slippage),
    tail_load_usdc: num2(tail),
    capital_charge_usdc: num2(capital),
    atticus_margin_usdc: num2(margin),
    retail_premium_usdc: num2(retail)
  };
};

/** Build a PremiumPricer (engine hook) bound to a config. */
export const makePerpProtectPricer = (cfg: PerpProtectPricingConfig = DEFAULT_PRICING_CONFIG): PremiumPricer =>
  (hedgeCostUsdc: number, ctx: OptionPriceCtx) => computeRetailPremium(hedgeCostUsdc, ctx, cfg);
