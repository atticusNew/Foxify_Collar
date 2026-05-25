import assert from "node:assert/strict";
import test from "node:test";

import {
  configureCircuitBreaker,
  getCircuitBreakerState,
  isCircuitBreakerActive,
  recordBalanceSample,
  resetCircuitBreaker,
  __getBalanceHistoryLengthForTests,
  __resetCircuitBreakerForTests
} from "../src/pilot/circuitBreaker.js";

// PR B (Gap 2) — max-loss circuit breaker regression tests.
//
// Coverage targets:
//   1. Trip behavior — fires when equity drops > maxLossPct from the
//      rolling-window peak.
//   2. Cold-start guard — minSamplesForTrip prevents false positives
//      on the first observed sample.
//   3. Cooldown — auto-reset after the configured cooldownMs window.
//   4. Manual reset — clears state immediately and clears history so
//      the breaker doesn't immediately re-trip against the pre-reset peak.
//   5. Enforce flag — when false, the breaker observes but never blocks
//      (isCircuitBreakerActive always returns false).
//   6. Rolling window — stale samples beyond windowMs are dropped from
//      the baseline computation.
//   7. Negative / zero / non-finite samples are rejected silently.

test("breaker trips when equity drops past maxLossPct", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 2, cooldownMs: 0 });

  // Pre-trip samples — establish a baseline of 1 BTC equity.
  recordBalanceSample(1.0, 1000);
  recordBalanceSample(0.95, 2000);
  assert.equal(getCircuitBreakerState().tripped, false, "still 5% drawdown, no trip");

  // 50% drawdown — should trip on this sample.
  recordBalanceSample(0.49, 3000);
  const state = getCircuitBreakerState();
  assert.equal(state.tripped, true, "51% drawdown trips breaker");
  assert.ok(state.tripped && state.lossPct >= 0.5, `lossPct=${state.tripped ? state.lossPct : "n/a"} >= 0.5`);
  assert.equal(isCircuitBreakerActive(), true);
});

test("cold-start guard: minSamplesForTrip prevents false positive", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 4, cooldownMs: 0 });

  // First sample is 1 BTC; second is 0.1 (90% drop) — but we need
  // 4 samples before the breaker is even allowed to trip.
  recordBalanceSample(1.0, 1000);
  recordBalanceSample(0.1, 2000);
  recordBalanceSample(0.1, 3000);
  assert.equal(getCircuitBreakerState().tripped, false, "fewer than minSamples → no trip");

  // 4th sample crosses the threshold AND we have enough samples.
  recordBalanceSample(0.1, 4000);
  assert.equal(getCircuitBreakerState().tripped, true, "now eligible to trip");
});

test("cooldown auto-resets the breaker after configured window", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 2, cooldownMs: 60_000 });

  recordBalanceSample(1.0, 1000);
  recordBalanceSample(0.4, 2000);
  assert.equal(getCircuitBreakerState().tripped, true, "tripped");

  // Sample within the cooldown window → still tripped.
  recordBalanceSample(0.5, 30_000);
  assert.equal(getCircuitBreakerState().tripped, true, "still tripped before cooldown expires");

  // Sample past the cooldown window → auto-reset.
  recordBalanceSample(0.6, 100_000);
  assert.equal(getCircuitBreakerState().tripped, false, "auto-reset after cooldown");
});

test("manual reset clears state and history", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 2, cooldownMs: 0 });

  recordBalanceSample(1.0, 1000);
  recordBalanceSample(0.4, 2000);
  assert.equal(getCircuitBreakerState().tripped, true);

  const wasTripped = resetCircuitBreaker("test_admin");
  assert.equal(wasTripped, true, "reset returns true when there was a trip");
  assert.equal(getCircuitBreakerState().tripped, false, "state cleared");
  assert.equal(__getBalanceHistoryLengthForTests(), 0, "history cleared so baseline restarts");

  // After reset, new samples build a fresh baseline; old peak no longer
  // counts. So a 0.4 sample now should NOT immediately re-trip the
  // breaker on its own (cold-start guard kicks in).
  recordBalanceSample(0.4, 5000);
  assert.equal(getCircuitBreakerState().tripped, false, "no immediate re-trip after manual reset");
});

test("manual reset on a non-tripped breaker is a no-op", () => {
  __resetCircuitBreakerForTests();
  const wasTripped = resetCircuitBreaker("test_admin");
  assert.equal(wasTripped, false, "reset returns false when nothing to clear");
});

test("enforce=false: observes and computes loss but never blocks", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 2, cooldownMs: 0, enforce: false });

  recordBalanceSample(1.0, 1000);
  recordBalanceSample(0.4, 2000);
  // The state can show tripped (informational), but isCircuitBreakerActive
  // returns false because enforcement is off.
  assert.equal(isCircuitBreakerActive(), false, "enforce=false → never active");
  // The internal state may still record a trip (so the operator can see
  // the would-have-fired signal in admin). Verify either way works:
  // tripped state, but isCircuitBreakerActive returns false.
});

test("rolling window: stale samples dropped from baseline", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({
    maxLossPct: 0.5,
    minSamplesForTrip: 2,
    cooldownMs: 0,
    windowMs: 10_000 // 10-second window for test
  });

  // Sample 1: 1.0 BTC at t=0
  recordBalanceSample(1.0, 0);
  // Sample 2: 0.95 BTC at t=5000 (still within window)
  recordBalanceSample(0.95, 5000);
  // Sample 3: 0.45 BTC at t=15000 — this is past 10s after sample 1,
  // so sample 1 (the 1.0 peak) is now stale and dropped.
  // Baseline becomes 0.95 (sample 2). Drawdown = (0.95 - 0.45)/0.95 = ~52%.
  recordBalanceSample(0.45, 15_000);
  const state = getCircuitBreakerState();
  // Even though a 1.0 → 0.45 is a 55% drop, the 1.0 sample is stale.
  // The 0.95 → 0.45 drop is ~52% — still trips.
  assert.equal(state.tripped, true, "still trips against the in-window baseline");
  assert.ok(state.tripped && state.baselineBtc < 1.0, "baseline reflects only in-window peak");
});

test("rejects negative / non-finite samples silently", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 1, cooldownMs: 0 });

  recordBalanceSample(-0.5, 1000);
  recordBalanceSample(NaN, 2000);
  recordBalanceSample(Infinity, 3000);
  assert.equal(__getBalanceHistoryLengthForTests(), 0, "no samples recorded");
  assert.equal(getCircuitBreakerState().tripped, false);
});

test("baseline uses peak in window, not first observation", () => {
  __resetCircuitBreakerForTests();
  configureCircuitBreaker({ maxLossPct: 0.5, minSamplesForTrip: 2, cooldownMs: 0 });

  // Equity rises and then falls — baseline must follow the peak.
  recordBalanceSample(1.0, 1000);
  recordBalanceSample(2.0, 2000); // peak
  recordBalanceSample(1.0, 3000); // 50% off peak — should trip
  assert.equal(getCircuitBreakerState().tripped, true, "drawdown measured from peak");
  const state = getCircuitBreakerState();
  if (state.tripped) {
    assert.equal(state.baselineBtc, 2.0, "baseline = window peak");
  }
});
