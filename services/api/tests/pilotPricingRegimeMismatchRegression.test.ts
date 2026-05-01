import assert from "node:assert/strict";
import test from "node:test";

import { getV7AvailableTiers } from "../src/pilot/v7Pricing.js";
import {
  recordDvolSample,
  __resetPricingRegimeForTests
} from "../src/pilot/pricingRegime.js";

// Regression for the production bug observed 2026-04-19:
//   /pilot/regime returned dvol=42.4, pricingRegime="low",
//   pricingRegimeLabel="Low" — but tiers[0].premiumPer1kUsd was 7
//   (the Moderate price). The cause: getV7AvailableTiers was being
//   passed the legacy 3-state regime "normal" by routes.ts, then
//   internally mapped legacy "normal" → Design A "moderate" and used
//   that for pricing, while pricingRegime/pricingRegimeLabel were
//   computed independently from Design A.
//
// The classifiers diverge in the 40–50 DVOL band:
//   legacy: calmBelow=40 → DVOL 42.4 = "normal"
//   Design A: lowMaxBelow=50 → DVOL 42.4 = "low"
//
// Fix: getV7AvailableTiers now ignores the legacy regime input and
// always sources pricing from Design A's classifier (or an explicit
// override, used by tests).
//
// This test exercises the exact scenario: DVOL 42.4 should produce
// "low" pricing for all tiers, not "moderate" pricing, regardless of
// what the legacy regime says. Note: 2% in low regime was raised from
// $6 → $7 on 2026-04-21 (PR C), so low and moderate now coincide on 2%
// — the regression remains meaningful for the 3% and other tiers
// where they still differ.

test("regression: DVOL 42.4 in 40-50 band uses Design A 'low' schedule, not legacy 'normal' → moderate mapping", () => {
  __resetPricingRegimeForTests();

  // Seed Design A's rolling window with samples averaging 42.4 (low band)
  const now = Date.now();
  recordDvolSample(42.0, now - 1800_000); // 30m ago
  recordDvolSample(42.4, now - 900_000);  // 15m ago
  recordDvolSample(42.8, now);

  // The bug-trigger call: pass legacy "normal" as the first arg, just
  // like routes.ts /pilot/regime endpoint does. With the fix, this
  // argument is ignored and Design A's "low" classifier wins.
  const tiers = getV7AvailableTiers("normal");

  const tier2 = tiers.find((t) => t.slPct === 2);
  assert.ok(tier2, "2% tier should exist");
  // 2026-04-25: low / 2% lowered from \$7 → \$6.50, while moderate / 2% stays
  // at \$7. The regression discriminator on the 2% tier is back: \$6.50 = low,
  // \$7 = moderate. If this were broken (legacy classifier winning), we'd see
  // \$7 here instead of \$6.50.
  assert.equal(
    tier2!.premiumPer1kUsd,
    6.5,
    `2% premium should be $6.50 (Design A 'low'), not $7 (legacy 'normal' → moderate). Got $${tier2!.premiumPer1kUsd}.`
  );

  const tier3 = tiers.find((t) => t.slPct === 3);
  assert.equal(
    tier3!.premiumPer1kUsd,
    5,
    `3% premium should be $5 (Design A 'low'), not $5.50 (legacy 'normal' → moderate). Got $${tier3!.premiumPer1kUsd}.`
  );

  const tier5 = tiers.find((t) => t.slPct === 5);
  assert.equal(tier5!.premiumPer1kUsd, 3, "5% premium should be $3");

  const tier10 = tiers.find((t) => t.slPct === 10);
  assert.equal(tier10!.premiumPer1kUsd, 2, "10% premium should be $2");
});

test("regression: explicit pricingRegimeOverride still wins over live classifier", () => {
  __resetPricingRegimeForTests();
  const now = Date.now();
  recordDvolSample(42.4, now); // would resolve to 'low' if not overridden

  const tiers = getV7AvailableTiers(undefined, "high");
  const tier2 = tiers.find((t) => t.slPct === 2);
  assert.equal(tier2!.premiumPer1kUsd, 10, "explicit 'high' override should produce $10 ceiling");
});

test("regression: legacy regime input is ignored even at the boundary values that previously caused divergence", () => {
  __resetPricingRegimeForTests();
  const now = Date.now();
  // DVOL 45 — squarely in the 40-50 band where the two classifiers
  // disagreed (legacy 'normal' vs Design A 'low').
  recordDvolSample(45, now);

  // Try every legacy value; Design A 'low' should win for all.
  // We assert on the 3% tier because 2% low/moderate are now $7 after
  // PR C — only the 3% tier still differs ($5 low vs $5.50 moderate).
  for (const legacy of ["calm", "normal", "stress"] as const) {
    const tiers = getV7AvailableTiers(legacy);
    const tier3 = tiers.find((t) => t.slPct === 3);
    assert.equal(
      tier3!.premiumPer1kUsd,
      5,
      `legacy='${legacy}' should be ignored → Design A 'low' → 3% = $5 (got $${tier3!.premiumPer1kUsd})`
    );
  }
});
