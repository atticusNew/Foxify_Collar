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

// ──────────────────────────── Phase 4.5: gamma scalp mode ────────────────────────────

const gsBase = {
  ...baseInputs,
  putStrike: 73950, callStrike: 73950, // ATM straddle (max gamma)
  sigmaAnnual: 0.55,
  hedgeCostUsdc: 3400,
  autoClosePnlPct: 100, autoCloseAbsoluteUsdc: 1e9, // disable auto-close → hold to expiry
  gammaScalpWithPerpHedge: true as const,
  perpFrictionBps: 5,
  nPaths: 1500, seed: 11
};

test("gamma scalp: requires perpFrictionBps (no hardcoded default)", async () => {
  await assert.rejects(
    () => runFoxifyDurationMc({ ...gsBase, perpFrictionBps: undefined }),
    /perpFrictionBps/,
    "must throw when friction not supplied in gamma scalp mode"
  );
});

test("gamma scalp: populates gammaScalp diagnostics; legacy mode leaves it null", async () => {
  const gs = await runFoxifyDurationMc(gsBase);
  assert.ok(gs.gammaScalp, "gammaScalp present in gamma scalp mode");
  assert.equal(gs.gammaScalp!.frictionBps, 5);
  assert.ok(gs.gammaScalp!.meanRebalances > 0, "rebalances occur");
  assert.ok(gs.gammaScalp!.meanPerpFrictionUsdc > 0, "friction paid");
  const legacy = await runFoxifyDurationMc(baseInputs);
  assert.equal(legacy.gammaScalp, null, "legacy mode -> gammaScalp null");
});

test("gamma scalp: trigger peak-capture disabled (delta-neutral has no directional windfall)", async () => {
  const gs = await runFoxifyDurationMc({ ...gsBase, triggerPctDown: 0.01, triggerPctUp: 0.01 });
  assert.equal(gs.exitDistribution.trigger_peak, 0, "no trigger_peak exits in gamma scalp mode");
  const total = gs.exitDistribution.foxify_auto_close + gs.exitDistribution.trigger_peak + gs.exitDistribution.expiry;
  assert.ok(Math.abs(total - 1) < 1e-6, "exit distribution sums to 1");
});

test("gamma scalp: deterministic across runs (same seed)", async () => {
  const a = await runFoxifyDurationMc(gsBase);
  const b = await runFoxifyDurationMc(gsBase);
  assert.equal(a.meanFoxifyNetUsdc, b.meanFoxifyNetUsdc);
  assert.equal(a.gammaScalp!.meanPerpFrictionUsdc, b.gammaScalp!.meanPerpFrictionUsdc);
});

test("gamma scalp: higher perp friction → lower mean net (monotonic)", async () => {
  const lowFric = await runFoxifyDurationMc({ ...gsBase, perpFrictionBps: 1 });
  const highFric = await runFoxifyDurationMc({ ...gsBase, perpFrictionBps: 60 });
  assert.ok(highFric.gammaScalp!.meanPerpFrictionUsdc > lowFric.gammaScalp!.meanPerpFrictionUsdc, "more friction paid");
  assert.ok(highFric.meanFoxifyNetUsdc < lowFric.meanFoxifyNetUsdc, "higher friction → lower net");
});

test("gamma scalp: delta hedge cuts net dispersion vs unhedged straddle", async () => {
  // Same straddle, hold-to-expiry, zero friction for a clean comparison.
  const common = { ...gsBase, perpFrictionBps: 0 };
  const hedged = await runFoxifyDurationMc(common);
  const unhedged = await runFoxifyDurationMc({ ...common, gammaScalpWithPerpHedge: false });
  const spread = (r: { p95FoxifyNetUsdc: number; p5FoxifyNetUsdc: number }) => r.p95FoxifyNetUsdc - r.p5FoxifyNetUsdc;
  console.log(`[EMPIRICAL][gamma-scalp] dispersion (p95-p5): hedged=$${spread(hedged).toFixed(0)} unhedged=$${spread(unhedged).toFixed(0)}; ` +
    `hedged meanNet=$${hedged.meanFoxifyNetUsdc.toFixed(0)} (perpPnL=$${hedged.gammaScalp!.meanPerpHedgePnlUsdc.toFixed(0)}) ` +
    `unhedged meanNet=$${unhedged.meanFoxifyNetUsdc.toFixed(0)}`);
  assert.ok(spread(hedged) < spread(unhedged),
    `delta hedge should reduce net dispersion (hedged ${spread(hedged).toFixed(0)} < unhedged ${spread(unhedged).toFixed(0)})`);
});

test("gamma scalp: realized vol > implied vol → higher harvest (the core thesis)", async () => {
  // Option priced/decayed at implied=0.40; compare realized path vol 0.40 vs 0.90.
  const common = {
    ...gsBase, impliedSigmaAnnual: 0.40, hedgeCostUsdc: 2500, perpFrictionBps: 2,
    regime: "moderate" as const, nPaths: 2000, seed: 21
  };
  const realizedEqImplied = await runFoxifyDurationMc({ ...common, sigmaAnnual: 0.40 });
  const realizedGtImplied = await runFoxifyDurationMc({ ...common, sigmaAnnual: 0.90 });
  console.log(`[EMPIRICAL][realized-vs-implied] implied=40%: ` +
    `realized=40% net=$${realizedEqImplied.meanFoxifyNetUsdc.toFixed(0)} (perpPnL=$${realizedEqImplied.gammaScalp!.meanPerpHedgePnlUsdc.toFixed(0)}) | ` +
    `realized=90% net=$${realizedGtImplied.meanFoxifyNetUsdc.toFixed(0)} (perpPnL=$${realizedGtImplied.gammaScalp!.meanPerpHedgePnlUsdc.toFixed(0)})`);
  assert.ok(
    realizedGtImplied.meanFoxifyNetUsdc > realizedEqImplied.meanFoxifyNetUsdc,
    "realized>>implied should harvest more gamma → higher mean net"
  );
});

test("split: higher Atticus split (Foxify keeps more) -> higher Foxify net (configurable)", async () => {
  const cfg = {
    ...baseInputs, salvageRealismMultiplier: 1.0,
    autoCloseAbsoluteUsdc: 100, autoClosePnlPct: 0.10,
    atticusFloorUsdc: 0, // isolate the % split from the floor
    nPaths: 1000, seed: 5
  };
  const foxifyKeeps95 = await runFoxifyDurationMc({ ...cfg, atticusSplitPct: 0.95 });
  const foxifyKeeps50 = await runFoxifyDurationMc({ ...cfg, atticusSplitPct: 0.50 });
  assert.ok(
    foxifyKeeps95.meanFoxifyNetUsdc > foxifyKeeps50.meanFoxifyNetUsdc,
    `Foxify keeping 95% should net more than keeping 50% (${foxifyKeeps95.meanFoxifyNetUsdc} vs ${foxifyKeeps50.meanFoxifyNetUsdc})`
  );
});

// ──────────────────────────── #2: fat-tail bootstrap for all regimes ────────────────────────────

// Deterministic synthetic 5-min bars (~calm historical vol) for offline bootstrap tests.
const synthBars = (() => {
  const bars: { open: number; high: number; low: number; close: number }[] = [];
  let px = 73000, s = 987654321;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 4000; i++) {
    const r = (rnd() - 0.5) * 0.004; // ~0.2% per 5-min step
    px = px * (1 + r);
    bars.push({ open: px, high: px * 1.0008, low: px * 0.9992, close: px });
  }
  return bars;
})();

test("fat-tail mode: bootstrapAllRegimes uses bootstrap for a non-calm regime (not GBM)", async () => {
  const r = await runFoxifyDurationMc({
    ...baseInputs, regime: "stress", sigmaAnnual: 0.95,
    bootstrapAllRegimes: true, barsOverride: synthBars as unknown as typeof baseInputs.barsOverride
  });
  assert.equal(r.pathGenerator, "bootstrap", "non-calm regime should bootstrap in fat-tail mode");
});

test("fat-tail mode: higher regime σ scales the bootstrap → wider net dispersion", async () => {
  const common = { ...baseInputs, autoCloseAbsoluteUsdc: 1e9, autoClosePnlPct: 1e9, triggerPctDown: 1, triggerPctUp: 1, nPaths: 800, seed: 9, bootstrapAllRegimes: true, barsOverride: synthBars as unknown as typeof baseInputs.barsOverride };
  // Disable auto-close/trigger so dispersion reflects the path vol, not exits.
  const lowVol = await runFoxifyDurationMc({ ...common, regime: "moderate", sigmaAnnual: 0.40 });
  const highVol = await runFoxifyDurationMc({ ...common, regime: "stress", sigmaAnnual: 1.20 });
  const spread = (x: { p95FoxifyNetUsdc: number; p5FoxifyNetUsdc: number }) => x.p95FoxifyNetUsdc - x.p5FoxifyNetUsdc;
  assert.ok(spread(highVol) > spread(lowVol),
    `higher σ should widen dispersion: high=${spread(highVol).toFixed(0)} vs low=${spread(lowVol).toFixed(0)}`);
});

test("fat-tail mode OFF (default) → non-calm stays GBM (validated numbers unchanged)", async () => {
  const r = await runFoxifyDurationMc({ ...baseInputs, regime: "moderate", sigmaAnnual: 0.44, barsOverride: null });
  assert.equal(r.pathGenerator, "gbm", "default: non-calm uses GBM");
});
