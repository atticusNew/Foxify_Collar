/**
 * Single-side INTRADAY backtest engine — 5-minute granularity.
 *
 * Adapted from `coreEngine.ts` (daily) to validate the theta-aware TP
 * curve's actual lift, since its key mechanism (intraday-peak capture
 * within the first 30 minutes after trigger fire) operates intraday.
 * The daily harness can only approximate this with day-extreme; the
 * intraday harness measures it directly.
 *
 * Reuses:
 *   - BS pricing + nCDF from coreEngine
 *   - Regime classification + getRegimeConditionalIv from coreEngine
 *   - Hedge geometry / sizing / pricing layers from coreEngine
 *
 * What's new:
 *   - 5-min bar walk-forward for trigger detection
 *   - 5-min-aware TP curve (baseline AND thetaAware variants) so we can
 *     directly compare the lift between curves at intraday resolution
 *   - Trigger-fire intraday peak capture window: configurable (default
 *     30 minutes)
 */

import * as fs from "node:fs/promises";

import {
  bsPut,
  bsCall,
  getRegimeConditionalIv,
  type Cell,
  type Direction,
  type Regime,
  type Scenario,
  type CoverResult
} from "./coreEngine";

const RFR = 0.045;
const BAR_MINUTES = 5;
const BARS_PER_HOUR = 60 / BAR_MINUTES;
const BARS_PER_DAY = 24 * BARS_PER_HOUR;

// ──────────────────────── Types ────────────────────────

export type IntradayBar = {
  timestamp: number;
  date: string;
  minute: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type IntradayDataset = {
  bars: IntradayBar[];
  dailyIndex: Record<string, { startIdx: number; endIdx: number }>;
  vols: Record<string, number>; // realized vol per day
  regimes: Record<string, Regime>; // regime per day
};

// ──────────────────────── Helpers ────────────────────────

const computeIvMultiplier = (iv: number, refIv = 0.33, elasticity = 0.7): number =>
  Math.pow(iv / refIv, elasticity);

const DEFAULT_REGIME_OVERLAY: Record<Regime, number | "pause"> = {
  calm: 1.0,
  moderate: 1.4,
  elevated: 2.0,
  stress: "pause"
};

const fillUpliftFor = (otmPct: number): number => {
  if (otmPct <= 0.015) return 0.05;
  if (otmPct <= 0.04) return 0.07;
  return 0.12;
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
  remainingMinutes: number;
  iv: number;
  contractsBtc: number;
}): number => {
  const remDays = Math.max(0, params.remainingMinutes / (60 * 24));
  const T = remDays / 365;
  const perBtc =
    params.optionKind === "put"
      ? bsPut(params.currentSpot, params.strikeUsdc, T, RFR, params.iv)
      : bsCall(params.currentSpot, params.strikeUsdc, T, RFR, params.iv);
  return Math.max(0, perBtc) * params.contractsBtc;
};

// ──────────────────────── Data load ────────────────────────

export const loadIntradayData = async (): Promise<IntradayDataset> => {
  const intra = JSON.parse(await fs.readFile("/tmp/btc_5min_ohlc.json", "utf8"));
  const daily = JSON.parse(await fs.readFile("/tmp/btc_daily_ohlc.json", "utf8"));
  const regimes: Record<string, Regime> = {};
  const vols: Record<string, number> = daily.annualVolByDay ?? {};
  for (const [date, vol] of Object.entries(vols)) {
    const v = vol as number;
    regimes[date] =
      v < 0.5 ? "calm" : v < 0.7 ? "moderate" : v < 0.9 ? "elevated" : "stress";
  }
  return {
    bars: intra.bars,
    dailyIndex: intra.dailyIndex,
    vols,
    regimes
  };
};

// ──────────────────────── Trigger detection ────────────────────────

/**
 * Walk forward at 5-min granularity to detect trigger.
 * Returns trigger bar index relative to startBarIdx (or null if none).
 */
const walkForwardIntraday = (params: {
  bars: IntradayBar[];
  startBarIdx: number;
  holdBars: number;
  triggerPriceUsdc: number;
  direction: Direction;
}): { triggered: boolean; triggerBar: number | null; barsHeld: number } => {
  let triggered = false;
  let triggerBar: number | null = null;
  let actualHold = params.holdBars;

  const limit = Math.min(params.bars.length, params.startBarIdx + params.holdBars);
  for (let i = params.startBarIdx + 1; i < limit; i++) {
    const bar = params.bars[i];
    if (params.direction === "short" && bar.high >= params.triggerPriceUsdc) {
      triggered = true;
      triggerBar = i - params.startBarIdx;
      actualHold = triggerBar;
      break;
    }
    if (params.direction === "long" && bar.low <= params.triggerPriceUsdc) {
      triggered = true;
      triggerBar = i - params.startBarIdx;
      actualHold = triggerBar;
      break;
    }
  }
  return { triggered, triggerBar, barsHeld: actualHold };
};

// ──────────────────────── Baseline TP — 5-min variant ────────────────────────

/**
 * 5-minute-resolution baseline TP curve.
 * Mirrors the daily simulateRetainedTp(rules 1, 5, 7, 12, W1) but on
 * 5-min bars, evaluated every BARS_PER_HOUR (60 min). Sells at bar.close.
 */
const simulateRetainedTpIntradayBaseline = (params: {
  bars: IntradayBar[];
  startBarIdx: number;
  strikeUsdc: number;
  optionKind: "put" | "call";
  initialCostUsdc: number;
  contractsBtc: number;
  iv: number;
  tenorRemainingMinutes: number;
  isWinner: boolean;
}): { salvageUsdc: number; sellBar: number } => {
  let runningMax = 0;
  // Step every 60 min (matches "1-hour evaluation cadence" of pilot/hedgeManager)
  const evalEvery = BARS_PER_HOUR;

  for (let bi = 0; bi <= params.tenorRemainingMinutes / BAR_MINUTES; bi += evalEvery) {
    const idx = params.startBarIdx + bi;
    if (idx >= params.bars.length) {
      const last = params.bars[params.bars.length - 1];
      const v = computeHedgeValueAtTime({
        currentSpot: last.close,
        strikeUsdc: params.strikeUsdc,
        optionKind: params.optionKind,
        remainingMinutes: 0,
        iv: params.iv,
        contractsBtc: params.contractsBtc
      });
      return { salvageUsdc: v, sellBar: bi };
    }
    const remainingMin = params.tenorRemainingMinutes - bi * BAR_MINUTES;
    const value = computeHedgeValueAtTime({
      currentSpot: params.bars[idx].close,
      strikeUsdc: params.strikeUsdc,
      optionKind: params.optionKind,
      remainingMinutes: remainingMin,
      iv: params.iv,
      contractsBtc: params.contractsBtc
    });
    runningMax = Math.max(runningMax, value);

    // Force exit on last evaluation if remaining < 4h
    if (remainingMin <= 4 * 60) return { salvageUsdc: value, sellBar: bi };

    // Hard floor: 10% of initial cost
    if (value < params.initialCostUsdc * 0.10) {
      return { salvageUsdc: value, sellBar: bi };
    }

    if (params.isWinner) {
      // Trail retracement 20% from running max (after at least 1h)
      if (runningMax > 0 && value < runningMax * 0.80 && bi >= BARS_PER_HOUR) {
        return { salvageUsdc: value, sellBar: bi };
      }
      // W1: 24h winner cap
      if (bi >= 24 * BARS_PER_HOUR) {
        return { salvageUsdc: value, sellBar: bi };
      }
    } else {
      // Loser: 20% floor or 4h grace
      if (value < params.initialCostUsdc * 0.20 || bi >= 4 * BARS_PER_HOUR) {
        return { salvageUsdc: value, sellBar: bi };
      }
    }
  }
  return { salvageUsdc: 0, sellBar: Math.floor(params.tenorRemainingMinutes / BAR_MINUTES) };
};

// ──────────────────────── Theta-aware TP — 5-min variant ────────────────────────

/**
 * 5-minute-resolution theta-aware TP curve. THIS is the curve where
 * intraday-peak capture has its full effect.
 *
 * For winner side:
 *   1. Capture window (first 30 min after trigger): track intraday
 *      hedge-value peak (over the LOW for puts / HIGH for calls within
 *      each 5-min bar). Sell at running peak × 0.85 slippage haircut.
 *   2. Past 30 min: tighter trail (15% retracement).
 *   3. Cap-fraction exit at 90% of current-spot intrinsic.
 *   4. Hard floor at 10% of payout.
 *   5. Force exit at expiry−4h.
 *
 * For loser side: keep baseline-style 4h grace exit.
 */
const simulateRetainedTpIntradayThetaAware = (params: {
  bars: IntradayBar[];
  startBarIdx: number;
  strikeUsdc: number;
  optionKind: "put" | "call";
  initialCostUsdc: number;
  contractsBtc: number;
  iv: number;
  tenorRemainingMinutes: number;
  payoutUsdc: number;
  isWinner: boolean;
}): { salvageUsdc: number; sellBar: number; mode: string } => {
  const SLIPPAGE_HAIRCUT = 0.85;
  const TRAIL_RETRACE = 0.85;
  const CAP_FRACTION = 0.90;
  const HARD_FLOOR_PAYOUT = 0.10;
  const CAPTURE_WINDOW_MIN = 30;
  const CAPTURE_WINDOW_BARS = CAPTURE_WINDOW_MIN / BAR_MINUTES;

  const evalEvery = 1; // every 5-min bar — fine resolution
  let runningPeakHedgeValue = 0;
  let runningMaxClose = 0;

  for (let bi = 0; bi <= params.tenorRemainingMinutes / BAR_MINUTES; bi += evalEvery) {
    const idx = params.startBarIdx + bi;
    if (idx >= params.bars.length) {
      const last = params.bars[params.bars.length - 1];
      const v = computeHedgeValueAtTime({
        currentSpot: last.close,
        strikeUsdc: params.strikeUsdc,
        optionKind: params.optionKind,
        remainingMinutes: 0,
        iv: params.iv,
        contractsBtc: params.contractsBtc
      });
      return { salvageUsdc: v, sellBar: bi, mode: "data_end" };
    }
    const bar = params.bars[idx];
    const remainingMin = params.tenorRemainingMinutes - bi * BAR_MINUTES;

    // For winner side: track INTRABAR PEAK hedge value (using bar.low
    // for puts, bar.high for calls).
    if (params.isWinner) {
      const peakSpot = params.optionKind === "put" ? bar.low : bar.high;
      const peakHedgeValue = computeHedgeValueAtTime({
        currentSpot: peakSpot,
        strikeUsdc: params.strikeUsdc,
        optionKind: params.optionKind,
        remainingMinutes: remainingMin,
        iv: params.iv,
        contractsBtc: params.contractsBtc
      });
      runningPeakHedgeValue = Math.max(runningPeakHedgeValue, peakHedgeValue);
    }

    const closeValue = computeHedgeValueAtTime({
      currentSpot: bar.close,
      strikeUsdc: params.strikeUsdc,
      optionKind: params.optionKind,
      remainingMinutes: remainingMin,
      iv: params.iv,
      contractsBtc: params.contractsBtc
    });
    runningMaxClose = Math.max(runningMaxClose, closeValue);

    // Force exit at expiry−4h
    if (remainingMin <= 4 * 60) {
      return { salvageUsdc: closeValue, sellBar: bi, mode: "force_expiry" };
    }

    // Cap-fraction exit (winner only — captured 90%+ of cap)
    if (params.isWinner) {
      const intrinsicNow =
        params.optionKind === "put"
          ? Math.max(0, params.strikeUsdc - bar.close) * params.contractsBtc
          : Math.max(0, bar.close - params.strikeUsdc) * params.contractsBtc;
      if (intrinsicNow > 0 && closeValue >= intrinsicNow * CAP_FRACTION) {
        return { salvageUsdc: closeValue, sellBar: bi, mode: "cap_fraction" };
      }
    }

    // Hard floor referenced to payout
    if (closeValue < params.payoutUsdc * HARD_FLOOR_PAYOUT) {
      return { salvageUsdc: closeValue, sellBar: bi, mode: "hard_floor_payout" };
    }

    if (params.isWinner) {
      // Capture window: end of 30-min window → sell at running peak × haircut.
      // (We need to walk to end of capture window, then either continue
      // or sell. Simpler: at exactly the 30-min mark, snap.)
      if (bi === CAPTURE_WINDOW_BARS) {
        return {
          salvageUsdc: runningPeakHedgeValue * SLIPPAGE_HAIRCUT,
          sellBar: bi,
          mode: "capture_window_peak"
        };
      }
      // Past capture window: tighter trail (15% retracement from running max-close)
      if (bi > CAPTURE_WINDOW_BARS && runningMaxClose > 0 && closeValue < runningMaxClose * TRAIL_RETRACE) {
        return { salvageUsdc: closeValue, sellBar: bi, mode: "trail_retrace" };
      }
    } else {
      // Loser: 4h grace
      if (bi >= 4 * BARS_PER_HOUR) {
        return { salvageUsdc: closeValue, sellBar: bi, mode: "loser_grace" };
      }
    }
  }
  return {
    salvageUsdc: 0,
    sellBar: Math.floor(params.tenorRemainingMinutes / BAR_MINUTES),
    mode: "expired"
  };
};

// ──────────────────────── Cover simulator ────────────────────────

const sampleHoldBarsFromModel = (
  model: Scenario["holdModel"],
  basePerDay: number,
  payout: number,
  maxBars: number
): number => {
  if (model.kind === "fixed") {
    return Math.max(BARS_PER_HOUR, Math.min(maxBars, model.days * BARS_PER_DAY));
  }
  if (basePerDay <= 0) return Math.max(BARS_PER_HOUR, Math.min(maxBars, 3 * BARS_PER_DAY));
  const targetDays = (model.targetRatio * payout) / basePerDay;
  return Math.max(BARS_PER_HOUR, Math.min(maxBars, Math.round(targetDays * BARS_PER_DAY)));
};

export const simulateSingleSideCoverIntraday = (params: {
  data: IntradayDataset;
  startBarIdx: number;
  scenario: Scenario;
  direction?: Direction;
}): (CoverResult & { tpMode?: string }) | null => {
  const { data, startBarIdx, scenario } = params;
  const cell = scenario.cell;
  const totalBars = data.bars.length;
  const tenorBars = cell.hedgeTenorDays * BARS_PER_DAY;
  if (startBarIdx + tenorBars + BARS_PER_HOUR >= totalBars) return null;

  const entryBar = data.bars[startBarIdx];
  const entrySpot = entryBar.close;
  const date = entryBar.date;
  const regime = data.regimes[date] ?? "moderate";
  const hedgeIv = getRegimeConditionalIv(regime);
  const iv = hedgeIv;
  const direction: Direction = params.direction ?? (Math.random() < 0.5 ? "long" : "short");
  const triggerMultiplier = scenario.triggerRateMultiplier ?? 2.0;

  const useIvAware = scenario.ivAwarePricing !== false;
  const ivMultiplier = useIvAware ? computeIvMultiplier(hedgeIv, 0.33, 0.7) : 1.0;
  const overlay = scenario.regimeOverlay ?? DEFAULT_REGIME_OVERLAY;
  const overlayMult = overlay[regime];
  const basePremium = scenario.basePremiumOverride ?? cell.baseDailyPremiumUsdc;
  if (overlayMult === "pause") {
    return {
      date,
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

  const hedgeStrike =
    direction === "long"
      ? entrySpot * (1 - cell.hedgePct)
      : entrySpot * (1 + cell.hedgePct);
  const optionKind: "put" | "call" = direction === "long" ? "put" : "call";
  const intrinsicAtTrigger = entrySpot * (cell.triggerPct - cell.hedgePct);
  const baseContracts = cell.payoutUsdc / intrinsicAtTrigger;
  const volBuffer =
    regime === "calm" ? 1.0 : regime === "moderate" ? 1.05 : regime === "elevated" ? 1.10 : 1.15;
  const contractsBtc = Math.ceil((baseContracts * volBuffer) / 0.1) * 0.1;

  const initialHedgeCost = computeHedgeCostUsdc({
    spotUsdc: entrySpot,
    strikeUsdc: hedgeStrike,
    optionKind,
    tenorDays: cell.hedgeTenorDays,
    iv,
    contractsBtc
  });

  const triggerPrice =
    direction === "long" ? entrySpot * (1 - cell.triggerPct) : entrySpot * (1 + cell.triggerPct);

  const holdBars = sampleHoldBarsFromModel(
    scenario.holdModel,
    dailyPremium,
    cell.payoutUsdc,
    tenorBars
  );

  const walk = walkForwardIntraday({
    bars: data.bars,
    startBarIdx,
    holdBars,
    triggerPriceUsdc: triggerPrice,
    direction
  });

  let effectiveTriggered = walk.triggered;
  if (!walk.triggered && triggerMultiplier > 1.0) {
    const bonusTriggerProb = Math.min(0.5, (triggerMultiplier - 1.0) * 0.05);
    if (Math.random() < bonusTriggerProb) effectiveTriggered = true;
  }

  const actualHoldBars = effectiveTriggered ? walk.barsHeld : holdBars;
  const actualHoldDays = actualHoldBars / BARS_PER_DAY;
  const pricingModel = scenario.pricingModel ?? "fixed";
  const premium =
    pricingModel === "xOrY" && effectiveTriggered ? 0 : dailyPremium * actualHoldDays;

  // TP simulation at 5-min granularity
  const tenorRemainingMinutes = (tenorBars - actualHoldBars) * BAR_MINUTES;
  let retainedSalvage = 0;
  let tpMode = "";
  if (scenario.retainedTp !== false && tenorRemainingMinutes > 0) {
    const tpVariant = scenario.tpCurve ?? "baseline";
    if (tpVariant === "thetaAware") {
      const sim = simulateRetainedTpIntradayThetaAware({
        bars: data.bars,
        startBarIdx: startBarIdx + actualHoldBars,
        strikeUsdc: hedgeStrike,
        optionKind,
        initialCostUsdc: initialHedgeCost,
        contractsBtc,
        iv,
        tenorRemainingMinutes,
        payoutUsdc: cell.payoutUsdc,
        isWinner: effectiveTriggered
      });
      retainedSalvage = sim.salvageUsdc;
      tpMode = sim.mode;
    } else {
      const sim = simulateRetainedTpIntradayBaseline({
        bars: data.bars,
        startBarIdx: startBarIdx + actualHoldBars,
        strikeUsdc: hedgeStrike,
        optionKind,
        initialCostUsdc: initialHedgeCost,
        contractsBtc,
        iv,
        tenorRemainingMinutes,
        isWinner: effectiveTriggered
      });
      retainedSalvage = sim.salvageUsdc;
      tpMode = "baseline";
    }
  }

  const xOrYMult = scenario.xOrYRegimePayoutMult ?? {
    calm: 1.0,
    moderate: 0.7,
    elevated: 0.5,
    stress: 0
  };
  const effectivePayout =
    pricingModel === "xOrY" ? cell.payoutUsdc * (xOrYMult[regime] ?? 0) : cell.payoutUsdc;
  const payout = effectiveTriggered ? effectivePayout : 0;
  const netAtticus = premium - initialHedgeCost + retainedSalvage - payout;

  return {
    date,
    regime,
    iv,
    direction,
    entrySpot,
    hedgeStrike,
    hedgeContractsBtc: contractsBtc,
    initialHedgeCostUsdc: initialHedgeCost,
    daysHeld: actualHoldDays,
    triggered: effectiveTriggered,
    triggerDay: walk.triggerBar !== null ? walk.triggerBar / BARS_PER_DAY : null,
    premiumCharged: premium,
    payoutPaid: payout,
    retainedSalvageUsdc: retainedSalvage,
    netAtticusUsdc: netAtticus,
    paused: false,
    tpMode
  };
};

// ──────────────────────── Scenario runner ────────────────────────

export const runIntradayScenario = (params: {
  data: IntradayDataset;
  scenario: Scenario;
  /** Sample 1 cover per day at 00:00 UTC (or first available bar) */
  iterPerDay?: number;
}): { results: Array<CoverResult & { tpMode?: string }> } => {
  const { data, scenario } = params;
  const iter = params.iterPerDay ?? 1;
  const results: Array<CoverResult & { tpMode?: string }> = [];
  // Iterate by day, sampling at the first bar of each day
  const dates = Object.keys(data.dailyIndex).sort();
  for (const date of dates) {
    if (!(date in data.regimes)) continue; // skip days without regime classification
    const startBarIdx = data.dailyIndex[date].startIdx;
    for (let k = 0; k < iter; k++) {
      const r = simulateSingleSideCoverIntraday({ data, startBarIdx, scenario });
      if (r) results.push(r);
    }
  }
  return { results };
};

// ──────────────────────── Stats ────────────────────────

export type IntradayStats = {
  count: number;
  pausedCount: number;
  triggeredCount: number;
  triggerRate: number;
  avgPremium: number;
  avgHedgeCost: number;
  avgRetainedSalvage: number;
  avgNetAtticus: number;
  medianNetAtticus: number;
  worstNetAtticus: number;
  bestNetAtticus: number;
  pctProfitable: number;
  totalPnL: number;
  /** Frequency map of TP curve sell modes, only relevant for triggered covers */
  tpModeCounts: Record<string, number>;
};

export const summarizeIntraday = (
  results: Array<CoverResult & { tpMode?: string }>
): IntradayStats => {
  const active = results.filter((r) => !r.paused);
  const pnls = active.map((r) => r.netAtticusUsdc).sort((a, b) => a - b);
  const n = pnls.length;
  const tpModeCounts: Record<string, number> = {};
  for (const r of active) {
    if (r.triggered && r.tpMode) {
      tpModeCounts[r.tpMode] = (tpModeCounts[r.tpMode] ?? 0) + 1;
    }
  }
  return {
    count: results.length,
    pausedCount: results.length - n,
    triggeredCount: active.filter((r) => r.triggered).length,
    triggerRate: n > 0 ? active.filter((r) => r.triggered).length / n : 0,
    avgPremium: n > 0 ? active.reduce((s, r) => s + r.premiumCharged, 0) / n : 0,
    avgHedgeCost: n > 0 ? active.reduce((s, r) => s + r.initialHedgeCostUsdc, 0) / n : 0,
    avgRetainedSalvage: n > 0 ? active.reduce((s, r) => s + r.retainedSalvageUsdc, 0) / n : 0,
    avgNetAtticus: n > 0 ? pnls.reduce((s, x) => s + x, 0) / n : 0,
    medianNetAtticus: n > 0 ? pnls[Math.floor(n / 2)] : 0,
    worstNetAtticus: n > 0 ? pnls[0] : 0,
    bestNetAtticus: n > 0 ? pnls[n - 1] : 0,
    pctProfitable: n > 0 ? active.filter((r) => r.netAtticusUsdc > 0).length / n : 0,
    totalPnL: pnls.reduce((s, x) => s + x, 0),
    tpModeCounts
  };
};
