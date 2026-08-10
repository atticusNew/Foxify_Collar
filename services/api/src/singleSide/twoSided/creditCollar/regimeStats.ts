/**
 * Regime & realized-vol readout (pure, offline). Answers the two questions a short-vol income book lives
 * or dies by: (1) what REALIZED vol are we actually in (vs the ~implied the caps were priced at), and
 * (2) is the credit CLEARING the collar bleed as the regime mixes — and how smooth is it day to day
 * (the value staggered opening adds). Computed from the settlement ledger: each settled position carries
 * its 24h move, collar payout, credit, and side, so we can derive realized vol and group P&L by day.
 */

import type { SettlementOutcome } from "./forwardSettlement";
import { loadSettlements } from "./forwardSettlementStore";
import { perpPnlUsdc } from "./foxifyPerpView";
import { evaluateRegimeGate, type RegimeGateConfig, type RegimeGateDecision } from "./regimeGate";

const r2 = (x: number) => +x.toFixed(2);
const r4 = (x: number) => +x.toFixed(4);

const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length);
};

export type RegimeDay = {
  dayIso: string;
  positions: number;
  avgMovePct: number;
  realizedVolPct: number; // stdev of that day's 24h moves, in %
  creditUsdc: number;
  collarUsdc: number; // collar payout to Foxify (− = capped upside given back)
  feesUsdc: number;
  netUsdc: number; // credit + collar + perp − fees
};

export type RegimeStats = {
  settledPositions: number;
  days: number;
  // ── Realized vol (the regime) ──
  realizedDailyVolPct: number; // stdev of 24h moves, in %
  realizedAnnualVolPct: number; // × √365
  avgAbsMovePct: number;
  // ── Per-day Foxify P&L (the smoothing + does-credit-clear-bleed view) ──
  avgDayNetUsdc: number;
  bestDayNetUsdc: number;
  worstDayNetUsdc: number;
  dayNetStdUsdc: number; // spread of daily net — lower = smoother (staggering shrinks this)
  pctDaysPositive: number;
  // ── Cumulative: is the credit clearing the collar bleed? ──
  cumulativeCreditUsdc: number;
  cumulativeCollarUsdc: number;
  cumulativeFeesUsdc: number;
  cumulativeNetUsdc: number;
  creditClearsBleed: boolean; // cumulative net ≥ 0
  gate: RegimeGateDecision | null; // current regime-gate action (null if no gate config supplied)
  /**
   * Directional-signal measurement (day-level — same-day positions share one market outcome, so the
   * independent unit is the DAY, not the trade). Bayesian Beta(1,1) posterior on the day-level hit rate;
   * pAboveBreakeven = P(hit rate > breakeven) — the number the throttle rule acts on. NOTE the power
   * reality: ~600 independent days separate 55% from breakeven at 95% confidence; a 2-week pilot gives
   * ±26pts. This block MEASURES, it does not "validate".
   */
  signal: {
    days: number;
    correctDays: number;
    dayHitRate: number;
    posteriorMean: number;
    breakevenUsed: number;
    pAboveBreakeven: number;
    ci95: [number, number];
  } | null;
  recentDays: RegimeDay[];
};

export type RegimeConfig = {
  perpFeeUsdc?: number;
  recentDays?: number;
  gate?: RegimeGateConfig;
  liveGaugePct?: number | null;
  /** Breakeven hit-rate the signal must clear (from the historical table; ~0.52 normal tape). Default 0.52. */
  signalBreakevenPct?: number;
  /** Last persisted gate regime, so the dashboard's gate display applies the same hysteresis as the loop. */
  prevRegime?: "calm" | "elevated" | "halt" | null;
};

// Beta(a,b) posterior utilities (numeric; small and dependency-free).
const betaPdf = (x: number, a: number, b: number): number => {
  if (x <= 0 || x >= 1) return 0;
  // log-space to avoid overflow for larger a,b
  const logB = lgamma(a) + lgamma(b) - lgamma(a + b);
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logB);
};
const lgamma = (z: number): number => {
  // Lanczos approximation
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const betaTailProb = (threshold: number, a: number, b: number): number => {
  // P(X > threshold) by Simpson integration over [threshold, 1]
  const n = 400;
  const h = (1 - threshold) / n;
  if (h <= 0) return 0;
  let s = betaPdf(threshold, a, b) + betaPdf(1, a, b);
  for (let i = 1; i < n; i++) s += betaPdf(threshold + i * h, a, b) * (i % 2 ? 4 : 2);
  return Math.min(1, Math.max(0, (s * h) / 3));
};
const betaQuantile = (q: number, a: number, b: number): number => {
  // bisection on the CDF (1 − tail)
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (1 - betaTailProb(mid, a, b) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

export const buildRegimeStats = (outcomes: SettlementOutcome[], cfg: RegimeConfig = {}): RegimeStats => {
  // Default 0: no fee assumed until the partner's real number is known (dashboards show observed money only).
  const fee = cfg.perpFeeUsdc != null && cfg.perpFeeUsdc >= 0 ? cfg.perpFeeUsdc : 0;
  const nRecent = cfg.recentDays ?? 14;

  const moves = outcomes.map((o) => o.movePct);
  const dailyVol = std(moves) * 100;

  // Group by settlement day (UTC).
  const byDay = new Map<string, SettlementOutcome[]>();
  for (const o of outcomes) {
    const day = new Date(o.settledAtMs).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(o);
    byDay.set(day, arr);
  }

  const days: RegimeDay[] = [...byDay.entries()]
    .map(([dayIso, os]) => {
      const credit = os.reduce((s, o) => s + o.foxifyCreditUsdc, 0);
      const collar = os.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);
      const perp = os.reduce((s, o) => s + perpPnlUsdc(o), 0);
      const fees = os.length * fee;
      const dayMoves = os.map((o) => o.movePct);
      return {
        dayIso,
        positions: os.length,
        avgMovePct: r4(dayMoves.reduce((s, m) => s + m, 0) / os.length),
        realizedVolPct: r2(std(dayMoves) * 100),
        creditUsdc: r2(credit),
        collarUsdc: r2(collar),
        feesUsdc: r2(fees),
        netUsdc: r2(credit + collar + perp - fees)
      };
    })
    .sort((a, b) => (a.dayIso < b.dayIso ? 1 : -1)); // newest first

  const dayNets = days.map((d) => d.netUsdc);
  const cumCredit = outcomes.reduce((s, o) => s + o.foxifyCreditUsdc, 0);
  const cumCollar = outcomes.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);
  const cumPerp = outcomes.reduce((s, o) => s + perpPnlUsdc(o), 0);
  const cumFees = outcomes.length * fee;
  const cumNet = cumCredit + cumCollar + cumPerp - cumFees;

  return {
    settledPositions: outcomes.length,
    days: days.length,
    realizedDailyVolPct: r2(dailyVol),
    realizedAnnualVolPct: r2(dailyVol * Math.sqrt(365)),
    avgAbsMovePct: r4(moves.reduce((s, m) => s + Math.abs(m), 0) / Math.max(1, moves.length)),
    avgDayNetUsdc: days.length ? r2(dayNets.reduce((s, x) => s + x, 0) / days.length) : 0,
    bestDayNetUsdc: days.length ? r2(Math.max(...dayNets)) : 0,
    worstDayNetUsdc: days.length ? r2(Math.min(...dayNets)) : 0,
    dayNetStdUsdc: r2(std(dayNets)),
    pctDaysPositive: days.length ? r4(days.filter((d) => d.netUsdc > 0).length / days.length) : 0,
    cumulativeCreditUsdc: r2(cumCredit),
    cumulativeCollarUsdc: r2(cumCollar),
    cumulativeFeesUsdc: r2(cumFees),
    cumulativeNetUsdc: r2(cumNet),
    creditClearsBleed: cumNet >= 0,
    gate: cfg.gate ? evaluateRegimeGate(outcomes.slice(-(cfg.gate.lookback ?? 40)).map((o) => Math.abs(o.movePct)), cfg.gate, cfg.liveGaugePct ?? null, cfg.prevRegime ?? null) : null,
    signal: (() => {
      // Day-level hit rate: a day is "correct" if the majority of its settled positions sat on the winning
      // side of that day's move. (Same-day positions share the outcome ⟹ one observation per day.)
      let correct = 0;
      let counted = 0;
      for (const [, os] of byDay) {
        const decided = os.filter((o) => o.movePct !== 0);
        if (!decided.length) continue;
        const hits = decided.filter((o) => (o.side === "long") === (o.movePct > 0)).length;
        if (hits * 2 === decided.length) continue; // perfectly split (neutral pairs) — no directional info
        counted += 1;
        if (hits * 2 > decided.length) correct += 1;
      }
      if (counted === 0) return null;
      const a = 1 + correct, b = 1 + (counted - correct);
      const be = cfg.signalBreakevenPct ?? 0.52;
      return {
        days: counted,
        correctDays: correct,
        dayHitRate: +(correct / counted).toFixed(4),
        posteriorMean: +(a / (a + b)).toFixed(4),
        breakevenUsed: be,
        pAboveBreakeven: +betaTailProb(be, a, b).toFixed(4),
        ci95: [+betaQuantile(0.025, a, b).toFixed(4), +betaQuantile(0.975, a, b).toFixed(4)] as [number, number]
      };
    })(),
    recentDays: days.slice(0, nRecent)
  };
};

export const loadRegimeStats = (ledgerPath?: string, cfg: RegimeConfig = {}): RegimeStats =>
  buildRegimeStats(loadSettlements(ledgerPath), cfg);
