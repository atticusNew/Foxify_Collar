/**
 * 30-day capital-scaling / budget projection (live pricing + real net distribution).
 *
 * Answers: "from a hedge budget B, how many concurrent pairs can Foxify open,
 * and — recycling profits (no split) — how many pairs / how much volume / profit
 * over N days, with what drawdown?" Monte-Carlo across the MC's REAL net
 * distribution so the output is a RANGE (p5/median/p95), not a rosy point.
 *
 * Per-pair inputs are REAL: cost = computeRealPricing (live chain ask); net
 * samples = runFoxifyDurationMc bootstrapped (returnNets) with split=1.0 so the
 * recycled amount is the GROSS option uplift (no Atticus/Foxify split, per spec).
 *
 * Model: sequential cycles of length cycleDays. Each cycle, if the market is
 * "active" (Bernoulli at marketAvailability), open as many pairs as capital
 * allows (capped by maxConcurrent if set); each pair returns capital + a sampled
 * net; recycle. Tracks peak concurrent, cumulative pairs/volume/profit, max drawdown.
 *
 * CAVEATS (surfaced): net is MC `estimate`-tier for moderate until validated
 * (re-run on realized as it accrues); cycle time approximated from the MC's
 * mean-ticks-to-auto-close (or tenor); availability = DVOL-history regime
 * fraction; sequential-cycle recycling is a simplification; depth/liquidity cap
 * only applied if maxConcurrent is set.
 */

import type { Pool, PoolClient } from "pg";
import type { Regime } from "./featureFlag";
import { PHASE_0_CELLS, computeStrikes } from "./cellConfig";
import { computeRealPricing, type SweepVenue } from "./cellSweep";
import { getRegimeCalibration } from "./regimeCalibration";
import { runFoxifyDurationMc } from "./foxifyDurationMc";
import { getRealizedShadowStats } from "./realizedVsMc";
import { mulberry32 } from "../../../scripts/backtest/singleSide/monteCarloEngine";
import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";

const BAR_MINUTES = 5;

/**
 * How the projection sources its per-pair net distribution:
 *   - "off"     → always MC (legacy behavior).
 *   - "blend"   → weight = min(1, realized_n / N); each draw picks from the
 *                 realized pool with probability `weight`, else MC. Smoothly
 *                 transfers trust to reality as validated settlements accrue.
 *   - "replace" → once realized_n >= N, sample ONLY realized; below N, MC.
 */
export type ProjectionRealizedMode = "off" | "blend" | "replace";

const DEFAULT_REALIZED_MODE: ProjectionRealizedMode =
  ((process.env.SS_PROJECTION_REALIZED_MODE as ProjectionRealizedMode) === "off" ||
   (process.env.SS_PROJECTION_REALIZED_MODE as ProjectionRealizedMode) === "replace")
    ? (process.env.SS_PROJECTION_REALIZED_MODE as ProjectionRealizedMode)
    : "blend";
const DEFAULT_MIN_VALIDATED_SETTLEMENTS = Math.max(
  1,
  Number(process.env.SS_PROJECTION_MIN_VALIDATED_SETTLEMENTS ?? "20")
);

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)))];
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export type ScalingProjectionResult = {
  cell_id: string;
  regime: Regime;
  spot: number;
  budget_usdc: number;
  days: number;
  cost_per_pair_usdc: number;
  per_pair_perp_notional_usdc: number;
  cycle_days: number;
  market_availability: number;
  max_concurrent_cap: number | null;
  mc_mean_net_usdc: number;
  mc_pct_profitable: number;
  /** Net distribution source actually used for the recycle sampling. */
  net_source: "mc" | "blend" | "realized";
  /** Realized-net wiring mode in effect (off | blend | replace). */
  realized_mode: ProjectionRealizedMode;
  /** Validated-settlement threshold N for full-trust transfer. */
  min_validated_settlements: number;
  /** Count of regime-tagged settled shadow pairs found for this cell+regime. */
  realized_n: number;
  /** Mean of the realized per-pair nets (null when realized_n === 0). */
  realized_mean_net_usdc: number | null;
  /** Blend weight applied to the realized pool (0 = pure MC, 1 = pure realized). */
  blend_weight: number;
  starting_concurrent: number;
  budget_to_reach_concurrent: Record<string, number>;
  projection: {
    final_capital_usdc: { p5: number; median: number; p95: number };
    total_pairs: { p5: number; median: number; p95: number };
    peak_concurrent: { p5: number; median: number; p95: number };
    cumulative_profit_usdc: { p5: number; median: number; p95: number };
    roundtrip_perp_volume_usdc: { p5: number; median: number; p95: number };
    max_drawdown_pct: { p5: number; median: number; p95: number };
  };
  caveats: string[];
};

export const projectScaling = async (
  pool: Pool,
  opts: {
    cellId: string;
    regime?: Regime;
    budgetUsdc: number;
    days?: number;
    spot: number;
    liquidChainCache: LiquidChainCache;
    dvolService?: DvolService | null;
    venue?: SweepVenue;
    cycleDays?: number;
    marketAvailability?: number;
    maxConcurrent?: number;
    nRuns?: number;
    nPaths?: number;
    seed?: number;
    nowMs?: number;
    /** Realized-net wiring mode; defaults to env SS_PROJECTION_REALIZED_MODE or "blend". */
    realizedMode?: ProjectionRealizedMode;
    /** Validated-settlement threshold N; defaults to env or 20. */
    minValidatedSettlements?: number;
  }
): Promise<ScalingProjectionResult> => {
  const regime = opts.regime ?? "moderate";
  const days = opts.days ?? 30;
  const nRuns = opts.nRuns ?? 1000;
  const nPaths = opts.nPaths ?? 1000;
  const venue: SweepVenue = opts.venue ?? "auto";
  const cell = PHASE_0_CELLS[opts.cellId];
  if (!cell) throw new Error(`unknown cell: ${opts.cellId}`);

  const contractsBtc = +(cell.notionalUsdcPerLeg / opts.spot).toFixed(3);
  const { putStrike, callStrike } = computeStrikes(cell, opts.spot);
  const pricing = computeRealPricing(
    opts.spot, putStrike, callStrike, contractsBtc, cell.hedgeTenorDays,
    opts.liquidChainCache, opts.dvolService ?? null, venue
  );
  if (!pricing) throw new Error("chain_unavailable: cannot price the cell at current spot");
  const costPerPair = pricing.hedgeCostUsdc;

  const calibration = await getRegimeCalibration(pool, { nowMs: opts.nowMs });
  const sigma = calibration[regime].sigma;

  // GROSS uplift per pair (split=1.0 → recycle the whole option profit, per spec).
  const mc = await runFoxifyDurationMc({
    cellId: opts.cellId, spot: opts.spot, hedgeCostUsdc: costPerPair,
    putStrike, callStrike, tenorDays: cell.hedgeTenorDays,
    triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
    regime, sigmaAnnual: sigma, contractsBtc,
    autoClosePnlPct: 0.30, autoCloseAbsoluteUsdc: 250,
    salvageRealismMultiplier: pricing.salvageRealismMultiplier,
    atticusSplitPct: 1.0, atticusFloorUsdc: 0,
    nPaths, returnNets: true, barsOverride: null
  });
  const mcNets = (mc.nets && mc.nets.length > 0) ? mc.nets : [mc.meanFoxifyNetUsdc];

  // ─── Realized-net wiring (Deliverable 1) ───
  // Once a cell has >=N regime-tagged validated settlements, transfer trust
  // from the (estimate-tier) MC distribution to the REAL realized one. Mode:
  //   off     → MC only (legacy);
  //   blend   → weight = min(1, n/N); per-draw pick realized w.p. weight else MC;
  //   replace → realized once n>=N, else MC.
  const realizedMode: ProjectionRealizedMode = opts.realizedMode ?? DEFAULT_REALIZED_MODE;
  const minValidated = Math.max(1, opts.minValidatedSettlements ?? DEFAULT_MIN_VALIDATED_SETTLEMENTS);
  let realizedNets: number[] = [];
  if (realizedMode !== "off") {
    try {
      const realizedRes = await getRealizedShadowStats(pool, { regime, returnSamples: true });
      const cellStats = realizedRes.stats.find((s) => s.cellId === opts.cellId);
      realizedNets = cellStats?.nets ?? [];
    } catch {
      realizedNets = []; // realized lookup is best-effort; fall back to MC
    }
  }
  const realizedN = realizedNets.length;
  const realizedMeanNet = realizedN > 0 ? +mean(realizedNets).toFixed(2) : null;
  // Effective weight on the realized pool.
  const blendWeight = realizedMode === "off" || realizedN === 0
    ? 0
    : realizedMode === "replace"
      ? (realizedN >= minValidated ? 1 : 0)
      : Math.min(1, realizedN / minValidated); // blend
  // Only take the new (extra-rng) code path when realized actually contributes;
  // when blendWeight === 0 the draw is byte-identical to legacy (regression-safe).
  const useRealizedDraw = blendWeight > 0 && realizedNets.length > 0;
  const netSource: "mc" | "blend" | "realized" =
    !useRealizedDraw ? "mc" : blendWeight >= 1 ? "realized" : "blend";
  /**
   * Draw one per-pair net sample. When realized is not in play this is exactly
   * the legacy `mcNets[floor(rng()*len)]` (single rng() call → preserves the
   * existing random stream and numeric output). When realized IS in play, an
   * extra rng() selects the source per draw.
   */
  const drawNet = (rng: () => number): number => {
    if (!useRealizedDraw) return mcNets[Math.floor(rng() * mcNets.length)];
    if (rng() < blendWeight) return realizedNets[Math.floor(rng() * realizedNets.length)];
    return mcNets[Math.floor(rng() * mcNets.length)];
  };

  // cycle time: mean ticks to auto-close → days; else tenor (ran to expiry)
  const cycleDays = opts.cycleDays ?? (mc.meanTicksToAutoClose != null
    ? Math.max(0.1, (mc.meanTicksToAutoClose * BAR_MINUTES) / (60 * 24))
    : cell.hedgeTenorDays);

  // market availability: fraction of DVOL history in this regime (default 0.67 for moderate)
  let marketAvailability = opts.marketAvailability ?? null;
  if (marketAvailability == null) {
    try {
      const r = await pool.query<{ regime: string; n: string }>(
        `SELECT regime, COUNT(*)::text AS n FROM two_sided_dvol_history GROUP BY regime`
      );
      const counts = new Map(r.rows.map((x) => [x.regime, Number(x.n)]));
      const total = [...counts.values()].reduce((s, x) => s + x, 0);
      marketAvailability = total > 0 ? (counts.get(regime) ?? 0) / total : (regime === "moderate" ? 0.67 : 0.2);
    } catch {
      marketAvailability = regime === "moderate" ? 0.67 : 0.2;
    }
  }
  const maxConcurrent = opts.maxConcurrent ?? Infinity;
  const perPairNotional = 2 * cell.notionalUsdcPerLeg; // long + short perp legs

  const cyclesTotal = Math.max(1, Math.floor(days / cycleDays));
  const finals: number[] = [];
  const totalPairsArr: number[] = [];
  const peakConcArr: number[] = [];
  const profitArr: number[] = [];
  const volumeArr: number[] = [];
  const ddArr: number[] = [];

  for (let run = 0; run < nRuns; run++) {
    const rng = mulberry32((opts.seed ?? 12345) + run);
    let capital = opts.budgetUsdc;
    let totalPairs = 0;
    let peakConc = 0;
    let peakCapital = capital;
    let maxDD = 0;
    for (let c = 0; c < cyclesTotal; c++) {
      if (rng() > (marketAvailability as number)) continue; // market not active this cycle
      const concurrent = Math.min(Math.floor(capital / costPerPair), maxConcurrent);
      if (concurrent <= 0) continue;
      peakConc = Math.max(peakConc, concurrent);
      let cycleNet = 0;
      for (let p = 0; p < concurrent; p++) {
        cycleNet += drawNet(rng);
      }
      capital += cycleNet; // recycle: cost returns + net (gross uplift)
      totalPairs += concurrent;
      peakCapital = Math.max(peakCapital, capital);
      const dd = peakCapital > 0 ? (peakCapital - capital) / peakCapital : 0;
      if (dd > maxDD) maxDD = dd;
    }
    finals.push(capital);
    totalPairsArr.push(totalPairs);
    peakConcArr.push(peakConc);
    profitArr.push(capital - opts.budgetUsdc);
    volumeArr.push(totalPairs * perPairNotional * 2); // ×2 = open + close round trip
    ddArr.push(+(maxDD * 100).toFixed(2));
  }

  const band = (arr: number[]): { p5: number; median: number; p95: number } => {
    const s = [...arr].sort((a, b) => a - b);
    return { p5: +pct(s, 0.05).toFixed(2), median: +pct(s, 0.5).toFixed(2), p95: +pct(s, 0.95).toFixed(2) };
  };
  const reach: Record<string, number> = {};
  for (const n of [1, 2, 5, 10, 25, 50, 100]) reach[String(n)] = +(n * costPerPair).toFixed(2);

  return {
    cell_id: opts.cellId, regime, spot: opts.spot, budget_usdc: opts.budgetUsdc, days,
    cost_per_pair_usdc: +costPerPair.toFixed(2),
    per_pair_perp_notional_usdc: perPairNotional,
    cycle_days: +cycleDays.toFixed(3),
    market_availability: +(marketAvailability as number).toFixed(4),
    max_concurrent_cap: Number.isFinite(maxConcurrent) ? maxConcurrent : null,
    mc_mean_net_usdc: +mc.meanFoxifyNetUsdc.toFixed(2),
    mc_pct_profitable: +mc.pctProfitable.toFixed(4),
    net_source: netSource,
    realized_mode: realizedMode,
    min_validated_settlements: minValidated,
    realized_n: realizedN,
    realized_mean_net_usdc: realizedMeanNet,
    blend_weight: +blendWeight.toFixed(4),
    starting_concurrent: Math.floor(opts.budgetUsdc / costPerPair),
    budget_to_reach_concurrent: reach,
    projection: {
      final_capital_usdc: band(finals),
      total_pairs: band(totalPairsArr),
      peak_concurrent: band(peakConcArr),
      cumulative_profit_usdc: band(profitArr),
      roundtrip_perp_volume_usdc: band(volumeArr),
      max_drawdown_pct: band(ddArr)
    },
    caveats: [
      netSource === "realized"
        ? `Net per pair sourced from ${realizedN} REAL validated settlement(s) (>= N=${minValidated}); MC retained only for reference. Recycled amount = GROSS option uplift (split=1.0, per spec).`
        : netSource === "blend"
          ? `Net per pair is a BLEND: ${(blendWeight * 100).toFixed(0)}% from ${realizedN} real settlement(s) + ${((1 - blendWeight) * 100).toFixed(0)}% from MC ('${calibration[regime].sigmaSource}'-calibrated). Trust shifts fully to realized at N=${minValidated}. Recycled amount = GROSS option uplift (split=1.0, per spec).`
          : `Net per pair is MC '${calibration[regime].sigmaSource}'-calibrated and (for moderate+) ESTIMATE tier until validated — ${realizedMode === "off" ? "realized-net wiring is OFF" : `accruing realized settlements (${realizedN}/${minValidated} for cell '${opts.cellId}' in '${regime}')`}. Recycled amount = GROSS option uplift (split=1.0, per spec).`,
      `Cycle time ≈ ${(+cycleDays.toFixed(2))}d from the MC's mean-ticks-to-close (or tenor); measure from real shadow settlement durations to refine.`,
      `Market availability ${(marketAvailability as number * 100).toFixed(0)}% = DVOL-history fraction in '${regime}'.`,
      "Sequential-cycle recycling is a simplification (pairs deploy/close per cycle). Depth/liquidity cap applied only if max_concurrent is set.",
      "Range is p5/median/p95 across MC runs — treat p5/drawdown as the LP buffer, not the median, for budgeting."
    ]
  };
};
