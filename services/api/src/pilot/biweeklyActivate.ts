/**
 * Biweekly subscription activate path.
 *
 * Self-contained handler for the new biweekly product. The activate
 * and quote endpoints in routes.ts dispatch here when the feature
 * flag is on (PILOT_BIWEEKLY_ENABLED=true) and the trader is
 * requesting a biweekly subscription. When the flag is off, the
 * legacy 1-day activate logic in routes.ts runs unchanged.
 *
 * Why this lives in its own module
 * --------------------------------
 * The legacy activate endpoint (routes.ts /pilot/protections/activate)
 * is ~700 lines of accumulated logic — V7 vs legacy pricing, tier-cap
 * checks, daily-cap reservations, multiple safety guards layered over
 * years. Modifying it in place to support biweekly would risk
 * regressing live trades. Instead this module owns the entire
 * biweekly flow and the legacy endpoint stays untouched.
 *
 * Flow
 * ----
 * QUOTE:
 *   1. Validate body (notional, sl_pct, direction)
 *   2. Compute trigger price from spot + sl_pct + direction
 *   3. Build a biweekly quote preview (daily rate, max projected charge)
 *   4. Call venue.quote with requestedTenorDays = 14
 *   5. Persist the venue quote in pilot_venue_quotes (existing table)
 *   6. Return a biweekly-shaped response containing both the venue
 *      quote ID and the per-day rate
 *
 * ACTIVATE:
 *   1. Validate body + look up the prior venue quote (must exist + unconsumed)
 *   2. Run safety guards: 1-trade-per-24h, hedge budget cap, circuit breaker
 *   3. Call venue.execute to actually buy the 14-day option on Deribit
 *   4. Insert pilot_protections row with tenor_days=14, daily_rate set,
 *      accumulated_charge_usd=0, expiry_at = now + 14 days
 *   5. Insert pilot_venue_executions row + pilot_ledger entry
 *      (subscription_started — no upfront premium charge)
 *   6. Mark the venue quote as consumed
 *   7. Return the new protection record
 *
 * What this does NOT do
 * ---------------------
 * - Does not modify venue.quote / venue.execute (uses existing
 *   PilotVenueAdapter as-is, just with tenorDays=14)
 * - Does not modify any DB schema (uses PR 2's columns)
 * - Does not change the trigger monitor (PR 4 wires close-on-trigger)
 * - Does not change the hedge manager TP behavior (PR 6)
 * - Does not handle close (PR 4)
 *
 * Tested via tests/pilotBiweeklyActivate.test.ts.
 */

import Decimal from "decimal.js";
import type { Pool } from "pg";

import {
  buildBiweeklyQuotePreview,
  BIWEEKLY_HEDGE_TENOR_DAYS,
  BIWEEKLY_MAX_TENOR_DAYS,
  BIWEEKLY_TENOR_DRIFT_BOUND_DAYS,
  getBiweeklyRatePerDayPer1k,
  isBiweeklyEnabled
} from "./biweeklyPricing";
import {
  countActivationsInLast24h,
  insertLedgerEntry,
  insertProtection,
  insertVenueExecution,
  insertVenueQuote
} from "./db";
import type { PilotVenueAdapter, QuoteRequest } from "./venue";
import type { ProtectionRecord, V7SlTier } from "./types";
import { isValidSlTier, slPctToTierLabel } from "./v7Pricing";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export type BiweeklyDirection = "long" | "short";

export type BiweeklyQuoteRequest = {
  protectedNotionalUsd: number;
  slPct: number;
  direction: BiweeklyDirection;
  /** Spot price at quote time (typically captured client-side just before quote). */
  spotUsd: number;
  /** Market identifier (e.g., "BTC-USD"). */
  marketId: string;
};

export type BiweeklyQuoteResponse = {
  status: "ok";
  product: "biweekly";
  quoteId: string;
  ratePerDayPer1kUsd: number;
  ratePerDayUsd: number;
  maxTenorDays: number;
  maxProjectedChargeUsd: number;
  payoutOnTriggerUsd: number;
  triggerPriceUsd: number;
  strikeHintUsd: number;
  hedgeQuote: {
    venueQuoteId: string;
    instrumentId: string;
    venuePremiumBtc: number;
    venuePremiumUsd: number;
    expiresAt: string;
  };
};

export type BiweeklyActivateRequest = {
  quoteId: string;
  /** Re-supplied for defense-in-depth: must match the prior quote's notional. */
  protectedNotionalUsd: number;
  /** Re-supplied for defense-in-depth: must match the prior quote's tier. */
  slPct: number;
  /** Re-supplied for defense-in-depth: must match the prior quote's direction. */
  direction: BiweeklyDirection;
  /** Optional client tag for idempotency / debugging. */
  clientOrderId?: string;
};

export type BiweeklyActivateResult =
  | { status: "ok"; product: "biweekly"; protection: ProtectionRecord }
  | { status: "error"; reason: BiweeklyActivateErrorReason; message: string; details?: Record<string, unknown> };

export type BiweeklyActivateErrorReason =
  | "biweekly_disabled"            // feature flag is off
  | "invalid_notional"
  | "invalid_sl_pct"
  | "invalid_direction"
  | "quote_not_found"
  | "quote_already_consumed"
  | "quote_expired"
  | "quote_mismatch"
  | "daily_trade_limit_exceeded"   // 1-trade-per-24h guard
  | "hedge_budget_cap_exceeded"
  | "venue_execute_failed"
  | "storage_unavailable";

// ─────────────────────────────────────────────────────────────────────
// Quote handler
// ─────────────────────────────────────────────────────────────────────

const TRIGGER_REASON_LABEL = (dir: BiweeklyDirection): string =>
  dir === "short" ? "ceiling" : "floor";

const computeTriggerPrice = (spotUsd: number, slPct: number, dir: BiweeklyDirection): number => {
  const move = slPct / 100;
  return dir === "short" ? spotUsd * (1 + move) : spotUsd * (1 - move);
};

const validateQuoteRequest = (
  req: BiweeklyQuoteRequest
): { ok: true; tier: V7SlTier } | { ok: false; reason: BiweeklyActivateErrorReason; message: string } => {
  if (!Number.isFinite(req.protectedNotionalUsd) || req.protectedNotionalUsd <= 0) {
    return { ok: false, reason: "invalid_notional", message: "Notional must be a positive number." };
  }
  if (!isValidSlTier(req.slPct)) {
    return { ok: false, reason: "invalid_sl_pct", message: `SL tier ${req.slPct}% is not supported.` };
  }
  if (req.direction !== "long" && req.direction !== "short") {
    return { ok: false, reason: "invalid_direction", message: "Direction must be 'long' or 'short'." };
  }
  if (!Number.isFinite(req.spotUsd) || req.spotUsd <= 0) {
    return { ok: false, reason: "invalid_notional", message: "Spot price must be a positive number." };
  }
  return { ok: true, tier: req.slPct as V7SlTier };
};

/**
 * Public entry point for the biweekly quote endpoint.
 *
 * Returns either a quote response (with the venue quote ID baked in)
 * or a structured error. Caller (routes.ts) sets the HTTP status code
 * based on the reason field.
 */
export const handleBiweeklyQuote = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
  req: BiweeklyQuoteRequest;
}): Promise<BiweeklyQuoteResponse | { status: "error"; reason: BiweeklyActivateErrorReason; message: string; details?: Record<string, unknown> }> => {
  if (!isBiweeklyEnabled()) {
    return {
      status: "error",
      reason: "biweekly_disabled",
      message: "Biweekly product is not enabled."
    };
  }
  const v = validateQuoteRequest(params.req);
  if (!v.ok) return { status: "error", reason: v.reason, message: v.message };
  const tier = v.tier;
  const { req, venue, pool } = params;

  const triggerPrice = computeTriggerPrice(req.spotUsd, tier, req.direction);
  const optionType = req.direction === "short" ? "C" : "P";
  const preview = buildBiweeklyQuotePreview({
    notionalUsd: req.protectedNotionalUsd,
    slPct: tier
  });

  // Strike sits AT the trigger price by default (matches D2 backtest
  // assumption + PR #76's ITM-aware selection on 2% tier). The venue
  // adapter's strike-selection logic will quantize to the nearest
  // Deribit grid point.
  const strikeHint = triggerPrice;

  // Hedge BTC quantity = notional / spot. The hedge covers the FULL
  // notional in BTC terms, not just the SL slice — this matches the
  // existing 1-day product's hedge sizing convention.
  const hedgeQty = req.protectedNotionalUsd / req.spotUsd;

  const quoteRequest: QuoteRequest = {
    marketId: req.marketId,
    instrumentId: `${req.marketId}-${BIWEEKLY_HEDGE_TENOR_DAYS}D-${optionType}`,
    protectedNotional: req.protectedNotionalUsd,
    quantity: hedgeQty,
    side: "buy",
    protectionType: req.direction,
    drawdownFloorPct: tier / 100,
    triggerPrice,
    requestedTenorDays: BIWEEKLY_HEDGE_TENOR_DAYS,
    // Biweekly clientPremiumUsd = trader's MAX projected charge over
    // the full tenor. This is what the venue adapter compares hedge
    // ask cost against to flag negative-margin deals. It's a soft
    // limit — the adapter still picks the best ITM-aware strike per
    // existing logic; this just informs its margin warning.
    clientPremiumUsd: preview.maxProjectedChargeUsd,
    // Tenor-drift override for biweekly (2026-04-30 fix).
    //
    // Deribit weekly options expire Friday 08:00 UTC, so the grid
    // spacing at the 14-day horizon is 7 days. The nearest weekly
    // expiry to a 14-day target is therefore at most ~3.5 days off
    // (and on most days is closer to 0–3 days off). The prod default
    // PILOT_DERIBIT_MAX_TENOR_DRIFT_DAYS=1.5 is sized for the legacy
    // 1-day product on a (denser) daily grid and is structurally
    // incompatible with biweekly — every quote would trip
    // tenor_drift_exceeded.
    //
    // 4 days = 7d grid spacing / 2 + ~0.5d safety margin. Tight enough
    // that a 14d trade can never silently land on a 7d or 21d expiry
    // (which would mean a >50% tenor mismatch, not a small drift).
    maxTenorDriftDaysOverride: BIWEEKLY_TENOR_DRIFT_BOUND_DAYS
  };

  let venueQuote;
  try {
    venueQuote = await venue.quote(quoteRequest);
  } catch (err: any) {
    return {
      status: "error",
      reason: "venue_execute_failed",
      message: `Venue quote failed: ${err?.message ?? "unknown"}`,
      details: { trigger: TRIGGER_REASON_LABEL(req.direction) }
    };
  }

  // Persist the venue quote so activate can look it up by quoteId
  // later. Reuses the existing pilot_venue_quotes table.
  try {
    await insertVenueQuote(pool, {
      protectionId: null,
      venue: venueQuote.venue,
      quoteId: venueQuote.quoteId,
      rfqId: venueQuote.rfqId ?? null,
      instrumentId: venueQuote.instrumentId,
      side: venueQuote.side,
      quantity: venueQuote.quantity,
      premium: venueQuote.premium,
      expiresAt: venueQuote.expiresAt,
      quoteTs: venueQuote.quoteTs,
      details: {
        ...(venueQuote.details || {}),
        product: "biweekly",
        tier,
        direction: req.direction,
        protectedNotionalUsd: req.protectedNotionalUsd,
        spotUsd: req.spotUsd,
        triggerPriceUsd: triggerPrice,
        ratePerDayPer1kUsd: preview.ratePerDayPer1kUsd,
        ratePerDayUsd: preview.ratePerDayUsd,
        maxProjectedChargeUsd: preview.maxProjectedChargeUsd,
        payoutOnTriggerUsd: preview.payoutOnTriggerUsd
      }
    });
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: "Quote temporarily unavailable. Please try again.",
      details: { underlying: String(err?.message ?? "") }
    };
  }

  // venueQuote.premium is in venue-native units (typically USD on
  // Deribit). For widget display we report both BTC and USD.
  const venuePremiumUsd = venueQuote.premium;
  const venuePremiumBtc = req.spotUsd > 0 ? venuePremiumUsd / req.spotUsd : 0;

  return {
    status: "ok",
    product: "biweekly",
    quoteId: venueQuote.quoteId,
    ratePerDayPer1kUsd: preview.ratePerDayPer1kUsd,
    ratePerDayUsd: preview.ratePerDayUsd,
    maxTenorDays: preview.maxTenorDays,
    maxProjectedChargeUsd: preview.maxProjectedChargeUsd,
    payoutOnTriggerUsd: preview.payoutOnTriggerUsd,
    triggerPriceUsd: triggerPrice,
    strikeHintUsd: strikeHint,
    hedgeQuote: {
      venueQuoteId: venueQuote.quoteId,
      instrumentId: venueQuote.instrumentId,
      venuePremiumBtc,
      venuePremiumUsd,
      expiresAt: venueQuote.expiresAt
    }
  };
};

// ─────────────────────────────────────────────────────────────────────
// Activate handler
// ─────────────────────────────────────────────────────────────────────

/**
 * Look up a previously-issued venue quote by ID, and parse its
 * details payload (which contains the biweekly metadata we wrote in
 * handleBiweeklyQuote). Returns null if not found, expired, or
 * already consumed by another protection.
 */
const lookupBiweeklyQuote = async (
  pool: Pool,
  quoteId: string,
  nowMs: number
): Promise<
  | {
      ok: true;
      venueQuoteRow: {
        venueQuoteId: string;
        rfqId: string | null;
        venue: string;
        instrumentId: string;
        side: string;
        quantity: string;
        premium: string;
        expiresAtIso: string;
        quoteTsIso: string;
        consumedAtIso: string | null;
        details: Record<string, unknown>;
      };
    }
  | { ok: false; reason: "quote_not_found" | "quote_already_consumed" | "quote_expired" }
> => {
  const result = await pool.query(
    `SELECT quote_id, rfq_id, venue, instrument_id, side, quantity, premium,
            expires_at, quote_ts, consumed_at, details
     FROM pilot_venue_quotes
     WHERE quote_id = $1
     LIMIT 1`,
    [quoteId]
  );
  const row = result.rows[0];
  if (!row) return { ok: false, reason: "quote_not_found" };
  if (row.consumed_at !== null) return { ok: false, reason: "quote_already_consumed" };
  const expiresAtMs = new Date(String(row.expires_at)).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return { ok: false, reason: "quote_expired" };
  }
  const detailsRaw = row.details;
  const details: Record<string, unknown> =
    detailsRaw && typeof detailsRaw === "object" && !Array.isArray(detailsRaw)
      ? (detailsRaw as Record<string, unknown>)
      : {};
  return {
    ok: true,
    venueQuoteRow: {
      venueQuoteId: String(row.quote_id),
      rfqId: row.rfq_id ? String(row.rfq_id) : null,
      venue: String(row.venue),
      instrumentId: String(row.instrument_id),
      side: String(row.side),
      quantity: String(row.quantity),
      premium: String(row.premium),
      expiresAtIso: new Date(String(row.expires_at)).toISOString(),
      quoteTsIso: new Date(String(row.quote_ts)).toISOString(),
      consumedAtIso: row.consumed_at ? new Date(String(row.consumed_at)).toISOString() : null,
      details
    }
  };
};

/**
 * Public entry point for the biweekly activate endpoint.
 *
 * Flow:
 *   1. Feature flag check
 *   2. Body validation
 *   3. Look up the prior venue quote
 *   4. Validate quote details match request body (defense-in-depth)
 *   5. 1-trade-per-24h guard
 *   6. Execute on Deribit (real money)
 *   7. Insert protection row + venue execution row + ledger entry
 *   8. Mark quote consumed
 *   9. Return new protection
 *
 * On any error, returns a structured error result. The caller
 * (routes.ts) maps the reason to an appropriate HTTP code.
 */
export const handleBiweeklyActivate = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
  userHash: string;
  hashVersion: number;
  marketId: string;
  req: BiweeklyActivateRequest;
  /** Hook for the existing hedge budget cap evaluation. Pass through; we don't reimplement. */
  evaluateHedgeBudget: (projectedHedgeCostUsd: number) => Promise<{ allowed: boolean; reason?: string; message?: string; details?: Record<string, unknown> }>;
  nowMs?: number;
}): Promise<BiweeklyActivateResult> => {
  const { pool, venue, userHash, hashVersion, marketId, req, evaluateHedgeBudget } = params;
  const nowMs = params.nowMs ?? Date.now();

  if (!isBiweeklyEnabled()) {
    return {
      status: "error",
      reason: "biweekly_disabled",
      message: "Biweekly product is not enabled."
    };
  }

  if (!req.quoteId) {
    return { status: "error", reason: "quote_not_found", message: "missing_quote_id" };
  }
  if (!Number.isFinite(req.protectedNotionalUsd) || req.protectedNotionalUsd <= 0) {
    return { status: "error", reason: "invalid_notional", message: "Notional must be a positive number." };
  }
  if (!isValidSlTier(req.slPct)) {
    return { status: "error", reason: "invalid_sl_pct", message: `SL tier ${req.slPct}% is not supported.` };
  }
  if (req.direction !== "long" && req.direction !== "short") {
    return { status: "error", reason: "invalid_direction", message: "Direction must be 'long' or 'short'." };
  }
  const tier = req.slPct as V7SlTier;

  // ── Look up the venue quote ──
  const lookup = await lookupBiweeklyQuote(pool, req.quoteId, nowMs);
  if (!lookup.ok) {
    return {
      status: "error",
      reason: lookup.reason,
      message:
        lookup.reason === "quote_not_found"
          ? "Quote not found. Refresh and try again."
          : lookup.reason === "quote_already_consumed"
          ? "Quote already used."
          : "Quote expired. Tap Refresh Quote."
    };
  }
  const vq = lookup.venueQuoteRow;
  const qDetails = vq.details;

  // Defense in depth: re-validate against the quote we issued.
  if (qDetails.product !== "biweekly") {
    return {
      status: "error",
      reason: "quote_mismatch",
      message: "Quote was not issued as biweekly. Refresh and try again."
    };
  }
  if (Number(qDetails.tier) !== tier) {
    return {
      status: "error",
      reason: "quote_mismatch",
      message: `Quote tier (${qDetails.tier}%) does not match request (${tier}%).`
    };
  }
  if (qDetails.direction !== req.direction) {
    return {
      status: "error",
      reason: "quote_mismatch",
      message: `Quote direction (${qDetails.direction}) does not match request (${req.direction}).`
    };
  }
  if (
    !Number.isFinite(Number(qDetails.protectedNotionalUsd)) ||
    Math.abs(Number(qDetails.protectedNotionalUsd) - req.protectedNotionalUsd) > 0.01
  ) {
    return {
      status: "error",
      reason: "quote_mismatch",
      message: `Quote notional ($${qDetails.protectedNotionalUsd}) does not match request ($${req.protectedNotionalUsd}).`
    };
  }

  // ── 1-trade-per-24h guard (per CEO direction 2026-04-30) ──
  let activationsLast24h: number;
  try {
    activationsLast24h = await countActivationsInLast24h(pool, userHash, nowMs);
  } catch {
    activationsLast24h = 0;
  }
  if (activationsLast24h >= 1) {
    return {
      status: "error",
      reason: "daily_trade_limit_exceeded",
      message:
        "Pilot allows only 1 protection activation per 24 hours during the biweekly ramp-up. Try again later."
    };
  }

  // ── Hedge budget cap (delegate to existing hedgeBudgetCap.ts) ──
  // Use venue quote's premium (the actual ask cost we'd pay) as the
  // projected hedge cost. The existing cap module decides whether to
  // allow.
  const projectedHedgeCostUsd = Number(vq.premium);
  const budget = await evaluateHedgeBudget(projectedHedgeCostUsd);
  if (!budget.allowed) {
    return {
      status: "error",
      reason: "hedge_budget_cap_exceeded",
      message: budget.message ?? "Pilot hedge budget reached for this phase. Please try again later.",
      details: budget.details
    };
  }

  // ── Execute on Deribit (real money) ──
  // We re-use the existing venue adapter. Build the QuoteRequest-shaped
  // object that the venue's execute() needs (it expects a VenueQuote;
  // we reconstruct from the row).
  const venueQuoteForExec = {
    venue: vq.venue as any,
    quoteId: vq.venueQuoteId,
    rfqId: vq.rfqId ?? null,
    instrumentId: vq.instrumentId,
    side: vq.side as "buy",
    quantity: Number(vq.quantity),
    premium: Number(vq.premium),
    expiresAt: vq.expiresAtIso,
    quoteTs: vq.quoteTsIso,
    details: qDetails
  };

  let execution;
  try {
    execution = await venue.execute(venueQuoteForExec as any);
  } catch (err: any) {
    return {
      status: "error",
      reason: "venue_execute_failed",
      message: `Exchange rejected the trade: ${err?.message ?? "unknown"}`
    };
  }
  if (execution.status !== "success") {
    return {
      status: "error",
      reason: "venue_execute_failed",
      message: "Exchange rejected the trade. Please refresh and try again.",
      details: execution.details ?? {}
    };
  }

  // ── Persist the new biweekly protection ──
  const ratePerDayPer1k = getBiweeklyRatePerDayPer1k(tier);
  const expiryAtIso = new Date(nowMs + BIWEEKLY_MAX_TENOR_DAYS * 86400 * 1000).toISOString();
  const triggerPriceUsd = Number(qDetails.triggerPriceUsd);
  const spotUsd = Number(qDetails.spotUsd);

  let protection: ProtectionRecord;
  try {
    protection = await insertProtection(pool, {
      userHash,
      hashVersion,
      status: "active",
      tierName: slPctToTierLabel(tier),
      drawdownFloorPct: new Decimal(tier).div(100).toFixed(6),
      slPct: tier,
      hedgeStatus: "active",
      marketId,
      protectedNotional: new Decimal(req.protectedNotionalUsd).toFixed(10),
      foxifyExposureNotional: new Decimal(req.protectedNotionalUsd).toFixed(10),
      expiryAt: expiryAtIso,
      autoRenew: false, // biweekly auto-renew semantics revisited in PR 4
      renewWindowMinutes: 1440,
      tenorDays: BIWEEKLY_MAX_TENOR_DAYS,
      dailyRateUsdPer1k: String(ratePerDayPer1k),
      metadata: {
        product: "biweekly",
        protectionType: req.direction,
        triggerPrice: triggerPriceUsd,
        floorPrice: triggerPriceUsd,
        spotAtActivation: spotUsd,
        ratePerDayPer1kUsd: ratePerDayPer1k,
        maxTenorDays: BIWEEKLY_MAX_TENOR_DAYS,
        venueQuoteId: vq.venueQuoteId,
        clientOrderId: req.clientOrderId ?? null,
        activationRequestId: `biweekly-${Date.now()}`
      }
    });
  } catch (err: any) {
    return {
      status: "error",
      reason: "storage_unavailable",
      message: "Could not persist activation. Funds were not charged.",
      details: { underlying: String(err?.message ?? "") }
    };
  }

  // ── Insert venue execution row ──
  try {
    await insertVenueExecution(pool, protection.id, execution);
  } catch {
    // Non-fatal: protection row exists; reconciliation will catch this.
    // Log only.
    console.warn(
      `[biweeklyActivate] Failed to insert venue execution for ${protection.id}; reconcile manually`
    );
  }

  // ── Patch top-level venue fields onto the protection row (2026-05-01) ──
  //
  // Bug found via CEO's first real biweekly trade (1c7e17f9, 2026-05-01):
  // insertProtection above does NOT pass venue/instrument_id/side/size/
  // execution_price/premium/executed_at/external_order_id/
  // external_execution_id, so those columns stay NULL on every biweekly
  // row. The legacy 1-day activate path DOES populate them inline (see
  // routes.ts:3926). Hedge manager + admin views read from the top-level
  // columns (NOT from pilot_venue_executions), so leaving them NULL
  // means:
  //   - hedge manager can't find the hedge → no TP runs on biweekly
  //   - admin view shows instr=None → trades look like leftover synthetics
  //   - ghost-trade-style reconciliation needed for every biweekly
  //
  // Also patch entry_price + floor_price (the trigger / floor price for
  // this trade), which legacy 1-day stores at top-level too. The
  // trigger monitor reads entry_price (or floor_price, depending on
  // path); leaving these NULL was masked because trigger monitor
  // currently falls back to metadata, but the admin views use
  // top-level so this still presents as broken.
  // 2026-05-01 — Premium semantic split for biweekly.
  //
  // Legacy 1-day product wrote `premium` = trader-charged amount and
  // hedge cost was implicit (≈ premium minus markup). PR #120 fixed the
  // missing-venue-fields bug but accidentally stamped the hedge cost
  // (execution.premium = $155.33 paid to Deribit) into the top-level
  // `premium` column, which the admin view labels as the trader charge.
  //
  // For biweekly, the two are different by design:
  //   - Trader pays: dailyRate × days_held × notional/1000 (capped at
  //     14 days = maxProjectedChargeUsd)
  //   - Platform pays Deribit: execution.premium (one-time at activation)
  //   - Platform margin: maxProjectedCharge - hedgeCost (if held to expiry)
  //
  // We stamp `premium` = max projected trader charge (the ceiling, same
  // semantic as legacy 1-day's "premium" column) so the admin view's
  // Premium / Hedge / Spread columns render correctly without unit
  // confusion. The actual running charge lives in
  // `accumulated_charge_usd` (updated on close) — admin view can read
  // both for "currently billed" vs "max ceiling" displays.
  //
  // We also stash `metadata.hedgeCostUsd` so admin views show hedge
  // cost in USD without having to know that Deribit's executionPrice
  // is BTC-denominated (multiplying by spot etc.).
  const hedgeCostUsd = Number(execution.premium);
  const maxProjectedChargeUsd = (Number(ratePerDayPer1k) * BIWEEKLY_MAX_TENOR_DAYS * Number(req.protectedNotionalUsd)) / 1000;
  const traderPremiumCeilingStr = new Decimal(maxProjectedChargeUsd).toFixed(10);
  const hedgeCostStr = new Decimal(hedgeCostUsd).toFixed(10);
  try {
    await pool.query(
      `UPDATE pilot_protections SET
         venue                 = $2,
         instrument_id         = $3,
         side                  = $4,
         size                  = $5,
         execution_price       = $6,
         premium               = $7,
         executed_at           = $8::timestamptz,
         external_order_id     = $9,
         external_execution_id = $10,
         entry_price           = $11,
         floor_price           = $12,
         updated_at            = NOW()
       WHERE id = $1`,
      [
        protection.id,
        execution.venue,
        execution.instrumentId,
        execution.side,
        new Decimal(execution.quantity).toFixed(10),
        new Decimal(execution.executionPrice).toFixed(10),
        traderPremiumCeilingStr,
        execution.executedAt,
        execution.externalOrderId,
        execution.externalExecutionId,
        new Decimal(spotUsd).toFixed(10),
        new Decimal(triggerPriceUsd).toFixed(10)
      ]
    );
    // Stamp hedge cost + max projected charge in metadata for admin
    // displays. Read-merge-write pattern (pg-mem doesn't support
    // jsonb_build_object — see PR #119 synthetic flag test).
    try {
      const r = await pool.query(`SELECT metadata FROM pilot_protections WHERE id = $1`, [protection.id]);
      const merged = {
        ...((r.rows[0]?.metadata as any) || {}),
        hedgeCostUsd,
        maxProjectedChargeUsd,
        traderPremiumCeilingUsd: maxProjectedChargeUsd
      };
      await pool.query(`UPDATE pilot_protections SET metadata = $2::jsonb WHERE id = $1`, [
        protection.id,
        JSON.stringify(merged)
      ]);
      protection.metadata = merged;
    } catch (mdErr: any) {
      console.warn(
        `[biweeklyActivate] Failed to stamp hedgeCostUsd metadata on ${protection.id}: ${mdErr?.message ?? "unknown"}`
      );
    }
    // Reflect on the in-memory record we return so the caller (routes
    // → trader) sees the full hydrated shape immediately.
    protection.venue = execution.venue;
    protection.instrumentId = execution.instrumentId;
    protection.side = execution.side;
    protection.size = new Decimal(execution.quantity).toFixed(10);
    protection.executionPrice = new Decimal(execution.executionPrice).toFixed(10);
    protection.premium = traderPremiumCeilingStr;
    protection.executedAt = execution.executedAt;
    protection.externalOrderId = execution.externalOrderId;
    protection.externalExecutionId = execution.externalExecutionId;
    protection.entryPrice = new Decimal(spotUsd).toFixed(10);
    protection.floorPrice = new Decimal(triggerPriceUsd).toFixed(10);
  } catch (err: any) {
    // Don't roll back the activate. The trade is already filled on
    // Deribit and the row + execution row exist. A reconcile-orphan
    // call can backfill the venue fields later.
    console.warn(
      `[biweeklyActivate] Failed to patch top-level venue fields on ${protection.id}: ${err?.message ?? "unknown"}. ` +
        `Trade IS live on Deribit (${execution.instrumentId}). Use /pilot/admin/protections/:id/reconcile-orphan-hedge to backfill.`
    );
  }

  // ── Insert subscription_started ledger entry (no upfront premium) ──
  try {
    await insertLedgerEntry(pool, {
      protectionId: protection.id,
      entryType: "subscription_started",
      // Amount = 0 for the start event; final settlement on close
      // writes the actual accumulated charge as
      // subscription_close_settlement.
      amount: "0",
      reference: `biweekly_quote:${vq.venueQuoteId}`
    });
  } catch {
    console.warn(
      `[biweeklyActivate] Failed to insert subscription_started ledger for ${protection.id}`
    );
  }

  // ── Mark venue quote consumed ──
  try {
    await pool.query(
      `UPDATE pilot_venue_quotes
       SET consumed_at = NOW(), consumed_by_protection_id = $1
       WHERE quote_id = $2`,
      [protection.id, vq.venueQuoteId]
    );
  } catch {
    console.warn(
      `[biweeklyActivate] Failed to mark quote consumed for ${vq.venueQuoteId}; reconcile manually`
    );
  }

  return { status: "ok", product: "biweekly", protection };
};
