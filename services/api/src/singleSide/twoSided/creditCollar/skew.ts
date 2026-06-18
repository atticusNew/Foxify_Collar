/**
 * Skew curve helpers — Phase A (pure, offline). For tests + sim only.
 *
 * Production wires the per-strike vol from the Deribit mark-IV ladder (deribitIvLadder.ts).
 * These synthetic curves let the solver + sim run deterministically without live data and let
 * tests assert the skew-driven asymmetry (the whole reason the credit is achievable).
 */

import type { SkewCurve } from "./creditCollarPricer";

/** Flat (no-skew) curve — produces a DEBIT at symmetric strikes; used to prove skew is required. */
export const flatSkew = (atmIv: number): SkewCurve => () => atmIv;

/**
 * Linear downside skew: IV rises as strike falls below spot (puts richer), falls above (calls cheaper).
 *   iv(K) = clamp(atmIv + slope × (spot − K)/spot, ivFloor, ivCap)
 * `slopePer10pct` is the IV increase per 10% drop in strike (e.g. 0.10 = +10 vol pts per −10% strike).
 */
export const linearDownsideSkew = (
  spot: number,
  atmIv: number,
  slopePer10pct: number,
  ivFloor = 0.05,
  ivCap = 5.0
): SkewCurve => {
  const slope = slopePer10pct / 0.1;
  return (strike: number) => {
    const moneyness = (spot - strike) / spot; // >0 below spot, <0 above
    const iv = atmIv + slope * moneyness;
    return Math.max(ivFloor, Math.min(ivCap, iv));
  };
};
