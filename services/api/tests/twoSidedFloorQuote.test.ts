/**
 * Floor-quote engine — leverage-additive / protective-put economics + best-venue pick.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeFloorEconomics, bestPutVenue, type FloorQuoteInputs } from "../src/singleSide/twoSided/floorQuote";

const base: FloorQuoteInputs = { spot: 66000, sizeBtc: 1, leverage: 10, floorPct: 0.10, tenorDays: 7 };

test("computeFloorEconomics: 10x + 10% floor is the DEGENERATE case (floor at liquidation → no value)", () => {
  const e = computeFloorEconomics(base, 1200);
  assert.equal(e.notional_usdc, 66000);
  assert.equal(e.margin_usdc, 6600);
  assert.equal(e.floor_strike, 59400);
  assert.equal(e.liquidation_price, 59400);
  assert.equal(e.unprotected_liq_drop_pct, 0.1);
  assert.equal(e.floor_drop_pct, 0.1);
  assert.equal(e.put_cost_usdc, 1200);
  assert.equal(e.max_loss_with_floor_usdc, 7800);   // (6600 floor distance) + 1200 premium
  assert.equal(e.max_loss_without_floor_usdc, 6600); // margin
  // floor at 10% == liq at 10% → floor adds NO value (this was the negative-additive case).
  assert.equal(e.floor_adds_value, false);
  assert.ok(/INSIDE|TIGHTER/.test(e.survival_summary));
});

test("computeFloorEconomics: floor TIGHTER than liquidation distance → floor_adds_value, capped loss < margin", () => {
  const tight = computeFloorEconomics({ ...base, floorPct: 0.03 }, 1500); // 3% floor at 10x (liq 10%)
  assert.equal(tight.floor_adds_value, true, "3% floor < 10% liq → adds value");
  // max loss with floor = 66000×0.03 + 1500 = 1980 + 1500 = 3480 < margin 6600.
  assert.equal(tight.max_loss_with_floor_usdc, 3480);
  assert.ok(tight.max_loss_with_floor_usdc < tight.max_loss_without_floor_usdc, "capped below margin");
  assert.ok(/SURVIVE/.test(tight.survival_summary));
  assert.ok(tight.equivalent_unprotected_leverage! > base.leverage);
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
