/**
 * Cross-component pricing consistency tests.
 *
 * The whole point of Phase 1 is that MTM, ShadowCloseExecutor, and the
 * runtime TP tick all produce the SAME value for the SAME inputs (via the
 * unified priceOption module). This test suite proves that empirically.
 *
 * If any of these tests fail, it means a consumer has drifted from the
 * canonical primitive — investigate immediately.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { priceOption } from "../src/singleSide/twoSided/optionPricing";
import { ShadowCloseExecutor } from "../src/singleSide/twoSided/closeExecutor";

const makeMockCache = (bidUsdcPerBtc: number) => ({
  getBidForSymbol: ({ instrumentSymbol }: { instrumentSymbol: string }) => ({
    bidUsdcPerBtc,
    askUsdcPerBtc: bidUsdcPerBtc * 1.2,
    midUsdcPerBtc: bidUsdcPerBtc * 1.1,
    spreadPct: 0.17,
    venue: "deribit" as const,
    instrumentName: instrumentSymbol,
    tenorHours: 48,
    markIv: 0.36,
    pulledAtMs: 1_000_000_000_000
  }),
  getBidForLeg: () => null,
  getCached: () => null
}) as unknown as Parameters<typeof priceOption>[0]["liquidChainCache"];

test("consistency: priceOption + ShadowCloseExecutor agree on fill value", async () => {
  const bid = 200; // USDC/BTC
  const haircut = 0.95;
  const cache = makeMockCache(bid);

  // 1. priceOption directly
  const direct = priceOption({
    spot: 73950,
    strike: 73000,
    optType: "put",
    tenorRemainingMs: 2 * 86_400_000,
    contractsBtc: 1,
    venue: "deribit",
    instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache,
    purpose: "salvage_estimate",
    bidHaircut: haircut,
    nowMs: 1_000_000_000_000
  });
  // 2. ShadowCloseExecutor on the same instrument
  const exec = new ShadowCloseExecutor({
    chainCache: cache,
    bidSlippageHaircut: haircut,
    log: () => {}
  });
  const r = await exec.closeStrangle({
    pairId: "consistency",
    putLeg: {
      legRole: "long_put", venue: "deribit", symbol: "BTC-1JUN26-73000-P",
      contractsBtc: 1, expectedSellPxUsdcPerBtc: 9999, minAcceptablePxUsdcPerBtc: 0,
      strikeUsdc: 73000, optType: "put", tenorRemainingHours: 48
    },
    callLeg: {
      legRole: "long_call", venue: "deribit", symbol: "BTC-1JUN26-75000-C",
      contractsBtc: 1, expectedSellPxUsdcPerBtc: 9999, minAcceptablePxUsdcPerBtc: 0,
      strikeUsdc: 75000, optType: "call", tenorRemainingHours: 48
    }
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // priceOption put value
  const expectedPutFill = direct.primary_value_per_btc;
  // ShadowCloseExecutor put value
  const actualPutFill = r.putLeg.filledPxUsdcPerBtc;
  assert.ok(
    Math.abs(expectedPutFill - actualPutFill) < 0.001,
    `priceOption returned ${expectedPutFill}, ShadowCloseExecutor returned ${actualPutFill}`
  );
});

test("consistency: same purpose+inputs → same output across N calls", () => {
  const cache = makeMockCache(150);
  const inputs = {
    spot: 73950,
    strike: 73000,
    optType: "put" as const,
    tenorRemainingMs: 2 * 86_400_000,
    contractsBtc: 1,
    venue: "deribit" as const,
    instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache,
    purpose: "mtm" as const,
    nowMs: 1_000_000_000_000
  };
  const values = Array.from({ length: 10 }, () => priceOption(inputs));
  // All 10 results should be identical
  for (let i = 1; i < values.length; i++) {
    assert.deepEqual(values[i], values[0]);
  }
});

test("consistency: mtm and salvage_estimate produce same value (both bid-side haircuts)", () => {
  const cache = makeMockCache(200);
  const baseInputs = {
    spot: 73950, strike: 73000, optType: "put" as const,
    tenorRemainingMs: 2 * 86_400_000, contractsBtc: 1,
    venue: "deribit" as const, instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache, nowMs: 1_000_000_000_000
  };
  const mtm = priceOption({ ...baseInputs, purpose: "mtm" });
  const salvage = priceOption({ ...baseInputs, purpose: "salvage_estimate" });
  assert.equal(mtm.primary_value_per_btc, salvage.primary_value_per_btc);
  assert.equal(mtm.bid_per_btc, salvage.bid_per_btc);
  assert.equal(mtm.haircut_applied, salvage.haircut_applied);
});

test("consistency: fair_value differs from mtm/salvage (uses mid, no haircut)", () => {
  const cache = makeMockCache(200);
  const baseInputs = {
    spot: 73950, strike: 73000, optType: "put" as const,
    tenorRemainingMs: 2 * 86_400_000, contractsBtc: 1,
    venue: "deribit" as const, instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache, nowMs: 1_000_000_000_000
  };
  const fair = priceOption({ ...baseInputs, purpose: "fair_value" });
  const mtm = priceOption({ ...baseInputs, purpose: "mtm" });
  // fair uses mid (220), mtm uses bid × haircut (200 × 0.95 = 190)
  assert.ok(fair.primary_value_per_btc > mtm.primary_value_per_btc);
  assert.equal(fair.haircut_applied, 1.0);
});

test("consistency: bs_only fallback produces consistent ratio of BS theoretical", () => {
  // No cache → all calls fall to bs_only
  const inputs = {
    spot: 73950, strike: 73000, optType: "put" as const,
    tenorRemainingMs: 2 * 86_400_000, contractsBtc: 1,
    purpose: "mtm" as const, nowMs: 1_000_000_000_000
  };
  const r = priceOption(inputs);
  assert.equal(r.source, "bs_only");
  // primary value = bs theoretical × haircut, exact ratio
  assert.ok(
    Math.abs(r.primary_value_per_btc - r.bs_theoretical_per_btc * r.haircut_applied) < 1e-9
  );
});

test("consistency: contracts_btc scales linearly (no constants drift between scales)", () => {
  const cache = makeMockCache(200);
  const baseInputs = {
    spot: 73950, strike: 73000, optType: "put" as const,
    tenorRemainingMs: 2 * 86_400_000,
    venue: "deribit" as const, instrumentSymbol: "BTC-1JUN26-73000-P",
    liquidChainCache: cache, purpose: "mtm" as const, nowMs: 1_000_000_000_000
  };
  const r1 = priceOption({ ...baseInputs, contractsBtc: 1 });
  const r2 = priceOption({ ...baseInputs, contractsBtc: 2 });
  const r05 = priceOption({ ...baseInputs, contractsBtc: 0.5 });
  // per-BTC value MUST be identical across contract sizes (no contract-size leakage)
  assert.equal(r1.primary_value_per_btc, r2.primary_value_per_btc);
  assert.equal(r1.primary_value_per_btc, r05.primary_value_per_btc);
  // total scales linearly
  assert.equal(r1.primary_value_total * 2, r2.primary_value_total);
  assert.equal(r1.primary_value_total * 0.5, r05.primary_value_total);
});
