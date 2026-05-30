/**
 * PR 6 tests — settlement engine + deferred pool.
 *
 * Settlement (8):
 *   - uplift > 0, well above floor → atticus = tier_pct × uplift
 *   - uplift > 0, floor binds → atticus = floor, foxify = hedge_cost + uplift - floor
 *   - uplift > 0, floor > uplift → atticus = uplift, foxify = hedge_cost (clamp)
 *   - uplift = 0 → atticus = 0, foxify = hedge_cost
 *   - uplift < 0 → atticus = 0, foxify = salvage (eat loss)
 *   - tier_5 split (8% / 92%, $45 floor) at typical uplift
 *   - tier_1 split at high uplift
 *   - assertSplitInvariant throws on bad inputs
 *
 * Deferred pool (5):
 *   - schema idempotent
 *   - togglePool active true/false
 *   - recordAccrual + getPoolBalance
 *   - settleAccruedBalance returns total + marks settled
 *   - getPoolBalance excludes settled entries
 *
 * Runtime integration smoke (1):
 *   - runtime close with deferred-pool active accrues to ledger
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { computeSplit, assertSplitInvariant } from "../src/singleSide/twoSided/settlementEngine";
import {
  ensureDeferredPoolSchema,
  togglePool,
  getPoolState,
  recordAccrual,
  getPoolBalance,
  settleAccruedBalance
} from "../src/singleSide/twoSided/deferredPool";
import { TIERS } from "../src/singleSide/twoSided/types";
import { ensureTwoSidedSchema, insertPair, insertPairLeg, updatePairStatus } from "../src/singleSide/twoSided/db";
import { ExecutionRuntime } from "../src/singleSide/twoSided/executionRuntime";
import { MockCloseExecutor } from "../src/singleSide/twoSided/closeExecutor";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureDeferredPoolSchema(pool);
  return pool;
};

// ─── Settlement engine ───

const tier1 = TIERS[0]; // 15% / 85% / $25 floor
const tier5 = TIERS[4]; // 8% / 92% / $45 floor

test("computeSplit: uplift well above floor → atticus = tier_pct × uplift (tier_1)", () => {
  const r = computeSplit({ salvageProceedsUsdc: 3_800, hedgeCostUsdc: 3_200, tier: tier1 });
  assert.equal(r.upliftUsdc, 600);
  assert.equal(r.atticusShareUsdc, 90); // 0.15 × 600 = 90 > $25 floor
  assert.equal(r.foxifyShareUsdc, 3_710); // 3200 + (600 - 90)
  assert.equal(r.outcomeCategory, "uplift_positive");
  assert.equal(r.floorWasBinding, false);
  assertSplitInvariant(r);
});

test("computeSplit: small uplift floor binds (tier_5, $45 floor)", () => {
  // tier_5 8% × 100 uplift = $8 → floor $45 binds
  const r = computeSplit({ salvageProceedsUsdc: 3_300, hedgeCostUsdc: 3_200, tier: tier5 });
  assert.equal(r.upliftUsdc, 100);
  assert.equal(r.atticusShareUsdc, 45);
  assert.equal(r.foxifyShareUsdc, 3_255); // 3200 + (100 - 45)
  assert.equal(r.floorWasBinding, true);
  assertSplitInvariant(r);
});

test("computeSplit: floor > uplift → atticus = uplift (clamp), foxify = hedge_cost", () => {
  // tier_5 floor $45, uplift only $30
  const r = computeSplit({ salvageProceedsUsdc: 3_230, hedgeCostUsdc: 3_200, tier: tier5 });
  assert.equal(r.upliftUsdc, 30);
  assert.equal(r.atticusShareUsdc, 30);
  assert.equal(r.foxifyShareUsdc, 3_200);
  assert.equal(r.upliftClampApplied, true);
  assertSplitInvariant(r);
});

test("computeSplit: uplift = 0 → atticus = 0, foxify = hedge_cost", () => {
  const r = computeSplit({ salvageProceedsUsdc: 3_200, hedgeCostUsdc: 3_200, tier: tier1 });
  assert.equal(r.upliftUsdc, 0);
  assert.equal(r.atticusShareUsdc, 0);
  assert.equal(r.foxifyShareUsdc, 3_200);
  assert.equal(r.outcomeCategory, "uplift_zero");
  assertSplitInvariant(r);
});

test("computeSplit: uplift < 0 → atticus = 0, foxify eats loss (= salvage)", () => {
  const r = computeSplit({ salvageProceedsUsdc: 2_800, hedgeCostUsdc: 3_200, tier: tier1 });
  assert.equal(r.upliftUsdc, -400);
  assert.equal(r.atticusShareUsdc, 0);
  assert.equal(r.foxifyShareUsdc, 2_800);
  assert.equal(r.outcomeCategory, "uplift_negative");
  assertSplitInvariant(r);
});

test("computeSplit: tier_1 at high uplift (deep ITM trigger fire)", () => {
  const r = computeSplit({ salvageProceedsUsdc: 5_500, hedgeCostUsdc: 3_200, tier: tier1 });
  // uplift = 2300, atticus = 0.15 × 2300 = 345
  assert.equal(r.atticusShareUsdc, 345);
  assert.equal(r.foxifyShareUsdc, 5_155); // 3200 + 2300 - 345
});

test("computeSplit: tier_5 at high uplift (Foxify scaled)", () => {
  const r = computeSplit({ salvageProceedsUsdc: 5_500, hedgeCostUsdc: 3_200, tier: tier5 });
  // uplift = 2300, atticus = 0.08 × 2300 = 184, foxify=5316
  assert.equal(r.atticusShareUsdc, 184);
  assert.equal(r.foxifyShareUsdc, 5_316);
  assertSplitInvariant(r);
});

test("assertSplitInvariant: throws on inconsistent split", () => {
  assert.throws(() =>
    assertSplitInvariant({
      salvageProceedsUsdc: 1000,
      hedgeCostUsdc: 800,
      upliftUsdc: 200,
      atticusShareUsdc: 100,
      foxifyShareUsdc: 100, // 100+100=200 ≠ 1000
      atticusProportionalUsdc: 100,
      atticusFlooredUsdc: 100,
      floorWasBinding: false,
      upliftClampApplied: false,
      outcomeCategory: "uplift_positive"
    })
  );
});

// ─── Deferred pool ───

test("ensureDeferredPoolSchema: idempotent", async () => {
  const pool = await buildPool();
  await ensureDeferredPoolSchema(pool);
  await ensureDeferredPoolSchema(pool);
});

test("togglePool: active true/false flips state + records timestamps", async () => {
  const pool = await buildPool();
  const s0 = await getPoolState(pool);
  assert.equal(s0.active, false);
  const s1 = await togglePool(pool, true, "ramp phase");
  assert.equal(s1.active, true);
  assert.equal(s1.notes, "ramp phase");
  assert.ok(s1.activatedAt);
  const s2 = await togglePool(pool, false, "stable at 25/day");
  assert.equal(s2.active, false);
  assert.ok(s2.deactivatedAt);
  assert.equal(s2.notes, "stable at 25/day");
});

test("recordAccrual + getPoolBalance: aggregates unsettled entries", async () => {
  const pool = await buildPool();
  await recordAccrual(pool, { ledgerId: "led-1", pairId: "p1", atticusShareUsdc: 90, upliftUsdc: 600 });
  await recordAccrual(pool, { ledgerId: "led-2", pairId: "p2", atticusShareUsdc: 110, upliftUsdc: 800 });
  await recordAccrual(pool, { ledgerId: "led-3", pairId: "p3", atticusShareUsdc: 45, upliftUsdc: 50 });
  const b = await getPoolBalance(pool);
  assert.equal(b.entryCount, 3);
  assert.equal(b.unsettledUsdc, 245);
});

test("settleAccruedBalance: returns total + marks all settled", async () => {
  const pool = await buildPool();
  await recordAccrual(pool, { ledgerId: "led-a", pairId: "pa", atticusShareUsdc: 90, upliftUsdc: 600 });
  await recordAccrual(pool, { ledgerId: "led-b", pairId: "pb", atticusShareUsdc: 110, upliftUsdc: 800 });
  const r = await settleAccruedBalance(pool);
  assert.equal(r.entryCount, 2);
  assert.equal(r.settledUsdc, 200);
  // Re-querying balance should now show 0 unsettled
  const b = await getPoolBalance(pool);
  assert.equal(b.entryCount, 0);
  assert.equal(b.unsettledUsdc, 0);
});

test("getPoolBalance: future accrual after settle is tracked separately", async () => {
  const pool = await buildPool();
  await recordAccrual(pool, { ledgerId: "led-x", pairId: "px", atticusShareUsdc: 50, upliftUsdc: 300 });
  await settleAccruedBalance(pool);
  await recordAccrual(pool, { ledgerId: "led-y", pairId: "py", atticusShareUsdc: 75, upliftUsdc: 500 });
  const b = await getPoolBalance(pool);
  assert.equal(b.entryCount, 1);
  assert.equal(b.unsettledUsdc, 75);
});

// ─── Runtime integration smoke ───

test("ExecutionRuntime with deferred-pool active accrues Atticus share", async () => {
  const pool = await buildPool();
  await togglePool(pool, true, "test");

  const TRIGGERED_AT = Date.parse("2026-05-28T00:00:00Z");
  const EXPIRES_AT = TRIGGERED_AT + 2.5 * 86_400_000;
  const FORCE_EXIT = EXPIRES_AT - 4 * 3_600_000;
  const p = await insertPair(pool, {
    pairId: "p-defer",
    cellId: "pair_50k_2pct",
    foxifyPairRef: "fxy-defer",
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
    legId: "leg-put-d", pairId: p.pairId, legRole: "long_put", venue: "bullish",
    symbol: "X-P", strikeUsdc: 77_000, contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_150, buyCostUsdc: 1_610, buyFilledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 1_150, liveAnchorPulledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    metadata: {}
  });
  await insertPairLeg(pool, {
    legId: "leg-call-d", pairId: p.pairId, legRole: "long_call", venue: "deribit",
    symbol: "X-C", strikeUsdc: 75_000, contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_163, buyCostUsdc: 1_628, buyFilledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 1_163, liveAnchorPulledAt: new Date(TRIGGERED_AT - 3_600_000).toISOString(),
    metadata: {}
  });
  const triggered = await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: new Date(TRIGGERED_AT).toISOString(), triggerSide: "down" });

  const feed = (spot: number, asOfMs = Date.now()): AggregatedFeed => ({
    canonicalPrice: spot, asOfMs, sources: [{source: "x", price: spot, ts: asOfMs}], rejected: [], expired: [], health: "healthy", medianCalcDescription: ""
  });
  const rt = new ExecutionRuntime({
    pool,
    getFeed: () => feed(74_000),
    closeExecutor: new MockCloseExecutor(),
    getCurrentSigma: () => 0.36,
    getCurrentSlippageHaircut: () => 0.85,
    calibrationFor: async () => ({ putCalib: 1.0, callCalib: 1.0, riskFreeRate: 0.045 }),
    pollPeriodMs: 50,
    log: () => {}
  }, triggered);
  await rt.init();
  rt.forceClose();
  await rt.tick(TRIGGERED_AT + 2 * 60_000);

  const balance = await getPoolBalance(pool);
  assert.ok(balance.unsettledUsdc > 0, `expected accrual, got ${balance.unsettledUsdc}`);
  assert.equal(balance.entryCount, 1);
});
