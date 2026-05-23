import assert from "node:assert/strict";
import test from "node:test";

import {
  decideDisruption,
  getDisruptionConfig,
  sleepMs
} from "../src/volumeCover/silentDisruption";

const clearDisruptionEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VC_SILENT_DISRUPTION_")) {
      delete process.env[key];
    }
  }
};

test("decideDisruption: null regime → fully disabled (no friction)", () => {
  clearDisruptionEnv();
  const d = decideDisruption({ regime: null });
  assert.equal(d.enabled, false);
  assert.equal(d.latencyMs, 0);
  assert.equal(d.reject503, false);
  assert.equal(d.jitterMultiplier, 1.0);
});

test("decideDisruption: calm regime → enabled but no friction", () => {
  clearDisruptionEnv();
  const d = decideDisruption({ regime: "calm" });
  assert.equal(d.enabled, true);
  assert.equal(d.latencyMs, 0);
  assert.equal(d.reject503, false);
  assert.equal(d.jitterMultiplier, 1.0);
});

test("decideDisruption: moderate regime (default) is currently no-op", () => {
  clearDisruptionEnv();
  // Use a randFn that always returns 0 (would maximally trigger any prob)
  const d = decideDisruption({ regime: "moderate", randFn: () => 0 });
  assert.equal(d.latencyMs, 0);
  assert.equal(d.reject503, false);
  assert.equal(d.jitterMultiplier, 1.0);
});

test("decideDisruption: elevated regime injects latency in the configured range", () => {
  clearDisruptionEnv();
  // Deterministic uniform sampler at 0.5 → midpoint of [15000, 60000] = 37500
  const d = decideDisruption({ regime: "elevated", randFn: () => 0.5 });
  // sampleUniformInt at randFn=0.5: floor(0.5 * (60000-15000+1)) + 15000 = floor(22500.5) + 15000 = 37500
  assert.equal(d.latencyMs, 37500);
  // 503 prob = 0.02; randFn=0.5 → 0.5 < 0.02 is false → no 503
  assert.equal(d.reject503, false);
  assert.equal(d.jitterMultiplier, 1.5);
});

test("decideDisruption: stress regime injects high latency + maximum jitter", () => {
  clearDisruptionEnv();
  const d = decideDisruption({ regime: "stress", randFn: () => 0.99 });
  // sampleUniformInt at 0.99: floor(0.99 * 120001) + 60000 = 178800 + 60000 = 178800?
  // = floor(0.99 * (180000-60000+1)) + 60000 = floor(0.99 * 120001) + 60000
  // = floor(118800.99) + 60000 = 118800 + 60000 = 178800
  assert.equal(d.latencyMs, 178800);
  // 503 prob = 0.10; randFn=0.99 → 0.99 < 0.10 is false → no 503
  assert.equal(d.reject503, false);
  assert.equal(d.jitterMultiplier, 2.0);
});

test("decideDisruption: 503 fires when sampled probability is below threshold", () => {
  clearDisruptionEnv();
  // randFn=0.005 → latency sample then 0.005 < 0.10 → 503 fires
  const d = decideDisruption({ regime: "stress", randFn: () => 0.005 });
  assert.equal(d.reject503, true);
  // retryAfterSeconds = uniform[30, 60]; randFn=0.005 → floor(0.005*31)+30 = 30
  assert.equal(d.retryAfterSeconds, 30);
});

test("decideDisruption: env override of latency range honored", () => {
  clearDisruptionEnv();
  process.env.VC_SILENT_DISRUPTION_STRESS_LATENCY_MIN_MS = "0";
  process.env.VC_SILENT_DISRUPTION_STRESS_LATENCY_MAX_MS = "100";
  process.env.VC_SILENT_DISRUPTION_STRESS_REJECT_503_PROB = "0";
  process.env.VC_SILENT_DISRUPTION_STRESS_JITTER_MULT = "1";
  try {
    const d = decideDisruption({ regime: "stress", randFn: () => 0.5 });
    // sampleUniformInt: floor(0.5 * 101) + 0 = 50
    assert.equal(d.latencyMs, 50);
    assert.equal(d.reject503, false);
    assert.equal(d.jitterMultiplier, 1.0);
  } finally {
    clearDisruptionEnv();
  }
});

test("decideDisruption: VC_SILENT_DISRUPTION_ENABLED=false disables entirely", () => {
  clearDisruptionEnv();
  process.env.VC_SILENT_DISRUPTION_ENABLED = "false";
  try {
    const d = decideDisruption({ regime: "stress", randFn: () => 0 });
    assert.equal(d.enabled, false);
    assert.equal(d.latencyMs, 0);
    assert.equal(d.reject503, false);
  } finally {
    clearDisruptionEnv();
  }
});

test("getDisruptionConfig: default values per regime", () => {
  clearDisruptionEnv();
  const calm = getDisruptionConfig("calm");
  assert.equal(calm.latencyMaxMs, 0);
  assert.equal(calm.reject503Probability, 0);

  const elev = getDisruptionConfig("elevated");
  assert.equal(elev.latencyMinMs, 15_000);
  assert.equal(elev.latencyMaxMs, 60_000);
  assert.equal(elev.reject503Probability, 0.02);

  const stress = getDisruptionConfig("stress");
  assert.equal(stress.latencyMinMs, 60_000);
  assert.equal(stress.latencyMaxMs, 180_000);
  assert.equal(stress.reject503Probability, 0.10);
});

test("sleepMs: resolves immediately for 0 ms", async () => {
  const start = Date.now();
  await sleepMs(0);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10);
});

test("sleepMs: sleeps approximately the requested duration", async () => {
  const start = Date.now();
  await sleepMs(50);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 45 && elapsed < 200, `elapsed=${elapsed}`);
});
