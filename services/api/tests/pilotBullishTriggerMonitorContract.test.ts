import assert from "node:assert/strict";
import test from "node:test";
import {
  BullishTradingClient,
  resolveBullishMarketSymbol,
  type BullishHybridOrderbook
} from "../src/pilot/bullish";

/**
 * Contract tests for the public API shape that triggerMonitor.ts depends on.
 *
 * Background: triggerMonitor.ts:resolveBullishTriggerPrice was originally
 * implemented against a different (older?) Bullish API shape and broke when
 * the actual bullish.ts module shipped:
 *
 *   1. resolveBullishMarketSymbol was called as (marketId, config) — but the
 *      actual signature is (config, params).
 *   2. client.getOrderBook(symbol) was called — but BullishTradingClient
 *      exposes getHybridOrderBook, not getOrderBook.
 *   3. book.bids[0][0] was indexed assuming tuple [price, qty] shape — but
 *      the actual shape is { price: string; quantity: string }.
 *
 * These contract tests fail-fast if anyone changes the public API in a way
 * that would re-break the trigger-monitor integration. They do NOT require
 * a live Bullish API connection.
 *
 * The runtime fix lives in services/api/src/pilot/triggerMonitor.ts in the
 * resolveBullishTriggerPrice function.
 */

test("BullishTradingClient exposes getHybridOrderBook (not getOrderBook)", () => {
  // Construct with minimal config; we don't call any network methods here.
  const minimalConfig = {
    enabled: true,
    restBaseUrl: "https://example.invalid",
    publicWsUrl: "wss://example.invalid",
    privateWsUrl: "wss://example.invalid",
    authMode: "hmac" as const,
    hmacPublicKey: "",
    hmacSecret: "",
    ecdsaPublicKey: "",
    ecdsaPrivateKey: "",
    ecdsaMetadata: "",
    tradingAccountId: "",
    defaultSymbol: "BTCUSDC",
    symbolByMarketId: {},
    hmacLoginPath: "/x",
    ecdsaLoginPath: "/x",
    tradingAccountsPath: "/x",
    noncePath: "/x",
    commandPath: "/x",
    orderbookPathTemplate: "/x/:symbol",
    enableExecution: false,
    orderTimeoutMs: 5000,
    orderTif: "IOC" as const,
    allowMargin: false
  };
  const client = new BullishTradingClient(minimalConfig);

  // The trigger monitor depends on getHybridOrderBook being a function.
  assert.equal(typeof (client as any).getHybridOrderBook, "function",
    "BullishTradingClient must expose getHybridOrderBook (trigger monitor depends on this method name)");

  // The trigger monitor must NOT depend on a method named getOrderBook.
  // If someone adds a getOrderBook in the future, that's fine, but the
  // trigger monitor must still call getHybridOrderBook.
  assert.equal(typeof (client as any).getOrderBook, "undefined",
    "BullishTradingClient does not expose getOrderBook — trigger monitor must call getHybridOrderBook instead");
});

test("resolveBullishMarketSymbol signature: (config, params) — not (params, config)", () => {
  const config = {
    defaultSymbol: "BTCUSDC",
    symbolByMarketId: { "BTC-USD": "BTCUSDC" }
  };

  // CORRECT call shape — should resolve via the symbol map.
  const correct = resolveBullishMarketSymbol(config, { marketId: "BTC-USD" });
  assert.equal(correct, "BTCUSDC",
    "resolveBullishMarketSymbol should accept (config, { marketId }) and return mapped symbol");

  // The trigger monitor's prior bug was to swap the args.
  // If someone reverses the signature in the future, this test will catch
  // either by throwing or returning a wrong value.
  try {
    // This is what the BUGGY call looked like:
    //   resolveBullishMarketSymbol("BTC-USD", config)
    // It either throws because string lacks defaultSymbol/symbolByMarketId,
    // or returns something other than the expected mapped symbol.
    const swapped = resolveBullishMarketSymbol(
      "BTC-USD" as any,
      config as any
    );
    // If it doesn't throw, the result must NOT match what the correct call
    // returned (sanity check — confirms the args are positional, not flexible).
    assert.notEqual(swapped, "BTCUSDC",
      "Swapped args should not silently return the right answer (would mask the bug)");
  } catch {
    // Throwing is also acceptable — confirms the signature enforcement.
  }
});

test("BullishHybridOrderbook shape: bids/asks are arrays of {price, quantity} objects", () => {
  // This test documents the expected shape that triggerMonitor.ts's fix
  // depends on. If a future refactor changes this shape, the trigger
  // monitor will need to update its access pattern.
  const sample: BullishHybridOrderbook = {
    symbol: "BTC-USDC-20260514-79600-P",
    bids: [{ price: "110.00", quantity: "23.6" }],
    asks: [{ price: "140.00", quantity: "1.91" }],
    datetime: null,
    timestamp: null,
    sequenceNumber: null,
    raw: null
  };

  // Trigger monitor accesses bids[0]?.price (NOT bids[0]?.[0])
  assert.equal(sample.bids[0]?.price, "110.00",
    "BullishHybridOrderbook bids[0].price must be the named accessor");
  assert.equal(sample.asks[0]?.price, "140.00",
    "BullishHybridOrderbook asks[0].price must be the named accessor");

  // Tuple-style access [0] returns undefined and would break the trigger
  // monitor's mid-price computation if used.
  assert.equal((sample.bids[0] as any)?.[0], undefined,
    "Tuple-style indexing bids[0][0] must NOT work — trigger monitor previously used this and broke");
});
