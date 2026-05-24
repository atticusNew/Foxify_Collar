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
import { computeTriggerPrices, findCellById } from "./matrix";
import {
  buildHedgeStructureWithVenueGrid,
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
import { recordObligationWithDeferralSchedule } from "./counterpartyLedger";
import { attemptLadderNetting } from "./ladderNetting";
import { recordTriggerForFingerprint } from "./antiBot";
// ─── 2026-05-23: spread-executor wiring (Track 2 PR #2 cutover) ───
import {
  buildSpreadStructureDB,
  resolveSpreadVenue,
  isSpreadCellAllowed
} from "./spreadHedge";
import {
  openSpread,
  closeSpread,
  partialCloseSpreadOnTrigger,
  type SpreadExecutorAdapter
} from "./spreadExecutor";
import { getBullishSpreadAdapter } from "./bullishSpreadAdapter";

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
  /**
   * 2026-05-23: smoke-test only. Force contracts-per-leg for the spread
   * branch (bypasses computeSpreadContractSize). Used by /admin/test-
   * activate to prove the wired path at micro-size without burning live
   * capital. Strangle path ignores this field — sizing there is fixed by
   * the strangle structure builder.
   */
  contractsOverrideBtc?: number;
  /**
   * 2026-05-24 (Phase 0.3): pricing attribution. The route computes
   * baseDailyPremium (from cell + regime overlay) and a surcharge
   * multiplier (from anti-bot Layer 4), producing effectiveDailyPremium
   * via base × multiplier. Persist all three so PnL attribution can
   * reconstruct what we charged and why per regime.
   */
  baseDailyPremiumUsdc?: number;
  surchargeMultiplierApplied?: number;
  /**
   * 2026-05-24 (Hybrid v3): optional override of the cell base payout
   * (e.g., from VC_PAYOUT_OVERLAY_JSON regime overlay). If unset, falls
   * back to cell.payoutUsdc. Calm regime never overrides; moderate +
   * elevated (and stress if not halted) can use a reduced payout per
   * regime to match Atticus's hedge economics. Used end-to-end so
   * position row, trigger payout, ledger entries, and obligation
   * tracking all see the SAME regime-adjusted Y value.
   */
  effectivePayoutUsdc?: number;
};

export type OpenPositionResult = {
  position: PositionRow;
  hedgeLegs: HedgeLegRow[];
  totalHedgeCostUsdc: number;
  venue: HedgeVenueChoice;
  /** P1e: ladder-netting outcome. */
  laddered: boolean;
  ladderedLegIds: string[];
  ladderEstimatedSavingsUsdc: number;
  ladderEventId: string | null;
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
  // 2026-05-24 (Hybrid v3): regime-adjusted payout if provided, else cell base.
  const effectivePayout = req.effectivePayoutUsdc ?? req.cell.payoutUsdc;

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
      payoutUsdc: effectivePayout,
      fingerprintHash: req.fingerprintHash ?? null,
      metadata: req.metadata,
      // 2026-05-24 (Phase 0.3): pricing attribution.
      regimeAtOpen: req.regime ?? null,
      baseDailyPremiumUsdc: req.baseDailyPremiumUsdc ?? null,
      surchargeMultiplierApplied: req.surchargeMultiplierApplied ?? 1.0
    });
  } catch (err: any) {
    throw new Error(`volume_cover_position_insert_failed: ${err?.message ?? err}`);
  }

  // ───────────────────────────────────────────────────────────────────
  // 2026-05-23: SPREAD-EXECUTOR BRANCH (Track 2 PR #2 cutover)
  //
  // Feature-flagged via VOLUME_COVER_HEDGE_STRATEGY (env) +
  // VC_SPREAD_CELL_ALLOWLIST. Default is strangle (existing path)
  // — spread only fires for explicitly allowlisted cells.
  //
  // Behavior:
  //   - Build a 4-leg [DB] tight-spread structure via spreadHedge
  //   - Open sequenced via spreadExecutor.openSpread (with rollback)
  //   - Persist 4 legs with shared spread_group_id and leg_role
  //   - Skip ladder netting (incompatible with spread structure)
  // ───────────────────────────────────────────────────────────────────
  if (isSpreadCellAllowed(req.cell.cellId)) {
    const spreadResult = await executeSpreadOpen({
      pool,
      positionId,
      cell: req.cell,
      pairEntryBtcPrice: req.pairEntryBtcPrice,
      contractsOverrideBtc: req.contractsOverrideBtc
    });
    return {
      position,
      hedgeLegs: spreadResult.hedgeLegs,
      totalHedgeCostUsdc: spreadResult.totalCostUsdc,
      venue: spreadResult.venue,
      laddered: false,
      ladderedLegIds: [],
      ladderEstimatedSavingsUsdc: 0,
      ladderEventId: null
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // STRANGLE PATH (default / existing behavior, unchanged below)
  // ───────────────────────────────────────────────────────────────────

  // Build hedge structure (P1c: vol-buffered sizing + grid snap +
  // venue strike grid lookup when provider wired). Falls back to
  // static grid snap if no provider or live fetch fails.
  const structure = await buildHedgeStructureWithVenueGrid({
    positionId,
    cell: req.cell,
    entryBtcPrice: req.pairEntryBtcPrice,
    regime: req.regime ?? null
  });

  // P1e: attempt ladder netting BEFORE execute. Repurposes any
  // matching Atticus-retained legs from a recent close/trigger of the
  // same fingerprint+cell. Returns only the legs that still need to
  // be bought from the venue.
  const netting = await attemptLadderNetting({
    pool,
    newPositionId: positionId,
    cell: req.cell,
    fingerprintHash: req.fingerprintHash ?? null,
    entryBtcPrice: req.pairEntryBtcPrice,
    structure
  });

  // Execute only the legs that didn't ladder-net.
  let executionResult: { venue: HedgeVenueChoice; legs: any[]; totalCostUsdc: number } = {
    venue: structure.venue,
    legs: [],
    totalCostUsdc: 0
  };
  if (netting.remainingLegs.length > 0) {
    try {
      executionResult = await executeHedgeStructure({
        structure: { ...structure, legs: netting.remainingLegs },
        cell: req.cell,
        executor
      });
    } catch (err: any) {
      // Hedge failed; cancel the position. Note: any already-repurposed
      // legs are now under this cancelled position. They retain on the
      // current owner but their ladder lineage is lost; acceptable
      // given lifecycle simplicity. The hedge manager will handle
      // disposal via TP rules on the failed-cancelled position.
      await markPositionClosed(pool, {
        id: positionId,
        reason: `hedge_execution_failed: ${err?.message ?? err}`
      });
      throw new Error(`volume_cover_hedge_execution_failed: ${err?.message ?? err}`);
    }
  }

  // Persist newly-bought hedge legs (the repurposed ones already exist
  // and were re-pointed at this position by attemptLadderNetting).
  //
  // Atomicity: if any insertHedgeLeg fails AFTER venue legs were
  // successfully bought, we have UNHEDGED venue legs with no DB row —
  // a real money-vs-ledger drift. Compensating action: best-effort sell
  // back every venue leg we just bought + mark position closed + alert.
  // If any compensating sell also fails, surface as orphan via [VC ALERT]
  // so ops + reconciler can find it.
  const hedgeLegs: HedgeLegRow[] = [...netting.repurposedLegs];
  for (const f of executionResult.legs) {
    try {
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
    } catch (insertErr: any) {
      console.error(
        `[VC ALERT] insertHedgeLeg FAILED after venue fill — initiating compensating sell. ` +
          `positionId=${positionId} legId=${f.legId} venue=${f.venue} ` +
          `optionKind=${f.optionKind} strike=${f.strikeUsdc} ` +
          `contracts=${f.contractsBtc} buyOrderId=${f.orderId} ` +
          `dbError=${JSON.stringify(insertErr?.message ?? String(insertErr))}`
      );
      const orphans: Array<Record<string, unknown>> = [];
      for (const toUnwind of executionResult.legs) {
        try {
          await executor.sellOptionLeg({
            venue: toUnwind.venue,
            optionKind: toUnwind.optionKind,
            strikeUsdc: toUnwind.strikeUsdc,
            expiryIso: toUnwind.expiryIso,
            contractsBtc: toUnwind.contractsBtc
          });
        } catch (sellErr: any) {
          const sellError = sellErr instanceof Error ? sellErr.message : String(sellErr);
          orphans.push({
            legId: toUnwind.legId,
            venue: toUnwind.venue,
            optionKind: toUnwind.optionKind,
            strikeUsdc: toUnwind.strikeUsdc,
            buyOrderId: toUnwind.orderId,
            sellError
          });
          console.error(
            `[VC ALERT] compensating sell FAILED — orphan venue leg: ` +
              `positionId=${positionId} legId=${toUnwind.legId} ` +
              `venue=${toUnwind.venue} buyOrderId=${toUnwind.orderId} ` +
              `sellError=${JSON.stringify(sellError)}`
          );
        }
      }
      try {
        await markPositionClosed(pool, {
          id: positionId,
          reason: `db_insert_failed_after_venue_fill: ${insertErr?.message ?? insertErr}`
        });
      } catch {
        // Best-effort; position row may itself be inaccessible.
      }
      const finalErr = new Error(
        `volume_cover_hedge_persist_failed: ${insertErr?.message ?? insertErr}` +
          (orphans.length > 0 ? ` | orphans=${JSON.stringify(orphans)}` : "")
      );
      (finalErr as any).orphans = orphans;
      throw finalErr;
    }
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
    venue: executionResult.venue,
    // P1e: surface ladder netting outcome for telemetry / smoke tests.
    laddered: netting.repurposedLegs.length > 0,
    ladderedLegIds: netting.repurposedLegs.map((l) => l.id),
    ladderEstimatedSavingsUsdc: netting.estimatedSavingsUsdc,
    ladderEventId: netting.ladderEventId
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
  // Include already-retained legs (post-close-window triggers): we still
  // want to refresh their retained_role to winner/loser so the hedge
  // manager applies the right TP rule on the now-triggered position.
  const openLegs = legs.filter((l) => l.status === "open");

  // ─── 2026-05-23: spread-executor trigger branch ───
  // If these legs were opened via the spread executor (4 legs sharing
  // a spreadGroupId), close BOTH shorts at the venue (collect spread
  // value, free margin) and retain only the long legs for salvage.
  // Otherwise fall through to strangle-style retention (all legs).
  const spreadLegs = openLegs.filter(
    (l) => l.spreadGroupId !== null && l.legRole !== null
  );
  const retainedLegIds: string[] = [];
  let spreadShortProceedsUsdc = 0;
  if (spreadLegs.length === 4) {
    const cell = findCellById(params.position.cellId);
    if (cell) {
      try {
        const spreadOutcome = await executeSpreadPartialCloseOnTrigger({
          pool,
          positionId: params.position.id,
          cell,
          spreadLegs,
          triggerDirection: params.direction
        });
        spreadShortProceedsUsdc = spreadOutcome.shortLegProceedsUsdc;
        // 2026-05-23: longLegIdsSold are NOT added to retainedLegIds —
        // they're already terminal (sold), no salvage tracking needed.
        // longLegIdsRetained (fallback case) still goes through salvage.
        retainedLegIds.push(...spreadOutcome.longLegIdsRetained);
        if (spreadOutcome.longLegIdsSold.length > 0) {
          console.log(
            `[volumeCover/lifecycle] spread trigger sold longs at fire: ` +
              `position=${params.position.id} count=${spreadOutcome.longLegIdsSold.length} ` +
              `proceeds=${spreadOutcome.longLegProceedsUsdc.toFixed(2)}`
          );
        }
      } catch (err) {
        console.error(
          `[VC ALERT] executeSpreadPartialCloseOnTrigger threw for position ${params.position.id}; ` +
            `falling back to retain-all. error=${(err as Error).message}`
        );
        // Best-effort: retain all 4 legs and let hedge manager TP them.
        for (const leg of spreadLegs) {
          const isWinner =
            (params.direction === "low" && leg.optionKind === "put") ||
            (params.direction === "high" && leg.optionKind === "call");
          const role: RetainedRole = isWinner ? "winner_post_trigger" : "loser_post_trigger";
          try {
            await markHedgeLegRetained(pool, {
              id: leg.id,
              retainedReason: "trigger_spread_fallback",
              retainedRole: role
            });
            retainedLegIds.push(leg.id);
          } catch { /* best effort */ }
        }
      }
    } else {
      console.warn(
        `[volumeCover/lifecycle] spread trigger: cell ${params.position.cellId} not in registry; using strangle-style retain-all fallback`
      );
    }
  }

  // ─── Strangle (or spread fallback) retention path ───
  // Only run for non-spread legs (or all legs if spread cell lookup failed
  // and we don't already have retainedLegIds for them).
  const strangleLegs = openLegs.filter((l) => l.spreadGroupId === null);
  for (const leg of strangleLegs) {
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
  // post_close_trigger: trigger fired after Foxify-initiated close, but
  // inside the still-paid coverage window. Payout still owed.
  const postCloseTrigger = params.position.status === "closed";
  const salvageEvent = await recordTriggerEvent(pool, {
    positionId: params.position.id,
    triggeredDirection: params.direction,
    payoutOwedUsdc: params.position.payoutUsdc,
    // Spread shorts close at trigger time and book proceeds immediately;
    // longs remain in salvage and get finalized by the hedge manager.
    hedgeSaleProceedsUsdc: spreadShortProceedsUsdc,
    metadata: {
      triggerSpotBtc: params.triggerSpotBtc ?? null,
      hedge_retained: true,
      retained_leg_ids: retainedLegIds,
      finalized: false,
      post_close_trigger: postCloseTrigger,
      coverage_through: params.position.coverageThrough,
      spread_short_proceeds_usdc: spreadShortProceedsUsdc > 0
        ? spreadShortProceedsUsdc
        : undefined
    }
  });

  // Ledger entry for spread short proceeds (these are realized cash
  // now, not deferred salvage).
  if (spreadShortProceedsUsdc > 0) {
    try {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: params.position.id,
        entryType: "hedge_sell_in",
        amountUsdc: spreadShortProceedsUsdc,
        reference: `vc_spread_short_close:${params.position.cellId}:${params.position.id}`,
        metadata: {
          product: "volume_cover",
          executor: "spread",
          direction: params.direction,
          source: "trigger_partial_close"
        }
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] spread short_proceeds ledger failed for position ${params.position.id}: ${(err as Error).message}`
      );
    }
  }

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

  // 2026-05-23 counterparty credit ledger: trigger payout obligation
  // (Atticus owes Foxify the cell payout, settled per 25%/75% deferred
  // schedule). Two ledger rows created — weekly_25 due next Friday +
  // monthly_75 due end-of-month. Insert is idempotent on
  // (category=trigger_payout, source_event_id=trigger:<positionId>).
  try {
    await recordObligationWithDeferralSchedule({
      pool,
      partyOwes: "atticus_to_foxify",
      amountUsdc: params.position.payoutUsdc,
      category: "trigger_payout",
      sourceEventId: `trigger:${params.position.id}`,
      cellId: params.position.cellId,
      foxifyPositionId: params.position.id,
      triggerEventId: salvageEvent?.id ?? null,
      notes: `trigger direction=${params.direction}`
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] counterparty trigger-payout ledger failed for position ${params.position.id}: ${(err as Error).message}`
    );
  }

  // P1g: record trigger for fingerprint (Layer 3 prereq)
  if (params.position.fingerprintHash) {
    try {
      await recordTriggerForFingerprint({
        pool,
        fingerprintHash: params.position.fingerprintHash
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] recordTriggerForFingerprint failed: ${(err as Error).message}`
      );
    }
  }

  // P1d: Accrue premium for the days position was active up to trigger.
  // Foxify pays for held days only. Days are whole-day units rounded
  // UP from partial (Foxify per-day billing convention). Triggered
  // positions are billed up to the trigger moment.
  //
  // 2026-05-19 coverage-window: if the position was already closed
  // (Foxify-close, coverage window still open), premium was already
  // accrued at close. Skip to avoid double-billing.
  const alreadyBilledAtClose = params.position.status === "closed";
  if (!alreadyBilledAtClose) {
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
  /** End-of-paid-coverage timestamp; triggers within this window still pay out. */
  coverageThroughIso: string;
  daysHeld: number;
}> => {
  const legs = await listHedgeLegsForPosition(pool, params.position.id);
  const openLegs = legs.filter((l) => l.status === "open" && !l.retained);
  const retainedLegIds: string[] = [];
  let spreadShortProceedsUsdc = 0;

  // ─── 2026-05-23: spread-executor close branch ───
  // If these legs are a 4-leg spread, close BOTH shorts immediately
  // (BUY back) and retain ONLY the longs for salvage. Retaining
  // shorts indefinitely is wrong: shorts cost margin until expiry
  // and can swing ITM, costing Atticus money. The hedge manager TP
  // loop also only knows how to sell longs (sellOptionLeg).
  //
  // Mirrors the trigger semantics from fireTrigger().
  const spreadLegs = openLegs.filter(
    (l) => l.spreadGroupId !== null && l.legRole !== null
  );
  const strangleLegs = openLegs.filter((l) => l.spreadGroupId === null);

  if (spreadLegs.length === 4) {
    const cell = findCellById(params.position.cellId);
    if (cell) {
      try {
        // Reuse the trigger-time helper. On Foxify-close (no trigger
        // fired), we don't know "winner" vs "loser" wing — but both
        // shorts close either way. Use direction="low" arbitrarily;
        // the function closes BOTH shorts regardless.
        //
        // 2026-05-23: pass sellLongsAtTriggerOverride=false because at
        // Foxify-close (non-trigger), longs are at fair value not peak.
        // The hedge manager's TP curve is the right tool here.
        const spreadOutcome = await executeSpreadPartialCloseOnTrigger({
          pool,
          positionId: params.position.id,
          cell,
          spreadLegs,
          triggerDirection: "low",
          sellLongsAtTriggerOverride: false
        });
        spreadShortProceedsUsdc = spreadOutcome.shortLegProceedsUsdc;
        retainedLegIds.push(...spreadOutcome.longLegIdsRetained);
      } catch (err) {
        console.error(
          `[VC ALERT] spread Foxify-close failed for position ${params.position.id}: ${(err as Error).message}. ` +
            `Falling back to retain-all (legacy strangle behavior). MANUAL CLEANUP MAY BE REQUIRED for retained shorts.`
        );
        // Fallback: retain all 4 legs (legacy behavior). Operator
        // must manually close shorts via /admin/bullish-test-buy
        // or /admin/force-sell-leg before margin accrues.
        for (const leg of spreadLegs) {
          try {
            await markHedgeLegRetained(pool, {
              id: leg.id,
              retainedReason: "foxify_close_spread_fallback",
              retainedRole: "near_atm_post_close"
            });
            retainedLegIds.push(leg.id);
          } catch { /* best effort */ }
        }
      }
    } else {
      console.warn(
        `[volumeCover/lifecycle] spread Foxify-close: cell ${params.position.cellId} not in registry; retain-all fallback`
      );
      for (const leg of spreadLegs) {
        try {
          await markHedgeLegRetained(pool, {
            id: leg.id,
            retainedReason: "foxify_close",
            retainedRole: "near_atm_post_close"
          });
          retainedLegIds.push(leg.id);
        } catch { /* best effort */ }
      }
    }
  }

  // ─── Strangle (legacy) retention path — runs for non-spread legs only ───
  // Tag retained role per leg based on current spot vs strike.
  // 0.5% threshold matches gamma-zone band in TP rule 3.
  const stalePctThreshold = 0.005;
  for (const leg of strangleLegs) {
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

  // P1d / 2026-05-19 coverage-window:
  //
  //   Foxify pays per whole day (ceil of elapsed). Coverage extends through
  //   opened_at + daysHeld × 24h so the customer gets the full paid period —
  //   triggers in that window still pay out. We compute it once here so the
  //   premium ledger and the coverage_through column stay in lockstep.
  const openedAtMs = new Date(params.position.openedAt).getTime();
  const closeMs = Date.now();
  const daysHeld = Math.max(1, Math.ceil((closeMs - openedAtMs) / 86_400_000));
  const coverageThroughMs = openedAtMs + daysHeld * 86_400_000;
  const coverageThroughIso = new Date(coverageThroughMs).toISOString();

  await markPositionClosed(pool, {
    id: params.position.id,
    reason: params.reason,
    coverageThroughIso
  });

  // Spread-close: book realized short-leg proceeds immediately.
  if (spreadShortProceedsUsdc > 0) {
    try {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: params.position.id,
        entryType: "hedge_sell_in",
        amountUsdc: spreadShortProceedsUsdc,
        reference: `vc_spread_short_foxify_close:${params.position.cellId}:${params.position.id}`,
        metadata: {
          product: "volume_cover",
          executor: "spread",
          source: "foxify_close_partial"
        }
      });
    } catch (err) {
      console.warn(
        `[volumeCover/lifecycle] spread short_proceeds ledger failed for position ${params.position.id}: ${(err as Error).message}`
      );
    }
  }

  try {
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
        close_reason: params.reason,
        coverage_through: coverageThroughIso
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

  return {
    hedgeRetainedLegIds: retainedLegIds,
    reason: params.reason,
    coverageThroughIso,
    daysHeld
  };
};

// ─────────────────────────────────────────────────────────────────────
// 2026-05-23: Spread-executor open helper (Track 2 PR #2 cutover).
//
// Called from openPosition() when isSpreadCellAllowed(cell). Mirrors
// the strangle execute path but uses the 4-leg [DB] spread structure
// and openSpread() with sequenced rollback.
// ─────────────────────────────────────────────────────────────────────

const computeExpiryIsoForSpread = (cell: CellDefinition): string => {
  // Mirror the strangle expiry logic in tightHedge.buildHedgeStructure
  // (3d for 2% cells, 5d for 5%, 14d for deeper). Snap to 08:00 UTC.
  const horizonDays = cell.expiryHorizonDays ?? 3;
  const expiryDate = new Date(Date.now() + horizonDays * 86_400_000);
  expiryDate.setUTCHours(8, 0, 0, 0);
  if (expiryDate.getTime() < Date.now()) {
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
  }
  return expiryDate.toISOString();
};

const executeSpreadOpen = async (params: {
  pool: Pool;
  positionId: string;
  cell: CellDefinition;
  pairEntryBtcPrice: number;
  adapterOverride?: SpreadExecutorAdapter; // for tests
  contractsOverrideBtc?: number; // smoke-test only
}): Promise<{
  hedgeLegs: HedgeLegRow[];
  totalCostUsdc: number;
  venue: HedgeVenueChoice;
}> => {
  const venueRouting = resolveSpreadVenue(params.cell);
  const expiryIso = computeExpiryIsoForSpread(params.cell);

  // 2026-05-23: Bullish lists BTC weekly option strikes at $1k grid
  // (74k/75k/76k/77k/78k empirically verified at this expiry; 73k/79k
  // are NOT listed). The cell's hedgePct=0.01 formula produces non-grid
  // strikes like 75240 — must snap or symbol resolves to a non-existent
  // contract and the liquidity gate / order placement fails.
  // VC_SPREAD_STRIKE_GRID_USDC env overrides (default $1000).
  const gridUsdc = Math.max(
    1,
    Number(process.env.VC_SPREAD_STRIKE_GRID_USDC ?? 1000)
  );
  const snapToGrid = (params: {
    targetUsdc: number;
    side: "long" | "short";
    kind: "put" | "call";
  }): number => Math.round(params.targetUsdc / gridUsdc) * gridUsdc;

  const structure = buildSpreadStructureDB({
    positionId: params.positionId,
    cell: params.cell,
    entryBtcPrice: params.pairEntryBtcPrice,
    expiryIso,
    venue: venueRouting.primary,
    fallbackVenue: venueRouting.fallback,
    strikeSnapper: snapToGrid
  });

  // Smoke-test override: forcibly resize each leg's contracts. Used by
  // /admin/test-activate to prove the wired path at micro-size without
  // burning live capital. NEVER set this from the real activate path.
  if (
    typeof params.contractsOverrideBtc === "number" &&
    params.contractsOverrideBtc > 0
  ) {
    const overrideBtc = params.contractsOverrideBtc;
    for (const leg of structure.legs) {
      leg.contractsBtc = overrideBtc;
    }
  }

  const adapter = params.adapterOverride ?? getBullishSpreadAdapter();

  let openResult: Awaited<ReturnType<typeof openSpread>>;
  try {
    openResult = await openSpread({ structure, adapter });
  } catch (err: any) {
    await markPositionClosed(params.pool, {
      id: params.positionId,
      reason: `spread_open_threw: ${err?.message ?? err}`
    });
    throw new Error(`volume_cover_spread_open_failed: ${err?.message ?? err}`);
  }

  if (!openResult.ok) {
    // openSpread already attempted rollback internally on partial fill.
    await markPositionClosed(params.pool, {
      id: params.positionId,
      reason: `spread_open_failed: ${openResult.errorReason ?? "unknown"} (failedAt=${openResult.failedAt})`
    });
    throw new Error(
      `volume_cover_spread_open_failed: ${openResult.errorReason ?? "unknown"} (failedAt=${openResult.failedAt})`
    );
  }

  // Persist 4 legs with shared spreadGroupId and per-leg role.
  // For LONG legs: buy_price_usdc = fill price (cost paid).
  // For SHORT legs: buy_price_usdc = 0 (no cost paid), initial_proceeds_usdc = fill price.
  const hedgeLegs: HedgeLegRow[] = [];
  for (const ol of openResult.legs) {
    const legSpec = structure.legs.find((l) => l.legRole === ol.legRole);
    if (!legSpec) {
      // Shouldn't happen — the executor mirrors the structure.
      console.error(
        `[VC ALERT] spread leg ${ol.legRole} not found in structure for position ${params.positionId}`
      );
      continue;
    }
    const isLong = legSpec.side === "long";
    try {
      const leg = await insertHedgeLeg(params.pool, {
        id: `vc-leg-${randomUUID()}`,
        positionId: params.positionId,
        venue: structure.venue,
        optionKind: legSpec.optionKind,
        strikeUsdc: legSpec.strikeActualUsdc,
        expiryIso: legSpec.expiryIso,
        contracts: legSpec.contractsBtc,
        buyPriceUsdc: isLong ? ol.fillPriceUsdcPerBtc : 0,
        buyOrderId: ol.orderId,
        status: "open",
        metadata: {
          spreadGroupId: structure.spreadGroupId,
          legRole: ol.legRole,
          symbol: ol.symbol,
          fillPriceUsdcPerBtc: ol.fillPriceUsdcPerBtc,
          fillQtyBtc: ol.fillQtyBtc,
          attempts: ol.attempts
        },
        spreadGroupId: structure.spreadGroupId,
        legRole: ol.legRole,
        initialProceedsUsdc: isLong ? null : ol.fillPriceUsdcPerBtc
      });
      hedgeLegs.push(leg);
    } catch (insertErr: any) {
      // Best-effort: log + attempt to unwind via closeSpread.
      console.error(
        `[VC ALERT] spread insertHedgeLeg FAILED — attempting closeSpread to unwind. ` +
          `positionId=${params.positionId} spreadGroupId=${structure.spreadGroupId} ` +
          `legRole=${ol.legRole} dbError=${JSON.stringify(insertErr?.message ?? String(insertErr))}`
      );
      try {
        await closeSpread({ structure, adapter });
      } catch (closeErr: any) {
        console.error(
          `[VC ALERT] closeSpread also FAILED after insert error — manual cleanup required. ` +
            `positionId=${params.positionId} spreadGroupId=${structure.spreadGroupId} ` +
            `closeError=${JSON.stringify(closeErr?.message ?? String(closeErr))}`
        );
      }
      await markPositionClosed(params.pool, {
        id: params.positionId,
        reason: `spread_persist_failed: ${insertErr?.message ?? insertErr}`
      });
      throw new Error(
        `volume_cover_spread_persist_failed: ${insertErr?.message ?? insertErr}`
      );
    }
  }

  // Ledger entry: net debit of the spread open.
  try {
    await insertLedgerEntry(params.pool, {
      poolId: "atticus_hedge",
      protectionId: params.positionId,
      entryType: "hedge_buy_out",
      amountUsdc: -openResult.netDebitUsdc,
      reference: `vc_spread_open:${params.cell.cellId}:${params.positionId}`,
      metadata: {
        product: "volume_cover",
        executor: "spread",
        spreadGroupId: structure.spreadGroupId,
        legCount: openResult.legs.length
      }
    });
  } catch (err) {
    console.warn(
      `[volumeCover/lifecycle] spread hedge_buy_out ledger failed for position ${params.positionId}: ${(err as Error).message}`
    );
  }

  return {
    hedgeLegs,
    totalCostUsdc: openResult.netDebitUsdc,
    venue: structure.venue
  };
};

// ─────────────────────────────────────────────────────────────────────
// 2026-05-23: Spread-executor trigger helper (Track 2 PR #2 cutover).
//
// Called from fireTrigger() when the position's legs carry a
// spread_group_id. Closes BOTH short legs via partialCloseSpreadOnTrigger
// and marks long legs retained for salvage.
// ─────────────────────────────────────────────────────────────────────

export const executeSpreadPartialCloseOnTrigger = async (params: {
  pool: Pool;
  positionId: string;
  cell: CellDefinition;
  spreadLegs: HedgeLegRow[];
  triggerDirection: "high" | "low";
  adapterOverride?: SpreadExecutorAdapter; // for tests
  /**
   * 2026-05-23: override the sell-longs-at-trigger flag.
   * - Trigger-fire path (fireTrigger): omit/true → captures peak value.
   * - Foxify-close path (closePosition non-trigger): false → preserves
   *   retain-and-hedge-manager behavior (longs are near fair value at
   *   close, not at trigger peak, so capturing peak doesn't apply).
   */
  sellLongsAtTriggerOverride?: boolean;
}): Promise<{
  shortLegProceedsUsdc: number;
  longLegProceedsUsdc: number;
  shortLegIdsClosed: string[];
  longLegIdsSold: string[];
  longLegIdsRetained: string[];
}> => {
  // Reconstruct a minimal SpreadStructure from the persisted legs.
  // We only need legs + venue + spreadGroupId for partialCloseSpreadOnTrigger.
  const firstLeg = params.spreadLegs[0];
  if (!firstLeg?.spreadGroupId) {
    throw new Error("executeSpreadPartialCloseOnTrigger: leg has no spreadGroupId");
  }
  const spreadGroupId = firstLeg.spreadGroupId;
  const venue = firstLeg.venue;

  // Build per-leg SpreadLegSpec from DB rows.
  const legSpecs = params.spreadLegs.map((leg) => {
    if (!leg.legRole) {
      throw new Error(
        `executeSpreadPartialCloseOnTrigger: leg ${leg.id} missing leg_role`
      );
    }
    const side: "long" | "short" =
      leg.legRole === "put_long" || leg.legRole === "call_long" ? "long" : "short";
    return {
      legRole: leg.legRole,
      optionKind: leg.optionKind,
      side,
      strikeIdealUsdc: leg.strikeUsdc,
      strikeActualUsdc: leg.strikeUsdc,
      contractsBtc: leg.contracts,
      expiryIso: leg.expiryIso
    };
  });

  const partialStructure = {
    positionId: params.positionId,
    cellId: params.cell.cellId,
    spreadGroupId,
    design: "DB" as const,
    venue: venue as HedgeVenueChoice,
    fallbackVenue: null as HedgeVenueChoice | null,
    legs: legSpecs,
    expectedNetDebitPerBtcUsdcIdeal: null,
    contractsBtcPerLeg: firstLeg.contracts,
    spreadWidthUsdc: params.cell.spreadWidthUsdc ?? 1000,
    triggerLowBtc: 0,
    triggerHighBtc: 0
  };

  const adapter = params.adapterOverride ?? getBullishSpreadAdapter();
  const result = await partialCloseSpreadOnTrigger({
    structure: partialStructure,
    adapter,
    triggerDirection: params.triggerDirection,
    sellLongsAtTriggerOverride: params.sellLongsAtTriggerOverride
  });

  // Map closed shorts to DB rows + mark them sold.
  const shortLegIdsClosed: string[] = [];
  const longLegIdsSold: string[] = [];
  const longLegIdsRetained: string[] = [];
  for (const closedShort of result.shortLegsClosed) {
    const dbLeg = params.spreadLegs.find((l) => l.legRole === closedShort.legRole);
    if (!dbLeg) continue;
    try {
      await markHedgeLegSold(params.pool, {
        id: dbLeg.id,
        sellPriceUsdc: closedShort.fillPriceUsdcPerBtc,
        sellOrderId: closedShort.orderId ?? null
      });
      shortLegIdsClosed.push(dbLeg.id);
    } catch (err) {
      console.error(
        `[VC ALERT] failed to markHedgeLegSold for spread short ${dbLeg.id} on trigger: ${(err as Error).message}`
      );
    }
  }
  // 2026-05-23: when sell-longs-at-trigger is on (default), longs are
  // SOLD here instead of retained. Mark them sold in DB so hedge
  // manager doesn't pick them up later.
  for (const soldLong of result.longLegsSold) {
    const dbLeg = params.spreadLegs.find((l) => l.legRole === soldLong.legRole);
    if (!dbLeg) continue;
    try {
      await markHedgeLegSold(params.pool, {
        id: dbLeg.id,
        sellPriceUsdc: soldLong.fillPriceUsdcPerBtc,
        sellOrderId: soldLong.orderId ?? null
      });
      longLegIdsSold.push(dbLeg.id);
    } catch (err) {
      console.error(
        `[VC ALERT] failed to markHedgeLegSold for spread long ${dbLeg.id} on trigger: ${(err as Error).message}`
      );
    }
  }
  // Any longs that fell back to retain (orderbook unavailable or sell
  // failed) — mark them retained for hedge manager to handle later.
  for (const retainedLong of result.longLegsRetained) {
    const dbLeg = params.spreadLegs.find((l) => l.legRole === retainedLong.legRole);
    if (!dbLeg) continue;
    try {
      await markHedgeLegRetained(params.pool, {
        id: dbLeg.id,
        retainedReason: `spread_trigger_${params.triggerDirection}`,
        retainedRole:
          (params.triggerDirection === "high" && retainedLong.legRole === "call_long") ||
          (params.triggerDirection === "low" && retainedLong.legRole === "put_long")
            ? "winner_post_trigger"
            : "loser_post_trigger"
      });
      longLegIdsRetained.push(dbLeg.id);
    } catch (err) {
      console.error(
        `[VC ALERT] failed to markHedgeLegRetained for spread long ${dbLeg.id} on trigger: ${(err as Error).message}`
      );
    }
  }

  return {
    shortLegProceedsUsdc: result.shortLegProceedsUsdc,
    longLegProceedsUsdc: result.longLegProceedsUsdc,
    shortLegIdsClosed,
    longLegIdsSold,
    longLegIdsRetained
  };
};
