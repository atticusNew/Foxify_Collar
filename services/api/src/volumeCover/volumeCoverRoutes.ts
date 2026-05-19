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
  computePairEventLatencyStats,
  finalizeSalvageProceedsForPosition
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

  /**
   * Inspect Bullish ECDSA credentials for the OPERATOR to debug config
   * issues without shell access. Returns SAFE metadata only — never
   * the raw key material:
   *   - publicKey/privateKey: { present, beginLabel, endLabel, bodyLength,
   *                              invalidBodyCharCount, parses, parseError }
   *   - metadataUserIdPresent: true if ECDSA_METADATA decodes to a userId
   *   - environment: testnet/mainnet inferred from REST URL
   *
   * Use cases:
   *   - "Did I paste the \\n correctly?" → bodyLength + parses tells you
   *   - "Are my keys present at all?" → present field
   *   - "Wrong PEM format?" → beginLabel + parseError
   *   - "Wrong environment?" → environment + restBaseUrl
   */
  /**
   * Direct login-test endpoint. Performs the actual Bullish ECDSA
   * login flow and returns the raw response (success OR error).
   *
   * Use this to see the EXACT Bullish-side response, bypassing all
   * our wrapping. Helpful for debugging USER_NOT_EXISTS-style errors
   * where the keys parse fine but Bullish rejects the identity.
   *
   * SAFE: never returns the raw private key, only the request payload
   * (which is non-sensitive — userId + timestamps).
   */
  app.post("/volume-cover/admin/bullish-login-test", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const { createSign } = await import("node:crypto");
    const {
      parseBullishPrivateKey,
      parseBullishPublicKey
    } = await import("../pilot/bullish").then((m) => ({
      // These aren't directly exported; we need to use BullishTradingClient.
      parseBullishPrivateKey: null as any,
      parseBullishPublicKey: null as any
    }));

    // Use the BullishTradingClient.loginWithEcdsa directly via reflection.
    // Easier: just build and send the request manually here so we can
    // capture the raw response.
    const restBaseUrl = pilotConfig.bullish.restBaseUrl;
    const loginPath = pilotConfig.bullish.ecdsaLoginPath || "/trading-api/v2/users/login";
    const ecdsaPublicKey = String(process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || "").trim();
    const ecdsaPrivateKey = String(process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || "").trim();
    const ecdsaMetadata = String(process.env.PILOT_BULLISH_ECDSA_METADATA || "").trim();

    if (!ecdsaPublicKey || !ecdsaPrivateKey || !ecdsaMetadata) {
      return reply.code(400).send({
        ok: false,
        reason: "credentials_missing",
        details: {
          publicKeyPresent: Boolean(ecdsaPublicKey),
          privateKeyPresent: Boolean(ecdsaPrivateKey),
          metadataPresent: Boolean(ecdsaMetadata)
        }
      });
    }

    // Decode userId from metadata
    let userId: string | null = null;
    let metadataDecoded: Record<string, unknown> = {};
    try {
      const decoded = Buffer.from(ecdsaMetadata, "base64").toString("utf8");
      metadataDecoded = JSON.parse(decoded);
      userId = String((metadataDecoded as any).userId || "");
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        reason: "metadata_decode_failed",
        message: (err as Error).message
      });
    }
    if (!userId) {
      return reply.code(400).send({ ok: false, reason: "userId_missing_in_metadata" });
    }

    // Normalize private key (handle \n escapes etc.)
    const normPriv = (() => {
      const withoutQuotes =
        (ecdsaPrivateKey.startsWith("'") && ecdsaPrivateKey.endsWith("'")) ||
        (ecdsaPrivateKey.startsWith('"') && ecdsaPrivateKey.endsWith('"'))
          ? ecdsaPrivateKey.slice(1, -1)
          : ecdsaPrivateKey;
      return withoutQuotes.replace(/\\n/g, "\n").trim();
    })();
    const normPub = (() => {
      const withoutQuotes =
        (ecdsaPublicKey.startsWith("'") && ecdsaPublicKey.endsWith("'")) ||
        (ecdsaPublicKey.startsWith('"') && ecdsaPublicKey.endsWith('"'))
          ? ecdsaPublicKey.slice(1, -1)
          : ecdsaPublicKey;
      return withoutQuotes.replace(/\\n/g, "\n").trim();
    })();

    // Build + sign login payload
    const nowSeconds = Math.floor(Date.now() / 1000);
    const loginPayload = {
      userId,
      nonce: nowSeconds,
      expirationTime: nowSeconds + 300,
      biometricsUsed: false,
      sessionKey: null
    };
    const loginPayloadJson = JSON.stringify(loginPayload);
    let signatureB64: string;
    try {
      const signer = createSign("sha256");
      signer.update(loginPayloadJson);
      signer.end();
      signatureB64 = signer.sign(normPriv).toString("base64");
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        reason: "signing_failed",
        message: (err as Error).message
      });
    }

    // POST to Bullish login
    const url = new URL(loginPath, restBaseUrl).toString();
    const body = JSON.stringify({
      publicKey: normPub,
      signature: signatureB64,
      loginPayload
    });

    let status = 0;
    let rawText = "";
    let bullishHeaders: Record<string, string> = {};
    let networkError: string | null = null;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body
      });
      status = resp.status;
      rawText = await resp.text();
      bullishHeaders = Object.fromEntries(resp.headers.entries());
    } catch (err) {
      networkError = (err as Error).message;
    }

    let rawJson: any = null;
    try {
      rawJson = rawText ? JSON.parse(rawText) : null;
    } catch {
      rawJson = null;
    }

    return reply.send({
      ok: status >= 200 && status < 300,
      request: {
        url,
        method: "POST",
        loginPayload, // safe: contains userId + timestamps only
        signatureB64Length: signatureB64.length,
        publicKeyLength: normPub.length
      },
      response: {
        status,
        networkError,
        bullishHeaders,
        rawText: rawText.length > 2000 ? rawText.slice(0, 2000) + "...[truncated]" : rawText,
        parsedJson: rawJson
      },
      metadata: {
        decodedUserId: userId,
        decodedCredentialId: (metadataDecoded as any).credentialId ?? null,
        embeddedPublicKeyPresent: Boolean((metadataDecoded as any).publicKey),
        embeddedPublicKeyMatchesEnv:
          (metadataDecoded as any).publicKey
            ? String((metadataDecoded as any).publicKey).replace(/\s+/g, "") ===
              normPub.replace(/\s+/g, "")
            : null
      }
    });
  });

  /**
   * Bullish option-chain feasibility analyzer for pilot cells.
   *
   * Operator-facing diagnostic: given current spot from spotSource(),
   * computes target hedge strikes for each MATRIX cell and checks
   * whether Bullish's actual option chain has strikes close enough
   * to make the hedge work.
   *
   * Required strike proximity: hedge strikes must be CLOSER to spot
   * than the trigger boundary, otherwise the option will not be ITM
   * when the trigger fires (defeating the hedge).
   *
   *   For cell with hedgePct=0.01, triggerPct=0.02, spot $77000:
   *     target put strike = spot × (1 - hedgePct) = $76,230
   *     trigger low       = spot × (1 - triggerPct) = $75,460
   *     hedge zone        = strikes in [$75,460, $77,000) for put leg
   *     viable strike     = closest Bullish put strike inside that zone
   *
   * Returns per-cell:
   *   - target put/call strikes
   *   - trigger boundaries
   *   - nearest Bullish strikes within the cell's expiry window
   *   - viability flag (true if a strike exists within the hedge zone)
   *   - reason if not viable
   *
   * Filters Bullish markets by:
   *   - underlyingBaseSymbol === 'BTC'
   *   - quote symbol USDC
   *   - expiry within (now, now + 30 days]
   *   - marketEnabled && createOrderEnabled
   */
  app.get("/volume-cover/admin/bullish-option-chain", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    let spot: number | null = null;
    try {
      const s = await opts.spotSource();
      spot = s.spotBtcPrice;
    } catch (err) {
      return reply.code(503).send({
        error: "spot_unavailable",
        message: (err as Error).message
      });
    }
    if (!spot || spot <= 0) {
      return reply.code(503).send({ error: "spot_invalid", spot });
    }

    // Pull markets from Bullish (60s cache inside client).
    const { BullishTradingClient } = await import("../pilot/bullish");
    const client = new BullishTradingClient(pilotConfig.bullish);
    let markets: any[] = [];
    try {
      markets = await client.getMarkets({ cacheTtlMs: 60_000 });
    } catch (err) {
      return reply.code(502).send({
        error: "bullish_markets_fetch_failed",
        message: (err as Error).message
      });
    }

    // Filter to BTC options, enabled, in the next 30 days
    const nowMs = Date.now();
    const horizon30dMs = nowMs + 30 * 24 * 3600_000;
    const btcOptions = markets
      .filter((m) => (m.underlyingBaseSymbol ?? "").toUpperCase() === "BTC")
      .filter((m) => Boolean(m.optionType) && Boolean(m.optionStrikePrice) && Boolean(m.expiryDatetime))
      .filter((m) => m.marketEnabled && m.createOrderEnabled)
      .map((m) => ({
        symbol: String(m.symbol ?? ""),
        optionType: String(m.optionType).toUpperCase(),
        strike: Number(m.optionStrikePrice),
        expiryIso: String(m.expiryDatetime),
        expiryMs: new Date(String(m.expiryDatetime)).getTime()
      }))
      .filter((m) => Number.isFinite(m.strike) && m.strike > 0)
      .filter((m) => m.expiryMs > nowMs && m.expiryMs <= horizon30dMs);

    // Group by expiry → strikes
    const byExpiry: Record<
      string,
      { puts: number[]; calls: number[]; expiryMs: number; daysOut: number }
    > = {};
    for (const m of btcOptions) {
      const dayKey = new Date(m.expiryMs).toISOString().slice(0, 10);
      if (!byExpiry[dayKey]) {
        byExpiry[dayKey] = {
          puts: [],
          calls: [],
          expiryMs: m.expiryMs,
          daysOut: Math.round((m.expiryMs - nowMs) / 86_400_000)
        };
      }
      if (m.optionType === "PUT") byExpiry[dayKey].puts.push(m.strike);
      else if (m.optionType === "CALL") byExpiry[dayKey].calls.push(m.strike);
    }
    for (const k of Object.keys(byExpiry)) {
      byExpiry[k].puts = [...new Set(byExpiry[k].puts)].sort((a, b) => a - b);
      byExpiry[k].calls = [...new Set(byExpiry[k].calls)].sort((a, b) => a - b);
    }

    // Per-cell viability analysis. Pick the FIRST expiry >= 7 days out
    // (matches typical pilot cell tenor; tightHedge picks 14d but we
    // want any nearby for analysis purposes).
    const expiries = Object.entries(byExpiry).sort(
      ([, a], [, b]) => a.expiryMs - b.expiryMs
    );

    const { MATRIX } = await import("./matrix");
    const cellAnalysis = MATRIX.map((cell) => {
      const targetPutStrike = spot! * (1 - cell.hedgePct);
      const targetCallStrike = spot! * (1 + cell.hedgePct);
      const triggerLow = spot! * (1 - cell.triggerPct);
      const triggerHigh = spot! * (1 + cell.triggerPct);

      // Hedge zone: strike must be inside (triggerBoundary, spot) so
      // option is ITM when trigger fires.
      // Put zone: [triggerLow, spot)
      // Call zone: (spot, triggerHigh]
      const putZoneMin = triggerLow;
      const putZoneMax = spot!;
      const callZoneMin = spot!;
      const callZoneMax = triggerHigh;

      // Try each expiry, find the first one where BOTH legs have a
      // viable strike.
      const expiryAnalyses = expiries.map(([dayKey, ex]) => {
        const putsInZone = ex.puts.filter((s) => s > putZoneMin && s < putZoneMax);
        const callsInZone = ex.calls.filter((s) => s > callZoneMin && s < callZoneMax);
        const closestPut =
          ex.puts.length > 0
            ? ex.puts.reduce(
                (best, s) =>
                  Math.abs(s - targetPutStrike) < Math.abs(best - targetPutStrike) ? s : best,
                ex.puts[0]
              )
            : null;
        const closestCall =
          ex.calls.length > 0
            ? ex.calls.reduce(
                (best, s) =>
                  Math.abs(s - targetCallStrike) < Math.abs(best - targetCallStrike) ? s : best,
                ex.calls[0]
              )
            : null;
        return {
          expiryDate: dayKey,
          daysOut: ex.daysOut,
          totalPuts: ex.puts.length,
          totalCalls: ex.calls.length,
          putsInHedgeZone: putsInZone,
          callsInHedgeZone: callsInZone,
          closestPutStrike: closestPut,
          closestCallStrike: closestCall,
          closestPutDistanceFromTargetPct:
            closestPut !== null
              ? Math.abs(closestPut - targetPutStrike) / targetPutStrike
              : null,
          closestCallDistanceFromTargetPct:
            closestCall !== null
              ? Math.abs(closestCall - targetCallStrike) / targetCallStrike
              : null,
          viable: putsInZone.length > 0 && callsInZone.length > 0
        };
      });

      const firstViableExpiry = expiryAnalyses.find((e) => e.viable);
      const minHedgeWindowUsdc = spot! * cell.hedgePct;
      const triggerWindowUsdc = spot! * cell.triggerPct;

      return {
        cellId: cell.cellId,
        notionalUsdc: cell.notionalUsdc,
        triggerPct: cell.triggerPct,
        hedgePct: cell.hedgePct,
        payoutUsdc: cell.payoutUsdc,
        targetPutStrike: Number(targetPutStrike.toFixed(0)),
        targetCallStrike: Number(targetCallStrike.toFixed(0)),
        triggerLow: Number(triggerLow.toFixed(0)),
        triggerHigh: Number(triggerHigh.toFixed(0)),
        hedgeWindowWidthUsdc: Number(minHedgeWindowUsdc.toFixed(0)),
        triggerWindowWidthUsdc: Number(triggerWindowUsdc.toFixed(0)),
        viable: Boolean(firstViableExpiry),
        firstViableExpiry: firstViableExpiry
          ? {
              expiry: firstViableExpiry.expiryDate,
              daysOut: firstViableExpiry.daysOut,
              putStrike: firstViableExpiry.putsInHedgeZone[0],
              callStrike: firstViableExpiry.callsInHedgeZone[0]
            }
          : null,
        reason: firstViableExpiry
          ? "viable"
          : "no_expiry_with_both_legs_in_hedge_zone",
        perExpiry: expiryAnalyses
      };
    });

    return reply.send({
      generatedAtIso: new Date().toISOString(),
      spotBtcUsdc: spot,
      bullishMainnet: pilotConfig.bullish.restBaseUrl.includes("bullish.com"),
      totalBtcOptionMarkets: btcOptions.length,
      expiriesInWindow: Object.keys(byExpiry).sort(),
      cellAnalysis
    });
  });

  /**
   * Bullish order status checker — given an orderId, fetches the
   * current state from Bullish and returns the raw response.
   *
   * Operator diagnostic for orders that were submitted but failed
   * to fill silently (no poll loop ran, GTC pending, rejected by
   * venue with reason buried in API response).
   *
   * Usage: GET /admin/bullish-order-status?orderId=976611473429627905
   */
  app.get("/volume-cover/admin/bullish-order-status", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const orderId = String((req.query as any)?.orderId ?? "").trim();
    if (!orderId) {
      return reply.code(400).send({ error: "missing_orderId_param" });
    }
    const { BullishTradingClient } = await import("../pilot/bullish");
    const client = new BullishTradingClient(pilotConfig.bullish);
    try {
      const status = await client.getOrderStatus(orderId);
      return reply.send({
        orderId,
        bullishStatus: status.status,
        fillPrice: status.fillPrice,
        fillQuantity: status.fillQuantity,
        fees: status.fees,
        rawBullishResponse: status.raw
      });
    } catch (err) {
      return reply.code(502).send({
        error: "bullish_order_status_fetch_failed",
        orderId,
        message: (err as Error).message
      });
    }
  });

  /**
   * Deribit auth + account snapshot. Diagnostic for live Deribit
   * pivot — verifies DERIBIT_CLIENT_ID/SECRET work against the
   * configured DERIBIT_ENV (live vs testnet) and returns the
   * account summary (balance, equity, margin info).
   *
   * Use case: confirm Deribit credentials are accepted before
   * routing real-money orders through Deribit primary.
   *
   * Returns:
   *   - env: from DERIBIT_ENV
   *   - paper: from DERIBIT_PAPER
   *   - credentialsConfigured: bool
   *   - authOk: bool (whether getAccountSummary succeeded)
   *   - accountSummary: raw Deribit response (balance, equity, etc.)
   *     OR error message if auth failed
   */
  app.get("/volume-cover/admin/deribit-auth-test", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const env = String(process.env.DERIBIT_ENV || "live").trim();
    const paperRaw = String(process.env.DERIBIT_PAPER || "true").trim().toLowerCase();
    const credentialsConfigured = Boolean(
      String(process.env.DERIBIT_CLIENT_ID || "").trim() &&
        String(process.env.DERIBIT_CLIENT_SECRET || "").trim() &&
        String(process.env.DERIBIT_CLIENT_ID || "").trim() !== "placeholder" &&
        String(process.env.DERIBIT_CLIENT_SECRET || "").trim() !== "placeholder"
    );

    if (!credentialsConfigured) {
      return reply.send({
        env,
        paper: paperRaw,
        credentialsConfigured: false,
        authOk: false,
        message:
          "DERIBIT_CLIENT_ID/SECRET not configured (or set to 'placeholder'). " +
          "Set real Deribit API credentials in Render env to enable auth + execution."
      });
    }

    // Use the main `deribit` instance which is wired with env creds.
    // We can't directly access it from here; instead, build a fresh
    // connector with the same env config for this test.
    let authOk = false;
    let accountSummaryRaw: any = null;
    let authError: string | null = null;
    try {
      const { DeribitConnector } = await import("@foxify/connectors");
      const testConnector = new DeribitConnector(
        env === "live" ? "live" : "testnet",
        paperRaw === "true",
        {
          clientId: String(process.env.DERIBIT_CLIENT_ID || ""),
          clientSecret: String(process.env.DERIBIT_CLIENT_SECRET || "")
        }
      );
      const summary = await testConnector.getAccountSummary("BTC");
      accountSummaryRaw = summary;
      authOk = true;
    } catch (err) {
      authError = (err as Error).message;
      authOk = false;
    }

    return reply.send({
      env,
      paper: paperRaw,
      credentialsConfigured: true,
      authOk,
      authError,
      accountSummary: accountSummaryRaw,
      note:
        env === "live" && paperRaw === "false"
          ? "READY for live execution (env=live, paper=false, creds present)"
          : env !== "live"
          ? `WARNING: env=${env} (not 'live') — orders will route to testnet`
          : paperRaw === "true"
          ? "WARNING: paper=true — orders will be SIMULATED (synthetic fills, not real)"
          : ""
    });
  });

  /**
   * Cleanup phantom retained legs from Bullish-rejected activations.
   *
   * Operator-driven cleanup of DB pollution caused by the silent
   * Bullish-margin-not-enabled rejection bug. Those orders went to
   * Bullish, came back as 'Command acknowledged' but were rejected
   * during validation — yet our system recorded the legs as 'open'
   * + 'retained=true' as if they were real holdings.
   *
   * This endpoint marks all retained Bullish legs as cancelled.
   * SAFE: Bullish never actually filled any of them (verified via
   * Bullish UI — no positions ever held). The DB rows are pure
   * artifacts.
   *
   * Does NOT touch Deribit retained legs (those are real).
   *
   * Usage:
   *   POST /admin/cleanup-bullish-phantom-legs            (dryRun=true by default)
   *   POST /admin/cleanup-bullish-phantom-legs?confirm=true  (actually marks)
   */
  app.post("/volume-cover/admin/cleanup-bullish-phantom-legs", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const confirm = String((req.query as any)?.confirm ?? "false").toLowerCase() === "true";

    const result = await pool.query(
      `SELECT id, position_id, venue, option_kind, strike_usdc, retained, retained_role, retained_at, status
         FROM volume_cover_hedge_leg
        WHERE venue = 'bullish'
          AND retained = TRUE
          AND status = 'open'`
    );
    const phantoms = result.rows.map((r: any) => ({
      legId: String(r.id),
      positionId: String(r.position_id),
      venue: String(r.venue),
      optionKind: String(r.option_kind),
      strikeUsdc: Number(r.strike_usdc),
      retainedRole: r.retained_role ? String(r.retained_role) : null,
      retainedAt: r.retained_at ? String(r.retained_at) : null
    }));

    if (!confirm) {
      return reply.send({
        dryRun: true,
        phantomCount: phantoms.length,
        phantoms,
        note:
          "Dry run — no rows changed. Re-call with ?confirm=true to mark these legs as cancelled."
      });
    }

    // Status MUST be 'failed' (not 'cancelled') to satisfy
    // volume_cover_hedge_leg_status_check (open|sold|expired|failed).
    // 'failed' is the correct domain value for legs that never
    // actually filled at the venue — distinct from 'sold' (active
    // unwind) and 'expired' (option matured worthless).
    let cancelled = 0;
    for (const p of phantoms) {
      await pool.query(
        `UPDATE volume_cover_hedge_leg
            SET status = 'failed',
                closed_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [
          p.legId,
          JSON.stringify({
            phantom_cleanup: true,
            phantom_cleanup_reason: "bullish_never_filled_silent_rejection",
            phantom_cleanup_at: new Date().toISOString()
          })
        ]
      );
      cancelled++;
    }

    return reply.send({
      dryRun: false,
      phantomCount: phantoms.length,
      cancelled,
      message: `Marked ${cancelled} Bullish phantom retained legs as status=failed.`
    });
  });

  /**
   * Force-sell a specific retained leg via the venue adapter,
   * bypassing the hedge manager's TP curve. Operator-driven; useful
   * for testing the sell path or for manual unwind decisions.
   *
   * Updates DB on success: status='closed', sell_price_usdc populated,
   * sell_order_id populated.
   *
   * Usage:
   *   POST /admin/force-sell-leg/:legId
   */
  app.post("/volume-cover/admin/force-sell-leg/:legId", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const legId = String((req.params as any)?.legId ?? "").trim();
    if (!legId) return reply.code(400).send({ error: "missing_legId_param" });

    const r = await pool.query(
      `SELECT id, position_id, venue, option_kind, strike_usdc, expiry_iso, contracts, status, retained
         FROM volume_cover_hedge_leg
        WHERE id = $1`,
      [legId]
    );
    if (r.rows.length === 0) {
      return reply.code(404).send({ error: "leg_not_found", legId });
    }
    const leg = r.rows[0];
    if (String(leg.status) !== "open") {
      return reply.code(409).send({
        error: "leg_not_sellable",
        currentStatus: String(leg.status),
        message: "Leg is not in 'open' status. Already sold, cancelled, or expired."
      });
    }

    const venue = String(leg.venue) as "bullish" | "deribit";
    const optionKind = String(leg.option_kind) as "put" | "call";
    const strikeUsdc = Number(leg.strike_usdc);
    const expiryIso = String(leg.expiry_iso);
    const contractsBtc = Number(leg.contracts);

    let sellResult: any = null;
    try {
      sellResult = await opts.hedgeExecutor.sellOptionLeg({
        venue,
        optionKind,
        strikeUsdc,
        expiryIso,
        contractsBtc
      });
    } catch (err) {
      return reply.code(502).send({
        error: "sell_failed",
        legId,
        venue,
        message: (err as Error).message
      });
    }

    // Mark sold in DB. Status MUST be 'sold' (not 'closed') to satisfy
    // volume_cover_hedge_leg_status_check (open|sold|expired|failed).
    // Matches the hedge-manager TP path which uses markHedgeLegSold.
    await pool.query(
      `UPDATE volume_cover_hedge_leg
          SET status = 'sold',
              sell_price_usdc = $2,
              sell_order_id = $3,
              closed_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
        WHERE id = $1`,
      [
        legId,
        sellResult.fillPriceUsdcPerBtc,
        sellResult.orderId,
        JSON.stringify({
          force_sell: true,
          force_sell_at: new Date().toISOString(),
          force_sell_total_proceeds_usdc: sellResult.totalProceedsUsdc
        })
      ]
    );

    // If this leg belongs to a triggered position, finalize that
    // position's salvage_event so Guard A (7d loss) and Guard B
    // (rolling salvage %) reflect realized proceeds.
    const positionId = String(leg.position_id ?? "");
    let salvageFinalized: boolean | null = null;
    if (positionId) {
      try {
        const finalized = await finalizeSalvageProceedsForPosition(pool, {
          positionId,
          proceedsUsdcDelta: sellResult.totalProceedsUsdc,
          legId
        });
        salvageFinalized = finalized !== null;
      } catch (err) {
        req.log.warn(
          `[volume-cover/force-sell-leg] salvage finalize failed for leg ${legId}: ${(err as Error).message}`
        );
        salvageFinalized = false;
      }
    }

    return reply.send({
      success: true,
      legId,
      venue,
      optionKind,
      strikeUsdc,
      contractsBtc,
      fillPriceUsdcPerBtc: sellResult.fillPriceUsdcPerBtc,
      totalProceedsUsdc: sellResult.totalProceedsUsdc,
      orderId: sellResult.orderId,
      salvageFinalized
    });
  });

  /**
   * Recovery endpoint — manually mark an open leg as sold when the
   * venue side already filled but the DB write failed (e.g., the
   * pre-2026-05-19 'closed'-vs-'sold' CHECK constraint regression).
   *
   * Does NOT touch any venue; this is purely a DB reconciliation
   * action. Use ONLY when you have verified the venue position is
   * already flat (e.g., via Deribit web UI). Includes audit
   * metadata so the action is traceable.
   *
   * Body:
   *   {
   *     "fillPriceUsdcPerBtc": <number>,    // from logs / Deribit fill confirmation
   *     "totalProceedsUsdc": <number>,
   *     "orderId": "<venue-order-id>",
   *     "reason": "<human-readable reason>"
   *   }
   *
   * Also finalizes the position's salvage_event (Guard A/B truth).
   */
  app.post("/volume-cover/admin/mark-leg-sold-manual/:legId", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const legId = String((req.params as any)?.legId ?? "").trim();
    if (!legId) return reply.code(400).send({ error: "missing_legId_param" });

    const ManualSoldSchema = z.object({
      fillPriceUsdcPerBtc: z.number().nonnegative().finite(),
      totalProceedsUsdc: z.number().nonnegative().finite(),
      orderId: z.string().min(1).max(256),
      reason: z.string().min(1).max(512)
    });
    const parse = ManualSoldSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const lookup = await pool.query(
      `SELECT id, position_id, venue, option_kind, strike_usdc, contracts, status
         FROM volume_cover_hedge_leg
        WHERE id = $1`,
      [legId]
    );
    if (lookup.rows.length === 0) {
      return reply.code(404).send({ error: "leg_not_found", legId });
    }
    const leg = lookup.rows[0];
    if (String(leg.status) !== "open") {
      return reply.code(409).send({
        error: "leg_not_open",
        currentStatus: String(leg.status),
        message: "Leg is not 'open'; manual sold mark only valid for open legs."
      });
    }

    await pool.query(
      `UPDATE volume_cover_hedge_leg
          SET status = 'sold',
              sell_price_usdc = $2,
              sell_order_id = $3,
              closed_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
        WHERE id = $1`,
      [
        legId,
        body.fillPriceUsdcPerBtc,
        body.orderId,
        JSON.stringify({
          manual_sold_mark: true,
          manual_sold_at: new Date().toISOString(),
          manual_sold_reason: body.reason,
          manual_sold_total_proceeds_usdc: body.totalProceedsUsdc
        })
      ]
    );

    let salvageFinalized: boolean | null = null;
    const positionId = String(leg.position_id ?? "");
    if (positionId) {
      try {
        const finalized = await finalizeSalvageProceedsForPosition(pool, {
          positionId,
          proceedsUsdcDelta: body.totalProceedsUsdc,
          legId
        });
        salvageFinalized = finalized !== null;
      } catch (err) {
        req.log.warn(
          `[volume-cover/mark-leg-sold-manual] salvage finalize failed for leg ${legId}: ${(err as Error).message}`
        );
        salvageFinalized = false;
      }
    }

    return reply.send({
      success: true,
      legId,
      positionId,
      venue: String(leg.venue),
      optionKind: String(leg.option_kind),
      strikeUsdc: Number(leg.strike_usdc),
      contractsBtc: Number(leg.contracts),
      fillPriceUsdcPerBtc: body.fillPriceUsdcPerBtc,
      totalProceedsUsdc: body.totalProceedsUsdc,
      orderId: body.orderId,
      reason: body.reason,
      salvageFinalized
    });
  });

  app.get("/volume-cover/admin/bullish-key-check", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const { inspectBullishEcdsaKeyMaterial } = await import("../pilot/bullish");
    const inspection = inspectBullishEcdsaKeyMaterial({
      publicKey: String(process.env.PILOT_BULLISH_ECDSA_PUBLIC_KEY || ""),
      privateKey: String(process.env.PILOT_BULLISH_ECDSA_PRIVATE_KEY || ""),
      metadata: String(process.env.PILOT_BULLISH_ECDSA_METADATA || "")
    });
    const tradingAccountIdSet = Boolean(
      String(process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || "").trim()
    );
    return reply.send({
      generatedAtIso: new Date().toISOString(),
      environment: pilotConfig.bullish.restBaseUrl.includes("bullish-test.com")
        ? "testnet"
        : pilotConfig.bullish.restBaseUrl.includes("bullish.com")
        ? "mainnet"
        : "unknown",
      restBaseUrl: pilotConfig.bullish.restBaseUrl,
      bullishEnabled: pilotConfig.bullish.enabled,
      authMode: pilotConfig.bullish.authMode,
      tradingAccountIdSet,
      tradingAccountIdLength: String(
        process.env.PILOT_BULLISH_TRADING_ACCOUNT_ID || ""
      ).trim().length,
      ...inspection
    });
  });

  /**
   * Bullish spot conversion — operator-driven rebalance of capital
   * between BTC and USDC on Bullish. Used for ongoing pilot ops:
   *   - Fund USDC for option premium when capital arrives as BTC
   *   - Convert excess USDC to BTC for hedging at venue
   *   - General portfolio rebalancing within the Bullish account
   *
   * Default behavior is SAFE LIMIT ORDER:
   *   - Computes a price within slippageBps of best bid/ask
   *   - Submits LIMIT order (not market) so fill price is bounded
   *   - Polls order status for up to 8s to confirm fill
   *   - Returns order ID + fill details
   *
   * Safety bounds (refuse to execute if violated):
   *   - Symbol allowlist: BTCUSDC only (block accidental cross-pair)
   *   - Side: BUY or SELL only
   *   - Max notional per call: $5000 USDC (block accidental drain)
   *   - dryRun=true returns the planned order without submitting
   *
   * Auth: admin token. Logged to volume_cover_foxify_access table
   * (slight repurpose — captures all venue-fund-touching admin
   * actions, not just Foxify dashboard access).
   */
  const SpotConvertSchema = z.object({
    side: z.enum(["BUY", "SELL"]),
    symbol: z.string().default("BTCUSDC"),
    quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
    slippageBps: z.number().int().min(0).max(500).default(50),
    dryRun: z.boolean().default(false),
    clientOrderId: z.string().max(64).optional()
  });

  app.post("/volume-cover/admin/bullish-spot-convert", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const parse = SpotConvertSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    // Symbol allowlist (block accidental cross-pair operations).
    const ALLOWED_SYMBOLS = ["BTCUSDC"];
    if (!ALLOWED_SYMBOLS.includes(body.symbol)) {
      return reply.code(400).send({
        error: "symbol_not_allowed",
        symbol: body.symbol,
        allowed: ALLOWED_SYMBOLS
      });
    }

    // Quantity must be positive number string.
    const qty = Number(body.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return reply.code(400).send({ error: "invalid_quantity", quantity: body.quantity });
    }

    const { BullishTradingClient } = await import("../pilot/bullish");
    const client = new BullishTradingClient(pilotConfig.bullish);

    // Step 1: get reference price for limit computation.
    //
    // PRIMARY SOURCE: opts.spotSource() — this is the same cached
    // hybrid-orderbook spot we use for trigger evaluation, with built-
    // in TTL + Coinbase fallback. Reusing it (instead of fetching the
    // raw orderbook here) avoids hitting Bullish's per-IP rate limit
    // (errorCode 96100) when the dashboard + trigger detector are
    // already polling the orderbook on a tight cadence.
    //
    // FALLBACK: if spotSource fails, do a fresh getHybridOrderBook.
    // That's the slow path; we accept the rate-limit risk only when
    // the cached source can't serve us.
    let referencePrice: number | null = null;
    let priceSource = "unknown";
    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    let topOfBook: any = null;
    try {
      const spot = await opts.spotSource();
      referencePrice = spot.spotBtcPrice;
      priceSource = `spotSource:${spot.source}`;
    } catch {
      // spotSource failed — try direct orderbook (rate-limit risk).
      try {
        const book = await client.getHybridOrderBook(body.symbol);
        bestBid = book.bids?.[0] ? Number(book.bids[0].price) : null;
        bestAsk = book.asks?.[0] ? Number(book.asks[0].price) : null;
        topOfBook = {
          bids: (book.bids ?? []).slice(0, 3),
          asks: (book.asks ?? []).slice(0, 3)
        };
        if (bestBid && bestAsk) {
          referencePrice = (bestBid + bestAsk) / 2;
          priceSource = "orderbook_direct";
        }
      } catch (err) {
        return reply.code(503).send({
          error: "price_source_unavailable",
          message: (err as Error).message,
          note: "Both spotSource and direct orderbook fetch failed. Wait 30-60s and retry; rate limit may clear."
        });
      }
    }

    if (!referencePrice || referencePrice <= 0) {
      return reply.code(503).send({
        error: "price_source_empty",
        referencePrice,
        priceSource
      });
    }

    // Step 2: compute limit price with slippage tolerance.
    // Apply slippage to the reference (mid/spot) price:
    //   SELL: refPrice × (1 - slippage)  → we accept fills at this
    //                                       price OR HIGHER
    //   BUY:  refPrice × (1 + slippage)  → we accept fills at this
    //                                       price OR LOWER
    // Note: when using spot mid, our slippage is conservative
    // (effectively "1 + half-spread" worse than best bid/ask). For
    // BTCUSDC where the spread is typically <1bp, this is fine.
    const slippageMultiplier = body.slippageBps / 10000;
    const limitPrice =
      body.side === "SELL"
        ? referencePrice * (1 - slippageMultiplier)
        : referencePrice * (1 + slippageMultiplier);

    // Step 3: notional safety cap. For BTCUSDC at ~$77k spot, $5000
    // = ~0.065 BTC per call. Operator can do multiple calls if needed.
    const MAX_NOTIONAL_USDC = 5000;
    const notionalUsdc = qty * limitPrice;
    if (notionalUsdc > MAX_NOTIONAL_USDC) {
      return reply.code(400).send({
        error: "notional_exceeds_max",
        notionalUsdc,
        maxNotionalUsdc: MAX_NOTIONAL_USDC,
        message: "Split into multiple smaller calls or contact engineering to raise the cap."
      });
    }

    // Audit-log this venue-fund-touching admin action. Best-effort:
    // failures don't block the conversion. Reuses the foxify access
    // log table (created by foxifyDashboard.ts on boot) since it's
    // already a generic admin-action audit surface.
    void pool
      .query(
        `INSERT INTO volume_cover_foxify_access
           (method, endpoint, ip, user_agent, success, reject_reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.method.toUpperCase(),
          req.url.split("?")[0] +
            ` [side=${body.side} sym=${body.symbol} qty=${body.quantity} dryRun=${body.dryRun}]`,
          String(
            (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
              req.ip ||
              ""
          ) || null,
          String(req.headers["user-agent"] || "") || null,
          true,
          null
        ]
      )
      .catch((err) => {
        console.warn(`[VolumeCover] spot-convert audit log failed: ${(err as Error).message}`);
      });

    // Format price + quantity per Bullish requirements.
    //
    // Bullish enforces tick-size on prices (errorCode 6018
    // PRICE_MUST_BE_OF_TICK_SIZE if violated). For BTCUSDC the tick
    // is $1 (integer dollars only). We round in the SAFE direction
    // for the side being submitted:
    //   SELL: floor (further from best bid → keeps slippage bound,
    //                less likely to fill above worst-acceptable)
    //   BUY:  ceil  (further from best ask → keeps slippage bound)
    //
    // For pairs other than BTCUSDC the tick may differ; that's why
    // the symbol allowlist exists. To support new pairs, fetch the
    // tick from getMarkets() and apply per-pair rounding.
    const TICK_SIZE_BTCUSDC = 1.0;
    const tickRounded =
      body.side === "SELL"
        ? Math.floor(limitPrice / TICK_SIZE_BTCUSDC) * TICK_SIZE_BTCUSDC
        : Math.ceil(limitPrice / TICK_SIZE_BTCUSDC) * TICK_SIZE_BTCUSDC;
    const priceStr = tickRounded.toFixed(0);

    // Quantity precision: BTC step is 0.0001 typically (lot size).
    // Floor to that resolution to avoid LOT_SIZE rejection. Re-check
    // notional after floor since rounding may shift it slightly.
    const LOT_SIZE_BTC = 0.0001;
    const qtyFloored =
      Math.floor(qty / LOT_SIZE_BTC) * LOT_SIZE_BTC;
    const qtyStr = qtyFloored.toFixed(4);
    if (qtyFloored <= 0) {
      return reply.code(400).send({
        error: "quantity_below_lot_size",
        requested: qty,
        lotSizeBtc: LOT_SIZE_BTC
      });
    }

    // Step 4: dryRun short-circuit.
    if (body.dryRun) {
      return reply.send({
        dryRun: true,
        plan: {
          side: body.side,
          symbol: body.symbol,
          quantityBase: qtyStr,
          limitPrice: priceStr,
          notionalUsdc: Number(notionalUsdc.toFixed(2)),
          referencePrice,
          priceSource,
          bestBid,
          bestAsk,
          slippageBps: body.slippageBps,
          worstAcceptablePrice: priceStr
        },
        topOfBook,
        note: "Dry run — no order submitted. Re-call with dryRun:false to execute."
      });
    }

    // Step 5: submit the limit order.
    let submitResult: any = null;
    let submitError: string | null = null;
    try {
      submitResult = await client.createSpotLimitOrder({
        symbol: body.symbol,
        side: body.side,
        price: priceStr,
        quantity: qtyStr,
        clientOrderId: body.clientOrderId
      });
    } catch (err) {
      submitError = (err as Error).message;
    }

    if (submitError) {
      return reply.code(502).send({
        error: "order_submit_failed",
        message: submitError,
        plan: {
          side: body.side,
          symbol: body.symbol,
          quantityBase: qtyStr,
          limitPrice: priceStr,
          notionalUsdc: Number(notionalUsdc.toFixed(2))
        }
      });
    }

    // Bullish responses vary in shape; try to extract orderId.
    const submitData = (submitResult as any)?.data ?? submitResult;
    const orderId =
      String(
        submitData?.orderId ??
          submitData?.order_id ??
          submitData?.id ??
          ""
      ).trim() || null;

    // Step 6: poll for fill status (max 8s with 500ms intervals).
    const pollStartMs = Date.now();
    const pollMaxMs = 8000;
    const pollIntervalMs = 500;
    let finalStatus: any = null;
    let pollAttempts = 0;

    if (orderId) {
      while (Date.now() - pollStartMs < pollMaxMs) {
        pollAttempts++;
        try {
          const status = await client.getOrderStatus(orderId);
          finalStatus = status;
          // Terminal states — stop polling.
          if (
            ["FILLED", "CLOSED", "DONE", "CANCELLED", "REJECTED"].includes(status.status)
          ) {
            break;
          }
        } catch {
          // Transient poll failure — keep trying.
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    return reply.send({
      submitted: true,
      orderId,
      submitResultRaw: submitResult,
      pollAttempts,
      finalStatus,
      plan: {
        side: body.side,
        symbol: body.symbol,
        quantityBase: qtyStr,
        limitPrice: priceStr,
        notionalUsdc: Number(notionalUsdc.toFixed(2)),
        bestBidAtSubmit: bestBid,
        bestAskAtSubmit: bestAsk,
        slippageBps: body.slippageBps
      }
    });
  });

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
