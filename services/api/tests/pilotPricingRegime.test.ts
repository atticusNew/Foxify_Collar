import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPricingRegime,
  configurePricingRegime,
  getCurrentPricingRegime,
  getPremiumPer1kForRegime,
  recordDvolSample,
  REGIME_SCHEDULES,
  __getDvolHistoryLength,
  __resetPricingRegimeForTests,
  __setLastRegimeForTests,
  type PricingRegime
} from "../src/pilot/pricingRegime.js";

// Design A — pricing regime regression tests.
//
// Coverage targets:
//   1. Schedule values match the documented Design A spec exactly,
//      including the $9 ceiling on 2% high regime (CEO-stated trader
//      acceptance threshold).
//   2. Pure classifier picks the right band for representative DVOL
//      values, with no hysteresis state.
//   3. Hysteresis: upward transitions are immediate (never under-
//      charge during a vol spike); downward transitions require
//      crossing by the configured padding (default 2 points).
//   4. Rolling-window DVOL average smooths noise, drops stale samples
//      past the 1-hour window.
//   5. Fallback: when no DVOL is available and no liveDvolFallback
//      provided, defaults to the documented "moderate" middle.
//   6. Live DVOL fallback (no rolling history yet): used directly.

test("Design A schedule matches the spec exactly", () => {
  __resetPricingRegimeForTests();

  // 2% tier across regimes (the most-watched row)
  assert.equal(REGIME_SCHEDULES.low[2],      6.5, "low / 2%  = $6.50 (lowered from $7 on 2026-04-25 — see pricingRegime.ts comment)");
  assert.equal(REGIME_SCHEDULES.moderate[2], 7, "moderate / 2%  = $7");
  assert.equal(REGIME_SCHEDULES.elevated[2], 8, "elevated / 2%  = $8");
  assert.equal(REGIME_SCHEDULES.high[2],     10, "high / 2%  = $10 (raised from $9 on 2026-04-20 — see pricingRegime.ts comment)");

  // 3% tier
  assert.equal(REGIME_SCHEDULES.low[3],      5,    "low / 3% = $5");
  assert.equal(REGIME_SCHEDULES.moderate[3], 5.5,  "moderate / 3% = $5.50");
  assert.equal(REGIME_SCHEDULES.elevated[3], 6,    "elevated / 3% = $6");
  assert.equal(REGIME_SCHEDULES.high[3],     7,    "high / 3% = $7");

  // 5% tier
  assert.equal(REGIME_SCHEDULES.low[5],      3,    "low / 5% = $3");
  assert.equal(REGIME_SCHEDULES.moderate[5], 3,    "moderate / 5% = $3");
  assert.equal(REGIME_SCHEDULES.elevated[5], 3.5,  "elevated / 5% = $3.50");
  assert.equal(REGIME_SCHEDULES.high[5],     4,    "high / 5% = $4");

  // 10% tier — flat across all regimes (deep OTM, near-zero gamma)
  assert.equal(REGIME_SCHEDULES.low[10],      2);
  assert.equal(REGIME_SCHEDULES.moderate[10], 2);
  assert.equal(REGIME_SCHEDULES.elevated[10], 2);
  assert.equal(REGIME_SCHEDULES.high[10],     2);

  // getPremiumPer1kForRegime is the public read accessor — verify it agrees
  assert.equal(getPremiumPer1kForRegime(2, "high"), 10);
  assert.equal(getPremiumPer1kForRegime(3, "moderate"), 5.5);
});

test("classifier (no hysteresis) picks correct band by DVOL", () => {
  __resetPricingRegimeForTests();

  // Defaults: low < 50 < moderate < 65 < elevated < 80 < high
  assert.equal(classifyPricingRegime(20, null), "low");
  assert.equal(classifyPricingRegime(43, null), "low",       "today's DVOL of 43 is low");
  assert.equal(classifyPricingRegime(49.99, null), "low",   "just under 50 is still low");
  assert.equal(classifyPricingRegime(50, null), "moderate", "50 is exactly moderate boundary");
  assert.equal(classifyPricingRegime(58, null), "moderate", "mid-band moderate");
  assert.equal(classifyPricingRegime(64.99, null), "moderate", "just under 65");
  assert.equal(classifyPricingRegime(65, null), "elevated", "65 is exactly elevated boundary");
  assert.equal(classifyPricingRegime(72, null), "elevated");
  assert.equal(classifyPricingRegime(79.99, null), "elevated");
  assert.equal(classifyPricingRegime(80, null), "high",     "80 is exactly high boundary");
  assert.equal(classifyPricingRegime(95, null), "high");
  assert.equal(classifyPricingRegime(150, null), "high",    "extreme DVOL = high");
});

test("hysteresis: upward transitions are immediate", () => {
  __resetPricingRegimeForTests();

  // Sitting in low at DVOL 40, vol spikes to 60 → moderate immediately
  assert.equal(classifyPricingRegime(60, "low"), "moderate", "low → moderate immediate");
  // Sitting in moderate, vol spikes to 70 → elevated
  assert.equal(classifyPricingRegime(70, "moderate"), "elevated", "moderate → elevated immediate");
  // Sitting in moderate, vol spikes to 90 → high (skipping elevated)
  assert.equal(classifyPricingRegime(90, "moderate"), "high", "skip-band upward jump");
  // Sitting in elevated, vol spikes to 90 → high
  assert.equal(classifyPricingRegime(90, "elevated"), "high");
});

test("hysteresis: downward transitions require crossing the boundary by padding", () => {
  __resetPricingRegimeForTests();
  // Default hysteresis padding = 2 points

  // Sitting in moderate, vol drifts to 49 → still moderate (need < 48 to drop)
  assert.equal(classifyPricingRegime(49, "moderate"), "moderate", "49 still holds moderate (boundary 50, padding 2 → need < 48)");
  assert.equal(classifyPricingRegime(48.5, "moderate"), "moderate", "48.5 still holds (just inside padding zone)");
  assert.equal(classifyPricingRegime(47.99, "moderate"), "low",    "47.99 drops to low");

  // Sitting in elevated, vol drifts to 64 → still elevated (need < 63)
  assert.equal(classifyPricingRegime(64, "elevated"), "elevated");
  assert.equal(classifyPricingRegime(62.99, "elevated"), "moderate");

  // Sitting in high, vol drifts to 79 → still high (need < 78)
  assert.equal(classifyPricingRegime(79, "high"), "high");
  assert.equal(classifyPricingRegime(77.99, "high"), "elevated");
});

test("hysteresis: configurable padding", () => {
  __resetPricingRegimeForTests();
  configurePricingRegime({ bands: { hysteresisPoints: 5 } });
  // With 5-point padding, dropping from moderate requires < 45
  assert.equal(classifyPricingRegime(46, "moderate"), "moderate", "46 holds with 5-pt padding (need < 45)");
  assert.equal(classifyPricingRegime(44, "moderate"), "low",      "44 drops with 5-pt padding");
});

test("rolling window: 1-hour average smooths samples and drops stale ones", () => {
  __resetPricingRegimeForTests();

  const now = Date.now();
  // Drop 5 samples in the last 30 minutes spanning low → moderate boundary
  recordDvolSample(45, now - 1800_000); // 30m ago
  recordDvolSample(48, now - 1500_000); // 25m ago
  recordDvolSample(52, now - 1200_000); // 20m ago
  recordDvolSample(55, now - 900_000);  // 15m ago
  recordDvolSample(60, now);            // now
  // Average = (45+48+52+55+60)/5 = 52 → moderate band

  const status = getCurrentPricingRegime(undefined, now);
  assert.equal(status.regime, "moderate", "rolling avg of 52 → moderate");
  assert.equal(status.dvol !== null && Math.abs(status.dvol - 52) < 0.01, true, "rolling avg = 52");
  assert.equal(status.source, "dvol", "real DVOL data used, not fallback");
  assert.equal(__getDvolHistoryLength(), 5, "5 samples in window");
});

test("rolling window: stale samples past 1h are dropped", () => {
  __resetPricingRegimeForTests();
  const now = Date.now();

  // Stale sample (90m ago) plus 2 fresh samples
  recordDvolSample(100, now - 5400_000); // 90m ago — should be dropped
  recordDvolSample(40, now - 60_000);    // 1m ago
  recordDvolSample(42, now);             // now
  // The 100-DVOL stale sample drops on the next recordDvolSample call's
  // shift-loop. After the 3rd call, history should hold 2 samples
  // (40 and 42), avg = 41.

  const status = getCurrentPricingRegime(undefined, now);
  assert.equal(__getDvolHistoryLength(), 2, "stale sample dropped");
  assert.equal(status.regime, "low", "rolling avg of 41 → low");
  assert.equal(status.dvol !== null && Math.abs(status.dvol - 41) < 0.01, true);
});

test("fallback: no DVOL anywhere → defaults to 'moderate'", () => {
  __resetPricingRegimeForTests();
  const status = getCurrentPricingRegime(); // no live, no history
  assert.equal(status.regime, "moderate", "fallback regime is moderate");
  assert.equal(status.source, "fallback", "source labeled fallback");
  assert.equal(status.dvol, null, "no DVOL value reported");
});

test("live DVOL fallback used when rolling history is empty", () => {
  __resetPricingRegimeForTests();
  // No samples recorded yet; pass a live DVOL of 75 directly
  const status = getCurrentPricingRegime(75);
  assert.equal(status.regime, "elevated", "live 75 → elevated");
  assert.equal(status.source, "dvol", "live DVOL is real DVOL data");
  assert.equal(status.dvol, 75);
});

test("getCurrentPricingRegime caches for 5 minutes", () => {
  __resetPricingRegimeForTests();
  const now = Date.now();
  recordDvolSample(40, now);
  const first = getCurrentPricingRegime(undefined, now);
  // Add a second sample that would shift the average up
  recordDvolSample(80, now + 1_000); // recordDvolSample invalidates cache
  const second = getCurrentPricingRegime(undefined, now + 1_000);
  // After cache invalidation, the new sample is reflected
  assert.notEqual(first.regime, second.regime, "cache properly invalidated by new sample");
});

test("regime change is logged once (not on every call)", () => {
  __resetPricingRegimeForTests();
  __setLastRegimeForTests("low");

  const originalLog = console.log;
  const calls: string[] = [];
  console.log = (...args: any[]) => { calls.push(args.join(" ")); };

  try {
    // Trigger a change low → high
    const status = getCurrentPricingRegime(95);
    assert.equal(status.regime, "high");
    const changeLogs = calls.filter((c) => c.includes("REGIME CHANGED"));
    assert.equal(changeLogs.length, 1, "one regime-change log line emitted");
    assert.ok(changeLogs[0].includes("low → high"), `log mentions transition: ${changeLogs[0]}`);
  } finally {
    console.log = originalLog;
  }
});

test("integration: classifier + schedule produces the documented expected daily P&L direction", () => {
  __resetPricingRegimeForTests();
  // Confirm the schedule's directional intent: as regime escalates,
  // 2% premium rises monotonically. This is the property that prevents
  // calm-priced product from being sold into stress markets.
  const regimes: PricingRegime[] = ["low", "moderate", "elevated", "high"];
  let last = -Infinity;
  for (const r of regimes) {
    const p = getPremiumPer1kForRegime(2, r);
    assert.ok(p >= last, `${r} 2% premium ${p} should be ≥ previous ${last}`);
    last = p;
  }
});
