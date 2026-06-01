/**
 * realized-vs-MC reconciliation — realized aggregation + regime-at-activation
 * filtering (exact gate) + comparison structure. Pure real data, no synthetics.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { getRealizedShadowStats, reconcileRealizedVsMc } from "../src/singleSide/twoSided/realizedVsMc";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { __resetCalibrationCache } from "../src/singleSide/twoSided/regimeCalibration";
import type { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  db.public.registerFunction({ name: "now", returns: DataType.timestamptz, implementation: () => new Date() });
  return new (db.adapters.createPg().Pool)();
};

let refSeq = 0;
const insertSettled = async (pool: Pool, cellId: string, cost: number, foxifyShare: number, exitMode: string, regime: string | null, source?: string) => {
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status, foxify_pair_ref, spot_at_activation,
       trigger_down_price, trigger_up_price, hedge_tenor_days, expires_at, tp_force_exit_at,
       hedge_cost_total_usdc, foxify_capital_funded_usdc, tier_at_activation, atticus_floor_usdc,
       is_shadow, regime_at_activation, salvage_proceeds_usdc, foxify_share_usdc, atticus_share_usdc, exit_mode, metadata)
     VALUES ($1,$2,'settled',$3,73000, 71000,75000,3, NOW(), NOW(),
       $4,$4,'tier_1',25, TRUE, $5, $6, $6, 0, $7, $8::jsonb)`,
    [randomUUID(), cellId, `ref-${refSeq++}`, cost, regime, foxifyShare, exitMode,
     source ? JSON.stringify({ source }) : "{}"]
  );
};

test("realized: aggregates settled shadow pairs per cell + reports tag coverage", async () => {
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await insertSettled(pool, "pair_50k_2pct", 1000, 900, "no_trigger_expiry", "moderate"); // -100
  await insertSettled(pool, "pair_50k_2pct", 1000, 850, "no_trigger_expiry", "moderate"); // -150
  await insertSettled(pool, "pair_50k_2pct", 1000, 1300, "foxify_close", "elevated");     // +300
  await insertSettled(pool, "pair_50k_2pct", 1000, 1100, "foxify_close", null);           // +100 untagged
  const all = await getRealizedShadowStats(pool); // no filter
  assert.equal(all.taggedPairs, 3);
  assert.equal(all.untaggedPairs, 1);
  const a = all.stats.find((s) => s.cellId === "pair_50k_2pct")!;
  assert.equal(a.n, 4, "no filter -> all 4 counted");
  // regime filter: only the 2 moderate pairs
  const mod = await getRealizedShadowStats(pool, { regime: "moderate" });
  const am = mod.stats.find((s) => s.cellId === "pair_50k_2pct")!;
  assert.equal(am.n, 2, "moderate filter -> 2 pairs");
  assert.ok(Math.abs(am.meanRealizedNetUsdc - (-125)) < 0.01, `moderate mean ${am.meanRealizedNetUsdc}`);
  await pool.end();
});

test("organic-only: excludes force-triggered/test-activated pairs (source=shadow_test_activate)", async () => {
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  // 2 organic (auto-loop) calm pairs + 3 forced/test calm pairs.
  await insertSettled(pool, "pair_25k_5pct_otm_3d", 250, 230, "no_trigger_expiry", "calm", "shadow_auto_activator"); // -20 organic
  await insertSettled(pool, "pair_25k_5pct_otm_3d", 250, 210, "no_trigger_expiry", "calm", "shadow_auto_activator"); // -40 organic
  await insertSettled(pool, "pair_25k_5pct_otm_3d", 250, 240, "capture_window_peak", "calm", "shadow_test_activate"); // forced
  await insertSettled(pool, "pair_25k_5pct_otm_3d", 250, 245, "capture_window_peak", "calm", "shadow_test_activate"); // forced
  await insertSettled(pool, "pair_25k_5pct_otm_3d", 250, 248, "capture_window_peak", "calm", "shadow_test_activate"); // forced

  const all = await getRealizedShadowStats(pool, { regime: "calm" });
  assert.equal(all.stats.find((s) => s.cellId === "pair_25k_5pct_otm_3d")!.n, 5, "no filter -> all 5");
  assert.equal(all.forcedExcluded, 0);

  const organic = await getRealizedShadowStats(pool, { regime: "calm", organicOnly: true });
  const o = organic.stats.find((s) => s.cellId === "pair_25k_5pct_otm_3d")!;
  assert.equal(o.n, 2, "organic-only -> only the 2 auto-loop pairs");
  assert.equal(organic.forcedExcluded, 3, "3 force-triggered/test pairs excluded");
  assert.ok(Math.abs(o.meanRealizedNetUsdc - (-30)) < 0.01, `organic mean ${o.meanRealizedNetUsdc}`);
  await pool.end();
});

test("reconcile: regime-filters realized to match the MC regime (exact gate)", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // 2 calm pairs (counted) + 1 moderate (excluded when reconciling calm)
  await insertSettled(pool, "pair_50k_3pct_atm_3d", 1400, 1208, "foxify_close", "calm");
  await insertSettled(pool, "pair_50k_3pct_atm_3d", 1400, 1250, "foxify_close", "calm");
  await insertSettled(pool, "pair_50k_3pct_atm_3d", 1400, 1600, "foxify_close", "moderate");
  const chain = {
    getBidForSymbol: () => null,
    getBidForLeg: (o: { strike: number; optType: "put" | "call" }) => ({
      bidUsdcPerBtc: 1000, askUsdcPerBtc: 1100, midUsdcPerBtc: 1050, spreadPct: 0.1,
      venue: "deribit" as const, instrumentName: `BTC-${o.strike}-${o.optType.toUpperCase()}`,
      tenorHours: 72, markIv: 0.4, pulledAtMs: Date.now()
    }),
    getCached: () => null
  } as unknown as LiquidChainCache;
  const report = await reconcileRealizedVsMc(pool, { regime: "calm", spot: 73000, liquidChainCache: chain, nPaths: 100 });
  const row = report.rows.find((r) => r.cell_id === "pair_50k_3pct_atm_3d")!;
  assert.equal(row.realized_n, 2, "only the 2 calm-tagged pairs counted");
  assert.ok(Math.abs(row.realized_mean_net_usdc - ((-192 - 150) / 2)) < 0.01);
  assert.equal(report.regime_tagged_pairs, 3);
  assert.equal(report.untagged_pairs, 0);
  assert.equal(row.mc_status, "ok");
  assert.equal(typeof row.within_15pct, "boolean");
  await pool.end();
});

test("reconcile: cell not in config is flagged (no MC)", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  await insertSettled(pool, "some_legacy_cell_xyz", 500, 600, "foxify_close", "calm");
  const chain = { getBidForSymbol: () => null, getBidForLeg: () => null, getCached: () => null } as unknown as LiquidChainCache;
  const report = await reconcileRealizedVsMc(pool, { regime: "calm", spot: 73000, liquidChainCache: chain, nPaths: 50 });
  const row = report.rows.find((r) => r.cell_id === "some_legacy_cell_xyz")!;
  assert.equal(row.mc_status, "cell_not_in_config");
  assert.equal(row.mc_predicted_net_usdc, null);
  assert.equal(row.within_15pct, null);
  await pool.end();
});
