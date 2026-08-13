import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  archiveTestProtectionsByIds,
  ensurePilotSchema,
  insertProtection,
  listProtectionsByUserHash
} from "../src/pilot/db.js";

// Regression test for the admin-dashboard / trader-widget visibility bug:
// after admin test-reset cancels and archives a protection, the
// trader-facing /pilot/protections endpoint and the admin dashboard
// (which both read via listProtectionsByUserHash) must NOT continue to
// render the row. The opt-in `includeArchived` flag is provided for
// audit / forensics use.

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seed = async (pool: any, userHash: string, notional: number) =>
  (await insertProtection(pool, {
    userHash,
    hashVersion: 1,
    status: "active",
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: String(notional),
    foxifyExposureNotional: String(notional),
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {}
  })).id;

test("listProtectionsByUserHash hides archived rows by default; opt-in flag exposes them", async () => {
  const pool = await buildPool();

  const idKeep1 = await seed(pool, "u1", 10000);
  const idKeep2 = await seed(pool, "u1", 25000);
  const idArchive = await seed(pool, "u1", 50000);

  const beforeReset = await listProtectionsByUserHash(pool, "u1");
  assert.equal(beforeReset.length, 3, "all 3 protections visible before any reset");

  const result = await archiveTestProtectionsByIds(pool, {
    userHash: "u1",
    protectionIds: [idArchive],
    actor: "admin"
  });
  assert.equal(result.archivedCount, 1, "archive helper retired exactly 1");

  // Default behavior: archived row hidden.
  const afterDefault = await listProtectionsByUserHash(pool, "u1");
  assert.equal(afterDefault.length, 2, "default list excludes archived row");
  const visibleIds = afterDefault.map((p) => p.id).sort();
  assert.deepEqual(visibleIds, [idKeep1, idKeep2].sort(), "exactly the two kept rows are visible");

  // Opt-in: archived row included.
  const afterOptIn = await listProtectionsByUserHash(pool, "u1", { includeArchived: true });
  assert.equal(afterOptIn.length, 3, "includeArchived=true returns all 3 rows");
  const allIds = afterOptIn.map((p) => p.id).sort();
  assert.deepEqual(allIds, [idKeep1, idKeep2, idArchive].sort(), "includes the archived row");
});
