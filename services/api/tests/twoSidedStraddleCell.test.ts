/**
 * Moderate+ straddle cell (pair_50k_3pct_atm_3d) — the friction-aware sweep
 * winner, allowlisted for moderate/elevated/stress (NOT calm), gated by
 * SS_TWO_SIDED_LIVE_ENABLED=false. Verifies the cell + regime allowlist so
 * should_activate.recommended_cells returns it in moderate+ and never in calm.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PHASE_0_CELLS, getCellOrThrow, computeStrikes } from "../src/singleSide/twoSided/cellConfig";
import { DEFAULT_CELL_ALLOWLIST, isCellAllowedInRegimeDefault } from "../src/singleSide/twoSided/cellAllowlist";

const CELL = "pair_50k_3pct_atm_3d";

test("straddle cell: defined, enabled, ATM 3% 3d", () => {
  const c = PHASE_0_CELLS[CELL];
  assert.ok(c, "cell exists");
  assert.equal(c.enabled, true);
  assert.equal(c.triggerPctDown, 0.03);
  assert.equal(c.triggerPctUp, 0.03);
  assert.equal(c.hedgeTenorDays, 3);
  assert.equal(c.putStrikeItmPct, 0);
  assert.equal(c.callStrikeItmPct, 0);
  assert.doesNotThrow(() => getCellOrThrow(CELL));
});

test("straddle cell: ATM strikes straddle the spot (within one grid step)", () => {
  const { putStrike, callStrike } = computeStrikes(PHASE_0_CELLS[CELL], 74085);
  assert.ok(Math.abs(putStrike - callStrike) <= 1000, "ATM: strikes within one $1k grid step");
});

test("computeStrikes: true ATM (0% ITM) snaps BOTH legs to the SAME nearest strike (matches sweep winner)", () => {
  // Reproduces the cell-sweep snapStrike (round) so the live cell == validated single-strike straddle.
  for (const cellId of [CELL, "pair_150k_3pct_atm_3d"]) {
    const { putStrike, callStrike } = computeStrikes(PHASE_0_CELLS[cellId], 73451);
    assert.equal(putStrike, callStrike, `${cellId}: single-strike straddle (put==call)`);
    assert.equal(putStrike, 73000, `${cellId}: round(73451/1000)*1000`);
  }
  // and snaps UP correctly past the midpoint
  const hi = computeStrikes(PHASE_0_CELLS[CELL], 73600);
  assert.equal(hi.putStrike, 74000);
  assert.equal(hi.callStrike, 74000);
});

test("pair_5k_atm_1d_smoke: tiny near-ATM Bullish smoke cell (5k, ATM, 1d, single-strike)", () => {
  const cell = PHASE_0_CELLS["pair_5k_atm_1d_smoke"];
  assert.ok(cell, "smoke cell exists in registry");
  assert.equal(cell.enabled, true);
  assert.equal(cell.notionalUsdcPerLeg, 5_000, "tiny notional → ~$100 premium");
  assert.equal(cell.hedgeTenorDays, 1);
  assert.equal(cell.putStrikeItmPct, 0, "ATM put (near-ATM so Bullish quotes it)");
  assert.equal(cell.callStrikeItmPct, 0, "ATM call");
  // ATM → both legs snap to the SAME single nearest-$1k strike (where Bullish quotes).
  const s = computeStrikes(cell, 70_934);
  assert.equal(s.putStrike, 71_000);
  assert.equal(s.callStrike, 71_000);
  assert.equal(s.putStrike, s.callStrike, "single ATM strike");
  // It is NOT in any default allowlist (operator allowlists it only for the smoke test).
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.equal(isCellAllowedInRegimeDefault("pair_5k_atm_1d_smoke", r), false, `not in ${r} default`);
  }
});

test("computeStrikes: guts cell (non-zero ITM) keeps the ceil/floor two-strike split", () => {
  // pair_50k_2pct: putItm/callItm 0.013 → ceil(76988)→77000 put, floor(75012)→75000 call.
  const guts = computeStrikes(PHASE_0_CELLS["pair_50k_2pct"], 76000);
  assert.equal(guts.putStrike, 77000);
  assert.equal(guts.callStrike, 75000);
  assert.notEqual(guts.putStrike, guts.callStrike, "guts geometry unchanged (two strikes)");
});

test("allowlist: straddle cell enabled in moderate/elevated/stress, NOT calm", () => {
  assert.equal(isCellAllowedInRegimeDefault(CELL, "calm"), false, "never in calm (stand-down)");
  for (const r of ["moderate", "elevated", "stress"] as const) {
    assert.equal(isCellAllowedInRegimeDefault(CELL, r), true, `allowed in ${r}`);
  }
  // calm holds only the budgeted loss-leader cells now (still hard-gated); the
  // profit-seeking straddle is never calm-allowed.
  assert.deepEqual(
    [...DEFAULT_CELL_ALLOWLIST.calm].sort(),
    ["pair_25k_5otm_strangle_1d", "pair_25k_5otm_strangle_2d"],
    "calm allowlist = loss-leader cells only"
  );
  assert.ok(!DEFAULT_CELL_ALLOWLIST.calm.includes(CELL), "straddle cell not in calm");
});
