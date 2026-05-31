/**
 * 30-day scaling/budget projection — structure, concurrency math, recycling.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { projectScaling } from "../src/singleSide/twoSided/scalingProjection";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { __resetCalibrationCache } from "../src/singleSide/twoSided/regimeCalibration";
import type { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  return new (db.adapters.createPg().Pool)();
};

const chain = {
  getBidForSymbol: () => null,
  getBidForLeg: (o: { strike: number; optType: "put" | "call" }) => ({
    bidUsdcPerBtc: 1800, askUsdcPerBtc: 2000, midUsdcPerBtc: 1900, spreadPct: 0.1,
    venue: "deribit" as const, instrumentName: `BTC-${o.strike}-${o.optType.toUpperCase()}`,
    tenorHours: 72, markIv: 0.5, pulledAtMs: Date.now()
  }),
  getCached: () => null
} as unknown as LiquidChainCache;

test("scaling projection: concurrency math + budget-to-reach + recycling produces a range", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const r = await projectScaling(pool, {
    cellId: "pair_50k_3pct_atm_3d", regime: "moderate", budgetUsdc: 10_000, spot: 73_000,
    liquidChainCache: chain, days: 10, marketAvailability: 1.0, nRuns: 200, nPaths: 200, seed: 7
  });
  assert.ok(r.cost_per_pair_usdc > 0, "priced from real chain");
  // contracts = 50000/73000 = 0.685; cost = (2000+2000)*0.685 = 2740
  assert.equal(r.starting_concurrent, Math.floor(10_000 / r.cost_per_pair_usdc));
  assert.ok(Math.abs(r.budget_to_reach_concurrent["1"] - r.cost_per_pair_usdc) < 0.01);
  assert.ok(Math.abs(r.budget_to_reach_concurrent["5"] - 5 * r.cost_per_pair_usdc) < 0.01);
  // with full availability + budget > cost, pairs get opened across the cycles
  assert.ok(r.projection.total_pairs.median > 0, "pairs opened");
  // p5 <= median <= p95 ordering on capital
  const cap = r.projection.final_capital_usdc;
  assert.ok(cap.p5 <= cap.median && cap.median <= cap.p95, "capital band ordered");
  assert.ok(r.projection.max_drawdown_pct.median >= 0);
  assert.ok(r.caveats.length >= 3);
  await pool.end();
});

test("scaling projection: bigger budget → more starting concurrent", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const small = await projectScaling(pool, { cellId: "pair_50k_3pct_atm_3d", regime: "moderate", budgetUsdc: 5_000, spot: 73_000, liquidChainCache: chain, days: 5, marketAvailability: 1.0, nRuns: 100, nPaths: 100, seed: 3 });
  const big = await projectScaling(pool, { cellId: "pair_50k_3pct_atm_3d", regime: "moderate", budgetUsdc: 50_000, spot: 73_000, liquidChainCache: chain, days: 5, marketAvailability: 1.0, nRuns: 100, nPaths: 100, seed: 3 });
  assert.ok(big.starting_concurrent > small.starting_concurrent, "more budget -> more concurrent");
  await pool.end();
});
