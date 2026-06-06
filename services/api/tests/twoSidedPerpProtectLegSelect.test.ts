/**
 * Perp Protect cross-venue leg selection — expiry-normalization (A1) + liquidity guard (B2).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { pickBestLegs, type LegRow } from "../src/singleSide/twoSided/perpProtectLegSelect";

test("A1: a shorter-dated leg cheaper in absolute terms but pricier per-day does NOT win", () => {
  const rows: LegRow[] = [
    { venue: "okx", ask: 600, bid: 500, strike: 57000, daysToExpiry: 5, spreadPct: 0.05 },   // 120/day
    { venue: "deribit", ask: 700, bid: 600, strike: 57000, daysToExpiry: 7, spreadPct: 0.05 } // 100/day
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7 });
  assert.equal(r.bestAsk?.venue, "deribit"); // cheaper per-day at the target tenor
  assert.equal(r.bestAsk?.ask, 700);
});

test("A1: legs far off the requested tenor are rejected", () => {
  const rows: LegRow[] = [
    { venue: "okx", ask: 300, bid: 250, strike: 57000, daysToExpiry: 2, spreadPct: 0.05 },   // way short of 7d → reject
    { venue: "deribit", ask: 700, bid: 600, strike: 57000, daysToExpiry: 7, spreadPct: 0.05 }
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7, maxTenorDeviationPct: 0.35 });
  assert.equal(r.consideredAsks, 1);
  assert.equal(r.bestAsk?.venue, "deribit");
});

test("B2: a wide/stale top-of-book spread is rejected even when it has the lowest ask", () => {
  const rows: LegRow[] = [
    { venue: "okx", ask: 500, bid: 50, strike: 57000, daysToExpiry: 7, spreadPct: 0.40 },     // lowest ask, but illiquid
    { venue: "deribit", ask: 650, bid: 600, strike: 57000, daysToExpiry: 7, spreadPct: 0.04 }
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7, maxSpreadPct: 0.20 });
  assert.equal(r.bestAsk?.venue, "deribit");
  assert.equal(r.consideredAsks, 1);
});

test("highest qualifying bid wins the short leg (cross-venue routing)", () => {
  const rows: LegRow[] = [
    { venue: "okx", ask: 600, bid: 520, strike: 55000, daysToExpiry: 7, spreadPct: 0.06 },
    { venue: "deribit", ask: 640, bid: 560, strike: 55000, daysToExpiry: 7, spreadPct: 0.06 }
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7 });
  assert.equal(r.bestBid?.venue, "deribit");
  assert.equal(r.bestBid?.bid, 560);
});

test("missing tenor / spread signals are allowed (no silent rejection)", () => {
  const rows: LegRow[] = [
    { venue: "bullish", ask: 700, bid: 600, strike: 57000 } // no daysToExpiry, no spreadPct
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7 });
  assert.equal(r.bestAsk?.venue, "bullish");
  assert.equal(r.consideredAsks, 1);
});

test("rows with no usable ask/bid or strike are excluded", () => {
  const rows: LegRow[] = [
    { venue: "okx", ask: null, bid: null, strike: 57000, daysToExpiry: 7 },
    { venue: "deribit", ask: 700, bid: 600, strike: null, daysToExpiry: 7 }, // no strike
    { venue: "bullish", ask: 680, bid: 590, strike: 57000, daysToExpiry: 7, spreadPct: 0.05 }
  ];
  const r = pickBestLegs(rows, { targetTenorDays: 7 });
  assert.equal(r.bestAsk?.venue, "bullish");
  assert.equal(r.consideredAsks, 1);
  assert.equal(r.consideredBids, 1);
});
