import assert from "node:assert/strict";
import test from "node:test";
import { computeLiveRegimeSignal, trendDirection, type PriceObs } from "../src/singleSide/twoSided/creditCollar/priceHistoryStore";
import { evaluateRegimeGate, type RegimeGateConfig } from "../src/singleSide/twoSided/creditCollar/regimeGate";

const CYCLE = 900_000; // 15 min
const NOW = 1_800_000_000_000;

// Build a 6h window (24 samples) with a steady drift of `driftPctPerStep` per 15-min step.
const drifting = (startPrice: number, driftPctPerStep: number, n = 24): PriceObs[] =>
  Array.from({ length: n }, (_, i) => ({ tsMs: NOW - (n - 1 - i) * CYCLE, priceUsd: startPrice * (1 + (driftPctPerStep / 100) * i) }));

test("insufficient live samples ⟹ null (don't act on noise)", () => {
  assert.equal(computeLiveRegimeSignal([{ tsMs: NOW, priceUsd: 60000 }], NOW, { minSamples: 4 }), null);
});

test("a steady trend is caught by MOMENTUM even though return-dispersion is low", () => {
  // +0.25%/step over 24 steps ≈ +6% over 6h → a strong trend; per-step returns are nearly identical (low vol).
  const sig = computeLiveRegimeSignal(drifting(60000, 0.25), NOW, { lookbackMs: 6 * 3_600_000, minSamples: 4 })!;
  assert.ok(sig !== null);
  // momentum (net move scaled to a day) should dominate and be large.
  assert.ok(sig.momentumPct > sig.volPct, "steady trend: momentum > vol");
  assert.ok(sig.gaugePct > 5, `gauge should flag the trend, got ${sig.gaugePct}`);
});

test("a flat tape reads near-zero", () => {
  const flat = Array.from({ length: 24 }, (_, i) => ({ tsMs: NOW - (23 - i) * CYCLE, priceUsd: 60000 }));
  const sig = computeLiveRegimeSignal(flat, NOW, { minSamples: 4 })!;
  assert.ok(sig.gaugePct < 0.01, `flat tape ⟹ ~0 gauge, got ${sig.gaugePct}`);
});

test("gate blends live: a live spike trips the gate even with calm trailing settled moves", () => {
  const cfg: RegimeGateConfig = { enabled: true, minSamples: 10, elevatedVolPct: 1.5, haltVolPct: 3.0, elevatedOpenMultiplier: 0.5, elevatedFloorPct: 0.1 };
  const calmTrailing = Array.from({ length: 20 }, () => 0.005); // 0.5%/day settled — calm
  // No live: calm.
  assert.equal(evaluateRegimeGate(calmTrailing, cfg).regime, "calm");
  // Live gauge at 4% (a developing trend the settled positions haven't caught yet) ⟹ halt, sourced from live.
  const d = evaluateRegimeGate(calmTrailing, cfg, 4.0);
  assert.equal(d.regime, "halt");
  assert.equal(d.signalSource, "live");
  assert.equal(d.liveMovePct, 4.0);
});

test("trendDirection: +1 rising, −1 falling, 0 flat/insufficient", () => {
  const rising = [{ tsMs: NOW - 5 * CYCLE, priceUsd: 60000 }, { tsMs: NOW, priceUsd: 61000 }];
  const falling = [{ tsMs: NOW - 5 * CYCLE, priceUsd: 61000 }, { tsMs: NOW, priceUsd: 60000 }];
  assert.equal(trendDirection(rising, NOW), 1);
  assert.equal(trendDirection(falling, NOW), -1);
  assert.equal(trendDirection([{ tsMs: NOW, priceUsd: 60000 }], NOW), 0);
});

test("live works during trailing warm-up (before enough positions have settled)", () => {
  const cfg: RegimeGateConfig = { enabled: true, minSamples: 10 };
  // Only 2 settled samples (below minSamples) but a live elevated gauge ⟹ gate still acts on live.
  const d = evaluateRegimeGate([0.02, 0.02], cfg, 2.0);
  assert.equal(d.regime, "elevated");
  assert.equal(d.signalSource, "live");
});
