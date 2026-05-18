import assert from "node:assert/strict";
import test from "node:test";

import {
  getSpotMovePct,
  recordSpotSample,
  __getSpotHistoryLengthForTests,
  __resetSpotHistoryForTests
} from "../src/pilot/spotHistory.js";

// PR C — spot-history ring buffer regression tests.
//
// Coverage:
//   1. Records valid samples; rejects non-positive / non-finite.
//   2. Computes move% over a lookback window when sufficient history.
//   3. Returns null when insufficient history exists.
//   4. Drops samples beyond the 24h rolling window.
//   5. Accepts a small tolerance on the lookback window (handles 60s
//      cycle-to-cycle drift without losing the lookback entirely).

test("records valid samples; rejects invalid", () => {
  __resetSpotHistoryForTests();
  recordSpotSample(100);
  recordSpotSample(0);          // rejected (non-positive)
  recordSpotSample(-50);        // rejected (negative)
  recordSpotSample(NaN);        // rejected (non-finite)
  recordSpotSample(Infinity);   // rejected (non-finite)
  recordSpotSample(101);
  assert.equal(__getSpotHistoryLengthForTests(), 2, "only the 2 valid samples recorded");
});

test("getSpotMovePct returns null when fewer than 2 samples", () => {
  __resetSpotHistoryForTests();
  recordSpotSample(100, 1000);
  assert.equal(getSpotMovePct(3600_000, 4600_000), null, "1 sample → null");
});

test("getSpotMovePct returns null when no sample old enough", () => {
  __resetSpotHistoryForTests();
  // Three samples all within the last 30 minutes
  recordSpotSample(100, 1000);
  recordSpotSample(101, 600_000);
  recordSpotSample(102, 1_800_000);
  // Lookback 4 hours from t=2_000_000 — none of our samples are 4h old.
  // Default tolerance 60s — none qualifies.
  assert.equal(getSpotMovePct(4 * 3600_000, 2_000_000), null);
});

test("getSpotMovePct computes positive move when spot rose", () => {
  __resetSpotHistoryForTests();
  recordSpotSample(100, 0);            // 2h ago
  recordSpotSample(105, 3_600_000);    // 1h ago
  recordSpotSample(110, 7_200_000);    // now (most recent)
  // Lookback 2h from now (7_200_000 - 7_200_000 = 0) → 2h ago = sample 100
  // Move = (110 - 100) / 100 = +10%
  const move = getSpotMovePct(7_200_000, 7_200_000, 60_000);
  assert.ok(move !== null, "move should be available");
  assert.ok(Math.abs((move as number) - 10) < 0.01, `move ≈ +10%, got ${move}`);
});

test("getSpotMovePct computes negative move when spot fell", () => {
  __resetSpotHistoryForTests();
  recordSpotSample(100, 0);
  recordSpotSample(80, 7_200_000);
  // Move = (80 - 100) / 100 = -20%
  const move = getSpotMovePct(7_200_000, 7_200_000);
  assert.ok(move !== null);
  assert.ok(Math.abs((move as number) - -20) < 0.01, `move ≈ -20%, got ${move}`);
});

test("rolling 24h window: stale samples dropped on next push", () => {
  __resetSpotHistoryForTests();
  // Sample 25h ago — should be dropped on the next push (cutoff is now-24h)
  recordSpotSample(100, 1000);
  // Push something now — the old sample is past 24h cutoff and gets shifted
  recordSpotSample(150, 1000 + 25 * 3600_000);
  assert.equal(__getSpotHistoryLengthForTests(), 1, "stale sample dropped");
});

test("tolerance accepts samples slightly newer than lookback target", () => {
  __resetSpotHistoryForTests();
  // Sample placed at exactly 1h ago — lookback for 1h+30s should accept it
  // because the tolerance is 60s.
  recordSpotSample(100, 0);
  recordSpotSample(110, 3_600_000);
  // Lookback 1h+30s from now: target = (3_600_000) - (3_600_000 + 30_000) = -30_000
  // Best match is sample at t=0 (distance 30_030); is its ms <= now - lookback + tolerance?
  // now - lookback = -30_000; +tolerance(60_000) = 30_000; sample.ms (0) <= 30_000 ✓
  const move = getSpotMovePct(3_600_000 + 30_000, 3_600_000);
  assert.ok(move !== null, "tolerance permits slightly-too-recent sample");
});
