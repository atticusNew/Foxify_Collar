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

test("getV7PremiumPer1k — tiered rates (tight SL costs more)", () => {
  // Pre-launch calibration:
  //   2% SL: $5 → $6 (2026-04-18, DVOL-headroom bump)
  //   3% SL: $4 → $5 (2026-04-19, second-tier DVOL-headroom + anchor)
  // SL 1% remains $6 (unlaunched). 5% / 10% unchanged.
  assert.equal(getV7PremiumPer1k(1), 6);
  assert.equal(getV7PremiumPer1k(2), 6);
  assert.equal(getV7PremiumPer1k(3), 5);
  assert.equal(getV7PremiumPer1k(5), 3);
  assert.equal(getV7PremiumPer1k(10), 2);
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
  assert.equal(r.premiumPer1kUsd, 6);
  assert.equal(r.premiumUsd, 60);
  assert.equal(r.payoutPer10kUsd, 200);
});

test("computeV7Premium — each tier has correct rate", () => {
  const expected: Record<number, number> = { 1: 60, 2: 60, 3: 50, 5: 30, 10: 20 };
  for (const sl of [1, 2, 3, 5, 10] as const) {
    const r = computeV7Premium({ slPct: sl, notionalUsd: 10000 });
    assert.ok(r.available);
    assert.equal(r.premiumUsd, expected[sl]);
  }
});

test("computeV7Premium — linear scaling", () => {
  const r1 = computeV7Premium({ slPct: 5, notionalUsd: 5000 });
  const r2 = computeV7Premium({ slPct: 5, notionalUsd: 25000 });
  assert.equal(r1.premiumUsd, 15);
  assert.equal(r2.premiumUsd, 75);
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

test("getV7AvailableTiers — launched tiers (no 1% SL)", () => {
  const tiers = getV7AvailableTiers();
  assert.equal(tiers.length, 4);
  assert.ok(tiers.every(t => t.available));
  assert.ok(!tiers.find(t => t.slPct === 1));
  const sl2 = tiers.find(t => t.slPct === 2);
  assert.equal(sl2?.premiumPer1kUsd, 6);
  assert.equal(sl2?.tenorDays, 1);
  const sl10 = tiers.find(t => t.slPct === 10);
  assert.equal(sl10?.premiumPer1kUsd, 2);
  assert.equal(sl10?.tenorDays, 1);
});

test("getV7TenorDays — 1d for all tiers", () => {
  // Tenor switched 2d → 1d on 2026-04-17 (see PR #18, docs sync).
  assert.equal(getV7TenorDays(1), 1);
  assert.equal(getV7TenorDays(2), 1);
  assert.equal(getV7TenorDays(3), 1);
  assert.equal(getV7TenorDays(5), 1);
  assert.equal(getV7TenorDays(10), 1);
});

test("slPctToTierLabel", () => {
  assert.equal(slPctToTierLabel(1), "SL 1%");
  assert.equal(slPctToTierLabel(5), "SL 5%");
  assert.equal(slPctToTierLabel(10), "SL 10%");
});
