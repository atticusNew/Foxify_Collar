/**
 * Miner Protect — Luxor Hashprice Index adapter (parse + provider with mocked fetcher, offline).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLuxorCurrentHashprice, luxorHashpriceProvider, mockHashpriceProvider, LUXOR_CURRENT_HASHPRICE_URL
} from "../src/minerProtect/luxorHashpriceAdapter";

test("parseLuxorCurrentHashprice: reads data.priceBTC (BTC/TH/day), else null", () => {
  assert.equal(parseLuxorCurrentHashprice({ data: { priceBTC: 0.00000075, priceUSD: 0.045 } }), 0.00000075);
  assert.equal(parseLuxorCurrentHashprice({ data: { priceBTC: 0 } }), null);
  assert.equal(parseLuxorCurrentHashprice({ data: {} }), null);
  assert.equal(parseLuxorCurrentHashprice(null), null);
});

test("luxorHashpriceProvider: hits THS current-hashprice with X-Hi-Api-Key, returns priceBTC", async () => {
  let seenUrl = ""; let seenKey = "";
  const fetcher = async (url: string, init?: { headers?: Record<string, string> }) => {
    seenUrl = url; seenKey = init?.headers?.["X-Hi-Api-Key"] ?? "";
    return { data: { priceBTC: 0.0000008, priceUSD: 0.048, timestamp: "2026-06-06T00:00:00Z" } };
  };
  const p = luxorHashpriceProvider("test-key", { fetcher });
  assert.equal(await p.getBtcPerThPerDay(), 0.0000008);
  assert.equal(seenUrl, LUXOR_CURRENT_HASHPRICE_URL);
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
