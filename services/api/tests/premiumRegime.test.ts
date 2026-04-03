import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { applyPremiumRegimeOverlay, resolvePremiumRegime, __resetPremiumRegimeStateForTests } from "../src/pilot/premiumRegime";
import type { PremiumRegimeRuntimeConfig } from "../src/pilot/config";

const buildConfig = (overrides?: Partial<PremiumRegimeRuntimeConfig>): PremiumRegimeRuntimeConfig => ({
  enabled: true,
  applyToActuarialStrict: false,
  lookbackMinutes: 240,
  minSamples: 10,
  minDwellMinutes: 30,
  maxOverlayPctOfBasePremium: 1,
  watchAddUsdPer1k: 2,
  watchMultiplier: 1,
  stressAddUsdPer1k: 4,
  stressMultiplier: 1,
  enterWatchTriggerHitRatePct: 8,
  enterWatchSubsidyUtilizationPct: 50,
  enterWatchTreasuryDrawdownPct: 20,
  enterStressTriggerHitRatePct: 15,
  enterStressSubsidyUtilizationPct: 80,
  enterStressTreasuryDrawdownPct: 35,
  exitWatchTriggerHitRatePct: 5,
  exitWatchSubsidyUtilizationPct: 35,
  exitWatchTreasuryDrawdownPct: 12,
  exitStressTriggerHitRatePct: 10,
  exitStressSubsidyUtilizationPct: 60,
  exitStressTreasuryDrawdownPct: 25,
  ...(overrides || {})
});

test("premium regime enters stress and respects dwell before downgrade", () => {
  __resetPremiumRegimeStateForTests();
  const config = buildConfig({ minDwellMinutes: 60 });
  const t0 = Date.now();
  const stressDecision = resolvePremiumRegime({
    scopeKey: "global",
    config,
    nowMs: t0,
    metrics: {
      sampleCount: 20,
      triggerHitRatePct: 16,
      subsidyUtilizationPct: 85,
      treasuryDrawdownPct: 40
    }
  });
  assert.equal(stressDecision.regime, "stress");
  assert.equal(stressDecision.changed, true);

  const earlyDowngrade = resolvePremiumRegime({
    scopeKey: "global",
    config,
    nowMs: t0 + 10 * 60_000,
    metrics: {
      sampleCount: 20,
      triggerHitRatePct: 2,
      subsidyUtilizationPct: 5,
      treasuryDrawdownPct: 2
    }
  });
  assert.equal(earlyDowngrade.regime, "stress");
  assert.equal(earlyDowngrade.changed, false);
  assert.match(earlyDowngrade.reason, /min_dwell_hold|stress_exit_thresholds_not_met/);
});

test("premium regime overlay applies add-per-1k and cap", () => {
  const config = buildConfig({
    maxOverlayPctOfBasePremium: 0.1,
    stressAddUsdPer1k: 10,
    stressMultiplier: 1.5
  });
  const overlay = applyPremiumRegimeOverlay({
    basePremiumUsd: new Decimal(100),
    protectedNotionalUsd: new Decimal(10000),
    regime: "stress",
    config,
    enabledForPricingMode: true
  });
  assert.equal(overlay.applied, true);
  // Raw overlay would exceed cap; ensure capped to 10% of base.
  assert.equal(overlay.overlayUsd.toFixed(4), "10.0000");
  assert.equal(overlay.adjustedPremiumUsd.toFixed(4), "110.0000");
});

test("premium regime overlay is no-op when disabled for pricing mode", () => {
  const config = buildConfig();
  const overlay = applyPremiumRegimeOverlay({
    basePremiumUsd: new Decimal(50),
    protectedNotionalUsd: new Decimal(5000),
    regime: "watch",
    config,
    enabledForPricingMode: false
  });
  assert.equal(overlay.applied, false);
  assert.equal(overlay.adjustedPremiumUsd.toFixed(4), "50.0000");
});
