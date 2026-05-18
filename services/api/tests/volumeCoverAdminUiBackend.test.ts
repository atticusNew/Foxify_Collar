/**
 * Smoke test for the backend endpoints the VC Admin UI consumes.
 * Verifies all 6 endpoints respond 200 with valid shape after an
 * end-to-end activation flow.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";
import { createHmac } from "node:crypto";

import { ensureCapitalPoolSchema, seedCapitalPoolsIfNeeded } from "../src/pilot/capitalPoolSchema";
import {
  registerVolumeCoverRoutes,
  __resetVolumeCoverRoutesForTests
} from "../src/volumeCover/volumeCoverRoutes";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

const ADMIN_TOKEN = "vc-admin-ui-test-token";
const HMAC_SECRET = "vc-admin-ui-test-hmac-secret-1234567890";

const mockExecutor: HedgeExecutor = {
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 50,
    totalProceedsUsdc: 50 * params.contractsBtc,
    orderId: `MOCK-${Math.random()}`
  })
};

const mockSpot: SpotPriceSource = async () => ({
  spotBtcPrice: 80_000,
  asOfMs: Date.now(),
  source: "bullish_hybrid"
});

const buildHarness = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = HMAC_SECRET;
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  process.env.VOLUME_COVER_GUARDS_ALL_DISABLED = "false";
  __resetVolumeCoverRoutesForTests();
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  const app = Fastify();
  await registerVolumeCoverRoutes(app, {
    pool,
    hedgeExecutor: mockExecutor,
    spotSource: mockSpot
  });
  await app.ready();
  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end?.();
    }
  };
};

const adminHeaders = () => ({ "x-admin-token": ADMIN_TOKEN });

const signFoxify = (method: string, path: string, body: any) => {
  const ts = String(Date.now());
  const sig = createHmac("sha256", HMAC_SECRET)
    .update(`${ts}\n${method.toUpperCase()}\n${path}\n${JSON.stringify(body)}`)
    .digest("hex");
  return {
    "x-foxify-signature": sig,
    "x-foxify-timestamp": ts,
    "content-type": "application/json"
  };
};

test("UI smoke: all 6 admin endpoints return 200 with valid shape", async () => {
  const { app, close } = await buildHarness();
  try {
    // 1. /volume-cover/health (no auth required)
    const health = await app.inject({ method: "GET", url: "/volume-cover/health" });
    assert.equal(health.statusCode, 200);
    const healthJson = JSON.parse(health.body);
    assert.ok(typeof healthJson.cellsConfigured === "number");
    assert.ok(typeof healthJson.activePositions === "number");

    // Open one position so subsequent endpoints have data
    const body = {
      foxifyPairId: "FX-UI-SMOKE-1",
      cellId: "50k_2pct_1k",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    };
    const activate = await app.inject({
      method: "POST",
      url: "/volume-cover/activate",
      headers: signFoxify("POST", "/volume-cover/activate", body),
      payload: body
    });
    assert.equal(activate.statusCode, 201);

    // 2. /volume-cover/admin/pair-events
    const pe = await app.inject({
      method: "GET",
      url: "/volume-cover/admin/pair-events?limit=50",
      headers: adminHeaders()
    });
    assert.equal(pe.statusCode, 200);
    const peJson = JSON.parse(pe.body);
    assert.ok(Array.isArray(peJson.events));
    assert.ok(peJson.events.length >= 1);
    const evt = peJson.events[0];
    // Shape match for UI consumption
    assert.ok(typeof evt.id === "string");
    assert.ok(typeof evt.foxifyPairId === "string");
    assert.ok(typeof evt.cellId === "string");
    assert.ok(["activated", "idempotent", "rejected", "failed"].includes(evt.result));
    assert.ok(typeof evt.totalLatencyMs === "number");

    // 3. /volume-cover/admin/pair-event-stats
    const pes = await app.inject({
      method: "GET",
      url: "/volume-cover/admin/pair-event-stats?windowHours=24",
      headers: adminHeaders()
    });
    assert.equal(pes.statusCode, 200);
    const pesJson = JSON.parse(pes.body);
    assert.ok(typeof pesJson.count === "number");
    // p50 may be null if 0 events; otherwise number
    assert.ok(pesJson.p50Ms === null || typeof pesJson.p50Ms === "number");

    // 4. /volume-cover/admin/active-positions-detail
    const apd = await app.inject({
      method: "GET",
      url: "/volume-cover/admin/active-positions-detail?limit=50",
      headers: adminHeaders()
    });
    assert.equal(apd.statusCode, 200);
    const apdJson = JSON.parse(apd.body);
    assert.ok(Array.isArray(apdJson.positions));
    assert.ok(apdJson.positions.length >= 1);
    const pos = apdJson.positions[0];
    assert.ok(typeof pos.id === "string");
    assert.ok(typeof pos.cellId === "string");
    assert.ok(typeof pos.triggerHighBtc === "number");
    assert.ok(typeof pos.triggerLowBtc === "number");
    assert.ok(Array.isArray(pos.legs));
    assert.equal(pos.legs.length, 2, "expected 2 hedge legs (put + call)");
    for (const leg of pos.legs) {
      assert.ok(["put", "call"].includes(leg.optionKind));
      assert.ok(typeof leg.strikeUsdc === "number");
      assert.ok(typeof leg.contracts === "number");
      assert.ok(typeof leg.buyPriceUsdc === "number");
      assert.ok(typeof leg.retained === "boolean");
    }
    assert.ok(typeof apdJson.currentSpotBtc === "number");
    assert.ok(typeof apdJson.spotSource === "string");

    // 5. /volume-cover/admin/salvage-stats
    const sg = await app.inject({
      method: "GET",
      url: "/volume-cover/admin/salvage-stats",
      headers: adminHeaders()
    });
    assert.equal(sg.statusCode, 200);
    const sgJson = JSON.parse(sg.body);
    assert.ok(typeof sgJson.rolling7dayAtticusLossUsdc === "number");
    assert.ok(typeof sgJson.rolling24hTriggerCount === "number");

    // 6. /volume-cover/admin/cells
    const cl = await app.inject({
      method: "GET",
      url: "/volume-cover/admin/cells",
      headers: adminHeaders()
    });
    assert.equal(cl.statusCode, 200);
    const clJson = JSON.parse(cl.body);
    assert.ok(Array.isArray(clJson.cells));
    assert.equal(clJson.cells.length, 6);
    for (const c of clJson.cells) {
      assert.ok(typeof c.cellId === "string");
      assert.ok(typeof c.notionalUsdc === "number");
      assert.ok(typeof c.triggerPct === "number");
      assert.ok(typeof c.dailyPremiumUsdc === "number");
      assert.ok(typeof c.enabled === "boolean");
    }

    // 7. POST halt + clear (UI buttons)
    const haltRes = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/halt",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      payload: { reason: "ui_smoke_test" }
    });
    assert.equal(haltRes.statusCode, 200);
    assert.equal(JSON.parse(haltRes.body).halt.halted, true);

    const clearRes = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/halt/clear",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      payload: {}
    });
    assert.equal(clearRes.statusCode, 200);
    assert.equal(JSON.parse(clearRes.body).halt.halted, false);

    // 8. POST cell toggle (UI button)
    const toggleRes = await app.inject({
      method: "POST",
      url: "/volume-cover/admin/cells/50k_5pct_2_5k/toggle",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      payload: { enabled: false }
    });
    assert.equal(toggleRes.statusCode, 200);
    const toggleJson = JSON.parse(toggleRes.body);
    assert.equal(toggleJson.cell.enabled, false);

    // 9. POST close position (UI per-row button)
    const closeRes = await app.inject({
      method: "POST",
      url: `/volume-cover/admin/positions/${pos.id}/close`,
      headers: { ...adminHeaders(), "content-type": "application/json" },
      payload: { reason: "ui_smoke_close_test" }
    });
    assert.equal(closeRes.statusCode, 200);
  } finally {
    await close();
  }
});
