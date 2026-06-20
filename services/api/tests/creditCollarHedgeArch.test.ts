import assert from "node:assert/strict";
import test from "node:test";
import {
  compareHedgeArchitectures,
  optionSpreadDecisionBoundary,
  internalizeLineFlowSensitivity,
  type BookSpec,
  type CostModel
} from "../src/singleSide/twoSided/creditCollar/hedgeArchitectureCompare";
import { wingAwareLegSpread } from "../src/singleSide/twoSided/creditCollar/skew";

const book = (over: Partial<BookSpec> = {}): BookSpec => ({
  spot: 100_000,
  tenorDays: 1,
  maxFloorPct: 0.04,
  atmIv: 0.55,
  skewSlopePer10pct: 0.12,
  dailyNotionalUsdc: 5_000_000,
  avgPositionNotionalUsdc: 50_000,
  notionalLogSdPct: 0.3,
  creditMode: "fixed_usdc",
  creditPerPositionUsdc: 100,
  creditBpsOfNotional: 2,
  longFraction: 0.55,
  netLongBias: 0.3,
  seed: 42,
  ...over
});

const cost = (over: Partial<CostModel> = {}): CostModel => ({
  profitBps: 1.5,
  minProfitUsdc: 12,
  optionRelHalfSpreadPct: 0.1,
  optionAbsHalfSpreadUsdcPerBtc: 1.5,
  backToBackWarehouseFraction: 0.15,
  nettingEfficiency: 1.0,
  perpTopOfBookBps: 1.5,
  perpDepthUsdc: 5_000_000,
  perpImpactCoefBps: 1.0,
  dailyRehedgeTurnover: 2,
  reserveMultiple: 1.5,
  costOfCapitalAnnual: 0.12,
  stressJumpPct: 0.12,
  ...over
});

test("at ~10% option half-spread, internalize+perp is cheaper for Foxify and surrenders less upside", () => {
  const cmp = compareHedgeArchitectures(book(), cost());
  assert.ok(cmp.foxifyCostSavingPerPositionUsdc > 0, "internalize must be cheaper for Foxify at 10% option spread");
  // Internalize is priced at mid ⟹ looser cap (Foxify keeps more upside).
  assert.ok(cmp.internalizePerp.medianCapPct >= cmp.backToBack.medianCapPct,
    "internalize cap must be >= back-to-back cap (less upside surrendered)");
});

test("Atticus keeps its clean profit in both architectures (apples-to-apples)", () => {
  const cmp = compareHedgeArchitectures(book(), cost());
  assert.ok(Math.abs(cmp.backToBack.atticusProfitPerDayUsdc - cmp.internalizePerp.atticusProfitPerDayUsdc) < 1,
    "Atticus profit is held equal across architectures");
  assert.ok(cmp.internalizePerp.atticusNetPerYearUsdc > 0, "Atticus net must be positive in internalize mode");
});

test("internalize reserve is larger than back-to-back reserve (gross netted book, not back-to-back residual)", () => {
  const cmp = compareHedgeArchitectures(book(), cost());
  assert.ok(cmp.internalizePerp.reserveUsdc > cmp.backToBack.reserveUsdc,
    "internalize warehouses more ⟹ larger reserve");
});

test("feasibility at low vol / thin skew widens under internalize+perp (crossing killed)", () => {
  const thin = { atmIv: 0.35, skewSlopePer10pct: 0.06, creditPerPositionUsdc: 100, avgPositionNotionalUsdc: 30_000 };
  const cmp = compareHedgeArchitectures(book(thin), cost());
  assert.ok(cmp.internalizePerp.feasibilityRate >= cmp.backToBack.feasibilityRate,
    "internalize cannot be LESS feasible than back-to-back");
});

test("decision boundary: back-to-back only wins at a tight enough option spread", () => {
  const db = optionSpreadDecisionBoundary(book(), cost(), [0.005, 0.01, 0.02, 0.05, 0.1, 0.15]);
  // At the widest spread, back-to-back must NOT be cheaper.
  const widest = db.rows[db.rows.length - 1];
  assert.equal(widest.backToBackCheaper, false);
  // back-to-back cost must increase with the option spread (internalize cost is flat in it).
  assert.ok(db.rows[db.rows.length - 1].backToBackFoxifyCostUsdc > db.rows[0].backToBackFoxifyCostUsdc);
});

test("perp residual hedge cost scales with net imbalance", () => {
  const balanced = compareHedgeArchitectures(book({ longFraction: 0.5, seed: 5 }), cost());
  const imbalanced = compareHedgeArchitectures(book({ longFraction: 0.85, seed: 5 }), cost());
  assert.ok(imbalanced.internalizePerp.perpHedgeCostPerDayUsdc > balanced.internalizePerp.perpHedgeCostPerDayUsdc,
    "more imbalance ⟹ more residual delta ⟹ more perp hedge cost");
});

test("flow concurrency: streaky/directional flow raises the internalize line (review #1)", () => {
  // Balanced book (50/50) so net is ~flat — concurrency is the ONLY driver of the residual.
  const b = book({ longFraction: 0.5, seed: 9 });
  const rows = internalizeLineFlowSensitivity(b, cost(), [1.0, 0.5, 0.0]);
  const wellNetted = rows[0];
  const fullyDirectional = rows[2];
  assert.ok(fullyDirectional.residualDeltaNotionalUsdc > wellNetted.residualDeltaNotionalUsdc,
    "no concurrency ⟹ Atticus warehouses gross ⟹ larger residual");
  assert.ok(fullyDirectional.perpHedgeCostPerDayUsdc > wellNetted.perpHedgeCostPerDayUsdc);
  assert.ok(fullyDirectional.internalizeFoxifyCostPerPositionUsdc >= wellNetted.internalizeFoxifyCostPerPositionUsdc,
    "streaky flow makes internalize more expensive for Foxify");
});

test("reserve stresses BOTH wings; binds on the concentrated side (review #2)", () => {
  const longHeavy = compareHedgeArchitectures(book({ longFraction: 0.85, seed: 3 }), cost());
  assert.equal(longHeavy.internalizePerp.reserveBindingWing, "down", "long-heavy book ⟹ put wing binds on a −jump");
  assert.ok(longHeavy.internalizePerp.reserveDownWingUsdc > longHeavy.internalizePerp.reserveUpWingUsdc);

  const shortHeavy = compareHedgeArchitectures(book({ longFraction: 0.15, seed: 3 }), cost());
  assert.equal(shortHeavy.internalizePerp.reserveBindingWing, "up", "short-heavy book ⟹ call wing binds on a +jump");
  assert.ok(shortHeavy.internalizePerp.reserveUpWingUsdc > shortHeavy.internalizePerp.reserveDownWingUsdc);
});

test("wing-aware option spread costs more than a flat ATM-equivalent (review #3a)", () => {
  const flat = compareHedgeArchitectures(book(), cost({ optionRelHalfSpreadPct: 0.05 }));
  // Same 5% ATM, but widening with OTM moneyness at the actual wing strikes.
  const wing = compareHedgeArchitectures(
    book(),
    cost({ optionLegSpread: wingAwareLegSpread({ atmRelHalfPct: 0.05, widenPerOtmPct: 0.5, absUsdcPerBtc: 1.5 }) })
  );
  assert.ok(wing.backToBack.foxifyCostPerPositionUsdc > flat.backToBack.foxifyCostPerPositionUsdc,
    "wing widening must raise back-to-back cost vs a flat ATM capture");
});

test("perp impact at clip: thinner depth raises the residual hedge cost (review #3b)", () => {
  const deep = compareHedgeArchitectures(book({ longFraction: 0.8, seed: 11 }), cost({ perpDepthUsdc: 50_000_000 }));
  const thin = compareHedgeArchitectures(book({ longFraction: 0.8, seed: 11 }), cost({ perpDepthUsdc: 2_000_000 }));
  assert.ok(thin.internalizePerp.perpHedgeCostPerDayUsdc > deep.internalizePerp.perpHedgeCostPerDayUsdc,
    "a clip that walks thin depth costs more than one into deep depth");
});
