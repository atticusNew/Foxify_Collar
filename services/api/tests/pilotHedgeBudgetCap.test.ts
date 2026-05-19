import assert from "node:assert/strict";
import test from "node:test";

import {
  configureHedgeBudgetCap,
  computePilotDay,
  getCapForDay,
  evaluateHedgeBudgetCap
} from "../src/pilot/hedgeBudgetCap";

// PR for hedge-budget cap (Foxify Pilot Agreement v2 §3.1) — pure
// policy module. Covers:
//   - day computation across the 4 phases (1-2, 3-7, 8-21, 22+)
//   - cap lookup at boundary days
//   - allow/deny verdicts at each phase
//   - enforce=false override
//   - missing pilot start (defaults to day 1)

const DAY_MS = 24 * 3600 * 1000;
const ISO_PILOT_START = "2026-04-23T00:00:00Z";
const PILOT_START_MS = Date.parse(ISO_PILOT_START);

test("computePilotDay: day 1 is the first 24h since start", () => {
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS), 1);
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 1000), 1);
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 23 * 3600 * 1000), 1);
  // Exactly 1 day in = day 2
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + DAY_MS), 2);
});

test("computePilotDay: phase boundaries", () => {
  // Day 7 = within first 7 days
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 6 * DAY_MS + 12 * 3600 * 1000), 7);
  // Day 8 = first day of the $10k phase
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 7 * DAY_MS), 8);
  // Day 21 = last day of $10k phase
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 20 * DAY_MS + 12 * 3600 * 1000), 21);
  // Day 22 = first day of unlimited phase
  assert.equal(computePilotDay(PILOT_START_MS, PILOT_START_MS + 21 * DAY_MS), 22);
});

test("computePilotDay: null start defaults to day 1", () => {
  assert.equal(computePilotDay(null, Date.now()), 1);
});

test("getCapForDay: matches v2 agreement schedule", () => {
  assert.equal(getCapForDay(1), 100);
  assert.equal(getCapForDay(2), 100);
  assert.equal(getCapForDay(3), 1000);
  assert.equal(getCapForDay(7), 1000);
  assert.equal(getCapForDay(8), 10000);
  assert.equal(getCapForDay(21), 10000);
  assert.equal(getCapForDay(22), null, "Day 22+ has no cap");
  assert.equal(getCapForDay(28), null);
  assert.equal(getCapForDay(100), null);
});

test("evaluateHedgeBudgetCap: allows trade within day-1 cap", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 50,
    prospectiveHedgeCostUsd: 30,
    nowMsEpoch: PILOT_START_MS + 1000  // day 1
  });
  assert.equal(v.allowed, true);
  assert.equal(v.pilotDay, 1);
  assert.equal(v.capUsd, 100);
  assert.equal(v.remainingUsd, 50);
  assert.equal(v.projectedAfterUsd, 80);
});

test("evaluateHedgeBudgetCap: rejects trade that would push over day-1 cap", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 90,
    prospectiveHedgeCostUsd: 30,
    nowMsEpoch: PILOT_START_MS + 1000
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "would_exceed_cap");
  assert.equal(v.pilotDay, 1);
  assert.equal(v.capUsd, 100);
  assert.equal(v.remainingUsd, 10);
  assert.equal(v.projectedAfterUsd, 120);
  assert.ok(v.message?.includes("Day 1"));
});

test("evaluateHedgeBudgetCap: day 5 has $1k cap", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 850,
    prospectiveHedgeCostUsd: 100,
    nowMsEpoch: PILOT_START_MS + 4 * DAY_MS + 1000  // day 5
  });
  assert.equal(v.allowed, true);
  assert.equal(v.pilotDay, 5);
  assert.equal(v.capUsd, 1000);
  assert.equal(v.remainingUsd, 150);
});

test("evaluateHedgeBudgetCap: day 10 has $10k cap", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 2500,
    prospectiveHedgeCostUsd: 200,
    nowMsEpoch: PILOT_START_MS + 9 * DAY_MS + 1000  // day 10
  });
  assert.equal(v.allowed, true);
  assert.equal(v.pilotDay, 10);
  assert.equal(v.capUsd, 10000);
  assert.equal(v.remainingUsd, 7500);
});

test("evaluateHedgeBudgetCap: day 22 has no cap, allows any size", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 50000,
    prospectiveHedgeCostUsd: 5000,
    nowMsEpoch: PILOT_START_MS + 21 * DAY_MS + 1000  // day 22
  });
  assert.equal(v.allowed, true);
  assert.equal(v.pilotDay, 22);
  assert.equal(v.capUsd, null);
  assert.equal(v.remainingUsd, null);
});

test("evaluateHedgeBudgetCap: enforce=false bypasses cap entirely", () => {
  configureHedgeBudgetCap({ enforce: false, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 999999,
    prospectiveHedgeCostUsd: 999999,
    nowMsEpoch: PILOT_START_MS + 1000
  });
  assert.equal(v.allowed, true, "enforce=false should always allow");
  // Fields still populated for observability
  assert.equal(v.pilotDay, 1);
  assert.equal(v.capUsd, 100);
});

test("evaluateHedgeBudgetCap: null pilot start treats as day 1", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: null });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: null,
    cumulativeSpentUsd: 0,
    prospectiveHedgeCostUsd: 50
  });
  assert.equal(v.pilotDay, 1);
  assert.equal(v.capUsd, 100);
  assert.equal(v.allowed, true);
});

test("evaluateHedgeBudgetCap: exact-equal-to-cap is allowed (boundary inclusive)", () => {
  configureHedgeBudgetCap({ enforce: true, pilotStartIso: ISO_PILOT_START });
  const v = evaluateHedgeBudgetCap({
    pilotStartMsEpoch: PILOT_START_MS,
    cumulativeSpentUsd: 50,
    prospectiveHedgeCostUsd: 50,  // exactly hits $100 cap
    nowMsEpoch: PILOT_START_MS + 1000
  });
  assert.equal(v.allowed, true, "Hitting cap exactly is allowed; only strict overage is blocked");
  assert.equal(v.projectedAfterUsd, 100);
});
