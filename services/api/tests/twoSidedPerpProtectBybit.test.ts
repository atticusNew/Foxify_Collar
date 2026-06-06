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
