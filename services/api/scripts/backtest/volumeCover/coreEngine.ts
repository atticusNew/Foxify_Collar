/**
 * P2 — Volume Cover production-faithful backtest engine.
 *
 * Models the Phase 1 production stack:
 *   - 14-day matched-tenor hedge (P1a)
 *   - Atticus retention post-trigger / post-Foxify-close (P1b)
 *   - Vol-buffered sizing + grid-snapped strikes (P1c)
 *   - Proportional premium accrual (P1d)
 *   - Ladder netting on rapid reopens (P1e)
 *   - Stub TP curve (rules 1+7+12+W1) for retained legs (P1f)
 *
 * Key differences from prior harnesses (see exit-assessment/19-23):
 *   - Premium = dailyPremium × walk.daysHeld (was full-tenor in #20)
 *   - Hedge sizing = payout / intrinsic_at_trigger × vol_buffer (was 1× notional in #21/#22)
 *   - Retained-TP simulation: post-Foxify-exit walk forward day-by-day
 *     applying TP rules, capture realized salvage as actual sale proceeds
 *     (was immediate sell at trigger spot in #21/#22)
 *   - Ladder netting: 60% of closes followed by reopen within 30min;
 *     repurpose retained legs when match (saves 1 hedge cost/cover)
 *
 * Output: per-cover P&L decomposition with retained-TP attribution.
 */

import * as fs from "node:fs/promises";
import { getRegimeIv } from "../lib/regimeIv";

// ──────────────────────── BS pricing ────────────────────────

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

export type Cell = {
  cellId: string;
  notionalUsdc: number;
  triggerPct: number;
  payoutUsdc: number;
  hedgePct: number;
  dailyPremiumUsdc: number;
};

export type Scenario = {
  name: string;
  cell: Cell;
  /** Regime → daily premium override (e.g., regime tier overlay). */
  regimePremium?: Partial<Record<Regime, number>>;
  /** Tenor in days; default 14. */
  tenorDays?: number;
  /** Vol buffer multipliers; default {calm:1, moderate:1.05, elevated:1.10, stress:1.15}. */
  volBuffers?: Partial<Record<Regime, number>>;
  /** Hold mean days for exponential sampler; default 3. */
  holdMeanDays?: number;
  /** Probability of ladder reopen within 30 min after a close (saves one hedge cost). */
  ladderProb?: number;
};

export type CoverResult = {
  date: string;
  regime: Regime;
  entrySpot: number;
  iv: number;
  dailyPremium: number;
  daysHeld: number;
  triggered: boolean;
  triggerDay: number | null;
  triggerSpot: number | null;
  hedgeCost: number;
  premium: number;
  payout: number;
  retainedSalvage: number;
  laddered: boolean;
  ladderSavings: number;
  atticusNet: number;
};

export type ScenarioStats = {
  count: number;
  avg: number;
  median: number;
  p10: number;
  p90: number;
  worst: number;
  best: number;
  pctProfitable: number;
  triggerRate: number;
  avgDaysHeld: number;
  avgPremium: number;
  avgHedgeCost: number;
  avgRetainedSalvage: number;
  avgLadderSavings: number;
  totalPnL: number;
};

// ──────────────────────── Data loader ────────────────────────

const classifyRegime = (annualVol: number): Regime => {
  if (annualVol < 0.50) return "calm";
  if (annualVol < 0.70) return "moderate";
  if (annualVol < 0.90) return "elevated";
  return "stress";
};

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

// ──────────────────────── Production-faithful helpers ────────────────────────

/**
 * Snap strike to grid toward spot, mirroring strikeGrid.snapHedgeStrike.
 */
const snapStrike = (params: {
  optionKind: "put" | "call";
  ideal: number;
  spot: number;
  triggerBoundary: number;
  gridStep: number;
}): number => {
  const { optionKind, ideal, spot, triggerBoundary, gridStep } = params;
  if (optionKind === "put") {
    let snapped = Math.ceil(ideal / gridStep) * gridStep;
    if (snapped > spot) snapped = Math.floor(spot / gridStep) * gridStep;
    if (snapped <= triggerBoundary) snapped = triggerBoundary + gridStep;
    return snapped;
  }
  let snapped = Math.floor(ideal / gridStep) * gridStep;
  if (snapped < spot) snapped = Math.ceil(spot / gridStep) * gridStep;
  if (snapped >= triggerBoundary) snapped = triggerBoundary - gridStep;
  return snapped;
};

/**
 * Vol-buffered hedge sizing, mirroring strikeGrid.applyVolBufferAndRound.
 */
const sizeHedge = (params: {
  payoutUsdc: number;
  entrySpot: number;
  triggerPct: number;
  hedgePct: number;
  volBuffer: number;
  granularity: number;
}): number => {
  const intrinsicPerBtc = params.entrySpot * (params.triggerPct - params.hedgePct);
  const baseBtc = params.payoutUsdc / intrinsicPerBtc;
  const buffered = baseBtc * params.volBuffer;
  return Math.ceil(buffered / params.granularity) * params.granularity;
};

const sampleHoldDays = (meanDays: number, maxDays: number): number => {
  const lambda = 1 / Math.max(0.5, meanDays);
  const u = Math.random();
  const sample = -Math.log(1 - u) / lambda;
  return Math.max(1, Math.min(maxDays, Math.round(sample)));
};

// ──────────────────────── Retained-TP simulation ────────────────────────

/**
 * Post-Foxify-exit, walk forward day-by-day applying stub TP rules
 * (rules 1+7+12+W1) on retained legs. Returns realized salvage.
 *
 * Inputs: leg cost, strike, entry IV, vs subsequent BTC path. Sells when
 *   - 4h to expiry (rule 1)
 *   - loser leg <20% of cost OR 4h post-trigger grace (rule 7)
 *   - hard floor <10% of cost (rule 12)
 *   - winner-side timecap 24h (W1 stub)
 *
 * Granularity: 1 day per check (engine resolution); production checks
 * every 60s but realized salvage closely tracks since rule 1 dominates
 * near expiry and rule W1 forces sell at 24h.
 */
const simulateRetainedTp = (params: {
  candles: Candle[];
  startIdx: number; // index of exit day (close or trigger)
  legs: Array<{
    kind: "put" | "call";
    strike: number;
    initialCostUsdc: number;
    role: "winner" | "loser" | "near_atm" | "stale";
    contractsBtc: number;
  }>;
  iv: number;
  tenorDaysRemaining: number;
  maxRetentionDays: number;
}): { totalSalvage: number; perLegSalvage: Array<{ kind: "put" | "call"; salvage: number; sellDay: number }> } => {
  const perLeg: Array<{ kind: "put" | "call"; salvage: number; sellDay: number }> = [];
  for (const leg of params.legs) {
    let sold = false;
    let salvage = 0;
    let sellDay = 0;
    for (let d = 0; d <= Math.min(params.maxRetentionDays, params.tenorDaysRemaining - 1); d++) {
      if (sold) break;
      const dayIdx = params.startIdx + d;
      if (dayIdx >= params.candles.length) {
        // Out of data: force sell at intrinsic.
        const lastCandle = params.candles[params.candles.length - 1];
        const intrinsic = leg.kind === "put"
          ? Math.max(0, leg.strike - lastCandle.close)
          : Math.max(0, lastCandle.close - leg.strike);
        salvage = intrinsic * leg.contractsBtc;
        sellDay = d;
        sold = true;
        break;
      }
      const spot = params.candles[dayIdx].close;
      const tDays = params.tenorDaysRemaining - d;
      const T = tDays / 365;
      const valuePerBtc = leg.kind === "put"
        ? bsPut(spot, leg.strike, T, RFR, params.iv)
        : bsCall(spot, leg.strike, T, RFR, params.iv);
      const value = valuePerBtc * leg.contractsBtc;

      // Rule 1 — time decay forced exit (assume <4h on the day before expiry,
      // i.e., the last day of remaining tenor)
      if (tDays <= 1) {
        salvage = value;
        sellDay = d;
        sold = true;
        break;
      }
      // Rule 12 — hard floor
      if (value < leg.initialCostUsdc * 0.10) {
        salvage = value;
        sellDay = d;
        sold = true;
        break;
      }
      // Rule 7 — loser floor + grace
      if (leg.role === "loser") {
        if (value < leg.initialCostUsdc * 0.20) {
          salvage = value;
          sellDay = d;
          sold = true;
          break;
        }
        if (d >= 1) {
          // Rule 7b grace: 4h post-trigger ≈ same day; engine grain is daily,
          // so day 1 fires
          salvage = value;
          sellDay = d;
          sold = true;
          break;
        }
      }
      // Rule W1 (stub) — winner / close-state legs sell at 24h ≈ day 1
      if (leg.role === "winner" || leg.role === "near_atm" || leg.role === "stale") {
        if (d >= 1) {
          salvage = value;
          sellDay = d;
          sold = true;
          break;
        }
      }
    }
    if (!sold) {
      // Reach end: assume sold at last-checked value
      salvage = 0;
    }
    perLeg.push({ kind: leg.kind, salvage, sellDay });
  }
  return {
    totalSalvage: perLeg.reduce((s, l) => s + l.salvage, 0),
    perLegSalvage: perLeg
  };
};

// ──────────────────────── Cover simulator ────────────────────────

const GRID_STEP_USDC = 200; // Bullish 2% cell default; cell-specific override below
const CONTRACT_GRANULARITY_BTC = 0.1;
const DEFAULT_VOL_BUFFERS: Record<Regime, number> = {
  calm: 1.0,
  moderate: 1.05,
  elevated: 1.10,
  stress: 1.15
};

const cellGridStep = (cellId: string): number => {
  // 2% / 5% routed Bullish ($200); 10% / 15% routed Deribit ($1000)
  if (/_2pct|_5pct/.test(cellId)) return 200;
  return 1000;
};

export const simulateCover = (params: {
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
  startIdx: number;
  scenario: Scenario;
  /** Random source override for reproducibility (default Math.random). */
  rand?: () => number;
}): CoverResult | null => {
  const { candles, vols, regimes, startIdx, scenario } = params;
  const cell = scenario.cell;
  const tenorDays = scenario.tenorDays ?? 14;
  const holdMean = scenario.holdMeanDays ?? 3;
  const ladderProb = scenario.ladderProb ?? 0.6;
  const volBuffers = { ...DEFAULT_VOL_BUFFERS, ...(scenario.volBuffers ?? {}) };

  if (startIdx + tenorDays >= candles.length) return null;

  const entryDay = candles[startIdx];
  const entrySpot = entryDay.close;
  // Calibration (2026-05-16): separate realized vol (regime
  // classification + trigger detection) from implied vol (BS hedge
  // cost). Realized vol historically over-states moderate/elevated
  // hedge cost by 20-40%; implied vol from regime IV table is
  // smoother and matches what the option market actually charges.
  // Tracked in services/api/scripts/backtest/lib/regimeIv.ts.
  const regime = regimes[entryDay.date] ?? "moderate";
  const iv = getRegimeIv(regime);

  // Daily premium: regime overlay or cell base
  const dailyPremium = scenario.regimePremium?.[regime] ?? cell.dailyPremiumUsdc;

  // Sizing + strikes
  const gridStep = cellGridStep(cell.cellId);
  const triggerLow = entrySpot * (1 - cell.triggerPct);
  const triggerHigh = entrySpot * (1 + cell.triggerPct);
  const idealPut = entrySpot * (1 - cell.hedgePct);
  const idealCall = entrySpot * (1 + cell.hedgePct);
  const putStrike = snapStrike({ optionKind: "put", ideal: idealPut, spot: entrySpot, triggerBoundary: triggerLow, gridStep });
  const callStrike = snapStrike({ optionKind: "call", ideal: idealCall, spot: entrySpot, triggerBoundary: triggerHigh, gridStep });

  const contractsBtc = sizeHedge({
    payoutUsdc: cell.payoutUsdc,
    entrySpot,
    triggerPct: cell.triggerPct,
    hedgePct: cell.hedgePct,
    volBuffer: volBuffers[regime] ?? 1.0,
    granularity: CONTRACT_GRANULARITY_BTC
  });

  // Hedge cost (BS at entry)
  const T = tenorDays / 365;
  const putCostPerBtc = bsPut(entrySpot, putStrike, T, RFR, iv);
  const callCostPerBtc = bsCall(entrySpot, callStrike, T, RFR, iv);
  const hedgeCost = (putCostPerBtc + callCostPerBtc) * contractsBtc;

  // Walk forward, detect trigger
  const heldDays = sampleHoldDays(holdMean, tenorDays);
  let triggered = false;
  let triggerDay: number | null = null;
  let triggerSpot: number | null = null;
  let exitIdx = startIdx + heldDays;
  for (let d = 1; d <= heldDays; d++) {
    const day = candles[startIdx + d];
    if (day.low <= triggerLow) {
      triggered = true;
      triggerDay = d;
      triggerSpot = triggerLow;
      exitIdx = startIdx + d;
      break;
    }
    if (day.high >= triggerHigh) {
      triggered = true;
      triggerDay = d;
      triggerSpot = triggerHigh;
      exitIdx = startIdx + d;
      break;
    }
  }
  const actualHeld = triggered ? triggerDay! : heldDays;
  const tenorRemainingDays = tenorDays - actualHeld;

  // Determine roles for retained-TP simulation
  type Role = "winner" | "loser" | "near_atm" | "stale";
  let putRole: Role;
  let callRole: Role;
  if (triggered) {
    if (triggerSpot! < entrySpot) {
      putRole = "winner";
      callRole = "loser";
    } else {
      putRole = "loser";
      callRole = "winner";
    }
  } else {
    // Foxify close path: spot at exit
    const exitSpot = candles[exitIdx].close;
    const putDist = Math.abs(exitSpot - putStrike) / exitSpot;
    const callDist = Math.abs(exitSpot - callStrike) / exitSpot;
    putRole = exitSpot > putStrike && putDist > 0.005 ? "stale" : "near_atm";
    callRole = exitSpot < callStrike && callDist > 0.005 ? "stale" : "near_atm";
  }

  // Retained TP simulation (start from exit day)
  const retainedSim = simulateRetainedTp({
    candles,
    startIdx: exitIdx,
    legs: [
      {
        kind: "put",
        strike: putStrike,
        initialCostUsdc: putCostPerBtc * contractsBtc,
        role: putRole,
        contractsBtc
      },
      {
        kind: "call",
        strike: callStrike,
        initialCostUsdc: callCostPerBtc * contractsBtc,
        role: callRole,
        contractsBtc
      }
    ],
    iv,
    tenorDaysRemaining: tenorRemainingDays,
    maxRetentionDays: Math.min(7, tenorRemainingDays)
  });
  const retainedSalvage = retainedSim.totalSalvage;

  // Ladder netting: probabilistic. If ladder fires, savings = average
  // hedge cost / 2 (one side repurposed) since match probability per
  // side is ~50% on price drift.
  const r = (params.rand ?? Math.random)();
  const laddered = r < ladderProb;
  const ladderSavings = laddered ? hedgeCost * 0.4 : 0; // 40% avg savings when fires

  // Premium = dailyPremium × actualHeld
  const premium = dailyPremium * actualHeld;
  const payout = triggered ? cell.payoutUsdc : 0;
  const atticusNet = premium - hedgeCost + retainedSalvage - payout + ladderSavings;

  return {
    date: entryDay.date,
    regime,
    entrySpot,
    iv,
    dailyPremium,
    daysHeld: actualHeld,
    triggered,
    triggerDay,
    triggerSpot,
    hedgeCost,
    premium,
    payout,
    retainedSalvage,
    laddered,
    ladderSavings,
    atticusNet
  };
};

// ──────────────────────── Stats ────────────────────────

const summarize = (results: CoverResult[]): ScenarioStats => {
  const pnls = results.map((r) => r.atticusNet).sort((a, b) => a - b);
  const n = pnls.length;
  return {
    count: n,
    avg: pnls.reduce((s, x) => s + x, 0) / Math.max(1, n),
    median: n > 0 ? pnls[Math.floor(n / 2)] : 0,
    p10: n > 0 ? pnls[Math.floor(n * 0.1)] : 0,
    p90: n > 0 ? pnls[Math.floor(n * 0.9)] : 0,
    worst: n > 0 ? pnls[0] : 0,
    best: n > 0 ? pnls[n - 1] : 0,
    pctProfitable: results.filter((r) => r.atticusNet > 0).length / Math.max(1, n),
    triggerRate: results.filter((r) => r.triggered).length / Math.max(1, n),
    avgDaysHeld: results.reduce((s, r) => s + r.daysHeld, 0) / Math.max(1, n),
    avgPremium: results.reduce((s, r) => s + r.premium, 0) / Math.max(1, n),
    avgHedgeCost: results.reduce((s, r) => s + r.hedgeCost, 0) / Math.max(1, n),
    avgRetainedSalvage: results.reduce((s, r) => s + r.retainedSalvage, 0) / Math.max(1, n),
    avgLadderSavings: results.reduce((s, r) => s + r.ladderSavings, 0) / Math.max(1, n),
    totalPnL: pnls.reduce((s, x) => s + x, 0)
  };
};

export const summarizeByRegime = (
  results: CoverResult[]
): Record<Regime, ScenarioStats> => {
  const groups: Record<Regime, CoverResult[]> = {
    calm: [], moderate: [], elevated: [], stress: []
  };
  for (const r of results) groups[r.regime].push(r);
  return {
    calm: summarize(groups.calm),
    moderate: summarize(groups.moderate),
    elevated: summarize(groups.elevated),
    stress: summarize(groups.stress)
  };
};

export const summarizeAll = summarize;

// ──────────────────────── Scenario runner ────────────────────────

export const runScenario = async (params: {
  candles: Candle[];
  vols: Record<string, number>;
  regimes: Record<string, Regime>;
  scenario: Scenario;
  iterPerEntry?: number;
}): Promise<{ scenario: Scenario; results: CoverResult[]; perRegime: Record<Regime, ScenarioStats>; total: ScenarioStats }> => {
  const { candles, vols, regimes, scenario } = params;
  const tenorDays = scenario.tenorDays ?? 14;
  const iter = params.iterPerEntry ?? 3;
  const results: CoverResult[] = [];
  for (let i = 30; i < candles.length - tenorDays - 1; i++) {
    for (let k = 0; k < iter; k++) {
      const r = simulateCover({ candles, vols, regimes, startIdx: i, scenario });
      if (r) results.push(r);
    }
  }
  const perRegime = summarizeByRegime(results);
  const total = summarize(results);
  return { scenario, results, perRegime, total };
};
