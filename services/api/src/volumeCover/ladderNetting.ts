/**
 * P1e — Volume Cover ladder netting.
 *
 * When a fingerprint reopens the SAME cell within 30 minutes of a
 * close or trigger, repurpose any matching Atticus-retained legs into
 * the new position instead of buying fresh. Saves the hedge cost of
 * the matched side(s) — material savings since pilot will start in
 * the hole at the locked $350/day base price.
 *
 * Match criteria per leg (must all hold):
 *   - same fingerprint
 *   - same cell
 *   - same option_kind (put / call)
 *   - retained_at within 30 min of now
 *   - retained=TRUE, status='open'
 *   - expiry_iso ≥ now + 7 days (enough remaining tenor for new pair)
 *   - strike within ±1.5% of new pair's required strike
 *   - contractsBtc ≥ new pair's required size
 *   - ladder_hop_count < 1 (single hop per lineage)
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
  minRemainingTenorMs: 7 * 86_400_000,
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

  // Disable when no fingerprint (cannot match without a stable
  // identity) or when env disabled.
  if (process.env.VOLUME_COVER_LADDER_NETTING_ENABLED === "false") {
    return {
      remainingLegs: structure.legs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }
  if (!fingerprintHash) {
    return {
      remainingLegs: structure.legs,
      repurposedLegs: [],
      estimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }

  const retainedAfterIso = new Date(nowMs - cfg.maxRetainedAgeMs).toISOString();
  const expiryAfterIso = new Date(nowMs + cfg.minRemainingTenorMs).toISOString();

  const retainedLegs = await listRetainedHedgeLegs(pool, {
    fingerprintHash,
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
