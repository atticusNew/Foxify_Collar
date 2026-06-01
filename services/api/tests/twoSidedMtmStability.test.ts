/**
 * MTM value-stability: avoid the venue_bid ↔ bs_fallback jitter.
 *
 * When the exact-instrument bid blinks out of the chain snapshot for one poll,
 * priceOption falls back to BS — which severely undervalues OTM wings (no skew),
 * making the mark jump (observed $11.89 → $1.27). stabilizeLegValuation holds the
 * last-good venue value for a TTL and substitutes it for the BS fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { stabilizeLegValuation } from "../src/singleSide/twoSided/mtmService";

type Cache = Parameters<typeof stabilizeLegValuation>[0];

const venueVal = (perBtc: number) => ({
  valuePerBtc: perBtc, method: "venue_bid" as const, matchTier: "exact_symbol" as const,
  rawBidUsdcPerBtc: perBtc / 0.95, venue: "deribit", sourceDetail: "deribit:exact_symbol"
});
const bsVal = (perBtc: number) => ({
  valuePerBtc: perBtc, method: "bs_fallback" as const, matchTier: "bs_theoretical" as const,
  sourceDetail: "bs(iv=37%)"
});

test("caches a fresh venue_bid value (no stabilization needed)", () => {
  const cache: Cache = new Map();
  const r = stabilizeLegValuation(cache, "BTC-3JUN26-68000-P", venueVal(34), 1_000);
  assert.equal(r.stabilized, false);
  assert.equal(r.v.method, "venue_bid");
  assert.equal(r.v.valuePerBtc, 34);
  assert.equal(cache.size, 1, "venue value cached");
});

test("substitutes last-good venue value when a later poll falls back to BS (within TTL)", () => {
  const cache: Cache = new Map();
  stabilizeLegValuation(cache, "k", venueVal(34), 1_000);          // good poll: $34/btc cached
  const r = stabilizeLegValuation(cache, "k", bsVal(2), 60_000);    // 59s later: BS says $2 (skew-blind)
  assert.equal(r.stabilized, true, "held last-good instead of BS");
  assert.equal(r.v.method, "venue_bid");
  assert.equal(r.v.valuePerBtc, 34, "uses the cached venue value, not the $2 BS value");
  assert.match(r.v.sourceDetail, /last_good_venue_bid/);
});

test("falls back to BS when the last-good value is STALE (beyond TTL)", () => {
  const cache: Cache = new Map();
  stabilizeLegValuation(cache, "k", venueVal(34), 1_000);
  // 6 min later (TTL is 5 min) → cached value too old, use BS
  const r = stabilizeLegValuation(cache, "k", bsVal(2), 1_000 + 6 * 60_000);
  assert.equal(r.stabilized, false);
  assert.equal(r.v.method, "bs_fallback");
  assert.equal(r.v.valuePerBtc, 2);
});

test("falls back to BS when there is no cached venue value", () => {
  const cache: Cache = new Map();
  const r = stabilizeLegValuation(cache, "k", bsVal(2), 1_000);
  assert.equal(r.stabilized, false);
  assert.equal(r.v.method, "bs_fallback");
});

test("a refreshed venue_bid updates the cache (newer last-good wins)", () => {
  const cache: Cache = new Map();
  stabilizeLegValuation(cache, "k", venueVal(34), 1_000);
  stabilizeLegValuation(cache, "k", venueVal(50), 30_000);   // bid moved up to $50
  const r = stabilizeLegValuation(cache, "k", bsVal(2), 31_000);
  assert.equal(r.v.valuePerBtc, 50, "uses the most recent good value");
});
