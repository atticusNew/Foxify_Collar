/**
 * Cell opportunities — per-cell EV recommendations for the Foxify bot.
 *
 * Why this exists:
 *   The global activation gate (good_to_activate) is conservative — it gates
 *   on a single VRP threshold across the whole market. But cell-level EV can
 *   be positive even when the global signal says WAIT (typical in calm regime
 *   when far-OTM cells still pay enough to be +EV).
 *
 *   Foxify's bot should have the OPTION to activate based on cell-level EV,
 *   not just the global signal. This module produces a sorted list of cells
 *   with their current EV%, so the bot can choose its own policy.
 *
 *   Decision authority remains with Foxify:
 *     - Conservative bot: only act on good_to_activate=true
 *     - Opportunistic bot: act on any cell with cell_opportunities[i].verdict=PROFITABLE
 *
 * Caching:
 *   - Computed every N seconds (default 30s), cached for the same window
 *   - Underlying computeLiveCellEv has its own 5-min cache, so this is cheap
 *     even on cold opportunity cache
 *   - Per-cell MC runs do NOT block /foxify/v2/should_activate response
 */

import type { PHASE_0_CELLS as PhaseCells } from "./cellConfig";
import { PHASE_0_CELLS } from "./cellConfig";
import type { LiquidChainCache } from "./liquidChainCache";
import type { LiveAnchorProvider } from "./quoteEngine";
import { buildQuote } from "./quoteEngine";
import { computeLiveCellEv } from "./liveCellEvService";
import type { TierContext } from "./tierResolver";

type Cell = (typeof PhaseCells)[keyof typeof PhaseCells];

export type CellOpportunity = {
  cell_id: string;
  cost_usdc: number;
  foxify_ev_pct: number;
  worst_case_pct: number;
  trigger_rate: number;
  verdict: "PROFITABLE" | "MARGINAL_PROFITABLE" | "BREAK_EVEN" | "MARGINAL_NEGATIVE" | "NEGATIVE" | "UNQUOTED";
  trigger_pct: number;
  tenor_days: number;
  unavailable_reason?: string;
};

export type CellOpportunitiesSnapshot = {
  computed_at: string;
  spot: number;
  regime: string;
  opportunities: CellOpportunity[];
};

const verdictFromPct = (pct: number): CellOpportunity["verdict"] => {
  if (pct > 0.20) return "PROFITABLE";
  if (pct > 0.05) return "MARGINAL_PROFITABLE";
  if (pct > -0.05) return "BREAK_EVEN";
  if (pct > -0.20) return "MARGINAL_NEGATIVE";
  return "NEGATIVE";
};

// Cache snapshot keyed by (regime, spot-bucket). $500 buckets, 30s TTL.
const SNAPSHOT_TTL_MS = 30_000;
const SPOT_BUCKET = 500;

type CacheEntry = { result: CellOpportunitiesSnapshot; expiresAtMs: number };
const _cache = new Map<string, CacheEntry>();

const cacheKey = (regime: string, spot: number) => `${regime}::${Math.round(spot / SPOT_BUCKET) * SPOT_BUCKET}`;

export const __resetCellOpportunityCache = (): void => { _cache.clear(); };

export const computeCellOpportunities = async (params: {
  spot: number;
  regime: "calm" | "moderate" | "elevated" | "stress";
  anchorProvider: LiveAnchorProvider;
  liquidChainCache: LiquidChainCache | null;
  tier: TierContext;
  nowMs?: number;
}): Promise<CellOpportunitiesSnapshot> => {
  const now = params.nowMs ?? Date.now();
  const key = cacheKey(params.regime, params.spot);
  const cached = _cache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.result;

  const opportunities: CellOpportunity[] = [];
  for (const [cellId, cell] of Object.entries(PHASE_0_CELLS) as Array<[string, Cell]>) {
    if (!cell.enabled) continue;
    try {
      const quote = await buildQuote({
        cell,
        spot: params.spot,
        anchorProvider: params.anchorProvider,
        tier: params.tier,
        liquidChainCache: params.liquidChainCache,
        nowMs: now
      });
      if (!quote.ok) {
        opportunities.push({
          cell_id: cellId,
          cost_usdc: 0,
          foxify_ev_pct: 0,
          worst_case_pct: 0,
          trigger_rate: 0,
          verdict: "UNQUOTED",
          trigger_pct: cell.triggerPctDown,
          tenor_days: cell.hedgeTenorDays,
          unavailable_reason: quote.reason
        });
        continue;
      }
      const evSim = await computeLiveCellEv({
        cellId,
        spot: params.spot,
        hedgeCostAtCalm: quote.totalHedgeCostUsdc,
        putStrike: quote.putStrike,
        callStrike: quote.callStrike,
        tenorDays: cell.hedgeTenorDays,
        triggerPctDown: cell.triggerPctDown,
        triggerPctUp: cell.triggerPctUp,
        regime: params.regime,
        contractsBtc: cell.contractsBtc
      });
      const evPct = quote.totalHedgeCostUsdc > 0 ? evSim.meanFoxifyEv / quote.totalHedgeCostUsdc : 0;
      const worstPct = quote.totalHedgeCostUsdc > 0 ? evSim.p5FoxifyEv / quote.totalHedgeCostUsdc : 0;
      opportunities.push({
        cell_id: cellId,
        cost_usdc: quote.totalHedgeCostUsdc,
        foxify_ev_pct: evPct,
        worst_case_pct: worstPct,
        trigger_rate: evSim.triggerRate,
        verdict: verdictFromPct(evPct),
        trigger_pct: cell.triggerPctDown,
        tenor_days: cell.hedgeTenorDays
      });
    } catch (err) {
      opportunities.push({
        cell_id: cellId,
        cost_usdc: 0,
        foxify_ev_pct: 0,
        worst_case_pct: 0,
        trigger_rate: 0,
        verdict: "UNQUOTED",
        trigger_pct: cell.triggerPctDown,
        tenor_days: cell.hedgeTenorDays,
        unavailable_reason: (err as Error).message?.slice(0, 200) ?? String(err)
      });
    }
  }

  // Sort: PROFITABLE first (highest EV%), then BREAK_EVEN, then NEGATIVE last
  opportunities.sort((a, b) => b.foxify_ev_pct - a.foxify_ev_pct);

  const result: CellOpportunitiesSnapshot = {
    computed_at: new Date(now).toISOString(),
    spot: params.spot,
    regime: params.regime,
    opportunities
  };
  _cache.set(key, { result, expiresAtMs: now + SNAPSHOT_TTL_MS });
  return result;
};
