/**
 * LiveCellEvService — runs a small Monte Carlo sim per cell at current live
 * conditions to estimate Foxify EV without hardcoded references.
 *
 * Replaces the V6_REF hardcoded lookup table in gate_with_ev. Always-fresh EV
 * numbers based on actual current cost, actual current strikes, current spot.
 *
 * Performance:
 *   - 2000 paths × 8 cells × 4 regimes = 64k path iterations
 *   - ~2-4 seconds total for full cell sweep
 *   - Cached per (cellId, regime, costBucket) for 5 minutes
 *   - Bars loaded once at boot (cached)
 *
 * Methodology mirrors runCellSweepV6.ts: MC paths via bootstrap (calm) or GBM,
 * trigger detection, peak-capture salvage, tier split, Foxify EV = share - cost.
 */

import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";
import {
  generateBootstrapPath,
  generateGbmPath,
  load5MinBars,
  mulberry32,
  __getBarsCacheSource,
  type PathConfig
} from "../../../scripts/backtest/singleSide/monteCarloEngine";
import { RISK_FREE_RATE } from "./optionPricing";
import { getCachedRegimeCalibrationOrDefault, SYNTHETIC_REGIME_SIGMAS, SYNTHETIC_REGIME_MARKUPS } from "./regimeCalibration";

const RFR = RISK_FREE_RATE; // pulls from BS_RISK_FREE_RATE env via optionPricing module
const N_PATHS = 2_000;            // smaller than V6's 8k for speed (still statistically meaningful)
const BAR_MINUTES = 5;
const CACHE_TTL_MS = 5 * 60_000;  // 5 min per (cellId, regime, costBucket)

// PHASE 2 (2026-05-30): regime sigmas + markups now come from
// regimeCalibration.getCachedRegimeCalibrationOrDefault() which prefers
// empirical medians from dvolHistory + chainSnapshotPersist over the
// synthetic defaults. Synthetic defaults (SYNTHETIC_REGIME_SIGMAS,
// SYNTHETIC_REGIME_MARKUPS) are the fallback when sample count is
// insufficient. The calibration cache is refreshed every 5 min.
const REGIME_SIGMAS = SYNTHETIC_REGIME_SIGMAS;  // fallback only
const REGIME_MARKUP = SYNTHETIC_REGIME_MARKUPS; // fallback only

export type LiveCellEvInputs = {
  cellId: string;
  spot: number;
  hedgeCostAtCalm: number;           // live cost at the spot price (calm-regime reference)
  putStrike: number;
  callStrike: number;
  tenorDays: number;
  triggerPctDown: number;
  triggerPctUp: number;
  regime: "calm" | "moderate" | "elevated" | "stress";
  contractsBtc: number;
  splitPct?: number;                  // default 0.85
  floorUsdc?: number;                 // default 25
  /**
   * REALISM CALIBRATION (added 2026-05-30):
   *
   * The MC sim values salvage via Black-Scholes at sim spot+remaining-time.
   * Real markets quote OTM/ITM strikes BELOW BS theoretical (due to vol skew,
   * spread, and bid-side discount). Live shadow probes have shown the gap
   * can be 2-3x — meaning a "PROFITABLE" verdict from BS-only MC can flip
   * to NEGATIVE once real bids are used.
   *
   * This multiplier scales every salvage value in the sim, simulating the
   * realistic bid-side haircut observed at activation time. Typical values:
   *   1.0  = no haircut (legacy BS-only — overstates EV)
   *   0.5  = real bids are half of BS theoretical (observed in calm conditions)
   *   0.7  = moderate haircut
   *
   * Defaults to 1.0 for back-compat. Caller (routes.ts) computes the ratio
   * from current bid vs current BS for the cell's actual strikes, then passes
   * the result so MC reflects what would actually be received on close.
   *
   * NOTE: this is an approximation — the ratio at current spot may differ
   * from the ratio at trigger spot. A deeper fix would haircut per-path
   * based on per-path market conditions (see PLAN.md option 3).
   */
  salvageRealismMultiplier?: number;
};

export type LiveCellEvResult = {
  hedgeCost: number;                  // cost at this regime (calm cost × regime markup)
  meanSalvage: number;
  triggerRate: number;
  meanFoxifyEv: number;
  meanAtticusEv: number;
  pctProfit: number;
  p5FoxifyEv: number;
  nPaths: number;
  computedAtMs: number;
  /** Which path generator was used: 'bootstrap' (historical sampling) or 'gbm' (theoretical). */
  pathGenerator: "bootstrap" | "gbm";
  /** Source of bars if bootstrap (e.g., 'tmp_file', 'deribit_30d'). null if gbm. */
  barsSource: string | null;
  /** Number of bars available for sampling if bootstrap. 0 if gbm. */
  barsCount: number;
  /** Salvage realism multiplier applied (1.0 = BS-only legacy, <1.0 = bid-adjusted). */
  salvageRealismMultiplier: number;
  /** Sigma actually used in this sim (from empirical calibration or synthetic default). */
  sigmaUsed: number;
  /** Source of sigma — "empirical_median" or "synthetic_default". Phase 2. */
  sigmaSource: "empirical_median" | "synthetic_default";
  /** How many DVOL history samples backed the empirical sigma. */
  sigmaSampleCount: number;
  /** Cost markup applied (1.0 = calm baseline). */
  markupUsed: number;
  /** Source of markup. */
  markupSource: "empirical_median" | "synthetic_default";
  /** How many chain snapshots backed the empirical markup. */
  markupSampleCount: number;
};

type CacheEntry = { result: LiveCellEvResult; expiresAtMs: number };

let _barsCache: Awaited<ReturnType<typeof load5MinBars>> | null = null;
const _resultCache = new Map<string, CacheEntry>();

const getBars = async () => {
  if (_barsCache) return _barsCache;
  try {
    _barsCache = await load5MinBars();
  } catch {
    _barsCache = null; // fall back to GBM
  }
  return _barsCache;
};

const cacheKey = (inputs: LiveCellEvInputs): string => {
  // Round cost to nearest $50 to allow some cache hits as prices drift slightly
  const costBucket = Math.round(inputs.hedgeCostAtCalm / 50) * 50;
  // Round spot to $500 for similar reason
  const spotBucket = Math.round(inputs.spot / 500) * 500;
  // Bucket realism multiplier to nearest 0.05 (e.g. 0.50, 0.55, 0.60)
  // so small bid drift doesn't bust cache, but distinct levels are separate
  const realism = inputs.salvageRealismMultiplier ?? 1.0;
  const realismBucket = Math.round(realism * 20) / 20;
  return `${inputs.cellId}::${inputs.regime}::${costBucket}::${spotBucket}::${inputs.putStrike}::${inputs.callStrike}::r${realismBucket}`;
};

/**
 * Compute live Foxify EV via fresh MC sim. Cached per (cellId, regime, cost-bucket).
 * Same methodology as runCellSweepV6.ts.
 */
export const computeLiveCellEv = async (inputs: LiveCellEvInputs): Promise<LiveCellEvResult> => {
  const now = Date.now();
  const key = cacheKey(inputs);
  const cached = _resultCache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.result;

  const bars = await getBars();
  // Phase 2: use empirical calibration when available; falls back to
  // synthetic defaults marked as "synthetic_default" via the calibration
  // structure (operator can inspect source via admin endpoint).
  const calibration = getCachedRegimeCalibrationOrDefault();
  const sigma = calibration[inputs.regime].sigma;
  const regimeMarkup = calibration[inputs.regime].markup;
  const hedgeCost = inputs.hedgeCostAtCalm * regimeMarkup;
  const slip = 0.82;
  const splitPct = inputs.splitPct ?? 0.85;
  const floorUsdc = inputs.floorUsdc ?? 25;
  // Realism multiplier applied to ALL salvages (both triggered and untriggered
  // paths). Default 1.0 = legacy BS-only behavior. <1.0 simulates the real
  // bid-side discount observed in live shadow probes.
  const realism = Math.max(0, Math.min(1.5, inputs.salvageRealismMultiplier ?? 1.0));

  const triggerDownPx = inputs.spot * (1 - inputs.triggerPctDown);
  const triggerUpPx = inputs.spot * (1 + inputs.triggerPctUp);

  const rng = mulberry32(42);
  const pathConfig: PathConfig = {
    tenorDays: inputs.tenorDays,
    sigmaAnnual: sigma,
    driftAnnual: 0,
    generator: inputs.regime === "calm" && bars ? "bootstrap" : "gbm",
    seed: 42
  };

  const foxifyEvs: number[] = [];
  const atticusEvs: number[] = [];
  const salvages: number[] = [];
  let triggers = 0;

  for (let p = 0; p < N_PATHS; p++) {
    const pathBars = bars && inputs.regime === "calm"
      ? generateBootstrapPath(inputs.spot, pathConfig, bars, rng)
      : generateGbmPath(inputs.spot, pathConfig, rng);
    let triggerBar = -1;
    let triggerSide: "down" | "up" | null = null;
    for (let i = 1; i < pathBars.closes.length; i++) {
      if (pathBars.lows[i] <= triggerDownPx) { triggerBar = i; triggerSide = "down"; break; }
      if (pathBars.highs[i] >= triggerUpPx) { triggerBar = i; triggerSide = "up"; break; }
    }
    let salvage = 0;
    if (triggerBar === -1) {
      const sellAt = Math.max(0, pathBars.closes.length - 1 - 48);
      const sp = pathBars.closes[sellAt];
      const remDays = ((pathBars.closes.length - 1 - sellAt) * BAR_MINUTES) / (60 * 24);
      const T2 = Math.max(0, remDays / 365);
      salvage = (Math.max(0, bsPut(sp, inputs.putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, inputs.callStrike, T2, RFR, sigma))) * inputs.contractsBtc * slip * realism;
    } else {
      triggers++;
      const captureEnd = Math.min(triggerBar + 6, pathBars.closes.length - 1);
      let peak = 0;
      for (let i = triggerBar; i <= captureEnd; i++) {
        const sp = triggerSide === "down" ? pathBars.lows[i] : pathBars.highs[i];
        const remBars = pathBars.closes.length - 1 - i;
        const remDays = (remBars * BAR_MINUTES) / (60 * 24);
        const T2 = Math.max(0, remDays / 365);
        const v = (Math.max(0, bsPut(sp, inputs.putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, inputs.callStrike, T2, RFR, sigma))) * inputs.contractsBtc;
        if (v > peak) peak = v;
      }
      salvage = peak * slip * realism;
    }
    salvages.push(salvage);
    const uplift = salvage - hedgeCost;
    let atticusShare = 0;
    let foxifyShare: number;
    if (uplift <= 0) {
      foxifyShare = salvage;
    } else {
      atticusShare = Math.min(uplift, Math.max((1 - splitPct) * uplift, floorUsdc));
      foxifyShare = hedgeCost + (uplift - atticusShare);
    }
    foxifyEvs.push(foxifyShare - hedgeCost);
    atticusEvs.push(atticusShare);
  }
  const sortedF = [...foxifyEvs].sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  // Identify which path generator was actually used. Bootstrap requires bars;
  // GBM fallback fires when bars unavailable OR regime != calm.
  const usedBootstrap = inputs.regime === "calm" && bars != null && bars.length > 0;
  const result: LiveCellEvResult = {
    hedgeCost,
    meanSalvage: mean(salvages),
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: mean(foxifyEvs),
    meanAtticusEv: mean(atticusEvs),
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    nPaths: N_PATHS,
    computedAtMs: now,
    pathGenerator: usedBootstrap ? "bootstrap" : "gbm",
    barsSource: usedBootstrap ? __getBarsCacheSource() : null,
    barsCount: usedBootstrap ? (bars?.length ?? 0) : 0,
    salvageRealismMultiplier: realism,
    sigmaUsed: sigma,
    sigmaSource: calibration[inputs.regime].sigmaSource,
    sigmaSampleCount: calibration[inputs.regime].sigmaSampleCount,
    markupUsed: regimeMarkup,
    markupSource: calibration[inputs.regime].markupSource,
    markupSampleCount: calibration[inputs.regime].markupSampleCount
  };
  _resultCache.set(key, { result, expiresAtMs: now + CACHE_TTL_MS });
  return result;
};

/** For tests / observability. */
export const __getLiveCellEvCacheSize = (): number => _resultCache.size;
export const __resetLiveCellEvCache = (): void => { _resultCache.clear(); _barsCache = null; };
