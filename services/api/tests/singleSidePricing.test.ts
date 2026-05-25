import assert from "node:assert/strict";
import test from "node:test";

import { findCellById } from "../src/singleSide/matrix";
import {
  resolveSingleSidePremium,
  computeIvMultiplier,
  resolveRegimeMultiplier,
  __resetSingleSidePricingCacheForTests
} from "../src/singleSide/pricing";

const cleanEnv = () => {
  delete process.env.SS_REGIME_OVERLAY_JSON;
  delete process.env.SS_IV_REFERENCE;
  delete process.env.SS_IV_ELASTICITY;
  delete process.env.SS_IV_SCALING_ENABLED;
  delete process.env.SS_PRICING_FLOOR_USD;
  delete process.env.SS_PRICING_CEILING_USD;
  __resetSingleSidePricingCacheForTests();
};

test("IV multiplier: 1.0 when current IV unknown", () => {
  cleanEnv();
  const m = computeIvMultiplier({ currentIv: null });
  assert.equal(m, 1.0);
});

test("IV multiplier: 1.0 when current IV equals reference", () => {
  cleanEnv();
  const m = computeIvMultiplier({ currentIv: 0.33, referenceIv: 0.33, elasticity: 0.7 });
  assert.equal(m, 1.0);
});

test("IV multiplier: doubles to ~1.6× when IV doubles (elasticity 0.7)", () => {
  cleanEnv();
  const m = computeIvMultiplier({ currentIv: 0.66, referenceIv: 0.33, elasticity: 0.7 });
  // 2^0.7 = 1.6245
  assert.ok(m >= 1.62 && m <= 1.63, `expected ~1.62, got ${m}`);
});

test("IV multiplier: drops to ~0.62 when IV halves", () => {
  cleanEnv();
  const m = computeIvMultiplier({ currentIv: 0.165, referenceIv: 0.33, elasticity: 0.7 });
  // 0.5^0.7 = 0.6156
  assert.ok(m >= 0.61 && m <= 0.62);
});

test("IV multiplier: env disable returns 1.0", () => {
  cleanEnv();
  process.env.SS_IV_SCALING_ENABLED = "false";
  try {
    const m = computeIvMultiplier({ currentIv: 0.66, referenceIv: 0.33, elasticity: 0.7 });
    assert.equal(m, 1.0);
  } finally {
    cleanEnv();
  }
});

test("regime multiplier: calm = 1.0; moderate = 1.4; elevated = 2.0; stress = 0", () => {
  cleanEnv();
  assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "calm" }), 1.0);
  assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "moderate" }), 1.4);
  assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "elevated" }), 2.0);
  assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "stress" }), 0);
});

test("regime multiplier: env override JSON applies", () => {
  cleanEnv();
  process.env.SS_REGIME_OVERLAY_JSON = JSON.stringify({
    "ss_200k_5pct_10k": { moderate: 1.6, elevated: 2.5, stress: 3.0 }
  });
  try {
    assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "moderate" }), 1.6);
    assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "elevated" }), 2.5);
    assert.equal(resolveRegimeMultiplier({ cellId: "ss_200k_5pct_10k", regime: "stress" }), 3.0);
  } finally {
    cleanEnv();
  }
});

test("resolve premium: 200k/5% calm at reference IV returns base $600", () => {
  cleanEnv();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const q = resolveSingleSidePremium({
    cell,
    currentIv: 0.33,
    regime: "calm"
  });
  assert.equal(q.dailyPremiumUsdc, 600);
  assert.equal(q.ivMultiplier, 1.0);
  assert.equal(q.regimeMultiplier, 1.0);
  assert.equal(q.baseSource, "matrix");
  assert.equal(q.stressPause, false);
});

test("resolve premium: 200k/5% with IV doubled to 66% returns ~$975", () => {
  cleanEnv();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const q = resolveSingleSidePremium({
    cell,
    currentIv: 0.66,
    regime: "calm"
  });
  // 600 × 1.6245 = $974.7
  assert.ok(q.dailyPremiumUsdc >= 970 && q.dailyPremiumUsdc <= 980);
  assert.ok(q.ivMultiplier >= 1.62 && q.ivMultiplier <= 1.63);
});

test("resolve premium: 200k/5% moderate regime + 50% IV → $600 × 1.4 × scaling", () => {
  cleanEnv();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const q = resolveSingleSidePremium({
    cell,
    currentIv: 0.50,
    regime: "moderate"
  });
  // IV multi = (0.50/0.33)^0.7 = 1.5152^0.7 = 1.341
  // Final = 600 × 1.341 × 1.4 = $1,126
  assert.ok(q.dailyPremiumUsdc >= 1100 && q.dailyPremiumUsdc <= 1150);
  assert.equal(q.regimeMultiplier, 1.4);
});

test("resolve premium: stress regime returns stressPause=true, premium=0", () => {
  cleanEnv();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const q = resolveSingleSidePremium({
    cell,
    currentIv: 0.85,
    regime: "stress"
  });
  assert.equal(q.dailyPremiumUsdc, 0);
  assert.equal(q.stressPause, true);
});

test("resolve premium: DB override beats matrix base", () => {
  cleanEnv();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const q = resolveSingleSidePremium({
    cell,
    dbOverrideDailyPremiumUsdc: 800,
    currentIv: 0.33,
    regime: "calm"
  });
  assert.equal(q.dailyPremiumUsdc, 800);
  assert.equal(q.basePremiumUsdc, 800);
  assert.equal(q.baseSource, "db_override");
});

test("resolve premium: clamps to floor when scaled value too low", () => {
  cleanEnv();
  const cell = findCellById("ss_50k_5pct_2_5k")!;  // base $140
  // IV at 0.10 (extremely low), elasticity 0.7
  // multi = (0.10/0.33)^0.7 = 0.3030^0.7 = 0.428
  // Scaled = 140 × 0.428 = $60
  // Floor default = $50
  const q = resolveSingleSidePremium({
    cell,
    currentIv: 0.10,
    regime: "calm"
  });
  assert.ok(q.dailyPremiumUsdc >= 50);
});

test("resolve premium: clamps to ceiling when scaled value too high", () => {
  cleanEnv();
  process.env.SS_PRICING_CEILING_USD = "5000";
  const cell = findCellById("ss_200k_7pct_14k")!;  // base $1,250
  // IV at 1.0 (extreme), elasticity 0.7
  // multi = (1.0/0.33)^0.7 = 3.03^0.7 = 2.18
  // Plus elevated regime ×2.0 = $1250 × 2.18 × 2.0 = $5,450
  // Ceiling at $5,000 should clamp
  try {
    const q = resolveSingleSidePremium({
      cell,
      currentIv: 1.0,
      regime: "elevated"
    });
    assert.ok(q.dailyPremiumUsdc <= 5000);
  } finally {
    cleanEnv();
  }
});
