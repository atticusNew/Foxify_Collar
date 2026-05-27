/**
 * Golden regression tests for the two-sided strangle MC.
 *
 * These tests pin the empirical-anchor + regime-markup + depth-aware slippage
 * model to known expected values. Any future engine edit that drifts these
 * numbers requires a deliberate golden-value update with reviewer sign-off.
 *
 * Coverage:
 *   - slippageHaircut boundary behavior
 *   - computeStrangleCostDetailed across the 3 reference strangles and 4 regimes
 *   - Slippage selection from anchors (worst-leg-wins)
 *   - Embedded default anchor presence and shape
 *
 * Tests are deterministic — no MC paths involved (those are validated via
 * the script's repeatable seed in runTwoSidedStrangleProof.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  slippageHaircut,
  slippageForStrangle,
  computeStrangleCostDetailed,
  EMBEDDED_DEFAULT_ANCHORS,
  REGIME_COST_MARKUP,
  STRANGLES,
  type Strangle
} from "../scripts/backtest/singleSide/runTwoSidedStrangleProof.js";

// Helpers
const findStrangle = (label: string): Strangle => {
  const s = STRANGLES.find((x) => x.label.startsWith(label));
  if (!s) throw new Error(`Strangle '${label}' not found`);
  return s;
};

// ─── slippageHaircut boundaries ───

test("slippageHaircut: contracts <= 0.5x depth → 0.92", () => {
  assert.equal(slippageHaircut(1.0, 3.0), 0.92); // 1/3 = 0.333
  assert.equal(slippageHaircut(0.5, 1.0), 0.92); // exactly 0.5
});

test("slippageHaircut: 0.5x < contracts <= 1.0x depth → 0.85", () => {
  assert.equal(slippageHaircut(1.4, 2.5), 0.85); // 1.4/2.5 = 0.56 → production case
  assert.equal(slippageHaircut(2.0, 2.0), 0.85); // exactly 1.0
});

test("slippageHaircut: 1.0x < contracts <= 1.5x depth → 0.75", () => {
  assert.equal(slippageHaircut(4.2, 3.0), 0.75); // 1.4 ratio
  assert.equal(slippageHaircut(3.0, 2.0), 0.75); // exactly 1.5
});

test("slippageHaircut: contracts > 1.5x depth → 0.65", () => {
  assert.equal(slippageHaircut(5.0, 2.0), 0.65);
});

test("slippageHaircut: missing/zero depth defaults to 0.85", () => {
  assert.equal(slippageHaircut(1.4, null), 0.85);
  assert.equal(slippageHaircut(1.4, 0), 0.85);
});

// ─── slippageForStrangle worst-leg-wins ───

test("slippageForStrangle: worst-leg-wins from anchor depths", () => {
  const itm = findStrangle("ITM guts");
  const r = slippageForStrangle(itm, EMBEDDED_DEFAULT_ANCHORS, 1.4);
  // put depth = 2.5 BTC, call depth = 3.1 BTC → put leg is the constraint
  // 1.4/2.5 = 0.56 → 0.85; 1.4/3.1 = 0.45 → 0.92; MIN = 0.85
  assert.equal(r.putDepth, 2.5);
  assert.equal(r.callDepth, 3.1);
  assert.equal(r.putSlip, 0.85);
  assert.equal(r.callSlip, 0.92);
  assert.equal(r.slip, 0.85);
});

// ─── Embedded anchors presence ───

test("EMBEDDED_DEFAULT_ANCHORS has production ITM guts strikes", () => {
  const putAnchor = EMBEDDED_DEFAULT_ANCHORS.anchors.find((a) => a.strike === 77_000 && a.optionType === "put");
  const callAnchor = EMBEDDED_DEFAULT_ANCHORS.anchors.find((a) => a.strike === 75_000 && a.optionType === "call");
  assert.ok(putAnchor, "put 77k anchor must exist");
  assert.ok(callAnchor, "call 75k anchor must exist");
  assert.equal(putAnchor!.venue, "bullish");
  assert.equal(callAnchor!.venue, "deribit");
  assert.equal(EMBEDDED_DEFAULT_ANCHORS.source, "embedded_default");
});

// ─── computeStrangleCostDetailed golden values ───

// Note: these golden values are at SPOT=75994 (the module-level default for embedded anchors).
// At runtime, SPOT may be overridden from live anchors. Direct tests bypass that override
// and exercise the cost function at its embedded baseline.

test("computeStrangleCostDetailed: ITM guts calm — golden range", () => {
  const itm = findStrangle("ITM guts");
  const cb = computeStrangleCostDetailed(itm, 0.358, "calm", EMBEDDED_DEFAULT_ANCHORS);
  // Calm cost from embedded anchors should be ~$3,150-$3,250 (within ±2% of $3,200 production point)
  assert.ok(cb.totalUsdc > 3_100 && cb.totalUsdc < 3_300, `ITM calm cost ${cb.totalUsdc} outside [3100, 3300]`);
  assert.equal(cb.regimeMarkup, 1.0);
  assert.equal(cb.putCalibSource.interpolated, false);
  assert.equal(cb.callCalibSource.interpolated, false);
});

test("computeStrangleCostDetailed: ITM guts stress — higher than calm by markup × σ scaling", () => {
  const itm = findStrangle("ITM guts");
  const calm = computeStrangleCostDetailed(itm, 0.358, "calm", EMBEDDED_DEFAULT_ANCHORS);
  const stress = computeStrangleCostDetailed(itm, 0.95, "stress", EMBEDDED_DEFAULT_ANCHORS);
  // Stress should be > calm by at least 2× (σ scaling alone is ~2.6×, plus 1.35× markup = ~3.5×)
  assert.ok(stress.totalUsdc > calm.totalUsdc * 2.0,
    `stress ${stress.totalUsdc} should be >2× calm ${calm.totalUsdc}`);
  assert.equal(stress.regimeMarkup, 1.35);
});

test("computeStrangleCostDetailed: OTM strangle uses interpolated calib (no direct anchor)", () => {
  const otm = findStrangle("OTM");
  const cb = computeStrangleCostDetailed(otm, 0.358, "calm", EMBEDDED_DEFAULT_ANCHORS);
  // OTM strikes ($74k put, $78k call) are not in embedded anchors → interpolated
  assert.equal(cb.putCalibSource.interpolated, true);
  assert.equal(cb.callCalibSource.interpolated, true);
  assert.equal(cb.putCalibSource.anchorStrike, 77_000); // closest put anchor
  assert.equal(cb.callCalibSource.anchorStrike, 75_000); // closest call anchor
});

test("REGIME_COST_MARKUP: monotone non-decreasing", () => {
  assert.equal(REGIME_COST_MARKUP.calm, 1.00);
  assert.ok(REGIME_COST_MARKUP.moderate > REGIME_COST_MARKUP.calm);
  assert.ok(REGIME_COST_MARKUP.elevated > REGIME_COST_MARKUP.moderate);
  assert.ok(REGIME_COST_MARKUP.stress > REGIME_COST_MARKUP.elevated);
});
