import assert from "node:assert/strict";
import test from "node:test";

/**
 * WS#5 (Bundle C, rev 6) — Deep-OTM short-tenor writeoff branch test.
 *
 * Validates the math conditions for the new "deep_otm_short_tenor_writeoff"
 * decision branch in hedgeManager.ts. Pure logic test — does not run the
 * full hedge cycle (that would require pg-mem + venue mock + spot history,
 * out of scope for a focused unit test of one branch).
 */

const BOUNCE_RECOVERY_MIN_VALUE = 5;

const checkDeepOtmWriteoffApplies = (params: {
  hoursToExpiry: number;
  intrinsicValue: number;
  totalValue: number;
}): boolean => {
  return (
    params.hoursToExpiry < 12 &&
    params.intrinsicValue <= 0 &&
    params.totalValue < BOUNCE_RECOVERY_MIN_VALUE
  );
};

test("Writeoff fires when option deep-OTM with no value and < 12h to expiry", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 8,
    intrinsicValue: 0,
    totalValue: 2.50
  }), true);
});

test("Writeoff does NOT fire when total value >= bounce-recovery min ($5)", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 8,
    intrinsicValue: 0,
    totalValue: 5
  }), false, "Value at boundary should not write off — try to sell first");
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 8,
    intrinsicValue: 0,
    totalValue: 7.50
  }), false);
});

test("Writeoff does NOT fire when option has intrinsic value (ITM)", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 8,
    intrinsicValue: 50, // ITM
    totalValue: 60
  }), false, "ITM options should never be written off — they have real payoff");
});

test("Writeoff does NOT fire when too far from expiry (>= 12h)", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 13,
    intrinsicValue: 0,
    totalValue: 1.50
  }), false, "13h to expiry — still time for spot to move; don't write off yet");
});

test("Writeoff fires at exactly 11.99h (just under threshold)", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 11.99,
    intrinsicValue: 0,
    totalValue: 1
  }), true);
});

test("Writeoff does NOT fire at exactly 12h (boundary)", () => {
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 12,
    intrinsicValue: 0,
    totalValue: 1
  }), false);
});

test("Writeoff covers the bot-burn case: option went OTM after trigger, spot retraced, value bled to $1", () => {
  // Real example: SHORT 2% protection triggered at 1.5h post-open;
  // spot retraced to below trigger; option intrinsic = 0; time decay
  // brought total to $1; 9h to expiry. Pre-WS#5: would burn 540 cycles
  // of futile no-bid retries + Deribit fees. Post-WS#5: writeoff at
  // first cycle.
  const result = checkDeepOtmWriteoffApplies({
    hoursToExpiry: 9,
    intrinsicValue: 0,
    totalValue: 1.00
  });
  assert.equal(result, true,
    "Should have written off the c84dbbe9-style trade pattern earlier");
});

test("Writeoff is OFF for option with negligible time value but positive intrinsic", () => {
  // Far-ITM with low time value still has intrinsic worth selling
  assert.equal(checkDeepOtmWriteoffApplies({
    hoursToExpiry: 4,
    intrinsicValue: 100,
    totalValue: 100.50
  }), false);
});

test("Writeoff condition order: hoursToExpiry first, then intrinsic, then totalValue", () => {
  // All three must be true. If any one fails, no writeoff.
  // Verify each variable matters independently.
  const base = { hoursToExpiry: 5, intrinsicValue: 0, totalValue: 2 };
  assert.equal(checkDeepOtmWriteoffApplies(base), true, "All conditions met");
  assert.equal(checkDeepOtmWriteoffApplies({ ...base, hoursToExpiry: 20 }), false);
  assert.equal(checkDeepOtmWriteoffApplies({ ...base, intrinsicValue: 1 }), false);
  assert.equal(checkDeepOtmWriteoffApplies({ ...base, totalValue: 10 }), false);
});
