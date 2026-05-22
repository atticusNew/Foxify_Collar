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
  // 2026-05-22 fix: premiumPaidUsdc was previously sent as the per-day RATE
  // (p.dailyPremiumUsdc), which Foxify reasonably interpreted as already-paid
  // (rate × 1 day) → "no premium owed". Real meaning is cumulative accrued
  // since open. Hourly precision so it updates smoothly. The daily rate is
  // still exposed via the new dailyRateUsdc field for explicit display.
  const accruedSinceOpen = premiumAccruedSinceOpenUsdc({
    openedAtIso: iso(p.openedAt) ?? p.openedAt,
    closedAtIso: iso(p.closedAt),
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
    // ─── Premium (2026-05-22 fix) ───
    // premiumPaidUsdc kept for backward-compat with existing Foxify
    // dashboard bindings; value semantics now corrected to be cumulative
    // accrued since open (hourly precision). New explicit fields below.
    premiumPaidUsdc: Number(accruedSinceOpen.toFixed(2)),
    premiumAccruedUsdc: Number(accruedSinceOpen.toFixed(2)),
    dailyRateUsdc: p.dailyPremiumUsdc,
    payoutUsdc: p.payoutUsdc,
    openedAtIso: iso(p.openedAt) ?? p.openedAt,
    triggeredAtIso: iso(p.triggeredAt),
    triggeredDirection: p.triggeredDirection,
    closedAtIso: iso(p.closedAt)
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
// 2026-05-22: dashboard previously sent dailyPremiumUsdc as `premiumPaidUsdc`
// (per-day RATE shown in a field that implies a CUMULATIVE total). Foxify's
// frontend rightly concluded "no premium owed" since the rate looked like
// already-paid. Fix: compute hourly-precision accrued premium for both the
// per-position projection and the /foxify/today aggregate counter.
//
// Hourly precision (not the round-up-to-whole-days rule the weekly settlement
// reconciler uses) is correct here because this is a DISPLAY value — it must
// update smoothly as time passes so Foxify can see real-time accrual.
// Settlement billing (weeklyReconciler.ts:144) still uses the per-day
// round-up rule and remains the authoritative billable amount.
//
// Inputs are ISO strings (or millisecond timestamps) and a daily rate.
// Returns USDC accrued in the intersection of [openedAt, closedAt|now]
// with [windowStart, windowEnd). Zero if no overlap.
export const premiumAccruedInWindowUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  windowStartIso: string;
  windowEndIso: string;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  const openedMs = new Date(params.openedAtIso).getTime();
  const closedMs = params.closedAtIso
    ? new Date(params.closedAtIso).getTime()
    : (params.nowMs ?? Date.now());
  const winStartMs = new Date(params.windowStartIso).getTime();
  const winEndMs = new Date(params.windowEndIso).getTime();
  const overlapStart = Math.max(openedMs, winStartMs);
  const overlapEnd = Math.min(closedMs, winEndMs);
  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs <= 0 || params.dailyRateUsdc <= 0) return 0;
  const overlapHours = overlapMs / 3_600_000;
  return (overlapHours / 24) * params.dailyRateUsdc;
};

// Convenience: cumulative accrued since open (open-ended right side = now)
const premiumAccruedSinceOpenUsdc = (params: {
  openedAtIso: string;
  closedAtIso: string | null;
  dailyRateUsdc: number;
  nowMs?: number;
}): number => {
  return premiumAccruedInWindowUsdc({
    openedAtIso: params.openedAtIso,
    closedAtIso: params.closedAtIso,
    // Use opened-at as window start and now/closed as end → just hours-active × rate
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

    const activeResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM volume_cover_position
       WHERE status = 'active'
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}`
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

    // 2026-05-22 fix: premium accrued IN [dayStart, dayEnd) across all
    // positions with overlapping activity. Includes positions opened
    // BEFORE today that are still alive (active or triggered, since both
    // accrue until pair-close), and positions opened today regardless of
    // whether they've since closed/triggered.
    const accrualResult = await pool.query(
      `SELECT id, opened_at, closed_at, daily_premium_usdc
       FROM volume_cover_position
       WHERE opened_at < $2
         AND (closed_at IS NULL OR closed_at >= $1)
         AND ${HIDE_ADMIN_TEST_POSITIONS_SQL}
         AND COALESCE((metadata->>'archived')::boolean, false) = false`,
      [dayStart, dayEnd]
    );
    let premiumBilledToday = 0;
    for (const row of accrualResult.rows) {
      premiumBilledToday += premiumAccruedInWindowUsdc({
        openedAtIso: String(row.opened_at),
        closedAtIso: row.closed_at ? String(row.closed_at) : null,
        windowStartIso: dayStart,
        windowEndIso: dayEnd,
        dailyRateUsdc: Number(row.daily_premium_usdc)
      });
    }

    // Triggers today + payouts owed.
    // Excludes both admin-test positions (HIDE_ADMIN_TEST_POSITIONS_SQL)
    // and explicitly-archived positions (metadata.archived=true). The
    // two filters serve different purposes and are AND'd together so
    // either one alone is sufficient to hide a position from this view.
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

    // Foxify-side net: payouts received - premium paid
    const foxifyNetUsdc = payoutsReceivedToday - premiumBilledToday;

    return reply.send({
      reportDate: new Date().toISOString().slice(0, 10),
      activationsToday,
      triggeredToday,
      closedEarlyToday,
      expiredUnusedToday,
      premiumPaidUsdc: Number(premiumBilledToday.toFixed(2)),
      payoutsReceivedUsdc: Number(payoutsReceivedToday.toFixed(2)),
      foxifyNetUsdc: Number(foxifyNetUsdc.toFixed(2)),
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
