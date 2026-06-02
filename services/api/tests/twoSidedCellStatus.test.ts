/**
 * Tests — CELL_STATUS classification (Phase-A clarity: what's production vs not).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PHASE_0_CELLS, CELL_STATUS, PRODUCTION_CELLS, cellStatus } from "../src/singleSide/twoSided/cellConfig";

test("CELL_STATUS classifies every registry cell (no orphans)", () => {
  for (const id of Object.keys(PHASE_0_CELLS)) {
    assert.ok(CELL_STATUS[id], `cell ${id} must be classified in CELL_STATUS`);
  }
});

test("PRODUCTION_CELLS = the validated set (ATM straddles + Bullish 2d + calm loss-leaders)", () => {
  assert.deepEqual(
    [...PRODUCTION_CELLS].sort(),
    [
      "pair_10k_atm_2d",
      "pair_150k_3pct_atm_3d",
      "pair_25k_5otm_strangle_1d",
      "pair_25k_5otm_strangle_2d",
      "pair_50k_3pct_atm_3d"
    ].sort()
  );
});

test("deprecated/test/disabled cells are NOT classified production", () => {
  for (const id of ["pair_50k_2pct", "pair_100k_3pct_itm_short", "pair_50k_3pct_atm", "pair_5k_atm_1d_smoke", "pair_25k_5pct_otm_short", "pair_25k_1pct_atm_micro"]) {
    assert.notEqual(cellStatus(id), "production", `${id} must not be production`);
  }
});

test("cellStatus defaults to deprecated for unknown cells (fail-safe)", () => {
  assert.equal(cellStatus("pair_does_not_exist"), "deprecated");
});
