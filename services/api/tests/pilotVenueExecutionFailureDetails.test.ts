import assert from "node:assert/strict";
import test from "node:test";
import { createPilotVenueAdapter } from "../src/pilot/venue";

test("ibkr execute failure includes fillStatus and rejectionReason details", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path.startsWith("health")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 100,
              ask: 101,
              bidSize: 3,
              askSize: 3,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("orders/place")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ orderId: "99", submittedAt: new Date().toISOString() })
        } as any;
      }
      if (path.startsWith("orders/99/cancel")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ cancelled: true, asOf: new Date().toISOString() })
        } as any;
      }
      if (path.startsWith("orders/99")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              orderId: "99",
              status: "rejected",
              filledQuantity: 0,
              avgFillPrice: 0,
              rejectionReason: "No liquidity at limit",
              lastUpdateAt: new Date().toISOString()
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
        bridgeTimeoutMs: 1500,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: true,
        orderTimeoutMs: 1200,
        maxRepriceSteps: 1,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: false,
        orderTif: "IOC",
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true
      }
    });

    const execution = await adapter.execute({
      venue: "ibkr_cme_paper",
      quoteId: "q-ibkr-fail",
      rfqId: null,
      instrumentId: "IBKR-FOP-99-MBT_20260401_P80000",
      side: "buy",
      quantity: 0.1,
      premium: 5,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      quoteTs: new Date().toISOString(),
      details: { conId: 11111, multiplier: "0.1", minTick: 5 }
    });

    assert.equal(execution.status, "failure");
    assert.equal(String(execution.details?.fillStatus || ""), "rejected");
    assert.equal(String(execution.details?.rejectionReason || ""), "No liquidity at limit");
    assert.equal(String(execution.details?.orderTif || ""), "IOC");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ibkr execute success includes realized commission details", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = url.split("://")[1]?.split("/").slice(1).join("/") || "";
      if (path.startsWith("health")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: "connected",
              transport: "ib_socket",
              activeTransport: "ib_socket",
              fallbackEnabled: false
            })
        } as any;
      }
      if (path.startsWith("marketdata/top")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              bid: 100,
              ask: 101,
              bidSize: 3,
              askSize: 3,
              asOf: new Date().toISOString()
            })
        } as any;
      }
      if (path.startsWith("orders/place")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ orderId: "100", submittedAt: new Date().toISOString() })
        } as any;
      }
      if (path.startsWith("orders/100/cancel")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ cancelled: true, asOf: new Date().toISOString() })
        } as any;
      }
      if (path.startsWith("orders/100")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              orderId: "100",
              status: "partially_filled",
              filledQuantity: 1,
              avgFillPrice: 285,
              commissionUsd: 2.02,
              commissionCurrency: "USD",
              lastUpdateAt: new Date().toISOString()
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
        bridgeTimeoutMs: 1500,
        bridgeToken: "",
        accountId: "DU123456",
        enableExecution: true,
        orderTimeoutMs: 1200,
        maxRepriceSteps: 1,
        repriceStepTicks: 1,
        maxSlippageBps: 25,
        requireLiveTransport: false,
        orderTif: "IOC",
        maxTenorDriftDays: 7,
        preferTenorAtOrAbove: true
      }
    });

    const execution = await adapter.execute({
      venue: "ibkr_cme_paper",
      quoteId: "q-ibkr-success",
      rfqId: null,
      instrumentId: "IBKR-FOP-99-MBT_20260401_P80000",
      side: "buy",
      quantity: 0.1,
      premium: 5,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      quoteTs: new Date().toISOString(),
      details: { conId: 11111, multiplier: "0.1", minTick: 5 }
    });

    assert.equal(execution.status, "success");
    assert.equal(Number(execution.details?.commissionUsd || 0), 2.02);
    assert.equal(String(execution.details?.commissionCurrency || ""), "USD");
  } finally {
    global.fetch = originalFetch;
  }
});
