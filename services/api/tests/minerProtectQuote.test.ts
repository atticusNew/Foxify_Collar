/**
 * Miner Protect engine — economics (power/cost/production/breakeven) + breakeven-floor + recommendation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  powerKw, costPerDayUsd, btcPerDay, breakevenPriceUsd,
  buildMinerProtectQuote, pickRecommendedFloor, type MinerInputs
} from "../src/minerProtect/minerProtectQuote";

// 100,000 TH/s @ 30 W/TH, $0.05/kWh, no extra opex; network 7.5e-7 BTC/TH/day; BTC $60k; 30d.
//   power 3,000 kW · cost $3,600/day · 0.075 BTC/day · breakeven $48,000 · 2.25 BTC over 30d.
const miner: MinerInputs = {
  hashrateThs: 100_000, efficiencyWPerTh: 30, powerCostUsdPerKwh: 0.05,
  btcPerThPerDay: 0.00000075, btcPrice: 60_000, tenorDays: 30
};

test("economics: power, cost/day, BTC/day, breakeven price", () => {
  assert.equal(powerKw(100_000, 30), 3_000);
  assert.equal(costPerDayUsd(miner), 3_600);
  assert.equal(btcPerDay(100_000, 0.00000075), 0.075);
  assert.equal(breakevenPriceUsd(3_600, 0.075), 48_000);
});

test("quote: miner block carries breakeven, expected production, period cost, gross revenue", () => {
  const q = buildMinerProtectQuote(miner, { floors: [{ strike: 48_000, askUsdcPerBtc: 1_000 }] });
  assert.equal(q.miner.breakeven_price_usd, 48_000);
  assert.equal(q.miner.expected_production_btc, 2.25);
  assert.equal(q.miner.period_cost_usd, 108_000);   // 3,600 × 30
  assert.equal(q.miner.gross_revenue_usd, 135_000); // 2.25 × 60,000
  assert.equal(q.miner.btc_per_day, 0.075);
});

test("quote: hashprice ($/TH/day) + hashprice breakeven (miner-native metrics)", () => {
  const q = buildMinerProtectQuote(miner, { floors: [{ strike: 48_000, askUsdcPerBtc: 1_000 }] });
  // hashprice = btcPerThPerDay × spot = 7.5e-7 × 60,000 = 0.045 $/TH/day
  assert.ok(Math.abs(q.miner.hashprice_usd_per_th_day - 0.045) < 1e-6, `${q.miner.hashprice_usd_per_th_day}`);
  assert.equal(q.miner.hashprice_btc_per_th_day, 0.00000075);
  // breakeven hashprice = cost/day ÷ hashrate = 3,600 / 100,000 = 0.036 $/TH/day (profitable above)
  assert.ok(Math.abs(q.miner.breakeven_hashprice_usd_per_th_day - 0.036) < 1e-6, `${q.miner.breakeven_hashprice_usd_per_th_day}`);
  assert.equal(q.miner.profitable_at_spot, true);
});

test("breakeven-strike floor: max margin erosion ≈ premium (does NOT fully cover cost)", () => {
  const q = buildMinerProtectQuote(miner, { floors: [{ strike: 48_000, askUsdcPerBtc: 1_000 }] });
  const o = q.options[0];
  assert.equal(o.premium_usd, 2_250);               // 1,000 × 2.25 (identity pricer)
  assert.equal(o.revenue_floor_usd, 105_750);       // 48,000 × 2.25 − 2,250
  assert.equal(o.covers_cost, false);               // 105,750 < 108,000 (short by the premium)
  assert.equal(o.protected_margin_usd, -2_250);
  assert.equal(o.label, "Breakeven floor $48,000");
});

test("recommendation: cheapest floor that KEEPS the miner cash-flow positive (covers cost)", () => {
  const q = buildMinerProtectQuote(miner, {
    floors: [
      { strike: 48_000, askUsdcPerBtc: 1_000 }, // breakeven — does not cover (premium erosion)
      { strike: 52_800, askUsdcPerBtc: 2_000 }, // +10% — revenue floor 114,300 ≥ 108,000 → covers
      { strike: 43_200, askUsdcPerBtc: 400 }    // −10% — 96,300 < 108,000 → does not cover
    ]
  });
  const rec = q.options.find((o) => o.recommended);
  assert.ok(rec);
  assert.equal(rec!.strike, 52_800);                 // cheapest floor that covers cost
  assert.equal(rec!.covers_cost, true);
  assert.equal(rec!.revenue_floor_usd, 114_300);    // 52,800 × 2.25 − 4,500
  assert.equal(q.options.filter((o) => o.recommended).length, 1);
  assert.match(rec!.label, /^Floor \$52,800/);       // spot-relative label (price $60k)
  assert.equal(q.miner.profitable_at_spot, true);    // spot 60k > breakeven 48k
});

test("margin floor: recTargetMarginPct picks the cheapest floor guaranteeing that profit margin", () => {
  // gross revenue = 2.25 × 60,000 = 135,000. Three cost-covering floors with rising margin.
  const floors = [
    { floorPct: 0, strike: 58_000, askUsdcPerBtc: 180 },  // margin ≈ 22,095 (16.4%)
    { floorPct: 0, strike: 60_000, askUsdcPerBtc: 400 },  // margin ≈ 26,100 (19.3%)
    { floorPct: 0, strike: 63_000, askUsdcPerBtc: 800 }   // margin ≈ 31,950 (23.7%)
  ];
  const base = buildMinerProtectQuote(miner, { floors });
  assert.equal(base.options.find((o) => o.recommended)!.strike, 58_000); // default: cheapest covering
  assert.ok(base.options[0].protected_margin_pct > 0.15);                 // pct surfaced

  const targeted = buildMinerProtectQuote(miner, { floors, recTargetMarginPct: 0.18 });
  const rec = targeted.options.find((o) => o.recommended)!;
  assert.ok(rec.protected_margin_pct >= 0.18, `rec margin ${rec.protected_margin_pct}`);
  assert.equal(rec.strike, 60_000); // cheapest floor that locks ≥18% margin
});

test("recommendation fallback: nothing covers cost → closest to breakeven", () => {
  const q = buildMinerProtectQuote(miner, {
    floors: [{ strike: 43_200, askUsdcPerBtc: 400 }, { strike: 40_000, askUsdcPerBtc: 200 }]
  });
  const rec = pickRecommendedFloor(q.options);
  const recOpt = q.options.find((o) => o.id === rec);
  assert.equal(recOpt?.strike, 43_200); // |−10%| < |−16.7%|
  assert.equal(recOpt?.covers_cost, false);
});
