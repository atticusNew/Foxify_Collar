/**
 * Pooled tail-hedge model — net-exposure hedging vs gross self-insurance.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computePooledTailHedge, type PooledTailInputs } from "../src/singleSide/twoSided/pooledTailHedge";

const spot = 62000;
const put = 1000; // USDC/BTC for the band-edge deep put

test("balanced-ish book: net << gross → pooled hedge is a fraction of self-insurance", () => {
  const inp: PooledTailInputs = { spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7 };
  const r = computePooledTailHedge(inp, put);
  assert.equal(r.gross_notional_usdc, 9_000_000);
  assert.equal(r.net_notional_usdc, 1_000_000);
  assert.equal(r.net_side, "long");
  // gross cost = 1000 × (9M/62000) = 145,161.29 ; pooled = 1000 × (1M/62000) = 16,129.03
  assert.equal(r.gross_selfinsure_cost_usdc, 145161.29);
  assert.equal(r.pooled_hedge_cost_usdc, 16129.03);
  assert.equal(r.pooled_vs_gross_pct, 0.1111); // 1/9
  assert.ok(r.savings_usdc > 129000);
});

test("cost in bps of book is the per-$ price to traders", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  // pooled 16,129.03 ÷ 9,000,000 × 10,000 = 17.92 bps
  assert.equal(r.cost_bps_of_book, 17.92);
});

test("delta-flat book (no haircut) → pooled hedge ≈ 0 (self-hedges)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 4_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  assert.equal(r.net_side, "flat");
  assert.equal(r.hedge_side, "put");
  assert.equal(r.pooled_hedge_cost_usdc, 0);
  assert.ok(/self-hedge/.test(r.summary));
});

test("net-long hedges with PUTS (crash, strike below spot)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  assert.equal(r.hedge_side, "put");
  assert.equal(r.band_strike, +(spot * 0.96).toFixed(2));
});

test("net-short book hedges with CALLS (pump, strike above spot)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 2_000_000, shortNotionalUsdc: 5_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  assert.equal(r.net_side, "short");
  assert.equal(r.net_notional_usdc, 3_000_000);
  assert.equal(r.hedge_side, "call");
  assert.equal(r.band_strike, +(spot * 1.04).toFixed(2));
});

test("stress haircut hedges net + fraction of (gross−net)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7, stressHaircut: 0.25 }, put);
  // net 1M + 0.25×(9M−1M)=2M → hedge 3M
  assert.equal(r.hedged_notional_usdc, 3_000_000);
  assert.equal(r.stress_haircut, 0.25);
  // pooled = 1000 × (3M/62000) = 48,387.10
  assert.equal(r.pooled_hedge_cost_usdc, 48387.1);
  // flat book WITH haircut now hedges a stress slice (not zero)
  const flat = computePooledTailHedge({ spot, longNotionalUsdc: 4_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7, stressHaircut: 0.25 }, put);
  assert.equal(flat.hedged_notional_usdc, 2_000_000); // 0 + 0.25×8M
  assert.ok(flat.pooled_hedge_cost_usdc > 0);
});

test("funding check: premiums vs pooled hedge cost", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7, premiumsCollectedUsdc: 20_000 }, put);
  assert.equal(r.premiums_collected_usdc, 20_000);
  assert.equal(r.funded, true); // 20k >= 16.1k
  assert.equal(r.net_after_hedge_usdc, round2(20_000 - 16129.03));
});

const round2 = (x: number) => +x.toFixed(2);
