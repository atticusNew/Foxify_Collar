import assert from "node:assert/strict";
import test from "node:test";
import {
  compareHedgeArchitectures,
  optionSpreadDecisionBoundary,
  type BookSpec,
  type CostModel
} from "../src/singleSide/twoSided/creditCollar/hedgeArchitectureCompare";

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
  perpHalfSpreadBps: 1.5,
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
  const balanced = compareHedgeArchitectures(book({ longFraction: 0.5, netLongBias: 0.0, seed: 5 }), cost());
  const imbalanced = compareHedgeArchitectures(book({ longFraction: 0.85, netLongBias: 0.7, seed: 5 }), cost());
  assert.ok(imbalanced.internalizePerp.perpHedgeCostPerDayUsdc > balanced.internalizePerp.perpHedgeCostPerDayUsdc,
    "more imbalance ⟹ more residual delta ⟹ more perp hedge cost");
});
