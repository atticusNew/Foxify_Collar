/**
 * PR A1 tests — 5-source feed fetchers + FeedService.
 *
 * Source fetchers (unit, mocked-fetch):
 *   - Deribit happy path returns sample
 *   - Coinbase happy path
 *   - Kraken happy path
 *   - Binance happy path
 *   - Bullish happy path (with creds)
 *   - Bullish returns null when creds missing
 *   - Source returns null on HTTP non-2xx
 *   - Source returns null on malformed JSON
 *
 * FeedService:
 *   - start → tick produces aggregated feed via pollOverride
 *   - getCurrentFeed returns cached snapshot
 *   - getHealth tracks per-source 60s window
 *   - isStale honors threshold
 *   - stop halts polling
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBullishSpot,
  fetchDeribitSpot,
  fetchCoinbaseSpot,
  fetchBinanceSpot,
  fetchKrakenSpot,
  pollAllSources,
  _resetBullishCacheForTests
} from "../src/singleSide/twoSided/feedSources";
import { FeedService } from "../src/singleSide/twoSided/feedService";

// Save + restore global fetch
const realFetch = globalThis.fetch;
const setMockFetch = (responses: Record<string, { status: number; body: unknown }>) => {
  globalThis.fetch = (async (url: string | URL | Request, _init?: unknown) => {
    const s = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (s.includes(pattern)) {
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body)
        } as Response;
      }
    }
    throw new Error(`Unmocked fetch: ${s}`);
  }) as typeof fetch;
};
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

// ─── Source fetchers ───

test("fetchDeribitSpot: returns sample on happy response", async () => {
  setMockFetch({ deribit: { status: 200, body: { result: { index_price: 74000 } } } });
  try {
    const r = await fetchDeribitSpot({ nowMs: 1_000_000 });
    assert.ok(r);
    assert.equal(r!.source, "deribit");
    assert.equal(r!.price, 74000);
    assert.equal(r!.ts, 1_000_000);
  } finally { restoreFetch(); }
});

test("fetchCoinbaseSpot: parses 'data.amount' string price", async () => {
  setMockFetch({ coinbase: { status: 200, body: { data: { amount: "74123.45" } } } });
  try {
    const r = await fetchCoinbaseSpot({ nowMs: 2_000_000 });
    assert.ok(r);
    assert.equal(r!.source, "coinbase");
    assert.equal(r!.price, 74123.45);
  } finally { restoreFetch(); }
});

test("fetchKrakenSpot: parses nested result.XXBTZUSD.c[0]", async () => {
  setMockFetch({ kraken: { status: 200, body: { error: [], result: { XXBTZUSD: { c: ["74050.10", "0.1"] } } } } });
  try {
    const r = await fetchKrakenSpot({ nowMs: 3_000_000 });
    assert.ok(r);
    assert.equal(r!.price, 74050.10);
  } finally { restoreFetch(); }
});

test("fetchBinanceSpot: parses price string", async () => {
  setMockFetch({ binance: { status: 200, body: { price: "74200" } } });
  try {
    const r = await fetchBinanceSpot({ nowMs: 4_000_000 });
    assert.ok(r);
    assert.equal(r!.price, 74200);
  } finally { restoreFetch(); }
});

test("fetchBullishSpot: returns sample when creds + chain present", async () => {
  _resetBullishCacheForTests();
  setMockFetch({
    "bullish-option-chain": {
      status: 200,
      body: { spotBtcUsdc: 74300, generatedAtIso: "2026-05-27T00:00:00Z" }
    }
  });
  try {
    const r = await fetchBullishSpot({
      renderApiUrl: "https://test.example.com",
      adminToken: "test-token",
      nowMs: 5_000_000
    });
    assert.ok(r);
    assert.equal(r!.source, "bullish");
    assert.equal(r!.price, 74300);
  } finally {
    restoreFetch();
    _resetBullishCacheForTests();
  }
});

test("fetchBullishSpot: returns null when creds missing", async () => {
  _resetBullishCacheForTests();
  const r = await fetchBullishSpot({ renderApiUrl: undefined, adminToken: undefined, nowMs: 6_000_000 });
  assert.equal(r, null);
});

test("Source returns null on non-2xx", async () => {
  setMockFetch({ deribit: { status: 500, body: {} } });
  try {
    const r = await fetchDeribitSpot({ nowMs: 7_000_000 });
    assert.equal(r, null);
  } finally { restoreFetch(); }
});

test("Source returns null on malformed price (NaN)", async () => {
  setMockFetch({ coinbase: { status: 200, body: { data: { amount: "not-a-number" } } } });
  try {
    const r = await fetchCoinbaseSpot({ nowMs: 8_000_000 });
    assert.equal(r, null);
  } finally { restoreFetch(); }
});

// ─── pollAllSources ───

test("pollAllSources: 4 ok + 1 fail returns degraded-friendly result", async () => {
  _resetBullishCacheForTests();
  setMockFetch({
    deribit: { status: 200, body: { result: { index_price: 74000 } } },
    coinbase: { status: 200, body: { data: { amount: "74010" } } },
    kraken: { status: 200, body: { error: [], result: { XXBTZUSD: { c: ["74020"] } } } },
    binance: { status: 500, body: {} },
    "bullish-option-chain": { status: 200, body: { spotBtcUsdc: 74030 } }
  });
  try {
    const r = await pollAllSources({ nowMs: 9_000_000, renderApiUrl: "https://test", adminToken: "tok" });
    assert.equal(r.attempted, 5);
    assert.equal(r.succeeded, 4);
    assert.equal(r.perSourceStatus.binance, "fail");
    assert.equal(r.perSourceStatus.deribit, "ok");
  } finally {
    restoreFetch();
    _resetBullishCacheForTests();
  }
});

// ─── FeedService ───

test("FeedService: tick produces aggregated feed via pollOverride", async () => {
  const svc = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [
        { source: "deribit", price: 74000, ts: nowMs },
        { source: "coinbase", price: 74005, ts: nowMs },
        { source: "kraken", price: 73995, ts: nowMs }
      ],
      attempted: 3,
      succeeded: 3,
      perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" },
      pollLatencyMs: 50
    }),
    log: () => {}
  });
  const { aggregated } = await svc.tick(1_000_000);
  assert.equal(aggregated.canonicalPrice, 74000);
  assert.equal(aggregated.health, "healthy");
  const f = svc.getCurrentFeed();
  assert.ok(f);
  assert.equal(f!.canonicalPrice, 74000);
});

test("FeedService: getHealth tracks per-source success", async () => {
  const svc = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [
        { source: "deribit", price: 74000, ts: nowMs },
        { source: "coinbase", price: 74010, ts: nowMs }
      ],
      attempted: 3,
      succeeded: 2,
      perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "fail" },
      pollLatencyMs: 20
    }),
    log: () => {}
  });
  await svc.tick(1_000_000);
  await svc.tick(1_001_000);
  await svc.tick(1_002_000);
  const h = svc.getHealth();
  assert.equal(h.totalPolls, 3);
  assert.equal(h.perSourceLast60sSuccess.deribit.ok, 3);
  assert.equal(h.perSourceLast60sSuccess.kraken.fail, 3);
  assert.equal(h.perSourceLast60sSuccess.kraken.pct, 0);
});

test("FeedService: isStale honors threshold", async () => {
  const svc = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [
        { source: "deribit", price: 74000, ts: nowMs },
        { source: "coinbase", price: 74010, ts: nowMs },
        { source: "kraken", price: 73990, ts: nowMs }
      ],
      attempted: 3,
      succeeded: 3,
      perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" },
      pollLatencyMs: 10
    }),
    staleHealthyMs: 5_000,
    log: () => {}
  });
  await svc.tick(1_000_000);
  assert.equal(svc.isStale(1_001_000), false); // 1s old
  assert.equal(svc.isStale(1_006_000), true);  // 6s old
});

test("FeedService: stop halts polling", async () => {
  let pollCount = 0;
  const svc = new FeedService({
    pollPeriodMs: 20,
    pollOverride: async ({ nowMs }) => {
      pollCount++;
      return {
        samples: [{ source: "deribit", price: 74000, ts: nowMs }],
        attempted: 1, succeeded: 1, perSourceStatus: { deribit: "ok" }, pollLatencyMs: 1
      };
    },
    log: () => {}
  });
  await svc.start();
  await new Promise((r) => setTimeout(r, 100));
  svc.stop();
  const c1 = pollCount;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pollCount, c1, "polls should not increment after stop");
  assert.ok(c1 >= 2, `expected multiple polls during 100ms, got ${c1}`);
});
