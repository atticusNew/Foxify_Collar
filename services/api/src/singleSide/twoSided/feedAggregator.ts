/**
 * Canonical Atticus feed aggregator (TRIGGER_SOURCE_AND_FEED_SPEC.md §3).
 *
 * Pure function — does NOT do any network I/O. Sources are provided as input
 * snapshots (FeedSourceSample[]). The aggregator:
 *   1. Drops samples older than maxAgeMs (default 1500ms) from now.
 *   2. Computes a tentative median of surviving samples.
 *   3. Rejects samples deviating >maxDeviationPct (default 0.5%) from tentative median.
 *   4. Re-medians the survivors as the canonical price.
 *   5. Returns audit object including median calc, rejected sources, degraded/unavailable flags.
 *
 * Health states:
 *   - healthy:    >=3 sources surviving
 *   - degraded:   2 sources surviving (faster source_stale SLA recommended)
 *   - unavailable: 0 or 1 sources surviving → trigger detector should halt
 */

export type FeedSourceSample = {
  source: string;     // "bullish" | "deribit" | "coinbase" | "binance" | "kraken" | (test names)
  price: number;
  ts: number;         // epoch ms
};

export type AggregatedFeed = {
  canonicalPrice: number | null;
  asOfMs: number;
  sources: FeedSourceSample[];          // surviving (used in median)
  rejected: Array<{ source: string; price: number; ts: number; reason: string; deviationPct?: number }>;
  expired: Array<{ source: string; ts: number; ageMs: number }>;
  health: "healthy" | "degraded" | "unavailable";
  medianCalcDescription: string;
};

export type AggregateOptions = {
  nowMs?: number;
  maxAgeMs?: number;        // sample older than this → expired
  maxDeviationPct?: number; // sample further than this from tentative median → rejected
  minSourcesHealthy?: number;
  minSourcesDegraded?: number;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const aggregateFeed = (
  samples: FeedSourceSample[],
  opts: AggregateOptions = {}
): AggregatedFeed => {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 1500;
  const maxDeviationPct = opts.maxDeviationPct ?? 0.005; // 0.5%
  const minHealthy = opts.minSourcesHealthy ?? 3;
  const minDegraded = opts.minSourcesDegraded ?? 2;

  // 1. Drop expired samples
  const fresh: FeedSourceSample[] = [];
  const expired: AggregatedFeed["expired"] = [];
  for (const s of samples) {
    const age = nowMs - s.ts;
    if (age > maxAgeMs) {
      expired.push({ source: s.source, ts: s.ts, ageMs: age });
    } else if (Number.isFinite(s.price) && s.price > 0) {
      fresh.push(s);
    } else {
      expired.push({ source: s.source, ts: s.ts, ageMs: age });
    }
  }

  if (fresh.length === 0) {
    return {
      canonicalPrice: null,
      asOfMs: nowMs,
      sources: [],
      rejected: [],
      expired,
      health: "unavailable",
      medianCalcDescription: "no fresh samples"
    };
  }

  // 2. Tentative median across all fresh
  const tentative = median(fresh.map((s) => s.price));
  // 3. Reject deviators (deviation against tentative median)
  const survivors: FeedSourceSample[] = [];
  const rejected: AggregatedFeed["rejected"] = [];
  for (const s of fresh) {
    const dev = Math.abs(s.price - tentative) / tentative;
    if (dev > maxDeviationPct) {
      rejected.push({
        source: s.source,
        price: s.price,
        ts: s.ts,
        deviationPct: dev,
        reason: `deviation ${(dev * 100).toFixed(3)}% > ${(maxDeviationPct * 100).toFixed(2)}% from tentative median ${tentative.toFixed(2)}`
      });
    } else {
      survivors.push(s);
    }
  }

  if (survivors.length === 0) {
    return {
      canonicalPrice: null,
      asOfMs: nowMs,
      sources: [],
      rejected,
      expired,
      health: "unavailable",
      medianCalcDescription: "no survivors after deviation filter"
    };
  }

  const canonicalPrice = median(survivors.map((s) => s.price));
  const health: AggregatedFeed["health"] =
    survivors.length >= minHealthy ? "healthy" : survivors.length >= minDegraded ? "degraded" : "unavailable";

  const sortedPxs = [...survivors.map((s) => s.price)].sort((a, b) => a - b);
  const desc = `median(${sortedPxs.map((p) => p.toFixed(2)).join(", ")}) = ${canonicalPrice.toFixed(2)}`;

  return {
    canonicalPrice,
    asOfMs: nowMs,
    sources: survivors,
    rejected,
    expired,
    health,
    medianCalcDescription: desc
  };
};

/**
 * Source-stale check: combines the canonical feed value with the most-recent
 * aggregation time. Returns true if no successful aggregation in the last
 * `sourceStaleMs` (default 5000 in healthy mode, 2000 in degraded).
 */
export const isFeedStale = (
  lastSuccessfulAggregationMs: number | null,
  nowMs: number,
  sourceStaleMs = 5_000
): boolean => {
  if (lastSuccessfulAggregationMs == null) return true;
  return nowMs - lastSuccessfulAggregationMs > sourceStaleMs;
};
