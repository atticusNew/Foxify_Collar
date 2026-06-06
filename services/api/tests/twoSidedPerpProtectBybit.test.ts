/**
 * Perp Protect — internal Bybit price-competitiveness comparator (pure).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareToBybit } from "../src/singleSide/twoSided/perpProtectBybit";

const bybit = { ask_usdc_per_btc: 1000, bid_usdc_per_btc: 900, strike: 57000, expiry_ms: 1, symbol: "BTC-7JAN26-57000-P-USDT" };

test("we win on both retail and hedge when cheaper than Bybit", () => {
  const r = compareToBybit({ optionId: "single-0", bybit, sizeBtc: 0.5, atticusPremiumUsdc: 420, atticusHedgeCostUsdc: 360 });
  assert.equal(r.available, true);
  assert.equal(r.bybit_premium_usdc, 500); // 1000 × 0.5
  assert.equal(r.beats_bybit_retail, true); // 420 ≤ 500
  assert.equal(r.retail_edge_usdc, 80);     // 500 − 420
  assert.equal(r.beats_bybit_hedge, true);  // 360 ≤ 500
  assert.equal(r.hedge_edge_usdc, 140);     // (1000 − 720)×0.5 ; hedge/btc = 360/0.5 = 720
  assert.equal(r.compared_option_id, "single-0");
  // Spread (1000 vs 900) = 100/950 ≈ 0.1053 → tight → fillable.
  assert.equal(r.bybit_bid_usdc_per_btc, 900);
  assert.ok(Math.abs((r.bybit_spread_pct as number) - 0.1053) < 1e-3);
  assert.equal(r.bybit_fillable, true);
});

test("size-aware ask drives the premium; TOB ask only informs spread/fillability", () => {
  // Tight top-of-book ($1000/$980) but only a sliver there → size-aware (VWAP) ask is $1200.
  const thin = { ask_usdc_per_btc: 1200, tob_ask_usdc_per_btc: 1000, bid_usdc_per_btc: 980, strike: 57000, expiry_ms: 1, symbol: "X" };
  const r = compareToBybit({ optionId: "single-0", bybit: thin, sizeBtc: 0.5, atticusPremiumUsdc: 560, atticusHedgeCostUsdc: 500 });
  assert.equal(r.bybit_premium_usdc, 600);            // size-aware 1200 × 0.5 (not the 1000 TOB)
  assert.equal(r.bybit_tob_ask_usdc_per_btc, 1000);
  assert.equal(r.bybit_fillable, true);               // spread judged on TOB 1000/980 ≈ 2%
  assert.equal(r.beats_bybit_retail, true);           // our 560 ≤ 600 size-aware
});

test("wide / one-sided Bybit book → fillable=false (don't trust the ask)", () => {
  const wide = { ...bybit, bid_usdc_per_btc: 100 }; // ask 1000 / bid 100 → spread ≈ 1.64 (164%)
  const r = compareToBybit({ optionId: "single-0", bybit: wide, sizeBtc: 0.5, atticusPremiumUsdc: 600, atticusHedgeCostUsdc: 360 });
  assert.equal(r.bybit_fillable, false);
  const oneSided = { ...bybit, bid_usdc_per_btc: null }; // no bid → spread null → not fillable
  const r2 = compareToBybit({ optionId: "single-0", bybit: oneSided, sizeBtc: 0.5, atticusPremiumUsdc: 600, atticusHedgeCostUsdc: 360 });
  assert.equal(r2.bybit_spread_pct, null);
  assert.equal(r2.bybit_fillable, false);
});

test("we lose on retail when our premium exceeds Bybit's", () => {
  const r = compareToBybit({ optionId: "single-1", bybit, sizeBtc: 0.5, atticusPremiumUsdc: 600, atticusHedgeCostUsdc: 360 });
  assert.equal(r.beats_bybit_retail, false); // 600 > 500
  assert.equal(r.retail_edge_usdc, -100);
});

test("unavailable Bybit data → available:false, no comparison", () => {
  const r = compareToBybit({ optionId: "single-0", bybit: null, sizeBtc: 0.5, atticusPremiumUsdc: 420, atticusHedgeCostUsdc: 360 });
  assert.equal(r.available, false);
  assert.equal(r.beats_bybit_retail, null);
  assert.equal(r.atticus_premium_usdc, 420); // still echoes our side
});

test("hedge sourced ON Bybit → floor-check caveat note (edge is circular)", () => {
  const r = compareToBybit({ optionId: "single-0", bybit, sizeBtc: 0.5, atticusPremiumUsdc: 420, atticusHedgeCostUsdc: 360, hedgeVenue: "bybit" });
  assert.equal(r.hedge_venue, "bybit");
  assert.match(r.note as string, /floor check/i);
});

test("hedge sourced elsewhere → no circular-comparison note", () => {
  const r = compareToBybit({ optionId: "single-0", bybit, sizeBtc: 0.5, atticusPremiumUsdc: 420, atticusHedgeCostUsdc: 360, hedgeVenue: "bullish" });
  assert.equal(r.hedge_venue, "bullish");
  assert.equal(r.note, null);
});
