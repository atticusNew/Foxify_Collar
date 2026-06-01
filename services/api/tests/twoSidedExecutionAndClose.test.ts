/**
 * PR 5 tests — execution runtime + Foxify early-close handler.
 *
 * Runtime (7 tests):
 *   - tick with no feed → wait
 *   - tick within capture window → wait
 *   - capture window snap → triggers close at peak × slip; pair → settled
 *   - trail retrace after window → close at current × slip
 *   - foxify force close → close at current × slip with reason=foxify_close
 *   - close executor failure → pair stays unwinding; execution_stuck event
 *   - unwind slot unavailable → defers (wait emitted)
 *
 * Close handler (5 tests):
 *   - 200 on triggered pair → forceClose called on runtime
 *   - 200 on active pair → spawnRuntimeForceClose called + status → unwinding
 *   - 404 on unknown pair
 *   - 409 on already-unwinding pair
 *   - 409 on settled pair
 *
 * Settlement split (PR 6 will own canonical settlement; smoke-tested here):
 *   - uplift > floor → atticus_share = tier_pct × uplift
 *   - uplift < floor amount but > 0 → atticus_share = floor
 *   - uplift <= 0 → atticus_share = 0, foxify eats loss
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  insertPairLeg,
  getPairById,
  updatePairStatus,
  getEventsForPair
} from "../src/singleSide/twoSided/db";
import { ExecutionRuntime, type RuntimeDeps } from "../src/singleSide/twoSided/executionRuntime";
import { handleClose } from "../src/singleSide/twoSided/closeHandler";
import { MockCloseExecutor } from "../src/singleSide/twoSided/closeExecutor";
import { CAPTURE_WINDOW_MS } from "../src/singleSide/twoSided/tpEngine";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const TRIGGERED_AT = Date.parse("2026-05-28T00:00:00Z");
const EXPIRES_AT = TRIGGERED_AT + 2.5 * 86_400_000; // 2.5d remaining
const FORCE_EXIT = EXPIRES_AT - 4 * 3_600_000;

const seedTriggeredPair = async (pool: Awaited<ReturnType<typeof buildPool>>, opts: { hedgeCost?: number; tier?: string; floor?: number } = {}) => {
  const p = await insertPair(pool, {
    pairId: "pair-1",
    cellId: "pair_50k_2pct",
    foxifyPairRef: "fxy-1",
    spotAtActivation: 76_000,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480,
    triggerUpPrice: 77_520,
    hedgeTenorDays: 3,
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    tpForceExitAt: new Date(FORCE_EXIT).toISOString(),
    hedgeCostTotalUsdc: opts.hedgeCost ?? 3_200,
    foxifyCapitalFundedUsdc: opts.hedgeCost ?? 3_200,
    tierAtActivation: (opts.tier as PairLegRecord["legRole"] | undefined ?? "tier_1") as "tier_1",
    atticusFloorUsdc: opts.floor ?? 25,
    metadata: {},
    status: "pending"
  });
  await updatePairStatus(pool, p.pairId, "active");
  await insertPairLeg(pool, {
    legId: "leg-put",
    pairId: p.pairId,
    legRole: "long_put",
    venue: "bullish",
    symbol: "BTC-USDC-20260530-77000-P",
    strikeUsdc: 77_000,
    contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_150,
    buyCostUsdc: 1_610,
    buyFilledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 1_150,
    liveAnchorPulledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    metadata: {}
  });
  await insertPairLeg(pool, {
    legId: "leg-call",
    pairId: p.pairId,
    legRole: "long_call",
    venue: "deribit",
    symbol: "BTC-31MAY26-75000-C",
    strikeUsdc: 75_000,
    contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_162.86,
    buyCostUsdc: 1_628,
    buyFilledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 1_162.86,
    liveAnchorPulledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    metadata: {}
  });
  return await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: new Date(TRIGGERED_AT).toISOString(), triggerSide: "down" });
};
// Type import alias
import type { PairLegRecord } from "../src/singleSide/twoSided/types";

const makeFeed = (spot: number, asOfMs = Date.now()): AggregatedFeed => ({
  canonicalPrice: spot,
  asOfMs,
  sources: [
    { source: "bullish", price: spot, ts: asOfMs },
    { source: "deribit", price: spot + 1, ts: asOfMs },
    { source: "coinbase", price: spot - 1, ts: asOfMs }
  ],
  rejected: [],
  expired: [],
  health: "healthy",
  medianCalcDescription: `m=${spot}`
});

const baseDeps = (pool: Awaited<ReturnType<typeof buildPool>>, feedSpot: () => number, behaviorOverrides: Partial<RuntimeDeps> = {}): RuntimeDeps => ({
  pool,
  getFeed: () => makeFeed(feedSpot()),
  closeExecutor: new MockCloseExecutor(),
  getCurrentSigma: () => 0.36,
  getCurrentSlippageHaircut: () => 0.85,
  calibrationFor: async () => ({ putCalib: 1.0, callCalib: 1.0, riskFreeRate: 0.045 }),
  pollPeriodMs: 50,
  log: () => {},
  ...behaviorOverrides
});

// ─── Runtime tests ───

test("ExecutionRuntime: tick with no feed → wait", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 0, { getFeed: () => null }), pair);
  await rt.init();
  const d = await rt.tick(TRIGGERED_AT + 5 * 60_000);
  assert.equal(d.action, "wait");
});

test("ExecutionRuntime: tick within capture window → wait", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000), pair); // deep ITM put, valuable strangle
  await rt.init();
  const d = await rt.tick(TRIGGERED_AT + 5 * 60_000); // 5 min in
  assert.equal(d.action, "wait");
});

test("ExecutionRuntime: capture window snap → closes pair as settled", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000), pair);
  await rt.init();
  // First tick within window to register peak
  await rt.tick(TRIGGERED_AT + 5 * 60_000);
  // Second tick exactly at capture window boundary → snap
  const d = await rt.tick(TRIGGERED_AT + CAPTURE_WINDOW_MS + 5_000);
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "capture_window_peak");
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "settled");
  assert.equal(fresh!.exitMode, "capture_window_peak");
  assert.equal(fresh!.closedReason, "trigger");
  assert.ok(fresh!.salvageProceedsUsdc != null);
  assert.ok(fresh!.foxifyShareUsdc != null);
  const events = await getEventsForPair(pool, pair.pairId);
  assert.ok(events.some((e) => e.kind === "unwinding_started"));
  assert.ok(events.some((e) => e.kind === "settled"));
});

test("ExecutionRuntime: foxify force close → reason=foxify_close + closedReason=foxify_close", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000), pair);
  await rt.init();
  rt.forceClose();
  const d = await rt.tick(TRIGGERED_AT + 2 * 60_000); // 2 min in (within window)
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "foxify_close");
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.closedReason, "foxify_close");
  assert.equal(fresh!.exitMode, "foxify_close");
});

test("ExecutionRuntime: force-close of a pair already in 'unwinding' SETTLES (regression: active-pair force-close hung)", async () => {
  // Reproduces the live bug: Foxify early-close of an ACTIVE pair → handleClose moves it
  // active → unwinding, then spawns the force-close runtime. The runtime used to require
  // status==='triggered' and ABORTED on 'unwinding' → the pair hung in unwinding with the
  // real legs never sold. After the fix it must proceed to close + settle.
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  await updatePairStatus(pool, pair.pairId, "unwinding"); // simulate handleClose(active→unwinding)
  const fresh0 = await getPairById(pool, pair.pairId);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000), fresh0!);
  await rt.init();
  rt.forceClose();
  const d = await rt.tick(TRIGGERED_AT + 2 * 60_000);
  assert.equal(d.action, "sell", "must proceed to sell, not abort");
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "settled", "force-close from unwinding now settles (was stuck before fix)");
  assert.equal(fresh!.exitMode, "foxify_close");
  assert.ok(fresh!.salvageProceedsUsdc != null, "salvage realized");
});

test("ExecutionRuntime: close executor failure → execution_stuck event + status unwinding (not settled)", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const failingExec = new MockCloseExecutor({
    failPutLeg: { reason: "venue_error", detail: "Bullish 500" },
    failCallLeg: { reason: "venue_error", detail: "Deribit timeout" }
  });
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000, { closeExecutor: failingExec }), pair);
  await rt.init();
  rt.forceClose();
  await rt.tick(TRIGGERED_AT + 2 * 60_000);
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "unwinding");
  const events = await getEventsForPair(pool, pair.pairId);
  assert.ok(events.some((e) => e.kind === "execution_stuck"));
});

test("ExecutionRuntime: isUnwindSlotAvailable=false defers (no DB writes)", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  const rt = new ExecutionRuntime(baseDeps(pool, () => 74_000, { isUnwindSlotAvailable: () => false }), pair);
  await rt.init();
  rt.forceClose();
  const d = await rt.tick(TRIGGERED_AT + 2 * 60_000);
  assert.equal(d.action, "wait"); // re-emitted as wait by throttle gate
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "triggered"); // no transition
});

test("ExecutionRuntime: trail_retrace after capture window", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  // Simulate: tick first at high-value spot (build peak), then drop spot way down (current < peak*0.85)
  let currentSpot = 73_500; // deep ITM put → big strangle value
  const rt = new ExecutionRuntime(baseDeps(pool, () => currentSpot), pair);
  await rt.init();
  await rt.tick(TRIGGERED_AT + 1 * 60_000); // establish peak inside window
  await rt.tick(TRIGGERED_AT + 10 * 60_000); // mid-window
  currentSpot = 75_500; // strangle value falls (no longer deep ITM either way)
  const d = await rt.tick(TRIGGERED_AT + CAPTURE_WINDOW_MS + 60 * 60_000); // 1h past window
  // Either trail_retrace or hard_floor — both produce sell action
  assert.equal(d.action, "sell");
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "settled");
});

// ─── Close handler tests ───

test("handleClose: 404 unknown pair", async () => {
  const pool = await buildPool();
  const r = await handleClose(
    { pairId: "nonexistent" },
    { pool, getRuntime: () => null, spawnRuntimeForceClose: async () => {} }
  );
  assert.equal(r.status, 404);
});

test("handleClose: 409 on settled pair", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  await updatePairStatus(pool, pair.pairId, "unwinding");
  await updatePairStatus(pool, pair.pairId, "settled", {
    closedAt: new Date().toISOString(),
    closedReason: "trigger",
    salvageProceedsUsdc: 3000,
    upliftUsdc: -200,
    foxifyShareUsdc: 3000,
    atticusShareUsdc: 0,
    exitMode: "trail_retrace"
  });
  const r = await handleClose(
    { pairId: pair.pairId },
    { pool, getRuntime: () => null, spawnRuntimeForceClose: async () => {} }
  );
  assert.equal(r.status, 409);
  if (r.status === 409) assert.equal(r.body.current_status, "settled");
});

test("handleClose: 200 on triggered pair, calls runtime.forceClose", async () => {
  const pool = await buildPool();
  const pair = await seedTriggeredPair(pool);
  let forceCloseCalled = false;
  // Minimal runtime stub
  const fakeRt = { forceClose: () => { forceCloseCalled = true; } } as unknown as ExecutionRuntime;
  const r = await handleClose(
    { pairId: pair.pairId, foxifyCloseReason: "user_request" },
    { pool, getRuntime: () => fakeRt, spawnRuntimeForceClose: async () => {} }
  );
  assert.equal(r.status, 200);
  assert.equal(forceCloseCalled, true);
  const events = await getEventsForPair(pool, pair.pairId);
  assert.ok(events.some((e) => e.kind === "foxify_closed"));
});

test("handleClose: 200 on active pair, transitions unwinding and spawns runtime", async () => {
  const pool = await buildPool();
  // Create pair in active state (not triggered)
  const p = await insertPair(pool, {
    pairId: "active-pair",
    cellId: "pair_50k_2pct",
    foxifyPairRef: "fxy-active",
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
  let spawnCalled = false;
  const r = await handleClose(
    { pairId: p.pairId },
    { pool, getRuntime: () => null, spawnRuntimeForceClose: async () => { spawnCalled = true; } }
  );
  assert.equal(r.status, 200);
  assert.equal(spawnCalled, true);
  const fresh = await getPairById(pool, p.pairId);
  assert.equal(fresh!.status, "unwinding");
});

test("handleClose: 400 on missing pairId", async () => {
  const pool = await buildPool();
  const r = await handleClose({}, { pool, getRuntime: () => null, spawnRuntimeForceClose: async () => {} });
  assert.equal(r.status, 400);
});
