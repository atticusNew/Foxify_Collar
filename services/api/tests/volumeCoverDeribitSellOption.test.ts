import assert from "node:assert/strict";
import test from "node:test";

import type { DeribitConnector } from "@foxify/connectors";
import { createPilotVenueAdapter } from "../src/pilot/venue.js";
import { createHedgeExecutor } from "../src/volumeCover/hedgeExecutorAdapter.js";

// VC unwind / TP regression coverage. These tests instantiate the real
// DeribitLiveAdapter (not a mock executor) so the next time someone
// drops a stub super.sellOption() into the live adapter it blows up here
// instead of in production at force-sell-leg time.

const buildFakeConnector = (overrides: Partial<Record<string, any>> = {}): DeribitConnector => {
  const base: Record<string, any> = {
    placeOrder: async () => ({
      status: "paper_filled",
      id: "deribit-test-order-1",
      fillPrice: 0.0015,
      fillCurrency: "btc",
      filledAmount: 0.3,
      request: { side: "sell" }
    }),
    getIndexPrice: async () => ({ result: { index_price: 80_000 } }),
    getOrderBook: async () => ({ result: {} }),
    listInstruments: async () => ({ result: [] }),
    getDVOL: async () => ({ dvol: 50, timestamp: Date.now() }),
    getHistoricalVolatility: async () => ({ rvol: 40 }),
    getTicker: async () => ({}),
    getAccountSummary: async () => ({})
  };
  return Object.assign(base, overrides) as unknown as DeribitConnector;
};

test("DeribitLiveAdapter.sellOption returns USDC-denominated price and proceeds (no super.sellOption ReferenceError)", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "deribit_live",
    deribit: buildFakeConnector(),
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });

  assert.ok(typeof adapter.sellOption === "function", "adapter.sellOption must be defined on live mode");

  const result = await adapter.sellOption!({
    instrumentId: "BTC-28MAY26-72000-P",
    quantity: 0.3
  });

  assert.equal(result.status, "sold", `expected sold, got ${result.status} (${JSON.stringify(result.details)})`);
  assert.equal(result.quantity, 0.3);
  // 0.0015 BTC/contract × 80,000 USDC/BTC = 120 USDC per BTC
  assert.equal(result.fillPrice, 120, "fillPrice must be USDC per BTC, not BTC per contract");
  // totalProceeds = 120 USDC/BTC × 0.3 BTC = 36 USDC
  assert.equal(result.totalProceeds, 36, "totalProceeds must be in USDC");
  assert.ok(result.orderId, "must surface an orderId");
  assert.equal((result.details as any)?.venue, "deribit_live", "live override must tag venue");
});

test("DeribitTestAdapter.sellOption fails closed if spot conversion unavailable (prevents 1e5× units bug)", async () => {
  const connector = buildFakeConnector({
    getIndexPrice: async () => ({ result: { index_price: 0 } })
  });
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    deribit: connector,
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });

  const result = await adapter.sellOption!({
    instrumentId: "BTC-28MAY26-72000-P",
    quantity: 0.2
  });

  assert.equal(result.status, "failed");
  assert.equal(result.fillPrice, 0);
  assert.equal(result.totalProceeds, 0);
  assert.equal((result.details as any)?.reason, "price_conversion_failed");
});

test("DeribitTestAdapter.sellOption maps paper_rejected to failed (no false-positive sells)", async () => {
  const connector = buildFakeConnector({
    placeOrder: async () => ({
      status: "paper_rejected",
      reason: "insufficient_liquidity",
      bestBid: null,
      availableSize: 0
    })
  });
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    deribit: connector,
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });

  const result = await adapter.sellOption!({
    instrumentId: "BTC-28MAY26-72000-P",
    quantity: 0.2
  });

  assert.equal(result.status, "failed");
  assert.match(String((result.details as any)?.reason ?? ""), /insufficient_liquidity|paper_rejected/);
});

test("hedgeExecutor.sellOptionLeg routes Deribit through DeribitLiveAdapter and returns USDC fill", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "deribit_live",
    deribit: buildFakeConnector(),
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });
  const executor = createHedgeExecutor({ deribit: adapter });

  const result = await executor.sellOptionLeg({
    venue: "deribit",
    optionKind: "put",
    strikeUsdc: 72000,
    expiryIso: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    contractsBtc: 0.3
  });

  assert.equal(result.venue, "deribit");
  // 0.0015 × 80,000 = 120 USDC per BTC
  assert.equal(result.fillPriceUsdcPerBtc, 120);
  // 120 × 0.3 = 36 USDC
  assert.equal(result.totalProceedsUsdc, 36);
});

test("hedgeExecutor.sellOptionLeg throws sell_option_failed when adapter returns failed (force-sell-leg surfaces 502)", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "deribit_live",
    deribit: buildFakeConnector({
      placeOrder: async () => ({ status: "paper_rejected", reason: "insufficient_liquidity" })
    }),
    falconx: { baseUrl: "", apiKey: "", secret: "", passphrase: "" }
  });
  const executor = createHedgeExecutor({ deribit: adapter });

  await assert.rejects(
    () =>
      executor.sellOptionLeg({
        venue: "deribit",
        optionKind: "put",
        strikeUsdc: 72000,
        expiryIso: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        contractsBtc: 0.2
      }),
    /sell_option_failed:deribit/
  );
});
