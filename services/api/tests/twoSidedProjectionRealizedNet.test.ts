/**
 * Realized-net projection wiring (Deliverable 1).
 *
 * Verifies:
 *   - getRealizedShadowStats({ returnSamples }) returns raw per-pair nets,
 *     regime-filtered, and is backward-compatible (no nets unless requested).
 *   - projectScaling sources its net distribution per the realized_mode:
 *       off                     -> MC only (net_source="mc")
 *       blend, 0 settlements    -> MC only, BYTE-IDENTICAL to off (regression-safe)
 *       blend, 0<n<N            -> net_source="blend", weight = n/N
 *       replace, n>=N           -> net_source="realized", weight=1, band tracks realized
 *
 * Pure real-style data via pg-mem; no synthetic prices.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { projectScaling } from "../src/singleSide/twoSided/scalingProjection";
import { getRealizedShadowStats } from "../src/singleSide/twoSided/realizedVsMc";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
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

// Real chain stub: ask 2000/leg, bid 1800/leg -> cost = (2000+2000)*contracts.
const chain = {
  getBidForSymbol: () => null,
  getBidForLeg: (o: { strike: number; optType: "put" | "call" }) => ({
    bidUsdcPerBtc: 1800, askUsdcPerBtc: 2000, midUsdcPerBtc: 1900, spreadPct: 0.1,
    venue: "deribit" as const, instrumentName: `BTC-${o.strike}-${o.optType.toUpperCase()}`,
    tenorHours: 72, markIv: 0.5, pulledAtMs: Date.now()
  }),
  getCached: () => null
} as unknown as LiquidChainCache;

let refSeq = 0;
const insertSettled = async (
  pool: Pool, cellId: string, cost: number, foxifyShare: number, regime: string | null,
  opts: { durationDays?: number } = {}
) => {
  // created_at = now - durationDays, closed_at = now → observed hold = durationDays.
  const closed = new Date();
  const created = new Date(closed.getTime() - (opts.durationDays ?? 1) * 86_400_000);
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status, foxify_pair_ref, spot_at_activation,
       trigger_down_price, trigger_up_price, hedge_tenor_days, expires_at, tp_force_exit_at,
       hedge_cost_total_usdc, foxify_capital_funded_usdc, tier_at_activation, atticus_floor_usdc,
       is_shadow, regime_at_activation, salvage_proceeds_usdc, foxify_share_usdc, atticus_share_usdc, exit_mode,
       created_at, closed_at)
     VALUES ($1,$2,'settled',$3,73000, 71000,75000,3, NOW(), NOW(),
       $4,$4,'tier_1',25, TRUE, $5, $6, $6, 0, 'foxify_close', $7::timestamptz, $8::timestamptz)`,
    [randomUUID(), cellId, `ref-${refSeq++}`, cost, regime, foxifyShare, created.toISOString(), closed.toISOString()]
  );
};

const CELL = "pair_50k_3pct_atm_3d";

test("getRealizedShadowStats: returnSamples surfaces raw nets, regime-filtered + backward-compatible", async () => {
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await insertSettled(pool, CELL, 1000, 1500, "moderate"); // +500
  await insertSettled(pool, CELL, 1000, 1300, "moderate"); // +300
  await insertSettled(pool, CELL, 1000, 1900, "elevated"); // +900 (excluded by moderate filter)

  // Without returnSamples -> no nets field (payload stays small).
  const plain = await getRealizedShadowStats(pool, { regime: "moderate" });
  assert.equal(plain.stats.find((s) => s.cellId === CELL)!.nets, undefined);

  // With returnSamples -> raw per-pair nets, regime-filtered to the 2 moderate pairs.
  const withSamples = await getRealizedShadowStats(pool, { regime: "moderate", returnSamples: true });
  const s = withSamples.stats.find((x) => x.cellId === CELL)!;
  assert.equal(s.n, 2);
  assert.deepEqual([...(s.nets ?? [])].sort((a, b) => a - b), [300, 500]);
  await pool.end();
});

test("projectScaling: blend with 0 settlements is byte-identical to off (regression-safe)", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const common = {
    cellId: CELL, regime: "moderate" as const, budgetUsdc: 10_000, spot: 73_000,
    liquidChainCache: chain, days: 10, marketAvailability: 1.0, nRuns: 200, nPaths: 200, seed: 7
  };
  const off = await projectScaling(pool, { ...common, realizedMode: "off" });
  const blend = await projectScaling(pool, { ...common, realizedMode: "blend" });
  assert.equal(off.net_source, "mc");
  assert.equal(blend.net_source, "mc", "no realized data -> MC even in blend mode");
  assert.equal(blend.realized_n, 0);
  assert.equal(blend.blend_weight, 0);
  // Identical numeric output (same rng stream) — the core regression guarantee.
  assert.deepEqual(blend.projection, off.projection);
  await pool.end();
});

test("projectScaling: replace mode with n>=N sources the REAL realized distribution", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // cost per pair from chain = (2000+2000)*(50000/73000) ≈ 2740. Seed 25 settled
  // moderate pairs each netting +500 (foxifyShare = cost + 500), well above N=20.
  const cost = 2740;
  for (let i = 0; i < 25; i++) await insertSettled(pool, CELL, cost, cost + 500, "moderate");

  const r = await projectScaling(pool, {
    cellId: CELL, regime: "moderate", budgetUsdc: 20_000, spot: 73_000,
    liquidChainCache: chain, days: 10, marketAvailability: 1.0, nRuns: 200, nPaths: 200, seed: 7,
    realizedMode: "replace", minValidatedSettlements: 20
  });
  assert.equal(r.net_source, "realized");
  assert.equal(r.realized_n, 25);
  assert.equal(r.blend_weight, 1);
  assert.ok(Math.abs((r.realized_mean_net_usdc ?? 0) - 500) < 0.01, `realized mean ${r.realized_mean_net_usdc}`);
  // Every realized sample is +500, so each opened pair adds +500 → strictly profitable.
  assert.ok(r.projection.cumulative_profit_usdc.p5 > 0, "all-positive realized nets -> profit floor > 0");
  assert.ok(r.caveats.some((c) => c.includes("REAL validated settlement")), "caveat reflects realized source");
  await pool.end();
});

test("projectScaling: blend mode with 0<n<N reports partial blend weight", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // 5 settled moderate pairs, N=20 -> weight = 5/20 = 0.25, net_source="blend".
  for (let i = 0; i < 5; i++) await insertSettled(pool, CELL, 2740, 2740 + 400, "moderate");
  const r = await projectScaling(pool, {
    cellId: CELL, regime: "moderate", budgetUsdc: 20_000, spot: 73_000,
    liquidChainCache: chain, days: 10, marketAvailability: 1.0, nRuns: 200, nPaths: 200, seed: 7,
    realizedMode: "blend", minValidatedSettlements: 20
  });
  assert.equal(r.net_source, "blend");
  assert.equal(r.realized_n, 5);
  assert.equal(r.blend_weight, 0.25);
  assert.ok(r.caveats.some((c) => c.includes("BLEND")), "caveat reflects blend");
  await pool.end();
});

test("projectScaling: cycle-time uses REAL observed settlement duration once realized is in play", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // 25 settled moderate pairs each held ~1.5 days → observed cycle should be ~1.5d.
  for (let i = 0; i < 25; i++) await insertSettled(pool, CELL, 2740, 2740 + 500, "moderate", { durationDays: 1.5 });
  const r = await projectScaling(pool, {
    cellId: CELL, regime: "moderate", budgetUsdc: 20_000, spot: 73_000,
    liquidChainCache: chain, days: 30, marketAvailability: 1.0, nRuns: 100, nPaths: 100, seed: 7,
    realizedMode: "replace", minValidatedSettlements: 20
  });
  assert.equal(r.cycle_days_source, "realized_settlements");
  assert.ok(Math.abs(r.cycle_days - 1.5) < 0.05, `cycle_days ${r.cycle_days} ~ 1.5`);
  assert.ok(r.caveats.some((c) => c.includes("REAL observed shadow settlement")), "caveat reflects real cycle source");

  // Control: explicit cycle_days override always wins.
  const r2 = await projectScaling(pool, {
    cellId: CELL, regime: "moderate", budgetUsdc: 20_000, spot: 73_000,
    liquidChainCache: chain, days: 30, marketAvailability: 1.0, nRuns: 100, nPaths: 100, seed: 7,
    realizedMode: "replace", minValidatedSettlements: 20, cycleDays: 2
  });
  assert.equal(r2.cycle_days_source, "explicit");
  assert.equal(r2.cycle_days, 2);
  await pool.end();
});
