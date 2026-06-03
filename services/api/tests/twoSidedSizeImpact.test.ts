/**
 * Size-aware market-impact model — pure function unit tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sizeImpactFraction, sizeImpactMultiplier, getSizeImpactConfig } from "../src/singleSide/twoSided/sizeImpact";

const cfg = { enabled: true, freeBtc: 1.0, perBtc: 0.05, maxFraction: 0.20 };

test("sizeImpactFraction: zero up to free_btc, then linear, then capped", () => {
  assert.equal(sizeImpactFraction(0.14, cfg), 0, "small cell (0.14 BTC) → no impact");
  assert.equal(sizeImpactFraction(1.0, cfg), 0, "exactly free_btc → no impact");
  assert.ok(Math.abs(sizeImpactFraction(2.0, cfg) - 0.05) < 1e-9, "1 BTC over free → 5%");
  assert.ok(Math.abs(sizeImpactFraction(3.0, cfg) - 0.10) < 1e-9, "2 BTC over free → 10%");
  assert.equal(sizeImpactFraction(100, cfg), 0.20, "capped at max_fraction");
});

test("sizeImpactMultiplier: 1 minus the fraction", () => {
  assert.ok(Math.abs(sizeImpactMultiplier(3.0, cfg) - 0.90) < 1e-9);
  assert.equal(sizeImpactMultiplier(0.14, cfg), 1.0);
});

test("sizeImpactFraction: disabled → always 0", () => {
  assert.equal(sizeImpactFraction(5.0, { ...cfg, enabled: false }), 0);
});

test("getSizeImpactConfig: defaults + env override", () => {
  const d = getSizeImpactConfig({} as NodeJS.ProcessEnv);
  assert.equal(d.enabled, true);
  assert.equal(d.freeBtc, 1.0);
  assert.equal(d.perBtc, 0.05);
  assert.equal(d.maxFraction, 0.20);
  const o = getSizeImpactConfig({ SS_MTM_SIZE_IMPACT: "false", SS_MTM_SIZE_IMPACT_FREE_BTC: "0.5", SS_MTM_SIZE_IMPACT_PER_BTC: "0.08", SS_MTM_SIZE_IMPACT_MAX: "0.3" } as unknown as NodeJS.ProcessEnv);
  assert.equal(o.enabled, false);
  assert.equal(o.freeBtc, 0.5);
  assert.equal(o.perBtc, 0.08);
  assert.equal(o.maxFraction, 0.3);
});
