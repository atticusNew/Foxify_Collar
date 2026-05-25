/**
 * VC spot price source — pluggable primary (Bullish or Deribit) +
 * Coinbase fallback.
 *
 * 2026-05-19 update: Source-of-truth follows execution venue. When
 * the system is locked to Deribit execution (VOLUME_COVER_VENUE_ROUTING_JSON
 * pointing to deribit), set VC_SPOT_PRIMARY=deribit so trigger
 * detection and hedge math reference the same venue's index.
 *
 * Source preference (in order):
 *   1. VC_SPOT_PRIMARY=deribit  → Deribit BTC index_price (live or testnet)
 *   2. VC_SPOT_PRIMARY=bullish  → Bullish hybrid orderbook mid (default if
 *                                  bullishOrderbookFn passed)
 *   3. Coinbase REST            → universal fallback
 *
 * Whichever venues respond contribute to drift detection (> 50bp
 * triggers an operator warning). All sources fall back gracefully.
 *
 * Cache: 2s TTL on the resolved source.
 */

import Decimal from "decimal.js";
import { resolvePriceSnapshot } from "../pilot/price";
import type { SpotPriceSource } from "./triggerDetector";

const DEFAULT_CACHE_TTL_MS = 2_000;
const BULLISH_TIMEOUT_MS = 3_000;
const DRIFT_THRESHOLD_BP = 50; // 0.50% — log warning above this

let cached: { spotBtcPrice: number; asOfMs: number; source: string } | null = null;

export type SpotPriceSourceOptions = {
  marketId?: string;
  primaryUrl?: string;
  primaryTimeoutMs?: number;
  freshnessMaxMs?: number;
  cacheTtlMs?: number;
  /**
   * Optional Bullish hybrid orderbook fetcher. When provided, used as
   * primary source. Pass null/undefined to fall back to Coinbase-only
   * (legacy behavior).
   */
  bullishOrderbookFn?: (symbol: string) => Promise<{
    bids: Array<{ price: string }>;
    asks: Array<{ price: string }>;
  }>;
  /** Bullish symbol (default BTCUSDC). */
  bullishSymbol?: string;
  /**
   * Optional Deribit index fetcher. When provided AND
   * VC_SPOT_PRIMARY=deribit, used as primary source. The function
   * should return Deribit's BTC USD index price (the same one used
   * for option settlement on Deribit).
   */
  deribitIndexFn?: () => Promise<{ price: number; asOfMs: number } | null>;
};

/**
 * Pull Bullish hybrid orderbook + compute mid price. Returns null on
 * any error or empty book (caller falls back to Coinbase).
 */
const tryBullishMid = async (
  fn: NonNullable<SpotPriceSourceOptions["bullishOrderbookFn"]>,
  symbol: string
): Promise<{ price: number; asOfMs: number } | null> => {
  try {
    const book = await Promise.race([
      fn(symbol),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("bullish_timeout")), BULLISH_TIMEOUT_MS)
      )
    ]);
    const topBid = book.bids?.[0]?.price;
    const topAsk = book.asks?.[0]?.price;
    if (!topBid || !topAsk) return null;
    const bid = Number(topBid);
    const ask = Number(topAsk);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return { price: (bid + ask) / 2, asOfMs: Date.now() };
  } catch {
    return null;
  }
};

const tryCoinbase = async (opts: SpotPriceSourceOptions): Promise<{ price: number; asOfMs: number } | null> => {
  try {
    const config = {
      primaryUrl: opts.primaryUrl ?? "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      primaryTimeoutMs: opts.primaryTimeoutMs ?? 3_000,
      freshnessMaxMs: opts.freshnessMaxMs ?? 60_000,
      requestRetryAttempts: 2,
      requestRetryDelayMs: 120,
      fallbackUrl: undefined as any,
      fallbackTimeoutMs: 3_000,
      maxAgeForFallbackMs: 60_000
    } as any;

    const snapshot = await resolvePriceSnapshot(config, {
      marketId: opts.marketId ?? "BTC-USD",
      now: new Date(),
      endpointVersion: "vc-spot",
      requestId: `vc-${Date.now()}`
    } as any);

    return {
      price: (snapshot.price as Decimal).toNumber(),
      asOfMs: new Date(snapshot.priceTimestamp).getTime()
    };
  } catch {
    return null;
  }
};

let lastDriftWarnAtMs = 0;
const DRIFT_WARN_COOLDOWN_MS = 60_000;

const tryDeribitIndex = async (
  fn: NonNullable<SpotPriceSourceOptions["deribitIndexFn"]>
): Promise<{ price: number; asOfMs: number } | null> => {
  try {
    const r = await fn();
    if (!r || !Number.isFinite(r.price) || r.price <= 0) return null;
    return r;
  } catch {
    return null;
  }
};

export const createSpotPriceSource = (opts: SpotPriceSourceOptions = {}): SpotPriceSource => {
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const bullishSymbol = opts.bullishSymbol ?? "BTCUSDC";
  const primaryPref = (process.env.VC_SPOT_PRIMARY ?? "").toLowerCase().trim();
  return async () => {
    if (cached && Date.now() - cached.asOfMs < cacheTtl) {
      return { ...cached };
    }

    // Fetch all available venues in parallel for drift detection.
    const [bullishResult, coinbaseResult, deribitResult] = await Promise.all([
      opts.bullishOrderbookFn ? tryBullishMid(opts.bullishOrderbookFn, bullishSymbol) : Promise.resolve(null),
      tryCoinbase(opts),
      opts.deribitIndexFn ? tryDeribitIndex(opts.deribitIndexFn) : Promise.resolve(null)
    ]);

    // Drift detection across whatever pair of venues responded
    const pairs: Array<[string, { price: number }]> = [];
    if (bullishResult) pairs.push(["bullish", bullishResult]);
    if (deribitResult) pairs.push(["deribit", deribitResult]);
    if (coinbaseResult) pairs.push(["coinbase", coinbaseResult]);
    for (let i = 0; i < pairs.length - 1; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [an, a] = pairs[i];
        const [bn, b] = pairs[j];
        const driftBp =
          Math.abs(a.price - b.price) / Math.min(a.price, b.price) * 10_000;
        if (driftBp > DRIFT_THRESHOLD_BP) {
          const now = Date.now();
          if (now - lastDriftWarnAtMs > DRIFT_WARN_COOLDOWN_MS) {
            console.warn(
              `[volumeCover/spot] DRIFT WARNING: ${an}=$${a.price.toFixed(2)} vs ${bn}=$${b.price.toFixed(2)} drift=${driftBp.toFixed(0)}bp (>${DRIFT_THRESHOLD_BP}bp threshold). ` +
                `Possible: oracle break, venue stale, or genuine dislocation. Operator review recommended.`
            );
            lastDriftWarnAtMs = now;
          }
        }
      }
    }

    // Source preference: VC_SPOT_PRIMARY=deribit elevates Deribit to
    // primary so trigger detection references the same venue we
    // execute hedges on. Otherwise default to Bullish primary
    // (legacy). Coinbase is always the final fallback.
    let result: { price: number; asOfMs: number; source: string } | null = null;
    if (primaryPref === "deribit" && deribitResult) {
      result = {
        price: deribitResult.price,
        asOfMs: deribitResult.asOfMs,
        source: "deribit_index"
      };
    } else if (bullishResult) {
      result = {
        price: bullishResult.price,
        asOfMs: bullishResult.asOfMs,
        source: "bullish_hybrid"
      };
    } else if (deribitResult) {
      result = {
        price: deribitResult.price,
        asOfMs: deribitResult.asOfMs,
        source: "deribit_index"
      };
    } else if (coinbaseResult) {
      result = {
        price: coinbaseResult.price,
        asOfMs: coinbaseResult.asOfMs,
        source: "coinbase_fallback"
      };
    }

    if (!result) {
      throw new Error("vc_spot_source_unavailable: both Bullish and Coinbase fetch failed");
    }

    cached = {
      spotBtcPrice: result.price,
      asOfMs: result.asOfMs,
      source: result.source
    };
    return { ...cached };
  };
};

/**
 * For dev/testing — fixed mock spot.
 */
export const createMockSpotPriceSource = (price: number): SpotPriceSource => {
  return async () => ({
    spotBtcPrice: price,
    asOfMs: Date.now(),
    source: "mock"
  });
};

/**
 * Test reset.
 */
export const __resetSpotPriceSourceCache = (): void => {
  cached = null;
  lastDriftWarnAtMs = 0;
};
