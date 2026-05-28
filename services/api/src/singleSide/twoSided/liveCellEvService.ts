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
  type PathConfig
} from "../../../scripts/backtest/singleSide/monteCarloEngine";

const RFR = 0.045;
const N_PATHS = 2_000;            // smaller than V6's 8k for speed (still statistically meaningful)
const BAR_MINUTES = 5;
const CACHE_TTL_MS = 5 * 60_000;  // 5 min per (cellId, regime, costBucket)

const REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 } as const;
const REGIME_MARKUP = { calm: 1.0, moderate: 1.15, elevated: 1.35, stress: 1.60 } as const;

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
  return `${inputs.cellId}::${inputs.regime}::${costBucket}::${spotBucket}::${inputs.putStrike}::${inputs.callStrike}`;
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
  const sigma = REGIME_SIGMAS[inputs.regime];
  const regimeMarkup = REGIME_MARKUP[inputs.regime];
  const hedgeCost = inputs.hedgeCostAtCalm * regimeMarkup;
  const slip = 0.82;
  const splitPct = inputs.splitPct ?? 0.85;
  const floorUsdc = inputs.floorUsdc ?? 25;

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
      salvage = (Math.max(0, bsPut(sp, inputs.putStrike, T2, RFR, sigma)) + Math.max(0, bsCall(sp, inputs.callStrike, T2, RFR, sigma))) * inputs.contractsBtc * slip;
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
      salvage = peak * slip;
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
  const result: LiveCellEvResult = {
    hedgeCost,
    meanSalvage: mean(salvages),
    triggerRate: triggers / N_PATHS,
    meanFoxifyEv: mean(foxifyEvs),
    meanAtticusEv: mean(atticusEvs),
    pctProfit: foxifyEvs.filter((x) => x > 0).length / foxifyEvs.length,
    p5FoxifyEv: sortedF[Math.floor(sortedF.length * 0.05)],
    nPaths: N_PATHS,
    computedAtMs: now
  };
  _resultCache.set(key, { result, expiresAtMs: now + CACHE_TTL_MS });
  return result;
};

/** For tests / observability. */
export const __getLiveCellEvCacheSize = (): number => _resultCache.size;
export const __resetLiveCellEvCache = (): void => { _resultCache.clear(); _barsCache = null; };
