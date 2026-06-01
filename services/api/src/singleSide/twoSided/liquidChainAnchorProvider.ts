/**
 * Adapter: expose a LiquidChainCache as a LiveAnchorProvider.
 *
 * The cache already pulls Bullish + Deribit chain quotes. Translating that
 * into the {bullish, deribit} anchor format expected by quoteEngine.buildQuote
 * lets us reuse the cache for both:
 *   1. Liquid strike refinement (via pickLiquidForLeg)
 *   2. Per-leg anchor fetch for pickLegVenue routing
 *
 * Without this adapter we'd need two separate chain pulls per activation.
 * With it, the cache serves both.
 *
 * Depth limitation: book_summary doesn't expose depth-within-2%. We default
 * to 999 (effectively unlimited). The LiveStrangleExecutor's IOC orders
 * fail-safe if depth is actually insufficient at execution time.
 */

import type { LiquidChainCache } from "./liquidChainCache";
import type { LiveAnchorProvider, LegAnchorQuote } from "./quoteEngine";

const DEFAULT_DEPTH_BTC = 999; // see header note

export const liquidChainAnchorProvider = (cache: LiquidChainCache): LiveAnchorProvider => ({
  getAnchorForLeg: async (strike: number, optType: "put" | "call", tenorDays: number): Promise<{ bullish: LegAnchorQuote | null; deribit: LegAnchorQuote | null }> => {
    const chain = await cache.getChain();
    if (!chain) return { bullish: null, deribit: null };
    const targetHours = tenorDays * 24;
    const pulledAt = new Date(chain.fetchedAtMs).toISOString();

    // Find best (closest-tenor) quote per venue at this exact strike + type
    let bullishBest: typeof chain.quotes[number] | null = null;
    let deribitBest: typeof chain.quotes[number] | null = null;
    for (const q of chain.quotes) {
      if (q.strike !== strike) continue;
      if (q.optType !== optType) continue;
      // Allow ±36h tenor drift (covers 1d → 1.5d edge cases without picking weekly expiries)
      if (Math.abs(q.tenorHours - targetHours) > 36) continue;
      if (q.venue === "bullish") {
        if (!bullishBest || Math.abs(q.tenorHours - targetHours) < Math.abs(bullishBest.tenorHours - targetHours)) {
          bullishBest = q;
        }
      } else if (q.venue === "deribit") {
        if (!deribitBest || Math.abs(q.tenorHours - targetHours) < Math.abs(deribitBest.tenorHours - targetHours)) {
          deribitBest = q;
        }
      }
    }

    const toAnchor = (q: typeof chain.quotes[number] | null, venue: "bullish" | "deribit"): LegAnchorQuote | null => {
      if (!q) return null;
      return {
        venue,
        symbol: q.instrument_name,
        askUsdcPerBtc: q.askUsdcPerBtc,
        // Carry the bid so pickLegVenue can rank by ROUND-TRIP cost (buy ask →
        // sell bid) — critical for venues with wide spreads (e.g. Bullish ~25%
        // vs Deribit ~6%): a competitive ask alone is not best execution.
        bidUsdcPerBtc: q.bidUsdcPerBtc,
        depthWithin2pctBtc: DEFAULT_DEPTH_BTC,
        pulledAt
      };
    };

    return {
      bullish: toAnchor(bullishBest, "bullish"),
      deribit: toAnchor(deribitBest, "deribit")
    };
  }
});
