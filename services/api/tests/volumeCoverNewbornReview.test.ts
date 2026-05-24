/**
 * 2026-05-24 (PR-D): newborn-trigger review tests.
 *
 * Validates:
 *   - default OFF (back-compat with legacy deploys)
 *   - opt-in via VC_NEWBORN_TRIGGER_REVIEW=true triggers auto-halt for
 *     the first N triggers (N = VC_NEWBORN_REVIEW_BUDGET, default 3)
 *   - graduates after the budget — no more auto-halts on subsequent
 *     triggers
 *   - manual-halt clear via setManualHalt({halted:false}) does NOT
 *     decrement the counter (which would re-arm the auto-halt)
 *   - getNewbornReviewState surfaces correct state for /health
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  recordTriggerForReview,
  getNewbornReviewState,
  __resetNewbornReviewForTests
} from "../src/volumeCover/volumeCoverNewbornReview";
import {
  setManualHalt,
  getManualHalt,
  __resetVolumeCoverGuardrailsForTests
} from "../src/volumeCover/volumeCoverGuardrails";

const NEWBORN_ENV_KEYS = [
  "VC_NEWBORN_TRIGGER_REVIEW",
  "VC_NEWBORN_REVIEW_BUDGET"
];

const reset = (): void => {
  for (const k of NEWBORN_ENV_KEYS) delete process.env[k];
  __resetNewbornReviewForTests();
  __resetVolumeCoverGuardrailsForTests();
};

test("PR-D newborn: default OFF — recordTriggerForReview does NOT halt", () => {
  reset();
  const state1 = recordTriggerForReview({ positionId: "pos-1" });
  assert.equal(state1.enabled, false);
  assert.equal(state1.lastTriggerAutoHalted, false);
  assert.equal(state1.triggersSoFar, 1);
  assert.equal(getManualHalt().halted, false);
});

test("PR-D newborn: enabled with budget=3 halts on triggers 1, 2, 3", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  process.env.VC_NEWBORN_REVIEW_BUDGET = "3";
  try {
    for (let i = 1; i <= 3; i++) {
      // Operator clears between triggers (simulates manual review)
      setManualHalt({ halted: false });
      const state = recordTriggerForReview({ positionId: `pos-${i}` });
      assert.equal(state.enabled, true);
      assert.equal(state.budget, 3);
      assert.equal(state.triggersSoFar, i);
      assert.equal(state.lastTriggerAutoHalted, true, `trigger ${i} should auto-halt`);
      assert.equal(state.graduated, false, `not graduated after trigger ${i}/${3}`);
      const halt = getManualHalt();
      assert.equal(halt.halted, true, `halted after trigger ${i}`);
      assert.match(halt.reason ?? "", /newborn_trigger_review:\d+\/3/);
      assert.match(halt.reason ?? "", new RegExp(`positionId=pos-${i}`));
    }
  } finally {
    reset();
  }
});

test("PR-D newborn: graduates after budget — trigger 4 does NOT auto-halt", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  process.env.VC_NEWBORN_REVIEW_BUDGET = "3";
  try {
    for (let i = 1; i <= 3; i++) {
      setManualHalt({ halted: false });
      recordTriggerForReview({ positionId: `pos-${i}` });
    }
    setManualHalt({ halted: false });
    const state4 = recordTriggerForReview({ positionId: "pos-4" });
    assert.equal(state4.triggersSoFar, 4);
    assert.equal(state4.graduated, true);
    assert.equal(state4.lastTriggerAutoHalted, false, "graduated → no auto-halt");
    assert.equal(getManualHalt().halted, false, "halt state preserved (no auto-halt)");

    // 5th trigger also graduated
    const state5 = recordTriggerForReview({ positionId: "pos-5" });
    assert.equal(state5.lastTriggerAutoHalted, false);
    assert.equal(getManualHalt().halted, false);
  } finally {
    reset();
  }
});

test("PR-D newborn: budget=0 effectively disables auto-halt (graduated immediately)", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  process.env.VC_NEWBORN_REVIEW_BUDGET = "0";
  try {
    const state = recordTriggerForReview({ positionId: "pos-1" });
    assert.equal(state.budget, 0);
    assert.equal(state.lastTriggerAutoHalted, false);
    assert.equal(getManualHalt().halted, false);
  } finally {
    reset();
  }
});

test("PR-D newborn: budget=1 halts only on first trigger", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  process.env.VC_NEWBORN_REVIEW_BUDGET = "1";
  try {
    setManualHalt({ halted: false });
    const s1 = recordTriggerForReview({ positionId: "pos-1" });
    assert.equal(s1.lastTriggerAutoHalted, true);
    assert.equal(getManualHalt().halted, true);

    setManualHalt({ halted: false });
    const s2 = recordTriggerForReview({ positionId: "pos-2" });
    assert.equal(s2.lastTriggerAutoHalted, false);
    assert.equal(getManualHalt().halted, false);
  } finally {
    reset();
  }
});

test("PR-D newborn: invalid env values fall back to default budget=3", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  for (const bad of ["abc", "-2", "3.7", ""]) {
    process.env.VC_NEWBORN_REVIEW_BUDGET = bad;
    const state = getNewbornReviewState();
    assert.equal(
      state.budget,
      3,
      `invalid budget "${bad}" should fall back to 3`
    );
  }
  reset();
});

test("PR-D newborn: getNewbornReviewState reports state without side effects", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "true";
  process.env.VC_NEWBORN_REVIEW_BUDGET = "5";
  try {
    const before = getNewbornReviewState();
    assert.equal(before.enabled, true);
    assert.equal(before.budget, 5);
    assert.equal(before.triggersSoFar, 0);
    assert.equal(before.graduated, false);
    assert.equal(before.lastTriggerAutoHalted, false);
    assert.equal(getManualHalt().halted, false, "read-only — no halt");
  } finally {
    reset();
  }
});

test("PR-D newborn: env value 'TRUE' (uppercase) and 'True' work; non-true values default to OFF", () => {
  reset();
  process.env.VC_NEWBORN_TRIGGER_REVIEW = "TRUE";
  assert.equal(getNewbornReviewState().enabled, true);

  process.env.VC_NEWBORN_TRIGGER_REVIEW = "True";
  assert.equal(getNewbornReviewState().enabled, true);

  process.env.VC_NEWBORN_TRIGGER_REVIEW = "yes";
  assert.equal(getNewbornReviewState().enabled, false, "only literal 'true' enables");

  process.env.VC_NEWBORN_TRIGGER_REVIEW = "1";
  assert.equal(getNewbornReviewState().enabled, false, "numeric 1 does NOT enable");

  reset();
});
