/**
 * Out-of-band close reconciliation — settle a pair from REAL venue proceeds
 * WITHOUT placing any venue orders.
 *
 * Why this exists: when an operator (or anyone) closes a pair's legs directly
 * on the venue (Bullish/Deribit UI, API, etc.), our system never learns about
 * it. The pair stays in `unwinding`/`triggered`/`active` forever with NULL
 * salvage/shares, and — worse — `runtimeRegistry.bootResurrect()` will re-spawn
 * a runtime for it on the next boot that tries to SELL legs we no longer hold.
 *
 * This module records the actual realized proceeds and walks the pair to
 * `settled` using the SAME canonical split math as the live ExecutionRuntime
 * (`computeSplit` + pinned tier floor), so downstream P&L / ledgers are
 * consistent. It places NO orders — it is pure bookkeeping.
 *
 * Contrast with `respawn-close` (routes.ts), which RE-DRIVES the force-close
 * runtime to actually sell the legs. respawn-close is for a close that never
 * completed (legs still held); reconcile-settle is for a close that already
 * happened OUT OF BAND (legs already gone on-venue).
 */

import type { Pool, PoolClient } from "pg";
import { getLegsForPair, getPairById, recordPairEvent, updatePairStatus } from "./db";
import { computeSplit, assertSplitInvariant, type SplitResult } from "./settlementEngine";
import { getTierByLabel } from "./tierResolver";
import type { CloseReason, ExitMode, PairRecord, PairStatus } from "./types";

export type ReconcileSettleInput = {
  pairId: string;
  /** Per-leg realized proceeds (USDC). Preferred — also writes the leg sell_* columns. */
  putProceedsUsdc?: number;
  callProceedsUsdc?: number;
  /** Alternative: a single total realized salvage (USDC) when per-leg is unknown. */
  salvageProceedsUsdc?: number;
  /** Recorded close reason (default "foxify_close" — the manual-close analog). */
  closedReason?: CloseReason;
  /** Recorded exit mode (default "foxify_close"). */
  exitMode?: ExitMode;
  /** Operator audit note, stored on the manual_reconcile event + pair metadata. */
  note?: string;
  /** Fire the Foxify pair-closed webhook (default FALSE — manual reconciles are
   *  usually operator-known test pairs; avoid double-notifying). */
  deliverWebhook?: boolean;
  /** Testability hook. */
  nowMs?: number;
};

export type ReconcileSettleOk = {
  ok: true;
  pair: PairRecord;
  split: SplitResult;
  salvageProceedsUsdc: number;
  /** The status the pair was in before reconciliation (active/triggered/unwinding). */
  steppedFrom: PairStatus;
  perLegApplied: boolean;
};

export type ReconcileSettleErr = {
  ok: false;
  error: "pair_not_found" | "already_terminal" | "invalid_proceeds" | "not_settleable";
  message: string;
  details?: Record<string, unknown>;
};

export type ReconcileSettleResult = ReconcileSettleOk | ReconcileSettleErr;

const log = (msg: string, meta?: Record<string, unknown>): void => {
  console.log(`[reconcileSettle] ${msg}`, meta ?? "");
};

/**
 * Reconcile-settle a pair from real venue proceeds. No venue orders are placed.
 */
export const reconcileSettlePair = async (
  pool: Pool | PoolClient,
  input: ReconcileSettleInput
): Promise<ReconcileSettleResult> => {
  const now = input.nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const pair = await getPairById(pool, input.pairId);
  if (!pair) {
    return { ok: false, error: "pair_not_found", message: `Pair ${input.pairId} not found` };
  }
  if (pair.status === "settled" || pair.status === "cancelled") {
    return {
      ok: false,
      error: "already_terminal",
      message: `Pair ${input.pairId} is already terminal (status=${pair.status}); nothing to reconcile`,
      details: { status: pair.status }
    };
  }
  if (pair.status === "pending") {
    return {
      ok: false,
      error: "not_settleable",
      message: `Pair ${input.pairId} is 'pending' (never went active); cannot reconcile-settle. Cancel it instead.`,
      details: { status: pair.status }
    };
  }
  // From here: status ∈ {active, triggered, unwinding}.

  // ── Resolve salvage proceeds ──────────────────────────────────────────────
  const hasPerLeg = input.putProceedsUsdc != null || input.callProceedsUsdc != null;
  let salvage: number;
  if (hasPerLeg) {
    const put = input.putProceedsUsdc ?? 0;
    const call = input.callProceedsUsdc ?? 0;
    if (!Number.isFinite(put) || !Number.isFinite(call) || put < 0 || call < 0) {
      return { ok: false, error: "invalid_proceeds", message: `Per-leg proceeds must be finite and >= 0 (put=${input.putProceedsUsdc}, call=${input.callProceedsUsdc})` };
    }
    salvage = put + call;
  } else {
    if (input.salvageProceedsUsdc == null || !Number.isFinite(input.salvageProceedsUsdc) || input.salvageProceedsUsdc < 0) {
      return { ok: false, error: "invalid_proceeds", message: `Provide per-leg proceeds (put_proceeds_usdc/call_proceeds_usdc) OR a finite salvage_proceeds_usdc >= 0` };
    }
    salvage = input.salvageProceedsUsdc;
  }

  const steppedFrom = pair.status;

  // ── Stop any tracked runtime so it can't race us (lazy import avoids cycle) ─
  try {
    const { getRuntimeRegistry } = await import("./runtimeRegistry");
    const reg = getRuntimeRegistry();
    const rt = reg.getRuntime(pair.pairId);
    if (rt) {
      rt.stop();
      reg.deregister(pair.pairId);
      log(`stopped + deregistered live runtime for ${pair.pairId} before reconcile`);
    }
  } catch (e) {
    log(`runtime stop skipped for ${pair.pairId}: ${(e as Error).message}`);
  }

  // ── Step the status machine legally to settled ─────────────────────────────
  // stateMachine permits: active→unwinding, triggered→unwinding, unwinding→settled.
  // It forbids active→settled and triggered→settled directly, so step via unwinding.
  if (pair.status === "active" || pair.status === "triggered") {
    await updatePairStatus(pool, pair.pairId, "unwinding");
  }

  // ── Write leg sell info when per-leg proceeds are supplied ──────────────────
  let perLegApplied = false;
  if (hasPerLeg) {
    const legs = await getLegsForPair(pool, pair.pairId);
    const putLeg = legs.find((l) => l.legRole === "long_put");
    const callLeg = legs.find((l) => l.legRole === "long_call");
    const apply = async (leg: typeof legs[number] | undefined, proceeds: number | undefined) => {
      if (!leg || proceeds == null) return;
      const perBtc = leg.contractsBtc > 0 ? proceeds / leg.contractsBtc : 0;
      await pool.query(
        `UPDATE two_sided_pair_leg
            SET sell_ask_usdc_per_btc = $1,
                sell_proceeds_usdc = $2,
                sell_filled_at = $3
          WHERE leg_id = $4`,
        [perBtc, proceeds, nowIso, leg.legId]
      );
    };
    await apply(putLeg, input.putProceedsUsdc);
    await apply(callLeg, input.callProceedsUsdc);
    perLegApplied = true;
  }

  // ── Canonical split (identical to ExecutionRuntime.executeClose) ────────────
  const tier = getTierByLabel(pair.tierAtActivation);
  const tierWithPinnedFloor = { ...tier, atticusFloorUsdc: pair.atticusFloorUsdc };
  const split = computeSplit({
    salvageProceedsUsdc: salvage,
    hedgeCostUsdc: pair.hedgeCostTotalUsdc,
    tier: tierWithPinnedFloor
  });
  assertSplitInvariant(split);
  const atticusShare = split.atticusShareUsdc;
  const foxifyShare = split.foxifyShareUsdc;
  const uplift = split.upliftUsdc;
  const closedReason: CloseReason = input.closedReason ?? "foxify_close";
  const exitMode: ExitMode = input.exitMode ?? "foxify_close";

  // ── Deferred-pool accrual (mirror runtime; tolerant) ────────────────────────
  if (atticusShare > 0) {
    try {
      const { getPoolState, recordAccrual } = await import("./deferredPool");
      const poolState = await getPoolState(pool).catch(() => null);
      if (poolState && poolState.active) {
        const { randomUUID } = await import("node:crypto");
        await recordAccrual(pool, {
          ledgerId: randomUUID(),
          pairId: pair.pairId,
          atticusShareUsdc: atticusShare,
          upliftUsdc: uplift
        });
      }
    } catch (e) {
      log(`deferred-pool accrual skipped for ${pair.pairId}: ${(e as Error).message}`);
    }
  }

  // ── Persist settlement ──────────────────────────────────────────────────────
  const settled = await updatePairStatus(pool, pair.pairId, "settled", {
    closedAt: nowIso,
    closedReason,
    salvageProceedsUsdc: salvage,
    upliftUsdc: uplift,
    foxifyShareUsdc: foxifyShare,
    atticusShareUsdc: atticusShare,
    exitMode
  });

  // ── Stamp metadata.reconciled (read-modify-write — pg-mem safe, no jsonb ||) ─
  let finalPair = settled;
  try {
    const mergedMeta = {
      ...(settled.metadata ?? {}),
      reconciled: true,
      reconcile_note: input.note ?? null,
      reconcile_at: nowIso,
      reconcile_stepped_from: steppedFrom
    };
    const r = await pool.query(
      `UPDATE two_sided_pair SET metadata = $2, updated_at = NOW() WHERE pair_id = $1 RETURNING *`,
      [pair.pairId, JSON.stringify(mergedMeta)]
    );
    if (r.rows[0]) {
      const refreshed = await getPairById(pool, pair.pairId);
      if (refreshed) finalPair = refreshed;
    }
  } catch (e) {
    log(`metadata stamp skipped for ${pair.pairId}: ${(e as Error).message}`);
  }

  // ── Events: manual_reconcile (audit) + settled (mirrors runtime) ────────────
  await recordPairEvent(pool, {
    pairId: pair.pairId,
    kind: "manual_reconcile",
    details: {
      source: "manual_reconcile",
      stepped_from: steppedFrom,
      note: input.note ?? null,
      salvage,
      put_proceeds_usdc: input.putProceedsUsdc ?? null,
      call_proceeds_usdc: input.callProceedsUsdc ?? null,
      per_leg_applied: perLegApplied,
      reconciled_at: nowIso
    },
    occurredAt: nowIso
  });
  await recordPairEvent(pool, {
    pairId: pair.pairId,
    kind: "settled",
    details: {
      reconciled: true,
      salvage,
      uplift,
      foxifyShare,
      atticusShare,
      exitMode,
      closedReason
    },
    occurredAt: nowIso
  });

  // ── Counterparty ledger (mirror runtime; tolerant) ──────────────────────────
  try {
    const { recordSettleEntries } = await import("./counterpartyLedger");
    const { getPoolState } = await import("./deferredPool");
    const poolState = await getPoolState(pool).catch(() => null);
    await recordSettleEntries(pool, {
      pairId: pair.pairId,
      salvageProceedsUsdc: salvage,
      foxifyShareUsdc: foxifyShare,
      atticusShareUsdc: atticusShare,
      upliftUsdc: uplift,
      isDeferredPoolActive: poolState?.active ?? false
    });
  } catch (e) {
    log(`ledger settle entries skipped for ${pair.pairId}: ${(e as Error).message}`);
  }

  // ── Optional webhook (default OFF) ──────────────────────────────────────────
  if (input.deliverWebhook === true) {
    try {
      const { deliverPairClosed } = await import("./webhookDelivery");
      void deliverPairClosed(pool as Pool, {
        pair_id: pair.pairId,
        foxify_pair_ref: pair.foxifyPairRef,
        closed_at: nowIso,
        closed_reason: closedReason,
        trigger_side: pair.triggerSide,
        salvage_proceeds_usdc: salvage,
        uplift_usdc: uplift,
        foxify_share_usdc: foxifyShare,
        atticus_share_usdc: atticusShare,
        exit_mode: exitMode,
        tier_at_settlement: pair.tierAtActivation
      }).catch((e) => log(`webhook delivery failed for ${pair.pairId}: ${(e as Error).message}`));
    } catch (e) {
      log(`webhook module load failed for ${pair.pairId}: ${(e as Error).message}`);
    }
  }

  log(`reconciled ${pair.pairId}: ${steppedFrom} → settled, salvage=$${salvage.toFixed(2)}, uplift=$${uplift.toFixed(2)}, foxify=$${foxifyShare.toFixed(2)}, atticus=$${atticusShare.toFixed(2)}`);

  return { ok: true, pair: finalPair, split, salvageProceedsUsdc: salvage, steppedFrom, perLegApplied };
};
