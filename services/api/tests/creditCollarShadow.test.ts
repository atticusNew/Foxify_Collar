import assert from "node:assert/strict";
import test from "node:test";
import { runShadowSession, type ShadowSessionDeps } from "../src/singleSide/twoSided/creditCollar/shadowRunner";
import { linearDownsideSkew } from "../src/singleSide/twoSided/creditCollar/skew";
import { aggregateOracle, signSnapshot, generateOracleKeyPair, type PriceSample, type OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";
import type { ScaffoldConfig } from "../src/singleSide/twoSided/creditCollar/activationScaffold";

const SPOT = 100_000;
const NOW = 2_000_000;
const skew = linearDownsideSkew(SPOT, 0.55, 0.12);

const buildOracle = (settlePrice: number) => {
  const samples: PriceSample[] = [
    { source: "deribit", priceUsd: SPOT, tsMs: NOW - 200 },
    { source: "okx", priceUsd: SPOT + 20, tsMs: NOW - 200 },
    { source: "coinbase", priceUsd: SPOT - 15, tsMs: NOW - 200 }
  ];
  const snapshot = aggregateOracle(samples, NOW);
  const keys = generateOracleKeyPair();
  const signatureHex = signSnapshot(snapshot, keys.privateKeyPem);
  const ticks: OracleTick[] = [
    { tsMs: NOW - 1_800_000, priceUsd: settlePrice },
    { tsMs: NOW, priceUsd: settlePrice }
  ];
  return { snapshot, signatureHex, publicKeyPem: keys.publicKeyPem, settlementTwapTicks: ticks, windowStartMs: NOW - 1_800_000, windowEndMs: NOW, keys };
};

const scaffoldConfig = (over: Partial<ScaffoldConfig> = {}): ScaffoldConfig => ({
  tiers: [{ tier: 0, maxDailyNotionalUsdc: 5_000_000, live: false }],
  policy: { targetNetBandPct: 0.1, allowDirectionalBias: false, directionalTiltSigned: 0 },
  breaker: { warnBandPct: 0.1, haltBandPct: 0.15, resumeBandPct: 0.08, minGrossNotionalUsd: 500_000, maxAbsNetNotionalUsd: 200_000 },
  serviceFeeBps: 2,
  minServiceFeeUsdc: 10,
  maxFloorPct: 0.04,
  tenorDays: 1,
  feeUsdc: 75,
  liveEnabled: false,
  spreadConfig: { fillMode: "touch", relativeHalfSpreadPct: 0.08, absHalfSpreadUsdcPerBtc: 1.5 },
  ...over
});

const deps = (over: Partial<ShadowSessionDeps> = {}): ShadowSessionDeps => ({
  scaffoldConfig: scaffoldConfig(),
  skew,
  spot: SPOT,
  oracle: buildOracle(SPOT),
  nPositions: 20,
  positionNotionalUsdc: 50_000,
  instrument: "BTC-PERP",
  seed: 42,
  ...over
});

test("shadow: full lifecycle completes (open → settle → reconcile), paper, oracle-verified", () => {
  const s = runShadowSession(deps());
  assert.equal(s.label, "tier0_shadow_paper_settled");
  assert.equal(s.mode, "shadow");
  assert.ok(s.opened > 0, "positions opened");
  assert.equal(s.settlements, s.opened, "every opened position settled");
  assert.equal(s.allSettledOracleVerified, true, "all settlements ECDSA-verified");
  assert.equal(s.allReconciled, true, "all venue-vs-ledger reconciliations matched");
  assert.equal(s.lifecycleComplete, true);
});

test("shadow: instruction stream keeps the book flat (net stays ~a few clips; material-book exposure small)", () => {
  const s = runShadowSession(deps());
  assert.ok(s.peakNetNotionalUsdc <= 4 * 50_000, `net should stay within a few clips, got $${s.peakNetNotionalUsdc}`);
  assert.ok(s.peakNetExposureRatio <= 0.3, `material-book exposure ${s.peakNetExposureRatio} should be small`);
});

test("shadow: credit accrued (not upfront) and service fee booked; EV guardrail held throughout", () => {
  const s = runShadowSession(deps());
  assert.ok(s.foxifyCreditAccruedUsdc > 0, "credit accrued to held balance");
  assert.ok(s.serviceFeeAccruedUsdc > 0, "Atticus service fee booked");
  // pass_through model: Foxify receives AT LEAST the $75 target per position; any discrete-strike
  // overshoot is passed through to Foxify (the collar nets to ~0 for Atticus, who earns the separate
  // operation fee). So credit is ≥ 75×opened, and bounded by a sane per-position ceiling.
  assert.ok(s.foxifyCreditAccruedUsdc >= 75 * s.opened - 1, `credit must cover the target, got ${s.foxifyCreditAccruedUsdc} for ${s.opened}`);
  assert.ok(s.foxifyCreditAccruedUsdc <= 250 * s.opened, `per-position credit should stay bounded, got ${s.foxifyCreditAccruedUsdc / s.opened}`);
});

test("shadow: steered flat book settles ~delta-neutral on a big directional move (collars offset); credit always netted", () => {
  const down = runShadowSession(deps({ oracle: buildOracle(SPOT * 0.9) })); // −10%
  const up = runShadowSession(deps({ oracle: buildOracle(SPOT * 1.1) })); // +10%
  for (const s of [down, up]) {
    const grossNotional = s.opened * 50_000;
    // Delta-flat: a big directional move nets to a SMALL fraction of notional (longs offset shorts),
    // unlike an all-one-side book which would pay ~the full floor move.
    assert.ok(Math.abs(s.totalPayoutToFoxifyUsdc) < 0.02 * grossNotional, `flat-book payout ${s.totalPayoutToFoxifyUsdc} should be small vs gross ${grossNotional}`);
    // Foxify's net = accrued credit + (small) settlement payout — credit is always netted in.
    assert.ok(Math.abs(s.totalNetToFoxifyUsdc - (s.foxifyCreditAccruedUsdc + s.totalPayoutToFoxifyUsdc)) < 1);
  }
});

test("shadow: a TAMPERED oracle snapshot fails settlement (fail-closed)", () => {
  const o = buildOracle(SPOT);
  const tampered = { ...o, snapshot: { ...o.snapshot, priceUsd: 50_000 } }; // signature no longer matches
  const s = runShadowSession(deps({ oracle: tampered }));
  assert.equal(s.allSettledOracleVerified, false, "tampered snapshot must fail ECDSA verification");
  assert.equal(s.lifecycleComplete, false);
});

test("shadow: live tiers stay OFF — everything is shadow mode", () => {
  // Even with a live-marked tier, liveEnabled=false keeps it shadow.
  const s = runShadowSession(deps({ scaffoldConfig: scaffoldConfig({ tiers: [{ tier: 0, maxDailyNotionalUsdc: 5_000_000, live: true }], liveEnabled: false }) }));
  assert.equal(s.mode, "shadow");
  assert.ok(s.lifecycleComplete);
});
