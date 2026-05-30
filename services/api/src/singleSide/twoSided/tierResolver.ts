/**
 * Tier resolver — determines which tier a new activation lands in based on
 * recent volume (PLAN.md §3.4).
 *
 * Approach: count pairs activated in the last 24 hours; map count → tier band
 * via TIERS table. Tier is locked in at activation moment (per-activation tier
 * lookup, not retroactive), with a ±5% hysteresis band around each threshold to
 * prevent flapping between tiers when volume sits near a boundary.
 *
 * Per-activation tier means each pair settles under the tier active when it
 * was activated, regardless of later volume swings.
 */

import type { Pool } from "pg";
import { TIERS, type TierDefinition } from "./types";

/** Look up the tier definition for a given pairs-per-day value. */
export const tierFromPairsPerDay = (pairsPerDay: number, hysteresisPct = 0.05): TierDefinition => {
  // Without hysteresis: just walk the table.
  for (let i = 0; i < TIERS.length; i++) {
    const t = TIERS[i];
    const upper = t.maxPairsPerDay ?? Infinity;
    if (pairsPerDay >= t.minPairsPerDay && pairsPerDay < upper) {
      // Hysteresis: when within hysteresisPct of an upper boundary, look up one tier
      // (favor the higher tier — better Foxify split). When within hysteresisPct of a
      // lower boundary, stay in the current tier (sticky).
      // Only applied for non-terminal upper boundaries.
      if (upper !== Infinity && pairsPerDay > upper * (1 - hysteresisPct)) {
        return TIERS[Math.min(i + 1, TIERS.length - 1)];
      }
      return t;
    }
  }
  return TIERS[TIERS.length - 1];
};

/**
 * Count pairs activated in the last `windowMs` (default 24h) where the
 * created_at falls within the rolling window. Excludes cancelled pairs
 * (they were never live).
 */
export const getRolling24hPairsCount = async (pool: Pool, nowMs?: number): Promise<number> => {
  const now = nowMs ?? Date.now();
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM two_sided_pair
     WHERE created_at >= $1
       AND status <> 'cancelled'`,
    [since]
  );
  return r.rows[0]?.n ?? 0;
};

/** Resolve current tier for activation. Per-activation lookup, not retroactive. */
export const resolveCurrentTier = async (pool: Pool, nowMs?: number): Promise<TierDefinition> => {
  const n = await getRolling24hPairsCount(pool, nowMs);
  return tierFromPairsPerDay(n);
};
