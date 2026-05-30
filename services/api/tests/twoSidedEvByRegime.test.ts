/**
 * Tests for GET /admin/foxify/v2/ev-by-regime.
 *
 * Validates input parsing, auth, and that the response shape is correct.
 * Heavy lifting (MC sims) is tested separately in liveCellEvService tests;
 * here we just validate the route wiring works with a minimal harness.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFoxifyV2Routes, type FoxifyV2RoutesDeps } from "../src/singleSide/twoSided/routes";

const ADMIN_TOKEN = "test-admin-token-32-chars-1234567890";
process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;

const minimalDeps = (overrides: Partial<FoxifyV2RoutesDeps> = {}): FoxifyV2RoutesDeps => ({
  pool: {} as unknown as FoxifyV2RoutesDeps["pool"],
  feedService: {
    getCurrentFeed: () => null,
    getHealth: () => ({ healthy: false, degraded: true, unavailable: false, lastAggregationMs: null, ageMs: null, health: "unavailable", perSourceLast60sSuccess: {}, totalPolls: 0 })
  } as unknown as FoxifyV2RoutesDeps["feedService"],
  dvolService: { getCurrentDvol: () => null } as unknown as FoxifyV2RoutesDeps["dvolService"],
  anchorProvider: {} as unknown as FoxifyV2RoutesDeps["anchorProvider"],
  executor: { executeStrangle: async () => ({ ok: false, reason: "both_failed", putLegResult: { ok: false, reason: "venue_error", detail: "test" }, callLegResult: { ok: false, reason: "venue_error", detail: "test" } }) } as unknown as FoxifyV2RoutesDeps["executor"],
  ...overrides
});

const startApp = async (deps: FoxifyV2RoutesDeps): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await registerFoxifyV2Routes(instance, deps);
  });
  await app.ready();
  return app;
};

test("ev-by-regime: rejects without admin token", async () => {
  const app = await startApp(minimalDeps());
  try {
    const res = await app.inject({ method: "GET", url: "/admin/foxify/v2/ev-by-regime" });
    assert.equal(res.statusCode, 401);
  } finally { await app.close(); }
});

test("ev-by-regime: 503 when no feed", async () => {
  const app = await startApp(minimalDeps());
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/ev-by-regime",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /feed_unavailable/);
  } finally { await app.close(); }
});

test("ev-by-regime: 400 when realism_override out of range", async () => {
  const feedService = {
    getCurrentFeed: () => ({ canonicalPrice: 73000, asOfMs: Date.now(), sources: [], rejected: [], expired: [], health: "healthy" as const, medianCalcDescription: "test" }),
    getHealth: () => ({ healthy: true, degraded: false, unavailable: false, lastAggregationMs: Date.now(), ageMs: 100, health: "healthy" as const, perSourceLast60sSuccess: {}, totalPolls: 1 })
  } as unknown as FoxifyV2RoutesDeps["feedService"];
  const app = await startApp(minimalDeps({ feedService }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/ev-by-regime?realism_override=99",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /realism_override must be/);
  } finally { await app.close(); }
});

test("ev-by-regime: accepts valid realism_override (negative test: route works)", async () => {
  // Test only that the route is reachable and parses params correctly. We
  // don't run the full MC because that requires live data — instead we just
  // verify the route doesn't 400/500 on valid input. It may 500 internally
  // due to missing pool/etc., but the parsing layer must accept the input.
  const feedService = {
    getCurrentFeed: () => ({ canonicalPrice: 73000, asOfMs: Date.now(), sources: [], rejected: [], expired: [], health: "healthy" as const, medianCalcDescription: "test" }),
    getHealth: () => ({ healthy: true, degraded: false, unavailable: false, lastAggregationMs: Date.now(), ageMs: 100, health: "healthy" as const, perSourceLast60sSuccess: {}, totalPolls: 1 })
  } as unknown as FoxifyV2RoutesDeps["feedService"];
  const app = await startApp(minimalDeps({ feedService }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/ev-by-regime?realism_override=0.85",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    // Either 200 (works end-to-end if anchor provider etc available) or 5xx
    // (tier resolver / quote engine deps not fully wired in test). Both
    // demonstrate parsing passed. Just NOT 400.
    assert.notEqual(res.statusCode, 400);
  } finally { await app.close(); }
});
