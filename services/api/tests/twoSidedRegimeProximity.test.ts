/**
 * Tests — computeRegimeProximity (DVOL distance/trend to the next regime boundary).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeRegimeProximity } from "../src/singleSide/twoSided/regimeProximity";

test("proximity: calm near the moderate line → approaching_up, correct distances", () => {
  const p = computeRegimeProximity(39, { trendDelta: 0.8 });
  assert.equal(p.regime, "calm");
  assert.equal(p.next_regime_up, "moderate");
  assert.equal(p.next_threshold_up, 40);
  assert.equal(p.dvol_to_next_up, 1);
  assert.equal(p.lower_threshold, null, "calm has no lower boundary");
  assert.equal(p.approaching_up, true);
  assert.equal(p.trend, "rising");
  assert.match(p.note, /imminent/i);
});

test("proximity: mid-moderate → not approaching, lower boundary at 40", () => {
  const p = computeRegimeProximity(48, { trendDelta: 0.0 });
  assert.equal(p.regime, "moderate");
  assert.equal(p.next_regime_up, "elevated");
  assert.equal(p.next_threshold_up, 60);
  assert.equal(p.dvol_to_next_up, 12);
  assert.equal(p.lower_threshold, 40);
  assert.equal(p.dvol_to_lower, 8);
  assert.equal(p.approaching_up, false);
  assert.equal(p.near_lower, false);
  assert.equal(p.trend, "flat");
});

test("proximity: just into moderate + falling → near_lower flag (risk of dropping back to calm)", () => {
  const p = computeRegimeProximity(41, { trendDelta: -0.5 });
  assert.equal(p.regime, "moderate");
  assert.equal(p.dvol_to_lower, 1);
  assert.equal(p.near_lower, true);
  assert.equal(p.trend, "falling");
  assert.match(p.note, /dropping a regime/i);
});

test("proximity: stress (top band) → no next-up threshold", () => {
  const p = computeRegimeProximity(90, { trendDelta: 1.0 });
  assert.equal(p.regime, "stress");
  assert.equal(p.next_regime_up, null);
  assert.equal(p.next_threshold_up, null);
  assert.equal(p.dvol_to_next_up, null);
  assert.equal(p.lower_threshold, 85);
});

test("proximity: trend classification from delta", () => {
  assert.equal(computeRegimeProximity(50, { trendDelta: 0.5 }).trend, "rising");
  assert.equal(computeRegimeProximity(50, { trendDelta: -0.5 }).trend, "falling");
  assert.equal(computeRegimeProximity(50, { trendDelta: 0.1 }).trend, "flat");
  assert.equal(computeRegimeProximity(50, { trendDelta: null }).trend, "unknown");
  assert.equal(computeRegimeProximity(50).trend, "unknown");
});

test("proximity: null/NaN DVOL → safe unknown shape", () => {
  const p = computeRegimeProximity(null);
  assert.equal(p.regime, null);
  assert.equal(p.approaching_up, false);
  assert.equal(p.trend, "unknown");
  assert.match(p.note, /unavailable/i);
});
