import assert from "node:assert/strict";
import test from "node:test";
import {
  solveAndPriceCreditCollar,
  type CreditCollarParams
} from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { flatSkew, linearDownsideSkew } from "../src/singleSide/twoSided/creditCollar/skew";
import { detectSelfCancellation } from "../src/singleSide/twoSided/creditCollar/selfCancellation";
import { simulateAtticusBook, type SimConfig } from "../src/singleSide/twoSided/creditCollar/creditCollarSim";

const SPOT = 100_000;

const baseParams = (over: Partial<CreditCollarParams> = {}): CreditCollarParams => ({
  side: "long",
  spot: SPOT,
  notionalUsdc: 50_000,
  tenorDays: 1,
  targetCreditUsdc: 100,
  maxFloorPct: 0.04,
  referenceMode: "position",
  ...over
});

test("downside skew makes the net credit achievable (long perp)", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams(), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  // Foxify is long the put (floor), short the call (funding/cap). Atticus short put + long call.
  assert.equal(q.legs.foxifyLongLeg, "put");
  assert.equal(q.legs.foxifyShortLeg, "call");
  assert.equal(q.legs.atticusShortLeg, "put");
  // Net credit accrued to Foxify equals the target; Atticus keeps a positive margin on top.
  assert.equal(q.economics.foxify_credit_usdc, 100);
  assert.ok(q.economics.atticus_margin_usdc > 0, "atticus margin must be positive");
  assert.ok(q.economics.fair_credit_usdc >= 100, "fair credit must cover target");
});

test("call (funding) strike sits TIGHTER than the put (floor) strike under downside skew", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams(), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  const callDistance = q.legs.callStrike - SPOT;
  const putDistance = SPOT - q.legs.putStrike;
  assert.ok(callDistance < putDistance, `call cap (${callDistance}) must be tighter than put floor (${putDistance})`);
});

test("EV guardrail: Foxify market-implied EV equals minus Atticus margin and is negative", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams(), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  const ev = q.economics.foxify_market_implied_ev_usdc;
  const margin = q.economics.atticus_margin_usdc;
  assert.ok(ev < 0, "Foxify EV must be strictly negative (insurance is never free)");
  assert.ok(Math.abs(ev + margin) < 0.02, "Foxify EV must equal minus Atticus margin");
  assert.ok(ev <= -q.economics.required_margin_usdc + 1e-6, "Foxify EV must be <= -required margin");
});

test("floor constraint is respected (put no deeper than maxFloorPct OTM)", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams({ maxFloorPct: 0.03 }), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.ok(q.legs.floor_pct <= 0.03 + 1e-9, "floor must not exceed the cap");
  assert.ok(q.legs.putStrike >= SPOT * 0.97 - 1, "put strike must respect the floor cap");
});

test("short perp mirrors the structure (long call ceiling + short put funding)", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams({ side: "short" }), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.equal(q.legs.foxifyLongLeg, "call");
  assert.equal(q.legs.foxifyShortLeg, "put");
  assert.equal(q.legs.atticusShortLeg, "call");
  assert.ok(q.legs.callStrike > SPOT, "ceiling call above spot");
  assert.ok(q.legs.putStrike < SPOT, "funding put below spot");
});

test("flat (no skew) symmetric strikes do NOT manufacture an easy credit", () => {
  // With flat vol and a tight target, the funding leg has to be pushed very close to spot to
  // fund the credit; we assert the solver still respects EV-neutrality (margin>0) whenever it
  // returns ok, and returns a structured infeasibility otherwise (never a positive-EV quote).
  const skew = flatSkew(0.4);
  const q = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 400 }), skew, { fundingSearchMaxPct: 0.05 });
  if (q.ok) {
    assert.ok(q.economics.atticus_margin_usdc > 0);
    assert.ok(q.economics.foxify_market_implied_ev_usdc < 0);
  } else {
    assert.equal(q.error, "credit_infeasible_at_floor");
    assert.ok(Array.isArray(q.hints) && q.hints.length > 0);
  }
});

test("infeasible when the target credit exceeds the upside tail value at the floor", () => {
  const skew = linearDownsideSkew(SPOT, 0.3, 0.05);
  // Absurd credit relative to a 1-day tail on a small notional → must be rejected, not mispriced.
  const q = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 50_000 }), skew, {});
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "credit_infeasible_at_floor");
});

test("credit is held + netted (counterparty), never upfront cash; collateral covers the short leg", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams(), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.equal(q.counterparty.settlement_is_netted, true);
  assert.equal(q.counterparty.held_credit_usdc, q.economics.foxify_credit_usdc);
  assert.ok(q.counterparty.required_collateral_usdc >= 0);
});

test("basis-risk sensitivity scales with notional", () => {
  const skew = linearDownsideSkew(SPOT, 0.55, 0.12);
  const q = solveAndPriceCreditCollar(baseParams({ notionalUsdc: 50_000 }), skew, {});
  assert.equal(q.ok, true);
  if (!q.ok) return;
  // 1% of $50k = $500 mismatch per 1% reference-vs-venue divergence.
  assert.equal(q.basis_risk.usdc_per_1pct_basis, 500);
});

test("self-cancellation detector flags simultaneously-hedged books", () => {
  const directional = detectSelfCancellation([
    { asset: "BTC", side: "long", notionalUsdc: 50_000 },
    { asset: "BTC", side: "long", notionalUsdc: 25_000 }
  ]);
  assert.equal(directional.anySelfCancels, false);
  assert.equal(directional.recommendedReferenceMode, "position");

  const hedged = detectSelfCancellation([
    { asset: "BTC", side: "long", notionalUsdc: 50_000 },
    { asset: "BTC", side: "short", notionalUsdc: 48_000 }
  ]);
  assert.equal(hedged.anySelfCancels, true);
  assert.equal(hedged.recommendedReferenceMode, "net_book_delta");
});

test("sim: embedded spread clears costs and reserve covers drawdown at rebates=0", () => {
  const cfg: SimConfig = {
    dailyNotionalUsdc: 5_000_000,
    avgPositionNotionalUsdc: 50_000,
    days: 500,
    spot: SPOT,
    tenorDays: 1,
    creditPerPositionUsdc: 100,
    maxFloorPct: 0.04,
    atmIv: 0.55,
    skewSlopePer10pct: 0.12,
    backToBackFraction: 0.85,
    hedgeSlippageBps: 0.5,
    residualTrackingError: 0.25,
    bookImbalanceFraction: 0.3,
    gapBasisBpsPerPct: 1.0,
    reserveMultiple: 3,
    costOfCapitalAnnual: 0.12,
    longFraction: 0.5,
    seed: 42
  };
  const res = simulateAtticusBook(cfg);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.grossMarginPerDayUsdc > 0, "gross embedded spread must be positive");
  assert.ok(res.meanNetDailyPnlUsdc > 0, "net of all costs at rebates=0 must be positive");
  assert.ok(res.reserveCoverageRatio >= 1, "reserve must cover max drawdown");
  assert.notEqual(res.verdict, "NOT_VIABLE");
});
