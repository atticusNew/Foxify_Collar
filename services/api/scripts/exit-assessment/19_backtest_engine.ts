/**
 * Shared backtest engine for all 5 analyses.
 * Black-Scholes pricing, BTC walk, trigger detection, regime classification.
 */

import * as fs from "node:fs/promises";

const SQRT2 = Math.SQRT2;
export const nCDF = (x: number): number => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
};

export const bsPut = (S: number, K: number, T: number, r: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
};

export const bsCall = (S: number, K: number, T: number, r: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * nCDF(d1) - K * Math.exp(-r * T) * nCDF(d2);
};

export type Candle = {
  timestamp: number;
  date: string;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
};

export type Regime = "calm" | "moderate" | "elevated" | "stress";

export const classifyRegime = (annualVol: number): Regime => {
  if (annualVol < 0.50) return "calm";
  if (annualVol < 0.70) return "moderate";
  if (annualVol < 0.90) return "elevated";
  return "stress";
};

export const loadHistoricalData = async (): Promise<{
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
}> => {
  const data = JSON.parse(await fs.readFile("/tmp/btc_daily_ohlc.json", "utf8"));
  const candles: Candle[] = data.candles;
  const vols: Record<string, number> = data.annualVolByDay;
  const regimes: Record<string, Regime> = {};
  for (const [date, vol] of Object.entries(vols)) {
    regimes[date] = classifyRegime(vol);
  }
  return { candles, vols, regimes };
};

/**
 * Sample hold days from exponential distribution with given mean,
 * truncated to [1, maxDays].
 */
export const sampleHoldDays = (meanDays: number, maxDays: number = 14): number => {
  const lambda = 1 / meanDays;
  const u = Math.random();
  const sample = -Math.log(1 - u) / lambda;
  return Math.max(1, Math.min(maxDays, Math.round(sample)));
};

/**
 * Premium/payout-aware hold model.
 * Foxify rationally holds longer when payout/premium ratio is favorable.
 *
 * Hypothesis (per operator): Foxify closes when cumulative_premium ≈ X% of payout potential.
 *   At deprecated pilot: X ≈ 30-50% of break-even (where break-even = payout/dailyPremium days)
 *   For new product with much larger payout-to-premium: hold longer
 */
export const sampleHoldDaysPremiumAware = (
  dailyPremium: number,
  payoutUsd: number,
  maxTenor: number = 14,
  closeThresholdPct: number = 0.40
): number => {
  // Break-even days = payout / daily premium
  const breakEvenDays = payoutUsd / dailyPremium;
  // Foxify likely closes at closeThresholdPct of break-even
  const meanCloseDay = Math.min(maxTenor, breakEvenDays * closeThresholdPct);
  // Sample around this with some variance
  const lambda = 1 / Math.max(1, meanCloseDay);
  const u = Math.random();
  const sample = -Math.log(1 - u) / lambda;
  return Math.max(1, Math.min(maxTenor, Math.round(sample)));
};

/**
 * Simulate forward walk through candles starting at index `startIdx`.
 * Detects trigger if intraday low/high touches threshold.
 * Returns: (triggered, triggerDay, finalSpot, finalDate)
 */
export const walkForward = (
  candles: Candle[],
  startIdx: number,
  holdDays: number,
  triggerLow: number | null,
  triggerHigh: number | null
): { triggered: boolean; triggerDay: number | null; spotAtClose: number; daysHeld: number } => {
  let triggered = false;
  let triggerDay: number | null = null;
  let actualHoldDays = holdDays;
  let spotAtClose = candles[startIdx].close;

  for (let d = 1; d <= holdDays; d++) {
    if (startIdx + d >= candles.length) break;
    const day = candles[startIdx + d];
    if (triggerLow !== null && day.low <= triggerLow) {
      triggered = true;
      triggerDay = d;
      actualHoldDays = d;
      spotAtClose = triggerLow;
      break;
    }
    if (triggerHigh !== null && day.high >= triggerHigh) {
      triggered = true;
      triggerDay = d;
      actualHoldDays = d;
      spotAtClose = triggerHigh;
      break;
    }
    spotAtClose = day.close;
  }

  return { triggered, triggerDay, spotAtClose, daysHeld: actualHoldDays };
};

export const summarize = (pnls: number[]): {
  count: number;
  avg: number;
  median: number;
  worst: number;
  best: number;
  p10: number;
  p90: number;
  pctProfitable: number;
  pctLosing: number;
  totalPnL: number;
} => {
  const sorted = pnls.slice().sort((a, b) => a - b);
  return {
    count: pnls.length,
    avg: pnls.reduce((s, x) => s + x, 0) / pnls.length,
    median: sorted[Math.floor(sorted.length / 2)],
    worst: sorted[0],
    best: sorted[sorted.length - 1],
    p10: sorted[Math.floor(sorted.length * 0.1)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    pctProfitable: pnls.filter(p => p > 0).length / pnls.length,
    pctLosing: pnls.filter(p => p < 0).length / pnls.length,
    totalPnL: pnls.reduce((s, x) => s + x, 0)
  };
};

/**
 * Group results by regime and summarize each.
 */
export const summarizeByRegime = (
  results: Array<{ regime: Regime; pnl: number }>
): Record<Regime, ReturnType<typeof summarize>> => {
  const groups: Record<string, number[]> = { calm: [], moderate: [], elevated: [], stress: [] };
  for (const r of results) {
    groups[r.regime].push(r.pnl);
  }
  const out: any = {};
  for (const [k, v] of Object.entries(groups)) {
    if (v.length > 0) out[k] = summarize(v);
    else out[k] = { count: 0, avg: 0, median: 0, worst: 0, best: 0, p10: 0, p90: 0, pctProfitable: 0, pctLosing: 0, totalPnL: 0 };
  }
  return out;
};

/** Risk-free rate for BS pricing */
export const RFR = 0.045;
