/**
 * Foxify-facing read-mostly dashboard endpoints.
 *
 * Mounted at /volume-cover/foxify/*. All endpoints require an
 * X-Foxify-Token header that matches the FOXIFY_DASHBOARD_TOKEN env
 * var (constant-time compared). Token is DISTINCT from
 * PILOT_ADMIN_TOKEN so a Foxify-side leak cannot affect operational
 * controls (HALT, cell toggles, salvage stats, hedge legs, etc.).
 *
 * Hard rules:
 *   1. EXPLICIT field whitelist on every response. New internal
 *      fields added to positions / events are NEVER auto-exposed.
 *   2. NO hedge leg data, NO salvage stats, NO regime classifier,
 *      NO latency timings, NO internal pricing config — only the
 *      Foxify-relevant view of activity + status.
 *   3. Every authenticated access is logged to volume_cover_foxify_access
 *      (audit table) for forensics + leak detection.
 *
 * Endpoints (all require X-Foxify-Token):
 *   GET  /volume-cover/foxify/status      — spot, service, today's counters
 *   GET  /volume-cover/foxify/positions   — active positions (whitelisted fields)
 *   GET  /volume-cover/foxify/today       — UTC-day activity summary
 *   GET  /volume-cover/foxify/recent      — last N activations (audit log)
 *   POST /volume-cover/foxify/positions/:id/close — early close
 *
 * Admin-only audit query (X-Admin-Token):
 *   GET  /volume-cover/admin/foxify-access-log?limit=100
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

import { pilotConfig } from "../pilot/config";
import { getPilotPool } from "../pilot/db";
import {
  getPosition,
  listActivePositions,
  listCells,
  listLiveFoxifyPositions,
  listRecentPairEvents
} from "./volumeCoverDb";
import { closePosition } from "./positionLifecycle";
import type { HedgeExecutor } from "./tightHedge";
import type { SpotPriceSource } from "./triggerDetector";

// ────────────────────── Test-position exclusion ──────────────────────
//
// Positions opened via /volume-cover/admin/test-activate are tagged with
// metadata.source = 'admin_test_activate' so the Foxify-facing dashboard
// can suppress them. Production traffic from Foxify is tagged
// metadata.source = 'foxify_api' (see volumeCoverRoutes.ts).
//
// SQL fragment is composable: takes the WHERE-clause prefix (e.g. " AND "
// for chaining onto an existing WHERE, or " WHERE " for the first clause).
// We keep NULL through-paths benign so positions opened before the tag
// was introduced still render (pre-tag positions are pre-existing only;
// new traffic always sets the tag).
const HIDE_ADMIN_TEST_POSITIONS_SQL =
  "(metadata->>'source' IS NULL OR metadata->>'source' <> 'admin_test_activate')";

// ────────────────────── Auth ──────────────────────

const resolveFoxifyToken = (): string => {
  return String(process.env.FOXIFY_DASHBOARD_TOKEN || "").trim();
};

const isFoxifyDashboardAuthorized = (req: FastifyRequest): boolean => {
  const expected = resolveFoxifyToken();
  if (!expected) return false; // unset → reject all (fail-closed)
  const token = String(req.headers["x-foxify-token"] || "").trim();
  if (!token || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
};

const resolveAdminToken = (): string => {
  return process.env.PILOT_ADMIN_TOKEN || pilotConfig.adminToken || "";
};

const isAdminAuthorized = (req: FastifyRequest): boolean => {
  const expected = resolveAdminToken();
  if (!expected) return false;
  const token = String(req.headers["x-admin-token"] || "");
  if (!token || token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
};

// ────────────────────── Audit table ──────────────────────

const ensureFoxifyAccessSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS volume_cover_foxify_access (
      id BIGSERIAL PRIMARY KEY,
      accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      success BOOLEAN NOT NULL,
      reject_reason TEXT
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_vc_foxify_access_accessed
      ON volume_cover_foxify_access (accessed_at DESC);
  `);
};

const logFoxifyAccess = async (
  pool: Pool,
  req: FastifyRequest,
  success: boolean,
  rejectReason?: string
): Promise<void> => {
  try {
    const ip = String(
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
        req.ip ||
        ""
    );
    const ua = String(req.headers["user-agent"] || "");
    await pool.query(
      `INSERT INTO volume_cover_foxify_access
         (method, endpoint, ip, user_agent, success, reject_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.method.toUpperCase(),
        req.url.split("?")[0],
        ip || null,
        ua || null,
        success,
        rejectReason ?? null
      ]
    );
  } catch (err) {
    // Audit log is best-effort. Never fail the request because audit
    // insert failed; just log to console.
    console.warn(`[FoxifyAudit] log insert failed: ${(err as Error).message}`);
  }
};

// ────────────────────── Field whitelist (positions) ──────────────────────

/**
 * Foxify-safe projection of a position. Excludes internal fields:
 *   - dailyPremiumUsdc (this is OUR pricing, not what they paid)
 *     ← actually IS what they paid; include it
 *   - pairLongNotionalUsdc / pairShortNotionalUsdc (their data; include)
 *   - metadata (may contain internal flags; EXCLUDE)
 *   - fingerprintHash (internal anti-bot; EXCLUDE)
 *   - closeReason (may include internal reasoning; EXCLUDE)
 *   - hedge legs (EXCLUDE entirely)
 *
 * If unsure → exclude. Whitelist beats blacklist.
 */
const projectPositionForFoxify = (p: {
  id: string;
  cellId: string;
  foxifyPairId: string;
  status: string;
  pairLongNotionalUsdc: number;
  pairShortNotionalUsdc: number;
  pairEntryBtcPrice: number;
  triggerHighBtc: number;
  triggerLowBtc: number;
  dailyPremiumUsdc: number;
  payoutUsdc: number;
  openedAt: string;
  triggeredAt: string | null;
  triggeredDirection: string | null;
  closedAt: string | null;
}) => {
  // Normalize timestamps to true ISO 8601 (the upstream rowToPosition
  // does String(Date) which can produce human-readable form on some
  // pg driver versions; force ISO here for Foxify consumers).
  const iso = (v: string | null): string | null => {
    if (!v) return null;
    try {
      return new Date(v).toISOString();
    } catch {
      return v;
    }
  };
  // 2026-05-22 (two-step fix). Step 1: stopped sending per-day rate as
  // `premiumPaidUsdc` (Foxify dash read it as paid → "$0 owed"). Step 2:
  // switched headline to BILLABLE (Foxify's per-day round-up contract rule).
  // For a position active any portion of N UTC days, billable = N × dailyRate
  // — matching weeklyReconciler.daysActiveInWindow. Hourly accrual still
  // exposed via premiumAccruedUsdc for smooth real-time UIs.
  const openedAtIso = iso(p.openedAt) ?? p.openedAt;
  const closedAtIso = iso(p.closedAt);
  // 2026-05-24 (PR-E): cap accrual at trigger time. fireTrigger writes the
  // capped premium_in to the ledger; the dashboard projection must match or
  // we display amounts higher than what was actually billed (the May 22-24
  // dash-pollution incident — two stuck-in-triggered positions over-displayed
  // by ~2× until they were archived).
  const triggeredAtIso = iso(p.triggeredAt);
  const accruedSinceOpen = premiumAccruedSinceOpenUsdc({
    openedAtIso,
    closedAtIso,
    triggeredAtIso,
    dailyRateUsdc: p.dailyPremiumUsdc
  });
  const billableSinceOpen = premiumBillableSinceOpenUsdc({
    openedAtIso,
    closedAtIso,
    triggeredAtIso,
    dailyRateUsdc: p.dailyPremiumUsdc
  });

  return {
    id: p.id,
    cellId: p.cellId,
    foxifyPairId: p.foxifyPairId,
    status: p.status,
    pairLongNotionalUsdc: p.pairLongNotionalUsdc,
    pairShortNotionalUsdc: p.pairShortNotionalUsdc,
    pairEntryBtcPrice: p.pairEntryBtcPrice,
    triggerHighBtc: p.triggerHighBtc,
    triggerLowBtc: p.triggerLowBtc,
    // ─── Premium (2026-05-22 fix v2) ───
    // premiumPaidUsdc = CONTRACT BILLABLE cumulative since open (per-day
    // round-up). For a position active any portion of N UTC days, value is
    // N × dailyRate. This is what Foxify owes per the billing contract.
    premiumPaidUsdc: Number(billableSinceOpen.toFixed(2)),
    premiumBillableUsdc: Number(billableSinceOpen.toFixed(2)),
    // Hourly precision since open — for smooth real-time UIs that want
    // a number that updates by the second rather than jumping at midnight.
    premiumAccruedUsdc: Number(accruedSinceOpen.toFixed(2)),
    dailyRateUsdc: p.dailyPremiumUsdc,
    payoutUsdc: p.payoutUsdc,
    openedAtIso,
    triggeredAtIso,
    triggeredDirection: p.triggeredDirection,
    closedAtIso
  };
};

/** Foxify-safe projection of a pair event. */
const projectPairEventForFoxify = (e: {
  foxifyPairId: string;
  cellId: string;
  result: string;
  rejectReason: string | null;
  positionId: string | null;
  receivedAtIso: string;
  totalLatencyMs: number;
}) => ({
  foxifyPairId: e.foxifyPairId,
  cellId: e.cellId,
  result: e.result,
  rejectReason: e.rejectReason,
  positionId: e.positionId,
  atIso: e.receivedAtIso,
  // Round latency to nearest 10ms (less internal-looking, still informative)
  latencyMs: Math.round(e.totalLatencyMs / 10) * 10
});

// ────────────────────── UTC day helpers ──────────────────────

const startOfTodayUtcIso = (): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

const endOfTodayUtcIso = (): string => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

// ────────────────────── Premium accrual ──────────────────────
//
// 2026-05-22: TWO premium views must be supported simultaneously:
//
//   1. ACCRUED (hourly precision) — for real-time UI display that updates
//      smoothly as time passes. e.g., at Fri 23:54 UTC of a position active
//      since Thu 12:13 UTC at $210/d:
//        Lifetime accrued = 35.7h × $210/24h = $312.40
//
//   2. BILLABLE (per-day round-up) — Foxify's contractual billing rule.
//      Any portion of a UTC day counts as a full day. weeklyReconciler.ts
//      uses this rule (daysActiveInWindow ceil()). Settlement-authoritative.
//      Same position at same time:
//        Thu = ceil(11.78h/24) = 1 day → $210
//        Fri = ceil(23.9h/24) = 1 day  → $210
//        Lifetime billable = $420
//
// Foxify dashboard "owed" is the BILLABLE amount — that's what the contract
// says they owe us. Accrued is informational.
//
// 2026-05-22 (later): /foxify/today previously sent only today's hourly
// window which displayed $209 and hid yesterday's $210. Now exposes both
// today-only AND lifetime fields, and renames headline `premiumPaidUsdc`
// to reflect lifetime billable (contract owed).
export const premiumAccruedInWindowUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  // 2026-05-24 (PR-E): premium accrual stops at trigger per the contract
  // (matches what fireTrigger writes to ledger via the daysHeld cap). For a
  // position stuck in `status='triggered'` the projection function used to
  // re-extend accrual to (now − openedAt) which over-displayed premium by
  // (now − triggeredAt) × dailyRate. Pass the row's triggered_at here and the
  // effective right edge becomes min(triggered_at, closed_at, now).
  triggeredAtIso?: string | null;
  windowStartIso: string;
  windowEndIso: string;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  const openedMs = new Date(params.openedAtIso).getTime();
  const fallbackEndMs = params.nowMs ?? Date.now();
  const closedMs = params.closedAtIso
    ? new Date(params.closedAtIso).getTime()
    : fallbackEndMs;
  const triggeredMs = params.triggeredAtIso
    ? new Date(params.triggeredAtIso).getTime()
    : Number.POSITIVE_INFINITY;
  const effectiveCloseMs = Math.min(closedMs, triggeredMs);
  const winStartMs = new Date(params.windowStartIso).getTime();
  const winEndMs = new Date(params.windowEndIso).getTime();
  const overlapStart = Math.max(openedMs, winStartMs);
  const overlapEnd = Math.min(effectiveCloseMs, winEndMs);
  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs <= 0 || params.dailyRateUsdc <= 0) return 0;
  const overlapHours = overlapMs / 3_600_000;
  return (overlapHours / 24) * params.dailyRateUsdc;
};

/**
 * Billable amount over a window using Foxify's per-day round-up rule:
 * ceil(overlap_hours/24) × dailyRate. Matches weeklyReconciler.daysActiveInWindow
 * which is the authoritative settlement formula. Use this for "premium owed"
 * displays that must match contractual billing.
 *
 * 2026-05-24 (PR-E): also caps at triggered_at when supplied — see
 * premiumAccruedInWindowUsdc for the full rationale.
 */
export const premiumBillableInWindowUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  triggeredAtIso?: string | null;
  windowStartIso: string;
  windowEndIso: string;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  const openedMs = new Date(params.openedAtIso).getTime();
  const fallbackEndMs = params.nowMs ?? Date.now();
  const closedMs = params.closedAtIso
    ? new Date(params.closedAtIso).getTime()
    : fallbackEndMs;
  const triggeredMs = params.triggeredAtIso
    ? new Date(params.triggeredAtIso).getTime()
    : Number.POSITIVE_INFINITY;
  const effectiveCloseMs = Math.min(closedMs, triggeredMs);
  const winStartMs = new Date(params.windowStartIso).getTime();
  const winEndMs = new Date(params.windowEndIso).getTime();
  const overlapStart = Math.max(openedMs, winStartMs);
  const overlapEnd = Math.min(effectiveCloseMs, winEndMs);
  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs <= 0 || params.dailyRateUsdc <= 0) return 0;
  const billableDays = Math.ceil(overlapMs / 86_400_000);
  return billableDays * params.dailyRateUsdc;
};

// Convenience: cumulative accrued since open (open-ended right side = now)
//
// 2026-05-24 (PR-E): triggeredAtIso added so triggered positions stop accruing
// at trigger time (contract-aligned). The in-window helper internally caps at
// min(triggered_at, closed_at, now); we just thread the value through here.
const premiumAccruedSinceOpenUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  triggeredAtIso?: string | null;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  return premiumAccruedInWindowUsdc({
    openedAtIso: params.openedAtIso,
    closedAtIso: params.closedAtIso,
    triggeredAtIso: params.triggeredAtIso,
    // Use opened-at as window start and now/closed as end → just hours-active × rate.
    // The in-window helper caps at min(closed,triggered,now) regardless.
    windowStartIso: params.openedAtIso,
    windowEndIso: params.closedAtIso ?? new Date(params.nowMs ?? Date.now()).toISOString(),
    dailyRateUsdc: params.dailyRateUsdc,
    nowMs: params.nowMs
  });
};

// Convenience: cumulative BILLABLE since open (per-day round-up rule).
// This is the Foxify-contractual "amount owed" headline number.
//
// 2026-05-24 (PR-E): see premiumAccruedSinceOpenUsdc for triggered_at rationale.
const premiumBillableSinceOpenUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  triggeredAtIso?: string | null;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  return premiumBillableInWindowUsdc({
    openedAtIso: params.openedAtIso,
    closedAtIso: params.closedAtIso,
    triggeredAtIso: params.triggeredAtIso,
    windowStartIso: params.openedAtIso,
    windowEndIso: params.closedAtIso ?? new Date(params.nowMs ?? Date.now()).toISOString(),
    dailyRateUsdc: params.dailyRateUsdc,
    nowMs: params.nowMs
  });
};

// ────────────────────── Registration ──────────────────────

export type RegisterFoxifyDashboardOptions = {
  pool?: Pool;
  hedgeExecutor: HedgeExecutor;
  spotSource: SpotPriceSource;
  /** Skip schema migration (tests provide pre-migrated pool). */
  skipSchema?: boolean;
};

export const registerFoxifyDashboardRoutes = async (
  app: FastifyInstance,
  opts: RegisterFoxifyDashboardOptions
): Promise<void> => {
  const pool = opts.pool ?? getPilotPool(pilotConfig.postgresUrl ?? "");

  if (!opts.skipSchema) {
    await ensureFoxifyAccessSchema(pool);
  }

  // ─── Status ───────────────────────────────────────────────

  app.get("/volume-cover/foxify/status", async (req, reply) => {
    if (!isFoxifyDashboardAuthorized(req)) {
      await logFoxifyAccess(pool, req, false, "invalid_token");
      return reply.code(401).send({ error: "unauthorized" });
    }
    await logFoxifyAccess(pool, req, true);

    // Spot — Foxify needs Atticus spot as source-of-truth across
    // their multi-exchange perp positions. This is the canonical
    // price we use for trigger evaluation.
    let spot: { spotBtcUsdc: number | null; source: string | null } = {
      spotBtcUsdc: null,
      source: null
    };
    try {
      const s = await opts.spotSource();
      spot = { spotBtcUsdc: s.spotBtcPrice, source: s.source };
    } catch {
      // best-effort
    }

    // Activity today (across all cells — there is one Foxify tenant
    // in the pilot, so all activity is theirs).
    const since = startOfTodayUtcIso();
    const todayResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM volume_cover_position
       WHERE opened_at >= $1
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}`,
      [since]
    );
    const todayActivations = Number(todayResult.rows[0]?.cnt ?? 0);

    // 2026-05-23: changed semantic from status='active' only to live
    // (active + triggered). A triggered position is still a protection
    // on the books until pair-close (it accrues premium and will pay
    // out at settlement). Matches what /foxify/positions returns and
    // what the operator sees in the table, so the status-strip count
    // no longer disagrees with the table row count.
    const activeResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM volume_cover_position
       WHERE status IN ('active', 'triggered')
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`
    );
    const activeCount = Number(activeResult.rows[0]?.cnt ?? 0);

    // Sum daily throttle across enabled cells (informational)
    const cells = await listCells(pool);
    const enabledCells = cells.filter((c) => c.enabled);
    const dailyThrottle = enabledCells.reduce(
      (sum, c) => sum + c.throttleMaxPerDay,
      0
    );

    return reply.send({
      service: "operational",
      spotBtcUsdc: spot.spotBtcUsdc,
      spotSource: spot.source,
      activeCount,
      todayActivations,
      dailyThrottle,
      dailyRemainingActivations: Math.max(0, dailyThrottle - todayActivations),
      generatedAtIso: new Date().toISOString()
    });
  });

  // ─── Active positions ─────────────────────────────────────

  app.get("/volume-cover/foxify/positions", async (req, reply) => {
    if (!isFoxifyDashboardAuthorized(req)) {
      await logFoxifyAccess(pool, req, false, "invalid_token");
      return reply.code(401).send({ error: "unauthorized" });
    }
    await logFoxifyAccess(pool, req, true);

    // 2026-05-22 fix: was listActivePositions (status='active' only) which
    // hid TRIGGERED positions even though they remain on the books
    // accruing premium until the Foxify pair's scheduled close. Switched
    // to listLiveFoxifyPositions which returns status IN (active, triggered)
    // sorted by opened_at. Closed positions remain hidden (correct).
    const positions = await listLiveFoxifyPositions(pool);
    // Hide admin/operator test positions from Foxify view (see
    // HIDE_ADMIN_TEST_POSITIONS_SQL for the canonical filter rule).
    // Also hide explicitly-archived positions (metadata.archived=true).
    const foxifyVisible = positions.filter((p) => {
      const meta = (p.metadata as any) ?? {};
      if (meta.source === "admin_test_activate") return false;
      if (meta.archived === true) return false;
      return true;
    });
    return reply.send({
      positions: foxifyVisible.map(projectPositionForFoxify),
      generatedAtIso: new Date().toISOString()
    });
  });

  // ─── Today's summary ──────────────────────────────────────

  app.get("/volume-cover/foxify/today", async (req, reply) => {
    if (!isFoxifyDashboardAuthorized(req)) {
      await logFoxifyAccess(pool, req, false, "invalid_token");
      return reply.code(401).send({ error: "unauthorized" });
    }
    await logFoxifyAccess(pool, req, true);

    const dayStart = startOfTodayUtcIso();
    const dayEnd = endOfTodayUtcIso();

    // Activations today (count of positions OPENED today). Premium
    // calculation moved below — previously this query SUM'd daily_premium_usdc
    // for positions opened today, which is the daily-RATE sum, not actual
    // accrued. We now compute hourly-precision accrued premium across all
    // positions whose activity window overlaps today.
    const openedResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM volume_cover_position
       WHERE opened_at >= $1 AND opened_at < $2
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}`,
      [dayStart, dayEnd]
    );
    const activationsToday = Number(openedResult.rows[0]?.cnt ?? 0);

    // 2026-05-22 fix (v2). Four premium aggregates exposed:
    //
    //   premiumBillableTodayUsdc   = today's window × per-day round-up rule.
    //                                Matches the contract — any portion of
    //                                today = 1 full day per active position.
    //   premiumAccruedTodayUsdc    = today's window × hourly precision.
    //                                Useful for real-time UIs.
    //   premiumBillableLifetimeUsdc = cumulative across all LIVE (active +
    //                                triggered, not archived) positions
    //                                from each position's open through now,
    //                                per-day round-up rule. THIS IS THE
    //                                FOXIFY "AMOUNT OWED" HEADLINE.
    //   premiumAccruedLifetimeUsdc = same scope, hourly precision.
    //
    // Earlier `premiumPaidUsdc` semantics ("today's hourly") hid yesterday's
    // accrual entirely from a Foxify dashboard that displayed only today,
    // which is why the dash showed "$0 yesterday $209 today" instead of the
    // contractual $210 + $210 = $420 owed so far. Headline now reflects
    // contract.
    // 2026-05-24 (PR-E): SELECT triggered_at so the per-row premium calc can
    // cap accrual at trigger time (matches the ledger). Without this, a
    // position triggered late yesterday but stuck in `triggered` status will
    // continue to add today-window premium that was never billed at fireTrigger.
    const todayResult = await pool.query(
      `SELECT id, opened_at, closed_at, triggered_at, daily_premium_usdc
       FROM volume_cover_position
       WHERE opened_at < $2
         AND (closed_at IS NULL OR closed_at >= $1)
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`,
      [dayStart, dayEnd]
    );

    let premiumBillableTodayUsdc = 0;
    let premiumAccruedTodayUsdc = 0;
    for (const row of todayResult.rows) {
      const args = {
        openedAtIso: String(row.opened_at),
        closedAtIso: row.closed_at ? String(row.closed_at) : null,
        triggeredAtIso: row.triggered_at ? String(row.triggered_at) : null,
        windowStartIso: dayStart,
        windowEndIso: dayEnd,
        dailyRateUsdc: Number(row.daily_premium_usdc)
      };
      premiumBillableTodayUsdc += premiumBillableInWindowUsdc(args);
      premiumAccruedTodayUsdc += premiumAccruedInWindowUsdc(args);
    }

    // Lifetime: every position currently on the books (active or triggered,
    // not archived, not admin-test). Premium accrues from open until close.
    // Closed positions excluded — they are settled separately by the weekly
    // reconciler and should not duplicate-display in the "owed now" view.
    // 2026-05-24 (PR-E): SELECT triggered_at and pass into the per-row premium
    // helpers so triggered positions stop accruing here too. This is the
    // headline "Premium Paid (lifetime)" number on the Foxify dashboard, which
    // pre-fix displayed up to 2× the contractually-billed amount when Foxify's
    // bot left positions stuck in `triggered` status (the May 22-24 incident).
    const lifetimeResult = await pool.query(
      `SELECT id, opened_at, closed_at, triggered_at, daily_premium_usdc
       FROM volume_cover_position
       WHERE status IN ('active', 'triggered')
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`
    );

    let premiumBillableLifetimeUsdc = 0;
    let premiumAccruedLifetimeUsdc = 0;
    for (const row of lifetimeResult.rows) {
      const triggeredAtIso = row.triggered_at ? String(row.triggered_at) : null;
      premiumBillableLifetimeUsdc += premiumBillableSinceOpenUsdc({
        openedAtIso: String(row.opened_at),
        closedAtIso: row.closed_at ? String(row.closed_at) : null,
        triggeredAtIso,
        dailyRateUsdc: Number(row.daily_premium_usdc)
      });
      premiumAccruedLifetimeUsdc += premiumAccruedSinceOpenUsdc({
        openedAtIso: String(row.opened_at),
        closedAtIso: row.closed_at ? String(row.closed_at) : null,
        triggeredAtIso,
        dailyRateUsdc: Number(row.daily_premium_usdc)
      });
    }

    // premiumBilledToday kept as a local for the foxifyNetUsdc calc below;
    // historical name preserved to keep that diff small. Semantically it's
    // now "today's billable (contract)" which is what matters for net P&L.
    const premiumBilledToday = premiumBillableTodayUsdc;

    // Triggers + payouts. Two scopes reported (parallel to premium):
    //
    //   payoutsReceivedTodayUsdc = positions triggered IN TODAY's UTC window.
    //                              Realized only — empty after UTC midnight
    //                              rolls a previously-triggered position into
    //                              "yesterday".
    //
    //   payoutExpectedUsdc        = sum of payout_usdc across ALL LIVE
    //                              (active + triggered, non-archived,
    //                              non-admin-test) positions. The "what
    //                              Foxify is expecting to receive" view:
    //                              triggered → guaranteed at pair-close,
    //                              active   → if-trigger-fires exposure.
    //                              This is the field the headline should
    //                              bind to so it never vanishes at midnight.
    //
    // Excludes admin-test positions and archived positions for both scopes.
    const triggeredResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(payout_usdc), 0)::numeric AS payout_sum
       FROM volume_cover_position
       WHERE triggered_at >= $1 AND triggered_at < $2
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`,
      [dayStart, dayEnd]
    );
    const triggeredToday = Number(triggeredResult.rows[0]?.cnt ?? 0);
    const payoutsReceivedToday = Number(triggeredResult.rows[0]?.payout_sum ?? 0);

    // Lifetime expected payout + live counts across all currently-live
    // positions. Same scope as the lifetime premium aggregation above.
    const livePayoutResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'triggered')::int AS count_triggered,
         COUNT(*) FILTER (WHERE status = 'active')::int    AS count_active,
         COUNT(*)::int                                     AS count_total,
         COALESCE(SUM(CASE WHEN status = 'triggered' THEN payout_usdc END), 0)::numeric AS payout_triggered,
         COALESCE(SUM(CASE WHEN status = 'active'    THEN payout_usdc END), 0)::numeric AS payout_active,
         COALESCE(SUM(payout_usdc), 0)::numeric                                        AS payout_total
       FROM volume_cover_position
       WHERE status IN ('active', 'triggered')
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`
    );
    const liveTriggeredCount = Number(livePayoutResult.rows[0]?.count_triggered ?? 0);
    const liveActiveCount = Number(livePayoutResult.rows[0]?.count_active ?? 0);
    const liveTotalCount = Number(livePayoutResult.rows[0]?.count_total ?? 0);
    const payoutOwedTriggeredUsdc = Number(livePayoutResult.rows[0]?.payout_triggered ?? 0);
    const payoutPotentialActiveUsdc = Number(livePayoutResult.rows[0]?.payout_active ?? 0);
    const payoutExpectedUsdc = Number(livePayoutResult.rows[0]?.payout_total ?? 0);

    // Closes today (any reason)
    const closedResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_cnt,
         COUNT(*) FILTER (WHERE status = 'triggered' AND closed_at IS NOT NULL)::int AS expired_cnt
       FROM volume_cover_position
       WHERE closed_at >= $1 AND closed_at < $2
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}`,
      [dayStart, dayEnd]
    );
    const closedEarlyToday = Number(closedResult.rows[0]?.closed_cnt ?? 0);
    const expiredUnusedToday = Number(closedResult.rows[0]?.expired_cnt ?? 0);

    // Foxify-side net.
    //
    // 2026-05-23 fix: switched from TODAY's window to LIFETIME so the
    // figure reflects the actual net Foxify is sitting on. Prior calc
    // (payoutsReceivedToday - premiumBilledToday) misled the operator
    // after UTC midnight rolled the trigger into "yesterday": Foxify
    // is genuinely +$180 ahead ($600 payout expected − $420 premium
    // billable) but the dashboard read −$210 ($0 payouts received
    // today − $210 billable today). Lifetime view aligns with the
    // headline premium/payout fields above.
    //
    // For an operator-facing "today's flow only" view we keep
    // foxifyNetTodayUsdc as an explicit secondary field.
    const foxifyNetUsdc = payoutExpectedUsdc - premiumBillableLifetimeUsdc;
    const foxifyNetTodayUsdc = payoutsReceivedToday - premiumBilledToday;

    return reply.send({
      reportDate: new Date().toISOString().slice(0, 10),
      activationsToday,
      // 2026-05-23: triggeredToday is the count of pair-trigger EVENTS
      // that fired in today's UTC window. Kept for back-compat. The
      // new liveTriggeredCount is what the dashboard headline binds to
      // — count of positions currently on the books in status='triggered'.
      // That number doesn't vanish at UTC midnight.
      triggeredToday,
      liveTriggeredCount,
      liveActiveCount,
      liveTotalCount,
      closedEarlyToday,
      expiredUnusedToday,
      // ─── Premium fields (2026-05-22 fix v2) ───
      // HEADLINE: lifetime billable across all live positions, per Foxify's
      // per-day round-up billing rule. This is the "amount owed" number.
      // Replaces the prior today-only-hourly semantic that hid yesterday's
      // accrual from a dashboard that displayed only this field.
      premiumPaidUsdc: Number(premiumBillableLifetimeUsdc.toFixed(2)),
      // Explicit aliases for each of the four premium views:
      premiumBillableLifetimeUsdc: Number(premiumBillableLifetimeUsdc.toFixed(2)),
      premiumAccruedLifetimeUsdc: Number(premiumAccruedLifetimeUsdc.toFixed(2)),
      premiumBillableTodayUsdc: Number(premiumBillableTodayUsdc.toFixed(2)),
      premiumAccruedTodayUsdc: Number(premiumAccruedTodayUsdc.toFixed(2)),
      // ─── Payout fields (2026-05-23 fix) ───
      // HEADLINE: lifetime payout exposure across all live positions.
      // This is what Foxify is "expecting to receive" — guaranteed
      // for triggered (paid at pair-close) plus potential for active
      // (paid if a trigger fires). Won't vanish at UTC midnight.
      payoutExpectedUsdc: Number(payoutExpectedUsdc.toFixed(2)),
      // Granular splits:
      payoutOwedTriggeredUsdc: Number(payoutOwedTriggeredUsdc.toFixed(2)),
      payoutPotentialActiveUsdc: Number(payoutPotentialActiveUsdc.toFixed(2)),
      // Legacy: realized today only (still useful but disappears at midnight).
      payoutsReceivedUsdc: Number(payoutsReceivedToday.toFixed(2)),
      // foxifyNetUsdc is now LIFETIME (payoutExpected − premiumBillableLifetime).
      // The today-only flavour is exposed explicitly below for operators
      // who want a daily-flow view.
      foxifyNetUsdc: Number(foxifyNetUsdc.toFixed(2)),
      foxifyNetTodayUsdc: Number(foxifyNetTodayUsdc.toFixed(2)),
      generatedAtIso: new Date().toISOString()
    });
  });

  // ─── Recent activity log ──────────────────────────────────

  app.get("/volume-cover/foxify/recent", async (req, reply) => {
    if (!isFoxifyDashboardAuthorized(req)) {
      await logFoxifyAccess(pool, req, false, "invalid_token");
      return reply.code(401).send({ error: "unauthorized" });
    }
    await logFoxifyAccess(pool, req, true);

    const limitRaw = Number((req.query as any)?.limit ?? 20);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50 ? limitRaw : 20;

    const events = await listRecentPairEvents(pool, limit);
    return reply.send({
      events: events.map(projectPairEventForFoxify),
      generatedAtIso: new Date().toISOString()
    });
  });

  // ─── Early close ──────────────────────────────────────────

  const CloseSchema = z.object({
    reason: z.string().max(256).optional()
  });

  app.post(
    "/volume-cover/foxify/positions/:id/close",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isFoxifyDashboardAuthorized(req)) {
        await logFoxifyAccess(pool, req, false, "invalid_token");
        return reply.code(401).send({ error: "unauthorized" });
      }
      await logFoxifyAccess(pool, req, true);

      const id = String((req.params as any).id ?? "");
      if (!id) {
        return reply.code(400).send({ error: "missing_position_id" });
      }
      const parse = CloseSchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", issues: parse.error.issues });
      }
      const position = await getPosition(pool, id);
      if (!position) {
        return reply.code(404).send({ error: "position_not_found" });
      }
      if (position.status !== "active") {
        return reply
          .code(409)
          .send({ error: "position_not_active", currentStatus: position.status });
      }
      try {
        await closePosition(pool, opts.hedgeExecutor, {
          position,
          reason: `foxify_dashboard_close: ${parse.data.reason ?? "user_initiated"}`
        });
        return reply.send({
          positionId: id,
          status: "closed",
          closedAtIso: new Date().toISOString()
        });
      } catch (err) {
        req.log.error(
          `[volume-cover/foxify/close] failed: ${(err as Error).message}`
        );
        return reply.code(500).send({
          error: "close_failed",
          message: (err as Error).message
        });
      }
    }
  );

  // ─── Admin: query the audit log ───────────────────────────

  app.get("/volume-cover/admin/foxify-access-log", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const limitRaw = Number((req.query as any)?.limit ?? 100);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
    const result = await pool.query(
      `SELECT id, accessed_at, method, endpoint, ip, user_agent, success, reject_reason
       FROM volume_cover_foxify_access
       ORDER BY accessed_at DESC
       LIMIT $1`,
      [limit]
    );
    return reply.send({
      events: result.rows.map((r) => ({
        id: String(r.id),
        accessedAtIso: r.accessed_at instanceof Date ? r.accessed_at.toISOString() : String(r.accessed_at),
        method: String(r.method),
        endpoint: String(r.endpoint),
        ip: r.ip ? String(r.ip) : null,
        userAgent: r.user_agent ? String(r.user_agent) : null,
        success: Boolean(r.success),
        rejectReason: r.reject_reason ? String(r.reject_reason) : null
      }))
    });
  });
};
