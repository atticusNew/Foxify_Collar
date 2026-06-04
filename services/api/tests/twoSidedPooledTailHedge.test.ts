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

test("delta-flat book → pooled hedge ≈ 0 (self-hedging)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 4_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  assert.equal(r.net_side, "flat");
  assert.equal(r.pooled_hedge_cost_usdc, 0);
  assert.ok(/self-hedging/.test(r.summary));
});

test("net-short book is detected (mirror side)", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 2_000_000, shortNotionalUsdc: 5_000_000, bandPct: 0.04, tenorDays: 7 }, put);
  assert.equal(r.net_side, "short");
  assert.equal(r.net_notional_usdc, 3_000_000);
});

test("funding check: premiums vs pooled hedge cost", () => {
  const r = computePooledTailHedge({ spot, longNotionalUsdc: 5_000_000, shortNotionalUsdc: 4_000_000, bandPct: 0.04, tenorDays: 7, premiumsCollectedUsdc: 20_000 }, put);
  assert.equal(r.premiums_collected_usdc, 20_000);
  assert.equal(r.funded, true); // 20k >= 16.1k
  assert.equal(r.net_after_hedge_usdc, round2(20_000 - 16129.03));
});

const round2 = (x: number) => +x.toFixed(2);
