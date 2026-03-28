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

test("ibkr_cme_paper adapter returns quote with hedge mode diagnostics", async () => {
  const originalFetch = global.fetch;
  const now = new Date();
  const nearExpiry = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const fartherExpiry = new Date(now.getTime() + 10 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            contracts: [
              {
                conId: 12345,
                secType: "FOP",
                localSymbol: "MBT 20260401 P80000",
                expiry: "20260401",
                strike: 80000,
                right: "P",
                multiplier: "0.1",
                minTick: 5
              }
            ]
          })
      } as any;
    }
    if (path.startsWith("marketdata/top")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: 101,
            ask: 102,
            bidSize: 9,
            askSize: 7,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 7,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    }
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-3D-P",
    protectedNotional: 10000,
    quantity: 0.2,
    side: "buy",
    protectionType: "long",
    triggerPrice: 80000,
    requestedTenorDays: 3,
    tenorMinDays: 1,
    tenorMaxDays: 7,
    hedgePolicy: "options_primary_futures_fallback"
  });
  assert.equal(quote.venue, "ibkr_cme_paper");
  assert.equal(typeof quote.details?.hedgeMode, "string");
  assert.equal(typeof quote.details?.selectedTenorDays, "number");
  assert.ok(String(quote.instrumentId).startsWith("IBKR-"));
  global.fetch = originalFetch;
});

test("ibkr_cme_paper uses depth-derived ask when top snapshot is empty", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 11111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260330",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: null,
            ask: null,
            bidSize: null,
            askSize: null,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 95, size: 4 }],
            asks: [{ level: 0, price: 96, size: 6 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 7,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    }
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-3D-P",
    protectedNotional: 10000,
    quantity: 0.2,
    side: "buy",
    protectionType: "long",
    triggerPrice: 55000,
    requestedTenorDays: 3,
    tenorMinDays: 1,
    tenorMaxDays: 7,
    hedgePolicy: "options_primary_futures_fallback"
  });
  assert.equal(String(quote.details?.hedgeMode), "options_native");
  assert.ok(String(quote.instrumentId).startsWith("IBKR-FOP-"));
  assert.equal(Number(quote.details?.askPrice), 96);
  assert.equal(String(quote.details?.selectionAlgorithm), "tenor_quality_v1");
  assert.equal(typeof quote.details?.candidateCountEvaluated, "number");
  assert.equal(Array.isArray(quote.details?.selectionTrace), true);
  global.fetch = originalFetch;
});

test("ibkr_cme_paper selection scoring prefers nearer tenor over wider-drift contract", async () => {
  const originalFetch = global.fetch;
  const now = new Date();
  const nearExpiry = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const fartherExpiry = new Date(now.getTime() + 10 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 11111,
                  secType: "FOP",
                  localSymbol: "WMH6 P55000",
                  expiry: nearExpiry,
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                },
                {
                  conId: 22222,
                  secType: "FOP",
                  localSymbol: "WMJ6 P55000",
                  expiry: fartherExpiry,
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 11111) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 105,
              ask: 106,
              bidSize: 4,
              askSize: 5,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: 107,
            ask: 108,
            bidSize: 4,
            askSize: 5,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 105, size: 4 }],
            asks: [{ level: 0, price: 106, size: 5 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 10,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    }
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-3D-P",
    protectedNotional: 10000,
    quantity: 0.2,
    side: "buy",
    protectionType: "long",
    triggerPrice: 55000,
    requestedTenorDays: 3,
    tenorMinDays: 1,
    tenorMaxDays: 7,
    hedgePolicy: "options_primary_futures_fallback"
  });
  assert.equal(String(quote.details?.selectionAlgorithm), "tenor_quality_v1");
  assert.equal(Number(quote.details?.conId), 11111);
  assert.equal(typeof quote.details?.selectedScore, "number");
  assert.equal(Array.isArray(quote.details?.selectionTrace), true);
  assert.ok((quote.details?.selectionTrace as Array<unknown>).length >= 1);
  global.fetch = originalFetch;
});

test("ibkr_cme_paper falls back to futures when option order books are unusable", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 11111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260330",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            contracts: [
              {
                conId: 22222,
                secType: "FUT",
                localSymbol: "MBTH6",
                expiry: "20260331",
                multiplier: "0.1",
                minTick: 5
              }
            ]
          })
      } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 11111) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: null,
              ask: null,
              bidSize: null,
              askSize: null,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: 95,
            ask: 96,
            bidSize: 4,
            askSize: 6,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 11111) {
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 95, size: 4 }],
            asks: [{ level: 0, price: 96, size: 6 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 7,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    }
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-3D-P",
    protectedNotional: 10000,
    quantity: 0.2,
    side: "buy",
    protectionType: "long",
    triggerPrice: 55000,
    requestedTenorDays: 3,
    tenorMinDays: 1,
    tenorMaxDays: 7,
    hedgePolicy: "options_primary_futures_fallback"
  });
  assert.equal(String(quote.details?.hedgeMode), "futures_synthetic");
  assert.ok(String(quote.instrumentId).startsWith("IBKR-FUT-"));
  global.fetch = originalFetch;
});

test("ibkr_cme_paper falls back quickly when options leg is slow and unusable", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 11111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260330",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            contracts: [
              {
                conId: 22222,
                secType: "FUT",
                localSymbol: "MBTH6",
                expiry: "20260331",
                multiplier: "0.1",
                minTick: 5
              }
            ]
          })
      } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 11111) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: null,
              ask: null,
              bidSize: null,
              askSize: null,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: 95,
            ask: 96,
            bidSize: 4,
            askSize: 6,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 11111) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 95, size: 4 }],
            asks: [{ level: 0, price: 96, size: 6 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 7,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    },
    ibkrQuoteBudgetMs: 9000
  });
  const started = Date.now();
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-3D-P",
    protectedNotional: 10000,
    quantity: 0.2,
    side: "buy",
    protectionType: "long",
    triggerPrice: 55000,
    requestedTenorDays: 3,
    tenorMinDays: 1,
    tenorMaxDays: 7,
    hedgePolicy: "options_primary_futures_fallback"
  });
  const elapsedMs = Date.now() - started;
  assert.equal(String(quote.details?.hedgeMode), "futures_synthetic");
  assert.ok(elapsedMs < 7000, `expected fast fallback, got ${elapsedMs}ms`);
  global.fetch = originalFetch;
});

test("ibkr_cme_paper execution disabled yields failure status", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "ibkr_cme_paper",
    falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
    deribit: {} as any,
    ibkr: {
      bridgeBaseUrl: "http://127.0.0.1:18080",
      bridgeTimeoutMs: 2000,
      bridgeToken: "",
      accountId: "DU123456",
      enableExecution: false,
      orderTimeoutMs: 2000,
      maxRepriceSteps: 3,
      repriceStepTicks: 1,
      maxSlippageBps: 25,
      requireLiveTransport: false,
      maxTenorDriftDays: 7,
      preferTenorAtOrAbove: true,
      orderTif: "IOC"
    }
  });
  const execution = await adapter.execute({
    venue: "ibkr_cme_paper",
    quoteId: "q-1",
    rfqId: null,
    instrumentId: "IBKR-FOP-100-MBT_20260401_P80000",
    side: "buy",
    quantity: 0.1,
    premium: 5,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    quoteTs: new Date().toISOString(),
    details: {
      conId: 12345
    }
  });
  assert.equal(execution.status, "failure");
});

test("ibkr_cme_live requires active ib_socket transport when enforced", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "synthetic_fallback",
              fallbackEnabled: true,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const adapter = createPilotVenueAdapter({
      mode: "ibkr_cme_live",
      falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
      deribit: {} as any,
      ibkr: {
        bridgeBaseUrl: "http://127.0.0.1:18080",
        bridgeTimeoutMs: 2000,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: true,
        orderTimeoutMs: 2000,
        maxRepriceSteps: 3,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: true,
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true,
        orderTif: "IOC"
      }
    });

    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-3D-P",
          protectedNotional: 10000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          triggerPrice: 80000,
          requestedTenorDays: 3,
          tenorMinDays: 1,
          tenorMaxDays: 7,
          hedgePolicy: "options_primary_futures_fallback"
        }),
      /ibkr_transport_not_live/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr connector timeout prefers bridge timeout when larger", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 12345,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260330",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 4,
              askSize: 6,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const adapter = createPilotVenueAdapter({
      mode: "ibkr_cme_paper",
      falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
      deribit: {} as any,
      ibkr: {
        bridgeBaseUrl: "http://127.0.0.1:18080",
        bridgeTimeoutMs: 20000,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: false,
        orderTimeoutMs: 8000,
        maxRepriceSteps: 3,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: true,
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true,
        orderTif: "IOC"
      }
    });

    const quote = await adapter.quote({
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-3D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy",
      protectionType: "long",
      triggerPrice: 55000,
      requestedTenorDays: 3,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_primary_futures_fallback"
    });
    assert.equal(quote.venue, "ibkr_cme_paper");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr tenor drift guard rejects candidates outside configured drift window", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 12345,
                  secType: "FOP",
                  localSymbol: "WMZ7 P55000",
                  expiry: "20271231",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 4,
              askSize: 6,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const adapter = createPilotVenueAdapter({
      mode: "ibkr_cme_live",
      falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
      deribit: {} as any,
      ibkr: {
        bridgeBaseUrl: "http://127.0.0.1:18080",
        bridgeTimeoutMs: 2000,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: false,
        orderTimeoutMs: 2000,
        maxRepriceSteps: 3,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: true,
        maxTenorDriftDays: 2,
        preferTenorAtOrAbove: true,
        orderTif: "IOC"
      }
    });

    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-3D-P",
          protectedNotional: 10000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          triggerPrice: 55000,
          requestedTenorDays: 3,
          tenorMinDays: 1,
          tenorMaxDays: 7,
          hedgePolicy: "options_primary_futures_fallback"
        }),
      /ibkr_quote_unavailable:tenor_drift_exceeded/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr tenor drift guard rejects contracts beyond configured drift", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path === "health") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("contracts/qualify")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 99999,
                  secType: "FOP",
                  localSymbol: "WMZ7 P55000",
                  expiry: "20271231",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 4,
              askSize: 6,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: false,
        status: 404,
        text: async () => "not_found"
      } as any;
    }) as typeof fetch;

    const adapter = createPilotVenueAdapter({
      mode: "ibkr_cme_paper",
      falconx: { baseUrl: "https://api.falconx.io", apiKey: "k", secret: "c2VjcmV0", passphrase: "p" },
      deribit: {} as any,
      ibkr: {
        bridgeBaseUrl: "http://127.0.0.1:18080",
        bridgeTimeoutMs: 6000,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: false,
        orderTimeoutMs: 6000,
        maxRepriceSteps: 3,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: true,
        maxTenorDriftDays: 2,
        preferTenorAtOrAbove: true,
        orderTif: "IOC"
      }
    });

    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-3D-P",
          protectedNotional: 10000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          triggerPrice: 55000,
          requestedTenorDays: 3,
          tenorMinDays: 1,
          tenorMaxDays: 7,
          hedgePolicy: "options_primary_futures_fallback"
        }),
      /ibkr_quote_unavailable:tenor_drift_exceeded/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

