/**
 * Vega-timing backtest — IV-percentile entry + vega-vs-theta P&L over a hold.
 * Pure logic on REAL DVOL history schema; seeded with a controlled fixture.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureDvolHistorySchema, persistDvolSample } from "../src/singleSide/twoSided/dvolHistory";
import { computeIvPercentile, backtestVegaTiming } from "../src/singleSide/twoSided/vegaTimingBacktest";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  return new (db.adapters.createPg().Pool)();
};

const HOUR = 3_600_000;
const seed = async (pool: Pool, baseMs: number, hours: number, dvolFn: (h: number) => number) => {
  for (let h = 0; h < hours; h++) {
    const dvol = dvolFn(h);
    await persistDvolSample(pool, { asOfMs: baseMs + h * HOUR, dvol, sigmaAnnual: dvol / 100 });
  }
};

test("computeIvPercentile: fraction of trailing <= value", () => {
  assert.equal(computeIvPercentile([30, 40, 50, 60], 30), 0.25);
  assert.equal(computeIvPercentile([30, 40, 50, 60], 60), 1.0);
  assert.equal(computeIvPercentile([], 50), 0.5);
});

test("vega-timing: cheap-vol entry into IV expansion → +EV", async () => {
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  const base = 1_780_000_000_000 - 6 * 24 * HOUR;
  // days 0-3: baseline calm IV=35 (trailing window); day 3: dip to 20 (cheap, low pctile);
  // day 4: expansion to 38 (exit). hold_days=1.
  await seed(pool, base, 4 * 24, () => 35);                       // 96h baseline
  await seed(pool, base + 4 * 24 * HOUR, 24, () => 20);           // entry window (cheap)
  await seed(pool, base + 5 * 24 * HOUR, 24, () => 38);           // exit window (expanded)
  const r = await backtestVegaTiming(pool, {
    entryPercentile: 0.25, holdDays: 1, tenorDays: 7, lookbackDays: 3, calmOnly: true, minTrailing: 20
  });
  assert.ok(r.eligible_entries > 0, `expected entries, got ${r.eligible_entries}`);
  assert.ok(r.mean_iv_change > 0, "IV expanded 20→38");
  assert.ok(r.mean_pnl_per_btc_usdc > 0, `cheap-vol→expansion should be +EV, got ${r.mean_pnl_per_btc_usdc}`);
  await pool.end();
});

test("vega-timing: flat IV → no cheap entries (insufficient/no edge)", async () => {
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  const base = 1_780_000_000_000 - 6 * 24 * HOUR;
  await seed(pool, base, 6 * 24, () => 35); // flat IV — nothing is in a low percentile
  const r = await backtestVegaTiming(pool, { entryPercentile: 0.25, holdDays: 1, tenorDays: 7, lookbackDays: 3, calmOnly: true, minTrailing: 20 });
  assert.equal(r.eligible_entries, 0, "flat IV -> no low-percentile entries");
  assert.ok(r.verdict.includes("INSUFFICIENT"), "verdict flags insufficient");
  await pool.end();
});

test("vega-timing: downsampling collapses dense (1/min) samples to ~1/hour", async () => {
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  const base = 1_780_000_000_000 - 24 * HOUR;
  // 180 minutes of 1/min samples (dense) — should downsample to ~3 hourly buckets
  for (let m = 0; m < 180; m++) {
    await persistDvolSample(pool, { asOfMs: base + m * 60_000, dvol: 35, sigmaAnnual: 0.35 });
  }
  const r = await backtestVegaTiming(pool, { granularityHours: 1, lookbackDays: 3, minTrailing: 1 });
  assert.ok(r.total_samples >= 170, `raw count ~180, got ${r.total_samples}`);
  assert.ok(r.downsampled_samples <= 5, `hourly downsample ~3, got ${r.downsampled_samples}`);
  assert.ok(r.downsampled_samples < r.total_samples, "downsampled < raw");
  assert.equal(r.granularity_hours, 1);
  await pool.end();
});
