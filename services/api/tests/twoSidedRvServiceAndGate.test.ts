/**
 * Tests for RvService, computeAnnualizedRv, and activation gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RvService, computeAnnualizedRv } from "../src/singleSide/twoSided/rvService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import { computeActivationGate } from "../src/singleSide/twoSided/activationGate";

test("computeAnnualizedRv returns 0 for empty or single-element input", () => {
  assert.equal(computeAnnualizedRv([], 365), 0);
  assert.equal(computeAnnualizedRv([100], 365), 0);
});

test("computeAnnualizedRv computes non-zero vol for variable prices", () => {
  // Daily prices with mild variation
  const prices = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105];
  const rv = computeAnnualizedRv(prices, 365);
  assert.ok(rv > 0);
  assert.ok(rv < 10); // sanity bound
});

test("computeAnnualizedRv higher for higher-variance series", () => {
  const lowVar = [100, 100.1, 99.9, 100.05, 99.95, 100, 99.95, 100.05];
  const highVar = [100, 105, 95, 108, 92, 110, 90, 115];
  const rvLow = computeAnnualizedRv(lowVar, 365);
  const rvHigh = computeAnnualizedRv(highVar, 365);
  assert.ok(rvHigh > rvLow);
});

test("RvService tick stores sample on success", async () => {
  const svc = new RvService({
    fetchOverride: async () => {
      const bars: Array<{ ts: number; close: number }> = [];
      // 24 hours of 5-min bars at ~$73k with mild drift
      for (let i = 0; i < 288; i++) {
        bars.push({ ts: Date.now() - (288 - i) * 5 * 60_000, close: 73_000 + Math.sin(i / 10) * 50 });
      }
      return bars;
    }
  });
  const sample = await svc.tick();
  assert.ok(sample);
  assert.ok(sample!.rvAnnual > 0);
  assert.equal(sample!.barCount, 288);
  assert.ok(Math.abs(sample!.meanSpot - 73_000) < 100);
});

test("RvService getCurrentRv returns null if stale", async () => {
  const svc = new RvService({
    staleMaxAgeMs: 1_000,
    fetchOverride: async () => Array.from({ length: 50 }, (_, i) => ({ ts: i, close: 73000 + i }))
  });
  await svc.tick(1_000);
  assert.ok(svc.getCurrentRv(1_500)); // fresh
  assert.equal(svc.getCurrentRv(3_000), null); // stale
});

test("RvService handles fetch failure (returns null)", async () => {
  const svc = new RvService({
    fetchOverride: async () => [] // empty bars
  });
  const r = await svc.tick();
  assert.equal(r, null);
  assert.equal(svc.getHealth().consecutiveFailures, 1);
});

test("activationGate: returns good_to_activate=true for moderate regime", async () => {
  const dvol = new DvolService({ fetchOverride: async () => 50 });
  await dvol.tick();
  const rv = new RvService({ fetchOverride: async () => Array.from({ length: 50 }, (_, i) => ({ ts: i, close: 73000 + i * 10 })) });
  await rv.tick();
  const r = await computeActivationGate({ dvolService: dvol, rvService: rv });
  assert.equal(r.good_to_activate, true);
  assert.equal(r.regime, "moderate");
  assert.ok(r.recommended_cells.length > 0);
});

test("activationGate: returns good_to_activate=false for calm + positive VRP", async () => {
  // Calm: DVOL=35 → IV=0.35
  // Low realized vol (flat prices) → RV << IV → VRP > 0
  const dvol = new DvolService({ fetchOverride: async () => 35 });
  await dvol.tick();
  const rv = new RvService({
    fetchOverride: async () => Array.from({ length: 50 }, (_, i) => ({ ts: i, close: 73000 + (i % 2) * 5 })) // very stable
  });
  await rv.tick();
  const r = await computeActivationGate({ dvolService: dvol, rvService: rv });
  assert.equal(r.regime, "calm");
  assert.ok(r.vrp != null);
  assert.ok(r.vrp! > 0); // IV >> RV
  assert.equal(r.good_to_activate, false);
});

test("activationGate: returns good_to_activate=true for calm + negative VRP", async () => {
  // Calm: DVOL=35 → IV=0.35
  // High realized vol (volatile prices) → RV > IV → VRP < threshold
  const dvol = new DvolService({ fetchOverride: async () => 35 });
  await dvol.tick();
  const rv = new RvService({
    fetchOverride: async () => Array.from({ length: 100 }, (_, i) => ({
      ts: i,
      close: 73000 + Math.sin(i / 2) * 2000 // BIG swings → high RV
    }))
  });
  await rv.tick();
  const r = await computeActivationGate({ dvolService: dvol, rvService: rv });
  assert.equal(r.regime, "calm");
  assert.ok(r.vrp != null);
  assert.ok(r.vrp! < -0.02); // IV well below RV
  assert.equal(r.good_to_activate, true);
  assert.match(r.reason, /vrp_negative/);
});

test("activationGate: handles DVOL unavailable gracefully", async () => {
  const dvol = new DvolService({ fetchOverride: async () => null, staleMaxAgeMs: 1_000 });
  await dvol.tick(0);
  const rv = new RvService({ fetchOverride: async () => Array.from({ length: 50 }, (_, i) => ({ ts: i, close: 73000 + i })) });
  await rv.tick();
  const r = await computeActivationGate({ dvolService: dvol, rvService: rv });
  assert.equal(r.good_to_activate, false);
  assert.equal(r.reason, "dvol_unavailable");
});
