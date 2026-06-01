/**
 * Breakeven-DVOL ladder (Phase 2 — calm loss-leader decision input).
 *
 * For one candidate cell, runs the Foxify-duration MC across a ladder of DVOL
 * levels (each → an annualized sigma) at the REAL current chain cost, and reports
 * the mean Foxify net at each level plus the interpolated BREAKEVEN DVOL — the
 * vol level at which the cell crosses from loss to profit.
 *
 * This is the signal the bot/CEO needs for the "calm loss-leader" decision:
 *   - Below breakeven_dvol the cell is a loss-leader (loss ≈ |net|, bounded by the
 *     premium it paid); the loss SHRINKS as DVOL rises toward breakeven.
 *   - At/above breakeven_dvol the cell is net-positive.
 *
 * REAL-anchored: cost + salvage realism come from computeRealPricing (live chain).
 * Only the current-DVOL rung is strictly "real tier"; higher rungs adapt sigma but
 * reuse today's chain cost, so they are directional (what the cell WOULD do at that
 * vol given current pricing) — exactly what a forward-looking activation decision needs.
 */

import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";
import { computeRealPricing, type SweepVenue } from "./cellSweep";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import { classifyRegime } from "./featureFlag";

const STRIKE_GRID = 1000;
const snap = (x: number): number => Math.round(x / STRIKE_GRID) * STRIKE_GRID;

export type BreakevenLadderInputs = {
  spot: number;
  notionalUsdcPerLeg: number;
  /** Negative = OTM (matches cellConfig/sweep convention). Ignored for straddle. */
  strikeMoneynessPct: number;
  tenorDays: number;
  structure: "straddle" | "strangle";
  triggerPct: number;
  autoClosePnlPct: number;
  autoCloseAbsoluteUsdc: number;
  /** DVOL ladder, e.g. [30, 35, 40, 45, 50]. */
  dvols: number[];
  liquidChainCache: LiquidChainCache;
  dvolService?: DvolService | null;
  venue?: SweepVenue;
  nPaths?: number;
  perpPairFrictionUsdc?: number;
  seed?: number;
};

export type BreakevenLadderRung = {
  dvol: number; sigma: number; regime: string;
  net_usdc: number; pct_profitable: number; net_after_friction_usdc: number;
};

export type BreakevenLadderResult =
  | {
      ok: true;
      spot: number; contracts_btc: number; put_strike: number; call_strike: number;
      cost_per_pair_usdc: number; structure: string; tenor_days: number; perp_pair_friction_usdc: number;
      ladder: BreakevenLadderRung[];
      breakeven_dvol: number | null;
      note: string;
    }
  | { ok: false; error: string };

export const computeBreakevenLadder = async (inp: BreakevenLadderInputs): Promise<BreakevenLadderResult> => {
  const contractsBtc = +(inp.notionalUsdcPerLeg / inp.spot).toFixed(3);
  const putStrike = inp.structure === "straddle" ? snap(inp.spot) : snap(inp.spot * (1 + inp.strikeMoneynessPct));
  const callStrike = inp.structure === "straddle" ? snap(inp.spot) : snap(inp.spot * (1 - inp.strikeMoneynessPct));
  const pricing = computeRealPricing(
    inp.spot, putStrike, callStrike, contractsBtc, inp.tenorDays,
    inp.liquidChainCache, inp.dvolService ?? null, inp.venue ?? "auto"
  );
  if (!pricing) return { ok: false, error: "chain_unavailable" };

  const friction = inp.perpPairFrictionUsdc ?? 0;
  const nPaths = inp.nPaths ?? 800;
  const dvols = [...new Set(inp.dvols)].sort((a, b) => a - b);
  const ladder: BreakevenLadderRung[] = [];
  for (const dvol of dvols) {
    const sigma = dvol / 100;
    const mc = await runFoxifyDurationMc({
      cellId: `ladder_${dvol}`, spot: inp.spot, hedgeCostUsdc: pricing.hedgeCostUsdc,
      putStrike, callStrike, tenorDays: inp.tenorDays,
      triggerPctDown: inp.triggerPct, triggerPctUp: inp.triggerPct,
      regime: classifyRegime(dvol), sigmaAnnual: sigma, contractsBtc,
      autoClosePnlPct: inp.autoClosePnlPct, autoCloseAbsoluteUsdc: inp.autoCloseAbsoluteUsdc,
      salvageRealismMultiplier: pricing.salvageRealismMultiplier, nPaths, barsOverride: null,
      seed: inp.seed
    });
    ladder.push({
      dvol, sigma, regime: classifyRegime(dvol),
      net_usdc: +mc.meanFoxifyNetUsdc.toFixed(2),
      pct_profitable: +mc.pctProfitable.toFixed(4),
      net_after_friction_usdc: +(mc.meanFoxifyNetUsdc - friction).toFixed(2)
    });
  }

  // Breakeven DVOL: lowest DVOL where net crosses >= 0, linearly interpolated.
  let breakeven: number | null = null;
  for (let i = 0; i < ladder.length; i++) {
    if (ladder[i].net_usdc >= 0) {
      if (i === 0) breakeven = ladder[0].dvol;
      else {
        const lo = ladder[i - 1], hi = ladder[i];
        const frac = hi.net_usdc === lo.net_usdc ? 0 : (0 - lo.net_usdc) / (hi.net_usdc - lo.net_usdc);
        breakeven = +(lo.dvol + frac * (hi.dvol - lo.dvol)).toFixed(1);
      }
      break;
    }
  }

  return {
    ok: true,
    spot: inp.spot, contracts_btc: contractsBtc, put_strike: putStrike, call_strike: callStrike,
    cost_per_pair_usdc: +pricing.hedgeCostUsdc.toFixed(2), structure: inp.structure, tenor_days: inp.tenorDays,
    perp_pair_friction_usdc: +friction.toFixed(2), ladder, breakeven_dvol: breakeven,
    note: "Net vs DVOL at REAL current cost. breakeven_dvol = interpolated DVOL where mean Foxify net crosses 0 (loss->profit). Below it the cell is a loss-leader (loss bounded by the premium). Only the current-DVOL rung is strictly real-tier; higher rungs adapt sigma on today's chain cost (directional)."
  };
};
