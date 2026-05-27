/**
 * Monte Carlo simulation engine for the cooperative single-side model.
 *
 * Two path generators:
 *   1. Block bootstrap (recommended) — sample sequential 5-min returns from
 *      historical BTC data. Captures real fat tails, vol clustering, intraday
 *      patterns. Most realistic for empirical proof.
 *   2. GBM (analytical baseline) — log-normal random walk at calibrated σ.
 *      Useful for sanity check / stress test at synthetic σ levels.
 *
 * Per path: simulate spot evolution at 5-min granularity over the cover's
 * full hedge tenor, detect trigger fire (high/low crosses boundary), apply
 * theta-aware TP rules to compute realized salvage value.
 *
 * Cooperative split economics:
 *   - Foxify funds hedge cost upfront (capital deployed)
 *   - At cover close: salvage proceeds split per ratio
 *   - Atticus also earns flat per-cover operating fee
 *   - Foxify net = -hedge_cost + foxify_share × salvage - operating_fee
 *   - Atticus net = atticus_share × salvage + operating_fee
 *     where shares apply only to salvage above hedge cost, OR to total
 *     salvage proceeds (configurable)
 */

import * as fs from "node:fs/promises";
import { bsPut, bsCall } from "./coreEngine";

const RFR = 0.045;
const BAR_MINUTES = 5;
const BARS_PER_HOUR = 60 / BAR_MINUTES; // 12
const BARS_PER_DAY = BARS_PER_HOUR * 24; // 288

// ─────────────────────────── Types ───────────────────────────

export type PathConfig = {
  /** Total simulation tenor in days (matches cell hedge tenor) */
  tenorDays: number;
  /** Annualized σ for GBM (calibrated to live DVOL). Ignored for bootstrap. */
  sigmaAnnual: number;
  /** Drift μ — typically 0 for risk-neutral, or small value for empirical */
  driftAnnual: number;
  /** Path generator: "bootstrap" or "gbm" */
  generator: "bootstrap" | "gbm";
  /** Optional seed for reproducibility */
  seed?: number;
};

export type CoverConfig = {
  cellId: string;
  spotEntry: number;
  triggerPct: number;
  hedgePct: number;
  payoutUsdc: number; // not used in cost-pass-through model (informational)
  contractsBtc: number;
  /** Strike snapped to grid (e.g. nearest $1k). If null, computed from spot × hedgePct */
  strikeUsdc: number | null;
  /** Direction: long-cover (Foxify long, hedge = put) or short-cover (Foxify short, hedge = call) */
  direction: "long" | "short";
  /** Empirical hedge cost (live ask × contracts × uplift). Foxify funds this upfront. */
  hedgeCostUsdc: number;
};

export type SplitConfig = {
  /** Atticus's share of salvage uplift (above hedge cost). 0.30 = 30%. */
  atticusUpliftShare: number;
  /** Whether split applies to (a) salvage above hedge cost only, or (b) total salvage */
  splitMode: "uplift_only" | "total_salvage";
  /** Per-cover flat operating fee Atticus charges (USD) */
  operatingFeeUsd: number;
};

export type PathOutcome = {
  triggered: boolean;
  triggerBarIdx: number | null;
  exitSpot: number;
  exitBarIdx: number;
  exitMode: string;
  salvageUsdc: number;
};

export type CoverPnl = {
  hedgeCost: number;
  salvage: number;
  uplift: number;
  operatingFee: number;
  foxifyNet: number;
  atticusNet: number;
};

// ─────────────────────────── Random helpers ───────────────────────────

/** Mulberry32 PRNG for reproducible runs */
export const mulberry32 = (seed: number) => {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Box-Muller standard normal */
const randNormal = (rng: () => number): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
};

// ─────────────────────────── Path generators ───────────────────────────

/**
 * GBM path generator: returns array of spot values (bars) starting at spotEntry.
 * Each step: spot_{t+1} = spot_t × exp((μ - σ²/2)dt + σ√dt × N(0,1)).
 * Returns 5-min spot path. We don't need full bar OHLC because trigger detection
 * uses spot crossings at 5-min resolution (close-to-close).
 */
export const generateGbmPath = (
  spotEntry: number,
  config: PathConfig,
  rng: () => number
): { closes: number[]; highs: number[]; lows: number[] } => {
  const totalBars = Math.ceil(config.tenorDays * BARS_PER_DAY);
  const dt = (BAR_MINUTES / 60 / 24) / 365; // bar dt in years
  const drift = (config.driftAnnual - 0.5 * config.sigmaAnnual ** 2) * dt;
  const vol = config.sigmaAnnual * Math.sqrt(dt);
  const closes: number[] = [spotEntry];
  const highs: number[] = [spotEntry];
  const lows: number[] = [spotEntry];
  let s = spotEntry;
  for (let i = 1; i <= totalBars; i++) {
    const z = randNormal(rng);
    s = s * Math.exp(drift + vol * z);
    closes.push(s);
    // Approximate intra-bar high/low using a Brownian bridge expectation.
    // For 5-min bars, intra-bar range ≈ |close-open| × 1.3 (empirical fudge).
    const open = closes[i - 1];
    const range = Math.abs(s - open) * 1.3;
    highs.push(Math.max(s, open) + range * 0.3);
    lows.push(Math.min(s, open) - range * 0.3);
  }
  return { closes, highs, lows };
};

/**
 * Block bootstrap path: sample a contiguous block of historical 5-min returns
 * starting at a random index, with overlap at boundaries to extend if needed.
 * Returns 5-min spot path scaled to spotEntry.
 */
export const generateBootstrapPath = (
  spotEntry: number,
  config: PathConfig,
  bars: { close: number; high: number; low: number; open: number }[],
  rng: () => number
): { closes: number[]; highs: number[]; lows: number[] } => {
  const totalBars = Math.ceil(config.tenorDays * BARS_PER_DAY);
  const startIdx = Math.floor(rng() * (bars.length - totalBars - 1));
  const closes: number[] = [spotEntry];
  const highs: number[] = [spotEntry];
  const lows: number[] = [spotEntry];
  for (let i = 1; i <= totalBars; i++) {
    const histPrev = bars[startIdx + i - 1].close;
    const histCurr = bars[startIdx + i].close;
    const histHigh = bars[startIdx + i].high;
    const histLow = bars[startIdx + i].low;
    const ret = histCurr / histPrev;
    const newClose = closes[i - 1] * ret;
    // Scale historical intra-bar high/low by current ratio
    const histRange = (histHigh - histLow) / histPrev;
    const newHigh = newClose + (newClose * histRange) / 2;
    const newLow = newClose - (newClose * histRange) / 2;
    closes.push(newClose);
    highs.push(Math.max(newClose, closes[i - 1], newHigh));
    lows.push(Math.min(newClose, closes[i - 1], newLow));
  }
  return { closes, highs, lows };
};

// ─────────────────────────── Trigger + TP simulation ───────────────────────────

const computeOptionValueAtBar = (
  currentSpot: number,
  cover: CoverConfig,
  remainingBars: number,
  ivAnnual: number
): number => {
  const remainingDays = (remainingBars * BAR_MINUTES) / (60 * 24);
  const T = Math.max(0, remainingDays / 365);
  const strike = cover.strikeUsdc!;
  const optionKind = cover.direction === "long" ? "put" : "call";
  const perBtc =
    optionKind === "put"
      ? bsPut(currentSpot, strike, T, RFR, ivAnnual)
      : bsCall(currentSpot, strike, T, RFR, ivAnnual);
  return Math.max(0, perBtc) * cover.contractsBtc;
};

/**
 * Walk the path, detect trigger, apply theta-aware TP curve.
 * Returns the realized salvage value (net of slippage haircut).
 */
export const simulatePathOutcome = (
  cover: CoverConfig,
  path: { closes: number[]; highs: number[]; lows: number[] },
  ivAnnual: number,
  /** Foxify's expected hold-days (capped at hedge tenor). Default 1d. */
  foxifyHoldDays = 1.0,
  cfg: { tenorDays: number }
): PathOutcome => {
  const totalBars = path.closes.length - 1;
  const triggerSpot =
    cover.direction === "long"
      ? cover.spotEntry * (1 - cover.triggerPct)
      : cover.spotEntry * (1 + cover.triggerPct);
  const foxifyHoldBars = Math.min(totalBars, Math.ceil(foxifyHoldDays * BARS_PER_DAY));

  // Step 1: walk forward up to Foxify's planned hold; detect trigger
  let triggerBar: number | null = null;
  for (let i = 1; i <= foxifyHoldBars; i++) {
    if (cover.direction === "long" && path.lows[i] <= triggerSpot) {
      triggerBar = i;
      break;
    }
    if (cover.direction === "short" && path.highs[i] >= triggerSpot) {
      triggerBar = i;
      break;
    }
  }

  // Step 2: if no trigger by Foxify hold-end, Foxify closes voluntarily.
  // Atticus retains the option and operates TP curve over remaining tenor.
  if (triggerBar === null) {
    const remainingFromHoldEnd = totalBars - foxifyHoldBars;
    const tpResult = applyThetaAwareTp({
      cover,
      path,
      startBarIdx: foxifyHoldBars,
      tenorRemainingBars: remainingFromHoldEnd,
      ivAnnual,
      isWinner: false
    });
    return {
      triggered: false,
      triggerBarIdx: null,
      exitSpot: path.closes[foxifyHoldBars + tpResult.sellBarOffset],
      exitBarIdx: foxifyHoldBars + tpResult.sellBarOffset,
      exitMode: tpResult.mode,
      salvageUsdc: tpResult.salvageUsdc
    };
  }

  // Step 3: trigger fired. Apply theta-aware TP capture-window logic.
  const remaining = totalBars - triggerBar;
  const tpResult = applyThetaAwareTp({
    cover,
    path,
    startBarIdx: triggerBar,
    tenorRemainingBars: remaining,
    ivAnnual,
    isWinner: true
  });
  return {
    triggered: true,
    triggerBarIdx: triggerBar,
    exitSpot: path.closes[triggerBar + tpResult.sellBarOffset],
    exitBarIdx: triggerBar + tpResult.sellBarOffset,
    exitMode: tpResult.mode,
    salvageUsdc: tpResult.salvageUsdc
  };
};

const applyThetaAwareTp = (params: {
  cover: CoverConfig;
  path: { closes: number[]; highs: number[]; lows: number[] };
  startBarIdx: number;
  tenorRemainingBars: number;
  ivAnnual: number;
  isWinner: boolean;
}): { salvageUsdc: number; sellBarOffset: number; mode: string } => {
  const { cover, path, startBarIdx, tenorRemainingBars, ivAnnual, isWinner } = params;
  const SLIPPAGE_HAIRCUT = 0.85;
  const TRAIL_RETRACE = 0.85;
  const CAP_FRACTION = 0.95; // tighter than 0.90 per intraday-tuning finding (PR 4.5)
  const HARD_FLOOR = 0.10; // 10% of payout
  const CAPTURE_WINDOW_BARS = 6; // 30 min
  const CAP_FRACTION_MIN_HOLD_BARS = 12; // 60 min — PR 4.5 fix for short-tenor cells

  if (isWinner) {
    // Winner side: track running peak for capture-window snap, then trail
    let runningPeakValue = 0;
    let runningPeakClose = 0;
    for (let bi = 0; bi <= tenorRemainingBars; bi++) {
      const idx = startBarIdx + bi;
      if (idx >= path.closes.length) {
        const last = path.closes[path.closes.length - 1];
        return {
          salvageUsdc: computeOptionValueAtBar(last, cover, 0, ivAnnual),
          sellBarOffset: bi,
          mode: "data_end"
        };
      }
      const close = path.closes[idx];
      const high = path.highs[idx];
      const low = path.lows[idx];
      const remainingBars = tenorRemainingBars - bi;

      // Track intra-bar peak (use favorable extreme)
      const peakSpot = cover.direction === "long" ? low : high;
      const peakValue = computeOptionValueAtBar(peakSpot, cover, remainingBars, ivAnnual);
      runningPeakValue = Math.max(runningPeakValue, peakValue);

      const closeValue = computeOptionValueAtBar(close, cover, remainingBars, ivAnnual);
      runningPeakClose = Math.max(runningPeakClose, closeValue);

      // Force exit at expiry−4h (48 bars × 5 min)
      if (remainingBars * BAR_MINUTES <= 4 * 60) {
        return { salvageUsdc: closeValue, sellBarOffset: bi, mode: "force_expiry" };
      }

      // Capture-window snap at 30min mark
      if (bi === CAPTURE_WINDOW_BARS) {
        return {
          salvageUsdc: runningPeakValue * SLIPPAGE_HAIRCUT,
          sellBarOffset: bi,
          mode: "capture_window_peak"
        };
      }

      // Cap-fraction exit (after min hold to avoid premature)
      if (bi >= CAP_FRACTION_MIN_HOLD_BARS) {
        const intrinsic =
          cover.direction === "long"
            ? Math.max(0, cover.strikeUsdc! - close) * cover.contractsBtc
            : Math.max(0, close - cover.strikeUsdc!) * cover.contractsBtc;
        if (intrinsic > 0 && closeValue >= intrinsic * CAP_FRACTION) {
          return { salvageUsdc: closeValue, sellBarOffset: bi, mode: "cap_fraction" };
        }
      }

      // Hard floor
      if (closeValue < cover.payoutUsdc * HARD_FLOOR && bi > CAPTURE_WINDOW_BARS) {
        return { salvageUsdc: closeValue, sellBarOffset: bi, mode: "hard_floor" };
      }

      // Trail retrace (after capture window)
      if (
        bi > CAPTURE_WINDOW_BARS &&
        runningPeakClose > 0 &&
        closeValue < runningPeakClose * TRAIL_RETRACE
      ) {
        return { salvageUsdc: closeValue, sellBarOffset: bi, mode: "trail_retrace" };
      }
    }
    const lastIdx = startBarIdx + tenorRemainingBars;
    if (lastIdx < path.closes.length) {
      return {
        salvageUsdc: computeOptionValueAtBar(path.closes[lastIdx], cover, 0, ivAnnual),
        sellBarOffset: tenorRemainingBars,
        mode: "tenor_end"
      };
    }
    return { salvageUsdc: 0, sellBarOffset: tenorRemainingBars, mode: "expired" };
  }

  // Loser side (no trigger by foxify hold-end): close-to-close exit at next eval point
  // Atticus operates remaining tenor with "minimum salvage" objective —
  // sells at first reasonable opportunity to recapture time value
  for (let bi = 1; bi <= tenorRemainingBars; bi++) {
    const idx = startBarIdx + bi;
    if (idx >= path.closes.length) break;
    const remainingBars = tenorRemainingBars - bi;
    const closeValue = computeOptionValueAtBar(path.closes[idx], cover, remainingBars, ivAnnual);
    // Sell on day-1 (1 bar) or earlier if value > hedge cost (positive return)
    if (bi >= BARS_PER_HOUR * 4 || closeValue > cover.hedgeCostUsdc * 0.5) {
      return { salvageUsdc: closeValue, sellBarOffset: bi, mode: "loser_grace" };
    }
  }
  // Hold-to-expiry tail
  const lastIdx = startBarIdx + tenorRemainingBars;
  if (lastIdx < path.closes.length) {
    return {
      salvageUsdc: computeOptionValueAtBar(path.closes[lastIdx], cover, 0, ivAnnual),
      sellBarOffset: tenorRemainingBars,
      mode: "loser_expiry"
    };
  }
  return { salvageUsdc: 0, sellBarOffset: tenorRemainingBars, mode: "expired" };
};

// ─────────────────────────── Per-cover P&L ───────────────────────────

export const computeCooperativePnl = (
  cover: CoverConfig,
  outcome: PathOutcome,
  split: SplitConfig
): CoverPnl => {
  const salvage = outcome.salvageUsdc;
  const uplift = salvage - cover.hedgeCostUsdc;
  let foxifyShare: number;
  let atticusShare: number;
  if (split.splitMode === "uplift_only") {
    // Foxify always gets back hedge cost from salvage (up to salvage),
    // then the uplift is split. If salvage < hedge cost, Foxify eats the loss.
    if (salvage <= cover.hedgeCostUsdc) {
      foxifyShare = salvage;
      atticusShare = 0;
    } else {
      foxifyShare = cover.hedgeCostUsdc + (1 - split.atticusUpliftShare) * uplift;
      atticusShare = split.atticusUpliftShare * uplift;
    }
  } else {
    // total_salvage: split entire salvage proceeds (rare in practice)
    foxifyShare = salvage * (1 - split.atticusUpliftShare);
    atticusShare = salvage * split.atticusUpliftShare;
  }
  const foxifyNet = -cover.hedgeCostUsdc + foxifyShare - split.operatingFeeUsd;
  const atticusNet = atticusShare + split.operatingFeeUsd;
  return {
    hedgeCost: cover.hedgeCostUsdc,
    salvage,
    uplift,
    operatingFee: split.operatingFeeUsd,
    foxifyNet,
    atticusNet
  };
};

// ─────────────────────────── MC simulation runner ───────────────────────────

export type MonteCarloResult = {
  nPaths: number;
  triggerRate: number;
  meanSalvage: number;
  meanUplift: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  // Distribution
  foxifyP1: number;
  foxifyP5: number;
  foxifyP50: number;
  foxifyP95: number;
  foxifyP99: number;
  atticusP1: number;
  atticusP5: number;
  atticusP50: number;
  atticusP95: number;
  atticusP99: number;
  // Loss diagnostics
  pctFoxifyProfitable: number;
  pctAtticusProfitable: number;
  worstFoxifySingleCover: number;
  worstAtticusSingleCover: number;
  meanSalvageOverHedgeRatio: number;
  // Confidence interval on mean Atticus EV (approximate, normal CLT)
  atticusEvCi95Lower: number;
  atticusEvCi95Upper: number;
  // Mode distribution
  exitModeBreakdown: Record<string, number>;
  // Loss path conditional stats
  /** Pct of paths where salvage < hedgeCost (Foxify takes a hit) */
  pctSalvageBelowHedge: number;
  /** Mean salvage value on loss paths (where salvage < hedgeCost) */
  meanSalvageWhenLoss: number;
  /** Mean loss severity (hedgeCost − salvage) on loss paths */
  meanLossSeverityWhenLoss: number;
  /** Pct of paths where salvage > hedgeCost (uplift positive) */
  pctSalvageAboveHedge: number;
  /** Mean salvage on win paths */
  meanSalvageWhenWin: number;
  /** Mean uplift on win paths */
  meanUpliftWhenWin: number;
  /** Pct of paths triggered AND uplift positive */
  pctTriggeredWin: number;
  /** Pct of paths NOT triggered but uplift positive */
  pctNonTriggeredWin: number;
  /** Pct of paths triggered AND in loss */
  pctTriggeredLoss: number;
  /** Pct of paths NOT triggered AND in loss */
  pctNonTriggeredLoss: number;
};

/**
 * Multi-split runner — generates paths once and evaluates split economics
 * for each split in `splits[]`. Returns array of MonteCarloResult parallel
 * to splits[]. Much faster than calling runMonteCarlo() per split.
 */
export const runMonteCarloMultiSplit = async (params: {
  cover: CoverConfig;
  path: PathConfig;
  splits: SplitConfig[];
  ivAnnualForBs: number;
  foxifyHoldDays: number;
  nPaths: number;
  bootstrapBars?: { close: number; high: number; low: number; open: number }[];
  randomDirection?: boolean;
}): Promise<MonteCarloResult[]> => {
  const rng = mulberry32(params.path.seed ?? 1);
  const foxifyEvsArr: number[][] = params.splits.map(() => []);
  const atticusEvsArr: number[][] = params.splits.map(() => []);
  const salvages: number[] = [];
  let triggerCount = 0;
  const exitModes: Record<string, number> = {};

  // Track per-path triggered + salvage joint outcomes for conditional stats
  const triggeredFlags: boolean[] = [];

  for (let p = 0; p < params.nPaths; p++) {
    const direction =
      params.randomDirection !== false ? (rng() < 0.5 ? "long" : "short") : params.cover.direction;
    const cover: CoverConfig = { ...params.cover, direction };
    if (cover.strikeUsdc === null) {
      cover.strikeUsdc =
        direction === "long"
          ? Math.round((cover.spotEntry * (1 - cover.hedgePct)) / 1000) * 1000
          : Math.round((cover.spotEntry * (1 + cover.hedgePct)) / 1000) * 1000;
    }
    const path =
      params.path.generator === "gbm"
        ? generateGbmPath(cover.spotEntry, params.path, rng)
        : generateBootstrapPath(cover.spotEntry, params.path, params.bootstrapBars!, rng);
    const outcome = simulatePathOutcome(cover, path, params.ivAnnualForBs, params.foxifyHoldDays, {
      tenorDays: params.path.tenorDays
    });
    if (outcome.triggered) triggerCount++;
    triggeredFlags.push(outcome.triggered);
    exitModes[outcome.exitMode] = (exitModes[outcome.exitMode] ?? 0) + 1;
    salvages.push(outcome.salvageUsdc);

    // Apply each split to this path
    for (let si = 0; si < params.splits.length; si++) {
      const pnl = computeCooperativePnl(cover, outcome, params.splits[si]);
      foxifyEvsArr[si].push(pnl.foxifyNet);
      atticusEvsArr[si].push(pnl.atticusNet);
    }
  }

  // Compute conditional loss stats (pre-sort: align indices with triggeredFlags)
  // Use original (unsorted) salvages array, indexed by path
  const hedge = params.cover.hedgeCostUsdc;
  const lossPaths: number[] = []; // salvage values when salvage < hedge
  const winPaths: number[] = []; // salvage values when salvage >= hedge
  let triggeredWin = 0;
  let triggeredLoss = 0;
  let nonTriggeredWin = 0;
  let nonTriggeredLoss = 0;
  for (let i = 0; i < salvages.length; i++) {
    const s = salvages[i];
    const trig = triggeredFlags[i];
    if (s < hedge) {
      lossPaths.push(s);
      if (trig) triggeredLoss++;
      else nonTriggeredLoss++;
    } else {
      winPaths.push(s);
      if (trig) triggeredWin++;
      else nonTriggeredWin++;
    }
  }
  const meanSalvageWhenLoss =
    lossPaths.length > 0 ? lossPaths.reduce((s, x) => s + x, 0) / lossPaths.length : 0;
  const meanSalvageWhenWin =
    winPaths.length > 0 ? winPaths.reduce((s, x) => s + x, 0) / winPaths.length : 0;
  const meanLossSeverity = lossPaths.length > 0 ? hedge - meanSalvageWhenLoss : 0;
  const meanUpliftWhenWin = winPaths.length > 0 ? meanSalvageWhenWin - hedge : 0;

  salvages.sort((a, b) => a - b);
  const meanSalvage = salvages.reduce((s, x) => s + x, 0) / salvages.length;

  // Build a result per split
  const results: MonteCarloResult[] = [];
  for (let si = 0; si < params.splits.length; si++) {
    const fe = [...foxifyEvsArr[si]].sort((a, b) => a - b);
    const ae = [...atticusEvsArr[si]].sort((a, b) => a - b);
    const n = fe.length;
    const pct = (sorted: number[], q: number) => {
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
      return sorted[idx];
    };
    const meanF = fe.reduce((s, x) => s + x, 0) / n;
    const meanA = ae.reduce((s, x) => s + x, 0) / n;
    const variance = (arr: number[], m: number) =>
      arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    const stdA = Math.sqrt(variance(ae, meanA));
    const seA = stdA / Math.sqrt(n);
    results.push({
      nPaths: n,
      triggerRate: triggerCount / n,
      meanSalvage,
      meanUplift: meanSalvage - params.cover.hedgeCostUsdc,
      meanFoxifyEv: meanF,
      meanAtticusEv: meanA,
      foxifyP1: pct(fe, 0.01),
      foxifyP5: pct(fe, 0.05),
      foxifyP50: pct(fe, 0.5),
      foxifyP95: pct(fe, 0.95),
      foxifyP99: pct(fe, 0.99),
      atticusP1: pct(ae, 0.01),
      atticusP5: pct(ae, 0.05),
      atticusP50: pct(ae, 0.5),
      atticusP95: pct(ae, 0.95),
      atticusP99: pct(ae, 0.99),
      pctFoxifyProfitable: fe.filter((x) => x > 0).length / n,
      pctAtticusProfitable: ae.filter((x) => x > 0).length / n,
      worstFoxifySingleCover: fe[0],
      worstAtticusSingleCover: ae[0],
      meanSalvageOverHedgeRatio: meanSalvage / params.cover.hedgeCostUsdc,
      atticusEvCi95Lower: meanA - 1.96 * seA,
      atticusEvCi95Upper: meanA + 1.96 * seA,
      exitModeBreakdown: exitModes,
      pctSalvageBelowHedge: lossPaths.length / n,
      meanSalvageWhenLoss,
      meanLossSeverityWhenLoss: meanLossSeverity,
      pctSalvageAboveHedge: winPaths.length / n,
      meanSalvageWhenWin,
      meanUpliftWhenWin,
      pctTriggeredWin: triggeredWin / n,
      pctNonTriggeredWin: nonTriggeredWin / n,
      pctTriggeredLoss: triggeredLoss / n,
      pctNonTriggeredLoss: nonTriggeredLoss / n
    });
  }
  return results;
};

export const runMonteCarlo = async (params: {
  cover: CoverConfig;
  path: PathConfig;
  split: SplitConfig;
  ivAnnualForBs: number;
  foxifyHoldDays: number;
  nPaths: number;
  bootstrapBars?: { close: number; high: number; low: number; open: number }[];
  randomDirection?: boolean;
}): Promise<MonteCarloResult> => {
  // Delegate to multi-split runner with one split — preserves all conditional stats
  const results = await runMonteCarloMultiSplit({
    cover: params.cover,
    path: params.path,
    splits: [params.split],
    ivAnnualForBs: params.ivAnnualForBs,
    foxifyHoldDays: params.foxifyHoldDays,
    nPaths: params.nPaths,
    bootstrapBars: params.bootstrapBars,
    randomDirection: params.randomDirection
  });
  return results[0];
};

// (Legacy single-split implementation removed — runMonteCarlo now delegates
// to runMonteCarloMultiSplit. The conditional loss/win stats live there.)
const _UNUSED_LEGACY_BLOCK = async (params: {
  cover: CoverConfig;
  path: PathConfig;
  split: SplitConfig;
  ivAnnualForBs: number;
  foxifyHoldDays: number;
  nPaths: number;
  bootstrapBars?: { close: number; high: number; low: number; open: number }[];
  randomDirection?: boolean;
}): Promise<void> => {
  // Body intentionally empty; preserves nothing from the prior implementation.
  void params;
  return;
  /*
  const rng = mulberry32(params.path.seed ?? 1);
  const foxifyEvs: number[] = [];
  const atticusEvs: number[] = [];
  const salvages: number[] = [];
  let triggerCount = 0;
  const exitModes: Record<string, number> = {};

  for (let p = 0; p < params.nPaths; p++) {
    // Optional: randomize direction per path
    const direction =
      params.randomDirection !== false ? (rng() < 0.5 ? "long" : "short") : params.cover.direction;
    const cover: CoverConfig = { ...params.cover, direction };
    if (cover.strikeUsdc === null) {
      cover.strikeUsdc =
        direction === "long"
          ? Math.round((cover.spotEntry * (1 - cover.hedgePct)) / 1000) * 1000
          : Math.round((cover.spotEntry * (1 + cover.hedgePct)) / 1000) * 1000;
    }

    // Generate path
    const path =
      params.path.generator === "gbm"
        ? generateGbmPath(cover.spotEntry, params.path, rng)
        : generateBootstrapPath(cover.spotEntry, params.path, params.bootstrapBars!, rng);

    const outcome = simulatePathOutcome(cover, path, params.ivAnnualForBs, params.foxifyHoldDays, {
      tenorDays: params.path.tenorDays
    });
    if (outcome.triggered) triggerCount++;
    exitModes[outcome.exitMode] = (exitModes[outcome.exitMode] ?? 0) + 1;

    const pnl = computeCooperativePnl(cover, outcome, params.split);
    foxifyEvs.push(pnl.foxifyNet);
    atticusEvs.push(pnl.atticusNet);
    salvages.push(outcome.salvageUsdc);
  }

  foxifyEvs.sort((a, b) => a - b);
  atticusEvs.sort((a, b) => a - b);
  salvages.sort((a, b) => a - b);

  const pct = (sorted: number[], q: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
    return sorted[idx];
  };
  const sum = (arr: number[]) => arr.reduce((s, x) => s + x, 0);
  const mean = (arr: number[]) => sum(arr) / arr.length;
  const variance = (arr: number[], m: number) =>
    arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);

  const meanFoxify = mean(foxifyEvs);
  const meanAtticus = mean(atticusEvs);
  const meanSalvage = mean(salvages);
  const stdAtticus = Math.sqrt(variance(atticusEvs, meanAtticus));
  const seAtticus = stdAtticus / Math.sqrt(params.nPaths);

  return {
    nPaths: params.nPaths,
    triggerRate: triggerCount / params.nPaths,
    meanSalvage,
    meanUplift: meanSalvage - params.cover.hedgeCostUsdc,
    meanFoxifyEv: meanFoxify,
    meanAtticusEv: meanAtticus,
    foxifyP1: pct(foxifyEvs, 0.01),
    foxifyP5: pct(foxifyEvs, 0.05),
    foxifyP50: pct(foxifyEvs, 0.50),
    foxifyP95: pct(foxifyEvs, 0.95),
    foxifyP99: pct(foxifyEvs, 0.99),
    atticusP1: pct(atticusEvs, 0.01),
    atticusP5: pct(atticusEvs, 0.05),
    atticusP50: pct(atticusEvs, 0.50),
    atticusP95: pct(atticusEvs, 0.95),
    atticusP99: pct(atticusEvs, 0.99),
    pctFoxifyProfitable: foxifyEvs.filter((x) => x > 0).length / params.nPaths,
    pctAtticusProfitable: atticusEvs.filter((x) => x > 0).length / params.nPaths,
    worstFoxifySingleCover: foxifyEvs[0],
    worstAtticusSingleCover: atticusEvs[0],
    meanSalvageOverHedgeRatio: meanSalvage / params.cover.hedgeCostUsdc,
    atticusEvCi95Lower: meanAtticus - 1.96 * seAtticus,
    atticusEvCi95Upper: meanAtticus + 1.96 * seAtticus,
    exitModeBreakdown: exitModes
  };
  */
};

// ─────────────────────────── Bootstrap data loader ───────────────────────────

export const load5MinBars = async (): Promise<
  { close: number; high: number; low: number; open: number }[]
> => {
  const data = JSON.parse(await fs.readFile("/tmp/btc_5min_ohlc.json", "utf8"));
  return data.bars.map((b: { close: number; high: number; low: number; open: number }) => ({
    close: b.close,
    high: b.high,
    low: b.low,
    open: b.open
  }));
};
