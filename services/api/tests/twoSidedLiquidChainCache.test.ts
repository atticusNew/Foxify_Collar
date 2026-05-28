/**
 * Tests for LiquidChainCache + pickLiquidForLeg + buildQuote integration.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiquidChainCache, pickLiquidForLeg } from "../src/singleSide/twoSided/liquidChainCache";
import { buildQuote, type LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";
import { TIERS } from "../src/singleSide/twoSided/types";
import type { DeribitQuote } from "../scripts/backtest/singleSide/liquidStrikePicker";

const fakeQuote = (strike: number, optType: "put" | "call", askUsdcPerBtc: number, spreadPct = 0.10, tenorHours = 72, venue: "deribit" | "bullish" = "deribit"): DeribitQuote => ({
  instrument_name: `${venue.toUpperCase()}-FAKE-${strike}-${optType[0].toUpperCase()}`,
  strike,
  optType,
  tenorHours,
  bidUsdcPerBtc: askUsdcPerBtc * (1 - spreadPct),
  askUsdcPerBtc,
  midUsdcPerBtc: askUsdcPerBtc * (1 - spreadPct / 2),
  spreadPct,
  markIv: 35,
  askIv: null,
  underlyingPrice: 75_000,
  venue
});

test("LiquidChainCache returns null if fetcher throws first call", async () => {
  const cache = new LiquidChainCache({
    ttlMs: 30_000,
    staleMaxAgeMs: 300_000,
    fetcher: async () => { throw new Error("network error"); }
  });
  const r = await cache.getChain();
  assert.equal(r, null);
});

test("LiquidChainCache returns cached snapshot within TTL", async () => {
  let calls = 0;
  const cache = new LiquidChainCache({
    ttlMs: 30_000, staleMaxAgeMs: 300_000,
    fetcher: async () => { calls++; return { spot: 75_000, quotes: [fakeQuote(75_000, "put", 1000)] }; }
  });
  const r1 = await cache.getChain(1_000);
  const r2 = await cache.getChain(20_000); // within TTL
  assert.equal(calls, 1);
  assert.deepEqual(r1, r2);
});

test("LiquidChainCache refreshes after TTL", async () => {
  let calls = 0;
  const cache = new LiquidChainCache({
    ttlMs: 30_000, staleMaxAgeMs: 300_000,
    fetcher: async () => { calls++; return { spot: 75_000 + calls, quotes: [] }; }
  });
  await cache.getChain(1_000);
  await cache.getChain(35_000); // past TTL
  assert.equal(calls, 2);
});

test("LiquidChainCache returns stale snapshot on fetch error if within staleMaxAge", async () => {
  let calls = 0;
  const cache = new LiquidChainCache({
    ttlMs: 30_000, staleMaxAgeMs: 300_000,
    fetcher: async () => {
      calls++;
      if (calls === 1) return { spot: 75_000, quotes: [fakeQuote(75_000, "put", 1000)] };
      throw new Error("fail");
    }
  });
  const r1 = await cache.getChain(1_000);
  const r2 = await cache.getChain(40_000); // past TTL, fetch fails, returns stale
  assert.equal(r2?.spot, r1?.spot);
});

test("pickLiquidForLeg returns picked strike when found", async () => {
  const quotes = [fakeQuote(75_000, "put", 1500, 0.10), fakeQuote(74_000, "put", 1200, 0.08), fakeQuote(76_000, "put", 1800, 0.40)];
  const cache = new LiquidChainCache({ fetcher: async () => ({ spot: 75_000, quotes }) });
  const r = await pickLiquidForLeg(cache, 75_000, "put", 3, 75_000);
  assert.ok(r.pickedStrike === 75_000); // exact match prefered
  assert.equal(r.askUsdcPerBtc, 1500);
});

test("pickLiquidForLeg shifts strike when exact match is illiquid", async () => {
  // target = 75_000 but it has 60% spread (illiquid); 74_000 has 8% spread
  const quotes = [
    fakeQuote(75_000, "put", 1500, 0.60),  // rejected (spread > 30%)
    fakeQuote(74_000, "put", 1200, 0.08),  // accepted, picked
    fakeQuote(76_000, "put", 1800, 0.40)   // rejected (spread > 30%)
  ];
  const cache = new LiquidChainCache({ fetcher: async () => ({ spot: 75_000, quotes }) });
  const r = await pickLiquidForLeg(cache, 75_000, "put", 3, 75_000);
  assert.equal(r.pickedStrike, 74_000);
  assert.equal(r.shifted, true);
});

test("pickLiquidForLeg falls back to target on empty cache", async () => {
  const cache = new LiquidChainCache({ fetcher: async () => { throw new Error("net"); } });
  const r = await pickLiquidForLeg(cache, 75_000, "put", 3, 75_000);
  assert.equal(r.pickedStrike, 75_000);
  assert.equal(r.shifted, false);
  assert.equal(r.askUsdcPerBtc, null);
});

test("buildQuote with liquidChainCache shifts strikes and reports shift", async () => {
  const cell = PHASE_0_CELLS.pair_50k_2pct;
  const spot = 75_000;
  // Naive target strikes: putItmPct=0.013 → 75_975 → snap up to 76_000
  //                       callItmPct=0.013 → 74_025 → snap down to 74_000
  // Wait — let me trace it carefully. The cell uses putStrikeItmPct=0.013 →
  // rawPut = 75_000 * 1.013 = 75_975, ceil to 1000 grid = 76_000.
  // rawCall = 75_000 * (1 - 0.013) = 74_025, floor = 74_000.

  // Liquid options: 76_000 illiquid, 75_000 liquid; 74_000 illiquid, 75_000 liquid.
  // The picker should shift 76_000 put → 75_000 put (closer to spot but still ITM since spot=75k)
  // Hmm, 75_000 put with spot 75_000 is ATM not ITM. Picker preserves moneyness — does it allow ATM?
  // Looking at picker: targetSideSign = sign(76000 - 75000) = +1. Then for strike 75_000:
  // sign(75000 - 75000) = 0, and sameSide returns true if sign === 0 (allowed). So 75_000 is OK.
  const quotes = [
    fakeQuote(76_000, "put",  900, 0.50),  // target, illiquid
    fakeQuote(75_000, "put",  500, 0.05),  // shift target, liquid (ATM is ok per picker)
    fakeQuote(74_000, "call", 1100, 0.55), // target, illiquid
    fakeQuote(75_000, "call", 700, 0.06)   // shift target, liquid
  ];
  const cache = new LiquidChainCache({ fetcher: async () => ({ spot, quotes }) });

  // Provider returns the same quote from "deribit" side for whatever strike asked.
  // Bullish side empty.
  const provider: LiveAnchorProvider = {
    getAnchorForLeg: async (strike, optType, _tenor) => {
      const q = quotes.find((x) => x.strike === strike && x.optType === optType);
      if (!q) return { bullish: null, deribit: null };
      return {
        bullish: null,
        deribit: {
          venue: "deribit",
          symbol: q.instrument_name,
          askUsdcPerBtc: q.askUsdcPerBtc,
          depthWithin2pctBtc: 5,
          pulledAt: new Date().toISOString()
        }
      };
    }
  };

  const tier = TIERS.tier_1;
  const result = await buildQuote({ cell, spot, anchorProvider: provider, tier, liquidChainCache: cache });

  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.targetPutStrike, 76_000);
  assert.equal(result.targetCallStrike, 74_000);
  assert.equal(result.putStrike, 75_000);  // shifted to liquid
  assert.equal(result.callStrike, 75_000); // shifted to liquid
  assert.equal(result.putStrikeShifted, true);
  assert.equal(result.callStrikeShifted, true);
  assert.equal(result.putLeg.askUsdcPerBtc, 500);  // liquid put ask
  assert.equal(result.callLeg.askUsdcPerBtc, 700); // liquid call ask
});

test("LiquidChainCache merges Deribit + Bullish providers, picks venue with cheaper ask", async () => {
  // Same strike, both venues have it — Bullish ask cheaper, Bullish wins
  const cache = new LiquidChainCache({
    providers: [
      {
        venue: "deribit",
        fetch: async () => ({ spot: 75_000, quotes: [fakeQuote(75_000, "put", 1000, 0.10, 72, "deribit")] })
      },
      {
        venue: "bullish",
        fetch: async () => ({ spot: 75_000, quotes: [fakeQuote(75_000, "put", 700, 0.08, 72, "bullish")] })
      }
    ]
  });
  const r = await pickLiquidForLeg(cache, 75_000, "put", 3, 75_000);
  assert.equal(r.pickedStrike, 75_000);
  assert.equal(r.venue, "bullish");
  assert.equal(r.askUsdcPerBtc, 700);
});

test("LiquidChainCache surfaces per-venue status (one venue failed)", async () => {
  const cache = new LiquidChainCache({
    providers: [
      {
        venue: "deribit",
        fetch: async () => ({ spot: 75_000, quotes: [fakeQuote(75_000, "put", 800, 0.10, 72, "deribit")] })
      },
      {
        venue: "bullish",
        fetch: async () => { throw new Error("bullish auth failed"); }
      }
    ]
  });
  const snap = await cache.getChain();
  assert.ok(snap);
  assert.equal(snap!.venueStatus.deribit.ok, true);
  assert.equal(snap!.venueStatus.deribit.quoteCount, 1);
  assert.equal(snap!.venueStatus.bullish.ok, false);
  assert.equal(snap!.venueStatus.bullish.error, "bullish auth failed");
  // Picker still works using Deribit quote
  const pick = await pickLiquidForLeg(cache, 75_000, "put", 3, 75_000);
  assert.equal(pick.venue, "deribit");
});

test("LiquidChainCache returns null when ALL providers fail (no stale fallback)", async () => {
  const cache = new LiquidChainCache({
    providers: [
      { venue: "deribit", fetch: async () => { throw new Error("net1"); } },
      { venue: "bullish", fetch: async () => { throw new Error("net2"); } }
    ]
  });
  const snap = await cache.getChain();
  assert.equal(snap, null);
});

test("buildQuote without liquidChainCache uses target strikes (backward compat)", async () => {
  const cell = PHASE_0_CELLS.pair_50k_2pct;
  const spot = 75_000;
  const provider: LiveAnchorProvider = {
    getAnchorForLeg: async (strike, _optType, _tenor) => ({
      bullish: null,
      deribit: {
        venue: "deribit",
        symbol: `FAKE-${strike}`,
        askUsdcPerBtc: 1000,
        depthWithin2pctBtc: 5,
        pulledAt: new Date().toISOString()
      }
    })
  };
  const result = await buildQuote({ cell, spot, anchorProvider: provider, tier: TIERS.tier_1 });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.putStrike, 76_000); // target preserved
  assert.equal(result.callStrike, 74_000);
  assert.equal(result.putStrikeShifted, false);
  assert.equal(result.callStrikeShifted, false);
});
