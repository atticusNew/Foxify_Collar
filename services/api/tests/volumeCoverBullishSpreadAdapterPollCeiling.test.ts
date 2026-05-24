/**
 * 2026-05-24 (PR-C): intent-based poll ceiling tests for the
 * bullishSpreadAdapter. The CLOSE path runs during a trigger fire where
 * every 100ms costs intrinsic value as BTC mean-reverts; the OPEN path
 * is fire-and-forget within the IOC window. We differentiate the
 * status-poll ceiling per intent so close fails-fast (8s default) while
 * open keeps the longer protective ceiling (30s default).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { __testHelpers, getBullishSpreadAdapterRuntimeConfig } from "../src/volumeCover/bullishSpreadAdapter";

const POLL_ENV_KEYS = [
  "VC_BULLISH_SPREAD_POLL_INTERVAL_MS",
  "VC_BULLISH_SPREAD_OPEN_POLL_MAX_ATTEMPTS",
  "VC_BULLISH_SPREAD_CLOSE_POLL_MAX_ATTEMPTS"
];

const clearEnv = (): void => {
  for (const key of POLL_ENV_KEYS) delete process.env[key];
};

test("PR-C poll ceiling: defaults — open=60 attempts (30s), close=16 (8s)", () => {
  clearEnv();
  const cfg = __testHelpers.getCurrentPollCeilingMs();
  assert.equal(cfg.intervalMs, 500);
  assert.equal(cfg.open, 30_000);
  assert.equal(cfg.close, 8_000);
  assert.equal(cfg.rollback, 8_000);
  assert.equal(__testHelpers.pollMaxAttemptsForIntent("open"), 60);
  assert.equal(__testHelpers.pollMaxAttemptsForIntent("close"), 16);
  assert.equal(__testHelpers.pollMaxAttemptsForIntent("rollback"), 16);
});

test("PR-C poll ceiling: env overrides take effect at call time", () => {
  clearEnv();
  process.env.VC_BULLISH_SPREAD_OPEN_POLL_MAX_ATTEMPTS = "120";
  process.env.VC_BULLISH_SPREAD_CLOSE_POLL_MAX_ATTEMPTS = "10";
  process.env.VC_BULLISH_SPREAD_POLL_INTERVAL_MS = "250";
  try {
    assert.equal(__testHelpers.pollMaxAttemptsForIntent("open"), 120);
    assert.equal(__testHelpers.pollMaxAttemptsForIntent("close"), 10);
    assert.equal(__testHelpers.pollMaxAttemptsForIntent("rollback"), 10);
    assert.equal(__testHelpers.getPollIntervalMs(), 250);

    const cfg = __testHelpers.getCurrentPollCeilingMs();
    assert.equal(cfg.open, 30_000); // 120 × 250 = 30s
    assert.equal(cfg.close, 2_500); // 10 × 250 = 2.5s
  } finally {
    clearEnv();
  }
});

test("PR-C poll ceiling: invalid env values fall back to defaults (no NaN/zero)", () => {
  clearEnv();
  for (const bad of ["abc", "0", "-5", "3.14", ""]) {
    process.env.VC_BULLISH_SPREAD_OPEN_POLL_MAX_ATTEMPTS = bad;
    assert.equal(
      __testHelpers.pollMaxAttemptsForIntent("open"),
      60,
      `invalid env "${bad}" should default to 60`
    );
  }
  clearEnv();
});

test("PR-C poll ceiling: getBullishSpreadAdapterRuntimeConfig surfaces live values", () => {
  clearEnv();
  process.env.VC_BULLISH_SPREAD_CLOSE_POLL_MAX_ATTEMPTS = "20";
  process.env.VC_BULLISH_SPREAD_POLL_INTERVAL_MS = "400";
  try {
    const cfg = getBullishSpreadAdapterRuntimeConfig();
    assert.equal(cfg.pollIntervalMs, 400);
    assert.equal(cfg.openPollCeilingMs, 60 * 400); // unchanged default × new interval
    assert.equal(cfg.closePollCeilingMs, 20 * 400);
  } finally {
    clearEnv();
  }
});

test("PR-C poll ceiling: close ceiling is strictly less than open ceiling under defaults", () => {
  clearEnv();
  const cfg = __testHelpers.getCurrentPollCeilingMs();
  assert.ok(
    cfg.close < cfg.open,
    `close ceiling (${cfg.close}ms) should be < open ceiling (${cfg.open}ms) — close path is under time pressure during trigger`
  );
});
