/**
 * PR C3 tests — cell allowlist + multi-cell registry.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  DEFAULT_CELL_ALLOWLIST,
  ensureCellAllowlistSchema,
  isCellAllowedInRegime,
  isCellAllowedInRegimeDefault,
  setCellOverride,
  getEffectiveAllowlist,
  getOverrides
} from "../src/singleSide/twoSided/cellAllowlist";
import { PHASE_0_CELLS } from "../src/singleSide/twoSided/cellConfig";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureCellAllowlistSchema(pool);
  return pool;
};

test("PHASE_0_CELLS registry contains 7 cells (Phase 0 + 6 Phase 1)", () => {
  const cellIds = Object.keys(PHASE_0_CELLS);
  assert.equal(cellIds.length, 7);
  assert.ok(cellIds.includes("pair_50k_2pct"));
  assert.ok(cellIds.includes("pair_50k_5pct_otm"));
  assert.ok(cellIds.includes("pair_25k_1pct_atm_micro"));
});

test("DEFAULT_CELL_ALLOWLIST: all 4 regimes have at least 1 cell", () => {
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.ok(DEFAULT_CELL_ALLOWLIST[regime].length > 0, `${regime} should have at least 1 cell`);
  }
});

test("isCellAllowedInRegimeDefault: Phase 0 cell allowed in calm but not stress", () => {
  assert.equal(isCellAllowedInRegimeDefault("pair_50k_2pct", "calm"), true);
  assert.equal(isCellAllowedInRegimeDefault("pair_50k_2pct", "stress"), false);
});

test("isCellAllowedInRegimeDefault: micro cell allowed in all regimes", () => {
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(isCellAllowedInRegimeDefault("pair_25k_1pct_atm_micro", regime), true);
  }
});

test("isCellAllowedInRegime (DB): respects defaults when no override", async () => {
  const pool = await buildPool();
  const r = await isCellAllowedInRegime(pool, "pair_50k_2pct", "calm");
  assert.equal(r.allowed, true);
  assert.ok(r.suggestedCells.includes("pair_50k_2pct"));
});

test("setCellOverride: adds cell to regime that didn't have it", async () => {
  const pool = await buildPool();
  // pair_50k_2pct is NOT in stress default
  const before = await isCellAllowedInRegime(pool, "pair_50k_2pct", "stress");
  assert.equal(before.allowed, false);
  // Override to enable
  await setCellOverride(pool, "stress", "pair_50k_2pct", true, "operator override for ramping test", "operator");
  const after = await isCellAllowedInRegime(pool, "pair_50k_2pct", "stress");
  assert.equal(after.allowed, true);
});

test("setCellOverride: disables a default-enabled cell", async () => {
  const pool = await buildPool();
  // pair_50k_2pct IS in calm default
  const before = await isCellAllowedInRegime(pool, "pair_50k_2pct", "calm");
  assert.equal(before.allowed, true);
  await setCellOverride(pool, "calm", "pair_50k_2pct", false, "temporarily disabled for investigation", "operator");
  const after = await isCellAllowedInRegime(pool, "pair_50k_2pct", "calm");
  assert.equal(after.allowed, false);
});

test("getEffectiveAllowlist: merges defaults + overrides correctly", async () => {
  const pool = await buildPool();
  await setCellOverride(pool, "stress", "pair_50k_2pct", true, "ramp", "op");
  await setCellOverride(pool, "stress", "pair_25k_1pct_atm_micro", false, "disabled", "op");
  const eff = await getEffectiveAllowlist(pool, "stress");
  assert.ok(eff.includes("pair_50k_2pct"));
  assert.ok(!eff.includes("pair_25k_1pct_atm_micro"));
});

test("getOverrides: returns all overrides", async () => {
  const pool = await buildPool();
  await setCellOverride(pool, "calm", "pair_50k_5pct_otm", true, "test", "op");
  await setCellOverride(pool, "stress", "pair_50k_2pct", true, "ramp", "op");
  const all = await getOverrides(pool);
  assert.equal(all.length, 2);
  const calmOnly = await getOverrides(pool, "calm");
  assert.equal(calmOnly.length, 1);
  assert.equal(calmOnly[0].cellId, "pair_50k_5pct_otm");
});
