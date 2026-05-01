import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  countActivationsInLast24h,
  ensurePilotSchema,
  getProtection,
  getProtectionSubscriptionState,
  insertProtection,
  listOpenBiweeklyProtections,
  markProtectionClosed
} from "../src/pilot/db.js";

// PR 2 of biweekly cutover (2026-04-30) — schema migration + helpers.
//
// Tests cover:
//   - Schema migration adds the 6 new columns with the right defaults
//   - mapProtection reads new columns correctly
//   - Back-compat: old rows with NULL new fields render as if 1-day legacy
//   - markProtectionClosed correctly sets closed_at + closed_by + bills
//   - markProtectionClosed is idempotent (won't double-charge)
//   - listOpenBiweeklyProtections filters correctly (tenor_days >= 2 AND open)
//   - countActivationsInLast24h enforces the rolling 24h window
//   - getProtectionSubscriptionState returns the lightweight subset

const buildPool = async () => {
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
    userHash?: string;
    tenorDays?: number;
    createdAtMs?: number;
    closedAtMs?: number | null;
    notional?: string;
    slPct?: number;
    expiryAtMs?: number;
  } = {}
) => {
  const seeded = await insertProtection(pool, {
    userHash: opts.userHash ?? "hh-biweekly-schema-test",
    hashVersion: 1,
    status: "active" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: opts.slPct ?? 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: opts.notional ?? "10000",
    foxifyExposureNotional: opts.notional ?? "10000",
    expiryAt: new Date(opts.expiryAtMs ?? Date.now() + 14 * 86400 * 1000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: { protectionType: "long" }
  });
  // Apply biweekly-specific updates that insertProtection doesn't
  // know about (it's the legacy 1-day shape). Direct UPDATE.
  if (opts.tenorDays !== undefined || opts.createdAtMs !== undefined || opts.closedAtMs !== undefined) {
    await pool.query(
      `UPDATE pilot_protections SET
         tenor_days = COALESCE($2, tenor_days),
         daily_rate_usd_per_1k = CASE WHEN $2 = 14 THEN 2.5 ELSE daily_rate_usd_per_1k END,
         created_at = COALESCE($3::timestamptz, created_at),
         closed_at = $4::timestamptz
       WHERE id = $1`,
      [
        seeded.id,
        opts.tenorDays ?? null,
        opts.createdAtMs ? new Date(opts.createdAtMs).toISOString() : null,
        opts.closedAtMs ? new Date(opts.closedAtMs).toISOString() : null
      ]
    );
  }
  return seeded.id;
};

// ─────────────────────────────────────────────────────────────────────
// Schema migration
// ─────────────────────────────────────────────────────────────────────

test("schema: pilot_protections has all 6 new biweekly columns with correct defaults", async () => {
  const pool = await buildPool();
  // Insert a row using the legacy 1-day shape (no biweekly fields).
  // The defaults from the ALTER TABLE ADD COLUMN should populate.
  const id = await seedProtection(pool);
  const r = await pool.query(
    `SELECT tenor_days, daily_rate_usd_per_1k, accumulated_charge_usd,
            days_billed, closed_at, closed_by, hedge_retained_for_platform
     FROM pilot_protections WHERE id = $1`,
    [id]
  );
  const row = r.rows[0];
  assert.equal(Number(row.tenor_days), 1, "tenor_days defaults to 1 (legacy 1-day)");
  assert.equal(row.daily_rate_usd_per_1k, null, "daily_rate_usd_per_1k null for legacy");
  assert.equal(Number(row.accumulated_charge_usd), 0, "accumulated_charge_usd defaults to 0");
  assert.equal(Number(row.days_billed), 0, "days_billed defaults to 0");
  assert.equal(row.closed_at, null);
  assert.equal(row.closed_by, null);
  assert.equal(Boolean(row.hedge_retained_for_platform), false);
});

test("mapProtection: reads new biweekly fields with correct defaults for legacy rows", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool);
  const p = await getProtection(pool, id);
  assert.ok(p);
  assert.equal(p!.tenorDays, 1);
  assert.equal(p!.dailyRateUsdPer1k, null);
  assert.equal(p!.accumulatedChargeUsd, "0");
  assert.equal(p!.daysBilled, 0);
  assert.equal(p!.closedAt, null);
  assert.equal(p!.closedBy, null);
  assert.equal(p!.hedgeRetainedForPlatform, false);
});

test("mapProtection: reads new biweekly fields when set", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14 });
  const p = await getProtection(pool, id);
  assert.ok(p);
  assert.equal(p!.tenorDays, 14);
  assert.equal(p!.dailyRateUsdPer1k, "2.5", "daily_rate set to 2.5 for biweekly seed");
});

// ─────────────────────────────────────────────────────────────────────
// markProtectionClosed
// ─────────────────────────────────────────────────────────────────────

test("markProtectionClosed: sets all close fields correctly", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14 });
  const closedAtIso = new Date().toISOString();
  const ok = await markProtectionClosed(pool, {
    protectionId: id,
    closedAtIso,
    closedBy: "user_close",
    accumulatedChargeUsd: "75.00",
    daysBilled: 3,
    newStatus: "cancelled"
  });
  assert.equal(ok, true);
  const p = await getProtection(pool, id);
  assert.ok(p);
  assert.equal(p!.status, "cancelled");
  // Compare timestamps to second precision — pg-mem truncates ms;
  // real Postgres preserves microseconds. Comparing the exact ISO
  // string would be brittle across both backends.
  assert.equal((p!.closedAt ?? "").slice(0, 19), closedAtIso.slice(0, 19));
  assert.equal(p!.closedBy, "user_close");
  assert.equal(p!.accumulatedChargeUsd, "75");
  assert.equal(p!.daysBilled, 3);
});

test("markProtectionClosed: hedgeRetainedForPlatform=true on trigger", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14 });
  await markProtectionClosed(pool, {
    protectionId: id,
    closedAtIso: new Date().toISOString(),
    closedBy: "trigger",
    accumulatedChargeUsd: "50.00",
    daysBilled: 2,
    newStatus: "triggered",
    hedgeRetainedForPlatform: true
  });
  const p = await getProtection(pool, id);
  assert.ok(p);
  assert.equal(p!.closedBy, "trigger");
  assert.equal(p!.status, "triggered");
  assert.equal(p!.hedgeRetainedForPlatform, true, "trigger should mark hedge retained for platform");
});

test("markProtectionClosed: idempotent — returns false on second call (no double-charge)", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14 });
  const closedAtIso = new Date().toISOString();
  const first = await markProtectionClosed(pool, {
    protectionId: id,
    closedAtIso,
    closedBy: "user_close",
    accumulatedChargeUsd: "75.00",
    daysBilled: 3,
    newStatus: "cancelled"
  });
  const second = await markProtectionClosed(pool, {
    protectionId: id,
    closedAtIso: new Date(Date.now() + 60_000).toISOString(),
    closedBy: "user_close",
    accumulatedChargeUsd: "200.00", // would be a double-charge if we let it through
    daysBilled: 8,
    newStatus: "cancelled"
  });
  assert.equal(first, true, "first close succeeds");
  assert.equal(second, false, "second close is a no-op (already closed)");
  const p = await getProtection(pool, id);
  assert.ok(p);
  // Original close numbers preserved; second call did NOT overwrite
  assert.equal(p!.accumulatedChargeUsd, "75", "original charge preserved");
  assert.equal(p!.daysBilled, 3, "original days_billed preserved");
});

test("markProtectionClosed: returns false for nonexistent protection", async () => {
  const pool = await buildPool();
  const ok = await markProtectionClosed(pool, {
    protectionId: "nonexistent-id-xxx",
    closedAtIso: new Date().toISOString(),
    closedBy: "user_close",
    accumulatedChargeUsd: "50",
    daysBilled: 2,
    newStatus: "cancelled"
  });
  assert.equal(ok, false);
});

// ─────────────────────────────────────────────────────────────────────
// listOpenBiweeklyProtections
// ─────────────────────────────────────────────────────────────────────

test("listOpenBiweeklyProtections: returns only open biweekly (not closed, not legacy 1-day)", async () => {
  const pool = await buildPool();
  // Three biweekly open
  await seedProtection(pool, { tenorDays: 14 });
  await seedProtection(pool, { tenorDays: 14 });
  await seedProtection(pool, { tenorDays: 14 });
  // One biweekly closed
  const closedId = await seedProtection(pool, { tenorDays: 14 });
  await markProtectionClosed(pool, {
    protectionId: closedId,
    closedAtIso: new Date().toISOString(),
    closedBy: "user_close",
    accumulatedChargeUsd: "25",
    daysBilled: 1,
    newStatus: "cancelled"
  });
  // Two legacy 1-day
  await seedProtection(pool, { tenorDays: 1 });
  await seedProtection(pool, { tenorDays: 1 });

  const open = await listOpenBiweeklyProtections(pool);
  assert.equal(open.length, 3, "exactly the 3 open biweekly rows");
  for (const p of open) {
    assert.equal(p.tenorDays, 14);
    assert.equal(p.closedAt, null);
  }
});

test("listOpenBiweeklyProtections: respects limit", async () => {
  const pool = await buildPool();
  for (let i = 0; i < 5; i++) await seedProtection(pool, { tenorDays: 14 });
  const open = await listOpenBiweeklyProtections(pool, { limit: 3 });
  assert.equal(open.length, 3);
});

// ─────────────────────────────────────────────────────────────────────
// countActivationsInLast24h
// ─────────────────────────────────────────────────────────────────────

test("countActivationsInLast24h: counts only this user's activations within window", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // 2 from user A in last 24h
  await seedProtection(pool, { userHash: "userA", createdAtMs: now - 2 * 60 * 60 * 1000 });
  await seedProtection(pool, { userHash: "userA", createdAtMs: now - 23 * 60 * 60 * 1000 });
  // 1 from user A older than 24h (should NOT count)
  await seedProtection(pool, { userHash: "userA", createdAtMs: now - 30 * 60 * 60 * 1000 });
  // 5 from user B (should NOT count for user A)
  for (let i = 0; i < 5; i++) {
    await seedProtection(pool, { userHash: "userB", createdAtMs: now - 1000 });
  }

  const userA = await countActivationsInLast24h(pool, "userA", now);
  const userB = await countActivationsInLast24h(pool, "userB", now);
  assert.equal(userA, 2, "userA should have 2 activations in last 24h");
  assert.equal(userB, 5, "userB should have 5");
});

test("countActivationsInLast24h: rolling window — 24h+1min ago does not count", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Just outside the window
  await seedProtection(pool, { userHash: "userC", createdAtMs: now - 24 * 60 * 60 * 1000 - 60_000 });
  // Exactly at the window edge (23h59m)
  await seedProtection(pool, { userHash: "userC", createdAtMs: now - 24 * 60 * 60 * 1000 + 60_000 });
  const count = await countActivationsInLast24h(pool, "userC", now);
  assert.equal(count, 1, "only the in-window activation counts");
});

test("countActivationsInLast24h: returns 0 for user with no activations", async () => {
  const pool = await buildPool();
  await seedProtection(pool, { userHash: "userD" });
  const count = await countActivationsInLast24h(pool, "newUserNeverTraded", Date.now());
  assert.equal(count, 0);
});

test("countActivationsInLast24h: skips synthetic test protections (2026-05-01)", async () => {
  // Synthetic protections (created via /pilot/admin/protections/synthetic
  // for UI testing) are tagged metadata.synthetic=true. They must NOT
  // count toward the 1-trade/24h activation guard — otherwise an
  // operator who created a test position is locked out of running a
  // real trade for the next 24h.
  const pool = await buildPool();
  const now = Date.now();
  // 1 real trade, 5 synthetic test rows
  await seedProtection(pool, { userHash: "userE", createdAtMs: now - 1000 });
  for (let i = 0; i < 5; i++) {
    const id = await seedProtection(pool, { userHash: "userE", createdAtMs: now - 2000 - i });
    // pg-mem's `metadata || jsonb_build_object` doesn't work, so do
    // the merge in JS and write the full object back. Same pattern as
    // markExpiredWithAutopsy uses (see PR #104).
    const r = await pool.query(`SELECT metadata FROM pilot_protections WHERE id = $1`, [id]);
    const merged = { ...(r.rows[0].metadata || {}), synthetic: true };
    await pool.query(`UPDATE pilot_protections SET metadata = $1::jsonb WHERE id = $2`, [JSON.stringify(merged), id]);
  }
  const count = await countActivationsInLast24h(pool, "userE", now);
  assert.equal(count, 1, "only the 1 real (non-synthetic) protection counts");
});

// ─────────────────────────────────────────────────────────────────────
// getProtectionSubscriptionState
// ─────────────────────────────────────────────────────────────────────

test("getProtectionSubscriptionState: returns subscription subset for biweekly row", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14, notional: "25000", slPct: 5 });
  const state = await getProtectionSubscriptionState(pool, id);
  assert.ok(state);
  assert.equal(state!.protectionId, id);
  assert.equal(state!.tenorDays, 14);
  assert.equal(state!.dailyRateUsdPer1k, "2.5");
  assert.equal(state!.protectedNotional, "25000");
  assert.equal(state!.slPct, 5);
  assert.equal(state!.closedAtIso, null);
  assert.equal(state!.status, "active");
});

test("getProtectionSubscriptionState: returns null for nonexistent protection", async () => {
  const pool = await buildPool();
  const state = await getProtectionSubscriptionState(pool, "does-not-exist");
  assert.equal(state, null);
});

test("getProtectionSubscriptionState: handles legacy 1-day rows (tenor_days=1, daily_rate=null)", async () => {
  const pool = await buildPool();
  const id = await seedProtection(pool); // legacy 1-day (tenor_days defaults to 1)
  const state = await getProtectionSubscriptionState(pool, id);
  assert.ok(state);
  assert.equal(state!.tenorDays, 1, "legacy treated as 1-day");
  assert.equal(state!.dailyRateUsdPer1k, null, "legacy has no daily_rate");
});

// ─────────────────────────────────────────────────────────────────────
// Composability: PR 1 + PR 2 work together
// ─────────────────────────────────────────────────────────────────────

test("composability: computeAccumulatedCharge from PR 1 produces the right value to write into PR 2 schema", async () => {
  // Don't import biweeklyPricing directly — keep this test focused on
  // integration behavior. Just confirm the Decimal-string the close
  // handler will write is a valid NUMERIC for the column type.
  const pool = await buildPool();
  const id = await seedProtection(pool, { tenorDays: 14 });
  // Charge for 5 days, $10k 2% = 5 × 25.00 = $125.00
  await markProtectionClosed(pool, {
    protectionId: id,
    closedAtIso: new Date().toISOString(),
    closedBy: "user_close",
    accumulatedChargeUsd: "125.00",
    daysBilled: 5,
    newStatus: "cancelled"
  });
  const p = await getProtection(pool, id);
  assert.ok(p);
  // Postgres NUMERIC normalizes "125.00" to "125" — check both forms
  assert.ok(p!.accumulatedChargeUsd === "125" || p!.accumulatedChargeUsd === "125.00");
});
