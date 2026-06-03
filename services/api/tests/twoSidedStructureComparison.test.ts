/**
 * compareStructures — returns the 4 structures side-by-side, role-labeled, and degrades
 * cleanly when the chain is unavailable (deterministic — no MC run).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { compareStructures } from "../src/singleSide/twoSided/structureComparison";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  return pool;
};

const emptyCache = { getBidForLeg: () => null, getBidForSymbol: () => null, getCached: () => null, getChain: async () => null } as never;

test("compareStructures: returns straddle + one-sided + collar, role-labeled; chain-unavailable degrades", async () => {
  const pool = await buildPool();
  const r = await compareStructures(pool, {
    cellId: "pair_10k_atm_2d", regime: "moderate", spot: 66_500, liquidChainCache: emptyCache, dvolService: null, nPaths: 50
  });
  const structs = r.rows.map((x) => x.structure).sort();
  assert.deepEqual(structs, [
    "collar", "credit_spread_call", "credit_spread_put", "one_sided_call", "one_sided_put",
    "short_strangle", "straddle", "vertical_spread_call", "vertical_spread_put"
  ]);
  for (const row of r.rows) {
    assert.equal(row.mc_status, "chain_unavailable", "no chain → no MC");
    assert.equal(row.net_cost_usdc, null);
    assert.ok(typeof row.role === "string" && row.role.length > 0);
  }
  // Role labels distinguish structure families.
  assert.ok(r.rows.find((x) => x.structure === "straddle")!.role.includes("two_sided"));
  assert.ok(r.rows.find((x) => x.structure === "vertical_spread_call")!.role.includes("debit spread"));
  assert.ok(r.rows.find((x) => x.structure === "credit_spread_put")!.role.includes("credit spread"));
  assert.ok(r.rows.find((x) => x.structure === "short_strangle")!.role.includes("SHORT premium"));
  // New report fields surface the edge + frictionless settings.
  assert.equal(typeof r.directional_win_rate, "number");
  assert.equal(typeof r.frictionless, "boolean");
  assert.equal(typeof r.drift_annual_magnitude, "number");
  assert.ok(r.framing.length >= 4);
  assert.equal(r.cell_id, "pair_10k_atm_2d");
  assert.equal(r.regime, "moderate");
});

test("compareStructures: throws on unknown cell", async () => {
  const pool = await buildPool();
  await assert.rejects(
    () => compareStructures(pool, { cellId: "nope", regime: "moderate", spot: 66_500, liquidChainCache: emptyCache, dvolService: null }),
    /unknown cell/
  );
});
