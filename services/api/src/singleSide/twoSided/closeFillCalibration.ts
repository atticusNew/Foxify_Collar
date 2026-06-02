/**
 * Close-fill calibration logger.
 *
 * On every settled close we record what we ESTIMATED the close value to be
 * (pre-haircut combined option value × the slippage haircut) vs what the close
 * ACTUALLY realized (the executor's proceeds). Over enough LIVE closes this tells
 * us whether our close-value estimate / slippage haircut is calibrated — the live
 * Deribit test showed the real fill cleared a touch BELOW our exact-symbol bid
 * estimate, hinting the haircut is slightly optimistic. One point isn't enough;
 * this logger accrues the data so the haircut can be tuned with evidence.
 *
 * SHADOW closes value at the same chain bid they "fill" at, so their ratio is ~1
 * and uninformative — the summary separates live vs shadow and tunes off LIVE only.
 *
 * Self-contained: lazily ensures its table (CREATE TABLE IF NOT EXISTS) so it needs
 * no boot wiring; every write/read is tolerant (best-effort, never blocks a close).
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

let _schemaEnsured = false;

export const ensureCloseFillCalibrationSchema = async (exec: Pool | PoolClient): Promise<void> => {
  await exec.query(`
    CREATE TABLE IF NOT EXISTS two_sided_close_fill_calibration (
      obs_id                        TEXT PRIMARY KEY,
      pair_id                       TEXT NOT NULL,
      cell_id                       TEXT,
      is_shadow                     BOOLEAN NOT NULL DEFAULT FALSE,
      exit_mode                     TEXT,
      raw_combined_value_usdc       NUMERIC(20, 8),
      slippage_haircut              NUMERIC(20, 8),
      estimated_salvage_usdc        NUMERIC(20, 8),
      realized_salvage_usdc         NUMERIC(20, 8),
      implied_haircut               NUMERIC(20, 8),
      ratio_realized_to_estimated   NUMERIC(20, 8),
      put_valuation_method          TEXT,
      call_valuation_method         TEXT,
      occurred_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await exec.query(`CREATE INDEX IF NOT EXISTS two_sided_close_fill_calibration_cell_idx ON two_sided_close_fill_calibration(cell_id);`);
    await exec.query(`CREATE INDEX IF NOT EXISTS two_sided_close_fill_calibration_shadow_idx ON two_sided_close_fill_calibration(is_shadow);`);
  } catch { /* pg-mem index support varies */ }
};

const ensureOnce = async (exec: Pool | PoolClient): Promise<void> => {
  if (_schemaEnsured) return;
  await ensureCloseFillCalibrationSchema(exec);
  _schemaEnsured = true;
};

export type CloseFillObservation = {
  pairId: string;
  cellId?: string;
  isShadow: boolean;
  exitMode?: string | null;
  /** Pre-haircut combined option value we estimated at close (referenceValue). */
  rawCombinedValueUsdc: number;
  /** Slippage haircut applied to the estimate. */
  slippageHaircut: number;
  /** realized close proceeds (real fill for live; the estimate itself for shadow). */
  realizedSalvageUsdc: number;
  putValuationMethod?: string | null;
  callValuationMethod?: string | null;
};

/**
 * Record one close-fill observation. Best-effort: swallows all errors so it can
 * never interfere with settlement.
 */
export const recordCloseFillObservation = async (
  exec: Pool | PoolClient,
  obs: CloseFillObservation
): Promise<void> => {
  try {
    await ensureOnce(exec);
    const estimated = obs.rawCombinedValueUsdc * obs.slippageHaircut;
    const impliedHaircut = obs.rawCombinedValueUsdc > 0 ? obs.realizedSalvageUsdc / obs.rawCombinedValueUsdc : null;
    const ratio = estimated > 0 ? obs.realizedSalvageUsdc / estimated : null;
    await exec.query(
      `INSERT INTO two_sided_close_fill_calibration
         (obs_id, pair_id, cell_id, is_shadow, exit_mode, raw_combined_value_usdc,
          slippage_haircut, estimated_salvage_usdc, realized_salvage_usdc,
          implied_haircut, ratio_realized_to_estimated, put_valuation_method, call_valuation_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        randomUUID(), obs.pairId, obs.cellId ?? null, obs.isShadow, obs.exitMode ?? null,
        obs.rawCombinedValueUsdc, obs.slippageHaircut, estimated, obs.realizedSalvageUsdc,
        impliedHaircut, ratio, obs.putValuationMethod ?? null, obs.callValuationMethod ?? null
      ]
    );
  } catch {
    /* best-effort calibration log — never block a close */
  }
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round4 = (x: number): number => +x.toFixed(4);

export type CloseFillCalibration = {
  n: number;
  live_n: number;
  shadow_n: number;
  /** LIVE-only stats (the actionable ones — shadow ratio ≈ 1 by construction). */
  live: {
    mean_implied_haircut: number | null;
    median_implied_haircut: number | null;
    mean_ratio_realized_to_estimated: number | null;
    current_haircut_observed: number | null;
  };
  per_cell: Array<{ cell_id: string; n: number; live_n: number; mean_implied_haircut: number | null }>;
  recommendation: string;
};

export const getCloseFillCalibration = async (
  exec: Pool | PoolClient,
  opts: { cells?: string[] } = {}
): Promise<CloseFillCalibration> => {
  try {
    await ensureOnce(exec);
  } catch {
    return emptyCalibration("calibration table unavailable");
  }
  const r = await exec.query<{
    cell_id: string | null; is_shadow: boolean; implied_haircut: string | null;
    ratio_realized_to_estimated: string | null; slippage_haircut: string | null;
  }>(
    `SELECT cell_id, is_shadow, implied_haircut, ratio_realized_to_estimated, slippage_haircut
       FROM two_sided_close_fill_calibration`
  );
  let rows = r.rows;
  if (opts.cells && opts.cells.length > 0) {
    const set = new Set(opts.cells);
    rows = rows.filter((x) => x.cell_id != null && set.has(x.cell_id));
  }
  const liveRows = rows.filter((x) => !x.is_shadow);
  const liveImplied = liveRows.map((x) => (x.implied_haircut == null ? NaN : Number(x.implied_haircut))).filter((x) => Number.isFinite(x));
  const liveRatio = liveRows.map((x) => (x.ratio_realized_to_estimated == null ? NaN : Number(x.ratio_realized_to_estimated))).filter((x) => Number.isFinite(x));
  const liveHaircuts = liveRows.map((x) => (x.slippage_haircut == null ? NaN : Number(x.slippage_haircut))).filter((x) => Number.isFinite(x));
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

  const perCellMap = new Map<string, { n: number; live_n: number; implied: number[] }>();
  for (const x of rows) {
    const cell = x.cell_id ?? "unknown";
    const e = perCellMap.get(cell) ?? { n: 0, live_n: 0, implied: [] };
    e.n++;
    if (!x.is_shadow) {
      e.live_n++;
      const ih = x.implied_haircut == null ? NaN : Number(x.implied_haircut);
      if (Number.isFinite(ih)) e.implied.push(ih);
    }
    perCellMap.set(cell, e);
  }
  const per_cell = Array.from(perCellMap.entries()).map(([cell_id, e]) => ({
    cell_id, n: e.n, live_n: e.live_n,
    mean_implied_haircut: e.implied.length ? round4(mean(e.implied)!) : null
  }));

  const meanImplied = mean(liveImplied);
  const curHaircut = mean(liveHaircuts);
  let recommendation: string;
  if (liveImplied.length < 5) {
    recommendation = `Only ${liveImplied.length} LIVE close(s) — not enough to tune the slippage haircut (need ≥5). Keep accruing; shadow closes (${rows.length - liveRows.length}) are ~1.0 by construction and excluded.`;
  } else if (meanImplied != null && curHaircut != null) {
    const delta = meanImplied - curHaircut;
    recommendation = Math.abs(delta) < 0.03
      ? `Slippage haircut looks calibrated: realized/estimate-value ≈ ${round4(meanImplied)} vs applied ${round4(curHaircut)} (Δ ${round4(delta)}). No change needed.`
      : `Realized fills clear at ~${round4(meanImplied)}× raw value vs the applied ${round4(curHaircut)} haircut (Δ ${round4(delta)}). Consider setting the close slippage haircut toward ${round4(meanImplied)} to remove the bias.`;
  } else {
    recommendation = "Insufficient signal.";
  }

  return {
    n: rows.length,
    live_n: liveRows.length,
    shadow_n: rows.length - liveRows.length,
    live: {
      mean_implied_haircut: meanImplied == null ? null : round4(meanImplied),
      median_implied_haircut: liveImplied.length ? round4(median(liveImplied)) : null,
      mean_ratio_realized_to_estimated: mean(liveRatio) == null ? null : round4(mean(liveRatio)!),
      current_haircut_observed: curHaircut == null ? null : round4(curHaircut)
    },
    per_cell,
    recommendation
  };
};

const emptyCalibration = (note: string): CloseFillCalibration => ({
  n: 0, live_n: 0, shadow_n: 0,
  live: { mean_implied_haircut: null, median_implied_haircut: null, mean_ratio_realized_to_estimated: null, current_haircut_observed: null },
  per_cell: [],
  recommendation: note
});

/** Test-only: reset the lazy schema-ensure flag. */
export const __resetCloseFillSchemaFlag = (): void => { _schemaEnsured = false; };
