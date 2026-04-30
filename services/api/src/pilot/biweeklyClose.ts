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
  computeAccumulatedCharge,
  computeDaysHeld
} from "./biweeklyPricing";
import {
  getProtectionSubscriptionState,
  insertLedgerEntry,
  markProtectionClosed,
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
