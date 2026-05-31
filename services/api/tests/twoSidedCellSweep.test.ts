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
import { runFullCellSweep, ensureCellSweepSchema, getLatestSweepRun, listSweepRuns, buildSearchGrid, type CellStructure } from "../src/singleSide/twoSided/cellSweep";
import { runFoxifyDurationMc } from "../src/singleSide/twoSided/foxifyDurationMc";
import { bsPut, bsCall } from "../scripts/backtest/singleSide/coreEngine";
import { RISK_FREE_RATE } from "../src/singleSide/twoSided/optionPricing";
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

test("getLatestSweepRun: returns latest COMPLETED, skips incomplete newer runs", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  // Run one completed sweep
  const completedReport = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0],
    tenors: [2], autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250],
    nPaths: 50, venue: "auto", liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: true });
  // Insert a NEWER row directly (simulating a stalled sweep)
  await pool.query(
    `INSERT INTO two_sided_cell_sweep_run (run_id, started_at, total_sims, spot, current_regime, venue, calibration_json) VALUES ($1::text, $2::timestamptz, $3, $4::numeric, $5::text, $6::text, $7::text)`,
    ["stalled-run-id", new Date(Date.now() + 1000).toISOString(), 99, 73000, "calm", "auto", "{}"]
  );
  // getLatestSweepRun should return the COMPLETED one, ignoring the stalled newer one
  const latest = await getLatestSweepRun(pool);
  assert.ok(latest);
  assert.equal(latest.runId, completedReport.runId, "should return completed runId, not stalled");
  await pool.end();
});

test("listSweepRuns: reports completed + in_progress + stalled status", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 48, bid: 200, ask: 230 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 48, bid: 200, ask: 230 }
  ]);
  // Completed sweep
  await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0],
    tenors: [2], autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250],
    nPaths: 50, venue: "auto", liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: true });
  // Stalled (older than 15 min, no completed_at)
  await pool.query(
    `INSERT INTO two_sided_cell_sweep_run (run_id, started_at, total_sims, spot, current_regime, venue, calibration_json) VALUES ($1::text, $2::timestamptz, $3, $4::numeric, $5::text, $6::text, $7::text)`,
    ["stalled", new Date(Date.now() - 20 * 60_000).toISOString(), 99, 73000, "calm", "auto", "{}"]
  );
  // In-progress (started 5 min ago, no completed_at)
  await pool.query(
    `INSERT INTO two_sided_cell_sweep_run (run_id, started_at, total_sims, spot, current_regime, venue, calibration_json) VALUES ($1::text, $2::timestamptz, $3, $4::numeric, $5::text, $6::text, $7::text)`,
    ["in-progress", new Date(Date.now() - 5 * 60_000).toISOString(), 99, 73000, "calm", "auto", "{}"]
  );
  const runs = await listSweepRuns(pool);
  const statuses = runs.map((r) => r.status);
  assert.ok(statuses.includes("completed"), `expected completed; got ${statuses.join(",")}`);
  assert.ok(statuses.includes("in_progress"), `expected in_progress; got ${statuses.join(",")}`);
  assert.ok(statuses.includes("failed_or_stalled"), `expected stalled; got ${statuses.join(",")}`);
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

// ──────────────────────────── Phase 4: structure variants ────────────────────────────

test("grid: emits straddle (ATM) + strangle (OTM wings only); m=0 strangle skipped", () => {
  const dummyChain = makeChain([]);
  const grid = buildSearchGrid(73000, {
    spot: 73000,
    notionals: [50000],
    triggers: [0.03],
    tenors: [3],
    strikeMoneyness: [0, -0.02, -0.03],
    liquidChainCache: dummyChain,
    currentRegime: "calm"
  });
  const straddles = grid.filter((c) => c.structure === "straddle");
  const strangles = grid.filter((c) => c.structure === "strangle");
  // straddle: 1 ATM point; strangle: 2 wings (m=-0.02,-0.03); m=0 skipped for strangle
  assert.equal(straddles.length, 1, "exactly one straddle (ATM)");
  assert.equal(strangles.length, 2, "two strangle wings (m=0 skipped)");
  assert.equal(straddles[0].strikeMoneynessPct, 0);
  assert.ok(strangles.every((c) => c.strikeMoneynessPct !== 0), "no m=0 in strangle");
  // No duplicate candidate cellIds
  const ids = grid.map((c) => c.cellId);
  assert.equal(new Set(ids).size, ids.length, `cellIds must be unique: ${ids.join(",")}`);
});

test("grid: structures=['straddle'] yields only ATM straddle; ['strangle'] with m=[0] yields none", () => {
  const dummyChain = makeChain([]);
  const onlyStraddle = buildSearchGrid(73000, {
    spot: 73000, notionals: [50000], triggers: [0.03], tenors: [3],
    strikeMoneyness: [0, -0.02], structures: ["straddle"],
    liquidChainCache: dummyChain, currentRegime: "calm"
  });
  assert.equal(onlyStraddle.length, 1);
  assert.equal(onlyStraddle[0].structure, "straddle");
  const onlyStrangleAtm = buildSearchGrid(73000, {
    spot: 73000, notionals: [50000], triggers: [0.03], tenors: [3],
    strikeMoneyness: [0], structures: ["strangle"],
    liquidChainCache: dummyChain, currentRegime: "calm"
  });
  assert.equal(onlyStrangleAtm.length, 0, "strangle with only m=0 produces no candidates");
});

test("sweep: straddle cell produces real tier with structure label + equal strikes", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // ATM straddle snaps to 73000 for both legs
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 72, bid: 1800, ask: 2000 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 72, bid: 1800, ask: 2000 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0], tenors: [3],
    autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250], nPaths: 100,
    venue: "auto", structures: ["straddle"], liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: false });
  const calm = report.rankings.calm;
  assert.equal(calm.cellsWithChainData, 1, "one straddle candidate priced");
  assert.equal(calm.result_tier, "real");
  assert.ok(calm.topCells.length >= 1);
  const top = calm.topCells[0];
  assert.equal(top.params.structure, "straddle");
  assert.equal(top.params.put_strike, top.params.call_strike, "straddle = equal strikes");
  assert.ok(top.cellId.includes("STRADDLE"), `cellId carries structure token: ${top.cellId}`);
});

test("sweep: persisted straddle round-trips structure via getLatestSweepRun", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  const chain = makeChain([
    { venue: "deribit", strike: 73000, optType: "put", tenorHours: 72, bid: 1800, ask: 2000 },
    { venue: "deribit", strike: 73000, optType: "call", tenorHours: 72, bid: 1800, ask: 2000 }
  ]);
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0], tenors: [3],
    autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250], nPaths: 100,
    venue: "auto", structures: ["straddle"], liquidChainCache: chain, currentRegime: "calm"
  }, { persistResults: true });
  const latest = await getLatestSweepRun(pool);
  assert.ok(latest);
  assert.equal(latest.runId, report.runId);
  const top = latest.rankings.calm.topCells[0];
  assert.equal(top.params.structure, "straddle", "structure survives DB round-trip");
  await pool.end();
});

test("MC gamma hypothesis: straddle vs OTM strangle auto-close (empirical, non-breaking)", async () => {
  // Identical params; only strike geometry differs.
  // Straddle: both legs ATM (max gamma). Strangle: 3% OTM wings (lower gamma).
  const spot = 73000;
  const sigma = 0.55;
  const tenorDays = 3;
  const contractsBtc = 1;
  const T = tenorDays / 365;
  // Derive each structure's entry cost from its OWN BS value (realistic + fair):
  // both start equally "in the hole" after the 0.85 realism + 0.95 slip, so the
  // auto-close comparison isolates gamma (recovery speed), not a rigged cost gap.
  const cost = (pk: number, ck: number) =>
    (Math.max(0, bsPut(spot, pk, T, RISK_FREE_RATE, sigma)) +
     Math.max(0, bsCall(spot, ck, T, RISK_FREE_RATE, sigma))) * contractsBtc;
  const base = {
    cellId: "gamma_test", spot, hedgeCostUsdc: 0,
    tenorDays, triggerPctDown: 0.05, triggerPctUp: 0.05,
    regime: "calm" as const, sigmaAnnual: sigma, contractsBtc,
    autoClosePnlPct: 0.15, autoCloseAbsoluteUsdc: 1e9, // % trigger isolates gamma harvest
    salvageRealismMultiplier: 0.85, bidSlipHaircut: 0.95, nPaths: 1500, seed: 7,
    barsOverride: null
  };
  const straddle = await runFoxifyDurationMc({
    ...base, putStrike: 73000, callStrike: 73000, hedgeCostUsdc: cost(73000, 73000)
  });
  const strangle = await runFoxifyDurationMc({
    ...base, putStrike: 70810, callStrike: 75190, hedgeCostUsdc: cost(70810, 75190)
  });
  // Structural invariants that MUST hold (deterministic):
  assert.ok(straddle.pctProfitable >= 0 && straddle.pctProfitable <= 1);
  assert.ok(strangle.pctProfitable >= 0 && strangle.pctProfitable <= 1);
  const sAuto = straddle.exitDistribution.foxify_auto_close;
  const gAuto = strangle.exitDistribution.foxify_auto_close;
  // EMPIRICAL FINDING (logged, not asserted — refinement B): the CTO hypothesis
  // is that ATM straddle's higher gamma yields a higher auto-close rate.
  const verdict = sAuto > gAuto
    ? `CONFIRMED straddle higher (${(sAuto * 100).toFixed(1)}% vs ${(gAuto * 100).toFixed(1)}%)`
    : sAuto < gAuto
      ? `REJECTED strangle higher (${(gAuto * 100).toFixed(1)}% vs ${(sAuto * 100).toFixed(1)}%)`
      : `INDETERMINATE equal (${(sAuto * 100).toFixed(1)}%)`;
  console.log(`[EMPIRICAL][gamma-hypothesis] auto-close rate: ${verdict}; ` +
    `straddle netMean=$${straddle.meanFoxifyNetUsdc.toFixed(0)} ` +
    `strangle netMean=$${strangle.meanFoxifyNetUsdc.toFixed(0)}`);
  // Always-true sanity: straddle ATM is strictly more expensive than OTM strangle.
  assert.ok(straddle.meanCostPaid > strangle.meanCostPaid,
    "ATM straddle costs more than OTM strangle");
});

test("sweep: structure_verdict + top_straddle/top_strangle populated for both structures", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await setupPool(pool);
  // Chain returns a quote for ANY strike so both straddle (ATM) and strangle
  // (OTM wings) price out and the per-regime verdict can compare them.
  const anyChain = {
    getBidForSymbol: () => null,
    getBidForLeg: (opts: { strike: number; optType: "put" | "call" }) => ({
      bidUsdcPerBtc: 1800, askUsdcPerBtc: 2000, midUsdcPerBtc: 1900,
      spreadPct: 0.1, venue: "deribit" as const,
      instrumentName: `BTC-${opts.strike}-${opts.optType.toUpperCase()}`,
      tenorHours: 72, markIv: 0.4, pulledAtMs: Date.now()
    }),
    getCached: () => null
  } as unknown as LiquidChainCache;
  const report = await runFullCellSweep(pool, {
    spot: 73000, notionals: [50000], triggers: [0.03], strikeMoneyness: [0, -0.03], tenors: [3],
    autoClosePnlPcts: [0.30], autoCloseAbsoluteUsdcs: [250], nPaths: 100,
    venue: "auto", structures: ["strangle", "straddle"], liquidChainCache: anyChain, currentRegime: "calm"
  }, { persistResults: false });
  const calm = report.rankings.calm;
  assert.ok(calm.top_straddle, "top_straddle present");
  assert.ok(calm.top_strangle, "top_strangle present");
  assert.equal((calm.top_straddle as NonNullable<typeof calm.top_straddle>).params.structure, "straddle");
  assert.equal((calm.top_strangle as NonNullable<typeof calm.top_strangle>).params.structure, "strangle");
  assert.equal(typeof calm.structure_verdict, "string");
  assert.ok(calm.structure_verdict.length > 0, "verdict non-empty");
  console.log(`[EMPIRICAL][verdict-test] calm (real tier): ${calm.structure_verdict}`);
});
