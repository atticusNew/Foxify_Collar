/**
 * Venue put probes — Deribit public probe (nearest strike/expiry, BTC→USDC) + Bullish
 * client probe. Mock fetcher/client (no network).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deribitPutProbe, bullishPutProbe } from "../src/singleSide/twoSided/venuePutProbes";
import type { OkxFetcher } from "../src/singleSide/twoSided/okxProbe";

test("deribitPutProbe: nearest put strike+expiry, premium BTC→USDC", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const exp = Date.UTC(2026, 5, 12, 8, 0, 0); // 9d out
  const fetcher: OkxFetcher = async (url) => {
    if (url.includes("get_instruments")) {
      return { result: [
        { instrument_name: "BTC-12JUN26-57000-P", strike: 57000, option_type: "put", expiration_timestamp: exp },
        { instrument_name: "BTC-12JUN26-60000-P", strike: 60000, option_type: "put", expiration_timestamp: exp },
        { instrument_name: "BTC-12JUN26-57000-C", strike: 57000, option_type: "call", expiration_timestamp: exp }
      ] };
    }
    if (url.includes("57000-P")) return { result: { best_ask_price: 0.0065 } }; // BTC
    return { result: {} };
  };
  const r = await deribitPutProbe({ spot: 63000, strike: 57000, tenorDays: 7, nowMs: now, fetcher });
  assert.equal(r.venue, "deribit");
  assert.equal(r.instrument, "BTC-12JUN26-57000-P", "picks nearest put strike");
  // 0.0065 BTC × 63000 = 409.5 USDC/BTC.
  assert.ok(Math.abs(r.ask_usdc_per_btc! - 409.5) < 0.01);
});

test("deribitPutProbe: no puts → null (graceful)", async () => {
  const fetcher: OkxFetcher = async () => ({ result: [] });
  const r = await deribitPutProbe({ spot: 63000, strike: 57000, tenorDays: 7, fetcher });
  assert.equal(r.ask_usdc_per_btc, null);
});

test("bullishPutProbe: USDC-quoted ask (no spot conversion); null when no client", async () => {
  const now = Date.parse("2026-06-03T12:00:00Z");
  const client = {
    getMarkets: async () => [
      { symbol: "BTC-USDC-20260612-57000-P", underlyingBaseSymbol: "BTC", optionType: "PUT", optionStrikePrice: "57000", expiryDatetime: "2026-06-12T08:00:00Z", marketEnabled: true }
    ],
    getHybridOrderBook: async () => ({ asks: [{ price: "430" }] })
  };
  const r = await bullishPutProbe(client, { spot: 63000, strike: 57000, tenorDays: 7, nowMs: now });
  assert.equal(r.ask_usdc_per_btc, 430, "Bullish ask is USDC per option — no ×spot");
  assert.equal(r.instrument, "BTC-USDC-20260612-57000-P");
  assert.equal((await bullishPutProbe(null, { spot: 63000, strike: 57000, tenorDays: 7 })).ask_usdc_per_btc, null);
});
