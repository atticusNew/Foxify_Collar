/**
 * Perp Protect — option fair-value / sanity diagnostic (pure, testable).
 *
 * We deliberately do NOT assert a "fair price" from a single assumed IV — option IV has a skew, so a
 * one-IV theoretical would wrongly flag legitimately-skewed OTM quotes as mispriced (misleading).
 * Instead we INVERT the hedge ask into its market-IMPLIED volatility (skew-agnostic: it just
 * expresses the quoted price as a vol) and flag only IMPLAUSIBLE values — a stale/garbage top-of-book
 * print that implies, say, 600% annualized vol. This complements the spread guard (B2) as a second,
 * price-quality check on the leg we'd actually hedge with.
 *
 * Black-Scholes on a USDC-quoted BTC option (S, K in USDC → price in USDC per BTC, matching our
 * premium convention). Rate defaults to 0 (crypto options are near-zero carry over these tenors).
 */

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (max err ~1.5e-7). */
const normCdf = (x: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
};

export type OptType = "put" | "call";

/** Black-Scholes price (USDC per BTC). */
export const bsPrice = (opt: { type: OptType; spot: number; strike: number; tYears: number; vol: number; rate?: number }): number => {
  const { type, spot: S, strike: K, tYears: T, vol } = opt;
  const r = opt.rate ?? 0;
  if (!(S > 0) || !(K > 0)) return 0;
  if (!(T > 0) || !(vol > 0)) {
    // No time/vol → intrinsic value.
    return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const disc = Math.exp(-r * T);
  return type === "call"
    ? S * normCdf(d1) - K * disc * normCdf(d2)
    : K * disc * normCdf(-d2) - S * normCdf(-d1);
};

/**
 * Implied volatility from a price (USDC per BTC) via bisection (price is monotincreasing in vol).
 * Returns null when the price is below intrinsic or above the no-arb bound (no solvable IV).
 */
export const impliedVol = (opt: { type: OptType; spot: number; strike: number; tYears: number; priceUsdcPerBtc: number; rate?: number }): number | null => {
  const { type, spot: S, strike: K, tYears: T, priceUsdcPerBtc: price } = opt;
  const r = opt.rate ?? 0;
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(price > 0)) return null;
  const disc = Math.exp(-r * T);
  const intrinsic = type === "call" ? Math.max(0, S - K * disc) : Math.max(0, K * disc - S);
  const upper = type === "call" ? S : K * disc; // option price can't exceed underlying (call) / discounted strike (put)
  if (price <= intrinsic + 1e-9 || price >= upper) return null;
  let lo = 1e-4;
  let hi = 10; // 1000% vol ceiling
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice({ type, spot: S, strike: K, tYears: T, vol: mid, rate: r });
    if (Math.abs(p - price) < 1e-6) return mid;
    if (p < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

export type FairValueConfig = { minPlausibleVol: number; maxPlausibleVol: number };
export const DEFAULT_FAIR_VALUE_CONFIG: FairValueConfig = { minPlausibleVol: 0.05, maxPlausibleVol: 5.0 };

export type FairValueFlag = "ok" | "implausible_vol" | "below_intrinsic" | "unpriceable";
export type FairValueDiagnostic = {
  implied_vol: number | null;
  flag: FairValueFlag;
  note: string;
};

/** Advisory price-quality diagnostic for the hedge ask of one leg. Never rejects — informs. */
export const fairValueDiagnostic = (
  opt: { type: OptType; spot: number; strike: number; tYears: number; priceUsdcPerBtc: number; rate?: number },
  cfg: FairValueConfig = DEFAULT_FAIR_VALUE_CONFIG
): FairValueDiagnostic => {
  const r = opt.rate ?? 0;
  if (!(opt.spot > 0) || !(opt.strike > 0) || !(opt.tYears > 0) || !(opt.priceUsdcPerBtc > 0)) {
    return { implied_vol: null, flag: "unpriceable", note: "missing/invalid inputs for IV" };
  }
  const disc = Math.exp(-r * opt.tYears);
  const intrinsic = opt.type === "call" ? Math.max(0, opt.spot - opt.strike * disc) : Math.max(0, opt.strike * disc - opt.spot);
  if (opt.priceUsdcPerBtc <= intrinsic + 1e-9) {
    return { implied_vol: null, flag: "below_intrinsic", note: "ask at/below intrinsic — likely stale quote" };
  }
  const iv = impliedVol(opt);
  if (iv == null) return { implied_vol: null, flag: "unpriceable", note: "no solvable IV within bounds — likely stale/garbage quote" };
  const ivPct = +(iv * 100).toFixed(1);
  if (iv < cfg.minPlausibleVol || iv > cfg.maxPlausibleVol) {
    return { implied_vol: +iv.toFixed(4), flag: "implausible_vol", note: `implied vol ${ivPct}% outside plausible band — treat the quote with caution` };
  }
  return { implied_vol: +iv.toFixed(4), flag: "ok", note: `implied vol ${ivPct}%` };
};

export const fairValueConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): FairValueConfig => {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    minPlausibleVol: num(env.PERP_PROTECT_MIN_PLAUSIBLE_VOL, DEFAULT_FAIR_VALUE_CONFIG.minPlausibleVol),
    maxPlausibleVol: num(env.PERP_PROTECT_MAX_PLAUSIBLE_VOL, DEFAULT_FAIR_VALUE_CONFIG.maxPlausibleVol)
  };
};
