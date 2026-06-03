/**
 * Settlement funnel — verifies the open/settled/excluded breakdown that explains
 * why active positions don't (yet) feed the realized-vs-MC gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema, insertPair } from "../src/singleSide/twoSided/db";
import { getSettlementFunnel } from "../src/singleSide/twoSided/settlementFunnel";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const add = async (pool: Pool, o: {
  isShadow: boolean; status: string; regime?: string | null; cell?: string; settled?: boolean; seeded?: boolean;
}) => {
  const pairId = randomUUID();
  await insertPair(pool, {
    pairId, cellId: o.cell ?? "pair_50k_3pct_atm_3d", foxifyPairRef: `r-${pairId}`, isShadow: o.isShadow,
    spotAtActivation: 70_000, feedSnapshotAtActivation: {}, triggerDownPrice: 68_000, triggerUpPrice: 72_000,
    hedgeTenorDays: 3, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    tpForceExitAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    hedgeCostTotalUsdc: 500, foxifyCapitalFundedUsdc: 500, tierAtActivation: "tier_1",
    atticusFloorUsdc: 25, metadata: o.seeded ? { source: "shadow_test_activate" } : {},
    regimeAtActivation: (o.regime ?? null) as never, status: o.status as never
  });
  if (o.settled) {
    await pool.query(
      `UPDATE two_sided_pair SET status='settled', foxify_share_usdc=480, closed_at=NOW() WHERE pair_id=$1`,
      [pairId]
    );
  }
};

test("getSettlementFunnel: classifies open / counted / excluded correctly", async () => {
  const pool = await buildPool();
  // OPEN shadow moderate (NOT counted — no realized outcome yet)
  await add(pool, { isShadow: true, status: "active", regime: "moderate" });
  await add(pool, { isShadow: true, status: "triggered", regime: "moderate" });
  // SETTLED shadow moderate, organic, tagged → COUNTED
  await add(pool, { isShadow: true, status: "active", regime: "moderate", settled: true });
  await add(pool, { isShadow: true, status: "active", regime: "moderate", settled: true });
  // SETTLED shadow moderate but SEEDED → excluded
  await add(pool, { isShadow: true, status: "active", regime: "moderate", settled: true, seeded: true });
  // SETTLED shadow UNTAGGED → excluded
  await add(pool, { isShadow: true, status: "active", regime: null, settled: true });
  // REAL pair, open + settled (excluded from shadow gate, tracked separately)
  await add(pool, { isShadow: false, status: "active", regime: "moderate" });
  await add(pool, { isShadow: false, status: "active", regime: "moderate", settled: true });

  const f = await getSettlementFunnel(pool);

  assert.equal(f.shadow.open.total, 2, "2 open shadow positions");
  assert.equal(f.shadow.open.by_regime.moderate, 2);
  assert.equal(f.shadow.settled.total, 4, "4 settled shadow (2 counted + 1 seeded + 1 untagged)");
  assert.equal(f.shadow.settled.counted_in_gate, 2, "only tagged+organic+settled count");
  assert.equal(f.shadow.settled.counted_by_regime.moderate, 2);
  assert.equal(f.shadow.settled.counted_by_cell.pair_50k_3pct_atm_3d, 2);
  assert.equal(f.shadow.settled.excluded_seeded, 1);
  assert.equal(f.shadow.settled.excluded_untagged, 1);
  // Real pairs tracked separately, NOT in the shadow gate counts.
  assert.equal(f.live.open, 1);
  assert.equal(f.live.settled, 1);
});
