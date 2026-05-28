/**
 * Integration test for DeribitLegAdapter USDC↔BTC unit conversion.
 *
 * Regression guard against the bug we caught pre-smoke: adapter was passing
 * USDC-quoted prices directly to Deribit, which expects BTC-per-option prices.
 * If someone reintroduces this regression, these tests fail BEFORE any real
 * orders fire.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DeribitLegAdapter } from "../src/singleSide/twoSided/liveVenueAdapters";

type MockOrderCall = {
  price?: number;
  side: "buy" | "sell";
  amount: number;
  instrument: string;
};

const buildMockDeribit = (calls: MockOrderCall[], avgPriceBtc: number) => ({
  placeOrder: async (req: { instrument: string; amount: number; side: "buy" | "sell"; price?: number }) => {
    calls.push({ price: req.price, side: req.side, amount: req.amount, instrument: req.instrument });
    return {
      result: {
        order: {
          order_state: "filled",
          average_price: avgPriceBtc, // Deribit returns in BTC
          filled_amount: req.amount
        }
      }
    };
  }
});

test("DeribitLegAdapter.buyLeg converts USDC limit to BTC limit before order", async () => {
  const calls: MockOrderCall[] = [];
  const mock = buildMockDeribit(calls, 0.005);
  const adapter = new DeribitLegAdapter(mock, { getCurrentSpotUsd: () => 73_500 });

  await adapter.buyLeg({
    instrument: "BTC-31MAY26-72000-P",
    contractsBtc: 0.01,
    maxAcceptableAskUsdcPerBtc: 5000,
    clientOrderId: "test-buy-1"
  });

  assert.equal(calls.length, 1);
  const sent = calls[0];
  // $5,000 USDC/BTC / $73,500 spot = 0.068027... BTC → snap UP to nearest 0.0001 tick = 0.0681
  // Bug would have passed 5000 directly. With fix: passes ~0.0681.
  assert.ok(sent.price! < 1, `Sent price should be in BTC (< 1), got ${sent.price}`);
  assert.ok(sent.price! >= 0.068, `Should be ~0.068 BTC for $5k/BTC at $73.5k spot, got ${sent.price}`);
  assert.ok(sent.price! <= 0.069, `Should be <= 0.069 after tick snap, got ${sent.price}`);
});

test("DeribitLegAdapter.buyLeg converts BTC fill back to USDC for caller", async () => {
  const calls: MockOrderCall[] = [];
  // Deribit returns 0.005 BTC per option
  const mock = buildMockDeribit(calls, 0.005);
  const adapter = new DeribitLegAdapter(mock, { getCurrentSpotUsd: () => 73_500 });

  const result = await adapter.buyLeg({
    instrument: "BTC-31MAY26-72000-P",
    contractsBtc: 0.01,
    maxAcceptableAskUsdcPerBtc: 5000,
    clientOrderId: "test-buy-2"
  });

  assert.ok(result.ok);
  if (!result.ok) return;
  // 0.005 BTC × $73,500 spot = $367.50 USDC per BTC option
  // Bug would have returned 0.005 (BTC) verbatim. With fix: returns ~367.50.
  assert.ok(result.filledAskUsdcPerBtc > 300, `Should be ~$367 USDC, got ${result.filledAskUsdcPerBtc}`);
  assert.ok(result.filledAskUsdcPerBtc < 400, `Should be ~$367 USDC, got ${result.filledAskUsdcPerBtc}`);
});

test("DeribitLegAdapter.sellLeg converts USDC floor to BTC floor before order (snaps DOWN)", async () => {
  const calls: MockOrderCall[] = [];
  const mock = buildMockDeribit(calls, 0.004);
  const adapter = new DeribitLegAdapter(mock, { getCurrentSpotUsd: () => 73_500 });

  await adapter.sellLeg({
    instrument: "BTC-31MAY26-72000-P",
    contractsBtc: 0.01,
    minAcceptableBidUsdcPerBtc: 300, // $300 USDC floor
    clientOrderId: "test-sell-1"
  });

  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.side, "sell");
  // $300 / $73,500 = 0.00408... BTC → snap DOWN to 0.004 tick (don't exceed bid)
  assert.ok(sent.price! < 1, `Sent price should be in BTC (< 1), got ${sent.price}`);
  assert.ok(sent.price! >= 0.004, `Should be ~0.004 BTC for $300 floor, got ${sent.price}`);
  assert.ok(sent.price! <= 0.0041, `Should snap DOWN to <= 0.0041, got ${sent.price}`);
});

test("DeribitLegAdapter.sellLeg with floor=0 uses 1 tick (0.0001 BTC) as best-effort price", async () => {
  const calls: MockOrderCall[] = [];
  const mock = buildMockDeribit(calls, 0.002);
  const adapter = new DeribitLegAdapter(mock, { getCurrentSpotUsd: () => 73_500 });

  await adapter.sellLeg({
    instrument: "BTC-31MAY26-72000-P",
    contractsBtc: 0.01,
    minAcceptableBidUsdcPerBtc: 0, // Best-effort reverse
    clientOrderId: "test-sell-2"
  });

  assert.equal(calls[0].price, 0.0001); // Minimum 1 tick to satisfy Deribit's price > 0 requirement
});

test("DeribitLegAdapter returns clear error when spot unavailable", async () => {
  const calls: MockOrderCall[] = [];
  const mock = buildMockDeribit(calls, 0.005);
  // Spot getter returns null — simulates feed outage
  const adapter = new DeribitLegAdapter(mock, { getCurrentSpotUsd: () => null });

  const result = await adapter.buyLeg({
    instrument: "BTC-31MAY26-72000-P",
    contractsBtc: 0.01,
    maxAcceptableAskUsdcPerBtc: 5000,
    clientOrderId: "test-no-spot"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match((result as { detail: string }).detail, /spot unavailable/);
  // Should NOT have called placeOrder at all
  assert.equal(calls.length, 0);
});

test("DeribitLegAdapter paper-mode fillPrice also gets USDC conversion", async () => {
  // Mock paper response (different shape than live)
  const adapter = new DeribitLegAdapter(
    { placeOrder: async () => ({ status: "paper_filled", fillPrice: 0.003 }) },
    { getCurrentSpotUsd: () => 73_500 }
  );
  const result = await adapter.buyLeg({
    instrument: "BTC-X-Y-P",
    contractsBtc: 0.01,
    maxAcceptableAskUsdcPerBtc: 5000,
    clientOrderId: "paper-1"
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  // 0.003 BTC × $73,500 = $220.50
  assert.ok(result.filledAskUsdcPerBtc > 200);
  assert.ok(result.filledAskUsdcPerBtc < 250);
});

test("DeribitLegAdapter rejects orders that would fall below 0 after conversion (defensive)", async () => {
  const adapter = new DeribitLegAdapter(
    { placeOrder: async () => ({ result: { order: { order_state: "filled", average_price: 0.005, filled_amount: 0.01 } } }) },
    { getCurrentSpotUsd: () => -1 } // negative spot — impossible state
  );
  const result = await adapter.buyLeg({
    instrument: "BTC-X-Y-P",
    contractsBtc: 0.01,
    maxAcceptableAskUsdcPerBtc: 5000,
    clientOrderId: "bad-spot"
  });
  assert.equal(result.ok, false);
});
