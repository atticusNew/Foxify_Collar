/**
 * Venue routing visibility — tells operator WHERE pair legs are being bought
 * and WHY the picker chose each venue.
 *
 * Two views:
 *   1. Historical: aggregate stats across all active/closed pairs
 *      (from two_sided_pair_leg table, grouped by cell + venue)
 *   2. Forward-looking: for each cell, simulate what the picker WOULD do
 *      right now and show the cost comparison (bullish vs deribit)
 *
 * The picker is cost-optimizing by default (picks cheapest valid leg). This
 * means in calm markets where Deribit typically has tighter spreads, most
 * volume routes to Deribit. The forward-looking view exposes WHY — so the
 * operator can decide if they want to add a Bullish-preference policy.
 */

import type { Pool } from "pg";
import { PHASE_0_CELLS } from "./cellConfig";
import type { LiquidChainCache } from "./liquidChainCache";
import type { LiveAnchorProvider } from "./quoteEngine";
import { computeStrikes, type TwoSidedCell } from "./cellConfig";
import type { TierContext } from "./tierResolver";

// ─── Historical routing (from DB) ───────────────────────────────────────────

export type HistoricalRoutingStats = {
  as_of: string;
  filter: "active_only" | "all";
  total_legs: number;
  total_cost_usdc: number;
  by_venue: {
    bullish: { leg_count: number; cost_usdc: number; pct_of_total: number };
    deribit: { leg_count: number; cost_usdc: number; pct_of_total: number };
  };
  by_cell: Array<{
    cell_id: string;
    total_legs: number;
    bullish_legs: number;
    deribit_legs: number;
    bullish_cost_usdc: number;
    deribit_cost_usdc: number;
    bullish_pct: number;
  }>;
};

export const getHistoricalRoutingStats = async (
  pool: Pool,
  opts: { activeOnly?: boolean } = {}
): Promise<HistoricalRoutingStats> => {
  const activeOnly = opts.activeOnly !== false;
  const statusFilter = activeOnly ? "WHERE p.status = 'active'" : "";

  const totalsRes = await pool.query<{
    venue: string;
    leg_count: number;
    cost_usdc: number;
  }>(`
    SELECT l.venue,
           COUNT(*) AS leg_count,
           COALESCE(SUM(l.buy_cost_usdc), 0) AS cost_usdc
      FROM two_sided_pair_leg l
      JOIN two_sided_pair p ON l.pair_id = p.pair_id
      ${statusFilter}
      GROUP BY l.venue
  `);

  const totalLegs = totalsRes.rows.reduce((s, r) => s + Number(r.leg_count), 0);
  const totalCost = totalsRes.rows.reduce((s, r) => s + Number(r.cost_usdc), 0);
  const venueMap = new Map(totalsRes.rows.map((r) => [r.venue, r]));
  const bullishTotal = venueMap.get("bullish") ?? { leg_count: 0, cost_usdc: 0 };
  const deribitTotal = venueMap.get("deribit") ?? { leg_count: 0, cost_usdc: 0 };

  const byCellRes = await pool.query<{
    cell_id: string;
    venue: string;
    leg_count: number;
    cost_usdc: number;
  }>(`
    SELECT p.cell_id, l.venue,
           COUNT(*) AS leg_count,
           COALESCE(SUM(l.buy_cost_usdc), 0) AS cost_usdc
      FROM two_sided_pair_leg l
      JOIN two_sided_pair p ON l.pair_id = p.pair_id
      ${statusFilter}
      GROUP BY p.cell_id, l.venue
      ORDER BY p.cell_id
  `);

  const byCell: HistoricalRoutingStats["by_cell"] = [];
  const cellMap = new Map<string, { bullish_legs: number; deribit_legs: number; bullish_cost: number; deribit_cost: number }>();
  for (const r of byCellRes.rows) {
    const existing = cellMap.get(r.cell_id) ?? { bullish_legs: 0, deribit_legs: 0, bullish_cost: 0, deribit_cost: 0 };
    if (r.venue === "bullish") {
      existing.bullish_legs += Number(r.leg_count);
      existing.bullish_cost += Number(r.cost_usdc);
    } else if (r.venue === "deribit") {
      existing.deribit_legs += Number(r.leg_count);
      existing.deribit_cost += Number(r.cost_usdc);
    }
    cellMap.set(r.cell_id, existing);
  }
  for (const [cellId, stats] of cellMap.entries()) {
    const totalLegsCell = stats.bullish_legs + stats.deribit_legs;
    byCell.push({
      cell_id: cellId,
      total_legs: totalLegsCell,
      bullish_legs: stats.bullish_legs,
      deribit_legs: stats.deribit_legs,
      bullish_cost_usdc: stats.bullish_cost,
      deribit_cost_usdc: stats.deribit_cost,
      bullish_pct: totalLegsCell > 0 ? stats.bullish_legs / totalLegsCell : 0
    });
  }
  byCell.sort((a, b) => b.total_legs - a.total_legs);

  return {
    as_of: new Date().toISOString(),
    filter: activeOnly ? "active_only" : "all",
    total_legs: totalLegs,
    total_cost_usdc: totalCost,
    by_venue: {
      bullish: {
        leg_count: Number(bullishTotal.leg_count),
        cost_usdc: Number(bullishTotal.cost_usdc),
        pct_of_total: totalLegs > 0 ? Number(bullishTotal.leg_count) / totalLegs : 0
      },
      deribit: {
        leg_count: Number(deribitTotal.leg_count),
        cost_usdc: Number(deribitTotal.cost_usdc),
        pct_of_total: totalLegs > 0 ? Number(deribitTotal.leg_count) / totalLegs : 0
      }
    },
    by_cell: byCell
  };
};

// ─── Forward-looking routing (what would the picker do RIGHT NOW) ──────────

export type LegRoutingExplanation = {
  leg: "put" | "call";
  target_strike: number;
  bullish: {
    available: boolean;
    ask_usdc_per_btc: number | null;
    leg_cost_usdc: number | null;
    depth_btc: number | null;
    rejected_reason: string | null;
  };
  deribit: {
    available: boolean;
    ask_usdc_per_btc: number | null;
    leg_cost_usdc: number | null;
    depth_btc: number | null;
    rejected_reason: string | null;
  };
  picked_venue: "bullish" | "deribit" | null;
  picker_reason: string;
  cost_savings_pct_vs_runner_up: number | null;
};

export type CellRoutingExplanation = {
  cell_id: string;
  spot_at_quote: number;
  put: LegRoutingExplanation;
  call: LegRoutingExplanation;
  picked_total_cost_usdc: number | null;
  alternative_all_bullish_cost_usdc: number | null;
  alternative_all_deribit_cost_usdc: number | null;
};

const explainLegPick = (
  leg: "put" | "call",
  targetStrike: number,
  bullishAnchor: { askUsdcPerBtc: number; depthWithin2pctBtc: number; symbol: string } | null,
  deribitAnchor: { askUsdcPerBtc: number; depthWithin2pctBtc: number; symbol: string } | null,
  requiredDepthBtc: number,
  contractsBtc: number
): LegRoutingExplanation => {
  const bullishValid = bullishAnchor != null
    && Number.isFinite(bullishAnchor.askUsdcPerBtc) && bullishAnchor.askUsdcPerBtc > 0
    && Number.isFinite(bullishAnchor.depthWithin2pctBtc) && bullishAnchor.depthWithin2pctBtc >= requiredDepthBtc;
  const deribitValid = deribitAnchor != null
    && Number.isFinite(deribitAnchor.askUsdcPerBtc) && deribitAnchor.askUsdcPerBtc > 0
    && Number.isFinite(deribitAnchor.depthWithin2pctBtc) && deribitAnchor.depthWithin2pctBtc >= requiredDepthBtc;

  const bullishView = {
    available: bullishValid,
    ask_usdc_per_btc: bullishAnchor?.askUsdcPerBtc ?? null,
    leg_cost_usdc: bullishAnchor ? bullishAnchor.askUsdcPerBtc * contractsBtc : null,
    depth_btc: bullishAnchor?.depthWithin2pctBtc ?? null,
    rejected_reason: bullishAnchor == null ? "no_quote"
      : !Number.isFinite(bullishAnchor.askUsdcPerBtc) || bullishAnchor.askUsdcPerBtc <= 0 ? "invalid_ask"
      : !Number.isFinite(bullishAnchor.depthWithin2pctBtc) || bullishAnchor.depthWithin2pctBtc < requiredDepthBtc ? `insufficient_depth(have ${bullishAnchor.depthWithin2pctBtc?.toFixed(2) ?? "n/a"}BTC, need ${requiredDepthBtc.toFixed(2)}BTC)`
      : null
  };
  const deribitView = {
    available: deribitValid,
    ask_usdc_per_btc: deribitAnchor?.askUsdcPerBtc ?? null,
    leg_cost_usdc: deribitAnchor ? deribitAnchor.askUsdcPerBtc * contractsBtc : null,
    depth_btc: deribitAnchor?.depthWithin2pctBtc ?? null,
    rejected_reason: deribitAnchor == null ? "no_quote"
      : !Number.isFinite(deribitAnchor.askUsdcPerBtc) || deribitAnchor.askUsdcPerBtc <= 0 ? "invalid_ask"
      : !Number.isFinite(deribitAnchor.depthWithin2pctBtc) || deribitAnchor.depthWithin2pctBtc < requiredDepthBtc ? `insufficient_depth(have ${deribitAnchor.depthWithin2pctBtc?.toFixed(2) ?? "n/a"}BTC, need ${requiredDepthBtc.toFixed(2)}BTC)`
      : null
  };

  let pickedVenue: "bullish" | "deribit" | null = null;
  let reason = "no_valid_venue";
  let savingsPct: number | null = null;

  if (bullishValid && deribitValid) {
    const bAsk = bullishAnchor!.askUsdcPerBtc;
    const dAsk = deribitAnchor!.askUsdcPerBtc;
    if (bAsk <= dAsk) {
      pickedVenue = "bullish";
      reason = `bullish_cheaper_or_tied (bullish=$${bAsk.toFixed(2)}, deribit=$${dAsk.toFixed(2)})`;
      savingsPct = dAsk > 0 ? (dAsk - bAsk) / dAsk : 0;
    } else {
      pickedVenue = "deribit";
      reason = `deribit_cheaper (deribit=$${dAsk.toFixed(2)} vs bullish=$${bAsk.toFixed(2)}, saved ${((bAsk - dAsk) / bAsk * 100).toFixed(1)}%)`;
      savingsPct = bAsk > 0 ? (bAsk - dAsk) / bAsk : 0;
    }
  } else if (bullishValid) {
    pickedVenue = "bullish";
    reason = `bullish_only (deribit unavailable: ${deribitView.rejected_reason})`;
  } else if (deribitValid) {
    pickedVenue = "deribit";
    reason = `deribit_only (bullish unavailable: ${bullishView.rejected_reason})`;
  }

  return {
    leg,
    target_strike: targetStrike,
    bullish: bullishView,
    deribit: deribitView,
    picked_venue: pickedVenue,
    picker_reason: reason,
    cost_savings_pct_vs_runner_up: savingsPct
  };
};

const DEPTH_HEADROOM_FACTOR = 5;

export const getForwardRoutingExplanation = async (params: {
  spot: number;
  anchorProvider: LiveAnchorProvider;
  liquidChainCache: LiquidChainCache | null;
  cells?: string[];
}): Promise<CellRoutingExplanation[]> => {
  const cellIds = params.cells ?? Object.keys(PHASE_0_CELLS);
  const out: CellRoutingExplanation[] = [];
  for (const cellId of cellIds) {
    const cell = PHASE_0_CELLS[cellId];
    if (!cell || !cell.enabled) continue;
    const strikes = computeStrikes(cell, params.spot);

    try {
      const [putAnchors, callAnchors] = await Promise.all([
        params.anchorProvider.getAnchorForLeg(strikes.putStrike, "put", cell.hedgeTenorDays),
        params.anchorProvider.getAnchorForLeg(strikes.callStrike, "call", cell.hedgeTenorDays)
      ]);
      const requiredDepth = cell.contractsBtc * DEPTH_HEADROOM_FACTOR;
      const putExplain = explainLegPick("put", strikes.putStrike, putAnchors.bullish, putAnchors.deribit, requiredDepth, cell.contractsBtc);
      const callExplain = explainLegPick("call", strikes.callStrike, callAnchors.bullish, callAnchors.deribit, requiredDepth, cell.contractsBtc);

      const pickedTotal =
        (putExplain.picked_venue === "bullish" ? putExplain.bullish.leg_cost_usdc :
         putExplain.picked_venue === "deribit" ? putExplain.deribit.leg_cost_usdc : null) ?? 0;
      const callPickedTotal =
        (callExplain.picked_venue === "bullish" ? callExplain.bullish.leg_cost_usdc :
         callExplain.picked_venue === "deribit" ? callExplain.deribit.leg_cost_usdc : null) ?? 0;

      out.push({
        cell_id: cellId,
        spot_at_quote: params.spot,
        put: putExplain,
        call: callExplain,
        picked_total_cost_usdc: pickedTotal + callPickedTotal,
        alternative_all_bullish_cost_usdc: (putExplain.bullish.leg_cost_usdc != null && callExplain.bullish.leg_cost_usdc != null)
          ? putExplain.bullish.leg_cost_usdc + callExplain.bullish.leg_cost_usdc
          : null,
        alternative_all_deribit_cost_usdc: (putExplain.deribit.leg_cost_usdc != null && callExplain.deribit.leg_cost_usdc != null)
          ? putExplain.deribit.leg_cost_usdc + callExplain.deribit.leg_cost_usdc
          : null
      });
    } catch (e) {
      out.push({
        cell_id: cellId,
        spot_at_quote: params.spot,
        put: { leg: "put", target_strike: strikes.putStrike } as LegRoutingExplanation,
        call: { leg: "call", target_strike: strikes.callStrike } as LegRoutingExplanation,
        picked_total_cost_usdc: null,
        alternative_all_bullish_cost_usdc: null,
        alternative_all_deribit_cost_usdc: null
      });
    }
  }
  return out;
};
