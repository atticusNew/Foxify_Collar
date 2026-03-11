import assert from "node:assert/strict";
import test from "node:test";
import { resolvePriceSnapshot } from "../src/pilot/price";

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("resolvePriceSnapshot uses primary source when valid", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        oraclePrice: 100000,
        timestamp: Date.now()
      })
    }) as any) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 5000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-1",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "reference_oracle");
  assert.equal(result.marketId, "BTC-USD");
});

test("resolvePriceSnapshot falls back when primary payload invalid", async () => {
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          market_id: "BTC-USD",
          oraclePrice: -1,
          timestamp: Date.now()
        })
      } as any;
    }
    return {
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        price: 99999,
        timestamp: Date.now()
      })
    } as any;
  }) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 5000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-2",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "fallback_oracle");
});

test("resolvePriceSnapshot rejects when both sources invalid", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        price: 0,
        timestamp: Date.now()
      })
    }) as any) as typeof fetch;
  await assert.rejects(
    () =>
      resolvePriceSnapshot(
        {
          primaryUrl: "https://primary",
          fallbackUrl: "https://fallback",
          primaryTimeoutMs: 800,
          fallbackTimeoutMs: 800,
          freshnessMaxMs: 5000
        },
        {
          marketId: "BTC-USD",
          now: new Date(),
          requestId: "req-3",
          endpointVersion: "v1"
        }
      ),
    /price_unavailable/
  );
});

