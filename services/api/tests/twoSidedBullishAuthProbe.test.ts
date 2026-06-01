/**
 * bullish-auth-probe endpoint — authenticated whitelist/auth check that runs
 * server-side (from the deployment's whitelisted IP). Verifies success, the
 * error classification (403 → not whitelisted), and the 503 when no client.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { registerFoxifyV2Routes } from "../src/singleSide/twoSided/routes";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import { FeedService } from "../src/singleSide/twoSided/feedService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const ADMIN = "admin-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const buildApp = async (probe: { getTradingAccounts: () => Promise<unknown> } | null): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN;
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [{ source: "deribit", price: 76000, ts: nowMs }, { source: "coinbase", price: 76001, ts: nowMs }, { source: "kraken", price: 75999, ts: nowMs }],
      attempted: 3, succeeded: 3, perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" }, pollLatencyMs: 5
    }),
    log: () => {}
  });
  await feedService.start();
  const dvolService = new DvolService({ fetchOverride: async () => 50.0, log: () => {} });
  await dvolService.tick();
  const anchorProvider: LiveAnchorProvider = { getAnchorForLeg: async () => ({ bullish: null, deribit: null }) };
  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, {
    pool, feedService, dvolService, anchorProvider, executor: new MockStrangleExecutor(),
    bullishProbeClient: probe
  });
  await app.ready();
  return { app, cleanup: async () => { feedService.stop(); dvolService.stop(); await app.close(); } };
};

test("bullish-auth-probe: success → authed + whitelist active", async () => {
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => [{ tradingAccountId: "x" }] });
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-auth-probe", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.ok, true);
    assert.equal(b.authenticated, true);
    assert.equal(b.whitelist, "active");
    assert.equal(b.trading_accounts_count, 1);
  } finally { await cleanup(); }
});

test("bullish-auth-probe: 403 error → likely_not_whitelisted", async () => {
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => { throw new Error("bullish_http_403: forbidden"); } });
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-auth-probe", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 200); // probe reports the failure in-body (not an HTTP error)
    const b = r.json();
    assert.equal(b.ok, false);
    assert.equal(b.whitelist, "likely_not_whitelisted");
    assert.match(b.interpretation, /NOT whitelisted/);
  } finally { await cleanup(); }
});

test("bullish-auth-probe: 429 → reached + authed, rate-limited (whitelist active)", async () => {
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => { throw new Error("bullish_http_429: RATE_LIMIT_EXCEEDED 96100"); } });
  try {
    const b = (await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-auth-probe", headers: { "x-admin-token": ADMIN } })).json();
    assert.equal(b.ok, false);
    assert.equal(b.whitelist, "active");
    assert.match(b.interpretation, /RATE_LIMITED/);
  } finally { await cleanup(); }
});

test("bullish-auth-probe: 503 when no client wired", async () => {
  const { app, cleanup } = await buildApp(null);
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-auth-probe", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, "bullish_client_unavailable");
  } finally { await cleanup(); }
});

test("bullish-auth-probe: requires admin token", async () => {
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => [] });
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-auth-probe" });
    assert.equal(r.statusCode, 401);
  } finally { await cleanup(); }
});
