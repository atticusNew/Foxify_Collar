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

import { fetchFullChainSnapshot, pickLiquidStrike, type DeribitQuote, DEFAULT_PICKER_CONFIG } from "../../../scripts/backtest/singleSide/liquidStrikePicker";

export type LiquidChainSnapshot = {
  fetchedAtMs: number;
  spot: number;
  quotes: DeribitQuote[];
};

export type LiquidChainCacheConfig = {
  /** TTL in ms after which getChain triggers refresh. Default 30s. */
  ttlMs: number;
  /** Fail-open: if fetch errors, keep returning the stale snapshot up to this age. Default 5 min. */
  staleMaxAgeMs: number;
  /** Override the chain fetcher (for tests). */
  fetcher?: () => Promise<{ spot: number; quotes: DeribitQuote[] }>;
};

export const DEFAULT_LIQUID_CHAIN_CACHE_CONFIG: LiquidChainCacheConfig = {
  ttlMs: 30_000,
  staleMaxAgeMs: 5 * 60_000
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
      const fetcher = this.config.fetcher ?? (() => fetchFullChainSnapshot(nowMs));
      const { spot, quotes } = await fetcher();
      this.snapshot = { fetchedAtMs: nowMs, spot, quotes };
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
  /** Deribit instrument name we'd trade. null if no pick. */
  instrumentName: string | null;
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
    return { pickedStrike: targetStrike, shifted: false, instrumentName: null, askUsdcPerBtc: null, spreadPct: null };
  }
  const result = pickLiquidStrike(chain.quotes, targetStrike, tenorDays, optType, spot, DEFAULT_PICKER_CONFIG);
  if (!result.picked) {
    return { pickedStrike: targetStrike, shifted: false, instrumentName: null, askUsdcPerBtc: null, spreadPct: null };
  }
  return {
    pickedStrike: result.picked.strike,
    shifted: result.picked.strike !== targetStrike,
    instrumentName: result.picked.instrument_name,
    askUsdcPerBtc: result.picked.askUsdcPerBtc,
    spreadPct: result.picked.spreadPct
  };
};
