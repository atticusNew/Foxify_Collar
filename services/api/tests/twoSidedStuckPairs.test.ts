/**
 * Tests — detectStuckPairs (stale / out-of-band-closed pair detector).
 *
 * Verifies:
 *   - a stale 'unwinding' pair with NO runtime → likely_out_of_band:true
 *   - a fresh 'active' pair → not flagged
 *   - an 'unwinding' pair WITH a runtime → not flagged (use respawn-close)
 *   - settled/cancelled pairs are excluded entirely
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
import { detectStuckPairs } from "../src/singleSide/twoSided/stuckPairs";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const NOW = Date.parse("2026-06-02T12:00:00Z");
const EXPIRES_AT = NOW + 86_400_000;

type Pool = Awaited<ReturnType<typeof buildPool>>;

const seed = async (pool: Pool, pairId: string, status: "active" | "triggered" | "unwinding") => {
  await insertPair(pool, {
    pairId, cellId: "pair_25k_5otm_strangle_1d", foxifyPairRef: `fxy-${pairId}`,
    spotAtActivation: 71_500, feedSnapshotAtActivation: {}, triggerDownPrice: 69_355, triggerUpPrice: 73_645,
    hedgeTenorDays: 1, expiresAt: new Date(EXPIRES_AT).toISOString(), tpForceExitAt: new Date(EXPIRES_AT - 4 * 3_600_000).toISOString(),
    hedgeCostTotalUsdc: 22.53, foxifyCapitalFundedUsdc: 22.53, tierAtActivation: "tier_2", atticusFloorUsdc: 30,
    metadata: {}, status: "pending", isShadow: false
  });
  await insertPairLeg(pool, {
    legId: `${pairId}-put`, pairId, legRole: "long_put", venue: "deribit", symbol: "BTC-3JUN26-68000-P",
    strikeUsdc: 68_000, contractsBtc: 0.35, buyAskUsdcPerBtc: 42.92, buyCostUsdc: 15.02,
    buyFilledAt: new Date(NOW - 3_600_000).toISOString(), liveAnchorAskUsdcPerBtc: 42.92, liveAnchorPulledAt: new Date(NOW - 3_600_000).toISOString(), metadata: {}
  });
  await insertPairLeg(pool, {
    legId: `${pairId}-call`, pairId, legRole: "long_call", venue: "deribit", symbol: "BTC-3JUN26-75000-C",
    strikeUsdc: 75_000, contractsBtc: 0.35, buyAskUsdcPerBtc: 21.46, buyCostUsdc: 7.51,
    buyFilledAt: new Date(NOW - 3_600_000).toISOString(), liveAnchorAskUsdcPerBtc: 21.46, liveAnchorPulledAt: new Date(NOW - 3_600_000).toISOString(), metadata: {}
  });
  await updatePairStatus(pool, pairId, "active");
  if (status === "triggered" || status === "unwinding") {
    await updatePairStatus(pool, pairId, "triggered", { triggeredAt: new Date(NOW).toISOString(), triggerSide: "down" });
  }
  if (status === "unwinding") await updatePairStatus(pool, pairId, "unwinding");
};

test("detectStuckPairs: stale unwinding pair with no runtime → likely_out_of_band", async () => {
  const pool = await buildPool();
  await seed(pool, "stuck-1", "unwinding");
  // 60 min after its updated_at, no runtime tracked.
  const report = await detectStuckPairs(pool, { staleMinutes: 15, nowMs: NOW + 60 * 60_000, hasRuntime: () => false });
  assert.equal(report.total_non_terminal, 1);
  assert.equal(report.likely_out_of_band_count, 1);
  const p = report.pairs[0];
  assert.equal(p.pair_id, "stuck-1");
  assert.equal(p.status, "unwinding");
  assert.equal(p.has_runtime, false);
  assert.equal(p.likely_out_of_band, true);
  assert.ok(p.age_minutes >= 15);
});

test("detectStuckPairs: fresh active pair → not flagged", async () => {
  const pool = await buildPool();
  await seed(pool, "active-1", "active");
  const report = await detectStuckPairs(pool, { staleMinutes: 15, nowMs: NOW + 60 * 60_000, hasRuntime: () => false });
  const p = report.pairs.find((x) => x.pair_id === "active-1")!;
  assert.equal(p.status, "active");
  assert.equal(p.likely_out_of_band, false, "active pairs are never flagged out-of-band");
  assert.equal(report.likely_out_of_band_count, 0);
});

test("detectStuckPairs: unwinding pair WITH a runtime → not flagged (use respawn-close)", async () => {
  const pool = await buildPool();
  await seed(pool, "unwind-rt", "unwinding");
  const report = await detectStuckPairs(pool, { staleMinutes: 15, nowMs: NOW + 60 * 60_000, hasRuntime: (id) => id === "unwind-rt" });
  const p = report.pairs.find((x) => x.pair_id === "unwind-rt")!;
  assert.equal(p.has_runtime, true);
  assert.equal(p.likely_out_of_band, false, "a live runtime is driving the close — not out-of-band");
});

test("detectStuckPairs: settled / cancelled pairs excluded", async () => {
  const pool = await buildPool();
  await seed(pool, "to-settle", "unwinding");
  await updatePairStatus(pool, "to-settle", "settled", {
    closedAt: new Date(NOW).toISOString(), closedReason: "foxify_close",
    salvageProceedsUsdc: 18, upliftUsdc: -4.53, foxifyShareUsdc: 18, atticusShareUsdc: 0, exitMode: "foxify_close"
  });
  const report = await detectStuckPairs(pool, { nowMs: NOW + 60 * 60_000, hasRuntime: () => false });
  assert.equal(report.total_non_terminal, 0);
  assert.equal(report.pairs.length, 0);
});
