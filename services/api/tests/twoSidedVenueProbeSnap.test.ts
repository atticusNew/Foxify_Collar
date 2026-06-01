/**
 * venue-probe ?snap_to_bullish=true (read-only what-if): snaps each leg to
 * Bullish's nearest listed strike and compares both venues at that strike.
 * Proves snapping can make Bullish win the round-trip when its spread is tight,
 * and still rejects it when wide — without touching the activation path.
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
import type { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const ADMIN = "admin-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Cell pair_50k_3pct_atm_3d at spot 74085 → ATM snaps to 74000 for both legs.
// Bullish lists 73500 (off our $1k grid). Put: Bullish tight (wins); Call: Bullish wide (loses).
const q = (venue: string, strike: number, optType: string, ask: number, bid: number) => ({
  venue, strike, optType, tenorHours: 72, askUsdcPerBtc: ask, bidUsdcPerBtc: bid,
  midUsdcPerBtc: (ask + bid) / 2, spreadPct: (ask - bid) / ((ask + bid) / 2),
  instrument_name: `${venue[0].toUpperCase()}-${strike}-${optType[0].toUpperCase()}`, markIv: 0
});
const chainSnapshot = {
  fetchedAtMs: Date.now(), spot: 74085, venueStatus: {},
  quotes: [
    q("bullish", 73500, "put", 1000, 960),  // tight → rt 1040
    q("deribit", 73500, "put", 1010, 950),  // rt 1070
    q("bullish", 73500, "call", 1000, 600), // wide → rt 1400
    q("deribit", 73500, "call", 1005, 945)  // rt 1065
  ]
};

const buildApp = async (): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN;
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [{ source: "deribit", price: 74085, ts: nowMs }, { source: "coinbase", price: 74086, ts: nowMs }, { source: "kraken", price: 74084, ts: nowMs }],
      attempted: 3, succeeded: 3, perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" }, pollLatencyMs: 5
    }),
    log: () => {}
  });
  await feedService.start();
  const dvolService = new DvolService({ fetchOverride: async () => 35.0, log: () => {} });
  await dvolService.tick();
  const anchorProvider: LiveAnchorProvider = { getAnchorForLeg: async () => ({ bullish: null, deribit: null }) };
  const liquidChainCache = {
    getChain: async () => chainSnapshot,
    getCached: () => chainSnapshot,
    getBidForLeg: () => null,
    getBidForSymbol: () => null
  } as unknown as LiquidChainCache;
  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, { pool, feedService, dvolService, anchorProvider, executor: new MockStrangleExecutor(), liquidChainCache });
  await app.ready();
  return { app, cleanup: async () => { feedService.stop(); dvolService.stop(); await app.close(); } };
};

test("venue-probe snap_to_bullish: snaps to Bullish strike; tight leg → Bullish wins, wide leg → Deribit", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/venue-probe?cell_id=pair_50k_3pct_atm_3d&snap_to_bullish=true", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.mode, "snap_to_bullish");
    const put = b.legs.find((l: { leg: string }) => l.leg === "put");
    const call = b.legs.find((l: { leg: string }) => l.leg === "call");
    // Both legs snapped from target 74000 → Bullish's nearest listed 73500.
    assert.equal(put.target_strike, 74000);
    assert.equal(put.snapped_bullish_strike, 73500);
    assert.equal(put.snapped, true);
    // Put: Bullish round-trip 1040 < Deribit 1070 → Bullish wins (snapping helps).
    assert.equal(put.chosen_venue, "bullish");
    // Call: Bullish wide (rt 1400) > Deribit 1065 → Deribit wins (no bias).
    assert.equal(call.chosen_venue, "deribit");
  } finally { await cleanup(); }
});

test("venue-probe snap_to_bullish: 503 when no chain cache wired", async () => {
  // Minimal app WITHOUT liquidChainCache.
  process.env.PILOT_ADMIN_TOKEN = ADMIN;
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  const feedService = new FeedService({ pollOverride: async ({ nowMs }) => ({ samples: [{ source: "deribit", price: 74085, ts: nowMs }, { source: "coinbase", price: 74086, ts: nowMs }, { source: "kraken", price: 74084, ts: nowMs }], attempted: 3, succeeded: 3, perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" }, pollLatencyMs: 5 }), log: () => {} });
  await feedService.start();
  const dvolService = new DvolService({ fetchOverride: async () => 35.0, log: () => {} });
  await dvolService.tick();
  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, { pool, feedService, dvolService, anchorProvider: { getAnchorForLeg: async () => ({ bullish: null, deribit: null }) }, executor: new MockStrangleExecutor() });
  await app.ready();
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/venue-probe?cell_id=pair_50k_3pct_atm_3d&snap_to_bullish=true", headers: { "x-admin-token": ADMIN } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error, "chain_cache_unavailable");
  } finally { feedService.stop(); dvolService.stop(); await app.close(); }
});
