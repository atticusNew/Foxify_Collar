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
  assert.equal(r.putLeg.valuationMethod, "venue_bid");
  assert.equal(r.callLeg.valuationMethod, "venue_bid");
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
  assert.equal(r.putLeg.valuationMethod, "venue_bid");
  assert.equal(r.callLeg.valuationMethod, "bs_expected");
});

test("ShadowCloseExecutor: rejects fill below min_acceptable (venue_bid path)", async () => {
  const exec = new ShadowCloseExecutor({
    bidLookup: () => 50, // bid * 0.95 = 47.5, below min 100
    bidSlippageHaircut: 0.95,
    log: () => {}
  });
  const r = await exec.closeStrangle(baseReq);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "both_failed");
  assert.equal(r.putLegResult.ok, false);
  if (r.putLegResult.ok) return;
  assert.equal(r.putLegResult.reason, "min_px_violated");
  assert.match(r.putLegResult.detail, /venue_bid/);
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
  const exec2 = new ShadowCloseExecutor({
    chainCache: { getBidForLeg: () => ({ bidUsdcPerBtc: 200 }) } as unknown as Parameters<typeof ShadowCloseExecutor>[0]["chainCache"],
    log: () => {}
  });
  const r = await exec2.closeStrangle(reqMissing);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.putLeg.valuationMethod, "bs_expected", "missing strike → bs fallback");
  assert.equal(r.callLeg.valuationMethod, "bs_expected", "missing optType → bs fallback");
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
