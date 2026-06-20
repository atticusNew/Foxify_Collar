/**
 * Skew curve helpers — Phase A (pure, offline). For tests + sim only.
 *
 * Production wires the per-strike vol from the Deribit mark-IV ladder (deribitIvLadder.ts).
 * These synthetic curves let the solver + sim run deterministically without live data and let
 * tests assert the skew-driven asymmetry (the whole reason the credit is achievable).
 */

import type { SkewCurve, AtticusSpreadConfig } from "./creditCollarPricer";

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

/**
 * Wing/tenor-aware leg HALF-spread model (USDC/BTC) for the pricer's `legHalfSpreadUsdcPerBtc`.
 *
 * Phase 0 review #3a: the solver crosses at the WINGS (cap ~1.5–2.5% OTM, floor ~4% OTM), and OTM
 * wings are materially wider than ATM. A flat %-of-premium (or an ATM capture) flatters back-to-back
 * and mislocates the crossover. This widens the relative half-spread with |moneyness| and (optionally)
 * with shorter tenor. Replace this synthetic curve with the MEASURED Bullish wing spreads when
 * available — same callback signature.
 */
export const wingAwareLegSpread = (params: {
  /** ATM half-spread as a fraction of mid premium (e.g. 0.05 = ±5% at the money). */
  atmRelHalfPct: number;
  /** Extra relative half-spread per 1% of |OTM moneyness| (e.g. 0.5 ⟹ +50% per 1% OTM). */
  widenPerOtmPct: number;
  /** Absolute half-spread floor, USDC/BTC. */
  absUsdcPerBtc: number;
  /** Optional: tenor at which atmRelHalfPct is quoted; shorter tenors widen by sqrt(ref/tenor). */
  tenorRefDays?: number;
}): NonNullable<AtticusSpreadConfig["legHalfSpreadUsdcPerBtc"]> => {
  return ({ strike, spot, tenorDays, midPerBtc }) => {
    const otmPct = Math.abs(strike - spot) / spot * 100; // |moneyness| in percent
    let rel = params.atmRelHalfPct * (1 + params.widenPerOtmPct * otmPct);
    if (params.tenorRefDays && params.tenorRefDays > 0 && tenorDays > 0) {
      rel *= Math.sqrt(params.tenorRefDays / tenorDays);
    }
    return Math.max(midPerBtc * rel, params.absUsdcPerBtc);
  };
};
