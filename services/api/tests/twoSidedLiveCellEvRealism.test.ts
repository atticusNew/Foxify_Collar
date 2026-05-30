/**
 * Tests for salvageRealismMultiplier in computeLiveCellEv.
 *
 * The multiplier scales every MC salvage value to simulate the
 * bid-side discount observed at activation. Critical correctness:
 * 0.5 multiplier means EV should be measurably lower than 1.0 (legacy).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeLiveCellEv, __resetLiveCellEvCache } from "../src/singleSide/twoSided/liveCellEvService";

const baseInputs = {
  cellId: "test_cell",
  spot: 73950,
  hedgeCostAtCalm: 350,
  putStrike: 73000,
  callStrike: 75000,
  tenorDays: 2,
  triggerPctDown: 0.05,
  triggerPctUp: 0.05,
  regime: "calm" as const,
  contractsBtc: 1
};

test("realism multiplier 1.0 = legacy BS-only behavior", async () => {
  __resetLiveCellEvCache();
  const r = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 1.0 });
  assert.equal(r.salvageRealismMultiplier, 1.0);
  assert.ok(r.meanSalvage > 0, "should have some salvage");
});

test("realism multiplier 0.5 halves mean salvage vs 1.0", async () => {
  __resetLiveCellEvCache();
  const full = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 1.0 });
  __resetLiveCellEvCache();
  const half = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 0.5 });
  // Mean salvage should be ~50% of full (allowing tiny rounding diff)
  const ratio = half.meanSalvage / full.meanSalvage;
  assert.ok(Math.abs(ratio - 0.5) < 0.01, `expected ratio ~0.5, got ${ratio.toFixed(4)}`);
  assert.equal(half.salvageRealismMultiplier, 0.5);
  // Trigger rate must be IDENTICAL (multiplier only affects salvage, not path generation)
  assert.equal(half.triggerRate, full.triggerRate);
});

test("realism multiplier 0.5 produces measurably lower Foxify EV than 1.0", async () => {
  __resetLiveCellEvCache();
  const full = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 1.0 });
  __resetLiveCellEvCache();
  const half = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 0.5 });
  assert.ok(half.meanFoxifyEv < full.meanFoxifyEv,
    `half-realism EV (${half.meanFoxifyEv}) should be less than full (${full.meanFoxifyEv})`);
});

test("realism multiplier 0 = zero salvage (full bid-side wipeout simulation)", async () => {
  __resetLiveCellEvCache();
  const r = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 0 });
  assert.equal(r.meanSalvage, 0);
  // Foxify EV = -hedgeCost when salvage is zero (full loss)
  assert.ok(r.meanFoxifyEv < 0, `should be net negative when salvage=0`);
});

test("realism multiplier defaults to 1.0 when omitted", async () => {
  __resetLiveCellEvCache();
  const r = await computeLiveCellEv(baseInputs);
  assert.equal(r.salvageRealismMultiplier, 1.0);
});

test("realism multiplier clamped to [0, 1.5]", async () => {
  __resetLiveCellEvCache();
  const high = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 5.0 });
  assert.equal(high.salvageRealismMultiplier, 1.5);
  __resetLiveCellEvCache();
  const neg = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: -0.5 });
  assert.equal(neg.salvageRealismMultiplier, 0);
});

test("realism multiplier participates in cache key (different multipliers → distinct results)", async () => {
  __resetLiveCellEvCache();
  const a = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 1.0 });
  const b = await computeLiveCellEv({ ...baseInputs, salvageRealismMultiplier: 0.5 });
  // Different multipliers should produce different mean salvage (NOT a cache hit)
  assert.notEqual(a.meanSalvage, b.meanSalvage);
});
