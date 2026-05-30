/**
 * Tests for LiquidChainCache bid lookup correctness.
 *
 * Critical: getBidForLeg must NEVER pick a wrong-expiry quote as a proxy
 * just because it has a higher bid. Different-expiry instruments are
 * different products.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";

// Build a cache pre-populated with a snapshot containing three expiries
// of the same strike on Deribit (1.54d, 2.54d, 0.54d) and one Bullish
// quote (1.54d).
const buildCacheWithSnapshot = (): LiquidChainCache => {
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 73950,
      quotes: [
        // Deribit 1.54-day (matches our hypothetical leg's actual expiry)
        {
          venue: "deribit",
          instrument_name: "BTC-1JUN26-73000-P",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 177,
          askUsdcPerBtc: 207,
          midUsdcPerBtc: 192,
          spreadPct: 0.15,
          markIv: 0.283
        },
        // Deribit 2.54-day (HIGHER bid — the buggy match would pick this)
        {
          venue: "deribit",
          instrument_name: "BTC-2JUN26-73000-P",
          strike: 73000,
          optType: "put",
          tenorHours: 61,
          bidUsdcPerBtc: 347,
          askUsdcPerBtc: 406,
          midUsdcPerBtc: 376,
          spreadPct: 0.16,
          markIv: 0.309
        },
        // Deribit 0.54-day
        {
          venue: "deribit",
          instrument_name: "BTC-31MAY26-73000-P",
          strike: 73000,
          optType: "put",
          tenorHours: 13,
          bidUsdcPerBtc: 29,
          askUsdcPerBtc: 36,
          midUsdcPerBtc: 32,
          spreadPct: 0.22,
          markIv: 0.268
        },
        // Bullish 1.54-day
        {
          venue: "bullish",
          instrument_name: "BTC-1JUN26-73000-P-BULLISH",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 150,
          askUsdcPerBtc: 200,
          midUsdcPerBtc: 175,
          spreadPct: 0.25,
          markIv: 0.29
        }
      ] as unknown as Parameters<NonNullable<ConstructorParameters<typeof LiquidChainCache>[0]["fetcher"]>>[never]
    })
  });
  return cache;
};

test("getBidForSymbol: returns exact match for instrument symbol", async () => {
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  const r = cache.getBidForSymbol({ venue: "deribit", instrumentSymbol: "BTC-1JUN26-73000-P" });
  assert.ok(r, "should find exact match");
  assert.equal(r.instrumentName, "BTC-1JUN26-73000-P");
  assert.equal(r.bidUsdcPerBtc, 177);
  assert.equal(r.tenorHours, 37);
});

test("getBidForSymbol: returns null for instrument not in snapshot", async () => {
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  const r = cache.getBidForSymbol({ venue: "deribit", instrumentSymbol: "BTC-NONSENSE-99999-P" });
  assert.equal(r, null);
});

test("getBidForSymbol: returns null when bid is zero", async () => {
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 73950,
      quotes: [
        {
          venue: "deribit",
          instrument_name: "BTC-X-Z",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 0,
          askUsdcPerBtc: 100,
          midUsdcPerBtc: 50,
          spreadPct: 1,
          markIv: 0.3
        }
      ] as unknown as Parameters<NonNullable<ConstructorParameters<typeof LiquidChainCache>[0]["fetcher"]>>[never]
    })
  });
  await cache.getChain();
  const r = cache.getBidForSymbol({ venue: "deribit", instrumentSymbol: "BTC-X-Z" });
  assert.equal(r, null, "zero bid means no resting buyer");
});

test("getBidForSymbol: venue mismatch returns null even if symbol matches", async () => {
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  // Symbol exists on deribit but not bullish
  const r = cache.getBidForSymbol({ venue: "bullish", instrumentSymbol: "BTC-1JUN26-73000-P" });
  assert.equal(r, null);
});

test("getBidForLeg: picks STRICTLY closest tenor (no bid-based tiebreak)", async () => {
  // This is the regression test for the wrong-expiry bug.
  // Target tenor = 37h (matches BTC-1JUN26 exactly).
  // Old buggy behavior would pick BTC-2JUN26 (61h, drift 24h, bid 347)
  //   because the tiebreaker "prefer higher bid" kicked in.
  // Correct behavior picks BTC-1JUN26 (37h, drift 0h, bid 177).
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  const r = cache.getBidForLeg({
    strike: 73000,
    optType: "put",
    tenorRemainingHours: 37,
    preferVenue: "deribit"
  });
  assert.ok(r);
  assert.equal(r.tenorHours, 37, "should pick the 1JUN26 (37h) option, not 2JUN26 (61h)");
  assert.equal(r.bidUsdcPerBtc, 177, "should report the 37h-option's bid, not the higher 61h bid");
  assert.equal(r.instrumentName, "BTC-1JUN26-73000-P");
});

test("getBidForLeg: picks closer tenor even when farther tenor has higher bid", async () => {
  // Target = 50h. 1JUN26 (37h, drift 13h) vs 2JUN26 (61h, drift 11h).
  // 2JUN26 has both higher bid AND smaller drift here, so it's correct
  // to pick it on tenor grounds alone.
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  const r = cache.getBidForLeg({
    strike: 73000,
    optType: "put",
    tenorRemainingHours: 50,
    preferVenue: "deribit"
  });
  assert.ok(r);
  assert.equal(r.tenorHours, 61, "should pick the 61h option (drift 11h vs 13h)");
  assert.equal(r.bidUsdcPerBtc, 347);
});

test("getBidForLeg: prefers venue match before tenor when both reasonable", async () => {
  const cache = buildCacheWithSnapshot();
  await cache.getChain();
  // Target tenor 37h. Both deribit and bullish have a 37h option.
  // preferVenue=bullish should pick bullish (bid 150) even though deribit
  // has a higher bid on its 37h option.
  const r = cache.getBidForLeg({
    strike: 73000,
    optType: "put",
    tenorRemainingHours: 37,
    preferVenue: "bullish"
  });
  assert.ok(r);
  assert.equal(r.venue, "bullish");
  assert.equal(r.bidUsdcPerBtc, 150);
});

test("getBidForLeg: filters out zero-bid candidates", async () => {
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 73950,
      quotes: [
        {
          venue: "deribit",
          instrument_name: "ZERO-BID",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 0,
          askUsdcPerBtc: 100,
          midUsdcPerBtc: 50,
          spreadPct: 1,
          markIv: 0.3
        }
      ] as unknown as Parameters<NonNullable<ConstructorParameters<typeof LiquidChainCache>[0]["fetcher"]>>[never]
    })
  });
  await cache.getChain();
  const r = cache.getBidForLeg({
    strike: 73000,
    optType: "put",
    tenorRemainingHours: 37,
    preferVenue: "deribit"
  });
  assert.equal(r, null);
});

test("getBidForLeg: tightened — true tenor tie breaks by SPREAD (not bid)", async () => {
  // Two quotes at exactly the same tenor, one wide spread one tight.
  // Should prefer tighter spread = better execution quality.
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 73950,
      quotes: [
        {
          venue: "deribit",
          instrument_name: "TIGHT",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 100,
          askUsdcPerBtc: 110,
          midUsdcPerBtc: 105,
          spreadPct: 0.10,
          markIv: 0.3
        },
        {
          venue: "deribit",
          instrument_name: "WIDE",
          strike: 73000,
          optType: "put",
          tenorHours: 37,
          bidUsdcPerBtc: 200,
          askUsdcPerBtc: 400,
          midUsdcPerBtc: 300,
          spreadPct: 1.0,
          markIv: 0.3
        }
      ] as unknown as Parameters<NonNullable<ConstructorParameters<typeof LiquidChainCache>[0]["fetcher"]>>[never]
    })
  });
  await cache.getChain();
  const r = cache.getBidForLeg({
    strike: 73000,
    optType: "put",
    tenorRemainingHours: 37,
    preferVenue: "deribit"
  });
  assert.ok(r);
  assert.equal(r.instrumentName, "TIGHT", "tightest spread wins on tenor tie (not highest bid)");
});
