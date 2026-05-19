/** Self-contained options math. No Foxify pilot dependencies. */

function nCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

export function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

export function putSpreadCost(
  S: number, K_long: number, K_short: number,
  T: number, r: number, ivLong: number, ivShort: number,
): number {
  if (K_long <= K_short) return 0;
  return Math.max(0, bsPut(S, K_long, T, r, ivLong) - bsPut(S, K_short, T, r, ivShort));
}

/** Realized vol (annualized) over a trailing N-day window. */
export function realizedVolN(closes: number[], endIdx: number, windowDays = 30): number {
  const start = Math.max(0, endIdx - windowDays);
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
