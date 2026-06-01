/**
 * Calm loss-leader cumulative-PnL scorecard.
 *
 * Verifies the scorecard splits WINS (convexity payoffs) from LOSSES (calm bleed),
 * sums cumulative net correctly per-cell + overall, and honours the organic-only
 * filter (force-triggered/test pairs excluded by default).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema, insertPair } from "../src/singleSide/twoSided/db";
import { computeLossLeaderScorecard } from "../src/singleSide/twoSided/lossLeaderScorecard";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const settlePair = async (
  pool: Pool,
  o: { cell: string; cost: number; foxifyShare: number; exitMode: string; source: string; regime?: string }
): Promise<void> => {
  const pairId = randomUUID();
  await insertPair(pool, {
    pairId, cellId: o.cell, foxifyPairRef: `t-${pairId}`, isShadow: true,
    spotAtActivation: 73_000, feedSnapshotAtActivation: {},
    triggerDownPrice: 70_810, triggerUpPrice: 75_190,
    hedgeTenorDays: 2,
    expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    tpForceExitAt: new Date(Date.now() + 2 * 86_400_000 - 4 * 3_600_000).toISOString(),
    hedgeCostTotalUsdc: o.cost, foxifyCapitalFundedUsdc: o.cost,
    tierAtActivation: "tier_1", atticusFloorUsdc: 25,
    metadata: { source: o.source }, regimeAtActivation: (o.regime ?? "calm") as "calm",
    status: "pending"
  });
  await pool.query(
    `UPDATE two_sided_pair SET status='settled', foxify_share_usdc=$2, salvage_proceeds_usdc=$2, exit_mode=$3, closed_at=NOW() WHERE pair_id=$1`,
    [pairId, o.foxifyShare, o.exitMode]
  );
};

// Net = foxify_share − cost. Seed: 3 calm-bleed losses + 1 convexity win on the 2d,
// 1 small loss on the 1d, and 1 FORCED win that must be excluded by organic-only.
const seed = async (pool: Pool) => {
  for (let i = 0; i < 3; i++) {
    await settlePair(pool, { cell: "pair_25k_5otm_strangle_2d", cost: 30, foxifyShare: 5, exitMode: "no_trigger_expiry", source: "calm_loss_leader" }); // net -25
  }
  await settlePair(pool, { cell: "pair_25k_5otm_strangle_2d", cost: 30, foxifyShare: 370, exitMode: "foxify_close", source: "calm_loss_leader" }); // net +340
  await settlePair(pool, { cell: "pair_25k_5otm_strangle_1d", cost: 18, foxifyShare: 2, exitMode: "no_trigger_expiry", source: "calm_loss_leader" }); // net -16
  await settlePair(pool, { cell: "pair_25k_5otm_strangle_2d", cost: 30, foxifyShare: 400, exitMode: "force_expiry", source: "shadow_test_activate" }); // net +370, FORCED → excluded
};

test("scorecard: organic-only splits wins (convexity) vs losses (bleed), sums cumulative net", async () => {
  const pool = await buildPool();
  await seed(pool);
  const sc = await computeLossLeaderScorecard(pool, {}); // default organic_only=true, default cells

  // 2d: 3×(-25) + 1×(+340) = +265; 4 pairs; 1 win, 3 losses
  const c2 = sc.per_cell.find((c) => c.cell_id === "pair_25k_5otm_strangle_2d")!;
  assert.equal(c2.n, 4, "forced pair excluded");
  assert.equal(c2.cumulative_net_usdc, 265);
  assert.equal(c2.wins.count, 1);
  assert.equal(c2.wins.sum_usdc, 340);
  assert.equal(c2.losses.count, 3);
  assert.equal(c2.losses.sum_usdc, -75);
  assert.equal(c2.mean_net_usdc, 66.25);

  // 1d: single -16 loss
  const c1 = sc.per_cell.find((c) => c.cell_id === "pair_25k_5otm_strangle_1d")!;
  assert.equal(c1.n, 1);
  assert.equal(c1.cumulative_net_usdc, -16);
  assert.equal(c1.losses.count, 1);

  // overall: 5 organic pairs, cumulative 265 - 16 = 249; 1 win, 4 losses
  assert.equal(sc.overall.n, 5);
  assert.equal(sc.overall.cumulative_net_usdc, 249);
  assert.equal(sc.overall.wins.count, 1);
  assert.equal(sc.overall.losses.count, 4);
  assert.ok(sc.interpretation.includes("cumulative net +$249"), sc.interpretation);
});

test("scorecard: organic_only=false includes the force-triggered pair", async () => {
  const pool = await buildPool();
  await seed(pool);
  const sc = await computeLossLeaderScorecard(pool, { organicOnly: false });
  const c2 = sc.per_cell.find((c) => c.cell_id === "pair_25k_5otm_strangle_2d")!;
  // now 5 on the 2d: +265 + 370 = +635
  assert.equal(c2.n, 5);
  assert.equal(c2.cumulative_net_usdc, 635);
  assert.equal(c2.wins.count, 2);
  assert.equal(sc.overall.n, 6);
});

test("scorecard: empty when no settled loss-leader pairs", async () => {
  const pool = await buildPool();
  const sc = await computeLossLeaderScorecard(pool, {});
  assert.equal(sc.overall.n, 0);
  assert.equal(sc.overall.cumulative_net_usdc, 0);
  assert.match(sc.interpretation, /No settled organic loss-leader pairs/);
});
