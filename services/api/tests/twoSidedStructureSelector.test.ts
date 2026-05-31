/**
 * Phase 5 — regime→structure selector (data-driven mapping + env override).
 * calm = stand_down (no options structure covers friction); moderate+ = straddle.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STRUCTURE_BY_REGIME, parseStructureOverrides, selectStructureForRegime, getFullStructureMap
} from "../src/singleSide/twoSided/structureSelector";

test("selector: data-driven defaults (calm stand_down, moderate+ straddle)", () => {
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.calm, "stand_down");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.moderate, "straddle");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.elevated, "straddle");
  assert.equal(DEFAULT_STRUCTURE_BY_REGIME.stress, "straddle");
});

test("selector: calm is stand_down + not tradeable; moderate is tradeable straddle", () => {
  const calm = selectStructureForRegime("calm", { envRaw: undefined });
  assert.equal(calm.structure, "stand_down");
  assert.equal(calm.tradeable, false);
  assert.equal(calm.source, "default");
  const mod = selectStructureForRegime("moderate", { envRaw: undefined });
  assert.equal(mod.structure, "straddle");
  assert.equal(mod.tradeable, true);
  assert.ok(mod.rationale.length > 0);
});

test("selector: env override wins and is validated (incl. stand_down)", () => {
  const envRaw = JSON.stringify({ moderate: "stand_down", calm: "straddle" });
  const mod = selectStructureForRegime("moderate", { envRaw });
  assert.equal(mod.structure, "stand_down");
  assert.equal(mod.tradeable, false);
  assert.equal(mod.source, "env_override");
  const calm = selectStructureForRegime("calm", { envRaw });
  assert.equal(calm.structure, "straddle");
  assert.equal(calm.tradeable, true);
  assert.equal(calm.source, "env_override");
});

test("selector: malformed / invalid env ignored (falls back to defaults)", () => {
  assert.deepEqual(parseStructureOverrides("not json"), {});
  assert.deepEqual(parseStructureOverrides(JSON.stringify({ calm: "iron_condor" })), {});
  assert.deepEqual(parseStructureOverrides(JSON.stringify({ calm: "stand_down", bogus: "x" })), { calm: "stand_down" });
  const sel = selectStructureForRegime("calm", { envRaw: "not json" });
  assert.equal(sel.structure, "stand_down");
  assert.equal(sel.source, "default");
});

test("selector: getFullStructureMap covers all four regimes", () => {
  const map = getFullStructureMap();
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    assert.ok(map[r]);
    assert.equal(map[r].regime, r);
  }
});
