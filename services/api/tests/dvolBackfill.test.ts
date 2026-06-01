/**
 * Phase 6 — historical DVOL backfill. Validates windowed fetch, idempotency,
 * accurate insert counts, and that calibration flips to empirical post-backfill.
 * Uses an injected fetch (deterministic fixtures) — no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { backfillDvolHistory, type DvolBar } from "../scripts/calibration/backfillDvolHistory";
import { getRegimeCalibration, __resetCalibrationCache } from "../src/singleSide/twoSided/regimeCalibration";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  return new (db.adapters.createPg().Pool)();
};

const NOW = 1_780_000_000_000;
// Hourly bars across the window, dvol cycling calm/moderate/elevated/stress.
const cyclingFetch = (startMs: number, endMs: number, resSec: number): Promise<DvolBar[]> => {
  const step = resSec * 1000;
  const bars: DvolBar[] = [];
  let idx = 0;
  for (let t = startMs; t < endMs; t += step) {
    bars.push({ tsMs: t, dvol: [30, 50, 70, 90][idx % 4] });
    idx++;
  }
  return Promise.resolve(bars);
};

test("backfill: windowed fetch inserts all bars; idempotent on re-run", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  const res = await backfillDvolHistory(pool, { days: 90, resolutionSec: 3600, windowDays: 10, fetch: cyclingFetch, nowMs: NOW });
  assert.equal(res.windows, 9, "90d / 10d = 9 windows");
  assert.equal(res.windowsFailed, 0);
  assert.equal(res.barsFetched, 2160, "90d hourly = 2160 bars");
  assert.equal(res.barsInserted, 2160, "all inserted first run");
  assert.equal(res.regimeBreakdown.calm, 540);
  assert.equal(res.regimeBreakdown.moderate, 540);
  assert.equal(res.regimeBreakdown.elevated, 540);
  assert.equal(res.regimeBreakdown.stress, 540);
  // Re-run over same window → dedupe → zero new inserts
  const res2 = await backfillDvolHistory(pool, { days: 90, resolutionSec: 3600, windowDays: 10, fetch: cyclingFetch, nowMs: NOW });
  assert.equal(res2.barsInserted, 0, "idempotent re-run inserts nothing");
  assert.equal(res2.barsFetched, 2160, "but still fetches (dedupe at persist)");
  await pool.end();
});

test("backfill: flips regime calibration to empirical for all regimes", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureChainSnapshotSchema(pool);
  await backfillDvolHistory(pool, { days: 90, resolutionSec: 3600, windowDays: 15, fetch: cyclingFetch, nowMs: NOW });
  const cal = await getRegimeCalibration(pool, { nowMs: NOW, bypassCache: true });
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(cal[regime].sigmaSource, "empirical_median", `${regime} sigma should be empirical post-backfill`);
    assert.ok(cal[regime].sigmaSampleCount >= 100, `${regime} should have >=100 samples`);
  }
  // sanity: empirical sigma matches the fed dvol/100 medians
  assert.ok(Math.abs(cal.calm.sigma - 0.30) < 0.01, `calm ~0.30 got ${cal.calm.sigma}`);
  assert.ok(Math.abs(cal.stress.sigma - 0.90) < 0.01, `stress ~0.90 got ${cal.stress.sigma}`);
  await pool.end();
});

test("backfill: explicit startMs/endMs targets a historical window (overrides days)", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  // Target a 30-day window ~200 days ago (e.g. a past volatile period), NOT now-days.
  const endMs = NOW - 170 * 86_400_000;
  const startMs = NOW - 200 * 86_400_000;
  const res = await backfillDvolHistory(pool, {
    days: 90, // should be IGNORED because explicit window provided
    resolutionSec: 3600, windowDays: 10, fetch: cyclingFetch, nowMs: NOW, startMs, endMs
  });
  assert.equal(res.windows, 3, "30d / 10d = 3 windows");
  assert.equal(res.barsFetched, 720, "30d hourly = 720 bars (explicit span, not 90d)");
  assert.equal(res.barsInserted, 720);
  assert.ok((res.oldestMs ?? 0) >= startMs && (res.newestMs ?? 0) < endMs, "bars fall inside the explicit window");
  assert.ok(Math.abs(res.days - 30) < 0.01, "reported days reflects the explicit span");
  await pool.end();
});

test("backfill: a failing window is counted but does not abort the rest", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  let call = 0;
  const flakyFetch = (s: number, e: number, r: number): Promise<DvolBar[]> => {
    call++;
    if (call === 2) return Promise.reject(new Error("simulated 429"));
    return cyclingFetch(s, e, r);
  };
  const res = await backfillDvolHistory(pool, { days: 30, resolutionSec: 3600, windowDays: 10, fetch: flakyFetch, nowMs: NOW });
  assert.equal(res.windows, 3);
  assert.equal(res.windowsFailed, 1, "one window failed");
  assert.ok(res.barsInserted > 0, "other windows still inserted");
  await pool.end();
});
