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

test("isValidSlTier — accepts valid tiers", () => {
  assert.ok(isValidSlTier(1));
  assert.ok(isValidSlTier(2));
  assert.ok(isValidSlTier(3));
  assert.ok(isValidSlTier(5));
  assert.ok(isValidSlTier(10));
});

test("isValidSlTier — rejects invalid tiers", () => {
  assert.ok(!isValidSlTier(0));
  assert.ok(!isValidSlTier(4));
  assert.ok(!isValidSlTier(7));
  assert.ok(!isValidSlTier(15));
  assert.ok(!isValidSlTier(20));
});

test("getV7PremiumPer1k — tiered rates", () => {
  assert.equal(getV7PremiumPer1k(1), 2);
  assert.equal(getV7PremiumPer1k(2), 3);
  assert.equal(getV7PremiumPer1k(3), 4);
  assert.equal(getV7PremiumPer1k(5), 6);
  assert.equal(getV7PremiumPer1k(10), 3);
});

test("getV7PayoutPer10k — correct payouts", () => {
  assert.equal(getV7PayoutPer10k(1), 100);
  assert.equal(getV7PayoutPer10k(2), 200);
  assert.equal(getV7PayoutPer10k(3), 300);
  assert.equal(getV7PayoutPer10k(5), 500);
  assert.equal(getV7PayoutPer10k(10), 1000);
});

test("computeV7Premium — $10k tiered pricing", () => {
  const r = computeV7Premium({ slPct: 2, notionalUsd: 10000 });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 3);
  assert.equal(r.premiumUsd, 30);
  assert.equal(r.payoutPer10kUsd, 200);
});

test("computeV7Premium — each tier has correct rate", () => {
  const expected: Record<number, number> = { 1: 20, 2: 30, 3: 40, 5: 60, 10: 30 };
  for (const sl of [1, 2, 3, 5, 10] as const) {
    const r = computeV7Premium({ slPct: sl, notionalUsd: 10000 });
    assert.ok(r.available);
    assert.equal(r.premiumUsd, expected[sl]);
  }
});

test("computeV7Premium — 1% SL always available", () => {
  const r = computeV7Premium({ slPct: 1, notionalUsd: 10000 });
  assert.ok(r.available);
  assert.equal(r.premiumUsd, 20);
});

test("computeV7Premium — linear scaling", () => {
  const r1 = computeV7Premium({ slPct: 3, notionalUsd: 5000 });
  const r2 = computeV7Premium({ slPct: 3, notionalUsd: 25000 });
  assert.equal(r1.premiumUsd, 20);
  assert.equal(r2.premiumUsd, 100);
  assert.equal(r2.premiumUsd / r1.premiumUsd, 5);
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

test("getV7AvailableTiers — all tiers available with correct rates", () => {
  const tiers = getV7AvailableTiers();
  assert.equal(tiers.length, 5);
  assert.ok(tiers.every(t => t.available));
  const sl2 = tiers.find(t => t.slPct === 2);
  assert.equal(sl2?.premiumPer1kUsd, 3);
  assert.equal(sl2?.tenorDays, 3);
  const sl10 = tiers.find(t => t.slPct === 10);
  assert.equal(sl10?.premiumPer1kUsd, 3);
  assert.equal(sl10?.tenorDays, 2);
});

test("getV7TenorDays — 3d for 1-5%, 2d for 10%", () => {
  assert.equal(getV7TenorDays(1), 3);
  assert.equal(getV7TenorDays(2), 3);
  assert.equal(getV7TenorDays(3), 3);
  assert.equal(getV7TenorDays(5), 3);
  assert.equal(getV7TenorDays(10), 2);
});

test("slPctToTierLabel", () => {
  assert.equal(slPctToTierLabel(1), "SL 1%");
  assert.equal(slPctToTierLabel(5), "SL 5%");
  assert.equal(slPctToTierLabel(10), "SL 10%");
});
