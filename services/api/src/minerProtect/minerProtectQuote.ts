/**
 * Miner Protect — breakeven-floor quote engine (pure, testable).
 *
 * SEPARATE offering. A Bitcoin miner is structurally LONG BTC with USD-fixed costs, so the core risk
 * is the BTC price falling below their all-in production cost. This engine turns miner economics into
 * a **breakeven BTC price** and prices a protective put that floors revenue at/around that level —
 * "stay cash-flow positive below $X." It reuses the crypto premium build-up (perpProtectPricing) and,
 * in the route layer, the multi-venue option sourcing (the moat applies: this is a BTC put).
 *
 * v1 is PRICE-ONLY and honest about it: we floor the BTC-PRICE leg of revenue, not network
 * difficulty / hashprice. Network productivity (`btcPerThPerDay`) is an INJECTED input sourced from
 * difficulty / the Luxor Hashprice Index, so difficulty is a parameter today and a hedgeable factor
 * on the roadmap. Option quotes (per-BTC asks) are injected → pure + unit-testable.
 */

import { makePerpProtectPricer } from "../singleSide/twoSided/perpProtectPricing";
import type { PremiumPricer, PremiumBreakdown } from "../singleSide/twoSided/perpProtectQuote";

export const SECONDS_PER_DAY = 86_400;

export type MinerInputs = {
  hashrateThs: number;            // total hashrate, TH/s
  efficiencyWPerTh: number;       // rig efficiency, W per TH/s
  powerCostUsdPerKwh: number;     // all-in electricity cost, $/kWh
  otherOpexUsdPerDay?: number;    // pool fees, hosting, etc. ($/day)
  /** Network productivity: BTC mined per TH/s per day (from difficulty / Luxor Hashprice Index). */
  btcPerThPerDay: number;
  btcPrice: number;               // current BTC spot
  tenorDays: number;
};

/** Injected option quote for a protective put at a strike (USDC per BTC). */
export type MinerPutQuote = { strike: number; askUsdcPerBtc: number; bidUsdcPerBtc?: number | null; spreadPct?: number | null };

export type MinerProtectOption = {
  id: string;
  label: string;                 // e.g. "Breakeven floor $48,000" / "Margin floor +10%"
  strike: number;                // put strike = protected BTC price floor
  hedged_btc: number;            // expected production hedged over the tenor
  premium_usd: number;           // retail premium the miner pays
  hedge_cost_usd: number;        // internal sourced hedge cost
  premium_breakdown: PremiumBreakdown;
  revenue_floor_usd: number;     // strike × hedged_btc − premium (worst-case protected revenue)
  period_cost_usd: number;       // all-in cost over the tenor
  covers_cost: boolean;          // revenue floor ≥ period cost (stays cash-flow positive)
  protected_margin_usd: number;  // revenue_floor − period_cost (≈ −premium at the breakeven strike)
  protected_margin_pct: number;  // protected_margin_usd / gross revenue (guaranteed profit margin)
  floor_vs_breakeven_pct: number; // (strike − breakeven) / breakeven
  floor_vs_spot_pct: number;     // (strike − spot) / spot — negative = OTM protective floor
  cost_pct_revenue: number;      // premium / expected gross revenue
  recommended: boolean;
  note: string;
};

export type MinerProtectQuote = {
  miner: {
    hashrate_ths: number; efficiency_w_per_th: number; power_kw: number;
    cost_per_day_usd: number; btc_per_day: number; expected_production_btc: number;
    breakeven_price_usd: number; btc_price: number; tenor_days: number;
    gross_revenue_usd: number; period_cost_usd: number;
    /** Is the miner cash-flow positive at the current price? (spot > breakeven) */
    profitable_at_spot: boolean;
    /** Hashprice = revenue per TH/s per day. The miner-native metric. */
    hashprice_usd_per_th_day: number;       // btcPerThPerDay × spot
    hashprice_btc_per_th_day: number;       // network productivity (difficulty-driven)
    /** Hashprice at which revenue = cost (cost/day ÷ hashrate). Profitable while above this. */
    breakeven_hashprice_usd_per_th_day: number;
  };
  options: MinerProtectOption[];
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const round8 = (x: number) => +x.toFixed(8);
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;

/** Power draw in kW for the fleet. */
export const powerKw = (hashrateThs: number, efficiencyWPerTh: number): number => (hashrateThs * efficiencyWPerTh) / 1000;

/** All-in cost per day (electricity + other opex). */
export const costPerDayUsd = (i: Pick<MinerInputs, "hashrateThs" | "efficiencyWPerTh" | "powerCostUsdPerKwh" | "otherOpexUsdPerDay">): number =>
  powerKw(i.hashrateThs, i.efficiencyWPerTh) * 24 * i.powerCostUsdPerKwh + (i.otherOpexUsdPerDay ?? 0);

/** BTC produced per day (network mechanics; price-independent). */
export const btcPerDay = (hashrateThs: number, btcPerThPerDay: number): number => hashrateThs * btcPerThPerDay;

/** Breakeven BTC price = the price at which gross revenue equals all-in cost. */
export const breakevenPriceUsd = (costPerDay: number, btcPerDayProduced: number): number =>
  btcPerDayProduced > 0 ? costPerDay / btcPerDayProduced : 0;

const identityBreakdown = (hedge: number): PremiumBreakdown => ({
  hedge_cost_usdc: round2(hedge), slippage_buffer_usdc: 0, tail_load_usdc: 0,
  capital_charge_usdc: 0, atticus_margin_usdc: 0, retail_premium_usdc: round2(hedge)
});

/**
 * Build a protective-put floor for the miner's expected production. The strike is the protected BTC
 * price; the revenue floor caps how low gross revenue can fall. Flooring exactly at breakeven means
 * the only margin erosion is the premium; flooring above breakeven locks a profit.
 */
export const buildBreakevenFloor = (
  inputs: MinerInputs,
  q: MinerPutQuote,
  ctx: { breakevenPrice: number; hedgedBtc: number; periodCost: number },
  idx: number,
  pricer?: PremiumPricer
): MinerProtectOption => {
  const notional = ctx.hedgedBtc * inputs.btcPrice;
  const hedgeCost = q.askUsdcPerBtc * ctx.hedgedBtc;
  const breakdown = pricer
    ? pricer(hedgeCost, { notionalUsdc: notional, marginUsdc: notional, tenorDays: inputs.tenorDays, spreadPct: q.spreadPct ?? null, structure: "single", leverage: 1 })
    : identityBreakdown(hedgeCost);
  const premium = breakdown.retail_premium_usdc;
  const revenueFloor = q.strike * ctx.hedgedBtc - premium;
  const protectedMargin = revenueFloor - ctx.periodCost;
  const vsBreakeven = ctx.breakevenPrice > 0 ? (q.strike - ctx.breakevenPrice) / ctx.breakevenPrice : 0;
  const vsSpot = inputs.btcPrice > 0 ? (q.strike - inputs.btcPrice) / inputs.btcPrice : 0;
  const grossRevenue = ctx.hedgedBtc * inputs.btcPrice;
  // Label OTM floors relative to the current price (clear for traders); reserve "Breakeven floor"
  // for a strike at the breakeven price (only meaningful when breakeven sits below spot).
  const label = Math.abs(vsBreakeven) < 0.01 && ctx.breakevenPrice <= inputs.btcPrice
    ? `Breakeven floor ${usd(q.strike)}`
    : `Floor ${usd(q.strike)} (${vsSpot >= 0 ? "+" : "−"}${Math.abs(Math.round(vsSpot * 100))}% vs price)`;
  const note = protectedMargin >= 0
    ? `Floors revenue at ${usd(revenueFloor)} — covers your ${usd(ctx.periodCost)} cost; you stay cash-flow positive below ${usd(q.strike)}.`
    : `Floors revenue at ${usd(revenueFloor)} vs ${usd(ctx.periodCost)} cost — max margin erosion ≈ the ${usd(premium)} premium even if BTC collapses.`;
  return {
    id: `floor-${idx}`,
    label,
    strike: round2(q.strike),
    hedged_btc: round8(ctx.hedgedBtc),
    premium_usd: round2(premium),
    hedge_cost_usd: round2(breakdown.hedge_cost_usdc),
    premium_breakdown: breakdown,
    revenue_floor_usd: round2(revenueFloor),
    period_cost_usd: round2(ctx.periodCost),
    covers_cost: revenueFloor >= ctx.periodCost,
    protected_margin_usd: round2(protectedMargin),
    protected_margin_pct: grossRevenue > 0 ? round4(protectedMargin / grossRevenue) : 0,
    floor_vs_breakeven_pct: round4(vsBreakeven),
    floor_vs_spot_pct: round4(vsSpot),
    cost_pct_revenue: grossRevenue > 0 ? round4(premium / grossRevenue) : 0,
    recommended: false,
    note
  };
};

/**
 * Recommend the cheapest floor that keeps the miner cash-flow positive (covers cost). If none do
 * (e.g. only deep/cheap floors), fall back to the one closest to breakeven. Deterministic.
 */
export const pickRecommendedFloor = (options: MinerProtectOption[], minMarginUsd = 0): string | null => {
  if (options.length === 0) return null;
  // Cheapest floor that GUARANTEES at least the target margin (default 0 = cover cost / stay positive).
  const eligible = options.filter((o) => o.protected_margin_usd >= minMarginUsd);
  if (eligible.length > 0) {
    return [...eligible].sort((a, b) => a.premium_usd - b.premium_usd || a.strike - b.strike)[0].id;
  }
  // None hit the target → closest to breakeven (smallest |floor_vs_breakeven|).
  return [...options].sort((a, b) => Math.abs(a.floor_vs_breakeven_pct) - Math.abs(b.floor_vs_breakeven_pct))[0].id;
};

export const buildMinerProtectQuote = (
  inputs: MinerInputs,
  opts: { floors: MinerPutQuote[]; pricer?: PremiumPricer; recTargetMarginPct?: number }
): MinerProtectQuote => {
  const power = powerKw(inputs.hashrateThs, inputs.efficiencyWPerTh);
  const costDay = costPerDayUsd(inputs);
  const btcDay = btcPerDay(inputs.hashrateThs, inputs.btcPerThPerDay);
  const breakeven = breakevenPriceUsd(costDay, btcDay);
  const hedgedBtc = btcDay * inputs.tenorDays;
  const periodCost = costDay * inputs.tenorDays;
  const grossRevenue = hedgedBtc * inputs.btcPrice;

  const options: MinerProtectOption[] = [];
  const seen = new Set<number>();
  opts.floors.forEach((q, i) => {
    if (!(q.askUsdcPerBtc > 0) || !(q.strike > 0)) return;
    const key = Math.round(q.strike);
    if (seen.has(key)) return;
    seen.add(key);
    options.push(buildBreakevenFloor(inputs, q, { breakevenPrice: breakeven, hedgedBtc, periodCost }, i, opts.pricer));
  });

  // Target a guaranteed profit margin (% of gross revenue) when requested; default 0 = cover cost.
  const minMarginUsd = opts.recTargetMarginPct && opts.recTargetMarginPct > 0 ? opts.recTargetMarginPct * grossRevenue : 0;
  const recId = pickRecommendedFloor(options, minMarginUsd);
  if (recId) { const r = options.find((o) => o.id === recId); if (r) r.recommended = true; }

  return {
    miner: {
      hashrate_ths: inputs.hashrateThs, efficiency_w_per_th: inputs.efficiencyWPerTh, power_kw: round4(power),
      cost_per_day_usd: round2(costDay), btc_per_day: round8(btcDay), expected_production_btc: round8(hedgedBtc),
      breakeven_price_usd: round2(breakeven), btc_price: round2(inputs.btcPrice), tenor_days: inputs.tenorDays,
      gross_revenue_usd: round2(grossRevenue), period_cost_usd: round2(periodCost),
      profitable_at_spot: inputs.btcPrice > breakeven,
      hashprice_usd_per_th_day: +(inputs.btcPerThPerDay * inputs.btcPrice).toFixed(6),
      hashprice_btc_per_th_day: inputs.btcPerThPerDay,
      breakeven_hashprice_usd_per_th_day: inputs.hashrateThs > 0 ? +(costDay / inputs.hashrateThs).toFixed(6) : 0
    },
    options
  };
};

/** Convenience: default pricer reusing the crypto underwriter build-up. */
export const makeMinerPricer = (): PremiumPricer => makePerpProtectPricer();
