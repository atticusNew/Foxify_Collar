/**
 * PR C9 tests — per-cell metrics + daily report extension.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  updatePairStatus
} from "../src/singleSide/twoSided/db";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { getCellMetrics, getAllActiveCellMetrics, generateDailyReport } from "../src/singleSide/twoSided/dashboardService";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureDeferredPoolSchema(pool);
  return pool;
};

const seedSettledPair = async (pool: Awaited<ReturnType<typeof buildPool>>, pairId: string, cellId: string, foxifyShare: number, hedgeCost = 3_200, salvage = 3_800, triggered = true) => {
  const p = await insertPair(pool, {
    pairId, cellId, foxifyPairRef: pairId + "-r",
    spotAtActivation: 76_000, feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480, triggerUpPrice: 77_520, hedgeTenorDays: 3,
    expiresAt: "2026-05-30T18:00:00Z", tpForceExitAt: "2026-05-30T14:00:00Z",
    hedgeCostTotalUsdc: hedgeCost, foxifyCapitalFundedUsdc: hedgeCost,
    tierAtActivation: "tier_1", atticusFloorUsdc: 25, metadata: {}
  });
  await updatePairStatus(pool, p.pairId, "active");
  const now = new Date().toISOString();
  if (triggered) {
    await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: now, triggerSide: "down" });
  }
  await updatePairStatus(pool, p.pairId, "unwinding");
  await updatePairStatus(pool, p.pairId, "settled", {
    closedAt: now, closedReason: triggered ? "trigger" : "expiry",
    salvageProceedsUsdc: salvage, upliftUsdc: foxifyShare - hedgeCost,
    foxifyShareUsdc: foxifyShare, atticusShareUsdc: 90, exitMode: "capture_window_peak"
  });
};

test("getCellMetrics: aggregates per-cell stats", async () => {
  const pool = await buildPool();
  const since = new Date(Date.now() - 100).toISOString();
  await seedSettledPair(pool, "p1", "pair_50k_2pct", 3_710);
  await seedSettledPair(pool, "p2", "pair_50k_2pct", 3_750, 3_200, 3_840);
  await seedSettledPair(pool, "p3", "pair_50k_5pct_otm", 3_400, 700, 3_500); // different cell
  const m = await getCellMetrics(pool, "pair_50k_2pct", { sinceIso: since });
  assert.equal(m.cellId, "pair_50k_2pct");
  assert.equal(m.pairsActivated, 2);
  assert.equal(m.pairsSettled, 2);
  assert.equal(m.pairsTriggered, 2);
  assert.equal(m.triggerRate, 1.0);
  // Total foxify_ev = (3710-3200) + (3750-3200) = 510 + 550 = 1060
  assert.equal(m.totalFoxifyEvUsdc, 1_060);
  assert.equal(m.meanFoxifyEvUsdc, 530);
});

test("getAllActiveCellMetrics: returns per-cell breakdown for active cells", async () => {
  const pool = await buildPool();
  await seedSettledPair(pool, "p1", "pair_50k_2pct", 3_710);
  await seedSettledPair(pool, "p2", "pair_50k_5pct_otm", 3_400, 700, 3_500);
  const all = await getAllActiveCellMetrics(pool);
  assert.equal(all.length, 2);
  const cellIds = all.map((m) => m.cellId).sort();
  assert.deepEqual(cellIds, ["pair_50k_2pct", "pair_50k_5pct_otm"]);
});

test("generateDailyReport: includes per-cell breakdown section", async () => {
  const pool = await buildPool();
  await seedSettledPair(pool, "p1", "pair_50k_2pct", 3_710);
  await seedSettledPair(pool, "p2", "pair_50k_5pct_otm", 3_400, 700, 3_500);
  const report = await generateDailyReport(pool);
  assert.match(report, /Per-cell breakdown/);
  assert.match(report, /pair_50k_2pct/);
  assert.match(report, /pair_50k_5pct_otm/);
});

test("getCellMetrics: empty result for cell with no activity", async () => {
  const pool = await buildPool();
  const m = await getCellMetrics(pool, "pair_nonexistent");
  assert.equal(m.pairsActivated, 0);
  assert.equal(m.pairsSettled, 0);
  assert.equal(m.totalFoxifyEvUsdc, 0);
  assert.equal(m.triggerRate, 0);
});
