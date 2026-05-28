/**
 * Tests for liquidChainAnchorProvider — the adapter that exposes
 * LiquidChainCache as a LiveAnchorProvider for buildQuote.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";
import { liquidChainAnchorProvider } from "../src/singleSide/twoSided/liquidChainAnchorProvider";
import type { DeribitQuote } from "../scripts/backtest/singleSide/liquidStrikePicker";

const q = (strike: number, optType: "put" | "call", venue: "deribit" | "bullish", ask: number, tenorHours = 72): DeribitQuote => ({
  instrument_name: `${venue.toUpperCase()}-${strike}-${optType[0].toUpperCase()}`,
  strike, optType, tenorHours,
  bidUsdcPerBtc: ask * 0.9, askUsdcPerBtc: ask, midUsdcPerBtc: ask * 0.95,
  spreadPct: 0.10, markIv: 35, askIv: null, underlyingPrice: 75_000, venue
});

test("liquidChainAnchorProvider returns null for both when cache empty", async () => {
  const cache = new LiquidChainCache({ fetcher: async () => { throw new Error("net"); } });
  const provider = liquidChainAnchorProvider(cache);
  const r = await provider.getAnchorForLeg(75_000, "put", 3);
  assert.equal(r.bullish, null);
  assert.equal(r.deribit, null);
});

test("liquidChainAnchorProvider returns both venues when both quote same strike", async () => {
  const cache = new LiquidChainCache({
    providers: [
      { venue: "deribit", fetch: async () => ({ spot: 75_000, quotes: [q(75_000, "put", "deribit", 1000)] }) },
      { venue: "bullish", fetch: async () => ({ spot: 75_000, quotes: [q(75_000, "put", "bullish", 800)] }) }
    ]
  });
  const provider = liquidChainAnchorProvider(cache);
  const r = await provider.getAnchorForLeg(75_000, "put", 3);
  assert.ok(r.bullish);
  assert.ok(r.deribit);
  assert.equal(r.bullish!.askUsdcPerBtc, 800);
  assert.equal(r.deribit!.askUsdcPerBtc, 1000);
  assert.equal(r.bullish!.venue, "bullish");
  assert.equal(r.deribit!.venue, "deribit");
});

test("liquidChainAnchorProvider returns only one venue when other absent", async () => {
  const cache = new LiquidChainCache({
    providers: [
      { venue: "deribit", fetch: async () => ({ spot: 75_000, quotes: [q(75_000, "put", "deribit", 1000)] }) }
    ]
  });
  const provider = liquidChainAnchorProvider(cache);
  const r = await provider.getAnchorForLeg(75_000, "put", 3);
  assert.equal(r.bullish, null);
  assert.ok(r.deribit);
});

test("liquidChainAnchorProvider filters by strike + type + tenor window", async () => {
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 75_000,
      quotes: [
        q(75_000, "put", "deribit", 1000, 72),    // match
        q(75_000, "call", "deribit", 700, 72),    // wrong type
        q(74_000, "put", "deribit", 800, 72),     // wrong strike
        q(75_000, "put", "deribit", 1500, 240)    // wrong tenor (>36h away from 72h target)
      ]
    })
  });
  const provider = liquidChainAnchorProvider(cache);
  const r = await provider.getAnchorForLeg(75_000, "put", 3);
  assert.ok(r.deribit);
  assert.equal(r.deribit!.askUsdcPerBtc, 1000); // only the matching one
});

test("liquidChainAnchorProvider picks closest tenor when multiple in window", async () => {
  const cache = new LiquidChainCache({
    fetcher: async () => ({
      spot: 75_000,
      quotes: [
        q(75_000, "put", "deribit", 1000, 72),  // exact (target 72h)
        q(75_000, "put", "deribit", 900, 96)    // 24h off
      ]
    })
  });
  const provider = liquidChainAnchorProvider(cache);
  const r = await provider.getAnchorForLeg(75_000, "put", 3);
  assert.equal(r.deribit!.askUsdcPerBtc, 1000); // closer-tenor wins
});
