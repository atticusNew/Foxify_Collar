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

import { bsPut, bsCall, bsPutDelta, bsCallDelta } from "../../../scripts/backtest/singleSide/coreEngine";
import {
  generateBootstrapPath,
  generateGbmPath,
  load5MinBars,
  mulberry32,
  type PathConfig
} from "../../../scripts/backtest/singleSide/monteCarloEngine";
import { RISK_FREE_RATE } from "./optionPricing";
import { structureValueAt, type OptionStructure } from "./optionStructures";

const BAR_MINUTES = 5;
const BARS_PER_HOUR = 60 / BAR_MINUTES;
const RFR = RISK_FREE_RATE;
const FIVE_MIN_BARS_PER_YEAR = 365 * 24 * 12;

/**
 * Annualized realized σ of a 5-min bar series (stdev of log-returns × √barsPerYear).
 * Used to scale a real-bar bootstrap up to a target regime σ in fat-tail mode.
 * Returns 0 on degenerate input (caller then leaves scale=1).
 */
const annualizedSigmaFrom5MinBars = (bars: { close: number }[]): number => {
  if (!Array.isArray(bars) || bars.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1]?.close, c = bars[i]?.close;
    if (p > 0 && c > 0) rets.push(Math.log(c / p));
  }
  if (rets.length < 2) return 0;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(FIVE_MIN_BARS_PER_YEAR);
};

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
  /**
   * Hedge structure to simulate (default "straddle" → long put + call; byte-identical
   * to legacy for all existing callers). Other structures (one_sided_put/call, collar)
   * change ONLY the per-tick valuation via structureValueAt — the path, triggers, and
   * auto-close logic are shared. Gamma-scalp mode ignores this (straddle-only branch).
   */
  structure?: OptionStructure;
  /** Short-leg strike for vertical spreads (the OTM leg sold). Ignored by other structures. */
  shortStrike?: number;
  /**
   * Annualized GBM drift for the path (RESEARCH ONLY — models a directional EDGE, e.g.
   * Foxify being right ~60-65% on direction). Default 0 = no edge → byte-identical to
   * legacy. Signed: + drifts up (favors call/bull structures), − drifts down.
   */
  driftAnnual?: number;
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
  /**
   * FAT-TAIL MODE (opt-in). When true, ALL regimes use a real-5min-bar bootstrap
   * (preserving BTC's fat tails / autocorrelation) scaled to the regime σ, instead
   * of GBM for non-calm. Default false (GBM for non-calm) — preserves the validated
   * sweep numbers byte-for-byte until the operator deliberately flips it and
   * re-validates. Env default: SS_MC_BOOTSTRAP_ALL_REGIMES=true. Falls back to GBM
   * if bars are unavailable.
   */
  bootstrapAllRegimes?: boolean;
  /** Deterministic RNG seed. */
  seed?: number;
  /** When true, the result includes the raw per-path Foxify-net array (for bootstrapping projections). */
  returnNets?: boolean;
  /**
   * GAMMA SCALP MODE (Phase 4.5). When true, the option position is treated as
   * delta-hedged via Foxify's perp pair: each tick we rehedge the combined delta
   * to ~0 through the perp and harvest realized gamma. The trigger peak-capture
   * branch is DISABLED (a delta-neutral book has no directional windfall).
   * Net Foxify P&L = (option salvage - cost) + perp-hedge P&L - perp friction.
   * A delta-hedged option at fair IV is ~zero-EV minus costs by construction —
   * profit comes only when realized vol exceeds the IV the option was priced at.
   * Default false → legacy behavior unchanged.
   */
  gammaScalpWithPerpHedge?: boolean;
  /**
   * REAL perp round-trip friction in basis points, applied to |Δdelta|×spot
   * notional on every rebalance (and the initial hedge). MUST be supplied by the
   * caller from the venue fee schedule (env FOXIFY_PERP_FRICTION_BPS) when gamma
   * scalp mode is on — no hardcoded default (avoids rigging EV). Required iff
   * gammaScalpWithPerpHedge.
   */
  perpFrictionBps?: number;
  /**
   * Optional perp funding cost in bps/day on the held hedge notional (env
   * FOXIFY_PERP_FUNDING_BPS_PER_DAY). Default 0 (short tenors often ignore it).
   */
  perpFundingBpsPerDay?: number;
  /**
   * Implied vol the option is PRICED + decayed at (gamma scalp valuation/delta),
   * decoupled from sigmaAnnual which is the REALIZED path vol. Gamma scalping is
   * profitable exactly when realized (sigmaAnnual) exceeds implied
   * (impliedSigmaAnnual). Default = sigmaAnnual (realized==implied → ~zero-EV
   * carry, the neutral baseline). For the REAL sweep, set impliedSigmaAnnual to
   * the IV embedded in the option's market ask. Only used in gamma scalp mode.
   */
  impliedSigmaAnnual?: number;
  /**
   * Atticus profit-share fraction of the uplift Foxify keeps... i.e. Foxify
   * keeps splitPct, Atticus takes (1-splitPct) of positive uplift (floored at
   * atticusFloorUsdc). Default = env SS_ATTICUS_SPLIT_PCT or 0.85 (85/15).
   * EASILY ADJUSTABLE: set the env, or pass per-sim, without code changes.
   */
  atticusSplitPct?: number;
  /** Minimum Atticus share on positive uplift (USDC). Default env SS_ATTICUS_FLOOR_USDC or 25. */
  atticusFloorUsdc?: number;
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
  /** Raw per-path Foxify-net samples — present only when returnNets was set (for projections). */
  nets?: number[];
  /**
   * Gamma-scalp diagnostics — null unless gammaScalpWithPerpHedge was set.
   * Decomposes the delta-hedged economics so the operator can see WHERE the
   * P&L came from (perp hedge harvest vs friction drag).
   */
  gammaScalp: {
    meanPerpHedgePnlUsdc: number;   // mean realized perp-hedge P&L per path
    meanPerpFrictionUsdc: number;   // mean total friction paid per path
    meanRebalances: number;         // mean # of perp rebalances per path
    frictionBps: number;            // friction bps used (echo of input)
  } | null;
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

/**
 * Combined BS value × realism multiplier — the per-tick valuation.
 *
 * SANCTIONED EXCEPTION to the "every pricing component calls the same
 * priceOption primitive" rule (operating rule #2):
 *   Across thousands of paths × hundreds of ticks, a live chain lookup
 *   (priceOption) per tick is computationally infeasible AND meaningless —
 *   the chain only knows the CURRENT spot, not the hypothetical evolved spot
 *   on a simulated path. So the MC values each tick with Black-Scholes at the
 *   path spot, then multiplies by `realismMultiplier`, which is itself derived
 *   from priceOption's REAL bid/ask at entry (real_bid_combined / bs_at_spot in
 *   cellSweep.computeRealPricing). This keeps the simulation anchored to real
 *   venue economics (no synthetic markup) while staying tractable. MTM, close
 *   executor, and EV display all still call priceOption directly on real spot —
 *   only the forward-simulated path valuation uses this BS×realism form.
 */
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

// Combined option net delta (BTC) — put delta + call delta, scaled by contracts.
// Used by gamma-scalp mode to size the perp delta hedge each tick.
const combinedDeltaAt = (
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  remainingMs: number,
  sigma: number
): number => {
  const T = Math.max(0, remainingMs / (365 * 86_400_000));
  return (bsPutDelta(spot, putStrike, T, RFR, sigma) + bsCallDelta(spot, callStrike, T, RFR, sigma)) * contractsBtc;
};

/**
 * Simulate ONE gamma-scalp path: delta-hedge the straddle via the perp each
 * tick and harvest realized gamma. Returns the Foxify net (after the 85/15
 * Atticus split on positive uplift) plus diagnostics. Pure + deterministic.
 */
const simulateGammaScalpPath = (
  path: { highs: number[]; lows: number[]; closes: number[] },
  inputs: FoxifyDurationMcInputs,
  realismMultiplier: number,
  bidSlip: number,
  splitPct: number,
  floorUsdc: number,
  frictionBps: number,
  fundingBpsPerDay: number,
  valuationSigma: number
): {
  foxifyNet: number;
  atticusShare: number;
  exitMode: FoxifyExitMode;
  exitedAtBar: number;
  autoCloseTick: number | null;
  perpHedgePnl: number;
  friction: number;
  rebalances: number;
} => {
  const contracts = inputs.contractsBtc;
  const cost = inputs.hedgeCostUsdc;
  // Option valuation + delta use IMPLIED vol; the path (realized vol) is the
  // sigmaAnnual the bars were generated at. realized>implied => gamma profit.
  const sigma = valuationSigma;
  const nBars = path.closes.length;
  const barMs = BAR_MINUTES * 60_000;
  const frictionRate = frictionBps / 10_000;
  const fundingPerBar = (fundingBpsPerDay / 10_000) * (BAR_MINUTES / (60 * 24));
  const totalTenorMs = inputs.tenorDays * 86_400_000;

  // Initial hedge: short the option net delta via perp (combined delta ~0).
  let hedgeUnits = -combinedDeltaAt(path.closes[0], inputs.putStrike, inputs.callStrike, contracts, totalTenorMs, sigma);
  let cumPerpPnl = 0;
  let cumFriction = Math.abs(hedgeUnits) * path.closes[0] * frictionRate; // entry hedge cost
  let rebalances = 1;

  const settle = (uplift: number): { foxifyNet: number; atticusShare: number } => {
    if (uplift <= 0) return { foxifyNet: uplift, atticusShare: 0 };
    const atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
    return { foxifyNet: uplift - atticusShare, atticusShare };
  };

  for (let i = 1; i < nBars; i++) {
    const S = path.closes[i];
    const Sprev = path.closes[i - 1];
    // 1. Perp hedge P&L over the tick (linear in spot) + funding on held notional.
    cumPerpPnl += hedgeUnits * (S - Sprev);
    cumFriction += Math.abs(hedgeUnits) * S * fundingPerBar;
    const remMs = (nBars - 1 - i) * barMs;
    // 2. Mark net P&L = (option salvage - cost) + perp P&L - friction.
    const optSalvage = combinedValueAt(S, inputs.putStrike, inputs.callStrike, contracts, remMs, sigma, realismMultiplier) * bidSlip;
    const netNow = (optSalvage - cost) + cumPerpPnl - cumFriction;
    const pnlPct = cost > 0 ? netNow / cost : 0;
    if (pnlPct >= inputs.autoClosePnlPct || netNow >= inputs.autoCloseAbsoluteUsdc) {
      const { foxifyNet, atticusShare } = settle(netNow);
      return { foxifyNet, atticusShare, exitMode: "foxify_auto_close", exitedAtBar: i, autoCloseTick: i, perpHedgePnl: cumPerpPnl, friction: cumFriction, rebalances };
    }
    // 3. Rebalance perp to new option delta (charge friction on the change).
    const newHedge = -combinedDeltaAt(S, inputs.putStrike, inputs.callStrike, contracts, remMs, sigma);
    const delta = Math.abs(newHedge - hedgeUnits);
    if (delta > 1e-9) {
      cumFriction += delta * S * frictionRate;
      rebalances++;
    }
    hedgeUnits = newHedge;
  }

  // Expiry: close option at terminal salvage + realized perp P&L - friction.
  const Sfin = path.closes[nBars - 1];
  const optSalvageFin = combinedValueAt(Sfin, inputs.putStrike, inputs.callStrike, contracts, 0, sigma, realismMultiplier) * bidSlip;
  const netFin = (optSalvageFin - cost) + cumPerpPnl - cumFriction;
  const { foxifyNet, atticusShare } = settle(netFin);
  return { foxifyNet, atticusShare, exitMode: "expiry", exitedAtBar: nBars - 1, autoCloseTick: null, perpHedgePnl: cumPerpPnl, friction: cumFriction, rebalances };
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
  const splitPct = inputs.atticusSplitPct ?? Number(process.env.SS_ATTICUS_SPLIT_PCT ?? "0.85");
  const floorUsdc = inputs.atticusFloorUsdc ?? Number(process.env.SS_ATTICUS_FLOOR_USDC ?? "25");
  const structure: OptionStructure = inputs.structure ?? "straddle";
  // Slippage on a SIGNED structure value: a positive (asset) value sells at bid×haircut;
  // a NEGATIVE value (a short-leg liability, e.g. collar on an up-move) costs MORE to close
  // (÷haircut → more negative). For long structures every value is ≥0 → identical to ×bidSlip
  // (keeps the validated straddle numbers byte-for-byte).
  const applySlip = (v: number): number => (v >= 0 ? v * bidSlip : v / bidSlip);

  // Fat-tail mode: bootstrap real bars for ALL regimes (scaled to regime σ), not
  // just calm. Opt-in (default off → legacy GBM for non-calm, validated numbers
  // unchanged). Env SS_MC_BOOTSTRAP_ALL_REGIMES=true flips the default.
  const bootstrapAll = inputs.bootstrapAllRegimes ?? (process.env.SS_MC_BOOTSTRAP_ALL_REGIMES === "true");
  const bars = inputs.barsOverride ?? ((inputs.regime === "calm" || bootstrapAll) ? await load5MinBars().catch(() => null) : null);
  const useBootstrap = bars != null && (inputs.regime === "calm" || bootstrapAll);
  // When bootstrapping a NON-calm regime, scale the (calm-ish) historical bars up
  // to the regime σ. Calm bootstrap stays unscaled (bars already ~calm) so legacy
  // calm behavior is byte-identical.
  const histSigma = bootstrapAll && bars ? annualizedSigmaFrom5MinBars(bars) : null;
  const bootstrapVolScale = (bootstrapAll && histSigma != null && histSigma > 0)
    ? inputs.sigmaAnnual / histSigma : 1;
  const pathConfig: PathConfig = {
    tenorDays: inputs.tenorDays,
    sigmaAnnual: inputs.sigmaAnnual,
    driftAnnual: inputs.driftAnnual ?? 0,
    generator: useBootstrap ? "bootstrap" : "gbm",
    seed,
    bootstrapVolScale
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

  // Gamma-scalp mode setup (Phase 4.5): require REAL friction, prep diagnostics.
  const gammaScalpMode = inputs.gammaScalpWithPerpHedge === true;
  if (gammaScalpMode && (inputs.perpFrictionBps == null || !Number.isFinite(inputs.perpFrictionBps) || inputs.perpFrictionBps < 0)) {
    throw new Error("runFoxifyDurationMc: gammaScalpWithPerpHedge requires perpFrictionBps (>=0) from the venue fee schedule (env FOXIFY_PERP_FRICTION_BPS) — no hardcoded default");
  }
  const frictionBps = inputs.perpFrictionBps ?? 0;
  const fundingBpsPerDay = inputs.perpFundingBpsPerDay ?? 0;
  const valuationSigma = inputs.impliedSigmaAnnual ?? inputs.sigmaAnnual;
  const gsPerpPnls: number[] = [];
  const gsFrictions: number[] = [];
  const gsRebalances: number[] = [];

  for (let p = 0; p < nPaths; p++) {
    const path = useBootstrap
      ? generateBootstrapPath(inputs.spot, pathConfig, bars as Parameters<typeof generateBootstrapPath>[2], rng)
      : generateGbmPath(inputs.spot, pathConfig, rng);

    // ─── Gamma-scalp branch (Phase 4.5): delta-hedge via perp; no trigger capture ───
    if (gammaScalpMode) {
      const gs = simulateGammaScalpPath(path, inputs, realismMultiplier, bidSlip, splitPct, floorUsdc, frictionBps, fundingBpsPerDay, valuationSigma);
      foxifyNets.push(gs.foxifyNet);
      atticusShares.push(gs.atticusShare);
      exitTicks.push(gs.exitedAtBar);
      if (gs.autoCloseTick != null) autoCloseTicks.push(gs.autoCloseTick);
      exitCounts[gs.exitMode]++;
      gsPerpPnls.push(gs.perpHedgePnl);
      gsFrictions.push(gs.friction);
      gsRebalances.push(gs.rebalances);
      continue;
    }

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
        // peak = -Infinity (NOT 0): for a short-containing structure (collar) the value can
        // be NEGATIVE on an adverse move; flooring at 0 would HIDE that loss. For long
        // structures (value ≥ 0) the captured max is unchanged → byte-identical.
        let peak = -Infinity;
        let peakBar = i;
        for (let j = i; j <= captureEnd; j++) {
          const sp = triggerSide === "down" ? path.lows[j] : path.highs[j];
          const remMs = (path.closes.length - 1 - j) * BAR_MINUTES * 60_000;
          const v = structureValueAt(structure, sp, inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier, inputs.shortStrike);
          if (v > peak) { peak = v; peakBar = j; }
        }
        const salvageGross = applySlip(peak);
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
      const mtmGross = structureValueAt(structure, path.closes[i], inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier, inputs.shortStrike);
      const mtmNetAfterSlip = applySlip(mtmGross) - inputs.hedgeCostUsdc;
      const mtmPnlPct = inputs.hedgeCostUsdc > 0 ? mtmNetAfterSlip / inputs.hedgeCostUsdc : 0;
      if (mtmPnlPct >= inputs.autoClosePnlPct || mtmNetAfterSlip >= inputs.autoCloseAbsoluteUsdc) {
        // Foxify closes here
        const salvageGross = applySlip(mtmGross);
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
      const salvageGross = applySlip(structureValueAt(structure, sp, inputs.putStrike, inputs.callStrike, inputs.contractsBtc, remMs, inputs.sigmaAnnual, realismMultiplier, inputs.shortStrike));
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
    pathGenerator: useBootstrap ? "bootstrap" : "gbm",
    nets: inputs.returnNets ? foxifyNets : undefined,
    gammaScalp: gammaScalpMode ? {
      meanPerpHedgePnlUsdc: mean(gsPerpPnls),
      meanPerpFrictionUsdc: mean(gsFrictions),
      meanRebalances: mean(gsRebalances),
      frictionBps
    } : null
  };
};
