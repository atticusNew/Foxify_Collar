/**
 * Phase 5 — regime→structure selector (mapping + env override). Pure logic;
 * NOT wired into live activation yet.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STRUCTURE_BY_REGIME, parseStructureOverrides, selectStructureForRegime, getFullStructureMap
} from "../src/singleSide/twoSided/structureSelector";

test("selector: CTO-framework defaults per regime", () => {
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.calm, "straddle_gamma_scalp");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.moderate, "straddle");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.elevated, "strangle");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.stress, "strangle");
});

test("selector: selectStructureForRegime returns default + rationale when no override", () => {
  const sel = selectStructureForRegime("calm", { envRaw: undefined });
  assert.equal(sel.structure, "straddle_gamma_scalp");
  assert.equal(sel.source, "default");
  assert.ok(sel.rationale.length > 0);
});

test("selector: env override wins and is validated", () => {
  const envRaw = JSON.stringify({ calm: "straddle", elevated: "straddle_gamma_scalp" });
  const calm = selectStructureForRegime("calm", { envRaw });
  assert.equal(calm.structure, "straddle");
  assert.equal(calm.source, "env_override");
  const elevated = selectStructureForRegime("elevated", { envRaw });
  assert.equal(elevated.structure, "straddle_gamma_scalp");
  assert.equal(elevated.source, "env_override");
  // regime not in override → default
  const moderate = selectStructureForRegime("moderate", { envRaw });
  assert.equal(moderate.structure, "straddle");
  assert.equal(moderate.source, "default");
});

test("selector: malformed / invalid env is ignored (falls back to defaults)", () => {
  assert.deepEqual(parseStructureOverrides("not json"), {});
  assert.deepEqual(parseStructureOverrides(undefined), {});
  // invalid structure value ignored
  assert.deepEqual(parseStructureOverrides(JSON.stringify({ calm: "iron_condor" })), {});
  // valid subset kept
  assert.deepEqual(parseStructureOverrides(JSON.stringify({ calm: "strangle", bogus: "x" })), { calm: "strangle" });
  const sel = selectStructureForRegime("calm", { envRaw: "not json" });
  assert.equal(sel.structure, "straddle_gamma_scalp");
  assert.equal(sel.source, "default");
});

test("selector: getFullStructureMap covers all four regimes", () => {
  const map = getFullStructureMap();
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.ok(map[r], `${r} present`);
    assert.equal(map[r].regime, r);
  }
});
