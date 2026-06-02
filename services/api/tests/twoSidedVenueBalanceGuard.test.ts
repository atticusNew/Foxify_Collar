/**
 * Phase C — pre-fire per-venue balance guard tests.
 *
 * Covers checkVenueBalances against a mock VenueBalanceReader:
 *   - sufficient balance (single + cross venue) → ok
 *   - insufficient Bullish (USDC) → block
 *   - insufficient Deribit (BTC→USDC at spot) → block
 *   - headroom enforced (avail above bare cost but below cost×(1+headroom)) → block
 *   - unreadable balance: fail-open (default) → ok ; fail-closed → block
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkVenueBalances,
  getBalanceGuardConfig,
  isBalanceGuardEnabled,
  type VenueBalanceReader
} from "../src/singleSide/twoSided/venueBalanceGuard";

const cfg0 = { headroomPct: 0, failClosed: false };

test("checkVenueBalances: both legs bullish + sufficient USDC → ok", async () => {
  const reader: VenueBalanceReader = {
    getBullishAvailableUsdc: async () => 1_000,
    getDeribitAvailableBtc: async () => 0
  };
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 200, callVenue: "bullish", callCostUsdc: 300, spot: 70_000 },
    cfg0
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.details.bullish_required_usdc, 500);
});

test("checkVenueBalances: insufficient Bullish USDC → insufficient_venue_balance", async () => {
  const reader: VenueBalanceReader = { getBullishAvailableUsdc: async () => 400 };
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 200, callVenue: "bullish", callCostUsdc: 300, spot: 70_000 },
    cfg0
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "insufficient_venue_balance");
    assert.equal(res.details.venue, "bullish");
    assert.equal(res.details.shortfall_usdc, 100); // need 500, have 400
  }
});

test("checkVenueBalances: cross-venue, Deribit BTC converted at spot, insufficient → block", async () => {
  // Deribit leg cost 700 USDC; available 0.005 BTC × 100000 spot = 500 USDC → short 200.
  const reader: VenueBalanceReader = {
    getBullishAvailableUsdc: async () => 10_000,
    getDeribitAvailableBtc: async () => 0.005
  };
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 100, callVenue: "deribit", callCostUsdc: 700, spot: 100_000 },
    cfg0
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "insufficient_venue_balance");
    assert.equal(res.details.venue, "deribit");
    assert.equal(res.details.deribit_available_usdc, 500);
    assert.equal(res.details.shortfall_usdc, 200);
  }
});

test("checkVenueBalances: headroom enforced (avail covers bare cost but not +10%)", async () => {
  const reader: VenueBalanceReader = { getBullishAvailableUsdc: async () => 520 };
  // bare cost 500, +10% = 550 needed; 520 < 550 → block
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 500, callVenue: "deribit", callCostUsdc: 0, spot: 70_000 },
    { headroomPct: 0.10, failClosed: false }
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.details.bullish_needed_usdc, 550);
});

test("checkVenueBalances: unreadable balance fails OPEN by default", async () => {
  const reader: VenueBalanceReader = {
    getBullishAvailableUsdc: async () => null, // unreadable
    getDeribitAvailableBtc: async () => { throw new Error("venue down"); }
  };
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 200, callVenue: "deribit", callCostUsdc: 300, spot: 70_000 },
    { headroomPct: 0, failClosed: false }
  );
  assert.equal(res.ok, true); // fail-open
});

test("checkVenueBalances: unreadable balance fails CLOSED when configured", async () => {
  const reader: VenueBalanceReader = { getBullishAvailableUsdc: async () => null };
  const res = await checkVenueBalances(
    reader,
    { putVenue: "bullish", putCostUsdc: 200, callVenue: "bullish", callCostUsdc: 300, spot: 70_000 },
    { headroomPct: 0, failClosed: true }
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, "balance_read_failed");
});

test("getBalanceGuardConfig + isBalanceGuardEnabled parse env", () => {
  assert.equal(isBalanceGuardEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isBalanceGuardEnabled({ SS_TWO_SIDED_BALANCE_GUARD: "false" } as unknown as NodeJS.ProcessEnv), false);
  const c = getBalanceGuardConfig({ SS_TWO_SIDED_BALANCE_HEADROOM_PCT: "0.25", SS_TWO_SIDED_BALANCE_GUARD_FAIL_CLOSED: "true" } as unknown as NodeJS.ProcessEnv);
  assert.equal(c.headroomPct, 0.25);
  assert.equal(c.failClosed, true);
});
