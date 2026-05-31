/**
 * Foxify-duration Monte Carlo — the optimization target that matters.
 *
 * The legacy MC in liveCellEvService models a binary outcome per path:
 *   - Trigger fires → capture peak value × slip during capture window
 *   - No trigger → sell at expiry-48h
 *
 * That's correct for trigger-payoff economics, but it MISSES Foxify's
 * actual behavior: Foxify holds delta-neutral perp pairs and will close
 * the option at ANY point during the lifetime as soon as MTM appreciation
 * covers their friction window (~$200-300 net per pair target).
 *
 * This module simulates that behavior:
 *
 *   For each path:
 *     activate at $cost
 *     for each tick (5 min):
 *       spot evolves
 *       compute MTM = combined option value at current spot + remaining tenor
 *                     × realism multiplier (matches close-time bid discount)
 *       if MTM - cost >= autoCloseAbsoluteUsdc OR pnl_pct >= autoCloseThresholdPct:
 *         close NOW at MTM × bid_slippage (realistic fill)
 *         foxify_net = mtm_at_close × bid_slip - cost
 *         exit_mode = "foxify_auto_close"
 *         break
 *       if trigger boundary crossed:
 *         enter capture window (legacy peak capture)
 *         close at peak × bid_slip
 *         break
 *     if no exit by tenor expiry:
 *       close at expiry value × bid_slip
 *       exit_mode = "expiry"
 *
 * Cell evaluation criteria (in this order):
 *   1. mean foxify_net per pair → target $200-300
 *   2. P(foxify_net > 0) → consistency, target >= 60%
 *   3. lower capital per pair at equal expected net (capital efficiency)
 *   4. smaller worst-case (p5) loss
 *
 * The output is comparable across cells, regimes, and auto-close thresholds
 * — so the optimization sweep can rank cells with apples-to-apples numbers.
 */

import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";
import {
  generateBootstrapPath,
  generateGbmPath,
  load5MinBars,
  mulberry32,
  type PathConfig
} from "../../../scripts/backtest/singleSide/monteCarloEngine";
import { RISK_FREE_RATE } from "./optionPricing";

const BAR_MINUTES = 5;
const BARS_PER_HOUR = 60 / BAR_MINUTES;
const RFR = RISK_FREE_RATE;

export type FoxifyDurationMcInputs = {
  cellId: string;
  spot: number;
  hedgeCostUsdc: number;             // already-regime-adjusted cost (calibration markup applied upstream)
  putStrike: number;
  callStrike: number;
  tenorDays: number;
  triggerPctDown: number;
  triggerPctUp: number;
  regime: "calm" | "moderate" | "elevated" | "stress";
  sigmaAnnual: number;               // from regimeCalibration
  contractsBtc: number;
  /** Foxify auto-close trigger: percent-of-cost PnL threshold. e.g. 0.30 = +30%. */
  autoClosePnlPct: number;
  /** Foxify auto-close absolute trigger: USDC. e.g. 250 = close once +$250 net. */
  autoCloseAbsoluteUsdc: number;
  /**
   * Salvage realism multiplier (from real_bid / bs_at_current_spot ratio at
   * the time of evaluation). Applied uniformly to every MC valuation so the
   * sim reflects realistic bid economics, not BS theoretical. Default 1.0
   * preserves legacy behavior; production callers pass the live multiplier.
   */
  salvageRealismMultiplier?: number;
  /** Fill slippage on auto-close (default 0.95 — matches priceOption default). */
  bidSlipHaircut?: number;
  /** Number of MC paths (default 2000 — balance speed vs statistical power). */
  nPaths?: number;
  /** Optional bars cache (avoids repeated load5MinBars when caller has them). */
  barsOverride?: { highs: number[]; lows: number[]; closes: number[] } | null;
  /** Deterministic RNG seed. */
  seed?: number;
};

export type FoxifyExitMode = "foxify_auto_close" | "trigger_peak" | "expiry";

export type FoxifyDurationMcResult = {
  // Foxify-side outcomes (the metrics that matter for cell selection)
  meanFoxifyNetUsdc: number;
  medianFoxifyNetUsdc: number;
  p5FoxifyNetUsdc: number;
  p95FoxifyNetUsdc: number;
  pctProfitable: number;
  meanCostPaid: number;                  // = hedgeCostUsdc (constant)
  // Exit distribution
  exitDistribution: Record<FoxifyExitMode, number>;
  // Capital efficiency
  meanCapitalRatio: number;              // mean net / mean cost
  // Auto-close timing (when foxify closed early)
  meanTicksToAutoClose: number | null;   // null when no auto-closes
  // Atticus (for completeness, not part of selection ranking)
  meanAtticusShareUsdc: number;
  // Metadata
  nPaths: number;
  pathGenerator: "bootstrap" | "gbm";
};

const median = (sorted: number[]): number => {
  if (sorted.length === 0) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)));
  return sorted[idx];
};

// Combined BS value × realism multiplier — the per-tick valuation
const combinedValueAt = (
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  remainingMs: number,
  sigma: number,
  realismMultiplier: number
): number => {
  const T = Math.max(0, remainingMs / (365 * 86_400_000));
  const bsP = Math.max(0, bsPut(spot, putStrike, T, RFR, sigma));
  const bsC = Math.max(0, bsCall(spot, callStrike, T, RFR, sigma));
  return (bsP + bsC) * contractsBtc * realismMultiplier;
};

/**
 * Run the Foxify-duration MC sim.
 *
 * Pure function except for one async barrier (load5MinBars). Same seed
 * produces same result. The Atticus split is computed inline using a
 * standard 85/15 with $25 floor — matches production settlement logic
 * for the cells we evaluate.
 */
export const runFoxifyDurationMc = async (
  inputs: FoxifyDurationMcInputs
): Promise<FoxifyDurationMcResult> => {
  const nPaths = inputs.nPaths ?? 2_000;
  const realismMultiplier = inputs.salvageRealismMultiplier ?? 1.0;
  const bidSlip = inputs.bidSlipHaircut ?? 0.95;
  const seed = inputs.seed ?? 42;
  const splitPct = 0.85;
  const floorUsdc = 25;

  const bars = inputs.barsOverride ?? (inputs.regime === "calm" ? await load5MinBars().catch(() => null) : null);
  const pathConfig: PathConfig = {
    tenorDays: inputs.tenorDays,
    sigmaAnnual: inputs.sigmaAnnual,
    driftAnnual: 0,
    generator: inputs.regime === "calm" && bars ? "bootstrap" : "gbm",
    seed
  };

  const triggerDownPx = inputs.spot * (1 - inputs.triggerPctDown);
  const triggerUpPx = inputs.spot * (1 + inputs.triggerPctUp);
  const totalTenorMs = inputs.tenorDays * 86_400_000;
  const rng = mulberry32(seed);

  const foxifyNets: number[] = [];
  const atticusShares: number[] = [];
  const exitTicks: number[] = []; // ticks to exit per path (any mode)
  const autoCloseTicks: number[] = [];
  const exitCounts: Record<FoxifyExitMode, number> = {
    foxify_auto_close: 0,
    trigger_peak: 0,
    expiry: 0
  };

  for (let p = 0; p < nPaths; p++) {
    const path = bars && inputs.regime === "calm"
      ? generateBootstrapPath(inputs.spot, pathConfig, bars, rng)
      : generateGbmPath(inputs.spot, pathConfig, rng);

    let foxifyNet = 0;
    let atticusShare = 0;
    let exitMode: FoxifyExitMode = "expiry";
    let exitedAtBar = path.closes.length - 1;
    let triggered = false;

    // ─── Walk path bar by bar ───
    for (let i = 1; i < path.closes.length; i++) {
      // 1. Check trigger first (handled like legacy peak capture)
      if (!triggered && (path.lows[i] <= triggerDownPx || path.highs[i] >= triggerUpPx)) {
        triggered = true;
        // Peak capture: scan next 6 bars (30 min) for the best value
        const captureEnd = Math.min(i + 6, path.closes.length - 1);
        const triggerSide = path.lows[i] <= triggerDownPx ? "down" : "up";
        let peak = 0;
        let peakBar = i;
        for (let j = i; j <= captureEnd; j++) {
          const sp = triggerSide === "down" ? path.lows[j] : path.highs[j];
          const remMs = (path.closes.length - 1 - j) * BAR_MINUTES * 60_000;
          const v = combinedValueAt(sp, inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier);
          if (v > peak) { peak = v; peakBar = j; }
        }
        const salvageGross = peak * bidSlip;
        const uplift = salvageGross - inputs.hedgeCostUsdc;
        if (uplift <= 0) {
          foxifyNet = salvageGross - inputs.hedgeCostUsdc;
          atticusShare = 0;
        } else {
          atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
          const foxifyTotal = inputs.hedgeCostUsdc + (uplift - atticusShare);
          foxifyNet = foxifyTotal - inputs.hedgeCostUsdc;
        }
        exitMode = "trigger_peak";
        exitedAtBar = peakBar;
        break;
      }

      // 2. Compute MTM at this tick + check Foxify auto-close
      const remMs = (path.closes.length - 1 - i) * BAR_MINUTES * 60_000;
      const mtmGross = combinedValueAt(path.closes[i], inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier);
      const mtmNetAfterSlip = mtmGross * bidSlip - inputs.hedgeCostUsdc;
      const mtmPnlPct = inputs.hedgeCostUsdc > 0 ? mtmNetAfterSlip / inputs.hedgeCostUsdc : 0;
      if (mtmPnlPct >= inputs.autoClosePnlPct || mtmNetAfterSlip >= inputs.autoCloseAbsoluteUsdc) {
        // Foxify closes here
        const salvageGross = mtmGross * bidSlip;
        const uplift = salvageGross - inputs.hedgeCostUsdc;
        if (uplift <= 0) {
          foxifyNet = uplift;
          atticusShare = 0;
        } else {
          atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
          const foxifyTotal = inputs.hedgeCostUsdc + (uplift - atticusShare);
          foxifyNet = foxifyTotal - inputs.hedgeCostUsdc;
        }
        exitMode = "foxify_auto_close";
        exitedAtBar = i;
        autoCloseTicks.push(i);
        break;
      }
    }

    // 3. If neither trigger nor auto-close fired, sell at expiry
    if (exitMode === "expiry") {
      const sp = path.closes[path.closes.length - 1];
      const remMs = 0;
      const salvageGross = combinedValueAt(sp, inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier) * bidSlip;
      const uplift = salvageGross - inputs.hedgeCostUsdc;
      if (uplift <= 0) {
        foxifyNet = uplift;
        atticusShare = 0;
      } else {
        atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
        const foxifyTotal = inputs.hedgeCostUsdc + (uplift - atticusShare);
        foxifyNet = foxifyTotal - inputs.hedgeCostUsdc;
      }
      exitedAtBar = path.closes.length - 1;
    }

    foxifyNets.push(foxifyNet);
    atticusShares.push(atticusShare);
    exitTicks.push(exitedAtBar);
    exitCounts[exitMode]++;
  }

  const sortedNets = [...foxifyNets].sort((a, b) => a - b);
  const mean = (a: number[]) => a.length > 0 ? a.reduce((s, x) => s + x, 0) / a.length : 0;

  const meanNet = mean(foxifyNets);
  const meanAuto = autoCloseTicks.length > 0 ? mean(autoCloseTicks) : null;

  return {
    meanFoxifyNetUsdc: meanNet,
    medianFoxifyNetUsdc: median(sortedNets),
    p5FoxifyNetUsdc: percentile(sortedNets, 0.05),
    p95FoxifyNetUsdc: percentile(sortedNets, 0.95),
    pctProfitable: foxifyNets.filter((x) => x > 0).length / foxifyNets.length,
    meanCostPaid: inputs.hedgeCostUsdc,
    exitDistribution: {
      foxify_auto_close: exitCounts.foxify_auto_close / nPaths,
      trigger_peak: exitCounts.trigger_peak / nPaths,
      expiry: exitCounts.expiry / nPaths
    },
    meanCapitalRatio: inputs.hedgeCostUsdc > 0 ? meanNet / inputs.hedgeCostUsdc : 0,
    meanTicksToAutoClose: meanAuto,
    meanAtticusShareUsdc: mean(atticusShares),
    nPaths,
    pathGenerator: bars && inputs.regime === "calm" ? "bootstrap" : "gbm"
  };
};
