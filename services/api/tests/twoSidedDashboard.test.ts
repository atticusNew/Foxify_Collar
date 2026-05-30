/**
 * PR 8 tests — Foxify dashboard service.
 *
 *  - computeFoxifyStatus: counts + tier + capital position
 *  - getPairDetail: returns pair + legs (or null)
 *  - explainPairOutcome: win/loss/breakeven/not_settled labels + 'why' text
 *  - generateDailyReport: shape contains essentials
 *  - Shadow pairs excluded from default metrics
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  insertPairLeg,
  updatePairStatus
} from "../src/singleSide/twoSided/db";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import {
  computeFoxifyStatus,
  explainPairOutcome,
  generateDailyReport,
  getPairDetail
} from "../src/singleSide/twoSided/dashboardService";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureCellAllowlistSchema(pool);
  await ensureDeferredPoolSchema(pool);
  return pool;
};

const seedPair = async (
  pool: Awaited<ReturnType<typeof buildPool>>,
  args: { pairId: string; isShadow?: boolean; finalStatus?: "active" | "settled" | "cancelled"; settled?: { salvage: number; uplift: number; foxifyShare: number; atticusShare: number; closedAtIso: string } }
) => {
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
    hedgeCostTotalUsdc: 3_200,
    foxifyCapitalFundedUsdc: 3_200,
    tierAtActivation: "tier_1",
    atticusFloorUsdc: 25,
    metadata: {},
    isShadow: args.isShadow ?? false,
    status: "pending"
  });
  await updatePairStatus(pool, p.pairId, "active");
  if (args.finalStatus === "settled" && args.settled) {
    await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: args.settled.closedAtIso, triggerSide: "down" });
    await updatePairStatus(pool, p.pairId, "unwinding");
    await updatePairStatus(pool, p.pairId, "settled", {
      closedAt: args.settled.closedAtIso,
      closedReason: "trigger",
      salvageProceedsUsdc: args.settled.salvage,
      upliftUsdc: args.settled.uplift,
      foxifyShareUsdc: args.settled.foxifyShare,
      atticusShareUsdc: args.settled.atticusShare,
      exitMode: "capture_window_peak"
    });
  } else if (args.finalStatus === "cancelled") {
    // can't go active → cancelled directly per state machine; use pending → cancelled instead
    const cancelP = await insertPair(pool, {
      pairId: args.pairId + "-cancel",
      cellId: "pair_50k_2pct",
      foxifyPairRef: args.pairId + "-cancel-ref",
      spotAtActivation: 76_000,
      feedSnapshotAtActivation: {},
      triggerDownPrice: 74_480,
      triggerUpPrice: 77_520,
      hedgeTenorDays: 3,
      expiresAt: "2026-05-30T18:00:00Z",
      tpForceExitAt: "2026-05-30T14:00:00Z",
      hedgeCostTotalUsdc: 3_200,
      foxifyCapitalFundedUsdc: 3_200,
      tierAtActivation: "tier_1",
      atticusFloorUsdc: 25,
      metadata: {},
      isShadow: args.isShadow ?? false,
      status: "pending"
    });
    await updatePairStatus(pool, cancelP.pairId, "cancelled");
  }
  return p;
};

test("computeFoxifyStatus: counts today's activations + rolling pnl", async () => {
  const pool = await buildPool();
  // Use real current time so seeded pairs (created_at = NOW()) fall within today's window
  const now = Date.now();
  const todayMs = now - 1_000; // 1s ago, guaranteed same UTC day (test crossed midnight before)
  await seedPair(pool, {
    pairId: "p-win",
    finalStatus: "settled",
    settled: { salvage: 3_800, uplift: 600, foxifyShare: 3_710, atticusShare: 90, closedAtIso: new Date(todayMs).toISOString() }
  });
  await seedPair(pool, {
    pairId: "p-loss",
    finalStatus: "settled",
    settled: { salvage: 2_900, uplift: -300, foxifyShare: 2_900, atticusShare: 0, closedAtIso: new Date(todayMs).toISOString() }
  });
  const s = await computeFoxifyStatus(pool, { nowMs: now });
  assert.equal(s.todayPairsActivated, 2);
  assert.equal(s.todayPairsSettled, 2);
  // today_pnl = (3710-3200) + (2900-3200) = 510 - 300 = 210
  assert.equal(s.todayFoxifyPnlUsdc, 210);
});

test("computeFoxifyStatus: current tier reflects 24h rolling count", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Create 30 active pairs in last 24h → tier_2 (25-100)
  for (let i = 0; i < 30; i++) {
    await seedPair(pool, { pairId: `tier-${i}` });
  }
  const s = await computeFoxifyStatus(pool, { nowMs: now });
  assert.equal(s.currentTier.label, "tier_2");
  assert.equal(s.currentTier.atticusPct, 0.13);
});

test("computeFoxifyStatus: shadow pairs excluded from metrics by default", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await seedPair(pool, { pairId: "p-live" });
  await seedPair(pool, { pairId: "p-shadow", isShadow: true });
  await seedPair(pool, { pairId: "p-shadow-2", isShadow: true });
  const s = await computeFoxifyStatus(pool, { nowMs: now });
  // Only the live pair should count in today's metrics
  assert.equal(s.todayPairsActivated, 1);
  assert.equal(s.rolling24hPairsCount, 1);
});

test("getPairDetail: returns pair + legs", async () => {
  const pool = await buildPool();
  const p = await seedPair(pool, { pairId: "p-detail" });
  await insertPairLeg(pool, {
    legId: "leg-1", pairId: p.pairId, legRole: "long_put", venue: "bullish",
    symbol: "BTC-USDC-X-77000-P", strikeUsdc: 77_000, contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_150, buyCostUsdc: 1_610, buyFilledAt: new Date().toISOString(),
    liveAnchorAskUsdcPerBtc: 1_150, liveAnchorPulledAt: new Date().toISOString(), metadata: {}
  });
  const detail = await getPairDetail(pool, p.pairId);
  assert.ok(detail);
  assert.equal(detail!.pair.pairId, p.pairId);
  assert.equal(detail!.legs.length, 1);
});

test("getPairDetail: returns null for unknown pair", async () => {
  const pool = await buildPool();
  assert.equal(await getPairDetail(pool, "nope"), null);
});

test("explainPairOutcome: win path includes 'uplift' phrasing", async () => {
  const pool = await buildPool();
  await seedPair(pool, {
    pairId: "p-w",
    finalStatus: "settled",
    settled: { salvage: 4_000, uplift: 800, foxifyShare: 3_880, atticusShare: 120, closedAtIso: new Date().toISOString() }
  });
  const r = await explainPairOutcome(pool, "p-w");
  assert.ok(r);
  assert.equal(r!.outcome, "win");
  assert.match(r!.why, /uplift|trigger|exit/i);
});

test("explainPairOutcome: loss path includes 'tail' / 'decay' phrasing", async () => {
  const pool = await buildPool();
  await seedPair(pool, {
    pairId: "p-l",
    finalStatus: "settled",
    settled: { salvage: 2_400, uplift: -800, foxifyShare: 2_400, atticusShare: 0, closedAtIso: new Date().toISOString() }
  });
  const r = await explainPairOutcome(pool, "p-l");
  assert.ok(r);
  assert.equal(r!.outcome, "loss");
  // The 'why' for a loss path includes either trigger info or 'theta' / 'decay'
  assert.match(r!.why, /trigger|theta|decay|tail/i);
});

test("explainPairOutcome: active pair returns not_settled", async () => {
  const pool = await buildPool();
  await seedPair(pool, { pairId: "p-active" });
  const r = await explainPairOutcome(pool, "p-active");
  assert.ok(r);
  assert.equal(r!.outcome, "not_settled");
});

test("generateDailyReport: contains essential sections", async () => {
  const pool = await buildPool();
  await seedPair(pool, {
    pairId: "p-rep",
    finalStatus: "settled",
    settled: { salvage: 3_800, uplift: 600, foxifyShare: 3_710, atticusShare: 90, closedAtIso: new Date().toISOString() }
  });
  const report = await generateDailyReport(pool);
  assert.match(report, /Foxify Volume Facility/);
  assert.match(report, /Pairs activated/);
  assert.match(report, /Foxify net P&L/);
  assert.match(report, /Tier:/);
  assert.match(report, /Halts/);
});
