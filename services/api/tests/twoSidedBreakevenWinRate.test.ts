/**
 * Breakeven win-rate — verifies the sweep shape + that chain-unavailable yields null
 * breakevens (deterministic; no MC).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { computeBreakevenWinRates } from "../src/singleSide/twoSided/breakevenWinRate";

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

test("computeBreakevenWinRates: sweeps the grid; chain-unavailable → null breakevens", async () => {
  const pool = await buildPool();
  const r = await computeBreakevenWinRates(pool, {
    cellId: "pair_10k_atm_2d", regime: "moderate", spot: 66_000,
    liquidChainCache: emptyCache, dvolService: null, nPaths: 30, winRates: [0.5, 0.6, 0.65]
  });
  assert.deepEqual(r.win_rate_grid, [0.5, 0.6, 0.65]);
  assert.equal(r.rows.length, 9, "one row per structure");
  for (const row of r.rows) {
    assert.equal(row.breakeven_win_rate, null, "no chain → no +EV point → null breakeven");
    assert.equal(row.net_by_win_rate.length, 3, "one net per grid point");
    assert.ok(row.net_by_win_rate.every((p) => p.mc_net === null));
  }
  assert.equal(r.regime, "moderate");
  assert.ok(r.note.includes("breakeven"));
});
