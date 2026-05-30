/**
 * Tests for POST /admin/foxify/v2/force-trigger admin endpoint.
 * Tests the route-level validation + callback wiring.
 * The actual force-trigger logic lives in server.ts (where it has access
 * to the runtime registry); this test mocks the callback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFoxifyV2Routes, type FoxifyV2RoutesDeps } from "../src/singleSide/twoSided/routes";

const minimalDeps = (overrides: Partial<FoxifyV2RoutesDeps> = {}): FoxifyV2RoutesDeps => ({
  pool: {} as unknown as FoxifyV2RoutesDeps["pool"],
  feedService: { getCurrentFeed: () => null, getHealth: () => ({ healthy: false, degraded: true, unavailable: false, lastAggregationMs: null, ageMs: null, health: "unavailable", perSourceLast60sSuccess: {}, totalPolls: 0 }) } as unknown as FoxifyV2RoutesDeps["feedService"],
  dvolService: { getCurrentDvol: () => null } as unknown as FoxifyV2RoutesDeps["dvolService"],
  anchorProvider: {} as unknown as FoxifyV2RoutesDeps["anchorProvider"],
  executor: { executeStrangle: async () => ({ ok: false, reason: "both_failed", putLegResult: { ok: false, reason: "venue_error", detail: "test" }, callLegResult: { ok: false, reason: "venue_error", detail: "test" } }) } as unknown as FoxifyV2RoutesDeps["executor"],
  ...overrides
});

const ADMIN_TOKEN = "test-admin-token-32-chars-1234567890";

// Auth handlers read PILOT_ADMIN_TOKEN at request time, so set it for all tests.
process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;

const startApp = async (deps: FoxifyV2RoutesDeps): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await registerFoxifyV2Routes(instance, deps);
  });
  await app.ready();
  return app;
};

test("POST /admin/foxify/v2/force-trigger: 400 when pair_id missing", async () => {
  const app = await startApp(minimalDeps({ forceTriggerPair: async () => ({ ok: true as const, pair_id: "x", triggered_at: "x", runtime_started: true }) }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({})
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /pair_id required/);
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: 400 when side invalid", async () => {
  const app = await startApp(minimalDeps({ forceTriggerPair: async () => ({ ok: true as const, pair_id: "x", triggered_at: "x", runtime_started: true }) }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "p1", side: "sideways" })
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /side must be 'down' or 'up'/);
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: 503 when callback not wired", async () => {
  const app = await startApp(minimalDeps()); // no forceTriggerPair
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "p1", side: "up" })
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /force_trigger_unavailable/);
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: 202 on success", async () => {
  let calledWith: { pairId?: string; side?: string } = {};
  const app = await startApp(minimalDeps({
    forceTriggerPair: async (pairId, side) => {
      calledWith = { pairId, side };
      return { ok: true as const, pair_id: pairId, triggered_at: "2026-05-30T12:00:00Z", runtime_started: true };
    }
  }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "abc-123", side: "up" })
    });
    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.pair_id, "abc-123");
    assert.equal(body.runtime_started, true);
    assert.equal(calledWith.pairId, "abc-123");
    assert.equal(calledWith.side, "up");
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: defaults side to 'up'", async () => {
  let capturedSide: string | undefined;
  const app = await startApp(minimalDeps({
    forceTriggerPair: async (_pairId, side) => {
      capturedSide = side;
      return { ok: true as const, pair_id: "x", triggered_at: "x", runtime_started: true };
    }
  }));
  try {
    await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "p1" })
    });
    assert.equal(capturedSide, "up");
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: 409 when callback returns ok:false", async () => {
  const app = await startApp(minimalDeps({
    forceTriggerPair: async () => ({ ok: false as const, error: "refuses_live_pair", details: { reason: "shadow_only" } })
  }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "live-pair", side: "up" })
    });
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.error, "refuses_live_pair");
  } finally { await app.close(); }
});

test("POST /admin/foxify/v2/force-trigger: rejects without admin token", async () => {
  const app = await startApp(minimalDeps({ forceTriggerPair: async () => ({ ok: true as const, pair_id: "x", triggered_at: "x", runtime_started: true }) }));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/force-trigger",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pair_id: "p1", side: "up" })
    });
    assert.equal(res.statusCode, 401);
  } finally { await app.close(); }
});
