/**
 * Cap selection: which listed funding strike the collar sells.
 *
 * P&L IDENTITY (re-derived 2026-09-20 under the founder's rule; this module changes WHICH strike,
 * never WHO keeps a payoff, and the identity must hold for every strike it can pick).
 *   Long position, size q, credit C = call_bid(K_cap) − put_ask(K_floor) − fees − take, both legs
 *   held to expiry, price at expiry S:
 *     trader = C + max(0, K_floor − S)·q − max(0, S − K_cap)·q      (the cap excess is the floor's premium)
 *     writer = take                                                 (long put and short call are the trader's mirror)
 *     venue  = fees + spreads
 *   Short position mirrors strikes and signs. Every early exit values both legs at the book at
 *   that moment and settles the same three lines; nothing is left open on our side.
 *
 *   Under the pricing measure E[max(0, S − K_cap)·q] = call_mid(K_cap)·q, so
 *     E[trader] = −put − spreads − take        for EVERY cap strike.
 *   The strike does not change what the trader expects to make; it changes the SHAPE: how much
 *   certain credit now against how much upside tail is kept. So the rule below is about frequency
 *   and legibility, and the shadow's cap ladder checks it against realized outcomes per rung (the
 *   variance risk premium favors closer caps; regret favors wider ones).
 *
 * RULES
 *   `widest`  — the widest strike whose net credit is positive (the rule until 2026-09-20). Minimal
 *               handback frequency; on a floor priced one strike deeper it can leave most of the
 *               credit on the table (measured: $29 at 5.9% when 4.7% paid ~$170, same floor).
 *   `target`  — among strikes that pay, the MOST credit whose market-implied chance of finishing
 *               beyond it (lognormal, the strike's own OKX mark vol, zero drift) is at most
 *               `maxExceedProb`. The cap is placed where the market says about one week in N ends
 *               above it — a sentence a retail trader can read. When no strike qualifies, or no
 *               vol is readable, it falls back to `widest`. Default: target, 0.20 — about one week
 *               in five ends past the cap (measured 2026-09-20: a 3.4% weekly cap sat at ~24%, a 4.7%
 *               cap at ~18%; the widest rule already wrote ~4.7% on a 6% floor, so the default keeps
 *               that shape and only moves the cap when the widest rule would leave the credit behind).
 *
 * Neither rule refuses on distance (the plain collar has nothing to refuse for); the funding band's
 * 0.5% ATM hard stop is the only limit on how close the search may look.
 */

import type { PerpSide } from "./creditCollarPricer";

export type CapRule = { kind: "widest" } | { kind: "target"; maxExceedProb: number };

export const DEFAULT_CAP_EXCEED_PROB = 0.2;

const numEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : d;
};

/** EP_CAP_RULE=widest|target (default target), EP_CAP_EXCEED_PROB as a fraction (default 0.20). */
export const capRuleFromEnv = (env: Record<string, string | undefined> = process.env): CapRule =>
  (env.EP_CAP_RULE ?? "target").trim().toLowerCase() === "widest"
    ? { kind: "widest" }
    : { kind: "target", maxExceedProb: numEnv(env.EP_CAP_EXCEED_PROB, DEFAULT_CAP_EXCEED_PROB) };

export const capRuleText = (rule: CapRule): string =>
  rule.kind === "widest"
    ? "the widest listed cap whose net credit is positive"
    : `the most credit among listed caps the market gives at most a ${(rule.maxExceedProb * 100).toFixed(0)}% chance of finishing beyond this cycle (widest paying cap when none qualifies)`;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26; |error| < 1.5e-7). */
export const normCdf = (x: number): number => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = poly * Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return x >= 0 ? 1 - tail : tail;
};

/**
 * Market-implied chance that expiry settles BEYOND the cap: above it for a long (S_T > K), below it
 * for a short (S_T < K). Zero-drift lognormal at the strike's own implied vol (annualized fraction).
 * Null when any input is unusable — the caller falls back to the widest rule rather than guess.
 */
export const exceedProb = (input: { side: PerpSide; spot: number; strike: number; ivAnnual: number; yearsToExpiry: number }): number | null => {
  const { side, spot, strike, ivAnnual, yearsToExpiry: T } = input;
  if (!(spot > 0) || !(strike > 0) || !(ivAnnual > 0) || !(T > 0) || !Number.isFinite(ivAnnual) || !Number.isFinite(T)) return null;
  const sT = ivAnnual * Math.sqrt(T);
  const d2 = (Math.log(spot / strike) - 0.5 * sT * sT) / sT;
  const pAbove = normCdf(d2);
  return +Math.min(1, Math.max(0, side === "long" ? pAbove : 1 - pAbove)).toFixed(4);
};

export interface CapCandidate {
  strike: number;
  /** net credit after venue fees for the whole position, USDC; only > 0 candidates can be picked */
  netUsdc: number;
  /** market-implied chance of finishing beyond this strike, or null when unreadable */
  exceedProb: number | null;
}

/**
 * Pick the funding strike. Returns the chosen candidate and which rule actually decided (`target`
 * only when a qualifying strike existed; `widest` otherwise, including every fallback).
 */
export const pickCap = <T extends CapCandidate>(cands: readonly T[], spot: number, rule: CapRule): { pick: T; decidedBy: CapRule["kind"] } | null => {
  const paying = cands.filter((c) => c.netUsdc > 0);
  if (paying.length === 0) return null;
  const dist = (c: T) => Math.abs(c.strike - spot);
  const widest = paying.reduce((a, b) => (dist(b) > dist(a) ? b : a));
  if (rule.kind === "target") {
    const ok = paying.filter((c) => c.exceedProb != null && c.exceedProb <= rule.maxExceedProb + 1e-9);
    if (ok.length > 0) {
      const best = ok.reduce((a, b) => (b.netUsdc > a.netUsdc || (b.netUsdc === a.netUsdc && dist(b) > dist(a)) ? b : a));
      return { pick: best, decidedBy: "target" };
    }
  }
  return { pick: widest, decidedBy: "widest" };
};

// ── Realized versus implied: the cap odds move inside the published band ──────
//
// Under the pricing measure every cap strike leaves the trader's expectation unchanged (above);
// what the record shows is that implied odds run above realized (18% said, 4% seen over the first
// three weeks). That gap is the variance premium: when options are rich against what price then
// does, a closer cap sells more credit per dollar of upside actually handed back; when they are
// cheap or price is trending, a wider cap gives back less for the credit it loses. So the odds the
// rule targets slide with implied over realized, inside the band a brand publishes (10-30%), and
// never outside it. This changes WHICH strike is written, never who keeps a payoff: the identity
// trader = C + floor payout - cap excess, writer = take holds at every strike the band allows.

/**
 * Close-to-close realized volatility, annualized fraction, from evenly spaced candles. Null with
 * fewer than `minCandles` usable returns, so a thin history never pretends to be a vol.
 */
export const realizedVolAnnual = (candles: ReadonlyArray<{ t: number; c: number }>, intervalMs: number, minCandles = 48): number | null => {
  if (!(intervalMs > 0)) return null;
  const closes = [...candles].sort((a, b) => a.t - b.t).map((c) => c.c).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < minCandles + 1) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
  const perYear = YEAR_MS / intervalMs;
  const vol = Math.sqrt(variance * perYear);
  return Number.isFinite(vol) && vol > 0 ? +vol.toFixed(4) : null;
};

export interface CapOddsBand {
  lo: number;
  hi: number;
}
export const DEFAULT_CAP_ODDS_BAND: CapOddsBand = { lo: 0.1, hi: 0.3 };
/** odds move 0.2 per unit of (implied / realized - 1): 1.5x rich vol lifts 20% to 30%, 0.75x drops it to 15% */
export const DEFAULT_CAP_ODDS_SLOPE = 0.2;

export interface CapOddsAdvice {
  baseProb: number;
  impliedVolAnnual: number | null;
  realizedVolAnnual: number | null;
  /** implied / realized; null when either is unreadable */
  ratio: number | null;
  /** the odds the rule would target now, inside the band */
  adviceProb: number;
  band: CapOddsBand;
  reason: "vol_rich" | "vol_cheap" | "near_fair" | "no_vol";
}

/** Where the cap odds should sit now. Pure; the caller decides whether to apply it or only record it. */
export const adaptCapOdds = (input: { baseProb: number; impliedVolAnnual: number | null; realizedVolAnnual: number | null; band?: CapOddsBand; slope?: number }): CapOddsAdvice => {
  const band = input.band ?? DEFAULT_CAP_ODDS_BAND;
  const slope = input.slope ?? DEFAULT_CAP_ODDS_SLOPE;
  const clamp = (p: number) => Math.min(band.hi, Math.max(band.lo, p));
  const base = clamp(input.baseProb);
  const iv = input.impliedVolAnnual;
  const rv = input.realizedVolAnnual;
  if (!(iv != null && iv > 0 && rv != null && rv > 0)) return { baseProb: base, impliedVolAnnual: iv ?? null, realizedVolAnnual: rv ?? null, ratio: null, adviceProb: base, band, reason: "no_vol" };
  const ratio = +(iv / rv).toFixed(3);
  const advice = +clamp(base + slope * (ratio - 1)).toFixed(4);
  const reason = ratio >= 1.15 ? "vol_rich" : ratio <= 0.9 ? "vol_cheap" : "near_fair";
  return { baseProb: base, impliedVolAnnual: iv, realizedVolAnnual: rv, ratio, adviceProb: advice, band, reason };
};

/** The cap rule with the advised odds applied (target rule only; `widest` has no odds to move). */
export const applyCapOdds = (rule: CapRule, advice: CapOddsAdvice): CapRule => (rule.kind === "target" ? { kind: "target", maxExceedProb: advice.adviceProb } : rule);

/** OKX `expTime` (YYMMDD, UTC) for an expiry timestamp — the opt-summary key. */
export const expTimeFromMs = (expiryMs: number): string => {
  const d = new Date(expiryMs);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
};

export const YEAR_MS = 365 * 86_400_000;
