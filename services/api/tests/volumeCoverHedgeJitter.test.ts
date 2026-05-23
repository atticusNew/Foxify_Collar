import assert from "node:assert/strict";
import test from "node:test";

import {
  getConfiguredHedgeJitter,
  sampleOpenDelayMs,
  sampleInterLegPacingMs,
  jitterStrikeWithinTolerance,
  jitterContractsWithinTolerance,
  jitterSleepMs
} from "../src/volumeCover/hedgeJitter";

const clearJitterEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VC_HEDGE_JITTER_")) {
      delete process.env[key];
    }
  }
};

test("getConfiguredHedgeJitter: defaults", () => {
  clearJitterEnv();
  const cfg = getConfiguredHedgeJitter();
  assert.equal(cfg.openDelayEnabled, true);
  assert.equal(cfg.openDelayMinMs, 0);
  assert.equal(cfg.openDelayMaxMs, 15_000);
  assert.equal(cfg.interLegEnabled, true);
  assert.equal(cfg.interLegMinMs, 500);
  assert.equal(cfg.interLegMaxMs, 3_000);
  assert.equal(cfg.strikeTolerance.enabled, false);
  assert.equal(cfg.contractsTolerance.enabled, true);
  assert.equal(cfg.contractsTolerance.tolerancePct, 0.02);
  assert.equal(cfg.contractsTolerance.granularityBtc, 0.01);
});

test("sampleOpenDelayMs: midpoint with randFn=0.5", () => {
  clearJitterEnv();
  // sampleUniformInt(0, 15000, 0.5) = floor(0.5 * 15001) + 0 = 7500
  assert.equal(sampleOpenDelayMs({ randFn: () => 0.5 }), 7500);
});

test("sampleOpenDelayMs: disabled via env returns 0", () => {
  clearJitterEnv();
  process.env.VC_HEDGE_JITTER_OPEN_DELAY_ENABLED = "false";
  try {
    assert.equal(sampleOpenDelayMs({ randFn: () => 0.99 }), 0);
  } finally {
    clearJitterEnv();
  }
});

test("sampleInterLegPacingMs: bounded by [min, max]", () => {
  clearJitterEnv();
  // randFn=0 → floor(0 * 2501) + 500 = 500 (min)
  assert.equal(sampleInterLegPacingMs({ randFn: () => 0 }), 500);
  // randFn=0.9999 → floor(0.9999 * 2501) + 500 ≈ 2500 + 500 = 3000
  assert.ok(sampleInterLegPacingMs({ randFn: () => 0.9999 }) <= 3000);
  assert.ok(sampleInterLegPacingMs({ randFn: () => 0.9999 }) >= 500);
});

test("jitterStrikeWithinTolerance: disabled by default returns ideal unchanged", () => {
  clearJitterEnv();
  const result = jitterStrikeWithinTolerance({
    idealStrikeUsdc: 75_000,
    gridStepUsdc: 1_000,
    lowerBoundUsdc: 70_000,
    upperBoundUsdc: 80_000,
    randFn: () => 0.99
  });
  assert.equal(result, 75_000);
});

test("jitterStrikeWithinTolerance: enabled with deviation 1 grid step", () => {
  process.env.VC_HEDGE_JITTER_STRIKE_ENABLED = "true";
  process.env.VC_HEDGE_JITTER_STRIKE_MAX_GRID_STEPS = "1";
  try {
    // randFn=0 → sampleSignedDeviation(1, 0) =
    //   sampleUniformInt(-1, 1, 0) = floor(0 * 3) + (-1) = -1
    // candidate = 75000 + (-1) * 1000 = 74000 (in band)
    const result = jitterStrikeWithinTolerance({
      idealStrikeUsdc: 75_000,
      gridStepUsdc: 1_000,
      lowerBoundUsdc: 70_000,
      upperBoundUsdc: 80_000,
      randFn: () => 0
    });
    assert.equal(result, 74_000);
  } finally {
    clearJitterEnv();
  }
});

test("jitterStrikeWithinTolerance: shift that would exit band returns ideal", () => {
  process.env.VC_HEDGE_JITTER_STRIKE_ENABLED = "true";
  process.env.VC_HEDGE_JITTER_STRIKE_MAX_GRID_STEPS = "2";
  try {
    // Tight band — even a 1-step shift down exits the band.
    // randFn=0 → deviation = -2 → candidate = 75000 - 2000 = 73000 (below 73500)
    const result = jitterStrikeWithinTolerance({
      idealStrikeUsdc: 75_000,
      gridStepUsdc: 1_000,
      lowerBoundUsdc: 73_500,
      upperBoundUsdc: 76_500,
      randFn: () => 0
    });
    // Should fall back to ideal because the shift would exit the band.
    assert.equal(result, 75_000);
  } finally {
    clearJitterEnv();
  }
});

test("jitterContractsWithinTolerance: defaults ±2%, granularity 0.01", () => {
  clearJitterEnv();
  // randFn=0.5 → sampleUniformFloat(-0.02, 0.02, 0.5) = -0.02 + 0.5 * 0.04 = 0 → unchanged
  const r = jitterContractsWithinTolerance({
    baseContractsBtc: 1.0,
    randFn: () => 0.5
  });
  assert.equal(r, 1.0);
});

test("jitterContractsWithinTolerance: max upward jitter", () => {
  clearJitterEnv();
  // randFn=1.0 → deviation = +0.02 → raw = 1.0 * 1.02 = 1.02
  // round to 0.01 granularity = 1.02
  const r = jitterContractsWithinTolerance({
    baseContractsBtc: 1.0,
    randFn: () => 0.999999
  });
  assert.ok(r >= 1.0 && r <= 1.05, `got ${r}`);
});

test("jitterContractsWithinTolerance: max downward jitter snaps to granularity", () => {
  clearJitterEnv();
  // randFn=0 → deviation = -0.02 → raw = 0.5 * 0.98 = 0.49
  // round to 0.01 = 0.49
  const r = jitterContractsWithinTolerance({
    baseContractsBtc: 0.5,
    randFn: () => 0
  });
  assert.ok(r >= 0.48 && r <= 0.5, `got ${r}`);
});

test("jitterContractsWithinTolerance: disabled returns base", () => {
  process.env.VC_HEDGE_JITTER_CONTRACTS_ENABLED = "false";
  try {
    const r = jitterContractsWithinTolerance({
      baseContractsBtc: 0.5,
      randFn: () => 0
    });
    assert.equal(r, 0.5);
  } finally {
    clearJitterEnv();
  }
});

test("jitterContractsWithinTolerance: clamps non-positive result to one granularity step", () => {
  process.env.VC_HEDGE_JITTER_CONTRACTS_TOLERANCE_PCT = "0.999";
  try {
    const r = jitterContractsWithinTolerance({
      baseContractsBtc: 0.005, // below 0.01 granularity
      randFn: () => 0
    });
    assert.ok(r > 0);
    assert.equal(r, 0.01);
  } finally {
    clearJitterEnv();
  }
});

test("jitterSleepMs: 0 ms resolves immediately", async () => {
  const start = Date.now();
  await jitterSleepMs(0);
  assert.ok(Date.now() - start < 10);
});
