/**
 * Floor-tier bundle — the "Protected Leverage" menu (risk X% of margin → cheapest long put).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  strikeForMarginFraction,
  buildFloorTier,
  buildFloorTierBundle,
  buildPositionCard,
  pickRecommended,
  DEFAULT_TIER_FRACTIONS,
  type FloorTierBundleInputs,
  type TierPutQuote,
  type FloorTier
} from "../src/singleSide/twoSided/floorTiers";

const base: FloorTierBundleInputs = { spot: 66000, sizeBtc: 1, leverage: 10, tenorDays: 3 };

test("strikeForMarginFraction: floorPct = fraction / leverage (clean mapping)", () => {
  assert.deepEqual(strikeForMarginFraction(66000, 10, 0.5), { floorPct: 0.05, strike: 62700 });
  assert.deepEqual(strikeForMarginFraction(66000, 10, 0.25), { floorPct: 0.025, strike: 64350 });
  assert.deepEqual(strikeForMarginFraction(66000, 20, 0.5), { floorPct: 0.025, strike: 64350 });
});

test("buildPositionCard: notional/margin/liq are correct", () => {
  const c = buildPositionCard(base);
  assert.equal(c.notional_usdc, 66000);
  assert.equal(c.margin_usdc, 6600);
  assert.equal(c.liquidation_price, 59400);
  assert.equal(c.liq_drop_pct, 0.1);
  assert.ok(/10×/.test(c.liq_summary) && /10\.0%/.test(c.liq_summary));
});

test("buildFloorTier: available tier caps worst case at f·margin + premium (gap-proof)", () => {
  const best: TierPutQuote = { venue: "okx", ask_usdc_per_btc: 1000, instrument: "BTC-USD-…-62700-P" };
  const t = buildFloorTier(base, 0.5, best);
  assert.equal(t.adds_value, true);
  assert.equal(t.available, true);
  assert.equal(t.floor_pct, 0.05);
  assert.equal(t.floor_strike, 62700);
  assert.equal(t.put_cost_usdc, 1000);
  // worst case = 0.5×6600 (price loss) + 1000 premium = 3300 + 1000 = 4300
  assert.equal(t.max_loss_usdc, 4300);
  assert.equal(t.cost_per_day_usdc, +(1000 / 3).toFixed(2));
  assert.equal(t.venue, "okx");
  assert.ok(/Cap your worst case/.test(t.headline));
});

test("buildFloorTier: fraction >= 1 → floor at/beyond liquidation → unavailable (cost-only)", () => {
  const t = buildFloorTier(base, 1.5, { venue: "okx", ask_usdc_per_btc: 500 });
  assert.equal(t.adds_value, false);
  assert.equal(t.available, false);
  assert.equal(t.put_cost_usdc, null);
  assert.ok(/liquidation|leverage/.test(t.unavailable_reason ?? ""));
});

test("buildFloorTier: no live quote → available=false with reason", () => {
  const t = buildFloorTier(base, 0.5, { venue: "okx", ask_usdc_per_btc: null });
  assert.equal(t.adds_value, true);
  assert.equal(t.available, false);
  assert.ok(/no live put quote/.test(t.unavailable_reason ?? ""));
});

test("pickRecommended: prefers the balanced 50% tier when it's worth it", () => {
  const tiers: FloorTier[] = [
    buildFloorTier(base, 0.25, { venue: "okx", ask_usdc_per_btc: 1000 }),
    buildFloorTier(base, 0.5, { venue: "okx", ask_usdc_per_btc: 1000 }),
    buildFloorTier(base, 0.75, { venue: "okx", ask_usdc_per_btc: 1000 })
  ];
  const idx = pickRecommended(tiers, 6600);
  assert.equal(tiers[idx].margin_fraction, 0.5);
});

test("buildFloorTierBundle: full bundle with one recommended tier", () => {
  const quotes = new Map<number, TierPutQuote | null>([
    [0.25, { venue: "deribit", ask_usdc_per_btc: 1100, instrument: "D-25" }],
    [0.5, { venue: "okx", ask_usdc_per_btc: 1000, instrument: "O-50" }],
    [0.75, { venue: "bullish", ask_usdc_per_btc: 900, instrument: "B-75" }]
  ]);
  const bundle = buildFloorTierBundle({ ...base, fractions: [...DEFAULT_TIER_FRACTIONS] }, quotes);
  assert.equal(bundle.tiers.length, 3);
  assert.equal(bundle.position.margin_usdc, 6600);
  assert.equal(bundle.tiers.filter((t) => t.recommended).length, 1);
  assert.ok(bundle.tiers.every((t) => t.available));
});

test("buildFloorTier: worst case is computed from the ACTUAL priced strike (venue snapping)", () => {
  // Target strike for 50% @ 10x is 62700, but the venue actually priced the 62000 strike.
  const t = buildFloorTier(base, 0.5, { venue: "okx", ask_usdc_per_btc: 1000, strike: 62000 });
  assert.equal(t.available, true);
  assert.equal(t.floor_strike, 62000, "uses the actual listed strike, not the theoretical target");
  // worst case must use 62000: (66000-62000)*1 + 1000 = 4000 + 1000 = 5000 (NOT the 62700 figure).
  assert.equal(t.max_loss_usdc, 5000);
});

test("buildFloorTierBundle: tiers that snap to the SAME listed strike are de-duplicated", () => {
  const sameStrike: TierPutQuote = { venue: "okx", ask_usdc_per_btc: 661.44, strike: 61000 };
  const quotes = new Map<number, TierPutQuote | null>([
    [0.25, { venue: "okx", ask_usdc_per_btc: 864.96, strike: 61500 }],
    [0.5, sameStrike],
    [0.75, sameStrike]
  ]);
  const bundle = buildFloorTierBundle({ ...base, fractions: [0.25, 0.5, 0.75] }, quotes);
  // 0.5 and 0.75 both priced the 61000 strike → collapse to one; 0.25 (61500) stays distinct.
  assert.equal(bundle.tiers.length, 2);
  const strikes = bundle.tiers.map((t) => t.floor_strike).sort((a, b) => a - b);
  assert.deepEqual(strikes, [61000, 61500]);
  assert.equal(bundle.tiers.filter((t) => t.recommended).length, 1);
});

test("buildFloorTier: high leverage where the nearest listed strike falls at/below liq → unavailable", () => {
  // 40x → liq 2.5% (liq price 64350). Nearest listed put landed at 60000 (9.1% below) → no floor.
  const hi = { spot: 66000, sizeBtc: 1, leverage: 40, tenorDays: 3 };
  const t = buildFloorTier(hi, 0.5, { venue: "okx", ask_usdc_per_btc: 300, strike: 60000 });
  assert.equal(t.available, false);
  assert.equal(t.adds_value, false);
  assert.ok(/liquidation|reduce leverage/.test(t.unavailable_reason ?? ""));
});

test("buildFloorTierBundle: when no listed strike is tradable, returns rows but none available", () => {
  const hi = { spot: 66000, sizeBtc: 1, leverage: 40, tenorDays: 3, fractions: [0.25, 0.5, 0.75] };
  const farQuote: TierPutQuote = { venue: "okx", ask_usdc_per_btc: 300, strike: 60000 }; // 9.1% below, outside 2.5% liq
  const quotes = new Map<number, TierPutQuote | null>([[0.25, farQuote], [0.5, farQuote], [0.75, farQuote]]);
  const bundle = buildFloorTierBundle(hi, quotes);
  assert.equal(bundle.tiers.every((t) => !t.available), true);
});

test("buildFloorTierBundle: 40x position keeps all sub-100%-margin tiers valid (inside liq)", () => {
  const quotes = new Map<number, TierPutQuote | null>([
    [0.25, { venue: "okx", ask_usdc_per_btc: 400 }],
    [0.5, { venue: "okx", ask_usdc_per_btc: 500 }],
    [0.75, { venue: "okx", ask_usdc_per_btc: 600 }]
  ]);
  const bundle = buildFloorTierBundle({ spot: 66000, sizeBtc: 1, leverage: 40, tenorDays: 3, fractions: [0.25, 0.5, 0.75] }, quotes);
  // liq at 40x = 2.5%; tiers map to 0.625% / 1.25% / 1.875% — all inside → all add value.
  assert.ok(bundle.tiers.every((t) => t.adds_value));
  assert.equal(bundle.position.liq_drop_pct, 0.025);
});
