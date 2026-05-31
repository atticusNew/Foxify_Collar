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

/**
 * SINGLE KNOB for the profit split. When env SS_ATTICUS_SPLIT_PCT is set (the
 * Foxify-keep fraction, e.g. 0.85 → Atticus gets the remaining 0.15), it
 * overrides EVERY tier's split — the same env the sim/sweep use, so live and
 * simulated economics share one control. SS_ATTICUS_FLOOR_USDC likewise
 * overrides the per-pair Atticus floor. When unset, the volume-based TIERS
 * table applies (current behavior). Invalid values are ignored.
 */
export const applySplitOverride = (tier: TierDefinition): TierDefinition => {
  let out = tier;
  const splitRaw = process.env.SS_ATTICUS_SPLIT_PCT;
  if (splitRaw != null && splitRaw !== "") {
    const foxifyPct = Number(splitRaw);
    if (Number.isFinite(foxifyPct) && foxifyPct > 0 && foxifyPct < 1) {
      out = { ...out, foxifyPct, atticusPct: +(1 - foxifyPct).toFixed(6) };
    }
  }
  const floorRaw = process.env.SS_ATTICUS_FLOOR_USDC;
  if (floorRaw != null && floorRaw !== "") {
    const floor = Number(floorRaw);
    if (Number.isFinite(floor) && floor >= 0) {
      out = { ...out, atticusFloorUsdc: floor };
    }
  }
  return out;
};

/** Tier definition for a label, with the split override applied. */
export const getTierByLabel = (label: string): TierDefinition => {
  const t = TIERS.find((x) => x.label === label) ?? TIERS[0];
  return applySplitOverride(t);
};

/** Resolve current tier for activation. Per-activation lookup, not retroactive. */
export const resolveCurrentTier = async (pool: Pool, nowMs?: number): Promise<TierDefinition> => {
  const n = await getRolling24hPairsCount(pool, nowMs);
  return applySplitOverride(tierFromPairsPerDay(n));
};
