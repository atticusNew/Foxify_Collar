/**
 * Cell sweep — runs runFoxifyDurationMc across a grid of cell parameters
 * × regimes × auto-close thresholds and ranks the survivors per regime.
 *
 * Search space (configurable):
 *   - strike moneyness:      ATM, -1% OTM, -2% OTM, -3% OTM, -5% OTM (5)
 *   - tenor days:            1, 2, 3, 5, 7 (5)
 *   - notional:              25k, 50k, 100k (3)
 *   - trigger %:             0.02, 0.03, 0.04, 0.05 (4)
 *   - auto-close pnl %:      0.20, 0.30, 0.50, 1.00 (4)
 *   - regime:                calm, moderate, elevated, stress (4)
 *   = 4,800 unique cell-x-regime sims per default sweep
 *
 * Each cell is evaluated PER REGIME — a cell's verdict can differ across
 * regimes (e.g. profitable in elevated, negative in calm).
 *
 * Selection criteria per regime (in order):
 *   1. mean Foxify net per pair → target $200-300 (user spec)
 *   2. pct profitable >= 60% (consistency)
 *   3. lower capital ratio at equal expected net (capital efficiency)
 *   4. smaller p5 loss (tail safety)
 *
 * Output: per-regime ranked list of top-N cells, plus full result matrix
 * for inspection. Persisted to two_sided_cell_sweep_run + _result tables.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { runFoxifyDurationMc, type FoxifyDurationMcResult } from "./foxifyDurationMc";
import type { Regime } from "./featureFlag";
import { getRegimeCalibration } from "./regimeCalibration";

export type CellCandidate = {
  /** Synthetic ID encoding the parameters. */
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  strikeMoneynessPct: number; // 0 = ATM, -0.05 = 5% OTM, +0.02 = 2% ITM
  tenorDays: number;
  /** Inferred contracts per leg from notional and spot. */
  contractsBtc: number;
};

export type SweepConfig = {
  spot: number;
  notionals?: number[];
  triggers?: number[];
  strikeMoneyness?: number[];
  tenors?: number[];
  autoClosePnlPcts?: number[];
  /** Default $250 ≈ Foxify target. Use 1e9 to disable absolute trigger. */
  autoCloseAbsoluteUsdcs?: number[];
  /** Hedge cost ALWAYS pulled from priceOption (real bids) — but for sweep
   * we synthesize the cost from BS at current spot × calibration markup × 2 (legs)
   * because actual chain data isn't keyed by these synthetic strikes. The
   * realism multiplier is also synthesized from calibration. */
  syntheticRealismByRegime?: Record<Regime, number>;
  nPaths?: number;
};

const DEFAULT_NOTIONALS = [25_000, 50_000, 100_000];
const DEFAULT_TRIGGERS = [0.02, 0.03, 0.04, 0.05];
const DEFAULT_STRIKE_MONEYNESS = [0, -0.01, -0.02, -0.03, -0.05]; // ATM, OTM
const DEFAULT_TENORS = [1, 2, 3, 5, 7];
const DEFAULT_AUTO_CLOSE_PCTS = [0.20, 0.30, 0.50, 1.00];
const DEFAULT_AUTO_CLOSE_ABS = [200, 250, 300]; // user target $200-300

const REGIMES: Regime[] = ["calm", "moderate", "elevated", "stress"];

const STRIKE_GRID_USDC = 1000;

// Helper: snap to $1k strike grid
const snapStrike = (raw: number): number => Math.round(raw / STRIKE_GRID_USDC) * STRIKE_GRID_USDC;

// Helper: synthesize cellId from parameters
const buildCellId = (params: CellCandidate, autoCloseUsdc: number, autoClosePct: number): string => {
  const kNotional = `${params.notionalUsdcPerLeg / 1000}k`;
  const triggerStr = `${(params.triggerPct * 100).toFixed(0)}pct`;
  const moneyStr = params.strikeMoneynessPct === 0 ? "atm"
    : params.strikeMoneynessPct < 0 ? `${Math.abs(params.strikeMoneynessPct * 100).toFixed(0)}otm`
    : `${(params.strikeMoneynessPct * 100).toFixed(0)}itm`;
  return `sweep_${kNotional}_${triggerStr}_${moneyStr}_${params.tenorDays}d_tp${(autoClosePct * 100).toFixed(0)}_abs${autoCloseUsdc}`;
};

export type CellSweepResult = {
  cellId: string;
  regime: Regime;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  strikeMoneynessPct: number;
  tenorDays: number;
  autoClosePnlPct: number;
  autoCloseAbsoluteUsdc: number;
  contractsBtc: number;
  putStrike: number;
  callStrike: number;
  sigmaUsed: number;
  syntheticHedgeCostUsdc: number;
  mc: FoxifyDurationMcResult;
};

export type RegimeRanking = {
  regime: Regime;
  topCells: Array<{
    cellId: string;
    mean_foxify_net_usdc: number;
    pct_profitable: number;
    p5_foxify_net_usdc: number;
    capital_per_pair: number;
    pnl_per_dollar_at_risk: number;
    auto_close_pct: number;
    trigger_pct: number;
    expiry_pct: number;
    params: {
      notional: number;
      trigger: number;
      moneyness: number;
      tenor_days: number;
      auto_close_pnl_pct: number;
      auto_close_absolute_usdc: number;
    };
  }>;
  /** Number of cells that passed both Foxify-target ($200-300) and consistency (>=60% profitable) checks. */
  cellsMatchingFoxifyTarget: number;
  /** All cells evaluated for this regime (for full inspection). */
  totalCellsEvaluated: number;
};

export type FullSweepReport = {
  runId: string;
  startedAt: string;
  completedAt: string;
  totalSims: number;
  spot: number;
  calibrationUsed: Record<Regime, { sigma: number; markup: number; sigmaSource: string; markupSource: string }>;
  rankings: Record<Regime, RegimeRanking>;
  resultCount: number;
};

// ─────────────────────────── DB schema ───────────────────────────

export const ensureCellSweepSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_cell_sweep_run (
      run_id TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      total_sims INTEGER NOT NULL,
      spot NUMERIC(12,2) NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      calibration_json TEXT NOT NULL,
      rankings_json TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_cell_sweep_result (
      result_id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES two_sided_cell_sweep_run(run_id),
      cell_id TEXT NOT NULL,
      regime TEXT NOT NULL,
      notional_usdc_per_leg NUMERIC(12,2) NOT NULL,
      trigger_pct NUMERIC(6,4) NOT NULL,
      strike_moneyness_pct NUMERIC(6,4) NOT NULL,
      tenor_days NUMERIC(5,2) NOT NULL,
      auto_close_pnl_pct NUMERIC(6,4) NOT NULL,
      auto_close_absolute_usdc NUMERIC(12,2) NOT NULL,
      contracts_btc NUMERIC(10,6) NOT NULL,
      put_strike NUMERIC(12,2) NOT NULL,
      call_strike NUMERIC(12,2) NOT NULL,
      sigma_used NUMERIC(8,5) NOT NULL,
      synthetic_hedge_cost_usdc NUMERIC(12,2) NOT NULL,
      mean_foxify_net_usdc NUMERIC(12,2) NOT NULL,
      median_foxify_net_usdc NUMERIC(12,2) NOT NULL,
      p5_foxify_net_usdc NUMERIC(12,2) NOT NULL,
      p95_foxify_net_usdc NUMERIC(12,2) NOT NULL,
      pct_profitable NUMERIC(6,4) NOT NULL,
      auto_close_pct NUMERIC(6,4) NOT NULL,
      trigger_pct_outcome NUMERIC(6,4) NOT NULL,
      expiry_pct NUMERIC(6,4) NOT NULL,
      n_paths INTEGER NOT NULL
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_cell_sweep_result_run ON two_sided_cell_sweep_result(run_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_cell_sweep_result_regime_net ON two_sided_cell_sweep_result(regime, mean_foxify_net_usdc DESC);`);
  } catch { /* pg-mem may not support */ }
};

// ─────────────────────────── Synthesis ───────────────────────────

/**
 * Build the list of cell × regime × auto-close combinations to evaluate.
 */
const buildSearchGrid = (spot: number, config: SweepConfig): CellCandidate[] => {
  const notionals = config.notionals ?? DEFAULT_NOTIONALS;
  const triggers = config.triggers ?? DEFAULT_TRIGGERS;
  const moneyness = config.strikeMoneyness ?? DEFAULT_STRIKE_MONEYNESS;
  const tenors = config.tenors ?? DEFAULT_TENORS;
  const candidates: CellCandidate[] = [];
  for (const notional of notionals) {
    const contractsBtc = +(notional / spot).toFixed(3);
    for (const trigger of triggers) {
      for (const m of moneyness) {
        for (const tenor of tenors) {
          candidates.push({
            cellId: `${notional / 1000}k_${(trigger * 100).toFixed(0)}pct_${m === 0 ? "atm" : `${Math.abs(m * 100).toFixed(0)}otm`}_${tenor}d`,
            notionalUsdcPerLeg: notional,
            triggerPct: trigger,
            strikeMoneynessPct: m,
            tenorDays: tenor,
            contractsBtc
          });
        }
      }
    }
  }
  return candidates;
};

/**
 * For a sweep cell, synthesize the hedge cost: pure BS at current spot
 * × regime markup × 2 legs × bid_haircut. Real activations will use live
 * venue asks but for sweep purposes this is a defensible proxy.
 */
import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";
import { RISK_FREE_RATE } from "./optionPricing";

const synthesizeHedgeCost = (
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  tenorDays: number,
  sigma: number,
  regimeMarkup: number
): number => {
  const T = tenorDays / 365;
  const bsP = Math.max(0, bsPut(spot, putStrike, T, RISK_FREE_RATE, sigma));
  const bsC = Math.max(0, bsCall(spot, callStrike, T, RISK_FREE_RATE, sigma));
  return (bsP + bsC) * contractsBtc * regimeMarkup;
};

// ─────────────────────────── Sweep ───────────────────────────

export const runFullCellSweep = async (
  pool: Pool,
  config: SweepConfig,
  opts: {
    progressLog?: (msg: string) => void;
    persistResults?: boolean;
  } = {}
): Promise<FullSweepReport> => {
  const log = opts.progressLog ?? (() => {});
  const persistResults = opts.persistResults !== false;
  const runId = randomUUID();
  const startedAt = new Date();
  const candidates = buildSearchGrid(config.spot, config);
  const autoClosePcts = config.autoClosePnlPcts ?? DEFAULT_AUTO_CLOSE_PCTS;
  const autoCloseAbs = config.autoCloseAbsoluteUsdcs ?? DEFAULT_AUTO_CLOSE_ABS;
  const totalSims = candidates.length * REGIMES.length * autoClosePcts.length * autoCloseAbs.length;
  const calibration = await getRegimeCalibration(pool);

  log(`sweep runId=${runId} cells=${candidates.length} regimes=${REGIMES.length} auto-close-combos=${autoClosePcts.length * autoCloseAbs.length} total_sims=${totalSims}`);

  if (persistResults) {
    await pool.query(
      `INSERT INTO two_sided_cell_sweep_run (run_id, started_at, total_sims, spot, calibration_json) VALUES ($1::text, $2::timestamptz, $3, $4, $5)`,
      [runId, startedAt.toISOString(), totalSims, config.spot,
       JSON.stringify(Object.fromEntries(REGIMES.map((r) => [r, calibration[r]])))]
    );
  }

  const allResults: CellSweepResult[] = [];
  let simIdx = 0;

  for (const candidate of candidates) {
    for (const regime of REGIMES) {
      const cal = calibration[regime];
      const sigma = cal.sigma;
      const markup = cal.markup;
      const realism = config.syntheticRealismByRegime?.[regime] ?? 0.80;
      // Snap strikes — put goes UP (more ITM for moneyness>0), call goes DOWN
      const rawPut = config.spot * (1 - candidate.strikeMoneynessPct);
      const rawCall = config.spot * (1 + candidate.strikeMoneynessPct);
      const putStrike = snapStrike(rawPut);
      const callStrike = snapStrike(rawCall);
      const hedgeCost = synthesizeHedgeCost(
        config.spot, putStrike, callStrike, candidate.contractsBtc,
        candidate.tenorDays, sigma, markup
      );

      for (const autoClosePct of autoClosePcts) {
        for (const autoCloseAbsUsdc of autoCloseAbs) {
          simIdx++;
          if (simIdx % 200 === 0) log(`progress: ${simIdx}/${totalSims} sims complete`);
          const cellId = buildCellId(candidate, autoCloseAbsUsdc, autoClosePct);
          const mc = await runFoxifyDurationMc({
            cellId,
            spot: config.spot,
            hedgeCostUsdc: hedgeCost,
            putStrike,
            callStrike,
            tenorDays: candidate.tenorDays,
            triggerPctDown: candidate.triggerPct,
            triggerPctUp: candidate.triggerPct,
            regime,
            sigmaAnnual: sigma,
            contractsBtc: candidate.contractsBtc,
            autoClosePnlPct: autoClosePct,
            autoCloseAbsoluteUsdc: autoCloseAbsUsdc,
            salvageRealismMultiplier: realism,
            nPaths: config.nPaths ?? 500 // smaller per-sim for sweep speed
          });
          const result: CellSweepResult = {
            cellId, regime,
            notionalUsdcPerLeg: candidate.notionalUsdcPerLeg,
            triggerPct: candidate.triggerPct,
            strikeMoneynessPct: candidate.strikeMoneynessPct,
            tenorDays: candidate.tenorDays,
            autoClosePnlPct: autoClosePct,
            autoCloseAbsoluteUsdc: autoCloseAbsUsdc,
            contractsBtc: candidate.contractsBtc,
            putStrike, callStrike,
            sigmaUsed: sigma,
            syntheticHedgeCostUsdc: hedgeCost,
            mc
          };
          allResults.push(result);
        }
      }
    }
  }

  // Persist each result row
  if (persistResults) {
    for (const r of allResults) {
      await pool.query(
        `INSERT INTO two_sided_cell_sweep_result (
          run_id, cell_id, regime, notional_usdc_per_leg, trigger_pct,
          strike_moneyness_pct, tenor_days, auto_close_pnl_pct, auto_close_absolute_usdc,
          contracts_btc, put_strike, call_strike, sigma_used, synthetic_hedge_cost_usdc,
          mean_foxify_net_usdc, median_foxify_net_usdc, p5_foxify_net_usdc, p95_foxify_net_usdc,
          pct_profitable, auto_close_pct, trigger_pct_outcome, expiry_pct, n_paths
        ) VALUES (
          $1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
          $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric,
          $15::numeric, $16::numeric, $17::numeric, $18::numeric,
          $19::numeric, $20::numeric, $21::numeric, $22::numeric, $23
        )`,
        [
          runId, r.cellId, r.regime, r.notionalUsdcPerLeg, r.triggerPct,
          r.strikeMoneynessPct, r.tenorDays, r.autoClosePnlPct, r.autoCloseAbsoluteUsdc,
          r.contractsBtc, r.putStrike, r.callStrike, r.sigmaUsed, r.syntheticHedgeCostUsdc,
          r.mc.meanFoxifyNetUsdc, r.mc.medianFoxifyNetUsdc, r.mc.p5FoxifyNetUsdc, r.mc.p95FoxifyNetUsdc,
          r.mc.pctProfitable, r.mc.exitDistribution.foxify_auto_close,
          r.mc.exitDistribution.trigger_peak, r.mc.exitDistribution.expiry, r.mc.nPaths
        ]
      );
    }
  }

  // Rank per regime
  const rankings: Record<Regime, RegimeRanking> = {} as Record<Regime, RegimeRanking>;
  for (const regime of REGIMES) {
    const regimeResults = allResults.filter((r) => r.regime === regime);
    // Filter: must satisfy primary (net >= $200) AND secondary (pct >= 60%)
    const meeting = regimeResults.filter((r) =>
      r.mc.meanFoxifyNetUsdc >= 200 && r.mc.pctProfitable >= 0.60
    );
    // Sort by mean net descending, tiebreak by lower capital, then higher p5
    const ranked = [...regimeResults].sort((a, b) => {
      if (Math.abs(a.mc.meanFoxifyNetUsdc - b.mc.meanFoxifyNetUsdc) > 5) {
        return b.mc.meanFoxifyNetUsdc - a.mc.meanFoxifyNetUsdc;
      }
      if (Math.abs(a.syntheticHedgeCostUsdc - b.syntheticHedgeCostUsdc) > 5) {
        return a.syntheticHedgeCostUsdc - b.syntheticHedgeCostUsdc;
      }
      return b.mc.p5FoxifyNetUsdc - a.mc.p5FoxifyNetUsdc;
    });
    const top = ranked.slice(0, 10).map((r) => ({
      cellId: r.cellId,
      mean_foxify_net_usdc: +r.mc.meanFoxifyNetUsdc.toFixed(2),
      pct_profitable: +r.mc.pctProfitable.toFixed(4),
      p5_foxify_net_usdc: +r.mc.p5FoxifyNetUsdc.toFixed(2),
      capital_per_pair: +r.syntheticHedgeCostUsdc.toFixed(2),
      pnl_per_dollar_at_risk: +(r.mc.meanFoxifyNetUsdc / r.syntheticHedgeCostUsdc).toFixed(4),
      auto_close_pct: +r.mc.exitDistribution.foxify_auto_close.toFixed(4),
      trigger_pct: +r.mc.exitDistribution.trigger_peak.toFixed(4),
      expiry_pct: +r.mc.exitDistribution.expiry.toFixed(4),
      params: {
        notional: r.notionalUsdcPerLeg,
        trigger: r.triggerPct,
        moneyness: r.strikeMoneynessPct,
        tenor_days: r.tenorDays,
        auto_close_pnl_pct: r.autoClosePnlPct,
        auto_close_absolute_usdc: r.autoCloseAbsoluteUsdc
      }
    }));
    rankings[regime] = {
      regime,
      topCells: top,
      cellsMatchingFoxifyTarget: meeting.length,
      totalCellsEvaluated: regimeResults.length
    };
  }

  const completedAt = new Date();
  if (persistResults) {
    await pool.query(
      `UPDATE two_sided_cell_sweep_run SET completed_at = $1::timestamptz, result_count = $2, rankings_json = $3 WHERE run_id = $4::text`,
      [completedAt.toISOString(), allResults.length, JSON.stringify(rankings), runId]
    );
  }
  log(`sweep complete: ${allResults.length} results, persisted=${persistResults}, runId=${runId}`);
  return {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    totalSims,
    spot: config.spot,
    calibrationUsed: Object.fromEntries(REGIMES.map((r) => [r, {
      sigma: calibration[r].sigma,
      markup: calibration[r].markup,
      sigmaSource: calibration[r].sigmaSource,
      markupSource: calibration[r].markupSource
    }])) as Record<Regime, { sigma: number; markup: number; sigmaSource: string; markupSource: string }>,
    rankings,
    resultCount: allResults.length
  };
};

// ─────────────────────────── Readers ───────────────────────────

export const getLatestSweepRun = async (pool: Pool | PoolClient): Promise<FullSweepReport | null> => {
  const r = await pool.query<{
    run_id: string; started_at: string; completed_at: string | null;
    total_sims: number; spot: string; result_count: number;
    calibration_json: string; rankings_json: string | null;
  }>(`SELECT * FROM two_sided_cell_sweep_run ORDER BY started_at DESC LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!row.completed_at || !row.rankings_json) return null;
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    totalSims: row.total_sims,
    spot: Number(row.spot),
    calibrationUsed: JSON.parse(row.calibration_json),
    rankings: JSON.parse(row.rankings_json),
    resultCount: row.result_count
  };
};
