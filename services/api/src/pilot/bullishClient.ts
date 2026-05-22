/**
 * Shared Bullish trading client + cache layer.
 *
 * Each `new BullishTradingClient(...)` creates a fresh HMAC login → fresh JWT
 * session + fresh private WS topic subscriptions. Bullish caps active sessions
 * per user (~10-20) and trips MAX_SESSION_COUNT_REACHED (errorCode 8400) when
 * exceeded; it also rate-limits the underlying market/orderbook HTTP endpoints
 * (errorCode 96100, RATE_LIMIT_EXCEEDED).
 *
 * Until 2026-05-22 the codebase had 5 callsites that built fresh clients on
 * every invocation:
 *   - server.ts:8276 (spotPriceSource Bullish branch, runs every 60s)
 *   - server.ts:8335 (venueBalanceFetcher, runs on every admin dashboard tick)
 *   - triggerMonitor.ts:40 (trigger detection cycle on Bullish-routed positions)
 *   - volumeCoverRoutes.ts:1352 (diagnostic balance endpoint)
 *   - volumeCoverRoutes.ts:1920 (wide-config trading-accounts endpoint)
 *   - volumeCoverRoutes.ts:2361 (option-chain enumeration endpoint)
 * The dashboard auto-refresh + 60s trigger monitor combined would exhaust the
 * session quota in <10 min of continuous use.
 *
 * This module exports:
 *   - `getSharedBullishClient(config)` — singleton fingerprinted on config
 *   - `getSharedWideBullishClient(config)` — singleton with tradingAccountId="" for admin lister
 *   - `getCachedBullishOrderbook(config, symbol, ttlMs)` — per-symbol 5s default cache
 *   - `getCachedBullishBalances(config, ttlMs, timeoutMs)` — 30s default cache
 *   - `isBullishBalanceTrackingEnabled()` — env gate to skip Bullish entirely on live
 *
 * The fingerprint covers `tradingAccountId`, ECDSA key tails, and `restBaseUrl`;
 * any env change via Render dashboard invalidates the singleton automatically.
 */

import {
  BullishTradingClient,
  type BullishHybridOrderbook,
  type BullishAssetBalance
} from "./bullish";

type BullishClientConfig = ConstructorParameters<typeof BullishTradingClient>[0];

type ClientFactory = (config: BullishClientConfig) => BullishTradingClient;

let _clientFactory: ClientFactory = (config) => new BullishTradingClient(config);

let _client: BullishTradingClient | null = null;
let _clientFingerprint: string | null = null;
let _wideClient: BullishTradingClient | null = null;
let _wideClientFingerprint: string | null = null;

type OrderbookCacheEntry = { expiresAtMs: number; book: BullishHybridOrderbook };
const _orderbookCache: Map<string, OrderbookCacheEntry> = new Map();

type BalancesCacheEntry = { expiresAtMs: number; balances: BullishAssetBalance[] };
let _balancesCache: BalancesCacheEntry | null = null;

// 2026-05-22 — Negative cache for rate-limit/session-quota errors. When
// Bullish returns 96100 RATE_LIMIT_EXCEEDED or 8400 MAX_SESSION_COUNT_REACHED,
// we cache the error for NEGATIVE_CACHE_TTL_MS and fast-fail subsequent
// calls without re-hitting Bullish. Otherwise every dashboard tick or
// script retry inside the cooldown window adds load and (depending on
// the rate-limit algorithm) can extend the cooldown.
type NegativeCacheEntry = { expiresAtMs: number; message: string };
const _negativeCache: Map<string, NegativeCacheEntry> = new Map();
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 60_000;

const isRateLimitOrSessionError = (err: unknown): { match: boolean; message: string } => {
  const msg = (err as { message?: string } | null | undefined)?.message ?? String(err ?? "");
  if (/RATE_LIMIT_EXCEEDED|96100|MAX_SESSION_COUNT_REACHED|8400|bullish_http_429|bullish_http_503/.test(msg)) {
    return { match: true, message: msg };
  }
  return { match: false, message: msg };
};

const negKey = (op: string, subject: string): string => `${op}|${subject}`;
const checkNegativeCache = (key: string): void => {
  const entry = _negativeCache.get(key);
  if (entry && entry.expiresAtMs > Date.now()) {
    throw new Error(
      `bullish_negative_cache_hit:${entry.message} (suppressed retry; ` +
        `try again in ${Math.ceil((entry.expiresAtMs - Date.now()) / 1000)}s)`
    );
  }
};
const recordNegativeIfMatch = (key: string, err: unknown, ttlMs: number = DEFAULT_NEGATIVE_CACHE_TTL_MS): void => {
  const r = isRateLimitOrSessionError(err);
  if (r.match) {
    _negativeCache.set(key, { expiresAtMs: Date.now() + Math.max(1000, ttlMs), message: r.message });
  }
};

const fingerprint = (cfg: BullishClientConfig): string => {
  const c = cfg as Record<string, unknown>;
  const tail = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(-n) : "");
  return [
    String(c.tradingAccountId ?? ""),
    tail(c.ecdsaPublicKey, 32),
    tail(c.ecdsaMetadata, 16),
    String(c.restBaseUrl ?? "")
  ].join("|");
};

export const getSharedBullishClient = (config: BullishClientConfig): BullishTradingClient => {
  const fp = fingerprint(config);
  if (_client && _clientFingerprint === fp) return _client;
  _client = _clientFactory(config);
  _clientFingerprint = fp;
  return _client;
};

export const getSharedWideBullishClient = (config: BullishClientConfig): BullishTradingClient => {
  const wideConfig = { ...(config as Record<string, unknown>), tradingAccountId: "" } as BullishClientConfig;
  const fp = fingerprint(wideConfig);
  if (_wideClient && _wideClientFingerprint === fp) return _wideClient;
  _wideClient = _clientFactory(wideConfig);
  _wideClientFingerprint = fp;
  return _wideClient;
};

export const getCachedBullishOrderbook = async (
  config: BullishClientConfig,
  symbol: string,
  ttlMs: number = 5_000
): Promise<BullishHybridOrderbook> => {
  const cached = _orderbookCache.get(symbol);
  if (cached && cached.expiresAtMs > Date.now()) return cached.book;
  const nKey = negKey("orderbook", symbol);
  checkNegativeCache(nKey);
  const client = getSharedBullishClient(config);
  try {
    const book = await client.getHybridOrderBook(symbol);
    _orderbookCache.set(symbol, { expiresAtMs: Date.now() + Math.max(0, ttlMs), book });
    return book;
  } catch (err) {
    recordNegativeIfMatch(nKey, err);
    throw err;
  }
};

export const getCachedBullishBalances = async (
  config: BullishClientConfig,
  ttlMs: number = 30_000,
  timeoutMs: number = 5_000
): Promise<BullishAssetBalance[]> => {
  if (_balancesCache && _balancesCache.expiresAtMs > Date.now()) {
    return _balancesCache.balances;
  }
  const nKey = negKey("balances", "shared");
  checkNegativeCache(nKey);
  const client = getSharedBullishClient(config);
  try {
    const balances = await client.getAssetBalances({ timeoutMs });
    _balancesCache = { expiresAtMs: Date.now() + Math.max(0, ttlMs), balances };
    return balances;
  } catch (err) {
    recordNegativeIfMatch(nKey, err);
    throw err;
  }
};

/**
 * Env gate: skip ALL Bullish balance fetching when Bullish isn't actively
 * holding positions. Default: true (no behavior change on shadow). Operator
 * sets `BULLISH_BALANCE_TRACKING_ENABLED=false` on live Render until Bullish
 * integration starts trading. Saves 1-3 Bullish requests per dashboard tick
 * and avoids MAX_SESSION_COUNT_REACHED entirely.
 */
export const isBullishBalanceTrackingEnabled = (): boolean => {
  const v = String(process.env.BULLISH_BALANCE_TRACKING_ENABLED ?? "true").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
};

// ---------------------------------------------------------------------------
// Test helpers — not part of the public API. Used by unit tests only.
// ---------------------------------------------------------------------------

export const __setBullishClientFactoryForTests = (factory: ClientFactory | null): void => {
  _clientFactory = factory ?? ((config) => new BullishTradingClient(config));
};

export const __resetBullishClientStateForTests = (): void => {
  _client = null;
  _clientFingerprint = null;
  _wideClient = null;
  _wideClientFingerprint = null;
  _orderbookCache.clear();
  _balancesCache = null;
  _negativeCache.clear();
};

/**
 * Operator/debug helper: clear the rate-limit negative cache so a
 * follow-up call retries Bullish even if the cooldown window hasn't
 * naturally expired. Use sparingly — defeats the purpose of the
 * back-off. Surfaced primarily for admin endpoints that want to
 * deliberately probe whether the rate limit has cleared.
 */
export const clearBullishNegativeCache = (): { cleared: number } => {
  const n = _negativeCache.size;
  _negativeCache.clear();
  return { cleared: n };
};
