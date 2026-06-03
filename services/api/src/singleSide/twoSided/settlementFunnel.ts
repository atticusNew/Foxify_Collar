/**
 * Settlement funnel — explains WHY active positions aren't (yet) feeding the
 * realized-vs-MC validation gate / per-cell realized stats.
 *
 * The validation gate (realizedVsMc.getRealizedShadowStats) only counts a pair when
 * ALL of these hold:
 *   (a) status = 'settled'      → OPEN pairs (active/triggered/unwinding) contribute
 *                                 NOTHING until they close. An open position has no
 *                                 realized outcome yet.
 *   (b) is_shadow = TRUE        → the MC gate is the SHADOW data engine. REAL (live)
 *                                 pairs feed live-pnl, not this gate.
 *   (c) regime_at_activation set→ legacy pairs opened before regime-tagging are
 *                                 untagged → excluded from the regime-filtered gate.
 *   (d) organic (metadata.source != 'shadow_test_activate') → seeded/force-triggered
 *                                 pairs are excluded (their artificial close biases the gate).
 *
 * SEPARATELY: σ CALIBRATION is fed by DVOL history samples (regimeCalibration), NOT by
 * settled pairs — so moderate σ can be empirical even with zero settled moderate pairs.
 * This funnel is about the realized-vs-MC VALIDATION step, not σ.
 *
 * This module aggregates the funnel so an operator can see exactly where their
 * moderate volume is sitting (open vs settled vs excluded) and per cell.
 */

import type { Pool, PoolClient } from "pg";

const OPEN_STATUSES = ["active", "triggered", "unwinding"] as const;

export type RegimeCount = Record<string, number>;

export type SettlementFunnel = {
  as_of: string;
  shadow: {
    open: { total: number; by_regime: RegimeCount; by_cell: RegimeCount };
    settled: {
      total: number;
      counted_in_gate: number;           // settled + tagged + organic
      counted_by_regime: RegimeCount;    // of the counted, split by regime
      counted_by_cell: RegimeCount;
      excluded_untagged: number;         // settled but no regime tag (pre-tagging-fix)
      excluded_seeded: number;           // settled but source=shadow_test_activate
    };
  };
  live: { open: number; settled: number };  // real pairs — excluded from the shadow MC gate
  notes: string[];
};

const isSeeded = (metadata: unknown): boolean => {
  const md = (typeof metadata === "string"
    ? (() => { try { return JSON.parse(metadata); } catch { return {}; } })()
    : (metadata ?? {})) as { source?: string };
  return md.source === "shadow_test_activate";
};

const inc = (m: RegimeCount, k: string | null | undefined) => {
  const key = k ?? "untagged";
  m[key] = (m[key] ?? 0) + 1;
};

export const getSettlementFunnel = async (
  pool: Pool | PoolClient,
  opts: { nowMs?: number } = {}
): Promise<SettlementFunnel> => {
  const r = await pool.query<{ status: string; is_shadow: boolean; regime_at_activation: string | null; cell_id: string; foxify_share_usdc: string | null; metadata: unknown }>(
    `SELECT status, is_shadow, regime_at_activation, cell_id, foxify_share_usdc, metadata
       FROM two_sided_pair`
  );

  const shadowOpenByRegime: RegimeCount = {};
  const shadowOpenByCell: RegimeCount = {};
  let shadowOpenTotal = 0;
  let settledTotal = 0;
  let counted = 0;
  const countedByRegime: RegimeCount = {};
  const countedByCell: RegimeCount = {};
  let excludedUntagged = 0;
  let excludedSeeded = 0;
  let liveOpen = 0;
  let liveSettled = 0;

  for (const row of r.rows) {
    const open = (OPEN_STATUSES as readonly string[]).includes(row.status);
    if (!row.is_shadow) {
      // Real pairs — tracked separately; excluded from the shadow MC gate.
      if (open) liveOpen++;
      else if (row.status === "settled") liveSettled++;
      continue;
    }
    // Shadow pairs
    if (open) {
      shadowOpenTotal++;
      inc(shadowOpenByRegime, row.regime_at_activation);
      inc(shadowOpenByCell, row.cell_id);
      continue;
    }
    if (row.status !== "settled" || row.foxify_share_usdc == null) continue;
    settledTotal++;
    if (isSeeded(row.metadata)) { excludedSeeded++; continue; }
    if (row.regime_at_activation == null) { excludedUntagged++; continue; }
    // settled + organic + tagged ⇒ COUNTED in the gate
    counted++;
    inc(countedByRegime, row.regime_at_activation);
    inc(countedByCell, row.cell_id);
  }

  return {
    as_of: new Date(opts.nowMs ?? Date.now()).toISOString(),
    shadow: {
      open: { total: shadowOpenTotal, by_regime: shadowOpenByRegime, by_cell: shadowOpenByCell },
      settled: {
        total: settledTotal,
        counted_in_gate: counted,
        counted_by_regime: countedByRegime,
        counted_by_cell: countedByCell,
        excluded_untagged: excludedUntagged,
        excluded_seeded: excludedSeeded
      }
    },
    live: { open: liveOpen, settled: liveSettled },
    notes: [
      "OPEN positions (active/triggered/unwinding) contribute NOTHING to the realized-vs-MC gate until they SETTLE — an open position has no realized outcome yet.",
      "The realized-vs-MC gate is SHADOW-only; the REAL (live) pair feeds live-pnl, not this gate.",
      "Settled shadow pairs only count when regime-TAGGED (pre-tagging-fix pairs are untagged → excluded) AND organic (seeded/force-triggered excluded).",
      "σ CALIBRATION is fed by DVOL history, NOT settled pairs — moderate σ can be empirical with zero settled moderate pairs. This funnel is about the VALIDATION step only."
    ]
  };
};
