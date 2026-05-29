/**
 * Tests for cellOpportunities — per-cell EV recommendations the Foxify
 * bot uses to optionally activate based on cell-level economics even
 * when the global signal says WAIT.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeCellOpportunities,
  __resetCellOpportunityCache
} from "../src/singleSide/twoSided/cellOpportunities";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

// Stub anchor provider — always returns simple anchors so buildQuote can succeed
const stubAnchorProvider: LiveAnchorProvider = {
  getAnchorForLeg: async (_strike, _side, _tenorDays) => ({
    bullish: {
      venue: "bullish",
      symbol: "BTC-TEST-P",
      askUsdcPerBtc: 500,
      bidUsdcPerBtc: 480,
      depthWithin2pctBtc: 10,
      pulledAt: new Date().toISOString()
    },
    deribit: {
      venue: "deribit",
      symbol: "BTC-TEST-P",
      askUsdcPerBtc: 520,
      bidUsdcPerBtc: 500,
      depthWithin2pctBtc: 10,
      pulledAt: new Date().toISOString()
    }
  })
} as unknown as LiveAnchorProvider;

const stubTier = {
  label: "tier_1",
  atticusPct: 0.15,
  foxifyPct: 0.85,
  atticusFloorUsdc: 25
};

test("computeCellOpportunities: returns one row per enabled cell", async () => {
  __resetCellOpportunityCache();
  const snap = await computeCellOpportunities({
    spot: 73000,
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier
  });
  // Should have at least the 6 enabled cells (registry has more, but a couple are disabled)
  assert.ok(snap.opportunities.length >= 6, `expected ≥6 opportunities, got ${snap.opportunities.length}`);
  for (const o of snap.opportunities) {
    assert.ok(typeof o.cell_id === "string");
    assert.ok(typeof o.cost_usdc === "number");
    assert.ok(typeof o.foxify_ev_pct === "number");
    assert.ok(typeof o.verdict === "string");
  }
});

test("computeCellOpportunities: sorts opportunities by foxify_ev_pct DESC", async () => {
  __resetCellOpportunityCache();
  const snap = await computeCellOpportunities({
    spot: 73000,
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier
  });
  // Verify descending order on cells where verdict != UNQUOTED
  const valid = snap.opportunities.filter((o) => o.verdict !== "UNQUOTED");
  for (let i = 1; i < valid.length; i++) {
    assert.ok(
      valid[i - 1].foxify_ev_pct >= valid[i].foxify_ev_pct,
      `not sorted: ${valid[i - 1].cell_id}(${valid[i - 1].foxify_ev_pct}) < ${valid[i].cell_id}(${valid[i].foxify_ev_pct})`
    );
  }
});

test("computeCellOpportunities: caches results within TTL window", async () => {
  __resetCellOpportunityCache();
  const t0 = Date.now();
  const snap1 = await computeCellOpportunities({
    spot: 73000,
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier,
    nowMs: t0
  });
  const snap2 = await computeCellOpportunities({
    spot: 73100, // same $500 bucket
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier,
    nowMs: t0 + 5_000 // 5s later
  });
  // Same cached snapshot returned (identical computed_at)
  assert.equal(snap1.computed_at, snap2.computed_at);
});

test("computeCellOpportunities: cache invalidated by spot crossing bucket", async () => {
  __resetCellOpportunityCache();
  const t0 = Date.now();
  const snap1 = await computeCellOpportunities({
    spot: 73000,
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier,
    nowMs: t0
  });
  const snap2 = await computeCellOpportunities({
    spot: 73600, // different $500 bucket
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier,
    nowMs: t0 + 100
  });
  // Different cache entries → different computed_at
  assert.notEqual(snap1.computed_at, snap2.computed_at);
});

test("computeCellOpportunities: verdict mapping is consistent with EV%", async () => {
  __resetCellOpportunityCache();
  const snap = await computeCellOpportunities({
    spot: 73000,
    regime: "elevated",
    anchorProvider: stubAnchorProvider,
    liquidChainCache: null,
    tier: stubTier
  });
  for (const o of snap.opportunities) {
    if (o.verdict === "UNQUOTED") continue;
    if (o.foxify_ev_pct > 0.20) assert.equal(o.verdict, "PROFITABLE");
    else if (o.foxify_ev_pct > 0.05) assert.equal(o.verdict, "MARGINAL_PROFITABLE");
    else if (o.foxify_ev_pct > -0.05) assert.equal(o.verdict, "BREAK_EVEN");
    else if (o.foxify_ev_pct > -0.20) assert.equal(o.verdict, "MARGINAL_NEGATIVE");
    else assert.equal(o.verdict, "NEGATIVE");
  }
});
