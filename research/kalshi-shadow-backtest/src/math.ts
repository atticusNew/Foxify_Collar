/**
 * Self-contained options math for the Kalshi shadow backtest.
 * No imports from the live pilot. All financial values are plain numbers
 * (not Decimal) to keep the research script simple and fast.
 *
 * Assumptions are explicitly documented at every callsite.
 */

// ─── Normal CDF (Horner approximation, Abramowitz & Stegun 26.2.17) ───────────
function nCDF(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * European put price — Black-Scholes closed form.
 * Returns intrinsic value if T <= 0 or sigma <= 0.
 */
export function bsPut(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
}

/**
 * European call price — Black-Scholes closed form.
 */
export function bsCall(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * nCDF(d1) - K * Math.exp(-r * T) * nCDF(d2);
}

/**
 * Annualised realized volatility from daily log-returns.
 * Uses a 30-day rolling window ending at endIdx.
 * Returns 0.55 (a conservative mid-regime estimate) when sample < 5 days.
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

/**
 * Map annualised realized vol → implied-vol estimate.
 *
 * Assumption (calibrated to Foxify pilot CFO report §3.2 + pilot R1 data):
 *   Deribit IV typically runs at a 15-25% premium to realized vol (vol risk premium).
 *   We use a piecewise scalar so that:
 *     - calm  (rvol < 0.40): IV = rvol × 1.20  (thin premium when markets quiet)
 *     - normal(0.40–0.65):   IV = rvol × 1.18
 *     - stress(> 0.65):      IV = rvol × 1.15  (premium compresses as realized catches up)
 *
 *   Additionally, Deribit short-dated OTM puts carry a volatility smile.
 *   We model the smile as a moneyness skew add-on (see ivForMoneyness).
 */
export function impliedVolFromRealized(rvol: number): number {
  if (rvol < 0.40) return rvol * 1.20;
  if (rvol < 0.65) return rvol * 1.18;
  return rvol * 1.15;
}

/**
 * Approximate IV adjusted for strike moneyness (OTM skew).
 *
 * Assumption: short-dated BTC puts exhibit ~3–5 vol points of skew per 5%
 * OTM increment below ATM. We use a linear skew of +0.7 vol pts per 1% OTM.
 * This is consistent with empirical Deribit observations for 1-DTE puts.
 *
 * @param atm_iv  ATM implied vol (annualised fraction)
 * @param otmPct  How far OTM the strike is (e.g. 0.02 = 2% OTM)
 */
export function ivForMoneyness(atm_iv: number, otmPct: number): number {
  const skewAdd = otmPct * 0.35; // 35 vol-pct-pts per unit OTM → ~0.007 per 2% OTM
  return Math.min(atm_iv + skewAdd, 2.5); // cap at 250% to avoid absurdities
}

/**
 * Put-spread cost: buy K_high put, sell K_low put.
 * Captures the protection corridor [K_low, K_high].
 */
export function putSpreadCost(
  S: number,
  K_high: number,
  K_low: number,
  T: number,
  r: number,
  iv_high: number,
  iv_low: number
): number {
  const longLeg = bsPut(S, K_high, T, r, iv_high);
  const shortLeg = bsPut(S, K_low, T, r, iv_low);
  return Math.max(0, longLeg - shortLeg);
}

/**
 * Put-spread max payout (intrinsic at expiry if spot <= K_low):
 *   (K_high - K_low) / S  × notional
 */
export function putSpreadMaxPayout(K_high: number, K_low: number, S: number, notional: number): number {
  return ((K_high - K_low) / S) * notional;
}

/**
 * Actual spread payout at a given expiry spot price.
 * = max(0, min(K_high - spot, K_high - K_low)) / S × notional
 */
export function putSpreadPayout(
  K_high: number,
  K_low: number,
  S_entry: number,
  S_expiry: number,
  notional: number
): number {
  if (S_expiry >= K_high) return 0;
  const gain = Math.min(K_high - S_expiry, K_high - K_low);
  return (gain / S_entry) * notional;
}

/**
 * TP (take-profit) recovery model.
 *
 * Assumption (calibrated to Foxify R1 §3.4):
 *   Realized TP recovery = 68% of BS theoretical in calm, ~55% in normal,
 *   ~40% in stress (Deribit spreads widen 2-4× in stress).
 *   For spreads, recovery is slightly better because the short leg reduces
 *   net bid-ask exposure; we add +5 percentage points.
 */
export function tpRecoveryRate(regime: "calm" | "normal" | "stress", isSpread: boolean): number {
  const base = regime === "calm" ? 0.68 : regime === "normal" ? 0.55 : 0.40;
  return isSpread ? Math.min(base + 0.05, 0.95) : base;
}

/**
 * Classify realized vol into a market regime.
 * Matches the Foxify pilot's regimeClassifier thresholds.
 */
export function classifyRegime(rvol: number): "calm" | "normal" | "stress" {
  if (rvol < 0.40) return "calm";
  if (rvol < 0.65) return "normal";
  return "stress";
}
