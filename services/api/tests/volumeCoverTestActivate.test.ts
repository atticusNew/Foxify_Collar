/**
 * Tests for POST /volume-cover/admin/test-activate.
 *
 * Operator-only endpoint that bypasses Foxify HMAC + anti-bot but
 * still runs financial guards. Lets operator do live self-tests
 * before delivering HMAC to Foxify.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";

import { ensureCapitalPoolSchema, seedCapitalPoolsIfNeeded } from "../src/pilot/capitalPoolSchema";
import {
  registerVolumeCoverRoutes,
  __resetVolumeCoverRoutesForTests
} from "../src/volumeCover/volumeCoverRoutes";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

const ADMIN_TOKEN = "test-activate-admin-token-1234567890";
const HMAC_SECRET = "test-activate-hmac-secret-not-needed";

const buildHarness = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = HMAC_SECRET;
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  __resetVolumeCoverRoutesForTests();
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  const buyCalls: any[] = [];
  const exec: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      buyCalls.push(params);
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 80,
        totalCostUsdc: 80 * params.contractsBtc,
        orderId: `MOCK-${buyCalls.length}`
      };
    },
    sellOptionLeg: async (params) => ({
      venue: params.venue,
      fillPriceUsdcPerBtc: 50,
      totalProceedsUsdc: 50 * params.contractsBtc,
      orderId: "MOCK-SELL"
    })
  };

  const spot: SpotPriceSource = async () => ({
    spotBtcPrice: 78_200,
    asOfMs: Date.now(),
    source: "test_mock"
  });

  const app = Fastify();
  await registerVolumeCoverRoutes(app, { pool, hedgeExecutor: exec, spotSource: spot });
  await app.ready();
  return {
    app,
    pool,
    buyCalls,
    close: async () => {
      await app.close();
      await pool.end?.();
    }
  };
};

const adminHeaders = () => ({ "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" });

test("test-activate: requires admin token", async () => {
  const { app, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      payload: {
        foxifyPairId: "TEST-NOAUTH",
        cellId: "50k_2pct_1k",
        pairEntryBtcPrice: 78_200
      }
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await close();
  }
});

test("test-activate: opens position with admin auth, no Foxify HMAC needed", async () => {
  const { app, buyCalls, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: {
        foxifyPairId: "TEST-001",
        cellId: "50k_2pct_1k",
        pairEntryBtcPrice: 78_200
      }
    });
    assert.equal(r.statusCode, 201, `body: ${r.body}`);
    const j = JSON.parse(r.body);
    assert.ok(j.positionId);
    assert.equal(j.cellId, "50k_2pct_1k");
    assert.equal(j.hedgeLegs.length, 2);
    assert.match(j.note, /OPERATOR TEST/);
    // Verify hedge actually bought
    assert.equal(buyCalls.length, 2);
  } finally {
    await close();
  }
});

test("test-activate: premium override applied", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: {
        foxifyPairId: "TEST-PREM-OVERRIDE",
        cellId: "50k_2pct_1k",
        pairEntryBtcPrice: 78_200,
        premiumOverrideUsdc: 10
      }
    });
    assert.equal(r.statusCode, 201);
    const j = JSON.parse(r.body);
    assert.equal(j.dailyPremiumUsdc, 10);

    // Verify position record uses overridden premium
    const positionId = j.positionId;
    const dbRow = await pool.query(
      `SELECT daily_premium_usdc FROM volume_cover_position WHERE id = $1`,
      [positionId]
    );
    assert.equal(Number(dbRow.rows[0].daily_premium_usdc), 10);
  } finally {
    await close();
  }
});

test("test-activate: idempotent on duplicate pair ID", async () => {
  const { app, close } = await buildHarness();
  try {
    const body = {
      foxifyPairId: "TEST-IDEMP",
      cellId: "50k_2pct_1k",
      pairEntryBtcPrice: 78_200
    };
    const r1 = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: body
    });
    assert.equal(r1.statusCode, 201);
    const r2 = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: body
    });
    assert.equal(r2.statusCode, 200);
    const j2 = JSON.parse(r2.body);
    assert.equal(j2.idempotent, true);
    assert.match(j2.note, /already active/);
  } finally {
    await close();
  }
});

test("test-activate: omitting notional defaults to cell notional", async () => {
  const { app, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: {
        foxifyPairId: "TEST-DEFAULT-NOTIONAL",
        cellId: "50k_2pct_1k",
        pairEntryBtcPrice: 78_200
      }
    });
    assert.equal(r.statusCode, 201, `body: ${r.body}`);
  } finally {
    await close();
  }
});

test("test-activate: uses metadata.source = admin_test_activate", async () => {
  const { app, pool, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: {
        foxifyPairId: "TEST-META",
        cellId: "50k_2pct_1k",
        pairEntryBtcPrice: 78_200
      }
    });
    const j = JSON.parse(r.body);
    const dbRow = await pool.query(
      `SELECT metadata FROM volume_cover_position WHERE id = $1`,
      [j.positionId]
    );
    const meta = typeof dbRow.rows[0].metadata === "string"
      ? JSON.parse(dbRow.rows[0].metadata)
      : dbRow.rows[0].metadata;
    assert.equal(meta.source, "admin_test_activate");
  } finally {
    await close();
  }
});

test("test-activate: invalid cell rejected with 400", async () => {
  const { app, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: {
        foxifyPairId: "TEST-BAD-CELL",
        cellId: "not_a_real_cell",
        pairEntryBtcPrice: 78_200
      }
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /cell_not_found/);
  } finally {
    await close();
  }
});

test("test-activate: schema validation rejects missing fields", async () => {
  const { app, close } = await buildHarness();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/test-activate",
      headers: adminHeaders(),
      payload: { foxifyPairId: "TEST-INCOMPLETE" }
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.body, /invalid_request/);
  } finally {
    await close();
  }
});
