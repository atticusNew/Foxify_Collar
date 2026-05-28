/**
 * Tests for liveCellEvService — live MC EV computation per cell.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeLiveCellEv, __resetLiveCellEvCache, __getLiveCellEvCacheSize } from "../src/singleSide/twoSided/liveCellEvService";

test("computeLiveCellEv returns sensible structure for moderate regime", async () => {
  __resetLiveCellEvCache();
  const r = await computeLiveCellEv({
    cellId: "test_cell",
    spot: 73000,
    hedgeCostAtCalm: 500,
    putStrike: 72000,
    callStrike: 74000,
    tenorDays: 3,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    regime: "moderate",
    contractsBtc: 0.5
  });
  assert.ok(typeof r.meanFoxifyEv === "number");
  assert.ok(typeof r.meanAtticusEv === "number");
  assert.ok(typeof r.triggerRate === "number");
  assert.ok(r.triggerRate >= 0 && r.triggerRate <= 1);
  assert.ok(typeof r.meanSalvage === "number");
  assert.ok(r.meanSalvage >= 0);
  assert.equal(r.nPaths, 2000);
  assert.ok(r.computedAtMs > 0);
});

test("computeLiveCellEv caches by (cellId, regime, cost-bucket)", async () => {
  __resetLiveCellEvCache();
  const inputs = {
    cellId: "cache_test",
    spot: 73000,
    hedgeCostAtCalm: 500,
    putStrike: 72000,
    callStrike: 74000,
    tenorDays: 3,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    regime: "calm" as const,
    contractsBtc: 0.5
  };
  const r1 = await computeLiveCellEv(inputs);
  const r2 = await computeLiveCellEv(inputs);
  assert.equal(r1.computedAtMs, r2.computedAtMs); // same cache entry
  assert.equal(__getLiveCellEvCacheSize(), 1);

  // Cost shift > $50 → cache miss
  const r3 = await computeLiveCellEv({ ...inputs, hedgeCostAtCalm: 600 });
  assert.notEqual(r1.computedAtMs, r3.computedAtMs);
  assert.equal(__getLiveCellEvCacheSize(), 2);
});

test("computeLiveCellEv higher regime → higher cost (markup applied)", async () => {
  __resetLiveCellEvCache();
  const base = {
    cellId: "regime_test",
    spot: 73000,
    hedgeCostAtCalm: 500,
    putStrike: 72000,
    callStrike: 74000,
    tenorDays: 3,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5
  };
  const calm = await computeLiveCellEv({ ...base, regime: "calm" });
  const stress = await computeLiveCellEv({ ...base, regime: "stress" });
  assert.equal(calm.hedgeCost, 500);
  assert.equal(stress.hedgeCost, 800); // 500 * 1.6
});

test("computeLiveCellEv higher regime → higher trigger rate", async () => {
  __resetLiveCellEvCache();
  const base = {
    cellId: "trigger_test",
    spot: 73000,
    hedgeCostAtCalm: 500,
    putStrike: 72000,
    callStrike: 74000,
    tenorDays: 3,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5
  };
  const calm = await computeLiveCellEv({ ...base, regime: "calm" });
  const stress = await computeLiveCellEv({ ...base, regime: "stress" });
  // Stress regime has much higher vol → more trigger crossings
  assert.ok(stress.triggerRate > calm.triggerRate);
});

test("computeLiveCellEv: cheaper cost → better Foxify EV", async () => {
  __resetLiveCellEvCache();
  const base = {
    cellId: "cost_sensitivity",
    spot: 73000,
    putStrike: 72000,
    callStrike: 74000,
    tenorDays: 3,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    regime: "moderate" as const,
    contractsBtc: 0.5
  };
  const expensive = await computeLiveCellEv({ ...base, hedgeCostAtCalm: 800 });
  const cheap = await computeLiveCellEv({ ...base, hedgeCostAtCalm: 300 });
  assert.ok(cheap.meanFoxifyEv > expensive.meanFoxifyEv);
});
