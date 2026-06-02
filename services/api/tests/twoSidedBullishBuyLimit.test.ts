/**
 * Tests — bullishBuyLimitUsdc (slippage headroom on the Bullish BUY IOC limit).
 *
 * Regression for the 2026-06-02 live failure: the call IOC expired ("Expired (last=CLOSED)")
 * because its limit (the stale quote ask) was below Bullish's moved/wide ask. Headroom
 * raises the limit ceiling so the order crosses; IOC still fills at the real resting ask.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bullishBuyLimitUsdc } from "../src/singleSide/twoSided/liveVenueAdapters";

test("bullishBuyLimitUsdc: adds slippage headroom then snaps UP to the $10 tick", () => {
  // ask 830, +5% = 871.5 → snap up to $10 = 880
  assert.equal(bullishBuyLimitUsdc(830, 0.05), 880);
  // ask 930, +5% = 976.5 → 980
  assert.equal(bullishBuyLimitUsdc(930, 0.05), 980);
});

test("bullishBuyLimitUsdc: 0 headroom = just snap the ask up to tick (back-compat)", () => {
  assert.equal(bullishBuyLimitUsdc(830, 0), 830);
  assert.equal(bullishBuyLimitUsdc(831, 0), 840);
});

test("bullishBuyLimitUsdc: bigger headroom widens the ceiling (crosses a more-moved ask)", () => {
  // ask 800, +10% = 880 → 880
  assert.equal(bullishBuyLimitUsdc(800, 0.10), 880);
});

test("bullishBuyLimitUsdc: negative headroom clamped to 0 (never below the ask)", () => {
  assert.equal(bullishBuyLimitUsdc(800, -0.5), 800);
});
