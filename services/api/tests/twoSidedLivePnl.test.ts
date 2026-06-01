/**
 * Tests — computeLivePnl (real-money settled-pair P&L rollup).
 *
 * The loss-leader scorecard is shadow-only (is_shadow=TRUE); this is its live
 * counterpart. Verifies it counts ONLY settled is_shadow=FALSE pairs, computes
 * Foxify net / wins / losses correctly, surfaces the reconciled flag, and
 * excludes shadow + non-settled pairs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  updatePairStatus
} from "../src/singleSide/twoSided/db";
import { computeLivePnl } from "../src/singleSide/twoSided/livePnl";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const NOW = Date.parse("2026-06-02T12:00:00Z");
const EXPIRES_AT = NOW + 86_400_000;

type Pool = Awaited<ReturnType<typeof buildPool>>;

const seedSettled = async (
  pool: Pool,
  opts: {
    pairId: string;
    cellId?: string;
    isShadow: boolean;
    hedgeCost: number;
    salvage: number;
    foxifyShare: number;
    atticusShare: number;
    reconciled?: boolean;
  }
) => {
  await insertPair(pool, {
    pairId: opts.pairId,
    cellId: opts.cellId ?? "pair_25k_5otm_strangle_1d",
    foxifyPairRef: `fxy-${opts.pairId}`,
    spotAtActivation: 71_500,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 69_355,
    triggerUpPrice: 73_645,
    hedgeTenorDays: 1,
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    tpForceExitAt: new Date(EXPIRES_AT - 4 * 3_600_000).toISOString(),
    hedgeCostTotalUsdc: opts.hedgeCost,
    foxifyCapitalFundedUsdc: opts.hedgeCost,
    tierAtActivation: "tier_2",
    atticusFloorUsdc: 30,
    metadata: opts.reconciled ? { reconciled: true } : {},
    status: "pending",
    isShadow: opts.isShadow
  });
  await updatePairStatus(pool, opts.pairId, "active");
  await updatePairStatus(pool, opts.pairId, "unwinding");
  await updatePairStatus(pool, opts.pairId, "settled", {
    closedAt: new Date(NOW).toISOString(),
    closedReason: "foxify_close",
    salvageProceedsUsdc: opts.salvage,
    upliftUsdc: opts.salvage - opts.hedgeCost,
    foxifyShareUsdc: opts.foxifyShare,
    atticusShareUsdc: opts.atticusShare,
    exitMode: "foxify_close"
  });
};

test("livePnl: counts only settled LIVE pairs; excludes shadow + non-settled", async () => {
  const pool = await buildPool();
  // Live win: salvage 200, cost 22.53 → foxify net positive
  await seedSettled(pool, { pairId: "live-win", isShadow: false, hedgeCost: 22.53, salvage: 200, foxifyShare: 170, atticusShare: 30, reconciled: true });
  // Live loss: salvage 5 < cost 22.53 → foxify share = salvage (loss path), net negative
  await seedSettled(pool, { pairId: "live-loss", isShadow: false, hedgeCost: 22.53, salvage: 5, foxifyShare: 5, atticusShare: 0 });
  // Shadow pair — must be EXCLUDED
  await seedSettled(pool, { pairId: "shadow-1", isShadow: true, hedgeCost: 22.53, salvage: 300, foxifyShare: 260, atticusShare: 40 });
  // Non-settled live pair (active) — must be EXCLUDED
  await insertPair(pool, {
    pairId: "live-active", cellId: "pair_25k_5otm_strangle_1d", foxifyPairRef: "fxy-active",
    spotAtActivation: 71_500, feedSnapshotAtActivation: {}, triggerDownPrice: 69_355, triggerUpPrice: 73_645,
    hedgeTenorDays: 1, expiresAt: new Date(EXPIRES_AT).toISOString(), tpForceExitAt: new Date(EXPIRES_AT - 4 * 3_600_000).toISOString(),
    hedgeCostTotalUsdc: 22.53, foxifyCapitalFundedUsdc: 22.53, tierAtActivation: "tier_2", atticusFloorUsdc: 30,
    metadata: {}, status: "pending", isShadow: false
  });
  await updatePairStatus(pool, "live-active", "active");

  const out = await computeLivePnl(pool);
  assert.equal(out.overall.n, 2, "only the 2 settled live pairs");
  // Foxify nets: win 170-22.53=147.47 ; loss 5-22.53=-17.53 → total 129.94
  assert.equal(out.overall.foxify_net_usdc, 129.94);
  assert.equal(out.overall.wins.count, 1);
  assert.equal(out.overall.losses.count, 1);
  assert.equal(out.overall.atticus_share_usdc, 30);
  assert.equal(out.overall.total_cost_usdc, 45.06);
  assert.equal(out.overall.total_salvage_usdc, 205);

  // Reconciled flag surfaced on the win pair.
  const winPair = out.pairs.find((p) => p.pair_id === "live-win")!;
  assert.equal(winPair.reconciled, true);
  assert.equal(winPair.foxify_net_usdc, 147.47);
  const lossPair = out.pairs.find((p) => p.pair_id === "live-loss")!;
  assert.equal(lossPair.reconciled, false);
  assert.equal(lossPair.foxify_net_usdc, -17.53);

  // No shadow / active pair leaked in.
  assert.ok(!out.pairs.some((p) => p.pair_id === "shadow-1"));
  assert.ok(!out.pairs.some((p) => p.pair_id === "live-active"));
});

test("livePnl: empty → n:0 with sane interpretation", async () => {
  const pool = await buildPool();
  const out = await computeLivePnl(pool);
  assert.equal(out.overall.n, 0);
  assert.equal(out.overall.foxify_net_usdc, 0);
  assert.match(out.interpretation, /No settled LIVE/);
});

test("livePnl: cells filter limits to requested cell", async () => {
  const pool = await buildPool();
  await seedSettled(pool, { pairId: "a", cellId: "cell_a", isShadow: false, hedgeCost: 20, salvage: 50, foxifyShare: 45, atticusShare: 5 });
  await seedSettled(pool, { pairId: "b", cellId: "cell_b", isShadow: false, hedgeCost: 20, salvage: 10, foxifyShare: 10, atticusShare: 0 });
  const out = await computeLivePnl(pool, { cells: ["cell_a"] });
  assert.equal(out.overall.n, 1);
  assert.equal(out.per_cell.length, 1);
  assert.equal(out.per_cell[0].cell_id, "cell_a");
});
