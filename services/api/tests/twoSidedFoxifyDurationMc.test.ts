/**
 * Tests for foxifyDurationMc — per-tick auto-close MC behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runFoxifyDurationMc } from "../src/singleSide/twoSided/foxifyDurationMc";

const baseInputs = {
  cellId: "test_cell",
  spot: 73950,
  hedgeCostUsdc: 500,
  putStrike: 73000,
  callStrike: 75000,
  tenorDays: 2,
  triggerPctDown: 0.05,
  triggerPctUp: 0.05,
  regime: "calm" as const,
  sigmaAnnual: 0.35,
  contractsBtc: 1,
  autoClosePnlPct: 0.30,
  autoCloseAbsoluteUsdc: 250,
  salvageRealismMultiplier: 0.85,
  bidSlipHaircut: 0.95,
  nPaths: 500, // smaller for fast tests
  seed: 42,
  barsOverride: null
};

test("foxifyDurationMc: returns the full result shape", async () => {
  const r = await runFoxifyDurationMc(baseInputs);
  assert.equal(typeof r.meanFoxifyNetUsdc, "number");
  assert.equal(typeof r.medianFoxifyNetUsdc, "number");
  assert.equal(typeof r.p5FoxifyNetUsdc, "number");
  assert.equal(typeof r.p95FoxifyNetUsdc, "number");
  assert.equal(typeof r.pctProfitable, "number");
  assert.equal(r.meanCostPaid, 500);
  assert.equal(r.nPaths, 500);
  assert.ok(typeof r.exitDistribution.foxify_auto_close === "number");
  assert.ok(typeof r.exitDistribution.trigger_peak === "number");
  assert.ok(typeof r.exitDistribution.expiry === "number");
  // Exit distribution sums to ~1
  const totalExits = r.exitDistribution.foxify_auto_close + r.exitDistribution.trigger_peak + r.exitDistribution.expiry;
  assert.ok(Math.abs(totalExits - 1) < 0.001, `exit distribution should sum to 1, got ${totalExits}`);
});

test("foxifyDurationMc: deterministic across runs (same seed)", async () => {
  const r1 = await runFoxifyDurationMc(baseInputs);
  const r2 = await runFoxifyDurationMc(baseInputs);
  assert.equal(r1.meanFoxifyNetUsdc, r2.meanFoxifyNetUsdc);
  assert.equal(r1.pctProfitable, r2.pctProfitable);
});

test("foxifyDurationMc: lower autoClosePnlPct → more auto-closes", async () => {
  const lowThreshold = await runFoxifyDurationMc({ ...baseInputs, autoClosePnlPct: 0.10, autoCloseAbsoluteUsdc: 1e9 });
  const highThreshold = await runFoxifyDurationMc({ ...baseInputs, autoClosePnlPct: 1.00, autoCloseAbsoluteUsdc: 1e9 });
  assert.ok(
    lowThreshold.exitDistribution.foxify_auto_close >= highThreshold.exitDistribution.foxify_auto_close,
    `low threshold (${lowThreshold.exitDistribution.foxify_auto_close}) should produce >= auto-closes than high (${highThreshold.exitDistribution.foxify_auto_close})`
  );
});

test("foxifyDurationMc: meanCapitalRatio = meanNet / meanCost", async () => {
  const r = await runFoxifyDurationMc(baseInputs);
  const expectedRatio = r.meanFoxifyNetUsdc / r.meanCostPaid;
  assert.ok(Math.abs(r.meanCapitalRatio - expectedRatio) < 1e-9);
});

test("foxifyDurationMc: realism multiplier 0.5 produces lower mean net than 1.0", async () => {
  const lowRealism = await runFoxifyDurationMc({ ...baseInputs, salvageRealismMultiplier: 0.5 });
  const highRealism = await runFoxifyDurationMc({ ...baseInputs, salvageRealismMultiplier: 1.0 });
  assert.ok(
    lowRealism.meanFoxifyNetUsdc < highRealism.meanFoxifyNetUsdc,
    `low realism net (${lowRealism.meanFoxifyNetUsdc}) should be less than high (${highRealism.meanFoxifyNetUsdc})`
  );
});

test("foxifyDurationMc: high autoCloseAbsoluteUsdc effectively disables absolute trigger", async () => {
  const r = await runFoxifyDurationMc({
    ...baseInputs,
    autoClosePnlPct: 100,  // high pct (won't trigger)
    autoCloseAbsoluteUsdc: 1e9 // huge (won't trigger)
  });
  // With both auto-close thresholds disabled, every path exits via trigger or expiry
  assert.equal(r.exitDistribution.foxify_auto_close, 0);
});

test("foxifyDurationMc: very low autoCloseAbsoluteUsdc causes most paths to auto-close early", async () => {
  const r = await runFoxifyDurationMc({
    ...baseInputs,
    autoClosePnlPct: 100,        // high pct
    autoCloseAbsoluteUsdc: -1e9  // tiny absolute → fires when net >= -infinity (always true)
  });
  // With absolute trigger always firing on first tick, ~100% auto-close
  assert.ok(r.exitDistribution.foxify_auto_close >= 0.95, `expected >= 95% auto-close, got ${r.exitDistribution.foxify_auto_close}`);
});

test("foxifyDurationMc: meanTicksToAutoClose populated only when auto-closes occur", async () => {
  const withAutoCloses = await runFoxifyDurationMc({ ...baseInputs, autoClosePnlPct: 0.10 });
  const withoutAutoCloses = await runFoxifyDurationMc({
    ...baseInputs,
    autoClosePnlPct: 100,
    autoCloseAbsoluteUsdc: 1e9
  });
  if (withAutoCloses.exitDistribution.foxify_auto_close > 0) {
    assert.ok(withAutoCloses.meanTicksToAutoClose !== null);
    assert.ok((withAutoCloses.meanTicksToAutoClose as number) > 0);
  }
  assert.equal(withoutAutoCloses.meanTicksToAutoClose, null);
});

test("foxifyDurationMc: percentile ordering is correct (p5 <= median <= p95)", async () => {
  const r = await runFoxifyDurationMc(baseInputs);
  assert.ok(r.p5FoxifyNetUsdc <= r.medianFoxifyNetUsdc);
  assert.ok(r.medianFoxifyNetUsdc <= r.p95FoxifyNetUsdc);
});
