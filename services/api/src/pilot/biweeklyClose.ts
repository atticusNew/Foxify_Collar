/**
 * Biweekly subscription close handler.
 *
 * Single source of truth for ending a biweekly protection. Three
 * code paths invoke this:
 *
 *   1. User-initiated close via POST /pilot/protections/:id/close
 *      → closedBy="user_close", status→"cancelled"
 *
 *   2. Trigger fired by triggerMonitor.ts (biweekly path)
 *      → closedBy="trigger", status→"triggered",
 *        hedgeRetainedForPlatform=true (per CEO direction 2026-04-30:
 *        protection closes for user, hedge stays open for platform)
 *
 *   3. Natural max-tenor expiry via the expiry sweep
 *      → closedBy="natural_expiry", status→"expired_otm",
 *        days_billed=BIWEEKLY_MAX_TENOR_DAYS, full max charge
 *
 * Common semantics across all paths:
 *   - Computes accumulated charge from (closedAt − createdAt) using
 *     PR 1's computeAccumulatedCharge (rounds days UP, clamps to
 *     [1, 14], rate × notional/1000)
 *   - Calls markProtectionClosed (PR 2) which is atomic + idempotent
 *   - Inserts subscription_close_settlement ledger entry
 *   - Returns the updated protection
 *   - Idempotent: if the protection was already closed, returns the
 *     prior close result without writing again
 *
 * What this does NOT do
 * ---------------------
 * - Does NOT touch the underlying Deribit hedge. The hedge manager
 *   (services/api/src/pilot/hedgeManager.ts) owns disposition. For
 *   trigger close, hedgeRetainedForPlatform=true is set so the
 *   hedge manager knows this hedge is platform-owned and can be
 *   disposed on its own schedule (re-tuned in PR 6).
 * - Does NOT process the trigger payout. That's done by
 *   triggerMonitor.ts (legacy path: insert trigger_payout_due
 *   ledger entry). Close handler runs AFTER trigger persistence.
 * - Does NOT modify legacy 1-day protections. The handler's first
 *   action checks tenor_days; if 1 (legacy), it returns an error.
 */

import Decimal from "decimal.js";
import type { Pool } from "pg";

import {
  BIWEEKLY_MAX_TENOR_DAYS,
  BIWEEKLY_MIN_DAYS_BILLED,
  computeAccumulatedCharge,
  computeDaysHeld
} from "./biweeklyPricing";
import {
  cancelProtectionCloseRequest,
  getProtectionSubscriptionState,
  insertLedgerEntry,
  listScheduledClosesDue,
  markProtectionClosed,
  requestProtectionClose,
  type SubscriptionCloseReason
} from "./db";
import type { ProtectionRecord, ProtectionStatus, V7SlTier } from "./types";
import { getProtection } from "./db";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type BiweeklyCloseReason = SubscriptionCloseReason;

export type BiweeklyCloseRequest = {
  protectionId: string;
  closedBy: BiweeklyCloseReason;
  /** Override "now" for tests / deterministic billing. Defaults to Date.now(). */
  nowMs?: number;
};

export type BiweeklyCloseResult =
  | {
      status: "ok";
      product: "biweekly";
      protection: ProtectionRecord;
      accumulatedChargeUsd: number;
      daysBilled: number;
      hedgeRetainedForPlatform: boolean;
      /** True if this call actually closed the protection; false if it was already closed (idempotent). */
      newlyClosed: boolean;
    }
  | { status: "error"; reason: BiweeklyCloseErrorReason; message: string };

export type BiweeklyCloseErrorReason =
  | "not_found"
  | "not_biweekly"           // legacy 1-day protection — wrong handler
  | "missing_rate"           // biweekly without daily_rate_usd_per_1k (data corruption)
  | "missing_sl_pct"         // biweekly without sl_pct (data corruption)
  | "storage_unavailable";

// ─────────────────────────────────────────────────────────────────────
// Status mapping per close reason
// ─────────────────────────────────────────────────────────────────────

/**
 * Map close reason to the new ProtectionStatus.
 *
 *   user_close      → "cancelled"
 *   trigger         → "triggered"
 *   natural_expiry  → "expired_otm"
 *   admin           → "cancelled" (admin force-close uses same status as user close)
 */
const statusForCloseReason = (reason: BiweeklyCloseReason): ProtectionStatus => {
  switch (reason) {
    case "user_close":
      return "cancelled";
    case "trigger":
      return "triggered";
    case "natural_expiry":
      return "expired_otm";
    case "admin":
      return "cancelled";
  }
};

/**
 * Per CEO direction 2026-04-30: when a trigger fires, the protection
 * closes for the user but the underlying Deribit option stays open
 * for the platform. The hedge manager owns disposition (sell now to
 * lock recovery, hold for continuation, etc.). This helper returns
 * true only for the trigger path.
 *
 * For user_close and natural_expiry, hedge disposition follows the
 * existing hedge manager logic (sell residual time value).
 */
const hedgeRetainedFor = (reason: BiweeklyCloseReason): boolean => reason === "trigger";

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Close a biweekly protection. Returns the updated protection plus
 * the billed amount, OR a structured error.
 *
 * Idempotent: if the protection is already closed, returns ok with
 * newlyClosed=false and the existing accumulated_charge_usd /
 * days_billed values. Safe to call multiple times.
 *
 * Validates that the protection is biweekly (tenor_days >= 2). Legacy
 * 1-day protections return not_biweekly — they should use the
 * existing legacy expiry/cancel flow.
 */
export const handleBiweeklyClose = async (params: {
  pool: Pool;
  req: BiweeklyCloseRequest;
}): Promise<BiweeklyCloseResult> => {
  const { pool, req } = params;
  const nowMs = req.nowMs ?? Date.now();

  // ── Fetch lightweight subscription state ──
  let state;
  try {
    state = await getProtectionSubscriptionState(pool, req.protectionId);
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: `Lookup failed: ${err?.message ?? "unknown"}`
    };
  }
  if (!state) {
    return { status: "error", reason: "not_found", message: "Protection not found." };
  }

  if (state.tenorDays < 2) {
    return {
      status: "error",
      reason: "not_biweekly",
      message: "This handler only manages biweekly subscriptions. Use the legacy expiry/cancel path for 1-day protections."
    };
  }

  // ── Idempotency: if already closed, return prior result ──
  if (state.closedAtIso !== null) {
    const protection = await getProtection(pool, req.protectionId);
    if (!protection) {
      return { status: "error", reason: "not_found", message: "Protection vanished mid-close." };
    }
    return {
      status: "ok",
      product: "biweekly",
      protection,
      accumulatedChargeUsd: Number(protection.accumulatedChargeUsd),
      daysBilled: protection.daysBilled,
      hedgeRetainedForPlatform: protection.hedgeRetainedForPlatform,
      newlyClosed: false
    };
  }

  if (state.dailyRateUsdPer1k === null) {
    return {
      status: "error",
      reason: "missing_rate",
      message: "Biweekly protection has no daily_rate_usd_per_1k set (data corruption)."
    };
  }
  if (state.slPct === null) {
    return {
      status: "error",
      reason: "missing_sl_pct",
      message: "Biweekly protection has no sl_pct set (data corruption)."
    };
  }

  // ── Compute accumulated charge ──
  const activatedAtMs = new Date(state.createdAtIso).getTime();
  const daysHeldRaw = computeDaysHeld({ activatedAtMs, nowMs });

  // For natural_expiry, force days_billed to MAX_TENOR_DAYS regardless
  // of clock drift (the protection ran the full 14 days).
  const daysToCompute =
    req.closedBy === "natural_expiry" ? BIWEEKLY_MAX_TENOR_DAYS : daysHeldRaw;

  const accumulatedChargeUsd = computeAccumulatedCharge({
    daysHeld: daysToCompute,
    notionalUsd: Number(state.protectedNotional),
    slPct: state.slPct as V7SlTier
  });

  // computeAccumulatedCharge already clamps days to [1, 14] internally
  // for the charge math. We redo the clamp here to record the exact
  // billed days on the row.
  const daysBilled =
    req.closedBy === "natural_expiry"
      ? BIWEEKLY_MAX_TENOR_DAYS
      : Math.min(BIWEEKLY_MAX_TENOR_DAYS, Math.max(1, Math.ceil(daysHeldRaw)));

  const closedAtIso = new Date(nowMs).toISOString();
  const newStatus = statusForCloseReason(req.closedBy);
  const hedgeRetained = hedgeRetainedFor(req.closedBy);

  // ── Atomic close write ──
  let didClose: boolean;
  try {
    didClose = await markProtectionClosed(pool, {
      protectionId: req.protectionId,
      closedAtIso,
      closedBy: req.closedBy,
      accumulatedChargeUsd: new Decimal(accumulatedChargeUsd).toFixed(8),
      daysBilled,
      newStatus,
      hedgeRetainedForPlatform: hedgeRetained
    });
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: `Close write failed: ${err?.message ?? "unknown"}`
    };
  }

  if (!didClose) {
    // Race condition: another close happened between our state read
    // and our write. Re-read and return the prior close result.
    const protection = await getProtection(pool, req.protectionId);
    if (!protection) {
      return { status: "error", reason: "not_found", message: "Protection vanished mid-close." };
    }
    return {
      status: "ok",
      product: "biweekly",
      protection,
      accumulatedChargeUsd: Number(protection.accumulatedChargeUsd),
      daysBilled: protection.daysBilled,
      hedgeRetainedForPlatform: protection.hedgeRetainedForPlatform,
      newlyClosed: false
    };
  }

  // ── Insert subscription_close_settlement ledger entry ──
  // Best-effort: a failure here doesn't roll back the close (the close
  // already succeeded atomically). The ledger entry is for accounting
  // audit; if it's missing we can backfill by querying
  // pilot_protections WHERE closed_at IS NOT NULL minus existing
  // ledger entries.
  try {
    await insertLedgerEntry(pool, {
      protectionId: req.protectionId,
      entryType: "subscription_close_settlement",
      amount: new Decimal(accumulatedChargeUsd).toFixed(8),
      reference: `close:${req.closedBy}:${daysBilled}d`
    });
  } catch (err: any) {
    console.warn(
      `[biweeklyClose] Failed to insert close ledger entry for ${req.protectionId}: ${err?.message ?? "unknown"}. Close itself succeeded; ledger backfill needed.`
    );
  }

  // ── Re-fetch the updated protection record ──
  const protection = await getProtection(pool, req.protectionId);
  if (!protection) {
    return {
      status: "error",
      reason: "not_found",
      message: "Protection vanished after close (unexpected)."
    };
  }

  console.log(
    `[biweeklyClose] CLOSED: protection=${req.protectionId} reason=${req.closedBy} ` +
      `daysBilled=${daysBilled} accumulatedCharge=$${accumulatedChargeUsd.toFixed(2)} ` +
      `newStatus=${newStatus} hedgeRetained=${hedgeRetained}`
  );

  return {
    status: "ok",
    product: "biweekly",
    protection,
    accumulatedChargeUsd,
    daysBilled,
    hedgeRetainedForPlatform: hedgeRetained,
    newlyClosed: true
  };
};

// ─────────────────────────────────────────────────────────────────────
// Natural expiry sweep
// ─────────────────────────────────────────────────────────────────────

export type NaturalExpirySweepResult = {
  scanned: number;
  closed: number;
  errors: number;
};

/**
 * Sweep open biweekly protections that have hit their max tenor
 * (created_at + BIWEEKLY_MAX_TENOR_DAYS <= now). Closes each with
 * closedBy="natural_expiry". Designed to run on a periodic ticker
 * (recommended: hourly, but works at any cadence — idempotent close
 * means duplicate-fires don't cause double-billing).
 *
 * Returns counts. The caller (router or scheduler) chooses cadence.
 *
 * For the MVP, this is invoked from the trigger monitor loop
 * (every cycle = every 3 seconds in production). Cheap query.
 */
export const sweepBiweeklyNaturalExpiries = async (params: {
  pool: Pool;
  nowMs?: number;
}): Promise<NaturalExpirySweepResult> => {
  const nowMs = params.nowMs ?? Date.now();
  const result: NaturalExpirySweepResult = { scanned: 0, closed: 0, errors: 0 };

  // Find biweekly protections that should have expired by now.
  const cutoffIso = new Date(nowMs - BIWEEKLY_MAX_TENOR_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let rows: Array<{ id: string }>;
  try {
    const r = await params.pool.query(
      `SELECT id
       FROM pilot_protections
       WHERE tenor_days >= 2
         AND closed_at IS NULL
         AND created_at <= $1::timestamptz
       LIMIT 100`,
      [cutoffIso]
    );
    rows = r.rows.map((row) => ({ id: String(row.id) }));
  } catch (err: any) {
    console.warn(`[biweeklyClose] expiry sweep query failed: ${err?.message ?? "unknown"}`);
    return result;
  }

  result.scanned = rows.length;
  for (const row of rows) {
    try {
      const closeResult = await handleBiweeklyClose({
        pool: params.pool,
        req: { protectionId: row.id, closedBy: "natural_expiry", nowMs }
      });
      if (closeResult.status === "ok" && closeResult.newlyClosed) {
        result.closed += 1;
      } else if (closeResult.status === "error") {
        result.errors += 1;
        console.warn(
          `[biweeklyClose] expiry sweep close failed for ${row.id}: ${closeResult.reason} ${closeResult.message}`
        );
      }
    } catch (err: any) {
      result.errors += 1;
      console.warn(`[biweeklyClose] expiry sweep threw for ${row.id}: ${err?.message ?? "unknown"}`);
    }
  }

  if (result.scanned > 0) {
    console.log(
      `[biweeklyClose] expiry sweep complete: scanned=${result.scanned} closed=${result.closed} errors=${result.errors}`
    );
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────
// Deferred close (2026-05-06, per CEO direction)
// ─────────────────────────────────────────────────────────────────────
//
// Trader pays whole-day units (Math.ceil); protection should ALSO be
// whole-day units. Previous immediate-close behaviour billed a full
// day but cut protection mid-day. Deferred close aligns the two: a
// close request takes effect at the next billing-day boundary
// (= activation + ceil(daysHeld) * 24h), so the trader gets every
// hour of every day they pay for.
//
// Status stays 'active' through the deferred window so trigger
// monitor and hedge manager keep working normally. A periodic sweep
// converts due requests to actual closes via the existing
// handleBiweeklyClose path.

export type RequestCloseResult =
  | {
      status: "ok";
      product: "biweekly";
      protection: ProtectionRecord;
      /** ISO timestamp when the protection will actually close. */
      closeEffectiveAt: string;
      /** Days that will be billed at close_effective_at. */
      daysBilledAtEffective: number;
      /** Charge that will be settled at close_effective_at, in USD. */
      accumulatedChargeAtEffectiveUsd: number;
      /** True if THIS call wrote the schedule; false if a prior schedule was already in place (idempotent). */
      newlyRequested: boolean;
    }
  | {
      status: "error";
      reason: BiweeklyCloseErrorReason | "already_closed" | "trigger_in_progress";
      message: string;
    };

/**
 * Compute the next billing-day boundary from activation that lies
 * AT OR AFTER nowMs. Matches the ceil-with-grace semantics used by
 * computeAccumulatedCharge so a close requested at hour 23 of day 1
 * doesn't tip into day 2's billing.
 *
 *   activatedAt + max(BIWEEKLY_MIN_DAYS_BILLED, ceil(daysHeld_at_now)) × 24h
 *   clamped to activatedAt + BIWEEKLY_MAX_TENOR_DAYS × 24h
 *
 * Returns ISO string + integer days at the boundary.
 */
const computeNextBoundary = (
  activatedAtMs: number,
  nowMs: number
): { effectiveMs: number; daysAtBoundary: number } => {
  const daysHeld = computeDaysHeld({ activatedAtMs, nowMs });
  const daysAtBoundary = Math.min(
    BIWEEKLY_MAX_TENOR_DAYS,
    Math.max(BIWEEKLY_MIN_DAYS_BILLED, Math.ceil(daysHeld))
  );
  const effectiveMs = activatedAtMs + daysAtBoundary * 86400 * 1000;
  return { effectiveMs, daysAtBoundary };
};

/**
 * Schedule a deferred close on a biweekly protection.
 *
 * Idempotent: if a close was already requested, returns the existing
 * schedule with newlyRequested=false. Refuses if the row is already
 * closed or in the middle of a trigger settlement.
 */
export const requestBiweeklyClose = async (params: {
  pool: Pool;
  protectionId: string;
  nowMs?: number;
}): Promise<RequestCloseResult> => {
  const { pool, protectionId } = params;
  const nowMs = params.nowMs ?? Date.now();

  let state;
  try {
    state = await getProtectionSubscriptionState(pool, protectionId);
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: `Lookup failed: ${err?.message ?? "unknown"}`
    };
  }
  if (!state) return { status: "error", reason: "not_found", message: "Protection not found." };
  if (state.tenorDays < 2) {
    return { status: "error", reason: "not_biweekly", message: "Deferred close only applies to biweekly protections." };
  }
  if (state.closedAtIso !== null) {
    return { status: "error", reason: "already_closed", message: "Protection already closed." };
  }
  if (state.dailyRateUsdPer1k === null) {
    return { status: "error", reason: "missing_rate", message: "Biweekly protection missing daily_rate_usd_per_1k." };
  }
  if (state.slPct === null) {
    return { status: "error", reason: "missing_sl_pct", message: "Biweekly protection missing sl_pct." };
  }

  const activatedAtMs = new Date(state.createdAtIso).getTime();
  const { effectiveMs, daysAtBoundary } = computeNextBoundary(activatedAtMs, nowMs);
  const closeEffectiveIso = new Date(effectiveMs).toISOString();
  const closeRequestedIso = new Date(nowMs).toISOString();

  const accumulatedChargeUsd = computeAccumulatedCharge({
    daysHeld: daysAtBoundary,
    notionalUsd: Number(state.protectedNotional),
    slPct: state.slPct as V7SlTier
  });

  let newlyRequested: boolean;
  try {
    newlyRequested = await requestProtectionClose(pool, {
      protectionId,
      closeRequestedAtIso: closeRequestedIso,
      closeEffectiveAtIso: closeEffectiveIso
    });
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: `Schedule write failed: ${err?.message ?? "unknown"}`
    };
  }

  // If newlyRequested === false the row already had a schedule. Either
  // way re-fetch and return the canonical state — caller doesn't need
  // to know whether the schedule was just-written or pre-existing
  // beyond the boolean flag.
  const protection = await getProtection(pool, protectionId);
  if (!protection) {
    return { status: "error", reason: "not_found", message: "Protection vanished mid-schedule." };
  }

  console.log(
    `[biweeklyClose] schedule ${newlyRequested ? "set" : "REUSED"}: protection=${protectionId} ` +
      `effectiveAt=${closeEffectiveIso} daysAtBoundary=${daysAtBoundary} ` +
      `chargeAtEffectiveUsd=$${accumulatedChargeUsd.toFixed(2)}`
  );

  return {
    status: "ok",
    product: "biweekly",
    protection,
    closeEffectiveAt: protection.closeEffectiveAt ?? closeEffectiveIso,
    daysBilledAtEffective: daysAtBoundary,
    accumulatedChargeAtEffectiveUsd: accumulatedChargeUsd,
    newlyRequested
  };
};

/**
 * Cancel a previously-scheduled close (the "undo" path).
 * Returns true if a schedule was cleared, false if no pending
 * schedule existed.
 */
export const cancelBiweeklyCloseRequest = async (params: {
  pool: Pool;
  protectionId: string;
}): Promise<{ status: "ok"; protection: ProtectionRecord; cleared: boolean } | { status: "error"; reason: "not_found"; message: string }> => {
  const cleared = await cancelProtectionCloseRequest(params.pool, params.protectionId);
  const protection = await getProtection(params.pool, params.protectionId);
  if (!protection) return { status: "error", reason: "not_found", message: "Protection not found." };
  console.log(
    `[biweeklyClose] schedule cleared=${cleared}: protection=${params.protectionId}`
  );
  return { status: "ok", protection, cleared };
};

/**
 * Sweep due scheduled closes. Runs alongside
 * sweepBiweeklyNaturalExpiries on the trigger monitor's tick loop.
 *
 * Critical: bills at the close_effective_at timestamp, NOT at the
 * sweep tick time. This guarantees the trader is billed exactly the
 * amount they were quoted at close-request time. If the sweep runs
 * 2 hours late (slow tick, downtime, etc.) the trader still pays
 * for daysAtBoundary days, not daysAtBoundary+1.
 *
 * Idempotent: handleBiweeklyClose is the source of truth for the
 * actual close write; sweep just hands off due rows.
 */
export const sweepScheduledCloses = async (params: {
  pool: Pool;
  nowMs?: number;
}): Promise<NaturalExpirySweepResult> => {
  const nowMs = params.nowMs ?? Date.now();
  const result: NaturalExpirySweepResult = { scanned: 0, closed: 0, errors: 0 };

  let rows: Array<{ id: string }>;
  try {
    rows = await listScheduledClosesDue(params.pool, nowMs);
  } catch (err: any) {
    console.warn(`[biweeklyClose] scheduled-close sweep query failed: ${err?.message ?? "unknown"}`);
    return result;
  }
  result.scanned = rows.length;

  for (const row of rows) {
    try {
      // Read the row's close_effective_at to use as the billing
      // anchor. Falls back to nowMs if column unset (shouldn't happen
      // since listScheduledClosesDue filters on it).
      const protection = await getProtection(params.pool, row.id);
      const billAtMs = protection?.closeEffectiveAt
        ? new Date(protection.closeEffectiveAt).getTime()
        : nowMs;
      const closeResult = await handleBiweeklyClose({
        pool: params.pool,
        req: { protectionId: row.id, closedBy: "user_close", nowMs: billAtMs }
      });
      if (closeResult.status === "ok" && closeResult.newlyClosed) {
        result.closed += 1;
      } else if (closeResult.status === "error") {
        result.errors += 1;
        console.warn(
          `[biweeklyClose] scheduled-close sweep failed for ${row.id}: ${closeResult.reason} ${closeResult.message}`
        );
      }
    } catch (err: any) {
      result.errors += 1;
      console.warn(`[biweeklyClose] scheduled-close sweep threw for ${row.id}: ${err?.message ?? "unknown"}`);
    }
  }

  if (result.scanned > 0) {
    console.log(
      `[biweeklyClose] scheduled-close sweep complete: scanned=${result.scanned} closed=${result.closed} errors=${result.errors}`
    );
  }
  return result;
};
