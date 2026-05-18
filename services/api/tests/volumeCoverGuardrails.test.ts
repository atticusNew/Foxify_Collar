import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCumulativeLossKill,
  checkSalvageRate,
  checkTriggerSurge,
  checkVolumeCoverStressPause,
  checkAllGuardsForVolumeCoverActivate,
  setManualHalt,
  getManualHalt,
  getThrottleStateMaxPerDay,
  __resetVolumeCoverGuardrailsForTests
} from "../src/volumeCover/volumeCoverGuardrails";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";

const resetAll = () => {
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();
  // Disable Wave 1/2 guards for these tests so we isolate Volume Cover
  // guards. Real composer test below leaves them on.
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
};

test("Guard A: cumulative loss kill — under threshold passes", () => {
  resetAll();
  const v = checkCumulativeLossKill({ rolling7dayAtticusLossUsdc: 1000 });
  assert.equal(v.allowed, true);
});

test("Guard A: cumulative loss kill — over threshold blocks", () => {
  resetAll();
  const v = checkCumulativeLossKill({ rolling7dayAtticusLossUsdc: 5500 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "cumulative_loss_kill_switch");
});

test("Guard A: env override changes threshold", () => {
  resetAll();
  const original = process.env.VOLUME_COVER_GUARD_LOSS_KILL_USDC;
  process.env.VOLUME_COVER_GUARD_LOSS_KILL_USDC = "1000";
  try {
    const v = checkCumulativeLossKill({ rolling7dayAtticusLossUsdc: 2000 });
    assert.equal(v.allowed, false);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_GUARD_LOSS_KILL_USDC;
    else process.env.VOLUME_COVER_GUARD_LOSS_KILL_USDC = original;
  }
});

test("Guard A: env disable bypasses block", () => {
  resetAll();
  const original = process.env.VOLUME_COVER_GUARD_LOSS_KILL_ENABLED;
  process.env.VOLUME_COVER_GUARD_LOSS_KILL_ENABLED = "false";
  try {
    const v = checkCumulativeLossKill({ rolling7dayAtticusLossUsdc: 100_000 });
    assert.equal(v.allowed, true);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_GUARD_LOSS_KILL_ENABLED;
    else process.env.VOLUME_COVER_GUARD_LOSS_KILL_ENABLED = original;
  }
});

test("Guard B: salvage rate — null with low samples returns normal", () => {
  resetAll();
  const v = checkSalvageRate({
    rolling5TriggerSalvagePct: null,
    rolling5TriggerSampleCount: 0
  });
  assert.equal(v.state, "normal");
  assert.equal(v.allowed, true);
});

test("Guard B: salvage rate — 95% with full samples returns normal", () => {
  resetAll();
  const v = checkSalvageRate({
    rolling5TriggerSalvagePct: 0.95,
    rolling5TriggerSampleCount: 5
  });
  assert.equal(v.state, "normal");
  assert.equal(v.allowed, true);
});

test("Guard B: salvage rate — 80% triggers throttle (allowed but throttled)", () => {
  resetAll();
  const v = checkSalvageRate({
    rolling5TriggerSalvagePct: 0.80,
    rolling5TriggerSampleCount: 5
  });
  assert.equal(v.state, "throttle");
  assert.equal(v.allowed, true);
  assert.equal(getThrottleStateMaxPerDay("throttle"), 3);
});

test("Guard B: salvage rate — 65% triggers halt (blocked)", () => {
  resetAll();
  const v = checkSalvageRate({
    rolling5TriggerSalvagePct: 0.65,
    rolling5TriggerSampleCount: 5
  });
  assert.equal(v.state, "halt");
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "salvage_rate_below_halt");
});

test("Guard B: insufficient samples (<3) returns normal regardless", () => {
  resetAll();
  const v = checkSalvageRate({
    rolling5TriggerSalvagePct: 0.10, // would normally halt
    rolling5TriggerSampleCount: 2
  });
  assert.equal(v.state, "normal");
});

test("Guard C: trigger surge — under max passes", () => {
  resetAll();
  const v = checkTriggerSurge({ rolling24hTriggerCount: 3 });
  assert.equal(v.allowed, true);
});

test("Guard C: trigger surge — over max blocks + arms cooldown", () => {
  resetAll();
  const nowMs = Date.now();
  const v1 = checkTriggerSurge({ rolling24hTriggerCount: 6, nowMs });
  assert.equal(v1.allowed, false);
  assert.equal(v1.reason, "trigger_surge_pause");

  // Within cooldown: still blocked even if trigger count drops below max
  const v2 = checkTriggerSurge({ rolling24hTriggerCount: 1, nowMs: nowMs + 5_000 });
  assert.equal(v2.allowed, false);
  assert.equal(v2.reason, "trigger_surge_cooldown");

  // After cooldown elapses: allowed again
  const futureMs = nowMs + 31 * 60_000;
  const v3 = checkTriggerSurge({ rolling24hTriggerCount: 1, nowMs: futureMs });
  assert.equal(v3.allowed, true);
});

test("Guard D: VC stress pause — DVOL < 80 passes", () => {
  resetAll();
  const v = checkVolumeCoverStressPause({ currentDvol: 65 });
  assert.equal(v.allowed, true);
});

test("Guard D: VC stress pause — DVOL >= 80 blocks", () => {
  resetAll();
  const v = checkVolumeCoverStressPause({ currentDvol: 82 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "vc_stress_regime_pause");
});

test("Guard D: VC stress pause — env override threshold", () => {
  resetAll();
  process.env.VC_STRESS_PAUSE_DVOL_THRESHOLD = "70";
  try {
    const v = checkVolumeCoverStressPause({ currentDvol: 75 });
    assert.equal(v.allowed, false);
  } finally {
    delete process.env.VC_STRESS_PAUSE_DVOL_THRESHOLD;
  }
});

test("Guard D: env disable bypasses block", () => {
  resetAll();
  process.env.VC_STRESS_PAUSE_ENABLED = "false";
  try {
    const v = checkVolumeCoverStressPause({ currentDvol: 100 });
    assert.equal(v.allowed, true);
  } finally {
    delete process.env.VC_STRESS_PAUSE_ENABLED;
  }
});

test("Composer: VC stress pause fires before pilot extreme-crisis (100)", () => {
  resetAll();
  process.env.PILOT_GUARDS_ALL_DISABLED = "false"; // enable Wave 2 normally
  process.env.PILOT_GUARD_DVOL_HIGH_THRESHOLD = "100";
  try {
    // DVOL 85: VC stress (>=80) fires; pilot extreme (>=100) does NOT
    const v = checkAllGuardsForVolumeCoverActivate({
      foxifyPoolBalanceUsdc: 0,
      totalActivePayoutLiabilityUsdc: 0,
      newPayoutLiabilityUsdc: 1_000,
      dbTrackedAtticusBalanceUsdc: null,
      venueReportedAtticusBalanceUsdc: null,
      currentDvol: 85,
      lastDvolThresholdCrossingMs: null,
      bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 0, sampleCount: 0 },
      todayPremiumIncomeUsdc: 0,
      rollingAvgPremiumIncomeUsdc: 0,
      rolling7dayAtticusLossUsdc: 0,
      rolling5TriggerSalvagePct: null,
      rolling5TriggerSampleCount: 0,
      rolling24hTriggerCount: 0
    });
    assert.equal(v.allowed, false);
    assert.equal(v.reason, "vc_stress_regime_pause");
  } finally {
    delete process.env.PILOT_GUARD_DVOL_HIGH_THRESHOLD;
    process.env.PILOT_GUARDS_ALL_DISABLED = "true"; // restore for other tests
  }
});

test("Manual halt: setManualHalt + clear cycle", () => {
  resetAll();
  setManualHalt({ halted: true, reason: "test_pause" });
  assert.equal(getManualHalt().halted, true);
  assert.equal(getManualHalt().reason, "test_pause");
  setManualHalt({ halted: false });
  assert.equal(getManualHalt().halted, false);
});

test("Composer: all green inputs allow activation", () => {
  resetAll();
  const v = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1_000,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 50,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 100, sampleCount: 100 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: 0,
    rolling5TriggerSalvagePct: null,
    rolling5TriggerSampleCount: 0,
    rolling24hTriggerCount: 0
  });
  assert.equal(v.allowed, true);
  assert.equal(v.salvageState, "normal");
});

test("Composer: manual halt blocks first", () => {
  resetAll();
  setManualHalt({ halted: true, reason: "operator" });
  const v = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1_000,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 50,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 100, sampleCount: 100 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: 0,
    rolling5TriggerSalvagePct: null,
    rolling5TriggerSampleCount: 0,
    rolling24hTriggerCount: 0
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "manual_halt");
});

test("Composer: cumulative loss kill blocks even if salvage normal", () => {
  resetAll();
  const v = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1_000,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 50,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 100, sampleCount: 100 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: 6_000, // over $5k threshold
    rolling5TriggerSalvagePct: 0.95,
    rolling5TriggerSampleCount: 5,
    rolling24hTriggerCount: 1
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "cumulative_loss_kill_switch");
});

test("Composer: salvage halt state blocks", () => {
  resetAll();
  const v = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1_000,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 50,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 100, sampleCount: 100 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: 0,
    rolling5TriggerSalvagePct: 0.55, // below 70% halt
    rolling5TriggerSampleCount: 5,
    rolling24hTriggerCount: 1
  });
  assert.equal(v.allowed, false);
  assert.equal(v.salvageState, "halt");
});

test("Composer: salvage throttle state allows but flags", () => {
  resetAll();
  const v = checkAllGuardsForVolumeCoverActivate({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1_000,
    dbTrackedAtticusBalanceUsdc: null,
    venueReportedAtticusBalanceUsdc: null,
    currentDvol: 50,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 100, sampleCount: 100 },
    todayPremiumIncomeUsdc: 0,
    rollingAvgPremiumIncomeUsdc: 0,
    rolling7dayAtticusLossUsdc: 0,
    rolling5TriggerSalvagePct: 0.80, // throttle band
    rolling5TriggerSampleCount: 5,
    rolling24hTriggerCount: 1
  });
  assert.equal(v.allowed, true);
  assert.equal(v.salvageState, "throttle");
  assert.equal(v.throttleOverridePerDay, 3);
});
