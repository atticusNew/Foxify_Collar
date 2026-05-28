/**
 * Regime-cell allowlist (PR C3 + OD-7).
 *
 * Maps each regime to the set of cells operator + Foxify have approved for
 * activation in that regime. Activation in a cell not on the regime's list
 * returns 503 cell_disabled_in_regime with details.suggested_cells.
 *
 * Phase 0 baseline (pair_50k_2pct) is calm-only.
 * Phase 1 cells are mapped per Wave C2 sweep results (see
 * docs/PHASE_1_CELL_SWEEP_2026-05-28.md for ranking).
 *
 * Operator can override via /admin/foxify/v2/cell-allowlist (PR C4) — DB-backed
 * override table takes precedence over the hardcoded defaults.
 */

import type { Pool, PoolClient } from "pg";
import type { Regime } from "./featureFlag";

/**
 * Hardcoded defaults per V5 cell sweep (liquid-picker strikes) 2026-05-28.
 *
 * Supersedes V3 defaults. V3 was systematically wrong about Phase 0 cell
 * because it used exact-strike-match instruments (often illiquid) for cost.
 * V5 uses the liquid-strike picker which selects the most-tradable strike
 * within ±$3k of target while preserving moneyness side. This produces
 * honest, internally-consistent EV.
 *
 * V5 sweep proved (per docs/PHASE_1_CELL_SWEEP_V5_2026-05-28.md):
 *   - calm (DVOL<40):     NO cell positive. Best is pair_25k_5pct_otm_3d (-$224).
 *                          System HALTS by default. Operator may override.
 *   - moderate (40-60):   pair_50k_2pct (Phase 0, +$326) leads, then otm_3d (+$136)
 *   - elevated (60-80):   pair_50k_2pct (+$833), pair_50k_5pct_otm (+$455)
 *   - stress (>80):       pair_50k_2pct (+$1,194) wins by a wide margin
 *
 * REMOVED from defaults (V3-broken cells still loss-making in V5):
 *   - pair_100k_3pct_itm_short  (still -$2k+ in all regimes)
 *   - pair_25k_1pct_atm_micro   (still -$145 to -$225)
 *   - pair_50k_3pct_atm         (still loss/marginal everywhere)
 *   - pair_25k_5pct_otm_short   (marginal — replaced by _3d variant)
 *   - pair_50k_4pct_otm_short   (marginal — kept in elevated/stress only)
 *
 * Operator may re-enable any cell via /admin/foxify/v2/cell-allowlist.
 */
export const DEFAULT_CELL_ALLOWLIST: Record<Regime, ReadonlyArray<string>> = {
  calm: [],
  moderate: ["pair_50k_2pct", "pair_25k_5pct_otm_3d", "pair_50k_5pct_otm"],
  elevated: ["pair_50k_2pct", "pair_50k_5pct_otm", "pair_25k_5pct_otm_3d", "pair_50k_4pct_otm_short"],
  stress: ["pair_50k_2pct", "pair_50k_5pct_otm", "pair_25k_5pct_otm_3d", "pair_50k_4pct_otm_short"]
};

export const ensureCellAllowlistSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_cell_allowlist_override (
      regime TEXT NOT NULL,
      cell_id TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      reason TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (regime, cell_id),
      CONSTRAINT two_sided_cell_allowlist_override_regime_check
        CHECK (regime IN ('calm', 'moderate', 'elevated', 'stress'))
    );
  `);
};

export type CellOverride = {
  regime: Regime;
  cellId: string;
  enabled: boolean;
  reason: string;
  updatedAt: string;
  updatedBy: string;
};

export const setCellOverride = async (
  pool: Pool | PoolClient,
  regime: Regime,
  cellId: string,
  enabled: boolean,
  reason: string,
  updatedBy: string
): Promise<void> => {
  await pool.query(
    `INSERT INTO two_sided_cell_allowlist_override (regime, cell_id, enabled, reason, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (regime, cell_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       reason = EXCLUDED.reason,
       updated_at = NOW(),
       updated_by = EXCLUDED.updated_by`,
    [regime, cellId, enabled, reason, updatedBy]
  );
};

export const getOverrides = async (pool: Pool | PoolClient, regime?: Regime): Promise<CellOverride[]> => {
  const q = regime
    ? "SELECT * FROM two_sided_cell_allowlist_override WHERE regime = $1"
    : "SELECT * FROM two_sided_cell_allowlist_override";
  const args = regime ? [regime] : [];
  const r = await pool.query(q, args);
  return r.rows.map((row) => ({
    regime: row.regime,
    cellId: row.cell_id,
    enabled: Boolean(row.enabled),
    reason: row.reason ?? "",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? "system"
  }));
};

/**
 * Resolves the effective allowlist for a regime: hardcoded default + DB overrides
 * applied on top. Returns array of cell IDs enabled for the regime.
 */
export const getEffectiveAllowlist = async (pool: Pool | PoolClient, regime: Regime): Promise<string[]> => {
  const defaults = new Set(DEFAULT_CELL_ALLOWLIST[regime]);
  const overrides = await getOverrides(pool, regime);
  for (const ov of overrides) {
    if (ov.enabled) defaults.add(ov.cellId);
    else defaults.delete(ov.cellId);
  }
  return Array.from(defaults);
};

/** Sync check: is the cell enabled in the regime per defaults (ignoring DB overrides)? */
export const isCellAllowedInRegimeDefault = (cellId: string, regime: Regime): boolean => {
  return DEFAULT_CELL_ALLOWLIST[regime].includes(cellId);
};

/** Async check with DB overrides applied. */
export const isCellAllowedInRegime = async (
  pool: Pool | PoolClient,
  cellId: string,
  regime: Regime
): Promise<{ allowed: boolean; suggestedCells: string[] }> => {
  const effective = await getEffectiveAllowlist(pool, regime);
  const allowed = effective.includes(cellId);
  return { allowed, suggestedCells: effective };
};
