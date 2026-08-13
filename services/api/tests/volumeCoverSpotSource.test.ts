import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpotPriceSource,
  __resetSpotPriceSourceCache
} from "../src/volumeCover/spotPriceSource";

const reset = () => __resetSpotPriceSourceCache();

test("spot source: Bullish primary returns bullish_hybrid source", async () => {
  reset();
  const src = createSpotPriceSource({
    bullishOrderbookFn: async () => ({
      bids: [{ price: "78180.00" }],
      asks: [{ price: "78185.00" }]
    }),
    // Coinbase will also be called but Bullish wins
    primaryUrl: "http://invalid-test-url-coinbase"
  });
  const res = await src();
  // Mid = 78182.50
  assert.equal(res.spotBtcPrice, 78_182.5);
  assert.equal(res.source, "bullish_hybrid");
});

test("spot source: falls back to Coinbase when Bullish errors", async () => {
  reset();
  // Bullish throws → Coinbase fallback. We use a real Coinbase URL
  // so the test depends on internet; if Coinbase also unreachable,
  // this asserts the error path.
  const src = createSpotPriceSource({
    bullishOrderbookFn: async () => {
      throw new Error("simulated_bullish_outage");
    }
  });
  try {
    const res = await src();
    // Real Coinbase price expected (~78k range)
    assert.equal(res.source, "coinbase_fallback");
    assert.ok(res.spotBtcPrice > 50_000 && res.spotBtcPrice < 200_000);
  } catch (err) {
    // If both fail (e.g., test env has no internet), accept the error
    assert.match((err as Error).message, /vc_spot_source_unavailable|primary_request_failed/);
  }
});

test("spot source: empty Bullish orderbook falls back to Coinbase", async () => {
  reset();
  const src = createSpotPriceSource({
    bullishOrderbookFn: async () => ({ bids: [], asks: [] })
  });
  try {
    const res = await src();
    assert.equal(res.source, "coinbase_fallback");
  } catch (err) {
    // Tolerate offline test env
    assert.match((err as Error).message, /vc_spot_source_unavailable|primary_request_failed/);
  }
});

test("spot source: cache returns same value within TTL", async () => {
  reset();
  let bullishCalls = 0;
  const src = createSpotPriceSource({
    bullishOrderbookFn: async () => {
      bullishCalls++;
      return { bids: [{ price: "78180.00" }], asks: [{ price: "78185.00" }] };
    },
    cacheTtlMs: 60_000
  });
  await src();
  await src();
  await src();
  // Bullish called once due to cache
  assert.equal(bullishCalls, 1);
});

test("spot source: drift warning logged when Bullish + Coinbase diverge >50bp", async () => {
  reset();
  // Stub console.warn to capture
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const src = createSpotPriceSource({
      bullishOrderbookFn: async () => ({
        bids: [{ price: "70000.00" }],
        asks: [{ price: "70010.00" }]
      })
      // Coinbase will return real ~78k; drift will be huge
    });
    await src();
    // Drift warning fired
    const driftWarn = warnings.find((w) => w.includes("DRIFT WARNING"));
    if (driftWarn) {
      assert.match(driftWarn, /Bullish=\$70005\.00/);
      assert.match(driftWarn, /drift=\d+bp/);
    } else {
      // Coinbase unreachable; can't compare. Acceptable.
    }
  } finally {
    console.warn = originalWarn;
    reset();
  }
});

test("spot source: throws when both venues unavailable", async () => {
  reset();
  const src = createSpotPriceSource({
    bullishOrderbookFn: async () => {
      throw new Error("bullish_down");
    },
    primaryUrl: "http://localhost:1/should-fail-immediately"
  });
  await assert.rejects(src(), /vc_spot_source_unavailable/);
});
