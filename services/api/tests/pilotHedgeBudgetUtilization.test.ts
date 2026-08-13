import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHedgeBudgetUtilization,
  projectBurnRate,
  type HedgeBudgetCapVerdict
} from "../src/pilot/hedgeBudgetCap";

/**
 * WS#2 (Bundle C cutover, rev 6) — utilization band classifier tests.
 */

const verdict = (capUsd: number | null, cumulativeSpentUsd: number): HedgeBudgetCapVerdict => ({
  allowed: true,
  pilotDay: 1,
  capUsd,
  cumulativeSpentUsd,
  remainingUsd: capUsd === null ? null : Math.max(0, capUsd - cumulativeSpentUsd),
  projectedAfterUsd: cumulativeSpentUsd
});

test("Utilization OK band (<70% used)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 5000));
  assert.equal(u.level, "ok");
  assert.equal(u.pctUsed, 0.5);
});

test("Utilization WARN band (70-85% used)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 7500));
  assert.equal(u.level, "warn");
  assert.equal(u.pctUsed, 0.75);
});

test("Utilization ALERT band (85-95% used)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 9000));
  assert.equal(u.level, "alert");
  assert.equal(u.pctUsed, 0.9);
});

test("Utilization CRITICAL band (>=95% used)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 9500));
  assert.equal(u.level, "critical");
  assert.equal(u.pctUsed, 0.95);
});

test("Utilization CRITICAL when cap exceeded", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 12000));
  assert.equal(u.level, "critical", "Over-cap should still classify as critical");
  assert.equal(u.pctUsed, 1.2);
});

test("Utilization OK when no cap (Day 22+)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(null, 50000));
  assert.equal(u.level, "ok");
  assert.equal(u.pctUsed, 0);
  assert.equal(u.remainingUsd, null);
});

test("Boundary: exactly 70% = WARN", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 7000));
  assert.equal(u.level, "warn");
});

test("Boundary: exactly 85% = ALERT", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 8500));
  assert.equal(u.level, "alert");
});

test("Boundary: 69.99% = OK (just under)", () => {
  const u = evaluateHedgeBudgetUtilization(verdict(10000, 6999));
  assert.equal(u.level, "ok");
});

// ── Burn rate projection ──

test("Burn rate: $200 spent over 4 days = $50/day", () => {
  const p = projectBurnRate({ cumulativeSpentUsd: 200, capUsd: 1000, pilotDay: 4 });
  assert.equal(p.burnRateUsdPerDay, 50);
  // remaining $800 at $50/day = 16 days remaining
  assert.equal(p.daysRemainingAtCurrentRate, 16);
});

test("Burn rate: zero spend yields infinity days remaining → null", () => {
  const p = projectBurnRate({ cumulativeSpentUsd: 0, capUsd: 1000, pilotDay: 4 });
  assert.equal(p.burnRateUsdPerDay, 0);
  assert.equal(p.daysRemainingAtCurrentRate, null,
    "Zero burn rate must report null days remaining (avoid division by zero)");
});

test("Burn rate: no cap yields null daysRemaining", () => {
  const p = projectBurnRate({ cumulativeSpentUsd: 100, capUsd: null, pilotDay: 5 });
  assert.equal(p.burnRateUsdPerDay, 20);
  assert.equal(p.daysRemainingAtCurrentRate, null);
});

test("Burn rate: pilot day 0 yields zero burn rate (boundary)", () => {
  const p = projectBurnRate({ cumulativeSpentUsd: 50, capUsd: 1000, pilotDay: 0 });
  assert.equal(p.burnRateUsdPerDay, 0);
});

test("Burn rate: spent already exceeds cap = 0 days remaining", () => {
  const p = projectBurnRate({ cumulativeSpentUsd: 1500, capUsd: 1000, pilotDay: 5 });
  assert.equal(p.daysRemainingAtCurrentRate, 0,
    "Cap exceeded must report 0 days remaining (Math.max guard)");
});
