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
  recentDays: RegimeDay[];
};

export type RegimeConfig = { perpFeeUsdc?: number; recentDays?: number };

export const buildRegimeStats = (outcomes: SettlementOutcome[], cfg: RegimeConfig = {}): RegimeStats => {
  const fee = cfg.perpFeeUsdc != null && cfg.perpFeeUsdc >= 0 ? cfg.perpFeeUsdc : 80;
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
    recentDays: days.slice(0, nRecent)
  };
};

export const loadRegimeStats = (ledgerPath?: string, cfg: RegimeConfig = {}): RegimeStats =>
  buildRegimeStats(loadSettlements(ledgerPath), cfg);
