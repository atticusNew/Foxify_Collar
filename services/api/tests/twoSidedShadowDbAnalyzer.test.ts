/**
 * Smoke test for shadowDbAnalyzer's SQL against pg-mem with sample data.
 *
 * Verifies:
 *   - The SELECT statement parses + executes against the real schema
 *   - Aggregation logic groups by cell × regime × mode correctly
 *   - Foxify EV math = foxify_share - hedge_cost
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema, insertPair, insertLeg, updatePairStatus } from "../src/singleSide/twoSided/db";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

test("shadowDbAnalyzer SQL works against real schema", async () => {
  const pool = await buildPool();

  // Seed 3 shadow pairs in moderate regime, 1 live pair in elevated
  const pairs = [
    { pair_id: "p1", cell_id: "pair_25k_5pct_otm_3d", regime: "moderate", isShadow: true,  hedgeCost: 300, salvage: 700, foxifyShare: 660, atticusShare: 40 },
    { pair_id: "p2", cell_id: "pair_25k_5pct_otm_3d", regime: "moderate", isShadow: true,  hedgeCost: 320, salvage: 500, foxifyShare: 480, atticusShare: 20 },
    { pair_id: "p3", cell_id: "pair_25k_5pct_otm_3d", regime: "moderate", isShadow: true,  hedgeCost: 310, salvage: 800, foxifyShare: 760, atticusShare: 50 },
    { pair_id: "p4", cell_id: "pair_50k_5pct_otm",    regime: "elevated", isShadow: false, hedgeCost: 1500, salvage: 3000, foxifyShare: 2800, atticusShare: 200 }
  ];
  for (const p of pairs) {
    await insertPair(pool, {
      pairId: p.pair_id,
      cellId: p.cell_id,
      foxifyPairRef: `ref-${p.pair_id}`,
      spotAtActivation: 74_000,
      feedSnapshotAtActivation: {},
      triggerDownPrice: 70_000,
      triggerUpPrice: 78_000,
      hedgeTenorDays: 3,
      expiresAt: new Date(Date.now() + 3 * 86_400_000),
      tpForceExitAt: new Date(Date.now() + 2.9 * 86_400_000),
      hedgeCostTotalUsdc: p.hedgeCost,
      foxifyCapitalFundedUsdc: 25_000,
      tierAtActivation: "tier_1",
      atticusFloorUsdc: 25,
      isShadow: p.isShadow,
      metadata: { regime: p.regime, source: "test" }
    });
    await updatePairStatus(pool, p.pair_id, "active");
    await updatePairStatus(pool, p.pair_id, "triggered", { triggeredAt: new Date(), triggerSide: "down" });
    await updatePairStatus(pool, p.pair_id, "unwinding");
    await updatePairStatus(pool, p.pair_id, "settled", {
      salvageProceedsUsdc: p.salvage,
      upliftUsdc: p.salvage - p.hedgeCost,
      foxifyShareUsdc: p.foxifyShare,
      atticusShareUsdc: p.atticusShare,
      closedAt: new Date(),
      closedReason: "trigger",
      exitMode: "capture_window_peak"
    });
  }

  // Run the analyzer's SELECT against pg-mem
  const result = await pool.query(`
    SELECT
      pair_id, cell_id, status, is_shadow, created_at, closed_at,
      spot_at_activation, hedge_cost_total_usdc, salvage_proceeds_usdc,
      foxify_share_usdc, atticus_share_usdc, uplift_usdc,
      triggered_at, trigger_side, closed_reason, tier_at_activation, metadata
    FROM two_sided_pair
    WHERE status IN ('settled', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 5000
  `);
  assert.equal(result.rows.length, 4);

  // Verify field shapes
  for (const r of result.rows) {
    assert.ok(r.pair_id);
    assert.ok(r.cell_id);
    assert.ok(r.metadata);
    assert.equal(typeof r.is_shadow, "boolean");
  }

  // Aggregation simulation: group by cell × regime × mode
  type Agg = { cellId: string; regime: string; isShadow: boolean; n: number; sumFoxEv: number };
  const groups = new Map<string, Agg>();
  for (const r of result.rows) {
    const regime = (r.metadata?.regime as string) ?? "unknown";
    const key = `${r.cell_id}::${regime}::${r.is_shadow}`;
    const fEv = Number(r.foxify_share_usdc ?? 0) - Number(r.hedge_cost_total_usdc ?? 0);
    let g = groups.get(key);
    if (!g) { g = { cellId: r.cell_id, regime, isShadow: r.is_shadow, n: 0, sumFoxEv: 0 }; groups.set(key, g); }
    g.n++;
    g.sumFoxEv += fEv;
  }

  // moderate shadow on pair_25k_5pct_otm_3d should have 3 pairs
  const modShadow = groups.get("pair_25k_5pct_otm_3d::moderate::true");
  assert.equal(modShadow?.n, 3);
  // Mean Foxify EV per pair = ((660-300) + (480-320) + (760-310)) / 3 = (360 + 160 + 450) / 3 = 323.33
  const meanFoxEv = modShadow!.sumFoxEv / modShadow!.n;
  assert.ok(Math.abs(meanFoxEv - 323.33) < 1);

  // elevated live on pair_50k_5pct_otm should have 1 pair, EV = 2800 - 1500 = 1300
  const elvLive = groups.get("pair_50k_5pct_otm::elevated::false");
  assert.equal(elvLive?.n, 1);
  assert.equal(elvLive!.sumFoxEv, 1300);
});

test("shadowDbAnalyzer SQL handles empty DB gracefully", async () => {
  const pool = await buildPool();
  const result = await pool.query(`
    SELECT * FROM two_sided_pair WHERE status IN ('settled', 'cancelled') ORDER BY created_at DESC LIMIT 100
  `);
  assert.equal(result.rows.length, 0);
});
