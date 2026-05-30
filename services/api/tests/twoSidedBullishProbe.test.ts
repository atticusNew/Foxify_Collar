/**
 * Tests for GET /admin/foxify/v2/bullish-whitelist-probe.
 * The probe is a thin wrapper around fetch() so we test the request shaping,
 * auth gate, query param handling, and interpretation logic via injected
 * fetch mocks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFoxifyV2Routes, type FoxifyV2RoutesDeps } from "../src/singleSide/twoSided/routes";

const ADMIN_TOKEN = "test-admin-token-32-chars-1234567890";
process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;

const minimalDeps = (): FoxifyV2RoutesDeps => ({
  pool: {} as unknown as FoxifyV2RoutesDeps["pool"],
  feedService: { getCurrentFeed: () => null, getHealth: () => ({ healthy: false, degraded: true, unavailable: false, lastAggregationMs: null, ageMs: null, health: "unavailable", perSourceLast60sSuccess: {}, totalPolls: 0 }) } as unknown as FoxifyV2RoutesDeps["feedService"],
  dvolService: { getCurrentDvol: () => null } as unknown as FoxifyV2RoutesDeps["dvolService"],
  anchorProvider: {} as unknown as FoxifyV2RoutesDeps["anchorProvider"],
  executor: { executeStrangle: async () => ({ ok: false, reason: "both_failed", putLegResult: { ok: false, reason: "venue_error", detail: "test" }, callLegResult: { ok: false, reason: "venue_error", detail: "test" } }) } as unknown as FoxifyV2RoutesDeps["executor"]
});

const startApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  await app.register(async (instance) => {
    await registerFoxifyV2Routes(instance, minimalDeps());
  });
  await app.ready();
  return app;
};

// Helper to swap global fetch and restore
const withMockedFetch = async (
  mockFetch: typeof fetch,
  fn: () => Promise<void>
): Promise<void> => {
  const original = global.fetch;
  (global as { fetch: typeof fetch }).fetch = mockFetch;
  try { await fn(); } finally { (global as { fetch: typeof fetch }).fetch = original; }
};

test("bullish-whitelist-probe: rejects without admin token", async () => {
  const app = await startApp();
  try {
    const res = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-whitelist-probe" });
    assert.equal(res.statusCode, 401);
  } finally { await app.close(); }
});

test("bullish-whitelist-probe: defaults to registered endpoint", async () => {
  let capturedUrl = "";
  const mockFetch = (async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(capturedUrl.startsWith("https://registered.api.exchange.bullish.com/"));
      assert.equal(body.http_status, 200);
      assert.match(body.interpretation, /REACHED_AND_OK/);
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: ?endpoint=public probes public host", async () => {
  let capturedUrl = "";
  const mockFetch = (async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe?endpoint=public",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      assert.ok(capturedUrl.startsWith("https://api.exchange.bullish.com/"));
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: 401 from Bullish = REACHED_NEEDS_AUTH (good signal)", async () => {
  const mockFetch = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      const body = JSON.parse(res.body);
      assert.equal(body.http_status, 401);
      assert.match(body.interpretation, /REACHED_NEEDS_AUTH/);
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: 403 with cloudflare body = BLOCKED interpretation", async () => {
  const mockFetch = (async () => new Response("<html>Cloudflare blocked this request</html>", { status: 403 })) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      const body = JSON.parse(res.body);
      assert.equal(body.http_status, 403);
      assert.match(body.interpretation, /BLOCKED.*NOT whitelisted/);
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: 429 = REACHED_RATE_LIMITED", async () => {
  const mockFetch = (async () => new Response('{"error":"too_many_requests"}', { status: 429 })) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      const body = JSON.parse(res.body);
      assert.match(body.interpretation, /REACHED_RATE_LIMITED/);
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: network timeout = TIMEOUT interpretation", async () => {
  const mockFetch = (async () => { throw new Error("The operation was aborted due to timeout"); }) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      const body = JSON.parse(res.body);
      assert.equal(body.http_status, null);
      assert.match(body.interpretation, /TIMEOUT.*NOT whitelisted/);
    } finally { await app.close(); }
  });
});

test("bullish-whitelist-probe: ECONNREFUSED = NOT whitelisted", async () => {
  const mockFetch = (async () => { throw new Error("connect ECONNREFUSED 1.2.3.4:443"); }) as unknown as typeof fetch;
  const app = await startApp();
  await withMockedFetch(mockFetch, async () => {
    try {
      const res = await app.inject({
        method: "GET",
        url: "/admin/foxify/v2/bullish-whitelist-probe",
        headers: { "x-admin-token": ADMIN_TOKEN }
      });
      const body = JSON.parse(res.body);
      assert.match(body.interpretation, /CONNECTION_REFUSED.*NOT whitelisted/);
    } finally { await app.close(); }
  });
});
