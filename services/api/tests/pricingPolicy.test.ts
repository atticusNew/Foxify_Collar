import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  resolvePremiumPricing,
  resolvePricingPolicyMode,
  resolveDefaultPricingPolicyConfig,
  type PricingPolicyConfig
} from "../src/pilot/pricingPolicy";

const baseConfig = (): PricingPolicyConfig => ({
  mode: "actuarial_strict",
  premiumPolicyMode: "pass_through_markup",
  premiumMarkupPct: new Decimal("0.06"),
  premiumFloorUsd: new Decimal("20"),
  premiumFloorBps: new Decimal("6"),
  triggerCreditFloorPct: new Decimal("0.03"),
  expectedTriggerBreachProb: new Decimal("0.25"),
  triggerCreditWeight: new Decimal("0.35"),
  profitabilityBufferPct: new Decimal("0.015"),
  baseFeeUsd: new Decimal("5"),
  markupFactor: new Decimal("1.5"),
  claimsCoverageFactor: new Decimal("0.35"),
  triggerProbCap: new Decimal("0.2"),
  hybridStrictMultiplier: new Decimal("0.65"),
  notionalBands: [
    { maxNotionalUsd: new Decimal("1500"), floorUsd: new Decimal("10") },
    { maxNotionalUsd: new Decimal("3000"), floorUsd: new Decimal("15") },
    { maxNotionalUsd: new Decimal("6000"), floorUsd: new Decimal("20") },
    { maxNotionalUsd: new Decimal("10000"), floorUsd: new Decimal("25") },
    { maxNotionalUsd: null, floorUsd: new Decimal("35") }
  ],
  selectionFeasibilityPenaltyScale: new Decimal("1")
});

test("resolvePricingPolicyMode defaults and parses hybrid mode", () => {
  assert.equal(resolvePricingPolicyMode(undefined), "actuarial_strict");
  assert.equal(resolvePricingPolicyMode("HYBRID_OTM_TREASURY"), "hybrid_otm_treasury");
  assert.equal(resolvePricingPolicyMode("actuarial_strict"), "actuarial_strict");
});

test("actuarial_strict mode keeps profitability floor behavior", () => {
  const result = resolvePremiumPricing({
    config: baseConfig(),
    protectedNotional: new Decimal("5000"),
    drawdownFloorPct: new Decimal("0.2"),
    hedgePremium: new Decimal("50"),
    brokerFees: new Decimal("0")
  });
  assert.equal(result.method, "floor_profitability");
  assert.equal(result.clientPremiumUsd.toFixed(10), "212.5000000000");
  assert.equal(result.strictClientPremiumUsd.toFixed(10), "212.5000000000");
  assert.equal(result.premiumProfitabilityTargetUsd.toFixed(10), "212.5000000000");
  assert.equal(result.expectedClaimsUsd.toFixed(10), "250.0000000000");
});

test("hybrid_otm_treasury mode discounts strict pricing by configured multiplier", () => {
  const config = { ...baseConfig(), mode: "hybrid_otm_treasury" as const };
  const result = resolvePremiumPricing({
    config,
    protectedNotional: new Decimal("5000"),
    drawdownFloorPct: new Decimal("0.2"),
    hedgePremium: new Decimal("50"),
    brokerFees: new Decimal("0")
  });
  assert.equal(result.method, "hybrid_strict_discount");
  assert.equal(result.strictClientPremiumUsd.toFixed(10), "212.5000000000");
  assert.equal(result.hybridStrictMultiplier.toFixed(10), "0.6500000000");
  assert.equal(result.hybridDiscountedStrictPremiumUsd.toFixed(10), "138.1250000000");
  assert.equal(result.clientPremiumUsd.toFixed(10), "138.1250000000");
});

test("hybrid_otm_treasury mode keeps actuarial expected claims diagnostics", () => {
  const config = {
    ...baseConfig(),
    mode: "hybrid_otm_treasury" as const,
    expectedTriggerBreachProb: new Decimal("0.9"),
    triggerProbCap: new Decimal("0.2")
  };
  const result = resolvePremiumPricing({
    config,
    protectedNotional: new Decimal("5000"),
    drawdownFloorPct: new Decimal("0.2"),
    hedgePremium: new Decimal("20"),
    brokerFees: new Decimal("0")
  });
  assert.equal(result.expectedTriggerProbRaw.toFixed(10), "0.9000000000");
  assert.equal(result.expectedTriggerProbCapped.toFixed(10), "0.9000000000");
  assert.equal(result.expectedClaimsUsd.toFixed(10), "900.0000000000");
  assert.equal(result.strictClientPremiumUsd.toFixed(10), "410.0000000000");
  assert.equal(result.clientPremiumUsd.toFixed(10), "266.5000000000");
});

test("resolveDefaultPricingPolicyConfig returns sane defaults", () => {
  const cfg = resolveDefaultPricingPolicyConfig({
    policyMode: "pass_through_markup",
    pricingMode: "actuarial_strict",
    markupPct: 0.06,
    floorUsd: 20,
    floorBps: 6,
    triggerCreditFloorPct: 0.03,
    expectedTriggerBreachProb: 0.25,
    triggerCreditWeight: 0.35,
    profitabilityBufferPct: 0.015,
    hybridStrictMultiplier: 0.65,
    selectionFeasibilityPenaltyScale: 1
  });
  assert.equal(cfg.mode, "actuarial_strict");
  assert.equal(cfg.baseFeeUsd.toFixed(10), "5.0000000000");
  assert.equal(cfg.markupFactor.toFixed(10), "1.5000000000");
  assert.equal(cfg.claimsCoverageFactor.toFixed(10), "0.3000000000");
  assert.equal(cfg.triggerProbCap.toFixed(10), "0.2000000000");
  assert.equal(cfg.hybridStrictMultiplier.toFixed(10), "0.6500000000");
  assert.equal(cfg.notionalBands.length, 5);
});
