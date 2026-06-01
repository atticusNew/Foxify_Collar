/**
 * Bullish orderbook (price) auth lever — BULLISH_ORDERBOOK_AUTHED.
 *
 * The hybrid-orderbook read is the PRICE path that feeds the v2 LiquidChainCache
 * (and volumeCover/dashboard). By default it is an UNAUTHENTICATED public read, so
 * the account IP-whitelist (which raises limits on AUTHENTICATED endpoints) does NOT
 * apply to it. Setting BULLISH_ORDERBOOK_AUTHED=true attaches the account JWT so the
 * read uses the whitelisted, higher-rate-limit authenticated path.
 *
 * These tests verify the gating + header attachment + graceful public fallback,
 * WITHOUT any live Bullish connection (the underlying request() is stubbed).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BullishTradingClient } from "../src/pilot/bullish";

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
  orderbookPathTemplate: "/orderbook/:symbol",
  enableExecution: false,
  orderTimeoutMs: 5000,
  orderTif: "IOC" as const,
  allowMargin: false
};

const makeClient = () => new BullishTradingClient(minimalConfig);

/** Replace the private network request() so we can capture the headers it would send. */
const stubRequest = (client: unknown, capture: { headers?: Record<string, string> }) => {
  (client as { request: unknown }).request = async (params: { headers?: Record<string, string> }) => {
    capture.headers = params.headers;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ bids: [{ price: "100", quantity: "1" }], asks: [{ price: "110", quantity: "1" }] })
    } as unknown as Response;
  };
};

const withEnv = async (val: string | undefined, fn: () => Promise<void>) => {
  const prev = process.env.BULLISH_ORDERBOOK_AUTHED;
  if (val === undefined) delete process.env.BULLISH_ORDERBOOK_AUTHED;
  else process.env.BULLISH_ORDERBOOK_AUTHED = val;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.BULLISH_ORDERBOOK_AUTHED;
    else process.env.BULLISH_ORDERBOOK_AUTHED = prev;
  }
};

test("getHybridOrderBook: PUBLIC read by default (no Authorization header)", async () => {
  await withEnv(undefined, async () => {
    const client = makeClient();
    const cap: { headers?: Record<string, string> } = {};
    stubRequest(client, cap);
    const book = await client.getHybridOrderBook("BTC-USDC-20260601-100000-P");
    assert.equal(cap.headers?.Authorization, undefined, "default = public read, no auth header");
    assert.equal(cap.headers?.Accept, "application/json");
    assert.ok(Array.isArray(book.bids) && Array.isArray(book.asks));
  });
});

test("getHybridOrderBook: AUTHED read when BULLISH_ORDERBOOK_AUTHED=true (attaches Bearer JWT)", async () => {
  await withEnv("true", async () => {
    const client = makeClient();
    // Stub the session so we don't need real creds/network.
    (client as { getJwtSession: unknown }).getJwtSession = async () => ({
      token: "JWT_TEST_TOKEN", authorizer: "auth", expiresAtMs: Date.now() + 1_000_000
    });
    const cap: { headers?: Record<string, string> } = {};
    stubRequest(client, cap);
    await client.getHybridOrderBook("BTC-USDC-20260601-100000-P");
    assert.equal(cap.headers?.Authorization, "Bearer JWT_TEST_TOKEN", "authed read attaches the account JWT");
    assert.equal(cap.headers?.Accept, "application/json");
  });
});

test("getHybridOrderBook: AUTHED flag on but no creds → graceful public fallback (no throw)", async () => {
  await withEnv("true", async () => {
    // minimalConfig has empty creds → getJwtSession throws → must fall back to public.
    const client = makeClient();
    const cap: { headers?: Record<string, string> } = {};
    stubRequest(client, cap);
    const book = await client.getHybridOrderBook("BTC-USDC-20260601-100000-P");
    assert.equal(cap.headers?.Authorization, undefined, "no creds → falls back to public read");
    assert.ok(Array.isArray(book.bids), "still returns a book (no throw)");
  });
});
