/**
 * Wick-insurance economics — the structure that actually WORKS at high leverage (30–40×).
 *
 * At 30–40× a near-ATM protective put costs ~your whole margin, so "reduce my max loss" is a
 * dead end. The value that DOES work is "don't get liquidated by a wick": a short-dated put
 * (or put SPREAD) placed around the liquidation zone so a brief spike doesn't force you out —
 * you stay in the trade and keep the upside on the bounce.
 *
 * This module is PURE (venue pricing injected → fully testable). It compares, per venue:
 *   - single_put : long put at K1 (pay the ASK).            cost = ask(K1) × size
 *   - put_spread : long K1 / short deeper K2 (sell at BID). cost = (ask(K1) − bid(K2)) × size
 * and expresses cost as a % of the trader's margin — the number that decides if it's worth it.
 *
 * READ-ONLY research/measurement. No orders. Honest framing: in the integrated (exchange
 * margin) model a put with strike ABOVE the liquidation price keeps the position open.
 */

export type VenueLegQuotes = {
  venue: string;
  /** Long-leg (protection) ask in USDC per BTC at the K1 strike actually priced. */
  k1AskUsdcPerBtc: number | null;
  k1Strike: number | null;
  /** Short-leg (spread) bid in USDC per BTC at the deeper K2 strike actually priced. */
  k2BidUsdcPerBtc: number | null;
  k2Strike: number | null;
};

export type WickInsuranceInputs = {
  spot: number;
  collateralUsdc: number;   // = margin posted
  leverage: number;
  tenorDays: number;
};

export type VenueWickResult = {
  venue: string;
  k1_strike: number | null;
  k2_strike: number | null;
  single_put_cost_usdc: number | null;
  single_put_pct_margin: number | null;
  put_spread_cost_usdc: number | null;
  put_spread_pct_margin: number | null;
  note: string | null;
};

/** Cheapest long put (K1) across venues. */
export type BestSingle = { venue: string; cost_usdc: number; pct_margin: number; strike: number } | null;
/** Cross-venue routed spread: long K1 at cheapest ask, short K2 at highest bid (legs may
 *  live on different venues for best execution). */
export type BestSpread = { long_venue: string; short_venue: string; cost_usdc: number; pct_margin: number; k1_strike: number; k2_strike: number } | null;

export type WickInsuranceResult = {
  position: {
    notional_usdc: number;
    margin_usdc: number;
    size_btc: number;
    liquidation_price: number;
    liq_drop_pct: number;
  };
  venues: VenueWickResult[];
  best_single: BestSingle;
  best_spread: BestSpread;
};

const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);

export const computeWickInsurance = (inputs: WickInsuranceInputs, quotes: VenueLegQuotes[]): WickInsuranceResult => {
  const { spot, collateralUsdc, leverage, tenorDays: _tenorDays } = inputs;
  const notional = collateralUsdc * leverage;
  const margin = collateralUsdc;
  const size = spot > 0 ? notional / spot : 0;
  const liqDropPct = leverage > 0 ? 1 / leverage : 1;
  const liqPrice = spot * (1 - liqDropPct);

  const venues: VenueWickResult[] = quotes.map((q) => {
    const singleCost = q.k1AskUsdcPerBtc != null && q.k1AskUsdcPerBtc > 0 ? q.k1AskUsdcPerBtc * size : null;
    // Spread requires BOTH a long ask (K1) and a short bid (K2), with K2 strictly below K1.
    const spreadOk =
      q.k1AskUsdcPerBtc != null && q.k1AskUsdcPerBtc > 0 &&
      q.k2BidUsdcPerBtc != null && q.k2BidUsdcPerBtc > 0 &&
      q.k1Strike != null && q.k2Strike != null && q.k2Strike < q.k1Strike;
    const spreadNetPerBtc = spreadOk ? (q.k1AskUsdcPerBtc as number) - (q.k2BidUsdcPerBtc as number) : null;
    const spreadCost = spreadNetPerBtc != null && spreadNetPerBtc > 0 ? spreadNetPerBtc * size : null;
    return {
      venue: q.venue,
      k1_strike: q.k1Strike,
      k2_strike: q.k2Strike,
      single_put_cost_usdc: singleCost != null ? round2(singleCost) : null,
      single_put_pct_margin: singleCost != null && margin > 0 ? round4(singleCost / margin) : null,
      put_spread_cost_usdc: spreadCost != null ? round2(spreadCost) : null,
      put_spread_pct_margin: spreadCost != null && margin > 0 ? round4(spreadCost / margin) : null,
      note: spreadOk ? null : "no valid spread (missing short-leg bid or K2≥K1)"
    };
  });

  // ── Cross-venue per-leg routing: buy the long (K1) where the ask is cheapest, sell the
  //    short (K2) where the bid is highest — legs may land on different venues. ──
  const longCands = quotes
    .map((q) => ({ venue: q.venue, ask: q.k1AskUsdcPerBtc, strike: q.k1Strike }))
    .filter((x): x is { venue: string; ask: number; strike: number } => x.ask != null && x.ask > 0 && x.strike != null && x.strike > 0);
  const shortCands = quotes
    .map((q) => ({ venue: q.venue, bid: q.k2BidUsdcPerBtc, strike: q.k2Strike }))
    .filter((x): x is { venue: string; bid: number; strike: number } => x.bid != null && x.bid > 0 && x.strike != null && x.strike > 0);
  const longLeg = longCands.length ? longCands.reduce((b, x) => (x.ask < b.ask ? x : b)) : null;
  const shortLeg = shortCands.length ? shortCands.reduce((b, x) => (x.bid > b.bid ? x : b)) : null;

  const best_single: BestSingle = longLeg
    ? { venue: longLeg.venue, cost_usdc: round2(longLeg.ask * size), pct_margin: margin > 0 ? round4((longLeg.ask * size) / margin) : 0, strike: longLeg.strike }
    : null;

  // Valid spread only if the short strike is strictly DEEPER (below) the long strike.
  const spreadNetPerBtc = longLeg && shortLeg && shortLeg.strike < longLeg.strike ? longLeg.ask - shortLeg.bid : null;
  const best_spread: BestSpread = spreadNetPerBtc != null && spreadNetPerBtc > 0 && longLeg && shortLeg
    ? { long_venue: longLeg.venue, short_venue: shortLeg.venue, cost_usdc: round2(spreadNetPerBtc * size), pct_margin: margin > 0 ? round4((spreadNetPerBtc * size) / margin) : 0, k1_strike: longLeg.strike, k2_strike: shortLeg.strike }
    : null;

  return {
    position: {
      notional_usdc: round2(notional),
      margin_usdc: round2(margin),
      size_btc: round4(size),
      liquidation_price: round2(liqPrice),
      liq_drop_pct: round4(liqDropPct)
    },
    venues,
    best_single,
    best_spread
  };
};
