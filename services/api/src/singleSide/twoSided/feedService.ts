/**
 * FeedService — long-running poll loop that produces the canonical Atticus feed.
 *
 * Polls all 5 source fetchers every `pollPeriodMs` (default 1s), runs the
 * aggregator, caches the latest `AggregatedFeed`. Consumers (trigger detector,
 * activate handler) read the cached snapshot via `getCurrentFeed()` — they
 * don't block on network.
 *
 * Tracks per-source success counters for the last 60s window so /feed/health
 * can report degraded sources to the operator.
 *
 * Lifecycle:
 *   const svc = new FeedService();
 *   await svc.start();              // begins 1s polling
 *   svc.getCurrentFeed();           // synchronous cached read
 *   svc.getHealth();                // per-source success counts last 60s
 *   svc.stop();                     // graceful shutdown
 */

import { aggregateFeed, isFeedStale, type AggregatedFeed } from "./feedAggregator";
import { pollAllSources, type PollAllResult } from "./feedSources";

export type FeedServiceOpts = {
  pollPeriodMs?: number;
  /** Subset of sources to use; default all 5. */
  sources?: ReadonlyArray<"bullish" | "deribit" | "coinbase" | "binance" | "kraken">;
  /** Aggregator override knobs. */
  maxAgeMs?: number;
  maxDeviationPct?: number;
  /** Stale threshold for isFeedStale check. */
  staleHealthyMs?: number;
  staleDegradedMs?: number;
  /** Inject for tests instead of real network. */
  pollOverride?: (opts: { nowMs: number }) => Promise<PollAllResult>;
  /** Logger. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
};

export type FeedHealthSummary = {
  healthy: boolean;
  degraded: boolean;
  unavailable: boolean;
  lastAggregationMs: number | null;
  ageMs: number | null;
  health: "healthy" | "degraded" | "unavailable" | "uninitialized";
  perSourceLast60sSuccess: Record<string, { ok: number; fail: number; pct: number }>;
  totalPolls: number;
};

type PerSourceWindow = { okCount: number; failCount: number };

export class FeedService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentFeed: AggregatedFeed | null = null;
  private lastAggregationMs: number | null = null;
  private totalPolls = 0;
  /** Per-source rolling 60s buckets. Resets bucket each ~60s; cheap memory. */
  private perSourceWindow: Map<string, PerSourceWindow> = new Map();
  private windowStartedMs = Date.now();

  constructor(private readonly opts: FeedServiceOpts = {}) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.tick(); // immediate first poll so getCurrentFeed isn't null
    const period = this.opts.pollPeriodMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.tick().catch((e) =>
        this.log(`feed tick error: ${(e as Error).message}`, { error: String(e) })
      );
    }, period);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") (this.timer as { unref: () => void }).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrentFeed(): AggregatedFeed | null {
    return this.currentFeed;
  }

  getHealth(): FeedHealthSummary {
    const now = Date.now();
    const ageMs = this.lastAggregationMs ? now - this.lastAggregationMs : null;
    const perSourceLast60sSuccess: Record<string, { ok: number; fail: number; pct: number }> = {};
    for (const [source, bucket] of this.perSourceWindow.entries()) {
      const total = bucket.okCount + bucket.failCount;
      perSourceLast60sSuccess[source] = {
        ok: bucket.okCount,
        fail: bucket.failCount,
        pct: total === 0 ? 0 : bucket.okCount / total
      };
    }
    const health: FeedHealthSummary["health"] = this.currentFeed
      ? this.currentFeed.health
      : "uninitialized";
    return {
      healthy: health === "healthy",
      degraded: health === "degraded",
      unavailable: health === "unavailable",
      lastAggregationMs: this.lastAggregationMs,
      ageMs,
      health,
      perSourceLast60sSuccess,
      totalPolls: this.totalPolls
    };
  }

  /** Exposed for tests. */
  async tick(nowMsOverride?: number): Promise<{ aggregated: AggregatedFeed; pollResult: PollAllResult }> {
    const nowMs = nowMsOverride ?? Date.now();
    const pollResult = this.opts.pollOverride
      ? await this.opts.pollOverride({ nowMs })
      : await pollAllSources({ nowMs, sources: this.opts.sources });
    this.totalPolls++;

    // Update per-source 60s window — reset every ~60s
    if (nowMs - this.windowStartedMs > 60_000) {
      this.perSourceWindow.clear();
      this.windowStartedMs = nowMs;
    }
    for (const [source, status] of Object.entries(pollResult.perSourceStatus)) {
      const cur = this.perSourceWindow.get(source) ?? { okCount: 0, failCount: 0 };
      if (status === "ok") cur.okCount++;
      else cur.failCount++;
      this.perSourceWindow.set(source, cur);
    }

    const aggregated = aggregateFeed(pollResult.samples, {
      nowMs,
      maxAgeMs: this.opts.maxAgeMs,
      maxDeviationPct: this.opts.maxDeviationPct
    });
    if (aggregated.canonicalPrice != null) {
      this.currentFeed = aggregated;
      this.lastAggregationMs = nowMs;
    } else {
      // Keep previous feed but mark as stale for consumers — they apply isFeedStale check
      this.log(`feed aggregation produced no canonical price`, {
        attempted: pollResult.attempted,
        succeeded: pollResult.succeeded,
        rejected: aggregated.rejected.length,
        expired: aggregated.expired.length
      });
    }
    return { aggregated, pollResult };
  }

  /** True if current feed is older than the appropriate stale threshold. */
  isStale(nowMs?: number): boolean {
    const stale = this.currentFeed?.health === "degraded"
      ? (this.opts.staleDegradedMs ?? 2_000)
      : (this.opts.staleHealthyMs ?? 5_000);
    return isFeedStale(this.lastAggregationMs, nowMs ?? Date.now(), stale);
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.opts.log ?? ((m, _meta) => console.log(`[feedService] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}
