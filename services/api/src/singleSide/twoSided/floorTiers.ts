/**
 * Floor-tier bundle — the menu behind the "Protected Leverage" widget (Sai exchange).
 *
 * Given a loaded leveraged position, this turns ONE position into a small menu of
 * protective-put "floor" tiers, each framed the way a trader thinks: **"risk only X% of my
 * margin."** Each tier is priced as the cheapest LONG PUT across venues (pricing injected →
 * pure + testable). READ-ONLY: no orders, no execution, no margin-engine coupling.
 *
 * Honest framing (Phase 1, cross-venue): the perp still liquidates on the exchange; the
 * separately-held put bounds NET loss. We do NOT claim "no liquidation" here — that needs
 * the Phase-2 margin integration with the exchange.
 *
 * ── The clean mapping that makes the menu intuitive ──
 *   A trader picks a "max price-loss as a fraction f of margin". The strike that delivers it:
 *       price-loss = (spot − strike)·size = f · margin = f · (spot·size / leverage)
 *   ⇒   floorPct = (spot − strike)/spot = f / leverage.
 *   So floorPct = f/leverage, and for any f < 1 the floor automatically sits INSIDE the
 *   liquidation distance (1/leverage) → it always adds protection. f ≥ 1 is cost-only
 *   (floor at/below liq) → marked invalid/greyed.
 *
 *   True worst case (reported honestly) = price-loss cap + premium = f·margin + put_cost.
 */

import { computeFloorEconomics, type FloorEconomics } from "./floorQuote";

/** Default menu: "risk 25% / 50% / 75% of your margin." */
export const DEFAULT_TIER_FRACTIONS = [0.25, 0.5, 0.75] as const;

export type TierPutQuote = { venue: string; ask_usdc_per_btc: number | null; instrument?: string | null };

export type FloorTier = {
  /** Fraction of margin the trader risks to price moves before the cap (e.g. 0.5). */
  margin_fraction: number;
  label: string;                          // "Risk 50% of your margin"
  floor_pct: number;                      // f / leverage
  floor_strike: number;
  /** True when this floor sits inside the liq distance (always true for fraction < 1). */
  adds_value: boolean;
  available: boolean;                     // a live put quote was found
  unavailable_reason: string | null;
  // ── Pricing (null when no live quote) ──
  venue: string | null;
  instrument: string | null;
  put_cost_usdc: number | null;
  cost_per_day_usdc: number | null;
  /** True, gap-proof worst case = f·margin + premium. */
  max_loss_usdc: number | null;
  /** Headline copy for the button. */
  headline: string;
  recommended: boolean;
};

export type FloorTierBundleInputs = {
  spot: number;
  sizeBtc: number;
  leverage: number;
  tenorDays: number;
  fractions?: ReadonlyArray<number>;
};

export type PositionCard = {
  spot: number;
  size_btc: number;
  leverage: number;
  notional_usdc: number;
  margin_usdc: number;
  liquidation_price: number;
  liq_drop_pct: number;
  liq_summary: string;
};

export type FloorTierBundle = {
  position: PositionCard;
  tenor_days: number;
  tiers: FloorTier[];
};

const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Strike that delivers a "risk f of margin" price-loss cap: floorPct = f/leverage. */
export const strikeForMarginFraction = (spot: number, leverage: number, fraction: number): { floorPct: number; strike: number } => {
  const floorPct = leverage > 0 ? fraction / leverage : fraction;
  return { floorPct, strike: spot * (1 - floorPct) };
};

/** Build one tier from injected pricing (the cheapest live put quote at that tier's strike). */
export const buildFloorTier = (
  inputs: FloorTierBundleInputs,
  fraction: number,
  best: TierPutQuote | null
): FloorTier => {
  const { spot, sizeBtc, leverage, tenorDays } = inputs;
  const { floorPct, strike } = strikeForMarginFraction(spot, leverage, fraction);
  const margin = leverage > 0 ? (sizeBtc * spot) / leverage : sizeBtc * spot;
  const liqDropPct = leverage > 0 ? 1 / leverage : 1;
  const addsValue = floorPct < liqDropPct; // equivalently fraction < 1

  const label = `Risk ${Math.round(fraction * 100)}% of your margin`;

  if (!addsValue) {
    return {
      margin_fraction: fraction, label, floor_pct: +floorPct.toFixed(4), floor_strike: +strike.toFixed(2),
      adds_value: false, available: false,
      unavailable_reason: `floor at ${pctStr(floorPct)} sits at/beyond liquidation (${pctStr(liqDropPct)}) — lower leverage to unlock`,
      venue: null, instrument: null, put_cost_usdc: null, cost_per_day_usdc: null, max_loss_usdc: null,
      headline: `Unavailable at ${leverage}× — reduce leverage`, recommended: false
    };
  }

  if (!best || best.ask_usdc_per_btc == null || best.ask_usdc_per_btc <= 0) {
    return {
      margin_fraction: fraction, label, floor_pct: +floorPct.toFixed(4), floor_strike: +strike.toFixed(2),
      adds_value: true, available: false,
      unavailable_reason: `no live put quote near ${usd(strike)}`,
      venue: null, instrument: null, put_cost_usdc: null, cost_per_day_usdc: null, max_loss_usdc: null,
      headline: `No live quote — try another tenor`, recommended: false
    };
  }

  // Reuse the canonical economics engine for the cap math (gap-proof, includes premium).
  const econ: FloorEconomics = computeFloorEconomics({ spot, sizeBtc, leverage, floorPct, tenorDays }, best.ask_usdc_per_btc);
  const costPerDay = tenorDays > 0 ? econ.put_cost_usdc / tenorDays : econ.put_cost_usdc;

  return {
    margin_fraction: fraction, label, floor_pct: +floorPct.toFixed(4), floor_strike: +strike.toFixed(2),
    adds_value: true, available: true, unavailable_reason: null,
    venue: best.venue, instrument: best.instrument ?? null,
    put_cost_usdc: econ.put_cost_usdc,
    cost_per_day_usdc: +costPerDay.toFixed(2),
    max_loss_usdc: econ.max_loss_with_floor_usdc,
    headline: `Cap your worst case at ${usd(econ.max_loss_with_floor_usdc)} — ${usd(econ.put_cost_usdc)} (${usd(costPerDay)}/day)`,
    recommended: false
  };
};

/**
 * Recommend a tier: the cheapest AVAILABLE tier whose premium is "worth it" — i.e. premium
 * is a modest share (≤ 60%) of the price-loss it caps. Falls back to the middle available
 * tier, then the first available.
 */
export const pickRecommended = (tiers: FloorTier[], margin: number): number => {
  const available = tiers.filter((t) => t.available);
  if (available.length === 0) return -1;
  const worthIt = available.filter((t) => {
    const priceLossCapped = t.margin_fraction * margin;
    return t.put_cost_usdc != null && t.put_cost_usdc <= 0.6 * priceLossCapped;
  });
  const pool = worthIt.length > 0 ? worthIt : available;
  // Prefer the balanced 50% tier if present in the pool, else the median by fraction.
  const balanced = pool.find((t) => Math.abs(t.margin_fraction - 0.5) < 1e-9);
  const chosen = balanced ?? [...pool].sort((a, b) => a.margin_fraction - b.margin_fraction)[Math.floor((pool.length - 1) / 2)];
  return tiers.indexOf(chosen);
};

export const buildPositionCard = (inputs: FloorTierBundleInputs): PositionCard => {
  const { spot, sizeBtc, leverage } = inputs;
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const liqDropPct = leverage > 0 ? 1 / leverage : 1;
  const liqPrice = spot * (1 - liqDropPct);
  return {
    spot: +spot.toFixed(2), size_btc: sizeBtc, leverage,
    notional_usdc: +notional.toFixed(2), margin_usdc: +margin.toFixed(2),
    liquidation_price: +liqPrice.toFixed(2), liq_drop_pct: +liqDropPct.toFixed(4),
    liq_summary: `At ${leverage}×, a ${pctStr(liqDropPct)} drop liquidates you — you lose your ~${usd(margin)} margin (a fast gap can cost MORE).`
  };
};

/**
 * Assemble the full bundle from injected per-tier pricing. `quotesByFraction` maps each
 * requested fraction → its best (cheapest) live put quote (or null). Pure + testable.
 */
export const buildFloorTierBundle = (
  inputs: FloorTierBundleInputs,
  quotesByFraction: Map<number, TierPutQuote | null>
): FloorTierBundle => {
  const fractions = (inputs.fractions && inputs.fractions.length > 0 ? inputs.fractions : DEFAULT_TIER_FRACTIONS).slice();
  const margin = inputs.leverage > 0 ? (inputs.sizeBtc * inputs.spot) / inputs.leverage : inputs.sizeBtc * inputs.spot;
  const tiers = fractions.map((f) => buildFloorTier(inputs, f, quotesByFraction.get(f) ?? null));
  const recIdx = pickRecommended(tiers, margin);
  if (recIdx >= 0) tiers[recIdx].recommended = true;
  return { position: buildPositionCard(inputs), tenor_days: inputs.tenorDays, tiers };
};
