import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  computeV7Premium,
  isValidSlTier,
  getV7PremiumPer1k,
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

test("getV7PremiumPer1k — flat $8/1k for all tiers", () => {
  assert.equal(getV7PremiumPer1k(1), 8);
  assert.equal(getV7PremiumPer1k(2), 8);
  assert.equal(getV7PremiumPer1k(3), 8);
  assert.equal(getV7PremiumPer1k(5), 8);
  assert.equal(getV7PremiumPer1k(10), 8);
});

test("getV7PayoutPer10k — correct payouts", () => {
  assert.equal(getV7PayoutPer10k(1), 100);
  assert.equal(getV7PayoutPer10k(2), 200);
  assert.equal(getV7PayoutPer10k(3), 300);
  assert.equal(getV7PayoutPer10k(5), 500);
  assert.equal(getV7PayoutPer10k(10), 1000);
});

test("computeV7Premium — $10k flat $8/1k any tier", () => {
  const r = computeV7Premium({ slPct: 2, notionalUsd: 10000 });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 8);
  assert.equal(r.premiumUsd, 80);
  assert.equal(r.payoutPer10kUsd, 200);
});

test("computeV7Premium — all tiers same $8/1k", () => {
  for (const sl of [1, 2, 3, 5, 10] as const) {
    const r = computeV7Premium({ slPct: sl, notionalUsd: 10000 });
    assert.ok(r.available);
    assert.equal(r.premiumPer1kUsd, 8);
    assert.equal(r.premiumUsd, 80);
  }
});

test("computeV7Premium — 1% SL always available (no pause)", () => {
  const r = computeV7Premium({ slPct: 1, notionalUsd: 10000, regime: "stress" });
  assert.ok(r.available);
  assert.equal(r.premiumUsd, 80);
});

test("computeV7Premium — linear scaling", () => {
  const r1 = computeV7Premium({ slPct: 3, notionalUsd: 5000 });
  const r2 = computeV7Premium({ slPct: 3, notionalUsd: 25000 });
  assert.equal(r1.premiumUsd, 40);
  assert.equal(r2.premiumUsd, 200);
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

test("getV7AvailableTiers — all tiers available at flat $8", () => {
  const tiers = getV7AvailableTiers();
  assert.equal(tiers.length, 5);
  assert.ok(tiers.every(t => t.available));
  assert.ok(tiers.every(t => t.premiumPer1kUsd === 8));
});

test("slPctToTierLabel", () => {
  assert.equal(slPctToTierLabel(1), "SL 1%");
  assert.equal(slPctToTierLabel(5), "SL 5%");
  assert.equal(slPctToTierLabel(10), "SL 10%");
});
