import assert from "node:assert/strict";
import test from "node:test";

import { resolveDailyPremium, __resetPricingCacheForTests } from "../src/volumeCover/pricing";
import { findCellById } from "../src/volumeCover/matrix";

const cell = findCellById("50k_2pct_1k")!; // base $350

test("Pricing: matrix base when no overlay env, no DB override", () => {
  __resetPricingCacheForTests();
  delete process.env.VC_REGIME_OVERLAY_JSON;
  const r = resolveDailyPremium({ cell });
  assert.equal(r.dailyPremiumUsdc, 350);
  assert.equal(r.source, "matrix_base");
});

test("Pricing: DB override takes precedence over matrix base in calm", () => {
  __resetPricingCacheForTests();
  delete process.env.VC_REGIME_OVERLAY_JSON;
  const r = resolveDailyPremium({
    cell,
    dbOverrideDailyPremiumUsdc: 420,
    regime: "calm"
  });
  assert.equal(r.dailyPremiumUsdc, 420);
  assert.equal(r.source, "db_override");
});

test("Pricing: VC_REGIME_OVERLAY_JSON applies for moderate", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 420, elevated: 525, stress: 700 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "moderate" });
    assert.equal(r.dailyPremiumUsdc, 420);
    assert.equal(r.source, "regime_overlay");
    assert.equal(r.baseDailyPremiumUsdc, 350);
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: overlay applies for elevated and stress", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 420, elevated: 525, stress: 700 }
  });
  try {
    const elev = resolveDailyPremium({ cell, regime: "elevated" });
    const stress = resolveDailyPremium({ cell, regime: "stress" });
    assert.equal(elev.dailyPremiumUsdc, 525);
    assert.equal(stress.dailyPremiumUsdc, 700);
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: calm regime IGNORES overlay (locked at base/DB) per operator commitment", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { calm: 999, moderate: 420 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "calm" });
    assert.equal(r.dailyPremiumUsdc, 350, "calm overlay must be ignored");
    assert.equal(r.source, "matrix_base");
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: malformed VC_REGIME_OVERLAY_JSON falls back to base safely", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = "{not valid json";
  try {
    const r = resolveDailyPremium({ cell, regime: "moderate" });
    assert.equal(r.dailyPremiumUsdc, 350);
    assert.equal(r.source, "matrix_base");
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: cell not in overlay map falls back to base in non-calm regimes", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "200k_15pct_30k": { moderate: 444 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "moderate" }); // 50k_2pct_1k not configured
    assert.equal(r.dailyPremiumUsdc, 350);
    assert.equal(r.source, "matrix_base");
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: DB override beats matrix base when overlay missing for that regime", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { stress: 700 }
  });
  try {
    // moderate regime, no overlay for it → use DB override
    const r = resolveDailyPremium({
      cell,
      dbOverrideDailyPremiumUsdc: 380,
      regime: "moderate"
    });
    assert.equal(r.dailyPremiumUsdc, 380);
    assert.equal(r.source, "db_override");
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Pricing: cache invalidates when env JSON changes mid-run", () => {
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 400 }
  });
  let r = resolveDailyPremium({ cell, regime: "moderate" });
  assert.equal(r.dailyPremiumUsdc, 400);

  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 500 }
  });
  r = resolveDailyPremium({ cell, regime: "moderate" });
  assert.equal(r.dailyPremiumUsdc, 500, "cache must invalidate on env change");

  delete process.env.VC_REGIME_OVERLAY_JSON;
  __resetPricingCacheForTests();
});

// ─── Hybrid v3: VC_PAYOUT_OVERLAY_JSON (Y overlay) tests ───
// Added 2026-05-24 for Hybrid v3 pilot pricing. Premium (X) and payout
// (Y) are independent overlays. Y override mirrors X overlay semantics:
// calm-locked at base, moderate/elevated/stress can be overridden.

test("Payout overlay: base payout when no VC_PAYOUT_OVERLAY_JSON set", () => {
  __resetPricingCacheForTests();
  delete process.env.VC_PAYOUT_OVERLAY_JSON;
  const r = resolveDailyPremium({ cell, regime: "moderate" });
  assert.equal(r.payoutUsdc, 1000);
  assert.equal(r.payoutSource, "matrix_base");
  assert.equal(r.basePayoutUsdc, 1000);
});

test("Payout overlay: applies for moderate (Hybrid v3 pilot: $750)", () => {
  __resetPricingCacheForTests();
  process.env.VC_PAYOUT_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 750, elevated: 450 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "moderate" });
    assert.equal(r.payoutUsdc, 750);
    assert.equal(r.payoutSource, "regime_overlay");
    assert.equal(r.basePayoutUsdc, 1000);
  } finally {
    delete process.env.VC_PAYOUT_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Payout overlay: applies for elevated (Hybrid v3 pilot: $450)", () => {
  __resetPricingCacheForTests();
  process.env.VC_PAYOUT_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 750, elevated: 450 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "elevated" });
    assert.equal(r.payoutUsdc, 450);
    assert.equal(r.payoutSource, "regime_overlay");
  } finally {
    delete process.env.VC_PAYOUT_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Payout overlay: calm regime IGNORES Y overlay (locked at base)", () => {
  __resetPricingCacheForTests();
  process.env.VC_PAYOUT_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { calm: 500, moderate: 750 }
  });
  try {
    const r = resolveDailyPremium({ cell, regime: "calm" });
    assert.equal(r.payoutUsdc, 1000, "calm payout overlay must be ignored");
    assert.equal(r.payoutSource, "matrix_base");
  } finally {
    delete process.env.VC_PAYOUT_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Payout overlay: X and Y overlays are independent (X flat $350, Y regime-tiered)", () => {
  // Hybrid v3 scenario: X stays flat at $350 across all regimes (calm base),
  // Y varies by regime via payout overlay.
  __resetPricingCacheForTests();
  process.env.VC_REGIME_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 350, elevated: 350 }
  });
  process.env.VC_PAYOUT_OVERLAY_JSON = JSON.stringify({
    "50k_2pct_1k": { moderate: 750, elevated: 450 }
  });
  try {
    const mod = resolveDailyPremium({ cell, regime: "moderate" });
    assert.equal(mod.dailyPremiumUsdc, 350, "X flat at $350 in moderate");
    assert.equal(mod.payoutUsdc, 750, "Y = $750 in moderate (Hybrid v3 pilot)");

    const elev = resolveDailyPremium({ cell, regime: "elevated" });
    assert.equal(elev.dailyPremiumUsdc, 350, "X flat at $350 in elevated");
    assert.equal(elev.payoutUsdc, 450, "Y = $450 in elevated (Hybrid v3 pilot)");

    const calm = resolveDailyPremium({ cell, regime: "calm" });
    assert.equal(calm.dailyPremiumUsdc, 350, "X = $350 base in calm");
    assert.equal(calm.payoutUsdc, 1000, "Y = $1000 base in calm");
  } finally {
    delete process.env.VC_REGIME_OVERLAY_JSON;
    delete process.env.VC_PAYOUT_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});

test("Payout overlay: malformed JSON falls back to base safely", () => {
  __resetPricingCacheForTests();
  process.env.VC_PAYOUT_OVERLAY_JSON = "{not valid json";
  try {
    const r = resolveDailyPremium({ cell, regime: "moderate" });
    assert.equal(r.payoutUsdc, 1000);
    assert.equal(r.payoutSource, "matrix_base");
  } finally {
    delete process.env.VC_PAYOUT_OVERLAY_JSON;
    __resetPricingCacheForTests();
  }
});
