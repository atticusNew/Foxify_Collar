/**
 * Fee-Recovery Cover pricing — exchange-priced one-touch (replicating vertical), both sides.
 * Deterministic: exchange quotes are injected, no Black-Scholes in the priced path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierPrice, buildFeeRecoveryQuote,
  type FeeRecoveryParams, type HedgeSpreadQuote
} from "../src/singleSide/twoSided/feeRecoveryQuote";

// $50k long, 3% stop, 24h, refund $100 of fees. Spot 100k → barrier 97k.
const longParams: FeeRecoveryParams = {
  side: "long", spot: 100000, notionalUsdc: 50000, triggerPct: 0.03, tenorDays: 1, payoutUsdc: 100
};
// Replicating put spread straddling 97k: buy 98k put (ask 1200), sell 96k put (bid 700). width 2000.
const longHedge: HedgeSpreadQuote = {
  longStrike: 98000, longAskUsdcPerBtc: 1200, shortStrike: 96000, shortBidUsdcPerBtc: 700
};

test("barrierPrice: long below spot, short above spot", () => {
  assert.equal(barrierPrice("long", 100000, 0.03), 97000);
  assert.equal(barrierPrice("short", 100000, 0.03), 103000);
});

test("long cover: exchange-priced fair value, premium, and Atticus margin", () => {
  const q = buildFeeRecoveryQuote(longParams, longHedge, { loadPct: 0.4, touchMultiplier: 2.0 });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  // width 2000, payout 100 → 0.05 contracts; net debit 500/btc → european cost 25; ×2 → fair 50.
  assert.equal(q.hedge.spread_width_usd, 2000);
  assert.equal(q.hedge.contracts_btc, 0.05);
  assert.equal(q.hedge.net_debit_usdc_per_btc, 500);
  assert.equal(q.hedge.european_digital_cost_usdc, 25);
  assert.equal(q.hedge.one_touch_hedge_cost_usdc, 50);
  assert.equal(q.pricing.fair_value_usdc, 50);
  assert.equal(q.pricing.premium_usdc, 70);          // 50 × 1.4
  assert.equal(q.pricing.atticus_margin_usdc, 20);   // 70 − 50
  assert.equal(q.pricing.implied_digital_prob, 0.25);
  assert.equal(q.pricing.implied_touch_prob, 0.5);   // 0.25 × 2
  assert.equal(q.economics.breakeven_touch_rate, 0.7); // 70 / 100
  assert.equal(q.hedge.structure, "put_spread");
});

test("foxify economics: -EV at implied rate (the load), +EV above breakeven", () => {
  const q = buildFeeRecoveryQuote(longParams, longHedge, { loadPct: 0.4, touchMultiplier: 2.0 },
    { tradesPerDay: 1000 });
  if (!q.ok) return;
  // at implied touch prob 0.5: expected payout 50, premium 70 → net -20/trade = -load.
  assert.equal(q.economics.touch_rate_source, "exchange_implied");
  assert.equal(q.economics.foxify.expected_payout_per_trade_usdc, 50);
  assert.equal(q.economics.foxify.net_ev_per_trade_usdc, -20);
  assert.equal(q.economics.foxify.net_ev_per_day_usdc, -20000);
  // Atticus keeps the load.
  assert.equal(q.economics.atticus.expected_gross_margin_per_trade_usdc, 20);
  assert.equal(q.economics.atticus.expected_gross_margin_per_day_usdc, 20000);
});

test("foxify measured hit-rate above breakeven flips to +EV", () => {
  const q = buildFeeRecoveryQuote(longParams, longHedge, { loadPct: 0.4, touchMultiplier: 2.0 },
    { tradesPerDay: 1000, foxifyRealTouchRate: 0.8 });
  if (!q.ok) return;
  assert.equal(q.economics.touch_rate_source, "foxify_measured");
  assert.equal(q.economics.touch_rate_used, 0.8);
  // 0.8 × 100 − 70 = +10/trade.
  assert.equal(q.economics.foxify.net_ev_per_trade_usdc, 10);
  assert.equal(q.economics.foxify.net_ev_per_day_usdc, 10000);
});

test("min premium floor applies at tiny size", () => {
  const q = buildFeeRecoveryQuote(longParams, longHedge, { loadPct: 0.0, touchMultiplier: 2.0, minPremiumUsdc: 60 });
  if (!q.ok) return;
  assert.equal(q.pricing.fair_value_usdc, 50);
  assert.equal(q.pricing.premium_usdc, 60); // floored above fair×1.0=50
});

test("short cover: call spread, short strike must be HIGHER", () => {
  const shortParams: FeeRecoveryParams = { ...longParams, side: "short" };
  const shortHedge: HedgeSpreadQuote = {
    longStrike: 102000, longAskUsdcPerBtc: 1200, shortStrike: 104000, shortBidUsdcPerBtc: 700
  };
  const q = buildFeeRecoveryQuote(shortParams, shortHedge, { loadPct: 0.4, touchMultiplier: 2.0 });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.equal(q.hedge.structure, "call_spread");
  assert.equal(q.position.barrier_price, 103000);
  assert.equal(q.pricing.premium_usdc, 70);
});

test("rejects invalid spread (short leg not beyond long leg)", () => {
  const bad: HedgeSpreadQuote = { longStrike: 96000, longAskUsdcPerBtc: 1200, shortStrike: 98000, shortBidUsdcPerBtc: 700 };
  const q = buildFeeRecoveryQuote(longParams, bad, {});
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "invalid_spread");
});

test("rejects non-positive debit (long ask must exceed short bid)", () => {
  const bad: HedgeSpreadQuote = { longStrike: 98000, longAskUsdcPerBtc: 600, shortStrike: 96000, shortBidUsdcPerBtc: 700 };
  const q = buildFeeRecoveryQuote(longParams, bad, {});
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "non_positive_debit");
});

test("rejects invalid params (trigger out of range)", () => {
  const q = buildFeeRecoveryQuote({ ...longParams, triggerPct: 0 }, longHedge, {});
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "invalid_trigger");
});
