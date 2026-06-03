/**
 * countValidatedSettlementsByRegime — the STRICT newborn-review validation counter:
 * only ORGANIC (not seeded) + PRODUCTION-cell settled pairs in the regime count.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema, insertPair, countSettledPairsByRegime, countValidatedSettlementsByRegime } from "../src/singleSide/twoSided/db";

const PROD = ["pair_50k_3pct_atm_3d", "pair_150k_3pct_atm_3d", "pair_10k_atm_2d"];

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const addSettled = async (pool: Pool, o: { regime: string; cell: string; seeded?: boolean }) => {
  const pairId = randomUUID();
  await insertPair(pool, {
    pairId, cellId: o.cell, foxifyPairRef: `r-${pairId}`, isShadow: true,
    spotAtActivation: 70_000, feedSnapshotAtActivation: {}, triggerDownPrice: 68_000, triggerUpPrice: 72_000,
    hedgeTenorDays: 3, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    tpForceExitAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    hedgeCostTotalUsdc: 500, foxifyCapitalFundedUsdc: 500, tierAtActivation: "tier_1",
    atticusFloorUsdc: 25, metadata: o.seeded ? { source: "shadow_test_activate" } : {},
    regimeAtActivation: o.regime as never, status: "active" as never
  });
  await pool.query(`UPDATE two_sided_pair SET status='settled', foxify_share_usdc=480 WHERE pair_id=$1`, [pairId]);
};

test("countValidatedSettlementsByRegime: organic + production-cell only", async () => {
  const pool = await buildPool();
  await addSettled(pool, { regime: "moderate", cell: "pair_50k_3pct_atm_3d" });            // ✓ organic + production
  await addSettled(pool, { regime: "moderate", cell: "pair_10k_atm_2d" });                 // ✓ organic + production
  await addSettled(pool, { regime: "moderate", cell: "pair_50k_3pct_atm_3d", seeded: true }); // ✗ seeded
  await addSettled(pool, { regime: "moderate", cell: "pair_50k_2pct" });                    // ✗ deprecated cell
  await addSettled(pool, { regime: "calm", cell: "pair_50k_3pct_atm_3d" });                 // counts for CALM, not moderate

  // Loose counter sees all 4 moderate settled (incl seeded + deprecated).
  assert.equal(await countSettledPairsByRegime(pool, "moderate"), 4);
  // Strict counter: only the 2 organic production-cell moderate pairs.
  assert.equal(await countValidatedSettlementsByRegime(pool, "moderate", PROD), 2);
  // The calm pair is organic + production → counts for CALM (regime-scoped), not moderate.
  assert.equal(await countValidatedSettlementsByRegime(pool, "calm", PROD), 1);
});
