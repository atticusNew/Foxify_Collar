/**
 * Foxify economics — verifies it returns PRODUCTION cells only, classifies role
 * (profit_engine vs loss_leader_cost), and degrades cleanly when the chain is
 * unavailable (deterministic — no MC run needed).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { computeFoxifyEconomics } from "../src/singleSide/twoSided/foxifyEconomics";
import { PRODUCTION_CELLS } from "../src/singleSide/twoSided/cellConfig";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);  // getRegimeCalibration reads two_sided_dvol_history
  await ensureChainSnapshotSchema(pool); // pricing path reads two_sided_chain_snapshot
  return pool;
};

// Stub chain cache that never has a quote → computeRealPricing returns null →
// mc_status=chain_unavailable (no MC run; deterministic + fast).
const emptyCache = {
  getBidForLeg: () => null,
  getBidForSymbol: () => null,
  getCached: () => null,
  getChain: async () => null
} as never;

test("computeFoxifyEconomics: production cells only, role-classified, chain-unavailable degrades cleanly", async () => {
  const pool = await buildPool();
  const report = await computeFoxifyEconomics(pool, {
    regime: "moderate", spot: 70_000, liquidChainCache: emptyCache, dvolService: null, nPaths: 50
  });
  // One row per production cell, nothing else.
  assert.equal(report.rows.length, PRODUCTION_CELLS.length);
  for (const r of report.rows) {
    assert.ok(PRODUCTION_CELLS.includes(r.cell_id), `${r.cell_id} is a production cell`);
    assert.ok(r.role === "profit_engine" || r.role === "loss_leader_cost");
    // No chain → no MC; cost null + chain_unavailable.
    assert.equal(r.mc_status, "chain_unavailable");
    assert.equal(r.cost_usdc, null);
    assert.equal(r.validated, false);
  }
  // Loss-leader strangles classified as cost, not profit.
  const ll = report.rows.find((r) => r.cell_id === "pair_25k_5otm_strangle_2d");
  assert.ok(ll && ll.role === "loss_leader_cost");
  const straddle = report.rows.find((r) => r.cell_id === "pair_150k_3pct_atm_3d");
  assert.ok(straddle && straddle.role === "profit_engine");
  assert.ok(report.framing.length >= 3);
  assert.equal(report.regime, "moderate");
});
