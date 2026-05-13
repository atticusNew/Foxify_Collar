import assert from "node:assert/strict";
import test from "node:test";
import { runScenario } from "../scripts/backtest/core/engine";
import { SCENARIOS } from "../scripts/backtest/scenarios/scenarios";
import { writeMarkdownReport } from "../scripts/backtest/core/scorecardWriter";

/**
 * Regression tests for the WS#9 backtest harness.
 *
 * The harness output is the gating evidence for Gate 1 operator review.
 * If anyone changes pricing schedules, tier mix, or engine math without
 * understanding the implications, these tests fail-fast.
 *
 * The headline numbers are pinned to current expectations; if they
 * shift materially, intentional re-anchoring should accompany the test
 * update so we have a paper trail of every economic assumption change.
 */

test("All 6 scenarios run without error and produce numeric outputs", () => {
  const scorecards = SCENARIOS.map(runScenario);
  assert.equal(scorecards.length, 6, "Should have exactly 6 scenarios");
  for (const s of scorecards) {
    assert.ok(Number.isFinite(s.pilotPnLProjected),
      `${s.scenarioName}: pilotPnLProjected must be a finite number`);
    assert.ok(s.totalProtectionsOpened > 0,
      `${s.scenarioName}: should open at least one protection`);
    assert.ok(s.totalNotionalUsd > 0,
      `${s.scenarioName}: should have positive notional`);
  }
});

test("S0 current baseline is structurally loss-making", () => {
  const s = runScenario(SCENARIOS.find(c => c.name === "S0_CURRENT_BASELINE")!);
  assert.ok(s.pilotPnLProjected < -5000,
    `S0 current pricing should lose at least \$5k over 28 days; got \$${s.pilotPnLProjected.toFixed(0)}`);
});

test("S3 Bundle C is profitable", () => {
  const s = runScenario(SCENARIOS.find(c => c.name === "S3_P3_BUNDLE_C")!);
  assert.ok(s.pilotPnLProjected > 0,
    `S3 Bundle C must project profitable pilot; got \$${s.pilotPnLProjected.toFixed(0)}`);
});

test("S3 Bundle C P&L within expected range (+$1k to +$8k)", () => {
  // Initial harness run on 2026-05-13 produced +$3,241.
  // Expected window is +$1k to +$8k — wider than the model midpoint to
  // accommodate small recalibrations of tier mix or recovery rate.
  // If this test fails, somebody changed an economic input assumption
  // and the change should be explicit + documented.
  const s = runScenario(SCENARIOS.find(c => c.name === "S3_P3_BUNDLE_C")!);
  assert.ok(s.pilotPnLProjected >= 1000 && s.pilotPnLProjected <= 8000,
    `S3 Bundle C should land between \$1k and \$8k; got \$${s.pilotPnLProjected.toFixed(0)}. ` +
    "If this is intentional, update the test with the new pin.");
});

test("Anti-bot defense materially improves S3 vs S5", () => {
  const withDefense = runScenario(SCENARIOS.find(c => c.name === "S3_P3_BUNDLE_C")!);
  const withoutDefense = runScenario(SCENARIOS.find(c => c.name === "S5_P3_NO_BOT_DEFENSE")!);
  const defenseValue = withDefense.pilotPnLProjected - withoutDefense.pilotPnLProjected;
  assert.ok(defenseValue > 1000,
    `Anti-bot defense should add at least \$1k of P&L; added \$${defenseValue.toFixed(0)}`);
});

test("Pricing scenario ordering is monotonic (current < P1 < P2 < P3)", () => {
  const s0 = runScenario(SCENARIOS.find(c => c.name === "S0_CURRENT_BASELINE")!);
  const s1 = runScenario(SCENARIOS.find(c => c.name === "S1_P1_AS_CODED")!);
  const s2 = runScenario(SCENARIOS.find(c => c.name === "S2_P2_LIFT_FLOORS")!);
  const s3 = runScenario(SCENARIOS.find(c => c.name === "S3_P3_BUNDLE_C")!);
  // Note: S0 and S1 use different tier mixes so direct comparison is
  // not perfectly fair; but P1 < P2 < P3 must hold (same config except pricing).
  assert.ok(s1.pilotPnLProjected < s2.pilotPnLProjected,
    "P1 < P2 (lifting pricing should improve P&L)");
  assert.ok(s2.pilotPnLProjected < s3.pilotPnLProjected,
    "P2 < P3 (more aggressive pricing should improve P&L further)");
  // S0 should be worst (current pricing + no bot defense)
  assert.ok(s0.pilotPnLProjected < s1.pilotPnLProjected);
});

test("Cap utilization stays under 100% for all Bundle C scenarios", () => {
  for (const cfg of SCENARIOS) {
    if (cfg.name === "S0_CURRENT_BASELINE") continue; // current uses different mix
    const s = runScenario(cfg);
    assert.ok(s.capUtilizationPct < 100,
      `${s.scenarioName}: cap utilization ${s.capUtilizationPct.toFixed(1)}% must be under 100%`);
  }
});

test("Engine is deterministic — same config twice yields same scorecard", () => {
  const cfg = SCENARIOS.find(c => c.name === "S3_P3_BUNDLE_C")!;
  const s1 = runScenario(cfg);
  const s2 = runScenario(cfg);
  assert.equal(s1.pilotPnLProjected, s2.pilotPnLProjected);
  assert.equal(s1.totalPremiumIncomeUsd, s2.totalPremiumIncomeUsd);
  assert.equal(s1.totalHedgeCostUsd, s2.totalHedgeCostUsd);
  assert.equal(s1.totalTriggersFired, s2.totalTriggersFired);
});

test("Scorecard writer produces non-empty Markdown for all scenarios", () => {
  const scorecards = SCENARIOS.map(runScenario);
  const md = writeMarkdownReport(scorecards);
  assert.ok(md.length > 1000, "Report should be substantial, not stubby");
  assert.ok(md.includes("Headline comparison"), "Should have headline section");
  assert.ok(md.includes("Gate 1 decision support"), "Should have Gate 1 section");
  for (const s of scorecards) {
    assert.ok(md.includes(s.scenarioName), `Scenario ${s.scenarioName} must appear in report`);
  }
});
