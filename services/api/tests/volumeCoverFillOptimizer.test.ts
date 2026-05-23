import assert from "node:assert/strict";
import test from "node:test";

import {
  computeImprovedTargetPrice,
  executeOptimizedFill,
  type FillSubmitFn
} from "../src/volumeCover/fillOptimizer";

const clearFillEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VC_FILL_OPTIMIZER_")) {
      delete process.env[key];
    }
  }
};

test("computeImprovedTargetPrice: BUY at 25% inside the spread", () => {
  const p = computeImprovedTargetPrice({
    side: "BUY",
    topBidUsdc: 100,
    topAskUsdc: 120,
    improvementFraction: 0.25,
    tickSizeUsdc: 0.01
  });
  // 120 - (120 - 100) * 0.25 = 120 - 5 = 115
  assert.equal(p, 115);
});

test("computeImprovedTargetPrice: SELL at 25% inside the spread", () => {
  const p = computeImprovedTargetPrice({
    side: "SELL",
    topBidUsdc: 100,
    topAskUsdc: 120,
    improvementFraction: 0.25
  });
  // 100 + (120 - 100) * 0.25 = 105
  assert.equal(p, 105);
});

test("computeImprovedTargetPrice: zero-spread returns null", () => {
  const p = computeImprovedTargetPrice({
    side: "BUY",
    topBidUsdc: 110,
    topAskUsdc: 110,
    improvementFraction: 0.25
  });
  assert.equal(p, null);
});

test("computeImprovedTargetPrice: non-finite bid/ask returns null", () => {
  const p = computeImprovedTargetPrice({
    side: "BUY",
    topBidUsdc: NaN,
    topAskUsdc: 120,
    improvementFraction: 0.25
  });
  assert.equal(p, null);
});

test("executeOptimizedFill: improved-price fill succeeds on first attempt", async () => {
  clearFillEnv();
  let calls = 0;
  const submitFn: FillSubmitFn = async ({ priceUsdc }) => {
    calls += 1;
    return {
      filled: true,
      fillPriceUsdc: priceUsdc,
      fillQtyBtc: 0.01,
      finalReason: "Executed",
      orderId: "ORD-1"
    };
  };
  const r = await executeOptimizedFill({
    side: "BUY",
    symbol: "BTC-USDC-X",
    quantityBtc: 0.01,
    topBidUsdc: 100,
    topAskUsdc: 120,
    submitFn
  });
  assert.equal(r.filled, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.attemptedPrices, [115]);
  assert.equal(calls, 1);
});

test("executeOptimizedFill: Expired on improved price → fallback to ask succeeds", async () => {
  clearFillEnv();
  let calls = 0;
  const submitFn: FillSubmitFn = async ({ priceUsdc }) => {
    calls += 1;
    if (calls === 1) {
      // First attempt at improved price expires
      return {
        filled: false,
        fillPriceUsdc: priceUsdc,
        fillQtyBtc: 0,
        finalReason: "Expired",
        orderId: "ORD-1"
      };
    }
    // Second attempt at worst-case ask fills
    return {
      filled: true,
      fillPriceUsdc: priceUsdc,
      fillQtyBtc: 0.01,
      finalReason: "Executed",
      orderId: "ORD-2"
    };
  };
  const r = await executeOptimizedFill({
    side: "BUY",
    symbol: "BTC-USDC-X",
    quantityBtc: 0.01,
    topBidUsdc: 100,
    topAskUsdc: 120,
    submitFn
  });
  assert.equal(r.filled, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.attemptedPrices, [115, 120]);
  assert.equal(r.fillPriceUsdc, 120);
});

test("executeOptimizedFill: Rejected on first attempt does NOT retry", async () => {
  clearFillEnv();
  let calls = 0;
  const submitFn: FillSubmitFn = async ({ priceUsdc }) => {
    calls += 1;
    return {
      filled: false,
      fillPriceUsdc: priceUsdc,
      fillQtyBtc: 0,
      finalReason: "Rejected",
      orderId: "ORD-1",
      raw: { error: "INSUFFICIENT_BALANCE" }
    };
  };
  const r = await executeOptimizedFill({
    side: "BUY",
    symbol: "BTC-USDC-X",
    quantityBtc: 0.01,
    topBidUsdc: 100,
    topAskUsdc: 120,
    submitFn
  });
  assert.equal(r.filled, false);
  assert.equal(r.attempts, 1);
  assert.equal(r.finalReason, "Rejected");
  assert.equal(calls, 1);
});

test("executeOptimizedFill: optimizer disabled → straight to worst-case (single attempt)", async () => {
  process.env.VC_FILL_OPTIMIZER_ENABLED = "false";
  try {
    let calls = 0;
    let receivedPrice = 0;
    const submitFn: FillSubmitFn = async ({ priceUsdc }) => {
      calls += 1;
      receivedPrice = priceUsdc;
      return {
        filled: true,
        fillPriceUsdc: priceUsdc,
        fillQtyBtc: 0.01,
        finalReason: "Executed",
        orderId: "ORD-1"
      };
    };
    const r = await executeOptimizedFill({
      side: "SELL",
      symbol: "BTC-USDC-X",
      quantityBtc: 0.01,
      topBidUsdc: 100,
      topAskUsdc: 120,
      submitFn
    });
    assert.equal(r.filled, true);
    assert.equal(r.attempts, 1);
    assert.equal(receivedPrice, 100); // worst-case bid
    assert.equal(calls, 1);
  } finally {
    clearFillEnv();
  }
});

test("executeOptimizedFill: zero-spread book → single attempt at worst-case", async () => {
  clearFillEnv();
  let calls = 0;
  const submitFn: FillSubmitFn = async ({ priceUsdc }) => {
    calls += 1;
    return {
      filled: true,
      fillPriceUsdc: priceUsdc,
      fillQtyBtc: 0.01,
      finalReason: "Executed",
      orderId: "ORD-1"
    };
  };
  const r = await executeOptimizedFill({
    side: "BUY",
    symbol: "BTC-USDC-X",
    quantityBtc: 0.01,
    topBidUsdc: 100,
    topAskUsdc: 100, // zero spread → no improvement possible
    submitFn
  });
  assert.equal(r.filled, true);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
});
