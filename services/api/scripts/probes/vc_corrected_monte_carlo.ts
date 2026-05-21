#!/usr/bin/env tsx
/**
 * Volume Cover — corrected Monte Carlo using REAL Deribit prices,
 * REAL BTC OHLC history, and the OBSERVED Foxify hold pattern.
 *
 * Fixes the prior salvageBandStressTest.ts which:
 *   - Modeled hedge as "$/day rented" rather than upfront-bought
 *   - Used Bullish probe prices instead of Deribit's true cost
 *   - Treated salvage as %-of-payout rather than %-of-buy-cost
 *
 * Algorithm:
 *   1. Pull 450 days BTC OHLC from Deribit (BTC-PERPETUAL daily bars)
 *   2. For each Monte Carlo trial:
 *      a. Pick a random hold-start day from history
 *      b. Compute realized vol from preceding 7d window (annualized)
 *      c. Sample hold duration from Foxify pattern
 *         (Foxify closes at ~ 18.75% × payout / dailyPremium days, with noise)
 *      d. Compute hedge buy cost via Black-Scholes at the realized IV
 *         (sized at 1% OTM strikes inside trigger, contracts to cover payout)
 *      e. Scan intra-period highs/lows for trigger touch during hold
 *      f. Compute strangle sale price:
 *         - If trigger:    BS price post-spot-move with vol expansion bump
 *         - If no trigger: BS price at hold-close with theta decay
 *      g. Apply bid-ask spread haircut to sale
 *      h. Trial P&L = revenue − buy + sale − payout_if_triggered
 *   3. Aggregate 10,000 trials per cell × per tenor
 *
 * Output: per-cell × per-tenor distribution table.
 *
 * Run:
 *   npx tsx services/api/scripts/probes/vc_corrected_monte_carlo.ts
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

// ─────────────────────────────────────────────────────────────────────
// Cells + tenors under test
// ─────────────────────────────────────────────────────────────────────

type Cell = {
  cellId: string;
  notional: number;
  triggerPct: number;
  hedgePct: number;
  payout: number;
  dailyPremium: number;
};

const CELLS: Cell[] = [
  { cellId: "50k_2pct_1k", notional: 50_000, triggerPct: 0.02, hedgePct: 0.01, payout: 1_000, dailyPremium: 350 },
  { cellId: "50k_5pct_2_5k", notional: 50_000, triggerPct: 0.05, hedgePct: 0.03, payout: 2_500, dailyPremium: 194 },
  { cellId: "50k_10pct_5k", notional: 50_000, triggerPct: 0.10, hedgePct: 0.05, payout: 5_000, dailyPremium: 97 },
  { cellId: "200k_15pct_30k", notional: 200_000, triggerPct: 0.15, hedgePct: 0.07, payout: 30_000, dailyPremium: 363 }
];

// Tenor options (days). "snap" maps to actual Deribit grid.
const TENORS_DAYS = [3, 5, 10, 17];

const N_TRIALS = 10_000;
const REALIZED_VOL_WINDOW_DAYS = 7;
const SPREAD_HAIRCUT_PCT = 0.05;
const VOL_EXPANSION_AT_TRIGGER = 0.05; // +5 IV points at trigger event
const FOXIFY_HOLD_RATIO_OF_PAYOUT = 0.1875; // empirical: closes at ~18.75% of payout in cumulative premium
const HOLD_NOISE_SD = 0.3; // 30% std-dev noise on hold time

// ─────────────────────────────────────────────────────────────────────
// Black-Scholes (no rates, no dividends — close enough for BTC short-dated)
// ─────────────────────────────────────────────────────────────────────

const erf = (x: number): number => {
  // Abramowitz & Stegun approximation
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
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

// ─────────────────────────────────────────────────────────────────────
// OHLC data load
// ─────────────────────────────────────────────────────────────────────

type Bar = { ts: number; o: number; h: number; l: number; c: number };

const loadBtcOhlc = async (days = 450): Promise<Bar[]> => {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const url = `${DERIBIT}/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${end}&resolution=1D`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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

// Compute realized vol from preceding N days of close-to-close log returns.
const realizedVol = (bars: Bar[], endIdx: number, window: number): number => {
  const start = Math.max(0, endIdx - window);
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) {
    rets.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const dailyVol = Math.sqrt(variance);
  return dailyVol * Math.sqrt(365);
};

// ─────────────────────────────────────────────────────────────────────
// Trigger detection — was the cell's trigger touched during hold?
// Uses intra-day highs and lows so we catch all touch events, not just
// close-to-close moves.
// ─────────────────────────────────────────────────────────────────────

type TriggerResult = {
  triggered: boolean;
  triggerDayIdx: number; // index of bar where trigger fired (relative to start), -1 if no trigger
  triggerSpot: number; // spot at trigger event
  direction: "up" | "down" | "none";
};

const detectTrigger = (
  bars: Bar[],
  startIdx: number,
  holdDays: number,
  entrySpot: number,
  triggerPct: number
): TriggerResult => {
  const triggerUp = entrySpot * (1 + triggerPct);
  const triggerDown = entrySpot * (1 - triggerPct);
  // Hold period in whole days; we scan up to ceil(holdDays) bars
  const holdBars = Math.max(1, Math.ceil(holdDays));
  for (let offset = 0; offset < holdBars; offset++) {
    const idx = startIdx + offset;
    if (idx >= bars.length) break;
    const bar = bars[idx];
    if (bar.h >= triggerUp) {
      return { triggered: true, triggerDayIdx: offset, triggerSpot: triggerUp, direction: "up" };
    }
    if (bar.l <= triggerDown) {
      return { triggered: true, triggerDayIdx: offset, triggerSpot: triggerDown, direction: "down" };
    }
  }
  return { triggered: false, triggerDayIdx: -1, triggerSpot: 0, direction: "none" };
};

// ─────────────────────────────────────────────────────────────────────
// Strangle hedge sizing + pricing
// ─────────────────────────────────────────────────────────────────────

const computeContracts = (cell: Cell, spot: number): number => {
  // intrinsic_per_btc_at_trigger = spot × (triggerPct − hedgePct)
  const intrinsicPerBtc = spot * (cell.triggerPct - cell.hedgePct);
  if (intrinsicPerBtc <= 0) throw new Error("bad cell config");
  const baseRequired = cell.payout / intrinsicPerBtc;
  // round UP to 0.1 BTC granularity
  return Math.ceil(baseRequired * 10) / 10;
};

const computeStranglePrice = (params: {
  spot: number;
  putK: number;
  callK: number;
  tenorDays: number;
  sigma: number;
  contractsBtc: number;
}): number => {
  const T = params.tenorDays / 365;
  const putPerBtc = bsPut(params.spot, params.putK, T, params.sigma);
  const callPerBtc = bsCall(params.spot, params.callK, T, params.sigma);
  return (putPerBtc + callPerBtc) * params.contractsBtc;
};

// ─────────────────────────────────────────────────────────────────────
// Hold sampling
// ─────────────────────────────────────────────────────────────────────

const sampleNormal = (): number => {
  let u1 = Math.random();
  const u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const sampleHoldDays = (cell: Cell): number => {
  // Mean hold from Foxify 18.75% rule
  const meanDays = (FOXIFY_HOLD_RATIO_OF_PAYOUT * cell.payout) / cell.dailyPremium;
  // Lognormal-ish noise
  const noisy = meanDays * (1 + HOLD_NOISE_SD * sampleNormal());
  return Math.max(0.05, Math.min(14, noisy)); // bounded between 1h and 14d
};

// ─────────────────────────────────────────────────────────────────────
// Single trial
// ─────────────────────────────────────────────────────────────────────

type TrialResult = {
  pnl: number;
  triggered: boolean;
  triggerDay: number;
  holdDays: number;
  buy: number;
  sale: number;
  payout: number;
  revenue: number;
  sigma: number;
};

const runTrial = (
  cell: Cell,
  bars: Bar[],
  tenorDays: number,
  rng: () => number
): TrialResult => {
  // Pick random starting bar (leave room for hold + lookback window)
  const minStart = REALIZED_VOL_WINDOW_DAYS;
  const maxStart = bars.length - 15; // leave 15 days at end for hold
  const startIdx = minStart + Math.floor(rng() * (maxStart - minStart));
  const entryBar = bars[startIdx];
  const entrySpot = entryBar.o; // use OPEN as activation price

  const sigma = realizedVol(bars, startIdx, REALIZED_VOL_WINDOW_DAYS);

  const contracts = computeContracts(cell, entrySpot);
  const putK = entrySpot * (1 - cell.hedgePct);
  const callK = entrySpot * (1 + cell.hedgePct);

  // Buy at entry: full strangle premium (BS, no spread haircut on buy since
  // we assume mid execution as benchmark)
  const buy = computeStranglePrice({
    spot: entrySpot,
    putK,
    callK,
    tenorDays,
    sigma,
    contractsBtc: contracts
  });

  // Sample hold duration
  const holdDays = sampleHoldDays(cell);

  // Trigger detection across the hold window
  const trig = detectTrigger(bars, startIdx, holdDays, entrySpot, cell.triggerPct);

  // Revenue = $premium/day × days actually held (capped at trigger day if trigger)
  const effectiveHold = trig.triggered ? Math.max(0.05, trig.triggerDayIdx + 0.5) : holdDays;
  const revenue = cell.dailyPremium * effectiveHold;

  // Compute sale price
  let sale: number;
  let payout: number;
  if (trig.triggered) {
    // Sale at trigger event: BS at new spot, with vol expansion bump
    const remTenor = Math.max(0.05, tenorDays - effectiveHold);
    const sigmaPost = sigma * (1 + VOL_EXPANSION_AT_TRIGGER / sigma); // +5pp absolute
    const ulSale = computeStranglePrice({
      spot: trig.triggerSpot,
      putK,
      callK,
      tenorDays: remTenor,
      sigma: sigma + VOL_EXPANSION_AT_TRIGGER,
      contractsBtc: contracts
    });
    sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    payout = cell.payout;
  } else {
    // No-trigger close: BS at hold-end spot (use the actual close price)
    const closeIdx = Math.min(bars.length - 1, startIdx + Math.ceil(holdDays));
    const closeSpot = bars[closeIdx].c;
    const remTenor = Math.max(0.05, tenorDays - holdDays);
    if (remTenor <= 0.05) {
      // Expired during hold — keep only intrinsic
      sale = computeStranglePrice({
        spot: closeSpot,
        putK,
        callK,
        tenorDays: 0,
        sigma,
        contractsBtc: contracts
      });
    } else {
      const ulSale = computeStranglePrice({
        spot: closeSpot,
        putK,
        callK,
        tenorDays: remTenor,
        sigma,
        contractsBtc: contracts
      });
      sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    }
    payout = 0;
  }

  const pnl = revenue - buy + sale - payout;

  return {
    pnl,
    triggered: trig.triggered,
    triggerDay: trig.triggerDayIdx,
    holdDays,
    buy,
    sale,
    payout,
    revenue,
    sigma
  };
};

// ─────────────────────────────────────────────────────────────────────
// Stats helpers
// ─────────────────────────────────────────────────────────────────────

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
};

const summarize = (trials: TrialResult[]): {
  n: number;
  triggerRate: number;
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  positivePct: number;
  meanBuy: number;
  meanSaleNoTrig: number;
  meanSaleTrig: number;
  meanHold: number;
} => {
  const pnls = trials.map((t) => t.pnl).sort((a, b) => a - b);
  const triggered = trials.filter((t) => t.triggered);
  const notTriggered = trials.filter((t) => !t.triggered);
  return {
    n: trials.length,
    triggerRate: triggered.length / trials.length,
    mean: trials.reduce((a, b) => a + b.pnl, 0) / trials.length,
    p5: percentile(pnls, 0.05),
    p50: percentile(pnls, 0.5),
    p95: percentile(pnls, 0.95),
    positivePct: trials.filter((t) => t.pnl > 0).length / trials.length,
    meanBuy: trials.reduce((a, b) => a + b.buy, 0) / trials.length,
    meanSaleNoTrig: notTriggered.length
      ? notTriggered.reduce((a, b) => a + b.sale, 0) / notTriggered.length
      : 0,
    meanSaleTrig: triggered.length
      ? triggered.reduce((a, b) => a + b.sale, 0) / triggered.length
      : 0,
    meanHold: trials.reduce((a, b) => a + b.holdDays, 0) / trials.length
  };
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("Loading BTC OHLC from Deribit BTC-PERPETUAL ...");
  const bars = await loadBtcOhlc(450);
  console.log(
    `Loaded ${bars.length} daily bars from ${new Date(bars[0].ts).toISOString().slice(0, 10)} to ${new Date(
      bars[bars.length - 1].ts
    ).toISOString().slice(0, 10)}\n`
  );

  // Seed-able RNG would be nice but Math.random is fine for headline numbers
  const rng = (): number => Math.random();

  console.log(
    [
      "cell",
      "tenor_d",
      "mean_pnl",
      "p5",
      "p50",
      "p95",
      "trig_rate",
      "positive_%",
      "mean_buy",
      "mean_sale_no_trig",
      "mean_sale_trig",
      "mean_hold_d"
    ].join("\t")
  );

  for (const cell of CELLS) {
    for (const tenor of TENORS_DAYS) {
      const trials: TrialResult[] = [];
      for (let i = 0; i < N_TRIALS; i++) {
        trials.push(runTrial(cell, bars, tenor, rng));
      }
      const s = summarize(trials);
      console.log(
        [
          cell.cellId,
          tenor,
          s.mean.toFixed(2),
          s.p5.toFixed(2),
          s.p50.toFixed(2),
          s.p95.toFixed(2),
          (s.triggerRate * 100).toFixed(2),
          (s.positivePct * 100).toFixed(2),
          s.meanBuy.toFixed(0),
          s.meanSaleNoTrig.toFixed(0),
          s.meanSaleTrig.toFixed(0),
          s.meanHold.toFixed(2)
        ].join("\t")
      );
    }
  }

  console.log(`\nN=${N_TRIALS} trials per cell × tenor. Done.`);
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
