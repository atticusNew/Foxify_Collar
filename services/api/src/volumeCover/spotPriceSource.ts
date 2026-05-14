/**
 * Spot price source — provides current BTC/USD spot to trigger detector
 * and Foxify quote/activate entry-price drift checks.
 *
 * Uses the existing pilot price chain (Coinbase reference + fallback)
 * via resolvePriceSnapshot. Cached for short TTL to avoid hammering
 * the upstream on every trigger detector cycle.
 */

import Decimal from "decimal.js";
import { resolvePriceSnapshot } from "../pilot/price";
import type { SpotPriceSource } from "./triggerDetector";

const DEFAULT_CACHE_TTL_MS = 2_000;

let cached: { spotBtcPrice: number; asOfMs: number; source: string } | null = null;

export type SpotPriceSourceOptions = {
  marketId?: string;
  /** Coinbase or other reference URL */
  primaryUrl?: string;
  primaryTimeoutMs?: number;
  freshnessMaxMs?: number;
  cacheTtlMs?: number;
};

export const createSpotPriceSource = (opts: SpotPriceSourceOptions = {}): SpotPriceSource => {
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  return async () => {
    if (cached && Date.now() - cached.asOfMs < cacheTtl) {
      return { ...cached };
    }
    const config = {
      primaryUrl:
        opts.primaryUrl ?? "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      primaryTimeoutMs: opts.primaryTimeoutMs ?? 3000,
      freshnessMaxMs: opts.freshnessMaxMs ?? 60_000,
      requestRetryAttempts: 2,
      requestRetryDelayMs: 120,
      // Some shapes of resolvePriceSnapshot require these — set safe defaults
      fallbackUrl: undefined as any,
      fallbackTimeoutMs: 3000,
      maxAgeForFallbackMs: 60_000
    } as any;

    const snapshot = await resolvePriceSnapshot(config, {
      marketId: opts.marketId ?? "BTC-USD",
      now: new Date(),
      endpointVersion: "vc-spot",
      requestId: `vc-${Date.now()}`
    } as any);

    const price = (snapshot.price as Decimal).toNumber();
    cached = {
      spotBtcPrice: price,
      asOfMs: new Date(snapshot.priceTimestamp).getTime(),
      source: snapshot.priceSource ?? "reference_oracle"
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
};
