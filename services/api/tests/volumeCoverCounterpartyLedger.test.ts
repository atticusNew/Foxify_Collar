import assert from "node:assert/strict";
import test from "node:test";

import {
  nextFridayUtc,
  endOfMonthUtc,
  getConfiguredTrancheFractions,
  shouldHaltDueToCounterpartyExposure,
  type CounterpartySummary
} from "../src/volumeCover/counterpartyLedger";

const clearLedgerEnv = (): void => {
  delete process.env.VC_COUNTERPARTY_WEEKLY_FRACTION;
  delete process.env.VC_COUNTERPARTY_MONTHLY_FRACTION;
  delete process.env.VC_COUNTERPARTY_HALT_THRESHOLD_USDC;
};

test("nextFridayUtc: Monday returns the upcoming Friday", () => {
  // 2026-05-25 is a Monday (UTC)
  const monday = new Date(Date.UTC(2026, 4, 25));
  const friday = nextFridayUtc(monday);
  assert.equal(friday.toISOString().slice(0, 10), "2026-05-29");
});

test("nextFridayUtc: Friday returns the same Friday", () => {
  // 2026-05-22 is a Friday (UTC)
  const friday = new Date(Date.UTC(2026, 4, 22));
  const result = nextFridayUtc(friday);
  assert.equal(result.toISOString().slice(0, 10), "2026-05-22");
});

test("nextFridayUtc: Saturday returns the following Friday", () => {
  // 2026-05-23 is a Saturday
  const saturday = new Date(Date.UTC(2026, 4, 23));
  const result = nextFridayUtc(saturday);
  assert.equal(result.toISOString().slice(0, 10), "2026-05-29");
});

test("endOfMonthUtc: mid-month → end of same month", () => {
  const may15 = new Date(Date.UTC(2026, 4, 15));
  const eom = endOfMonthUtc(may15);
  assert.equal(eom.toISOString().slice(0, 10), "2026-05-31");
});

test("endOfMonthUtc: last day of month returns same day", () => {
  const may31 = new Date(Date.UTC(2026, 4, 31));
  const eom = endOfMonthUtc(may31);
  assert.equal(eom.toISOString().slice(0, 10), "2026-05-31");
});

test("endOfMonthUtc: February (non-leap) → 28th", () => {
  const feb15 = new Date(Date.UTC(2027, 1, 15));
  const eom = endOfMonthUtc(feb15);
  assert.equal(eom.toISOString().slice(0, 10), "2027-02-28");
});

test("getConfiguredTrancheFractions: defaults are 25%/75%", () => {
  clearLedgerEnv();
  const f = getConfiguredTrancheFractions();
  assert.equal(f.weekly, 0.25);
  assert.equal(f.monthly, 0.75);
});

test("getConfiguredTrancheFractions: env overrides honored when sum = 1.0", () => {
  process.env.VC_COUNTERPARTY_WEEKLY_FRACTION = "0.3";
  process.env.VC_COUNTERPARTY_MONTHLY_FRACTION = "0.7";
  try {
    const f = getConfiguredTrancheFractions();
    assert.equal(f.weekly, 0.3);
    assert.equal(f.monthly, 0.7);
  } finally {
    clearLedgerEnv();
  }
});

test("getConfiguredTrancheFractions: invalid env (sum ≠ 1) falls back to defaults", () => {
  process.env.VC_COUNTERPARTY_WEEKLY_FRACTION = "0.5";
  process.env.VC_COUNTERPARTY_MONTHLY_FRACTION = "0.7";
  try {
    const f = getConfiguredTrancheFractions();
    assert.equal(f.weekly, 0.25);
    assert.equal(f.monthly, 0.75);
  } finally {
    clearLedgerEnv();
  }
});

test("shouldHaltDueToCounterpartyExposure: below threshold → no halt", () => {
  clearLedgerEnv();
  const summary: CounterpartySummary = {
    generatedAtIso: new Date().toISOString(),
    atticusOwesFoxifyTotalUsdc: 0,
    foxifyOwesAtticusTotalUsdc: 10_000,
    netExposureUsdc: 10_000,
    byDirection: {} as never
  };
  const r = shouldHaltDueToCounterpartyExposure(summary);
  assert.equal(r.halt, false);
  assert.equal(r.thresholdUsdc, 25_000);
});

test("shouldHaltDueToCounterpartyExposure: above threshold → halt", () => {
  clearLedgerEnv();
  const summary: CounterpartySummary = {
    generatedAtIso: new Date().toISOString(),
    atticusOwesFoxifyTotalUsdc: 0,
    foxifyOwesAtticusTotalUsdc: 30_000,
    netExposureUsdc: 30_000,
    byDirection: {} as never
  };
  const r = shouldHaltDueToCounterpartyExposure(summary);
  assert.equal(r.halt, true);
  assert.equal(r.unsettledUsdc, 30_000);
});

test("shouldHaltDueToCounterpartyExposure: env threshold honored", () => {
  process.env.VC_COUNTERPARTY_HALT_THRESHOLD_USDC = "5000";
  try {
    const summary: CounterpartySummary = {
      generatedAtIso: new Date().toISOString(),
      atticusOwesFoxifyTotalUsdc: 0,
      foxifyOwesAtticusTotalUsdc: 7_500,
      netExposureUsdc: 7_500,
      byDirection: {} as never
    };
    const r = shouldHaltDueToCounterpartyExposure(summary);
    assert.equal(r.halt, true);
    assert.equal(r.thresholdUsdc, 5_000);
  } finally {
    clearLedgerEnv();
  }
});
