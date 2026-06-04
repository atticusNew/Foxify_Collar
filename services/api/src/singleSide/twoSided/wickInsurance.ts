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

export type WickInsuranceResult = {
  position: {
    notional_usdc: number;
    margin_usdc: number;
    size_btc: number;
    liquidation_price: number;
    liq_drop_pct: number;
  };
  venues: VenueWickResult[];
  best_single: { venue: string; cost_usdc: number; pct_margin: number } | null;
  best_spread: { venue: string; cost_usdc: number; pct_margin: number } | null;
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

  const best = (sel: (v: VenueWickResult) => number | null) => {
    const usable = venues
      .map((v) => ({ v, c: sel(v) }))
      .filter((x): x is { v: VenueWickResult; c: number } => x.c != null && x.c > 0);
    if (usable.length === 0) return null;
    const w = usable.reduce((b, x) => (x.c < b.c ? x : b));
    return { venue: w.v.venue, cost_usdc: w.c, pct_margin: margin > 0 ? round4(w.c / margin) : 0 };
  };

  return {
    position: {
      notional_usdc: round2(notional),
      margin_usdc: round2(margin),
      size_btc: round4(size),
      liquidation_price: round2(liqPrice),
      liq_drop_pct: round4(liqDropPct)
    },
    venues,
    best_single: best((v) => v.single_put_cost_usdc),
    best_spread: best((v) => v.put_spread_cost_usdc)
  };
};
