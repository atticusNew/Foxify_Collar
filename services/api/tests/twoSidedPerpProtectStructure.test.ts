/**
 * Perp Protect position-aware structure — intents by leverage, sane strikes for all position types.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  selectIntents, generateStrikeCandidates, spreadTargets, strikeAtMove,
  DEFAULT_STRUCTURE_CONFIG, structureConfigFromEnv
} from "../src/singleSide/twoSided/perpProtectStructure";

test("1× (unleveraged): only drawdown_floor; strikes are sensible near-the-money floors", () => {
  const pos = { spot: 60000, side: "long" as const, leverage: 1 };
  assert.deepEqual(selectIntents(pos), ["drawdown_floor"]);
  const cands = generateStrikeCandidates(pos);
  // No absurd 50%-down "balanced" tier: every candidate is a modest drawdown floor.
  assert.ok(cands.length >= 1);
  assert.deepEqual(cands.map((c) => c.intent), cands.map(() => "drawdown_floor"));
  assert.deepEqual(cands.map((c) => c.targetStrike), [57000, 54000, 48000]); // −5/−10/−20%
});

test("leveraged (20×): all three intents present", () => {
  const pos = { spot: 60000, side: "long" as const, leverage: 20 };
  const intents = selectIntents(pos);
  assert.ok(intents.includes("drawdown_floor"));
  assert.ok(intents.includes("liquidation_insurance"));
  assert.ok(intents.includes("margin_loss_cap"));
});

test("liquidation_insurance strike sits INSIDE the liquidation price (long)", () => {
  const pos = { spot: 60000, side: "long" as const, leverage: 20 };
  const cands = generateStrikeCandidates(pos);
  const liqIns = cands.find((c) => c.intent === "liquidation_insurance");
  assert.ok(liqIns);
  const liqPrice = 60000 * (1 - 1 / 20); // 57000
  // Strike above the liq price (closer to spot) → ITM before liquidation.
  assert.ok(liqIns!.targetStrike > liqPrice, `${liqIns!.targetStrike} should be > ${liqPrice}`);
});

test("short side mirrors: candidates are ABOVE spot (calls)", () => {
  const pos = { spot: 60000, side: "short" as const, leverage: 10 };
  const cands = generateStrikeCandidates(pos);
  assert.ok(cands.every((c) => c.targetStrike > 60000));
});

test("candidates are de-duped by strike and capped at maxCandidates", () => {
  const pos = { spot: 60000, side: "long" as const, leverage: 8 };
  const cands = generateStrikeCandidates(pos, { ...DEFAULT_STRUCTURE_CONFIG, maxCandidates: 4 });
  assert.ok(cands.length <= 4);
  const strikes = cands.map((c) => Math.round(c.targetStrike));
  assert.equal(new Set(strikes).size, strikes.length); // all distinct
  // Sorted closest-to-spot first → priorities ascending, strikes descending for a long.
  assert.deepEqual(cands.map((c) => c.priority), cands.map((_, i) => i));
});

test("spreadTargets: short leg is strictly deeper than the long leg", () => {
  const posL = { spot: 60000, side: "long" as const, leverage: 20 };
  const sl = spreadTargets(posL, 0.04);
  assert.ok(sl.shortStrike < sl.longStrike); // deeper = lower strike for a long put
  const posS = { spot: 60000, side: "short" as const, leverage: 20 };
  const ss = spreadTargets(posS, 0.04);
  assert.ok(ss.shortStrike > ss.longStrike); // deeper = higher strike for a short call
});

test("strikeAtMove direction is side-aware", () => {
  assert.equal(strikeAtMove(60000, "long", 0.1), 54000);
  assert.equal(strikeAtMove(60000, "short", 0.1), 66000);
});

test("structureConfigFromEnv parses overrides and falls back on bad input", () => {
  const cfg = structureConfigFromEnv({ PERP_PROTECT_DRAWDOWN_LADDER: "0.03,0.07", PERP_PROTECT_MAX_CANDIDATES: "9", PERP_PROTECT_MIN_LEV_LIQ_INTENTS: "oops" } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.drawdownLadder, [0.03, 0.07]);
  assert.equal(cfg.maxCandidates, 9);
  assert.equal(cfg.minLeverageForLiqIntents, DEFAULT_STRUCTURE_CONFIG.minLeverageForLiqIntents); // bad → default
});
