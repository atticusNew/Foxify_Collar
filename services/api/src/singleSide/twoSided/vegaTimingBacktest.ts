/**
 * Vega-timing backtest (Phase: calm-edge research, pure REAL DVOL history).
 *
 * Thesis: in calm, IV is low and MEAN-REVERTS. Buying a long-vega ATM straddle
 * when IV is in a LOW percentile, then exiting after a hold, can profit from IV
 * EXPANSION (vega gain) — direction-agnostic — IF that gain beats theta decay.
 *
 * Method (REAL data: two_sided_dvol_history; NO synthetics):
 *   - For each historical sample, compute its IV percentile vs the trailing
 *     `lookbackDays` window.
 *   - Entry rule: percentile <= entryPercentile (cheap vol) [+ optional calm-only].
 *   - Value an ATM straddle at entry IV (tenor T) and at the IV `holdDays` later
 *     (tenor T - hold), HOLDING SPOT CONSTANT at a reference spot. This ISOLATES
 *     the vol-timing P&L (vega gain vs theta) — it deliberately excludes the
 *     spot/gamma/directional component (we have DVOL history, not spot history).
 *   - Aggregate mean P&L/BTC + % profitable + mean IV change.
 *
 * Interpretation: positive mean ⇒ cheap-vol buying historically paid (IV
 * expansion > theta) → a real, direction-agnostic calm edge worth pursuing.
 * Negative ⇒ theta dominated → not an edge. Either way it's REAL evidence.
 */

import type { Pool, PoolClient } from "pg";
import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";
import { RISK_FREE_RATE } from "./optionPricing";

const MS_PER_DAY = 86_400_000;

/** Fraction of trailing values <= the given value (0..1). */
export const computeIvPercentile = (trailing: number[], value: number): number => {
  if (trailing.length === 0) return 0.5;
  return trailing.filter((x) => x <= value).length / trailing.length;
};

export type VegaTimingResult = {
  entry_percentile: number;
  hold_days: number;
  tenor_days: number;
  lookback_days: number;
  ref_spot: number;
  calm_only: boolean;
  granularity_hours: number;
  total_samples: number;
  downsampled_samples: number;
  eligible_entries: number;
  mean_pnl_per_btc_usdc: number;
  pct_profitable: number;
  mean_entry_iv: number;
  mean_exit_iv: number;
  mean_iv_change: number;
  verdict: string;
  caveats: string[];
};

export const backtestVegaTiming = async (
  pool: Pool | PoolClient,
  opts: {
    entryPercentile?: number;
    holdDays?: number;
    tenorDays?: number;
    lookbackDays?: number;
    refSpot?: number;
    calmOnly?: boolean;
    minTrailing?: number;
    granularityHours?: number;
  } = {}
): Promise<VegaTimingResult> => {
  const entryPercentile = opts.entryPercentile ?? 0.25;
  const holdDays = opts.holdDays ?? 2;
  const tenorDays = opts.tenorDays ?? 7;
  const lookbackDays = opts.lookbackDays ?? 30;
  const refSpot = opts.refSpot ?? 73000;
  const calmOnly = opts.calmOnly ?? true;
  const minTrailing = opts.minTrailing ?? 20;
  const granularityHours = opts.granularityHours ?? 1;
  const r = RISK_FREE_RATE;

  const res = await pool.query<{ ts: string; dvol: string }>(
    `SELECT ts, dvol FROM two_sided_dvol_history ORDER BY ts ASC`
  );
  const rawRows = res.rows
    .map((x) => ({ tsMs: new Date(x.ts).getTime(), dvol: Number(x.dvol) }))
    .filter((x) => Number.isFinite(x.tsMs) && Number.isFinite(x.dvol) && x.dvol > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
  // Downsample to one sample per `granularityHours` bucket so dense live samples
  // (~1/min) don't swamp the sparser backfill (~1/hr) and bias entries toward the
  // most recent flat period. Keeps the LAST sample in each bucket.
  const granMs = granularityHours * 3_600_000;
  const bucket = new Map<number, { tsMs: number; dvol: number }>();
  for (const x of rawRows) bucket.set(Math.floor(x.tsMs / granMs), x);
  const rows = [...bucket.values()].sort((a, b) => a.tsMs - b.tsMs);

  const lookbackMs = lookbackDays * MS_PER_DAY;
  const holdMs = holdDays * MS_PER_DAY;
  const straddle = (iv: number, T: number): number =>
    Math.max(0, bsPut(refSpot, refSpot, T, r, iv)) + Math.max(0, bsCall(refSpot, refSpot, T, r, iv));

  const pnls: number[] = [];
  const iv0s: number[] = [];
  const iv1s: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    if (calmOnly && e.dvol >= 40) continue;
    // trailing window percentile
    const trailing: number[] = [];
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].tsMs < e.tsMs - lookbackMs) break;
      trailing.push(rows[j].dvol);
    }
    if (trailing.length < minTrailing) continue;
    if (computeIvPercentile(trailing, e.dvol) > entryPercentile) continue;
    // exit = nearest sample to entry + holdDays (within ±12h)
    const targetExit = e.tsMs + holdMs;
    let exit: { tsMs: number; dvol: number } | null = null;
    let bestDiff = Infinity;
    for (let k = i + 1; k < rows.length; k++) {
      const d = Math.abs(rows[k].tsMs - targetExit);
      if (d < bestDiff) { bestDiff = d; exit = rows[k]; }
      if (rows[k].tsMs > targetExit + 12 * 3_600_000) break;
    }
    if (!exit || bestDiff > 12 * 3_600_000) continue;
    const iv0 = e.dvol / 100;
    const iv1 = exit.dvol / 100;
    const T0 = tenorDays / 365;
    const T1 = Math.max(0.0001, (tenorDays - holdDays) / 365);
    pnls.push(straddle(iv1, T1) - straddle(iv0, T0));
    iv0s.push(iv0);
    iv1s.push(iv1);
  }

  const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const meanPnl = +mean(pnls).toFixed(2);
  const pctProfitable = pnls.length ? +(pnls.filter((x) => x > 0).length / pnls.length).toFixed(4) : 0;
  const meanIv0 = +mean(iv0s).toFixed(4);
  const meanIv1 = +mean(iv1s).toFixed(4);

  const verdict = pnls.length < 10
    ? `INSUFFICIENT DATA: only ${pnls.length} eligible entries — accumulate more DVOL history (or widen entry_percentile / shorten lookback).`
    : meanPnl > 0
      ? `+EV: buying cheap vol (<=${(entryPercentile * 100).toFixed(0)}th pctile) netted +$${meanPnl}/BTC over ${holdDays}d (${(pctProfitable * 100).toFixed(0)}% profitable; IV ${(meanIv0 * 100).toFixed(1)}%→${(meanIv1 * 100).toFixed(1)}%). Direction-agnostic calm edge candidate — validate live before trusting.`
      : `-EV: $${meanPnl}/BTC — cheap-vol buying did NOT pay (theta decay > IV-expansion gain over ${holdDays}d). Not a calm edge at these params.`;

  return {
    entry_percentile: entryPercentile, hold_days: holdDays, tenor_days: tenorDays,
    lookback_days: lookbackDays, ref_spot: refSpot, calm_only: calmOnly,
    granularity_hours: granularityHours,
    total_samples: rawRows.length, downsampled_samples: rows.length, eligible_entries: pnls.length,
    mean_pnl_per_btc_usdc: meanPnl, pct_profitable: pctProfitable,
    mean_entry_iv: meanIv0, mean_exit_iv: meanIv1, mean_iv_change: +(meanIv1 - meanIv0).toFixed(4),
    verdict,
    caveats: [
      "Holds SPOT CONSTANT at ref_spot — isolates the vol-timing P&L (vega gain vs theta); excludes spot/gamma/directional P&L (DVOL history has no spot). Real P&L would add the directional/gamma component.",
      "ATM straddle valued via Black-Scholes at the entry/exit DVOL (no bid/ask spread modeled) — a clean vol-timing signal, not a fill-accurate execution backtest.",
      "REAL DVOL history (two_sided_dvol_history). Accumulates with the backfill + live persister."
    ]
  };
};
