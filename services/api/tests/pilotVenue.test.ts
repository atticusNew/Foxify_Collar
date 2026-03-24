import assert from "node:assert/strict";
import test from "node:test";
import { createPilotVenueAdapter, mapVenueFailureReason } from "../src/pilot/venue";

test("mock_falconx adapter returns quote and execution", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "mock_falconx",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: {} as any
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 10000,
    quantity: 0.1,
    side: "buy"
  });
  assert.equal(quote.venue, "mock_falconx");
  const execution = await adapter.execute(quote);
  assert.equal(execution.status, "success");
});

test("mapVenueFailureReason normalizes known errors", () => {
  assert.equal(mapVenueFailureReason(new Error("QUOTE_EXPIRED")), "quote_expired");
  assert.equal(mapVenueFailureReason(new Error("INVALID_QUOTE_ID")), "invalid_quote_id");
  assert.equal(mapVenueFailureReason(new Error("INSUFFICIENT_CASH_BALANCE")), "insufficient_balance");
  assert.equal(mapVenueFailureReason(new Error("other")), "venue_error");
});

const makeDeribitStub = (params: {
  spot?: number;
  instruments?: Array<{ instrument_name: string; option_type: "put" | "call"; strike: number; expiration_timestamp: number }>;
  books?: Record<string, any>;
  orderResult?: Record<string, unknown>;
}) => {
  const books = params.books || {};
  return {
    getIndexPrice: async () => ({
      result: { index_price: params.spot ?? 100000 }
    }),
    listInstruments: async () => ({
      result: params.instruments || []
    }),
    getOrderBook: async (instrument: string) => books[instrument] || { result: {} },
    placeOrder: async () =>
      params.orderResult || {
        status: "paper_filled",
        fillPrice: 0.02,
        filledAmount: 1
      }
  } as any;
};

test("deribit_test can fall back to mark when ask missing", async () => {
  const now = Date.now();
  const instrument = "BTC-31MAR26-81000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: instrument,
          option_type: "put",
          strike: 81000,
          expiration_timestamp: now + 7 * 86400000
        }
      ],
      books: {
        [instrument]: { result: { asks: [], bids: [[0.013, 2]], mark_price: 0.015 } }
      }
    }),
    deribitQuotePolicy: "ask_or_mark_fallback",
    deribitStrikeSelectionMode: "trigger_aligned"
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 10000,
    quantity: 0.1,
    side: "buy",
    protectionType: "long",
    triggerPrice: 80000,
    requestedTenorDays: 7
  });
  assert.equal(quote.venue, "deribit_test");
  assert.equal(String(quote.details?.askSource), "mark");
});

test("deribit_test ask_only policy rejects mark-only books", async () => {
  const now = Date.now();
  const instrument = "BTC-31MAR26-81000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: instrument,
          option_type: "put",
          strike: 81000,
          expiration_timestamp: now + 7 * 86400000
        }
      ],
      books: {
        [instrument]: { result: { asks: [], bids: [[0.013, 2]], mark_price: 0.015 } }
      }
    }),
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned"
  });
  await assert.rejects(
    () =>
      adapter.quote({
        marketId: "BTC-USD",
        instrumentId: "BTC-USD-7D-P",
        protectedNotional: 10000,
        quantity: 0.1,
        side: "buy",
        protectionType: "long",
        triggerPrice: 80000,
        requestedTenorDays: 7
      }),
    /deribit_quote_unavailable/
  );
});

test("trigger_aligned put selection chooses strike above trigger", async () => {
  const now = Date.now();
  const lower = "BTC-31MAR26-79000-P";
  const higher = "BTC-31MAR26-81000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: lower,
          option_type: "put",
          strike: 79000,
          expiration_timestamp: now + 7 * 86400000
        },
        {
          instrument_name: higher,
          option_type: "put",
          strike: 81000,
          expiration_timestamp: now + 7 * 86400000
        }
      ],
      books: {
        [lower]: { result: { asks: [[0.01, 2]], bids: [[0.009, 2]], mark_price: 0.0095 } },
        [higher]: { result: { asks: [[0.012, 2]], bids: [[0.011, 2]], mark_price: 0.0115 } }
      }
    }),
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned"
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 10000,
    quantity: 0.1,
    side: "buy",
    protectionType: "long",
    triggerPrice: 80000,
    requestedTenorDays: 7
  });
  assert.equal(quote.instrumentId, higher);
  assert.ok(Number(quote.details?.selectedStrike) >= 80000);
});

test("trigger_aligned fails when no eligible strike side exists", async () => {
  const now = Date.now();
  const lower = "BTC-31MAR26-79000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: lower,
          option_type: "put",
          strike: 79000,
          expiration_timestamp: now + 7 * 86400000
        }
      ],
      books: {
        [lower]: { result: { asks: [[0.01, 2]], bids: [[0.009, 2]], mark_price: 0.0095 } }
      }
    }),
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned"
  });
  await assert.rejects(
    () =>
      adapter.quote({
        marketId: "BTC-USD",
        instrumentId: "BTC-USD-7D-P",
        protectedNotional: 10000,
        quantity: 0.1,
        side: "buy",
        protectionType: "long",
        triggerPrice: 80000,
        requestedTenorDays: 7
      }),
    /trigger_strike_unavailable/
  );
});

test("tenor drift guard rejects far expiries", async () => {
  const now = Date.now();
  const far = "BTC-31MAR26-81000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: far,
          option_type: "put",
          strike: 81000,
          expiration_timestamp: now + 20 * 86400000
        }
      ],
      books: {
        [far]: { result: { asks: [[0.01, 2]], bids: [[0.009, 2]], mark_price: 0.0095 } }
      }
    }),
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned",
    deribitMaxTenorDriftDays: 1
  });
  await assert.rejects(
    () =>
      adapter.quote({
        marketId: "BTC-USD",
        instrumentId: "BTC-USD-7D-P",
        protectedNotional: 10000,
        quantity: 0.1,
        side: "buy",
        protectionType: "long",
        triggerPrice: 80000,
        requestedTenorDays: 7
      }),
    /tenor_drift_exceeded/
  );
});

test("deribit execution scales premium to filled quantity", async () => {
  const now = Date.now();
  const instrument = "BTC-31MAR26-81000-P";
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: makeDeribitStub({
      instruments: [
        {
          instrument_name: instrument,
          option_type: "put",
          strike: 81000,
          expiration_timestamp: now + 7 * 86400000
        }
      ],
      books: {
        [instrument]: { result: { asks: [[0.01, 5]], bids: [[0.009, 5]], mark_price: 0.0095 } }
      },
      orderResult: {
        status: "paper_filled",
        id: "paper-1",
        fillPrice: 0.01,
        filledAmount: 0.2
      }
    }),
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned"
  });
  const execution = await adapter.execute({
    venue: "deribit_test",
    quoteId: "q1",
    rfqId: null,
    instrumentId: instrument,
    side: "buy",
    quantity: 1,
    premium: 100,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    quoteTs: new Date().toISOString()
  });
  assert.equal(execution.quantity, 0.2);
  assert.equal(execution.premium, 20);
});

