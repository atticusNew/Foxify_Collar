/**
 * Phase A optimization — background venue chain warmer.
 *
 * Always-warm strategy: every VC_CHAIN_WARM_TICK_MS, prefetch the
 * Bullish + Deribit option chain for the expiries our hedge structure
 * is likely to use (14-day matched tenor +/- 1 day). Result lands in
 * the venueStrikeGrid 60s cache, so when /activate fires its
 * pickClosestStrike() lookup, the cache is already populated and the
 * call returns in microseconds instead of a 200-500ms venue REST hit.
 *
 * Net latency win on /activate path: 200-500ms saved per cell × leg.
 * Pure win, zero UX change, runs server-side regardless of trader
 * activity.
 *
 * Disable globally with VOLUME_COVER_CHAIN_WARM_ENABLED=false.
 */

import {
  getAvailableStrikes,
  type OptionChainQuery
} from "./venueStrikeGrid";
import type { HedgeVenueChoice } from "./tightHedge";

export type ChainWarmerConfig = {
  /** Tick interval in ms. Default 30s. */
  tickIntervalMs: number;
  /** Tenor offsets (days) to warm beyond the canonical 14d matched tenor. */
  tenorOffsetsDays: number[];
};

const DEFAULTS: ChainWarmerConfig = {
  tickIntervalMs: 30_000,
  tenorOffsetsDays: [13, 14, 15] // matched tenor + 1d either side for snap-edge cases
};

const readConfig = (): ChainWarmerConfig => {
  const cfg = { ...DEFAULTS };
  const tick = Number(process.env.VC_CHAIN_WARM_TICK_MS);
  if (Number.isFinite(tick) && tick > 0) cfg.tickIntervalMs = tick;
  return cfg;
};

/**
 * Compute the upcoming expiries we want pre-cached. Snap to 08:00 UTC
 * boundary (matches buildHedgeStructure semantics).
 */
const upcomingExpiries = (offsetsDays: number[], nowMs: number): string[] => {
  return offsetsDays.map((days) => {
    const d = new Date(nowMs + days * 86_400_000);
    d.setUTCHours(8, 0, 0, 0);
    if (d.getTime() < nowMs) {
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return d.toISOString();
  });
};

/**
 * Run one warming tick. Exposed for tests + manual ops endpoint.
 * Iterates (venue × expiry × optionKind) and triggers cache fills.
 * Best-effort: failures logged but do not stop subsequent fills.
 */
export const runChainWarmerTick = async (params: {
  venues?: HedgeVenueChoice[];
  nowMs?: number;
} = {}): Promise<{
  cycledAt: string;
  queriesAttempted: number;
  queriesSucceeded: number;
}> => {
  const cfg = readConfig();
  const venues = params.venues ?? (["bullish", "deribit"] as HedgeVenueChoice[]);
  const nowMs = params.nowMs ?? Date.now();
  const expiries = upcomingExpiries(cfg.tenorOffsetsDays, nowMs);

  const queries: OptionChainQuery[] = [];
  for (const venue of venues) {
    for (const expiryIso of expiries) {
      queries.push({ venue, expiryIso, optionKind: "put" });
      queries.push({ venue, expiryIso, optionKind: "call" });
    }
  }

  let succeeded = 0;
  // Fire in parallel; getAvailableStrikes returns null on no provider
  // or fetch error which we count as a no-op (not a success).
  const results = await Promise.all(
    queries.map(async (q) => {
      try {
        const strikes = await getAvailableStrikes(q);
        return strikes !== null && strikes.length > 0;
      } catch {
        return false;
      }
    })
  );
  for (const ok of results) if (ok) succeeded++;

  return {
    cycledAt: new Date(nowMs).toISOString(),
    queriesAttempted: queries.length,
    queriesSucceeded: succeeded
  };
};

// ──────────────────────────── Lifecycle ────────────────────────────

let runningHandle: NodeJS.Timeout | null = null;

export const startChainWarmer = (): { stop: () => void } => {
  if (process.env.VOLUME_COVER_CHAIN_WARM_ENABLED === "false") {
    console.log(`[VolumeCover] Chain warmer disabled via env`);
    return { stop: () => {} };
  }
  if (runningHandle !== null) {
    console.warn(`[VolumeCover] Chain warmer already running; ignoring start`);
    return { stop: () => stopChainWarmer() };
  }
  const cfg = readConfig();

  const tick = async () => {
    try {
      const result = await runChainWarmerTick();
      if (result.queriesSucceeded > 0) {
        console.log(
          `[VolumeCover] Chain warmer: ${result.queriesSucceeded}/${result.queriesAttempted} queries cached`
        );
      }
    } catch (err) {
      console.warn(`[VolumeCover] Chain warmer tick error: ${(err as Error).message}`);
    }
  };

  // Initial tick after 5s so server boot completes
  runningHandle = setTimeout(function loop() {
    void tick();
    runningHandle = setTimeout(loop, cfg.tickIntervalMs);
  }, 5_000);

  return { stop: () => stopChainWarmer() };
};

export const stopChainWarmer = (): void => {
  if (runningHandle !== null) {
    clearTimeout(runningHandle);
    runningHandle = null;
  }
};

export const __resetChainWarmerForTests = (): void => stopChainWarmer();
