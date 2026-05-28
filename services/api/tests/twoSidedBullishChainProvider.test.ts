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
