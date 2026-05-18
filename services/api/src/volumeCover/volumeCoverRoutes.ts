/**
 * Volume Cover HTTP routes.
 *
 * Foxify-facing endpoints (HMAC-signed, given to Foxify):
 *   POST /volume-cover/quote
 *   POST /volume-cover/activate
 *   GET  /volume-cover/positions/:id            (own pair only)
 *   POST /volume-cover/positions/:id/close      (own pair only)
 *
 * Atticus-only endpoints (X-Admin-Token, you only):
 *   GET  /volume-cover/admin/cells
 *   POST /volume-cover/admin/cells/:cellId/toggle
 *   GET  /volume-cover/admin/positions
 *   GET  /volume-cover/admin/foxify-report?date=YYYY-MM-DD
 *   GET  /volume-cover/admin/foxify-report/range?from=...&to=...
 *   GET  /volume-cover/admin/dashboard
 *   GET  /volume-cover/admin/salvage-stats
 *   POST /volume-cover/admin/halt
 *   POST /volume-cover/admin/halt/clear
 *   POST /volume-cover/admin/positions/:id/close
 *   POST /volume-cover/admin/trigger-detector/run    (manual cycle for ops)
 *   GET  /volume-cover/health
 *
 * Auth model:
 *   - Foxify endpoints: HMAC-SHA256(timestamp + method + path + body, FOXIFY_API_KEY_HMAC_SECRET)
 *     in X-Foxify-Signature header. X-Foxify-Timestamp header within ±60s of server time.
 *   - Admin endpoints: X-Admin-Token equal to PILOT_ADMIN_TOKEN env (constant-time compare).
 *
 * All requests Zod-validated; failures return 4xx with structured error code.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

import { pilotConfig } from "../pilot/config";
import { getPilotPool } from "../pilot/db";
import { selectCell } from "./cellSelector";
import { resolveDailyPremium } from "./pricing";
import { findCellById, computeTriggerPrices, computeHedgeStrikes } from "./matrix";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded,
  getCell,
  listCells,
  updateCell,
  getPosition,
  getPositionByPairId,
  listActivePositions,
  listPositionsForCellToday,
  sumActivePayoutLiability,
  insertPairEvent,
  listRecentPairEvents,
  computePairEventLatencyStats
} from "./volumeCoverDb";
import { openPosition, closePosition } from "./positionLifecycle";
import {
  checkAllGuardsForVolumeCoverActivate,
  setManualHalt,
  getManualHalt,
  __resetVolumeCoverGuardrailsForTests
} from "./volumeCoverGuardrails";
import { readSalvageMetrics } from "./salvageTracker";
import { buildFoxifyDailyReport, buildFoxifyRangeReport } from "./foxifyReport";
import {
  buildWeeklySettlement,
  renderWeeklySettlementMarkdown,
  type VenueBalanceFetcher
} from "./weeklyReconciler";
import { runOneDetectionCycle, type SpotPriceSource } from "./triggerDetector";
import {
  runOneHedgeManagerTick,
  type SpotIvSource
} from "./volumeCoverHedgeManager";
import type { HedgeExecutor } from "./tightHedge";
import {
  classifyVolumeCoverRegime,
  translatePilotRegime,
  type VolRegime
} from "./strikeGrid";
import { getCurrentRegime } from "../pilot/regimeClassifier";
import {
  checkAntiBot,
  recordActivation,
  recordTriggerForFingerprint,
  recordPatternStrike
} from "./antiBot";

// ────────────────────── Auth helpers ──────────────────────

const HMAC_TIMESTAMP_TOLERANCE_MS = 60_000;

const resolveAdminToken = (): string => {
  // Read dynamically so tests can override env at runtime.
  return process.env.PILOT_ADMIN_TOKEN || pilotConfig.adminToken || "";
};

const isAdminAuthorized = (req: FastifyRequest): boolean => {
  const token = String(req.headers["x-admin-token"] || "");
  const expected = resolveAdminToken();
  if (!expected || !token) return false;
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
};

const getFoxifyHmacSecret = (): string => {
  return process.env.FOXIFY_API_KEY_HMAC_SECRET || "";
};

const isFoxifyAuthorized = (req: FastifyRequest): {
  ok: boolean;
  reason?: string;
} => {
  const secret = getFoxifyHmacSecret();
  if (!secret) {
    // If no secret configured, allow only in test/dev. In prod the env
    // is required.
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "no_hmac_secret_configured" };
    }
    if (String(process.env.VOLUME_COVER_AUTH_DISABLED ?? "false").toLowerCase() === "true") {
      return { ok: true };
    }
    return { ok: false, reason: "no_hmac_secret_configured" };
  }

  const sig = String(req.headers["x-foxify-signature"] || "");
  const tsStr = String(req.headers["x-foxify-timestamp"] || "");
  if (!sig || !tsStr) {
    return { ok: false, reason: "missing_hmac_headers" };
  }
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const driftMs = Math.abs(Date.now() - ts);
  if (driftMs > HMAC_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: `timestamp_drift_${driftMs}ms` };
  }

  const method = req.method.toUpperCase();
  const path = req.url.split("?")[0];
  const body = req.body ? JSON.stringify(req.body) : "";
  const message = `${tsStr}\n${method}\n${path}\n${body}`;
  const expected = createHmac("sha256", secret).update(message).digest("hex");

  if (sig.length !== expected.length) {
    return { ok: false, reason: "signature_length_mismatch" };
  }
  try {
    if (!timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) {
      return { ok: false, reason: "signature_mismatch" };
    }
  } catch {
    return { ok: false, reason: "signature_compare_failed" };
  }
  return { ok: true };
};

// ────────────────────── Zod schemas ──────────────────────

const QuoteRequestSchema = z.object({
  foxifyPairId: z.string().min(1).max(128),
  pairNotionalUsdc: z.number().positive().finite(),
  triggerPct: z.number().positive().lt(1),
  pairEntryBtcPrice: z.number().positive().optional(),
  cellId: z.string().optional()
});

const ActivateRequestSchema = z.object({
  foxifyPairId: z.string().min(1).max(128),
  cellId: z.string().min(1),
  pairLongNotionalUsdc: z.number().positive().finite(),
  pairShortNotionalUsdc: z.number().positive().finite(),
  pairEntryBtcPrice: z.number().positive().finite(),
  /** P1g: fingerprint hash for anti-bot Layers 1+2 + ladder netting. */
  fingerprintHash: z.string().min(1).max(128).optional()
});

const CloseRequestSchema = z.object({
  reason: z.string().max(256).optional()
});

const CellToggleSchema = z.object({
  enabled: z.boolean().optional(),
  dailyPremiumUsdc: z.number().positive().optional(),
  throttleMaxPerDay: z.number().int().positive().optional()
});

const HaltSchema = z.object({
  reason: z.string().max(256)
});

// ────────────────────── Handler factory ──────────────────────

export type RegisterVolumeCoverRoutesOptions = {
  /** Required: Postgres pool. If omitted, uses pilot getPilotPool(). */
  pool?: Pool;
  /** Required: HedgeExecutor for live order placement. */
  hedgeExecutor: HedgeExecutor;
  /** Required: live spot source for trigger detector + Foxify entry-price sanity. */
  spotSource: SpotPriceSource;
  /** Optional: spot+IV source for hedge manager; falls back to spotSource + fallbackIv. */
  spotIvSource?: SpotIvSource;
  /**
   * Optional (P3 §12.4): venue balance fetcher for reconciliation
   * drift halt. When provided, weekly settlement endpoint compares
   * venue balance to ledger; emits driftHalt=true if drift > 1%.
   * Operator wires Bullish + Deribit balance APIs (sum into single
   * USDC-equivalent value).
   */
  venueBalanceFetcher?: VenueBalanceFetcher;
  /** Optional: skip schema migration (tests provide pre-migrated pg-mem). */
  skipSchema?: boolean;
};

export const registerVolumeCoverRoutes = async (
  app: FastifyInstance,
  opts: RegisterVolumeCoverRoutesOptions
): Promise<void> => {
  const pool = opts.pool ?? getPilotPool(pilotConfig.postgresUrl ?? "");

  if (!opts.skipSchema) {
    await ensureVolumeCoverSchema(pool);
    await seedVolumeCoverCellsIfNeeded(pool);
  }

  // ────────── HEALTH ──────────

  app.get("/volume-cover/health", async (_req, reply) => {
    try {
      const cells = await listCells(pool);
      const active = await listActivePositions(pool);
      const liability = await sumActivePayoutLiability(pool);
      const halt = getManualHalt();
      return reply.send({
        status: "ok",
        cellsConfigured: cells.length,
        cellsEnabled: cells.filter((c) => c.enabled).length,
        activePositions: active.length,
        totalActivePayoutLiabilityUsdc: liability,
        manualHalt: halt
      });
    } catch (err) {
      return reply.code(503).send({
        status: "degraded",
        error: (err as Error).message
      });
    }
  });

  // ────────── FOXIFY-FACING ──────────

  app.post("/volume-cover/quote", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = isFoxifyAuthorized(req);
    if (!auth.ok) {
      return reply.code(401).send({ error: "unauthorized", reason: auth.reason });
    }
    const parse = QuoteRequestSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const cellResult = body.cellId
      ? selectCell({ cellId: body.cellId })
      : selectCell({ notionalUsdc: body.pairNotionalUsdc, triggerPct: body.triggerPct });
    if (!cellResult.ok) {
      return reply.code(400).send({ error: "cell_not_found", details: cellResult.details });
    }

    const cellRow = await getCell(pool, cellResult.cell.cellId);
    if (!cellRow) {
      return reply.code(503).send({ error: "cell_row_missing" });
    }
    if (!cellRow.enabled) {
      return reply.code(403).send({ error: "cell_disabled", cellId: cellRow.cellId });
    }

    const premium = resolveDailyPremium({
      cell: cellResult.cell,
      dbOverrideDailyPremiumUsdc: cellRow.dailyPremiumUsdc
    });

    let entryBtc: number;
    if (typeof body.pairEntryBtcPrice === "number") {
      entryBtc = body.pairEntryBtcPrice;
    } else {
      try {
        const live = await opts.spotSource();
        entryBtc = live.spotBtcPrice;
      } catch {
        return reply.code(503).send({ error: "spot_price_unavailable" });
      }
    }

    const triggers = computeTriggerPrices({ cell: cellResult.cell, entryBtcPrice: entryBtc });
    const strikes = computeHedgeStrikes({ cell: cellResult.cell, entryBtcPrice: entryBtc });

    return reply.send({
      cellId: cellResult.cell.cellId,
      dailyPremiumUsdc: premium.dailyPremiumUsdc,
      payoutUsdc: premium.payoutUsdc,
      pairEntryBtcPrice: entryBtc,
      triggerHighBtc: triggers.triggerHighBtc,
      triggerLowBtc: triggers.triggerLowBtc,
      hedgeStructure: {
        venueRouting: cellResult.cell.triggerPct <= 0.05 ? "bullish_primary" : "deribit_primary",
        putStrikeBtc: strikes.putStrikeBtc,
        callStrikeBtc: strikes.callStrikeBtc
      },
      throttleMaxPerDay: cellRow.throttleMaxPerDay,
      premiumSource: premium.source,
      quoteExpiresInSeconds: 30
    });
  });

  app.post("/volume-cover/activate", async (req: FastifyRequest, reply: FastifyReply) => {
    // Pair-event audit timing capture. Stages tracked:
    //   receivedAt        — request arrival (this point)
    //   guardsPassedAtMs  — after anti-bot + guard composer
    //   hedgeBuySubmitMs  — just before openPosition (which fires venue order)
    //   hedgeFillMs       — after openPosition returns (venue confirmed)
    //   responseSentAt    — final reply
    const receivedAtMs = Date.now();
    let guardsPassedAtMs: number | null = null;
    let hedgeBuySubmittedAtMs: number | null = null;
    let hedgeFillAtMs: number | null = null;

    const writeEvent = async (params: {
      result: "activated" | "idempotent" | "rejected" | "failed";
      rejectReason?: string;
      positionId?: string;
      laddered?: boolean;
      ladderSavingsUsdc?: number;
      metadata?: Record<string, unknown>;
    }) => {
      try {
        const responseSentAtMs = Date.now();
        await insertPairEvent(pool, {
          foxifyPairId: (req.body as any)?.foxifyPairId ?? "unknown",
          cellId: (req.body as any)?.cellId ?? "unknown",
          fingerprintHash: (req.body as any)?.fingerprintHash ?? null,
          pairEntryBtcPrice: Number((req.body as any)?.pairEntryBtcPrice ?? 0) || null,
          result: params.result,
          rejectReason: params.rejectReason ?? null,
          positionId: params.positionId ?? null,
          receivedAtIso: new Date(receivedAtMs).toISOString(),
          guardsPassedAtIso: guardsPassedAtMs ? new Date(guardsPassedAtMs).toISOString() : null,
          hedgeBuySubmittedAtIso: hedgeBuySubmittedAtMs ? new Date(hedgeBuySubmittedAtMs).toISOString() : null,
          hedgeFillAtIso: hedgeFillAtMs ? new Date(hedgeFillAtMs).toISOString() : null,
          responseSentAtIso: new Date(responseSentAtMs).toISOString(),
          totalLatencyMs: responseSentAtMs - receivedAtMs,
          laddered: params.laddered ?? false,
          ladderSavingsUsdc: params.ladderSavingsUsdc ?? 0,
          metadata: params.metadata ?? {}
        });
      } catch (err) {
        // best-effort; never fail the request because of audit insert
        req.log.warn(`[volume-cover/activate] pair-event audit insert failed: ${(err as Error).message}`);
      }
    };

    const auth = isFoxifyAuthorized(req);
    if (!auth.ok) {
      void writeEvent({ result: "rejected", rejectReason: `unauthorized:${auth.reason}` });
      return reply.code(401).send({ error: "unauthorized", reason: auth.reason });
    }
    const parse = ActivateRequestSchema.safeParse(req.body);
    if (!parse.success) {
      void writeEvent({ result: "rejected", rejectReason: "invalid_request" });
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const cell = findCellById(body.cellId);
    if (!cell) {
      return reply.code(400).send({ error: "cell_not_found", cellId: body.cellId });
    }

    const cellRow = await getCell(pool, cell.cellId);
    if (!cellRow) {
      return reply.code(503).send({ error: "cell_row_missing" });
    }
    if (!cellRow.enabled) {
      return reply.code(403).send({ error: "cell_disabled", cellId: cell.cellId });
    }

    // Spot-drift sanity: reject if entry price more than 1% off live spot
    try {
      const live = await opts.spotSource();
      const drift = Math.abs(body.pairEntryBtcPrice - live.spotBtcPrice) / live.spotBtcPrice;
      if (drift > 0.01) {
        return reply.code(400).send({
          error: "entry_price_drift_too_high",
          driftPct: drift,
          maxPct: 0.01
        });
      }
    } catch {
      // If spot source down, allow but log
      req.log.warn(`[volume-cover] spot source unavailable; skipping drift check`);
    }

    // Per-cell daily throttle
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const todayPositions = await listPositionsForCellToday(pool, {
      cellId: cell.cellId,
      sinceIso: dayStart.toISOString()
    });

    // Idempotency check: if a position already exists with this foxifyPairId,
    // return it (Foxify may retry on network error).
    const existing = await getPositionByPairId(pool, body.foxifyPairId);
    if (existing && existing.status === "active") {
      void writeEvent({ result: "idempotent", positionId: existing.id });
      return reply.code(200).send({
        positionId: existing.id,
        status: existing.status,
        idempotent: true
      });
    }

    // P1g + P3: anti-bot Layers 1-4. Bypass via X-Bypass-Antibot
    // header equal to admin token.
    const bypassHeader = String(req.headers["x-bypass-antibot"] || "");
    const bypass = bypassHeader.length > 0 && bypassHeader === resolveAdminToken();
    let surchargeMultiplier = 1.0;
    if (body.fingerprintHash && !bypass) {
      const decision = await checkAntiBot({
        pool,
        fingerprintHash: body.fingerprintHash,
        cellId: cell.cellId
      });
      if (!decision.allowed) {
        // P3 Layer 4: pattern-strike when Layer 1 blocks (repeat attempt)
        if (decision.reason === "layer1_repeat_cell_window") {
          try {
            await recordPatternStrike({ pool, fingerprintHash: body.fingerprintHash });
          } catch (err) {
            req.log.warn(`[volume-cover/activate] recordPatternStrike failed: ${(err as Error).message}`);
          }
        }
        void writeEvent({ result: "rejected", rejectReason: `antibot:${decision.reason}` });
        return reply.code(429).send({
          error: "antibot_blocked",
          reason: decision.reason,
          message: decision.message,
          retryAfterMs: decision.retryAfterMs
        });
      }
      surchargeMultiplier = decision.surchargeMultiplier ?? 1.0;
    }

    // Salvage / loss / liability metrics for guard composer
    const metrics = await readSalvageMetrics(pool);
    const totalActiveLiability = await sumActivePayoutLiability(pool);

    // P3 §13 + P1c: fetch live DVOL ONCE, reuse for guard, pricing, sizing.
    let currentDvolForGuard = 0;
    let regime: VolRegime | null = null;
    try {
      const status = await getCurrentRegime();
      currentDvolForGuard = status.dvol ?? 0;
      regime = classifyVolumeCoverRegime(status.dvol);
      if (!regime) regime = translatePilotRegime(status.regime);
    } catch (err) {
      req.log.warn(`[volume-cover/activate] regime fetch failed: ${(err as Error).message}`);
    }

    const guardVerdict = checkAllGuardsForVolumeCoverActivate({
      foxifyPoolBalanceUsdc: 0,
      totalActivePayoutLiabilityUsdc: totalActiveLiability,
      newPayoutLiabilityUsdc: cell.payoutUsdc,
      dbTrackedAtticusBalanceUsdc: null,
      venueReportedAtticusBalanceUsdc: null,
      currentDvol: currentDvolForGuard,
      lastDvolThresholdCrossingMs: null,
      bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 0, sampleCount: 0 },
      todayPremiumIncomeUsdc: 0,
      rollingAvgPremiumIncomeUsdc: 0,
      rolling7dayAtticusLossUsdc: metrics.rolling7dayAtticusLossUsdc,
      rolling5TriggerSalvagePct: metrics.rolling5TriggerSalvagePct,
      rolling5TriggerSampleCount: metrics.rolling5TriggerSampleCount,
      rolling24hTriggerCount: metrics.rolling24hTriggerCount
    });
    if (!guardVerdict.allowed) {
      void writeEvent({ result: "rejected", rejectReason: `guard:${guardVerdict.reason}` });
      return reply.code(403).send({
        error: "guardrail_blocked",
        reason: guardVerdict.reason,
        message: guardVerdict.message,
        details: guardVerdict.details
      });
    }

    const effectiveThrottle =
      guardVerdict.throttleOverridePerDay ?? cellRow.throttleMaxPerDay;
    if (todayPositions.length >= effectiveThrottle) {
      void writeEvent({ result: "rejected", rejectReason: "daily_throttle_exceeded" });
      return reply.code(429).send({
        error: "daily_throttle_exceeded",
        cellId: cell.cellId,
        openedToday: todayPositions.length,
        maxPerDay: effectiveThrottle,
        salvageState: guardVerdict.salvageState
      });
    }
    guardsPassedAtMs = Date.now();

    // P3 §13: regime-aware pricing. resolveDailyPremium reads
    // VC_REGIME_OVERLAY_JSON env (post-Phase-2 sign-off) and applies
    // moderate/elevated/stress overlays. Calm always uses base/DB.
    const premiumQuote = resolveDailyPremium({
      cell,
      dbOverrideDailyPremiumUsdc: cellRow.dailyPremiumUsdc,
      regime
    });
    const baseDailyPremium = premiumQuote.dailyPremiumUsdc;
    // P3 Layer 4: apply surcharge multiplier if fingerprint is in
    // surcharge state. Default 1.0 (no change).
    const dailyPremium = Math.round(baseDailyPremium * surchargeMultiplier);

    // P1c: vol-buffered sizing reuses the regime fetched once above
    // for guard + pricing.
    try {
      hedgeBuySubmittedAtMs = Date.now();
      const result = await openPosition(pool, opts.hedgeExecutor, {
        cell,
        foxifyPairId: body.foxifyPairId,
        pairLongNotionalUsdc: body.pairLongNotionalUsdc,
        pairShortNotionalUsdc: body.pairShortNotionalUsdc,
        pairEntryBtcPrice: body.pairEntryBtcPrice,
        effectiveDailyPremiumUsdc: dailyPremium,
        regime,
        fingerprintHash: body.fingerprintHash ?? null,
        metadata: {
          source: "foxify_api",
          requestIp: req.ip,
          regime
        }
      });
      hedgeFillAtMs = Date.now();

      // P1g + P3: record activation for Layer 2 cooldown. Surcharge
      // applied to dailyPremium above is logged for audit.
      if (body.fingerprintHash) {
        try {
          await recordActivation({
            pool,
            fingerprintHash: body.fingerprintHash,
            cellId: cell.cellId
          });
        } catch (err) {
          req.log.warn(`[volume-cover/activate] recordActivation failed: ${(err as Error).message}`);
        }
      }
      if (surchargeMultiplier > 1.0) {
        req.log.info(`[volume-cover/activate] surcharge applied: ${surchargeMultiplier}\u00d7 base \$${baseDailyPremium} = \$${dailyPremium}`);
      }

      void writeEvent({
        result: "activated",
        positionId: result.position.id,
        laddered: result.laddered,
        ladderSavingsUsdc: result.ladderEstimatedSavingsUsdc,
        metadata: { regime, surchargeMultiplier }
      });
      return reply.code(201).send({
        positionId: result.position.id,
        status: result.position.status,
        cellId: cell.cellId,
        triggerHighBtc: result.position.triggerHighBtc,
        triggerLowBtc: result.position.triggerLowBtc,
        dailyPremiumUsdc: dailyPremium,
        payoutUsdc: cell.payoutUsdc,
        hedgeLegs: result.hedgeLegs.map((l) => ({
          id: l.id,
          venue: l.venue,
          optionKind: l.optionKind,
          strikeUsdc: l.strikeUsdc
        })),
        salvageState: guardVerdict.salvageState
      });
    } catch (err) {
      req.log.error(`[volume-cover/activate] failed: ${(err as Error).message}`);
      void writeEvent({ result: "failed", rejectReason: (err as Error).message });
      return reply.code(500).send({
        error: "activate_failed",
        message: (err as Error).message
      });
    }
  });

  app.get("/volume-cover/positions/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = isFoxifyAuthorized(req);
    if (!auth.ok) {
      return reply.code(401).send({ error: "unauthorized", reason: auth.reason });
    }
    const id = (req.params as any).id as string;
    const position = await getPosition(pool, id);
    if (!position) {
      return reply.code(404).send({ error: "position_not_found" });
    }
    return reply.send({
      positionId: position.id,
      cellId: position.cellId,
      foxifyPairId: position.foxifyPairId,
      status: position.status,
      triggerHighBtc: position.triggerHighBtc,
      triggerLowBtc: position.triggerLowBtc,
      payoutUsdc: position.payoutUsdc,
      dailyPremiumUsdc: position.dailyPremiumUsdc,
      openedAt: position.openedAt,
      triggeredAt: position.triggeredAt,
      triggeredDirection: position.triggeredDirection,
      closedAt: position.closedAt
    });
  });

  app.post("/volume-cover/positions/:id/close", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = isFoxifyAuthorized(req);
    if (!auth.ok) {
      return reply.code(401).send({ error: "unauthorized", reason: auth.reason });
    }
    const id = (req.params as any).id as string;
    const parse = CloseRequestSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const position = await getPosition(pool, id);
    if (!position) {
      return reply.code(404).send({ error: "position_not_found" });
    }
    if (position.status !== "active") {
      return reply.code(409).send({ error: "position_not_active", currentStatus: position.status });
    }
    try {
      const result = await closePosition(pool, opts.hedgeExecutor, {
        position,
        reason: `foxify_close: ${parse.data.reason ?? "no_reason"}`
      });
      return reply.send({
        positionId: id,
        status: "closed",
        // P1b: hedge legs are RETAINED (not sold). VC hedge manager
        // owns disposition. legsSold field intentionally omitted.
        hedgeRetainedLegIds: result.hedgeRetainedLegIds,
        hedgeRetained: true
      });
    } catch (err) {
      req.log.error(`[volume-cover/close] failed: ${(err as Error).message}`);
      return reply.code(500).send({
        error: "close_failed",
        message: (err as Error).message
      });
    }
  });

  // ────────── ATTICUS-ONLY ADMIN ──────────

  app.get("/volume-cover/admin/cells", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const cells = await listCells(pool);
    return reply.send({ cells });
  });

  app.post("/volume-cover/admin/cells/:cellId/toggle", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const parse = CellToggleSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const cellId = (req.params as any).cellId as string;
    const updated = await updateCell(pool, cellId, parse.data);
    if (!updated) return reply.code(404).send({ error: "cell_not_found" });
    return reply.send({ cell: updated });
  });

  app.get("/volume-cover/admin/positions", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const status = String((req.query as any)?.status ?? "active");
    if (status === "active") {
      const positions = await listActivePositions(pool);
      return reply.send({ positions });
    }
    // Default: return active + recent (last 100)
    const r = await pool.query(
      `SELECT * FROM volume_cover_position
       ORDER BY opened_at DESC LIMIT 100`
    );
    return reply.send({
      positions: r.rows.map((row) => ({
        id: row.id,
        cellId: row.cell_id,
        foxifyPairId: row.foxify_pair_id,
        status: row.status,
        openedAt: row.opened_at,
        triggeredAt: row.triggered_at,
        closedAt: row.closed_at,
        payoutUsdc: Number(row.payout_usdc)
      }))
    });
  });

  /**
   * Detailed active-positions endpoint for the live ops UI.
   * Joins positions + hedge legs + recent telemetry per leg so the
   * UI can render one row per position with expandable leg detail.
   */
  app.get("/volume-cover/admin/active-positions-detail", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const limitRaw = Number((req.query as any)?.limit ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;

    // Pull active + recently-triggered + recently-closed (so UI shows
    // a few terminal rows for context without overwhelming).
    const posResult = await pool.query(
      `SELECT * FROM volume_cover_position
       WHERE status IN ('active', 'triggered')
          OR (status = 'closed' AND closed_at >= NOW() - interval '6 hours')
       ORDER BY opened_at DESC
       LIMIT $1`,
      [limit]
    );

    const positions = await Promise.all(
      posResult.rows.map(async (row) => {
        const legsResult = await pool.query(
          `SELECT id, venue, option_kind, strike_usdc, expiry_iso,
                  contracts, buy_price_usdc, sell_price_usdc, status,
                  retained, retained_role, retained_at, opened_at, closed_at
           FROM volume_cover_hedge_leg
           WHERE position_id = $1
           ORDER BY opened_at`,
          [row.id]
        );
        const legs = legsResult.rows.map((l) => ({
          id: String(l.id),
          venue: String(l.venue),
          optionKind: String(l.option_kind),
          strikeUsdc: Number(l.strike_usdc),
          expiryIso: String(l.expiry_iso),
          contracts: Number(l.contracts),
          buyPriceUsdc: Number(l.buy_price_usdc),
          sellPriceUsdc: l.sell_price_usdc !== null ? Number(l.sell_price_usdc) : null,
          status: String(l.status),
          retained: Boolean(l.retained),
          retainedRole: l.retained_role ? String(l.retained_role) : null,
          retainedAt: l.retained_at ? String(l.retained_at) : null,
          openedAt: String(l.opened_at),
          closedAt: l.closed_at ? String(l.closed_at) : null
        }));

        return {
          id: String(row.id),
          cellId: String(row.cell_id),
          foxifyPairId: String(row.foxify_pair_id),
          fingerprintHash: row.fingerprint_hash ? String(row.fingerprint_hash) : null,
          pairLongNotionalUsdc: Number(row.pair_long_notional_usdc),
          pairShortNotionalUsdc: Number(row.pair_short_notional_usdc),
          pairEntryBtcPrice: Number(row.pair_entry_btc_price),
          triggerHighBtc: Number(row.trigger_high_btc),
          triggerLowBtc: Number(row.trigger_low_btc),
          dailyPremiumUsdc: Number(row.daily_premium_usdc),
          payoutUsdc: Number(row.payout_usdc),
          status: String(row.status),
          openedAt: String(row.opened_at),
          triggeredAt: row.triggered_at ? String(row.triggered_at) : null,
          triggeredDirection: row.triggered_direction ? String(row.triggered_direction) : null,
          closedAt: row.closed_at ? String(row.closed_at) : null,
          closeReason: row.close_reason ? String(row.close_reason) : null,
          legs
        };
      })
    );

    // Also pull current spot for trigger-distance display
    let currentSpotBtc: number | null = null;
    let spotSource: string | null = null;
    try {
      const spot = await opts.spotSource();
      currentSpotBtc = spot.spotBtcPrice;
      spotSource = spot.source;
    } catch {
      // best-effort
    }

    return reply.send({
      positions,
      currentSpotBtc,
      spotSource,
      generatedAtIso: new Date().toISOString()
    });
  });

  app.get("/volume-cover/admin/foxify-report", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const dateParam = String((req.query as any)?.date ?? "");
    const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : new Date().toISOString().slice(0, 10);
    const report = await buildFoxifyDailyReport({ pool, reportDate });
    return reply.send(report);
  });

  app.get("/volume-cover/admin/foxify-report/range", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const fromParam = String((req.query as any)?.from ?? "");
    const toParam = String((req.query as any)?.to ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromParam) || !/^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
      return reply.code(400).send({ error: "invalid_date_range" });
    }
    const range = await buildFoxifyRangeReport({ pool, fromDate: fromParam, toDate: toParam });
    return reply.send(range);
  });

  app.get("/volume-cover/admin/dashboard", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const today = new Date().toISOString().slice(0, 10);
    const report = await buildFoxifyDailyReport({ pool, reportDate: today });
    const md = renderDashboardMarkdown(report);
    return reply.type("text/markdown").send(md);
  });

  app.get("/volume-cover/admin/salvage-stats", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const metrics = await readSalvageMetrics(pool);
    return reply.send(metrics);
  });

  /**
   * Live venue balances — pulls Bullish asset balances (USDC + BTC).
   * Used by the admin dashboard header to show real available capital
   * and confirm venue connectivity.
   *
   * Server-side cached (default TTL 30s) so the 2s dashboard refresh
   * loop doesn't hammer Bullish and trigger 429 RATE_LIMIT_EXCEEDED.
   * Override TTL via VC_VENUE_BALANCE_CACHE_MS env (>=5000).
   *
   * Failed fetches are ALSO cached (shorter TTL of 5s) so an outage
   * doesn't cause a retry storm. Returns previously-cached value with
   * 'stale: true' flag while the underlying error is in cooldown.
   *
   * 5s timeout per Bullish call. Returns whatever it gets; sets
   * `error` field per venue on failure (graceful degradation).
   */
  const venueBalanceCacheTtlMs = Math.max(
    5_000,
    Number(process.env.VC_VENUE_BALANCE_CACHE_MS ?? 30_000)
  );
  const venueBalanceFailureCooldownMs = 5_000;

  type CachedVenueBalanceResp = {
    fetchedAtMs: number;
    payload: any;
    wasError: boolean;
  };
  let venueBalanceCache: CachedVenueBalanceResp | null = null;
  let venueBalanceInflight: Promise<CachedVenueBalanceResp> | null = null;

  const fetchFreshVenueBalances = async (): Promise<CachedVenueBalanceResp> => {
    const withTimeout = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
      return Promise.race([
        p,
        new Promise<T>((_, rej) =>
          setTimeout(() => rej(new Error(`timeout_${ms}ms`)), ms)
        )
      ]);
    };

    let bullishUsdc: number | null = null;
    let bullishBtc: number | null = null;
    let bullishError: string | null = null;
    let bullishRawCount = 0;
    try {
      const { BullishTradingClient } = await import("../pilot/bullish");
      const client = new BullishTradingClient(pilotConfig.bullish);
      const balances: any[] = await withTimeout(client.getAssetBalances(), 5_000);
      bullishRawCount = balances.length;
      const usdc = balances.find(
        (b: any) => b.assetSymbol === "USDC" || b.assetSymbol === "USD"
      );
      const btc = balances.find((b: any) => b.assetSymbol === "BTC");
      if (usdc) bullishUsdc = Number(usdc.availableQuantity ?? 0);
      if (btc) bullishBtc = Number(btc.availableQuantity ?? 0);
    } catch (err) {
      bullishError = (err as Error).message;
    }

    let spotBtcUsdc: number | null = null;
    try {
      const spot = await opts.spotSource();
      spotBtcUsdc = spot.spotBtcPrice;
    } catch {
      // best-effort
    }

    const bullishBtcValueUsdc =
      bullishBtc !== null && spotBtcUsdc !== null ? bullishBtc * spotBtcUsdc : null;
    const bullishTotalUsdc =
      bullishUsdc !== null && bullishBtcValueUsdc !== null
        ? bullishUsdc + bullishBtcValueUsdc
        : bullishUsdc;

    return {
      fetchedAtMs: Date.now(),
      wasError: bullishError !== null,
      payload: {
        generatedAtIso: new Date().toISOString(),
        spotBtcUsdc,
        bullish: {
          connected: bullishError === null,
          error: bullishError,
          rawAssetCount: bullishRawCount,
          usdcAvailable: bullishUsdc,
          btcAvailable: bullishBtc,
          btcValueUsdc: bullishBtcValueUsdc,
          totalEquityUsdc: bullishTotalUsdc,
          environment: pilotConfig.bullish.restBaseUrl.includes("bullish-test.com")
            ? "testnet"
            : pilotConfig.bullish.restBaseUrl.includes("bullish.com")
            ? "mainnet"
            : "unknown",
          restBaseUrl: pilotConfig.bullish.restBaseUrl
        }
      }
    };
  };

  app.get("/volume-cover/admin/venue-balances", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const now = Date.now();
    if (venueBalanceCache) {
      const ageMs = now - venueBalanceCache.fetchedAtMs;
      const ttl = venueBalanceCache.wasError
        ? venueBalanceFailureCooldownMs
        : venueBalanceCacheTtlMs;
      if (ageMs < ttl) {
        return reply.send({
          ...venueBalanceCache.payload,
          cached: true,
          cacheAgeMs: ageMs
        });
      }
    }

    // De-dupe concurrent fetches: if a refresh is already in flight,
    // wait for it rather than starting a parallel one.
    if (!venueBalanceInflight) {
      venueBalanceInflight = fetchFreshVenueBalances()
        .then((result) => {
          venueBalanceCache = result;
          return result;
        })
        .finally(() => {
          venueBalanceInflight = null;
        });
    }

    try {
      const fresh = await venueBalanceInflight;
      return reply.send({
        ...fresh.payload,
        cached: false,
        cacheAgeMs: 0
      });
    } catch (err) {
      // Should be unreachable (fetchFreshVenueBalances catches its own
      // errors and embeds in payload), but defensive.
      return reply.code(500).send({ error: "venue_balance_fetch_failed", message: (err as Error).message });
    }
  });

  // P1d: weekly settlement reconciler. Format: ?week=YYYY-Www
  // Returns JSON by default; pass ?format=markdown for the Markdown view.
  app.get("/volume-cover/admin/weekly-settlement", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const weekLabel = String((req.query as any)?.week ?? "");
    if (!/^\d{4}-W\d{1,2}$/.test(weekLabel)) {
      return reply.code(400).send({ error: "invalid_week_label", expected: "YYYY-Www" });
    }
    try {
      const settlement = await buildWeeklySettlement({
        pool,
        weekLabel,
        venueBalanceFetcher: opts.venueBalanceFetcher
      });
      const format = String((req.query as any)?.format ?? "json");
      if (format === "markdown") {
        return reply.type("text/markdown").send(renderWeeklySettlementMarkdown(settlement));
      }
      return reply.send(settlement);
    } catch (err) {
      return reply.code(500).send({ error: "settlement_failed", message: (err as Error).message });
    }
  });

  app.post("/volume-cover/admin/halt", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const parse = HaltSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    setManualHalt({ halted: true, reason: parse.data.reason });
    return reply.send({ halt: getManualHalt() });
  });

  app.post("/volume-cover/admin/halt/clear", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    setManualHalt({ halted: false });
    return reply.send({ halt: getManualHalt() });
  });

  app.post("/volume-cover/admin/positions/:id/close", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const id = (req.params as any).id as string;
    const reason = String((req.body as any)?.reason ?? "admin_close");
    const position = await getPosition(pool, id);
    if (!position) return reply.code(404).send({ error: "position_not_found" });
    if (position.status !== "active") {
      return reply.code(409).send({ error: "position_not_active", currentStatus: position.status });
    }
    try {
      const result = await closePosition(pool, opts.hedgeExecutor, {
        position,
        reason: `admin: ${reason}`
      });
      return reply.send({
        positionId: id,
        status: "closed",
        hedgeRetainedLegIds: result.hedgeRetainedLegIds,
        hedgeRetained: true
      });
    } catch (err) {
      return reply.code(500).send({ error: "close_failed", message: (err as Error).message });
    }
  });

  // Pair-event audit log endpoints for ops monitoring.
  app.get("/volume-cover/admin/pair-events", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const limitRaw = Number((req.query as any)?.limit ?? 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 100;
    const events = await listRecentPairEvents(pool, limit);
    return reply.send({ events });
  });

  app.get("/volume-cover/admin/pair-event-stats", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const windowHoursRaw = Number((req.query as any)?.windowHours ?? 24);
    const windowHours =
      Number.isFinite(windowHoursRaw) && windowHoursRaw > 0 && windowHoursRaw <= 168
        ? windowHoursRaw
        : 24;
    const stats = await computePairEventLatencyStats(pool, windowHours);
    return reply.send({ windowHours, ...stats });
  });

  app.post("/volume-cover/admin/trigger-detector/run", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    try {
      const cycle = await runOneDetectionCycle({
        pool,
        executor: opts.hedgeExecutor,
        spotSource: opts.spotSource
      });
      return reply.send(cycle);
    } catch (err) {
      return reply.code(500).send({ error: "cycle_failed", message: (err as Error).message });
    }
  });

  // P1f: manual hedge manager tick (ops + smoke testing)
  app.post("/volume-cover/admin/hedge-manager/run", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const dryRun = String((req.query as any)?.dryRun ?? "false").toLowerCase() === "true";
    try {
      // Build a SpotIvSource from the SpotPriceSource if not provided.
      // Falls back to env-configured fallback IV.
      const spotIvSource: SpotIvSource =
        opts.spotIvSource ??
        (async () => {
          const spot = await opts.spotSource();
          const fallbackIv = Number(process.env.VC_HM_FALLBACK_IV ?? 0.65);
          return {
            spotBtcUsdc: spot.spotBtcPrice,
            ivAnnualized: fallbackIv,
            asOfMs: spot.asOfMs
          };
        });
      const result = await runOneHedgeManagerTick({
        pool,
        executor: opts.hedgeExecutor,
        spotIvSource,
        dryRun
      });
      return reply.send(result);
    } catch (err) {
      return reply.code(500).send({ error: "hedge_manager_tick_failed", message: (err as Error).message });
    }
  });

  /**
   * Operator self-test endpoint — bypasses Foxify HMAC, requires
   * admin auth instead. Lets operator open a real position on the
   * live venue (real money hedge buy) without delivering Foxify
   * the HMAC secret yet, with optional premium override so the
   * test doesn't bleed full pilot pricing.
   *
   * Usage:
   *   POST /volume-cover/admin/test-activate
   *   X-Admin-Token: <token>
   *   Body:
   *     {
   *       "foxifyPairId": "TEST-001" (any unique string),
   *       "cellId": "50k_2pct_1k",
   *       "pairLongNotionalUsdc": 50000,
   *       "pairShortNotionalUsdc": 50000,
   *       "pairEntryBtcPrice": 78200,
   *       "premiumOverrideUsdc": 10  // optional; uses cell base if omitted
   *     }
   *
   * Returns: same shape as /volume-cover/activate (positionId, triggers, legs).
   *
   * Notes:
   *   - All guardrails still apply (DVOL stress, kill-switch, etc.)
   *   - Telemetry tagged with metadata.source = 'admin_test_activate'
   *   - Anti-bot Layers SKIPPED (this is operator action, not bot)
   *   - DOES NOT bypass capital pre-check or trigger surge guard
   */
  app.post("/volume-cover/admin/test-activate", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const TestActivateSchema = z.object({
      foxifyPairId: z.string().min(1).max(128),
      cellId: z.string().min(1),
      pairLongNotionalUsdc: z.number().positive().finite().optional(),
      pairShortNotionalUsdc: z.number().positive().finite().optional(),
      pairEntryBtcPrice: z.number().positive().finite(),
      premiumOverrideUsdc: z.number().positive().finite().optional()
    });
    const parse = TestActivateSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const cell = findCellById(body.cellId);
    if (!cell) {
      return reply.code(400).send({ error: "cell_not_found", cellId: body.cellId });
    }

    const cellRow = await getCell(pool, cell.cellId);
    if (!cellRow) {
      return reply.code(503).send({ error: "cell_row_missing" });
    }

    // Use cell.notional as default if operator omits notional fields
    const longNotional = body.pairLongNotionalUsdc ?? cell.notionalUsdc;
    const shortNotional = body.pairShortNotionalUsdc ?? cell.notionalUsdc;

    // Idempotency on the test pair ID
    const existing = await getPositionByPairId(pool, body.foxifyPairId);
    if (existing && existing.status === "active") {
      return reply.code(200).send({
        positionId: existing.id,
        status: existing.status,
        idempotent: true,
        note: "test pair already active"
      });
    }

    // Run only the financial guards (skip anti-bot since this is admin action)
    const metrics = await readSalvageMetrics(pool);
    const totalActiveLiability = await sumActivePayoutLiability(pool);
    let currentDvolForGuard = 0;
    let regime: VolRegime | null = null;
    try {
      const status = await getCurrentRegime();
      currentDvolForGuard = status.dvol ?? 0;
      regime = classifyVolumeCoverRegime(status.dvol);
      if (!regime) regime = translatePilotRegime(status.regime);
    } catch (err) {
      req.log.warn(`[volume-cover/test-activate] regime fetch failed: ${(err as Error).message}`);
    }
    const guardVerdict = checkAllGuardsForVolumeCoverActivate({
      foxifyPoolBalanceUsdc: 0,
      totalActivePayoutLiabilityUsdc: totalActiveLiability,
      newPayoutLiabilityUsdc: cell.payoutUsdc,
      dbTrackedAtticusBalanceUsdc: null,
      venueReportedAtticusBalanceUsdc: null,
      currentDvol: currentDvolForGuard,
      lastDvolThresholdCrossingMs: null,
      bullishHealth: { recent5xxRate: 0, recentP95LatencyMs: 0, sampleCount: 0 },
      todayPremiumIncomeUsdc: 0,
      rollingAvgPremiumIncomeUsdc: 0,
      rolling7dayAtticusLossUsdc: metrics.rolling7dayAtticusLossUsdc,
      rolling5TriggerSalvagePct: metrics.rolling5TriggerSalvagePct,
      rolling5TriggerSampleCount: metrics.rolling5TriggerSampleCount,
      rolling24hTriggerCount: metrics.rolling24hTriggerCount
    });
    if (!guardVerdict.allowed) {
      return reply.code(403).send({
        error: "guardrail_blocked",
        reason: guardVerdict.reason,
        message: guardVerdict.message,
        details: guardVerdict.details
      });
    }

    // Premium: caller override OR matrix base (regime overlay still applies
    // unless operator explicitly overrides).
    const dailyPremium =
      body.premiumOverrideUsdc !== undefined
        ? body.premiumOverrideUsdc
        : resolveDailyPremium({
            cell,
            dbOverrideDailyPremiumUsdc: cellRow.dailyPremiumUsdc,
            regime
          }).dailyPremiumUsdc;

    try {
      const result = await openPosition(pool, opts.hedgeExecutor, {
        cell,
        foxifyPairId: body.foxifyPairId,
        pairLongNotionalUsdc: longNotional,
        pairShortNotionalUsdc: shortNotional,
        pairEntryBtcPrice: body.pairEntryBtcPrice,
        effectiveDailyPremiumUsdc: dailyPremium,
        regime,
        // No fingerprint = no anti-bot, no ladder netting (intentional for test)
        fingerprintHash: null,
        metadata: {
          source: "admin_test_activate",
          requestIp: req.ip,
          regime,
          premiumOverrideUsdc: body.premiumOverrideUsdc ?? null
        }
      });

      return reply.code(201).send({
        positionId: result.position.id,
        status: result.position.status,
        cellId: cell.cellId,
        triggerHighBtc: result.position.triggerHighBtc,
        triggerLowBtc: result.position.triggerLowBtc,
        dailyPremiumUsdc: dailyPremium,
        payoutUsdc: cell.payoutUsdc,
        hedgeLegs: result.hedgeLegs.map((l) => ({
          id: l.id,
          venue: l.venue,
          optionKind: l.optionKind,
          strikeUsdc: l.strikeUsdc,
          contractsBtc: l.contracts,
          buyPriceUsdc: l.buyPriceUsdc
        })),
        totalHedgeCostUsdc: result.totalHedgeCostUsdc,
        regime,
        note: "OPERATOR TEST ACTIVATION — real venue hedge purchased. Use POST /admin/positions/:id/close to close."
      });
    } catch (err) {
      req.log.error(`[volume-cover/test-activate] failed: ${(err as Error).message}`);
      return reply.code(500).send({
        error: "test_activate_failed",
        message: (err as Error).message
      });
    }
  });
};

// ────────────────────── Markdown dashboard ──────────────────────

const renderDashboardMarkdown = (report: Awaited<ReturnType<typeof buildFoxifyDailyReport>>): string => {
  const cellTable = report.cellsStatus
    .map(
      (c) =>
        `| ${c.cellId} | ${c.enabled ? "✅" : "❌"} | ${c.openedToday}/${c.throttleMaxPerDay} | ${c.activeNow} | $${c.dailyPremiumUsdc} | $${c.payoutUsdc} |`
    )
    .join("\n");
  const guardsTable = report.guardrailsActive.length === 0
    ? "_All guards green._"
    : report.guardrailsActive.map((g) => `- **${g.name}**: ${g.reason}`).join("\n");
  return `# Volume Cover Dashboard — ${report.reportDate}

_Generated ${report.reportGeneratedAt}_

## Today
- Positions opened: **${report.positionsOpenedToday}**
- Positions triggered: **${report.positionsTriggeredToday}**
- Positions closed: **${report.positionsClosedToday}**
- Active at EOD: **${report.positionsActiveAtEod}**
- Premium billed to Foxify: **$${report.totalPremiumBilledToFoxifyUsdc.toFixed(2)}**
- Payouts owed to Foxify: **$${report.totalPayoutsOwedToFoxifyUsdc.toFixed(2)}**
- Atticus P&L today: **$${report.atticusPnlTodayUsdc.toFixed(2)}**
- Atticus P&L 7-day rolling: **$${report.atticusPnl7dayRollingUsdc.toFixed(2)}**

## Salvage stats (rolling 5 triggers)
- Trigger count: ${report.salvageStatsRolling5.triggerCount}
- Avg salvage: ${report.salvageStatsRolling5.avgSalvagePct === null ? "n/a" : (report.salvageStatsRolling5.avgSalvagePct * 100).toFixed(1) + "%"}
- State: **${report.salvageStatsRolling5.state.toUpperCase()}**

## Settlement schedule
- Next weekly: ${report.weeklySettlementDueIso}
- Next monthly: ${report.monthlySettlementDueIso}

## Cells
| Cell | Enabled | Opened/Cap | Active | Premium/day | Payout |
|------|---------|------------|--------|-------------|--------|
${cellTable}

## Active guardrails
${guardsTable}
`;
};

// ────────────────────── Test helpers ──────────────────────

export const __resetVolumeCoverRoutesForTests = (): void => {
  __resetVolumeCoverGuardrailsForTests();
};
