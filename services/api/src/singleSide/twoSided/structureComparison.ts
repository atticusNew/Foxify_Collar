/**
 * Structure comparison — runs the SAME cell + regime + real chain through multiple hedge
 * structures (two-sided straddle vs one-sided put/call vs collar) and returns them
 * side-by-side, so the operator can answer "is a one-sided / collar hedge better for
 * Foxify's directional bet than paying full two-sided premium + theta every time?"
 *
 * Pure-ish: real pricing (computeRealPricing) + Foxify-duration MC per structure. Models
 * the HEDGE OPTION LEGS only (approach A) — the protected position is Foxify's own P&L.
 */

import type { Pool } from "pg";
import type { Regime } from "./featureFlag";
import { PHASE_0_CELLS, computeStrikes, type TwoSidedCell } from "./cellConfig";
import { computeRealPricing, type SweepVenue } from "./cellSweep";
import { getRegimeCalibration } from "./regimeCalibration";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import { structureCostAndRealism, theta1dUsdc, type OptionStructure, type LegPrices } from "./optionStructures";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

const COMPARE_STRUCTURES: OptionStructure[] = [
  "straddle", "one_sided_put", "one_sided_call", "collar", "vertical_spread_call", "vertical_spread_put"
];

const roleOf = (s: OptionStructure): string =>
  s === "straddle" ? "two_sided (movement insurance — pays either direction)"
    : s === "one_sided_put" ? "directional: DOWN-protection (long put)"
    : s === "one_sided_call" ? "directional: UP-protection (long call)"
    : s === "collar" ? "directional collar (long put − short call; ~zero theta, capped)"
    : s === "vertical_spread_call" ? "directional UP debit spread (long call − short OTM call; cheap, low theta, capped)"
    : s === "vertical_spread_put" ? "directional DOWN debit spread (long put − short OTM put; cheap, low theta, capped)"
    : s;

export type StructureComparisonRow = {
  structure: OptionStructure;
  role: string;
  short_strike: number | null;         // OTM short-leg strike for spreads (null otherwise)
  net_cost_usdc: number | null;
  theta_1d_usdc: number | null;        // value lost in 1 day at flat spot (the bleed)
  mc_mean_net_usdc: number | null;
  mc_pct_profitable: number | null;
  mc_p5_net_usdc: number | null;
  mc_p95_net_usdc: number | null;
  mc_status: "ok" | "chain_unavailable";
};

export type StructureComparisonReport = {
  as_of: string;
  cell_id: string;
  regime: Regime;
  spot: number;
  sigma_annual: number;
  put_strike: number;
  call_strike: number;
  rows: StructureComparisonRow[];
  framing: string[];
};

export const compareStructures = async (
  pool: Pool,
  opts: {
    cellId: string;
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
): Promise<StructureComparisonReport> => {
  const cell: TwoSidedCell | undefined = PHASE_0_CELLS[opts.cellId];
  if (!cell) throw new Error(`unknown cell '${opts.cellId}'`);
  const nPaths = opts.nPaths ?? 2000;
  const venue: SweepVenue = opts.venue ?? "auto";
  const autoClosePnlPct = opts.autoClosePnlPct ?? 0.30;
  const autoCloseAbsoluteUsdc = opts.autoCloseAbsoluteUsdc ?? 250;

  const calibration = await getRegimeCalibration(pool, { nowMs: opts.nowMs, bypassCache: true });
  const sigma = calibration[opts.regime].sigma;
  const { putStrike, callStrike } = computeStrikes(cell, opts.spot);
  const pricing = computeRealPricing(
    opts.spot, putStrike, callStrike, cell.contractsBtc, cell.hedgeTenorDays,
    opts.liquidChainCache, opts.dvolService ?? null, venue
  );

  const rows: StructureComparisonRow[] = [];
  for (const structure of COMPARE_STRUCTURES) {
    if (!pricing) {
      rows.push({ structure, role: roleOf(structure), short_strike: null, net_cost_usdc: null, theta_1d_usdc: null, mc_mean_net_usdc: null, mc_pct_profitable: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_status: "chain_unavailable" });
      continue;
    }
    // For vertical spreads, price the OTM SHORT leg at the cell's trigger distance and
    // fold it into the leg prices. shortStrike: up-trigger for a call spread, down-trigger
    // for a put spread (the spread "bets" on a move up to the trigger).
    let shortStrike: number | undefined;
    let legs: LegPrices = pricing;
    if (structure === "vertical_spread_call") {
      shortStrike = Math.round(opts.spot * (1 + cell.triggerPctUp));
      const sp = computeRealPricing(opts.spot, shortStrike, shortStrike, cell.contractsBtc, cell.hedgeTenorDays, opts.liquidChainCache, opts.dvolService ?? null, venue);
      if (!sp) { rows.push({ structure, role: roleOf(structure), short_strike: shortStrike, net_cost_usdc: null, theta_1d_usdc: null, mc_mean_net_usdc: null, mc_pct_profitable: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_status: "chain_unavailable" }); continue; }
      legs = { ...pricing, shortAskPerBtc: sp.callAskPerBtc, shortBidPerBtc: sp.callBidPerBtc, shortBsPerBtc: sp.bsCallPerBtc };
    } else if (structure === "vertical_spread_put") {
      shortStrike = Math.round(opts.spot * (1 - cell.triggerPctDown));
      const sp = computeRealPricing(opts.spot, shortStrike, shortStrike, cell.contractsBtc, cell.hedgeTenorDays, opts.liquidChainCache, opts.dvolService ?? null, venue);
      if (!sp) { rows.push({ structure, role: roleOf(structure), short_strike: shortStrike, net_cost_usdc: null, theta_1d_usdc: null, mc_mean_net_usdc: null, mc_pct_profitable: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_status: "chain_unavailable" }); continue; }
      legs = { ...pricing, shortAskPerBtc: sp.putAskPerBtc, shortBidPerBtc: sp.putBidPerBtc, shortBsPerBtc: sp.bsPutPerBtc };
    }
    const { hedgeCostUsdc, salvageRealismMultiplier } = structureCostAndRealism(legs, structure, cell.contractsBtc);
    const theta = theta1dUsdc(structure, opts.spot, putStrike, callStrike, cell.contractsBtc, cell.hedgeTenorDays, sigma, salvageRealismMultiplier, shortStrike);
    const mc = await runFoxifyDurationMc({
      cellId: opts.cellId, spot: opts.spot, hedgeCostUsdc, putStrike, callStrike,
      tenorDays: cell.hedgeTenorDays, triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
      regime: opts.regime, sigmaAnnual: sigma, contractsBtc: cell.contractsBtc,
      autoClosePnlPct, autoCloseAbsoluteUsdc, salvageRealismMultiplier, nPaths,
      structure, shortStrike, barsOverride: null
    });
    rows.push({
      structure,
      role: roleOf(structure),
      short_strike: shortStrike ?? null,
      net_cost_usdc: +hedgeCostUsdc.toFixed(2),
      theta_1d_usdc: theta,
      mc_mean_net_usdc: +mc.meanFoxifyNetUsdc.toFixed(2),
      mc_pct_profitable: +mc.pctProfitable.toFixed(4),
      mc_p5_net_usdc: +mc.p5FoxifyNetUsdc.toFixed(2),
      mc_p95_net_usdc: +mc.p95FoxifyNetUsdc.toFixed(2),
      mc_status: "ok"
    });
  }

  return {
    as_of: new Date(opts.nowMs ?? Date.now()).toISOString(),
    cell_id: opts.cellId,
    regime: opts.regime,
    spot: opts.spot,
    sigma_annual: +sigma.toFixed(4),
    put_strike: putStrike,
    call_strike: callStrike,
    rows,
    framing: [
      "Models the HEDGE OPTION LEGS only (approach A) — the protected directional position is Foxify's own P&L, not modeled here.",
      "net_cost = entry premium. straddle = full two-sided premium; one-sided ≈ half; collar ≈ put−call (often ~0 or a credit).",
      "theta_1d = value lost in ONE day at flat spot — the 'guaranteed-losing hedge' bleed. straddle bleeds most; one-sided ~half; collar ≈ 0 (short-call decay offsets the long put).",
      "vertical spreads (debit) = long leg − short OTM leg at the trigger distance: cheap, low theta, directional, payoff CAPPED at the strike width. Best vehicle when the edge is 'right on direction more often than not' rather than 'a big move is coming'.",
      "mc_* = Foxify-duration MC at the regime σ. one-sided/collar/spreads are DIRECTIONAL; the straddle pays either direction.",
      "UPSIDE IS SENSITIVE TO auto_close_pct/abs: the MC banks winners at the auto-close threshold (default +30%), which CLIPS a long option's convex tail. For a directional long bet, pass a HIGHER auto_close_pct to see the true upside; spreads are inherently capped so they're less sensitive.",
      "Read it as: if Foxify has a directional view, one-sided/spread/collar deliver protection far cheaper (less/no theta) at the cost of being directional — exactly the trade-off being evaluated."
    ]
  };
};
