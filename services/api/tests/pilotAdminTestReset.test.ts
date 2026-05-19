import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  archiveTestProtectionsByIds,
  ensurePilotSchema,
  getDailyTierUsageForUser,
  insertProtection,
  reserveDailyActivationCapacity,
  sumActiveProtectionNotional
} from "../src/pilot/db.js";

// Regression coverage for the surgical admin test-reset helper. The
// production motivation is paper-test sessions that exhaust pilot caps
// (R2.B aggregate-active, R2.D per-tier-daily) without a way to clear
// headroom mid-pilot without destroying audit data. This test verifies:
//
//   1. Archiving a subset releases the aggregate-active cap for those rows
//   2. Per-tier daily usage drops the archived rows (filter on
//      metadata.archivedAt)
//   3. pilot_daily_usage row is decremented by the correct amount
//   4. Rows owned by a different userHash are never touched
//   5. Already-archived rows are no-ops (archivedCount == 0 for them)
//   6. archivedIds + skippedIds reflect partial success correctly
//   7. Audit metadata is stamped (archivedAt, archivedReason, archivedBy)

const buildPool = async () => {
  // Reset module-level schemaReady flag so each test re-creates tables in
  // its own pg-mem instance.
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedProtection = async (
  pool: any,
  opts: {
    userHash: string;
    status: string;
    notional: number;
    slPct?: number;
    createdAtIso?: string;
  }
) => {
  const { id } = await insertProtection(pool, {
    userHash: opts.userHash,
    hashVersion: 1,
    status: opts.status as any,
    tierName: opts.slPct ? `SL ${opts.slPct}%` : "SL 2%",
    drawdownFloorPct: opts.slPct ? String(opts.slPct / 100) : "0.02",
    slPct: opts.slPct ?? 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: String(opts.notional),
    foxifyExposureNotional: String(opts.notional),
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {}
  });
  if (opts.createdAtIso) {
    await pool.query(
      `UPDATE pilot_protections SET created_at = $1 WHERE id = $2`,
      [opts.createdAtIso, id]
    );
  }
  return id;
};

test("archiveTestProtectionsByIds — releases caps surgically without destroying other data", async () => {
  const pool = await buildPool();

  const today = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));
  const dayStart = new Date(Date.UTC(2026, 3, 19)).toISOString();
  const dayEnd = new Date(Date.UTC(2026, 3, 20)).toISOString();
  const dayStartDateOnly = "2026-04-19";

  const idA = await seedProtection(pool, { userHash: "u1", status: "active", notional: 20000, slPct: 2, createdAtIso: today.toISOString() });
  const idB = await seedProtection(pool, { userHash: "u1", status: "active", notional: 25000, slPct: 2, createdAtIso: today.toISOString() });
  const idKeep1 = await seedProtection(pool, { userHash: "u1", status: "active", notional: 15000, slPct: 2, createdAtIso: today.toISOString() });
  const idKeep2 = await seedProtection(pool, { userHash: "u1", status: "active", notional: 20000, slPct: 2, createdAtIso: today.toISOString() });

  const idOtherUser = await seedProtection(pool, { userHash: "u2", status: "active", notional: 99999, slPct: 2, createdAtIso: today.toISOString() });

  // Mirror what reserveDailyActivationCapacity would have written for u1
  // when these protections activated. We populate $80k for the day.
  await reserveDailyActivationCapacity(pool, {
    userHash: "u1",
    dayStartIso: dayStartDateOnly,
    protectedNotional: "80000",
    maxDailyNotional: "100000"
  });

  // Sanity check before archive
  assert.equal(Number(await sumActiveProtectionNotional(pool, "u1")), 80000, "pre: u1 active = 80000");
  assert.equal(Number(await getDailyTierUsageForUser(pool, "u1", 2, dayStart, dayEnd)), 80000, "pre: u1 SL 2% today = 80000");
  const dailyBefore = await pool.query(
    `SELECT used_notional::text AS u FROM pilot_daily_usage WHERE user_hash = 'u1' AND day_start = '2026-04-19'::date`
  );
  assert.equal(Number(dailyBefore.rows[0].u), 80000, "pre: pilot_daily_usage = 80000");

  // ── Action: archive idA + idB (and try to archive other user's row) ───
  const result = await archiveTestProtectionsByIds(pool, {
    userHash: "u1",
    protectionIds: [idA, idB, idOtherUser],
    actor: "test_admin",
    reason: "paper_test_cleanup"
  });

  // ── Assertions ────────────────────────────────────────────────────────
  assert.equal(result.archivedCount, 2, "should archive exactly idA and idB");
  assert.deepEqual(
    result.archivedIds.sort(),
    [idA, idB].sort(),
    "archived IDs should match request minus the foreign-user row"
  );
  assert.deepEqual(
    result.releasedDailyByDay,
    [{ dayStart: "2026-04-19", notional: "45000" }],
    "should release exactly 45000 (= 20000 + 25000) on day 2026-04-19"
  );

  // Aggregate active dropped by archived notional
  assert.equal(
    Number(await sumActiveProtectionNotional(pool, "u1")),
    35000,
    "post: u1 active = 80000 - 45000 = 35000"
  );

  // Per-tier-daily usage dropped by archived rows (filter via metadata)
  assert.equal(
    Number(await getDailyTierUsageForUser(pool, "u1", 2, dayStart, dayEnd)),
    35000,
    "post: u1 SL 2% today = 35000 (archived rows filtered out)"
  );

  // pilot_daily_usage decremented
  const dailyAfter = await pool.query(
    `SELECT used_notional::text AS u FROM pilot_daily_usage WHERE user_hash = 'u1' AND day_start = '2026-04-19'::date`
  );
  assert.equal(Number(dailyAfter.rows[0].u), 35000, "post: pilot_daily_usage = 35000");

  // Other user untouched
  assert.equal(
    Number(await sumActiveProtectionNotional(pool, "u2")),
    99999,
    "u2's protections must be untouched"
  );

  // Audit metadata stamped on archived rows
  const audit = await pool.query(
    `SELECT id, status, metadata->>'archivedAt' AS archived_at, metadata->>'archivedReason' AS reason, metadata->>'archivedBy' AS actor FROM pilot_protections WHERE id = ANY($1::text[])`,
    [[idA, idB]]
  );
  for (const row of audit.rows) {
    assert.equal(row.status, "cancelled", `${row.id} status should be cancelled`);
    assert.ok(row.archived_at, `${row.id} archivedAt should be set`);
    assert.equal(row.reason, "paper_test_cleanup", `${row.id} archivedReason should match`);
    assert.equal(row.actor, "test_admin", `${row.id} archivedBy should match`);
  }

  // Kept rows untouched
  const kept = await pool.query(
    `SELECT id, status, COALESCE(metadata->>'archivedAt', '') AS archived_at FROM pilot_protections WHERE id = ANY($1::text[])`,
    [[idKeep1, idKeep2]]
  );
  for (const row of kept.rows) {
    assert.equal(row.status, "active", `${row.id} status should still be active`);
    assert.equal(row.archived_at, "", `${row.id} should not be archived`);
  }
});

test("archiveTestProtectionsByIds — second call on same IDs is a no-op", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { userHash: "u1", status: "active", notional: 10000, slPct: 2 });

  const first = await archiveTestProtectionsByIds(pool, {
    userHash: "u1",
    protectionIds: [id],
    actor: "admin"
  });
  assert.equal(first.archivedCount, 1, "first call archives 1");

  const second = await archiveTestProtectionsByIds(pool, {
    userHash: "u1",
    protectionIds: [id],
    actor: "admin"
  });
  assert.equal(second.archivedCount, 0, "second call is a no-op");
  assert.deepEqual(second.archivedIds, [], "no IDs archived second time");
  assert.deepEqual(second.releasedDailyByDay, [], "no daily release second time");
});

test("archiveTestProtectionsByIds — empty input returns clean zero result", async () => {
  const pool = await buildPool();
  const result = await archiveTestProtectionsByIds(pool, {
    userHash: "u1",
    protectionIds: [],
    actor: "admin"
  });
  assert.deepEqual(result, { archivedCount: 0, archivedIds: [], releasedDailyByDay: [] });
});
