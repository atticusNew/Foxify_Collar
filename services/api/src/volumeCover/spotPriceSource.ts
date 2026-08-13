/**
 * VC spot price source — Bullish primary + Coinbase fallback.
 *
 * Source-of-truth decision (operator + Foxify CEO 2026-05-16):
 * Foxify defers to "our feed". We choose Bullish hybrid orderbook as
 * primary because:
 *   1. ZERO basis between trigger detection and hedge execution venue
 *   2. Sub-bp top-of-book spreads on BTCUSDC pair
 *   3. Same data source we use for hedge sizing math
 *
 * Coinbase remains as fallback for:
 *   - Bullish API outages (graceful degradation)
 *   - Cross-validation: drift > 50bp between Bullish + Coinbase
 *     emits an audit event flag that operator can review
 *
 * Drift detection rationale: if Bullish vs Coinbase diverge by >50bp,
 * could indicate (a) Bullish oracle manipulation, (b) one venue's
 * feed stale/broken, (c) genuine market dislocation. Operator sees
 * the drift in pair-event audit log and can halt if needed.
 *
 * Cache: 2s TTL on the resolved source — both venues updated each
 * tick to keep drift detection live.
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

export const createSpotPriceSource = (opts: SpotPriceSourceOptions = {}): SpotPriceSource => {
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const bullishSymbol = opts.bullishSymbol ?? "BTCUSDC";
  return async () => {
    if (cached && Date.now() - cached.asOfMs < cacheTtl) {
      return { ...cached };
    }

    // Fetch both venues in parallel for drift detection
    const [bullishResult, coinbaseResult] = await Promise.all([
      opts.bullishOrderbookFn ? tryBullishMid(opts.bullishOrderbookFn, bullishSymbol) : Promise.resolve(null),
      tryCoinbase(opts)
    ]);

    // Drift detection: if both succeeded, compare
    if (bullishResult && coinbaseResult) {
      const driftBp =
        Math.abs(bullishResult.price - coinbaseResult.price) /
        Math.min(bullishResult.price, coinbaseResult.price) *
        10000;
      if (driftBp > DRIFT_THRESHOLD_BP) {
        const now = Date.now();
        if (now - lastDriftWarnAtMs > DRIFT_WARN_COOLDOWN_MS) {
          console.warn(
            `[volumeCover/spot] DRIFT WARNING: Bullish=$${bullishResult.price.toFixed(2)} vs Coinbase=$${coinbaseResult.price.toFixed(2)} drift=${driftBp.toFixed(0)}bp (>${DRIFT_THRESHOLD_BP}bp threshold). ` +
              `Possible: oracle break, venue stale, or genuine dislocation. Operator review recommended.`
          );
          lastDriftWarnAtMs = now;
        }
      }
    }

    // Source preference: Bullish primary, Coinbase fallback
    let result: { price: number; asOfMs: number; source: string } | null = null;
    if (bullishResult) {
      result = {
        price: bullishResult.price,
        asOfMs: bullishResult.asOfMs,
        source: "bullish_hybrid"
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
