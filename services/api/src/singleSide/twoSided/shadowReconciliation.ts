/**
 * Shadow PnL reconciliation against MC predictions.
 *
 * Aggregates settled shadow pairs over a window and reports the realized vs
 * predicted EV. Drift > driftThresholdPct triggers an alert payload that the
 * operator dashboard / cron picks up.
 *
 * Predictions come from PLAN.md §2.3 / the validation MD's per-pair Foxify EV
 * at the active regime. For Phase 0 (calm-only operation), the calm-regime
 * expected per-pair Foxify EV is +$543 (from runTwoSidedStrangleProof.ts
 * embedded defaults). Operator can override per-regime when shadow runs sample
 * higher-vol regimes.
 */

import type { Pool } from "pg";

export type ShadowReconciliation = {
  windowStartIso: string;
  windowEndIso: string;
  shadowPairsSettled: number;
  realizedFoxifyEvUsdc: number;            // sum of foxify_share - hedge_cost across settled shadow pairs
  meanRealizedFoxifyEvPerPair: number;
  predictedFoxifyEvPerPair: number;        // from MC, parameterized
  driftPct: number;                        // (realized - predicted) / |predicted|
  driftThresholdPct: number;
  alert: boolean;
};

export type ReconciliationOptions = {
  windowMs?: number;             // default 7d
  predictedFoxifyEvPerPair?: number;  // default +$543 (calm regime ITM guts)
  driftThresholdPct?: number;    // default 0.15 = 15%
  nowMs?: number;
};

export const computeShadowReconciliation = async (
  pool: Pool,
  opts: ReconciliationOptions = {}
): Promise<ShadowReconciliation> => {
  const now = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? 7 * 86_400_000;
  const sinceIso = new Date(now - windowMs).toISOString();
  const untilIso = new Date(now).toISOString();
  const predicted = opts.predictedFoxifyEvPerPair ?? 543;
  const threshold = opts.driftThresholdPct ?? 0.15;

  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS n,
       COALESCE(SUM(foxify_share_usdc - hedge_cost_total_usdc), 0) AS realized_foxify_ev
     FROM two_sided_pair
     WHERE is_shadow = TRUE
       AND status = 'settled'
       AND closed_at >= $1
       AND closed_at <= $2`,
    [sinceIso, untilIso]
  );
  const n = r.rows[0]?.n ?? 0;
  const realized = Number(r.rows[0]?.realized_foxify_ev ?? 0);
  const meanRealized = n === 0 ? 0 : realized / n;
  const drift = predicted === 0 ? 0 : (meanRealized - predicted) / Math.abs(predicted);

  return {
    windowStartIso: sinceIso,
    windowEndIso: untilIso,
    shadowPairsSettled: n,
    realizedFoxifyEvUsdc: realized,
    meanRealizedFoxifyEvPerPair: meanRealized,
    predictedFoxifyEvPerPair: predicted,
    driftPct: drift,
    driftThresholdPct: threshold,
    alert: Math.abs(drift) > threshold && n >= 10 // require min sample size before alerting
  };
};
