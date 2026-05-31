/**
 * Foxify cost-vs-gain analysis.
 *
 * For each (SL tier, position size, leverage) combination:
 *   - Compute the daily protection fee in USD.
 *   - Compute the break-even BTC move: how much BTC needs to move in
 *     the trader's favor (over a 24h window) for the perp's gain to
 *     fully offset the protection fee.
 *   - Walk the 24-month BTC daily OHLC, count what fraction of days
 *     the actual move met or exceeded that threshold.
 *
 * Reports for both LONG and SHORT positions (positive vs negative
 * BTC daily moves are favorable depending on direction).
 *
 * The output frames the question honestly:
 *   "On X% of historical days, your position moved enough that the
 *    protection fee was fully offset by perp gains. On the other (100-X)%
 *    you paid the fee and the protection didn't fire — same dynamic as
 *    insurance you didn't claim."
 *
 * NOT a claim of "free protection." Frames cost-averaging probabilistically.
 *
 * Run: npx tsx src/costVsGainMain.ts → writes output/foxify_cost_vs_gain.md
 */

import type { DailyOhlc } from "./fetchPrices.js";

// Locked pricing per CEO confirmation (per $10k of position, per day)
const FEE_PER_10K_BY_TIER: Record<string, number> = {
  "0.02": 55,
  "0.03": 60,
  "0.05": 65,
  "0.10": 25,
};

// Position-size buckets analyzed
export const POSITION_SIZES = [10_000, 25_000, 50_000] as const;
// Leverage buckets — affects margin but not the daily fee or the break-even move
export const LEVERAGES = [3, 5, 10, 20] as const;
// SL tiers
export const SL_TIERS = [0.02, 0.03, 0.05, 0.10] as const;

export type DailyMove = {
  date: string;
  movePctOpenToClose: number;     // (close - open) / open  — direction-signed
  moveAbsPct: number;             // absolute value of above
};

/**
 * Build a flat array of daily BTC moves over the OHLC window.
 * "Move" defined as (close - open) / open of each daily bar.
 *
 * For directional analysis: positive moves favor long perp; negative moves favor short.
 */
export function buildDailyMoves(ohlc: DailyOhlc[]): DailyMove[] {
  return ohlc.map(d => {
    const movePctOpenToClose = (d.close - d.open) / d.open;
    return {
      date: d.date,
      movePctOpenToClose,
      moveAbsPct: Math.abs(movePctOpenToClose),
    };
  });
}

export type CostGainRow = {
  slTier: number;
  positionSizeUsd: number;
  leverage: number;
  // Pricing
  dailyFeeUsd: number;
  // Break-even
  breakEvenMoveFracLong: number;     // BTC needs to move +X% for long to absorb fee
  breakEvenMoveFracShort: number;    // BTC needs to move -X% for short to absorb fee
  // Historical frequency (24mo)
  pctDaysLongAbsorbsFee: number;     // % of days where +move >= breakEven
  pctDaysShortAbsorbsFee: number;    // % of days where -move <= -breakEven
  // Average gain on absorbing days
  avgGainOnAbsorbDayLong: number;    // USD, on days where the long absorbed
  avgGainOnAbsorbDayShort: number;
  // Worst-case unprotected scenario (helpful context — the loss-floor story)
  worstSingleDayLossUnhedgedLong: number;  // USD on worst BTC down day
  worstSingleDayLossUnhedgedShort: number;
};

export function analyze(args: {
  moves: DailyMove[];
  slTier: number;
  positionSizeUsd: number;
  leverage: number;
}): CostGainRow {
  const { moves, slTier, positionSizeUsd, leverage } = args;
  const feePer10k = FEE_PER_10K_BY_TIER[slTier.toFixed(2)] ?? 0;
  const dailyFeeUsd = feePer10k * (positionSizeUsd / 10_000);

  // Break-even BTC move (% of position):
  //   perpGain = positionSizeUsd × moveFrac
  //   for long: moveFrac > 0 means gain → set positionSizeUsd × moveFrac = dailyFeeUsd
  //   ⇒ breakEvenMoveFrac = dailyFeeUsd / positionSizeUsd
  // Note: leverage doesn't change the break-even move because fee is on notional,
  // gain is on notional. Leverage only affects the *margin* the trader has at risk.
  const breakEvenMoveFracLong = dailyFeeUsd / positionSizeUsd;
  const breakEvenMoveFracShort = dailyFeeUsd / positionSizeUsd;

  // Historical frequency
  const longAbsorbDays = moves.filter(m => m.movePctOpenToClose >= breakEvenMoveFracLong);
  const shortAbsorbDays = moves.filter(m => m.movePctOpenToClose <= -breakEvenMoveFracShort);
  const pctDaysLongAbsorbsFee = longAbsorbDays.length / moves.length;
  const pctDaysShortAbsorbsFee = shortAbsorbDays.length / moves.length;

  // Avg gain on those days (in USD on the position)
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const avgGainOnAbsorbDayLong = avg(longAbsorbDays.map(m => m.movePctOpenToClose * positionSizeUsd));
  const avgGainOnAbsorbDayShort = avg(shortAbsorbDays.map(m => -m.movePctOpenToClose * positionSizeUsd));

  // Worst-day single-day loss (unhedged, before SL trigger)
  const worstDownMove = Math.min(...moves.map(m => m.movePctOpenToClose));
  const worstUpMove = Math.max(...moves.map(m => m.movePctOpenToClose));
  const worstSingleDayLossUnhedgedLong = worstDownMove * positionSizeUsd;  // negative
  const worstSingleDayLossUnhedgedShort = -worstUpMove * positionSizeUsd;  // negative

  return {
    slTier,
    positionSizeUsd,
    leverage,
    dailyFeeUsd,
    breakEvenMoveFracLong,
    breakEvenMoveFracShort,
    pctDaysLongAbsorbsFee,
    pctDaysShortAbsorbsFee,
    avgGainOnAbsorbDayLong,
    avgGainOnAbsorbDayShort,
    worstSingleDayLossUnhedgedLong,
    worstSingleDayLossUnhedgedShort,
  };
}

export function analyzeAll(moves: DailyMove[]): CostGainRow[] {
  const out: CostGainRow[] = [];
  for (const slTier of SL_TIERS) {
    for (const positionSizeUsd of POSITION_SIZES) {
      for (const leverage of LEVERAGES) {
        out.push(analyze({ moves, slTier, positionSizeUsd, leverage }));
      }
    }
  }
  return out;
}
