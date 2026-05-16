/**
 * Position lifecycle orchestration — Volume Cover.
 *
 * Coordinates the open / monitor / trigger / close flow:
 *
 *   1. openPosition  — guardrail check, persist position, execute hedge,
 *                      ledger entries (premium_in for Foxify, hedge_buy_out
 *                      for Atticus pool)
 *   2. fireTrigger   — sell winning hedge leg, capture proceeds, record
 *                      salvage event, mark position triggered, ledger
 *                      entries (payout_out for Foxify, hedge_sell_in)
 *   3. closePosition — explicit close (no trigger), sell hedge legs at
 *                      market, mark closed, ledger entries
 *
 * Each lifecycle action is transactional where it touches both DB and
 * the venue. If the venue call fails after DB insert, we mark the row
 * with status='failed' and emit a recovery alert.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CellDefinition } from "./matrix";
import { computeTriggerPrices } from "./matrix";
import {
  buildHedgeStructure,
  executeHedgeStructure,
  type HedgeExecutor,
  type HedgeVenueChoice
} from "./tightHedge";
import type { VolRegime } from "./strikeGrid";
import {
  insertPosition,
  insertHedgeLeg,
  listHedgeLegsForPosition,
  markHedgeLegSold,
  markHedgeLegRetained,
  markPositionTriggered,
  markPositionClosed,
  type PositionRow,
  type HedgeLegRow,
  type RetainedRole
} from "./volumeCoverDb";
import { recordTriggerEvent } from "./salvageTracker";
import { insertLedgerEntry } from "../pilot/capitalPoolLedger";

export type OpenPositionRequest = {
  cell: CellDefinition;
  foxifyPairId: string;
  pairLongNotionalUsdc: number;
  pairShortNotionalUsdc: number;
  pairEntryBtcPrice: number;
  fingerprintHash?: string | null;
  /** Optional override of the cell base premium (e.g., from cell row override) */
  effectiveDailyPremiumUsdc?: number;
  /**
   * P1c: optional vol regime for vol-buffered sizing. Routes pull this
   * from regimeClassifier at quote time. null/undefined = no buffer.
   */
  regime?: VolRegime | null;
  metadata?: Record<string, unknown>;
};

export type OpenPositionResult = {
  position: PositionRow;
  hedgeLegs: HedgeLegRow[];
  totalHedgeCostUsdc: number;
  venue: HedgeVenueChoice;
};

/**
 * Open a new Volume Cover position. Caller must run guardrail checks
 * BEFORE calling this; this function assumes go-ahead.
 *
 * Performs:
 *   - Trigger price computation
 *   - Position row insert
 *   - Hedge execution (both legs)
 *   - Hedge leg row inserts
 *   - Ledger entries: premium_in (Foxify pool credit) + hedge_buy_out (Atticus pool debit)
 *
 * Throws if hedge execution fails. On throw, position row is marked
 * 'cancelled' and no ledger entries are made.
 */
export const openPosition = async (
  pool: Pool,
  executor: HedgeExecutor,
  req: OpenPositionRequest
): Promise<OpenPositionResult> => {
  const positionId = `vc-pos-${randomUUID()}`;
  const dailyPremium = req.effectiveDailyPremiumUsdc ?? req.cell.dailyPremiumUsdc;

  const { triggerHighBtc, triggerLowBtc } = computeTriggerPrices({
    cell: req.cell,
    entryBtcPrice: req.pairEntryBtcPrice
  });

  // Persist position FIRST (status='active'). If hedge fails, we mark cancelled.
  let position: PositionRow;
  try {
    position = await insertPosition(pool, {
      id: positionId,
      cellId: req.cell.cellId,
      foxifyPairId: req.foxifyPairId,
      pairLongNotionalUsdc: req.pairLongNotionalUsdc,
      pairShortNotionalUsdc: req.pairShortNotionalUsdc,
      pairEntryBtcPrice: req.pairEntryBtcPrice,
      triggerHighBtc,
      triggerLowBtc,
      dailyPremiumUsdc: dailyPremium,
      payoutUsdc: req.cell.payoutUsdc,
      fingerprintHash: req.fingerprintHash ?? null,
      metadata: req.metadata
    });
  } catch (err: any) {
    throw new Error(`volume_cover_position_insert_failed: ${err?.message ?? err}`);
  }

  // Build + execute hedge (P1c: vol-buffered sizing + grid snap from regime)
  const structure = buildHedgeStructure({
    positionId,
    cell: req.cell,
    entryBtcPrice: req.pairEntryBtcPrice,
    regime: req.regime ?? null
  });

  let executionResult;
  try {
    executionResult = await executeHedgeStructure({
      structure,
      cell: req.cell,
      executor
    });
  } catch (err: any) {
    // Hedge failed; cancel the position so it doesn't show as active
    await markPositionClosed(pool, {
      id: positionId,
      reason: `hedge_execution_failed: ${err?.message ?? err}`
    });
    throw new Error(`volume_cover_hedge_execution_failed: ${err?.message ?? err}`);
  }

  // Persist hedge legs
  const hedgeLegs: HedgeLegRow[] = [];
  for (const f of executionResult.legs) {
    const leg = await insertHedgeLeg(pool, {
      id: f.legId,
      positionId,
      venue: f.venue,
      optionKind: f.optionKind,
      strikeUsdc: f.strikeUsdc,
      expiryIso: f.expiryIso,
      contracts: f.contractsBtc,
      buyPriceUsdc: f.fillPriceUsdcPerBtc,
      buyOrderId: f.orderId,
      status: "open",
      metadata: { totalCostUsdc: f.totalCostUsdc }
    });
    hedgeLegs.push(leg);
  }

  // P1d (2026-05-16): NO open-time premium_in ledger entry. Premium is
  // proportional to days held (Foxify pays only for held days, NOT
  // upfront). Source of truth: position row (opened_at × dailyPremium).
  // Final premium_in entry is written by closePosition with actual
  // accrued amount; weekly reconciler also computes from position rows
  // as the canonical view. See weeklyReconciler.buildWeeklySettlement.
  try {
    await insertLedgerEntry(pool, {
      poolId: "atticus_hedge",
      protectionId: positionId,
      entryType: "hedge_buy_out",
      amountUsdc: -executionResult.totalCostUsdc,
      reference: `vc_hedge_buy:${req.cell.cellId}:${positionId}`,
      metadata: { product: "volume_cover", legCount: executionResult.legs.length }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] hedge_buy_out ledger failed for position ${positionId}: ${(err as Error).message}`
    );
  }

  return {
    position,
    hedgeLegs,
    totalHedgeCostUsdc: executionResult.totalCostUsdc,
    venue: executionResult.venue
  };
};

/**
 * Fire a trigger event for an active position.
 *
 * P1b (2026-05-16): Atticus RETAINS hedge legs after trigger.
 *   Spec: "If protection triggers, hedge protection closes for Foxify
 *   but we still own to TP and salvage."
 *
 *   On trigger:
 *     1. Mark position triggered (closes Foxify-side obligation; payout owed)
 *     2. Tag each leg with retained_role:
 *          winner_post_trigger — leg whose strike side BTC crossed
 *          loser_post_trigger  — opposite side leg
 *     3. Mark legs retained=TRUE (status stays 'open' — Atticus owns option)
 *     4. Insert payout_out ledger entry (Foxify owed)
 *     5. Insert salvage_pending audit row in salvage_event with
 *        hedge_sale_proceeds_usdc=0 (placeholder; finalized when hedge
 *        manager actually sells the legs and writes the
 *        hedge_sell_in ledger entries)
 *
 *   The VolumeCover hedge manager (60s tick) is responsible for the
 *   actual sell, the proceeds ledger, and updating the salvage record
 *   with realized salvage. This function does NOT call sellOptionLeg.
 */
export const fireTrigger = async (
  pool: Pool,
  _executor: HedgeExecutor,
  params: {
    position: PositionRow;
    direction: "high" | "low";
    triggerSpotBtc?: number;
  }
): Promise<{
  salvageEventId: string;
  hedgeRetainedLegIds: string[];
  payoutOwedUsdc: number;
}> => {
  const legs = await listHedgeLegsForPosition(pool, params.position.id);
  const openLegs = legs.filter((l) => l.status === "open" && !l.retained);

  // Tag each leg's retained role based on trigger direction.
  // direction='low'  → BTC dropped → put leg is the WINNER (now ITM)
  // direction='high' → BTC rose    → call leg is the WINNER
  const retainedLegIds: string[] = [];
  for (const leg of openLegs) {
    const isWinner =
      (params.direction === "low" && leg.optionKind === "put") ||
      (params.direction === "high" && leg.optionKind === "call");
    const role: RetainedRole = isWinner ? "winner_post_trigger" : "loser_post_trigger";
    try {
      await markHedgeLegRetained(pool, {
        id: leg.id,
        retainedReason: "trigger",
        retainedRole: role
      });
      retainedLegIds.push(leg.id);
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] markHedgeLegRetained failed for leg ${leg.id} on trigger: ${(err as Error).message}`
      );
    }
  }

  // Record salvage event with 0 proceeds (finalized later by hedge manager).
  const salvageEvent = await recordTriggerEvent(pool, {
    positionId: params.position.id,
    triggeredDirection: params.direction,
    payoutOwedUsdc: params.position.payoutUsdc,
    hedgeSaleProceedsUsdc: 0,
    metadata: {
      triggerSpotBtc: params.triggerSpotBtc ?? null,
      hedge_retained: true,
      retained_leg_ids: retainedLegIds,
      finalized: false
    }
  });

  // Mark position triggered
  await markPositionTriggered(pool, {
    id: params.position.id,
    direction: params.direction
  });

  // Ledger: payout owed to Foxify (always)
  try {
    await insertLedgerEntry(pool, {
      poolId: "foxify_trader",
      protectionId: params.position.id,
      entryType: "payout_out",
      amountUsdc: -params.position.payoutUsdc,
      reference: `vc_payout:${params.position.cellId}:${params.position.id}`,
      metadata: { product: "volume_cover", direction: params.direction }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] payout_out ledger failed for position ${params.position.id}: ${(err as Error).message}`
    );
  }

  // P1d: Accrue premium for the days position was active up to trigger.
  // Foxify pays for held days only. Days are whole-day units rounded
  // UP from partial (Foxify per-day billing convention). Triggered
  // positions are billed up to the trigger moment.
  try {
    const openedAtMs = new Date(params.position.openedAt).getTime();
    const triggerMs = Date.now();
    const daysHeld = Math.max(1, Math.ceil((triggerMs - openedAtMs) / 86_400_000));
    const accruedPremium = params.position.dailyPremiumUsdc * daysHeld;
    await insertLedgerEntry(pool, {
      poolId: "foxify_trader",
      protectionId: params.position.id,
      entryType: "premium_in",
      amountUsdc: accruedPremium,
      reference: `vc_premium_accrued_trigger:${params.position.cellId}:${params.position.id}`,
      metadata: {
        product: "volume_cover",
        cellId: params.position.cellId,
        daysHeld,
        dailyPremiumUsdc: params.position.dailyPremiumUsdc,
        accrual_basis: "trigger_close"
      }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] premium_in (trigger) ledger failed for position ${params.position.id}: ${(err as Error).message}`
    );
  }

  // Note: no separate "hedge_retained" ledger entry. Source of truth
  // for retention is the leg row (retained=TRUE, retained_role,
  // retained_at) plus salvage_event metadata (hedge_retained=true).
  // Real hedge_sell_in entries come from the VC hedge manager when
  // legs sell.

  return {
    salvageEventId: salvageEvent.id,
    hedgeRetainedLegIds: retainedLegIds,
    payoutOwedUsdc: params.position.payoutUsdc
  };
};

/**
 * Explicit close (no trigger). Used by:
 *   - Foxify-initiated early close (POST /volume-cover/positions/:id/close)
 *   - Admin manual close
 *
 * P1b (2026-05-16): Atticus RETAINS hedge legs after Foxify close.
 *   Spec: "If foxify closes position it doesn't close the hedge option,
 *   we still own to salvage."
 *
 *   On Foxify close:
 *     1. Determine retained_role per leg:
 *          near_atm_post_close — current spot within 0.5% of strike
 *          stale_post_close    — current spot moved away from strike
 *          (if currentSpotBtc not provided, default near_atm_post_close)
 *     2. Mark legs retained=TRUE (status stays 'open' — Atticus owns)
 *     3. Mark position closed
 *     4. Insert hedge_retained audit row (amount=0)
 *
 *   Premium accrual is NOT computed here in P1b — handled by P1d
 *   (daily ledger / weekly reconciler) using (closed_at - opened_at).
 *
 *   The VolumeCover hedge manager (60s tick) is responsible for the
 *   actual sell + ledger entry. This function does NOT call sellOptionLeg.
 *
 * Natural-expiry close: separate code path (legs expired). For now,
 * markHedgeLegSold path is unchanged for that case (handled by hedge
 * manager's time-decay rule).
 */
export const closePosition = async (
  pool: Pool,
  _executor: HedgeExecutor,
  params: {
    position: PositionRow;
    reason: string;
    /** Optional current spot BTC at close time; tags retained_role. */
    currentSpotBtc?: number;
  }
): Promise<{
  hedgeRetainedLegIds: string[];
  reason: string;
}> => {
  const legs = await listHedgeLegsForPosition(pool, params.position.id);
  const openLegs = legs.filter((l) => l.status === "open" && !l.retained);
  const retainedLegIds: string[] = [];

  // Tag retained role per leg based on current spot vs strike.
  // 0.5% threshold matches gamma-zone band in TP rule 3.
  const stalePctThreshold = 0.005;
  for (const leg of openLegs) {
    let role: RetainedRole = "near_atm_post_close";
    if (typeof params.currentSpotBtc === "number" && params.currentSpotBtc > 0) {
      const dist = Math.abs(params.currentSpotBtc - leg.strikeUsdc) / params.currentSpotBtc;
      // "stale" = spot moved AWAY from this leg's strike side.
      // For put leg (strike < entry), stale if spot > strike + threshold.
      // For call leg (strike > entry), stale if spot < strike - threshold.
      const spotAboveStrike = params.currentSpotBtc > leg.strikeUsdc;
      const spotBelowStrike = params.currentSpotBtc < leg.strikeUsdc;
      if (leg.optionKind === "put" && spotAboveStrike && dist > stalePctThreshold) {
        role = "stale_post_close";
      } else if (leg.optionKind === "call" && spotBelowStrike && dist > stalePctThreshold) {
        role = "stale_post_close";
      }
    }
    try {
      await markHedgeLegRetained(pool, {
        id: leg.id,
        retainedReason: "foxify_close",
        retainedRole: role
      });
      retainedLegIds.push(leg.id);
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] markHedgeLegRetained failed for leg ${leg.id} on close: ${(err as Error).message}`
      );
    }
  }

  await markPositionClosed(pool, {
    id: params.position.id,
    reason: params.reason
  });

  // P1d: Accrue premium for held days. Foxify pays for held days only
  // (not upfront, not full tenor).
  try {
    const openedAtMs = new Date(params.position.openedAt).getTime();
    const closeMs = Date.now();
    const daysHeld = Math.max(1, Math.ceil((closeMs - openedAtMs) / 86_400_000));
    const accruedPremium = params.position.dailyPremiumUsdc * daysHeld;
    await insertLedgerEntry(pool, {
      poolId: "foxify_trader",
      protectionId: params.position.id,
      entryType: "premium_in",
      amountUsdc: accruedPremium,
      reference: `vc_premium_accrued_close:${params.position.cellId}:${params.position.id}`,
      metadata: {
        product: "volume_cover",
        cellId: params.position.cellId,
        daysHeld,
        dailyPremiumUsdc: params.position.dailyPremiumUsdc,
        accrual_basis: "foxify_close",
        close_reason: params.reason
      }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] premium_in (close) ledger failed for position ${params.position.id}: ${(err as Error).message}`
    );
  }

  // Note: no separate "hedge_retained" ledger entry on close. Source
  // of truth is the leg row (retained=TRUE) + position row (status,
  // close_reason). Real hedge_sell_in ledger entries are written by
  // the VC hedge manager when legs eventually sell.

  return { hedgeRetainedLegIds: retainedLegIds, reason: params.reason };
};
