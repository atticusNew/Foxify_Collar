/**
 * Miner Protect PR3 — production strip (multi-tenor) + hedge monitoring/roll evaluator.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildProductionStrip, evaluateHedge, DEFAULT_MONITOR_CONFIG, type ActiveHedge } from "../src/minerProtect/minerProtectStrip";
import type { FloorSource } from "../src/minerProtect/minerProtectSourcing";
import type { MinerInputs } from "../src/minerProtect/minerProtectQuote";

const miner: MinerInputs = {
  hashrateThs: 100_000, efficiencyWPerTh: 30, powerCostUsdPerKwh: 0.05,
  btcPerThPerDay: 0.00000075, btcPrice: 60_000, tenorDays: 30
};

test("buildProductionStrip: one quote per tenor; production scales with tenor; total premium summed", async () => {
  const sourcePut = async (strike: number, _tenor: number): Promise<FloorSource> => ({
    best: { strike, ask: Math.max(50, (strike - 40_000) / 10), venue: "deribit", spreadPct: 0.02 },
    considered: ["okx", "deribit"]
  });
  const strip = await buildProductionStrip(miner, { tenors: [30, 60, 90], sourcePut });
  assert.equal(strip.legs.length, 3);
  assert.deepEqual(strip.legs.map((l) => l.tenor_days), [30, 60, 90]);
  // production grows with tenor: 0.075 BTC/day × tenor.
  assert.equal(strip.legs[0].quote.miner.expected_production_btc, 2.25);
  assert.equal(strip.legs[2].quote.miner.expected_production_btc, 6.75);
  assert.ok(strip.total_recommended_premium_usd > 0);
});

test("evaluateHedge: active in-the-money put near expiry → roll/take-profit action", () => {
  // Floor $55k, spot dropped to $50k → put ITM by $5k/BTC. 2 BTC hedged, $2,000 premium.
  const h: ActiveHedge = { strike: 55_000, expiry_iso: new Date(Date.now() + 5 * 86_400_000).toISOString(), premium_usd: 2_000, hedged_btc: 2 };
  const s = evaluateHedge(h, { spot: 50_000, breakeven_price: 52_000 });
  assert.equal(s.protection_active, true);     // 50k < 55k
  assert.equal(s.below_breakeven, true);        // 50k < 52k
  assert.equal(s.put_intrinsic_usd, 10_000);    // (55k−50k)×2
  assert.equal(s.pnl_vs_premium_usd, 8_000);    // 10k − 2k
  assert.equal(s.roll_due, true);               // 5d ≤ 14d
  assert.equal(s.take_profit, true);            // 10k ≥ 2×2k
  assert.equal(s.action, "take_profit");        // take-profit takes precedence
});

test("evaluateHedge: healthy hedge far from expiry, spot above floor → hold", () => {
  const h: ActiveHedge = { strike: 54_000, expiry_iso: new Date(Date.now() + 60 * 86_400_000).toISOString(), premium_usd: 1_500, hedged_btc: 2 };
  const s = evaluateHedge(h, { spot: 61_000, breakeven_price: 48_000 });
  assert.equal(s.protection_active, false);
  assert.equal(s.below_breakeven, false);
  assert.equal(s.put_intrinsic_usd, 0);
  assert.equal(s.roll_due, false);
  assert.equal(s.action, "hold");
});

test("evaluateHedge: past expiry → expired; config defaults sane", () => {
  const h: ActiveHedge = { strike: 54_000, expiry_iso: new Date(Date.now() - 86_400_000).toISOString(), premium_usd: 1_500, hedged_btc: 2 };
  assert.equal(evaluateHedge(h, { spot: 61_000 }).action, "expired");
  assert.equal(DEFAULT_MONITOR_CONFIG.rollDaysThreshold, 14);
  assert.equal(DEFAULT_MONITOR_CONFIG.takeProfitMultiple, 2);
});
