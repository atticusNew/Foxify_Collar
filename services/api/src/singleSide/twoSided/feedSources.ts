/**
 * Five-source live price fetchers for the canonical Atticus feed (PR A1).
 *
 * Each fetcher returns a `FeedSourceSample` with timestamp, or null if it
 * fails / times out. The aggregator (feedAggregator.ts) consumes an array
 * of samples and applies median + outlier rejection.
 *
 * Source list per TRIGGER_SOURCE_AND_FEED_SPEC.md §3.1:
 *   1. Bullish      — via Render-proxied admin chain endpoint (spotBtcUsdc field)
 *   2. Deribit      — public get_index_price?index_name=btc_usd
 *   3. Coinbase     — public /v2/prices/BTC-USD/spot
 *   4. Binance      — public /api/v3/ticker/price?symbol=BTCUSDT
 *   5. Kraken       — public /0/public/Ticker?pair=XBTUSD
 *
 * Each fetcher has its own timeout (default 500ms — fast feeds). pollAllSources
 * runs them in parallel via Promise.all-style; one slow source can't block
 * the others.
 *
 * Bullish requires RENDER_API_URL + RENDER_ADMIN_TOKEN env vars; if either is
 * missing, Bullish fetcher returns null and pollAllSources operates on the
 * remaining 4 sources. The aggregator's degraded health flag will fire when
 * surviving source count drops below 3.
 *
 * Notable: Binance is geo-blocked from some Atticus dev environments but works
 * from Render production. Local dev sees 4-source healthy + 1 source blocked.
 *
 * Notable: Bullish chain endpoint is heavy (full option chain payload) for a
 * single spot price. For production efficiency we cache the last successful
 * Bullish spot for `BULLISH_SPOT_CACHE_MS` (5000ms default) — the chain is
 * only re-pulled when the cache expires. Spec aggregator's `maxAgeMs=1500ms`
 * means cached Bullish sample will be filtered as "expired" after 1.5s; that's
 * acceptable since the other 4 sources keep the feed healthy in between.
 *
 * Future optimization (not in this PR — would require live VC change):
 * a dedicated GET /volume-cover/admin/spot endpoint that returns just
 * { spotBtcUsdc, generatedAtIso } in <100 bytes.
 */

import type { FeedSourceSample } from "./feedAggregator";

const DEFAULT_FETCH_TIMEOUT_MS = 500;
const BULLISH_SPOT_CACHE_MS = 5_000;

const fetchWithTimeout = async (
  url: string,
  opts: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const safeJson = async <T>(r: Response): Promise<T | null> => {
  try {
    return (await r.json()) as T;
  } catch {
    return null;
  }
};

// ───────────────────────── Bullish (via Render proxy) ─────────────────────────

type BullishChainHead = {
  spotBtcUsdc?: number;
  generatedAtIso?: string;
};

type BullishCache = { sample: FeedSourceSample; cachedAtMs: number } | null;
let bullishCache: BullishCache = null;

export const _resetBullishCacheForTests = (): void => {
  bullishCache = null;
};

export const fetchBullishSpot = async (opts: {
  renderApiUrl?: string;
  adminToken?: string;
  nowMs?: number;
  timeoutMs?: number;
} = {}): Promise<FeedSourceSample | null> => {
  const now = opts.nowMs ?? Date.now();
  if (bullishCache && now - bullishCache.cachedAtMs < BULLISH_SPOT_CACHE_MS) {
    return bullishCache.sample;
  }
  const renderApiUrl = opts.renderApiUrl ?? process.env.RENDER_API_URL;
  const adminToken = opts.adminToken ?? process.env.RENDER_ADMIN_TOKEN;
  if (!renderApiUrl || !adminToken) return null;
  try {
    const res = await fetchWithTimeout(
      `${renderApiUrl}/volume-cover/admin/bullish-option-chain`,
      { headers: { "X-Admin-Token": adminToken, Accept: "application/json" } },
      opts.timeoutMs ?? 1_500 // chain payload is heavier than spot-only feeds — give it more headroom
    );
    if (!res.ok) return null;
    const body = await safeJson<BullishChainHead>(res);
    if (!body?.spotBtcUsdc || !Number.isFinite(body.spotBtcUsdc) || body.spotBtcUsdc <= 0) return null;
    const sample: FeedSourceSample = { source: "bullish", price: body.spotBtcUsdc, ts: now };
    bullishCache = { sample, cachedAtMs: now };
    return sample;
  } catch {
    return null;
  }
};

// ───────────────────────── Deribit (public) ─────────────────────────

type DeribitIndexResponse = { result?: { index_price?: number } };

export const fetchDeribitSpot = async (opts: { nowMs?: number; timeoutMs?: number } = {}): Promise<FeedSourceSample | null> => {
  const now = opts.nowMs ?? Date.now();
  try {
    const res = await fetchWithTimeout(
      "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd",
      { headers: { Accept: "application/json" } },
      opts.timeoutMs
    );
    if (!res.ok) return null;
    const body = await safeJson<DeribitIndexResponse>(res);
    const price = body?.result?.index_price;
    if (!price || !Number.isFinite(price) || price <= 0) return null;
    return { source: "deribit", price, ts: now };
  } catch {
    return null;
  }
};

// ───────────────────────── Coinbase (public) ─────────────────────────

type CoinbasePriceResponse = { data?: { amount?: string } };

export const fetchCoinbaseSpot = async (opts: { nowMs?: number; timeoutMs?: number } = {}): Promise<FeedSourceSample | null> => {
  const now = opts.nowMs ?? Date.now();
  try {
    const res = await fetchWithTimeout(
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      { headers: { Accept: "application/json" } },
      opts.timeoutMs
    );
    if (!res.ok) return null;
    const body = await safeJson<CoinbasePriceResponse>(res);
    const amt = body?.data?.amount;
    const price = amt ? Number(amt) : NaN;
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: "coinbase", price, ts: now };
  } catch {
    return null;
  }
};

// ───────────────────────── Binance (public) ─────────────────────────
//
// Geo-blocked from some Atticus dev environments (e.g. US-hosted dev VMs).
// Works fine from Render production. The aggregator handles the missing source
// gracefully (health=degraded with 4 instead of 5 sources is still healthy).

type BinanceTickerResponse = { price?: string };

export const fetchBinanceSpot = async (opts: { nowMs?: number; timeoutMs?: number } = {}): Promise<FeedSourceSample | null> => {
  const now = opts.nowMs ?? Date.now();
  try {
    const res = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      { headers: { Accept: "application/json" } },
      opts.timeoutMs
    );
    if (!res.ok) return null;
    const body = await safeJson<BinanceTickerResponse>(res);
    const price = body?.price ? Number(body.price) : NaN;
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: "binance", price, ts: now };
  } catch {
    return null;
  }
};

// ───────────────────────── Kraken (public) ─────────────────────────
//
// Kraken returns nested {result: {XXBTZUSD: {c: ["price", ...]}}}.

type KrakenTickerResponse = {
  error?: string[];
  result?: Record<string, { c?: string[] }>;
};

export const fetchKrakenSpot = async (opts: { nowMs?: number; timeoutMs?: number } = {}): Promise<FeedSourceSample | null> => {
  const now = opts.nowMs ?? Date.now();
  try {
    const res = await fetchWithTimeout(
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      { headers: { Accept: "application/json" } },
      opts.timeoutMs
    );
    if (!res.ok) return null;
    const body = await safeJson<KrakenTickerResponse>(res);
    if (body?.error && body.error.length > 0) return null;
    // Kraken returns XXBTZUSD as the canonical key for XBT/USD
    const pair = body?.result?.["XXBTZUSD"] ?? body?.result?.["XBTUSD"];
    const lastTrade = pair?.c?.[0];
    const price = lastTrade ? Number(lastTrade) : NaN;
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: "kraken", price, ts: now };
  } catch {
    return null;
  }
};

// ───────────────────────── Poll-all runner ─────────────────────────

export type PollAllResult = {
  samples: FeedSourceSample[];
  attempted: number;
  succeeded: number;
  perSourceStatus: Record<string, "ok" | "fail">;
  pollLatencyMs: number;
};

export type PollAllOpts = {
  nowMs?: number;
  timeoutMs?: number;
  /** Subset to poll, default all. Useful for tests + Render-only environments. */
  sources?: ReadonlyArray<"bullish" | "deribit" | "coinbase" | "binance" | "kraken">;
  /** Overrides for Bullish — read from env by default. */
  renderApiUrl?: string;
  adminToken?: string;
};

const SOURCE_FETCHERS = {
  bullish: fetchBullishSpot,
  deribit: fetchDeribitSpot,
  coinbase: fetchCoinbaseSpot,
  binance: fetchBinanceSpot,
  kraken: fetchKrakenSpot
} as const;

export const pollAllSources = async (opts: PollAllOpts = {}): Promise<PollAllResult> => {
  const t0 = Date.now();
  const sources = opts.sources ?? (["bullish", "deribit", "coinbase", "binance", "kraken"] as const);
  const fetchOpts = { nowMs: opts.nowMs, timeoutMs: opts.timeoutMs };

  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const fetcher = SOURCE_FETCHERS[s];
        // Bullish needs render creds threaded explicitly when provided
        if (s === "bullish") {
          return await (fetcher as typeof fetchBullishSpot)({
            ...fetchOpts,
            renderApiUrl: opts.renderApiUrl,
            adminToken: opts.adminToken
          });
        }
        return await fetcher(fetchOpts);
      } catch {
        return null;
      }
    })
  );

  const samples: FeedSourceSample[] = [];
  const perSourceStatus: Record<string, "ok" | "fail"> = {};
  for (let i = 0; i < sources.length; i++) {
    const r = results[i];
    perSourceStatus[sources[i]] = r ? "ok" : "fail";
    if (r) samples.push(r);
  }

  return {
    samples,
    attempted: sources.length,
    succeeded: samples.length,
    perSourceStatus,
    pollLatencyMs: Date.now() - t0
  };
};
