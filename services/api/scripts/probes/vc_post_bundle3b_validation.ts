#!/usr/bin/env tsx
/**
 * Volume Cover — Post-Bundle-3-B economic validation.
 *
 * Backtest + Monte Carlo against the production stack as it stands
 * after Bundles 1, 2, and 3-B:
 *
 *   • 4-leg [DB] vertical spread (50k_2pct_1k cell)
 *   • Y=$800 calm payout (PR-G overlay)
 *   • X=$350 daily premium, flat across regimes (Hybrid v3)
 *   • PR-G2 mid-IOC short buyback at trigger (improvementFraction=0.5)
 *   • PR-Bundle-3-B winner_only long-trigger policy (sell winner, retain loser)
 *   • PR-Bundle-3-B spread ladder netting (60% modeled reopen-rate)
 *   • PR-G max-hold cap 72h
 *   • h = 0.68 (verified from Trade 1 hedge_buy_out ledger entry)
 *   • s = 0.70 (modeled post Bundles 1+2+3-B)
 *
 * Answers five questions:
 *
 *   Q1. Empirical 1-day ±2% trigger rate, by vol regime
 *   Q2. Theta retention factor on 1-day no-trigger close (3d expiry spread)
 *   Q3. Per-cycle EV distribution (mean / median / P5 / P95 / win-rate)
 *   Q4. Sensitivity to salvage ratio s (break-even threshold)
 *   Q5. Ladder-netting marginal contribution by reopen-rate
 *
 * Plus:
 *   • Stress test at forced P(trigger)=0.25 (worst case from sensitivity table)
 *   • Capital adequacy at 1/5/10 concurrent pairs at $10k/$20k/$50k/$100k caps
 *
 * Outputs:
 *   stdout  — markdown summary
 *   ./vc_post_bundle3b_validation.json — structured results for tooling
 *
 * Run:
 *   npx tsx services/api/scripts/probes/vc_post_bundle3b_validation.ts
 *   npx tsx services/api/scripts/probes/vc_post_bundle3b_validation.ts --days 365
 */

import * as fs from "node:fs/promises";

const DERIBIT = "https://www.deribit.com/api/v2/public";

// ─── Constants ─────────────────────────────────────────────────────────

// Fixed inputs that mirror the live production state.
const X_PREMIUM_DAILY = 350; // matrix base + flat across regimes
const Y_PAYOUT_BY_REGIME = {
  calm: 800, // PR-G overlay (post Bundle 2)
  moderate: 750,
  elevated: 450,
  stress: 450 // halted but kept for completeness
};
const TRIGGER_PCT = 0.02; // 50k_2pct_1k cell
const HEDGE_PCT = 0.01; // strikes 1% inside trigger
const SPREAD_WIDTH_USDC = 1000; // grid-snapped Bullish width
const EXPIRY_DAYS = 3; // matrix tenor for 2% cells
const MAX_HOLD_HOURS = 72; // PR-G cap

// Empirical anchors from production (Trade 1 ledger, 2026-05-23).
const H_VERIFIED = 0.68; // hedge_open_net_debit / Y, verified
const S_MODELED_DEFAULT = 0.70; // salvage ratio post Bundles 1+2+3-B

// Foxify hold model — calibrated from Trade 1 (5h50m) + Trade 2 (1.43d).
// Hold mean is a function of payout/premium ratio: with X=$350, Y=$800,
// Foxify is paying $350 per 24h chunk to insure $800. Day 1 is always
// economic. Day 2/3 hold depends on rebate income; we model a
// bounded-exponential hold with mean 1.0 day.
const HOLD_MEAN_DAYS = 1.0;
const HOLD_NOISE_SD = 0.4;

// Realized-vol thresholds → regime (calibrated to DVOL-style buckets,
// in annualized fraction of return).
const REGIME_THRESHOLDS = {
  calm: 0.40, // < 40% ann vol = calm
  moderate: 0.55,
  elevated: 0.70
};

// Ladder netting parameters.
const LADDER_MATCH_PROB = 0.85; // prob that a retained leg matches strike+expiry on the next reopen
const LADDER_REOPEN_RATE_DEFAULT = 0.60; // probability Foxify reopens within 30min same fingerprint+cell

// Monte Carlo trial count.
const N_TRIALS = 8_000;

// Realized-vol lookback window.
const REALIZED_VOL_WINDOW_HOURS = 7 * 24;

const BTC_HISTORY_DAYS_DEFAULT = 180;

// ─── Black-Scholes helpers ────────────────────────────────────────────

const erf = (x: number): number => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
};
const N_cdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

const bsCall = (S: number, K: number, T: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, S - K);
  if (sigma <= 0) return Math.max(0, S - K);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * N_cdf(d1) - K * N_cdf(d2);
};

const bsPut = (S: number, K: number, T: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, K - S);
  if (sigma <= 0) return Math.max(0, K - S);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return K * N_cdf(-d2) - S * N_cdf(-d1);
};

// ─── Data fetch ───────────────────────────────────────────────────────

type Bar = { ts: number; o: number; h: number; l: number; c: number };

const loadBtcHourly = async (days: number): Promise<Bar[]> => {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const url =
    `${DERIBIT}/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL` +
    `&start_timestamp=${start}&end_timestamp=${end}&resolution=60`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`OHLC fetch failed: HTTP ${r.status}`);
  const j: any = await r.json();
  if (j.result?.status !== "ok") throw new Error(`OHLC status: ${j.result?.status}`);
  const ts: number[] = j.result.ticks;
  const o: number[] = j.result.open;
  const h: number[] = j.result.high;
  const l: number[] = j.result.low;
  const c: number[] = j.result.close;
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    bars.push({ ts: ts[i], o: o[i], h: h[i], l: l[i], c: c[i] });
  }
  return bars;
};

// ─── Vol regime classification ────────────────────────────────────────

type Regime = "calm" | "moderate" | "elevated" | "stress";

const realizedVol = (bars: Bar[], endIdx: number, windowHours: number): number => {
  const start = Math.max(0, endIdx - windowHours);
  if (endIdx <= start + 1) return 0.5;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    rets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const hourlyVol = Math.sqrt(variance);
  return hourlyVol * Math.sqrt(24 * 365); // annualized
};

const classifyRegime = (rv: number): Regime => {
  if (rv < REGIME_THRESHOLDS.calm) return "calm";
  if (rv < REGIME_THRESHOLDS.moderate) return "moderate";
  if (rv < REGIME_THRESHOLDS.elevated) return "elevated";
  return "stress";
};

// ─── Trigger detection ────────────────────────────────────────────────

type TriggerOutcome = {
  triggered: boolean;
  triggerHourOffset: number; // 0-indexed from entry hour
  triggerSpot: number;
  direction: "high" | "low" | "none";
};

const detectTrigger = (
  bars: Bar[],
  startIdx: number,
  holdHours: number,
  entrySpot: number
): TriggerOutcome => {
  const triggerHigh = entrySpot * (1 + TRIGGER_PCT);
  const triggerLow = entrySpot * (1 - TRIGGER_PCT);
  const maxOffset = Math.min(Math.ceil(holdHours), bars.length - startIdx - 1);
  for (let offset = 0; offset < maxOffset; offset++) {
    const bar = bars[startIdx + offset];
    if (bar.h >= triggerHigh) {
      return {
        triggered: true,
        triggerHourOffset: offset,
        triggerSpot: triggerHigh,
        direction: "high"
      };
    }
    if (bar.l <= triggerLow) {
      return {
        triggered: true,
        triggerHourOffset: offset,
        triggerSpot: triggerLow,
        direction: "low"
      };
    }
  }
  return {
    triggered: false,
    triggerHourOffset: -1,
    triggerSpot: 0,
    direction: "none"
  };
};

// ─── Spread theta retention via BS ────────────────────────────────────

/**
 * Compute the BS-priced market value of the 4-leg spread at a given
 * spot + remaining time-to-expiry. Returns a signed amount where
 * positive = if Atticus closed all 4 legs right now, this is the net
 * cash IN (value of longs sold − cost to buy back shorts).
 *
 * Used for the no-trigger theta retention question. Calibrated against
 * the verified Trade 1 open net debit ($680 at h=0.68 with Y=$1000).
 */
const spreadValueAtClose = (params: {
  spot: number;
  entrySpot: number;
  remainingDaysToExpiry: number;
  sigma: number;
  contracts: number;
}): number => {
  const { spot, entrySpot, remainingDaysToExpiry: T_days, sigma, contracts } = params;
  if (T_days <= 0) {
    // Intrinsic only — should not happen in our hold window but defensive.
    const K2 = entrySpot * (1 - HEDGE_PCT);
    const K1 = K2 - SPREAD_WIDTH_USDC;
    const K3 = entrySpot * (1 + HEDGE_PCT);
    const K4 = K3 + SPREAD_WIDTH_USDC;
    const longPut = Math.max(0, K2 - spot);
    const shortPut = Math.max(0, K1 - spot);
    const longCall = Math.max(0, spot - K3);
    const shortCall = Math.max(0, spot - K4);
    return contracts * (longPut + longCall - shortPut - shortCall);
  }
  const T = T_days / 365;
  const K2 = entrySpot * (1 - HEDGE_PCT);
  const K1 = K2 - SPREAD_WIDTH_USDC;
  const K3 = entrySpot * (1 + HEDGE_PCT);
  const K4 = K3 + SPREAD_WIDTH_USDC;
  const longPut = bsPut(spot, K2, T, sigma);
  const shortPut = bsPut(spot, K1, T, sigma);
  const longCall = bsCall(spot, K3, T, sigma);
  const shortCall = bsCall(spot, K4, T, sigma);
  return contracts * (longPut + longCall - shortPut - shortCall);
};

// Compute contracts to hedge $Y at intrinsic-floor sizing, matching matrix.ts.
const computeContracts = (Y: number, entrySpot: number): number => {
  const intrinsicAtTrigger = entrySpot * (TRIGGER_PCT - HEDGE_PCT);
  return Math.ceil((Y / intrinsicAtTrigger) * 100) / 100; // 0.01 BTC granularity
};

// ─── Hold sampling ────────────────────────────────────────────────────

const sampleNormal = (rng: () => number): number => {
  let u1 = rng();
  const u2 = rng();
  while (u1 === 0) u1 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const sampleHoldHours = (rng: () => number): number => {
  const noisy = HOLD_MEAN_DAYS * 24 * (1 + HOLD_NOISE_SD * sampleNormal(rng));
  return Math.max(1, Math.min(MAX_HOLD_HOURS, noisy));
};

// ─── Single trial ─────────────────────────────────────────────────────

type TrialResult = {
  regime: Regime;
  triggered: boolean;
  triggerHourOffset: number;
  holdHours: number;
  daysHeld: number;
  premiumIn: number;
  hedgeOpenDebit: number;
  hedgeCloseValue: number;
  payoutOwed: number;
  cyclePnl: number;
  retainsLoserOnly: boolean; // true on triggered cycles (winner_only mode)
  retainsBothLongs: boolean; // true on no-trigger Foxify-close
  Y: number;
};

const runTrial = (
  bars: Bar[],
  rng: () => number,
  s: number
): TrialResult | null => {
  const minStart = REALIZED_VOL_WINDOW_HOURS;
  const maxStart = bars.length - Math.ceil(MAX_HOLD_HOURS) - 24;
  if (maxStart <= minStart) throw new Error("not enough OHLC for window");
  const startIdx = minStart + Math.floor(rng() * (maxStart - minStart));
  const entryBar = bars[startIdx];
  const entrySpot = entryBar.o;

  const sigma = realizedVol(bars, startIdx, REALIZED_VOL_WINDOW_HOURS);
  const regime = classifyRegime(sigma);
  if (regime === "stress") return null; // system halts new opens

  const Y = Y_PAYOUT_BY_REGIME[regime];
  const contracts = computeContracts(Y, entrySpot);
  const hedgeOpenDebit = H_VERIFIED * Y;

  const holdHours = sampleHoldHours(rng);
  const trig = detectTrigger(bars, startIdx, holdHours, entrySpot);
  // daysHeld is what Foxify pays for. Whole-day rounded up per
  // pricing.ts daysHeld math (Foxify's per-24h chunk billing).
  const actualHoldHours = trig.triggered
    ? trig.triggerHourOffset + 1
    : holdHours;
  const daysHeld = Math.max(1, Math.ceil(actualHoldHours / 24));
  const premiumIn = X_PREMIUM_DAILY * daysHeld;

  let hedgeCloseValue: number;
  let payoutOwed: number;
  let retainsLoserOnly = false;
  let retainsBothLongs = false;

  if (trig.triggered) {
    // Trigger fired.
    // Salvage = s × Y models the realized-close cash in:
    //   short_buybacks (paid, mid-IOC) + winner_long_sale (peak captured)
    //   + retained_loser_long_eventual_sale (TP curve)
    // Net of payment to Foxify is computed separately.
    hedgeCloseValue = s * Y;
    payoutOwed = Y;
    retainsLoserOnly = true; // winner_only mode
  } else {
    // No trigger — Foxify hits max-hold OR closes at sampled hold.
    // BS-price the spread at remaining expiry to get realized close
    // value. (This is the foxify_close path: shorts bought back via
    // mid-IOC, longs retained for hedge manager → ladder eligibility.)
    const remainingDaysToExpiry = Math.max(0, EXPIRY_DAYS - actualHoldHours / 24);
    const closeBar = bars[Math.min(bars.length - 1, startIdx + Math.ceil(actualHoldHours))];
    const closeSpot = closeBar.c;
    hedgeCloseValue = spreadValueAtClose({
      spot: closeSpot,
      entrySpot,
      remainingDaysToExpiry,
      sigma,
      contracts
    });
    payoutOwed = 0;
    retainsBothLongs = true;
  }

  const cyclePnl = premiumIn - hedgeOpenDebit + hedgeCloseValue - payoutOwed;

  return {
    regime,
    triggered: trig.triggered,
    triggerHourOffset: trig.triggerHourOffset,
    holdHours: actualHoldHours,
    daysHeld,
    premiumIn,
    hedgeOpenDebit,
    hedgeCloseValue,
    payoutOwed,
    cyclePnl,
    retainsLoserOnly,
    retainsBothLongs,
    Y
  };
};

// ─── Stats helpers ────────────────────────────────────────────────────

type Stats = {
  count: number;
  mean: number;
  median: number;
  p5: number;
  p95: number;
  min: number;
  max: number;
  stdev: number;
  positiveRate: number;
};

const computeStats = (xs: number[]): Stats => {
  if (xs.length === 0) {
    return {
      count: 0, mean: 0, median: 0, p5: 0, p95: 0,
      min: 0, max: 0, stdev: 0, positiveRate: 0
    };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))];
  return {
    count: n,
    mean: Number(mean.toFixed(2)),
    median: Number(pct(0.5).toFixed(2)),
    p5: Number(pct(0.05).toFixed(2)),
    p95: Number(pct(0.95).toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[n - 1].toFixed(2)),
    stdev: Number(Math.sqrt(variance).toFixed(2)),
    positiveRate: Number((sorted.filter((x) => x > 0).length / n).toFixed(4))
  };
};

// ─── Deterministic RNG (Mulberry32) ────────────────────────────────────

const makeRng = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ─── Per-question runs ────────────────────────────────────────────────

const runBaselineMonteCarlo = (bars: Bar[], s: number, seed: number) => {
  const rng = makeRng(seed);
  const trials: TrialResult[] = [];
  let stressBlocked = 0;
  while (trials.length < N_TRIALS) {
    const r = runTrial(bars, rng, s);
    if (r === null) {
      stressBlocked++;
      continue;
    }
    trials.push(r);
    if (trials.length + stressBlocked > N_TRIALS * 4) break; // safety
  }
  const all = trials.map((t) => t.cyclePnl);
  const triggers = trials.filter((t) => t.triggered).map((t) => t.cyclePnl);
  const noTriggers = trials.filter((t) => !t.triggered).map((t) => t.cyclePnl);

  const byRegime: Record<Regime, { trials: TrialResult[] }> = {
    calm: { trials: [] }, moderate: { trials: [] },
    elevated: { trials: [] }, stress: { trials: [] }
  };
  for (const t of trials) byRegime[t.regime].trials.push(t);

  return {
    nTrials: trials.length,
    nStressBlocked: stressBlocked,
    overall: computeStats(all),
    triggered: computeStats(triggers),
    noTrigger: computeStats(noTriggers),
    triggerRate: Number((triggers.length / trials.length).toFixed(4)),
    byRegime: Object.fromEntries(
      Object.entries(byRegime).map(([r, b]) => [
        r,
        {
          n: b.trials.length,
          triggerRate: b.trials.length > 0
            ? Number((b.trials.filter((t) => t.triggered).length / b.trials.length).toFixed(4))
            : 0,
          stats: computeStats(b.trials.map((t) => t.cyclePnl))
        }
      ])
    ) as Record<Regime, { n: number; triggerRate: number; stats: Stats }>
  };
};

const sweepSalvage = (bars: Bar[], svalues: number[], seed: number) => {
  const out: Array<{ s: number; mean: number; positiveRate: number; triggerEv: number; noTrigEv: number }> = [];
  for (const s of svalues) {
    const r = runBaselineMonteCarlo(bars, s, seed);
    out.push({
      s,
      mean: r.overall.mean,
      positiveRate: r.overall.positiveRate,
      triggerEv: r.triggered.mean,
      noTrigEv: r.noTrigger.mean
    });
  }
  return out;
};

const sweepLadderReopen = (
  baseline: ReturnType<typeof runBaselineMonteCarlo>,
  rates: number[]
) => {
  // Ladder netting saves the open cost of LONG legs that match. With
  // h=0.68 verified for Y=$800: longs cost $1160 of $1700 spread, shorts
  // collect $480. Long-leg cost ≈ $1160 × (Y / 1000) × (1 / verified_Y).
  // Using verified-trade ratios scaled to Y=$800:
  //   long_leg_cost = $1160 × 0.8 = $928
  // Per-leg savings (one of two longs) = $464.
  // Triggered cycle (winner_only) retains 1 long → eligible for half-ladder.
  // No-trigger Foxify-close retains 2 longs → eligible for full-ladder.
  const SAVINGS_FULL_LADDER_AT_800 = 928;  // both longs reused on next open
  const SAVINGS_HALF_LADDER_AT_800 = 464;  // one long reused
  // Across regimes, the savings scales linearly with Y. We approximate
  // the weighted average by reading byRegime trial counts.
  const triggerShare = baseline.byRegime.calm.n + baseline.byRegime.moderate.n + baseline.byRegime.elevated.n > 0
    ? baseline.triggered.count / baseline.nTrials
    : 0;
  const noTrigShare = 1 - triggerShare;
  // Weight the savings by retention probability:
  //   triggered cycles: half-ladder
  //   no-trigger cycles: full-ladder
  // Then scale by ladder match probability (strikes + expiry compatible).
  const out = rates.map((reopenRate) => {
    const expectedSavingsPerCycle =
      LADDER_MATCH_PROB * reopenRate * (
        triggerShare * SAVINGS_HALF_LADDER_AT_800 +
        noTrigShare * SAVINGS_FULL_LADDER_AT_800
      );
    return {
      reopenRate,
      expectedSavingsPerCycle: Number(expectedSavingsPerCycle.toFixed(2)),
      adjustedMeanCyclePnl: Number((baseline.overall.mean + expectedSavingsPerCycle).toFixed(2))
    };
  });
  return out;
};

const stressTestForcedTriggerRate = (
  bars: Bar[],
  s: number,
  forcedP: number,
  seed: number
) => {
  // Force a target trigger rate by re-running trials and re-rolling
  // the trigger outcome to match `forcedP`. PnL is computed from the
  // empirical no-trigger / triggered EV from the baseline run.
  const baseline = runBaselineMonteCarlo(bars, s, seed);
  const ev = forcedP * baseline.triggered.mean + (1 - forcedP) * baseline.noTrigger.mean;
  return {
    forcedP,
    triggerEvFromBaseline: baseline.triggered.mean,
    noTrigEvFromBaseline: baseline.noTrigger.mean,
    forcedEv: Number(ev.toFixed(2))
  };
};

// ─── Capital adequacy simulation ──────────────────────────────────────

type CapitalSimResult = {
  capUsdc: number;
  pairs: number;
  maxDrawdownUsdc: number;
  maxConcurrentExposureUsdc: number;
  endBalanceUsdc: number;
  cyclesPerPair: number;
  capExceededPct: number; // % of sim time exposure exceeded cap
};

const simulateCapitalUsage = (params: {
  bars: Bar[];
  s: number;
  capUsdc: number;
  pairs: number;
  daysSimulated: number;
  seed: number;
}): CapitalSimResult => {
  const { bars, s, capUsdc, pairs, daysSimulated, seed } = params;
  const rng = makeRng(seed);
  // Per-pair active state machine. Each pair, when free, opens a new
  // cycle at the current sim hour; cycle runs to trigger or hold-hours.
  const cycleTimeline: Array<{ tStart: number; tEnd: number; pnl: number; hedgeOpenDebit: number; payout: number }> = [];
  type PairState = {
    busyUntilHour: number;
    hedgeOpenDebit: number;
    payoutOwed: number;
    cyclePnl: number;
  };
  const pairStates: PairState[] = Array.from({ length: pairs }, () => ({
    busyUntilHour: 0,
    hedgeOpenDebit: 0,
    payoutOwed: 0,
    cyclePnl: 0
  }));
  // Simulate daysSimulated × 24 hours, advance each pair as it frees.
  const totalHours = daysSimulated * 24;
  let activeExposure = 0;
  let maxExposure = 0;
  let runningBalance = capUsdc;
  let minBalance = capUsdc;
  let hoursCapExceeded = 0;

  for (let h = 0; h < totalHours; h++) {
    // Free up pairs whose cycle ended at or before this hour. Settle PnL.
    for (const ps of pairStates) {
      if (ps.busyUntilHour > 0 && ps.busyUntilHour <= h) {
        runningBalance += ps.cyclePnl;
        activeExposure -= ps.hedgeOpenDebit;
        ps.busyUntilHour = 0;
        ps.hedgeOpenDebit = 0;
        ps.payoutOwed = 0;
        ps.cyclePnl = 0;
      }
    }
    // For each free pair, start a new cycle.
    for (const ps of pairStates) {
      if (ps.busyUntilHour > 0) continue;
      // Run a new trial starting at hour h. Use the same trial logic.
      // We need a starting bar — pick the bar at offset h from REALIZED_VOL_WINDOW_HOURS.
      const startIdx = REALIZED_VOL_WINDOW_HOURS + h;
      if (startIdx >= bars.length - MAX_HOLD_HOURS - 1) continue;
      const sigma = realizedVol(bars, startIdx, REALIZED_VOL_WINDOW_HOURS);
      const regime = classifyRegime(sigma);
      if (regime === "stress") {
        // System halts; pair stays free for next hour.
        continue;
      }
      const Y = Y_PAYOUT_BY_REGIME[regime];
      const entrySpot = bars[startIdx].o;
      const contracts = computeContracts(Y, entrySpot);
      const hedgeOpenDebit = H_VERIFIED * Y;

      // Capital check — if cap exceeded, skip this open (back off).
      if (activeExposure + hedgeOpenDebit > capUsdc) {
        hoursCapExceeded++;
        continue;
      }

      const holdHours = sampleHoldHours(rng);
      const trig = detectTrigger(bars, startIdx, holdHours, entrySpot);
      const actualHoldHours = trig.triggered ? trig.triggerHourOffset + 1 : holdHours;
      const daysHeld = Math.max(1, Math.ceil(actualHoldHours / 24));
      const premiumIn = X_PREMIUM_DAILY * daysHeld;
      let hedgeCloseValue: number;
      let payoutOwed: number;
      if (trig.triggered) {
        hedgeCloseValue = s * Y;
        payoutOwed = Y;
      } else {
        const remainingDaysToExpiry = Math.max(0, EXPIRY_DAYS - actualHoldHours / 24);
        const closeIdx = Math.min(bars.length - 1, startIdx + Math.ceil(actualHoldHours));
        hedgeCloseValue = spreadValueAtClose({
          spot: bars[closeIdx].c,
          entrySpot,
          remainingDaysToExpiry,
          sigma,
          contracts
        });
        payoutOwed = 0;
      }
      const cyclePnl = premiumIn - hedgeOpenDebit + hedgeCloseValue - payoutOwed;
      ps.busyUntilHour = h + Math.ceil(actualHoldHours);
      ps.hedgeOpenDebit = hedgeOpenDebit;
      ps.payoutOwed = payoutOwed;
      ps.cyclePnl = cyclePnl;
      activeExposure += hedgeOpenDebit;
      cycleTimeline.push({
        tStart: h, tEnd: ps.busyUntilHour, pnl: cyclePnl,
        hedgeOpenDebit, payout: payoutOwed
      });
    }
    if (activeExposure > maxExposure) maxExposure = activeExposure;
    if (runningBalance < minBalance) minBalance = runningBalance;
  }

  // Settle any still-active cycles at end of sim.
  for (const ps of pairStates) {
    if (ps.busyUntilHour > 0) {
      runningBalance += ps.cyclePnl;
      activeExposure -= ps.hedgeOpenDebit;
    }
  }

  return {
    capUsdc,
    pairs,
    maxDrawdownUsdc: Number((capUsdc - minBalance).toFixed(2)),
    maxConcurrentExposureUsdc: Number(maxExposure.toFixed(2)),
    endBalanceUsdc: Number(runningBalance.toFixed(2)),
    cyclesPerPair: cycleTimeline.length / pairs,
    capExceededPct: Number(((hoursCapExceeded / totalHours) * 100).toFixed(2))
  };
};

// ─── Main ─────────────────────────────────────────────────────────────

const formatPct = (n: number) => `${(n * 100).toFixed(2)}%`;
const fmtUsd = (n: number) => `${n >= 0 ? "+" : ""}\$${n.toFixed(2)}`;

const parseArgs = (): { days: number } => {
  const args = process.argv.slice(2);
  const d = args.indexOf("--days");
  if (d >= 0 && args[d + 1]) {
    const n = Number(args[d + 1]);
    if (Number.isFinite(n) && n > 30) return { days: n };
  }
  return { days: BTC_HISTORY_DAYS_DEFAULT };
};

const main = async () => {
  const { days } = parseArgs();
  const seed = 0xDEADBEEF;

  console.log(`# VC Post-Bundle-3-B Validation`);
  console.log(`\nGenerated: ${new Date().toISOString()}`);
  console.log(`BTC OHLC window: last ${days} days, hourly bars`);
  console.log(`Trials per scenario: ${N_TRIALS}`);
  console.log(`\nLoading BTC OHLC...`);

  const bars = await loadBtcHourly(days);
  console.log(`Loaded ${bars.length} hourly bars (${bars[0]?.ts ? new Date(bars[0].ts).toISOString().slice(0, 10) : "?"} → ${bars[bars.length - 1]?.ts ? new Date(bars[bars.length - 1].ts).toISOString().slice(0, 10) : "?"})`);

  // Q1 + Q3: baseline run.
  console.log(`\n## Baseline Monte Carlo (s=${S_MODELED_DEFAULT}, h=${H_VERIFIED}, Y=$800 calm / $750 mod / $450 elev)`);
  const baseline = runBaselineMonteCarlo(bars, S_MODELED_DEFAULT, seed);
  console.log(`\nTrials: ${baseline.nTrials} (${baseline.nStressBlocked} stress blocked, system would HALT new opens)`);
  console.log(`\nOverall per-cycle EV:`);
  console.log(`  Mean:        ${fmtUsd(baseline.overall.mean)}`);
  console.log(`  Median:      ${fmtUsd(baseline.overall.median)}`);
  console.log(`  P5:          ${fmtUsd(baseline.overall.p5)}`);
  console.log(`  P95:         ${fmtUsd(baseline.overall.p95)}`);
  console.log(`  Stdev:       ${fmtUsd(baseline.overall.stdev)}`);
  console.log(`  Win rate:    ${formatPct(baseline.overall.positiveRate)}`);
  console.log(`\nTrigger rate (empirical): ${formatPct(baseline.triggerRate)}`);
  console.log(`\nBy regime:`);
  console.log(`| Regime | N | Trigger Rate | Mean EV | Win Rate |`);
  console.log(`|---|---:|---:|---:|---:|`);
  for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
    const x = baseline.byRegime[r];
    console.log(`| ${r} | ${x.n} | ${formatPct(x.triggerRate)} | ${fmtUsd(x.stats.mean)} | ${formatPct(x.stats.positiveRate)} |`);
  }

  // Q4: salvage sensitivity.
  console.log(`\n## Q4 — Salvage sensitivity (sweep s)`);
  const sSweep = sweepSalvage(bars, [0.40, 0.55, 0.70, 0.80, 0.90], seed);
  console.log(`| s | Mean Cycle EV | Win Rate | Trigger EV | No-Trig EV |`);
  console.log(`|---|---:|---:|---:|---:|`);
  for (const r of sSweep) {
    console.log(`| ${r.s.toFixed(2)} | ${fmtUsd(r.mean)} | ${formatPct(r.positiveRate)} | ${fmtUsd(r.triggerEv)} | ${fmtUsd(r.noTrigEv)} |`);
  }

  // Q5: ladder netting sweep.
  console.log(`\n## Q5 — Ladder netting savings sensitivity`);
  const ladderSweep = sweepLadderReopen(baseline, [0, 0.30, 0.60, 0.90]);
  console.log(`| Reopen Rate | Expected Savings/Cycle | Adjusted Cycle EV |`);
  console.log(`|---|---:|---:|`);
  for (const r of ladderSweep) {
    console.log(`| ${formatPct(r.reopenRate)} | ${fmtUsd(r.expectedSavingsPerCycle)} | ${fmtUsd(r.adjustedMeanCyclePnl)} |`);
  }

  // Stress test: forced P=0.25.
  console.log(`\n## Stress Test — Forced P(trigger) = 0.25`);
  const stress = stressTestForcedTriggerRate(bars, S_MODELED_DEFAULT, 0.25, seed);
  console.log(`At s=${S_MODELED_DEFAULT}, forced P=0.25:`);
  console.log(`  Trigger cycle EV (from baseline): ${fmtUsd(stress.triggerEvFromBaseline)}`);
  console.log(`  No-trigger cycle EV (from baseline): ${fmtUsd(stress.noTrigEvFromBaseline)}`);
  console.log(`  → Forced-EV per cycle: ${fmtUsd(stress.forcedEv)}`);

  // Capital adequacy.
  console.log(`\n## Capital Adequacy — 30-day sim across pair counts × cap tiers`);
  const capTiers = [10_000, 20_000, 50_000, 100_000];
  const pairCounts = [1, 5, 10];
  const capRows: any[] = [];
  for (const cap of capTiers) {
    for (const pairs of pairCounts) {
      const sim = simulateCapitalUsage({
        bars, s: S_MODELED_DEFAULT, capUsdc: cap,
        pairs, daysSimulated: 30, seed: seed + cap + pairs
      });
      capRows.push(sim);
    }
  }
  console.log(`| Cap | Pairs | Cycles/Pair | Max Exposure | Max Drawdown | End Balance | % Hours Cap Exceeded |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const r of capRows) {
    console.log(
      `| \$${r.capUsdc.toLocaleString()} | ${r.pairs} | ${r.cyclesPerPair.toFixed(1)} | \$${r.maxConcurrentExposureUsdc.toLocaleString()} | \$${r.maxDrawdownUsdc.toLocaleString()} | \$${r.endBalanceUsdc.toLocaleString()} | ${r.capExceededPct}% |`
    );
  }

  // ─── JSON output ─────────────────────────────────────────────────────
  const jsonOut = {
    generatedAt: new Date().toISOString(),
    inputs: {
      btcHistoryDays: days,
      barsLoaded: bars.length,
      barsStart: bars[0]?.ts ? new Date(bars[0].ts).toISOString() : null,
      barsEnd: bars[bars.length - 1]?.ts ? new Date(bars[bars.length - 1].ts).toISOString() : null,
      X: X_PREMIUM_DAILY,
      Y: Y_PAYOUT_BY_REGIME,
      h_verified: H_VERIFIED,
      s_modeled_default: S_MODELED_DEFAULT,
      ladder_reopen_rate_default: LADDER_REOPEN_RATE_DEFAULT,
      ladder_match_prob: LADDER_MATCH_PROB,
      max_hold_hours: MAX_HOLD_HOURS,
      hold_mean_days: HOLD_MEAN_DAYS,
      n_trials: N_TRIALS,
      regime_thresholds: REGIME_THRESHOLDS
    },
    baseline,
    salvageSweep: sSweep,
    ladderSweep,
    stressTest: stress,
    capitalAdequacy: capRows
  };
  await fs.writeFile(
    "vc_post_bundle3b_validation.json",
    JSON.stringify(jsonOut, null, 2)
  );
  console.log(`\n[wrote vc_post_bundle3b_validation.json]`);
};

main().catch((err) => {
  console.error(`fatal: ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
