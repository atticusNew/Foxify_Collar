import assert from "node:assert/strict";
import test from "node:test";
import {
  V7_LAUNCHED_TIERS,
  isValidSlTier,
  getV7PayoutPer10k,
  getV7TenorDays,
  computeV7Payout,
  computeV7TriggerPrice
} from "../src/pilot/v7Pricing";
import {
  REGIME_SCHEDULES,
  getPremiumPer1kForRegime,
  classifyPricingRegime,
  __resetPricingRegimeForTests
} from "../src/pilot/pricingRegime";
import { V7_SL_TIERS } from "../src/pilot/types";
import Decimal from "decimal.js";

/**
 * Rev 6 tier set + pricing tests (Bundle C cutover, 2026-05-13).
 *
 * Verifies:
 *   - 7% tier added to V7_LAUNCHED_TIERS (offerable to traders)
 *   - 10% tier removed from V7_LAUNCHED_TIERS (still in V7_SL_TIERS for legacy data compat)
 *   - 7% pricing matches Bundle C P3 schedule across regimes
 *   - Stress 2% lifted from $13/$1k to $11/$1k (1.8× trader return on trigger)
 *   - 10% pricing entries retained in regime schedule (legacy display)
 *   - Payout math correct for all launched tiers
 */

test("V7_LAUNCHED_TIERS rev 6: [2, 3, 5, 7] — 10% dropped, 7% added", () => {
  const launched = [...V7_LAUNCHED_TIERS].sort((a, b) => a - b);
  assert.deepEqual(launched, [2, 3, 5, 7],
    "Launched set must be 2/3/5/7 after rev 6");
  assert.ok(!launched.includes(10 as any),
    "10% must NOT be in launched set (Bullish has no strikes for 10% on 1-DTE)");
  assert.ok(launched.includes(7 as any),
    "7% must be in launched set (fills the demand gap between 5% and the dropped 10%)");
});

test("V7_SL_TIERS retains 10% for legacy data compatibility", () => {
  const all = [...V7_SL_TIERS].sort((a, b) => a - b);
  assert.deepEqual(all, [1, 2, 3, 5, 7, 10],
    "Type-level SL tier set must include 10 for legacy historical records");
});

test("isValidSlTier accepts 7%", () => {
  assert.equal(isValidSlTier(7), true, "7% must validate as a real tier");
  assert.equal(isValidSlTier(10), true, "10% must still validate (legacy data may exist)");
  assert.equal(isValidSlTier(2), true);
  assert.equal(isValidSlTier(8), false, "8% is NOT a launched tier");
  assert.equal(isValidSlTier(4), false);
});

test("7% payout = $700 per $10k notional", () => {
  assert.equal(getV7PayoutPer10k(7), 700, "7% × $10k = $700 payout");
});

test("7% tenor = 1 day (matches all other launched tiers)", () => {
  assert.equal(getV7TenorDays(7), 1);
});

test("7% payout calculation: $50k notional × 7% = $3500", () => {
  const payout = computeV7Payout(new Decimal(50000), 7);
  assert.equal(payout.toNumber(), 3500);
});

test("7% trigger price: $80k entry × (1 - 0.07) = $74,400", () => {
  const trigger = computeV7TriggerPrice(new Decimal(80000), 7, "long");
  assert.equal(trigger.toNumber(), 74400, "Long 7% trigger = entry × 0.93");
});

test("7% trigger price (short): $80k entry × (1 + 0.07) = $85,600", () => {
  const trigger = computeV7TriggerPrice(new Decimal(80000), 7, "short");
  assert.equal(trigger.toNumber(), 85600, "Short 7% trigger = entry × 1.07");
});

// ── Regime schedule rev 6 verification ──

test("REGIME_SCHEDULES Bundle C P3 LOCKED: 7% pricing across all regimes", () => {
  // Locked 2026-05-13 per Gate 1 operator sign-off
  assert.equal(REGIME_SCHEDULES.low[7], 3, "7% low (P3 calm) = $3/$1k");
  assert.equal(REGIME_SCHEDULES.moderate[7], 3.5, "7% moderate (P3 normal) = $3.50/$1k");
  assert.equal(REGIME_SCHEDULES.elevated[7], 5.25, "7% elevated (P3 mid) = $5.25/$1k");
  assert.equal(REGIME_SCHEDULES.high[7], 7, "7% high (P3 stress) = $7/$1k");
});

test("REGIME_SCHEDULES Bundle C P3 LOCKED: stress 2% lifted to $11/$1k", () => {
  // 2% high (stress) under P3 with rev 6 stress lift adjustment.
  // Pre-rev-6 was $13/$1k → 1.54× trader return.
  // Locked at $11/$1k → 1.82× trader return (above 2× psychological floor).
  assert.equal(REGIME_SCHEDULES.high[2], 11,
    "Stress 2% rate must be $11/$1k (not $13) to give 1.82× trader return on trigger");
});

test("REGIME_SCHEDULES rev 6: trader return on trigger for stress 2%", () => {
  // Premium per $10k = $11 × 10 = $110
  // Payout per $10k = $200
  // Return = 200 / 110 = 1.818...
  const stressPremiumPer10k = REGIME_SCHEDULES.high[2] * 10;
  const payoutPer10k = getV7PayoutPer10k(2);
  const returnOnTrigger = payoutPer10k / stressPremiumPer10k;
  assert.ok(returnOnTrigger >= 1.8 && returnOnTrigger < 1.9,
    `Stress 2% return on trigger should be ~1.8× (was 1.54× pre-rev-6); got ${returnOnTrigger.toFixed(2)}×`);
});

test("REGIME_SCHEDULES retains 10% for legacy display (P3 LOCKED values)", () => {
  // 10% is dropped from launched set but remains priced in schedule for
  // legacy display on triggered/expired protection records.
  // P3 locked values include 10% even though it's not offered.
  assert.equal(REGIME_SCHEDULES.low[10], 2);
  assert.equal(REGIME_SCHEDULES.moderate[10], 2.5);
  assert.equal(REGIME_SCHEDULES.elevated[10], 4.25);
  assert.equal(REGIME_SCHEDULES.high[10], 6);
});

test("getPremiumPer1kForRegime returns correct rates for all Bundle C P3 LOCKED tiers", () => {
  // Locked 2026-05-13. Numbers per REGIME_SCHEDULES (P3 cutover lock).
  const cases = [
    { tier: 2 as const, regime: "low" as const, expected: 10 },
    { tier: 2 as const, regime: "moderate" as const, expected: 10.5 },
    { tier: 2 as const, regime: "high" as const, expected: 11 },
    { tier: 3 as const, regime: "low" as const, expected: 7 },
    { tier: 3 as const, regime: "high" as const, expected: 11 },
    { tier: 5 as const, regime: "low" as const, expected: 4 },
    { tier: 5 as const, regime: "high" as const, expected: 9 },
    { tier: 7 as const, regime: "low" as const, expected: 3 },
    { tier: 7 as const, regime: "moderate" as const, expected: 3.5 },
    { tier: 7 as const, regime: "elevated" as const, expected: 5.25 },
    { tier: 7 as const, regime: "high" as const, expected: 7 }
  ];
  for (const c of cases) {
    const actual = getPremiumPer1kForRegime(c.tier, c.regime);
    assert.equal(actual, c.expected,
      `${c.tier}% in ${c.regime} regime: expected $${c.expected}/$1k, got $${actual}/$1k`);
  }
});

// ── Premium/payout math for typical position sizes (Bundle C user-facing) ──

test("Bundle C P3 LOCKED user-facing premiums for $50k 2% match table", () => {
  // From BUNDLE_C_PRICING_TABLE.md after Gate 1 lock to P3:
  //   Calm:   $500 premium / $1000 payout → 2.0× return
  //   Normal: $525 premium / $1000 payout → 1.9× return
  //   Stress: $550 premium / $1000 payout → 1.82× return
  const notional = 50000;
  const payout = notional * 0.02;
  assert.equal(payout, 1000);

  const calmPremium = notional * REGIME_SCHEDULES.low[2] / 1000;
  const normalPremium = notional * REGIME_SCHEDULES.moderate[2] / 1000;
  const stressPremium = notional * REGIME_SCHEDULES.high[2] / 1000;

  assert.equal(calmPremium, 500, "P3 calm 2% on $50k = $500 (2.0× return on trigger)");
  assert.equal(normalPremium, 525, "P3 normal 2% on $50k = $525");
  assert.equal(stressPremium, 550, "P3 stress 2% on $50k = $550 (1.82× return)");
});

test("Bundle C user-facing premiums for $50k 7% (NEW tier)", () => {
  // From BUNDLE_C_PRICING_TABLE.md rev 6:
  //   $50k 7% calm:  $150 premium / $3500 payout → 23.3× return
  //   $50k 7% normal: $175 premium / $3500 payout → 20.0× return
  //   $50k 7% stress: $350 premium / $3500 payout → 10.0× return
  const notional = 50000;
  // 50000 * 0.07 = 3500.0000000000005 due to fp; use Decimal-style payout helper
  const payout = computeV7Payout(new Decimal(notional), 7).toNumber();
  assert.equal(payout, 3500);

  // Bullet-proof against 50_000 * 3.5 / 1000 fp jitter (= 175.0000000000... vs 175)
  const round2 = (n: number) => Math.round(n * 100) / 100;
  assert.equal(round2(notional * REGIME_SCHEDULES.low[7] / 1000), 150);
  assert.equal(round2(notional * REGIME_SCHEDULES.moderate[7] / 1000), 175);
  assert.equal(round2(notional * REGIME_SCHEDULES.high[7] / 1000), 350);
});

// ── Regime classifier still works (no regression) ──

test("Pricing regime classifier unchanged by rev 6 schedule additions", () => {
  __resetPricingRegimeForTests();
  // DVOL boundaries unchanged; just adding 7% to the schedule shouldn't
  // affect classification logic.
  assert.equal(classifyPricingRegime(30), "low");
  assert.equal(classifyPricingRegime(55), "moderate");
  assert.equal(classifyPricingRegime(70), "elevated");
  assert.equal(classifyPricingRegime(85), "high");
});
