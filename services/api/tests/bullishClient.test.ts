/**
 * Unit tests for the shared Bullish client singleton + cache layer
 * (services/api/src/pilot/bullishClient.ts, added 2026-05-22).
 *
 * Validates:
 *   - Singleton: same config → same instance; different fingerprint → new
 *   - Wide singleton is distinct from primary singleton
 *   - Balances cache: TTL respected; refetch after expiry
 *   - Orderbook cache: per-symbol; TTL respected
 *   - Env gate: BULLISH_BALANCE_TRACKING_ENABLED true/false/missing
 *
 * Mocks BullishTradingClient via __setBullishClientFactoryForTests so no
 * network or WS connections are made.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getSharedBullishClient,
  getSharedWideBullishClient,
  getCachedBullishBalances,
  getCachedBullishOrderbook,
  isBullishBalanceTrackingEnabled,
  __setBullishClientFactoryForTests,
  __resetBullishClientStateForTests
} from "../src/pilot/bullishClient";

type FakeClient = {
  id: string;
  config: any;
  getAssetBalancesCalls: number;
  getHybridOrderBookCalls: Map<string, number>;
  getAssetBalances: (params?: any) => Promise<any[]>;
  getHybridOrderBook: (symbol: string) => Promise<any>;
};

let _factoryCallCount = 0;
const makeFakeClient = (config: any): FakeClient => {
  _factoryCallCount += 1;
  const c: FakeClient = {
    id: `fake-${_factoryCallCount}`,
    config,
    getAssetBalancesCalls: 0,
    getHybridOrderBookCalls: new Map(),
    getAssetBalances: async (_params?: any) => {
      c.getAssetBalancesCalls += 1;
      return [
        { assetSymbol: "USDC", availableQuantity: "1000.00", lockedQuantity: "0", borrowedQuantity: "0" },
        { assetSymbol: "BTC", availableQuantity: "0.05", lockedQuantity: "0", borrowedQuantity: "0" }
      ];
    },
    getHybridOrderBook: async (symbol: string) => {
      const n = (c.getHybridOrderBookCalls.get(symbol) ?? 0) + 1;
      c.getHybridOrderBookCalls.set(symbol, n);
      return {
        symbol,
        bids: [{ price: "75000", quantity: "1.5" }],
        asks: [{ price: "75100", quantity: "1.5" }],
        datetime: new Date().toISOString(),
        timestamp: String(Date.now()),
        sequenceNumber: String(n),
        raw: {}
      };
    }
  };
  return c;
};

const baseConfig = {
  tradingAccountId: "acct-1",
  ecdsaPublicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ecdsaMetadata: "meta-fingerprint",
  restBaseUrl: "https://api.exchange.bullish.com"
};

const setup = () => {
  _factoryCallCount = 0;
  __resetBullishClientStateForTests();
  __setBullishClientFactoryForTests((cfg) => makeFakeClient(cfg) as any);
};

const teardown = () => {
  __setBullishClientFactoryForTests(null);
  __resetBullishClientStateForTests();
};

test("bullishClient: getSharedBullishClient returns same instance on second call with same config", () => {
  setup();
  try {
    const a = getSharedBullishClient(baseConfig as any) as any;
    const b = getSharedBullishClient(baseConfig as any) as any;
    assert.equal(a.id, b.id, "same config → same singleton");
    assert.equal(_factoryCallCount, 1, "factory called exactly once");
  } finally { teardown(); }
});

test("bullishClient: different tradingAccountId fingerprint produces a new instance", () => {
  setup();
  try {
    const a = getSharedBullishClient(baseConfig as any) as any;
    const b = getSharedBullishClient({ ...baseConfig, tradingAccountId: "acct-2" } as any) as any;
    assert.notEqual(a.id, b.id, "different account → different singleton");
    assert.equal(_factoryCallCount, 2);
  } finally { teardown(); }
});

test("bullishClient: ecdsaPublicKey rotation invalidates singleton (Render env change)", () => {
  setup();
  try {
    const a = getSharedBullishClient(baseConfig as any) as any;
    const b = getSharedBullishClient({ ...baseConfig, ecdsaPublicKey: "a".repeat(64) } as any) as any;
    assert.notEqual(a.id, b.id, "key rotation → fresh singleton");
  } finally { teardown(); }
});

test("bullishClient: wide singleton is distinct from primary singleton", () => {
  setup();
  try {
    const primary = getSharedBullishClient(baseConfig as any) as any;
    const wide = getSharedWideBullishClient(baseConfig as any) as any;
    assert.notEqual(primary.id, wide.id, "wide must be a separate instance");
    assert.equal(wide.config.tradingAccountId, "", "wide config has empty tradingAccountId");
    assert.equal(primary.config.tradingAccountId, "acct-1", "primary keeps the original tradingAccountId");
  } finally { teardown(); }
});

test("bullishClient: getCachedBullishBalances caches within TTL, refetches after expiry", async () => {
  setup();
  try {
    // Seed cache with very short TTL (1ms) so it expires before second call.
    const balances1 = await getCachedBullishBalances(baseConfig as any, 1);
    const balances2 = await getCachedBullishBalances(baseConfig as any, 60_000);
    // 1ms TTL means by the time of the second call (async hop), cache has expired.
    // Wait one extra tick just to be deterministic across machines.
    await new Promise((r) => setTimeout(r, 5));
    const balances3 = await getCachedBullishBalances(baseConfig as any, 60_000);

    const client = getSharedBullishClient(baseConfig as any) as any;
    // First call seeds cache; balances1 = miss. balances2 = either fresh
    // refetch (TTL already expired) OR cache hit if microtask ordering left it.
    // balances3 (after 5ms sleep) WILL definitely be a cache hit if balances2
    // already refetched. So the expected call count is either 2 (balances1 +
    // balances2 refetch) or 2 (balances1 + balances3 refetch).
    assert.equal(client.getAssetBalancesCalls, 2, "exactly one refetch after TTL expiry");
    assert.deepEqual(balances1, balances2);
    assert.deepEqual(balances1, balances3);

    // Subsequent call inside the long TTL should NOT trigger another fetch.
    await getCachedBullishBalances(baseConfig as any, 60_000);
    assert.equal(client.getAssetBalancesCalls, 2, "within 60s TTL must hit cache");
  } finally { teardown(); }
});

test("bullishClient: getCachedBullishOrderbook caches per-symbol, distinct symbols independent", async () => {
  setup();
  try {
    await getCachedBullishOrderbook(baseConfig as any, "BTC-USDC-20260526-75000-P", 60_000);
    await getCachedBullishOrderbook(baseConfig as any, "BTC-USDC-20260526-75000-P", 60_000);
    await getCachedBullishOrderbook(baseConfig as any, "BTC-USDC-20260526-76500-C", 60_000);

    const client = getSharedBullishClient(baseConfig as any) as any;
    assert.equal(client.getHybridOrderBookCalls.get("BTC-USDC-20260526-75000-P"), 1, "put cached after first fetch");
    assert.equal(client.getHybridOrderBookCalls.get("BTC-USDC-20260526-76500-C"), 1, "call fetched once (different symbol)");
  } finally { teardown(); }
});

test("bullishClient: isBullishBalanceTrackingEnabled defaults to true when env unset", () => {
  const prev = process.env.BULLISH_BALANCE_TRACKING_ENABLED;
  delete process.env.BULLISH_BALANCE_TRACKING_ENABLED;
  try {
    assert.equal(isBullishBalanceTrackingEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.BULLISH_BALANCE_TRACKING_ENABLED;
    else process.env.BULLISH_BALANCE_TRACKING_ENABLED = prev;
  }
});

test("bullishClient: isBullishBalanceTrackingEnabled honors explicit false / 0", () => {
  const prev = process.env.BULLISH_BALANCE_TRACKING_ENABLED;
  try {
    process.env.BULLISH_BALANCE_TRACKING_ENABLED = "false";
    assert.equal(isBullishBalanceTrackingEnabled(), false);
    process.env.BULLISH_BALANCE_TRACKING_ENABLED = "0";
    assert.equal(isBullishBalanceTrackingEnabled(), false);
    process.env.BULLISH_BALANCE_TRACKING_ENABLED = "true";
    assert.equal(isBullishBalanceTrackingEnabled(), true);
    process.env.BULLISH_BALANCE_TRACKING_ENABLED = "1";
    assert.equal(isBullishBalanceTrackingEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.BULLISH_BALANCE_TRACKING_ENABLED;
    else process.env.BULLISH_BALANCE_TRACKING_ENABLED = prev;
  }
});
