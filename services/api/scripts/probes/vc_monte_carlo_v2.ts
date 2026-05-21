#!/usr/bin/env tsx
/**
 * Volume Cover — Monte Carlo v2 (refined).
 *
 * Improvements over v1 (vc_corrected_monte_carlo.ts):
 *   1. HOURLY OHLC instead of daily → tighter trigger detection,
 *      especially important for sub-day holds (2% cell holds ~13h).
 *   2. REGIME BUCKETING — each starting hour classified by realized
 *      vol over preceding 7d. Trials grouped: calm/normal/elevated/stress.
 *      Stress = system PAUSES new activations (no MC contribution to EV;
 *      just counted as "% blocked"). Matches volumeCoverGuardrails.ts §12.2.
 *   3. UNCOVERED-AFTER-EXPIRY TAIL — if hedge tenor < hold time and a
 *      trigger fires after tenor expiry, the hedge has expired (intrinsic
 *      only or worthless) and we owe the full payout with no recovery.
 *      v1 was incorrectly treating post-expiry triggers as recoverable.
 *   4. PER-CELL PROPOSED REGIME PREMIUMS to test if regime overlay can
 *      offset the calm-tier bleed.
 *
 * Output: per-cell × per-tenor × per-regime EV distribution.
 *
 * Run:
 *   npx tsx services/api/scripts/probes/vc_monte_carlo_v2.ts
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

type Cell = {
  cellId: string;
  notional: number;
  triggerPct: number;
  hedgePct: number;
  payout: number;
  // Per-regime premium override (calm = matrix base; others = proposed overlay)
  premiumByRegime: { calm: number; normal: number; elevated: number; stress: number };
};

const CELLS: Cell[] = [
  {
    cellId: "50k_2pct_1k",
    notional: 50_000,
    triggerPct: 0.02,
    hedgePct: 0.01,
    payout: 1_000,
    premiumByRegime: { calm: 350, normal: 450, elevated: 600, stress: 750 }
  },
  {
    cellId: "50k_5pct_2_5k",
    notional: 50_000,
    triggerPct: 0.05,
    hedgePct: 0.03,
    payout: 2_500,
    premiumByRegime: { calm: 194, normal: 260, elevated: 350, stress: 450 }
  },
  {
    cellId: "50k_10pct_5k",
    notional: 50_000,
    triggerPct: 0.10,
    hedgePct: 0.05,
    payout: 5_000,
    premiumByRegime: { calm: 97, normal: 130, elevated: 175, stress: 230 }
  },
  {
    cellId: "200k_15pct_30k",
    notional: 200_000,
    triggerPct: 0.15,
    hedgePct: 0.07,
    payout: 30_000,
    premiumByRegime: { calm: 363, normal: 480, elevated: 640, stress: 850 }
  }
];

const TENORS_DAYS = [3, 5, 10, 17];
const N_TRIALS_PER_CELL = 8_000;
const REALIZED_VOL_WINDOW_HOURS = 7 * 24;
const SPREAD_HAIRCUT_PCT = 0.05;
const VOL_EXPANSION_AT_TRIGGER = 0.05; // +5 annualized vol points
const FOXIFY_HOLD_RATIO_OF_PAYOUT = 0.1875;
const HOLD_NOISE_SD = 0.3;

// Realized-vol thresholds → regime (calibrated to match DVOL thresholds:
// calm<40, normal 40-65, elevated 65-80, stress≥80, all in DVOL units).
// Realized vol is in annualized fraction (0.35 = 35%).
const REGIME_THRESHOLDS = {
  calm: 0.40,
  normal: 0.55,
  elevated: 0.70
  // anything >= 0.70 = stress = PAUSE
};

type Regime = "calm" | "normal" | "elevated" | "stress";

// ─────────────────────────────────────────────────────────────────────
// Black-Scholes
// ─────────────────────────────────────────────────────────────────────

const erf = (x: number): number => {
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
// Hourly OHLC + realized vol
// ─────────────────────────────────────────────────────────────────────

type Bar = { ts: number; o: number; h: number; l: number; c: number };

const loadBtcHourly = async (days = 180): Promise<Bar[]> => {
  const end = Date.now();
  const start = end - days * 86_400_000;
  const url = `${DERIBIT}/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${end}&resolution=60`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
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

// Realized vol from preceding N hourly bars (close-to-close)
const realizedVol = (bars: Bar[], endIdx: number, windowHours: number): number => {
  const start = Math.max(0, endIdx - windowHours);
  if (endIdx <= start + 1) return 0.5; // default
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
  if (rv < REGIME_THRESHOLDS.normal) return "normal";
  if (rv < REGIME_THRESHOLDS.elevated) return "elevated";
  return "stress";
};

// ─────────────────────────────────────────────────────────────────────
// Trigger detection — intra-hour resolution
// ─────────────────────────────────────────────────────────────────────

type TriggerResult = {
  triggered: boolean;
  triggerHourOffset: number; // index of hourly bar where trigger fired, -1 if no trigger
  triggerSpot: number;
  direction: "up" | "down" | "none";
};

const detectTriggerHourly = (
  bars: Bar[],
  startIdx: number,
  windowHours: number,
  entrySpot: number,
  triggerPct: number
): TriggerResult => {
  const triggerUp = entrySpot * (1 + triggerPct);
  const triggerDown = entrySpot * (1 - triggerPct);
  const maxOffset = Math.max(1, Math.ceil(windowHours));
  for (let offset = 0; offset < maxOffset; offset++) {
    const idx = startIdx + offset;
    if (idx >= bars.length) break;
    const bar = bars[idx];
    if (bar.h >= triggerUp) {
      return { triggered: true, triggerHourOffset: offset, triggerSpot: triggerUp, direction: "up" };
    }
    if (bar.l <= triggerDown) {
      return { triggered: true, triggerHourOffset: offset, triggerSpot: triggerDown, direction: "down" };
    }
  }
  return { triggered: false, triggerHourOffset: -1, triggerSpot: 0, direction: "none" };
};

// ─────────────────────────────────────────────────────────────────────
// Sizing + pricing
// ─────────────────────────────────────────────────────────────────────

const computeContracts = (cell: Cell, spot: number): number => {
  const intrinsicPerBtc = spot * (cell.triggerPct - cell.hedgePct);
  const baseRequired = cell.payout / intrinsicPerBtc;
  return Math.ceil(baseRequired * 10) / 10;
};

const stranglePrice = (params: {
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

// Hold in hours (scaled from days)
const sampleHoldHours = (cell: Cell, regime: Regime): number => {
  const meanDays = (FOXIFY_HOLD_RATIO_OF_PAYOUT * cell.payout) / cell.premiumByRegime[regime];
  const meanHours = meanDays * 24;
  const noisy = meanHours * (1 + HOLD_NOISE_SD * sampleNormal());
  return Math.max(1, Math.min(14 * 24, noisy)); // bounded 1h to 14d
};

// ─────────────────────────────────────────────────────────────────────
// Single trial
// ─────────────────────────────────────────────────────────────────────

type TrialResult = {
  regime: Regime;
  pnl: number;
  triggered: boolean;
  triggerInTenor: boolean; // triggered DURING hedge tenor (covered) vs after (uncovered)
  holdHours: number;
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
): TrialResult | null => {
  // Pick starting bar (leave room for hold + lookback)
  const minStart = REALIZED_VOL_WINDOW_HOURS;
  const maxStart = bars.length - 14 * 24; // leave 14d at end
  if (maxStart <= minStart) throw new Error("not enough OHLC");
  const startIdx = minStart + Math.floor(rng() * (maxStart - minStart));
  const entryBar = bars[startIdx];
  const entrySpot = entryBar.o;

  const sigma = realizedVol(bars, startIdx, REALIZED_VOL_WINDOW_HOURS);
  const regime = classifyRegime(sigma);

  // STRESS regime: system PAUSES new positions. Trial returns null.
  if (regime === "stress") return null;

  const contracts = computeContracts(cell, entrySpot);
  const putK = entrySpot * (1 - cell.hedgePct);
  const callK = entrySpot * (1 + cell.hedgePct);
  const dailyPremium = cell.premiumByRegime[regime];

  const buy = stranglePrice({ spot: entrySpot, putK, callK, tenorDays, sigma, contractsBtc: contracts });

  const holdHours = sampleHoldHours(cell, regime);
  const tenorHours = tenorDays * 24;

  // Trigger detection over FULL hold window
  const trigFull = detectTriggerHourly(bars, startIdx, holdHours, entrySpot, cell.triggerPct);

  // Trigger detection within tenor window only (covered)
  const trigCovered = detectTriggerHourly(
    bars,
    startIdx,
    Math.min(holdHours, tenorHours),
    entrySpot,
    cell.triggerPct
  );

  let sale: number;
  let payout: number;
  let revenue: number;
  let triggered = false;
  let triggerInTenor = false;

  if (trigCovered.triggered) {
    // Triggered DURING tenor — hedge is alive, full salvage available
    triggered = true;
    triggerInTenor = true;
    const trigHours = trigCovered.triggerHourOffset + 0.5;
    const remTenorDays = Math.max(0.05, tenorDays - trigHours / 24);
    const sigmaPost = sigma + VOL_EXPANSION_AT_TRIGGER;
    const ulSale = stranglePrice({
      spot: trigCovered.triggerSpot,
      putK,
      callK,
      tenorDays: remTenorDays,
      sigma: sigmaPost,
      contractsBtc: contracts
    });
    sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    payout = cell.payout;
    revenue = dailyPremium * (trigHours / 24);
  } else if (trigFull.triggered) {
    // Trigger fired AFTER hedge expired — UNCOVERED. Hedge worthless,
    // full payout owed, no salvage. Revenue accrued through trigger event.
    triggered = true;
    triggerInTenor = false;
    sale = 0;
    payout = cell.payout;
    revenue = dailyPremium * ((trigFull.triggerHourOffset + 0.5) / 24);
  } else {
    // No trigger. Sell hedge at close OR let it expire if hold > tenor.
    if (holdHours <= tenorHours) {
      // Hedge still alive — sell at close
      const closeBarIdx = Math.min(bars.length - 1, startIdx + Math.ceil(holdHours));
      const closeSpot = bars[closeBarIdx].c;
      const remTenorDays = Math.max(0.05, tenorDays - holdHours / 24);
      const ulSale = stranglePrice({
        spot: closeSpot,
        putK,
        callK,
        tenorDays: remTenorDays,
        sigma,
        contractsBtc: contracts
      });
      sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    } else {
      // Hedge expired before close. Sale = 0 (intrinsic-only, OTM at expiry = 0).
      // Position then ran uncovered for (hold - tenor) more time. No trigger.
      sale = 0;
    }
    payout = 0;
    revenue = dailyPremium * (holdHours / 24);
  }

  const pnl = revenue - buy + sale - payout;

  return {
    regime,
    pnl,
    triggered,
    triggerInTenor,
    holdHours,
    buy,
    sale,
    payout,
    revenue,
    sigma
  };
};

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
};

type RegimeSummary = {
  regime: Regime;
  n: number;
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  triggerRate: number;
  uncoveredRate: number;
  positivePct: number;
  meanBuy: number;
  meanHoldHrs: number;
};

const summarizeByRegime = (trials: TrialResult[]): {
  byRegime: Record<Regime, RegimeSummary>;
  overall: RegimeSummary;
  blockedPct: number; // % stress that were blocked from opening
} => {
  const byRegime: Record<Regime, TrialResult[]> = {
    calm: [],
    normal: [],
    elevated: [],
    stress: []
  };
  for (const t of trials) byRegime[t.regime].push(t);

  const make = (rs: Regime, ts: TrialResult[]): RegimeSummary => {
    if (ts.length === 0) {
      return {
        regime: rs,
        n: 0,
        mean: 0,
        p5: 0,
        p50: 0,
        p95: 0,
        triggerRate: 0,
        uncoveredRate: 0,
        positivePct: 0,
        meanBuy: 0,
        meanHoldHrs: 0
      };
    }
    const pnls = ts.map((t) => t.pnl).sort((a, b) => a - b);
    return {
      regime: rs,
      n: ts.length,
      mean: ts.reduce((a, b) => a + b.pnl, 0) / ts.length,
      p5: percentile(pnls, 0.05),
      p50: percentile(pnls, 0.5),
      p95: percentile(pnls, 0.95),
      triggerRate: ts.filter((t) => t.triggered).length / ts.length,
      uncoveredRate:
        ts.filter((t) => t.triggered && !t.triggerInTenor).length / ts.length,
      positivePct: ts.filter((t) => t.pnl > 0).length / ts.length,
      meanBuy: ts.reduce((a, b) => a + b.buy, 0) / ts.length,
      meanHoldHrs: ts.reduce((a, b) => a + b.holdHours, 0) / ts.length
    };
  };

  const overallTrials = [...byRegime.calm, ...byRegime.normal, ...byRegime.elevated];
  const overall = make("calm", overallTrials); // label irrelevant
  return {
    byRegime: {
      calm: make("calm", byRegime.calm),
      normal: make("normal", byRegime.normal),
      elevated: make("elevated", byRegime.elevated),
      stress: make("stress", byRegime.stress)
    },
    overall,
    blockedPct: 0 // computed at run time (trial returns null)
  };
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("Loading hourly BTC OHLC from Deribit BTC-PERPETUAL ...");
  const bars = await loadBtcHourly(180);
  console.log(
    `Loaded ${bars.length} hourly bars from ${new Date(bars[0].ts).toISOString().slice(0, 16)} to ${new Date(
      bars[bars.length - 1].ts
    ).toISOString().slice(0, 16)}\n`
  );

  const rng = (): number => Math.random();

  console.log(
    "cell\ttenor\tregime\tn\tmean\tp5\tp50\tp95\ttrig%\tuncov%\tpos%\tbuy\thold_hrs"
  );

  for (const cell of CELLS) {
    for (const tenor of TENORS_DAYS) {
      const trials: TrialResult[] = [];
      let blocked = 0;
      while (trials.length < N_TRIALS_PER_CELL) {
        const tr = runTrial(cell, bars, tenor, rng);
        if (tr === null) {
          blocked++;
          continue;
        }
        trials.push(tr);
      }

      const summary = summarizeByRegime(trials);
      const totalAttempts = trials.length + blocked;
      const blockedPct = (blocked / totalAttempts) * 100;

      for (const rs of ["calm", "normal", "elevated"] as const) {
        const s = summary.byRegime[rs];
        if (s.n === 0) {
          console.log(`${cell.cellId}\t${tenor}\t${rs}\t0\t-\t-\t-\t-\t-\t-\t-\t-\t-`);
          continue;
        }
        console.log(
          [
            cell.cellId,
            tenor,
            rs,
            s.n,
            s.mean.toFixed(2),
            s.p5.toFixed(2),
            s.p50.toFixed(2),
            s.p95.toFixed(2),
            (s.triggerRate * 100).toFixed(1),
            (s.uncoveredRate * 100).toFixed(1),
            (s.positivePct * 100).toFixed(1),
            s.meanBuy.toFixed(0),
            s.meanHoldHrs.toFixed(1)
          ].join("\t")
        );
      }
      // Blended view (calm + normal + elevated together):
      console.log(
        [
          cell.cellId,
          tenor,
          "BLEND",
          summary.overall.n,
          summary.overall.mean.toFixed(2),
          summary.overall.p5.toFixed(2),
          summary.overall.p50.toFixed(2),
          summary.overall.p95.toFixed(2),
          (summary.overall.triggerRate * 100).toFixed(1),
          (summary.overall.uncoveredRate * 100).toFixed(1),
          (summary.overall.positivePct * 100).toFixed(1),
          summary.overall.meanBuy.toFixed(0),
          summary.overall.meanHoldHrs.toFixed(1)
        ].join("\t")
      );
      console.log(`  └── stress-paused (blocked): ${blockedPct.toFixed(1)}% of attempts\n`);
    }
  }
};

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
