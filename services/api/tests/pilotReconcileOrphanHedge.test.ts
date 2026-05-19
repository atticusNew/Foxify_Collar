import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";

import { __setPilotPoolForTests, ensurePilotSchema, insertProtection, getProtection } from "../src/pilot/db.js";

// PR ?? — admin reconcile-orphan-hedge endpoint regression coverage.
//
// Built specifically to backfill CEO's first real biweekly trade
// (1c7e17f9, 2026-05-01) where biweeklyActivate succeeded at venue.execute
// but didn't populate top-level venue/instrument/size/etc. (fixed in
// PR #120 for FUTURE trades; this endpoint is the one-shot tool for the
// already-existing orphan).
//
// 4 focused tests:
//   - Happy path: patches venue fields + un-archives + merges metadata
//   - Idempotency: refuses to overwrite a row that already has instrument_id,
//     unless ?force=true
//   - Direction mismatch: SHORT protection + put instrument → 400
//   - 404 on unknown ID

const ADMIN_TOKEN = "admin-local-reconcile-test";

const buildApp = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.PILOT_ADMIN_IP_ALLOWLIST = ""; // disable IP gate in tests

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  __setPilotPoolForTests(pool as any);
  await ensurePilotSchema(pool);

  // Re-import config so PILOT_ADMIN_TOKEN is read fresh.
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

const seedOrphanProtection = async (
  pool: any,
  opts: { protectionType: "long" | "short"; archived?: boolean }
) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-reconcile-test",
    hashVersion: 1,
    status: opts.archived ? ("cancelled" as any) : ("active" as any),
    tierName: "SL 2%",
    drawdownFloorPct: "0.020000",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(Date.now() + 14 * 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    tenorDays: 14,
    dailyRateUsdPer1k: "2.5",
    metadata: {
      product: "biweekly",
      protectionType: opts.protectionType,
      triggerPrice: opts.protectionType === "short" ? 79228.96 : 76131.04,
      floorPrice: opts.protectionType === "short" ? 79228.96 : 76131.04,
      spotAtActivation: 77675.45,
      ...(opts.archived ? { archivedAt: new Date().toISOString(), archivedBy: "ops" } : {})
    }
  });
  return seeded.id;
};

test("reconcile-orphan-hedge: happy path patches venue fields + un-archives + merges metadata", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedOrphanProtection(ctx.pool, { protectionType: "short", archived: true });
    const before = await getProtection(ctx.pool, id);
    assert.equal(before!.status, "cancelled", "seeded as archived (cancelled)");
    assert.equal(before!.instrumentId, null);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/reconcile-orphan-hedge`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        venue: "deribit_live",
        instrumentId: "BTC-15MAY26-79000-C",
        side: "buy",
        size: "0.1",
        executionPriceBtc: "0.0200",
        premiumUsd: "155.33",
        executedAt: "2026-05-01T12:18:18.000Z",
        externalOrderId: "deribit-order-12345"
      }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.reconciled, true);

    const after = await getProtection(ctx.pool, id);
    assert.equal(after!.venue, "deribit_live");
    assert.equal(after!.instrumentId, "BTC-15MAY26-79000-C");
    assert.equal(after!.side, "buy");
    assert.equal(Number(after!.size), 0.1);
    assert.equal(Number(after!.executionPrice), 0.02);
    // 2026-05-01 — premium column = trader-facing ceiling
    // (= dailyRate × 14 × notional/1000 = 2.5 × 14 × 10 = $350),
    // NOT the caller-supplied premiumUsd (which is hedge cost).
    assert.equal(Number(after!.premium), 350);
    // Hedge cost stashed in metadata for admin view.
    assert.equal(Number((after!.metadata as any).hedgeCostUsd), 155.33);
    assert.equal(Number((after!.metadata as any).maxProjectedChargeUsd), 350);
    assert.equal(after!.externalOrderId, "deribit-order-12345");
    assert.equal(after!.externalExecutionId, "deribit-order-12345");
    // Un-archived
    assert.equal(after!.status, "active");
    assert.equal(after!.hedgeStatus, "active");
    assert.equal(after!.closedAt, null);
    assert.equal(after!.closedBy, null);
    // Backfilled from metadata
    assert.equal(Number(after!.entryPrice), 77675.45);
    assert.equal(Number(after!.floorPrice), 79228.96);
    // Metadata audit trail
    const meta = after!.metadata as any;
    assert.ok(meta.reconciledAt);
    assert.equal(meta.reconciledBy, "pilot-ops");
    assert.equal(meta.reconciledReason, "orphan_biweekly_activate_pre_pr120_fix");
  } finally {
    await ctx.close();
  }
});

test("reconcile-orphan-hedge: refuses to overwrite already-reconciled row without ?force=true", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedOrphanProtection(ctx.pool, { protectionType: "short" });
    // Pre-populate instrumentId to simulate already-reconciled
    await ctx.pool.query(
      `UPDATE pilot_protections SET instrument_id = 'BTC-15MAY26-79000-C', venue = 'deribit_live' WHERE id = $1`,
      [id]
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/reconcile-orphan-hedge`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        venue: "deribit_live",
        instrumentId: "BTC-15MAY26-80000-C",
        side: "buy",
        size: "0.1",
        executionPriceBtc: "0.025",
        premiumUsd: "200",
        executedAt: "2026-05-01T12:18:18.000Z",
        externalOrderId: "different-order"
      }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, "already_reconciled");

    // With ?force=true the overwrite succeeds
    const forceRes = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/reconcile-orphan-hedge?force=true`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        venue: "deribit_live",
        instrumentId: "BTC-15MAY26-80000-C",
        side: "buy",
        size: "0.1",
        executionPriceBtc: "0.025",
        premiumUsd: "200",
        executedAt: "2026-05-01T12:18:18.000Z",
        externalOrderId: "different-order"
      }
    });
    assert.equal(forceRes.statusCode, 200);
    const after = await getProtection(ctx.pool, id);
    assert.equal(after!.instrumentId, "BTC-15MAY26-80000-C");
  } finally {
    await ctx.close();
  }
});

test("reconcile-orphan-hedge: rejects direction-mismatch (SHORT + put instrument)", async () => {
  const ctx = await buildApp();
  try {
    const id = await seedOrphanProtection(ctx.pool, { protectionType: "short" });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/${id}/reconcile-orphan-hedge`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        venue: "deribit_live",
        instrumentId: "BTC-15MAY26-79000-P",
        side: "buy",
        size: "0.1",
        executionPriceBtc: "0.0200",
        premiumUsd: "155",
        executedAt: "2026-05-01T12:18:18.000Z",
        externalOrderId: "ord-1"
      }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().reason, "direction_mismatch");
  } finally {
    await ctx.close();
  }
});

test("reconcile-orphan-hedge: 404 for unknown protection id", async () => {
  const ctx = await buildApp();
  try {
    const res = await ctx.app.inject({
      method: "POST",
      url: `/pilot/admin/protections/00000000-0000-0000-0000-000000000000/reconcile-orphan-hedge`,
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: {
        venue: "deribit_live",
        instrumentId: "BTC-15MAY26-79000-C",
        side: "buy",
        size: "0.1",
        executionPriceBtc: "0.0200",
        premiumUsd: "155",
        executedAt: "2026-05-01T12:18:18.000Z",
        externalOrderId: "ord-1"
      }
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().reason, "not_found");
  } finally {
    await ctx.close();
  }
});
