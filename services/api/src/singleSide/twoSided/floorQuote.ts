/**
 * Floor-quote engine — the read-only calculator behind the leverage-additive / perp-floor
 * protection widget. Given a leveraged perp position + a protective-put floor priced LIVE
 * across venues, it computes: max loss with/without the floor, the floor cost, the payoff
 * curve, and the "leverage-additive" headline (the leverage an unprotected position would
 * carry the same worst-case loss as the floored one).
 *
 * Pure economics here (venue pricing is injected → fully testable + decoupled from the
 * chain cache). READ-ONLY: no orders, no activation, no vol-facility coupling.
 *
 * v1: LONG perp + protective PUT (the confirmed case). Short side (protective call) is the
 * mirror image — a straightforward follow-up.
 *
 * Assumptions (illustrative demo — surfaced to the user, NOT a trading guarantee):
 *  - simplified liquidation: long liq ≈ spot × (1 − 1/leverage); ignores maintenance
 *    margin, funding, fees, slippage.
 *  - the protective put caps economic loss at (entry − strike)×size + premium.
 */

export type FloorQuoteInputs = {
  spot: number;
  sizeBtc: number;
  leverage: number;
  /** Floor distance below spot as a fraction (e.g. 0.10 = put strike 10% under). */
  floorPct: number;
  tenorDays: number;
};

export type FloorEconomics = {
  notional_usdc: number;
  margin_usdc: number;
  floor_strike: number;
  liquidation_price: number;
  max_loss_without_floor_usdc: number;   // ≈ margin (liquidation loss)
  put_cost_usdc: number;
  max_loss_with_floor_usdc: number;       // (entry−strike)×size + premium, capped
  /** Leverage at which an UNPROTECTED position carries the same max loss as the floored one. */
  equivalent_leverage: number | null;
  /** equivalent_leverage − current leverage (how much more leverage the floor "buys"). */
  leverage_additive: number | null;
  payoff: Array<{ price: number; pnl_without_floor_usdc: number; pnl_with_floor_usdc: number }>;
};

/** Pure economics given the best protective-put ask (USDC per BTC). */
export const computeFloorEconomics = (inputs: FloorQuoteInputs, bestPutAskUsdcPerBtc: number): FloorEconomics => {
  const notional = inputs.sizeBtc * inputs.spot;
  const margin = inputs.leverage > 0 ? notional / inputs.leverage : notional;
  const floorStrike = inputs.spot * (1 - inputs.floorPct);
  const liqPrice = inputs.leverage > 0 ? inputs.spot * (1 - 1 / inputs.leverage) : 0;
  const putCost = bestPutAskUsdcPerBtc * inputs.sizeBtc;
  const floorDistanceLoss = (inputs.spot - floorStrike) * inputs.sizeBtc; // loss from entry down to the floor
  const maxLossWithFloor = floorDistanceLoss + putCost;
  const maxLossWithoutFloor = margin; // liquidation forfeits posted margin
  const equivLeverage = maxLossWithFloor > 0 ? notional / maxLossWithFloor : null;

  // Payoff curve from −1 floor-distance below the floor up to +floorPct above spot.
  const payoff: FloorEconomics["payoff"] = [];
  const lo = floorStrike * 0.97;
  const hi = inputs.spot * (1 + inputs.floorPct);
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const price = lo + ((hi - lo) * i) / steps;
    const perpPnl = (price - inputs.spot) * inputs.sizeBtc;
    // Unprotected: floored at −margin (liquidation).
    const pnlWithout = Math.max(perpPnl, -margin);
    // Protected: long perp + long put(strike). Below strike the put offsets further losses.
    const putPayoff = Math.max(0, floorStrike - price) * inputs.sizeBtc;
    const pnlWith = perpPnl + putPayoff - putCost;
    payoff.push({ price: +price.toFixed(2), pnl_without_floor_usdc: +pnlWithout.toFixed(2), pnl_with_floor_usdc: +pnlWith.toFixed(2) });
  }

  return {
    notional_usdc: +notional.toFixed(2),
    margin_usdc: +margin.toFixed(2),
    floor_strike: +floorStrike.toFixed(2),
    liquidation_price: +liqPrice.toFixed(2),
    max_loss_without_floor_usdc: +maxLossWithoutFloor.toFixed(2),
    put_cost_usdc: +putCost.toFixed(2),
    max_loss_with_floor_usdc: +maxLossWithFloor.toFixed(2),
    equivalent_leverage: equivLeverage != null ? +equivLeverage.toFixed(2) : null,
    leverage_additive: equivLeverage != null ? +(equivLeverage - inputs.leverage).toFixed(2) : null,
    payoff
  };
};

export type VenuePutQuote = { venue: string; ask_usdc_per_btc: number | null; instrument?: string | null };

/** Pick the cheapest (lowest ask) protective-put venue from a set of live quotes. */
export const bestPutVenue = (quotes: VenuePutQuote[]): VenuePutQuote | null => {
  const usable = quotes.filter((q) => q.ask_usdc_per_btc != null && q.ask_usdc_per_btc > 0);
  if (usable.length === 0) return null;
  return usable.reduce((best, q) => (q.ask_usdc_per_btc! < best.ask_usdc_per_btc! ? q : best));
};
