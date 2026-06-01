/**
 * PR C3 tests — cell allowlist + multi-cell registry.
 * Updated 2026-05-28 to reflect V3 multi-tenor sweep findings:
 *   - calm default is empty (no cell profitable; operator must override)
 *   - pair_50k_2pct, pair_100k_3pct_itm_short, pair_25k_1pct_atm_micro removed
 *     from all defaults (V3 proves them loss-making in every regime)
 *   - pair_25k_5pct_otm_3d added as moderate winner (+$252/pair MC EV)
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

test("PHASE_0_CELLS registry contains all known cells including the new 3d winner", () => {
  const cellIds = Object.keys(PHASE_0_CELLS);
  assert.ok(cellIds.includes("pair_50k_2pct"), "old Phase 0 cell still in registry (override-only)");
  assert.ok(cellIds.includes("pair_50k_5pct_otm"));
  assert.ok(cellIds.includes("pair_25k_1pct_atm_micro"), "micro cell still registered (override-only)");
  assert.ok(cellIds.includes("pair_25k_5pct_otm_3d"), "new moderate winner from redesign sweep");
  assert.ok(cellIds.length >= 7);
});

test("DEFAULT_CELL_ALLOWLIST: calm is intentionally EMPTY (no cell profitable per V3)", () => {
  assert.equal(DEFAULT_CELL_ALLOWLIST.calm.length, 0, "operator must consciously override to activate in calm");
});

test("DEFAULT_CELL_ALLOWLIST: moderate/elevated/stress have at least 1 cell", () => {
  for (const regime of ["moderate", "elevated", "stress"] as const) {
    assert.ok(DEFAULT_CELL_ALLOWLIST[regime].length > 0, `${regime} should have at least 1 cell`);
  }
});

test("DEFAULT_CELL_ALLOWLIST: moderate features the empirical ATM straddle winner", () => {
  assert.ok(DEFAULT_CELL_ALLOWLIST.moderate.includes("pair_150k_3pct_atm_3d"));
  assert.ok(DEFAULT_CELL_ALLOWLIST.moderate.includes("pair_25k_5pct_otm_3d"));
});

test("DEFAULT_CELL_ALLOWLIST: pair_50k_2pct PRUNED from all regimes (deprecated 2026-06-01; synthetic-era EV, superseded by ATM straddle)", () => {
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.ok(!DEFAULT_CELL_ALLOWLIST[regime].includes("pair_50k_2pct"), `pair_50k_2pct must NOT be in ${regime} default`);
  }
});

test("isCellAllowedInRegimeDefault: V5-broken cells NOT in any default regime", () => {
  // pair_50k_2pct was V3-broken but V5 reversed that — now in moderate/elevated/stress.
  // Truly broken cells (per V5):
  for (const broken of ["pair_100k_3pct_itm_short", "pair_25k_1pct_atm_micro"]) {
    for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
      assert.equal(
        isCellAllowedInRegimeDefault(broken, regime),
        false,
        `V5 proved ${broken} loss-making in ${regime} — must not be in default`
      );
    }
  }
});

test("isCellAllowedInRegimeDefault: pair_50k_2pct deprecated — NOT in any default regime (2026-06-01 prune)", () => {
  // Its V5 +$326..+$1,194 were SYNTHETIC-era; the ITM-guts structure was NOT
  // revalidated by the empirical sweep (which validated the ATM straddle). Per
  // "real validation > synthetic confidence" it is pruned. Re-enable via DB override.
  for (const regime of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(
      isCellAllowedInRegimeDefault("pair_50k_2pct", regime),
      false,
      `pair_50k_2pct deprecated — must NOT be in ${regime} default`
    );
  }
});

test("isCellAllowedInRegime (DB): respects empty calm default", async () => {
  const pool = await buildPool();
  const r = await isCellAllowedInRegime(pool, "pair_25k_5pct_otm_3d", "calm");
  assert.equal(r.allowed, false);
  assert.equal(r.suggestedCells.length, 0);
});

test("setCellOverride: operator can enable a cell in calm (override empty default)", async () => {
  const pool = await buildPool();
  const before = await isCellAllowedInRegime(pool, "pair_25k_5pct_otm_3d", "calm");
  assert.equal(before.allowed, false);
  await setCellOverride(pool, "calm", "pair_25k_5pct_otm_3d", true, "operator accepts expected loss", "operator");
  const after = await isCellAllowedInRegime(pool, "pair_25k_5pct_otm_3d", "calm");
  assert.equal(after.allowed, true);
});

test("setCellOverride: operator can disable a default-enabled cell in moderate", async () => {
  const pool = await buildPool();
  const before = await isCellAllowedInRegime(pool, "pair_25k_5pct_otm_3d", "moderate");
  assert.equal(before.allowed, true);
  await setCellOverride(pool, "moderate", "pair_25k_5pct_otm_3d", false, "temporarily disabled for investigation", "operator");
  const after = await isCellAllowedInRegime(pool, "pair_25k_5pct_otm_3d", "moderate");
  assert.equal(after.allowed, false);
});

test("getEffectiveAllowlist: merges defaults + overrides correctly", async () => {
  const pool = await buildPool();
  await setCellOverride(pool, "stress", "pair_25k_1pct_atm_micro", true, "ramp test", "op");
  await setCellOverride(pool, "stress", "pair_50k_5pct_otm", false, "temporary disable", "op");
  const eff = await getEffectiveAllowlist(pool, "stress");
  assert.ok(eff.includes("pair_25k_1pct_atm_micro"));
  assert.ok(!eff.includes("pair_50k_5pct_otm"));
});

test("getOverrides: returns all overrides, optionally filtered by regime", async () => {
  const pool = await buildPool();
  await setCellOverride(pool, "calm", "pair_25k_5pct_otm_3d", true, "test", "op");
  await setCellOverride(pool, "stress", "pair_25k_1pct_atm_micro", true, "ramp", "op");
  const all = await getOverrides(pool);
  assert.equal(all.length, 2);
  const calmOnly = await getOverrides(pool, "calm");
  assert.equal(calmOnly.length, 1);
  assert.equal(calmOnly[0].cellId, "pair_25k_5pct_otm_3d");
});
