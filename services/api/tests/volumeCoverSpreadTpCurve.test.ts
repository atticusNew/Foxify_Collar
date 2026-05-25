import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSpreadTpRule,
  getRegimeTighten,
  getConfiguredSpreadTpCurve
} from "../src/volumeCover/spreadTpCurve";

const clearEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VC_SPREAD_TP_")) {
      delete process.env[key];
    }
  }
};

test("getConfiguredSpreadTpCurve: defaults", () => {
  clearEnv();
  const c = getConfiguredSpreadTpCurve();
  assert.equal(c.primeFraction, 0.70);
  assert.equal(c.fullFraction, 0.90);
  assert.equal(c.bouncePeakFraction, 0.50);
  assert.equal(c.bounceRetraceFraction, 0.75);
  assert.equal(c.stressTighten, 0.85);
  assert.equal(c.elevatedTighten, 0.90);
  assert.equal(c.moderateTighten, 0.95);
});

test("getRegimeTighten: per-regime multipliers", () => {
  clearEnv();
  assert.equal(getRegimeTighten("calm"), 1.0);
  assert.equal(getRegimeTighten("moderate"), 0.95);
  assert.equal(getRegimeTighten("elevated"), 0.90);
  assert.equal(getRegimeTighten("stress"), 0.85);
  assert.equal(getRegimeTighten(null), 1.0);
});

test("evaluateSpreadTpRule: below all thresholds → 'none'", () => {
  clearEnv();
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 100,
    peakMtmUsdc: 200,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "none");
  assert.equal(d.shouldClose, false);
});

test("evaluateSpreadTpRule: prime trigger at 70% in calm regime", () => {
  clearEnv();
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 750, // 75% of 1000
    peakMtmUsdc: 750,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "prime");
  assert.equal(d.shouldClose, true);
  assert.equal(d.primeThresholdUsdc, 700); // 1000 * 0.70 * 1.0
});

test("evaluateSpreadTpRule: full trigger at 90% supersedes prime", () => {
  clearEnv();
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 950,
    peakMtmUsdc: 950,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "full");
  assert.equal(d.shouldClose, true);
});

test("evaluateSpreadTpRule: stress regime tightens prime threshold to 70% * 0.85 = 59.5%", () => {
  clearEnv();
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 600, // 60% of 1000 = above tightened prime threshold of 595
    peakMtmUsdc: 600,
    maxValueUsdc: 1000,
    regime: "stress"
  });
  assert.equal(d.rule, "prime");
  assert.equal(d.shouldClose, true);
  // 1000 * 0.70 * 0.85 = 595
  assert.equal(d.primeThresholdUsdc, 595);
});

test("evaluateSpreadTpRule: stress regime — 600 MTM that would NOT fire in calm DOES fire in stress", () => {
  clearEnv();
  const calm = evaluateSpreadTpRule({
    currentMtmUsdc: 600,
    peakMtmUsdc: 600,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(calm.rule, "none"); // calm prime threshold = 700, current = 600

  const stress = evaluateSpreadTpRule({
    currentMtmUsdc: 600,
    peakMtmUsdc: 600,
    maxValueUsdc: 1000,
    regime: "stress"
  });
  assert.equal(stress.rule, "prime"); // stress prime threshold = 595, current = 600
});

test("evaluateSpreadTpRule: bounce — peak crossed 50% then retraced to ≤75% of peak", () => {
  clearEnv();
  // Peak = 600 (60% of 1000, crossed bounce-peak 500)
  // Current = 400 (≤ 75% of peak 600 = 450)
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 400,
    peakMtmUsdc: 600,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "bounce");
  assert.equal(d.shouldClose, true);
});

test("evaluateSpreadTpRule: bounce does NOT fire when peak never crossed bounce-peak threshold", () => {
  clearEnv();
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 200,
    peakMtmUsdc: 400, // below 500 bounce-peak threshold
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "none");
});

test("evaluateSpreadTpRule: bounce does NOT fire when current is still close to peak", () => {
  clearEnv();
  // Peak = 600 (above 500 bounce-peak), but current = 500 = 83% of peak (above 75% retrace)
  const d = evaluateSpreadTpRule({
    currentMtmUsdc: 500,
    peakMtmUsdc: 600,
    maxValueUsdc: 1000,
    regime: "calm"
  });
  assert.equal(d.rule, "none");
});

test("evaluateSpreadTpRule: env override of primeFraction honored", () => {
  process.env.VC_SPREAD_TP_PRIME_FRACTION = "0.50";
  try {
    const d = evaluateSpreadTpRule({
      currentMtmUsdc: 550, // 55%
      peakMtmUsdc: 550,
      maxValueUsdc: 1000,
      regime: "calm"
    });
    assert.equal(d.rule, "prime");
    assert.equal(d.primeThresholdUsdc, 500); // 1000 * 0.50 * 1.0
  } finally {
    clearEnv();
  }
});
