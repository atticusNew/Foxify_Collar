/**
 * Iron-condor Monte Carlo (Phase 7 modeling — short premium / income to cover
 * Foxify's perp friction).
 *
 * Context: Foxify runs a delta-neutral perp pair and closes both legs when the
 * winning leg takes profit. They do NOT need the option to protect the losing
 * leg — they need it to generate ~$200-300 of INCOME to cover the pair's
 * round-trip fees+slippage. A short iron condor collects a net credit up front
 * and profits from time decay while price stays range-bound (calm's friend).
 *
 * Structure (4 legs):
 *   SELL put  @ Kp1 (inner)   BUY put  @ Kp2 (outer, < Kp1)   → put credit spread
 *   SELL call @ Kc1 (inner)   BUY call @ Kc2 (outer, > Kc1)   → call credit spread
 *   net credit C = (Kp1 bid - Kp2 ask) + (Kc1 bid - Kc2 ask), per BTC × contracts.
 *
 * Per tick we value the cost to BUY BACK the condor (close it) via Black-Scholes
 * at the simulated spot; P&L = C - buyback. Exits (operator-confirmed semantics):
 *   - PROFIT TARGET: P&L >= profitTargetUsdc  → close (covers friction) ["target"]
 *   - TRAILING STOP: P&L <= peakPnL - trailStopUsdc → close (controlled loss) ["trail_stop"]
 *   - EXPIRY: settle at intrinsic (loss capped structurally by the wings) ["expiry"]
 *
 * REAL-anchored: entryCredit is priced from real chain bid/ask upstream; the
 * per-tick buyback uses BS × realismMultiplier (same approach as the straddle MC,
 * since simulated future spots have no live quote).
 */

import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";
import {
  generateBootstrapPath, generateGbmPath, load5MinBars, mulberry32, type PathConfig
} from "../../../scripts/backtest/singleSide/monteCarloEngine";
import { RISK_FREE_RATE } from "./optionPricing";

const BAR_MINUTES = 5;
const RFR = RISK_FREE_RATE;
const MS_PER_YEAR = 365 * 86_400_000;

export type IronCondorExitMode = "target" | "trail_stop" | "expiry";

export type IronCondorMcInputs = {
  cellId: string;
  spot: number;
  putShortStrike: number;   // Kp1 (sell)
  putLongStrike: number;    // Kp2 (buy, < Kp1)
  callShortStrike: number;  // Kc1 (sell)
  callLongStrike: number;   // Kc2 (buy, > Kc1)
  tenorDays: number;
  regime: "calm" | "moderate" | "elevated" | "stress";
  sigmaAnnual: number;
  contractsBtc: number;
  /** Net credit received at entry (USDC, total, real-priced upstream). */
  entryCreditUsdc: number;
  /** Close when condor P&L >= this (the cover-friction target). */
  profitTargetUsdc: number;
  /** Close when P&L falls this far below its running peak (trailing stop). */
  trailStopUsdc: number;
  /** BS→real adjustment for per-tick buyback valuation (default 1.0). */
  realismMultiplier?: number;
  /** Atticus split (Foxify keeps this fraction of positive uplift). */
  atticusSplitPct?: number;
  atticusFloorUsdc?: number;
  nPaths?: number;
  seed?: number;
  barsOverride?: { highs: number[]; lows: number[]; closes: number[] } | null;
};

export type IronCondorMcResult = {
  meanFoxifyNetUsdc: number;
  medianFoxifyNetUsdc: number;
  p5FoxifyNetUsdc: number;
  p95FoxifyNetUsdc: number;
  pctProfitable: number;
  entryCreditUsdc: number;
  maxProfitUsdc: number;       // = entryCredit
  maxLossUsdc: number;         // structural cap (spread width - credit)
  exitDistribution: Record<IronCondorExitMode, number>;
  meanTicksToExit: number;
  nPaths: number;
  pathGenerator: "bootstrap" | "gbm";
};

const median = (s: number[]): number => s.length === 0 ? 0 : (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
const percentile = (s: number[], p: number): number => s.length === 0 ? 0 : s[Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)))];
const mean = (a: number[]): number => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/** Cost to buy back (close) the condor at spot S with remaining tenor (per-BTC × contracts × realism). */
const condorBuyback = (
  S: number, inp: IronCondorMcInputs, remMs: number, realism: number
): number => {
  const T = Math.max(0, remMs / MS_PER_YEAR);
  const sig = inp.sigmaAnnual;
  const callSpread = Math.max(0, bsCall(S, inp.callShortStrike, T, RFR, sig) - bsCall(S, inp.callLongStrike, T, RFR, sig));
  const putSpread = Math.max(0, bsPut(S, inp.putShortStrike, T, RFR, sig) - bsPut(S, inp.putLongStrike, T, RFR, sig));
  return (callSpread + putSpread) * inp.contractsBtc * realism;
};

export const runIronCondorMc = async (inp: IronCondorMcInputs): Promise<IronCondorMcResult> => {
  const nPaths = inp.nPaths ?? 2_000;
  const realism = inp.realismMultiplier ?? 1.0;
  const seed = inp.seed ?? 42;
  const splitPct = inp.atticusSplitPct ?? Number(process.env.SS_ATTICUS_SPLIT_PCT ?? "0.85");
  const floorUsdc = inp.atticusFloorUsdc ?? Number(process.env.SS_ATTICUS_FLOOR_USDC ?? "25");
  const credit = inp.entryCreditUsdc;

  // Structural caps: max profit = credit; max loss = wider spread width - credit.
  const callWidth = (inp.callLongStrike - inp.callShortStrike) * inp.contractsBtc;
  const putWidth = (inp.putShortStrike - inp.putLongStrike) * inp.contractsBtc;
  const maxLossUsdc = Math.max(callWidth, putWidth) - credit;

  const bars = inp.barsOverride ?? (inp.regime === "calm" ? await load5MinBars().catch(() => null) : null);
  const pathConfig: PathConfig = {
    tenorDays: inp.tenorDays, sigmaAnnual: inp.sigmaAnnual, driftAnnual: 0,
    generator: inp.regime === "calm" && bars ? "bootstrap" : "gbm", seed
  };
  const rng = mulberry32(seed);

  const settle = (uplift: number): number => {
    if (uplift <= 0) return uplift; // full loss to Foxify (no Atticus share on losses)
    const atticus = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
    return uplift - atticus; // Foxify net
  };

  const nets: number[] = [];
  const exitTicks: number[] = [];
  const exitCounts: Record<IronCondorExitMode, number> = { target: 0, trail_stop: 0, expiry: 0 };

  for (let p = 0; p < nPaths; p++) {
    const path = bars && inp.regime === "calm"
      ? generateBootstrapPath(inp.spot, pathConfig, bars, rng)
      : generateGbmPath(inp.spot, pathConfig, rng);
    const n = path.closes.length;
    let peak = 0;
    let exited = false;
    let pnl = 0;
    let exitMode: IronCondorExitMode = "expiry";
    let exitedAt = n - 1;

    for (let i = 1; i < n; i++) {
      const remMs = (n - 1 - i) * BAR_MINUTES * 60_000;
      pnl = credit - condorBuyback(path.closes[i], inp, remMs, realism);
      if (pnl > peak) peak = pnl;
      if (pnl >= inp.profitTargetUsdc) { exitMode = "target"; exitedAt = i; exited = true; break; }
      // Trailing stop: give back trailStop from the peak (covers both "never profitable"
      // when peak≈0 → stop at -trailStop, and "gave back gains" when peak>0).
      if (pnl <= Math.max(peak, 0) - inp.trailStopUsdc) { exitMode = "trail_stop"; exitedAt = i; exited = true; break; }
    }
    if (!exited) {
      // Expiry: intrinsic buyback (loss capped structurally by the wings)
      pnl = credit - condorBuyback(path.closes[n - 1], inp, 0, realism);
      exitMode = "expiry"; exitedAt = n - 1;
    }
    nets.push(settle(pnl));
    exitTicks.push(exitedAt);
    exitCounts[exitMode]++;
  }

  const sorted = [...nets].sort((a, b) => a - b);
  return {
    meanFoxifyNetUsdc: mean(nets),
    medianFoxifyNetUsdc: median(sorted),
    p5FoxifyNetUsdc: percentile(sorted, 0.05),
    p95FoxifyNetUsdc: percentile(sorted, 0.95),
    pctProfitable: nets.filter((x) => x > 0).length / nets.length,
    entryCreditUsdc: credit,
    maxProfitUsdc: credit,
    maxLossUsdc,
    exitDistribution: {
      target: exitCounts.target / nPaths,
      trail_stop: exitCounts.trail_stop / nPaths,
      expiry: exitCounts.expiry / nPaths
    },
    meanTicksToExit: mean(exitTicks),
    nPaths,
    pathGenerator: bars && inp.regime === "calm" ? "bootstrap" : "gbm"
  };
};
