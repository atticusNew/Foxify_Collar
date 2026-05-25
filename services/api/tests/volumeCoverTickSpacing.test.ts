import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTickSpacing,
  getConfiguredTickSpacing
} from "../src/volumeCover/tickSpacing";

const clearEnv = (): void => {
  delete process.env.VC_TICK_SPACING_ENABLED;
  delete process.env.VC_TICK_SPACING_MIN_MS;
  delete process.env.VC_TICK_SPACING_MIN_BTC_USDC;
};

test("PR-G tick-spacing: defaults are 60s + $400 BTC, enabled", () => {
  clearEnv();
  const cfg = getConfiguredTickSpacing();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.minMs, 60_000);
  assert.equal(cfg.minBtcUsdc, 400);
});

test("PR-G tick-spacing: env overrides honored", () => {
  clearEnv();
  process.env.VC_TICK_SPACING_MIN_MS = "30000";
  process.env.VC_TICK_SPACING_MIN_BTC_USDC = "200";
  try {
    const cfg = getConfiguredTickSpacing();
    assert.equal(cfg.minMs, 30_000);
    assert.equal(cfg.minBtcUsdc, 200);
  } finally {
    clearEnv();
  }
});

test("PR-G tick-spacing: VC_TICK_SPACING_ENABLED=false bypasses the gate", () => {
  clearEnv();
  process.env.VC_TICK_SPACING_ENABLED = "false";
  try {
    const decision = evaluateTickSpacing({
      lastOpenedAtIso: new Date(Date.now() - 1_000).toISOString(),
      lastEntryBtcUsdc: 75_000,
      currentEntryBtcUsdc: 75_000
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, null);
  } finally {
    clearEnv();
  }
});

test("PR-G tick-spacing: no prior position → always allowed (cell first activation)", () => {
  clearEnv();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: null,
    lastEntryBtcUsdc: null,
    currentEntryBtcUsdc: 75_000
  });
  assert.equal(decision.allowed, true);
});

test("PR-G tick-spacing: reject when cooldown unmet AND BTC barely moved", () => {
  clearEnv();
  const now = Date.now();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 30_000).toISOString(), // 30s ago < 60s
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_100, // $100 < $400
    nowMs: now
  });
  assert.equal(decision.allowed, false);
  if (decision.allowed === false) {
    assert.equal(decision.reason, "tick_spacing_violation");
    assert.equal(decision.elapsedMs, 30_000);
    assert.equal(decision.btcDeltaUsdc, 100);
    assert.equal(decision.retryAfterMs, 30_000);
  }
});

test("PR-G tick-spacing: allow when cooldown elapsed even if BTC didn't move", () => {
  clearEnv();
  const now = Date.now();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 90_000).toISOString(), // 90s ago > 60s
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_010, // basically same price
    nowMs: now
  });
  assert.equal(decision.allowed, true);
});

test("PR-G tick-spacing: allow when BTC moved >= $400 even if cooldown not met", () => {
  clearEnv();
  const now = Date.now();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 5_000).toISOString(), // 5s ago
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_500, // $500 > $400
    nowMs: now
  });
  assert.equal(decision.allowed, true);
});

test("PR-G tick-spacing: BTC delta is symmetric (down moves count too)", () => {
  clearEnv();
  const now = Date.now();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 5_000).toISOString(),
    lastEntryBtcUsdc: 75_500,
    currentEntryBtcUsdc: 75_000, // $500 down
    nowMs: now
  });
  assert.equal(decision.allowed, true);
});

test("PR-G tick-spacing: edge case — exactly at threshold (>=) passes", () => {
  clearEnv();
  const now = Date.now();
  // Exactly 60s elapsed: cooldownMet === true → allowed
  const exactCooldown = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 60_000).toISOString(),
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_000,
    nowMs: now
  });
  assert.equal(exactCooldown.allowed, true);

  // Exactly $400 delta: movedEnough === true → allowed
  const exactMove = evaluateTickSpacing({
    lastOpenedAtIso: new Date(now - 100).toISOString(),
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_400,
    nowMs: now
  });
  assert.equal(exactMove.allowed, true);
});

test("PR-G tick-spacing: malformed lastOpenedAtIso fails open (don't block real activations)", () => {
  clearEnv();
  const decision = evaluateTickSpacing({
    lastOpenedAtIso: "not-a-date",
    lastEntryBtcUsdc: 75_000,
    currentEntryBtcUsdc: 75_000
  });
  assert.equal(decision.allowed, true);
});

test("PR-G tick-spacing: env minMs=0 effectively disables cooldown gate (BTC delta carries the gate)", () => {
  clearEnv();
  process.env.VC_TICK_SPACING_MIN_MS = "0";
  try {
    const now = Date.now();
    const decision = evaluateTickSpacing({
      lastOpenedAtIso: new Date(now).toISOString(),
      lastEntryBtcUsdc: 75_000,
      currentEntryBtcUsdc: 75_000,
      nowMs: now
    });
    // 0ms cooldown → cooldownMet trivially true → allowed
    assert.equal(decision.allowed, true);
  } finally {
    clearEnv();
  }
});
