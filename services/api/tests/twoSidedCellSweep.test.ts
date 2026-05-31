/**
 * Tests for cellSweep — real-pricing path.
 *
 * Validates:
 *   - Cells where chain has no quote → result_tier "chain_unavailable", excluded from rankings
 *   - Cells in current regime → "real" tier
 *   - Cells in other regimes → "estimate" tier
 *   - Venue filter (bullish-only / deribit-only) properly rejects other venues
 *   - cost_source / salvage_source fields populated correctly
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runFullCellSweep, ensureCellSweepSchema, getLatestSweepRun } from "../src/singleSide/twoSided/cellSweep";
import type { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";
import { ensureDvolHistorySchema } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { __resetCalibrationCache } from "../src/singleSide/twoSided/regimeCalibration";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "gen_random_uuid", returns: DataType.uuid, impure: true,
    implementation: () => randomUUID()
  });
  return new (db.adapters.createPg().Pool)();
};

const makeChain = (quotes: Array<{
  venue: "deribit" | "bullish";
  strike: number;
  optType: "put" | "call";
  tenorHours: number;
  bid: number;
  ask: number;
}>): LiquidChainCache => ({
  getBidForSymbol: () => null,
  getBidForLeg: (opts: { strike: number; optType: "put" | "call"; preferVenue?: string }) => {
    const matches = quotes.filter((q) =>
      q.strike === opts.strike && q.optType === opts.optType &&
      (opts.preferVenue == null || q.venue === opts.preferVenue)
    );
    if (matches.length === 0) return null;
    const q = matches[0];
    return {
      bidUsdcPerBtc: q.bid, askUsdcPerBtc: q.ask, midUsdcPerBtc: (q.bid + q.ask) / 2,
      spreadPct: q.ask > 0 ? (q.ask - q.bid) / q.ask : 0,
      venue: q.venue, instrumentName: `BTC-${q.strike}-${q.optType.toUpperCase()}`,
      tenorHours: q.tenorHours, markIv: 0.36, pulledAtMs: Date.now()
    };
  },
  getCached: () => null
}) as unknown as LiquidChainCache;

const setupPool = async (pool: Pool) => {
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  await ensureCellSweepSchema(pool);
};

test("sweep: cells with no chain data are marked chain_unavailable + excluded from rankings", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // Empty chain — no quotes for any candidate
  const chain = makeChain([]);
  const report = await runFullCellSweep(pool, {
    spot: 73000,
    notionals: [50000],
    triggers: [0.03],
    strikeMoneyness: [0],
    tenors: [2],
    autoClosePnlPcts: [0.30],
    autoCloseAbsoluteUsdcs: [250],
    nPaths: 50,
    venue: "auto",
    liquidChainCache: chain,
    currentRegime: "calm"
  }, { persistResults: false });
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(report.rankings[regime].result_tier, "chain_unavailable",
      `${regime} should be chain_unavailable when no chain quotes exist`);
    assert.equal(report.rankings[regime].cellsWithChainData, 0);
    assert.equal(report.rankings[regime].topCells.length, 0,
      `${regime} should have no ranked cells when chain unavailable`);
  }
  await pool.end();
});

test("sweep: current regime gets result_tier='real', others get 'estimate'", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // Chain has quotes for the candidate strikes
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000,
    notionals: [50000],
    triggers: [0.03],
    strikeMoneyness: [0],
    tenors: [2],
    autoClosePnlPcts: [0.30],
    autoCloseAbsoluteUsdcs: [250],
    nPaths: 50,
    venue: "auto",
    liquidChainCache: chain,
    currentRegime: "moderate"
  }, { persistResults: false });
  assert.equal(report.rankings.moderate.result_tier, "real",
    "current regime (moderate) should be real");
  assert.equal(report.rankings.calm.result_tier, "estimate");
  assert.equal(report.rankings.elevated.result_tier, "estimate");
  assert.equal(report.rankings.stress.result_tier, "estimate");
  await pool.end();
});

test("sweep: cost_source and salvage_source fields populated when real prices used", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "bullish", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "bullish", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000,
    notionals: [50000],
    triggers: [0.03],
    strikeMoneyness: [0],
    tenors: [2],
    autoClosePnlPcts: [0.30],
    autoCloseAbsoluteUsdcs: [250],
    nPaths: 50,
    venue: "auto",
    liquidChainCache: chain,
    currentRegime: "calm"
  }, { persistResults: false });
  // calm regime is current → should have real result with real source labels
  const calm = report.rankings.calm;
  assert.equal(calm.cellsWithChainData, 1, "1 candidate × 1 auto-close combo");
  // Top cell should have bullish source
  if (calm.topCells.length > 0) {
    const top = calm.topCells[0];
    assert.equal(top.cost_source_put, "real_ask_bullish");
    assert.equal(top.cost_source_call, "real_ask_bullish");
    assert.equal(top.salvage_source_put, "real_bid_bullish");
    assert.equal(top.salvage_source_call, "real_bid_bullish");
    assert.equal(top.result_tier, "real");
  }
  await pool.end();
});

test("sweep: venue='bullish' filter rejects Deribit quotes", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // Only Deribit has quotes; Bullish has none
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000,
    notionals: [50000],
    triggers: [0.03],
    strikeMoneyness: [0],
    tenors: [2],
    autoClosePnlPcts: [0.30],
    autoCloseAbsoluteUsdcs: [250],
    nPaths: 50,
    venue: "bullish",
    liquidChainCache: chain,
    currentRegime: "calm"
  }, { persistResults: false });
  // Should reject Deribit quote → no chain data for any regime
  assert.equal(report.rankings.calm.result_tier, "chain_unavailable",
    "bullish-only filter should reject deribit-only chain");
  await pool.end();
});

test("sweep: venue='auto' uses whatever chain provides", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0],
    tenors: [2], autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250],
    nPaths: 50, venue: "auto", liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: false });
  assert.equal(report.rankings.calm.cellsWithChainData, 1);
  if (report.rankings.calm.topCells.length > 0) {
    assert.equal(report.rankings.calm.topCells[0].cost_source_put, "real_ask_deribit");
  }
  await pool.end();
});

test("sweep: persists results and getLatestSweepRun retrieves them", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0],
    tenors: [2], autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250],
    nPaths: 50, venue: "auto", liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: true });
  const latest = await getLatestSweepRun(pool);
  assert.ok(latest);
  assert.equal(latest.runId, report.runId);
  assert.equal(latest.currentRegime, "calm");
  assert.equal(latest.venue, "auto");
  await pool.end();
});

test("sweep: result includes hedge_cost from real ask (not synthetic BS × markup)", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // Specific known asks: 200/BTC + 250/BTC for 1 BTC contracts = 450 cost
  const contractsBtc = 1.0; // notional 73000 ÷ spot 73000 = 1 BTC (after rounding)
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 180, ask: 200 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 220, ask: 250 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [73000], triggers: [0.03], strikeMoneyness: [0],
    tenors: [2], autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250],
    nPaths: 50, venue: "auto", liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: false });
  if (report.rankings.calm.topCells.length > 0) {
    const top = report.rankings.calm.topCells[0];
    // hedge_cost = (200 + 250) * 1 = 450
    assert.equal(top.capital_per_pair, 450, `expected real cost = 450 (real asks), got ${top.capital_per_pair}`);
  }
  void contractsBtc; // silence unused
  await pool.end();
});
