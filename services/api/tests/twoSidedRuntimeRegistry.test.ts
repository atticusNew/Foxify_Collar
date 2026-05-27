/**
 * PR A6 tests — runtime registry + bootResurrect.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  getRuntimeRegistry,
  __resetRegistryForTests,
  bootResurrect
} from "../src/singleSide/twoSided/runtimeRegistry";
import {
  ensureTwoSidedSchema,
  insertPair,
  insertPairLeg,
  updatePairStatus,
  recordPairEvent
} from "../src/singleSide/twoSided/db";
import { MockCloseExecutor } from "../src/singleSide/twoSided/closeExecutor";
import type { RuntimeDeps } from "../src/singleSide/twoSided/executionRuntime";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const TRIGGERED_AT = Date.parse("2026-05-28T00:00:00Z");
const EXPIRES_AT = TRIGGERED_AT + 2.5 * 86_400_000;
const FORCE_EXIT = EXPIRES_AT - 4 * 3_600_000;

const seedTriggered = async (pool: Awaited<ReturnType<typeof buildPool>>, pairId: string, status: "active" | "triggered" | "unwinding" = "triggered") => {
  const p = await insertPair(pool, {
    pairId,
    cellId: "pair_50k_2pct",
    foxifyPairRef: pairId + "-ref",
    spotAtActivation: 76_000,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480,
    triggerUpPrice: 77_520,
    hedgeTenorDays: 3,
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    tpForceExitAt: new Date(FORCE_EXIT).toISOString(),
    hedgeCostTotalUsdc: 3_200,
    foxifyCapitalFundedUsdc: 3_200,
    tierAtActivation: "tier_1",
    atticusFloorUsdc: 25,
    metadata: {},
    status: "pending"
  });
  await updatePairStatus(pool, p.pairId, "active");
  await insertPairLeg(pool, {
    legId: `${pairId}-put`, pairId: p.pairId, legRole: "long_put", venue: "bullish",
    symbol: "X-P", strikeUsdc: 77_000, contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_150, buyCostUsdc: 1_610, buyFilledAt: new Date().toISOString(),
    liveAnchorAskUsdcPerBtc: 1_150, liveAnchorPulledAt: new Date().toISOString(),
    metadata: {}
  });
  await insertPairLeg(pool, {
    legId: `${pairId}-call`, pairId: p.pairId, legRole: "long_call", venue: "deribit",
    symbol: "X-C", strikeUsdc: 75_000, contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_163, buyCostUsdc: 1_628, buyFilledAt: new Date().toISOString(),
    liveAnchorAskUsdcPerBtc: 1_163, liveAnchorPulledAt: new Date().toISOString(),
    metadata: {}
  });
  if (status === "triggered" || status === "unwinding") {
    await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: new Date(TRIGGERED_AT).toISOString(), triggerSide: "down" });
    await recordPairEvent(pool, { pairId: p.pairId, kind: "trigger_detected", details: { side: "down", canonical_price: 74_400 } });
  }
  if (status === "unwinding") {
    await updatePairStatus(pool, p.pairId, "unwinding");
    await recordPairEvent(pool, { pairId: p.pairId, kind: "unwinding_started", details: { exitMode: "capture_window_peak", peakValue: 4_500, currentValue: 4_200 } });
  }
};

const makeDeps = (pool: Awaited<ReturnType<typeof buildPool>>): RuntimeDeps => ({
  pool,
  getFeed: (): AggregatedFeed => ({
    canonicalPrice: 76_000,
    asOfMs: Date.now(),
    sources: [],
    rejected: [],
    expired: [],
    health: "healthy",
    medianCalcDescription: "test"
  }),
  closeExecutor: new MockCloseExecutor(),
  getCurrentSigma: () => 0.36,
  getCurrentSlippageHaircut: () => 0.85,
  calibrationFor: async () => ({ putCalib: 1.0, callCalib: 1.0, riskFreeRate: 0.045 }),
  pollPeriodMs: 100_000, // long period so test doesn't auto-tick
  log: () => {}
});

test("registry: spawnRuntime registers and returns", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "p1");
  const reg = getRuntimeRegistry();
  const { getPairById } = await import("../src/singleSide/twoSided/db");
  const pair = (await getPairById(pool, "p1"))!;
  const rt = await reg.spawnRuntime(pair, makeDeps(pool));
  assert.ok(rt);
  assert.equal(reg.size(), 1);
  assert.equal(reg.getRuntime("p1"), rt);
  reg.stopAll();
});

test("registry: spawn idempotent — second call returns same instance", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "p1");
  const reg = getRuntimeRegistry();
  const { getPairById } = await import("../src/singleSide/twoSided/db");
  const pair = (await getPairById(pool, "p1"))!;
  const rt1 = await reg.spawnRuntime(pair, makeDeps(pool));
  const rt2 = await reg.spawnRuntime(pair, makeDeps(pool));
  assert.equal(rt1, rt2);
  assert.equal(reg.size(), 1);
  reg.stopAll();
});

test("registry: stopAll halts all + clears map", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "p1");
  await seedTriggered(pool, "p2");
  const reg = getRuntimeRegistry();
  const { getPairById } = await import("../src/singleSide/twoSided/db");
  const p1 = (await getPairById(pool, "p1"))!;
  const p2 = (await getPairById(pool, "p2"))!;
  await reg.spawnRuntime(p1, makeDeps(pool));
  await reg.spawnRuntime(p2, makeDeps(pool));
  assert.equal(reg.size(), 2);
  reg.stopAll();
  assert.equal(reg.size(), 0);
});

test("bootResurrect: 0 non-terminal pairs → no-op", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  const result = await bootResurrect(pool, makeDeps(pool), { log: () => {} });
  assert.equal(result.totalResumed, 0);
  assert.equal(result.errors.length, 0);
});

test("bootResurrect: 2 triggered + 1 unwinding pairs → all 3 resumed", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "t1", "triggered");
  await seedTriggered(pool, "t2", "triggered");
  await seedTriggered(pool, "u1", "unwinding");
  const result = await bootResurrect(pool, makeDeps(pool), { log: () => {} });
  assert.equal(result.triggeredResumed, 2);
  assert.equal(result.unwindingResumed, 1);
  assert.equal(result.totalResumed, 3);
  assert.equal(result.peakReconstructions, 1); // u1 had unwinding_started event with peakValue
  const reg = getRuntimeRegistry();
  assert.equal(reg.size(), 3);
  reg.stopAll();
});

test("bootResurrect: skips pairs in `active`/`settled`/`cancelled` (only non-terminal in-flight)", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "active1", "active");
  await seedTriggered(pool, "trig1", "triggered");
  const result = await bootResurrect(pool, makeDeps(pool), { log: () => {} });
  // Only the triggered pair should be resumed; active stays untouched (trigger detector picks it up)
  assert.equal(result.totalResumed, 1);
  const reg = getRuntimeRegistry();
  assert.equal(reg.size(), 1);
  assert.equal(reg.getRuntime("trig1") !== null, true);
  assert.equal(reg.getRuntime("active1"), null);
  reg.stopAll();
});

test("bootResurrect: idempotent — second call doesn't re-spawn existing", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "t1", "triggered");
  const r1 = await bootResurrect(pool, makeDeps(pool), { log: () => {} });
  const r2 = await bootResurrect(pool, makeDeps(pool), { log: () => {} });
  assert.equal(r1.totalResumed, 1);
  assert.equal(r2.totalResumed, 0); // already in registry, skipped
  assert.equal(r2.skipped, 1);
  const reg = getRuntimeRegistry();
  assert.equal(reg.size(), 1);
  reg.stopAll();
});

test("registry: deregister removes from map", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedTriggered(pool, "p1");
  const reg = getRuntimeRegistry();
  const { getPairById } = await import("../src/singleSide/twoSided/db");
  const pair = (await getPairById(pool, "p1"))!;
  await reg.spawnRuntime(pair, makeDeps(pool));
  assert.equal(reg.size(), 1);
  reg.deregister("p1");
  assert.equal(reg.size(), 0);
  assert.equal(reg.getRuntime("p1"), null);
  reg.stopAll();
});
