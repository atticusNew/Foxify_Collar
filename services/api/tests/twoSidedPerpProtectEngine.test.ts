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

test("worst_case_pct_margin surfaces the HONEST cap as a share of margin (label can understate)", () => {
  // 20× long, margin = 3000. A near-money put whose premium dominates → worst case >> the
  // "X% of margin" intent label, so the true %-of-margin must be reported.
  const pos: PerpPosition = { spot: 60000, entryPrice: 60000, sizeBtc: 1, side: "long", leverage: 20, tenorDays: 7 };
  const o = buildSingleOption(pos, { strike: 59250, askUsdcPerBtc: 1500, label: "Cap 25% of margin" }, 0);
  // margin = 3000; worst = (60000-59250)*1 + 1500 = 2250; 2250/3000 = 0.75
  assert.equal(o.worst_case_pct_margin, 0.75);
  assert.ok(o.worst_case_pct_margin > 0.25); // honest number exceeds the intent label
});

test("pickRecommendedOption prefers a strike that protects before liq", () => {
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 57000, askUsdcPerBtc: 800 }, { strike: 53000, askUsdcPerBtc: 300 }]
  });
  const rec = pickRecommendedOption(q.options, 6000);
  const recOpt = q.options.find((o) => o.id === rec);
  assert.equal(recOpt?.protects_before_liq, true);
});

test("honesty guard: a 'Stay alive' strike snapped BELOW liq is relabeled as a plain floor", () => {
  // longPos: entry 60000, lev 10 → liq 54000. A "Stay alive" labeled strike at 53000 is BELOW liq
  // (does not protect before liquidation) → must be relabeled to a Floor, never left as "Stay alive".
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 53000, askUsdcPerBtc: 300, label: "Stay alive" }]
  });
  const o = q.options[0];
  assert.equal(o.protects_before_liq, false);
  assert.notEqual(o.label, "Stay alive");
  assert.match(o.label, /^Floor −/);
});

test("honesty guard: a 'Stay alive' strike inside liq keeps its label", () => {
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 55000, askUsdcPerBtc: 400, label: "Stay alive" }] // 55000 > 54000 liq
  });
  const o = q.options[0];
  assert.equal(o.protects_before_liq, true);
  assert.equal(o.label, "Stay alive");
});

test("pickRecommendedOption: cheapest option whose worst case is within the margin bound (best value)", () => {
  // longPos: entry 60000, size 1, lev 10 → margin 6000, liq 54000. All three protect before liq.
  // worst case = (60000−K)·1 + premium; pct of margin = worst/6000.
  //   58800 @300  → 1200+300=1500   (25.0%)
  //   57600 @180  → 2400+180=2580   (43.0%)
  //   55800 @90   → 4200+90 =4290   (71.5%, exceeds 60% bound)
  const q = buildPerpProtectQuote(longPos, {
    singles: [
      { strike: 58800, askUsdcPerBtc: 300 },
      { strike: 57600, askUsdcPerBtc: 180 },
      { strike: 55800, askUsdcPerBtc: 90 }
    ]
  });
  const rec = pickRecommendedOption(q.options, 6000, 0.6);
  const recOpt = q.options.find((o) => o.id === rec);
  // 55800 is cheapest but breaches the 60% bound; among acceptable (58800, 57600) the cheaper is 57600.
  assert.equal(recOpt?.strike, 57600);
  assert.equal(recOpt?.capped, true);
});

test("pickRecommendedOption: falls back to lowest worst case when none meet the bound", () => {
  // Tight bound (10%) that nothing satisfies → fall back to the pool, cheapest premium.
  const q = buildPerpProtectQuote(longPos, {
    singles: [{ strike: 58800, askUsdcPerBtc: 300 }, { strike: 57600, askUsdcPerBtc: 180 }]
  });
  const rec = pickRecommendedOption(q.options, 6000, 0.1);
  const recOpt = q.options.find((o) => o.id === rec);
  // No option ≤10% margin worst case → fallback cheapest premium = 57600.
  assert.equal(recOpt?.strike, 57600);
});
