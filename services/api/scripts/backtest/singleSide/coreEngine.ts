/**
 * Single-Side backtest engine — production-faithful for new pilot.
 *
 * Models the new singleSide product:
 *   - Single-leg hedge (put for long cover, call for short cover)
 *   - Cell-conditional tenor (3d for 5%, 6d for 7%)
 *   - Vol-buffered sizing
 *   - IV-aware dynamic pricing (current_iv / 33%)^0.7
 *   - Regime overlay multipliers (1.0/1.4/2.0/pause)
 *   - Atticus-retained TP simulation post-trigger and post-close
 *   - 12-rule TP curve approximated at daily granularity
 *   - Hold-time hypothesis: hold ∝ premium_accrued / payout
 *
 * Calibrated to LIVE Bullish prices from
 * docs/foxify-pilot-bundle-c/26_BIWEEKLY_BULLISH_LIVE_PRICING_REPORT.md
 *
 * Key calibration knobs:
 *   - Implied vol scaling: BS computes hedge cost; observed Bullish
 *     prices imply ~33% short-dated IV. Scenarios run at multiple
 *     IV regimes (33%, 50%, 65%, 80%) reflecting calm to stress.
 *   - Bullish bid-ask uplift: ~5-15% above mid for fills (lower for
 *     near-the-money, higher for far-OTM).
 *   - Selection-bias trigger rate: 1.5-2.5× statistical baseline
 *     reflecting Foxify's likely entry-timing.
 */

import * as fs from "node:fs/promises";
import { getRegimeIv as sharedGetRegimeIv } from "../lib/regimeIv";

const SQRT2 = Math.SQRT2;
const nCDF = (x: number): number => {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
};

export const bsPut = (S: number, K: number, T: number, r: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, K - S);
  if (sigma <= 0) return Math.max(0, K - S);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * Math.exp(-r * T) * nCDF(-d2) - S * nCDF(-d1);
};

export const bsCall = (S: number, K: number, T: number, r: number, sigma: number): number => {
  if (T <= 0) return Math.max(0, S - K);
  if (sigma <= 0) return Math.max(0, S - K);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * nCDF(d1) - K * Math.exp(-r * T) * nCDF(d2);
};

const RFR = 0.045;

// ──────────────────────── Types ────────────────────────

export type Candle = {
  timestamp: number;
  date: string;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
};

export type Regime = "calm" | "moderate" | "elevated" | "stress";
export type Direction = "long" | "short";

export type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  hedgeTenorDays: number;
  /** Calm-regime base premium */
  baseDailyPremiumUsdc: number;
};

export type Scenario = {
  name: string;
  cell: Cell;
  /** Override base price for sweep (null = use cell.baseDailyPremiumUsdc) */
  basePremiumOverride?: number;
  /** Selection-bias multiplier on statistical trigger rate (default 2.0×) */
  triggerRateMultiplier?: number;
  /** Hold-time model: "fixed" days OR "premium_ratio" using P/Po breakpoint */
  holdModel: { kind: "fixed"; days: number } | { kind: "premium_ratio"; targetRatio: number };
  /** Apply IV-aware pricing scaling (default true) */
  ivAwarePricing?: boolean;
  /** Apply regime overlay multiplier (default {calm:1.0, mod:1.4, elev:2.0, stress:pause}) */
  regimeOverlay?: Record<Regime, number | "pause">;
  /** Apply 12-rule TP simulation for retained leg (default true) */
  retainedTp?: boolean;
};

export type CoverResult = {
  date: string;
  regime: Regime;
  iv: number;
  direction: Direction;
  entrySpot: number;
  hedgeStrike: number;
  hedgeContractsBtc: number;
  initialHedgeCostUsdc: number;
  daysHeld: number;
  triggered: boolean;
  triggerDay: number | null;
  premiumCharged: number;
  payoutPaid: number;
  retainedSalvageUsdc: number;
  netAtticusUsdc: number;
  paused: boolean;
};

export type ScenarioStats = {
  count: number;
  pausedCount: number;
  triggeredCount: number;
  triggerRate: number;
  avgDaysHeld: number;
  avgPremium: number;
  avgHedgeCost: number;
  avgRetainedSalvage: number;
  avgNetAtticus: number;
  medianNetAtticus: number;
  worstNetAtticus: number;
  bestNetAtticus: number;
  pctProfitable: number;
  totalPnL: number;
};

const classifyRegime = (vol: number): Regime => {
  if (vol < 0.50) return "calm";
  if (vol < 0.70) return "moderate";
  if (vol < 0.90) return "elevated";
  return "stress";
};

/**
 * Regime-conditional implied vol for BS hedge cost.
 * Imported from shared lib (services/api/scripts/backtest/lib/regimeIv.ts)
 * so all backtests use the same calibration table.
 *
 * See docs/foxify-pilot-bundle-c/28_BACKTEST_CALIBRATION_PRINCIPLES.md
 * for rationale + env override knobs.
 */
export const getRegimeConditionalIv = (regime: Regime): number => sharedGetRegimeIv(regime);

export const loadHistoricalData = async (): Promise<{
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
}> => {
  const data = JSON.parse(await fs.readFile("/tmp/btc_daily_ohlc.json", "utf8"));
  const candles: Candle[] = data.candles;
  const vols: Record<string, number> = data.annualVolByDay;
  const regimes: Record<string, Regime> = {};
  for (const [date, vol] of Object.entries(vols)) {
    regimes[date] = classifyRegime(vol as number);
  }
  return { candles, vols, regimes };
};

// ──────────────────────── Single-side helpers ────────────────────────

const computeIvMultiplier = (iv: number, refIv = 0.33, elasticity = 0.7): number => {
  return Math.pow(iv / refIv, elasticity);
};

const DEFAULT_REGIME_OVERLAY: Record<Regime, number | "pause"> = {
  calm: 1.0,
  moderate: 1.4,
  elevated: 2.0,
  stress: "pause"
};

// Bullish bid-ask uplift over mid (% above mid for buyer). Calibrated
// from live Bullish data: ~5% near-the-money, 10-15% far-OTM.
const fillUpliftFor = (otmPct: number): number => {
  if (otmPct <= 0.015) return 0.05;  // 0-1.5% OTM: 5%
  if (otmPct <= 0.04) return 0.07;   // 1.5-4% OTM: 7%
  return 0.12;                        // >4% OTM: 12%
};

const computeHedgeCostUsdc = (params: {
  spotUsdc: number;
  strikeUsdc: number;
  optionKind: "put" | "call";
  tenorDays: number;
  iv: number;
  contractsBtc: number;
}): number => {
  const T = params.tenorDays / 365;
  const perBtc =
    params.optionKind === "put"
      ? bsPut(params.spotUsdc, params.strikeUsdc, T, RFR, params.iv)
      : bsCall(params.spotUsdc, params.strikeUsdc, T, RFR, params.iv);
  const otmPct = Math.abs(params.spotUsdc - params.strikeUsdc) / params.spotUsdc;
  const uplift = 1 + fillUpliftFor(otmPct);
  return Math.max(0, perBtc * uplift) * params.contractsBtc;
};

const computeHedgeValueAtTime = (params: {
  currentSpot: number;
  strikeUsdc: number;
  optionKind: "put" | "call";
  remainingDays: number;
  iv: number;
  contractsBtc: number;
}): number => {
  const T = Math.max(0, params.remainingDays / 365);
  const perBtc =
    params.optionKind === "put"
      ? bsPut(params.currentSpot, params.strikeUsdc, T, RFR, params.iv)
      : bsCall(params.currentSpot, params.strikeUsdc, T, RFR, params.iv);
  return Math.max(0, perBtc) * params.contractsBtc;
};

/**
 * Apply 12-rule TP curve to retained leg. Daily granularity.
 * Returns realized salvage + sell day relative to retention start.
 */
const simulateRetainedTp = (params: {
  candles: Candle[];
  startIdx: number;
  strikeUsdc: number;
  optionKind: "put" | "call";
  initialCostUsdc: number;
  contractsBtc: number;
  iv: number;
  tenorRemainingDays: number;
  isWinner: boolean;
}): { salvageUsdc: number; sellDay: number } => {
  let runningMax = 0;
  for (let d = 0; d <= params.tenorRemainingDays; d++) {
    const dayIdx = params.startIdx + d;
    if (dayIdx >= params.candles.length) {
      // Out of data; force-sell at last close
      const last = params.candles[params.candles.length - 1];
      const v = computeHedgeValueAtTime({
        currentSpot: last.close,
        strikeUsdc: params.strikeUsdc,
        optionKind: params.optionKind,
        remainingDays: 0,
        iv: params.iv,
        contractsBtc: params.contractsBtc
      });
      return { salvageUsdc: v, sellDay: d };
    }
    const remaining = params.tenorRemainingDays - d;
    const value = computeHedgeValueAtTime({
      currentSpot: params.candles[dayIdx].close,
      strikeUsdc: params.strikeUsdc,
      optionKind: params.optionKind,
      remainingDays: remaining,
      iv: params.iv,
      contractsBtc: params.contractsBtc
    });
    runningMax = Math.max(runningMax, value);

    // Rule 1: time-decay forced exit (last day of tenor)
    if (remaining <= 1) return { salvageUsdc: value, sellDay: d };

    // Rule 12: hard floor
    if (value < params.initialCostUsdc * 0.10) {
      return { salvageUsdc: value, sellDay: d };
    }

    // Winner-side rules:
    if (params.isWinner) {
      // Rule 5: trailing-max retracement (sell on 20% pullback)
      if (runningMax > 0 && value < runningMax * 0.80 && d >= 1) {
        return { salvageUsdc: value, sellDay: d };
      }
      // Rule W1 stub: 24h time cap (day 1 in our daily granularity)
      if (d >= 1) {
        return { salvageUsdc: value, sellDay: d };
      }
    } else {
      // Loser side:
      // Rule 7: floor 20% OR grace 4h (≈ same day at daily resolution)
      if (value < params.initialCostUsdc * 0.20 || d >= 1) {
        return { salvageUsdc: value, sellDay: d };
      }
    }
  }
  // Should never reach here, but force-sell at zero if we do
  return { salvageUsdc: 0, sellDay: params.tenorRemainingDays };
};

/**
 * Walk forward to detect trigger. For SHORT cover: trigger when high
 * crosses entry × (1 + triggerPct). For LONG cover: trigger when low
 * crosses entry × (1 - triggerPct).
 *
 * Returns: triggered, triggerDay (1-indexed), spot at exit (== trigger
 * price if triggered, else day-N close).
 */
const walkForwardSingleSide = (params: {
  candles: Candle[];
  startIdx: number;
  holdDays: number;
  triggerPriceUsdc: number;
  direction: Direction;
}): { triggered: boolean; triggerDay: number | null; exitSpot: number; daysHeld: number } => {
  let triggered = false;
  let triggerDay: number | null = null;
  let actualHold = params.holdDays;
  let exitSpot = params.candles[params.startIdx].close;

  for (let d = 1; d <= params.holdDays; d++) {
    if (params.startIdx + d >= params.candles.length) break;
    const day = params.candles[params.startIdx + d];
    if (params.direction === "short" && day.high >= params.triggerPriceUsdc) {
      triggered = true;
      triggerDay = d;
      actualHold = d;
      exitSpot = params.triggerPriceUsdc;
      break;
    }
    if (params.direction === "long" && day.low <= params.triggerPriceUsdc) {
      triggered = true;
      triggerDay = d;
      actualHold = d;
      exitSpot = params.triggerPriceUsdc;
      break;
    }
    exitSpot = day.close;
  }
  return { triggered, triggerDay, exitSpot, daysHeld: actualHold };
};

const sampleHoldDaysFromModel = (
  model: Scenario["holdModel"],
  basePerDay: number,
  payout: number,
  maxDays: number
): number => {
  if (model.kind === "fixed") {
    return Math.max(1, Math.min(maxDays, model.days));
  }
  // premium_ratio: hold until premium accumulated reaches targetRatio × payout
  // breakeven_days = targetRatio × payout / dailyPremium
  if (basePerDay <= 0) return Math.max(1, Math.min(maxDays, 3));
  const targetDays = (model.targetRatio * payout) / basePerDay;
  return Math.max(1, Math.min(maxDays, Math.round(targetDays)));
};

// ──────────────────────── Cover simulator ────────────────────────

export const simulateSingleSideCover = (params: {
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
  startIdx: number;
  scenario: Scenario;
  /** Random direction (50/50 long/short by default) */
  direction?: Direction;
}): CoverResult | null => {
  const { candles, vols, regimes, startIdx, scenario } = params;
  const cell = scenario.cell;

  if (startIdx + cell.hedgeTenorDays >= candles.length) return null;

  const entryDay = candles[startIdx];
  const entrySpot = entryDay.close;
  // Path D: separate realized vs implied vol.
  //   - realizedVol: from historical price returns; drives regime
  //     classification + the IV-aware pricing scaling input
  //   - hedgeIv: regime-conditional reference IV used for BS hedge cost
  //     (what the market actually charges for the option, smoother than
  //     realized vol)
  const realizedVol = vols[entryDay.date] ?? 0.65;
  const regime = regimes[entryDay.date] ?? "moderate";
  const hedgeIv = getRegimeConditionalIv(regime);
  // For backward compat with tests + telemetry, expose hedgeIv as 'iv'
  const iv = hedgeIv;
  const direction = params.direction ?? (Math.random() < 0.5 ? "long" : "short");

  // Apply trigger-rate multiplier for selection bias
  const triggerMultiplier = scenario.triggerRateMultiplier ?? 2.0;

  // IV-aware base price + regime overlay.
  // Path D: scaling reflects the hedgeIv (regime-conditional implied vol),
  // not realized vol. This matches what production code will actually
  // charge — current Bullish IV at quote time, anchored to 33% reference.
  const useIvAware = scenario.ivAwarePricing !== false;
  const ivMultiplier = useIvAware ? computeIvMultiplier(hedgeIv, 0.33, 0.7) : 1.0;
  const overlay = scenario.regimeOverlay ?? DEFAULT_REGIME_OVERLAY;
  const overlayMult = overlay[regime];

  const basePremium = scenario.basePremiumOverride ?? cell.baseDailyPremiumUsdc;

  // Stress regime: pause
  if (overlayMult === "pause") {
    return {
      date: entryDay.date,
      regime,
      iv,
      direction,
      entrySpot,
      hedgeStrike: 0,
      hedgeContractsBtc: 0,
      initialHedgeCostUsdc: 0,
      daysHeld: 0,
      triggered: false,
      triggerDay: null,
      premiumCharged: 0,
      payoutPaid: 0,
      retainedSalvageUsdc: 0,
      netAtticusUsdc: 0,
      paused: true
    };
  }
  const overlayMultNum = typeof overlayMult === "number" ? overlayMult : 1.0;

  const dailyPremium = basePremium * ivMultiplier * overlayMultNum;

  // Hedge geometry
  const hedgeStrike =
    direction === "long"
      ? entrySpot * (1 - cell.hedgePct)
      : entrySpot * (1 + cell.hedgePct);
  const optionKind: "put" | "call" = direction === "long" ? "put" : "call";
  const intrinsicAtTrigger = entrySpot * (cell.triggerPct - cell.hedgePct);
  const baseContracts = cell.payoutUsdc / intrinsicAtTrigger;
  // Vol buffer
  const volBuffer = regime === "calm" ? 1.0 : regime === "moderate" ? 1.05 : regime === "elevated" ? 1.10 : 1.15;
  const buffered = baseContracts * volBuffer;
  const contractsBtc = Math.ceil(buffered / 0.1) * 0.1;

  const initialHedgeCost = computeHedgeCostUsdc({
    spotUsdc: entrySpot,
    strikeUsdc: hedgeStrike,
    optionKind,
    tenorDays: cell.hedgeTenorDays,
    iv,
    contractsBtc
  });

  // Trigger price
  const triggerPrice =
    direction === "long"
      ? entrySpot * (1 - cell.triggerPct)
      : entrySpot * (1 + cell.triggerPct);

  // Apply trigger multiplier: probabilistically extend "selection bias"
  // by treating the position as if entry was at slightly less favorable
  // spot. We model this as a probability adjustment: at higher
  // multiplier, treat the cover as more likely to trigger.
  // Implementation: use multiplier as probability scaler when comparing
  // to historical walks. For cleanliness, run the actual walk and only
  // count the outcome — multiplier is reflected in scenario tuning later.

  // Hold time
  const holdDays = sampleHoldDaysFromModel(scenario.holdModel, dailyPremium, cell.payoutUsdc, cell.hedgeTenorDays);

  // Walk forward
  const walk = walkForwardSingleSide({
    candles,
    startIdx,
    holdDays,
    triggerPriceUsdc: triggerPrice,
    direction
  });

  // Apply selection bias by occasionally forcing trigger at higher rate.
  // If trigger didn't fire naturally, but multiplier > 1, randomly
  // mark some as triggered to reflect Foxify's better entry timing.
  let effectiveTriggered = walk.triggered;
  if (!walk.triggered && triggerMultiplier > 1.0) {
    // Probability of "would have triggered with better entry timing":
    // simple model — additional 5% per multiplier point above 1.0
    const bonusTriggerProb = Math.min(0.5, (triggerMultiplier - 1.0) * 0.05);
    if (Math.random() < bonusTriggerProb) {
      effectiveTriggered = true;
    }
  }

  // Premium accrued
  const actualHold = effectiveTriggered ? walk.daysHeld : holdDays;
  const premium = dailyPremium * actualHold;

  // Retained TP simulation
  const useTp = scenario.retainedTp !== false;
  const tenorRemaining = cell.hedgeTenorDays - actualHold;
  let retainedSalvage = 0;
  if (useTp && tenorRemaining > 0) {
    const sim = simulateRetainedTp({
      candles,
      startIdx: startIdx + actualHold,
      strikeUsdc: hedgeStrike,
      optionKind,
      initialCostUsdc: initialHedgeCost,
      contractsBtc,
      iv,
      tenorRemainingDays: tenorRemaining,
      isWinner: effectiveTriggered
    });
    retainedSalvage = sim.salvageUsdc;
  } else {
    // No retained TP (e.g., expired): salvage = 0
    retainedSalvage = 0;
  }

  const payout = effectiveTriggered ? cell.payoutUsdc : 0;
  const netAtticus = premium - initialHedgeCost + retainedSalvage - payout;

  return {
    date: entryDay.date,
    regime,
    iv,
    direction,
    entrySpot,
    hedgeStrike,
    hedgeContractsBtc: contractsBtc,
    initialHedgeCostUsdc: initialHedgeCost,
    daysHeld: actualHold,
    triggered: effectiveTriggered,
    triggerDay: walk.triggerDay,
    premiumCharged: premium,
    payoutPaid: payout,
    retainedSalvageUsdc: retainedSalvage,
    netAtticusUsdc: netAtticus,
    paused: false
  };
};

// ──────────────────────── Stats ────────────────────────

export const summarize = (results: CoverResult[]): ScenarioStats => {
  const active = results.filter((r) => !r.paused);
  const pnls = active.map((r) => r.netAtticusUsdc).sort((a, b) => a - b);
  const n = pnls.length;
  return {
    count: results.length,
    pausedCount: results.length - n,
    triggeredCount: active.filter((r) => r.triggered).length,
    triggerRate: n > 0 ? active.filter((r) => r.triggered).length / n : 0,
    avgDaysHeld: n > 0 ? active.reduce((s, r) => s + r.daysHeld, 0) / n : 0,
    avgPremium: n > 0 ? active.reduce((s, r) => s + r.premiumCharged, 0) / n : 0,
    avgHedgeCost: n > 0 ? active.reduce((s, r) => s + r.initialHedgeCostUsdc, 0) / n : 0,
    avgRetainedSalvage: n > 0 ? active.reduce((s, r) => s + r.retainedSalvageUsdc, 0) / n : 0,
    avgNetAtticus: n > 0 ? pnls.reduce((s, x) => s + x, 0) / n : 0,
    medianNetAtticus: n > 0 ? pnls[Math.floor(n / 2)] : 0,
    worstNetAtticus: n > 0 ? pnls[0] : 0,
    bestNetAtticus: n > 0 ? pnls[n - 1] : 0,
    pctProfitable: n > 0 ? active.filter((r) => r.netAtticusUsdc > 0).length / n : 0,
    totalPnL: pnls.reduce((s, x) => s + x, 0)
  };
};

export const summarizeByRegime = (results: CoverResult[]): Record<Regime, ScenarioStats> => {
  const groups: Record<Regime, CoverResult[]> = { calm: [], moderate: [], elevated: [], stress: [] };
  for (const r of results) groups[r.regime].push(r);
  return {
    calm: summarize(groups.calm),
    moderate: summarize(groups.moderate),
    elevated: summarize(groups.elevated),
    stress: summarize(groups.stress)
  };
};

// ──────────────────────── Scenario runner ────────────────────────

export const runScenario = async (params: {
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
  scenario: Scenario;
  iterPerEntry?: number;
}): Promise<{
  scenario: Scenario;
  results: CoverResult[];
  perRegime: Record<Regime, ScenarioStats>;
  total: ScenarioStats;
}> => {
  const { candles, vols, regimes, scenario } = params;
  const tenorDays = scenario.cell.hedgeTenorDays;
  const iter = params.iterPerEntry ?? 3;
  const results: CoverResult[] = [];
  for (let i = 30; i < candles.length - tenorDays - 1; i++) {
    for (let k = 0; k < iter; k++) {
      const r = simulateSingleSideCover({ candles, vols, regimes, startIdx: i, scenario });
      if (r) results.push(r);
    }
  }
  const perRegime = summarizeByRegime(results);
  const total = summarize(results);
  return { scenario, results, perRegime, total };
};
