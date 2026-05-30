/**
 * Tests for classifySignalTier — the 4-tier breakout of the activation signal.
 *
 * Tier boundaries (calm regime):
 *   vrp >  +1.5%            → "negative"
 *   0   <  vrp ≤ +1.5%      → "slightly_negative"
 *   threshold < vrp ≤ 0     → "slightly_positive"
 *   vrp ≤ threshold (-1.5%) → "positive"  (good_to_activate fires here)
 *
 * Non-calm: moderate → slightly_positive, elevated/stress → positive.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classifySignalTier } from "../src/singleSide/twoSided/activationGate";

const CALM_THRESHOLD = -0.015;

// ─── Calm regime: VRP-driven ────────────────────────────────────────────────

test("classifySignalTier: calm + VRP deeply above +1.5% → negative", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0.03, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "negative");
  assert.ok(r.score < -0.5);
  assert.match(r.label, /WAIT/);
});

test("classifySignalTier: calm + VRP at +1.0% (typical calm) → slightly_negative", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0.01, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_negative");
  assert.ok(r.score < 0 && r.score > -0.5);
});

test("classifySignalTier: calm + VRP at +0.2% (current live state example) → slightly_negative", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0.002, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_negative");
  assert.ok(r.score > -0.1 && r.score < 0);
});

test("classifySignalTier: calm + VRP exactly at +1.5% boundary → slightly_negative (closed at top)", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0.015, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_negative");
});

test("classifySignalTier: calm + VRP just above +1.5% → negative", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0.016, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "negative");
});

test("classifySignalTier: calm + VRP at 0% (boundary) → slightly_positive", () => {
  const r = classifySignalTier({ regime: "calm", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_positive");
  assert.equal(r.score, 0);
});

test("classifySignalTier: calm + VRP slightly negative (-0.5%) → slightly_positive (favorable but no activation)", () => {
  const r = classifySignalTier({ regime: "calm", vrp: -0.005, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_positive");
  assert.ok(r.score > 0 && r.score < 0.5);
});

test("classifySignalTier: calm + VRP at threshold (-1.5%) → positive (good_to_activate boundary)", () => {
  const r = classifySignalTier({ regime: "calm", vrp: -0.015, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "positive");
  assert.equal(r.score, 0.5);
});

test("classifySignalTier: calm + VRP well below threshold (-2.5%) → positive with high score", () => {
  const r = classifySignalTier({ regime: "calm", vrp: -0.025, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "positive");
  assert.ok(r.score > 0.5);
});

test("classifySignalTier: calm + VRP deeply negative (-4%) → positive with max score", () => {
  const r = classifySignalTier({ regime: "calm", vrp: -0.04, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "positive");
  assert.equal(r.score, 1);
});

test("classifySignalTier: calm + null VRP → negative (defensive default)", () => {
  const r = classifySignalTier({ regime: "calm", vrp: null, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "negative");
  assert.equal(r.score, -1);
});

// ─── Non-calm regimes: regime-driven ────────────────────────────────────────

test("classifySignalTier: moderate regime → slightly_positive", () => {
  const r = classifySignalTier({ regime: "moderate", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 45 });
  assert.equal(r.tier, "slightly_positive");
  assert.ok(r.score > 0 && r.score <= 0.5);
});

test("classifySignalTier: elevated regime → positive", () => {
  const r = classifySignalTier({ regime: "elevated", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 65 });
  assert.equal(r.tier, "positive");
  assert.ok(r.score >= 0.5);
});

test("classifySignalTier: stress regime → positive with max score", () => {
  const r = classifySignalTier({ regime: "stress", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 95 });
  assert.equal(r.tier, "positive");
  assert.equal(r.score, 1);
  assert.match(r.label, /stress/);
});

test("classifySignalTier: higher DVOL within elevated band → higher score", () => {
  const low = classifySignalTier({ regime: "elevated", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 62 });
  const high = classifySignalTier({ regime: "elevated", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 78 });
  assert.equal(low.tier, "positive");
  assert.equal(high.tier, "positive");
  assert.ok(high.score > low.score);
});

// ─── Defensive cases ────────────────────────────────────────────────────────

test("classifySignalTier: null regime → negative tier with no-data label", () => {
  const r = classifySignalTier({ regime: null, vrp: null, calmVrpThreshold: CALM_THRESHOLD, dvol: null });
  assert.equal(r.tier, "negative");
  assert.equal(r.score, -1);
  assert.match(r.label.toLowerCase(), /unavailable/);
});

test("classifySignalTier: non-calm regime with null DVOL still works", () => {
  const r = classifySignalTier({ regime: "moderate", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: null });
  assert.equal(r.tier, "slightly_positive");
});

// ─── Monotonicity: more favorable VRP → strictly higher score in calm ───────

test("classifySignalTier: monotonic in VRP within calm regime", () => {
  const veryGood = classifySignalTier({ regime: "calm", vrp: -0.05, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const good = classifySignalTier({ regime: "calm", vrp: -0.02, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const slightBad = classifySignalTier({ regime: "calm", vrp: 0.005, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const veryBad = classifySignalTier({ regime: "calm", vrp: 0.03, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.ok(veryGood.score > good.score);
  assert.ok(good.score > slightBad.score);
  assert.ok(slightBad.score > veryBad.score);
});

// ─── Tier ↔ good_to_activate alignment ──────────────────────────────────────

test("classifySignalTier: positive tier in calm regime fires exactly when good_to_activate would (vrp ≤ threshold)", () => {
  // Just at threshold → positive
  const at = classifySignalTier({ regime: "calm", vrp: CALM_THRESHOLD, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(at.tier, "positive");
  // Just above threshold → not yet positive
  const above = classifySignalTier({ regime: "calm", vrp: CALM_THRESHOLD + 0.0001, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(above.tier, "slightly_positive");
});
