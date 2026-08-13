/**
 * WS#1 (Bundle C cutover, rev 6) — Multi-venue routing decision module.
 *
 * Decides which venue (Bullish or Deribit) handles a given quote/activate
 * based on the live findings from docs/foxify-pilot-bundle-c/04_BULLISH_VS_DERIBIT_LIVE_COMPARISON.md:
 *
 *   2% protection: Bullish primary (pricing within 1-4%, good ATM strikes)
 *   3% protection: Bullish primary (mixed pricing but workable)
 *   5% protection: Deribit primary (Bullish strike grid sparse)
 *   7% protection: Deribit primary (Bullish 1-DTE has no strikes; 1-week ok)
 *   10% protection: Deribit primary (Bullish has zero strikes for 10%)
 *
 * Dynamic fallback: at quote time, if the primary venue's ask price
 * is materially worse than the fallback (>= 30% delta), switch. This
 * catches cases where the primary has a stale or thin orderbook.
 *
 * All routing decisions are env-tunable via PILOT_VENUE_ROUTING_JSON
 * for operator override without code change.
 */

import type { V7SlTier } from "./types";

export type VenueChoice = "bullish" | "deribit";

export type VenueRoutingDecision = {
  primary: VenueChoice;
  fallback: VenueChoice | null;
  reason: string;
  /** Maximum drift the primary's ask can be over fallback before forcing fallback. */
  fallbackDriftThresholdPct: number;
};

const DEFAULT_ROUTING: Record<V7SlTier, VenueRoutingDecision> = {
  1:  { primary: "deribit", fallback: null,      reason: "1% unlaunched; Deribit has historical strike data", fallbackDriftThresholdPct: 0.30 },
  2:  { primary: "bullish", fallback: "deribit", reason: "Bullish 2% pricing within 1-4% of Deribit + tighter ATM grid", fallbackDriftThresholdPct: 0.30 },
  3:  { primary: "bullish", fallback: "deribit", reason: "Bullish 3% workable; fall back to Deribit when grid alignment poor", fallbackDriftThresholdPct: 0.30 },
  5:  { primary: "deribit", fallback: "bullish", reason: "Bullish 5% strikes too far from trigger; Deribit primary", fallbackDriftThresholdPct: 0.30 },
  7:  { primary: "deribit", fallback: "bullish", reason: "Bullish 1-DTE has no 7% strikes; Deribit primary; 7-DTE Bullish viable as longer-dated alt", fallbackDriftThresholdPct: 0.30 },
  10: { primary: "deribit", fallback: null,      reason: "Bullish has ZERO strikes for 10% on 1-DTE; Deribit only", fallbackDriftThresholdPct: 0 }
};

/**
 * Resolve the routing decision for a given SL tier.
 *
 * Reads PILOT_VENUE_ROUTING_JSON env if set, e.g.:
 *   PILOT_VENUE_ROUTING_JSON='{"2":{"primary":"deribit","fallback":"bullish"}}'
 *
 * Otherwise returns the rev 6 default routing decision.
 */
export const resolveVenueRouting = (slTier: V7SlTier): VenueRoutingDecision => {
  const envOverride = process.env.PILOT_VENUE_ROUTING_JSON;
  if (envOverride && envOverride.trim()) {
    try {
      const parsed = JSON.parse(envOverride);
      const tierKey = String(slTier);
      if (parsed[tierKey]) {
        const o = parsed[tierKey] as Partial<VenueRoutingDecision>;
        return {
          primary: o.primary || DEFAULT_ROUTING[slTier].primary,
          fallback: o.fallback === undefined ? DEFAULT_ROUTING[slTier].fallback : o.fallback,
          reason: o.reason || `env override for tier ${slTier}`,
          fallbackDriftThresholdPct: typeof o.fallbackDriftThresholdPct === "number"
            ? o.fallbackDriftThresholdPct
            : DEFAULT_ROUTING[slTier].fallbackDriftThresholdPct
        };
      }
    } catch (err: any) {
      console.warn(
        `[MultiVenueRouter] PILOT_VENUE_ROUTING_JSON parse failed (using defaults): ${err?.message ?? err}`
      );
    }
  }
  return DEFAULT_ROUTING[slTier] || DEFAULT_ROUTING[2];
};

/**
 * Quote-comparison decision: given quotes from BOTH venues, decide
 * which to execute against. Used after the primary returns a quote.
 *
 * Logic:
 *   1. If only primary returned a usable quote, use primary
 *   2. If only fallback returned, use fallback (primary unavailable)
 *   3. If both returned, compare hedge cost; if primary > fallback × (1 + drift_threshold),
 *      switch to fallback (catches stale/thin primary orderbook)
 *   4. Otherwise stick with primary (preserve routing intent)
 */
export type VenueQuoteCandidate = {
  venue: VenueChoice;
  hedgeCostUsd: number | null;
  available: boolean;
  reason?: string;
};

export type VenueExecutionChoice = {
  chosenVenue: VenueChoice;
  reason: string;
  primary: VenueQuoteCandidate;
  fallback: VenueQuoteCandidate | null;
};

export const chooseExecutionVenue = (params: {
  routing: VenueRoutingDecision;
  primaryQuote: VenueQuoteCandidate;
  fallbackQuote: VenueQuoteCandidate | null;
}): VenueExecutionChoice => {
  const { routing, primaryQuote, fallbackQuote } = params;

  // Case 1: primary unavailable
  if (!primaryQuote.available || primaryQuote.hedgeCostUsd === null || primaryQuote.hedgeCostUsd <= 0) {
    if (fallbackQuote && fallbackQuote.available) {
      return {
        chosenVenue: fallbackQuote.venue,
        reason: `primary_unavailable_fell_back:${primaryQuote.reason ?? "no_quote"}`,
        primary: primaryQuote,
        fallback: fallbackQuote
      };
    }
    return {
      chosenVenue: routing.primary, // fail to primary anyway; downstream will error
      reason: `both_venues_unavailable:${primaryQuote.reason ?? "no_quote"}`,
      primary: primaryQuote,
      fallback: fallbackQuote
    };
  }

  // Case 2: only primary; no fallback configured or available
  if (!fallbackQuote || !fallbackQuote.available || fallbackQuote.hedgeCostUsd === null || fallbackQuote.hedgeCostUsd <= 0) {
    return {
      chosenVenue: primaryQuote.venue,
      reason: "primary_only_no_fallback",
      primary: primaryQuote,
      fallback: fallbackQuote
    };
  }

  // Case 3: both available — compare hedge cost
  const primaryCost = primaryQuote.hedgeCostUsd;
  const fallbackCost = fallbackQuote.hedgeCostUsd;
  const driftThreshold = routing.fallbackDriftThresholdPct;
  // If primary cost is meaningfully higher than fallback, switch
  if (primaryCost > fallbackCost * (1 + driftThreshold)) {
    return {
      chosenVenue: fallbackQuote.venue,
      reason: `fallback_cheaper_by_${(((primaryCost / fallbackCost) - 1) * 100).toFixed(1)}pct`,
      primary: primaryQuote,
      fallback: fallbackQuote
    };
  }

  // Case 4: primary acceptable
  return {
    chosenVenue: primaryQuote.venue,
    reason: "primary_within_drift_threshold",
    primary: primaryQuote,
    fallback: fallbackQuote
  };
};
