/**
 * Floor-quote engine — leverage-additive / protective-put economics + best-venue pick.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeFloorEconomics, bestPutVenue, type FloorQuoteInputs } from "../src/singleSide/twoSided/floorQuote";

const base: FloorQuoteInputs = { spot: 66000, sizeBtc: 1, leverage: 10, floorPct: 0.10, tenorDays: 7 };

test("computeFloorEconomics: floor caps loss; leverage-additive computed", () => {
  // protective put ask = 0.02 BTC-equiv... here pass USDC/BTC directly: say $1,200/BTC.
  const e = computeFloorEconomics(base, 1200);
  // notional = 66000; margin = 6600 (10x).
  assert.equal(e.notional_usdc, 66000);
  assert.equal(e.margin_usdc, 6600);
  // floor strike = 66000 × 0.90 = 59400.
  assert.equal(e.floor_strike, 59400);
  // liq ≈ 66000 × (1 − 1/10) = 59400 (coincidentally near the floor at 10x/10%).
  assert.equal(e.liquidation_price, 59400);
  // put cost = 1200 × 1 = 1200.
  assert.equal(e.put_cost_usdc, 1200);
  // max loss with floor = (66000−59400)×1 + 1200 = 6600 + 1200 = 7800.
  assert.equal(e.max_loss_with_floor_usdc, 7800);
  // unprotected max loss = margin 6600.
  assert.equal(e.max_loss_without_floor_usdc, 6600);
  // equivalent leverage = notional / maxLossWithFloor = 66000/7800 ≈ 8.46.
  assert.ok(Math.abs(e.equivalent_leverage! - 8.46) < 0.05);
  assert.ok(e.payoff.length > 5);
});

test("computeFloorEconomics: deeper floor (smaller distance) → cheaper max loss, higher equiv leverage", () => {
  const tight = computeFloorEconomics({ ...base, floorPct: 0.03 }, 1500); // floor only 3% down
  // max loss with floor = (66000×0.03)×1 + 1500 = 1980 + 1500 = 3480 → equiv lev = 66000/3480 ≈ 18.97
  assert.ok(tight.equivalent_leverage! > base.leverage, "tighter floor → can run more leverage for same risk");
  assert.ok(tight.leverage_additive! > 0);
});

test("bestPutVenue: picks lowest non-null ask", () => {
  const best = bestPutVenue([
    { venue: "bullish", ask_usdc_per_btc: 1400 },
    { venue: "deribit", ask_usdc_per_btc: 1180 },
    { venue: "okx", ask_usdc_per_btc: 1250 },
    { venue: "dead", ask_usdc_per_btc: null }
  ]);
  assert.equal(best?.venue, "deribit");
  assert.equal(bestPutVenue([{ venue: "x", ask_usdc_per_btc: null }]), null);
});
