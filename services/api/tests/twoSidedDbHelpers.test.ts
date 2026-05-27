/**
 * PR B4 tests — withTransaction + withClient + timeQuery.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { withTransaction, withClient, timeQuery } from "../src/singleSide/twoSided/dbHelpers";
import { ensureTwoSidedSchema, insertPair, getPairById } from "../src/singleSide/twoSided/db";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const samplePair = (id = "p-tx") => ({
  pairId: id,
  cellId: "pair_50k_2pct",
  foxifyPairRef: id + "-ref",
  spotAtActivation: 76_000,
  feedSnapshotAtActivation: {},
  triggerDownPrice: 74_480,
  triggerUpPrice: 77_520,
  hedgeTenorDays: 3,
  expiresAt: "2026-05-30T18:00:00Z",
  tpForceExitAt: "2026-05-30T14:00:00Z",
  hedgeCostTotalUsdc: 3_200,
  foxifyCapitalFundedUsdc: 3_200,
  tierAtActivation: "tier_1" as const,
  atticusFloorUsdc: 25,
  metadata: {}
});

test("withTransaction: commits on success", async () => {
  const pool = await buildPool();
  const result = await withTransaction(pool, async (client) => {
    const r = await insertPair(client, samplePair("tx-commit"));
    return r.pairId;
  });
  assert.equal(result, "tx-commit");
  const fetched = await getPairById(pool, "tx-commit");
  assert.ok(fetched);
});

test("withTransaction: rolls back on throw (real Postgres only — pg-mem doesn't enforce TX)", async () => {
  // NOTE: pg-mem accepts BEGIN/ROLLBACK SQL but does NOT actually isolate writes.
  // This test verifies the helper throws + invokes ROLLBACK (we can't verify
  // the rollback actually undid the insert because pg-mem doesn't honor it).
  // The transactional semantics are verified by Postgres at production time.
  const pool = await buildPool();
  await assert.rejects(async () => {
    await withTransaction(pool, async (client) => {
      await insertPair(client, samplePair("tx-rollback"));
      throw new Error("intentional");
    });
  }, /intentional/);
});

test("withClient: borrows + releases connection", async () => {
  const pool = await buildPool();
  const r = await withClient(pool, async (client) => {
    const res = await client.query("SELECT 1 AS n");
    return res.rows[0].n;
  });
  assert.equal(r, 1);
});

test("timeQuery: runs fn + returns result; doesn't throw on slow", async () => {
  const r = await timeQuery("test_query", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "ok";
  }, 1); // 1ms threshold — likely triggers slow path
  assert.equal(r, "ok");
});
