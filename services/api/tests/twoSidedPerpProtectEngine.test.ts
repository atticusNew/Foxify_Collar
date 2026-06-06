/**
 * Perp Protect engine upgrade — liquidation-interaction (whipsaw) model, protects_before_liq,
 * de-dup, recommended default, pricer injection, liquidation_prevented flag.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSingleOption, buildPerpProtectQuote, pickRecommendedOption,
  type PerpPosition, type PremiumPricer
} from "../src/singleSide/twoSided/perpProtectQuote";

const longPos: PerpPosition = { spot: 60000, entryPrice: 60000, sizeBtc: 1, side: "long", leverage: 10, tenorDays: 7 };
// liq price = 54000, margin = 6000.

test("leveraged + not prevented: whipsaw_exposed, risk = margin + premium", () => {
  const o = buildSingleOption(longPos, { strike: 57000, askUsdcPerBtc: 800 }, 0);
  assert.equal(o.whipsaw_exposed, true);
  assert.equal(o.liquidation_whipsaw_risk_usdc, 6800); // 6000 margin + 800 premium
  assert.equal(o.protects_before_liq, true); // 57000 >= 54000 liq
  assert.equal(o.worst_case_usdc, 3800);     // held-to-expiry cap unchanged
});

test("liquidationPrevented=true: hard cap is truly hard, no whipsaw", () => {
  const o = buildSingleOption({ ...longPos, liquidationPrevented: true }, { strike: 57000, askUsdcPerBtc: 800 }, 0);
  assert.equal(o.whipsaw_exposed, false);
  assert.equal(o.liquidation_whipsaw_risk_usdc, null);
});

test("1× (not liquidatable): no whipsaw exposure", () => {
  const o = buildSingleOption({ ...longPos, leverage: 1 }, { strike: 54000, askUsdcPerBtc: 800 }, 0);
  assert.equal(o.whipsaw_exposed, false);
  assert.equal(o.liquidation_whipsaw_risk_usdc, null);
});

test("protects_before_liq false when strike sits beyond the liq price", () => {
  const o = buildSingleOption(longPos, { strike: 53000, askUsdcPerBtc: 400 }, 0); // 53000 < 54000 liq
  assert.equal(o.protects_before_liq, false);
});

test("de-dup: two singles snapping to the same strike collapse to one", () => {
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 57000, askUsdcPerBtc: 800 }, { strike: 57000, askUsdcPerBtc: 810 }]
  });
  assert.equal(q.options.length, 1);
});

test("recommended: exactly one, and it is a capped single (never a spread)", () => {
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 58000, askUsdcPerBtc: 1200 }, { strike: 57000, askUsdcPerBtc: 800 }, { strike: 55500, askUsdcPerBtc: 400 }],
    spread: { long: { strike: 57000, askUsdcPerBtc: 800 }, short: { strike: 54500, askUsdcPerBtc: 0, bidUsdcPerBtc: 300 } }
  });
  const recommended = q.options.filter((o) => o.recommended);
  assert.equal(recommended.length, 1);
  assert.equal(recommended[0].capped, true);
});

test("pricer injection raises premium and surfaces the breakdown", () => {
  const pricer: PremiumPricer = (hedge) => ({
    hedge_cost_usdc: hedge, slippage_buffer_usdc: 10, tail_load_usdc: 5,
    capital_charge_usdc: 3, atticus_margin_usdc: 0.2 * hedge,
    retail_premium_usdc: hedge + 10 + 5 + 3 + 0.2 * hedge
  });
  const o = buildSingleOption(longPos, { strike: 57000, askUsdcPerBtc: 800 }, 0, pricer);
  assert.equal(o.hedge_cost_usdc, 800);
  assert.equal(o.premium_usdc, 800 + 10 + 5 + 3 + 160); // 978
  assert.equal(o.worst_case_usdc, 3000 + 978);          // (60000-57000) + retail premium
  assert.equal(o.premium_breakdown.atticus_margin_usdc, 160);
});

test("liquidation_prevented surfaced on the quote", () => {
  const a = buildPerpProtectQuote(longPos, { singles: [{ strike: 57000, askUsdcPerBtc: 800 }] });
  assert.equal(a.liquidation_prevented, false);
  const b = buildPerpProtectQuote({ ...longPos, liquidationPrevented: true }, { singles: [{ strike: 57000, askUsdcPerBtc: 800 }] });
  assert.equal(b.liquidation_prevented, true);
});

test("pickRecommendedOption prefers a strike that protects before liq", () => {
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 57000, askUsdcPerBtc: 800 }, { strike: 53000, askUsdcPerBtc: 300 }]
  });
  const rec = pickRecommendedOption(q.options, 6000);
  const recOpt = q.options.find((o) => o.id === rec);
  assert.equal(recOpt?.protects_before_liq, true);
});
