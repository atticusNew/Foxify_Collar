/**
 * mathUtils — invNormCdf + driftAnnualFromWinRate (the directional-edge mapping).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { invNormCdf, driftAnnualFromWinRate } from "../src/singleSide/twoSided/mathUtils";

test("invNormCdf: known quantiles", () => {
  assert.ok(Math.abs(invNormCdf(0.5)) < 1e-6, "median = 0");
  assert.ok(Math.abs(invNormCdf(0.975) - 1.959964) < 1e-3, "0.975 ≈ 1.96");
  assert.ok(Math.abs(invNormCdf(0.025) + 1.959964) < 1e-3, "0.025 ≈ -1.96");
  assert.ok(invNormCdf(0.625) > 0.31 && invNormCdf(0.625) < 0.33, "0.625 ≈ 0.319");
});

test("driftAnnualFromWinRate: 0.5 → 0; higher win-rate → larger positive drift", () => {
  assert.equal(driftAnnualFromWinRate(0.5, 0.43, 2), 0, "no edge → no drift");
  assert.equal(driftAnnualFromWinRate(0.4, 0.43, 2), 0, "≤0.5 → 0");
  const d60 = driftAnnualFromWinRate(0.60, 0.43, 2);
  const d65 = driftAnnualFromWinRate(0.65, 0.43, 2);
  assert.ok(d60 > 0, "60% edge → positive drift");
  assert.ok(d65 > d60, "65% edge → larger drift than 60%");
});
