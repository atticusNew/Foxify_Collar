/**
 * Single-knob split override: SS_ATTICUS_SPLIT_PCT / SS_ATTICUS_FLOOR_USDC
 * override the volume-based TIERS split for LIVE activation + settlement, so
 * live and sim/sweep economics share one control. Env is set/cleared per test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applySplitOverride, getTierByLabel } from "../src/singleSide/twoSided/tierResolver";
import { TIERS } from "../src/singleSide/twoSided/types";

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
};

test("override: no env → raw tier table unchanged", () => {
  withEnv({ SS_ATTICUS_SPLIT_PCT: undefined, SS_ATTICUS_FLOOR_USDC: undefined }, () => {
    const t1 = applySplitOverride(TIERS[0]);
    assert.equal(t1.foxifyPct, 0.85);
    assert.equal(t1.atticusPct, 0.15);
    assert.equal(t1.atticusFloorUsdc, 25);
  });
});

test("override: SS_ATTICUS_SPLIT_PCT collapses all tiers to one knob (Foxify keep)", () => {
  withEnv({ SS_ATTICUS_SPLIT_PCT: "0.90" }, () => {
    for (const t of TIERS) {
      const o = applySplitOverride(t);
      assert.equal(o.foxifyPct, 0.90, `${t.label} foxify keep -> 0.90`);
      assert.ok(Math.abs(o.atticusPct - 0.10) < 1e-9, `${t.label} atticus -> 0.10`);
    }
    // getTierByLabel applies it too (tier_3 table foxify is 0.89 → overridden)
    assert.equal(getTierByLabel("tier_3").foxifyPct, 0.90);
  });
});

test("override: SS_ATTICUS_FLOOR_USDC overrides per-pair floor", () => {
  withEnv({ SS_ATTICUS_FLOOR_USDC: "50" }, () => {
    assert.equal(applySplitOverride(TIERS[0]).atticusFloorUsdc, 50);
    assert.equal(getTierByLabel("tier_2").atticusFloorUsdc, 50);
  });
});

test("override: invalid env values are ignored (fall back to table)", () => {
  withEnv({ SS_ATTICUS_SPLIT_PCT: "1.5", SS_ATTICUS_FLOOR_USDC: "-3" }, () => {
    const o = applySplitOverride(TIERS[0]);
    assert.equal(o.foxifyPct, 0.85, "out-of-range split ignored");
    assert.equal(o.atticusFloorUsdc, 25, "negative floor ignored");
  });
  withEnv({ SS_ATTICUS_SPLIT_PCT: "abc" }, () => {
    assert.equal(applySplitOverride(TIERS[0]).foxifyPct, 0.85, "non-numeric ignored");
  });
});
