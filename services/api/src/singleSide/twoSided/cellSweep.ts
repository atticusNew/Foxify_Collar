/**
 * Cell sweep — runs runFoxifyDurationMc across a grid of cell parameters
 * × regimes × auto-close thresholds and ranks the survivors per regime.
 *
 * REAL-PRICING REWRITE (2026-05-30):
 *   Cost and salvage realism now come from REAL chain data via priceOption.
 *   No more BS × synthetic_markup. For cells where chain has no quote at
 *   the candidate strike/tenor → cell is marked chain_unavailable and
 *   EXCLUDED from rankings (no synthetic backfill).
 *
 *   Non-current regimes can only ever produce ESTIMATE results because we
 *   only have today's chain. Those results are tagged "estimate" and
 *   ineligible for the rankings_actionable view.
 *
 * Search space (configurable):
 *   - strike moneyness:      ATM, -1% OTM, -2% OTM, -3% OTM, -5% OTM (5)
 *   - tenor days:            1, 2, 3, 5, 7 (5)
 *   - notional:              25k, 50k, 100k (3)
 *   - trigger %:             0.02, 0.03, 0.04, 0.05 (4)
 *   - auto-close pnl %:      0.20, 0.30, 0.50, 1.00 (4)
 *   - regime:                calm, moderate, elevated, stress (4) — non-current = estimate
 *   = 4,800 unique cell-x-regime sims per default sweep
 *
 * Cell selection per regime (only from REAL results):
 *   1. mean Foxify net per pair → target $200-300 (user spec)
 *   2. pct profitable >= 60% (consistency)
 *   3. lower capital ratio at equal expected net
 *   4. smaller p5 loss
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { runFoxifyDurationMc, type FoxifyDurationMcResult } from "./foxifyDurationMc";
import type { Regime } from "./featureFlag";
import { classifyRegime } from "./featureFlag";
import { getRegimeCalibration } from "./regimeCalibration";
import { priceOption } from "./optionPricing";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";
import { load5MinBars } from "../../../scripts/backtest/singleSide/monteCarloEngine";

export type CellCandidate = {
  cellId: string;
  notionalUsdcPerLeg: number;
  triggerPct: number;
  strikeMoneynessPct: number;
  tenorDays: number;
  contractsBtc: number;
};

export type SweepVenue = "auto" | "bullish" | "deribit";

export type SweepConfig = {
  spot: number;
  notionals?: number[];
  triggers?: number[];
  strikeMoneyness?: number[];
  tenors?: number[];
  autoClosePnlPcts?: number[];
  autoCloseAbsoluteUsdcs?: number[];
  nPaths?: number;
  /**
   * Venue preference for price lookups:
   *   "auto"    → priceOption picks best venue (exact_symbol → fuzzy → bs)
   *   "bullish" → only consider Bullish quotes for cost + salvage
   *   "deribit" → only consider Deribit quotes
   *
   * Use "bullish" or "deribit" to compare venue-specific economics.
   */
  venue?: SweepVenue;
  /** Liquid chain cache for real price lookups. REQUIRED. */
  liquidChainCache: LiquidChainCache;
  /** DvolService for live IV. Optional but recommended. */
  dvolService?: DvolService | null;
  /**
   * Current regime (typically classifyRegime(currentDvol)). Cells in this
   * regime get rated "real" if chain has quotes; cells in other regimes
   * are always "estimate" (we can't simulate other-regime conditions
   * without historical chain data).
   */
  currentRegime: Regime;
};

const DEFAULT_NOTIONALS = [25_000, 50_000, 100_000];
const DEFAULT_TRIGGERS = [0.02, 0.03, 0.04, 0.05];
const DEFAULT_STRIKE_MONEYNESS = [0, -0.01, -0.02, -0.03, -0.05];
const DEFAULT_TENORS = [1, 2, 3, 5, 7];
const DEFAULT_AUTO_CLOSE_PCTS = [0.20, 0.30, 0.50, 1.00];
const DEFAULT_AUTO_CLOSE_ABS = [200, 250, 300];

const REGIMES: Regime[] = ["calm", "moderate", "elevated", "stress"];
const STRIKE_GRID_USDC = 1000;
const snapStrike = (raw: number): number => Math.round(raw / STRIKE_GRID_USDC) * STRIKE_GRID_USDC;

const buildCellId = (params: CellCandidate, autoCloseUsdc: number, autoClosePct: number): string => {
  const kNotional = `${params.notionalUsdcPerLeg / 1000}k`;
  const triggerStr = `${(params.triggerPct * 100).toFixed(0)}pct`;
  const moneyStr = params.strikeMoneynessPct === 0 ? "atm"
    : params.strikeMoneynessPct < 0 ? `${Math.abs(params.strikeMoneynessPct * 100).toFixed(0)}otm`
    : `${(params.strikeMoneynessPct * 100).toFixed(0)}itm`;
  return `sweep_${kNotional}_${triggerStr}_${moneyStr}_${params.tenorDays}d_tp${(autoClosePct * 100).toFixed(0)}_abs${autoCloseUsdc}`;
};

/** What the cost came from. */
export type CostSource = "real_ask_bullish" | "real_ask_deribit" | "chain_unavailable";
/** What the salvage realism came from. */
export type SalvageSource = "real_bid_bullish" | "real_bid_deribit" | "chain_unavailable";

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
  /** Cost in USDC for one pair (both legs). */
  hedgeCostUsdc: number;
  /** Source of cost: which venue's ask we used, or chain_unavailable. */
  costSourcePut: CostSource;
  costSourceCall: CostSource;
  /** Realism multiplier used in MC (real_bid / bs_at_spot). */
  salvageRealismMultiplier: number;
  salvageSourcePut: SalvageSource;
  salvageSourceCall: SalvageSource;
  /** Whether this result is REAL (current regime + chain available) or ESTIMATE. */
  resultTier: "real" | "estimate" | "chain_unavailable";
  mc: FoxifyDurationMcResult | null;
};

export type RankedCell = {
  cellId: string;
  mean_foxify_net_usdc: number;
  pct_profitable: number;
  p5_foxify_net_usdc: number;
  capital_per_pair: number;
  pnl_per_dollar_at_risk: number;
  auto_close_pct: number;
  trigger_pct: number;
  expiry_pct: number;
  cost_source_put: CostSource;
  cost_source_call: CostSource;
  salvage_source_put: SalvageSource;
  salvage_source_call: SalvageSource;
  result_tier: "real" | "estimate";
  params: {
    notional: number;
    trigger: number;
    moneyness: number;
    tenor_days: number;
    auto_close_pnl_pct: number;
    auto_close_absolute_usdc: number;
    put_strike: number;
    call_strike: number;
  };
};

export type RegimeRanking = {
  regime: Regime;
  result_tier: "real" | "estimate" | "chain_unavailable";
  /** Cells where chain had quotes (cost + salvage both real). */
  cellsWithChainData: number;
  /** Cells skipped because no chain quote. */
  cellsSkippedNoChain: number;
  /** Cells passing Foxify target ($200-300 net, >= 60% profitable). */
  cellsMatchingFoxifyTarget: number;
  /** Top-10 cells ranked by mean net. */
  topCells: RankedCell[];
  totalCellsEvaluated: number;
};

export type FullSweepReport = {
  runId: string;
  startedAt: string;
  completedAt: string;
  totalSims: number;
  spot: number;
  currentRegime: Regime;
  venue: SweepVenue;
  calibrationUsed: Record<Regime, { sigma: number; markup: number; sigmaSource: string; markupSource: string }>;
  rankings: Record<Regime, RegimeRanking>;
  resultCount: number;
};

// ─────────────────────────── DB schema ───────────────────────────

export const ensureCellSweepSchema = async (pool: Pool): Promise<void> => {
  // 1. Base table CREATE (no-op if exists)
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
      hedge_cost_usdc NUMERIC(12,2) NOT NULL
    );
  `);

  // 2. Idempotent ADD COLUMN migrations (handle tables created by prior schemas).
  //    Each runs independently with its own try/catch so one missing column
  //    doesn't block the rest. Postgres ADD COLUMN IF NOT EXISTS is safe.
  const additions: Array<{ table: string; column: string; definition: string }> = [
    // _run table additions (post-2026-05-31)
    { table: "two_sided_cell_sweep_run", column: "current_regime", definition: "TEXT" },
    { table: "two_sided_cell_sweep_run", column: "venue", definition: "TEXT" },
    // _result table additions
    { table: "two_sided_cell_sweep_result", column: "result_tier", definition: "TEXT NOT NULL DEFAULT 'estimate'" },
    { table: "two_sided_cell_sweep_result", column: "cost_source_put", definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { table: "two_sided_cell_sweep_result", column: "cost_source_call", definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { table: "two_sided_cell_sweep_result", column: "salvage_realism_multiplier", definition: "NUMERIC(6,4) NOT NULL DEFAULT 0" },
    { table: "two_sided_cell_sweep_result", column: "salvage_source_put", definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { table: "two_sided_cell_sweep_result", column: "salvage_source_call", definition: "TEXT NOT NULL DEFAULT 'unknown'" },
    { table: "two_sided_cell_sweep_result", column: "mean_foxify_net_usdc", definition: "NUMERIC(12,2)" },
    { table: "two_sided_cell_sweep_result", column: "median_foxify_net_usdc", definition: "NUMERIC(12,2)" },
    { table: "two_sided_cell_sweep_result", column: "p5_foxify_net_usdc", definition: "NUMERIC(12,2)" },
    { table: "two_sided_cell_sweep_result", column: "p95_foxify_net_usdc", definition: "NUMERIC(12,2)" },
    { table: "two_sided_cell_sweep_result", column: "pct_profitable", definition: "NUMERIC(6,4)" },
    { table: "two_sided_cell_sweep_result", column: "auto_close_pct", definition: "NUMERIC(6,4)" },
    { table: "two_sided_cell_sweep_result", column: "trigger_pct_outcome", definition: "NUMERIC(6,4)" },
    { table: "two_sided_cell_sweep_result", column: "expiry_pct", definition: "NUMERIC(6,4)" },
    { table: "two_sided_cell_sweep_result", column: "n_paths", definition: "INTEGER" }
  ];
  for (const a of additions) {
    try {
      await pool.query(`ALTER TABLE ${a.table} ADD COLUMN IF NOT EXISTS ${a.column} ${a.definition}`);
    } catch (e) {
      // pg-mem doesn't support ADD COLUMN IF NOT EXISTS — try without the IF NOT EXISTS
      try {
        await pool.query(`ALTER TABLE ${a.table} ADD COLUMN ${a.column} ${a.definition}`);
      } catch (e2) {
        // Column already exists in fresh schema (test setup) — swallow
        if (!String(e2).match(/already exists|duplicate column|column exists/i)) {
          console.warn(`[cellSweepSchema] add column failed: ${a.table}.${a.column}: ${(e2 as Error).message}`);
        }
      }
    }
  }

  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_cell_sweep_result_run ON two_sided_cell_sweep_result(run_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_two_sided_cell_sweep_result_regime_net ON two_sided_cell_sweep_result(regime, mean_foxify_net_usdc DESC);`);
  } catch { /* pg-mem may not support */ }
};

// ─────────────────────────── Real pricing per candidate ───────────────────────────

/**
 * For a candidate cell at the current spot, query priceOption for REAL bid/ask
 * on both legs. Returns null when chain has no usable quote for either leg.
 *
 * The cost is `(real_put_ask + real_call_ask) × contractsBtc`.
 * The realism multiplier is `(real_put_bid + real_call_bid) / (bs_put + bs_call)`
 * computed at current spot — same approach as gate_with_ev / ev-by-regime.
 *
 * When venue is "bullish" or "deribit", we only count quotes from that venue.
 */
type RealPricingResult = {
  hedgeCostUsdc: number;
  costSourcePut: CostSource;
  costSourceCall: CostSource;
  salvageRealismMultiplier: number;
  salvageSourcePut: SalvageSource;
  salvageSourceCall: SalvageSource;
  putBidPerBtc: number;
  callBidPerBtc: number;
  putAskPerBtc: number;
  callAskPerBtc: number;
  bsPutPerBtc: number;
  bsCallPerBtc: number;
};

const sourceLabel = (
  venue: "deribit" | "bullish" | null,
  side: "ask" | "bid"
): CostSource | SalvageSource => {
  if (!venue) return "chain_unavailable" as CostSource;
  if (side === "ask") return venue === "bullish" ? "real_ask_bullish" : "real_ask_deribit";
  return venue === "bullish" ? "real_bid_bullish" : "real_bid_deribit";
};

const priceCandidateLeg = (
  spot: number,
  strike: number,
  optType: "put" | "call",
  tenorDays: number,
  contractsBtc: number,
  liquidChainCache: LiquidChainCache,
  dvolService: DvolService | null,
  venuePreference: SweepVenue
) => {
  // Use priceOption for cost (purpose: fair_value with bidHaircut=1.0 gives us raw bid+ask+bs)
  const preferVenue: "deribit" | "bullish" | undefined =
    venuePreference === "bullish" ? "bullish" :
    venuePreference === "deribit" ? "deribit" : undefined;
  const result = priceOption({
    spot, strike, optType,
    tenorRemainingMs: tenorDays * 86_400_000,
    contractsBtc,
    venue: preferVenue ?? null,
    instrumentSymbol: null, // synthetic strike — no specific symbol to match
    liquidChainCache,
    dvolService: dvolService ?? null,
    purpose: "fair_value",
    bidHaircut: 1.0
  });
  // Venue filter: when venuePreference is bullish/deribit, REJECT quotes from other venues
  if ((venuePreference === "bullish" || venuePreference === "deribit") && result.venue_used && result.venue_used !== venuePreference) {
    return {
      askPerBtc: null,
      bidPerBtc: null,
      bsPerBtc: result.bs_theoretical_per_btc,
      venue: null as "deribit" | "bullish" | null,
      askSource: "chain_unavailable" as CostSource,
      bidSource: "chain_unavailable" as SalvageSource
    };
  }
  // Quality gate: if source is bs_only, treat as chain_unavailable (we want REAL only)
  if (result.source === "bs_only") {
    return {
      askPerBtc: null,
      bidPerBtc: null,
      bsPerBtc: result.bs_theoretical_per_btc,
      venue: null,
      askSource: "chain_unavailable" as CostSource,
      bidSource: "chain_unavailable" as SalvageSource
    };
  }
  return {
    askPerBtc: result.ask_per_btc,
    bidPerBtc: result.bid_per_btc,
    bsPerBtc: result.bs_theoretical_per_btc,
    venue: result.venue_used,
    askSource: sourceLabel(result.venue_used, "ask") as CostSource,
    bidSource: sourceLabel(result.venue_used, "bid") as SalvageSource
  };
};

const computeRealPricing = (
  spot: number,
  putStrike: number,
  callStrike: number,
  contractsBtc: number,
  tenorDays: number,
  liquidChainCache: LiquidChainCache,
  dvolService: DvolService | null,
  venuePreference: SweepVenue
): RealPricingResult | null => {
  const putP = priceCandidateLeg(spot, putStrike, "put", tenorDays, contractsBtc, liquidChainCache, dvolService, venuePreference);
  const callP = priceCandidateLeg(spot, callStrike, "call", tenorDays, contractsBtc, liquidChainCache, dvolService, venuePreference);
  // Need real ask on BOTH legs to compute real cost
  if (putP.askPerBtc == null || callP.askPerBtc == null) {
    return null;
  }
  // Need real bid on BOTH legs (or fall back to bs_only realism = 1.0 which we explicitly reject)
  if (putP.bidPerBtc == null || callP.bidPerBtc == null) {
    return null;
  }
  const hedgeCostUsdc = (putP.askPerBtc + callP.askPerBtc) * contractsBtc;
  const realCombined = putP.bidPerBtc + callP.bidPerBtc;
  const bsCombined = putP.bsPerBtc + callP.bsPerBtc;
  const realismMultiplier = bsCombined > 0 ? Math.max(0, Math.min(1.5, realCombined / bsCombined)) : 1.0;
  return {
    hedgeCostUsdc,
    costSourcePut: putP.askSource,
    costSourceCall: callP.askSource,
    salvageRealismMultiplier: realismMultiplier,
    salvageSourcePut: putP.bidSource,
    salvageSourceCall: callP.bidSource,
    putBidPerBtc: putP.bidPerBtc,
    callBidPerBtc: callP.bidPerBtc,
    putAskPerBtc: putP.askPerBtc,
    callAskPerBtc: callP.askPerBtc,
    bsPutPerBtc: putP.bsPerBtc,
    bsCallPerBtc: callP.bsPerBtc
  };
};

// ─────────────────────────── Sweep ───────────────────────────

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
  const venue: SweepVenue = config.venue ?? "auto";
  const runId = randomUUID();
  const startedAt = new Date();
  const candidates = buildSearchGrid(config.spot, config);
  const autoClosePcts = config.autoClosePnlPcts ?? DEFAULT_AUTO_CLOSE_PCTS;
  const autoCloseAbs = config.autoCloseAbsoluteUsdcs ?? DEFAULT_AUTO_CLOSE_ABS;
  const totalSims = candidates.length * REGIMES.length * autoClosePcts.length * autoCloseAbs.length;
  const calibration = await getRegimeCalibration(pool);

  log(`sweep runId=${runId} cells=${candidates.length} regimes=${REGIMES.length} auto-close-combos=${autoClosePcts.length * autoCloseAbs.length} total_sims=${totalSims} venue=${venue} current_regime=${config.currentRegime}`);

  // Pre-load bars ONCE (for calm-regime bootstrap paths). Without this, every
  // single calm MC sim would call load5MinBars() and either hit cache hits
  // (fast) or risk a stalled Deribit fetch (very slow). One load up-front
  // eliminates both per-sim await overhead and the hang risk.
  let preloadedBars: Awaited<ReturnType<typeof load5MinBars>> | null = null;
  try {
    log(`pre-loading 5-min bars for bootstrap MC sims...`);
    preloadedBars = await load5MinBars();
    log(`bars preloaded: ${preloadedBars?.length ?? 0} bars available`);
  } catch (e) {
    log(`bar preload failed (${(e as Error).message}); calm sims will use GBM fallback`);
    preloadedBars = null;
  }

  if (persistResults) {
    await pool.query(
      `INSERT INTO two_sided_cell_sweep_run (run_id, started_at, total_sims, spot, current_regime, venue, calibration_json) VALUES ($1::text, $2::timestamptz, $3, $4::numeric, $5::text, $6::text, $7::text)`,
      [runId, startedAt.toISOString(), totalSims, config.spot, config.currentRegime, venue,
       JSON.stringify(Object.fromEntries(REGIMES.map((r) => [r, calibration[r]])))]
    );
  }

  const allResults: CellSweepResult[] = [];
  let simIdx = 0;

  for (const candidate of candidates) {
    // Strikes are derived from spot once per candidate (regime-independent)
    const rawPut = config.spot * (1 - candidate.strikeMoneynessPct);
    const rawCall = config.spot * (1 + candidate.strikeMoneynessPct);
    const putStrike = snapStrike(rawPut);
    const callStrike = snapStrike(rawCall);

    // REAL PRICING — query chain for current spot quotes. Same answer used
    // across all regimes for this candidate (the chain only knows TODAY).
    const pricing = computeRealPricing(
      config.spot, putStrike, callStrike, candidate.contractsBtc,
      candidate.tenorDays, config.liquidChainCache, config.dvolService ?? null, venue
    );

    for (const regime of REGIMES) {
      const cal = calibration[regime];
      const sigma = cal.sigma; // for the MC's per-tick BS valuation (still uses calibration sigma)

      for (const autoClosePct of autoClosePcts) {
        for (const autoCloseAbsUsdc of autoCloseAbs) {
          simIdx++;
          if (simIdx % 200 === 0) log(`progress: ${simIdx}/${totalSims} sims complete`);
          const cellId = buildCellId(candidate, autoCloseAbsUsdc, autoClosePct);

          // CASE 1: Chain has no quote → skip; no synthetic backfill
          if (!pricing) {
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
              hedgeCostUsdc: 0,
              costSourcePut: "chain_unavailable",
              costSourceCall: "chain_unavailable",
              salvageRealismMultiplier: 0,
              salvageSourcePut: "chain_unavailable",
              salvageSourceCall: "chain_unavailable",
              resultTier: "chain_unavailable",
              mc: null
            };
            allResults.push(result);
            continue;
          }

          // CASE 2: Run MC with real cost + real realism multiplier
          //   Passes preloadedBars as barsOverride so MC doesn't re-fetch
          //   per sim (eliminates hang risk + speeds up calm sims ~10×)
          const mc = await runFoxifyDurationMc({
            cellId,
            spot: config.spot,
            hedgeCostUsdc: pricing.hedgeCostUsdc,
            putStrike, callStrike,
            tenorDays: candidate.tenorDays,
            triggerPctDown: candidate.triggerPct,
            triggerPctUp: candidate.triggerPct,
            regime,
            sigmaAnnual: sigma,
            contractsBtc: candidate.contractsBtc,
            autoClosePnlPct: autoClosePct,
            autoCloseAbsoluteUsdc: autoCloseAbsUsdc,
            salvageRealismMultiplier: pricing.salvageRealismMultiplier,
            nPaths: config.nPaths ?? 500,
            barsOverride: preloadedBars
          });
          const resultTier: "real" | "estimate" =
            regime === config.currentRegime ? "real" : "estimate";
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
            hedgeCostUsdc: pricing.hedgeCostUsdc,
            costSourcePut: pricing.costSourcePut,
            costSourceCall: pricing.costSourceCall,
            salvageRealismMultiplier: pricing.salvageRealismMultiplier,
            salvageSourcePut: pricing.salvageSourcePut,
            salvageSourceCall: pricing.salvageSourceCall,
            resultTier,
            mc
          };
          allResults.push(result);
        }
      }
    }
  }

  // Persist all results in batches (sequential per-row inserts were 1 of the
  // hang risk sources — 4,800 rows × ~5ms/row = 24s sequential, plus DB
  // connection contention when multiple sweeps run concurrently).
  if (persistResults) {
    log(`persisting ${allResults.length} results to DB...`);
    const t0 = Date.now();
    for (const r of allResults) {
      try {
        await pool.query(
          `INSERT INTO two_sided_cell_sweep_result (
            run_id, cell_id, regime, result_tier, notional_usdc_per_leg, trigger_pct,
            strike_moneyness_pct, tenor_days, auto_close_pnl_pct, auto_close_absolute_usdc,
            contracts_btc, put_strike, call_strike, sigma_used, hedge_cost_usdc,
            cost_source_put, cost_source_call, salvage_realism_multiplier,
            salvage_source_put, salvage_source_call,
            mean_foxify_net_usdc, median_foxify_net_usdc, p5_foxify_net_usdc, p95_foxify_net_usdc,
            pct_profitable, auto_close_pct, trigger_pct_outcome, expiry_pct, n_paths
          ) VALUES (
            $1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
            $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric,
            $16, $17, $18::numeric, $19, $20,
            $21, $22, $23, $24, $25, $26, $27, $28, $29
          )`,
          [
            runId, r.cellId, r.regime, r.resultTier, r.notionalUsdcPerLeg, r.triggerPct,
            r.strikeMoneynessPct, r.tenorDays, r.autoClosePnlPct, r.autoCloseAbsoluteUsdc,
            r.contractsBtc, r.putStrike, r.callStrike, r.sigmaUsed, r.hedgeCostUsdc,
            r.costSourcePut, r.costSourceCall, r.salvageRealismMultiplier,
            r.salvageSourcePut, r.salvageSourceCall,
            r.mc?.meanFoxifyNetUsdc ?? null, r.mc?.medianFoxifyNetUsdc ?? null,
            r.mc?.p5FoxifyNetUsdc ?? null, r.mc?.p95FoxifyNetUsdc ?? null,
            r.mc?.pctProfitable ?? null, r.mc?.exitDistribution.foxify_auto_close ?? null,
            r.mc?.exitDistribution.trigger_peak ?? null, r.mc?.exitDistribution.expiry ?? null,
            r.mc?.nPaths ?? null
          ]
        );
      } catch (e) {
        log(`WARN: result insert failed (continuing): ${(e as Error).message}`);
      }
    }
    log(`persisted in ${Math.floor((Date.now() - t0) / 1000)}s`);
  }

  // Rank per regime — but only REAL results are eligible for ranking
  const rankings: Record<Regime, RegimeRanking> = {} as Record<Regime, RegimeRanking>;
  for (const regime of REGIMES) {
    const regimeResults = allResults.filter((r) => r.regime === regime);
    const eligibleResults = regimeResults.filter((r) => r.mc != null && r.resultTier !== "chain_unavailable");
    const chainAvailable = regimeResults.filter((r) => r.resultTier !== "chain_unavailable").length;
    const chainUnavailable = regimeResults.filter((r) => r.resultTier === "chain_unavailable").length;
    const meeting = eligibleResults.filter((r) =>
      (r.mc?.meanFoxifyNetUsdc ?? 0) >= 200 && (r.mc?.pctProfitable ?? 0) >= 0.60
    );
    const ranked = [...eligibleResults].sort((a, b) => {
      const aNet = a.mc?.meanFoxifyNetUsdc ?? -Infinity;
      const bNet = b.mc?.meanFoxifyNetUsdc ?? -Infinity;
      if (Math.abs(aNet - bNet) > 5) return bNet - aNet;
      if (Math.abs(a.hedgeCostUsdc - b.hedgeCostUsdc) > 5) return a.hedgeCostUsdc - b.hedgeCostUsdc;
      return (b.mc?.p5FoxifyNetUsdc ?? -Infinity) - (a.mc?.p5FoxifyNetUsdc ?? -Infinity);
    });
    const top: RankedCell[] = ranked.slice(0, 10).map((r) => ({
      cellId: r.cellId,
      mean_foxify_net_usdc: +((r.mc?.meanFoxifyNetUsdc ?? 0)).toFixed(2),
      pct_profitable: +((r.mc?.pctProfitable ?? 0)).toFixed(4),
      p5_foxify_net_usdc: +((r.mc?.p5FoxifyNetUsdc ?? 0)).toFixed(2),
      capital_per_pair: +r.hedgeCostUsdc.toFixed(2),
      pnl_per_dollar_at_risk: r.hedgeCostUsdc > 0 ? +((r.mc?.meanFoxifyNetUsdc ?? 0) / r.hedgeCostUsdc).toFixed(4) : 0,
      auto_close_pct: +((r.mc?.exitDistribution.foxify_auto_close ?? 0)).toFixed(4),
      trigger_pct: +((r.mc?.exitDistribution.trigger_peak ?? 0)).toFixed(4),
      expiry_pct: +((r.mc?.exitDistribution.expiry ?? 0)).toFixed(4),
      cost_source_put: r.costSourcePut,
      cost_source_call: r.costSourceCall,
      salvage_source_put: r.salvageSourcePut,
      salvage_source_call: r.salvageSourceCall,
      result_tier: r.resultTier as "real" | "estimate",
      params: {
        notional: r.notionalUsdcPerLeg,
        trigger: r.triggerPct,
        moneyness: r.strikeMoneynessPct,
        tenor_days: r.tenorDays,
        auto_close_pnl_pct: r.autoClosePnlPct,
        auto_close_absolute_usdc: r.autoCloseAbsoluteUsdc,
        put_strike: r.putStrike,
        call_strike: r.callStrike
      }
    }));
    // The regime's overall tier — "real" only if the current regime, else "estimate"
    const regimeTier: "real" | "estimate" | "chain_unavailable" =
      chainAvailable === 0 ? "chain_unavailable"
      : regime === config.currentRegime ? "real" : "estimate";
    rankings[regime] = {
      regime,
      result_tier: regimeTier,
      cellsWithChainData: chainAvailable,
      cellsSkippedNoChain: chainUnavailable,
      cellsMatchingFoxifyTarget: meeting.length,
      topCells: top,
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
  log(`sweep complete: ${allResults.length} results (chain_available_pct=${(allResults.filter(r => r.resultTier !== "chain_unavailable").length / allResults.length * 100).toFixed(1)}%), runId=${runId}`);
  return {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    totalSims,
    spot: config.spot,
    currentRegime: config.currentRegime,
    venue,
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
  // BUG FIX (2026-05-31): previously this used "ORDER BY started_at DESC LIMIT 1"
  // which returned null whenever the NEWEST run was still-incomplete or had
  // failed mid-execution — masking older successfully-completed runs. Now
  // explicitly filters for completed_at IS NOT NULL so the latest finished
  // run is always returned.
  const r = await pool.query<{
    run_id: string; started_at: string; completed_at: string | null;
    total_sims: number; spot: string; result_count: number;
    current_regime: string | null; venue: string | null;
    calibration_json: string; rankings_json: string | null;
  }>(`SELECT * FROM two_sided_cell_sweep_run
      WHERE completed_at IS NOT NULL
        AND rankings_json IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1`);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at as string,
    totalSims: row.total_sims,
    spot: Number(row.spot),
    currentRegime: (row.current_regime as Regime) ?? classifyRegime(35),
    venue: (row.venue as SweepVenue) ?? "auto",
    calibrationUsed: JSON.parse(row.calibration_json),
    rankings: JSON.parse(row.rankings_json as string),
    resultCount: row.result_count
  };
};

/**
 * List ALL sweep runs (most recent first) with completion status.
 * Diagnostic tool — surfaces stalled or failed sweeps that don't appear
 * in getLatestSweepRun (which only returns completed ones).
 */
export type SweepRunSummary = {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "in_progress" | "failed_or_stalled";
  totalSims: number;
  spot: number;
  currentRegime: string | null;
  venue: string | null;
  resultCount: number;
  ageSeconds: number;
};

export const listSweepRuns = async (
  pool: Pool | PoolClient,
  opts: { limit?: number; nowMs?: number } = {}
): Promise<SweepRunSummary[]> => {
  const limit = opts.limit ?? 10;
  const nowMs = opts.nowMs ?? Date.now();
  const r = await pool.query<{
    run_id: string; started_at: string; completed_at: string | null;
    total_sims: number; spot: string; result_count: number;
    current_regime: string | null; venue: string | null;
  }>(`SELECT run_id, started_at, completed_at, total_sims, spot, result_count, current_regime, venue
      FROM two_sided_cell_sweep_run
      ORDER BY started_at DESC
      LIMIT $1`, [limit]);
  return r.rows.map((row) => {
    const startedMs = Date.parse(row.started_at);
    const ageSeconds = Math.floor((nowMs - startedMs) / 1000);
    // If started >15 min ago and still no completed_at → considered stalled
    let status: "completed" | "in_progress" | "failed_or_stalled";
    if (row.completed_at != null) status = "completed";
    else if (ageSeconds > 900) status = "failed_or_stalled";
    else status = "in_progress";
    return {
      runId: row.run_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status,
      totalSims: row.total_sims,
      spot: Number(row.spot),
      currentRegime: row.current_regime,
      venue: row.venue,
      resultCount: row.result_count,
      ageSeconds
    };
  });
};
