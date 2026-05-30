/**
 * Tests for ShadowCloseExecutor bid-based valuation.
 *
 * Critical correctness path: when a venue bid is available, the executor
 * MUST use it instead of BS-derived expected. When bid is missing, falls
 * back to expected (BS) so unwinding never breaks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ShadowCloseExecutor,
  type CloseStrangleRequest,
  type CloseLegRequest
} from "../src/singleSide/twoSided/closeExecutor";

const baseReq: CloseStrangleRequest = {
  pairId: "pair-1",
  putLeg: {
    legRole: "long_put",
    venue: "bullish",
    symbol: "BTC-2D-73000-P",
    contractsBtc: 0.5,
    expectedSellPxUsdcPerBtc: 1000, // BS-derived (potentially inflated)
    minAcceptablePxUsdcPerBtc: 100,
    strikeUsdc: 73000,
    optType: "put",
    tenorRemainingHours: 48
  },
  callLeg: {
    legRole: "long_call",
    venue: "bullish",
    symbol: "BTC-2D-75000-C",
    contractsBtc: 0.5,
    expectedSellPxUsdcPerBtc: 1000,
    minAcceptablePxUsdcPerBtc: 100,
    strikeUsdc: 75000,
    optType: "call",
    tenorRemainingHours: 48
  }
};

test("ShadowCloseExecutor: uses venue bid when available (bid << BS expected)", async () => {
  // Real-world scenario: BS says option is worth $1000/BTC but real venue
  // bid is $200/BTC. Executor MUST use $200, not $1000.
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 200, // venue bid is $200/BTC for both legs
    bidSlippageHaircut: 0.95,
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Each leg fill = 200 × 0.95 = 190 USDC/BTC
  // Total proceeds = 190 × 0.5 + 190 × 0.5 = 190 USDC
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 190);
  assert.equal(r.callLeg.filledPxUsdcPerBtc, 190);
  assert.equal(r.totalProceedsUsdc, 190);
  assert.equal(r.putLeg.valuationMethod, "exact_symbol");
  assert.equal(r.callLeg.valuationMethod, "exact_symbol");
  assert.equal(r.putLeg.rawVenueBidUsdcPerBtc, 200);
});

test("ShadowCloseExecutor: falls back to BS expected when bid lookup returns null", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: () => null, // no bid available
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Fall back to expected = 1000 USDC/BTC (no slip applied — already in expected)
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 1000);
  assert.equal(r.callLeg.filledPxUsdcPerBtc, 1000);
  assert.equal(r.totalProceedsUsdc, 1000); // 1000 × 0.5 + 1000 × 0.5
  assert.equal(r.putLeg.valuationMethod, "bs_expected");
  assert.equal(r.callLeg.valuationMethod, "bs_expected");
  assert.equal(r.putLeg.rawVenueBidUsdcPerBtc, undefined);
});

test("ShadowCloseExecutor: falls back to BS expected when bid is 0", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 0, // zero bid = no resting buyer
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected");
});

test("ShadowCloseExecutor: mixed — put has bid, call doesn't", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: (leg: CloseLegRequest) => leg.optType === "put" ? 100 : null,
    bidSlippageHaircut: 1.0, // no haircut for easy math
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Put: real bid 100 → fill 100
  // Call: no bid → fill 1000 (expected)
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 100);
  assert.equal(r.callLeg.filledPxUsdcPerBtc, 1000);
  assert.equal(r.putLeg.valuationMethod, "exact_symbol");
  assert.equal(r.callLeg.valuationMethod, "bs_expected");
});

test("ShadowCloseExecutor: ACCEPTS real-bid fill below BS-derived floor (real bid IS the market)", async () => {
  // Critical semantic: shadow accepts whatever real bid the venue is
  // showing, even if below the BS-derived floor. The floor only catches
  // bad fills in live trading; in shadow we record reality.
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 50, // bid * 0.95 = 47.5, below min 100
    bidSlippageHaircut: 0.95,
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true, "shadow should accept real bid even when below BS floor");
  if (!r.ok) return;
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 47.5);
  assert.equal(r.putLeg.valuationMethod, "exact_symbol");
  assert.equal(r.putLeg.rawVenueBidUsdcPerBtc, 50);
});

test("ShadowCloseExecutor: rejects real-bid path if bid is zero (no liquidity)", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 0, // zero bid is treated as no liquidity, not a real bid
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true, "zero bid falls through to BS-expected fallback (not stuck)");
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected");
});

test("ShadowCloseExecutor: rejects fill below min_acceptable (bs_expected path)", async () => {
  const exec = new ShadowCloseExecutor({ bidLookup: () => null, log: () => {} });
  const reqLow: CloseStrangleRequest = {
    ...baseReq,
    putLeg: { ...baseReq.putLeg, expectedSellPxUsdcPerBtc: 50, minAcceptablePxUsdcPerBtc: 100 },
    callLeg: { ...baseReq.callLeg, expectedSellPxUsdcPerBtc: 50, minAcceptablePxUsdcPerBtc: 100 }
  };
  const r = await exec.closeStrangle(reqLow);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.putLegResult.ok, false);
  if (r.putLegResult.ok) return;
  assert.match(r.putLegResult.detail, /bs_expected/);
});

test("ShadowCloseExecutor: no chain cache + no bidLookup = always bs_expected", async () => {
  const exec = new ShadowCloseExecutor({}); // empty config
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected");
  assert.equal(r.callLeg.valuationMethod, "bs_expected");
});

test("ShadowCloseExecutor: missing strike/optType/tenor inputs = bs_expected fallback", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 200, // would return a bid if called, but missing inputs short-circuits
    log: () => {}
  });
  const reqMissing: CloseStrangleRequest = {
    ...baseReq,
    putLeg: { ...baseReq.putLeg, strikeUsdc: undefined },
    callLeg: { ...baseReq.callLeg, optType: undefined }
  };
  // bidLookup IS called by ShadowCloseExecutor regardless of strike/optType
  // when bidLookup is explicitly injected (test-mode override). Verify normal
  // chainCache path correctly short-circuits when strike/optType missing.
  // (Exact-symbol lookup may also miss when symbol isn't in the test mock.)
  const exec2 = new ShadowCloseExecutor({
    chainCache: {
      getBidForSymbol: () => null,           // no exact match
      getBidForLeg: () => ({ bidUsdcPerBtc: 200 })
    } as unknown as Parameters<typeof ShadowCloseExecutor>[0]["chainCache"],
    log: () => {}
  });
  const r = await exec2.closeStrangle(reqMissing);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected", "missing strike → bs fallback");
  assert.equal(r.callLeg.valuationMethod, "bs_expected", "missing optType → bs fallback");
});

test("ShadowCloseExecutor: prefers exact-symbol match via chainCache (regression: wrong-expiry bug)", async () => {
  // Mock chain cache where exact symbol returns bid=177 but fuzzy
  // match would return bid=347 (wrong-expiry option). The fix MUST
  // use the exact-symbol bid.
  const mockCache = {
    getBidForSymbol: ({ instrumentSymbol }: { instrumentSymbol: string }) => {
      if (instrumentSymbol === "BTC-1JUN26-73000-P") {
        return { bidUsdcPerBtc: 177, askUsdcPerBtc: 207, midUsdcPerBtc: 192, spreadPct: 0.15, venue: "deribit" as const, instrumentName: instrumentSymbol, tenorHours: 37, markIv: 0.28, pulledAtMs: 0 };
      }
      if (instrumentSymbol === "BTC-1JUN26-75000-C") {
        return { bidUsdcPerBtc: 126, askUsdcPerBtc: 148, midUsdcPerBtc: 137, spreadPct: 0.16, venue: "deribit" as const, instrumentName: instrumentSymbol, tenorHours: 37, markIv: 0.255, pulledAtMs: 0 };
      }
      return null;
    },
    getBidForLeg: () => ({ bidUsdcPerBtc: 999, askUsdcPerBtc: 999, midUsdcPerBtc: 999, spreadPct: 0.1, venue: "deribit" as const, instrumentName: "WRONG", tenorHours: 61, markIv: 0.3, pulledAtMs: 0 })
  } as unknown as Parameters<typeof ShadowCloseExecutor>[0]["chainCache"];

  const exec = new ShadowCloseExecutor({ chainCache: mockCache, bidSlippageHaircut: 0.95, log: () => {} });
  const r = await exec.closeStrangle({
    pairId: "regression-test",
    putLeg: { ...baseReq.putLeg, symbol: "BTC-1JUN26-73000-P" },
    callLeg: { ...baseReq.callLeg, symbol: "BTC-1JUN26-75000-C" }
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Put: 177 × 0.95 = 168.15 USDC/BTC × 0.5 BTC = 84.075
  // Call: 126 × 0.95 = 119.70 USDC/BTC × 0.5 BTC = 59.85
  // Total: 143.925 USDC
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 177 * 0.95);
  assert.equal(r.callLeg.filledPxUsdcPerBtc, 126 * 0.95);
  assert.equal(r.putLeg.valuationMethod, "exact_symbol");
  assert.equal(r.callLeg.valuationMethod, "exact_symbol");
  assert.equal(r.putLeg.rawVenueBidUsdcPerBtc, 177);
  assert.equal(r.callLeg.rawVenueBidUsdcPerBtc, 126);
});

test("ShadowCloseExecutor: falls back to fuzzy when exact symbol not in cache", async () => {
  const mockCache = {
    getBidForSymbol: () => null, // exact not available
    getBidForLeg: () => ({ bidUsdcPerBtc: 300, askUsdcPerBtc: 450, midUsdcPerBtc: 375, spreadPct: 0.4, venue: "deribit" as const, instrumentName: "PROXY", tenorHours: 60, markIv: 0.3, pulledAtMs: 0 })
  } as unknown as Parameters<typeof ShadowCloseExecutor>[0]["chainCache"];
  const exec = new ShadowCloseExecutor({ chainCache: mockCache, bidSlippageHaircut: 0.95, log: () => {} });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "fuzzy_strike_tenor");
  assert.equal(r.callLeg.valuationMethod, "fuzzy_strike_tenor");
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 300 * 0.95);
});

test("ShadowCloseExecutor: BS-expected fallback when no chain at all", async () => {
  const mockCache = {
    getBidForSymbol: () => null,
    getBidForLeg: () => null
  } as unknown as Parameters<typeof ShadowCloseExecutor>[0]["chainCache"];
  const exec = new ShadowCloseExecutor({ chainCache: mockCache, log: () => {} });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected");
  assert.equal(r.putLeg.filledPxUsdcPerBtc, 1000); // expectedSellPxUsdcPerBtc
});

test("ShadowCloseExecutor: realistic real-bid haircut produces accurate PnL", async () => {
  // Real scenario from the bug: paid $80, BS says $712, real bid $50.
  // With our fix, salvage should reflect $50, NOT $712.
  const PUT_BID = 25; // USDC/BTC
  const CALL_BID = 25;
  const exec = new ShadowCloseExecutor({
    bidLookup: (leg: CloseLegRequest) => leg.optType === "put" ? PUT_BID : CALL_BID,
    bidSlippageHaircut: 0.95,
    log: () => {}
  });
  const r = await exec.closeStrangle({
    pairId: "p1",
    putLeg: { ...baseReq.putLeg, expectedSellPxUsdcPerBtc: 712, minAcceptablePxUsdcPerBtc: 0 },
    callLeg: { ...baseReq.callLeg, expectedSellPxUsdcPerBtc: 712, minAcceptablePxUsdcPerBtc: 0 }
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Realistic salvage: 25 × 0.95 = 23.75 per BTC × 0.5 BTC × 2 legs = $23.75
  // NOT the inflated $712 × 0.5 × 2 = $712
  const expectedTotal = (PUT_BID * 0.95 * 0.5) + (CALL_BID * 0.95 * 0.5);
  assert.equal(r.totalProceedsUsdc, expectedTotal);
  assert.ok(r.totalProceedsUsdc < 30, `salvage ${r.totalProceedsUsdc} should be small (real bid), not ~$700 (BS)`);
});
