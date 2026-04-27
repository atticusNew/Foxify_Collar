/**
 * Kalshi event-archetype adapter.
 *
 * Ports the methodology from kal_v3_demo (services/kalshi/event_parser.py
 * and services/kalshi/adapter.py) into TypeScript. This is the entry point
 * for every hedge-construction call — it determines what *instrument* the
 * hedge needs to be based on (event_type, user_direction).
 *
 * WHY THIS MATTERS:
 *   The previous research package hardcoded "PUT spread" everywhere. That
 *   was Foxify-shaped thinking: Foxify users are always long BTC drawdown
 *   protection. Kalshi users can bet YES or NO on ABOVE / BELOW / HIT
 *   events, which means the hedge instrument INVERTS depending on the bet
 *   direction.
 *
 *   This module is the explicit fix.
 *
 * REFERENCE:
 *   kal_v3_demo/services/kalshi/event_parser.py — taxonomy
 *   kal_v3_demo/services/kalshi/adapter.py      — direction → instrument
 *
 *   research/kalshi-shadow-backtest/KAL_V3_DEMO_REVIEW.md — discussion
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Three Kalshi BTC event archetypes:
 *   ABOVE — "Will BTC be above $X by date Y?" / "How high?" (KXBTC2025100, KXBTCMAXY)
 *   BELOW — "Will BTC go below $X?"          / "How low?"  (KXBTCMINY)
 *   HIT   — "When will BTC hit $X?"          (first-to-touch barrier, KXBTCMAX150)
 */
export type EventType = "ABOVE" | "BELOW" | "HIT";

/** User's bet direction on the Kalshi market. */
export type UserDirection = "yes" | "no";

/**
 * What instrument the hedge needs:
 *   call  — vertical call spread on Deribit (long lower-K call, short higher-K call)
 *   put   — vertical put spread (long higher-K put, short lower-K put)
 *   none  — no Deribit hedge instrument applies (e.g. HIT-direction combinations
 *           where a put-spread overlay isn't appropriate; Kalshi-NO-leg only)
 */
export type HedgeInstrument = "call" | "put" | "none";

/**
 * Where the user's loss region lies relative to the barrier K.
 * The hedge must pay in this region.
 */
export type LossRegion =
  | { kind: "above"; barrier: number }   // user loses if S_T > K
  | { kind: "below"; barrier: number }   // user loses if S_T ≤ K (or < K, depending on event)
  | { kind: "hit_not_reached"; barrier: number }   // user loses if S_T never hits K (HIT-YES bet)
  | { kind: "hit_reached"; barrier: number };      // user loses if S_T does hit K (HIT-NO bet)

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Map (event_type, user_direction) → (instrument, loss region).
 *
 * Rules (from kal_v3_demo/services/kalshi/adapter.py):
 *
 *   BELOW K + YES: user wins if S_T ≤ K. Loses if S_T > K.
 *                  Hedge with CALL spread (pays when S_T moves up past K).
 *
 *   BELOW K + NO:  user wins if S_T > K. Loses if S_T ≤ K.
 *                  Hedge with PUT spread (pays when S_T falls below K).
 *
 *   ABOVE K + YES: user wins if S_T ≥ K. Loses if S_T < K.
 *                  Hedge with PUT spread (pays when S_T fails to reach K).
 *
 *   ABOVE K + NO:  user wins if S_T < K. Loses if S_T ≥ K.
 *                  Hedge with CALL spread (pays when S_T pushes through K).
 *
 *   HIT K + YES (path-dependent, K above current spot):
 *                  user wins if S_t ≥ K is touched at any time before expiry.
 *                  Loses if S never touches K. Pure-NO-leg Shield is the
 *                  cleanest hedge for this; a Deribit overlay is awkward
 *                  (would need a knock-in option, not a vanilla spread).
 *                  We mark instrument = "none" for the Deribit overlay and
 *                  rely on the Shield NO-leg as the sole hedge.
 *
 *   HIT K + NO:    user wins if S never touches K. Loses if it does.
 *                  Same: Deribit overlay is awkward (need knock-out), we
 *                  mark instrument = "none".
 *
 * The "none" cases for HIT mean Shield-only protection is the recommended
 * tier for those markets. Tiers that require a Deribit overlay (Lite,
 * Standard, Shield+) should be flagged as "not offered" for HIT markets
 * unless we add a knock-in/knock-out path.
 */
export function adaptHedgeInstrument(
  eventType: EventType,
  direction: UserDirection,
  barrier: number,
): { instrument: HedgeInstrument; lossRegion: LossRegion } {
  if (eventType === "BELOW") {
    if (direction === "yes") {
      return { instrument: "call", lossRegion: { kind: "above", barrier } };
    }
    return { instrument: "put", lossRegion: { kind: "below", barrier } };
  }

  if (eventType === "ABOVE") {
    if (direction === "yes") {
      return { instrument: "put", lossRegion: { kind: "below", barrier } };
    }
    return { instrument: "call", lossRegion: { kind: "above", barrier } };
  }

  // HIT
  if (direction === "yes") {
    return { instrument: "none", lossRegion: { kind: "hit_not_reached", barrier } };
  }
  return { instrument: "none", lossRegion: { kind: "hit_reached", barrier } };
}

// ─── Outcome resolver ────────────────────────────────────────────────────────

/**
 * Determine whether a Kalshi market settled YES or NO from the at-settle
 * underlying price. For HIT events this is approximate — true HIT settlement
 * depends on the *path*, not just the closing price. For backtest purposes
 * we approximate HIT-YES as "did S_settle reach within 1% of K from the
 * appropriate side at settlement". A better model would walk daily highs/lows
 * across the holding window; we accept the approximation and flag it.
 */
export function deriveKalshiOutcome(
  eventType: EventType,
  barrier: number,
  S_at_settle: number,
  S_at_open: number,
): "yes" | "no" {
  if (eventType === "ABOVE") {
    return S_at_settle >= barrier ? "yes" : "no";
  }
  if (eventType === "BELOW") {
    return S_at_settle <= barrier ? "yes" : "no";
  }
  // HIT — approximation: did the price approach K from the opening side?
  // (caller can override with path-aware logic if max-during-window data exists)
  if (S_at_open < barrier) {
    return S_at_settle >= barrier ? "yes" : "no";
  }
  return S_at_settle <= barrier ? "yes" : "no";
}
