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
  // ── Survive-the-move framing ──
  unprotected_liq_drop_pct: number;        // the drop that liquidates you unprotected (= 1/leverage)
  floor_drop_pct: number;                  // the drop you survive WITH the floor (= floorPct)
  max_loss_without_floor_usdc: number;     // ≈ margin at liquidation (and an UNCAPPED gap/ADL tail beyond)
  max_loss_with_floor_usdc: number;        // (entry−strike)×size + premium — HARD cap, gap-proof
  put_cost_usdc: number;
  /** True when the floor caps loss BEFORE liquidation (floorPct < 1/leverage) — i.e. it adds protection,
   *  not just cost. When false, leverage is so high that liquidation hits before the floor → floor is cost-only. */
  floor_adds_value: boolean;
  /** To cap your loss at the floored amount WITHOUT a floor, you'd have to cut leverage to ≤ this. */
  equivalent_unprotected_leverage: number | null;
  survival_summary: string;
  payoff: Array<{ price: number; pnl_without_floor_usdc: number; pnl_with_floor_usdc: number }>;
};

/** Pure economics given the best protective-put ask (USDC per BTC). Survive-the-move (b) framing. */
export const computeFloorEconomics = (inputs: FloorQuoteInputs, bestPutAskUsdcPerBtc: number): FloorEconomics => {
  const notional = inputs.sizeBtc * inputs.spot;
  const margin = inputs.leverage > 0 ? notional / inputs.leverage : notional;
  const floorStrike = inputs.spot * (1 - inputs.floorPct);
  const liqDropPct = inputs.leverage > 0 ? 1 / inputs.leverage : 1;
  const liqPrice = inputs.spot * (1 - liqDropPct);
  const putCost = bestPutAskUsdcPerBtc * inputs.sizeBtc;
  const maxLossWithFloor = (inputs.spot - floorStrike) * inputs.sizeBtc + putCost; // hard, gap-proof cap
  const maxLossWithoutFloor = margin; // liquidation forfeits margin (and a gap can cost MORE)
  const floorAddsValue = inputs.floorPct < liqDropPct; // floor caps before liquidation
  const equivUnprotectedLev = maxLossWithFloor > 0 ? notional / maxLossWithFloor : null;

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
  const survival_summary = floorAddsValue
    ? `Unprotected at ${inputs.leverage}×, a ${pct(liqDropPct)} drop liquidates you (lose ~${usd(margin)} margin, and a fast gap can cost MORE). With a floor at ${pct(inputs.floorPct)} below, you SURVIVE the drop with loss hard-capped at ${usd(maxLossWithFloor)} — gap-proof, no liquidation wipeout.`
    : `At ${inputs.leverage}× the liquidation point (${pct(liqDropPct)} drop) is INSIDE the ${pct(inputs.floorPct)} floor — so the put can't protect before you're liquidated. Use a floor TIGHTER than ${pct(liqDropPct)} (or lower leverage) for the floor to add value.`;

  // Payoff curve: protected line is flat-capped at the floor; unprotected is floored at −margin (liquidation).
  const payoff: FloorEconomics["payoff"] = [];
  const lo = floorStrike * 0.95;
  const hi = inputs.spot * (1 + inputs.floorPct);
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const price = lo + ((hi - lo) * i) / steps;
    const perpPnl = (price - inputs.spot) * inputs.sizeBtc;
    const pnlWithout = Math.max(perpPnl, -margin); // liquidation caps the loss at margin
    const pnlWith = perpPnl + Math.max(0, floorStrike - price) * inputs.sizeBtc - putCost; // put offsets below strike
    payoff.push({ price: +price.toFixed(2), pnl_without_floor_usdc: +pnlWithout.toFixed(2), pnl_with_floor_usdc: +pnlWith.toFixed(2) });
  }

  return {
    notional_usdc: +notional.toFixed(2),
    margin_usdc: +margin.toFixed(2),
    floor_strike: +floorStrike.toFixed(2),
    liquidation_price: +liqPrice.toFixed(2),
    unprotected_liq_drop_pct: +liqDropPct.toFixed(4),
    floor_drop_pct: +inputs.floorPct.toFixed(4),
    max_loss_without_floor_usdc: +maxLossWithoutFloor.toFixed(2),
    max_loss_with_floor_usdc: +maxLossWithFloor.toFixed(2),
    put_cost_usdc: +putCost.toFixed(2),
    floor_adds_value: floorAddsValue,
    equivalent_unprotected_leverage: equivUnprotectedLev != null ? +equivUnprotectedLev.toFixed(2) : null,
    survival_summary,
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
