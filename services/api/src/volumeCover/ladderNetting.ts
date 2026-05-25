/**
 * P1e — Volume Cover ladder netting.
 *
 * When a new position opens for a cell within 30 minutes of a prior
 * close or trigger that left retained legs, repurpose the matching
 * legs into the new position instead of buying fresh. Saves the
 * hedge cost of the matched side(s) — material savings, especially
 * post-Bundle-3-B where this is the dominant economic lever.
 *
 * Match criteria per leg (must all hold):
 *   - same cell
 *   - same option_kind (put / call)
 *   - retained_at within 30 min of now
 *   - retained=TRUE, status='open'
 *   - expiry_iso ≥ now + 1 day (enough remaining tenor)
 *   - strike within ±1.5% of new pair's required strike
 *   - contractsBtc ≥ new pair's required size
 *   - ladder_hop_count < 1 (single hop per lineage)
 *
 * 2026-05-25 (Bundle-3-B follow-up): the prior `same fingerprint`
 * requirement was REMOVED. Rationale:
 *   1. Pilot has a single counterparty (Foxify) — all retained legs
 *      come from the same source so cross-tenant mismatch is not a
 *      concern.
 *   2. The strike + expiry + cell match criteria are tight enough
 *      that a "wrong" match would be functionally identical (same
 *      option contract on the venue).
 *   3. Foxify wasn't sending fingerprintHash on /activate (verified
 *      via 12 historical pair_event audit rows — all null), so
 *      requiring it produced 0% laddering — exactly the assumption
 *      the post-Bundle-3-B Monte Carlo identified as the make-or-
 *      break for pilot economics.
 *   4. Other guardrails (tick spacing, max-hold, capital caps,
 *      cell throttle, depth gate) remain in place.
 *
 * `fingerprintHash` is still accepted for telemetry + audit logging
 * (forward compat). It is NOT a match gate.
 *
 * If matched: leg is repurposed via volumeCoverDb.repurposeHedgeLeg
 * (transaction-safe: clears retention flags, points at new
 * position_id, increments hop count, records repurposed_from). Skip
 * the venue buy on that side.
 *
 * If not matched: caller proceeds with normal buy.
 *
 * If retained leg's contracts > new pair's required: we keep the
 * whole leg under the new position (slight over-hedge on this
 * cover). Splitting a leg would require contract-level partial
 * sells which aren't supported by venue adapters; over-hedge is
 * preferable to skipping the netting.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { CellDefinition } from "./matrix";
import { computeTriggerPrices } from "./matrix";
import type { HedgeStructure, HedgeVenueChoice } from "./tightHedge";
import type { SpreadStructure, SpreadLegSpec } from "./spreadHedge";
import {
  insertLadderNettingEvent,
  listRetainedHedgeLegs,
  repurposeHedgeLeg,
  insertHedgeLeg,
  type HedgeLegRow
} from "./volumeCoverDb";

export type LadderNettingResult = {
  /** Leg specs that should still be bought via the venue executor. */
  remainingLegs: HedgeStructure["legs"];
  /** Repurposed leg rows (already pointed at new position). */
  repurposedLegs: HedgeLegRow[];
  /** Estimated USDC saved by netting (sum of buy_price × contracts of repurposed legs). */
  estimatedSavingsUsdc: number;
  /** Audit event id, or null if no netting fired. */
  ladderEventId: string | null;
};

export type LadderNettingConfig = {
  /** Max age of retained leg considered for matching, ms. Default 30min. */
  maxRetainedAgeMs: number;
  /** Min remaining tenor required, ms. Default 7d. */
  minRemainingTenorMs: number;
  /** Max strike distance, fraction. Default 0.015 (1.5%). */
  maxStrikeDistancePct: number;
  /** Max ladder hop count. Default 1. */
  maxHopCount: number;
};

const DEFAULT_CONFIG: LadderNettingConfig = {
  maxRetainedAgeMs: 30 * 60 * 1_000,
  // 2026-05-19: lowered from 7d → 1d. The per-cell tenor change introduced
  // 3-day tenors on the 2% cell, which previously disabled ALL ladder
  // netting on short-tenor cells (legs only had 3 days at open, never
  // ≥7 days remaining). 1d is the floor at which we'd still trust a
  // retained leg as the primary hedge for a new position. Overridable
  // via VC_LADDER_MIN_TENOR_MS.
  minRemainingTenorMs: 86_400_000,
  maxStrikeDistancePct: 0.015,
  maxHopCount: 1
};

const readConfig = (): LadderNettingConfig => {
  const cfg = { ...DEFAULT_CONFIG };
  const env = process.env;
  if (env.VC_LADDER_MAX_AGE_MS) {
    const n = Number(env.VC_LADDER_MAX_AGE_MS);
    if (Number.isFinite(n) && n > 0) cfg.maxRetainedAgeMs = n;
  }
  if (env.VC_LADDER_MIN_TENOR_MS) {
    const n = Number(env.VC_LADDER_MIN_TENOR_MS);
    if (Number.isFinite(n) && n > 0) cfg.minRemainingTenorMs = n;
  }
  if (env.VC_LADDER_MAX_STRIKE_DIST_PCT) {
    const n = Number(env.VC_LADDER_MAX_STRIKE_DIST_PCT);
    if (Number.isFinite(n) && n > 0) cfg.maxStrikeDistancePct = n;
  }
  return cfg;
};

/**
 * Try to match retained legs against the new pair's hedge structure
 * and repurpose where possible. Returns the legs that still need to
 * be bought + audit details.
 *
 * Caller must:
 *   1. Have already inserted the new position row (so newPositionId is valid)
 *   2. Pass the structure produced by buildHedgeStructure
 *   3. Receive remainingLegs and call executeHedgeStructure with them
 *      (or a stripped-down structure containing only those legs)
 */
export const attemptLadderNetting = async (params: {
  pool: Pool;
  newPositionId: string;
  cell: CellDefinition;
  fingerprintHash: string | null;
  entryBtcPrice: number;
  structure: HedgeStructure;
  /** Test override for "now". */
  nowMs?: number;
}): Promise<LadderNettingResult> => {
  const { pool, newPositionId, cell, fingerprintHash, entryBtcPrice, structure } = params;
  const cfg = readConfig();
  const nowMs = params.nowMs ?? Date.now();

  // Bundle-3-B follow-up (2026-05-25): no fingerprint requirement —
  // single-counterparty assumption locked in. Env flag still respected.
  if (process.env.VOLUME_COVER_LADDER_NETTING_ENABLED === "false") {
    return {
      remainingLegs: structure.legs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }

  const retainedAfterIso = new Date(nowMs - cfg.maxRetainedAgeMs).toISOString();
  const expiryAfterIso = new Date(nowMs + cfg.minRemainingTenorMs).toISOString();

  // fingerprintHash NOT passed to the SQL query — match across all
  // retained legs in the cell.
  const retainedLegs = await listRetainedHedgeLegs(pool, {
    cellId: cell.cellId,
    expiryAfterIso,
    retainedAfterIso
  });
  if (retainedLegs.length === 0) {
    return {
      remainingLegs: structure.legs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }

  const remainingLegs: HedgeStructure["legs"] = [];
  const repurposedLegs: HedgeLegRow[] = [];
  let savings = 0;
  // Pull a single "prior position" id for audit; if multiple, use the
  // first repurposed leg's source.
  let priorPositionIdForAudit: string | null = null;

  for (const newLeg of structure.legs) {
    // Find a retained leg of the same kind, within strike tolerance,
    // sufficient size, hop count under cap. Pick MOST recent.
    const candidate = retainedLegs.find((l) => {
      if (l.optionKind !== newLeg.optionKind) return false;
      if (l.ladderHopCount >= cfg.maxHopCount) return false;
      if (l.contracts < newLeg.contractsBtc - 1e-9) return false;
      const strikeDist = Math.abs(l.strikeUsdc - newLeg.strikeUsdc) / Math.max(l.strikeUsdc, newLeg.strikeUsdc);
      if (strikeDist > cfg.maxStrikeDistancePct) return false;
      // Already used by another leg in this loop? skip.
      if (repurposedLegs.some((r) => r.id === l.id)) return false;
      return true;
    });

    if (!candidate) {
      remainingLegs.push(newLeg);
      continue;
    }

    const repurposed = await repurposeHedgeLeg(pool, {
      legId: candidate.id,
      newPositionId,
      maxHops: cfg.maxHopCount
    });
    if (!repurposed) {
      // Lost a race or hop cap hit — fallback to fresh buy
      remainingLegs.push(newLeg);
      continue;
    }
    repurposedLegs.push(repurposed);
    savings += candidate.buyPriceUsdc * candidate.contracts;
    if (!priorPositionIdForAudit) {
      priorPositionIdForAudit = candidate.repurposedFromPositionId ?? candidate.positionId;
    }
  }

  if (repurposedLegs.length === 0) {
    return {
      remainingLegs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }

  // Insert audit event
  const eventId = `vc-ladder-${randomUUID()}`;
  await insertLadderNettingEvent(pool, {
    id: eventId,
    priorPositionId: priorPositionIdForAudit ?? "unknown",
    newPositionId,
    fingerprintHash,
    cellId: cell.cellId,
    legsRepurposed: repurposedLegs.map((l) => ({
      legId: l.id,
      optionKind: l.optionKind,
      strikeUsdc: l.strikeUsdc,
      contractsBtc: l.contracts
    })),
    estimatedSavingsUsdc: savings
  });

  return {
    remainingLegs,
    repurposedLegs,
    estimatedSavingsUsdc: savings,
    ladderEventId: eventId
  };
};

// ─── PR-Bundle-3-B (2026-05-25): spread-path ladder netting ────────────────
//
// Mirror of attemptLadderNetting for the 4-leg [DB] vertical spread. Only
// LONG legs are eligible (shorts are flatten-to-zero on close, nothing to
// retain). Match criteria are identical to the strangle path. Each
// repurposed leg has its `leg_role` and `spread_group_id` rewritten to
// the new spread's values so the close-path code can identify it.
//
// Returns a `legsToPlace` subset of structure.legs that the caller must
// pass into openSpread. The 4-leg open sequence still preserves the
// "covered window" invariant when one or both longs are laddered:
//   • laddered put_long is at venue from the prior position
//     → SELL short_put is immediately covered
//   • same for the call side
// So skipping a long's BUY in openSpread does not introduce a naked
// window. We deliberately keep the full structure.legs in the returned
// SpreadStructure so close-path code (partialCloseSpreadOnTrigger,
// closeSpread) sees all 4 legs and behaves normally — only the OPEN
// path skips the laddered ones.

export type SpreadLadderNettingResult = {
  /** Spec subset to pass into openSpread (fresh buys only). */
  legsToPlace: SpreadStructure["legs"];
  /** Repurposed leg rows, already re-pointed at newPositionId + new spread group + new leg_role. */
  repurposedLegs: HedgeLegRow[];
  /** Estimated USDC saved (sum of buy_price × contracts of repurposed long legs). */
  estimatedSavingsUsdc: number;
  /** Audit event id, or null if no netting fired. */
  ladderEventId: string | null;
  /** Per-leg breakdown for telemetry. */
  perLeg: Array<{
    legRole: SpreadLegSpec["legRole"];
    matched: boolean;
    matchedLegId?: string;
    reason?: string;
  }>;
};

export const attemptLadderNettingForSpread = async (params: {
  pool: Pool;
  newPositionId: string;
  newSpreadGroupId: string;
  cell: CellDefinition;
  fingerprintHash: string | null;
  structure: SpreadStructure;
  /** Test override for "now". */
  nowMs?: number;
}): Promise<SpreadLadderNettingResult> => {
  const { pool, newPositionId, newSpreadGroupId, cell, fingerprintHash, structure } = params;
  const cfg = readConfig();
  const nowMs = params.nowMs ?? Date.now();

  const noOp = (perLeg: SpreadLadderNettingResult["perLeg"]): SpreadLadderNettingResult => ({
    legsToPlace: structure.legs,
    repurposedLegs: [],
    estimatedSavingsUsdc: 0,
    ladderEventId: null,
    perLeg
  });

  if (process.env.VOLUME_COVER_LADDER_NETTING_ENABLED === "false") {
    return noOp(structure.legs.map((l) => ({
      legRole: l.legRole,
      matched: false,
      reason: "feature_disabled"
    })));
  }
  // Bundle-3-B follow-up (2026-05-25): fingerprintHash is no longer a
  // match gate — single-counterparty assumption + tight strike/expiry
  // criteria make cross-tenant mismatch impossible in practice. Field
  // still accepted for audit logging.

  const longLegSpecs = structure.legs.filter((l) => l.side === "long");
  if (longLegSpecs.length === 0) {
    // Defensive — a properly-built [DB] spread always has 2 long legs.
    return noOp(structure.legs.map((l) => ({
      legRole: l.legRole,
      matched: false,
      reason: "no_long_legs"
    })));
  }

  const retainedAfterIso = new Date(nowMs - cfg.maxRetainedAgeMs).toISOString();
  const expiryAfterIso = new Date(nowMs + cfg.minRemainingTenorMs).toISOString();

  // fingerprintHash NOT passed to the SQL query — match across all
  // retained legs in the cell.
  const retainedLegs = await listRetainedHedgeLegs(pool, {
    cellId: cell.cellId,
    expiryAfterIso,
    retainedAfterIso
  });
  if (retainedLegs.length === 0) {
    return noOp(structure.legs.map((l) => ({
      legRole: l.legRole,
      matched: false,
      reason: "no_retained_legs"
    })));
  }

  const placeSet = new Set<string>(structure.legs.map((l) => l.legRole)); // legs that still need fresh placement
  const repurposedLegs: HedgeLegRow[] = [];
  let savings = 0;
  let priorPositionIdForAudit: string | null = null;
  const perLeg: SpreadLadderNettingResult["perLeg"] = [];

  for (const newLeg of structure.legs) {
    if (newLeg.side === "short") {
      perLeg.push({ legRole: newLeg.legRole, matched: false, reason: "short_leg_not_eligible" });
      continue;
    }
    const candidate = retainedLegs.find((l) => {
      if (l.optionKind !== newLeg.optionKind) return false;
      if (l.ladderHopCount >= cfg.maxHopCount) return false;
      if (l.contracts < newLeg.contractsBtc - 1e-9) return false;
      const denom = Math.max(l.strikeUsdc, newLeg.strikeActualUsdc);
      const strikeDist = Math.abs(l.strikeUsdc - newLeg.strikeActualUsdc) / denom;
      if (strikeDist > cfg.maxStrikeDistancePct) return false;
      if (repurposedLegs.some((r) => r.id === l.id)) return false;
      return true;
    });

    if (!candidate) {
      perLeg.push({ legRole: newLeg.legRole, matched: false, reason: "no_match" });
      continue;
    }

    const repurposed = await repurposeHedgeLeg(pool, {
      legId: candidate.id,
      newPositionId,
      maxHops: cfg.maxHopCount,
      newLegRole: newLeg.legRole,
      newSpreadGroupId
    });
    if (!repurposed) {
      // Lost a race or hop cap hit — fallback to fresh buy
      perLeg.push({ legRole: newLeg.legRole, matched: false, reason: "race_or_hop_cap" });
      continue;
    }
    repurposedLegs.push(repurposed);
    placeSet.delete(newLeg.legRole);
    savings += candidate.buyPriceUsdc * candidate.contracts;
    if (!priorPositionIdForAudit) {
      priorPositionIdForAudit = candidate.repurposedFromPositionId ?? candidate.positionId;
    }
    perLeg.push({
      legRole: newLeg.legRole,
      matched: true,
      matchedLegId: candidate.id
    });
  }

  if (repurposedLegs.length === 0) {
    return {
      legsToPlace: structure.legs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null,
      perLeg
    };
  }

  const eventId = `vc-ladder-${randomUUID()}`;
  await insertLadderNettingEvent(pool, {
    id: eventId,
    priorPositionId: priorPositionIdForAudit ?? "unknown",
    newPositionId,
    fingerprintHash,
    cellId: cell.cellId,
    legsRepurposed: repurposedLegs.map((l) => ({
      legId: l.id,
      optionKind: l.optionKind,
      strikeUsdc: l.strikeUsdc,
      contractsBtc: l.contracts
    })),
    estimatedSavingsUsdc: savings
  });

  const legsToPlace = structure.legs.filter((l) => placeSet.has(l.legRole));

  return {
    legsToPlace,
    repurposedLegs,
    estimatedSavingsUsdc: savings,
    ladderEventId: eventId,
    perLeg
  };
};
