import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMaxHoldExpired,
  getConfiguredMaxHold
} from "../src/volumeCover/maxHoldSweep";
import type { PositionRow } from "../src/volumeCover/volumeCoverDb";

const buildPosition = (overrides: Partial<PositionRow> = {}): PositionRow => ({
  id: "vc-pos-test-mh",
  cellId: "50k_2pct_1k",
  foxifyPairId: "TEST-MH-1",
  pairLongNotionalUsdc: 50_000,
  pairShortNotionalUsdc: 50_000,
  pairEntryBtcPrice: 75_000,
  triggerHighBtc: 76_500,
  triggerLowBtc: 73_500,
  dailyPremiumUsdc: 350,
  payoutUsdc: 1_000,
  status: "active",
  openedAt: new Date(Date.now() - 10 * 3_600_000).toISOString(), // 10h ago by default
  triggeredAt: null,
  triggeredDirection: null,
  closedAt: null,
  closeReason: null,
  coverageThrough: null,
  fingerprintHash: null,
  metadata: {},
  regimeAtOpen: null,
  baseDailyPremiumUsdc: null,
  surchargeMultiplierApplied: 1.0,
  ...overrides
});

const clearEnv = (): void => {
  delete process.env.VC_MAX_HOLD_ENABLED;
  delete process.env.VC_MAX_HOLD_HOURS;
  delete process.env.VC_MAX_HOLD_CLOSES_PER_CYCLE;
};

test("PR-G max-hold: defaults are 72h, 5/cycle, enabled", () => {
  clearEnv();
  const cfg = getConfiguredMaxHold();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxHoldHours, 72);
  assert.equal(cfg.maxClosesPerCycle, 5);
});

test("PR-G max-hold: env overrides honored", () => {
  clearEnv();
  process.env.VC_MAX_HOLD_HOURS = "24";
  process.env.VC_MAX_HOLD_CLOSES_PER_CYCLE = "10";
  try {
    const cfg = getConfiguredMaxHold();
    assert.equal(cfg.maxHoldHours, 24);
    assert.equal(cfg.maxClosesPerCycle, 10);
  } finally {
    clearEnv();
  }
});

test("PR-G max-hold: position 1h old, default 72h cap → not expired", () => {
  clearEnv();
  const now = Date.now();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({ openedAt: new Date(now - 1 * 3_600_000).toISOString() }),
    nowMs: now
  });
  assert.equal(verdict.expired, false);
  assert.equal(verdict.ageMs, 3_600_000);
  assert.equal(verdict.deadlineMs, 72 * 3_600_000);
});

test("PR-G max-hold: position 73h old, default 72h cap → expired", () => {
  clearEnv();
  const now = Date.now();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({ openedAt: new Date(now - 73 * 3_600_000).toISOString() }),
    nowMs: now
  });
  assert.equal(verdict.expired, true);
  assert.equal(verdict.reason, "max_hold_exceeded");
});

test("PR-G max-hold: status='triggered' is never swept (already lifecycle-final)", () => {
  clearEnv();
  const now = Date.now();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({
      status: "triggered",
      openedAt: new Date(now - 200 * 3_600_000).toISOString() // very old
    }),
    nowMs: now
  });
  assert.equal(verdict.expired, false);
  assert.equal(verdict.reason, "not_active");
});

test("PR-G max-hold: status='closed' is never swept", () => {
  clearEnv();
  const now = Date.now();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({
      status: "closed",
      openedAt: new Date(now - 200 * 3_600_000).toISOString()
    }),
    nowMs: now
  });
  assert.equal(verdict.expired, false);
  assert.equal(verdict.reason, "not_active");
});

test("PR-G max-hold: VC_MAX_HOLD_ENABLED=false bypasses sweep", () => {
  clearEnv();
  process.env.VC_MAX_HOLD_ENABLED = "false";
  try {
    const now = Date.now();
    const verdict = evaluateMaxHoldExpired({
      position: buildPosition({ openedAt: new Date(now - 200 * 3_600_000).toISOString() }),
      nowMs: now
    });
    assert.equal(verdict.expired, false);
    assert.equal(verdict.reason, "disabled");
  } finally {
    clearEnv();
  }
});

test("PR-G max-hold: VC_MAX_HOLD_HOURS=24 expires 25h-old position", () => {
  clearEnv();
  process.env.VC_MAX_HOLD_HOURS = "24";
  try {
    const now = Date.now();
    const verdict = evaluateMaxHoldExpired({
      position: buildPosition({ openedAt: new Date(now - 25 * 3_600_000).toISOString() }),
      nowMs: now
    });
    assert.equal(verdict.expired, true);
    assert.equal(verdict.deadlineMs, 24 * 3_600_000);
  } finally {
    clearEnv();
  }
});

test("PR-G max-hold: edge case — exactly at deadline expires (>=)", () => {
  clearEnv();
  const now = Date.now();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({ openedAt: new Date(now - 72 * 3_600_000).toISOString() }),
    nowMs: now
  });
  assert.equal(verdict.expired, true);
});

test("PR-G max-hold: malformed openedAt does not crash, returns not-expired", () => {
  clearEnv();
  const verdict = evaluateMaxHoldExpired({
    position: buildPosition({ openedAt: "not-a-date" })
  });
  assert.equal(verdict.expired, false);
  assert.equal(verdict.reason, "invalid_opened_at");
});
