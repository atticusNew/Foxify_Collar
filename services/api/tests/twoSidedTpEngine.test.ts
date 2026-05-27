/**
 * PR 4 tests — theta-aware TP engine + option value lookup.
 *
 * Pure functions, no I/O. Covers all decision branches:
 *   - wait when no condition triggers
 *   - foxify_close decision (early-close override)
 *   - force_expiry when currentMs >= tpForceExitAtMs
 *   - capture_window_peak snap at 30 min boundary
 *   - trail_retrace after capture window (current < peak × 0.85)
 *   - hard_floor after capture window (current < hedge × 0.10)
 *   - slippage applied to projectedSalvage
 *   - msInCaptureWindow / msToForceExit reported correctly
 *
 * Plus optionValueLookup smoke test.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  tpEvaluate,
  CAPTURE_WINDOW_MS,
  TRAIL_RETRACE_FACTOR,
  HARD_FLOOR_FRACTION
} from "../src/singleSide/twoSided/tpEngine";
import { computeCombinedOptionValue } from "../src/singleSide/twoSided/optionValueLookup";

const HEDGE_COST = 3_200;
const TRIGGERED_AT = 1_000_000;
const FORCE_EXIT = TRIGGERED_AT + 3 * 86_400_000 - 4 * 3_600_000; // 3d - 4h

const baseInput = (overrides: Partial<Parameters<typeof tpEvaluate>[0]> = {}) => ({
  hedgeCostUsdc: HEDGE_COST,
  triggeredAtMs: TRIGGERED_AT,
  tpForceExitAtMs: FORCE_EXIT,
  currentMs: TRIGGERED_AT + 5 * 60_000, // 5 min after trigger
  currentValueUsdc: 4_000,
  peakValueSinceTriggerUsdc: 4_200,
  slippageHaircut: 0.85,
  ...overrides
});

test("tpEvaluate: wait when nothing fires (early in capture window)", () => {
  const d = tpEvaluate(baseInput());
  assert.equal(d.action, "wait");
  assert.equal(d.reason, null);
  assert.equal(Math.round(d.projectedSalvageUsdc), Math.round(4_000 * 0.85));
});

test("tpEvaluate: foxify_close override sells at current * slip", () => {
  const d = tpEvaluate(baseInput({ foxifyForceClose: true }));
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "foxify_close");
  assert.equal(d.projectedSalvageUsdc, 4_000 * 0.85);
});

test("tpEvaluate: force_expiry when currentMs >= tpForceExitAtMs", () => {
  const d = tpEvaluate(baseInput({ currentMs: FORCE_EXIT + 100 }));
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "force_expiry");
});

test("tpEvaluate: capture_window_peak snaps to peak * slip at 30min boundary", () => {
  const d = tpEvaluate(baseInput({
    currentMs: TRIGGERED_AT + CAPTURE_WINDOW_MS + 10_000, // 10s past 30min
    peakValueSinceTriggerUsdc: 5_500
  }));
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "capture_window_peak");
  assert.equal(d.projectedSalvageUsdc, 5_500 * 0.85);
});

test("tpEvaluate: trail_retrace after capture window", () => {
  const peak = 5_000;
  const current = peak * 0.80; // below 85% retrace
  const d = tpEvaluate(baseInput({
    currentMs: TRIGGERED_AT + CAPTURE_WINDOW_MS + 5 * 60_000, // 5 min past window
    currentValueUsdc: current,
    peakValueSinceTriggerUsdc: peak
  }));
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "trail_retrace");
  assert.equal(d.projectedSalvageUsdc, current * 0.85);
});

test("tpEvaluate: hard_floor after capture window (collapse to <10% of hedge cost)", () => {
  const current = HEDGE_COST * 0.05; // 5%, below 10% floor
  const d = tpEvaluate(baseInput({
    currentMs: TRIGGERED_AT + CAPTURE_WINDOW_MS + 10 * 60_000,
    currentValueUsdc: current,
    peakValueSinceTriggerUsdc: 500
  }));
  // Hard floor checked after trail_retrace branch — trail_retrace fires first
  // because current (160) < peak (500) × 0.85 = 425. trail_retrace fires.
  assert.equal(d.action, "sell");
  assert.ok(d.reason === "trail_retrace" || d.reason === "hard_floor");
});

test("tpEvaluate: hard_floor fires when peak is small enough that trail doesn't fire", () => {
  const peak = 200;       // trail threshold = 170
  const current = 250;    // above trail threshold (no trail fire) but high vs peak — but peak < current means peak gets bumped in caller
  // Realistic scenario: peak is below current (caller hasn't updated peak yet) AND current < 10% of hedge
  // To isolate hard_floor: peak = current (no trail trigger) AND current < hedge * 0.10
  const d = tpEvaluate(baseInput({
    currentMs: TRIGGERED_AT + CAPTURE_WINDOW_MS + 10 * 60_000,
    currentValueUsdc: HEDGE_COST * 0.05, // 5% of hedge
    peakValueSinceTriggerUsdc: HEDGE_COST * 0.05 // same — no trail
  }));
  assert.equal(d.action, "sell");
  assert.equal(d.reason, "hard_floor");
});

test("tpEvaluate: within capture window, current well below peak doesn't trail-retrace yet", () => {
  // Trail retrace only applies AFTER capture window.
  const d = tpEvaluate(baseInput({
    currentMs: TRIGGERED_AT + 10 * 60_000, // 10 min in (within 30 min window)
    currentValueUsdc: 2_000,
    peakValueSinceTriggerUsdc: 10_000      // huge peak
  }));
  // Inside capture window → wait
  assert.equal(d.action, "wait");
});

test("tpEvaluate: foxify_close beats force_expiry semantically", () => {
  // Even past expiry, foxify_close is correctly labeled
  const d = tpEvaluate(baseInput({
    foxifyForceClose: true,
    currentMs: FORCE_EXIT + 1_000_000
  }));
  assert.equal(d.reason, "foxify_close");
});

test("tpEvaluate: msInCaptureWindow + msToForceExit reported correctly", () => {
  const d = tpEvaluate(baseInput({ currentMs: TRIGGERED_AT + 20 * 60_000 }));
  assert.equal(d.msInCaptureWindow, CAPTURE_WINDOW_MS - 20 * 60_000);
  assert.equal(d.msToForceExit, FORCE_EXIT - (TRIGGERED_AT + 20 * 60_000));
});

// ─── computeCombinedOptionValue smoke test ───

test("computeCombinedOptionValue: ITM guts at-trigger value > intrinsic floor", () => {
  // Spot at down trigger: 76000 × 0.98 = 74480
  // Put strike 77000, call strike 75000, 1.4 BTC each
  // Intrinsic at down trigger:
  //   put: max(0, 77000 - 74480) = 2520 per BTC × 1.4 = 3528
  //   call: max(0, 74480 - 75000) = 0
  // Combined intrinsic = 3528. With time value + calibration we expect total > 3528.
  const result = computeCombinedOptionValue({
    spot: 74_480,
    putStrike: 77_000,
    callStrike: 75_000,
    contractsBtc: 1.4,
    msToExpiry: 2 * 86_400_000, // 2d remaining
    sigmaAnnual: 0.36,
    riskFreeRate: 0.045,
    putCalibrationMultiplier: 1.0,
    callCalibrationMultiplier: 1.0
  });
  assert.ok(result.totalUsdc > 3_528, `total ${result.totalUsdc} should exceed intrinsic 3528`);
  assert.ok(result.putValueUsdc > 0);
});

test("TP curve constants are within expected ranges", () => {
  assert.equal(CAPTURE_WINDOW_MS, 30 * 60_000);
  assert.equal(TRAIL_RETRACE_FACTOR, 0.85);
  assert.equal(HARD_FLOOR_FRACTION, 0.10);
});
