/**
 * Volume Cover spread-aware TP curve (2026-05-23).
 *
 * The single-leg TP curve in pilot/hedgeManager.ts is tuned for
 * biweekly strangles where each leg is monitored independently and
 * closed when ITS individual MTM crosses a threshold.
 *
 * Spread structures need different semantics:
 *
 *   - The spread's value moves between $0 and `spreadWidthUsdc` × contracts.
 *     Both legs always move together (long protects short).
 *
 *   - "TP" decisions operate on the SPREAD value, not individual legs.
 *     Closing one leg early would break the safety invariant (no naked
 *     short window). We always close ALL or close NOTHING (or partial-
 *     close on trigger per Item 1, which is a separate path).
 *
 *   - Three TP regimes for a spread:
 *
 *       prime    — early lock: spread MTM ≥ primeFraction × maxValue
 *                  Captures most of the upside while leaving small
 *                  remaining theta value for the holder of the spread.
 *
 *       full     — late lock: spread MTM ≥ fullFraction × maxValue
 *                  Almost full value; only close here if expiry close
 *                  or no path to additional profit.
 *
 *       bounce   — bounce recovery: spread MTM peaked at ≥ peakFraction,
 *                  then retraced to ≤ retraceFraction × peak. Lock the
 *                  partial profit before it evaporates.
 *
 *   - Vol-regime adjustment: in higher vol, be MORE aggressive (close
 *     sooner) because option time-decay accelerates and re-fill risk
 *     rises. In calm, be MORE patient.
 *
 * This module is PURE — it returns a TP signal given current MTM and
 * peak MTM. The decision to ACT on the signal lives in the hedge
 * manager (which is responsible for sequencing the close).
 */

import type { VolRegime } from "./strikeGrid";

// ─── Config ──────────────────────────────────────────────────────────

export type SpreadTpCurveConfig = {
  /** primeFraction × maxValue → "prime" TP signal */
  primeFraction: number;
  /** fullFraction × maxValue → "full" TP signal */
  fullFraction: number;
  /** Peak crossed peakFraction × maxValue (track all-time-high) */
  bouncePeakFraction: number;
  /** Then retraced to ≤ retraceFraction × peak */
  bounceRetraceFraction: number;
  /** Multiplier applied to fractions in stress regime (< 1 = tighter TP). */
  stressTighten: number;
  /** Multiplier applied to fractions in elevated regime. */
  elevatedTighten: number;
  /** Multiplier in moderate regime. */
  moderateTighten: number;
};

const DEFAULTS: SpreadTpCurveConfig = {
  primeFraction: 0.70,
  fullFraction: 0.90,
  bouncePeakFraction: 0.50,
  bounceRetraceFraction: 0.75,
  stressTighten: 0.85,
  elevatedTighten: 0.90,
  moderateTighten: 0.95
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const getConfiguredSpreadTpCurve = (): SpreadTpCurveConfig => ({
  primeFraction: readNumber("VC_SPREAD_TP_PRIME_FRACTION", DEFAULTS.primeFraction),
  fullFraction: readNumber("VC_SPREAD_TP_FULL_FRACTION", DEFAULTS.fullFraction),
  bouncePeakFraction: readNumber("VC_SPREAD_TP_BOUNCE_PEAK_FRACTION", DEFAULTS.bouncePeakFraction),
  bounceRetraceFraction: readNumber("VC_SPREAD_TP_BOUNCE_RETRACE_FRACTION", DEFAULTS.bounceRetraceFraction),
  stressTighten: readNumber("VC_SPREAD_TP_STRESS_TIGHTEN", DEFAULTS.stressTighten),
  elevatedTighten: readNumber("VC_SPREAD_TP_ELEVATED_TIGHTEN", DEFAULTS.elevatedTighten),
  moderateTighten: readNumber("VC_SPREAD_TP_MODERATE_TIGHTEN", DEFAULTS.moderateTighten)
});

// ─── Regime tighten ──────────────────────────────────────────────────

export const getRegimeTighten = (
  regime: VolRegime | null,
  cfg?: SpreadTpCurveConfig
): number => {
  const c = cfg ?? getConfiguredSpreadTpCurve();
  if (!regime) return 1.0;
  switch (regime) {
    case "stress": return c.stressTighten;
    case "elevated": return c.elevatedTighten;
    case "moderate": return c.moderateTighten;
    case "calm":
    default: return 1.0;
  }
};

// ─── Decision API ────────────────────────────────────────────────────

export type SpreadTpRule = "prime" | "full" | "bounce" | "none";

export type SpreadTpDecision = {
  rule: SpreadTpRule;
  shouldClose: boolean;
  currentMtmUsdc: number;
  peakMtmUsdc: number;
  maxValueUsdc: number;
  primeThresholdUsdc: number;
  fullThresholdUsdc: number;
  bouncePeakThresholdUsdc: number;
  bounceRetraceThresholdUsdc: number;
  regime: VolRegime | null;
  regimeTighten: number;
  reason: string;
};

/**
 * Evaluate the TP curve for a spread.
 *
 * Inputs:
 *   currentMtmUsdc: current spread MTM (long_value + long_call_value
 *                   − short_put_value − short_call_value, summed across
 *                   all 4 legs, times contracts)
 *   peakMtmUsdc:    running max of currentMtmUsdc since spread open
 *   maxValueUsdc:   spread cap (= spreadWidthUsdc × contracts, for [DB])
 *   regime:         current vol regime
 *
 * Output: a decision record with the matched rule (if any) and the
 * thresholds at which the rules evaluated. The hedge manager calls
 * closeSpread when shouldClose is true.
 */
export const evaluateSpreadTpRule = (params: {
  currentMtmUsdc: number;
  peakMtmUsdc: number;
  maxValueUsdc: number;
  regime: VolRegime | null;
  cfgOverride?: SpreadTpCurveConfig;
}): SpreadTpDecision => {
  const cfg = params.cfgOverride ?? getConfiguredSpreadTpCurve();
  const tighten = getRegimeTighten(params.regime, cfg);

  const primeThresholdUsdc = params.maxValueUsdc * cfg.primeFraction * tighten;
  const fullThresholdUsdc = params.maxValueUsdc * cfg.fullFraction * tighten;
  const bouncePeakThresholdUsdc = params.maxValueUsdc * cfg.bouncePeakFraction * tighten;
  const bounceRetraceThresholdUsdc = params.peakMtmUsdc * cfg.bounceRetraceFraction * tighten;

  const base = {
    currentMtmUsdc: params.currentMtmUsdc,
    peakMtmUsdc: params.peakMtmUsdc,
    maxValueUsdc: params.maxValueUsdc,
    primeThresholdUsdc,
    fullThresholdUsdc,
    bouncePeakThresholdUsdc,
    bounceRetraceThresholdUsdc,
    regime: params.regime,
    regimeTighten: tighten
  };

  // Evaluate full first (most aggressive), then prime, then bounce.
  if (params.currentMtmUsdc >= fullThresholdUsdc) {
    return {
      ...base,
      rule: "full",
      shouldClose: true,
      reason: `mtm ${params.currentMtmUsdc.toFixed(2)} ≥ full threshold ${fullThresholdUsdc.toFixed(2)}`
    };
  }
  if (params.currentMtmUsdc >= primeThresholdUsdc) {
    return {
      ...base,
      rule: "prime",
      shouldClose: true,
      reason: `mtm ${params.currentMtmUsdc.toFixed(2)} ≥ prime threshold ${primeThresholdUsdc.toFixed(2)}`
    };
  }
  // Bounce: peak crossed bouncePeakThresholdUsdc AND current ≤ bounceRetraceThresholdUsdc
  if (
    params.peakMtmUsdc >= bouncePeakThresholdUsdc &&
    params.currentMtmUsdc <= bounceRetraceThresholdUsdc
  ) {
    return {
      ...base,
      rule: "bounce",
      shouldClose: true,
      reason: `peak ${params.peakMtmUsdc.toFixed(2)} ≥ bounce-peak ${bouncePeakThresholdUsdc.toFixed(2)} and current ${params.currentMtmUsdc.toFixed(2)} ≤ retrace ${bounceRetraceThresholdUsdc.toFixed(2)}`
    };
  }

  return {
    ...base,
    rule: "none",
    shouldClose: false,
    reason: `no TP rule matched (mtm=${params.currentMtmUsdc.toFixed(2)}, peak=${params.peakMtmUsdc.toFixed(2)}, regime=${params.regime ?? "null"})`
  };
};
