/**
 * QUARANTINED: Foxify pilot calibration constants.
 *
 * This file is intentionally NOT imported by any product-code module in
 * this rebuild package. It exists only to:
 *   1. Document what was previously baked into research/kalshi-shadow-backtest/
 *      (the prior research package, which carried Foxify calibrations).
 *   2. Serve as a fallback if Kalshi-native calibration data is unavailable
 *      for a specific calculation — but only via explicit opt-in by the
 *      caller, with a comment explaining why.
 *
 * Underscore prefix on the filename signals "internal / do not import casually".
 *
 * Source citations (from the prior package's comments):
 *   - IV-from-realized-vol scalars  : Foxify CFO report §3.2
 *   - Skew slope (vol-pts per % OTM): Foxify pilot empirical
 *   - TP recovery rates by regime    : Foxify R1 §3.4 (n=9 trades)
 *   - 1.40× / 1.45× markup           : Foxify margin target
 *
 * For the Kalshi rebuild, we replace these with:
 *   - Direct BS pricing using rvol as IV proxy + explicit vol risk premium
 *     scalar passed by the caller (no hidden scalar)
 *   - Skew add-on parameterized by caller
 *   - TP recovery NOT modeled in the rebuild backtest (pass-through only;
 *     un-triggered hedges expire worthless or are sold back at unspecified
 *     value — we book zero recovery as a conservative lower bound)
 *   - Markups are explicit per-tier configuration, not a Foxify default
 */

export const FOXIFY_DEPRECATED_NOTE =
  "If you see this string in any pitch artifact, the rebuild has regressed — " +
  "the goal is zero Foxify carryover in product-facing numbers.";
