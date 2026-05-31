/**
 * Realized-vs-MC reconciliation (production-readiness gate, pure REAL data).
 *
 * Pulls SETTLED shadow pairs per cell, computes the realized mean Foxify net,
 * and compares it to the Foxify-duration MC's prediction for that cell at a
 * given regime. Flags whether realized is within ±15% of predicted — the
 * checklist gate for trusting a cell's signal before live.
 *
 * Realized Foxify net per pair = foxify_share_usdc - hedge_cost_total_usdc
 *   (on losses: foxify_share = salvage, so net = salvage - cost = uplift;
 *    on profits: foxify_share = cost + uplift - atticus, so net = uplift - atticus).
 * This is exactly the quantity the MC's meanFoxifyNetUsdc predicts.
 *
 * HONEST CAVEATS (surfaced in the output):
 *   - regime is NOT recorded at activation, so realized spans whatever regimes
 *     the pairs were actually opened in; the MC prediction is for ONE regime.
 *     => treat ±15% as directional until regime-at-activation is recorded.
 *   - the MC uses a default auto-close target ($abs / pct) which may differ from
 *     Foxify's actual close timing. No synthetic prices: cost+realism come from
 *     computeRealPricing (real chain), sigma from empirical calibration.
 */

import type { Pool, PoolClient } from "pg";
import type { Regime } from "./featureFlag";
import { PHASE_0_CELLS, computeStrikes, type TwoSidedCell } from "./cellConfig";
import { computeRealPricing, type SweepVenue } from "./cellSweep";
import { getRegimeCalibration } from "./regimeCalibration";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

export type RealizedCellStats = {
  cellId: string;
  n: number;
  meanRealizedNetUsdc: number;
  pctProfitable: number;
  meanCostUsdc: number;
  exitModeCounts: Record<string, number>;
};

export type ReconcileRow = {
  cell_id: string;
  realized_n: number;
  realized_mean_net_usdc: number;
  realized_pct_profitable: number;
  realized_mean_cost_usdc: number;
  exit_modes: Record<string, number>;
  mc_predicted_net_usdc: number | null;
  mc_status: "ok" | "chain_unavailable" | "cell_not_in_config";
  delta_usdc: number | null;
  within_15pct: boolean | null;
};

export type ReconcileReport = {
  as_of: string;
  regime: Regime;
  spot: number;
  n_paths: number;
  auto_close_pnl_pct: number;
  auto_close_absolute_usdc: number;
  /** Settled shadow pairs tagged with a regime-at-activation (usable for the exact gate). */
  regime_tagged_pairs: number;
  /** Legacy settled shadow pairs with NO regime tag (excluded from the regime-filtered realized). */
  untagged_pairs: number;
  rows: ReconcileRow[];
  caveats: string[];
};

/** Pull settled shadow pairs and aggregate realized stats per cell (JS-side, pg-mem safe). */
export const getRealizedShadowStats = async (
  pool: Pool | PoolClient,
  opts: { regime?: Regime } = {}
): Promise<{ stats: RealizedCellStats[]; taggedPairs: number; untaggedPairs: number }> => {
  const r = await pool.query<{ cell_id: string; hedge_cost_total_usdc: string; foxify_share_usdc: string | null; exit_mode: string | null; regime_at_activation: string | null }>(
    `SELECT cell_id, hedge_cost_total_usdc, foxify_share_usdc, exit_mode, regime_at_activation
     FROM two_sided_pair
     WHERE status = 'settled' AND is_shadow = TRUE AND foxify_share_usdc IS NOT NULL`
  );
  let taggedPairs = 0;
  let untaggedPairs = 0;
  const byCell = new Map<string, { nets: number[]; costs: number[]; exits: Record<string, number> }>();
  for (const row of r.rows) {
    const cost = Number(row.hedge_cost_total_usdc);
    const fox = Number(row.foxify_share_usdc);
    if (!Number.isFinite(cost) || !Number.isFinite(fox)) continue;
    const rg = row.regime_at_activation ?? null;
    if (rg == null) untaggedPairs++; else taggedPairs++;
    // When a regime filter is set, only count pairs ACTIVATED in that regime
    // (legacy untagged pairs are excluded — that's how the gate becomes exact).
    if (opts.regime && rg !== opts.regime) continue;
    const net = fox - cost;
    const g = byCell.get(row.cell_id) ?? { nets: [], costs: [], exits: {} };
    g.nets.push(net);
    g.costs.push(cost);
    const em = row.exit_mode ?? "unknown";
    g.exits[em] = (g.exits[em] ?? 0) + 1;
    byCell.set(row.cell_id, g);
  }
  const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const stats = [...byCell.entries()].map(([cellId, g]) => ({
    cellId,
    n: g.nets.length,
    meanRealizedNetUsdc: +mean(g.nets).toFixed(2),
    pctProfitable: +(g.nets.filter((x) => x > 0).length / g.nets.length).toFixed(4),
    meanCostUsdc: +mean(g.costs).toFixed(2),
    exitModeCounts: g.exits
  }));
  return { stats, taggedPairs, untaggedPairs };
};

export const reconcileRealizedVsMc = async (
  pool: Pool,
  opts: {
    regime: Regime;
    spot: number;
    liquidChainCache: LiquidChainCache;
    dvolService?: DvolService | null;
    venue?: SweepVenue;
    nPaths?: number;
    autoClosePnlPct?: number;
    autoCloseAbsoluteUsdc?: number;
    nowMs?: number;
  }
): Promise<ReconcileReport> => {
  const nPaths = opts.nPaths ?? 500;
  const autoClosePnlPct = opts.autoClosePnlPct ?? 0.30;
  const autoCloseAbsoluteUsdc = opts.autoCloseAbsoluteUsdc ?? 250;
  const venue: SweepVenue = opts.venue ?? "auto";
  const calibration = await getRegimeCalibration(pool, { nowMs: opts.nowMs });
  const sigma = calibration[opts.regime].sigma;
  const realizedResult = await getRealizedShadowStats(pool, { regime: opts.regime });
  const realized = realizedResult.stats;

  const rows: ReconcileRow[] = [];
  for (const rz of realized) {
    const cell: TwoSidedCell | undefined = PHASE_0_CELLS[rz.cellId];
    let mcPredicted: number | null = null;
    let mcStatus: ReconcileRow["mc_status"] = "ok";
    if (!cell) {
      mcStatus = "cell_not_in_config";
    } else {
      const { putStrike, callStrike } = computeStrikes(cell, opts.spot);
      const pricing = computeRealPricing(
        opts.spot, putStrike, callStrike, cell.contractsBtc, cell.hedgeTenorDays,
        opts.liquidChainCache, opts.dvolService ?? null, venue
      );
      if (!pricing) {
        mcStatus = "chain_unavailable";
      } else {
        const mc = await runFoxifyDurationMc({
          cellId: rz.cellId, spot: opts.spot, hedgeCostUsdc: pricing.hedgeCostUsdc,
          putStrike, callStrike, tenorDays: cell.hedgeTenorDays,
          triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
          regime: opts.regime, sigmaAnnual: sigma, contractsBtc: cell.contractsBtc,
          autoClosePnlPct, autoCloseAbsoluteUsdc,
          salvageRealismMultiplier: pricing.salvageRealismMultiplier, nPaths, barsOverride: null
        });
        mcPredicted = +mc.meanFoxifyNetUsdc.toFixed(2);
      }
    }
    const delta = mcPredicted != null ? +(rz.meanRealizedNetUsdc - mcPredicted).toFixed(2) : null;
    const within = mcPredicted != null && delta != null
      ? Math.abs(delta) <= 0.15 * Math.abs(mcPredicted) || Math.abs(delta) <= 5 // $5 abs tolerance near zero
      : null;
    rows.push({
      cell_id: rz.cellId,
      realized_n: rz.n,
      realized_mean_net_usdc: rz.meanRealizedNetUsdc,
      realized_pct_profitable: rz.pctProfitable,
      realized_mean_cost_usdc: rz.meanCostUsdc,
      exit_modes: rz.exitModeCounts,
      mc_predicted_net_usdc: mcPredicted,
      mc_status: mcStatus,
      delta_usdc: delta,
      within_15pct: within
    });
  }
  rows.sort((a, b) => b.realized_n - a.realized_n);
  return {
    as_of: new Date(opts.nowMs ?? Date.now()).toISOString(),
    regime: opts.regime, spot: opts.spot, n_paths: nPaths,
    auto_close_pnl_pct: autoClosePnlPct, auto_close_absolute_usdc: autoCloseAbsoluteUsdc,
    regime_tagged_pairs: realizedResult.taggedPairs,
    untagged_pairs: realizedResult.untaggedPairs,
    rows,
    caveats: [
      `Realized is FILTERED to regime='${opts.regime}' via regime-at-activation. ${realizedResult.untaggedPairs} legacy pair(s) without a regime tag are excluded; ${realizedResult.taggedPairs} are tagged. As tagged pairs accumulate, within_15pct becomes an EXACT gate (apples-to-apples vs the same-regime MC).`,
      "MC uses a default auto-close target (abs/pct) that may differ from Foxify's actual close timing — pass auto_close_abs / auto_close_pct to match.",
      "No synthetic prices: cost+realism from real chain (computeRealPricing), sigma from empirical calibration."
    ]
  };
};
