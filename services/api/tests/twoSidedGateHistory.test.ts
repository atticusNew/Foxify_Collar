/**
 * Tests for gateHistory — VRP trend + consecutive-good tracking.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  recordGateSnapshot,
  computeVrpTrend,
  computeConsecutiveGoodSeconds,
  getLatestSnapshot,
  __resetGateHistory,
  __getGateHistorySize
} from "../src/singleSide/twoSided/gateHistory";

test("gateHistory: empty buffer returns null trend and consecutive", () => {
  __resetGateHistory();
  assert.equal(computeVrpTrend(5).delta, null);
  assert.equal(computeConsecutiveGoodSeconds(), null);
  assert.equal(getLatestSnapshot(), null);
});

test("gateHistory: records snapshots and exposes latest", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 60_000, vrp: -0.02, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now - 30_000, vrp: -0.018, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now, vrp: -0.015, goodToActivate: false, regime: "calm" });
  assert.equal(__getGateHistorySize(), 3);
  assert.equal(getLatestSnapshot()?.vrp, -0.015);
});

test("computeVrpTrend: returns null when not enough history", () => {
  __resetGateHistory();
  recordGateSnapshot({ asOfMs: Date.now(), vrp: -0.02, goodToActivate: true, regime: "calm" });
  const trend = computeVrpTrend(5);
  assert.equal(trend.delta, null); // only one entry, no past data
});

test("computeVrpTrend: positive delta when VRP loosened (got worse for buyers)", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 6 * 60_000, vrp: -0.025, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now - 5 * 60_000, vrp: -0.022, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now - 4 * 60_000, vrp: -0.020, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now, vrp: -0.010, goodToActivate: false, regime: "calm" });
  const trend = computeVrpTrend(5, now);
  assert.ok(trend.delta != null);
  assert.ok(trend.delta! > 0); // VRP went from -0.025 → -0.010 = +0.015 (loosened)
  assert.ok(trend.sampleCount >= 1);
});

test("computeVrpTrend: negative delta when VRP tightened", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 6 * 60_000, vrp: -0.005, goodToActivate: false, regime: "calm" });
  recordGateSnapshot({ asOfMs: now - 5 * 60_000, vrp: -0.010, goodToActivate: false, regime: "calm" });
  recordGateSnapshot({ asOfMs: now, vrp: -0.025, goodToActivate: true, regime: "calm" });
  const trend = computeVrpTrend(5, now);
  assert.ok(trend.delta != null);
  assert.ok(trend.delta! < 0); // VRP went from -0.005 → -0.025 = -0.020 (tightened, became more negative)
});

test("computeConsecutiveGoodSeconds: returns 0 if latest is bad", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 60_000, vrp: -0.025, goodToActivate: true, regime: "calm" });
  recordGateSnapshot({ asOfMs: now, vrp: -0.010, goodToActivate: false, regime: "calm" });
  assert.equal(computeConsecutiveGoodSeconds(now), 0);
});

test("computeConsecutiveGoodSeconds: returns elapsed seconds since first good", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 300_000, vrp: -0.005, goodToActivate: false, regime: "calm" }); // 5 min ago, bad
  recordGateSnapshot({ asOfMs: now - 180_000, vrp: -0.025, goodToActivate: true, regime: "calm" });  // 3 min ago, GOOD start
  recordGateSnapshot({ asOfMs: now - 120_000, vrp: -0.023, goodToActivate: true, regime: "calm" });  // 2 min ago, GOOD
  recordGateSnapshot({ asOfMs: now - 60_000, vrp: -0.020, goodToActivate: true, regime: "calm" });   // 1 min ago, GOOD
  recordGateSnapshot({ asOfMs: now, vrp: -0.018, goodToActivate: true, regime: "calm" });            // now, GOOD
  // First continuous good was 3 min ago = 180 seconds
  const sec = computeConsecutiveGoodSeconds(now);
  assert.ok(sec != null);
  assert.ok(Math.abs(sec! - 180) < 2); // within 2-sec rounding
});

test("computeConsecutiveGoodSeconds: a single bad in the middle resets the streak", () => {
  __resetGateHistory();
  const now = Date.now();
  recordGateSnapshot({ asOfMs: now - 300_000, vrp: -0.025, goodToActivate: true, regime: "calm" });  // good 5 min ago
  recordGateSnapshot({ asOfMs: now - 200_000, vrp: -0.010, goodToActivate: false, regime: "calm" }); // bad 3.3 min ago
  recordGateSnapshot({ asOfMs: now - 100_000, vrp: -0.020, goodToActivate: true, regime: "calm" });  // good 1.7 min ago
  recordGateSnapshot({ asOfMs: now, vrp: -0.022, goodToActivate: true, regime: "calm" });            // good now
  // Streak starts at -100s ago = 100 seconds (because -200s was bad)
  const sec = computeConsecutiveGoodSeconds(now);
  assert.ok(sec != null);
  assert.ok(Math.abs(sec! - 100) < 2);
});
