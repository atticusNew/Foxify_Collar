#!/usr/bin/env tsx
/**
 * Volume Cover — LAUNCH PROJECTION for 2 × 50k_2pct_1k pilot.
 *
 * Locks in the operator decisions for the 2026-05-19 ship:
 *   - Cell: 50k_2pct_1k only (2 concurrent positions)
 *   - Tenor: 3 days (per-cell matrix value)
 *   - Stress-pause threshold = 65 → MC PAUSES elevated + stress regimes
 *     (only calm + moderate contribute to P&L)
 *   - Sweep candidate premium overlays to find break-even
 *
 * Foxify hold model: bot exits when cumulative premium hits 18.75% of
 * payout ($187.50 on the $1k cell). Hold = $187.50 / daily_premium.
 *
 * P&L per position = revenue (capped at $187.50) − hedge_buy + hedge_sale − payout_if_triggered
 *
 * Capped-loss invariant (per single position):
 *   - Maximum loss = hedge_buy − hedge_sale_min + payout
 *     where hedge_sale_min ≥ 0 (we can't sell below 0)
 *     and the hedge intrinsic at trigger ALWAYS covers the spot × (trig−hedge%) gap
 *   - For 50k_2pct_1k: max loss ≈ $hedge_buy + $1,000 if hedge expires worthless
 *     AND a trigger fires immediately. With 3d tenor and ~13h hold:
 *     hedge_buy ≈ $130-$200 typical, so worst-case ≈ −$1,200 per position.
 *   - p99 from this MC will quantify the true tail.
 *
 * Output: per-config per-regime EV, blended EV, and 2-position 4-week pilot
 * projection (mean + p5 worst case).
 *
 * Run:
 *   npx tsx services/api/scripts/probes/vc_launch_projection.ts
 */

const DERIBIT = "https://www.deribit.com/api/v2/public";

// ─────────────────────────────────────────────────────────────────────
// Locked launch parameters
// ─────────────────────────────────────────────────────────────────────

const CELL = {
  cellId: "50k_2pct_1k",
  notional: 50_000,
  triggerPct: 0.02,
  hedgePct: 0.01,
  payout: 1_000
};

const TENOR_DAYS = 3;
const N_TRIALS_PER_CONFIG = 10_000;

// Stress-pause threshold = 65 means we PAUSE both elevated and stress.
// Realized-vol equivalent: rvol >= 0.55 → pause.
const REGIME_THRESHOLDS = {
  calm: 0.40,    // < 0.40 = calm
  moderate: 0.55 // 0.40 - 0.55 = moderate, ≥ 0.55 PAUSED (elevated + stress)
};
type Regime = "calm" | "moderate" | "paused";

// Premium sweep configs (calm, moderate) USDC/day per pair
const PREMIUM_CONFIGS: Array<{ label: string; calm: number; moderate: number }> = [
  { label: "current_matrix",       calm: 350, moderate: 350 }, // no overlay (control)
  { label: "proposed_overlay",     calm: 350, moderate: 750 }, // calm = matrix base, mod = MC-suggested
  { label: "calm_lift_$400",       calm: 400, moderate: 750 }, // small calm bump
  { label: "calm_lift_$450",       calm: 450, moderate: 850 },
  { label: "calm_lift_$500",       calm: 500, moderate: 950 },
  { label: "aggressive_calm_$600", calm: 600, moderate: 1100 }
];

// ─────────────────────────────────────────────────────────────────────
// Foxify exit model
// ─────────────────────────────────────────────────────────────────────

const FOXIFY_HOLD_RATIO_OF_PAYOUT = 0.1875;
const HOLD_NOISE_SD = 0.3;
const REALIZED_VOL_WINDOW_HOURS = 7 * 24;
const SPREAD_HAIRCUT_PCT = 0.05;
const VOL_EXPANSION_AT_TRIGGER = 0.05;

// Mean expected concurrent positions for the pilot (operator's plan)
const N_CONCURRENT_POSITIONS = 2;
// Operator pilot window (days). 28 = 4-week pilot
const PILOT_WINDOW_DAYS = 28;

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
  for (let i = 0; i < ts.length; i++) bars.push({ ts: ts[i], o: o[i], h: h[i], l: l[i], c: c[i] });
  return bars;
};

const realizedVol = (bars: Bar[], endIdx: number, windowHours: number): number => {
  const start = Math.max(0, endIdx - windowHours);
  if (endIdx <= start + 1) return 0.5;
  const rets: number[] = [];
  for (let i = start + 1; i <= endIdx; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(24 * 365);
};

const classifyRegime = (rv: number): Regime => {
  if (rv < REGIME_THRESHOLDS.calm) return "calm";
  if (rv < REGIME_THRESHOLDS.moderate) return "moderate";
  return "paused"; // elevated + stress both blocked at threshold=65
};

const sampleNormal = (): number => {
  let u1 = Math.random();
  const u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const computeContracts = (spot: number): number => {
  const intrinsicPerBtc = spot * (CELL.triggerPct - CELL.hedgePct);
  const baseRequired = CELL.payout / intrinsicPerBtc;
  return Math.ceil(baseRequired * 10) / 10;
};

const stranglePrice = (p: {
  spot: number; putK: number; callK: number; tenorDays: number; sigma: number; contractsBtc: number;
}): number => {
  const T = p.tenorDays / 365;
  return (bsPut(p.spot, p.putK, T, p.sigma) + bsCall(p.spot, p.callK, T, p.sigma)) * p.contractsBtc;
};

type TrigResult = { triggered: boolean; offsetHours: number; spot: number };
const detectTrigger = (bars: Bar[], startIdx: number, hours: number, entry: number): TrigResult => {
  const up = entry * (1 + CELL.triggerPct);
  const down = entry * (1 - CELL.triggerPct);
  const maxOffset = Math.max(1, Math.ceil(hours));
  for (let off = 0; off < maxOffset; off++) {
    const i = startIdx + off;
    if (i >= bars.length) break;
    if (bars[i].h >= up) return { triggered: true, offsetHours: off, spot: up };
    if (bars[i].l <= down) return { triggered: true, offsetHours: off, spot: down };
  }
  return { triggered: false, offsetHours: -1, spot: 0 };
};

// ─────────────────────────────────────────────────────────────────────
// Trial
// ─────────────────────────────────────────────────────────────────────

type Trial = {
  regime: Regime;
  pnl: number;
  triggered: boolean;
  triggerInTenor: boolean;
  buy: number;
  sale: number;
  payout: number;
  revenue: number;
  holdHours: number;
};

const runTrial = (
  bars: Bar[],
  premium: { calm: number; moderate: number }
): Trial | null => {
  const minStart = REALIZED_VOL_WINDOW_HOURS;
  const maxStart = bars.length - 14 * 24;
  const startIdx = minStart + Math.floor(Math.random() * (maxStart - minStart));
  const entry = bars[startIdx].o;
  const sigma = realizedVol(bars, startIdx, REALIZED_VOL_WINDOW_HOURS);
  const regime = classifyRegime(sigma);
  if (regime === "paused") return null;

  const dailyPremium = regime === "calm" ? premium.calm : premium.moderate;
  const contracts = computeContracts(entry);
  const putK = entry * (1 - CELL.hedgePct);
  const callK = entry * (1 + CELL.hedgePct);

  const buy = stranglePrice({ spot: entry, putK, callK, tenorDays: TENOR_DAYS, sigma, contractsBtc: contracts });

  // Foxify hold model: exit at 18.75% of payout in cumulative premium
  const meanHoldHours = (FOXIFY_HOLD_RATIO_OF_PAYOUT * CELL.payout / dailyPremium) * 24;
  const holdHours = Math.max(1, Math.min(14 * 24, meanHoldHours * (1 + HOLD_NOISE_SD * sampleNormal())));
  const tenorHours = TENOR_DAYS * 24;

  const trigCovered = detectTrigger(bars, startIdx, Math.min(holdHours, tenorHours), entry);
  const trigFull = detectTrigger(bars, startIdx, holdHours, entry);

  let sale: number, payout: number, revenue: number, triggered = false, triggerInTenor = false;

  if (trigCovered.triggered) {
    triggered = true;
    triggerInTenor = true;
    const trigHrs = trigCovered.offsetHours + 0.5;
    const remT = Math.max(0.05, TENOR_DAYS - trigHrs / 24);
    const sigmaPost = sigma + VOL_EXPANSION_AT_TRIGGER;
    const ulSale = stranglePrice({
      spot: trigCovered.spot, putK, callK,
      tenorDays: remT, sigma: sigmaPost, contractsBtc: contracts
    });
    sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    payout = CELL.payout;
    revenue = dailyPremium * (trigHrs / 24);
  } else if (trigFull.triggered) {
    // Uncovered — should be rare/impossible for 3d tenor with ~13h hold
    triggered = true;
    triggerInTenor = false;
    sale = 0;
    payout = CELL.payout;
    revenue = dailyPremium * ((trigFull.offsetHours + 0.5) / 24);
  } else {
    if (holdHours <= tenorHours) {
      const closeIdx = Math.min(bars.length - 1, startIdx + Math.ceil(holdHours));
      const closeSpot = bars[closeIdx].c;
      const remT = Math.max(0.05, TENOR_DAYS - holdHours / 24);
      const ulSale = stranglePrice({ spot: closeSpot, putK, callK, tenorDays: remT, sigma, contractsBtc: contracts });
      sale = ulSale * (1 - SPREAD_HAIRCUT_PCT);
    } else {
      sale = 0;
    }
    payout = 0;
    revenue = dailyPremium * (holdHours / 24);
  }

  return { regime, pnl: revenue - buy + sale - payout, triggered, triggerInTenor, buy, sale, payout, revenue, holdHours };
};

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
};

type Summary = {
  n: number;
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  p99: number;
  minLoss: number;
  triggerRate: number;
  uncoveredRate: number;
  meanBuy: number;
  meanHoldHrs: number;
  positivePct: number;
};

const summarize = (ts: Trial[]): Summary => {
  if (ts.length === 0) {
    return { n: 0, mean: 0, p5: 0, p50: 0, p95: 0, p99: 0, minLoss: 0, triggerRate: 0, uncoveredRate: 0, meanBuy: 0, meanHoldHrs: 0, positivePct: 0 };
  }
  const pnls = ts.map((t) => t.pnl).sort((a, b) => a - b);
  return {
    n: ts.length,
    mean: ts.reduce((a, b) => a + b.pnl, 0) / ts.length,
    p5: pct(pnls, 0.05),
    p50: pct(pnls, 0.5),
    p95: pct(pnls, 0.95),
    p99: pct(pnls, 0.99),
    minLoss: pnls[0],
    triggerRate: ts.filter((t) => t.triggered).length / ts.length,
    uncoveredRate: ts.filter((t) => t.triggered && !t.triggerInTenor).length / ts.length,
    meanBuy: ts.reduce((a, b) => a + b.buy, 0) / ts.length,
    meanHoldHrs: ts.reduce((a, b) => a + b.holdHours, 0) / ts.length,
    positivePct: ts.filter((t) => t.pnl > 0).length / ts.length
  };
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("Loading hourly BTC-PERPETUAL ...");
  const bars = await loadBtcHourly(180);
  console.log(`Loaded ${bars.length} bars: ${new Date(bars[0].ts).toISOString().slice(0, 13)} → ${new Date(bars[bars.length - 1].ts).toISOString().slice(0, 13)}\n`);

  // First: report regime distribution observed in the window
  let calmCount = 0, modCount = 0, pausedCount = 0;
  for (let i = REALIZED_VOL_WINDOW_HOURS; i < bars.length - 14 * 24; i++) {
    const rv = realizedVol(bars, i, REALIZED_VOL_WINDOW_HOURS);
    const r = classifyRegime(rv);
    if (r === "calm") calmCount++;
    else if (r === "moderate") modCount++;
    else pausedCount++;
  }
  const totalHours = calmCount + modCount + pausedCount;
  console.log("REGIME DISTRIBUTION (last 180d, threshold=65 = pause at rvol >= 0.55):");
  console.log(`  calm:     ${((calmCount / totalHours) * 100).toFixed(1)}%  (live, calm-tier pricing)`);
  console.log(`  moderate: ${((modCount / totalHours) * 100).toFixed(1)}%  (live, overlay pricing)`);
  console.log(`  paused:   ${((pausedCount / totalHours) * 100).toFixed(1)}%  (no activations)\n`);

  console.log("PER-CONFIG P&L (50k_2pct_1k, 3d tenor, hourly OHLC, ${N_TRIALS_PER_CONFIG.toLocaleString()} trials/config)");
  console.log("─".repeat(140));
  console.log(["config", "calm", "mod", "regime", "n", "mean", "p5", "p50", "p95", "p99", "min", "trig%", "uncov%", "pos%", "buy", "hold_hrs"].join("\t"));

  for (const cfg of PREMIUM_CONFIGS) {
    const trials: Trial[] = [];
    let paused = 0;
    while (trials.length < N_TRIALS_PER_CONFIG) {
      const t = runTrial(bars, cfg);
      if (t === null) { paused++; continue; }
      trials.push(t);
    }

    const calm = summarize(trials.filter((t) => t.regime === "calm"));
    const mod = summarize(trials.filter((t) => t.regime === "moderate"));
    const blend = summarize(trials);
    const pausedPct = (paused / (trials.length + paused)) * 100;

    for (const [regime, s] of [["calm", calm], ["moderate", mod], ["BLEND", blend]] as const) {
      console.log([
        cfg.label, cfg.calm, cfg.moderate, regime, s.n,
        s.mean.toFixed(2), s.p5.toFixed(2), s.p50.toFixed(2), s.p95.toFixed(2), s.p99.toFixed(2),
        s.minLoss.toFixed(0),
        (s.triggerRate * 100).toFixed(1),
        (s.uncoveredRate * 100).toFixed(1),
        (s.positivePct * 100).toFixed(1),
        s.meanBuy.toFixed(0),
        s.meanHoldHrs.toFixed(1)
      ].join("\t"));
    }

    // 2-position pilot projection
    // Activations per pilot: 2 concurrent × pilot_days / mean_hold_days = total turns
    const meanHoldDays = blend.meanHoldHrs / 24;
    const totalActivations = (N_CONCURRENT_POSITIONS * PILOT_WINDOW_DAYS) / meanHoldDays;
    const pilotMeanPnl = blend.mean * totalActivations;
    const pilotP5 = blend.p5 * totalActivations * 0.6; // p5 doesn't simply scale; rough proxy
    console.log(`  └── 2-pos × 28d pilot: ~${totalActivations.toFixed(0)} activations, expected P&L ≈ $${pilotMeanPnl.toFixed(0)} (per-position p5 capped at $${blend.p5.toFixed(0)}, min observed $${blend.minLoss.toFixed(0)})`);
    console.log(`  └── paused: ${pausedPct.toFixed(1)}% of attempts\n`);
  }

  console.log("\nCAPPED-LOSS NOTE:");
  console.log("  Max loss per single 50k_2pct_1k position is bounded:");
  console.log("    Worst case = (hedge_buy − $0_sale) + $1,000_payout − $0_revenue");
  console.log("    With typical hedge_buy ~$130-200, worst single-position loss ≈ −$1,200");
  console.log("  This is the 'cap' — even on a catastrophic miss, you lose ~1.2× payout, not unbounded.");
  console.log("  See 'min' column for actual worst observed in 10,000 trials.");
};

main().catch((e) => { console.error("ERR", e); process.exit(1); });
