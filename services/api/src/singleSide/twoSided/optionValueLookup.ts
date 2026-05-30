/**
 * Combined option value lookup for the two-sided strangle.
 *
 * Production TP loop uses this to convert (current spot, time remaining,
 * implied vol) → combined put + call value.
 *
 * Two strategies:
 *   1. BS-theoretical with calibration multipliers (default).
 *      Uses the per-leg calibration multiplier captured at activation
 *      (live_anchor_ask / BS_at_anchor_σ) to convert BS at current σ → market value.
 *   2. Live-mark from chain (Phase 1 enhancement; not implemented here).
 *
 * For PR 4 we ship strategy 1. Strategy 2 will plug into the same interface.
 */

import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";

export type CombinedValueInput = {
  spot: number;
  putStrike: number;
  callStrike: number;
  contractsBtc: number;
  msToExpiry: number;
  sigmaAnnual: number;
  riskFreeRate: number;
  /** Per-leg calibration multipliers captured at activation:
   * calib = live_anchor_ask / BS_at_anchor_σ.
   * Applied as: leg_value = BS_at_current_σ × calib × contracts. */
  putCalibrationMultiplier: number;
  callCalibrationMultiplier: number;
};

export type CombinedValueResult = {
  putValueUsdc: number;
  callValueUsdc: number;
  totalUsdc: number;
};

const MS_PER_YEAR = 365 * 86_400_000;

export const computeCombinedOptionValue = (input: CombinedValueInput): CombinedValueResult => {
  const T = Math.max(0, input.msToExpiry / MS_PER_YEAR);
  const bsP = Math.max(0, bsPut(input.spot, input.putStrike, T, input.riskFreeRate, input.sigmaAnnual));
  const bsC = Math.max(0, bsCall(input.spot, input.callStrike, T, input.riskFreeRate, input.sigmaAnnual));
  const putValue = bsP * input.putCalibrationMultiplier * input.contractsBtc;
  const callValue = bsC * input.callCalibrationMultiplier * input.contractsBtc;
  return {
    putValueUsdc: putValue,
    callValueUsdc: callValue,
    totalUsdc: putValue + callValue
  };
};
