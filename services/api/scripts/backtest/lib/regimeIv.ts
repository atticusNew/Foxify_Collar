/**
 * Shared backtest IV calibration — regime-conditional implied vol.
 *
 * Used by ALL backtest engines (volumeCover, singleSide, future).
 *
 * Why this exists:
 * Historical realized volatility (computed from past returns) is NOT
 * the same as implied volatility (what the option market actually
 * charges). Using realized vol as the BS implied-vol input to compute
 * hedge costs OVERSTATES costs in moderate/elevated regimes by 20-40%
 * because realized vol can spike on single-day moves while implied vol
 * smoothly anticipates them.
 *
 * This module provides the canonical regime-conditional IV table that
 * all backtests should use for hedge cost simulation. Realized vol
 * still drives:
 *   - Regime classification (which IV bucket applies)
 *   - Trigger detection (whether spot actually crosses trigger band)
 *
 * Implied vol (this module) drives:
 *   - BS hedge cost calculation
 *   - IV-aware pricing scaling formulas
 *
 * Calibration anchor: live Bullish data 2026-05-16 showed 3-day BTC
 * ATM IV at 33% (calm regime). Other regime IVs extrapolated from
 * historical implied vol patterns:
 *   - Moderate (typical): 50-60%
 *   - Elevated (high-vol): 70-80%
 *   - Stress (extreme):   90-100%
 *
 * These numbers are env-overridable for sensitivity testing:
 *   BACKTEST_IV_CALM, BACKTEST_IV_MODERATE,
 *   BACKTEST_IV_ELEVATED, BACKTEST_IV_STRESS
 *
 * If real conditions diverge significantly from these IVs, the
 * backtest can be re-run with adjusted env values to test sensitivity.
 */

export type Regime = "calm" | "moderate" | "elevated" | "stress";

export const DEFAULT_REGIME_IV: Record<Regime, number> = {
  calm: 0.35,
  moderate: 0.55,
  elevated: 0.75,
  stress: 0.95
};

/**
 * Resolve the regime-conditional IV used for BS hedge cost in
 * backtests. Reads env override if present; otherwise uses calibrated
 * defaults.
 */
export const getRegimeIv = (regime: Regime): number => {
  const envKey = `BACKTEST_IV_${regime.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined && envVal !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_REGIME_IV[regime];
};

/**
 * Classify a regime from realized vol (annualized). Used by historical
 * data loaders to bucket each day.
 */
export const classifyRegime = (annualVol: number): Regime => {
  if (annualVol < 0.50) return "calm";
  if (annualVol < 0.70) return "moderate";
  if (annualVol < 0.90) return "elevated";
  return "stress";
};

/**
 * Convenience: given a date's realized vol, return the IV that
 * should be used for BS hedge cost on that day. Combines
 * classification + table lookup in one call.
 */
export const ivForDay = (annualRealizedVol: number): number => {
  return getRegimeIv(classifyRegime(annualRealizedVol));
};
