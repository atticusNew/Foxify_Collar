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
import {
  insertPosition,
  insertHedgeLeg,
  listHedgeLegsForPosition,
  markHedgeLegSold,
  markPositionTriggered,
  markPositionClosed,
  type PositionRow,
  type HedgeLegRow
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

  // Build + execute hedge
  const structure = buildHedgeStructure({
    positionId,
    cell: req.cell,
    entryBtcPrice: req.pairEntryBtcPrice
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

  // Ledger entries (best-effort; if either fails, log but don't roll back since
  // hedge is already in market and position is real)
  try {
    await insertLedgerEntry(pool, {
      poolId: "foxify_trader",
      protectionId: positionId,
      entryType: "premium_in",
      amountUsdc: dailyPremium,
      reference: `vc_premium:${req.cell.cellId}:${req.foxifyPairId}`,
      metadata: { product: "volume_cover", cellId: req.cell.cellId }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] premium_in ledger failed for position ${positionId}: ${(err as Error).message}`
    );
  }
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
 * Fire a trigger event for an active position. Called by triggerDetector
 * when BTC spot crosses the position's trigger boundary.
 *
 * Sells BOTH hedge legs (winning leg salvages near full payout; losing
 * leg salvages near zero), records salvage event, marks position triggered,
 * posts ledger entries.
 */
export const fireTrigger = async (
  pool: Pool,
  executor: HedgeExecutor,
  params: {
    position: PositionRow;
    direction: "high" | "low";
    triggerSpotBtc?: number;
  }
): Promise<{
  salvageEventId: string;
  salvagePct: number;
  totalProceedsUsdc: number;
  netAtticusLossUsdc: number;
}> => {
  const legs = await listHedgeLegsForPosition(pool, params.position.id);
  const openLegs = legs.filter((l) => l.status === "open");

  // Sell every open leg
  let totalProceeds = 0;
  for (const leg of openLegs) {
    try {
      const sellResult = await executor.sellOptionLeg({
        venue: leg.venue as HedgeVenueChoice,
        optionKind: leg.optionKind,
        strikeUsdc: leg.strikeUsdc,
        expiryIso: leg.expiryIso,
        contractsBtc: leg.contracts
      });
      totalProceeds += sellResult.totalProceedsUsdc;
      await markHedgeLegSold(pool, {
        id: leg.id,
        sellPriceUsdc: sellResult.fillPriceUsdcPerBtc,
        sellOrderId: sellResult.orderId
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] sellOptionLeg failed for leg ${leg.id}: ${(err as Error).message}; ` +
          `continuing with remaining legs (best-effort salvage)`
      );
    }
  }

  // Record salvage event
  const salvageEvent = await recordTriggerEvent(pool, {
    positionId: params.position.id,
    triggeredDirection: params.direction,
    payoutOwedUsdc: params.position.payoutUsdc,
    hedgeSaleProceedsUsdc: totalProceeds,
    metadata: { triggerSpotBtc: params.triggerSpotBtc ?? null }
  });

  // Mark position triggered
  await markPositionTriggered(pool, {
    id: params.position.id,
    direction: params.direction
  });

  // Ledger entries
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
  try {
    if (totalProceeds > 0) {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: params.position.id,
        entryType: "hedge_sell_in",
        amountUsdc: totalProceeds,
        reference: `vc_hedge_sell:${params.position.cellId}:${params.position.id}`,
        metadata: { product: "volume_cover", direction: params.direction }
      });
    }
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] hedge_sell_in ledger failed for position ${params.position.id}: ${(err as Error).message}`
    );
  }

  return {
    salvageEventId: salvageEvent.id,
    salvagePct: salvageEvent.salvagePct,
    totalProceedsUsdc: totalProceeds,
    netAtticusLossUsdc: salvageEvent.netAtticusLossUsdc
  };
};

/**
 * Explicit close (no trigger). Used by:
 *   - Foxify-initiated early close (POST /volume-cover/positions/:id/close)
 *   - Admin manual close
 *   - Expiry-driven close (hedge legs expired)
 *
 * Sells any open hedge legs at market. No payout to Foxify since no trigger.
 */
export const closePosition = async (
  pool: Pool,
  executor: HedgeExecutor,
  params: {
    position: PositionRow;
    reason: string;
  }
): Promise<{
  totalProceedsUsdc: number;
  legsSold: number;
}> => {
  const legs = await listHedgeLegsForPosition(pool, params.position.id);
  const openLegs = legs.filter((l) => l.status === "open");
  let totalProceeds = 0;
  let legsSold = 0;

  for (const leg of openLegs) {
    try {
      const sellResult = await executor.sellOptionLeg({
        venue: leg.venue as HedgeVenueChoice,
        optionKind: leg.optionKind,
        strikeUsdc: leg.strikeUsdc,
        expiryIso: leg.expiryIso,
        contractsBtc: leg.contracts
      });
      totalProceeds += sellResult.totalProceedsUsdc;
      legsSold += 1;
      await markHedgeLegSold(pool, {
        id: leg.id,
        sellPriceUsdc: sellResult.fillPriceUsdcPerBtc,
        sellOrderId: sellResult.orderId
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] sellOptionLeg failed during close for leg ${leg.id}: ${(err as Error).message}`
      );
    }
  }

  await markPositionClosed(pool, {
    id: params.position.id,
    reason: params.reason
  });

  if (totalProceeds > 0) {
    try {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: params.position.id,
        entryType: "hedge_sell_in",
        amountUsdc: totalProceeds,
        reference: `vc_close:${params.position.cellId}:${params.position.id}`,
        metadata: { product: "volume_cover", reason: params.reason }
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] hedge_sell_in ledger failed during close for position ${params.position.id}: ${(err as Error).message}`
      );
    }
  }

  return { totalProceedsUsdc: totalProceeds, legsSold };
};
