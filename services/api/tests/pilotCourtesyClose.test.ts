import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection,
  getProtection,
  requestProtectionClose
} from "../src/pilot/db.js";

// Courtesy-close admin endpoint regression coverage (2026-05-07).
//
// Scope:
//   1. Backdates billing + closes the row with explicit overrides
//   2. Sets hedge_retained_for_platform=true so hedge manager keeps TP running
//   3. Cancels any pre-existing pending deferred-close schedule
//   4. Refuses already-closed protections
//   5. Requires reason for audit trail
//
// The endpoint exists for dispute-resolution and one-shot ops
// adjustments. NOT exposed to traders.

const ADMIN_TOKEN = "admin-local-courtesy-test";

const buildApp = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.PILOT_ADMIN_IP_ALLOWLIST = "";

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  __setPilotPoolForTests(pool as any);
  await ensurePilotSchema(pool);

  const configModule = await import("../src/pilot/config.js");
  configModule.pilotConfig.enabled = true;
  configModule.pilotConfig.venueMode = "mock_falconx" as any;
  configModule.pilotConfig.adminToken = ADMIN_TOKEN;
  configModule.pilotConfig.adminIpAllowlist = { entries: [], raw: "" } as any;
  configModule.pilotConfig.tenantScopeId = "test-tenant";
  configModule.pilotConfig.hashSecret = "test-hash-secret";

  const triggerMonitorModule = await import("../src/pilot/triggerMonitor.js");
  triggerMonitorModule.__setTriggerMonitorEnabledForTests(false);

  const { registerPilotRoutes } = await import("../src/pilot/routes.js");
  const app = Fastify();
  await registerPilotRoutes(app, { deribit: {} as any });
  await app.ready();

  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end();
      triggerMonitorModule.__setTriggerMonitorEnabledForTests(true);
      __setPilotPoolForTests(null);
    }
  };
};

const seedActive = async (pool: any, opts: { activatedAtMs: number; tenor?: number; sl?: number }) => {
  const tenor = opts.tenor ?? 14;
  const sl = opts.sl ?? 2;
  const seeded = await insertProtection(pool, {
    userHash: "hh-courtesy-test",
    hashVersion: 1,
    status: "active" as any,
    tierName: `SL ${sl}%`,
    drawdownFloorPct: String(sl / 100),
    slPct: sl,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(opts.activatedAtMs + tenor * 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    tenorDays: tenor,
    dailyRateUsdPer1k: "2.5",
    metadata: { product: "biweekly", protectionType: "short" }
  });
  await pool.query(`UPDATE pilot_protections SET created_at = $1::timestamptz WHERE id = $2`,
    [new Date(opts.activatedAtMs).toISOString(), seeded.id]);
  return seeded.id;
};

const HOUR_MS = 3600 * 1000;

test("courtesy-close: backdates billing + sets hedge_retained_for_platform=true", async () => {
  const ctx = await buildApp();
  try {
    // Seeded ~2.25 days old (in day 3), would normally bill 3 days = $75.
    // Courtesy bills 2 days = $50.
    const id = await seedActive(ctx.pool, { activatedAtMs: Date.now() - 53 * HOUR_MS });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        daysBilled: 2,
        accumulatedChargeUsd: 50,
        reason: "ceo_one_time_courtesy_pre_rollover"
      }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.courtesyApplied, true);
    assert.equal(body.daysBilled, 2);
    assert.equal(body.accumulatedChargeUsd, 50);
    assert.equal(body.hedgeRetainedForPlatform, true);

    const after = await getProtection(ctx.pool, id);
    assert.equal(after!.status, "cancelled");
    assert.equal(after!.closedBy, "admin");
    assert.equal(after!.daysBilled, 2);
    assert.equal(Number(after!.accumulatedChargeUsd), 50);
    assert.equal(after!.hedgeRetainedForPlatform, true);
    // Audit metadata stamped
    const meta = after!.metadata as any;
    assert.ok(meta.courtesyClose);
    assert.equal(meta.courtesyClose.reason, "ceo_one_time_courtesy_pre_rollover");
    assert.equal(meta.courtesyClose.billedDaysOverride, 2);
    assert.equal(meta.courtesyClose.billedChargeOverride, 50);
    assert.equal(meta.courtesyClose.hedgeRetained, true);
    // Ledger entry written
    const led = await ctx.pool.query(
      `SELECT * FROM pilot_ledger_entries WHERE protection_id = $1 AND entry_type = 'subscription_close_settlement'`,
      [id]
    );
    assert.equal(led.rows.length, 1);
    assert.equal(Number(led.rows[0].amount), 50);
    assert.ok(String(led.rows[0].reference).startsWith("courtesy:"));
  } finally {
    await ctx.close();
  }
});

test("courtesy-close: cancels pre-existing pending deferred-close schedule", async () => {
  const ctx = await buildApp();
  try {
    const activatedAt = Date.now() - 53 * HOUR_MS;
    const id = await seedActive(ctx.pool, { activatedAtMs: activatedAt });
    // Schedule a normal deferred close first.
    await requestProtectionClose(ctx.pool, {
      protectionId: id,
      closeRequestedAtIso: new Date().toISOString(),
      closeEffectiveAtIso: new Date(activatedAt + 3 * 86400000).toISOString()
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { daysBilled: 2, accumulatedChargeUsd: 50, reason: "ceo_courtesy" }
    });
    assert.equal(res.statusCode, 200);

    const after = await getProtection(ctx.pool, id);
    assert.equal(after!.status, "cancelled");
    // Schedule columns cleared so the sweep job doesn't re-fire.
    assert.equal(after!.closeRequestedAt, null);
    assert.equal(after!.closeEffectiveAt, null);
    // Prior schedule preserved in audit metadata.
    const meta = after!.metadata as any;
    assert.ok(meta.courtesyClose.priorSchedule.closeRequestedAt);
    assert.ok(meta.courtesyClose.priorSchedule.closeEffectiveAt);
  } finally {
    await ctx.close();
  }
});

test("courtesy-close: refuses already-closed protections", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedActive(ctx.pool, { activatedAtMs: Date.now() - 53 * HOUR_MS });
    // Close it normally first.
    await ctx.pool.query(
      `UPDATE pilot_protections SET status = 'cancelled', closed_at = NOW(), closed_by = 'user_close' WHERE id = $1`,
      [id]
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { daysBilled: 2, accumulatedChargeUsd: 50, reason: "ceo_courtesy" }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, "already_closed");
  } finally {
    await ctx.close();
  }
});

test("courtesy-close: requires reason for audit trail", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedActive(ctx.pool, { activatedAtMs: Date.now() - 53 * HOUR_MS });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { daysBilled: 2, accumulatedChargeUsd: 50 } // no reason
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reason, "missing_reason");
  } finally {
    await ctx.close();
  }
});

test("courtesy-close: validates daysBilled in [1, 14]", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedActive(ctx.pool, { activatedAtMs: Date.now() - 53 * HOUR_MS });

    // Invalid: 0
    let res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { daysBilled: 0, accumulatedChargeUsd: 0, reason: "x" }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reason, "invalid_days_billed");

    // Invalid: 15
    res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/courtesy-close`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { daysBilled: 15, accumulatedChargeUsd: 350, reason: "x" }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reason, "invalid_days_billed");
  } finally {
    await ctx.close();
  }
});
