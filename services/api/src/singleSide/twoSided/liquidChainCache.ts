/**
 * Liquid chain cache — wraps the Deribit `fetchFullChainSnapshot` with TTL
 * caching so the production quote engine can pick liquid strikes without
 * doing a fresh chain pull on every activation.
 *
 * Refresh interval: 30s by default. Activations within the window reuse the
 * cached snapshot. After TTL, next request triggers refresh.
 *
 * Implements a passive-refresh model: no background timer (so tests don't
 * leak handles); refresh happens on-demand when getChain() is called and
 * cache is stale.
 */

import { fetchFullChainSnapshot, mergeChainSnapshots, pickLiquidStrike, type DeribitQuote, DEFAULT_PICKER_CONFIG } from "../../../scripts/backtest/singleSide/liquidStrikePicker";

export type LiquidChainSnapshot = {
  fetchedAtMs: number;
  spot: number;
  quotes: DeribitQuote[];
  /** Per-venue fetch outcomes for observability. */
  venueStatus: Record<string, { ok: boolean; quoteCount: number; error?: string }>;
};

/**
 * Provider for a single venue's chain snapshot.
 * Production: one for Deribit (using fetchFullChainSnapshot), one for Bullish
 * (using fetchBullishChainSnapshot). The cache merges all configured providers
 * on each refresh.
 */
export type VenueChainProvider = {
  venue: "deribit" | "bullish";
  fetch: () => Promise<{ spot: number; quotes: DeribitQuote[] }>;
};

export type LiquidChainCacheConfig = {
  /** TTL in ms after which getChain triggers refresh. Default 30s. */
  ttlMs: number;
  /** Fail-open: if fetch errors, keep returning the stale snapshot up to this age. Default 5 min. */
  staleMaxAgeMs: number;
  /** Deribit-only override fetcher (back-compat for tests). */
  fetcher?: () => Promise<{ spot: number; quotes: DeribitQuote[] }>;
  /** Venue providers — production should pass [deribit, bullish] here. */
  providers?: VenueChainProvider[];
};

export const DEFAULT_LIQUID_CHAIN_CACHE_CONFIG: LiquidChainCacheConfig = {
  // Bumped from 30s → 120s. With multiple consumers (cell-costs endpoint,
  // every activation, scheduled probe, VolumeCover chain warmer) all
  // triggering Bullish chain refreshes, 30s × ~30 orderbook calls per refresh
  // exceeded Bullish's ~10 req/sec rate limit (errorCode 96100). 120s aligns
  // with the existing BullishTradingClient.getMarkets cache TTL and gives
  // ~4 refreshes/min worth of headroom across all callers.
  ttlMs: 120_000,
  staleMaxAgeMs: 10 * 60_000
};

export class LiquidChainCache {
  private snapshot: LiquidChainSnapshot | null = null;
  private inflightFetch: Promise<LiquidChainSnapshot | null> | null = null;
  private readonly config: LiquidChainCacheConfig;

  constructor(config: Partial<LiquidChainCacheConfig> = {}) {
    this.config = { ...DEFAULT_LIQUID_CHAIN_CACHE_CONFIG, ...config };
  }

  /** Returns the cached snapshot if fresh; else triggers refresh and returns latest. */
  async getChain(nowMs = Date.now()): Promise<LiquidChainSnapshot | null> {
    // Fresh enough? Return as-is
    if (this.snapshot && nowMs - this.snapshot.fetchedAtMs < this.config.ttlMs) {
      return this.snapshot;
    }
    // Already refreshing? Wait for it
    if (this.inflightFetch) return this.inflightFetch;
    // Trigger refresh
    this.inflightFetch = this.refresh(nowMs).finally(() => { this.inflightFetch = null; });
    return this.inflightFetch;
  }

  /** Force-refresh (e.g., after halt clear). */
  async refresh(nowMs = Date.now()): Promise<LiquidChainSnapshot | null> {
    try {
      // Path 1: providers list (production). Run all, merge, record per-venue status.
      if (this.config.providers && this.config.providers.length > 0) {
        const venueStatus: Record<string, { ok: boolean; quoteCount: number; error?: string }> = {};
        const results = await Promise.all(
          this.config.providers.map(async (p) => {
            try {
              const r = await p.fetch();
              venueStatus[p.venue] = { ok: true, quoteCount: r.quotes.length };
              return r;
            } catch (e) {
              venueStatus[p.venue] = { ok: false, quoteCount: 0, error: (e as Error).message };
              return null;
            }
          })
        );
        const merged = mergeChainSnapshots(results);
        if (merged.quotes.length > 0 || merged.spot > 0) {
          this.snapshot = { fetchedAtMs: nowMs, spot: merged.spot, quotes: merged.quotes, venueStatus };
          return this.snapshot;
        }
        // All providers failed — fall through to stale-fallback
        throw new Error(`all venues failed: ${JSON.stringify(venueStatus)}`);
      }
      // Path 2: single-fetcher (back-compat for tests + Deribit-only mode).
      const fetcher = this.config.fetcher ?? (() => fetchFullChainSnapshot(nowMs));
      const { spot, quotes } = await fetcher();
      this.snapshot = {
        fetchedAtMs: nowMs,
        spot,
        quotes,
        venueStatus: { deribit: { ok: true, quoteCount: quotes.length } }
      };
      return this.snapshot;
    } catch (e) {
      // Fail-open: if we have a non-too-stale snapshot, return it
      if (this.snapshot && nowMs - this.snapshot.fetchedAtMs < this.config.staleMaxAgeMs) {
        return this.snapshot;
      }
      return null;
    }
  }

  /** For tests / introspection. */
  getCached(): LiquidChainSnapshot | null { return this.snapshot; }

  /**
   * EXACT instrument bid lookup — the right tool for valuing a position
   * we actually hold (the only thing we can sell is what we bought).
   *
   * Returns the live bid for the SPECIFIC instrument symbol we own (e.g.
   * "BTC-1JUN26-73000-P"). If the snapshot does not contain that exact
   * symbol — or contains it but with zero bid (no resting buyer) — this
   * returns null and the caller must decide how to fall back.
   *
   * Why this matters:
   *   getBidForLeg() uses fuzzy tenor matching with a higher-bid tiebreaker.
   *   That helps with strike-only lookups but produces WRONG numbers when
   *   we need to value a specific holding: a 2.54-day option's bid is NOT
   *   a valid proxy for our 1.54-day option, even though both share strike.
   *   Same-strike different-expiry are different products.
   */
  getBidForSymbol(opts: {
    venue: "deribit" | "bullish";
    instrumentSymbol: string;
  }): {
    bidUsdcPerBtc: number;
    askUsdcPerBtc: number;
    midUsdcPerBtc: number;
    spreadPct: number;
    venue: "deribit" | "bullish";
    instrumentName: string;
    tenorHours: number;
    markIv: number;
    pulledAtMs: number;
  } | null {
    if (!this.snapshot) return null;
    const match = this.snapshot.quotes.find(
      (q) =>
        q.venue === opts.venue &&
        q.instrument_name === opts.instrumentSymbol &&
        q.bidUsdcPerBtc > 0
    );
    if (!match) return null;
    return {
      bidUsdcPerBtc: match.bidUsdcPerBtc,
      askUsdcPerBtc: match.askUsdcPerBtc,
      midUsdcPerBtc: match.midUsdcPerBtc,
      spreadPct: match.spreadPct,
      venue: match.venue,
      instrumentName: match.instrument_name,
      tenorHours: match.tenorHours,
      markIv: match.markIv,
      pulledAtMs: this.snapshot.fetchedAtMs
    };
  }

  /**
   * Look up the BID price for a strike+tenor combination (proxy lookup).
   * Used when the caller does NOT have a specific instrument symbol —
   * e.g. estimating realizable salvage for a hypothetical position, or
   * pricing a cell quote.
   *
   * For valuing positions we actually hold, prefer getBidForSymbol().
   *
   * Sort order (post-tightening):
   *   1. Prefer venue match
   *   2. Strictly closest tenor (no bid-based tiebreaker — that produces
   *      WRONG values because different-expiry options are different products)
   *   3. If venue match has zero or no bid, fall through to cross-venue
   *      closest-tenor (consumer should be aware this is a proxy)
   */
  getBidForLeg(opts: {
    strike: number;
    optType: "put" | "call";
    tenorRemainingHours: number;
    preferVenue?: "deribit" | "bullish";
    /** Max tenor drift in hours (default 36 = ±1.5 days). */
    maxTenorDriftHours?: number;
  }): {
    bidUsdcPerBtc: number;
    askUsdcPerBtc: number;
    midUsdcPerBtc: number;
    spreadPct: number;
    venue: "deribit" | "bullish";
    instrumentName: string;
    tenorHours: number;
    markIv: number;
    pulledAtMs: number;
  } | null {
    if (!this.snapshot) return null;
    const maxDrift = opts.maxTenorDriftHours ?? 36;
    const candidates = this.snapshot.quotes.filter(
      (q) =>
        q.strike === opts.strike &&
        q.optType === opts.optType &&
        Math.abs(q.tenorHours - opts.tenorRemainingHours) <= maxDrift &&
        q.bidUsdcPerBtc > 0
    );
    if (candidates.length === 0) return null;
    // Tightened sort: venue preference, then STRICTLY closest tenor. NO
    // bid-based tiebreaker (different-expiry quotes are different products
    // and the higher-bid one is typically the longer-dated option, which
    // overstates value for our actual shorter-dated holding).
    candidates.sort((a, b) => {
      if (opts.preferVenue) {
        if (a.venue === opts.preferVenue && b.venue !== opts.preferVenue) return -1;
        if (b.venue === opts.preferVenue && a.venue !== opts.preferVenue) return 1;
      }
      const aDrift = Math.abs(a.tenorHours - opts.tenorRemainingHours);
      const bDrift = Math.abs(b.tenorHours - opts.tenorRemainingHours);
      if (aDrift !== bDrift) return aDrift - bDrift;
      // True tie (same drift, e.g. same expiry across venues): prefer
      // tighter spread = better execution quality.
      return a.spreadPct - b.spreadPct;
    });
    const best = candidates[0];
    return {
      bidUsdcPerBtc: best.bidUsdcPerBtc,
      askUsdcPerBtc: best.askUsdcPerBtc,
      midUsdcPerBtc: best.midUsdcPerBtc,
      spreadPct: best.spreadPct,
      venue: best.venue,
      instrumentName: best.instrument_name,
      tenorHours: best.tenorHours,
      markIv: best.markIv,
      pulledAtMs: this.snapshot.fetchedAtMs
    };
  }
}

/**
 * Given a target strike + type + tenor, returns the liquid-picked instrument's
 * (strike, type, ask) for use by quoteEngine. Falls back to target strike if
 * no liquid pick is available.
 */
export type LiquidPickResult = {
  /** Strike actually picked (may differ from target). */
  pickedStrike: number;
  /** Was this strike shifted from target? */
  shifted: boolean;
  /** Venue instrument name we'd trade. null if no pick. */
  instrumentName: string | null;
  /** Venue ("deribit" or "bullish") that won the pick. */
  venue: "deribit" | "bullish" | null;
  /** Live ask in USDC per BTC for the picked instrument. null if no pick. */
  askUsdcPerBtc: number | null;
  /** Live bid-ask spread % for the picked instrument. */
  spreadPct: number | null;
};

export const pickLiquidForLeg = async (
  cache: LiquidChainCache,
  targetStrike: number,
  optType: "put" | "call",
  tenorDays: number,
  spot: number,
  nowMs = Date.now()
): Promise<LiquidPickResult> => {
  const chain = await cache.getChain(nowMs);
  if (!chain) {
    return { pickedStrike: targetStrike, shifted: false, instrumentName: null, venue: null, askUsdcPerBtc: null, spreadPct: null };
  }
  const result = pickLiquidStrike(chain.quotes, targetStrike, tenorDays, optType, spot, DEFAULT_PICKER_CONFIG);
  if (!result.picked) {
    return { pickedStrike: targetStrike, shifted: false, instrumentName: null, venue: null, askUsdcPerBtc: null, spreadPct: null };
  }
  return {
    pickedStrike: result.picked.strike,
    shifted: result.picked.strike !== targetStrike,
    instrumentName: result.picked.instrument_name,
    venue: result.picked.venue,
    askUsdcPerBtc: result.picked.askUsdcPerBtc,
    spreadPct: result.picked.spreadPct
  };
};
