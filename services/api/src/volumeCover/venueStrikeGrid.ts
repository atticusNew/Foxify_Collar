/**
 * P1c — Venue strike grid lookup with 60s cache.
 *
 * Per PLAN §5 #3: at quote time, fetch live Bullish + Deribit option
 * chain for target expiry; pick strike closest to ideal that *exists*
 * on the venue. Avoids the failure mode of computing an ideal strike
 * the venue doesn't have on its grid.
 *
 * Architecture:
 *   - VenueOptionChainProvider: operator-wired pluggable interface
 *     that returns the list of available strikes for (venue, expiry).
 *   - 60s in-memory TTL cache keyed by (venue, expiryIso, optionKind).
 *   - Public API: pickClosestStrike() — returns the closest existing
 *     strike to an ideal value, constrained to stay inside a band.
 *
 * Fallback: when no provider is wired (typical pre-launch state), or
 * the provider throws, callers should default to the static grid-step
 * snap from strikeGrid.snapHedgeStrike. tightHedge.buildHedgeStructure
 * already does this fallback transparently.
 *
 * Operator wires actual venue REST calls via setVenueOptionChainProvider().
 */

import type { HedgeVenueChoice } from "./tightHedge";

export type OptionChainQuery = {
  venue: HedgeVenueChoice;
  expiryIso: string;
  optionKind: "put" | "call";
};

/**
 * Returns sorted ascending list of strikes (USDC) the venue lists for
 * the given expiry + option kind. May throw on venue-API failure.
 */
export type VenueOptionChainProvider = (query: OptionChainQuery) => Promise<number[]>;

type CacheEntry = {
  strikes: number[];
  expiresAtMs: number;
};

let provider: VenueOptionChainProvider | null = null;
const cache = new Map<string, CacheEntry>();
const TTL_MS_DEFAULT = 60_000;

const cacheKey = (q: OptionChainQuery): string =>
  `${q.venue}|${q.expiryIso}|${q.optionKind}`;

/**
 * Operator wiring point. Registers the live chain-fetch implementation.
 * Pass null to clear (resets to static-fallback behavior).
 */
export const setVenueOptionChainProvider = (
  fn: VenueOptionChainProvider | null
): void => {
  provider = fn;
  cache.clear();
};

/**
 * Read-through cache around the registered provider. Returns null if
 * no provider wired or fetch failed (caller should fall back to static
 * grid snap). TTL configurable via VC_VENUE_GRID_CACHE_TTL_MS env.
 */
export const getAvailableStrikes = async (
  q: OptionChainQuery
): Promise<number[] | null> => {
  if (!provider) return null;
  const ttl = Number(process.env.VC_VENUE_GRID_CACHE_TTL_MS ?? TTL_MS_DEFAULT);
  const key = cacheKey(q);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.strikes;

  try {
    const strikes = await provider(q);
    const sorted = (strikes ?? []).slice().filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
    cache.set(key, { strikes: sorted, expiresAtMs: now + ttl });
    return sorted;
  } catch {
    // Stale cache better than nothing if available
    if (cached) return cached.strikes;
    return null;
  }
};

/**
 * Pick the strike closest to `idealStrikeUsdc` that exists in the
 * venue's grid AND lies inside the safe band:
 *
 *   PUT:  triggerBoundary < strike <= spot
 *   CALL: spot <= strike < triggerBoundary
 *
 * Returns null if no provider wired, fetch failed, or no strike in
 * band. Caller falls back to strikeGrid.snapHedgeStrike (static).
 */
export const pickClosestStrike = async (params: {
  query: OptionChainQuery;
  idealStrikeUsdc: number;
  spotUsdc: number;
  triggerBoundaryUsdc: number;
}): Promise<number | null> => {
  const strikes = await getAvailableStrikes(params.query);
  if (!strikes || strikes.length === 0) return null;

  const inBand = strikes.filter((s) => {
    if (params.query.optionKind === "put") {
      return s > params.triggerBoundaryUsdc && s <= params.spotUsdc;
    }
    return s < params.triggerBoundaryUsdc && s >= params.spotUsdc;
  });
  if (inBand.length === 0) return null;

  let best = inBand[0];
  let bestDist = Math.abs(best - params.idealStrikeUsdc);
  for (const s of inBand) {
    const d = Math.abs(s - params.idealStrikeUsdc);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
};

/**
 * Test helpers.
 */
export const __resetVenueStrikeGridForTests = (): void => {
  provider = null;
  cache.clear();
};
