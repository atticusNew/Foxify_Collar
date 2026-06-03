/**
 * Foxify-shareable expected economics (production cells only).
 *
 * A CURATED, honest view of what each PRODUCTION cell is expected to do in a given
 * regime — built ONLY from validated inputs so it's safe to share with the partner:
 *   - cost      = real chain pricing (computeRealPricing — no synthetic prices)
 *   - MC net / %profitable / p5 / p95 = Foxify-duration MC at the empirical σ for the regime
 *   - realized  = organic, regime-tagged, settled SHADOW pairs (if any) + within-15% gate
 *
 * Deliberately EXCLUDES deprecated/experimental cells and shadow noise. This is the
 * "what Foxify can expect" surface — distinct from the raw shadow position list (which
 * is paper/data-engine and NOT a forecast).
 *
 * Framing rule conveyed to the operator:
 *   - moderate+ ATM straddles are the PROFIT engine.
 *   - calm loss-leaders are a CAPPED COST (volume buy), not a profit line — shown as such.
 */

import type { Pool } from "pg";
import type { Regime } from "./featureFlag";
import { PHASE_0_CELLS, computeStrikes, PRODUCTION_CELLS, cellStatus, type TwoSidedCell } from "./cellConfig";
import { computeRealPricing, type SweepVenue } from "./cellSweep";
import { getRegimeCalibration } from "./regimeCalibration";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import { getRealizedShadowStats } from "./realizedVsMc";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

export type FoxifyEconomicsRow = {
  cell_id: string;
  status: string;
  role: "profit_engine" | "loss_leader_cost";  // calm loss-leaders are a cost, not profit
  structure: string;
  notional_usdc_per_leg: number;
  tenor_days: number;
  cost_usdc: number | null;
  mc_mean_net_usdc: number | null;
  mc_median_net_usdc: number | null;
  mc_p5_net_usdc: number | null;
  mc_p95_net_usdc: number | null;
  mc_pct_profitable: number | null;
  realized_n: number;
  realized_mean_net_usdc: number | null;
  realized_pct_profitable: number | null;
  within_15pct: boolean | null;
  validated: boolean;             // realized_n >= minValidated AND within_15pct
  mc_status: "ok" | "chain_unavailable" | "cell_not_in_config";
};

export type FoxifyEconomicsReport = {
  as_of: string;
  regime: Regime;
  spot: number;
  sigma_annual: number;
  min_validated_n: number;
  rows: FoxifyEconomicsRow[];
  framing: string[];
};

export const computeFoxifyEconomics = async (
  pool: Pool,
  opts: {
    regime: Regime;
    spot: number;
    liquidChainCache: LiquidChainCache;
    dvolService?: DvolService | null;
    venue?: SweepVenue;
    nPaths?: number;
    minValidatedN?: number;
    autoClosePnlPct?: number;
    autoCloseAbsoluteUsdc?: number;
    nowMs?: number;
  }
): Promise<FoxifyEconomicsReport> => {
  const nPaths = opts.nPaths ?? 2000;
  const minValidatedN = opts.minValidatedN ?? 10;
  const venue: SweepVenue = opts.venue ?? "auto";
  const autoClosePnlPct = opts.autoClosePnlPct ?? 0.30;
  const autoCloseAbsoluteUsdc = opts.autoCloseAbsoluteUsdc ?? 250;

  const calibration = await getRegimeCalibration(pool, { nowMs: opts.nowMs, bypassCache: true });
  const sigma = calibration[opts.regime].sigma;

  // Realized organic, regime-tagged, settled shadow stats (validation overlay).
  const realizedResult = await getRealizedShadowStats(pool, { regime: opts.regime, organicOnly: true });
  const realizedByCell = new Map(realizedResult.stats.map((s) => [s.cellId, s]));

  const rows: FoxifyEconomicsRow[] = [];
  for (const cellId of PRODUCTION_CELLS) {
    const cell: TwoSidedCell | undefined = PHASE_0_CELLS[cellId];
    const realized = realizedByCell.get(cellId);
    const baseRow: FoxifyEconomicsRow = {
      cell_id: cellId,
      status: cellStatus(cellId),
      role: cellId.includes("5otm_strangle") ? "loss_leader_cost" : "profit_engine",
      structure: cell?.structure ?? "unknown",
      notional_usdc_per_leg: cell?.notionalUsdcPerLeg ?? 0,
      tenor_days: cell?.hedgeTenorDays ?? 0,
      cost_usdc: null,
      mc_mean_net_usdc: null, mc_median_net_usdc: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_pct_profitable: null,
      realized_n: realized?.n ?? 0,
      realized_mean_net_usdc: realized?.meanRealizedNetUsdc ?? null,
      realized_pct_profitable: realized?.pctProfitable ?? null,
      within_15pct: null,
      validated: false,
      mc_status: cell ? "ok" : "cell_not_in_config"
    };
    if (!cell) { rows.push(baseRow); continue; }

    const { putStrike, callStrike } = computeStrikes(cell, opts.spot);
    const pricing = computeRealPricing(
      opts.spot, putStrike, callStrike, cell.contractsBtc, cell.hedgeTenorDays,
      opts.liquidChainCache, opts.dvolService ?? null, venue
    );
    if (!pricing) { baseRow.mc_status = "chain_unavailable"; rows.push(baseRow); continue; }

    const mc = await runFoxifyDurationMc({
      cellId, spot: opts.spot, hedgeCostUsdc: pricing.hedgeCostUsdc,
      putStrike, callStrike, tenorDays: cell.hedgeTenorDays,
      triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
      regime: opts.regime, sigmaAnnual: sigma, contractsBtc: cell.contractsBtc,
      autoClosePnlPct, autoCloseAbsoluteUsdc,
      salvageRealismMultiplier: pricing.salvageRealismMultiplier, nPaths, barsOverride: null
    });
    baseRow.cost_usdc = +pricing.hedgeCostUsdc.toFixed(2);
    baseRow.mc_mean_net_usdc = +mc.meanFoxifyNetUsdc.toFixed(2);
    baseRow.mc_median_net_usdc = +mc.medianFoxifyNetUsdc.toFixed(2);
    baseRow.mc_p5_net_usdc = +mc.p5FoxifyNetUsdc.toFixed(2);
    baseRow.mc_p95_net_usdc = +mc.p95FoxifyNetUsdc.toFixed(2);
    baseRow.mc_pct_profitable = +mc.pctProfitable.toFixed(4);

    if (realized && realized.n > 0 && baseRow.mc_mean_net_usdc != null) {
      const delta = Math.abs(realized.meanRealizedNetUsdc - baseRow.mc_mean_net_usdc);
      baseRow.within_15pct = delta <= 0.15 * Math.abs(baseRow.mc_mean_net_usdc) || delta <= 5;
      baseRow.validated = realized.n >= minValidatedN && baseRow.within_15pct === true;
    }
    rows.push(baseRow);
  }

  return {
    as_of: new Date(opts.nowMs ?? Date.now()).toISOString(),
    regime: opts.regime,
    spot: opts.spot,
    sigma_annual: +sigma.toFixed(4),
    min_validated_n: minValidatedN,
    rows,
    framing: [
      "PRODUCTION cells only — deprecated/experimental cells and raw shadow pairs are excluded. This is the 'expected economics' surface, NOT the shadow position list.",
      "profit_engine = moderate+ ATM straddles (the strategy's profit driver). loss_leader_cost = calm budgeted strangles, a CAPPED volume-buy cost (expected small negative), NOT a profit line.",
      "cost = real chain pricing; MC mean/%-profitable at the empirical σ for the regime; realized = organic, regime-tagged, settled shadow pairs.",
      `validated = realized_n >= ${minValidatedN} AND realized within 15% of MC. Until validated, treat MC as a projection, not a promise.`
    ]
  };
};
