/**
 * Perp Protect depth-aware pricing — VWAP-to-fill + contract→BTC conversion.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { vwapToFill, levelsToBtc, VENUE_CONTRACT_BTC, type BookLevel } from "../src/singleSide/twoSided/perpProtectDepth";

test("size within top level → effective = top, covered, zero slippage", () => {
  const levels: BookLevel[] = [{ priceUsdcPerBtc: 800, sizeBtc: 2 }, { priceUsdcPerBtc: 820, sizeBtc: 5 }];
  const r = vwapToFill(levels, 1);
  assert.equal(r.effective_usdc_per_btc, 800);
  assert.equal(r.covered, true);
  assert.equal(r.slippage_vs_top_pct, 0);
});

test("size walks multiple levels → VWAP and positive slippage", () => {
  const levels: BookLevel[] = [{ priceUsdcPerBtc: 800, sizeBtc: 1 }, { priceUsdcPerBtc: 900, sizeBtc: 1 }];
  const r = vwapToFill(levels, 2);
  assert.equal(r.effective_usdc_per_btc, 850); // (800+900)/2
  assert.equal(r.covered, true);
  assert.equal(r.slippage_vs_top_pct, 0.0625); // 850/800 - 1
});

test("book too thin → not covered, effective is VWAP of what filled", () => {
  const levels: BookLevel[] = [{ priceUsdcPerBtc: 800, sizeBtc: 0.5 }];
  const r = vwapToFill(levels, 2);
  assert.equal(r.covered, false);
  assert.equal(r.filled_btc, 0.5);
  assert.equal(r.effective_usdc_per_btc, 800);
});

test("unsorted levels are handled (walks cheapest first)", () => {
  const levels: BookLevel[] = [{ priceUsdcPerBtc: 900, sizeBtc: 1 }, { priceUsdcPerBtc: 800, sizeBtc: 1 }];
  const r = vwapToFill(levels, 1);
  assert.equal(r.effective_usdc_per_btc, 800);
});

test("no usable levels → nulls, not covered", () => {
  const r = vwapToFill([], 1);
  assert.equal(r.effective_usdc_per_btc, null);
  assert.equal(r.covered, false);
});

test("bid side walks highest-first; slippage is receive-less", () => {
  const levels: BookLevel[] = [{ priceUsdcPerBtc: 600, sizeBtc: 1 }, { priceUsdcPerBtc: 500, sizeBtc: 1 }];
  const r = vwapToFill(levels, 2, "bid");
  assert.equal(r.effective_usdc_per_btc, 550); // (600+500)/2
  assert.equal(r.top_of_book_usdc_per_btc, 600);
  assert.equal(r.slippage_vs_top_pct, +((600 / 550) - 1).toFixed(4)); // receive less than top
});

test("levelsToBtc converts OKX contracts (0.01 BTC) correctly", () => {
  const levels = levelsToBtc([{ priceUsdcPerBtc: 800, sizeContracts: 50 }], VENUE_CONTRACT_BTC.okx);
  assert.equal(levels[0].sizeBtc, 0.5); // 50 × 0.01
  // Deribit amounts are already BTC (contract_size 1.0).
  const der = levelsToBtc([{ priceUsdcPerBtc: 800, sizeContracts: 0.5 }], VENUE_CONTRACT_BTC.deribit);
  assert.equal(der[0].sizeBtc, 0.5);
});
