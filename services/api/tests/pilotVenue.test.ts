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
                  expiry: "20260402",
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
      // Disable at-or-above bias so this test isolates tenor drift scoring preference.
      preferTenorAtOrAbove: false,
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
  const selectedConId = Number(quote.details?.conId);
  assert.equal([11111, 22222].includes(selectedConId), true);
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
  assert.equal(String(quote.details?.hedgeInstrumentFamily), "MBT");
  assert.equal(String(quote.details?.selectionReason), "options_unavailable_futures_fallback");
  assert.ok(String(quote.instrumentId).startsWith("IBKR-FUT-"));
  global.fetch = originalFetch;
});

test("ibkr_cme_paper options_only_native liquidity hints prioritize previously liquid tenor", async () => {
  const originalFetch = global.fetch;
  const now = new Date();
  const tenor3Expiry = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const tenor4Expiry = new Date(now.getTime() + 4 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  let quoteAttempt = 0;
  const topCallTenorsByAttempt: Record<number, number[]> = { 1: [], 2: [] };
  const conIdToTenor = new Map<number, number>();
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        const tenorDays = Number(payload.tenorDays || 0);
        const contracts: Array<Record<string, unknown>> = [];
        if (tenorDays === 3) {
          contracts.push({
            conId: 73111,
            secType: "FOP",
            localSymbol: "WMH6 P55000",
            expiry: tenor3Expiry,
            strike: 55000,
            right: "P",
            multiplier: "0.1",
            minTick: 5
          });
          conIdToTenor.set(73111, 3);
        }
        if (tenorDays === 4) {
          contracts.push({
            conId: 74111,
            secType: "FOP",
            localSymbol: "WMI6 P55000",
            expiry: tenor4Expiry,
            strike: 55000,
            right: "P",
            multiplier: "0.1",
            minTick: 5
          });
          conIdToTenor.set(74111, 4);
        }
        return {
          ok: true,
          text: async () => JSON.stringify({ contracts })
        } as any;
      }
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      const conId = Number(payload.conId || 0);
      const tenor = conIdToTenor.get(conId) || 0;
      topCallTenorsByAttempt[quoteAttempt]?.push(tenor);
      if (quoteAttempt === 1 && tenor === 3) {
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
      if (quoteAttempt === 1 && tenor === 4) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 97,
              ask: 98,
              bidSize: 5,
              askSize: 7,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (tenor === 4) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 97,
              ask: 98,
              bidSize: 5,
              askSize: 7,
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
  try {
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
        maxTenorDriftDays: 5,
        preferTenorAtOrAbove: true,
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 1,
        optionTenorWindowDays: 1,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 12000
    });

    quoteAttempt = 1;
    const first = await adapter.quote({
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-3D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy",
      protectionType: "long",
      drawdownFloorPct: 0.2,
      triggerPrice: 55000,
      requestedTenorDays: 3,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_only_native"
    });
    assert.equal(Number(first.details?.selectedTenorDays) > 0, true);

    quoteAttempt = 2;
    const second = await adapter.quote({
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-3D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy",
      protectionType: "long",
      drawdownFloorPct: 0.2,
      triggerPrice: 55000,
      requestedTenorDays: 3,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_only_native"
    });
    assert.equal(Number(second.details?.selectedTenorDays) > 0, true);
    const firstTopTenor = topCallTenorsByAttempt[1][0];
    const secondTopTenor = topCallTenorsByAttempt[2][0];
    assert.equal(firstTopTenor, 3);
    assert.equal(secondTopTenor, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper options_only_native rejects instead of futures fallback", async () => {
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
                  conId: 61111,
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
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 62222,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 61111) {
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
      return {
        ok: true,
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
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
        hedgePolicy: "options_only_native"
      }),
    /ibkr_quote_unavailable:no_top_of_book/
  );
  global.fetch = originalFetch;
});

test("ibkr_cme_paper options_only_native enforces short-side coverage and rejects unprotected calls", async () => {
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
                  conId: 63111,
                  secType: "FOP",
                  localSymbol: "W5AH6 C54000",
                  expiry: "20260330",
                  strike: 54000,
                  right: "C",
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
            bid: 90,
            ask: 91,
            bidSize: 4,
            askSize: 6,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 90, size: 4 }],
            asks: [{ level: 0, price: 91, size: 6 }],
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
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 2,
        optionTenorWindowDays: 4,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 8000
    });
    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-3D-C",
          protectedNotional: 10000,
          quantity: 0.2,
          side: "buy",
          protectionType: "short",
          drawdownFloorPct: 0.2,
          triggerPrice: 55000,
          requestedTenorDays: 3,
          tenorMinDays: 1,
          tenorMaxDays: 7,
          hedgePolicy: "options_only_native"
        }),
      /ibkr_quote_unavailable:no_protection_compliant_option:no_viable_option:/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper options_only_native maps repeated top timeouts to no_liquidity_window", async () => {
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
                  conId: 65111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260330",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                },
                {
                  conId: 65222,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55500",
                  expiry: "20260330",
                  strike: 55500,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                },
                {
                  conId: 65333,
                  secType: "FOP",
                  localSymbol: "W5AH6 P56000",
                  expiry: "20260330",
                  strike: 56000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                },
                {
                  conId: 65444,
                  secType: "FOP",
                  localSymbol: "W5AH6 P56500",
                  expiry: "20260330",
                  strike: 56500,
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
      await new Promise((resolve) => setTimeout(resolve, 1200));
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
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  try {
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
        maxTenorDriftDays: 5,
        preferTenorAtOrAbove: true,
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 1,
        optionTenorWindowDays: 0,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 12000
    });
    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-14D-P",
          protectedNotional: 25000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          drawdownFloorPct: 0.2,
          triggerPrice: 55000,
          requestedTenorDays: 14,
          tenorMinDays: 1,
          tenorMaxDays: 30,
          hedgePolicy: "options_only_native"
        }),
      /ibkr_quote_unavailable:(no_liquidity_window|tenor_drift_exceeded)/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper options_only_native caps top probes per option leg", async () => {
  const originalFetch = global.fetch;
  const matchedExpiry = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  const optionContracts = Array.from({ length: 30 }, (_, idx) => ({
    conId: 76000 + idx,
    secType: "FOP",
    localSymbol: `W5AH6 P${65000 + idx * 250}`,
    expiry: matchedExpiry,
    strike: 65000 + idx * 250,
    right: "P",
    multiplier: "0.1",
    minTick: 5
  }));
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
              contracts: optionContracts
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
            bid: 95,
            ask: 100,
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
            bids: [{ level: 0, price: 95, size: 4 }],
            asks: [{ level: 0, price: 100, size: 5 }],
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
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 4,
        optionTenorWindowDays: 10,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 20000
    });
    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-14D-P",
          protectedNotional: 25000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          drawdownFloorPct: 0.2,
          triggerPrice: 55000,
          requestedTenorDays: 14,
          tenorMinDays: 1,
          tenorMaxDays: 30,
          hedgePolicy: "options_only_native"
        }),
      /ibkr_quote_unavailable:no_protection_compliant_option:no_viable_option:/
    );
    const diagnostics = (adapter as any).getDiagnostics?.();
    const topCalls = Number(diagnostics?.counters?.topCalls || 0);
    assert.ok(topCalls > 0, "expected top-of-book probing to occur");
    assert.ok(topCalls <= 12, `expected topCalls <= 12, got ${topCalls}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper options_only_native maps qualify timeouts to no_liquidity_window", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      await new Promise((resolve) => setTimeout(resolve, 4200));
      return {
        ok: true,
        text: async () => JSON.stringify({ contracts: [] })
      } as any;
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
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  try {
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
        maxTenorDriftDays: 5,
        preferTenorAtOrAbove: true,
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 1,
        optionTenorWindowDays: 0,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 12000
    });
    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-14D-P",
          protectedNotional: 25000,
          quantity: 0.2,
          side: "buy",
          protectionType: "long",
          drawdownFloorPct: 0.2,
          triggerPrice: 55000,
          requestedTenorDays: 14,
          tenorMinDays: 1,
          tenorMaxDays: 30,
          hedgePolicy: "options_only_native"
        }),
      /ibkr_quote_unavailable:no_liquidity_window/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper options_only_native scoring favors stronger economics when tenor is equal", async () => {
  const originalFetch = global.fetch;
  const now = new Date();
  const matchedExpiry = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
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
                  conId: 64111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: matchedExpiry,
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                },
                {
                  conId: 64222,
                  secType: "FOP",
                  localSymbol: "W5AH6 P54500",
                  expiry: matchedExpiry,
                  strike: 54500,
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
      if (payload.conId === 64111) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 115,
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
            bid: 90,
            ask: 92,
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
            bids: [{ level: 0, price: 90, size: 4 }],
            asks: [{ level: 0, price: 92, size: 5 }],
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
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 2,
        optionTenorWindowDays: 4,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 8000
    });
    const quote = await adapter.quote({
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-3D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy",
      protectionType: "long",
      drawdownFloorPct: 0.2,
      triggerPrice: 55000,
      requestedTenorDays: 3,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_only_native"
    });
    assert.equal(Number(quote.details?.conId), 64222);
    assert.equal(String(quote.details?.hedgeMode), "options_native");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper option strike ladder finds nearby liquid strike before futures fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        if (Number(payload.strike) === 55000) {
          return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
        }
        if (Number(payload.strike) === 55500) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 91111,
                    secType: "FOP",
                    localSymbol: "W5AH6 P55500",
                    expiry: "20260330",
                    strike: 55500,
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
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 92222,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 91111) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 94,
              ask: 95,
              bidSize: 3,
              askSize: 4,
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
      return {
        ok: true,
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  try {
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
        orderTif: "IOC",
        primaryProductFamily: "MBT",
        enableBffFallback: false,
        bffProductFamily: "BFF"
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
      requestedTenorDays: 4,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_primary_futures_fallback"
    });
    assert.equal(String(quote.details?.hedgeMode), "options_native");
    assert.equal(Number(quote.details?.conId), 91111);
    assert.equal(String(quote.details?.selectionReason), "best_tenor_liquidity_option");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper probes secondary options family before futures when enabled", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option" && payload.productFamily === "MBT") {
        return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
      }
      if (payload.kind === "mbt_option" && payload.productFamily === "BFF") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 93333,
                  secType: "FOP",
                  localSymbol: "BFFH6 P55000",
                  expiry: "20260331",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 94444,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 93333) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 91,
              ask: 92,
              bidSize: 2,
              askSize: 3,
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
      return {
        ok: true,
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  try {
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
        orderTif: "IOC",
        primaryProductFamily: "MBT",
        enableBffFallback: true,
        bffProductFamily: "BFF"
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
      requestedTenorDays: 2,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_primary_futures_fallback"
    });
    assert.equal(String(quote.details?.hedgeMode), "options_native");
    assert.equal(String(quote.details?.hedgeInstrumentFamily), "BFF");
    assert.equal(
      String(quote.details?.selectionReason),
      "primary_options_unavailable_secondary_options_fallback"
    );
    assert.equal(Number(quote.details?.conId), 93333);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper keeps MBT-only fallback when BFF fallback is disabled", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () => JSON.stringify({ contracts: [] })
        } as any;
      }
      if (payload.kind === "mbt_future" && payload.productFamily === "MBT") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 33333,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
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
      orderTif: "IOC",
      primaryProductFamily: "MBT",
      enableBffFallback: false,
      bffProductFamily: "BFF"
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
  assert.equal(String(quote.details?.hedgeInstrumentFamily), "MBT");
  assert.equal(String(quote.details?.selectionReason), "options_unavailable_futures_fallback");
  global.fetch = originalFetch;
});

test("ibkr_cme_paper falls back to BFF futures after MBT futures fail when enabled", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        return {
          ok: true,
          text: async () => JSON.stringify({ contracts: [] })
        } as any;
      }
      if (payload.kind === "mbt_future" && payload.productFamily === "MBT") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 44444,
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
      if (payload.kind === "mbt_future" && payload.productFamily === "BFF") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 55555,
                  secType: "FUT",
                  localSymbol: "BFFH6",
                  expiry: "20260328",
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
      if (payload.conId === 44444) {
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
      if (payload.conId === 55555) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 88,
              ask: 89,
              bidSize: 3,
              askSize: 5,
              asOf: new Date().toISOString()
            })
        } as any;
      }
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
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 44444) {
        return {
          ok: true,
          text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
        } as any;
      }
      if (payload.conId === 55555) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [{ level: 0, price: 88, size: 3 }],
              asks: [{ level: 0, price: 89, size: 5 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
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
      orderTif: "IOC",
      primaryProductFamily: "MBT",
      enableBffFallback: true,
      bffProductFamily: "BFF"
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
  assert.equal(String(quote.details?.hedgeInstrumentFamily), "BFF");
  assert.equal(String(quote.details?.selectionReason), "options_and_mbt_unavailable_bff_fallback");
  assert.equal(Number(quote.details?.conId), 55555);
  global.fetch = originalFetch;
});

test("ibkr_cme_paper option strike ladder finds nearby strike before futures fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option") {
        // Simulate first requested strike empty, nearby ladder strike available.
        if (Number(payload.strike) === 55000) {
          return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
        }
        if (Number(payload.strike) === 55500) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 66666,
                    secType: "FOP",
                    localSymbol: "W5AH6 P55500",
                    expiry: "20260330",
                    strike: 55500,
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
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 77777,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 66666) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 101,
              ask: 102,
              bidSize: 7,
              askSize: 6,
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
            bids: [{ level: 0, price: 101, size: 7 }],
            asks: [{ level: 0, price: 102, size: 6 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return { ok: false, status: 404, text: async () => "not_found" } as any;
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
      orderTif: "IOC",
      primaryProductFamily: "MBT",
      enableBffFallback: true,
      bffProductFamily: "BFF"
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
  assert.equal(String(quote.details?.selectionReason), "best_tenor_liquidity_option");
  assert.equal(String(quote.details?.hedgeInstrumentFamily), "MBT");
  assert.equal(Number(quote.details?.conId), 66666);
  assert.equal(Number(quote.details?.selectedStrike), 55500);
  global.fetch = originalFetch;
});

test("ibkr_cme_paper probes secondary options family before futures synthetic fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
    if (path.startsWith("contracts/qualify")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.kind === "mbt_option" && payload.productFamily === "MBT") {
        return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
      }
      if (payload.kind === "mbt_option" && payload.productFamily === "BFF") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 88888,
                  secType: "FOP",
                  localSymbol: "W5AH6 P55000",
                  expiry: "20260406",
                  strike: 55000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (payload.kind === "mbt_future" && payload.productFamily === "MBT") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 99999,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 88888) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 99,
              ask: 100,
              bidSize: 8,
              askSize: 7,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (payload.conId === 99999) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 5,
              askSize: 5,
              asOf: new Date().toISOString()
            })
        } as any;
      }
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
            bids: [{ level: 0, price: 99, size: 8 }],
            asks: [{ level: 0, price: 100, size: 7 }],
            asOf: new Date().toISOString()
          })
      } as any;
    }
    return { ok: false, status: 404, text: async () => "not_found" } as any;
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
      orderTif: "IOC",
      primaryProductFamily: "MBT",
      enableBffFallback: true,
      bffProductFamily: "BFF"
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
  assert.equal(String(quote.details?.hedgeInstrumentFamily), "BFF");
  assert.equal(
    String(quote.details?.selectionReason),
    "primary_options_unavailable_secondary_options_fallback"
  );
  assert.equal(Number(quote.details?.conId), 88888);
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

test("ibkr_cme_paper liquidity-first mode emits structured no-viable diagnostics", async () => {
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
                  conId: 77111,
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
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 77222,
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
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 77111) {
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
        text: async () => JSON.stringify({ bids: [], asks: [], asOf: new Date().toISOString() })
      } as any;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "not_found"
    } as any;
  }) as typeof fetch;
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 2,
        optionTenorWindowDays: 4,
        maxOptionPremiumRatio: 0.2,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 8000
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
      /ibkr_quote_unavailable:no_(economical_option|protection_compliant_option|top_of_book):no_viable_option:/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper liquidity-first guard rejects untradably small notionals", async () => {
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
                  conId: 70111,
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
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 70222,
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
    }
    if (path.startsWith("marketdata/top")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 70222) {
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
            bid: 90,
            ask: 91,
            bidSize: 4,
            askSize: 5,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      const payload = init?.body ? JSON.parse(String(init.body)) : {};
      if (payload.conId === 70222) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bids: [],
              asks: [],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 90, size: 4 }],
            asks: [{ level: 0, price: 91, size: 5 }],
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
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 2,
        optionTenorWindowDays: 4,
        maxOptionPremiumRatio: 0.5,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 8000
    });
    await assert.rejects(
      () =>
        adapter.quote({
          marketId: "BTC-USD",
          instrumentId: "BTC-USD-3D-P",
          protectedNotional: 20,
          quantity: 0.0002,
          side: "buy",
          protectionType: "long",
          triggerPrice: 55000,
          requestedTenorDays: 3,
          tenorMinDays: 1,
          tenorMaxDays: 7,
          hedgePolicy: "options_primary_futures_fallback"
        }),
      /ibkr_quote_unavailable:min_tradable_notional_exceeded:no_viable_option:/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper liquidity-first mode falls back to futures when option coverage is below threshold", async () => {
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
                  conId: 88111,
                  secType: "FOP",
                  localSymbol: "W5AH6 P60000",
                  expiry: "20260330",
                  strike: 60000,
                  right: "P",
                  multiplier: "0.1",
                  minTick: 5
                }
              ]
            })
        } as any;
      }
      if (payload.kind === "mbt_future") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 88222,
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
      return { ok: true, text: async () => JSON.stringify({ contracts: [] }) } as any;
    }
    if (path.startsWith("marketdata/top")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bid: 90,
            ask: 91,
            bidSize: 5,
            askSize: 6,
            asOf: new Date().toISOString()
          })
      } as any;
    }
    if (path.startsWith("marketdata/depth")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            bids: [{ level: 0, price: 90, size: 5 }],
            asks: [{ level: 0, price: 91, size: 6 }],
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
  try {
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
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionProbeParallelism: 2,
        optionTenorWindowDays: 4,
        maxOptionPremiumRatio: 0.2,
        optionProtectionTolerancePct: 0.03
      },
      ibkrQuoteBudgetMs: 8000
    });
    const quote = await adapter.quote({
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-3D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy",
      protectionType: "long",
      drawdownFloorPct: 0.2,
      triggerPrice: 55000,
      requestedTenorDays: 3,
      tenorMinDays: 1,
      tenorMaxDays: 7,
      hedgePolicy: "options_primary_futures_fallback"
    });
    assert.equal(String(quote.details?.hedgeMode), "futures_synthetic");
    assert.equal(String(quote.details?.selectionReason), "options_unavailable_futures_fallback");
  } finally {
    global.fetch = originalFetch;
  }
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

test("ibkr_cme_paper qualify cache reuses option qualification across repeated quotes", async () => {
  const originalFetch = global.fetch;
  let optionQualifyCalls = 0;
  try {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload.kind === "mbt_option") {
          optionQualifyCalls += 1;
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                contracts: [
                  {
                    conId: 12121,
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
          text: async () => JSON.stringify({ contracts: [] })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 95,
              ask: 96,
              bidSize: 3,
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
              bids: [{ level: 0, price: 95, size: 3 }],
              asks: [{ level: 0, price: 96, size: 5 }],
              asOf: new Date().toISOString()
            })
        } as any;
      }
      return { ok: false, status: 404, text: async () => "not_found" } as any;
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
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true,
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: true,
        optionTenorWindowDays: 1,
        optionProbeParallelism: 2,
        qualifyCacheTtlMs: 120000,
        qualifyCacheMaxKeys: 1000
      },
      ibkrQuoteBudgetMs: 12000
    });

    const request = {
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-8D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy" as const,
      protectionType: "long" as const,
      triggerPrice: 55000,
      requestedTenorDays: 8,
      tenorMinDays: 1,
      tenorMaxDays: 14,
      hedgePolicy: "options_primary_futures_fallback" as const
    };
    await assert.rejects(() => adapter.quote(request), /ibkr_quote_unavailable:tenor_drift_exceeded/);
    await assert.rejects(() => adapter.quote(request), /ibkr_quote_unavailable:tenor_drift_exceeded/);
    assert.ok(optionQualifyCalls > 0);
    assert.ok(optionQualifyCalls <= 25, `expected cache to reduce qualify calls, got ${optionQualifyCalls}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr_cme_paper qualify cache avoids repeated contract qualification", async () => {
  const originalFetch = global.fetch;
  try {
    let qualifyCount = 0;
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
        qualifyCount += 1;
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              contracts: [
                {
                  conId: 32101,
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
              bidSize: 3,
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
              bids: [{ level: 0, price: 95, size: 3 }],
              asks: [{ level: 0, price: 96, size: 5 }],
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
        requireLiveTransport: false,
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true,
        orderTif: "IOC",
        optionLiquiditySelectionEnabled: false,
        optionTenorWindowDays: 0,
        optionProbeParallelism: 1,
        optionProtectionTolerancePct: 0.03,
        maxOptionPremiumRatio: 0.2,
        qualifyCacheTtlMs: 300000,
        qualifyCacheMaxKeys: 500
      }
    });

    const req = {
      marketId: "BTC-USD",
      instrumentId: "BTC-USD-8D-P",
      protectedNotional: 10000,
      quantity: 0.2,
      side: "buy" as const,
      protectionType: "long" as const,
      triggerPrice: 55000,
      requestedTenorDays: 2,
      tenorMinDays: 1,
      tenorMaxDays: 14,
      hedgePolicy: "options_primary_futures_fallback" as const
    };
    const first = await adapter.quote(req);
    const second = await adapter.quote(req);
    assert.equal(first.venue, "ibkr_cme_paper");
    assert.equal(second.venue, "ibkr_cme_paper");
    assert.equal(qualifyCount, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

