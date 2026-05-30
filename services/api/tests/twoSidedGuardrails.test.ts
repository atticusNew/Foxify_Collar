/**
 * PR 9 tests — guardrails (halt ladder + dollar kill + concurrent throttle).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  recordPairEvent,
  updatePairStatus
} from "../src/singleSide/twoSided/db";
import {
  ensureGuardrailsSchema,
  getHaltState,
  recordHalt,
  clearHalt,
  canActivate,
  canUnwind,
  evaluateAutoHalts,
  DVOL_HALT_THRESHOLD,
  DEFAULT_KILL_THRESHOLDS
} from "../src/singleSide/twoSided/guardrails";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureGuardrailsSchema(pool);
  return pool;
};

const seedSettledPair = async (
  pool: Awaited<ReturnType<typeof buildPool>>,
  args: { pairId: string; foxifyShare: number; hedgeCost?: number; closedAtIso: string; isShadow?: boolean }
) => {
  const hedge = args.hedgeCost ?? 3_200;
  const p = await insertPair(pool, {
    pairId: args.pairId,
    cellId: "pair_50k_2pct",
    foxifyPairRef: args.pairId + "-ref",
    spotAtActivation: 76_000,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480,
    triggerUpPrice: 77_520,
    hedgeTenorDays: 3,
    expiresAt: "2026-05-30T18:00:00Z",
    tpForceExitAt: "2026-05-30T14:00:00Z",
    hedgeCostTotalUsdc: hedge,
    foxifyCapitalFundedUsdc: hedge,
    tierAtActivation: "tier_1",
    atticusFloorUsdc: 25,
    metadata: {},
    isShadow: args.isShadow ?? false,
    status: "pending"
  });
  await updatePairStatus(pool, p.pairId, "active");
  await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: args.closedAtIso, triggerSide: "down" });
  await updatePairStatus(pool, p.pairId, "unwinding");
  await updatePairStatus(pool, p.pairId, "settled", {
    closedAt: args.closedAtIso,
    closedReason: "trigger",
    salvageProceedsUsdc: args.foxifyShare + 100,
    upliftUsdc: args.foxifyShare - hedge,
    foxifyShareUsdc: args.foxifyShare,
    atticusShareUsdc: 100,
    exitMode: "capture_window_peak"
  });
};

// ─── Halt state ───

test("recordHalt + getHaltState: foxify halt", async () => {
  const pool = await buildPool();
  await recordHalt(pool, "foxify", "manual_foxify", "foxify_ops", "scheduled maintenance");
  const s = await getHaltState(pool);
  assert.equal(s.foxifyHalt, true);
  assert.equal(s.atticusHalt, false);
  assert.equal(s.foxifyHaltReason, "manual_foxify");
});

test("clearHalt: removes halt + records auto_resume vs manual clear", async () => {
  const pool = await buildPool();
  await recordHalt(pool, "atticus", "feed_stale");
  await clearHalt(pool, "atticus", "system", "feed back online", true);
  const s = await getHaltState(pool);
  assert.equal(s.atticusHalt, false);
});

// ─── canActivate ───

test("canActivate: ok when no halts and conditions normal", async () => {
  const pool = await buildPool();
  const r = await canActivate(pool, { dvol: 38, capitalAvailableUsdc: 10_000, pairHedgeCostUsdc: 3_200 });
  assert.equal(r.ok, true);
});

test("canActivate: rejects when DVOL > 60", async () => {
  const pool = await buildPool();
  const r = await canActivate(pool, { dvol: 75, capitalAvailableUsdc: 10_000, pairHedgeCostUsdc: 3_200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dvol_high");
});

test("canActivate: rejects when capital pool < 1.5× hedge cost", async () => {
  const pool = await buildPool();
  const r = await canActivate(pool, { dvol: 38, capitalAvailableUsdc: 4_000, pairHedgeCostUsdc: 3_200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "capital_pool_low");
});

test("canActivate: rejects when foxify halt active", async () => {
  const pool = await buildPool();
  await recordHalt(pool, "foxify", "manual_foxify");
  const r = await canActivate(pool, { dvol: 38, capitalAvailableUsdc: 10_000, pairHedgeCostUsdc: 3_200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "manual_foxify");
});

test("canActivate: rejects when atticus halt active", async () => {
  const pool = await buildPool();
  await recordHalt(pool, "atticus", "rolling_salvage_low");
  const r = await canActivate(pool, { dvol: 38, capitalAvailableUsdc: 10_000, pairHedgeCostUsdc: 3_200 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "rolling_salvage_low");
});

// ─── Concurrent unwind throttle ───

test("canUnwind: ok with 0 concurrent unwinds", async () => {
  const pool = await buildPool();
  const r = await canUnwind(pool);
  assert.equal(r.ok, true);
  assert.equal(r.concurrentNow, 0);
});

test("canUnwind: defer when >= max concurrent in window", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Need real pairs to log events against
  const p1 = await insertPair(pool, {
    pairId: "u1", cellId: "pair_50k_2pct", foxifyPairRef: "u1r",
    spotAtActivation: 76_000, feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480, triggerUpPrice: 77_520, hedgeTenorDays: 3,
    expiresAt: "2026-05-30T18:00:00Z", tpForceExitAt: "2026-05-30T14:00:00Z",
    hedgeCostTotalUsdc: 3_200, foxifyCapitalFundedUsdc: 3_200,
    tierAtActivation: "tier_1", atticusFloorUsdc: 25, metadata: {}
  });
  const p2 = await insertPair(pool, {
    pairId: "u2", cellId: "pair_50k_2pct", foxifyPairRef: "u2r",
    spotAtActivation: 76_000, feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480, triggerUpPrice: 77_520, hedgeTenorDays: 3,
    expiresAt: "2026-05-30T18:00:00Z", tpForceExitAt: "2026-05-30T14:00:00Z",
    hedgeCostTotalUsdc: 3_200, foxifyCapitalFundedUsdc: 3_200,
    tierAtActivation: "tier_1", atticusFloorUsdc: 25, metadata: {}
  });
  // Record 2 unwinding_started events within window
  await recordPairEvent(pool, { pairId: p1.pairId, kind: "unwinding_started", details: {} });
  await recordPairEvent(pool, { pairId: p2.pairId, kind: "unwinding_started", details: {} });
  const r = await canUnwind(pool, { nowMs: now, maxConcurrent: 2, windowMs: 60_000 });
  assert.equal(r.ok, false);
  assert.match(r.deferReason ?? "", /concurrent_unwind_throttle/);
});

// ─── Dollar kill-ladder ───

test("evaluateAutoHalts: per-pair loss kill fires on deep loss", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Seed a deep loss pair: foxify share 1000, hedge 3200 → net -2200 (worse than -2000 threshold)
  await seedSettledPair(pool, {
    pairId: "deep-loss",
    foxifyShare: 1_000,
    hedgeCost: 3_200,
    closedAtIso: new Date(now - 3_600_000).toISOString()
  });
  const r = await evaluateAutoHalts(pool, DEFAULT_KILL_THRESHOLDS, { nowMs: now });
  assert.equal(r.shouldHalt, true);
  assert.equal(r.reason, "per_pair_loss");
});

test("evaluateAutoHalts: shadow loss does NOT trigger halt", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await seedSettledPair(pool, {
    pairId: "shadow-loss",
    foxifyShare: 1_000,
    hedgeCost: 3_200,
    closedAtIso: new Date(now - 3_600_000).toISOString(),
    isShadow: true
  });
  const r = await evaluateAutoHalts(pool, DEFAULT_KILL_THRESHOLDS, { nowMs: now });
  assert.equal(r.shouldHalt, false);
});

test("evaluateAutoHalts: no halt when conditions normal", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await seedSettledPair(pool, { pairId: "w1", foxifyShare: 3_700, hedgeCost: 3_200, closedAtIso: new Date(now - 3_600_000).toISOString() });
  await seedSettledPair(pool, { pairId: "w2", foxifyShare: 3_800, hedgeCost: 3_200, closedAtIso: new Date(now - 3_600_000).toISOString() });
  const r = await evaluateAutoHalts(pool, DEFAULT_KILL_THRESHOLDS, { nowMs: now });
  assert.equal(r.shouldHalt, false);
});

test("DVOL_HALT_THRESHOLD is 60 (B2 finding)", () => {
  assert.equal(DVOL_HALT_THRESHOLD, 60);
});
