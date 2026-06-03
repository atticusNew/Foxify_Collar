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
import { computeRealPricing, priceCandidateLeg, type SweepVenue } from "./cellSweep";
import { getRegimeCalibration } from "./regimeCalibration";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import { structureCostAndRealism, theta1dUsdc, favoredDirection, type OptionStructure, type LegPrices } from "./optionStructures";
import { driftAnnualFromWinRate } from "./mathUtils";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

const COMPARE_STRUCTURES: OptionStructure[] = [
  "straddle", "one_sided_put", "one_sided_call", "collar",
  "vertical_spread_call", "vertical_spread_put",
  "credit_spread_put", "credit_spread_call", "short_strangle"
];

const roleOf = (s: OptionStructure): string =>
  s === "straddle" ? "two_sided (movement insurance — pays either direction)"
    : s === "one_sided_put" ? "directional: DOWN bet (long put)"
    : s === "one_sided_call" ? "directional: UP bet (long call)"
    : s === "collar" ? "directional collar (long put − short call; ~zero theta, capped)"
    : s === "vertical_spread_call" ? "UP debit spread (long call − short OTM call; cheap, capped)"
    : s === "vertical_spread_put" ? "DOWN debit spread (long put − short OTM put; cheap, capped)"
    : s === "credit_spread_put" ? "UP credit spread (short put − long OTM put; COLLECT premium, win if up/flat, capped)"
    : s === "credit_spread_call" ? "DOWN credit spread (short call − long OTM call; COLLECT premium, win if down/flat, capped)"
    : s === "short_strangle" ? "SHORT premium (sell put+call; VRP harvest, non-directional, tail risk)"
    : s;

export type StructureComparisonRow = {
  structure: OptionStructure;
  role: string;
  short_strike: number | null;         // OTM short-leg strike for spreads (null otherwise)
  note?: string;                        // why a row is unavailable (e.g. short leg not quoted)
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
  directional_win_rate: number;
  frictionless: boolean;
  drift_annual_magnitude: number;   // |drift| applied to directional structures (signed by side)
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
    /** Foxify directional hit-rate (0.5 = no edge). Maps to a signed drift per structure. */
    directionalWinRate?: number;
    /** Trade at mid, no haircut, no Atticus floor/split (pure structure EV). */
    frictionless?: boolean;
    nowMs?: number;
  }
): Promise<StructureComparisonReport> => {
  const cell: TwoSidedCell | undefined = PHASE_0_CELLS[opts.cellId];
  if (!cell) throw new Error(`unknown cell '${opts.cellId}'`);
  const nPaths = opts.nPaths ?? 2000;
  const venue: SweepVenue = opts.venue ?? "auto";
  // Default: NO auto-close (run to trigger/expiry) — early-close clips a directional bet's
  // payoff. Operator can still pass explicit thresholds to re-enable it.
  const autoClosePnlPct = opts.autoClosePnlPct ?? 1e9;
  const autoCloseAbsoluteUsdc = opts.autoCloseAbsoluteUsdc ?? 1e12;
  const winRate = opts.directionalWinRate ?? 0.5;
  const frictionless = opts.frictionless === true;

  const calibration = await getRegimeCalibration(pool, { nowMs: opts.nowMs, bypassCache: true });
  const sigma = calibration[opts.regime].sigma;
  const driftMag = driftAnnualFromWinRate(winRate, sigma, cell.hedgeTenorDays);
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
    // Wing leg (OTM) for spreads — same strike whether it's the SHORT leg (debit) or the
    // LONG leg (credit). Priced single-leg (computeRealPricing needs both put+call; the ITM
    // side of an OTM strike is often illiquid). Snap to the $500 grid to hit a real quote.
    const snap500 = (x: number): number => Math.round(x / 500) * 500;
    const needsCallWing = structure === "vertical_spread_call" || structure === "credit_spread_call";
    const needsPutWing = structure === "vertical_spread_put" || structure === "credit_spread_put";
    if (needsCallWing) {
      shortStrike = snap500(opts.spot * (1 + cell.triggerPctUp));
      const sl = priceCandidateLeg(opts.spot, shortStrike, "call", cell.hedgeTenorDays, cell.contractsBtc, opts.liquidChainCache, opts.dvolService ?? null, venue);
      if (sl.askPerBtc == null || sl.bidPerBtc == null) { rows.push({ structure, role: roleOf(structure), short_strike: shortStrike, note: `wing CALL @ ${shortStrike} has no live quote (venue=${venue})`, net_cost_usdc: null, theta_1d_usdc: null, mc_mean_net_usdc: null, mc_pct_profitable: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_status: "chain_unavailable" }); continue; }
      legs = { ...pricing, shortAskPerBtc: sl.askPerBtc, shortBidPerBtc: sl.bidPerBtc, shortBsPerBtc: sl.bsPerBtc };
    } else if (needsPutWing) {
      shortStrike = snap500(opts.spot * (1 - cell.triggerPctDown));
      const sl = priceCandidateLeg(opts.spot, shortStrike, "put", cell.hedgeTenorDays, cell.contractsBtc, opts.liquidChainCache, opts.dvolService ?? null, venue);
      if (sl.askPerBtc == null || sl.bidPerBtc == null) { rows.push({ structure, role: roleOf(structure), short_strike: shortStrike, note: `wing PUT @ ${shortStrike} has no live quote (venue=${venue})`, net_cost_usdc: null, theta_1d_usdc: null, mc_mean_net_usdc: null, mc_pct_profitable: null, mc_p5_net_usdc: null, mc_p95_net_usdc: null, mc_status: "chain_unavailable" }); continue; }
      legs = { ...pricing, shortAskPerBtc: sl.askPerBtc, shortBidPerBtc: sl.bidPerBtc, shortBsPerBtc: sl.bsPerBtc };
    }
    const { hedgeCostUsdc, salvageRealismMultiplier } = structureCostAndRealism(legs, structure, cell.contractsBtc, frictionless);
    const theta = theta1dUsdc(structure, opts.spot, putStrike, callStrike, cell.contractsBtc, cell.hedgeTenorDays, sigma, salvageRealismMultiplier, shortStrike);
    // Directional edge → signed drift in the structure's favored direction (0 for non-directional).
    const driftAnnual = favoredDirection(structure) * driftMag;
    const mc = await runFoxifyDurationMc({
      cellId: opts.cellId, spot: opts.spot, hedgeCostUsdc, putStrike, callStrike,
      tenorDays: cell.hedgeTenorDays, triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
      regime: opts.regime, sigmaAnnual: sigma, contractsBtc: cell.contractsBtc,
      autoClosePnlPct, autoCloseAbsoluteUsdc, salvageRealismMultiplier, nPaths,
      structure, shortStrike, driftAnnual,
      // Frictionless: keep 100% (no Atticus split/floor) + no exit haircut.
      bidSlipHaircut: frictionless ? 1.0 : undefined,
      atticusFloorUsdc: frictionless ? 0 : undefined,
      atticusSplitPct: frictionless ? 1.0 : undefined,
      barsOverride: null
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
    directional_win_rate: winRate,
    frictionless,
    drift_annual_magnitude: +driftMag.toFixed(4),
    rows,
    framing: [
      "RESEARCH ONLY — read-only model. Short-premium structures are NOT executable/activatable; nothing here touches live positions.",
      `Directional EDGE: win_rate=${winRate} → the path drifts in each structure's favored direction (mc reflects Foxify being right that fraction of the time). 0.5 = no edge.`,
      frictionless ? "FRICTIONLESS: traded at mid (no spread), no haircut, Foxify keeps 100% (no Atticus split/floor) — pure structure EV." : "Realistic frictions ON (ask/bid spread, haircut, Atticus split).",
      "Auto-close OFF by default (runs to trigger/expiry) so a directional bet's payoff isn't clipped. mc_* = Foxify-duration MC at the regime σ.",
      "DEBIT spreads (vertical_*) = long − short OTM: cheap, capped, directional. CREDIT spreads (credit_*) = short − long OTM: COLLECT premium, win if right-or-flat, capped risk — the natural fit for a 'right-direction-often' edge. short_strangle = pure VRP harvest (non-directional, tail risk).",
      "Compare across regimes: long structures tend to +EV only where realized > implied (elevated/stress); credit/short structures harvest the VRP and can be +EV in calmer regimes."
    ]
  };
};
