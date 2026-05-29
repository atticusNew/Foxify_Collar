/**
 * Tests for classifySignalTier — the 4-tier breakout of the activation signal.
 * Uses the SAME precise measurements (regime + VRP + DVOL) as good_to_activate,
 * but exposes a more granular "negative / slightly_negative / slightly_positive
 * / positive" tier for the operator + Foxify-facing UI.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classifySignalTier } from "../src/singleSide/twoSided/activationGate";

const CALM_THRESHOLD = -0.015;

// ─── Calm regime: VRP-driven ────────────────────────────────────────────────

test("classifySignalTier: calm + VRP deeply above threshold → negative", () => {
  // VRP = +1.5% (well above -1.5% threshold). gap = -3.0%. score clamps to -1.
  const r = classifySignalTier({ regime: "calm", vrp: 0.015, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "negative");
  assert.equal(r.score, -1);
  assert.match(r.label, /WAIT/);
});

test("classifySignalTier: calm + VRP just above threshold → slightly_negative", () => {
  // VRP = -1.0% (above -1.5% threshold by 0.5%). gap = -0.5%. score = -0.33.
  const r = classifySignalTier({ regime: "calm", vrp: -0.01, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_negative");
  assert.ok(r.score > -0.5 && r.score <= 0, `expected -0.5 < score <= 0, got ${r.score}`);
});

test("classifySignalTier: calm + VRP just below threshold → slightly_positive", () => {
  // VRP = -2.0% (below -1.5% threshold by 0.5%). gap = +0.5%. score = +0.33.
  const r = classifySignalTier({ regime: "calm", vrp: -0.02, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_positive");
  assert.ok(r.score > 0 && r.score <= 0.5, `expected 0 < score <= 0.5, got ${r.score}`);
});

test("classifySignalTier: calm + VRP well below threshold → positive", () => {
  // VRP = -4.0% (below -1.5% by 2.5%). gap = +2.5%. score clamps to +1.
  const r = classifySignalTier({ regime: "calm", vrp: -0.04, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "positive");
  assert.ok(r.score > 0.5, `expected score > 0.5, got ${r.score}`);
});

test("classifySignalTier: calm + null VRP → negative (defensive default)", () => {
  const r = classifySignalTier({ regime: "calm", vrp: null, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "negative");
  assert.equal(r.score, -1);
});

test("classifySignalTier: calm + VRP === threshold → boundary slightly_negative", () => {
  // gap = 0 exactly. score = 0. 0 falls into slightly_negative bucket (score <= 0).
  const r = classifySignalTier({ regime: "calm", vrp: -0.015, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.equal(r.tier, "slightly_negative");
  assert.equal(r.score, 0);
});

// ─── Non-calm regimes: DVOL-driven ──────────────────────────────────────────

test("classifySignalTier: moderate regime → slightly_positive", () => {
  const r = classifySignalTier({ regime: "moderate", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 45 });
  assert.equal(r.tier, "slightly_positive");
  assert.ok(r.score > 0 && r.score <= 0.5, `expected 0 < score <= 0.5, got ${r.score}`);
});

test("classifySignalTier: elevated regime → positive", () => {
  const r = classifySignalTier({ regime: "elevated", vrp: 0, calmVrpThreshold: CALM_THRESHOLD, dvol: 65 });
  assert.equal(r.tier, "positive");
  assert.ok(r.score >= 0.5, `expected score >= 0.5, got ${r.score}`);
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
  assert.ok(high.score > low.score, `expected high.score > low.score, got ${high.score} vs ${low.score}`);
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
  assert.ok(r.score > 0);
});

// ─── Monotonicity: more favorable VRP → higher score in calm ────────────────

test("classifySignalTier: monotonic in VRP within calm regime", () => {
  const veryGood = classifySignalTier({ regime: "calm", vrp: -0.05, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const good = classifySignalTier({ regime: "calm", vrp: -0.02, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const slightBad = classifySignalTier({ regime: "calm", vrp: -0.01, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  const veryBad = classifySignalTier({ regime: "calm", vrp: 0.03, calmVrpThreshold: CALM_THRESHOLD, dvol: 35 });
  assert.ok(veryGood.score > good.score);
  assert.ok(good.score > slightBad.score);
  assert.ok(slightBad.score > veryBad.score);
});
