/**
 * Stale / out-of-band-closed pair detector.
 *
 * Read-only: lists non-terminal pairs (active/triggered/unwinding) with age,
 * past-expiry, runtime-presence, and legs-sold flags. Flags `likely_out_of_band`
 * when a pair is 'unwinding', older than the stale threshold, and has NO live
 * runtime — i.e. a close that stalled or was done directly on the venue and never
 * synced back. These are the candidates for reconcile-settle.
 *
 * Extracted from the route so it is unit-testable (runtime presence injected).
 */

import type { Pool, PoolClient } from "pg";
import { getLegsForPair } from "./db";

export type StuckPair = {
  pair_id: string;
  cell_id: string;
  is_shadow: boolean;
  status: string;
  age_minutes: number;
  past_expiry: boolean;
  has_runtime: boolean;
  legs_sold: boolean;
  likely_out_of_band: boolean;
};

export type StuckPairsReport = {
  as_of: string;
  stale_minutes: number;
  total_non_terminal: number;
  likely_out_of_band_count: number;
  pairs: StuckPair[];
  note: string;
};

export const detectStuckPairs = async (
  pool: Pool | PoolClient,
  opts: { staleMinutes?: number; nowMs?: number; hasRuntime: (pairId: string) => boolean }
): Promise<StuckPairsReport> => {
  const staleMinutes = opts.staleMinutes != null && Number.isFinite(opts.staleMinutes) ? opts.staleMinutes : 15;
  const now = opts.nowMs ?? Date.now();
  const r = await pool.query(
    `SELECT pair_id, cell_id, is_shadow, status, expires_at, updated_at, created_at
       FROM two_sided_pair
      WHERE status IN ('active','triggered','unwinding')
      ORDER BY updated_at ASC`
  );
  const pairs: StuckPair[] = [];
  for (const row of r.rows) {
    const pairId = row.pair_id as string;
    const updatedMs = row.updated_at ? Date.parse(String(row.updated_at)) : now;
    const ageMin = Math.max(0, (now - updatedMs) / 60_000);
    const pastExpiry = row.expires_at ? now > Date.parse(String(row.expires_at)) : false;
    const hasRuntime = opts.hasRuntime(pairId);
    const legs = await getLegsForPair(pool, pairId);
    const legsSold = legs.length === 2 && legs.every((l) => l.sellFilledAt != null);
    const status = row.status as string;
    const likelyOutOfBand = status === "unwinding" && ageMin >= staleMinutes && !hasRuntime;
    pairs.push({
      pair_id: pairId,
      cell_id: row.cell_id as string,
      is_shadow: Boolean(row.is_shadow),
      status,
      age_minutes: +ageMin.toFixed(1),
      past_expiry: pastExpiry,
      has_runtime: hasRuntime,
      legs_sold: legsSold,
      likely_out_of_band: likelyOutOfBand
    });
  }
  return {
    as_of: new Date(now).toISOString(),
    stale_minutes: staleMinutes,
    total_non_terminal: pairs.length,
    likely_out_of_band_count: pairs.filter((x) => x.likely_out_of_band).length,
    pairs,
    note: "likely_out_of_band pairs are candidates for POST /admin/foxify/v2/reconcile-settle (legs already closed on-venue). Pairs WITH a runtime / still-held legs should use respawn-close instead."
  };
};
