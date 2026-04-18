import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { ensurePilotSchema, listExecutionQualityRecent, upsertExecutionQualityDaily } from "../src/pilot/db.js";

// Regression test for the silent NOT NULL violation on
// pilot_execution_quality_daily.id that ate every activation's
// execution-quality rollup row across the v1-v5 Phase 0 reports.
//
// Before the fix:
//   "[Activate] Execution quality upsert failed: null value in column \"id\"
//    of relation \"pilot_execution_quality_daily\" violates not-null
//    constraint"
//
// After the fix: the row is inserted with a generated UUID, the composite
// UNIQUE (day, venue, hedge_mode) carries identity for upsert semantics.
//
// Note: pg-mem has known quirks with `INSERT ... ON CONFLICT ... DO UPDATE`
// for some statement shapes, so we cover the regression with a single
// straight-INSERT case here. Conflict semantics are exercised in production
// against real Postgres.

const buildMemPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

test("upsertExecutionQualityDaily inserts a row with a generated id (regression for production NOT NULL bug)", async () => {
  const pool = await buildMemPool();

  await upsertExecutionQualityDaily(pool, {
    day: "2026-04-18",
    venue: "deribit_test",
    hedgeMode: "default",
    avgSlippageBps: "12.34",
    p95SlippageBps: "25.0",
    sampleCount: 1,
    quotes: 1,
    fills: 1,
    rejects: 0
  });

  const recs = await listExecutionQualityRecent(pool, { lookbackDays: 30 });
  assert.equal(recs.length, 1, "one row should be persisted (was 0 before fix due to id NOT NULL violation)");
  assert.equal(recs[0].venue, "deribit_test");
  assert.equal(recs[0].hedgeMode, "default");
  assert.equal(recs[0].sampleCount, 1);
  assert.equal(recs[0].avgSlippageBps, "12.34");
});
