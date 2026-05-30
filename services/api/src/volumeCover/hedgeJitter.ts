/**
 * Volume Cover hedge-execution jitter layer (2026-05-23).
 *
 * Calibrated randomness layered onto each Bullish hedge execution so
 * that timing, strike selection, and sizing patterns cannot be
 * fingerprinted by external observers (Foxify bot, market makers,
 * other counterparties).
 *
 * Four independent jitter dimensions:
 *
 *   1. Open delay — wait Uniform[openDelayMinMs, openDelayMaxMs] before
 *      submitting the FIRST leg of a multi-leg hedge. Decouples
 *      hedge-open timing from the Foxify activation event.
 *
 *   2. Inter-leg pacing — between consecutive legs, wait
 *      Uniform[interLegMinMs, interLegMaxMs]. Adds variability to the
 *      open/close sequence so the 4-leg pattern doesn't always show
 *      up as a tight burst.
 *
 *   3. Strike-within-tolerance — given an ideal strike and the venue's
 *      $1000 grid, optionally jitter to one of the N nearest liquid
 *      strikes (1-grid-step inside or outside the band, gated by
 *      pre-trade liquidity check). Default off — only enable once the
 *      band has slack.
 *
 *   4. Contracts-within-tolerance — apply ±tolerancePct jitter to the
 *      base contract size (e.g. ±2% on a 1.0 BTC base → 0.98..1.02).
 *      Rounded to venue granularity (0.01 BTC for Bullish options).
 *
 * All four dimensions are env-configurable and individually toggleable
 * via VC_HEDGE_JITTER_*_ENABLED flags so we can dial intensity as the
 * pilot matures.
 *
 * RNG-injection via opts.randFn for deterministic tests.
 */

import Decimal from "decimal.js";

// ─── Config ──────────────────────────────────────────────────────────

export type HedgeJitterConfig = {
  openDelayEnabled: boolean;
  openDelayMinMs: number;
  openDelayMaxMs: number;
  interLegEnabled: boolean;
  interLegMinMs: number;
  interLegMaxMs: number;
  strikeTolerance: {
    enabled: boolean;
    /** Max # grid steps deviation either side of ideal (default 0 = no shift). */
    maxGridStepDeviation: number;
  };
  contractsTolerance: {
    enabled: boolean;
    /** ± fraction applied to base contracts. e.g. 0.02 = ±2%. */
    tolerancePct: number;
    /** Round result to this granularity (BTC). Default 0.01. */
    granularityBtc: number;
  };
};

const DEFAULTS: HedgeJitterConfig = {
  openDelayEnabled: true,
  openDelayMinMs: 0,
  openDelayMaxMs: 15_000,
  interLegEnabled: true,
  interLegMinMs: 500,
  interLegMaxMs: 3_000,
  strikeTolerance: {
    enabled: false,
    maxGridStepDeviation: 0
  },
  contractsTolerance: {
    enabled: true,
    tolerancePct: 0.02,
    granularityBtc: 0.01
  }
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() !== "false";
};

export const getConfiguredHedgeJitter = (): HedgeJitterConfig => ({
  openDelayEnabled: readBool("VC_HEDGE_JITTER_OPEN_DELAY_ENABLED", DEFAULTS.openDelayEnabled),
  openDelayMinMs: readNumber("VC_HEDGE_JITTER_OPEN_DELAY_MIN_MS", DEFAULTS.openDelayMinMs),
  openDelayMaxMs: readNumber("VC_HEDGE_JITTER_OPEN_DELAY_MAX_MS", DEFAULTS.openDelayMaxMs),
  interLegEnabled: readBool("VC_HEDGE_JITTER_INTERLEG_ENABLED", DEFAULTS.interLegEnabled),
  interLegMinMs: readNumber("VC_HEDGE_JITTER_INTERLEG_MIN_MS", DEFAULTS.interLegMinMs),
  interLegMaxMs: readNumber("VC_HEDGE_JITTER_INTERLEG_MAX_MS", DEFAULTS.interLegMaxMs),
  strikeTolerance: {
    enabled: readBool("VC_HEDGE_JITTER_STRIKE_ENABLED", DEFAULTS.strikeTolerance.enabled),
    maxGridStepDeviation: readNumber(
      "VC_HEDGE_JITTER_STRIKE_MAX_GRID_STEPS",
      DEFAULTS.strikeTolerance.maxGridStepDeviation
    )
  },
  contractsTolerance: {
    enabled: readBool("VC_HEDGE_JITTER_CONTRACTS_ENABLED", DEFAULTS.contractsTolerance.enabled),
    tolerancePct: (() => {
      const n = readNumber("VC_HEDGE_JITTER_CONTRACTS_TOLERANCE_PCT", DEFAULTS.contractsTolerance.tolerancePct);
      return Math.min(0.10, Math.max(0, n)); // cap at 10%
    })(),
    granularityBtc:
      readNumber("VC_HEDGE_JITTER_CONTRACTS_GRANULARITY_BTC", DEFAULTS.contractsTolerance.granularityBtc) ||
      DEFAULTS.contractsTolerance.granularityBtc
  }
});

// ─── Samplers ────────────────────────────────────────────────────────

const sampleUniformInt = (
  minInclusive: number,
  maxInclusive: number,
  randFn: () => number
): number => {
  if (maxInclusive <= minInclusive) return minInclusive;
  return Math.floor(randFn() * (maxInclusive - minInclusive + 1)) + minInclusive;
};

const sampleUniformFloat = (
  min: number,
  max: number,
  randFn: () => number
): number => {
  if (max <= min) return min;
  return min + randFn() * (max - min);
};

const sampleSignedDeviation = (
  maxAbsolute: number,
  randFn: () => number
): number => {
  if (maxAbsolute <= 0) return 0;
  // Sample from uniform on integer range [-maxAbsolute, maxAbsolute]
  return sampleUniformInt(-maxAbsolute, maxAbsolute, randFn);
};

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Sample the random open-delay before the first leg. Returns 0 if
 * disabled.
 */
export const sampleOpenDelayMs = (opts?: {
  cfg?: HedgeJitterConfig;
  randFn?: () => number;
}): number => {
  const cfg = opts?.cfg ?? getConfiguredHedgeJitter();
  if (!cfg.openDelayEnabled) return 0;
  return sampleUniformInt(cfg.openDelayMinMs, cfg.openDelayMaxMs, opts?.randFn ?? Math.random);
};

/**
 * Sample the random pacing between consecutive legs. Returns 0 if
 * disabled.
 */
export const sampleInterLegPacingMs = (opts?: {
  cfg?: HedgeJitterConfig;
  randFn?: () => number;
}): number => {
  const cfg = opts?.cfg ?? getConfiguredHedgeJitter();
  if (!cfg.interLegEnabled) return 0;
  return sampleUniformInt(cfg.interLegMinMs, cfg.interLegMaxMs, opts?.randFn ?? Math.random);
};

/**
 * Maybe shift the ideal strike by up to N grid steps within a hard
 * trigger-band guard. Caller passes the band edges to prevent the
 * jitter from exiting the safe boundary.
 *
 * Returns the original ideal if disabled or if any candidate would
 * exit the band.
 */
export const jitterStrikeWithinTolerance = (params: {
  idealStrikeUsdc: number;
  gridStepUsdc: number;
  /** Inclusive lower bound the strike may not cross (e.g. trigger floor + 1 step). */
  lowerBoundUsdc: number;
  /** Inclusive upper bound the strike may not cross. */
  upperBoundUsdc: number;
  cfg?: HedgeJitterConfig;
  randFn?: () => number;
}): number => {
  const cfg = params.cfg ?? getConfiguredHedgeJitter();
  if (!cfg.strikeTolerance.enabled || cfg.strikeTolerance.maxGridStepDeviation <= 0) {
    return params.idealStrikeUsdc;
  }
  const randFn = params.randFn ?? Math.random;
  const dev = sampleSignedDeviation(cfg.strikeTolerance.maxGridStepDeviation, randFn);
  const candidate = params.idealStrikeUsdc + dev * params.gridStepUsdc;
  if (candidate < params.lowerBoundUsdc || candidate > params.upperBoundUsdc) {
    return params.idealStrikeUsdc;
  }
  return candidate;
};

/**
 * Apply ±tolerancePct jitter to a BTC contract size and round to the
 * venue's contract granularity. Result is always strictly positive
 * (clamped to one granularity step if jitter would drive below).
 *
 * Returns the original base if contractsTolerance is disabled.
 */
export const jitterContractsWithinTolerance = (params: {
  baseContractsBtc: number;
  cfg?: HedgeJitterConfig;
  randFn?: () => number;
}): number => {
  const cfg = params.cfg ?? getConfiguredHedgeJitter();
  if (!cfg.contractsTolerance.enabled || cfg.contractsTolerance.tolerancePct <= 0) {
    return params.baseContractsBtc;
  }
  const randFn = params.randFn ?? Math.random;
  const tol = cfg.contractsTolerance.tolerancePct;
  // Sample uniformly in [-tol, +tol]
  const deviation = sampleUniformFloat(-tol, tol, randFn);
  const raw = new Decimal(params.baseContractsBtc).mul(1 + deviation);
  const gran = new Decimal(cfg.contractsTolerance.granularityBtc);
  const snapped = raw.div(gran).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(gran);
  if (snapped.lte(0)) return gran.toNumber();
  return snapped.toNumber();
};

// ─── Sleep helper (mirror of silentDisruption.sleepMs to keep modules
// independent — both call setTimeout). ────────────────────────────────

export const jitterSleepMs = (ms: number): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
};
