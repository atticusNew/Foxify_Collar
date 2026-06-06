/**
 * Perp Protect — quote engine (Phase 1).
 *
 * SEPARATE product from Protected Leverage. Protected Leverage prices a *hypothetical* position
 * for a sandbox/demo; Perp Protect prices protection for a trader's *real, open* perp position
 * (entry price, size, side, leverage) and is the transactional, exchange-embedded product
 * (the "Bybit Perp Protect" equivalent). It REUSES the shared option pricing (venue quotes are
 * injected here → pure + testable), but the worst-case math is ENTRY-aware (a real position has
 * a cost basis, not "spot = entry").
 *
 * Underwriter model: Atticus sells the protection as a product and hedges with the real
 * cross-venue option underneath. Settlement is pluggable (european now; american / auto-close
 * later) — carried as `settlement_style` so converting to earlier settlement is a strategy swap,
 * not a rewrite.
 *
 * Structures offered: a SINGLE option (gap-proof, capped worst case) and an optional SPREAD
 * (cheaper, protects a band, re-exposed beyond the short strike).
 */

export type TradeSide = "long" | "short";
export type SettlementStyle = "european" | "american" | "auto_close";

export type PerpPosition = {
  spot: number;          // current mark / index price
  entryPrice: number;    // the position's cost basis
  sizeBtc: number;
  side: TradeSide;
  leverage: number;
  tenorDays: number;
  /** Phase-4 hook: when the exchange margin engine PREVENTS liquidation, the option's hard cap is
   *  truly hard. Pre-Phase-4 (default false) a leveraged perp can be liquidated on a wick → the
   *  cap holds only for sustained moves; a whipsaw can still cost margin + premium. */
  liquidationPrevented?: boolean;
};

/** Cheapest cross-venue option quote at a strike (premium in USDC per BTC). Venue is NOT exposed.
 *  Optional label/intent come from the structure generator; spreadPct feeds the pricing load. */
export type StrikeQuote = {
  strike: number;
  askUsdcPerBtc: number;
  bidUsdcPerBtc?: number | null;
  label?: string;
  spreadPct?: number | null;
};

/** Transparent underwriter premium build-up (filled by perpProtectPricing; identity by default). */
export type PremiumBreakdown = {
  hedge_cost_usdc: number;        // Atticus's cost to buy the hedge (cheapest cross-venue)
  slippage_buffer_usdc: number;   // cushion for not filling at the displayed ask
  tail_load_usdc: number;         // pooled-tail / gap-risk contribution
  capital_charge_usdc: number;    // cost of underwriting capital over the tenor
  atticus_margin_usdc: number;    // sustainable profit line
  retail_premium_usdc: number;    // what the trader pays = sum of the above
};

/** Context a pricer needs to turn a hedge cost into a retail premium. */
export type OptionPriceCtx = {
  notionalUsdc: number;
  marginUsdc: number;
  tenorDays: number;
  spreadPct: number | null;
  structure: "single" | "spread";
  leverage: number;
};

/** Injectable premium pricer (perpProtectPricing.computeRetailPremium conforms). */
export type PremiumPricer = (hedgeCostUsdc: number, ctx: OptionPriceCtx) => PremiumBreakdown;

/** Default pricer: retail = hedge cost (no load). Real underwriter load injected in the route. */
export const identityPricer: PremiumPricer = (hedgeCostUsdc) => ({
  hedge_cost_usdc: round2(hedgeCostUsdc),
  slippage_buffer_usdc: 0,
  tail_load_usdc: 0,
  capital_charge_usdc: 0,
  atticus_margin_usdc: 0,
  retail_premium_usdc: round2(hedgeCostUsdc)
});

export type PerpProtectOption = {
  id: string;
  label: string;                 // from the structure generator, or a sensible fallback
  structure: "put" | "call" | "put_spread" | "call_spread";
  strike: number;
  short_strike: number | null;
  premium_usdc: number;          // RETAIL premium (what the trader pays)
  hedge_cost_usdc: number;       // INTERNAL: Atticus's cross-venue hedge cost
  premium_breakdown: PremiumBreakdown;
  /** Total max loss on position+protection held to expiry (compensation basis — matches Bybit).
   *  For a single this is the hard cap (truly hard iff liquidation is prevented / not liquidatable);
   *  for a spread it's the loss at the band edge — below it you're exposed again. */
  worst_case_usdc: number;
  capped: boolean;               // true = gap-proof single; false = spread (exposed beyond band)
  exposed_beyond: number | null; // for spreads: the strike past which protection runs out
  /** True when the strike is inside the liquidation price (option ITM before liquidation). */
  protects_before_liq: boolean;
  /** Pre-Phase-4 leverage risk: a wick-to-liq-then-recover whipsaw can cost ~margin + premium even
   *  though the held-to-expiry cap is lower. null when liquidation is prevented / not liquidatable. */
  liquidation_whipsaw_risk_usdc: number | null;
  whipsaw_exposed: boolean;
  cost_pct_margin: number;
  /** The HONEST worst case as a fraction of posted margin. Surfaced because an intent label like
   *  "Cap 25% of margin" describes the price-loss target only — at high leverage the premium
   *  dominates, so the true worst case (incl. premium) can be a far larger share of margin. */
  worst_case_pct_margin: number;
  cost_per_day_usdc: number;
  breakeven_price: number;       // price at which protected PnL breaks even (incl. premium)
  protect_move_pct: number;      // strike distance from spot (positive)
  recommended: boolean;
  note: string;
};

export type PerpProtectQuote = {
  position: {
    side: TradeSide;
    spot: number;
    entry_price: number;
    size_btc: number;
    leverage: number;
    notional_usdc: number;
    margin_usdc: number;
    liquidation_price: number;
    liq_move_pct: number;
    unrealized_pnl_usdc: number;
  };
  settlement_style: SettlementStyle;
  /** false pre-Phase-4 (option compensates at expiry; perp can still liquidate); true once the
   *  exchange margin engine prevents liquidation → the single-option cap becomes truly hard. */
  liquidation_prevented: boolean;
  tenor_days: number;
  options: PerpProtectOption[];
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Truthful Floor/Ceiling label from the ACTUAL (snapped) strike's distance from spot. Venues snap
 *  targets to their listed grid, so the displayed move must reflect the real strike, not the target. */
const floorLabel = (side: TradeSide, movePct: number): string => {
  const word = side === "short" ? "Ceiling" : "Floor";
  const sign = side === "short" ? "+" : "−";
  const p = movePct * 100;
  return `${word} ${sign}${p.toFixed(p < 10 ? 1 : 0)}%`;
};

/** Liquidation price + |move| for the perp (simplified: ignores maintenance margin/funding). */
export const liquidationOf = (position: PerpPosition): { price: number; movePct: number } => {
  const movePct = position.leverage > 0 ? 1 / position.leverage : 1;
  // Liquidation is measured from the ENTRY price (that's where margin was posted).
  const price = position.side === "short" ? position.entryPrice * (1 + movePct) : position.entryPrice * (1 - movePct);
  return { price, movePct };
};

/** Signed protection-strike distance from spot as a positive fraction (below for long puts, above for short calls). */
const strikeDist = (side: TradeSide, spot: number, strike: number) => (side === "short" ? (strike - spot) / spot : (spot - strike) / spot);

/**
 * SINGLE protective option — ENTRY-aware hard cap.
 *   long  (put@K):  worst case = (entry − K)·size + premium   (you lose down to K, then capped)
 *   short (call@K): worst case = (K − entry)·size + premium
 * (A protective strike beyond entry can lock in profit → worst case can be negative; we surface it.)
 */
/** Is the perp liquidatable before expiry (leveraged) and NOT prevented by a margin engine? */
const whipsawExposedFor = (position: PerpPosition): boolean => {
  const { movePct } = liquidationOf(position);
  return position.liquidationPrevented !== true && movePct < 1; // movePct = 1/lev; <1 ⇒ leverage > 1
};

/** Does the strike sit inside the liquidation price (option ITM before the perp would liquidate)? */
const protectsBeforeLiq = (position: PerpPosition, strike: number): boolean => {
  const liq = liquidationOf(position).price;
  return position.side === "short" ? strike <= liq : strike >= liq;
};

export const buildSingleOption = (position: PerpPosition, q: StrikeQuote, idx: number, pricer: PremiumPricer = identityPricer): PerpProtectOption => {
  const { side, entryPrice, sizeBtc, spot, leverage } = position;
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const hedgeCost = q.askUsdcPerBtc * sizeBtc;
  const breakdown = pricer(hedgeCost, { notionalUsdc: notional, marginUsdc: margin, tenorDays: position.tenorDays, spreadPct: q.spreadPct ?? null, structure: "single", leverage });
  const premium = breakdown.retail_premium_usdc;
  const perpLossToStrike = side === "short" ? (q.strike - entryPrice) * sizeBtc : (entryPrice - q.strike) * sizeBtc;
  const worstCase = perpLossToStrike + premium;
  const structure: "put" | "call" = side === "short" ? "call" : "put";
  const whipsaw = whipsawExposedFor(position);
  const beforeLiq = protectsBeforeLiq(position, q.strike);
  const whipsawRisk = whipsaw ? margin + premium : null;
  const breakeven = side === "short" ? entryPrice - (sizeBtc > 0 ? premium / sizeBtc : 0) : entryPrice + (sizeBtc > 0 ? premium / sizeBtc : 0);
  const dropWord = side === "short" ? "it pumps" : "it drops";
  const note = whipsaw
    ? `${structure} compensates to a ${usd(worstCase)} loss if ${dropWord} and stays there. Pre-liquidation-prevention, a wick to liquidation then a recovery can still cost up to ${usd(whipsawRisk as number)}.`
    : `Gap-proof ${structure}: loss hard-capped at ${usd(worstCase)} no matter how far ${dropWord}.`;
  // Label from the ACTUAL strike: keep "Stay alive" only when the strike truly sits inside liq;
  // otherwise it's a plain Floor/Ceiling at its real distance (no overstated target moves).
  const actualMove = strikeDist(side, spot, q.strike);
  const label = q.label === "Stay alive" && beforeLiq ? "Stay alive" : floorLabel(side, actualMove);
  return {
    id: `single-${idx}`,
    label,
    structure,
    strike: round2(q.strike),
    short_strike: null,
    premium_usdc: round2(premium),
    hedge_cost_usdc: round2(breakdown.hedge_cost_usdc),
    premium_breakdown: breakdown,
    worst_case_usdc: round2(worstCase),
    capped: true,
    exposed_beyond: null,
    protects_before_liq: beforeLiq,
    liquidation_whipsaw_risk_usdc: whipsawRisk != null ? round2(whipsawRisk) : null,
    whipsaw_exposed: whipsaw,
    cost_pct_margin: margin > 0 ? round4(premium / margin) : 0,
    worst_case_pct_margin: margin > 0 ? round4(worstCase / margin) : 0,
    cost_per_day_usdc: position.tenorDays > 0 ? round2(premium / position.tenorDays) : round2(premium),
    breakeven_price: round2(breakeven),
    protect_move_pct: round4(strikeDist(side, spot, q.strike)),
    recommended: false,
    note
  };
};

/**
 * SPREAD — cheaper, but protection only spans K1→K2; beyond K2 you're re-exposed.
 * Reported worst_case = the loss at the band edge (K2): (entry − K1)·size + premium for a long
 * (the K2 leg cancels at K2). Below/above K2 the loss keeps growing → `capped: false`.
 */
export const buildSpreadOption = (position: PerpPosition, longLeg: StrikeQuote, shortLeg: StrikeQuote, pricer: PremiumPricer = identityPricer): PerpProtectOption | null => {
  const { side, entryPrice, sizeBtc, spot, leverage } = position;
  // Short leg must be strictly DEEPER than the long leg: lower strike for puts, higher for calls.
  const deeperOk = side === "short" ? shortLeg.strike > longLeg.strike : shortLeg.strike < longLeg.strike;
  const shortBid = shortLeg.bidUsdcPerBtc;
  if (!deeperOk || shortBid == null || shortBid <= 0) return null;
  const netPerBtc = longLeg.askUsdcPerBtc - shortBid;
  if (!(netPerBtc > 0)) return null;
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const hedgeCost = netPerBtc * sizeBtc;
  const breakdown = pricer(hedgeCost, { notionalUsdc: notional, marginUsdc: margin, tenorDays: position.tenorDays, spreadPct: longLeg.spreadPct ?? null, structure: "spread", leverage });
  const premium = breakdown.retail_premium_usdc;
  // Loss at the band edge (K1): perp loss to K1 + premium.
  const perpLossToK1 = side === "short" ? (longLeg.strike - entryPrice) * sizeBtc : (entryPrice - longLeg.strike) * sizeBtc;
  const bandEdgeLoss = perpLossToK1 + premium;
  const structure: "put_spread" | "call_spread" = side === "short" ? "call_spread" : "put_spread";
  const whipsaw = whipsawExposedFor(position);
  const beforeLiq = protectsBeforeLiq(position, longLeg.strike);
  // Spread re-exposes beyond the short strike; the deeper of (short strike, liq) bounds the worst case.
  const whipsawRisk = whipsaw ? margin + premium : null;
  const breakeven = side === "short" ? entryPrice - (sizeBtc > 0 ? premium / sizeBtc : 0) : entryPrice + (sizeBtc > 0 ? premium / sizeBtc : 0);
  const shortInsideLiq = protectsBeforeLiq(position, shortLeg.strike);
  const liqNote = whipsaw && !shortInsideLiq ? ` Note: the band extends past the liquidation price, so pre-liquidation-prevention the lower band is only realized if liquidation is avoided.` : "";
  return {
    id: "spread",
    label: `${floorLabel(side, strikeDist(side, spot, longLeg.strike))} (spread)`,
    structure,
    strike: round2(longLeg.strike),
    short_strike: round2(shortLeg.strike),
    premium_usdc: round2(premium),
    hedge_cost_usdc: round2(breakdown.hedge_cost_usdc),
    premium_breakdown: breakdown,
    worst_case_usdc: round2(bandEdgeLoss),
    capped: false,
    exposed_beyond: round2(shortLeg.strike),
    protects_before_liq: beforeLiq,
    liquidation_whipsaw_risk_usdc: whipsawRisk != null ? round2(whipsawRisk) : null,
    whipsaw_exposed: whipsaw,
    cost_pct_margin: margin > 0 ? round4(premium / margin) : 0,
    worst_case_pct_margin: margin > 0 ? round4(bandEdgeLoss / margin) : 0,
    cost_per_day_usdc: position.tenorDays > 0 ? round2(premium / position.tenorDays) : round2(premium),
    breakeven_price: round2(breakeven),
    protect_move_pct: round4(strikeDist(side, spot, longLeg.strike)),
    recommended: false,
    note: `Cheaper: protects from ${pctStr(strikeDist(side, spot, longLeg.strike))} to ${pctStr(strikeDist(side, spot, shortLeg.strike))}; exposed again beyond ${usd(shortLeg.strike)}.${liqNote}`
  };
};

/** Assemble the full quote from injected option quotes. `singles` = strike quotes for the single-option
 *  tiers; `spread` = {long, short} legs for the optional spread (or null). Pure + testable. */
/**
 * Recommend a single option: the cheapest "worth-it" tier (premium a modest share of the loss it
 * caps) that protects before liquidation, preferring a mid-distance strike. Spreads are never the
 * default (they re-expose beyond the band). Returns the option id, or null if none qualify.
 */
export const pickRecommendedOption = (
  options: PerpProtectOption[],
  marginUsdc: number,
  maxWorstCasePctMargin = 0.6
): string | null => {
  const singles = options.filter((o) => o.capped);
  if (singles.length === 0) return null;
  // Prefer options that keep you in the trade (strike inside liquidation) — the "stay alive" set.
  const beforeLiq = singles.filter((o) => o.protects_before_liq);
  const pool = beforeLiq.length > 0 ? beforeLiq : singles;
  // Acceptable = the HONEST worst case (incl. premium) is bounded to ≤ threshold of posted margin.
  // This is the trader-value anchor: don't recommend something that still loses most of the margin.
  const acceptable = pool.filter((o) => o.worst_case_pct_margin <= maxWorstCasePctMargin);
  const finalPool = acceptable.length > 0 ? acceptable : pool;
  // Best value = cheapest premium that meets the bar; tie-break to the lower worst case (more protection).
  const chosen = [...finalPool].sort((a, b) => a.premium_usdc - b.premium_usdc || a.worst_case_usdc - b.worst_case_usdc)[0];
  return chosen?.id ?? null;
};

export const buildPerpProtectQuote = (
  position: PerpPosition,
  inputs: { singles: StrikeQuote[]; spread?: { long: StrikeQuote; short: StrikeQuote } | null; settlementStyle?: SettlementStyle; pricer?: PremiumPricer; recMaxWorstCasePctMargin?: number }
): PerpProtectQuote => {
  const { spot, entryPrice, sizeBtc, side, leverage, tenorDays } = position;
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const liq = liquidationOf(position);
  const unrealized = side === "short" ? (entryPrice - spot) * sizeBtc : (spot - entryPrice) * sizeBtc;
  const pricer = inputs.pricer ?? identityPricer;

  const options: PerpProtectOption[] = [];
  // De-dup singles by snapped strike (venues snap to listed grid → several targets can collapse).
  const seenStrikes = new Set<number>();
  inputs.singles.forEach((q, i) => {
    if (!(q.askUsdcPerBtc > 0)) return;
    const key = Math.round(q.strike);
    if (seenStrikes.has(key)) return;
    seenStrikes.add(key);
    options.push(buildSingleOption(position, q, i, pricer));
  });
  if (inputs.spread) {
    const sp = buildSpreadOption(position, inputs.spread.long, inputs.spread.short, pricer);
    if (sp) options.push(sp);
  }

  const recId = pickRecommendedOption(options, margin, inputs.recMaxWorstCasePctMargin ?? 0.6);
  if (recId) { const r = options.find((o) => o.id === recId); if (r) r.recommended = true; }

  return {
    position: {
      side, spot: round2(spot), entry_price: round2(entryPrice), size_btc: round4(sizeBtc), leverage,
      notional_usdc: round2(notional), margin_usdc: round2(margin),
      liquidation_price: round2(liq.price), liq_move_pct: round4(liq.movePct),
      unrealized_pnl_usdc: round2(unrealized)
    },
    settlement_style: inputs.settlementStyle ?? "european",
    liquidation_prevented: position.liquidationPrevented === true,
    tenor_days: tenorDays,
    options
  };
};
