import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRegimeGate, type RegimeGateConfig } from "../src/singleSide/twoSided/creditCollar/regimeGate";

const cfg = (over: Partial<RegimeGateConfig> = {}): RegimeGateConfig => ({
  enabled: true, lookback: 40, minSamples: 10, elevatedVolPct: 1.5, haltVolPct: 3.0,
  elevatedOpenMultiplier: 0.5, elevatedFloorPct: 0.1, ...over
});

const moves = (absPct: number, n = 20) => Array.from({ length: n }, () => absPct / 100);

test("disabled ⟹ always calm, open normally", () => {
  const d = evaluateRegimeGate(moves(5), cfg({ enabled: false }));
  assert.equal(d.regime, "calm");
  assert.equal(d.openMultiplier, 1);
  assert.equal(d.floorPctOverride, null);
});

test("insufficient samples ⟹ don't gate (calm)", () => {
  const d = evaluateRegimeGate(moves(5, 5), cfg());
  assert.equal(d.regime, "calm");
  assert.equal(d.openMultiplier, 1);
});

test("calm regime (small moves) ⟹ open normally, no floor override", () => {
  const d = evaluateRegimeGate(moves(0.9), cfg());
  assert.equal(d.regime, "calm");
  assert.equal(d.openMultiplier, 1);
  assert.equal(d.floorPctOverride, null);
});

test("elevated regime ⟹ widen cap (deeper floor) + throttle opens", () => {
  const d = evaluateRegimeGate(moves(2.0), cfg());
  assert.equal(d.regime, "elevated");
  assert.equal(d.openMultiplier, 0.5);
  assert.equal(d.floorPctOverride, 0.1);
  assert.ok(Math.abs(d.realizedMovePct - 2.0) < 1e-6);
});

test("extreme regime ⟹ pause new opens", () => {
  const d = evaluateRegimeGate(moves(3.5), cfg());
  assert.equal(d.regime, "halt");
  assert.equal(d.openMultiplier, 0);
});

test("hysteresis: elevated is sticky at the line — no calm↔elevated flicker", () => {
  const c = cfg({ elevatedVolPct: 1.2, hysteresisExitRatio: 0.85 }); // exit below 1.02
  // Fresh (no prev): 1.19 < 1.2 ⟹ calm.
  assert.equal(evaluateRegimeGate(moves(1.19), c, null, null).regime, "calm");
  // Already elevated: 1.19 (and even 1.05) stays elevated — above the 1.02 exit bar.
  assert.equal(evaluateRegimeGate(moves(1.19), c, null, "elevated").regime, "elevated");
  assert.equal(evaluateRegimeGate(moves(1.05), c, null, "elevated").regime, "elevated");
  // Only genuinely calming (below 1.02) releases.
  assert.equal(evaluateRegimeGate(moves(0.95), c, null, "elevated").regime, "calm");
});

test("hysteresis: halt is sticky, and releases into elevated (not straight to calm)", () => {
  const c = cfg({ elevatedVolPct: 1.2, haltVolPct: 3.0, hysteresisExitRatio: 0.85 }); // halt exit 2.55
  assert.equal(evaluateRegimeGate(moves(2.7), c, null, "halt").regime, "halt"); // above 2.55 ⟹ still halt
  assert.equal(evaluateRegimeGate(moves(2.3), c, null, "halt").regime, "elevated"); // below halt exit, above elevated
  assert.equal(evaluateRegimeGate(moves(0.9), c, null, "halt").regime, "calm"); // fully calmed
});
