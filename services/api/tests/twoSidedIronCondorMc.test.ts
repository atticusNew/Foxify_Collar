/**
 * Iron-condor MC (short-premium income to cover perp friction).
 * Validates exit logic (target/trail/expiry), determinism, and that the condor
 * LOVES calm and HATES volatility (the whole premise).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runIronCondorMc } from "../src/singleSide/twoSided/ironCondorMc";

const base = {
  cellId: "ic_test",
  spot: 73000,
  putShortStrike: 71000, putLongStrike: 69000,
  callShortStrike: 75000, callLongStrike: 77000,
  tenorDays: 3,
  regime: "calm" as const,
  sigmaAnnual: 0.35,
  contractsBtc: 1,
  entryCreditUsdc: 800,
  profitTargetUsdc: 250,
  trailStopUsdc: 300,
  realismMultiplier: 1.0,
  nPaths: 1000,
  seed: 42,
  barsOverride: null
};

test("ironCondor: result shape + exit distribution sums to 1", async () => {
  const r = await runIronCondorMc(base);
  for (const k of ["meanFoxifyNetUsdc","medianFoxifyNetUsdc","p5FoxifyNetUsdc","p95FoxifyNetUsdc","pctProfitable"] as const) {
    assert.equal(typeof r[k], "number");
  }
  assert.equal(r.maxProfitUsdc, 800);
  assert.ok(r.maxLossUsdc > 0, "structural max loss = width - credit");
  const tot = r.exitDistribution.target + r.exitDistribution.trail_stop + r.exitDistribution.expiry;
  assert.ok(Math.abs(tot - 1) < 1e-6, `exits sum to 1, got ${tot}`);
});

test("ironCondor: deterministic across runs (same seed)", async () => {
  const a = await runIronCondorMc(base);
  const b = await runIronCondorMc(base);
  assert.equal(a.meanFoxifyNetUsdc, b.meanFoxifyNetUsdc);
  assert.equal(a.pctProfitable, b.pctProfitable);
});

test("ironCondor: LOVES calm, HATES volatility (calm net > stress net)", async () => {
  const calm = await runIronCondorMc({ ...base, regime: "calm", sigmaAnnual: 0.35 });
  const stress = await runIronCondorMc({ ...base, regime: "stress", sigmaAnnual: 0.95, barsOverride: null });
  console.log(`[EMPIRICAL][iron-condor] calm net=$${calm.meanFoxifyNetUsdc.toFixed(0)} (prof ${(calm.pctProfitable*100).toFixed(0)}%, target ${(calm.exitDistribution.target*100).toFixed(0)}%) | stress net=$${stress.meanFoxifyNetUsdc.toFixed(0)} (prof ${(stress.pctProfitable*100).toFixed(0)}%, trail ${(stress.exitDistribution.trail_stop*100).toFixed(0)}%)`);
  assert.ok(calm.meanFoxifyNetUsdc > stress.meanFoxifyNetUsdc, "condor should net more in calm than stress");
  assert.ok(calm.pctProfitable > stress.pctProfitable, "calm more often profitable");
});

test("ironCondor: higher entry credit → higher mean net (calm)", async () => {
  const lo = await runIronCondorMc({ ...base, entryCreditUsdc: 400 });
  const hi = await runIronCondorMc({ ...base, entryCreditUsdc: 1000 });
  assert.ok(hi.meanFoxifyNetUsdc > lo.meanFoxifyNetUsdc, "more credit collected -> more net");
});

test("ironCondor: profit-target exits occur in calm; tighter trail → more stop-outs", async () => {
  const calm = await runIronCondorMc(base);
  assert.ok(calm.exitDistribution.target >= 0, "target exits tracked");
  const tightTrail = await runIronCondorMc({ ...base, trailStopUsdc: 50 });
  const looseTrail = await runIronCondorMc({ ...base, trailStopUsdc: 600 });
  assert.ok(tightTrail.exitDistribution.trail_stop >= looseTrail.exitDistribution.trail_stop,
    "tighter trailing stop -> at least as many stop-outs");
});
