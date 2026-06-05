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


/** Default menu: "risk 25% / 50% / 75% of your margin." */
export const DEFAULT_TIER_FRACTIONS = [0.25, 0.5, 0.75] as const;

export type TierPutQuote = { venue: string; ask_usdc_per_btc: number | null; instrument?: string | null; strike?: number | null };

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

export type TradeSide = "long" | "short";

export type FloorTierBundleInputs = {
  spot: number;
  sizeBtc: number;
  leverage: number;
  tenorDays: number;
  /** long = protect downside with PUTs (liq on a drop); short = protect upside with CALLs (liq on a pump). */
  side?: TradeSide;
  fractions?: ReadonlyArray<number>;
};

export type PositionCard = {
  spot: number;
  size_btc: number;
  leverage: number;
  side: TradeSide;
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

/** Strike that delivers a "risk f of margin" loss cap: floorPct = f/leverage. PUT below spot
 *  for a long; CALL above spot for a short. */
export const strikeForMarginFraction = (spot: number, leverage: number, fraction: number, side: TradeSide = "long"): { floorPct: number; strike: number } => {
  const floorPct = leverage > 0 ? fraction / leverage : fraction;
  const strike = side === "short" ? spot * (1 + floorPct) : spot * (1 - floorPct);
  return { floorPct, strike };
};

/**
 * Build one tier from injected pricing. CORRECTNESS: when the quote carries the ACTUAL listed
 * strike it was priced at (venues snap to the nearest listed strike), we recompute the floor
 * and worst case from THAT strike — so strike, premium, and worst case always describe ONE
 * instrument. The requested `fraction` is only the targeting knob (and the tier name).
 */
export const buildFloorTier = (
  inputs: FloorTierBundleInputs,
  fraction: number,
  best: TierPutQuote | null
): FloorTier => {
  const { spot, sizeBtc, leverage, tenorDays } = inputs;
  const side: TradeSide = inputs.side ?? "long";
  const { floorPct: targetFloorPct, strike: targetStrike } = strikeForMarginFraction(spot, leverage, fraction, side);
  const liqDropPct = leverage > 0 ? 1 / leverage : 1;
  const label = `Risk ${Math.round(fraction * 100)}% of your margin`;
  // Distance of the protection strike from spot, as a positive fraction (below for long, above for short).
  const strikeDist = (strike: number) => (side === "short" ? (strike - spot) / spot : (spot - strike) / spot);
  const optWord = side === "short" ? "ceiling" : "floor";

  // No live quote → carry the target strike for display, mark unavailable.
  if (!best || best.ask_usdc_per_btc == null || best.ask_usdc_per_btc <= 0) {
    const targetAdds = targetFloorPct > 0 && targetFloorPct < liqDropPct;
    return {
      margin_fraction: fraction, label, floor_pct: +targetFloorPct.toFixed(4), floor_strike: +targetStrike.toFixed(2),
      adds_value: targetAdds, available: false,
      unavailable_reason: targetAdds ? `no live quote near ${usd(targetStrike)}` : `${optWord} at ${pctStr(targetFloorPct)} sits at/beyond liquidation (${pctStr(liqDropPct)}) — reduce leverage`,
      venue: null, instrument: null, put_cost_usdc: null, cost_per_day_usdc: null, max_loss_usdc: null,
      headline: targetAdds ? `No live quote — try another tenor` : `Unavailable at ${leverage}× — reduce leverage`, recommended: false
    };
  }

  // Use the ACTUAL strike the venue priced (snapped to its listed grid) when available.
  const actualStrike = best.strike != null && best.strike > 0 ? best.strike : targetStrike;
  const floorPctActual = strikeDist(actualStrike);
  const addsValue = floorPctActual > 0 && floorPctActual < liqDropPct;

  // The nearest listed strike landed at/beyond the liquidation price → no tradable protection here.
  if (!addsValue) {
    return {
      margin_fraction: fraction, label, floor_pct: +floorPctActual.toFixed(4), floor_strike: +actualStrike.toFixed(2),
      adds_value: false, available: false,
      unavailable_reason: `nearest listed ${optWord} (${usd(actualStrike)}, ${pctStr(floorPctActual)}) sits at/beyond liquidation (${pctStr(liqDropPct)}) — reduce leverage`,
      venue: best.venue, instrument: best.instrument ?? null, put_cost_usdc: null, cost_per_day_usdc: null, max_loss_usdc: null,
      headline: `Unavailable at ${leverage}× — reduce leverage`, recommended: false
    };
  }

  // Cap math (works for both sides, from the ACTUAL priced strike): max loss = distance×size + premium.
  const premium = best.ask_usdc_per_btc * sizeBtc;
  const maxLoss = floorPctActual * sizeBtc * spot + premium;
  const costPerDay = tenorDays > 0 ? premium / tenorDays : premium;

  return {
    margin_fraction: fraction, label, floor_pct: +floorPctActual.toFixed(4), floor_strike: +actualStrike.toFixed(2),
    adds_value: true, available: true, unavailable_reason: null,
    venue: best.venue, instrument: best.instrument ?? null,
    put_cost_usdc: +premium.toFixed(2),
    cost_per_day_usdc: +costPerDay.toFixed(2),
    max_loss_usdc: +maxLoss.toFixed(2),
    headline: `Cap your worst case at ${usd(maxLoss)} — ${usd(premium)} (${usd(costPerDay)}/day)`,
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
  const side: TradeSide = inputs.side ?? "long";
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const liqDropPct = leverage > 0 ? 1 / leverage : 1;
  const liqPrice = side === "short" ? spot * (1 + liqDropPct) : spot * (1 - liqDropPct);
  const moveWord = side === "short" ? "rally" : "drop";
  return {
    spot: +spot.toFixed(2), size_btc: sizeBtc, leverage, side,
    notional_usdc: +notional.toFixed(2), margin_usdc: +margin.toFixed(2),
    liquidation_price: +liqPrice.toFixed(2), liq_drop_pct: +liqDropPct.toFixed(4),
    liq_summary: `At ${leverage}×, a ${pctStr(liqDropPct)} ${moveWord} liquidates you — you lose your ~${usd(margin)} margin (a fast gap can cost MORE).`
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
  const built = fractions.map((f) => buildFloorTier({ ...inputs, side: inputs.side ?? "long" }, f, quotesByFraction.get(f) ?? null));

  // De-duplicate: venues snap to listed strikes, so several requested fractions can resolve to
  // the SAME real floor. Keep one distinct floor per strike (the first = safest intent). If no
  // tier is tradable (very high leverage), keep the built rows so the UI shows an honest reason.
  const seen = new Set<number>();
  const distinct: FloorTier[] = [];
  for (const t of built) {
    if (!t.available) continue;
    const key = Math.round(t.floor_strike);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(t);
  }
  const tiers = distinct.length > 0 ? distinct : built;

  const recIdx = pickRecommended(tiers, margin);
  if (recIdx >= 0) tiers[recIdx].recommended = true;
  return { position: buildPositionCard(inputs), tenor_days: inputs.tenorDays, tiers };
};
