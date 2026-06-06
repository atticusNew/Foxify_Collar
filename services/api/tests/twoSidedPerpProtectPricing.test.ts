/**
 * Perp Protect underwriter pricing — Decimal risk-component build-up.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRetailPremium, makePerpProtectPricer, pricingConfigFromEnv,
  DEFAULT_PRICING_CONFIG, type PerpProtectPricingConfig
} from "../src/singleSide/twoSided/perpProtectPricing";
import type { OptionPriceCtx } from "../src/singleSide/twoSided/perpProtectQuote";

const ctx = (over: Partial<OptionPriceCtx> = {}): OptionPriceCtx => ({
  notionalUsdc: 60000, marginUsdc: 3000, tenorDays: 7, spreadPct: 0.05, structure: "single", leverage: 20, ...over
});

test("retail premium = sum of components and exceeds hedge cost", () => {
  const b = computeRetailPremium(900, ctx());
  const sum = b.hedge_cost_usdc + b.slippage_buffer_usdc + b.tail_load_usdc + b.capital_charge_usdc + b.atticus_margin_usdc;
  assert.ok(Math.abs(b.retail_premium_usdc - sum) <= 0.02, `retail ${b.retail_premium_usdc} ≈ ${sum}`);
  assert.ok(b.retail_premium_usdc > b.hedge_cost_usdc);
  assert.equal(b.hedge_cost_usdc, 900);
});

test("slippage buffer scales with book spread, clamped to bounds", () => {
  const tight = computeRetailPremium(1000, ctx({ spreadPct: 0.02 })); // 0.5*0.02=0.01 → min floor 0.01
  const wide = computeRetailPremium(1000, ctx({ spreadPct: 0.5 }));   // 0.5*0.5=0.25 → cap 0.10
  assert.equal(tight.slippage_buffer_usdc, 10);  // 1000 * 0.01
  assert.equal(wide.slippage_buffer_usdc, 100);  // 1000 * 0.10 (capped)
});

test("unknown spread uses the conservative assumed spread", () => {
  const b = computeRetailPremium(1000, ctx({ spreadPct: null }));
  // 0.5 * 0.06 = 0.03 → 1000 * 0.03 = 30
  assert.equal(b.slippage_buffer_usdc, 30);
});

test("spreads carry a higher tail load than singles", () => {
  const single = computeRetailPremium(500, ctx({ structure: "single" }));
  const spread = computeRetailPremium(500, ctx({ structure: "spread" }));
  // tail = notional * 5/1e4 = 30 single; × 2.5 = 75 spread
  assert.equal(single.tail_load_usdc, 30);
  assert.equal(spread.tail_load_usdc, 75);
});

test("capital charge scales with tenor", () => {
  const wk = computeRetailPremium(500, ctx({ tenorDays: 7 }));
  const mo = computeRetailPremium(500, ctx({ tenorDays: 28 }));
  // 60000 * 100/1e4 * d/365 = 600 * d/365
  assert.ok(Math.abs(wk.capital_charge_usdc - 600 * 7 / 365) <= 0.02);
  assert.ok(Math.abs(mo.capital_charge_usdc - 600 * 28 / 365) <= 0.02);
  assert.ok(mo.capital_charge_usdc > wk.capital_charge_usdc);
});

test("all-in load stays lean (sustainable, not a lowball, not gold-plated)", () => {
  const b = computeRetailPremium(900, ctx());
  const markup = (b.retail_premium_usdc - b.hedge_cost_usdc) / b.hedge_cost_usdc;
  assert.ok(markup > 0.05 && markup < 0.4, `all-in markup ${(markup * 100).toFixed(1)}% should be lean but real`);
});

test("min premium floor applies to tiny hedge costs", () => {
  const b = computeRetailPremium(0, ctx({ notionalUsdc: 0, tenorDays: 0 }));
  assert.equal(b.retail_premium_usdc, DEFAULT_PRICING_CONFIG.minPremiumUsdc);
});

test("makePerpProtectPricer conforms to the engine PremiumPricer", () => {
  const pricer = makePerpProtectPricer();
  const b = pricer(900, ctx());
  assert.ok(b.retail_premium_usdc > 900);
});

test("pricingConfigFromEnv parses overrides and rejects bad input", () => {
  const cfg: PerpProtectPricingConfig = pricingConfigFromEnv({ PERP_PROTECT_ATTICUS_MARGIN_PCT: "0.2", PERP_PROTECT_TAIL_LOAD_BPS: "nope" } as NodeJS.ProcessEnv);
  assert.equal(cfg.atticusMarginPct, 0.2);
  assert.equal(cfg.tailLoadBps, DEFAULT_PRICING_CONFIG.tailLoadBps);
});
