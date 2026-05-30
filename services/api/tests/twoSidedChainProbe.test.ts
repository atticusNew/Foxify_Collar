/**
 * Tests for GET /admin/foxify/v2/chain-probe.
 * Validates input parsing, auth, snapshot shape extraction, and the
 * 503 case when LiquidChainCache isn't wired.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFoxifyV2Routes, type FoxifyV2RoutesDeps } from "../src/singleSide/twoSided/routes";

const ADMIN_TOKEN = "test-admin-token-32-chars-1234567890";
process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;

const fakeSnapshot = {
  fetchedAtMs: Date.now(),
  spot: 73941.305,
  venueStatus: {
    bullish: { ok: true, quoteCount: 100 },
    deribit: { ok: true, quoteCount: 200 }
  },
  quotes: [
    {
      venue: "bullish" as const,
      instrument_name: "BTC-31MAY26-73000-P",
      strike: 73000,
      optType: "put" as const,
      tenorHours: 48,
      bidUsdcPerBtc: 25,
      askUsdcPerBtc: 40,
      midUsdcPerBtc: 32.5,
      spreadPct: 37.5,
      markIv: 35.2
    },
    {
      venue: "deribit" as const,
      instrument_name: "BTC-1JUN26-73000-P",
      strike: 73000,
      optType: "put" as const,
      tenorHours: 72,
      bidUsdcPerBtc: 30,
      askUsdcPerBtc: 50,
      midUsdcPerBtc: 40,
      spreadPct: 40,
      markIv: 36
    },
    {
      venue: "bullish" as const,
      instrument_name: "BTC-31MAY26-75000-C",
      strike: 75000,
      optType: "call" as const,
      tenorHours: 48,
      bidUsdcPerBtc: 20,
      askUsdcPerBtc: 35,
      midUsdcPerBtc: 27.5,
      spreadPct: 42.8,
      markIv: 35.5
    }
  ]
};

const makeFakeCache = (snapshot: typeof fakeSnapshot | null = fakeSnapshot) => ({
  getChain: async () => snapshot,
  refresh: async () => snapshot,
  getBidForLeg: (opts: { strike: number; optType: "put" | "call"; tenorRemainingHours: number; preferVenue?: string }) => {
    if (!snapshot) return null;
    const matches = snapshot.quotes.filter(
      (q) => q.strike === opts.strike && q.optType === opts.optType && q.bidUsdcPerBtc > 0
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      if (opts.preferVenue) {
        if (a.venue === opts.preferVenue && b.venue !== opts.preferVenue) return -1;
        if (b.venue === opts.preferVenue && a.venue !== opts.preferVenue) return 1;
      }
      return Math.abs(a.tenorHours - opts.tenorRemainingHours) - Math.abs(b.tenorHours - opts.tenorRemainingHours);
    });
    const best = matches[0];
    return {
      bidUsdcPerBtc: best.bidUsdcPerBtc,
      askUsdcPerBtc: best.askUsdcPerBtc,
      midUsdcPerBtc: best.midUsdcPerBtc,
      spreadPct: best.spreadPct,
      venue: best.venue,
      instrumentName: best.instrument_name,
      tenorHours: best.tenorHours,
      markIv: best.markIv,
      pulledAtMs: snapshot.fetchedAtMs
    };
  },
  getCached: () => snapshot
});

const baseDeps = (overrides: Partial<FoxifyV2RoutesDeps> = {}): FoxifyV2RoutesDeps => ({
  pool: {} as unknown as FoxifyV2RoutesDeps["pool"],
  feedService: { getCurrentFeed: () => null, getHealth: () => ({ healthy: false, degraded: true, unavailable: false, lastAggregationMs: null, ageMs: null, health: "unavailable", perSourceLast60sSuccess: {}, totalPolls: 0 }) } as unknown as FoxifyV2RoutesDeps["feedService"],
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

test("chain-probe: rejects without admin token", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache() as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({ method: "GET", url: "/admin/foxify/v2/chain-probe?strikes=73000" });
    assert.equal(res.statusCode, 401);
  } finally { await app.close(); }
});

test("chain-probe: 503 when LiquidChainCache not wired", async () => {
  const app = await startApp(baseDeps()); // no cache
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe?strikes=73000",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /chain_cache_unavailable/);
  } finally { await app.close(); }
});

test("chain-probe: 400 when no strikes", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache() as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 400);
  } finally { await app.close(); }
});

test("chain-probe: returns per-strike per-side quotes", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache() as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe?strikes=73000,75000&opt_type=both&tenor_hours=48",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.spot, 73941.305);
    assert.equal(body.requested_tenor_hours, 48);
    assert.equal(body.strikes.length, 2);
    const strike73k = body.strikes.find((s: { strike: number }) => s.strike === 73000);
    assert.ok(strike73k, "should have entry for strike 73000");
    assert.ok(Array.isArray(strike73k.put_quotes), "put_quotes should be an array");
    assert.equal(strike73k.put_quotes.length, 2, "should have 2 put quotes for 73000 (bullish + deribit)");
    assert.equal(strike73k.put_quotes[0].venue, "bullish");
    assert.equal(strike73k.put_quotes[0].bid_usdc_per_btc, 25);
    assert.equal(strike73k.put_quotes[0].ask_usdc_per_btc, 40);
    assert.ok(strike73k.put_picker_bid_choice, "picker bid choice should be populated");
    assert.equal(strike73k.put_picker_bid_choice.venue, "bullish", "picker prefers bullish");
    assert.equal(strike73k.put_picker_bid_choice.bid_usdc_per_btc, 25);
    // call side present?
    assert.ok(Array.isArray(strike73k.call_quotes));
  } finally { await app.close(); }
});

test("chain-probe: opt_type=put filters out calls", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache() as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe?strikes=73000&opt_type=put&tenor_hours=48",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    const body = JSON.parse(res.body);
    assert.ok(body.strikes[0].put_quotes !== undefined);
    assert.equal(body.strikes[0].call_quotes, undefined);
  } finally { await app.close(); }
});

test("chain-probe: 503 when snapshot is null (all venues down)", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache(null) as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe?strikes=73000",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /no_chain_snapshot/);
  } finally { await app.close(); }
});

test("chain-probe: invalid opt_type returns 400", async () => {
  const app = await startApp(baseDeps({ liquidChainCache: makeFakeCache() as unknown as FoxifyV2RoutesDeps["liquidChainCache"] }));
  try {
    const res = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/chain-probe?strikes=73000&opt_type=banana",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(res.statusCode, 400);
  } finally { await app.close(); }
});
