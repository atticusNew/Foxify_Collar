/**
 * Deprecated-shadow flush — clears legacy/deprecated OPEN shadow pairs out of the
 * active set so the positions view + funnel reflect only the real strategy.
 *
 * Targets ONLY pairs that are:
 *   - is_shadow = TRUE  (paper — no real money is ever touched)
 *   - status in (active, triggered, unwinding)  (still open)
 *   - cell classified 'deprecated' in cellConfig.CELL_STATUS
 *
 * These are flushed to 'cancelled' (NOT settled): we are abandoning paper noise, not
 * inventing a settlement value. Cancelled pairs are excluded from realized stats (only
 * 'settled' counts) and from the active MTM list, so they stop polluting the view + the
 * settlement funnel. active→cancelled isn't a normal state-machine transition, so this
 * is a deliberate direct cancel (cleanup), scoped strictly to deprecated shadow pairs.
 *
 * Gated by SS_SHADOW_FLUSH_DEPRECATED (default on). Real (is_shadow=false) pairs and
 * non-deprecated cells are NEVER touched.
 */

import type { Pool, PoolClient } from "pg";
import { cellStatus } from "./cellConfig";
import { recordPairEvent } from "./db";

export const isDeprecatedFlushEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env.SS_SHADOW_FLUSH_DEPRECATED ?? "true").toLowerCase() !== "false";

export type FlushResult = { flushed: number; scanned_open_shadow: number; ids: string[] };

export const flushDeprecatedOpenShadowPairs = async (
  pool: Pool | PoolClient,
  opts: { dryRun?: boolean } = {}
): Promise<FlushResult> => {
  const r = await pool.query<{ pair_id: string; cell_id: string; status: string }>(
    `SELECT pair_id, cell_id, status
       FROM two_sided_pair
      WHERE is_shadow = TRUE AND status IN ('active','triggered','unwinding')`
  );
  const targets = r.rows.filter((row) => cellStatus(row.cell_id) === "deprecated");
  const ids: string[] = [];
  if (!opts.dryRun) {
    for (const t of targets) {
      // Direct cancel (cleanup) — leave closed_reason NULL (its CHECK allows only
      // trigger/foxify_close/expiry/atticus_halt); the reason lives in the event.
      await pool.query(
        `UPDATE two_sided_pair SET status = 'cancelled', closed_at = NOW(), updated_at = NOW() WHERE pair_id = $1`,
        [t.pair_id]
      );
      try {
        await recordPairEvent(pool, {
          pairId: t.pair_id,
          kind: "cancelled",
          details: { reason: "deprecated_shadow_flush", cell_id: t.cell_id, prev_status: t.status }
        });
      } catch { /* event table optional in some test pools — cancel still applied */ }
      ids.push(t.pair_id);
    }
  } else {
    ids.push(...targets.map((t) => t.pair_id));
  }
  return { flushed: opts.dryRun ? 0 : ids.length, scanned_open_shadow: r.rows.length, ids };
};
