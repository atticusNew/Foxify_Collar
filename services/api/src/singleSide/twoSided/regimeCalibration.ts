/**
 * Regime calibration — replaces hardcoded REGIME_SIGMAS and REGIME_MARKUP
 * in liveCellEvService with empirically derived values from DVOL history
 * and chain snapshot history.
 *
 * The OLD synthetic defaults (kept as fallbacks when no history exists):
 *   REGIME_SIGMAS = { calm: 0.35, moderate: 0.55, elevated: 0.75, stress: 0.95 }
 *   REGIME_MARKUP = { calm: 1.00, moderate: 1.15, elevated: 1.35, stress: 1.60 }
 *
 * The NEW empirical derivation:
 *   - For each regime, look up median observed DVOL/100 (from dvolHistory)
 *     over the last 30-90 days
 *   - For each regime, look up median ATM strangle ask-widening ratio
 *     vs calm baseline (from chainSnapshotPersist)
 *
 * Fallback rules (per regime independently):
 *   - sigma:   need >= MIN_SIGMA_SAMPLES samples
 *   - markup:  need >= MIN_MARKUP_SAMPLES samples + calm baseline available
 * Otherwise fall back to documented synthetic default for that regime.
 *
 * Cached for 5 min per regime — recomputed on cache miss.
 */

import type { Pool, PoolClient } from "pg";
import type { Regime } from "./featureFlag";
import { getAllRegimeSigmaStats, type RegimeSigmaStats } from "./dvolHistory";
import { getRegimeMarkupStats, type RegimeMarkupStats } from "./chainSnapshotPersist";

// ──────────── Synthetic defaults (fallback when no history) ────────────

export const SYNTHETIC_REGIME_SIGMAS: Record<Regime, number> = {
  calm: Number(process.env.SYNTHETIC_SIGMA_CALM ?? "0.35"),
  moderate: Number(process.env.SYNTHETIC_SIGMA_MODERATE ?? "0.55"),
  elevated: Number(process.env.SYNTHETIC_SIGMA_ELEVATED ?? "0.75"),
  stress: Number(process.env.SYNTHETIC_SIGMA_STRESS ?? "0.95")
};

export const SYNTHETIC_REGIME_MARKUPS: Record<Regime, number> = {
  calm: 1.0,
  moderate: Number(process.env.SYNTHETIC_MARKUP_MODERATE ?? "1.15"),
  elevated: Number(process.env.SYNTHETIC_MARKUP_ELEVATED ?? "1.35"),
  stress: Number(process.env.SYNTHETIC_MARKUP_STRESS ?? "1.60")
};

const MIN_SIGMA_SAMPLES = Number(process.env.MIN_SIGMA_CALIB_SAMPLES ?? "100");
const MIN_MARKUP_SAMPLES = Number(process.env.MIN_MARKUP_CALIB_SAMPLES ?? "100");
const CALIBRATION_CACHE_TTL_MS = Number(process.env.CALIBRATION_CACHE_TTL_MS ?? "300000"); // 5 min

// ──────────── Types ────────────

export type RegimeCalibration = {
  regime: Regime;
  sigma: number;
  sigmaSource: "empirical_median" | "empirical_ewma" | "synthetic_default";
  sigmaSampleCount: number;
  markup: number;
  markupSource: "empirical_median" | "synthetic_default";
  markupSampleCount: number;
};

export type FullRegimeCalibration = Record<Regime, RegimeCalibration>;

// ──────────── Cache ────────────

let _cache: { result: FullRegimeCalibration; expiresAtMs: number; weighting: "median" | "ewma" } | null = null;

export const __resetCalibrationCache = (): void => {
  _cache = null;
};

// ──────────── Computation ────────────

const lookbackForRegime = (regime: Regime): number => {
  // Calm has more samples (most of time spent there), so we can use shorter lookback
  // Higher regimes are rarer — use longer lookback to accumulate enough samples
  if (regime === "calm") return 30 * 86_400_000;       // 30d
  if (regime === "moderate") return 60 * 86_400_000;   // 60d
  return 90 * 86_400_000;                              // 90d for elevated/stress
};

/**
 * Compute calibration for all four regimes. Caches result for 5 min so
 * MC sims (which run for every cell × regime) don't hammer the DB.
 */
export const getRegimeCalibration = async (
  pool: Pool | PoolClient,
  opts: { nowMs?: number; bypassCache?: boolean; weighting?: "median" | "ewma"; halfLifeDays?: number } = {}
): Promise<FullRegimeCalibration> => {
  const nowMs = opts.nowMs ?? Date.now();
  // Recency-weighting: median (default, stable) or ewma (tracks transitions faster).
  // Env-selectable (SS_CALIB_WEIGHTING / SS_CALIB_HALFLIFE_DAYS); opts override env.
  const weighting: "median" | "ewma" = opts.weighting
    ?? ((process.env.SS_CALIB_WEIGHTING === "ewma") ? "ewma" : "median");
  const halfLifeDays = opts.halfLifeDays ?? Number(process.env.SS_CALIB_HALFLIFE_DAYS ?? "14");
  // Cache is keyed on weighting so median/ewma don't collide.
  if (!opts.bypassCache && _cache && _cache.expiresAtMs > nowMs && _cache.weighting === weighting) {
    return _cache.result;
  }

  // Use uniform 90d lookback for sigma stats query, then per-regime sample-count
  // gates for fallback decisions.
  const sigmaStats = await getAllRegimeSigmaStats(pool as Pool, {
    lookbackMs: 90 * 86_400_000, // pull 90d, gates filter per-regime
    nowMs,
    halfLifeDays
  });
  const markupStats = await getRegimeMarkupStats(pool as Pool, {
    lookbackMs: 90 * 86_400_000,
    nowMs
  });

  const regimes: Regime[] = ["calm", "moderate", "elevated", "stress"];
  const out: Partial<FullRegimeCalibration> = {};
  for (const regime of regimes) {
    const ss = sigmaStats[regime];
    const ms = markupStats[regime];
    const empiricalSigma = weighting === "ewma" ? ss.ewmaSigma : ss.medianSigma;
    const useEmpiricalSigma = ss.sampleCount >= MIN_SIGMA_SAMPLES && empiricalSigma != null && empiricalSigma > 0;
    const useEmpiricalMarkup = ms.sampleCount >= MIN_MARKUP_SAMPLES && ms.markupVsCalm != null && ms.markupVsCalm > 0;
    out[regime] = {
      regime,
      sigma: useEmpiricalSigma ? (empiricalSigma as number) : SYNTHETIC_REGIME_SIGMAS[regime],
      sigmaSource: useEmpiricalSigma ? (weighting === "ewma" ? "empirical_ewma" : "empirical_median") : "synthetic_default",
      sigmaSampleCount: ss.sampleCount,
      markup: useEmpiricalMarkup ? (ms.markupVsCalm as number) : SYNTHETIC_REGIME_MARKUPS[regime],
      markupSource: useEmpiricalMarkup ? "empirical_median" : "synthetic_default",
      markupSampleCount: ms.sampleCount
    };
  }
  const result = out as FullRegimeCalibration;
  _cache = { result, expiresAtMs: nowMs + CALIBRATION_CACHE_TTL_MS, weighting };
  return result;
};

/**
 * Synchronous helper: returns the cached calibration if available, else
 * synthetic defaults. Used in hot paths (MC sim inner loop) to avoid await
 * on every iteration.
 */
export const getCachedRegimeCalibrationOrDefault = (): FullRegimeCalibration => {
  if (_cache && _cache.expiresAtMs > Date.now()) return _cache.result;
  // Fallback: synthetic defaults marked as "synthetic_default" so callers
  // can see this came from the fallback path.
  const regimes: Regime[] = ["calm", "moderate", "elevated", "stress"];
  const out: Partial<FullRegimeCalibration> = {};
  for (const r of regimes) {
    out[r] = {
      regime: r,
      sigma: SYNTHETIC_REGIME_SIGMAS[r],
      sigmaSource: "synthetic_default",
      sigmaSampleCount: 0,
      markup: SYNTHETIC_REGIME_MARKUPS[r],
      markupSource: "synthetic_default",
      markupSampleCount: 0
    };
  }
  return out as FullRegimeCalibration;
};

/**
 * Diagnostic summary — exposes the calibration to operator via admin endpoint.
 */
export type CalibrationSummary = {
  asOf: string;
  cache_age_ms: number | null;
  cache_ttl_ms: number;
  min_sigma_samples_required: number;
  min_markup_samples_required: number;
  regimes: FullRegimeCalibration;
  synthetic_defaults: {
    sigmas: Record<Regime, number>;
    markups: Record<Regime, number>;
  };
};

export const getCalibrationSummary = async (
  pool: Pool,
  nowMs?: number,
  opts: { bypassCache?: boolean } = {}
): Promise<CalibrationSummary> => {
  const now = nowMs ?? Date.now();
  // bypassCache=true recomputes from the DB (e.g. right after a DVOL backfill,
  // where the 5-min cache would otherwise serve the pre-backfill calibration).
  const calibration = await getRegimeCalibration(pool, { nowMs: now, bypassCache: opts.bypassCache });
  const cacheAge = _cache ? now - (_cache.expiresAtMs - CALIBRATION_CACHE_TTL_MS) : null;
  return {
    asOf: new Date(now).toISOString(),
    cache_age_ms: cacheAge,
    cache_ttl_ms: CALIBRATION_CACHE_TTL_MS,
    min_sigma_samples_required: MIN_SIGMA_SAMPLES,
    min_markup_samples_required: MIN_MARKUP_SAMPLES,
    regimes: calibration,
    synthetic_defaults: {
      sigmas: SYNTHETIC_REGIME_SIGMAS,
      markups: SYNTHETIC_REGIME_MARKUPS
    }
  };
};
