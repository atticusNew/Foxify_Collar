/**
 * Wick-insurance economics — single put vs put spread cost as % of margin, best-venue pick.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeWickInsurance, type WickInsuranceInputs, type VenueLegQuotes } from "../src/singleSide/twoSided/wickInsurance";

const base: WickInsuranceInputs = { spot: 62000, collateralUsdc: 1000, leverage: 40, tenorDays: 1 };
// size = 1000*40/62000 = 0.6452 BTC

test("position math: notional, margin, size, liquidation", () => {
  const r = computeWickInsurance(base, []);
  assert.equal(r.position.notional_usdc, 40000);
  assert.equal(r.position.margin_usdc, 1000);
  assert.equal(r.position.size_btc, 0.6452);
  assert.equal(r.position.liq_drop_pct, 0.025);
  assert.equal(r.position.liquidation_price, 60450); // 62000*(1-1/40)
});

test("single put cost = ask × size, expressed as % of margin", () => {
  const q: VenueLegQuotes[] = [{ venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 61000, k2BidUsdcPerBtc: null, k2Strike: null }];
  const r = computeWickInsurance(base, q);
  const v = r.venues[0];
  // cost = 1000 × 0.6452 = 645.2; pct = 645.16/1000 ≈ 0.6452
  assert.equal(v.single_put_cost_usdc, 645.16);
  assert.equal(v.single_put_pct_margin, 0.6452);
  assert.equal(v.put_spread_cost_usdc, null, "no short-leg bid → no spread");
});

test("put spread cost = (askK1 − bidK2) × size; much cheaper than single put", () => {
  const q: VenueLegQuotes[] = [{ venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 61000, k2BidUsdcPerBtc: 600, k2Strike: 59000 }];
  const r = computeWickInsurance(base, q);
  const v = r.venues[0];
  // (1000-600) × 0.6452 = 258.06
  assert.equal(v.put_spread_cost_usdc, 258.06);
  assert.ok((v.put_spread_pct_margin ?? 1) < (v.single_put_pct_margin ?? 1), "spread cheaper than single");
});

test("spread invalid when K2 >= K1 (short leg not deeper)", () => {
  const q: VenueLegQuotes[] = [{ venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 60000, k2BidUsdcPerBtc: 600, k2Strike: 61000 }];
  const r = computeWickInsurance(base, q);
  assert.equal(r.venues[0].put_spread_cost_usdc, null);
  assert.ok(/no valid spread/.test(r.venues[0].note ?? ""));
});

test("best_single picks cheapest long ask across venues (incl. Bullish)", () => {
  const q: VenueLegQuotes[] = [
    { venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 61000, k2BidUsdcPerBtc: 600, k2Strike: 59000 },
    { venue: "deribit", k1AskUsdcPerBtc: 1100, k1Strike: 61000, k2BidUsdcPerBtc: 580, k2Strike: 59000 },
    { venue: "bullish", k1AskUsdcPerBtc: 900, k1Strike: 61000, k2BidUsdcPerBtc: 650, k2Strike: 59000 }
  ];
  const r = computeWickInsurance(base, q);
  assert.equal(r.best_single?.venue, "bullish", "bullish has the cheapest long put");
});

test("best_spread ROUTES legs cross-venue: long where ask cheapest, short where bid highest", () => {
  const q: VenueLegQuotes[] = [
    { venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 61000, k2BidUsdcPerBtc: 600, k2Strike: 59000 },
    { venue: "deribit", k1AskUsdcPerBtc: 1100, k1Strike: 61000, k2BidUsdcPerBtc: 580, k2Strike: 59000 },
    { venue: "bullish", k1AskUsdcPerBtc: 900, k1Strike: 61000, k2BidUsdcPerBtc: 650, k2Strike: 59000 }
  ];
  const r = computeWickInsurance(base, q);
  // long = bullish (ask 900, cheapest); short = bullish (bid 650, highest) → net 250 × 0.6452
  assert.equal(r.best_spread?.long_venue, "bullish");
  assert.equal(r.best_spread?.short_venue, "bullish");
  // If bullish absent, legs split: long okx(1000) / short okx(600)… verify a true split:
  const q2: VenueLegQuotes[] = [
    { venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 61000, k2BidUsdcPerBtc: 600, k2Strike: 59000 },
    { venue: "deribit", k1AskUsdcPerBtc: 1100, k1Strike: 61000, k2BidUsdcPerBtc: 700, k2Strike: 59000 }
  ];
  const r2 = computeWickInsurance(base, q2);
  assert.equal(r2.best_spread?.long_venue, "okx", "long routed to cheapest ask");
  assert.equal(r2.best_spread?.short_venue, "deribit", "short routed to highest bid");
  // net = 1000 (okx ask) − 700 (deribit bid) = 300 × (40000/62000) = 193.55
  assert.equal(r2.best_spread?.cost_usdc, 193.55);
});

test("SHORT side: liq above spot; spread valid when K2 > K1 (calls, deeper = higher strike)", () => {
  const q: VenueLegQuotes[] = [{ venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 62800, k2BidUsdcPerBtc: 600, k2Strike: 64000 }];
  const r = computeWickInsurance({ spot: 62000, collateralUsdc: 1000, leverage: 40, tenorDays: 1, side: "short" }, q);
  assert.equal(r.position.liquidation_price, 63550); // 62000 × (1 + 1/40)
  assert.ok(r.best_spread, "call spread valid when short strike is higher (deeper OTM)");
  assert.equal(r.best_spread?.k1_strike, 62800);
  assert.equal(r.best_spread?.k2_strike, 64000);
});

test("SHORT side: a put-style ordering (K2<K1) is NOT a valid call spread", () => {
  const q: VenueLegQuotes[] = [{ venue: "okx", k1AskUsdcPerBtc: 1000, k1Strike: 62800, k2BidUsdcPerBtc: 600, k2Strike: 61000 }];
  const r = computeWickInsurance({ spot: 62000, collateralUsdc: 1000, leverage: 40, tenorDays: 1, side: "short" }, q);
  assert.equal(r.best_spread, null);
});

test("venues with no quotes are skipped in best-of", () => {
  const q: VenueLegQuotes[] = [
    { venue: "okx", k1AskUsdcPerBtc: null, k1Strike: null, k2BidUsdcPerBtc: null, k2Strike: null },
    { venue: "deribit", k1AskUsdcPerBtc: 1100, k1Strike: 61000, k2BidUsdcPerBtc: null, k2Strike: null }
  ];
  const r = computeWickInsurance(base, q);
  assert.equal(r.best_single?.venue, "deribit");
  assert.equal(r.best_spread, null);
});
