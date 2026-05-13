import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import {
  checkFoxifyPoolMinBalance,
  checkAggregateLiabilityCap,
  checkReconciliationDrift,
  checkHighDvolPause,
  checkBullishApiHealth,
  checkPremiumVelocity,
  checkWave1Guards,
  checkWave2Guards
} from "../src/pilot/operationalGuardrails";

/**
 * WS#8 (Bundle C cutover, rev 6) — operational guardrail tests.
 *
 * All guards are pure functions; tests don't need DB or HTTP setup.
 */

// Save / restore env so tests don't leak settings
let savedEnv: Record<string, string | undefined> = {};
const ENV_VARS_TO_SAVE = [
  "PILOT_GUARDS_ALL_DISABLED",
  "PILOT_GUARD_FOXIFY_POOL_KILL_ENABLED",
  "PILOT_GUARD_FOXIFY_POOL_MIN_USDC",
  "PILOT_GUARD_AGGREGATE_LIABILITY_ENABLED",
  "PILOT_GUARD_AGGREGATE_LIABILITY_COVERAGE_PCT",
  "PILOT_GUARD_RECONCILIATION_ENABLED",
  "PILOT_GUARD_RECONCILIATION_DRIFT_PCT",
  "PILOT_GUARD_DVOL_HIGH_ENABLED",
  "PILOT_GUARD_DVOL_HIGH_THRESHOLD",
  "PILOT_GUARD_DVOL_HIGH_COOLDOWN_HOURS",
  "PILOT_GUARD_BULLISH_HEALTH_ENABLED",
  "PILOT_GUARD_BULLISH_HEALTH_5XX_RATE_MAX",
  "PILOT_GUARD_BULLISH_HEALTH_P95_LATENCY_MS_MAX",
  "PILOT_GUARD_BULLISH_HEALTH_MIN_SAMPLES",
  "PILOT_GUARD_PREMIUM_VELOCITY_ENABLED",
  "PILOT_GUARD_PREMIUM_VELOCITY_MAX_RATIO"
];

beforeEach(() => {
  savedEnv = {};
  for (const v of ENV_VARS_TO_SAVE) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of ENV_VARS_TO_SAVE) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

// ── Foxify pool kill-switch ──

test("Foxify pool kill: $0 pool (rev 6 default) → no block (pool not yet relied on)", () => {
  const v = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: 0,
    projectedPayoutLiabilityUsdc: 1000
  });
  assert.equal(v.allowed, true,
    "$0 pool means Foxify hasn't pre-funded; guard must not block");
});

test("Foxify pool kill: pool above floor → no block", () => {
  process.env.PILOT_GUARD_FOXIFY_POOL_MIN_USDC = "5000";
  const v = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: 25000,
    projectedPayoutLiabilityUsdc: 1000
  });
  assert.equal(v.allowed, true);
});

test("Foxify pool kill: trade would breach floor → BLOCK", () => {
  process.env.PILOT_GUARD_FOXIFY_POOL_MIN_USDC = "5000";
  const v = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: 5500,
    projectedPayoutLiabilityUsdc: 1000 // would leave pool at $4,500 < floor
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "foxify_pool_below_min_balance");
});

test("Foxify pool kill: env-disabled → no block", () => {
  process.env.PILOT_GUARD_FOXIFY_POOL_KILL_ENABLED = "false";
  const v = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: 100,
    projectedPayoutLiabilityUsdc: 1000
  });
  assert.equal(v.allowed, true);
});

// ── Aggregate liability cap ──

test("Aggregate liability: $0 pool → no block (rev 6 default)", () => {
  const v = checkAggregateLiabilityCap({
    foxifyPoolBalanceUsdc: 0,
    totalActivePayoutLiabilityUsdc: 100000,
    newPayoutLiabilityUsdc: 50000
  });
  assert.equal(v.allowed, true,
    "Without Foxify backstop, guard short-circuits — Atticus eats payout via hedge");
});

test("Aggregate liability: under coverage → no block", () => {
  const v = checkAggregateLiabilityCap({
    foxifyPoolBalanceUsdc: 25000,
    totalActivePayoutLiabilityUsdc: 5000,
    newPayoutLiabilityUsdc: 1000
  });
  // total liability $6k vs $25k pool × 80% = $20k allowed → fits
  assert.equal(v.allowed, true);
});

test("Aggregate liability: over coverage → BLOCK", () => {
  const v = checkAggregateLiabilityCap({
    foxifyPoolBalanceUsdc: 10000,
    totalActivePayoutLiabilityUsdc: 7500,
    newPayoutLiabilityUsdc: 1000 // total $8.5k > $10k × 0.8 = $8k
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "aggregate_liability_exceeds_pool_coverage");
});

// ── Reconciliation drift ──

test("Reconciliation: drift within tolerance → no block", () => {
  const v = checkReconciliationDrift({
    dbTrackedBalanceUsdc: 12000,
    venueReportedBalanceUsdc: 12050 // 0.4% drift
  });
  assert.equal(v.allowed, true);
});

test("Reconciliation: drift over tolerance → BLOCK", () => {
  const v = checkReconciliationDrift({
    dbTrackedBalanceUsdc: 12000,
    venueReportedBalanceUsdc: 11500 // 4.3% drift
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "reconciliation_drift_exceeded");
});

test("Reconciliation: zero venue balance → no block (no data to compare)", () => {
  const v = checkReconciliationDrift({
    dbTrackedBalanceUsdc: 12000,
    venueReportedBalanceUsdc: 0
  });
  assert.equal(v.allowed, true);
});

// ── High-DVOL pause ──

test("High DVOL: under threshold → no block", () => {
  const v = checkHighDvolPause({ currentDvol: 75, lastDvolThresholdCrossingMs: null });
  assert.equal(v.allowed, true);
});

test("High DVOL: at threshold → BLOCK", () => {
  const v = checkHighDvolPause({ currentDvol: 105, lastDvolThresholdCrossingMs: null });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "high_dvol_extreme_pause");
});

test("High DVOL: cooldown after spike → BLOCK", () => {
  const now = Date.now();
  const v = checkHighDvolPause({
    currentDvol: 60, // back to normal
    lastDvolThresholdCrossingMs: now - 30 * 60_000, // 30 min ago, < 1h cooldown
    nowMs: now
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "high_dvol_cooldown");
});

test("High DVOL: cooldown elapsed → no block", () => {
  const now = Date.now();
  const v = checkHighDvolPause({
    currentDvol: 60,
    lastDvolThresholdCrossingMs: now - 2 * 3600_000, // 2h ago, > 1h cooldown
    nowMs: now
  });
  assert.equal(v.allowed, true);
});

// ── Bullish API health ──

test("Bullish health: low sample count → no block (insufficient data)", () => {
  const v = checkBullishApiHealth({ recent5xxRate: 0.5, recentP95LatencyMs: 10000, sampleCount: 5 });
  assert.equal(v.allowed, true);
});

test("Bullish health: 5xx rate high → BLOCK", () => {
  const v = checkBullishApiHealth({ recent5xxRate: 0.15, recentP95LatencyMs: 1000, sampleCount: 50 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "bullish_api_5xx_rate_high");
});

test("Bullish health: latency high → BLOCK", () => {
  const v = checkBullishApiHealth({ recent5xxRate: 0.02, recentP95LatencyMs: 8000, sampleCount: 50 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "bullish_api_latency_high");
});

test("Bullish health: both healthy → no block", () => {
  const v = checkBullishApiHealth({ recent5xxRate: 0.02, recentP95LatencyMs: 800, sampleCount: 50 });
  assert.equal(v.allowed, true);
});

// ── Premium velocity ──

test("Premium velocity: no baseline → no block", () => {
  const v = checkPremiumVelocity({ todayPremiumIncomeUsdc: 5000, rollingAvgPremiumIncomeUsdc: 0 });
  assert.equal(v.allowed, true);
});

test("Premium velocity: under 3x avg → no block", () => {
  const v = checkPremiumVelocity({ todayPremiumIncomeUsdc: 600, rollingAvgPremiumIncomeUsdc: 300 });
  assert.equal(v.allowed, true);
});

test("Premium velocity: above 3x avg → BLOCK", () => {
  const v = checkPremiumVelocity({ todayPremiumIncomeUsdc: 1500, rollingAvgPremiumIncomeUsdc: 300 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "premium_velocity_exceeded");
});

// ── Composed checks ──

test("Wave 1 composed: first failing guard wins", () => {
  process.env.PILOT_GUARD_FOXIFY_POOL_MIN_USDC = "5000";
  const v = checkWave1Guards({
    foxifyPoolBalanceUsdc: 5500,
    totalActivePayoutLiabilityUsdc: 0,
    newPayoutLiabilityUsdc: 1000, // would breach pool floor
    dbTrackedAtticusBalanceUsdc: 12000,
    venueReportedAtticusBalanceUsdc: 12000
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "foxify_pool_below_min_balance",
    "Foxify pool guard should fire first since others are passing");
});

test("Wave 1 composed: all pass → allowed", () => {
  const v = checkWave1Guards({
    foxifyPoolBalanceUsdc: 25000,
    totalActivePayoutLiabilityUsdc: 5000,
    newPayoutLiabilityUsdc: 1000,
    dbTrackedAtticusBalanceUsdc: 12000,
    venueReportedAtticusBalanceUsdc: 12050
  });
  assert.equal(v.allowed, true);
});

test("Wave 2 composed: high DVOL fires", () => {
  const v = checkWave2Guards({
    currentDvol: 110,
    lastDvolThresholdCrossingMs: null,
    bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 500, sampleCount: 100 },
    todayPremiumIncomeUsdc: 100,
    rollingAvgPremiumIncomeUsdc: 200
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "high_dvol_extreme_pause");
});

test("Master kill-switch: PILOT_GUARDS_ALL_DISABLED disables every guard", () => {
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  const v = checkFoxifyPoolMinBalance({
    foxifyPoolBalanceUsdc: 100,
    projectedPayoutLiabilityUsdc: 99999
  });
  assert.equal(v.allowed, true,
    "Master kill-switch must override individual guard decisions");
});
