import Decimal from "decimal.js";

const SQRT2 = Math.SQRT2;

function nCDF(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * European put option price via Black-Scholes closed-form.
 * S = spot, K = strike, T = time to expiry in years, r = risk-free rate, sigma = annualized vol
 */
export function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

/**
 * European call option price via Black-Scholes closed-form.
 */
export function bsCall(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * nCDF(d1) - K * Math.exp(-r * T) * nCDF(d2);
}

/**
 * Decimal-precision wrapper for bsPut. Returns the put value as a Decimal.
 */
export function bsPutDecimal(
  spot: Decimal,
  strike: Decimal,
  timeToExpiryYears: Decimal,
  riskFreeRate: Decimal,
  sigma: Decimal
): Decimal {
  const value = bsPut(
    spot.toNumber(),
    strike.toNumber(),
    timeToExpiryYears.toNumber(),
    riskFreeRate.toNumber(),
    sigma.toNumber()
  );
  return new Decimal(Math.max(0, value));
}

/**
 * Compute the time-to-expiry in years given an expiry timestamp.
 */
export function timeToExpiryYears(expiryMs: number, nowMs?: number): number {
  const now = nowMs ?? Date.now();
  const remainingMs = Math.max(0, expiryMs - now);
  return remainingMs / (365.25 * 24 * 3600 * 1000);
}

/**
 * Compute option value (intrinsic + time) for a put option at current conditions.
 * Used for recovery model: selling the hedge option post-trigger or early-close.
 */
export function computePutRecoveryValue(params: {
  currentSpot: number;
  strike: number;
  expiryMs: number;
  sigma: number;
  riskFreeRate?: number;
  nowMs?: number;
}): { totalValue: number; intrinsicValue: number; timeValue: number } {
  const r = params.riskFreeRate ?? 0;
  const T = timeToExpiryYears(params.expiryMs, params.nowMs);
  const intrinsicValue = Math.max(0, params.strike - params.currentSpot);
  const totalValue = bsPut(params.currentSpot, params.strike, T, r, params.sigma);
  const timeValue = Math.max(0, totalValue - intrinsicValue);
  return { totalValue: Math.max(intrinsicValue, totalValue), intrinsicValue, timeValue };
}
