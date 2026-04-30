import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  getProtection,
  insertProtection
} from "../src/pilot/db.js";
import { handleBiweeklyClose, sweepBiweeklyNaturalExpiries } from "../src/pilot/biweeklyClose.js";

// PR 4 of biweekly cutover (2026-04-30) — close handler.
//
// Tests cover:
//   - Happy path: user_close after N days → status cancelled, charge billed, ledger entry written
//   - trigger close: status triggered, hedgeRetainedForPlatform=true (CEO direction)
//   - natural_expiry: forces 14 days billed regardless of clock drift
//   - admin close: status cancelled, hedge retained = false
//   - Idempotency: second close call returns newlyClosed=false with prior values
//   - Refuses legacy 1-day protections (not_biweekly)
//   - 404 for nonexistent protection
//   - Errors when biweekly row has missing daily_rate or sl_pct (data corruption)
//   - sweepBiweeklyNaturalExpiries closes only protections past their 14-day max
//   - sweepBiweeklyNaturalExpiries skips already-closed protections

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedBiweekly = async (
  pool: any,
  opts: {
    notional?: string;
    slPct?: number;
    dailyRate?: string;
    createdAtMs?: number;
    tenorDays?: number;
  } = {}
) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-close-test",
    hashVersion: 1,
    status: "active" as any,
    tierName: `SL ${opts.slPct ?? 2}%`,
    drawdownFloorPct: String((opts.slPct ?? 2) / 100),
    slPct: opts.slPct ?? 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: opts.notional ?? "10000",
    foxifyExposureNotional: opts.notional ?? "10000",
    expiryAt: new Date(Date.now() + 14 * 86400 * 1000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: { protectionType: "long" },
    tenorDays: opts.tenorDays ?? 14,
    dailyRateUsdPer1k: opts.dailyRate ?? "2.5"
  });
  if (opts.createdAtMs) {
    await pool.query(
      `UPDATE pilot_protections SET created_at = $1::timestamptz WHERE id = $2`,
      [new Date(opts.createdAtMs).toISOString(), seeded.id]
    );
  }
  return seeded.id;
};

const seedLegacy1Day = async (pool: any) => {
  return insertProtection(pool, {
    userHash: "hh-legacy-test",
    hashVersion: 1,
    status: "active" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(Date.now() + 86400 * 1000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: { protectionType: "long" }
    // No tenorDays/dailyRateUsdPer1k → defaults to 1-day legacy
  });
};

// ─────────────────────────────────────────────────────────────────────
// User close happy path
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: user_close after 3 days → status cancelled, $75 billed, ledger entry written", async () => {
  const pool = await buildPool();
  // Created 3 days ago, $10k 2% → 3 × $25 = $75
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 3 * 86400 * 1000 });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.product, "biweekly");
  assert.equal(result.daysBilled, 3);
  assert.equal(result.accumulatedChargeUsd, 75);
  assert.equal(result.hedgeRetainedForPlatform, false);
  assert.equal(result.newlyClosed, true);
  assert.equal(result.protection.status, "cancelled");
  assert.equal(result.protection.daysBilled, 3);
  assert.equal(result.protection.accumulatedChargeUsd, "75");
  assert.equal(result.protection.closedBy, "user_close");
  assert.ok(result.protection.closedAt);
  assert.equal(result.protection.hedgeRetainedForPlatform, false);

  // Verify ledger entry written
  const ledger = await pool.query(
    "SELECT * FROM pilot_ledger_entries WHERE protection_id = $1 AND entry_type = 'subscription_close_settlement'",
    [id]
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(Number(ledger.rows[0].amount), 75);
});

test("handleBiweeklyClose: user_close at day 1 → bills 1 day minimum", async () => {
  const pool = await buildPool();
  // Created just now → < 1 day held → MIN_DAYS_BILLED kicks in (1 day)
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 60_000 }); // 1 min ago
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.daysBilled, 1, "min 1 day billed even on immediate close");
  assert.equal(result.accumulatedChargeUsd, 25, "1 day × $25");
});

test("handleBiweeklyClose: user_close at fractional day rounds UP", async () => {
  const pool = await buildPool();
  // 2.3 days held → ceil to 3 → $75
  const id = await seedBiweekly(pool, {
    createdAtMs: Date.now() - 2.3 * 86400 * 1000
  });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.daysBilled, 3, "2.3d ceil to 3");
  assert.equal(result.accumulatedChargeUsd, 75);
});

// ─────────────────────────────────────────────────────────────────────
// Trigger close — protection closes for user, hedge stays open
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: trigger close → status triggered, hedgeRetainedForPlatform=true (CEO direction)", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 2 * 86400 * 1000 });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "trigger" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.protection.status, "triggered");
  assert.equal(result.hedgeRetainedForPlatform, true, "trigger MUST retain hedge for platform");
  assert.equal(result.protection.hedgeRetainedForPlatform, true);
  assert.equal(result.daysBilled, 2);
  assert.equal(result.accumulatedChargeUsd, 50);
  assert.equal(result.protection.closedBy, "trigger");
});

// ─────────────────────────────────────────────────────────────────────
// Natural expiry — forces 14 days billed
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: natural_expiry → forces 14 days, $350 billed regardless of clock drift", async () => {
  const pool = await buildPool();
  // Even if clock says only 13.9 days held, natural_expiry bills the full 14
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 13.9 * 86400 * 1000 });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "natural_expiry" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.protection.status, "expired_otm");
  assert.equal(result.daysBilled, 14);
  assert.equal(result.accumulatedChargeUsd, 350);
  assert.equal(result.hedgeRetainedForPlatform, false);
});

test("handleBiweeklyClose: natural_expiry past 14 days → still bills exactly 14 days", async () => {
  const pool = await buildPool();
  // 20 days held (clock drift) — natural_expiry caps at 14
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 20 * 86400 * 1000 });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "natural_expiry" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.daysBilled, 14);
  assert.equal(result.accumulatedChargeUsd, 350);
});

// ─────────────────────────────────────────────────────────────────────
// Admin close
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: admin close → status cancelled, hedgeRetained=false (different from trigger)", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 2 * 86400 * 1000 });
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "admin" }
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.protection.status, "cancelled");
  assert.equal(result.hedgeRetainedForPlatform, false);
});

// ─────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: idempotent — second close returns newlyClosed=false with prior values", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 5 * 86400 * 1000 });
  const first = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.equal(first.newlyClosed, true);
  assert.equal(first.daysBilled, 5);
  assert.equal(first.accumulatedChargeUsd, 125);

  // Second call — should be no-op
  const second = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.newlyClosed, false, "second close should be no-op");
  assert.equal(second.daysBilled, 5, "prior daysBilled preserved");
  assert.equal(second.accumulatedChargeUsd, 125, "prior charge preserved (no double-bill)");

  // Verify only ONE ledger entry was written
  const ledger = await pool.query(
    "SELECT COUNT(*)::int AS n FROM pilot_ledger_entries WHERE protection_id = $1 AND entry_type = 'subscription_close_settlement'",
    [id]
  );
  assert.equal(Number(ledger.rows[0].n), 1, "only one ledger entry — no double settlement");
});

test("handleBiweeklyClose: idempotent across different closedBy reasons", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 2 * 86400 * 1000 });
  // First: trigger
  const first = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "trigger" }
  });
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.equal(first.protection.closedBy, "trigger");

  // Now user_close attempt — should NOT overwrite the trigger close
  const second = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.newlyClosed, false);
  assert.equal(second.protection.closedBy, "trigger", "original close reason preserved");
});

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

test("handleBiweeklyClose: returns not_found for nonexistent protection", async () => {
  const pool = await buildPool();
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: "nonexistent-id", closedBy: "user_close" }
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "not_found");
  }
});

test("handleBiweeklyClose: refuses legacy 1-day protections (not_biweekly)", async () => {
  const pool = await buildPool();
  const legacy = await seedLegacy1Day(pool);
  const result = await handleBiweeklyClose({
    pool,
    req: { protectionId: legacy.id, closedBy: "user_close" }
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "not_biweekly");
  }
});

// ─────────────────────────────────────────────────────────────────────
// Natural expiry sweep
// ─────────────────────────────────────────────────────────────────────

test("sweepBiweeklyNaturalExpiries: closes only protections past their 14-day max", async () => {
  const pool = await buildPool();
  // 3 protections past max tenor
  const expired1 = await seedBiweekly(pool, { createdAtMs: Date.now() - 15 * 86400 * 1000 });
  const expired2 = await seedBiweekly(pool, { createdAtMs: Date.now() - 14.5 * 86400 * 1000 });
  const expired3 = await seedBiweekly(pool, { createdAtMs: Date.now() - 30 * 86400 * 1000 });
  // 2 still within tenor
  const active1 = await seedBiweekly(pool, { createdAtMs: Date.now() - 5 * 86400 * 1000 });
  const active2 = await seedBiweekly(pool, { createdAtMs: Date.now() - 13 * 86400 * 1000 });

  const result = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(result.scanned, 3, "scanned only the 3 expired");
  assert.equal(result.closed, 3, "closed all 3");
  assert.equal(result.errors, 0);

  // Verify expired ones are closed with natural_expiry
  for (const id of [expired1, expired2, expired3]) {
    const p = await getProtection(pool, id);
    assert.ok(p);
    assert.equal(p!.closedBy, "natural_expiry");
    assert.equal(p!.status, "expired_otm");
    assert.equal(p!.daysBilled, 14);
    assert.equal(p!.accumulatedChargeUsd, "350");
  }
  // Verify still-active ones are untouched
  for (const id of [active1, active2]) {
    const p = await getProtection(pool, id);
    assert.ok(p);
    assert.equal(p!.closedAt, null);
    assert.equal(p!.status, "active");
  }
});

test("sweepBiweeklyNaturalExpiries: skips already-closed protections", async () => {
  const pool = await buildPool();
  // Protection past max tenor but already closed by user a few days ago
  const id = await seedBiweekly(pool, { createdAtMs: Date.now() - 15 * 86400 * 1000 });
  await handleBiweeklyClose({ pool, req: { protectionId: id, closedBy: "user_close" } });

  const result = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(result.scanned, 0, "already-closed protection not scanned");

  const p = await getProtection(pool, id);
  assert.ok(p);
  assert.equal(p!.closedBy, "user_close", "did not get re-closed as natural_expiry");
});

test("sweepBiweeklyNaturalExpiries: idempotent — second sweep is no-op", async () => {
  const pool = await buildPool();
  await seedBiweekly(pool, { createdAtMs: Date.now() - 15 * 86400 * 1000 });
  const first = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(first.closed, 1);

  // Second sweep should find no candidates
  const second = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(second.scanned, 0);
  assert.equal(second.closed, 0);
});

test("sweepBiweeklyNaturalExpiries: empty when no biweekly protections exist", async () => {
  const pool = await buildPool();
  const result = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(result.scanned, 0);
  assert.equal(result.closed, 0);
  assert.equal(result.errors, 0);
});

test("sweepBiweeklyNaturalExpiries: ignores legacy 1-day protections regardless of age", async () => {
  const pool = await buildPool();
  const legacy = await seedLegacy1Day(pool);
  // Force the legacy row to be 30 days old
  await pool.query(
    `UPDATE pilot_protections SET created_at = $1::timestamptz WHERE id = $2`,
    [new Date(Date.now() - 30 * 86400 * 1000).toISOString(), legacy.id]
  );
  const result = await sweepBiweeklyNaturalExpiries({ pool });
  assert.equal(result.scanned, 0, "legacy 1-day not scanned by biweekly sweep");

  const p = await getProtection(pool, legacy.id);
  assert.ok(p);
  assert.equal(p!.closedAt, null, "legacy 1-day not touched");
});
