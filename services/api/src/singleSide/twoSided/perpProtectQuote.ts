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
};

/** Cheapest cross-venue option quote at a strike (premium in USDC per BTC). Venue is NOT exposed. */
export type StrikeQuote = { strike: number; askUsdcPerBtc: number; bidUsdcPerBtc?: number | null };

export type PerpProtectOption = {
  id: string;
  label: string;                 // Safer / Balanced / Cheapest (single) or Spread
  structure: "put" | "call" | "put_spread" | "call_spread";
  strike: number;
  short_strike: number | null;
  premium_usdc: number;
  /** Total max loss on position+protection held to expiry. For a single option this is a HARD
   *  cap; for a spread it's the loss at the band edge — below it you're exposed again. */
  worst_case_usdc: number;
  capped: boolean;               // true = gap-proof single; false = spread (exposed beyond band)
  exposed_beyond: number | null; // for spreads: the strike past which protection runs out
  cost_pct_margin: number;
  protect_move_pct: number;      // strike distance from spot (positive)
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
  tenor_days: number;
  options: PerpProtectOption[];
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;

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
export const buildSingleOption = (position: PerpPosition, q: StrikeQuote, idx: number): PerpProtectOption => {
  const { side, entryPrice, sizeBtc, spot, leverage } = position;
  const margin = leverage > 0 ? (sizeBtc * spot) / leverage : sizeBtc * spot;
  const premium = q.askUsdcPerBtc * sizeBtc;
  const perpLossToStrike = side === "short" ? (q.strike - entryPrice) * sizeBtc : (entryPrice - q.strike) * sizeBtc;
  const worstCase = perpLossToStrike + premium;
  const structure: "put" | "call" = side === "short" ? "call" : "put";
  const labels = ["Safer", "Balanced", "Cheapest"];
  return {
    id: `single-${idx}`,
    label: labels[idx] ?? "Single",
    structure,
    strike: round2(q.strike),
    short_strike: null,
    premium_usdc: round2(premium),
    worst_case_usdc: round2(worstCase),
    capped: true,
    exposed_beyond: null,
    cost_pct_margin: margin > 0 ? round4(premium / margin) : 0,
    protect_move_pct: round4(strikeDist(side, spot, q.strike)),
    note: `Gap-proof ${structure}: loss capped at ${usd(worstCase)} no matter how far ${side === "short" ? "it pumps" : "it drops"}.`
  };
};

/**
 * SPREAD — cheaper, but protection only spans K1→K2; beyond K2 you're re-exposed.
 * Reported worst_case = the loss at the band edge (K2): (entry − K1)·size + premium for a long
 * (the K2 leg cancels at K2). Below/above K2 the loss keeps growing → `capped: false`.
 */
export const buildSpreadOption = (position: PerpPosition, longLeg: StrikeQuote, shortLeg: StrikeQuote): PerpProtectOption | null => {
  const { side, entryPrice, sizeBtc, spot, leverage } = position;
  // Short leg must be strictly DEEPER than the long leg: lower strike for puts, higher for calls.
  const deeperOk = side === "short" ? shortLeg.strike > longLeg.strike : shortLeg.strike < longLeg.strike;
  const shortBid = shortLeg.bidUsdcPerBtc;
  if (!deeperOk || shortBid == null || shortBid <= 0) return null;
  const netPerBtc = longLeg.askUsdcPerBtc - shortBid;
  if (!(netPerBtc > 0)) return null;
  const margin = leverage > 0 ? (sizeBtc * spot) / leverage : sizeBtc * spot;
  const premium = netPerBtc * sizeBtc;
  // Loss at the band edge (K1): perp loss to K1 + premium.
  const perpLossToK1 = side === "short" ? (longLeg.strike - entryPrice) * sizeBtc : (entryPrice - longLeg.strike) * sizeBtc;
  const bandEdgeLoss = perpLossToK1 + premium;
  const structure: "put_spread" | "call_spread" = side === "short" ? "call_spread" : "put_spread";
  return {
    id: "spread",
    label: "Spread",
    structure,
    strike: round2(longLeg.strike),
    short_strike: round2(shortLeg.strike),
    premium_usdc: round2(premium),
    worst_case_usdc: round2(bandEdgeLoss),
    capped: false,
    exposed_beyond: round2(shortLeg.strike),
    cost_pct_margin: margin > 0 ? round4(premium / margin) : 0,
    protect_move_pct: round4(strikeDist(side, spot, longLeg.strike)),
    note: `Cheaper: protects from ${pctStr(strikeDist(side, spot, longLeg.strike))} to ${pctStr(strikeDist(side, spot, shortLeg.strike))}; exposed again beyond ${usd(shortLeg.strike)}.`
  };
};

/** Assemble the full quote from injected option quotes. `singles` = strike quotes for the single-option
 *  tiers; `spread` = {long, short} legs for the optional spread (or null). Pure + testable. */
export const buildPerpProtectQuote = (
  position: PerpPosition,
  inputs: { singles: StrikeQuote[]; spread?: { long: StrikeQuote; short: StrikeQuote } | null; settlementStyle?: SettlementStyle }
): PerpProtectQuote => {
  const { spot, entryPrice, sizeBtc, side, leverage, tenorDays } = position;
  const notional = sizeBtc * spot;
  const margin = leverage > 0 ? notional / leverage : notional;
  const liq = liquidationOf(position);
  const unrealized = side === "short" ? (entryPrice - spot) * sizeBtc : (spot - entryPrice) * sizeBtc;

  const options: PerpProtectOption[] = [];
  inputs.singles.forEach((q, i) => { if (q.askUsdcPerBtc > 0) options.push(buildSingleOption(position, q, i)); });
  if (inputs.spread) {
    const sp = buildSpreadOption(position, inputs.spread.long, inputs.spread.short);
    if (sp) options.push(sp);
  }

  return {
    position: {
      side, spot: round2(spot), entry_price: round2(entryPrice), size_btc: round4(sizeBtc), leverage,
      notional_usdc: round2(notional), margin_usdc: round2(margin),
      liquidation_price: round2(liq.price), liq_move_pct: round4(liq.movePct),
      unrealized_pnl_usdc: round2(unrealized)
    },
    settlement_style: inputs.settlementStyle ?? "european",
    tenor_days: tenorDays,
    options
  };
};
