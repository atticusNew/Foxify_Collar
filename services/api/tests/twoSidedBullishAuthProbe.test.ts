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

type ProbeClient = {
  getTradingAccounts: () => Promise<unknown>;
  getMarkets?: (p?: { forceRefresh?: boolean; cacheTtlMs?: number }) => Promise<Array<Record<string, unknown>>>;
  getHybridOrderBook?: (symbol: string) => Promise<{ bids?: Array<{ price: string | number }>; asks?: Array<{ price: string | number }> }>;
};

const buildApp = async (probe: ProbeClient | null): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
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

// ── markets-probe (diagnose 0-quote cause) ──

const mkMarket = (strike: number, optType: "PUT" | "CALL", daysToExpiry: number) => ({
  symbol: `BTC-${strike}-${optType}-${daysToExpiry}d`,
  marketEnabled: true, createOrderEnabled: true, underlyingBaseSymbol: "BTC",
  optionType: optType, optionStrikePrice: String(strike),
  expiryDatetime: new Date(Date.now() + daysToExpiry * 86_400_000).toISOString()
});

test("bullish-markets-probe: BTC options exist but all far-dated → diagnoses sparse expiry calendar", async () => {
  // Feed spot is 76000; markets are near-spot strikes but expire in ~30d (miss the 3d±1.5 window).
  const markets = [mkMarket(76000, "PUT", 30), mkMarket(76000, "CALL", 30), mkMarket(75000, "PUT", 30)];
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => [], getMarkets: async () => markets });
  try {
    const b = (await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-markets-probe?tenor_days=3", headers: { "x-admin-token": ADMIN } })).json();
    assert.equal(b.ok, true);
    assert.equal(b.funnel.btc_options, 3);
    assert.equal(b.funnel.enabled_btc_options, 3);
    assert.equal(b.funnel.within_tenor_window, 0, "30d expiries miss the 3d window");
    assert.match(b.diagnosis, /NONE within|sparse expiry/i);
  } finally { await cleanup(); }
});

test("bullish-markets-probe: a matching near-3d contract → diagnoses quotable", async () => {
  const markets = [mkMarket(76000, "PUT", 3), mkMarket(76000, "CALL", 3)];
  const probe: ProbeClient = {
    getTradingAccounts: async () => [],
    getMarkets: async () => markets,
    getHybridOrderBook: async () => ({ bids: [{ price: 1500 }], asks: [{ price: 1600 }] })
  };
  const { app, cleanup } = await buildApp(probe);
  try {
    const b = (await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-markets-probe?tenor_days=3", headers: { "x-admin-token": ADMIN } })).json();
    assert.equal(b.funnel.within_both >= 1, true);
    assert.ok(b.near_atm_books_with_liquidity >= 1, "at least one near-ATM book has liquidity");
    assert.equal(b.orderbook_samples[0].has_book, true);
    assert.match(b.diagnosis, /quotable/i);
  } finally { await cleanup(); }
});

test("bullish-markets-probe: matching contracts but EMPTY books → diagnoses no resting / RFQ", async () => {
  const markets = [mkMarket(73000, "PUT", 3), mkMarket(73000, "CALL", 3)];
  const probe: ProbeClient = {
    getTradingAccounts: async () => [],
    getMarkets: async () => markets,
    getHybridOrderBook: async () => ({ bids: [], asks: [] }) // listed but empty book
  };
  const { app, cleanup } = await buildApp(probe);
  try {
    const b = (await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-markets-probe?tenor_days=3", headers: { "x-admin-token": ADMIN } })).json();
    assert.equal(b.near_atm_books_with_liquidity, 0);
    assert.match(b.diagnosis, /EMPTY|RFQ|resting/i);
  } finally { await cleanup(); }
});

test("bullish-markets-probe: 503 when getMarkets not wired", async () => {
  const { app, cleanup } = await buildApp({ getTradingAccounts: async () => [] });
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/bullish-markets-probe", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 503);
  } finally { await cleanup(); }
});
