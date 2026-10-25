/**
 * Demo cache: stale-while-revalidate is bounded. A scan younger than the TTL is served as is; one
 * past the TTL is served while a refresh runs; one past the stale ceiling is not served before
 * its refresh (the request waits, up to the wait cap), so the first visitor after an idle hour
 * reads live books, not that hour's.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

test("demo cache: the three ages map to serve, refresh-and-serve, refresh-and-wait; defaults are 10s and 60s", async () => {
  const { cacheServeDecision } = await import("../scripts/eventProtectXDemoService");
  const limits = { ttlMs: 10_000, staleMaxMs: 60_000 };
  assert.equal(cacheServeDecision(0, limits), "serve");
  assert.equal(cacheServeDecision(9_999, limits), "serve");
  assert.equal(cacheServeDecision(10_000, limits), "refresh_and_serve", "at the TTL the refresh starts, the old scan still answers");
  assert.equal(cacheServeDecision(59_999, limits), "refresh_and_serve");
  assert.equal(cacheServeDecision(60_000, limits), "refresh_and_wait", "at the ceiling the request waits for the refresh");
  assert.equal(cacheServeDecision(3_600_000, limits), "refresh_and_wait");
  // the module's own thresholds (no env set): 10s TTL, 60s ceiling
  assert.equal(cacheServeDecision(5_000), "serve");
  assert.equal(cacheServeDecision(30_000), "refresh_and_serve");
  assert.equal(cacheServeDecision(61_000), "refresh_and_wait");
});
