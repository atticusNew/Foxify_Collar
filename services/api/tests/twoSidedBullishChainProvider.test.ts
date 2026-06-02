/**
 * Tests for the Bullish chain provider (filters → orderbook fetch → normalized quotes).
 *
 * Uses a fake BullishTradingClient (we only need getMarkets) and a stub orderbook
 * fetcher injected into fetchBullishChainSnapshot.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fetchBullishChainSnapshot } from "../src/singleSide/twoSided/bullishChainProvider";

// Minimal mock client: only getMarkets is used by the provider; submitCommand etc. stubbed.
const buildMockClient = (markets: Array<{ symbol: string; optionType: string; optionStrikePrice: string; expiryDatetime: string; underlyingBaseSymbol: string; marketEnabled?: boolean; createOrderEnabled?: boolean }>) => ({
  getMarkets: async () => markets.map((m) => ({
    ...m,
    marketEnabled: m.marketEnabled !== false,
    createOrderEnabled: m.createOrderEnabled !== false
  }))
}) as unknown as Parameters<typeof fetchBullishChainSnapshot>[0];

test("fetchBullishChainSnapshot filters non-BTC, disabled, out-of-window markets", async () => {
  const nowMs = Date.now();
  const inWindowExpiry = new Date(nowMs + 3 * 86_400_000).toISOString(); // 3d out (target)
  const outOfWindowExpiry = new Date(nowMs + 30 * 86_400_000).toISOString(); // 30d out
  const client = buildMockClient([
    { symbol: "BTC-CALL-75000-IN", optionType: "CALL", optionStrikePrice: "75000", expiryDatetime: inWindowExpiry, underlyingBaseSymbol: "BTC" },
    { symbol: "BTC-CALL-75000-OUT", optionType: "CALL", optionStrikePrice: "75000", expiryDatetime: outOfWindowExpiry, underlyingBaseSymbol: "BTC" }, // out of tenor window
    { symbol: "ETH-CALL-3500", optionType: "CALL", optionStrikePrice: "3500", expiryDatetime: inWindowExpiry, underlyingBaseSymbol: "ETH" }, // wrong underlying
    { symbol: "BTC-PERP", optionType: "", optionStrikePrice: "0", expiryDatetime: "", underlyingBaseSymbol: "BTC" }, // no optionType
    { symbol: "BTC-CALL-90000-FAR", optionType: "CALL", optionStrikePrice: "90000", expiryDatetime: inWindowExpiry, underlyingBaseSymbol: "BTC" } // out of strike window
  ]);
  const ob = async (sym: string) => ({ bid: 100, ask: 110 });
  const r = await fetchBullishChainSnapshot(client, 75_000, {
    centerSpot: 75_000,
    centerTenorDays: 3,
    strikeWindowUsdc: 5_000,
    tenorWindowDays: 1
  }, ob, nowMs);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].instrument_name, "BTC-CALL-75000-IN");
  assert.equal(r.quotes[0].venue, "bullish");
  assert.equal(r.quotes[0].strike, 75_000);
  assert.equal(r.quotes[0].optType, "call");
});

test("fetchBullishChainSnapshot computes spread + mid correctly", async () => {
  const nowMs = Date.now();
  const exp = new Date(nowMs + 3 * 86_400_000).toISOString();
  const client = buildMockClient([
    { symbol: "BTC-PUT-75000", optionType: "PUT", optionStrikePrice: "75000", expiryDatetime: exp, underlyingBaseSymbol: "BTC" }
  ]);
  const ob = async () => ({ bid: 900, ask: 1100 });
  const r = await fetchBullishChainSnapshot(client, 75_000, {
    centerSpot: 75_000, centerTenorDays: 3, strikeWindowUsdc: 5_000, tenorWindowDays: 1
  }, ob, nowMs);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].bidUsdcPerBtc, 900);
  assert.equal(r.quotes[0].askUsdcPerBtc, 1100);
  assert.equal(r.quotes[0].midUsdcPerBtc, 1000);
  assert.ok(Math.abs(r.quotes[0].spreadPct - 0.20) < 1e-6); // (1100-900)/1000 = 0.20
});

test("fetchBullishChainSnapshot skips entries with null/zero bid or ask", async () => {
  const nowMs = Date.now();
  const exp = new Date(nowMs + 3 * 86_400_000).toISOString();
  const client = buildMockClient([
    { symbol: "BTC-PUT-74000", optionType: "PUT", optionStrikePrice: "74000", expiryDatetime: exp, underlyingBaseSymbol: "BTC" },
    { symbol: "BTC-PUT-75000", optionType: "PUT", optionStrikePrice: "75000", expiryDatetime: exp, underlyingBaseSymbol: "BTC" }
  ]);
  const ob = async (sym: string) =>
    sym === "BTC-PUT-74000"
      ? ({ bid: null, ask: 1000 } as { bid: number | null; ask: number | null })
      : ({ bid: 800, ask: 900 } as { bid: number | null; ask: number | null });
  const r = await fetchBullishChainSnapshot(client, 75_000, {
    centerSpot: 75_000, centerTenorDays: 3, strikeWindowUsdc: 5_000, tenorWindowDays: 1
  }, ob, nowMs);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].strike, 75_000);
});

test("fetchBullishChainSnapshot caps orderbook fetches to nearest-ATM (maxOrderbookFetches) — rate-limit guard", async () => {
  const nowMs = Date.now();
  const exp = new Date(nowMs + 3 * 86_400_000).toISOString();
  const strikes: number[] = [];
  for (let k = 70_000; k <= 80_000; k += 1_000) strikes.push(k); // 11 strikes, all in ±6k window
  const client = buildMockClient(strikes.map((k) => ({
    symbol: `BTC-CALL-${k}`, optionType: "CALL", optionStrikePrice: String(k), expiryDatetime: exp, underlyingBaseSymbol: "BTC"
  })));
  let calls = 0;
  const ob = async () => { calls++; return { bid: 100, ask: 110 }; };
  const r = await fetchBullishChainSnapshot(client, 75_000, {
    centerSpot: 75_000, centerTenorDays: 3, strikeWindowUsdc: 6_000, tenorWindowDays: 1, maxOrderbookFetches: 6
  }, ob, nowMs);
  assert.equal(calls, 6, "only 6 orderbook fetches despite 11 in-window strikes (nearest-ATM cap)");
  assert.equal(r.quotes.length, 6);
  const qStrikes = r.quotes.map((q) => q.strike);
  assert.ok(Math.min(...qStrikes) >= 72_000 && Math.max(...qStrikes) <= 78_000, "kept only the nearest-ATM strikes");
});

test("fetchBullishChainSnapshot: pinnedSymbols (held positions) are fetched even outside strike/tenor window + beyond the cap", async () => {
  const nowMs = Date.now();
  const inWindowExp = new Date(nowMs + 2 * 86_400_000).toISOString();   // 2d (target)
  const heldExp = new Date(nowMs + 1 * 86_400_000).toISOString();        // 1d — outside a tight tenor window
  // Spot has drifted to 64000; the held 67500 strike is now $3.5k away (outside a $2k window).
  const strikes: number[] = [];
  for (let k = 63_000; k <= 65_000; k += 500) strikes.push(k);           // ATM band around 64000
  const markets = strikes.map((k) => ({
    symbol: `BTC-USDC-ATM-${k}-P`, optionType: "PUT", optionStrikePrice: String(k), expiryDatetime: inWindowExp, underlyingBaseSymbol: "BTC"
  }));
  // The HELD instrument: far strike (67500) AND a different (1d) expiry → would be filtered out twice.
  markets.push({ symbol: "BTC-USDC-20260605-67500-P", optionType: "PUT", optionStrikePrice: "67500", expiryDatetime: heldExp, underlyingBaseSymbol: "BTC" });
  const client = buildMockClient(markets);

  const fetched: string[] = [];
  const ob = async (sym: string) => { fetched.push(sym); return { bid: 1500, ask: 1700 }; };
  const r = await fetchBullishChainSnapshot(client, 64_000, {
    centerSpot: 64_000,
    centerTenorDays: 2,
    strikeWindowUsdc: 2_000,        // 67500 is $3.5k away → out of window
    tenorWindowDays: 0.25,          // 1d held expiry is outside the ±0.25d tenor window
    maxOrderbookFetches: 3,         // tight cap — pinned must be added ON TOP
    pinnedSymbols: ["BTC-USDC-20260605-67500-P"]
  }, ob, nowMs);

  // The held instrument must be fetched + present despite being out of both windows and past the cap.
  assert.ok(fetched.includes("BTC-USDC-20260605-67500-P"), "pinned held symbol was fetched");
  const held = r.quotes.find((q) => q.instrument_name === "BTC-USDC-20260605-67500-P");
  assert.ok(held, "pinned held symbol is in the snapshot → exact-symbol valuation will match");
  assert.equal(held!.strike, 67_500);
  // And the nearest-ATM cap still applied to the NON-pinned strikes (3 of them).
  assert.equal(r.quotes.filter((q) => q.strike !== 67_500).length, 3, "non-pinned still capped at 3");
});

test("fetchBullishChainSnapshot tolerates individual orderbook failures (returns null)", async () => {
  const nowMs = Date.now();
  const exp = new Date(nowMs + 3 * 86_400_000).toISOString();
  const client = buildMockClient([
    { symbol: "BTC-PUT-74000", optionType: "PUT", optionStrikePrice: "74000", expiryDatetime: exp, underlyingBaseSymbol: "BTC" },
    { symbol: "BTC-PUT-75000", optionType: "PUT", optionStrikePrice: "75000", expiryDatetime: exp, underlyingBaseSymbol: "BTC" }
  ]);
  const ob = async (sym: string) =>
    sym === "BTC-PUT-74000" ? null : ({ bid: 800, ask: 900 } as { bid: number | null; ask: number | null });
  const r = await fetchBullishChainSnapshot(client, 75_000, {
    centerSpot: 75_000, centerTenorDays: 3, strikeWindowUsdc: 5_000, tenorWindowDays: 1
  }, ob, nowMs);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].strike, 75_000);
});
