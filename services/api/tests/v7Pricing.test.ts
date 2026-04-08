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

test("getV7PremiumPer1k — CALM premiums", () => {
  assert.equal(getV7PremiumPer1k(1, "calm"), 5);
  assert.equal(getV7PremiumPer1k(2, "calm"), 3);
  assert.equal(getV7PremiumPer1k(3, "calm"), 2);
  assert.equal(getV7PremiumPer1k(5, "calm"), 2);
  assert.equal(getV7PremiumPer1k(10, "calm"), 1);
});

test("getV7PremiumPer1k — NORMAL premiums", () => {
  assert.equal(getV7PremiumPer1k(1, "normal"), 9);
  assert.equal(getV7PremiumPer1k(2, "normal"), 6);
  assert.equal(getV7PremiumPer1k(3, "normal"), 5);
  assert.equal(getV7PremiumPer1k(5, "normal"), 4);
  assert.equal(getV7PremiumPer1k(10, "normal"), 2);
});

test("getV7PremiumPer1k — STRESS premiums (1% paused)", () => {
  assert.equal(getV7PremiumPer1k(1, "stress"), null);
  assert.equal(getV7PremiumPer1k(2, "stress"), 13);
  assert.equal(getV7PremiumPer1k(3, "stress"), 12);
  assert.equal(getV7PremiumPer1k(5, "stress"), 10);
  assert.equal(getV7PremiumPer1k(10, "stress"), 6);
});

test("getV7PayoutPer10k — correct payouts", () => {
  assert.equal(getV7PayoutPer10k(1), 100);
  assert.equal(getV7PayoutPer10k(2), 200);
  assert.equal(getV7PayoutPer10k(3), 300);
  assert.equal(getV7PayoutPer10k(5), 500);
  assert.equal(getV7PayoutPer10k(10), 1000);
});

test("computeV7Premium — $10k CALM 2% SL", () => {
  const r = computeV7Premium({ slPct: 2, regime: "calm", notionalUsd: 10000, dvol: 35, regimeSource: "dvol" });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 3);
  assert.equal(r.premiumUsd, 30);
  assert.equal(r.payoutPer10kUsd, 200);
});

test("computeV7Premium — $10k NORMAL 5% SL", () => {
  const r = computeV7Premium({ slPct: 5, regime: "normal", notionalUsd: 10000, dvol: 50, regimeSource: "dvol" });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 4);
  assert.equal(r.premiumUsd, 40);
  assert.equal(r.payoutPer10kUsd, 500);
});

test("computeV7Premium — STRESS 1% SL paused", () => {
  const r = computeV7Premium({ slPct: 1, regime: "stress", notionalUsd: 10000, dvol: 70, regimeSource: "dvol" });
  assert.ok(!r.available);
  assert.equal(r.reason, "paused_in_stress");
  assert.equal(r.premiumUsd, 0);
});

test("computeV7Premium — STRESS 2% SL active", () => {
  const r = computeV7Premium({ slPct: 2, regime: "stress", notionalUsd: 10000, dvol: 70, regimeSource: "dvol" });
  assert.ok(r.available);
  assert.equal(r.premiumPer1kUsd, 13);
  assert.equal(r.premiumUsd, 130);
});

test("computeV7Premium — linear scaling", () => {
  const r1 = computeV7Premium({ slPct: 3, regime: "normal", notionalUsd: 5000, dvol: 50, regimeSource: "dvol" });
  const r2 = computeV7Premium({ slPct: 3, regime: "normal", notionalUsd: 25000, dvol: 50, regimeSource: "dvol" });
  assert.equal(r1.premiumUsd, 25);
  assert.equal(r2.premiumUsd, 125);
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

test("getV7AvailableTiers — CALM all available", () => {
  const tiers = getV7AvailableTiers("calm");
  assert.equal(tiers.length, 5);
  assert.ok(tiers.every(t => t.available));
});

test("getV7AvailableTiers — STRESS has 1% paused", () => {
  const tiers = getV7AvailableTiers("stress");
  const sl1 = tiers.find(t => t.slPct === 1);
  assert.ok(!sl1?.available);
  assert.equal(sl1?.premiumPer1kUsd, null);
  const sl2 = tiers.find(t => t.slPct === 2);
  assert.ok(sl2?.available);
  assert.equal(sl2?.premiumPer1kUsd, 13);
});

test("slPctToTierLabel", () => {
  assert.equal(slPctToTierLabel(1), "SL 1%");
  assert.equal(slPctToTierLabel(5), "SL 5%");
  assert.equal(slPctToTierLabel(10), "SL 10%");
});
