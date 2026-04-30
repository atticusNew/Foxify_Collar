import assert from "node:assert/strict";
import test from "node:test";

import {
  BIWEEKLY_DEFAULT_RATES,
  BIWEEKLY_MAX_TENOR_DAYS,
  BIWEEKLY_HEDGE_TENOR_DAYS,
  BIWEEKLY_MIN_DAYS_BILLED,
  buildBiweeklyQuotePreview,
  clearBiweeklyRateOverride,
  computeAccumulatedCharge,
  computeDaysHeld,
  computeMaxProjectedCharge,
  getBiweeklyRatePerDayPer1k,
  isBiweeklyEnabled,
  setBiweeklyRateOverride
} from "../src/pilot/biweeklyPricing.js";

// Biweekly pricing module — PR 1 of the biweekly cutover sequence.
//
// Tests cover:
//   - Default rate table matches the CEO-confirmed baseline
//   - Tenor constants are 14 days for both max and hedge
//   - Rate overrides work via runtime + env, in priority order
//   - Accumulated charge math is correct including rounding rules
//   - Max projected charge = rate × max × notional/1000
//   - Days held math handles clock skew defensively
//   - Quote preview builder produces correct trader-facing numbers
//   - Feature flag respects multiple truthy env values
//
// Note: this PR is additive only — it does not touch the live 1-day
// product code. No regression coverage on existing modules is needed.

// ─────────────────────────────────────────────────────────────────────
// Default rate table
// ─────────────────────────────────────────────────────────────────────

test("default rate table matches CEO-confirmed baseline (2026-04-30)", () => {
  // Per CEO direction: $2.50 for 2-3%, $2.00 for 5%, $1.50 for 10%.
  // 1% defined for forward compatibility but not in V7_LAUNCHED_TIERS.
  assert.equal(BIWEEKLY_DEFAULT_RATES[2], 2.5);
  assert.equal(BIWEEKLY_DEFAULT_RATES[3], 2.5);
  assert.equal(BIWEEKLY_DEFAULT_RATES[5], 2.0);
  assert.equal(BIWEEKLY_DEFAULT_RATES[10], 1.5);
  // 1% mirrors 2% pricing so future launch doesn't accidentally underprice
  assert.equal(BIWEEKLY_DEFAULT_RATES[1], 2.5);
});

test("tenor constants: max user duration and hedge tenor both 14 days", () => {
  assert.equal(BIWEEKLY_MAX_TENOR_DAYS, 14);
  assert.equal(BIWEEKLY_HEDGE_TENOR_DAYS, 14);
  // Min billed days is 1 (anti-abuse: open + immediate close still bills 1d)
  assert.equal(BIWEEKLY_MIN_DAYS_BILLED, 1);
});

// ─────────────────────────────────────────────────────────────────────
// Rate resolution: default → env → runtime override
// ─────────────────────────────────────────────────────────────────────

test("getBiweeklyRatePerDayPer1k: returns default when no override", () => {
  clearBiweeklyRateOverride();
  delete process.env.PILOT_BIWEEKLY_RATE_2PCT;
  assert.equal(getBiweeklyRatePerDayPer1k(2), 2.5);
  assert.equal(getBiweeklyRatePerDayPer1k(5), 2.0);
});

test("getBiweeklyRatePerDayPer1k: env var overrides default", () => {
  clearBiweeklyRateOverride();
  process.env.PILOT_BIWEEKLY_RATE_2PCT = "3.75";
  try {
    assert.equal(getBiweeklyRatePerDayPer1k(2), 3.75);
    // Other tiers unaffected
    assert.equal(getBiweeklyRatePerDayPer1k(5), 2.0);
  } finally {
    delete process.env.PILOT_BIWEEKLY_RATE_2PCT;
  }
});

test("getBiweeklyRatePerDayPer1k: runtime override beats env var", () => {
  clearBiweeklyRateOverride();
  process.env.PILOT_BIWEEKLY_RATE_2PCT = "3.75";
  setBiweeklyRateOverride(2, 9.99);
  try {
    assert.equal(getBiweeklyRatePerDayPer1k(2), 9.99);
  } finally {
    delete process.env.PILOT_BIWEEKLY_RATE_2PCT;
    clearBiweeklyRateOverride();
  }
});

test("getBiweeklyRatePerDayPer1k: invalid env values fall through to default", () => {
  clearBiweeklyRateOverride();
  for (const bad of ["", "abc", "0", "-1", "NaN"]) {
    process.env.PILOT_BIWEEKLY_RATE_2PCT = bad;
    assert.equal(
      getBiweeklyRatePerDayPer1k(2),
      2.5,
      `bad env value ${JSON.stringify(bad)} should fall through to default`
    );
  }
  delete process.env.PILOT_BIWEEKLY_RATE_2PCT;
});

test("setBiweeklyRateOverride: rejects non-positive rates (anti-foot-gun)", () => {
  assert.throws(() => setBiweeklyRateOverride(2, 0));
  assert.throws(() => setBiweeklyRateOverride(2, -1));
  assert.throws(() => setBiweeklyRateOverride(2, NaN));
  clearBiweeklyRateOverride();
});

// ─────────────────────────────────────────────────────────────────────
// Accumulated charge math
// ─────────────────────────────────────────────────────────────────────

test("computeAccumulatedCharge: 1 day, $10k, 2% = $25.00", () => {
  clearBiweeklyRateOverride();
  const charge = computeAccumulatedCharge({
    daysHeld: 1,
    notionalUsd: 10000,
    slPct: 2
  });
  assert.equal(charge, 25.0);
});

test("computeAccumulatedCharge: 7 days, $10k, 2% = $175", () => {
  clearBiweeklyRateOverride();
  const charge = computeAccumulatedCharge({
    daysHeld: 7,
    notionalUsd: 10000,
    slPct: 2
  });
  assert.equal(charge, 175.0);
});

test("computeAccumulatedCharge: max tenor, $10k, 2% = $350 (14 days)", () => {
  clearBiweeklyRateOverride();
  const charge = computeAccumulatedCharge({
    daysHeld: 14,
    notionalUsd: 10000,
    slPct: 2
  });
  assert.equal(charge, 350.0);
});

test("computeAccumulatedCharge: rounds days UP to nearest whole day", () => {
  clearBiweeklyRateOverride();
  // 0.5 days → ceil to 1 → $25
  assert.equal(computeAccumulatedCharge({ daysHeld: 0.5, notionalUsd: 10000, slPct: 2 }), 25.0);
  // 2.1 days → ceil to 3 → $75
  assert.equal(computeAccumulatedCharge({ daysHeld: 2.1, notionalUsd: 10000, slPct: 2 }), 75.0);
  // 1.9999 days → ceil to 2 → $50
  assert.equal(computeAccumulatedCharge({ daysHeld: 1.9999, notionalUsd: 10000, slPct: 2 }), 50.0);
});

test("computeAccumulatedCharge: clamps below MIN_DAYS_BILLED to 1 day", () => {
  clearBiweeklyRateOverride();
  // 0 days held → still bills the minimum (1 day) so trader can't dodge
  // by opening + immediately closing
  assert.equal(computeAccumulatedCharge({ daysHeld: 0, notionalUsd: 10000, slPct: 2 }), 25.0);
  assert.equal(computeAccumulatedCharge({ daysHeld: 0.001, notionalUsd: 10000, slPct: 2 }), 25.0);
});

test("computeAccumulatedCharge: clamps above MAX_TENOR_DAYS to 14 days", () => {
  clearBiweeklyRateOverride();
  // 15 days → clamps to 14 → $350 (matching held-to-expiry case)
  assert.equal(computeAccumulatedCharge({ daysHeld: 15, notionalUsd: 10000, slPct: 2 }), 350.0);
  // 100 days → clamps to 14 → $350
  assert.equal(computeAccumulatedCharge({ daysHeld: 100, notionalUsd: 10000, slPct: 2 }), 350.0);
});

test("computeAccumulatedCharge: handles bad inputs defensively (returns 0)", () => {
  clearBiweeklyRateOverride();
  assert.equal(computeAccumulatedCharge({ daysHeld: -1, notionalUsd: 10000, slPct: 2 }), 0);
  assert.equal(computeAccumulatedCharge({ daysHeld: NaN, notionalUsd: 10000, slPct: 2 }), 0);
  assert.equal(computeAccumulatedCharge({ daysHeld: 1, notionalUsd: 0, slPct: 2 }), 0);
  assert.equal(computeAccumulatedCharge({ daysHeld: 1, notionalUsd: -100, slPct: 2 }), 0);
});

test("computeAccumulatedCharge: per-tier rates differentiated correctly", () => {
  clearBiweeklyRateOverride();
  // Same 2-day hold, $10k notional, different tiers:
  assert.equal(computeAccumulatedCharge({ daysHeld: 2, notionalUsd: 10000, slPct: 2 }), 50.0);  // 2 × $25
  assert.equal(computeAccumulatedCharge({ daysHeld: 2, notionalUsd: 10000, slPct: 3 }), 50.0);  // 2 × $25 (3% same as 2%)
  assert.equal(computeAccumulatedCharge({ daysHeld: 2, notionalUsd: 10000, slPct: 5 }), 40.0);  // 2 × $20
  assert.equal(computeAccumulatedCharge({ daysHeld: 2, notionalUsd: 10000, slPct: 10 }), 30.0); // 2 × $15
});

test("computeAccumulatedCharge: respects runtime rate override", () => {
  clearBiweeklyRateOverride();
  setBiweeklyRateOverride(2, 5.0); // double the default
  try {
    // 1 day, $10k, 2% → $50 (was $25 at default)
    assert.equal(computeAccumulatedCharge({ daysHeld: 1, notionalUsd: 10000, slPct: 2 }), 50.0);
  } finally {
    clearBiweeklyRateOverride();
  }
});

test("computeAccumulatedCharge: rounds final result to cents (no sub-penny drift)", () => {
  clearBiweeklyRateOverride();
  // $7,777 notional, 1 day, 2% rate $2.50/$1k → $19.4425 → rounds to $19.44
  const charge = computeAccumulatedCharge({ daysHeld: 1, notionalUsd: 7777, slPct: 2 });
  assert.equal(charge, 19.44);
});

// ─────────────────────────────────────────────────────────────────────
// Max projected charge
// ─────────────────────────────────────────────────────────────────────

test("computeMaxProjectedCharge: $10k 2% = $350 (14 days × $2.50/$1k × 10)", () => {
  clearBiweeklyRateOverride();
  assert.equal(computeMaxProjectedCharge({ notionalUsd: 10000, slPct: 2 }), 350.0);
});

test("computeMaxProjectedCharge: scales linearly with notional", () => {
  clearBiweeklyRateOverride();
  assert.equal(computeMaxProjectedCharge({ notionalUsd: 5000, slPct: 2 }), 175.0);
  assert.equal(computeMaxProjectedCharge({ notionalUsd: 25000, slPct: 2 }), 875.0);
});

// ─────────────────────────────────────────────────────────────────────
// computeDaysHeld
// ─────────────────────────────────────────────────────────────────────

test("computeDaysHeld: returns fractional day count", () => {
  const activated = Date.UTC(2026, 3, 1, 0, 0, 0); // 2026-04-01 00:00:00Z
  const now = Date.UTC(2026, 3, 3, 12, 0, 0); // 2026-04-03 12:00:00Z = 2.5 days later
  assert.equal(computeDaysHeld({ activatedAtMs: activated, nowMs: now }), 2.5);
});

test("computeDaysHeld: returns 0 on clock skew (now < activated)", () => {
  const activated = Date.now() + 60000; // future
  const now = Date.now();
  assert.equal(computeDaysHeld({ activatedAtMs: activated, nowMs: now }), 0);
});

test("computeDaysHeld: defaults nowMs to Date.now()", () => {
  const activated = Date.now() - 86400000; // 1 day ago
  const result = computeDaysHeld({ activatedAtMs: activated });
  assert.ok(result >= 0.99 && result <= 1.01, `expected ~1.0 day, got ${result}`);
});

// ─────────────────────────────────────────────────────────────────────
// Quote preview builder
// ─────────────────────────────────────────────────────────────────────

test("buildBiweeklyQuotePreview: 2% on $10k", () => {
  clearBiweeklyRateOverride();
  const q = buildBiweeklyQuotePreview({ notionalUsd: 10000, slPct: 2 });
  assert.equal(q.ratePerDayPer1kUsd, 2.5);
  assert.equal(q.ratePerDayUsd, 25.0);
  assert.equal(q.maxProjectedChargeUsd, 350.0);
  assert.equal(q.maxTenorDays, 14);
  assert.equal(q.payoutOnTriggerUsd, 200.0);
});

test("buildBiweeklyQuotePreview: 5% on $25k", () => {
  clearBiweeklyRateOverride();
  const q = buildBiweeklyQuotePreview({ notionalUsd: 25000, slPct: 5 });
  // 5% rate is $2/$1k/day → $50/day on $25k
  assert.equal(q.ratePerDayPer1kUsd, 2.0);
  assert.equal(q.ratePerDayUsd, 50.0);
  // 14 × $50 = $700 max
  assert.equal(q.maxProjectedChargeUsd, 700.0);
  // Payout = 5% × $25k = $1,250
  assert.equal(q.payoutOnTriggerUsd, 1250.0);
});

test("buildBiweeklyQuotePreview: 10% on $10k", () => {
  clearBiweeklyRateOverride();
  const q = buildBiweeklyQuotePreview({ notionalUsd: 10000, slPct: 10 });
  // 10% rate is $1.50/$1k/day → $15/day on $10k
  assert.equal(q.ratePerDayPer1kUsd, 1.5);
  assert.equal(q.ratePerDayUsd, 15.0);
  // 14 × $15 = $210 max
  assert.equal(q.maxProjectedChargeUsd, 210.0);
  // Payout = 10% × $10k = $1,000
  assert.equal(q.payoutOnTriggerUsd, 1000.0);
});

// ─────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────

test("isBiweeklyEnabled: defaults to false (safe default)", () => {
  delete process.env.PILOT_BIWEEKLY_ENABLED;
  assert.equal(isBiweeklyEnabled(), false);
});

test("isBiweeklyEnabled: accepts multiple truthy values", () => {
  for (const truthy of ["true", "True", "TRUE", "1", "yes", "YES"]) {
    process.env.PILOT_BIWEEKLY_ENABLED = truthy;
    assert.equal(isBiweeklyEnabled(), true, `${JSON.stringify(truthy)} should enable`);
  }
  delete process.env.PILOT_BIWEEKLY_ENABLED;
});

test("isBiweeklyEnabled: rejects falsy / non-truthy values", () => {
  for (const falsy of ["false", "0", "no", "off", "", "  ", "abc"]) {
    process.env.PILOT_BIWEEKLY_ENABLED = falsy;
    assert.equal(isBiweeklyEnabled(), false, `${JSON.stringify(falsy)} should NOT enable`);
  }
  delete process.env.PILOT_BIWEEKLY_ENABLED;
});

test("isBiweeklyEnabled: trims whitespace", () => {
  process.env.PILOT_BIWEEKLY_ENABLED = "  true  ";
  assert.equal(isBiweeklyEnabled(), true);
  delete process.env.PILOT_BIWEEKLY_ENABLED;
});
