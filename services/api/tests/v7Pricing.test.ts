import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  computeV7Premium,
  isValidSlTier,
  getV7PremiumPer1k,
  getV7TenorDays,
  getV7PayoutPer10k,
  slPctToDrawdownFloor,
  computeV7Payout,
  computeV7TriggerPrice,
  computeV7HedgeStrike,
  getV7AvailableTiers,
  slPctToTierLabel
} from "../src/pilot/v7Pricing";

test("isValidSlTier — accepts valid tiers (Bundle C rev 6: 1/2/3/5/7/10)", () => {
  assert.ok(isValidSlTier(1));
  assert.ok(isValidSlTier(2));
  assert.ok(isValidSlTier(3));
  assert.ok(isValidSlTier(5));
  assert.ok(isValidSlTier(7), "7% added in rev 6");
  assert.ok(isValidSlTier(10), "10% retained in V7_SL_TIERS for legacy data");
});

test("isValidSlTier — rejects invalid tiers", () => {
  assert.ok(!isValidSlTier(0));
  assert.ok(!isValidSlTier(4));
  assert.ok(!isValidSlTier(6));
  assert.ok(!isValidSlTier(15));
  assert.ok(!isValidSlTier(20));
});

test("getV7PremiumPer1k — legacy static fallback rates (tight SL costs more)", () => {
  // Design A (2026-04-19) made pricing regime-aware. The legacy static
  // table is now only consulted when useLegacyStaticRate=true, which
  // is only meaningful in unit tests like this one. Production calls
  // go through the live pricing regime (low/moderate/elevated/high).
  // Static fallback values match the "low" regime to preserve
  // backwards compatibility for any caller that bypasses regime.
  const opts = { useLegacyStaticRate: true } as const;
  assert.equal(getV7PremiumPer1k(1, opts), 6);
  assert.equal(getV7PremiumPer1k(2, opts), 6);
  assert.equal(getV7PremiumPer1k(3, opts), 5);
  assert.equal(getV7PremiumPer1k(5, opts), 3);
  assert.equal(getV7PremiumPer1k(10, opts), 2);
});

test("getV7PayoutPer10k — correct payouts", () => {
  assert.equal(getV7PayoutPer10k(1), 100);
  assert.equal(getV7PayoutPer10k(2), 200);
  assert.equal(getV7PayoutPer10k(3), 300);
  assert.equal(getV7PayoutPer10k(5), 500);
  assert.equal(getV7PayoutPer10k(10), 1000);
});

test("computeV7Premium — $10k tiered pricing (low regime, P3)", () => {
  // Bundle C P3 lock (2026-05-13): low / 2% = $10/$1k.
  const r = computeV7Premium({ slPct: 2, notionalUsd: 10000, pricingRegimeOverride: "low" });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 10, "P3 low / 2% = $10");
  assert.equal(r.premiumUsd, 100);
  assert.equal(r.payoutPer10kUsd, 200);
});

test("computeV7Premium — each tier has correct rate per regime (P3)", () => {
  // Bundle C P3 schedule across all 4 regimes for all 6 tiers
  // (1/2/3/5/7/10 — 7 added in rev 6, 10 kept in schedule for legacy).
  const cases: Array<{ regime: "low" | "moderate" | "elevated" | "high"; expected: Record<number, number> }> = [
    { regime: "low",      expected: { 1: 65,  2: 100,   3: 70,   5: 40,   7: 30,   10: 20  } },
    { regime: "moderate", expected: { 1: 70,  2: 105,   3: 75,   5: 45,   7: 35,   10: 25  } },
    { regime: "elevated", expected: { 1: 80,  2: 107.5, 3: 92.5, 5: 67.5, 7: 52.5, 10: 42.5 } },
    { regime: "high",     expected: { 1: 90,  2: 110,   3: 110,  5: 90,   7: 70,   10: 60  } }
  ];
  for (const { regime, expected } of cases) {
    for (const sl of [1, 2, 3, 5, 7, 10] as const) {
      const r = computeV7Premium({ slPct: sl, notionalUsd: 10000, pricingRegimeOverride: regime });
      assert.ok(r.available);
      // Use rounding to avoid float-precision noise on values like $107.50
      const actual = Math.round(r.premiumUsd * 100) / 100;
      assert.equal(actual, expected[sl], `P3 ${regime} / ${sl}% on $10k = $${expected[sl]}`);
    }
  }
});

test("computeV7Premium — linear scaling", () => {
  // Pin the pricing regime so this test is decoupled from any DVOL state
  // a prior test in the same process may have seeded into the regime
  // classifier rolling window. P3 low / 5% = $4/$1k.
  const r1 = computeV7Premium({ slPct: 5, notionalUsd: 5000, pricingRegimeOverride: "low" });
  const r2 = computeV7Premium({ slPct: 5, notionalUsd: 25000, pricingRegimeOverride: "low" });
  assert.equal(r1.premiumUsd, 20, "P3 low / 5% on $5k = $20");
  assert.equal(r2.premiumUsd, 100, "P3 low / 5% on $25k = $100");
  assert.equal(r2.premiumUsd / r1.premiumUsd, 5, "linear scaling: 5x notional → 5x premium");
});

test("slPctToDrawdownFloor — conversions", () => {
  assert.equal(slPctToDrawdownFloor(1).toNumber(), 0.01);
  assert.equal(slPctToDrawdownFloor(2).toNumber(), 0.02);
  assert.equal(slPctToDrawdownFloor(5).toNumber(), 0.05);
  assert.equal(slPctToDrawdownFloor(10).toNumber(), 0.10);
});

test("computeV7Payout", () => {
  assert.equal(computeV7Payout(new Decimal(10000), 2).toNumber(), 200);
  assert.equal(computeV7Payout(new Decimal(10000), 5).toNumber(), 500);
  assert.equal(computeV7Payout(new Decimal(50000), 1).toNumber(), 500);
});

test("computeV7TriggerPrice — long", () => {
  const t = computeV7TriggerPrice(new Decimal(70000), 2, "long");
  assert.equal(t.toNumber(), 68600);
});

test("computeV7TriggerPrice — short", () => {
  const t = computeV7TriggerPrice(new Decimal(70000), 2, "short");
  assert.equal(t.toNumber(), 71400);
});

test("computeV7HedgeStrike equals trigger", () => {
  const s = computeV7HedgeStrike(new Decimal(70000), 2, "long");
  const t = computeV7TriggerPrice(new Decimal(70000), 2, "long");
  assert.ok(s.eq(t));
});

test("getV7AvailableTiers — launched tiers (rev 6: [2,3,5,7]), pinned to 'low' regime", () => {
  // Bundle C rev 6: V7_LAUNCHED_TIERS = [2, 3, 5, 7]. 10% dropped from
  // launched set (still in V7_SL_TIERS for legacy data). 1% remains
  // unlaunched.
  const tiers = getV7AvailableTiers(undefined, "low");
  assert.equal(tiers.length, 4, "rev 6: 4 launched tiers (2/3/5/7)");
  assert.ok(tiers.every(t => t.available));
  assert.ok(!tiers.find(t => t.slPct === 1), "1% unlaunched");
  assert.ok(!tiers.find(t => t.slPct === 10), "10% dropped from launched set in rev 6");
  const sl2 = tiers.find(t => t.slPct === 2);
  assert.equal(sl2?.premiumPer1kUsd, 10, "P3 low / 2% = $10");
  assert.equal(sl2?.tenorDays, 1);
  const sl7 = tiers.find(t => t.slPct === 7);
  assert.equal(sl7?.premiumPer1kUsd, 3, "P3 low / 7% = $3 (NEW tier in rev 6)");
  assert.equal(sl7?.tenorDays, 1);
});

test("getV7AvailableTiers — high-regime schedule reflects P3 ceiling", () => {
  const tiers = getV7AvailableTiers(undefined, "high");
  const sl2 = tiers.find((t) => t.slPct === 2);
  assert.equal(sl2?.premiumPer1kUsd, 11, "P3 stress 2% = $11 (lifted from $13 to give 1.82× trader return)");
  const sl3 = tiers.find((t) => t.slPct === 3);
  assert.equal(sl3?.premiumPer1kUsd, 11, "P3 stress 3% = $11");
  const sl7 = tiers.find((t) => t.slPct === 7);
  assert.equal(sl7?.premiumPer1kUsd, 7, "P3 stress 7% = $7");
});

test("getV7TenorDays — 1d for all tiers", () => {
  // Tenor switched 2d → 1d on 2026-04-17 (see PR #18, docs sync).
  assert.equal(getV7TenorDays(1), 1);
  assert.equal(getV7TenorDays(2), 1);
  assert.equal(getV7TenorDays(3), 1);
  assert.equal(getV7TenorDays(5), 1);
  assert.equal(getV7TenorDays(7), 1);
  assert.equal(getV7TenorDays(10), 1);
});

test("slPctToTierLabel", () => {
  assert.equal(slPctToTierLabel(1), "SL 1%");
  assert.equal(slPctToTierLabel(5), "SL 5%");
  assert.equal(slPctToTierLabel(10), "SL 10%");
});
