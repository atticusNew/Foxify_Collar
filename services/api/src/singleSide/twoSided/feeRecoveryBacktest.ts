/**
 * Fee-Recovery Cover — go/no-go backtest (realized vs implied touch, grid × signal). Pure.
 *
 * THE QUESTION (the whole cooperative model lives or dies on this):
 *   On the trades Foxify would actually cover, does the REALIZED rate of touching the stop
 *   (e.g. -3% within 24h) exceed the IMPLIED touch rate they pay for — by more than the ops fee?
 *
 * METHOD (real data, honest):
 *   - REALIZED touch: from actual BTC price highs/lows. For a long-side cover at trigger X over
 *     tenor T from entry close C: touched iff min(low) over the next T <= C·(1−X). Short-side uses
 *     max(high) >= C·(1+X). Hourly candles capture intraday wicks → accurate touch detection.
 *   - IMPLIED touch: derived from DVOL (the exchange's implied-vol index) at entry via the barrier
 *     reflection principle  P(touch) = 2·Φ(−X / (σ·√T)),  σ = DVOL/100, T in years. This equals the
 *     european-digital prob × 2 — i.e. exactly what the live option-spread pricing approximates
 *     (verified: DVOL≈44 → ~19% for 3%/24h, matching the live cross-venue quote). It is the honest
 *     stand-in for a historical option chain (which we don't have).
 *   - EDGE = realized_touch − implied_touch. Positive ⇒ the cover is underpriced for Foxify.
 *
 * ECONOMICS (pass-through + flat ops fee — the cooperative model, no vol markup):
 *   premium = implied_touch × payout + ops_fee
 *   foxify_ev_per_trade = realized_touch × payout − premium = EDGE × payout − ops_fee
 *   atticus_margin_per_trade = ops_fee   (pure pass-through; Atticus warehouses only basis/exec risk)
 *
 * SIGNALS: the unconditional edge is expected to be NEGATIVE (variance risk premium ⇒ implied >
 *   realized on average). The model only works if a SIGNAL selects entries where the edge flips
 *   positive. We bucket every entry by DVOL trailing-percentile quintile and by regime, and report
 *   the edge per bucket so we can SEE whether (and where) selectivity creates value.
 *
 * Pure + deterministic: candles + DVOL are injected. The runnable script fetches them live.
 */

import { classifyRegime, type Regime } from "./featureFlag";

const MS_PER_YEAR = 365 * 86_400_000;
const SQRT2 = Math.SQRT2;

/** Standard normal CDF (Abramowitz-Stegun 7.1.26), same kernel as pilot/blackScholes. */
export const normCdf = (x: number): number => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
};

/** Implied one-touch probability from annualized vol via the driftless barrier reflection principle. */
export const impliedTouchProb = (trigger: number, sigmaAnnual: number, tenorYears: number): number => {
  if (!(sigmaAnnual > 0) || !(tenorYears > 0) || !(trigger > 0)) return 0;
  const z = trigger / (sigmaAnnual * Math.sqrt(tenorYears));
  return Math.min(1, 2 * normCdf(-z));
};

export type Candle = { tsMs: number; close: number; high: number; low: number };
export type DvolPoint = { tsMs: number; dvol: number };
export type TradeSide = "long" | "short";

/**
 * Term-structure multipliers applied to DVOL (a 30-day constant-maturity IV) to estimate the
 * SHORT-DATED IV relevant to a 24h barrier. BTC's vol term structure is upward-sloping in calm
 * (front-end < 30d) and inverts in elevated/stress (front-end > 30d). Without this, implied touch
 * is understated in stress → edge overstated. Defaults are approximate and TUNABLE; the runner
 * sweeps them to find the uplift that erases the edge.
 */
export type TermStructure = Partial<Record<Regime, number>>;
export const NEUTRAL_TERM_STRUCTURE: Record<Regime, number> = { calm: 1, moderate: 1, elevated: 1, stress: 1 };
export const DEFAULT_TERM_STRUCTURE: Record<Regime, number> = { calm: 0.9, moderate: 1.0, elevated: 1.2, stress: 1.4 };

export type FeeRecoveryBacktestParams = {
  triggers: number[];                 // e.g. [0.02, 0.025, 0.03, 0.035, 0.04]
  tenorHours: number;                 // e.g. 24
  sides: TradeSide[];                 // ["long","short"]
  payoutUsdc: number;                 // e.g. 60
  opsFeeUsdc: number;                 // e.g. 1
  dvolPercentileLookbackHours?: number; // trailing window for the DVOL percentile signal (default 720 = 30d)
  minBucketN?: number;                // min entries for a verdict (default 30)
  tradesPerDay?: number;              // for daily aggregates (default null)
  /** DVOL→short-tenor IV term-structure multiplier by regime. Default = neutral (1×) so the pure
   *  function is transparent; the runner passes DEFAULT_TERM_STRUCTURE (and sweeps it). */
  termStructure?: TermStructure;
  /** ADAPTIVE signal: trailing window (hours) over which to measure recent realized-vs-implied touch
   *  (the variance-risk-premium momentum). Leakage-free — only RESOLVED past entries are used. Default 336 (14d). */
  vrpLookbackHours?: number;
  /** Fire "adaptive_go" only when trailing realized touch exceeds trailing implied by this margin. Default 0. */
  vrpMargin?: number;
};

export type CellSignalStat = {
  side: TradeSide;
  trigger: number;
  signal: string;                     // "all" | "dvol_q1".."dvol_q5" | "regime:calm".."regime:stress"
  n: number;
  realized_touch_rate: number;
  implied_touch_rate: number;
  edge: number;                       // realized − implied
  premium_usdc: number;               // implied×payout + ops
  foxify_ev_per_trade_usdc: number;
  foxify_ev_per_day_usdc: number | null;
  atticus_margin_per_trade_usdc: number;
  verdict: "FOXIFY_POSITIVE" | "MARGINAL" | "FOXIFY_NEGATIVE" | "INSUFFICIENT_DATA";
};

export type FeeRecoveryBacktestReport = {
  window: { from_iso: string; to_iso: string; entries: number };
  params: FeeRecoveryBacktestParams;
  rows: CellSignalStat[];
  best_positive: CellSignalStat[];    // positive-EV (side,trigger,signal) sorted by foxify EV/trade
  summary: string[];
};

type Acc = { n: number; touches: number; impliedSum: number };

const verdictOf = (foxifyEv: number, n: number, minN: number): CellSignalStat["verdict"] => {
  if (n < minN) return "INSUFFICIENT_DATA";
  if (foxifyEv > 0.25) return "FOXIFY_POSITIVE";
  if (foxifyEv > -0.25) return "MARGINAL";
  return "FOXIFY_NEGATIVE";
};

/** Quintile (1=cheapest..5=richest) of `value` within a trailing array. */
const quintileOf = (trailing: number[], value: number): number => {
  if (trailing.length === 0) return 3;
  const frac = trailing.filter((x) => x <= value).length / trailing.length;
  return Math.min(5, Math.max(1, Math.floor(frac * 5) + 1));
};

export const runFeeRecoveryBacktest = (
  candles: Candle[],
  dvol: DvolPoint[],
  params: FeeRecoveryBacktestParams
): FeeRecoveryBacktestReport => {
  const tenorHours = params.tenorHours;
  const tenorYears = (tenorHours * 3_600_000) / MS_PER_YEAR;
  const lookbackHours = params.dvolPercentileLookbackHours ?? 720;
  const minN = params.minBucketN ?? 30;
  const payout = params.payoutUsdc;
  const ops = params.opsFeeUsdc;

  const sortedCandles = [...candles].filter((c) => c.close > 0 && c.high > 0 && c.low > 0).sort((a, b) => a.tsMs - b.tsMs);
  const sortedDvol = [...dvol].filter((d) => d.dvol > 0).sort((a, b) => a.tsMs - b.tsMs);

  // Align DVOL to each candle hour: nearest DVOL sample within ±1h.
  const dvolByHour = new Map<number, number>();
  for (const d of sortedDvol) dvolByHour.set(Math.round(d.tsMs / 3_600_000), d.dvol);
  const nearestDvol = (tsMs: number): number | null => {
    const h = Math.round(tsMs / 3_600_000);
    return dvolByHour.get(h) ?? dvolByHour.get(h - 1) ?? dvolByHour.get(h + 1) ?? null;
  };

  // accumulators keyed by `${side}|${trigger}|${signal}`
  const acc = new Map<string, Acc>();
  const bump = (side: TradeSide, trig: number, signal: string, touched: boolean, implied: number) => {
    const k = `${side}|${trig}|${signal}`;
    const a = acc.get(k) ?? { n: 0, touches: 0, impliedSum: 0 };
    a.n += 1; a.touches += touched ? 1 : 0; a.impliedSum += implied;
    acc.set(k, a);
  };

  const stepHours = Math.max(1, Math.round((sortedCandles[1]?.tsMs - sortedCandles[0]?.tsMs) / 3_600_000) || 1);
  const tenorSteps = Math.max(1, Math.round(tenorHours / stepHours));
  const vrpLookbackMs = (params.vrpLookbackHours ?? 336) * 3_600_000;
  const vrpMargin = params.vrpMargin ?? 0;

  // Fixed (side,trigger) order so each entry's cells[] align by index across entries.
  const cellDefs: Array<{ side: TradeSide; trigger: number }> = [];
  for (const side of params.sides) for (const trig of params.triggers) cellDefs.push({ side, trigger: trig });

  type Outcome = { tsMs: number; q: number; regime: Regime; touched: boolean[]; implied: number[] };

  // Pass 1: per-entry outcomes (signals computed from PAST data only → leakage-free).
  const outcomes: Outcome[] = [];
  for (let i = 0; i < sortedCandles.length - tenorSteps; i++) {
    const c = sortedCandles[i];
    const dv = nearestDvol(c.tsMs);
    if (dv == null) continue;
    const trail: number[] = [];
    for (let j = i - 1; j >= 0; j--) {
      if (sortedCandles[j].tsMs < c.tsMs - lookbackHours * 3_600_000) break;
      const dj = nearestDvol(sortedCandles[j].tsMs);
      if (dj != null) trail.push(dj);
    }
    const q = quintileOf(trail, dv);
    const regime: Regime = classifyRegime(dv);
    const termFactor = params.termStructure?.[regime] ?? 1;
    const sigma = (dv / 100) * termFactor;
    let lo = Infinity, hi = -Infinity;
    for (let k = i + 1; k <= i + tenorSteps; k++) {
      if (sortedCandles[k].low < lo) lo = sortedCandles[k].low;
      if (sortedCandles[k].high > hi) hi = sortedCandles[k].high;
    }
    const touched: boolean[] = [];
    const implied: number[] = [];
    for (const cd of cellDefs) {
      implied.push(impliedTouchProb(cd.trigger, sigma, tenorYears));
      touched.push(cd.side === "long" ? lo <= c.close * (1 - cd.trigger) : hi >= c.close * (1 + cd.trigger));
    }
    outcomes.push({ tsMs: c.tsMs, q, regime, touched, implied });
  }

  // Pass 2: static buckets + ADAPTIVE VRP bucket (trailing realized vs implied on RESOLVED entries).
  for (let i = 0; i < outcomes.length; i++) {
    const e = outcomes[i];
    for (let ci = 0; ci < cellDefs.length; ci++) {
      const { side, trigger } = cellDefs[ci];
      bump(side, trigger, "all", e.touched[ci], e.implied[ci]);
      bump(side, trigger, `dvol_q${e.q}`, e.touched[ci], e.implied[ci]);
      bump(side, trigger, `regime:${e.regime}`, e.touched[ci], e.implied[ci]);
      // adaptive: only entries that have fully RESOLVED by time e (index <= i - tenorSteps), within window.
      let n = 0, tch = 0, impSum = 0;
      for (let j = i - tenorSteps; j >= 0; j--) {
        if (outcomes[j].tsMs < e.tsMs - vrpLookbackMs) break;
        n++; tch += outcomes[j].touched[ci] ? 1 : 0; impSum += outcomes[j].implied[ci];
      }
      if (n < 20) { bump(side, trigger, "adaptive_warmup", e.touched[ci], e.implied[ci]); continue; }
      const go = tch / n > impSum / n + vrpMargin;
      bump(side, trigger, go ? "adaptive_go" : "adaptive_wait", e.touched[ci], e.implied[ci]);
    }
  }

  const entries = outcomes.length;
  const firstTs = outcomes[0]?.tsMs ?? 0;
  const lastTs = outcomes[outcomes.length - 1]?.tsMs ?? 0;

  const rows: CellSignalStat[] = [];
  for (const [k, a] of acc.entries()) {
    const [sideStr, trigStr, signal] = k.split("|");
    const side = sideStr as TradeSide;
    const trigger = Number(trigStr);
    const realized = a.n > 0 ? a.touches / a.n : 0;
    const implied = a.n > 0 ? a.impliedSum / a.n : 0;
    const edge = realized - implied;
    const premium = implied * payout + ops;
    const foxifyEv = edge * payout - ops;
    rows.push({
      side, trigger, signal, n: a.n,
      realized_touch_rate: +realized.toFixed(4),
      implied_touch_rate: +implied.toFixed(4),
      edge: +edge.toFixed(4),
      premium_usdc: +premium.toFixed(2),
      foxify_ev_per_trade_usdc: +foxifyEv.toFixed(3),
      foxify_ev_per_day_usdc: params.tradesPerDay ? +(foxifyEv * params.tradesPerDay).toFixed(2) : null,
      atticus_margin_per_trade_usdc: +ops.toFixed(2),
      verdict: verdictOf(foxifyEv, a.n, minN)
    });
  }

  rows.sort((x, y) =>
    x.side === y.side
      ? (x.trigger === y.trigger ? x.signal.localeCompare(y.signal) : x.trigger - y.trigger)
      : x.side.localeCompare(y.side)
  );

  const bestPositive = rows
    .filter((r) => r.verdict === "FOXIFY_POSITIVE")
    .sort((a, b) => b.foxify_ev_per_trade_usdc - a.foxify_ev_per_trade_usdc);

  const allRow = rows.find((r) => r.signal === "all");
  const summary: string[] = [
    `Entries analyzed: ${entries}. Implied touch derived from DVOL via reflection principle (the live option-spread pricing's basis); realized touch from actual BTC highs/lows.`,
    `Pass-through economics: premium = implied×payout + ops_fee($${ops}); foxify_ev = (realized−implied)×payout($${payout}) − ops_fee. Atticus margin = ops_fee (pass-through).`,
    bestPositive.length > 0
      ? `${bestPositive.length} (side,trigger,signal) bucket(s) are FOXIFY_POSITIVE. Top: ${bestPositive[0].side} ${(bestPositive[0].trigger * 100).toFixed(1)}% on '${bestPositive[0].signal}' → +$${bestPositive[0].foxify_ev_per_trade_usdc}/trade (edge ${(bestPositive[0].edge * 100).toFixed(1)}pts, n=${bestPositive[0].n}).`
      : `NO bucket is FOXIFY_POSITIVE at these params (payout $${payout}, ops $${ops}). The signal does not lift realized touch above implied enough to clear the ops fee — cooperative model not viable as configured. Try other triggers/tenors/payout or a sharper signal.`,
    allRow ? `Unconditional (always-on) edge for ${allRow.side} ${(allRow.trigger * 100).toFixed(1)}%: realized ${(allRow.realized_touch_rate * 100).toFixed(1)}% vs implied ${(allRow.implied_touch_rate * 100).toFixed(1)}% → ${allRow.foxify_ev_per_trade_usdc >= 0 ? "+" : ""}$${allRow.foxify_ev_per_trade_usdc}/trade (expected ≤0 due to variance risk premium; selectivity is the only path).` : ""
  ].filter(Boolean);

  return {
    window: { from_iso: firstTs ? new Date(firstTs).toISOString() : "", to_iso: lastTs ? new Date(lastTs).toISOString() : "", entries },
    params,
    rows,
    best_positive: bestPositive,
    summary
  };
};
