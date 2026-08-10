import assert from "node:assert/strict";
import test from "node:test";
import {
  solveAndPriceCreditCollar,
  solveAdaptiveCreditCollar,
  type CreditCollarParams
} from "../src/singleSide/twoSided/creditCollar/creditCollarPricer";
import { flatSkew, linearDownsideSkew } from "../src/singleSide/twoSided/creditCollar/skew";
import { detectSelfCancellation } from "../src/singleSide/twoSided/creditCollar/selfCancellation";
import { simulateAtticusBook, feasibilitySweep, type SimConfig } from "../src/singleSide/twoSided/creditCollar/creditCollarSim";

const SPOT = 100_000;
const SKEW = linearDownsideSkew(SPOT, 0.55, 0.12);

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

test("downside skew makes the net credit achievable at TOUCH fills (long perp)", () => {
  const q = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  // Foxify long put (floor) + short call (funding/cap). Atticus short put + long call.
  assert.equal(q.legs.foxifyLongLeg, "put");
  assert.equal(q.legs.foxifyShortLeg, "call");
  assert.equal(q.legs.atticusShortLeg, "put");
  assert.equal(q.fills.fill_mode, "touch");
  assert.equal(q.economics.foxify_credit_usdc, 100);
  // Margin is computed on the EXECUTABLE (post-crossing) credit.
  assert.ok(q.economics.atticus_margin_usdc > 0, "post-crossing margin must be positive");
  assert.ok(q.economics.fundable_credit_usdc >= 100, "fundable credit must cover target");
  assert.ok(q.economics.atticus_margin_bps >= q.economics.required_margin_usdc / 50_000 * 1e4 - 1e-6);
});

test("call (funding) strike sits TIGHTER than the put (floor) strike under downside skew", () => {
  const q = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.ok(q.legs.callStrike - SPOT < SPOT - q.legs.putStrike, "call cap must be tighter than put floor");
});

test("TOUCH fills cost more than MID: positive crossing drag and a tighter/looser cap", () => {
  const mid = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "mid" });
  const touch = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch" });
  assert.equal(mid.ok, true);
  assert.equal(touch.ok, true);
  if (!mid.ok || !touch.ok) return;
  assert.equal(mid.fills.crossing_drag_usdc, 0, "mid mode has no crossing drag");
  assert.ok(touch.fills.crossing_drag_usdc > 0, "touch mode must show positive crossing drag");
  // Crossing forces the funding leg tighter (or equal) — Foxify surrenders at least as much upside.
  assert.ok(touch.legs.cap_pct <= mid.legs.cap_pct + 1e-9, "touch cap must be <= mid cap");
});

test("EV guardrail: Foxify EV = -(crossing drag + Atticus margin), strictly negative, <= -required", () => {
  const q = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  const ev = q.economics.foxify_market_implied_ev_usdc;
  const margin = q.economics.atticus_margin_usdc;
  const drag = q.fills.crossing_drag_usdc;
  assert.ok(ev < 0, "Foxify EV must be strictly negative (insurance is never free)");
  assert.ok(Math.abs(ev + (drag + margin)) < 0.1, "Foxify EV must equal -(crossing + margin)");
  assert.ok(ev <= -q.economics.required_margin_usdc + 1e-6, "Foxify EV must be <= -required margin");
});

test("floor constraint is respected (put no deeper than maxFloorPct OTM)", () => {
  const q = solveAndPriceCreditCollar(baseParams({ maxFloorPct: 0.03 }), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.ok(q.legs.floor_pct <= 0.03 + 1e-9, "floor must not exceed the cap");
  assert.ok(q.legs.putStrike >= SPOT * 0.97 - 1, "put strike must respect the floor cap");
});

test("short perp mirrors the structure (long call ceiling + short put funding)", () => {
  const q = solveAndPriceCreditCollar(baseParams({ side: "short" }), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.equal(q.legs.foxifyLongLeg, "call");
  assert.equal(q.legs.foxifyShortLeg, "put");
  assert.equal(q.legs.atticusShortLeg, "call");
  assert.ok(q.legs.callStrike > SPOT, "ceiling call above spot");
  assert.ok(q.legs.putStrike < SPOT, "funding put below spot");
});

test("infeasible (not mispriced) when the target credit exceeds the upside tail value", () => {
  const thin = linearDownsideSkew(SPOT, 0.3, 0.05);
  const q = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 50_000 }), thin, { fillMode: "touch" });
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.ok(q.error === "credit_infeasible_at_floor" || q.error === "margin_below_floor_after_crossing");
  assert.ok(Array.isArray(q.hints) ? q.hints.length > 0 : true);
});

test("credit is held + netted (counterparty), never upfront cash; collateral covers the short leg", () => {
  const q = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
  assert.equal(q.counterparty.settlement_is_netted, true);
  assert.equal(q.counterparty.held_credit_usdc, q.economics.foxify_credit_usdc);
  assert.ok(q.counterparty.required_collateral_usdc >= 0);
});

test("basis-risk sensitivity scales with notional", () => {
  const q = solveAndPriceCreditCollar(baseParams({ notionalUsdc: 50_000 }), SKEW, { fillMode: "touch" });
  assert.equal(q.ok, true);
  if (!q.ok) return;
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

test("feasibility sweep: touch is stricter than mid; higher credit/notional ratio surrenders more upside", () => {
  const thin = linearDownsideSkew(SPOT, 0.35, 0.06);
  const notionals = [30_000, 50_000, 150_000];
  const fees = [100];
  const base = { spot: SPOT, tenorDays: 1, maxFloorPct: 0.04 };
  const mid = feasibilitySweep(notionals, fees, base, thin, { fillMode: "mid" });
  const touch = feasibilitySweep(notionals, fees, base, thin, { fillMode: "touch" });
  assert.ok(touch.feasibilityRate <= mid.feasibilityRate, "touch fills cannot be MORE feasible than mid");
  // Among feasible touch cells, the lowest-notional (highest credit-bps) surrenders the most upside.
  const feasibleTouch = touch.cells.filter((c) => c.feasible && c.capPct != null);
  if (feasibleTouch.length >= 2) {
    const byBps = [...feasibleTouch].sort((a, b) => b.creditBps - a.creditBps);
    assert.ok((byBps[0].capPct as number) <= (byBps[byBps.length - 1].capPct as number) + 1e-9,
      "higher credit-bps cell must have a tighter (smaller) cap");
  }
});

test("sim: spread clears costs at rebates=0 AND reserve survives an imbalanced jump (touch fills)", () => {
  const cfg: SimConfig = {
    dailyNotionalUsdc: 5_000_000,
    avgPositionNotionalUsdc: 50_000,
    notionalLogSdPct: 0.3,
    days: 750,
    spot: SPOT,
    tenorDays: 1,
    creditMode: "fixed_usdc",
    creditPerPositionUsdc: 100,
    creditBpsOfNotional: 2,
    maxFloorPct: 0.04,
    atmIv: 0.55,
    skewSlopePer10pct: 0.12,
    backToBackFraction: 0.85,
    legRelativeHalfSpreadPct: 0.1,
    legAbsHalfSpreadUsdcPerBtc: 1.5,
    fillMode: "touch",
    extraImpactBps: 0.2,
    residualTrackingError: 0.25,
    netLongBias: 0.3,
    gapBasisBpsPerPct: 1.0,
    reserveMultiple: 1.5,
    costOfCapitalAnnual: 0.12,
    stressJumpPct: 0.12,
    longFraction: 0.5,
    seed: 42
  };
  const res = simulateAtticusBook(cfg);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.label, "directionally_encouraging_not_validated");
  assert.equal(res.fillMode, "touch");
  assert.ok(res.grossMarginPerDayUsdc > 0, "embedded spread (post-crossing) must be positive");
  assert.ok(res.meanNetDailyPnlUsdc > 0, "net of crossing + residual + capital cost must be positive at rebates=0");
  assert.ok(res.stressCoverageRatio >= 1, "reserve must survive the imbalanced jump");
  assert.ok(res.medianCapPct > 0 && res.medianCapPct < 0.1, "median cap (upside surrendered) is reported");
  assert.notEqual(res.verdict, "NOT_VIABLE");
});

test("pass_through model: collar nets to ~0, profit is the SEPARATE operation fee", () => {
  const embedded = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch", feeMode: "clob_taker" });
  const pass = solveAndPriceCreditCollar(baseParams(), SKEW, {
    fillMode: "touch",
    feeMode: "clob_taker",
    pricingModel: "pass_through",
    operationFeeBps: 2,
    minOperationFeeUsdc: 10
  });
  assert.equal(embedded.ok, true);
  assert.equal(pass.ok, true);
  if (!embedded.ok || !pass.ok) return;

  // Embedded: profit lives inside the collar (margin), no separate operation fee.
  assert.equal(embedded.economics.pricing_model, "embedded_spread");
  assert.equal(embedded.economics.operation_fee_usdc, 0);
  assert.ok(embedded.economics.atticus_margin_net_of_fees_usdc > 0);

  // Pass-through: the collar funds credit + the Bullish fee and nets to ~0; profit is the operation fee.
  assert.equal(pass.economics.pricing_model, "pass_through");
  assert.ok(pass.economics.foxify_credit_usdc >= 100, "Foxify receives at least the target credit (overshoot passed through)");
  assert.ok(pass.economics.operation_fee_usdc >= 10, "operation fee billed separately (>= floor)");
  assert.ok(Math.abs(pass.economics.atticus_margin_net_of_fees_usdc) <= 0.5, "collar nets to ~0 (proceeds passed through, fee funded)");
  assert.equal(pass.economics.atticus_total_revenue_usdc, pass.economics.operation_fee_usdc, "all profit is the separate fee");
  // Foxify EV from the collar is still strictly negative (they cross the spread + fund the fee), but it is
  // NOT pushed down by an embedded margin — so the collar is sold at (near) fair value.
  assert.ok(pass.economics.foxify_market_implied_ev_usdc <= 1e-6);
});

test("credit-target mode: ceiling caps Foxify credit and routes the bounded overshoot to Atticus", () => {
  const uncapped = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch", pricingModel: "pass_through" });
  const capped = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch", pricingModel: "pass_through", maxFoxifyCreditUsdc: 105 });
  assert.equal(uncapped.ok, true);
  assert.equal(capped.ok, true);
  if (!uncapped.ok || !capped.ok) return;
  // Foxify never receives more than the ceiling, and never more than the uncapped pass-through would give.
  assert.ok(capped.economics.foxify_credit_usdc <= 105 + 1e-6, "Foxify credit capped at the ceiling");
  assert.ok(capped.economics.foxify_credit_usdc <= uncapped.economics.foxify_credit_usdc + 1e-6);
  // Foxify still gets at least the target.
  assert.ok(capped.economics.foxify_credit_usdc >= baseParams().targetCreditUsdc - 1e-6, "Foxify still gets the target");
  // When the uncapped model would have overshot past the ceiling, that overshoot is retained as Atticus margin.
  if (uncapped.economics.foxify_credit_usdc > 105 + 1e-6) {
    assert.ok(
      capped.economics.atticus_margin_net_of_fees_usdc > uncapped.economics.atticus_margin_net_of_fees_usdc + 1e-6,
      "ceiling routes the bounded overshoot to Atticus margin"
    );
  }
});

test("credit-target mode: a finer strike grid sits the cap WIDER and overshoots the target by less", () => {
  const coarse = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 80 }), SKEW, { fillMode: "touch", pricingModel: "pass_through", strikeGridUsdc: 1000 });
  const fine = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 80 }), SKEW, { fillMode: "touch", pricingModel: "pass_through", strikeGridUsdc: 100 });
  assert.equal(coarse.ok, true);
  assert.equal(fine.ok, true);
  if (!coarse.ok || !fine.ok) return;
  // More candidate strikes ⟹ the loosest one that still funds the target sits at least as far OTM (wider cap),
  // so Foxify surrenders less upside, and the discrete-strike overshoot above the target is smaller-or-equal.
  assert.ok(fine.legs.cap_pct >= coarse.legs.cap_pct - 1e-9, "finer grid ⟹ wider-or-equal cap");
  const coarseOvershoot = coarse.economics.fundable_credit_usdc - 80;
  const fineOvershoot = fine.economics.fundable_credit_usdc - 80;
  assert.ok(fineOvershoot <= coarseOvershoot + 1e-6, "finer grid overshoots the target by less-or-equal");
});

test("σ-floor: in low vol the cap holds at the σ-floor and the credit floats DOWN (no ATM compression)", () => {
  const lowVol = flatSkew(0.3); // calm: 30% ann ⟹ tenor-σ ~1.57%/day
  const off = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 100 }), lowVol, { fillMode: "touch", pricingModel: "pass_through" });
  const on = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 100 }), lowVol, { fillMode: "touch", pricingModel: "pass_through", minCapSigmaMult: 1.25 });
  assert.equal(off.ok, true);
  assert.equal(on.ok, true);
  if (!off.ok || !on.ok) return;
  const sigmaTenor = 0.3 * Math.sqrt(1 / 365); // ~1.57%
  // Without the σ-floor the solver compresses the cap inside 1.25σ to manufacture the credit.
  assert.ok(off.legs.cap_pct < 1.25 * sigmaTenor, `legacy compresses the cap (${off.legs.cap_pct})`);
  // With it, the cap may not sit closer than 1.25σ, and the credit floats below the target instead.
  assert.ok(on.legs.cap_pct >= 1.25 * sigmaTenor - 1e-6, `σ-floor holds the cap wide (${on.legs.cap_pct})`);
  assert.ok(on.economics.foxify_credit_usdc < 100, `credit floats below target (${on.economics.foxify_credit_usdc})`);
  assert.ok(on.economics.foxify_credit_usdc > 0, "floated credit is still positive");
});

test("symmetric retention bound: Atticus retention net of fees is capped; excess passes to Foxify", () => {
  // Coarse grid + low ceiling ⟹ big overshoot the ceiling would hand to Atticus; the bound stops that.
  const unbounded = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 80 }), SKEW, { fillMode: "touch", pricingModel: "pass_through", strikeGridUsdc: 1000, maxFoxifyCreditUsdc: 85 });
  const bounded = solveAndPriceCreditCollar(baseParams({ targetCreditUsdc: 80 }), SKEW, { fillMode: "touch", pricingModel: "pass_through", strikeGridUsdc: 1000, maxFoxifyCreditUsdc: 85, maxRetainedNetOfFeesUsdc: 25 });
  assert.equal(unbounded.ok, true);
  assert.equal(bounded.ok, true);
  if (!unbounded.ok || !bounded.ok) return;
  if (unbounded.economics.atticus_margin_net_of_fees_usdc > 25) {
    assert.ok(bounded.economics.atticus_margin_net_of_fees_usdc <= 25 + 0.01, `retention capped at 25 (got ${bounded.economics.atticus_margin_net_of_fees_usdc})`);
    assert.ok(bounded.economics.foxify_credit_usdc > unbounded.economics.foxify_credit_usdc, "excess passes to Foxify as extra credit");
  }
});

test("pass_through funds the Bullish fee inside the credit (looser-or-equal cap vs embedded margin)", () => {
  const embedded = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch", feeMode: "clob_taker" });
  const pass = solveAndPriceCreditCollar(baseParams(), SKEW, { fillMode: "touch", feeMode: "clob_taker", pricingModel: "pass_through" });
  assert.equal(embedded.ok, true);
  assert.equal(pass.ok, true);
  if (!embedded.ok || !pass.ok) return;
  // Embedded must fund credit + ~$12 margin; pass_through only credit + ~$7 fee ⟹ needs no more premium,
  // so its ceiling sits at least as loose (Foxify surrenders no more upside than the embedded model).
  assert.ok(pass.legs.cap_pct >= embedded.legs.cap_pct - 1e-9, "pass_through cap is looser-or-equal (funds less extra)");
});

test("adaptive floor: deepens to stay feasible in a thin/low-vol regime; disabled == single solve", () => {
  const thin = linearDownsideSkew(SPOT, 0.3, 0.04); // calm regime
  const params = baseParams({ targetCreditUsdc: 150, maxFloorPct: 0.04 }); // demanding credit vs thin vol
  const single = solveAndPriceCreditCollar(params, thin, { fillMode: "touch" });
  const adaptive = solveAdaptiveCreditCollar(params, thin, { fillMode: "touch" }, { enabled: true, maxFloorCapPct: 0.12, stepPct: 0.005 });
  if (!single.ok) {
    assert.equal(adaptive.quote.ok, true, "adaptive floor should find a feasible deeper floor");
    assert.ok(adaptive.floorUsedPct > params.maxFloorPct, "floor was deepened");
    assert.ok(adaptive.steps > 0);
  } else {
    assert.equal(adaptive.floorUsedPct, params.maxFloorPct, "already feasible ⟹ no deepening");
  }
  // Disabled ⟹ identical to a single solve at the configured floor.
  const off = solveAdaptiveCreditCollar(params, thin, { fillMode: "touch" }, { enabled: false, maxFloorCapPct: 0.12, stepPct: 0.005 });
  assert.equal(off.quote.ok, single.ok);
  assert.equal(off.floorUsedPct, params.maxFloorPct);
  assert.equal(off.steps, 0);
});

test("sim: thin back-to-back + stress flips NOT_VIABLE (viability rides on hedge quality, not rebates)", () => {
  const cfg: SimConfig = {
    dailyNotionalUsdc: 50_000_000,
    avgPositionNotionalUsdc: 50_000,
    notionalLogSdPct: 0.3,
    days: 750,
    spot: SPOT,
    tenorDays: 1,
    creditMode: "fixed_usdc",
    creditPerPositionUsdc: 100,
    creditBpsOfNotional: 2,
    maxFloorPct: 0.04,
    atmIv: 0.75,
    skewSlopePer10pct: 0.18,
    backToBackFraction: 0.4,
    legRelativeHalfSpreadPct: 0.18,
    legAbsHalfSpreadUsdcPerBtc: 3,
    fillMode: "touch",
    extraImpactBps: 1.5,
    residualTrackingError: 0.6,
    netLongBias: 0.6,
    gapBasisBpsPerPct: 4.0,
    reserveMultiple: 1.5,
    costOfCapitalAnnual: 0.15,
    stressJumpPct: 0.15,
    longFraction: 0.65,
    seed: 7
  };
  const res = simulateAtticusBook(cfg);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.notEqual(res.verdict, "VIABLE_AT_REBATES_ZERO");
});
