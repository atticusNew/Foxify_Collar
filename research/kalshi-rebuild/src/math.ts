/**
 * Self-contained options + market math for the Kalshi rebuild backtest.
 *
 * DESIGN GOAL — Foxify-clean:
 *   This module does NOT import or assume any Foxify pilot calibrations.
 *   The previous research package (research/kalshi-shadow-backtest/src/math.ts)
 *   embedded several Foxify-specific constants:
 *     - 1.20× / 1.18× / 1.15× IV-from-realized-vol scalars (Foxify CFO §3.2)
 *     - 0.7 vol-pts/% OTM skew slope (Foxify empirical)
 *     - 68% / 55% / 40% TP recovery by regime (Foxify R1 §3.4)
 *   Those have been removed. This module exposes:
 *     - Plain Black-Scholes call/put pricing (no IV regime adjustment)
 *     - Realized-vol calculator (kept; same formula, no calibration)
 *     - Generic spread cost and payout functions for both call and put spreads
 *   Any vol risk premium or skew adjustment is now an explicit caller-side
 *   parameter, not a hidden constant baked into the math.
 *
 * BID-ASK NOTE:
 *   For backtest purposes we don't have historical Deribit chain snapshots
 *   for 2024-2026 cheaply available. We price spreads with BS theoretical
 *   and add an explicit `bidAskSpreadFrac` widener at the caller layer
 *   (calibrated against current Deribit snapshots — documented in
 *   ANALYSIS_NOTES.md when we have it).
 */

// ─── Normal CDF (Abramowitz & Stegun 26.2.17) ─────────────────────────────────
function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/** European put — Black-Scholes closed form. */
export function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

/** European call — Black-Scholes closed form. */
export function bsCall(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * nCDF(d1) - K * Math.exp(-r * T) * nCDF(d2);
}

/**
 * Annualised realized volatility from daily log-returns, ending at endIdx.
 * Returns 0.55 (a conservative mid estimate) when sample < 5 days.
 * No Foxify regime mapping — caller decides what to do with rvol.
 */
export function realizedVol30d(closes: number[], endIdx: number): number {
  const start = Math.max(0, endIdx - 30);
  const slice = closes.slice(start, endIdx + 1);
  if (slice.length < 6) return 0.55;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > 0 && slice[i - 1] > 0) rets.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (rets.length < 5) return 0.55;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 365);
}

// ─── Spreads (call + put, generic) ────────────────────────────────────────────
//
// Conventions:
//   Long leg = the leg whose strike is closer to the money (more expensive)
//   Short leg = the leg whose strike is further OTM (cheaper)
//   Spread width = |K_long - K_short|
//   Net cost = LongPrice - ShortPrice (always positive for vertical spreads)
//   Max payout = spread width × notional / S_entry

/** Vertical put-spread cost: long the higher-strike put, short the lower-strike put. */
export function putSpreadCost(
  S: number,
  K_long: number, K_short: number,
  T: number, r: number,
  iv_long: number, iv_short: number,
): number {
  if (K_long <= K_short) {
    // Caller passed strikes inverted; protect against negative cost.
    return 0;
  }
  const longLeg = bsPut(S, K_long, T, r, iv_long);
  const shortLeg = bsPut(S, K_short, T, r, iv_short);
  return Math.max(0, longLeg - shortLeg);
}

/** Vertical call-spread cost: long the lower-strike call, short the higher-strike call. */
export function callSpreadCost(
  S: number,
  K_long: number, K_short: number,
  T: number, r: number,
  iv_long: number, iv_short: number,
): number {
  if (K_short <= K_long) {
    return 0;
  }
  const longLeg = bsCall(S, K_long, T, r, iv_long);
  const shortLeg = bsCall(S, K_short, T, r, iv_short);
  return Math.max(0, longLeg - shortLeg);
}

/**
 * Put-spread payout at expiry.
 * Pays when S_expiry < K_long (the high-strike leg). Capped at spread width.
 * Payout is scaled by notional / S_entry so it's expressed in USD on the user's notional.
 */
export function putSpreadPayout(
  K_long: number, K_short: number,
  S_entry: number, S_expiry: number,
  notional: number,
): number {
  if (K_long <= K_short || S_expiry >= K_long) return 0;
  const gain = Math.min(K_long - S_expiry, K_long - K_short);
  return (gain / S_entry) * notional;
}

/**
 * Call-spread payout at expiry.
 * Pays when S_expiry > K_long. Capped at spread width.
 */
export function callSpreadPayout(
  K_long: number, K_short: number,
  S_entry: number, S_expiry: number,
  notional: number,
): number {
  if (K_short <= K_long || S_expiry <= K_long) return 0;
  const gain = Math.min(S_expiry - K_long, K_short - K_long);
  return (gain / S_entry) * notional;
}
