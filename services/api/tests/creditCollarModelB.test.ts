import assert from "node:assert/strict";
import test from "node:test";
import {
  computeInventory,
  recommendNextSide,
  assertInventoryNeutralPolicy,
  assertIndependentFlow,
  type InventoryPolicy
} from "../src/singleSide/twoSided/creditCollar/inventoryBalancer";
import {
  aggregateOracle,
  computeSettlementTwap,
  confirmTrigger,
  signSnapshot,
  verifySnapshot,
  recomputeAndVerify,
  type PriceSample
} from "../src/singleSide/twoSided/creditCollar/referenceOracle";
import { simulateModelBVolume, type ModelBConfig } from "../src/singleSide/twoSided/creditCollar/modelBVolumeSim";

const neutral: InventoryPolicy = { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 };

// ── Inventory balancer ──────────────────────────────────────────────────────

test("inventory signal steers toward flat (recommends the offsetting side)", () => {
  const longHeavy = computeInventory(
    [
      { asset: "BTC", side: "long", notionalUsdc: 300_000 },
      { asset: "BTC", side: "short", notionalUsdc: 100_000 }
    ],
    0.1
  );
  assert.equal(longHeavy.netNotionalUsdc, 200_000);
  const rec = recommendNextSide(longHeavy, 50_000, neutral);
  assert.equal(rec.side, "short", "long-heavy book ⟹ steer short to flatten");
  assert.ok(rec.reducesImbalance);
});

test("no directional warehousing: directional policy is hard-rejected", () => {
  assert.throws(() => assertInventoryNeutralPolicy({ ...neutral, allowDirectionalBias: true }));
  assert.throws(() => assertInventoryNeutralPolicy({ ...neutral, directionalTiltSigned: 0.2 }));
  assert.doesNotThrow(() => assertInventoryNeutralPolicy(neutral));
});

test("balanced independent flow is NOT flagged as self-cancelling; manufactured pairs ARE", () => {
  // Many independent trades that balance in aggregate — must be allowed.
  const independent = assertIndependentFlow([
    { asset: "BTC", side: "long", notionalUsdc: 50_000, ref: "a" },
    { asset: "BTC", side: "short", notionalUsdc: 50_000, ref: "b" },
    { asset: "BTC", side: "long", notionalUsdc: 50_000, ref: "c" }
  ]);
  assert.equal(independent.independent, true);
  // A manufactured hedge pair (same instrument, opened to net another) is rejected.
  assert.throws(() =>
    assertIndependentFlow([
      { asset: "BTC", side: "long", notionalUsdc: 50_000, ref: "x" },
      { asset: "BTC", side: "short", notionalUsdc: 50_000, ref: "y", pairedWithRef: "x" }
    ])
  );
  // Duplicate refs (same trade counted twice) rejected.
  assert.throws(() =>
    assertIndependentFlow([
      { asset: "BTC", side: "long", notionalUsdc: 50_000, ref: "dup" },
      { asset: "BTC", side: "short", notionalUsdc: 50_000, ref: "dup" }
    ])
  );
});

// ── Reference oracle ────────────────────────────────────────────────────────

const mk = (source: string, priceUsd: number, ageMs: number, now: number): PriceSample => ({ source, priceUsd, tsMs: now - ageMs });

test("oracle: healthy median with >=3 fresh inlier sources", () => {
  const now = 1_000_000;
  const snap = aggregateOracle(
    [mk("bullish", 100_000, 500, now), mk("deribit", 100_050, 800, now), mk("coinbase", 99_980, 1000, now)],
    now
  );
  assert.equal(snap.status, "healthy");
  assert.equal(snap.safeForActivation, true);
  assert.equal(snap.priceUsd, 100_000);
});

test("oracle: stale sources dropped; fail-closed below min sources", () => {
  const now = 1_000_000;
  const snap = aggregateOracle(
    [mk("bullish", 100_000, 500, now), mk("deribit", 100_050, 9000, now), mk("coinbase", 99_980, 8000, now)],
    now
  );
  assert.ok(snap.droppedStale.includes("deribit") && snap.droppedStale.includes("coinbase"));
  assert.equal(snap.safeForActivation, false, "only 1 fresh source ⟹ fail-closed for activation");
  assert.notEqual(snap.status, "healthy");
});

test("oracle: MAD rejects a manipulated outlier", () => {
  const now = 1_000_000;
  const snap = aggregateOracle(
    [mk("bullish", 100_000, 200, now), mk("deribit", 100_020, 200, now), mk("coinbase", 99_990, 200, now), mk("evil", 130_000, 200, now)],
    now
  );
  assert.ok(snap.droppedOutliers.includes("evil"), "outlier must be rejected by MAD");
  assert.ok(Math.abs((snap.priceUsd as number) - 100_000) < 100, "median unaffected by the rejected outlier");
});

test("oracle: settlement TWAP is time-weighted over the window", () => {
  const r = computeSettlementTwap(
    [
      { tsMs: 0, priceUsd: 100_000 },
      { tsMs: 600_000, priceUsd: 101_000 },
      { tsMs: 1_200_000, priceUsd: 99_000 }
    ],
    0,
    1_800_000
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.twapUsd > 99_000 && r.twapUsd < 101_000);
});

test("oracle: tick-persistence suppresses a single wick", () => {
  const ticks = [
    { tsMs: 0, priceUsd: 100_000 },
    { tsMs: 1000, priceUsd: 95_000 }, // single wick below barrier
    { tsMs: 2000, priceUsd: 100_000 },
    { tsMs: 3000, priceUsd: 100_000 }
  ];
  const wick = confirmTrigger(ticks, 96_000, "down", 3);
  assert.equal(wick.triggered, false, "a single wick must not confirm a 3-tick-persistent trigger");
  const real = confirmTrigger(
    [
      { tsMs: 0, priceUsd: 95_000 },
      { tsMs: 1000, priceUsd: 94_000 },
      { tsMs: 2000, priceUsd: 93_500 }
    ],
    96_000,
    "down",
    3
  );
  assert.equal(real.triggered, true, "a sustained move must confirm");
});

test("oracle: snapshot is signable + independently recomputable/verifiable", () => {
  const now = 1_000_000;
  const snap = aggregateOracle(
    [mk("bullish", 100_000, 200, now), mk("deribit", 100_020, 200, now), mk("coinbase", 99_990, 200, now)],
    now
  );
  const secret = "shared-audit-secret";
  const sig = signSnapshot(snap, secret);
  assert.equal(verifySnapshot(snap, sig, secret), true);
  assert.equal(verifySnapshot(snap, sig, "wrong-secret"), false);
  const audit = recomputeAndVerify({ snapshot: snap, signatureHex: sig }, secret);
  assert.equal(audit.reproduced, true);
  assert.equal(audit.signatureValid, true);
  assert.equal(audit.recomputedPriceUsd, snap.priceUsd);
});

// ── Model B volume sim ──────────────────────────────────────────────────────

const modelB = (over: Partial<ModelBConfig> = {}): ModelBConfig => ({
  dailyNotionalUsdc: 50_000_000,
  avgPositionNotionalUsdc: 50_000,
  spot: 100_000,
  tenorDays: 1,
  maxFloorPct: 0.04,
  atmIv: 0.55,
  skewSlopePer10pct: 0.12,
  serviceFeeBps: 2.0,
  minServiceFeeUsdc: 10,
  creditBpsOfNotional: 20,
  steerComplianceProb: 0.95,
  flowStreakiness: 0.7,
  targetNetBandPct: 0.1,
  perpTopOfBookBps: 1.5,
  perpDepthUsdc: 5_000_000,
  perpImpactCoefBps: 1.0,
  dailyRehedgeTurnover: 2,
  reserveMultiple: 1.5,
  costOfCapitalAnnual: 0.12,
  stressJumpPct: 0.12,
  intradayTimingBufferPct: 0.25,
  maxDirectionalExposureBand: 0.15,
  days: 250,
  seed: 42,
  ...over
});

test("Model B: service fee clears costs at rebates=0 with steered-flat flow", () => {
  const r = simulateModelBVolume(modelB());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.label, "model_b_service_fee_volume_engine");
  assert.ok(r.realizedNettingEfficiency >= 0.8, "high steer compliance ⟹ high netting efficiency");
  assert.ok(r.netServiceRevenuePerDayUsdc > 0, "service fee must clear perp + reserve capital cost at rebates=0");
  assert.ok(r.evGuardrailHeld, "Foxify EV ≤ −service fee must hold");
  assert.ok(r.foxifyEvPerPositionUsdc < 0, "Foxify EV strictly negative");
  assert.notEqual(r.verdict, "NOT_VIABLE");
});

test("Model B: poor steering (low compliance) collapses netting efficiency and raises perp cost", () => {
  const good = simulateModelBVolume(modelB({ steerComplianceProb: 0.98, seed: 3 }));
  const poor = simulateModelBVolume(modelB({ steerComplianceProb: 0.55, seed: 3 }));
  assert.equal(good.ok, true);
  assert.equal(poor.ok, true);
  if (!good.ok || !poor.ok) return;
  assert.ok(poor.realizedNettingEfficiency < good.realizedNettingEfficiency,
    "streaky/uncontrolled flow nets worse");
  assert.ok(poor.perpHedgeCostPerDayUsdc > good.perpHedgeCostPerDayUsdc,
    "bigger residual ⟹ more perp hedge cost");
});

test("Model B: reserve sizes off the imbalanced peak residual ±12% both wings", () => {
  const r = simulateModelBVolume(modelB({ steerComplianceProb: 0.7, seed: 11 }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.reserveDownWingUsdc >= 0 && r.reserveUpWingUsdc >= 0);
  assert.ok(r.reserveUsdc >= Math.max(r.reserveDownWingUsdc, r.reserveUpWingUsdc),
    "reserve includes the timing-gap buffer on top of the binding wing");
  assert.ok(r.intradayTimingGapReserveUsdc > 0, "stop→TWAP timing gap reserve is carried");
});

test("Model B: steering FAILURE crosses into directional warehousing ⟹ not VIABLE (no warehousing rule)", () => {
  const steered = simulateModelBVolume(modelB({ steerComplianceProb: 0.95, flowStreakiness: 0.85, seed: 4 }));
  const failed = simulateModelBVolume(modelB({ steerComplianceProb: 0.0, flowStreakiness: 0.85, seed: 4 }));
  assert.equal(steered.ok, true);
  assert.equal(failed.ok, true);
  if (!steered.ok || !failed.ok) return;
  assert.ok(steered.peakDirectionalExposureRatio < steered.inputs.maxDirectionalExposureBand,
    "steered book stays flat (within the directional band)");
  assert.equal(steered.verdict, "VIABLE_AT_REBATES_ZERO");
  assert.ok(failed.peakDirectionalExposureRatio > failed.inputs.maxDirectionalExposureBand,
    "no steering ⟹ directional warehousing exposure");
  assert.notEqual(failed.verdict, "VIABLE_AT_REBATES_ZERO");
});

test("Model B: feasibility surfaces as a function of the (unknown) Foxify fee level", () => {
  const lowFee = simulateModelBVolume(modelB({ creditBpsOfNotional: 8, atmIv: 0.35, skewSlopePer10pct: 0.06 }));
  const highFee = simulateModelBVolume(modelB({ creditBpsOfNotional: 40, atmIv: 0.35, skewSlopePer10pct: 0.06 }));
  assert.equal(lowFee.ok, true);
  assert.equal(highFee.ok, true);
  if (!lowFee.ok || !highFee.ok) return;
  assert.ok(lowFee.feasibilityRate >= highFee.feasibilityRate,
    "a smaller credit/notional ratio is at least as fundable against skew");
});
