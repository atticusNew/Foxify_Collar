/**
 * Tests for regimeCalibration — empirical → synthetic fallback logic.
 *
 * Uses an in-memory pg-mem instance for the DVOL history + chain snapshot
 * tables (matches the pattern in other twoSided tests).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  __resetCalibrationCache,
  getRegimeCalibration,
  getCachedRegimeCalibrationOrDefault,
  SYNTHETIC_REGIME_SIGMAS,
  SYNTHETIC_REGIME_MARKUPS,
  getCalibrationSummary
} from "../src/singleSide/twoSided/regimeCalibration";
import { ensureDvolHistorySchema, persistDvolSample } from "../src/singleSide/twoSided/dvolHistory";
import { ensureChainSnapshotSchema } from "../src/singleSide/twoSided/chainSnapshotPersist";
import { classifyRegime } from "../src/singleSide/twoSided/featureFlag";

const makePool = (): Pool => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  return new (db.adapters.createPg().Pool)();
};

test("calibration: returns synthetic defaults when no history exists", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const cal = await getRegimeCalibration(pool, { nowMs: 1_780_000_000_000 });
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(cal[regime].sigmaSource, "synthetic_default");
    assert.equal(cal[regime].markupSource, "synthetic_default");
    assert.equal(cal[regime].sigma, SYNTHETIC_REGIME_SIGMAS[regime]);
    assert.equal(cal[regime].markup, SYNTHETIC_REGIME_MARKUPS[regime]);
    assert.equal(cal[regime].sigmaSampleCount, 0);
    assert.equal(cal[regime].markupSampleCount, 0);
  }
  await pool.end();
});

test("calibration: uses empirical sigma when enough samples", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // Persist 150 calm samples (DVOL ~30 → sigma ~0.30)
  const baseMs = 1_780_000_000_000 - 86_400_000 * 10; // 10 days ago
  for (let i = 0; i < 150; i++) {
    const sample = { asOfMs: baseMs + i * 60_000, dvol: 30, sigmaAnnual: 0.30 };
    await persistDvolSample(pool, sample);
  }
  const cal = await getRegimeCalibration(pool, { nowMs: 1_780_000_000_000, bypassCache: true });
  assert.equal(cal.calm.sigmaSource, "empirical_median", "should use empirical with 150 samples");
  assert.equal(cal.calm.sigmaSampleCount, 150);
  assert.ok(Math.abs(cal.calm.sigma - 0.30) < 0.001, `expected sigma ~0.30, got ${cal.calm.sigma}`);
  // Other regimes still synthetic (no history for them)
  assert.equal(cal.moderate.sigmaSource, "synthetic_default");
  await pool.end();
});

test("calibration: falls back to synthetic when sample count below threshold", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  // Only 50 samples — below default MIN_SIGMA_CALIB_SAMPLES (100)
  const baseMs = 1_780_000_000_000 - 86_400_000;
  for (let i = 0; i < 50; i++) {
    await persistDvolSample(pool, { asOfMs: baseMs + i * 60_000, dvol: 30, sigmaAnnual: 0.30 });
  }
  const cal = await getRegimeCalibration(pool, { nowMs: 1_780_000_000_000, bypassCache: true });
  assert.equal(cal.calm.sigmaSource, "synthetic_default");
  assert.equal(cal.calm.sigma, SYNTHETIC_REGIME_SIGMAS.calm);
  assert.equal(cal.calm.sigmaSampleCount, 50, "sample count surfaced even when fallback");
  await pool.end();
});

test("calibration: caches result for 5 min", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const t0 = 1_780_000_000_000;
  const cal1 = await getRegimeCalibration(pool, { nowMs: t0 });
  // Same cache window — should NOT re-query
  const cal2 = await getRegimeCalibration(pool, { nowMs: t0 + 60_000 });
  assert.equal(cal1, cal2, "should return same object instance from cache");
  // 6 min later — cache expired, should re-query
  const cal3 = await getRegimeCalibration(pool, { nowMs: t0 + 6 * 60_000 });
  assert.notEqual(cal1, cal3, "should return fresh result after TTL");
  await pool.end();
});

test("calibration: bypassCache forces fresh query", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const cal1 = await getRegimeCalibration(pool, { nowMs: 1_780_000_000_000 });
  const cal2 = await getRegimeCalibration(pool, { nowMs: 1_780_000_000_000, bypassCache: true });
  // Different object references (fresh compute)
  assert.notEqual(cal1, cal2);
  // But values are the same since data didn't change
  assert.deepEqual(cal1.calm, cal2.calm);
  await pool.end();
});

test("getCachedRegimeCalibrationOrDefault: returns sync defaults when cache empty", () => {
  __resetCalibrationCache();
  const cal = getCachedRegimeCalibrationOrDefault();
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(cal[regime].sigmaSource, "synthetic_default");
    assert.equal(cal[regime].sigma, SYNTHETIC_REGIME_SIGMAS[regime]);
  }
});

test("getCalibrationSummary: includes synthetic_defaults reference", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const summary = await getCalibrationSummary(pool, 1_780_000_000_000);
  assert.equal(typeof summary.asOf, "string");
  assert.deepEqual(summary.synthetic_defaults.sigmas, SYNTHETIC_REGIME_SIGMAS);
  assert.deepEqual(summary.synthetic_defaults.markups, SYNTHETIC_REGIME_MARKUPS);
  assert.ok(typeof summary.cache_ttl_ms === "number");
  await pool.end();
});

test("regime classification matches: stored regime aligns with classifyRegime(dvol)", () => {
  assert.equal(classifyRegime(20), "calm");
  assert.equal(classifyRegime(45), "moderate");
  assert.equal(classifyRegime(70), "elevated");
  assert.equal(classifyRegime(90), "stress");
});

test("calibration: EWMA weighting tracks a recent IV rise faster than median", async () => {
  __resetCalibrationCache();
  const pool = makePool();
  await ensureDvolHistorySchema(pool);
  await ensureChainSnapshotSchema(pool);
  const now = 1_780_000_000_000;
  // 150 calm samples over the prior ~6 days: OLD half dvol=30, RECENT half dvol=38.
  const base = now - 150 * 3_600_000;
  for (let i = 0; i < 150; i++) {
    const dvol = i < 75 ? 30 : 38; // recent half higher
    await persistDvolSample(pool, { asOfMs: base + i * 3_600_000, dvol, sigmaAnnual: dvol / 100 });
  }
  const calMedian = await getRegimeCalibration(pool, { nowMs: now, bypassCache: true, weighting: "median" });
  const calEwma = await getRegimeCalibration(pool, { nowMs: now, bypassCache: true, weighting: "ewma", halfLifeDays: 2 });
  assert.equal(calMedian.calm.sigmaSource, "empirical_median");
  assert.equal(calEwma.calm.sigmaSource, "empirical_ewma");
  // EWMA weights the recent dvol=38 (sigma 0.38) more → higher than the median (~0.34)
  assert.ok(calEwma.calm.sigma > calMedian.calm.sigma,
    `ewma ${calEwma.calm.sigma} should exceed median ${calMedian.calm.sigma} when IV recently rose`);
  assert.ok(calEwma.calm.sigma > 0.35, `ewma should lean toward recent 0.38, got ${calEwma.calm.sigma}`);
});
