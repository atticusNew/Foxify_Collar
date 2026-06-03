/**
 * Option-structure math: per-structure value, cost, and theta relationships.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { structureValueAt, structureCostAndRealism, theta1dUsdc, type LegPrices } from "../src/singleSide/twoSided/optionStructures";

const SPOT = 70_000, K = 70_000, C = 1.0, SIG = 0.5;
const REM = 2 * 86_400_000; // 2 days

test("structureValueAt: straddle = put + call; collar = put − call; one-sided isolates a leg", () => {
  const straddle = structureValueAt("straddle", SPOT, K, K, C, REM, SIG, 1.0);
  const put = structureValueAt("one_sided_put", SPOT, K, K, C, REM, SIG, 1.0);
  const call = structureValueAt("one_sided_call", SPOT, K, K, C, REM, SIG, 1.0);
  const collar = structureValueAt("collar", SPOT, K, K, C, REM, SIG, 1.0);

  assert.ok(put > 0 && call > 0);
  assert.ok(Math.abs(straddle - (put + call)) < 1e-9, "straddle == put + call");
  assert.ok(Math.abs(collar - (put - call)) < 1e-9, "collar == put − call");
  assert.ok(straddle > put && straddle > call, "two-sided worth more than one leg");
  // At ATM, put ≈ call → collar ≈ 0 (synthetic-short, ~zero premium).
  assert.ok(Math.abs(collar) < 0.02 * straddle, "ATM collar value ≈ 0");
});

test("structureValueAt: vertical spreads = long leg − short OTM leg, value ≥ 0 and < the bare long leg", () => {
  const shortUp = 73_500, shortDown = 66_500; // OTM legs
  const longCall = structureValueAt("one_sided_call", SPOT, K, K, C, REM, SIG, 1.0);
  const callSpread = structureValueAt("vertical_spread_call", SPOT, K, K, C, REM, SIG, 1.0, shortUp);
  const longPut = structureValueAt("one_sided_put", SPOT, K, K, C, REM, SIG, 1.0);
  const putSpread = structureValueAt("vertical_spread_put", SPOT, K, K, C, REM, SIG, 1.0, shortDown);
  // A debit spread is cheaper than the bare long leg (you sold the OTM wing) but still > 0.
  assert.ok(callSpread > 0 && callSpread < longCall, "call spread between 0 and the long call");
  assert.ok(putSpread > 0 && putSpread < longPut, "put spread between 0 and the long put");
});

test("structureCostAndRealism: vertical spread = long ask − short bid (a debit)", () => {
  const legs: LegPrices = {
    putAskPerBtc: 1000, callAskPerBtc: 1000, putBidPerBtc: 950, callBidPerBtc: 950,
    bsPutPerBtc: 980, bsCallPerBtc: 980, shortAskPerBtc: 400, shortBidPerBtc: 360, shortBsPerBtc: 380
  };
  const callSpread = structureCostAndRealism(legs, "vertical_spread_call", 1);
  // long call ask 1000 − short call bid 360 = 640 net debit (cheaper than the bare 1000 call).
  assert.equal(callSpread.hedgeCostUsdc, 640);
  assert.ok(callSpread.salvageRealismMultiplier > 0 && callSpread.salvageRealismMultiplier <= 1.5);
});

test("theta1dUsdc: straddle bleeds most; one-sided ~half; collar ≈ 0", () => {
  const straddleTheta = theta1dUsdc("straddle", SPOT, K, K, C, 2, SIG, 1.0);
  const putTheta = theta1dUsdc("one_sided_put", SPOT, K, K, C, 2, SIG, 1.0);
  const collarTheta = theta1dUsdc("collar", SPOT, K, K, C, 2, SIG, 1.0);
  assert.ok(straddleTheta > 0, "straddle decays (positive bleed)");
  assert.ok(straddleTheta > putTheta, "straddle bleeds more than one-sided");
  assert.ok(Math.abs(collarTheta) < 0.1 * straddleTheta, "collar ≈ theta-neutral");
});

test("structureCostAndRealism: per-structure net premium", () => {
  const legs: LegPrices = {
    putAskPerBtc: 1000, callAskPerBtc: 1000,
    putBidPerBtc: 950, callBidPerBtc: 940,
    bsPutPerBtc: 980, bsCallPerBtc: 960
  };
  const straddle = structureCostAndRealism(legs, "straddle", 1);
  const put = structureCostAndRealism(legs, "one_sided_put", 1);
  const call = structureCostAndRealism(legs, "one_sided_call", 1);
  const collar = structureCostAndRealism(legs, "collar", 1);

  assert.equal(straddle.hedgeCostUsdc, 2000, "straddle = putAsk + callAsk");
  assert.equal(put.hedgeCostUsdc, 1000, "one-sided put = putAsk");
  assert.equal(call.hedgeCostUsdc, 1000, "one-sided call = callAsk");
  // collar = putAsk − callBid (you pay the put, collect the short-call bid).
  assert.equal(collar.hedgeCostUsdc, 1000 - 940, "collar = putAsk − callBid = 60");
  // one-sided premium ≈ half the two-sided.
  assert.ok(put.hedgeCostUsdc < straddle.hedgeCostUsdc);
  // realism finite + in range for every structure.
  for (const r of [straddle, put, call, collar]) {
    assert.ok(r.salvageRealismMultiplier > 0 && r.salvageRealismMultiplier <= 1.5);
  }
});
