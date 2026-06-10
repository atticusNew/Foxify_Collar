/**
 * Miner Protect — Luxor Hashprice Index adapter (parse + provider with mocked fetcher, offline).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLuxorHashprice, luxorHashpriceProvider, mockHashpriceProvider, LUXOR_HASHPRICE_URL
} from "../src/minerProtect/luxorHashpriceAdapter";

test("parseLuxorHashprice: span series → most recent positive price; also handles current shape", () => {
  // span series (currency=BTC, hashunit=THS): pick the latest timestamp's price.
  assert.equal(parseLuxorHashprice({ data: [
    { price: 0.0000007, timestamp: "2026-06-05T00:00:00Z" },
    { price: 0.0000008, timestamp: "2026-06-06T00:00:00Z" }
  ] }), 0.0000008);
  assert.equal(parseLuxorHashprice({ data: { priceBTC: 0.00000075 } }), 0.00000075); // current shape
  assert.equal(parseLuxorHashprice({ data: [] }), null);
  assert.equal(parseLuxorHashprice(null), null);
});

test("luxorHashpriceProvider: hits the /hashprice span endpoint with X-Hi-Api-Key, returns latest price", async () => {
  let seenUrl = ""; let seenKey = "";
  const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
    seenUrl = url; seenKey = init?.headers?.["X-Hi-Api-Key"] ?? "";
    return { data: [{ price: 0.0000008, timestamp: "2026-06-06T00:00:00Z" }] };
  };
  const p = luxorHashpriceProvider("test-key", { fetcher });
  assert.equal(await p.getBtcPerThPerDay(), 0.0000008);
  assert.equal(seenUrl, LUXOR_HASHPRICE_URL);
  assert.equal(seenKey, "test-key");
});

test("luxorHashpriceProvider: null without a key, and null on fetch error", async () => {
  assert.equal(await luxorHashpriceProvider(undefined).getBtcPerThPerDay(), null);
  const boom = luxorHashpriceProvider("k", { fetcher: async () => { throw new Error("network"); } });
  assert.equal(await boom.getBtcPerThPerDay(), null);
});

test("mockHashpriceProvider: echoes a positive value, null otherwise", async () => {
  assert.equal(await mockHashpriceProvider(0.00000075).getBtcPerThPerDay(), 0.00000075);
  assert.equal(await mockHashpriceProvider(0).getBtcPerThPerDay(), null);
});
