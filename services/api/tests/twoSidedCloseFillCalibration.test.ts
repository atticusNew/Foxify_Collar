/**
 * Tests — closeFillCalibration (estimate-vs-realized close-fill logger).
 *
 * Verifies the recorder computes implied haircut + ratio, the summary tunes off
 * LIVE closes only (shadow excluded), per-cell rollup, and the recommendation
 * gating (≥5 live closes).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureCloseFillCalibrationSchema,
  recordCloseFillObservation,
  getCloseFillCalibration,
  __resetCloseFillSchemaFlag
} from "../src/singleSide/twoSided/closeFillCalibration";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  __resetCloseFillSchemaFlag();
  await ensureCloseFillCalibrationSchema(pool);
  return pool;
};

test("closeFillCalibration: records implied haircut + ratio; live-only summary", async () => {
  const pool = await buildPool();
  // LIVE close: raw value 100, applied haircut 0.85 → estimated 85; realized 80.
  await recordCloseFillObservation(pool, {
    pairId: "p1", cellId: "cell_a", isShadow: false, exitMode: "foxify_close",
    rawCombinedValueUsdc: 100, slippageHaircut: 0.85, realizedSalvageUsdc: 80,
    putValuationMethod: "exact_symbol", callValuationMethod: "exact_symbol"
  });
  // SHADOW close: value == fill (ratio ~1) — must be EXCLUDED from live tuning.
  await recordCloseFillObservation(pool, {
    pairId: "p2", cellId: "cell_a", isShadow: true, exitMode: "foxify_close",
    rawCombinedValueUsdc: 50, slippageHaircut: 0.85, realizedSalvageUsdc: 42.5
  });

  const out = await getCloseFillCalibration(pool);
  assert.equal(out.n, 2);
  assert.equal(out.live_n, 1);
  assert.equal(out.shadow_n, 1);
  // implied haircut (live) = realized/raw = 80/100 = 0.80
  assert.equal(out.live.mean_implied_haircut, 0.8);
  // ratio realized/estimated = 80/85 = 0.9412
  assert.equal(out.live.mean_ratio_realized_to_estimated, 0.9412);
  assert.equal(out.live.current_haircut_observed, 0.85);
  // < 5 live → "not enough" recommendation
  assert.match(out.recommendation, /not enough/i);
});

test("closeFillCalibration: ≥5 live closes → tuning recommendation toward implied haircut", async () => {
  const pool = await buildPool();
  // 6 live closes, all realized at 0.80× raw value while applying 0.85 haircut.
  for (let i = 0; i < 6; i++) {
    await recordCloseFillObservation(pool, {
      pairId: `live-${i}`, cellId: "cell_b", isShadow: false, exitMode: "trail_retrace",
      rawCombinedValueUsdc: 100, slippageHaircut: 0.85, realizedSalvageUsdc: 80
    });
  }
  const out = await getCloseFillCalibration(pool);
  assert.equal(out.live_n, 6);
  assert.equal(out.live.mean_implied_haircut, 0.8);
  // bias of ~0.05 > 0.03 threshold → recommends moving toward 0.80
  assert.match(out.recommendation, /0\.8/);
  assert.match(out.recommendation, /haircut/i);
  // per-cell rollup present
  const cell = out.per_cell.find((c) => c.cell_id === "cell_b")!;
  assert.equal(cell.live_n, 6);
  assert.equal(cell.mean_implied_haircut, 0.8);
});

test("closeFillCalibration: cells filter limits the aggregate", async () => {
  const pool = await buildPool();
  await recordCloseFillObservation(pool, { pairId: "a", cellId: "cell_a", isShadow: false, rawCombinedValueUsdc: 100, slippageHaircut: 0.85, realizedSalvageUsdc: 80 });
  await recordCloseFillObservation(pool, { pairId: "b", cellId: "cell_b", isShadow: false, rawCombinedValueUsdc: 100, slippageHaircut: 0.85, realizedSalvageUsdc: 90 });
  const out = await getCloseFillCalibration(pool, { cells: ["cell_b"] });
  assert.equal(out.n, 1);
  assert.equal(out.live.mean_implied_haircut, 0.9);
});

test("closeFillCalibration: recorder is best-effort (raw value 0 → null implied, no throw)", async () => {
  const pool = await buildPool();
  await recordCloseFillObservation(pool, { pairId: "z", cellId: "cell_z", isShadow: false, rawCombinedValueUsdc: 0, slippageHaircut: 0.85, realizedSalvageUsdc: 0 });
  const out = await getCloseFillCalibration(pool);
  assert.equal(out.n, 1);
  // raw value 0 → implied null → excluded from mean (no live implied samples)
  assert.equal(out.live.mean_implied_haircut, null);
});
