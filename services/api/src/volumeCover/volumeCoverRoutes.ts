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
import { tierBlocksFoxifyTraffic, isShadowTier } from "../pilot/deploymentTier";
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
  listHedgeLegsForPosition,
  listActivePositions,
  listPositionsForCellToday,
  countActivePositionsForCell,
  countLifetimePositionsForCell,
  sumActivePayoutLiability,
  insertPairEvent,
  listRecentPairEvents,
  computePairEventLatencyStats,
  finalizeSalvageProceedsForPosition,
  markPositionArchived,
  markPositionFoxifyAcknowledged
} from "./volumeCoverDb";
import { openPosition, closePosition } from "./positionLifecycle";
import {
  checkAllGuardsForVolumeCoverActivate,
  setManualHalt,
  getManualHalt,
  __resetVolumeCoverGuardrailsForTests
} from "./volumeCoverGuardrails";
import { getNewbornReviewState } from "./volumeCoverNewbornReview";
import {
  getBullishSpreadAdapterRuntimeConfig
} from "./bullishSpreadAdapter";
import { getConfiguredDepthGate } from "./spreadExecutor";
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
import { resolveHedgeVenue, type HedgeExecutor } from "./tightHedge";
import { decideDisruption, applyLatencyInjection } from "./silentDisruption";
import {
  ensureCounterpartyLedgerSchema,
  summarizeCounterpartyCredit,
  shouldHaltDueToCounterpartyExposure,
  listLedgerEntries,
  settleLedgerEntry
} from "./counterpartyLedger";
import {
  ensureHedgePoolSchema,
  listActiveHedges,
  listLinksForHedge,
  computeHedgePoolEfficiency,
  markHedgePoolClosed
} from "./hedgePool";
import {
  classifyVolumeCoverRegime,
  classifyVolumeCoverRegimeHysteretic,
  translatePilotRegime,
  getGridStepUsdc,
  getConfiguredVolRegimeThresholds,
  snapHedgeStrike,
  type VolRegime
} from "./strikeGrid";
import { getCurrentRegime } from "../pilot/regimeClassifier";
import {
  checkAntiBot,
  recordActivation,
  recordTriggerForFingerprint,
  recordPatternStrike
} from "./antiBot";
import { insertLedgerEntry } from "../pilot/capitalPoolLedger";

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
  // Defense in depth: refuse all Foxify HMAC traffic on non-live tiers
  // even before checking the signature. Shadow services accept admin
  // traffic only.
  if (tierBlocksFoxifyTraffic()) {
    return { ok: false, reason: "shadow_tier_blocks_foxify_traffic" };
  }

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

const computeCoverExpiresAtIso = (expiryIsos: string[]): string | null => {
  if (expiryIsos.length === 0) return null;
  const maxMs = expiryIsos.reduce((acc, iso) => {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return acc;
    return Math.max(acc, ms);
  }, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(maxMs)) return null;
  return new Date(maxMs).toISOString();
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

// 2026-05-21 — Module-level singleton to avoid burning Bullish JWT
// session quota. Each new BullishTradingClient creates a new login →
// new session. Bullish caps active sessions per user (~10-20). When
// every admin-debug endpoint creates its own client, we trip
// MAX_SESSION_COUNT_REACHED (errorCode 8400). This singleton reuses
// a single client → single session for all admin debug calls.
//
// 2026-05-22 — Refactored to use the shared `pilot/bullishClient`
// module so that admin routes, the spot price source, the venue
// balance fetcher, and the trigger monitor all share ONE singleton.
// Previously this was a local singleton scoped to admin routes only,
// while 4 other callsites (server.ts spot/balance, triggerMonitor,
// chain endpoint, wide-config lister) bypassed it and each spun fresh
// clients. The dashboard auto-refresh + 60s trigger monitor combined
// to exhaust Bullish's session quota within ~10 min of continuous use.
const getBullishAdminClient = async () => {
  const { getSharedBullishClient } = await import("../pilot/bullishClient");
  return getSharedBullishClient(pilotConfig.bullish);
};

export const registerVolumeCoverRoutes = async (
  app: FastifyInstance,
  opts: RegisterVolumeCoverRoutesOptions
): Promise<void> => {
  const pool = opts.pool ?? getPilotPool(pilotConfig.postgresUrl ?? "");

  if (!opts.skipSchema) {
    await ensureVolumeCoverSchema(pool);
    await seedVolumeCoverCellsIfNeeded(pool);
    // 2026-05-23: additive schemas for counterparty credit ledger + hedge pool
    await ensureCounterpartyLedgerSchema(pool);
    await ensureHedgePoolSchema(pool);
  }

  // ────────── HEALTH ──────────

  app.get("/volume-cover/health", async (_req, reply) => {
    try {
      const cells = await listCells(pool);
      const active = await listActivePositions(pool);
      const liability = await sumActivePayoutLiability(pool);
      const halt = getManualHalt();
      // 2026-05-24 (PR-D): surface PR-A/B/C/D config so an operator
      // can verify a deploy picked up the expected env values without
      // shelling into Render.
      const newbornReview = getNewbornReviewState();
      const bullishSpread = getBullishSpreadAdapterRuntimeConfig();
      const depthGate = getConfiguredDepthGate();
      return reply.send({
        status: "ok",
        cellsConfigured: cells.length,
        cellsEnabled: cells.filter((c) => c.enabled).length,
        activePositions: active.length,
        totalActivePayoutLiabilityUsdc: liability,
        manualHalt: halt,
        config: {
          newbornReview,
          bullishSpreadAdapter: bullishSpread,
          spreadDepthGate: {
            minDepthBtcFloor: depthGate.minDepthBtcFloor,
            depthRatio: depthGate.depthRatio,
            enforced: depthGate.enforced
          },
          flags: {
            sellLongsAtTrigger:
              String(process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER ?? "true").toLowerCase() !==
              "false",
            parallelLongSells:
              String(process.env.VC_SPREAD_PARALLEL_LONG_SELLS ?? "true").toLowerCase() !==
              "false",
            slippageEnabledVenues:
              process.env.VC_SLIPPAGE_FLOOR_ENABLED_VENUES ?? "deribit,bullish",
            fillOptimizerDeepCrossBps:
              Number(process.env.VC_FILL_OPTIMIZER_DEEP_CROSS_BPS ?? "500"),
            // 2026-05-24 (PR-E): two display/ledger correctness fixes shipped
            // together — both are unconditionally on (no env toggle).
            //   prE_dashTriggeredAtCap   = Foxify dash premium projection caps
            //                              at triggered_at (matches ledger).
            //   prE_closeDoubleBillGuard = closePosition skips premium_in for
            //                              already-triggered positions (defense
            //                              in depth; route also gates).
            prE_dashTriggeredAtCap: true,
            prE_closeDoubleBillGuard: true,
            // 2026-05-24 (PR-F): foxify-acknowledge mark hides triggered
            // positions from the Foxify Active Protections list while keeping
            // them counted in lifetime premium/payout aggregates. Recent
            // Activity feed also suppresses 'rejected' + 'failed' events.
            prF_foxifyAcknowledge: true,
            prF_recentActivityHidesRejectedFailed: true,
            // 2026-05-25 (PR-G2): mid-IOC short-leg buyback fraction. Default
            // 0.5 (true mid). At trigger fire and Foxify-close, the spread
            // executor's `partialCloseSpreadOnTrigger` short-leg buyback path
            // runs through executeOptimizedFill with this fraction (vs the
            // standard 0.25 the long-sale path uses). Operator-tunable via
            // VC_SPREAD_SHORT_BUYBACK_MID_FRACTION; clamped to [0, 0.5].
            prG2_shortBuybackMidFraction: (() => {
              const raw = process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
              if (raw === undefined || raw === "") return 0.5;
              const n = Number(raw);
              if (!Number.isFinite(n)) return 0.5;
              return Math.max(0, Math.min(0.5, n));
            })()
          }
        }
      });
    } catch (err) {
      return reply.code(503).send({
        status: "degraded",
        error: (err as Error).message
      });
    }
  });

  // ────────── FOXIFY-FACING ──────────

  // Tighter rate limits on Foxify-facing endpoints. The global limit
  // (60/min) is already applied by the pilot router registration.
  // These per-route values further constrain Foxify request bursts
  // independent of total traffic from other consumers.
  app.post("/volume-cover/quote", {
    config: {
      rateLimit: {
        max: Number(process.env.VC_QUOTE_RATE_LIMIT_MAX ?? "30"),
        timeWindow: Number(process.env.VC_QUOTE_RATE_LIMIT_WINDOW_MS ?? "60000")
      }
    }
  }, async (req: FastifyRequest, reply: FastifyReply) => {
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
    const idealStrikes = computeHedgeStrikes({ cell: cellResult.cell, entryBtcPrice: entryBtc });

    // 2026-05-20: reflect ACTUAL venue routing + grid-snapped strikes that
    // the matching activate call will use. Previously the quote response
    // hardcoded "bullish_primary" for ≤5% triggers (ignoring the env-driven
    // VOLUME_COVER_VENUE_ROUTING_JSON) and returned ungrid-snapped ideal
    // strikes — both misleading to Foxify.
    const venueRoutingCfg = resolveHedgeVenue(cellResult.cell);
    const gridStepUsdc = getGridStepUsdc(venueRoutingCfg.primary);
    const putStrikeSnapped = snapHedgeStrike({
      optionKind: "put",
      idealStrikeUsdc: idealStrikes.putStrikeBtc,
      spotUsdc: entryBtc,
      triggerBoundaryUsdc: triggers.triggerLowBtc,
      gridStepUsdc
    });
    const callStrikeSnapped = snapHedgeStrike({
      optionKind: "call",
      idealStrikeUsdc: idealStrikes.callStrikeBtc,
      spotUsdc: entryBtc,
      triggerBoundaryUsdc: triggers.triggerHighBtc,
      gridStepUsdc
    });

    return reply.send({
      cellId: cellResult.cell.cellId,
      dailyPremiumUsdc: premium.dailyPremiumUsdc,
      payoutUsdc: premium.payoutUsdc,
      pairEntryBtcPrice: entryBtc,
      triggerHighBtc: triggers.triggerHighBtc,
      triggerLowBtc: triggers.triggerLowBtc,
      hedgeStructure: {
        venueRouting: `${venueRoutingCfg.primary}_primary`,
        venueFallback: venueRoutingCfg.fallback,
        putStrikeBtc: putStrikeSnapped,
        callStrikeBtc: callStrikeSnapped,
        putStrikeIdealBtc: idealStrikes.putStrikeBtc,
        callStrikeIdealBtc: idealStrikes.callStrikeBtc,
        gridStepUsdc
      },
      throttleMaxPerDay: cellRow.throttleMaxPerDay,
      premiumSource: premium.source,
      quoteExpiresInSeconds: 30
    });
  });

  app.post("/volume-cover/activate", {
    config: {
      rateLimit: {
        max: Number(process.env.VC_ACTIVATE_RATE_LIMIT_MAX ?? "15"),
        timeWindow: Number(process.env.VC_ACTIVATE_RATE_LIMIT_WINDOW_MS ?? "60000")
      }
    }
  }, async (req: FastifyRequest, reply: FastifyReply) => {
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
    // 2026-05-23: route the VC 4-bucket classification through the
    // hysteresis wrapper so the activation/pricing tier doesn't flip
    // more than once per VC_REGIME_HYSTERESIS_MIN_FLIP_INTERVAL_MS
    // (default 1h). Prevents boundary jitter at DVOL threshold crossings.
    let currentDvolForGuard = 0;
    let regime: VolRegime | null = null;
    try {
      const status = await getCurrentRegime();
      currentDvolForGuard = status.dvol ?? 0;
      const hysteretic = classifyVolumeCoverRegimeHysteretic(status.dvol);
      regime = hysteretic?.regime ?? null;
      if (!regime) regime = translatePilotRegime(status.regime);
    } catch (err) {
      req.log.warn(`[volume-cover/activate] regime fetch failed: ${(err as Error).message}`);
    }

    // 2026-05-23: Counterparty credit halt gate. If unsettled
    // Foxify→Atticus exposure exceeds VC_COUNTERPARTY_HALT_THRESHOLD_USDC
    // (default $25k), halt new cell openings until Foxify catches up.
    // Disabled with VC_COUNTERPARTY_HALT_GATE_ENABLED=false.
    if (process.env.VC_COUNTERPARTY_HALT_GATE_ENABLED !== "false") {
      try {
        const cpSummary = await summarizeCounterpartyCredit({ pool });
        const haltGate = shouldHaltDueToCounterpartyExposure(cpSummary);
        if (haltGate.halt) {
          req.log.warn(
            `[volume-cover/activate] counterparty-credit halt: foxifyOwes=$${haltGate.unsettledUsdc} > threshold=$${haltGate.thresholdUsdc}`
          );
          return reply.code(503).send({
            ok: false,
            error: "counterparty_credit_halt",
            message:
              "Counterparty credit exposure exceeds threshold. New activations paused pending settlement.",
            unsettledUsdc: haltGate.unsettledUsdc,
            thresholdUsdc: haltGate.thresholdUsdc
          });
        }
      } catch (err) {
        req.log.warn(`[volume-cover/activate] counterparty halt check failed: ${(err as Error).message}`);
      }
    }

    // 2026-05-23: Silent disruption layer. Vol-regime-gated calibrated
    // friction (latency injection, sparing 503, anti-bot jitter
    // expansion). Calm/moderate → no-op. Elevated/stress → soft
    // deterrent before the harder stress-pause halt at DVOL 80.
    const disruptionDirective = decideDisruption({ regime });
    if (disruptionDirective.reject503) {
      req.log.info(
        `[volume-cover/activate] silent-disruption 503 fired regime=${regime} retryAfter=${disruptionDirective.retryAfterSeconds}s`
      );
      return reply
        .header("Retry-After", String(disruptionDirective.retryAfterSeconds))
        .code(503)
        .send({
          ok: false,
          error: "service_unavailable",
          message: "Service temporarily unavailable. Please retry shortly."
        });
    }
    if (disruptionDirective.latencyMs > 0) {
      req.log.info(
        `[volume-cover/activate] silent-disruption latency regime=${regime} injecting=${disruptionDirective.latencyMs}ms`
      );
      await applyLatencyInjection(disruptionDirective);
    }

    // 2026-05-24 (Hybrid v3): resolve premium + regime-adjusted payout BEFORE
    // the guard so liability checks use the actual obligation (smaller in
    // moderate/elevated when payout overlay set), not the cell base. Pulled
    // up so we can also pass the same effectivePayoutUsdc into openPosition
    // for end-to-end consistency.
    const earlyQuote = resolveDailyPremium({
      cell,
      dbOverrideDailyPremiumUsdc: cellRow.dailyPremiumUsdc,
      regime
    });
    const effectivePayoutForGuard = earlyQuote.payoutUsdc;

    const guardVerdict = checkAllGuardsForVolumeCoverActivate({
      foxifyPoolBalanceUsdc: 0,
      totalActivePayoutLiabilityUsdc: totalActiveLiability,
      newPayoutLiabilityUsdc: effectivePayoutForGuard,
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

    // P2 (2026-05-19): per-cell concurrent-open cap for the pilot. Env-driven
    // override so operator can set tight bounds for the 2-position launch
    // (`VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=2`) without changing the matrix
    // throttle (which is daily-count-based). Format:
    //   VC_MAX_CONCURRENT_PER_CELL_<UPPERCASE_ID_NO_DOTS>=<N>
    // Example: VC_MAX_CONCURRENT_PER_CELL_50K_2PCT_1K=2
    // Or a global default: VC_MAX_CONCURRENT_PER_CELL=2 (applies to ALL cells).
    const cellEnvKey = `VC_MAX_CONCURRENT_PER_CELL_${cell.cellId.toUpperCase()}`;
    const concurrentCapRaw =
      process.env[cellEnvKey] ?? process.env.VC_MAX_CONCURRENT_PER_CELL ?? "0";
    const concurrentCap = Number(concurrentCapRaw);
    if (Number.isFinite(concurrentCap) && concurrentCap > 0) {
      const activeNow = await countActivePositionsForCell(pool, { cellId: cell.cellId });
      if (activeNow >= concurrentCap) {
        void writeEvent({ result: "rejected", rejectReason: "concurrent_throttle_exceeded" });
        return reply.code(429).send({
          error: "concurrent_throttle_exceeded",
          cellId: cell.cellId,
          activeNow,
          maxConcurrent: concurrentCap,
          message: `cell ${cell.cellId} has ${activeNow} active positions; cap=${concurrentCap}`
        });
      }
    }

    // 2026-05-20: per-cell LIFETIME cap. Counts every real (non-admin-test)
    // position ever opened for the cell — regardless of current status.
    // Used for the pilot launch lock-down: allow exactly N opens, then
    // block all further activations (including auto-reopens after
    // close/trigger) until operator manually raises the env var.
    // Format:
    //   VC_MAX_LIFETIME_PER_CELL_<UPPERCASE_ID_NO_DOTS>=<N>
    // Example: VC_MAX_LIFETIME_PER_CELL_50K_2PCT_1K=2
    // Or a global default: VC_MAX_LIFETIME_PER_CELL=2 (applies to ALL cells).
    // Unset / 0 / negative ⇒ no lifetime cap (normal operation).
    const lifetimeEnvKey = `VC_MAX_LIFETIME_PER_CELL_${cell.cellId.toUpperCase()}`;
    const lifetimeCapRaw =
      process.env[lifetimeEnvKey] ?? process.env.VC_MAX_LIFETIME_PER_CELL ?? "0";
    const lifetimeCap = Number(lifetimeCapRaw);
    if (Number.isFinite(lifetimeCap) && lifetimeCap > 0) {
      const openedEver = await countLifetimePositionsForCell(pool, { cellId: cell.cellId });
      if (openedEver >= lifetimeCap) {
        void writeEvent({ result: "rejected", rejectReason: "lifetime_cap_exceeded" });
        return reply.code(423).send({
          error: "lifetime_cap_exceeded",
          cellId: cell.cellId,
          openedEver,
          maxLifetime: lifetimeCap,
          message: `cell ${cell.cellId} has ${openedEver} lifetime opens; cap=${lifetimeCap}. Raise ${lifetimeEnvKey} env to allow more.`
        });
      }
    }

    guardsPassedAtMs = Date.now();

    // P3 §13: regime-aware pricing. Already resolved as `earlyQuote` above
    // (we pulled it up so guard's liability check uses regime-adjusted payout).
    // Reuse to avoid double-parsing the overlay JSON.
    const premiumQuote = earlyQuote;
    const baseDailyPremium = premiumQuote.dailyPremiumUsdc;
    const effectivePayout = premiumQuote.payoutUsdc;
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
        // 2026-05-24 (Hybrid v3): pass regime-adjusted payout so position
        // row, trigger payout, ledger, and obligation use the SAME Y value.
        effectivePayoutUsdc: effectivePayout,
        regime,
        // 2026-05-24 (Phase 0.3): persist pricing inputs for PnL attribution.
        baseDailyPremiumUsdc: baseDailyPremium,
        surchargeMultiplierApplied: surchargeMultiplier,
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
            cellId: cell.cellId,
            // 2026-05-23: widen the Layer 2 jitter window in elevated/stress
            // regimes so the cooldown after activation is materially longer
            // for whatever cadence pattern called us.
            jitterMultiplier: disruptionDirective.jitterMultiplier
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
        payoutUsdc: effectivePayout,
        // 2026-05-24 (Hybrid v3): regime context for caller observability.
        regime,
        payoutSource: premiumQuote.payoutSource,
        basePayoutUsdc: premiumQuote.basePayoutUsdc,
        hedgeLegs: result.hedgeLegs.map((l) => ({
          id: l.id,
          venue: l.venue,
          optionKind: l.optionKind,
          strikeUsdc: l.strikeUsdc,
          expiryIso: l.expiryIso
        })),
        coverExpiresAtIso: computeCoverExpiresAtIso(result.hedgeLegs.map((l) => l.expiryIso)),
        salvageState: guardVerdict.salvageState
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      // PR-A (2026-05-24): depth-gate aborts surface as a clean 503
      // retry signal. The position row was marked
      // `hedge_execution_failed:spread_liquidity_gate_failed` so it
      // does NOT count toward the cell's lifetime cap. Foxify's HMAC
      // client should retry the same activation idempotency-keyed in
      // 30s once the orderbook recovers.
      if (e.code === "spread_liquidity_gate_failed") {
        req.log.warn(
          `[volume-cover/activate] depth-gate abort: ${e.message} (no venue order placed; retry safe)`
        );
        void writeEvent({ result: "rejected", rejectReason: "venue_book_thin" });
        return reply
          .header("Retry-After", "30")
          .code(503)
          .send({
            error: "venue_book_thin",
            message:
              "Bullish orderbook depth insufficient on one or more legs; please retry shortly.",
            retryAfterSeconds: 30
          });
      }
      req.log.error(`[volume-cover/activate] failed: ${e.message}`);
      void writeEvent({ result: "failed", rejectReason: e.message });
      return reply.code(500).send({
        error: "activate_failed",
        message: e.message
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
    const hedgeLegs = await listHedgeLegsForPosition(pool, id);
    // Effective protection state from Foxify's perspective. status='closed'
    // with coverage_through > now means the customer is still inside their
    // last paid day — a trigger within this window still pays out.
    const nowMs = Date.now();
    const coverageThroughMs = position.coverageThrough ? new Date(position.coverageThrough).getTime() : null;
    const protectionActive =
      position.status === "active" ||
      (position.status === "closed" && coverageThroughMs !== null && coverageThroughMs > nowMs);

    return reply.send({
      positionId: position.id,
      cellId: position.cellId,
      foxifyPairId: position.foxifyPairId,
      status: position.status,
      protectionActive,
      coverageThroughIso: position.coverageThrough,
      triggerHighBtc: position.triggerHighBtc,
      triggerLowBtc: position.triggerLowBtc,
      payoutUsdc: position.payoutUsdc,
      dailyPremiumUsdc: position.dailyPremiumUsdc,
      openedAt: position.openedAt,
      triggeredAt: position.triggeredAt,
      triggeredDirection: position.triggeredDirection,
      closedAt: position.closedAt,
      hedgeLegs: hedgeLegs.map((l) => ({
        id: l.id,
        venue: l.venue,
        optionKind: l.optionKind,
        strikeUsdc: l.strikeUsdc,
        expiryIso: l.expiryIso,
        status: l.status
      })),
      coverExpiresAtIso: computeCoverExpiresAtIso(hedgeLegs.map((l) => l.expiryIso))
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
        hedgeRetained: true,
        // 2026-05-19: protection continues through the end of the last
        // paid day. Triggers within this window still pay out the cell
        // payout. Foxify can rely on this to keep coverage live for the
        // remainder of the paid period after clicking close.
        coverageThroughIso: result.coverageThroughIso,
        daysBilled: result.daysHeld
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
        payoutUsdc: Number(row.payout_usdc),
        dailyPremiumUsdc: Number(row.daily_premium_usdc),
        // 2026-05-24 (Phase 0.3): pricing attribution surfaced for PnL
        // reconciliation queries against this endpoint.
        regimeAtOpen: row.regime_at_open ? String(row.regime_at_open) : null,
        baseDailyPremiumUsdc:
          row.base_daily_premium_usdc !== null && row.base_daily_premium_usdc !== undefined
            ? Number(row.base_daily_premium_usdc)
            : null,
        surchargeMultiplierApplied:
          row.surcharge_multiplier_applied !== null && row.surcharge_multiplier_applied !== undefined
            ? Number(row.surcharge_multiplier_applied)
            : 1.0
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
    // Archived positions (metadata.archived=true) excluded so test
    // trades don't pollute the operational view.
    const posResult = await pool.query(
      `SELECT * FROM volume_cover_position
       WHERE (status IN ('active', 'triggered')
          OR (status = 'closed' AND closed_at >= NOW() - interval '6 hours'))
         AND COALESCE((metadata->>'archived')::boolean, false) = false
       ORDER BY opened_at DESC
       LIMIT $1`,
      [limit]
    );

    const positions = await Promise.all(
      posResult.rows.map(async (row) => {
        // PR-Admin-Surface (2026-05-25): include the spread-executor
        // attribution columns so per-position hedge-cost reconciliation
        // doesn't require crawling the Atticus pool ledger. For SHORT
        // legs of a 4-leg spread:
        //   buy_price_usdc       = 0 (sentinel; no cash paid at open)
        //   initial_proceeds_usdc = USDC received when the short was sold-to-open
        //   sell_price_usdc      = USDC paid to buy back at close (BUY-side fill)
        // Combined with leg_role + spread_group_id, downstream consumers
        // can compute net spread P&L per position without re-querying.
        const legsResult = await pool.query(
          `SELECT id, venue, option_kind, strike_usdc, expiry_iso,
                  contracts, buy_price_usdc, sell_price_usdc, status,
                  retained, retained_role, retained_at, opened_at, closed_at,
                  spread_group_id, leg_role, initial_proceeds_usdc
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
          closedAt: l.closed_at ? String(l.closed_at) : null,
          // 2026-05-25 (PR-Admin-Surface): spread executor attribution.
          spreadGroupId: l.spread_group_id ? String(l.spread_group_id) : null,
          legRole: l.leg_role ? String(l.leg_role) : null,
          initialProceedsUsdc:
            l.initial_proceeds_usdc !== null && l.initial_proceeds_usdc !== undefined
              ? Number(l.initial_proceeds_usdc)
              : null
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
          // 2026-05-24 (Phase 0.3): pricing attribution for live ops UI.
          regimeAtOpen: row.regime_at_open ? String(row.regime_at_open) : null,
          baseDailyPremiumUsdc:
            row.base_daily_premium_usdc !== null && row.base_daily_premium_usdc !== undefined
              ? Number(row.base_daily_premium_usdc)
              : null,
          surchargeMultiplierApplied:
            row.surcharge_multiplier_applied !== null && row.surcharge_multiplier_applied !== undefined
              ? Number(row.surcharge_multiplier_applied)
              : 1.0,
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

  // 2026-05-23 — Vol regime status + premium tier preview
  //
  // Surfaces:
  //   - Current DVOL (Deribit), RVOL fallback
  //   - Configured thresholds (env-driven for production tightening)
  //   - Raw classification + hysteresis-committed regime
  //   - For each cell: the premium that would be quoted right now
  //
  // Used by operator dashboard to verify the regime classifier is
  // tracking expected market state + to preview what cells would
  // charge if a customer activated this instant.
  app.get("/volume-cover/admin/vol-regime", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const thresholds = getConfiguredVolRegimeThresholds();
    let dvol: number | null = null;
    let rvol: number | null = null;
    let pilotRegimeName: "calm" | "normal" | "stress" | null = null;
    try {
      const status = await getCurrentRegime();
      dvol = status.dvol ?? null;
      rvol = status.rvol ?? null;
      pilotRegimeName = status.regime;
    } catch (err) {
      return reply.send({
        ok: false,
        error: `regime_fetch_failed: ${(err as Error).message}`,
        thresholds
      });
    }

    const rawRegime = classifyVolumeCoverRegime(dvol, thresholds);
    const hysteretic = classifyVolumeCoverRegimeHysteretic(dvol, { thresholds });
    const effectiveRegime =
      hysteretic?.regime ?? rawRegime ?? translatePilotRegime(pilotRegimeName) ?? null;

    // Premium preview across all cells in the matrix.
    const { MATRIX } = await import("./matrix");
    const cellPreviews = MATRIX.map((cell) => {
      const quote = resolveDailyPremium({
        cell,
        dbOverrideDailyPremiumUsdc: null,
        regime: effectiveRegime
      });
      return {
        cellId: cell.cellId,
        baseDailyPremiumUsdc: cell.dailyPremiumUsdc,
        effectiveDailyPremiumUsdc: quote.dailyPremiumUsdc,
        source: quote.source,
        payoutUsdc: cell.payoutUsdc
      };
    });

    return reply.send({
      ok: true,
      generatedAtIso: new Date().toISOString(),
      dvol,
      rvol,
      pilotRegime: pilotRegimeName,
      vcRegime: {
        rawClassification: rawRegime,
        effective: effectiveRegime,
        flipSuppressed: hysteretic?.flipSuppressed ?? false,
        lastFlipAtIso: hysteretic
          ? new Date(hysteretic.lastFlipAtMs).toISOString()
          : null,
        minFlipIntervalMs: Number(
          process.env.VC_REGIME_HYSTERESIS_MIN_FLIP_INTERVAL_MS ?? 3_600_000
        )
      },
      thresholds: {
        ...thresholds,
        stressPauseDvol: Number(process.env.VC_STRESS_PAUSE_DVOL_THRESHOLD ?? 80)
      },
      cellPreviews
    });
  });

  // 2026-05-23 — Counterparty credit ledger summary
  //
  // Surfaces the deferred-payment exposure (Atticus↔Foxify) created by
  // the 25%/75% schedule. Halt-new-cells gate state included so the
  // operator can see why activations would refuse if exposure exceeds
  // the configured threshold.
  app.get("/volume-cover/admin/counterparty-credit", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const summary = await summarizeCounterpartyCredit({ pool });
    const halt = shouldHaltDueToCounterpartyExposure(summary);
    return reply.send({
      ok: true,
      summary,
      haltGate: halt
    });
  });

  // 2026-05-23 — Counterparty credit ledger entries (paginated list)
  //
  // Filterable by party/category/settled-status for operator review.
  app.get<{
    Querystring: {
      partyOwes?: "atticus_to_foxify" | "foxify_to_atticus";
      category?: "trigger_payout" | "premium_billing" | "adjustment_manual";
      settled?: "true" | "false";
      limit?: string;
    };
  }>("/volume-cover/admin/counterparty-credit/entries", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const settledQuery = req.query.settled;
    const settled =
      settledQuery === "true" ? true : settledQuery === "false" ? false : null;
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit ?? 200)));
    const rows = await listLedgerEntries({
      pool,
      partyOwes: req.query.partyOwes,
      category: req.query.category,
      settled,
      limit
    });
    return reply.send({ ok: true, count: rows.length, entries: rows });
  });

  // 2026-05-23 — Mark a ledger entry settled.
  //
  // Operator action. Idempotent: settling an already-settled entry
  // returns ok=false with reason=already_settled.
  app.post<{
    Params: { entryId: string };
    Body: {
      settledAmountUsdc?: number;
      paymentReference?: string;
      notes?: string;
    };
  }>("/volume-cover/admin/counterparty-credit/entries/:entryId/settle", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const entryId = String(req.params.entryId ?? "").trim();
    if (!entryId) return reply.code(400).send({ ok: false, error: "missing_entry_id" });
    const updated = await settleLedgerEntry({
      pool,
      entryId,
      settledAmountUsdc: req.body?.settledAmountUsdc,
      paymentReference: req.body?.paymentReference ?? null,
      notes: req.body?.notes ?? null
    });
    if (!updated) {
      return reply.code(200).send({ ok: false, reason: "already_settled_or_missing" });
    }
    return reply.send({ ok: true, entryId, settledAtIso: new Date().toISOString() });
  });

  // 2026-05-23 — Hedge pool listing (active hedges + efficiency metrics)
  //
  // Operator view of Bullish [DB] spreads currently in the pool, with
  // remaining capacity and cycles-per-hedge efficiency metric.
  app.get<{ Querystring: { cellId?: string } }>(
    "/volume-cover/admin/hedge-pool",
    async (req, reply) => {
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
      const cellId = req.query.cellId ? String(req.query.cellId) : undefined;
      const [hedges, efficiency] = await Promise.all([
        listActiveHedges({ pool, cellId }),
        computeHedgePoolEfficiency({ pool })
      ]);
      return reply.send({
        ok: true,
        generatedAtIso: new Date().toISOString(),
        efficiency,
        activeHedges: hedges
      });
    }
  );

  // 2026-05-23 — Hedge pool detail (one hedge + its links)
  app.get<{ Params: { hedgeId: string }; Querystring: { activeOnly?: string } }>(
    "/volume-cover/admin/hedge-pool/:hedgeId",
    async (req, reply) => {
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
      const hedgeId = String(req.params.hedgeId ?? "").trim();
      if (!hedgeId) return reply.code(400).send({ ok: false, error: "missing_hedge_id" });
      const activeOnly = String(req.query.activeOnly ?? "").toLowerCase() === "true";
      const links = await listLinksForHedge({ pool, hedgeId, activeOnly });
      const allHedges = await listActiveHedges({ pool });
      const hedge = allHedges.find((h) => h.hedgeId === hedgeId) ?? null;
      return reply.send({
        ok: true,
        generatedAtIso: new Date().toISOString(),
        hedge,
        links,
        linkCount: links.length
      });
    }
  );

  // 2026-05-23 — Hedge pool close (operator action)
  //
  // Marks a hedge pool entry status='closed' with reason='manual'. The
  // executor (Track 2 PR #2) is expected to read this status and
  // sequence-close the underlying Bullish legs on the next sweep.
  app.post<{ Params: { hedgeId: string }; Body: { reason?: string } }>(
    "/volume-cover/admin/hedge-pool/:hedgeId/close",
    async (req, reply) => {
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
      const hedgeId = String(req.params.hedgeId ?? "").trim();
      if (!hedgeId) return reply.code(400).send({ ok: false, error: "missing_hedge_id" });
      const closed = await markHedgePoolClosed({
        pool,
        hedgeId,
        reason: "manual"
      });
      if (!closed) return reply.send({ ok: false, reason: "already_closed_or_missing" });
      return reply.send({ ok: true, hedgeId, closedAtIso: new Date().toISOString() });
    }
  );

  // 2026-05-21 — TP slippage-floor observability
  //
  // Returns counters from the volume_cover_hedge_leg_telemetry table
  // bucketed by action so ops can see how often the floor fires,
  // unfills, falls through, etc. Looks back over a configurable
  // window (default 24h) so we can scope to recent activity.
  //
  // Body shape:
  //   {
  //     windowHours: 24,
  //     enabled: true|false,                     ← feature flag state
  //     config: { tolerance, maxDefers, ... },   ← active params
  //     totals: { sold, unfilled, fallthrough, error, held, dryRun, skip },
  //     byRule: [ { rule, sold, unfilled, fallthrough, ... }, ... ],
  //     activeLegsWithDefers: [ { legId, positionId, deferCount }, ... ]
  //   }
  app.get("/volume-cover/admin/slippage-floor-stats", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const windowHours = Math.max(
      1,
      Math.min(168, Number((req.query as any)?.windowHours ?? "24"))
    );
    const cutoffIso = new Date(Date.now() - windowHours * 3_600_000).toISOString();

    try {
      const totalsRes = await pool.query(
        `SELECT action, COUNT(*)::INT AS n
         FROM volume_cover_hedge_leg_telemetry
         WHERE cycled_at >= $1
         GROUP BY action
         ORDER BY action`,
        [cutoffIso]
      );

      const byRuleRes = await pool.query(
        `SELECT rule_evaluated AS rule, action, COUNT(*)::INT AS n
         FROM volume_cover_hedge_leg_telemetry
         WHERE cycled_at >= $1
           AND action IN ('sold', 'unfilled', 'fallthrough_market', 'error')
         GROUP BY rule_evaluated, action
         ORDER BY rule_evaluated, action`,
        [cutoffIso]
      );

      const deferRes = await pool.query(
        `SELECT id AS leg_id, position_id, tp_defer_count
         FROM volume_cover_hedge_leg
         WHERE retained = TRUE
           AND status = 'open'
           AND tp_defer_count > 0
         ORDER BY tp_defer_count DESC
         LIMIT 100`
      );

      const totals: Record<string, number> = {};
      for (const r of totalsRes.rows) {
        totals[String(r.action)] = Number(r.n);
      }

      const ruleMap = new Map<string, Record<string, number>>();
      for (const r of byRuleRes.rows) {
        const rule = String(r.rule);
        const action = String(r.action);
        if (!ruleMap.has(rule)) ruleMap.set(rule, {});
        ruleMap.get(rule)![action] = Number(r.n);
      }

      const byRule = Array.from(ruleMap.entries()).map(([rule, counts]) => ({
        rule,
        sold: counts.sold ?? 0,
        unfilled: counts.unfilled ?? 0,
        fallthroughMarket: counts.fallthrough_market ?? 0,
        error: counts.error ?? 0
      }));

      // Effective ratio: of all sells (sold + fallthrough + unfilled),
      // what fraction filled at the floor vs fell through? Higher =
      // more revenue captured.
      const totalSells =
        (totals.sold ?? 0) + (totals.fallthrough_market ?? 0) + (totals.unfilled ?? 0);
      const floorSuccessRate =
        totalSells > 0 ? (totals.sold ?? 0) / totalSells : null;

      return reply.send({
        windowHours,
        windowStart: cutoffIso,
        enabled: String(process.env.VC_TP_SLIPPAGE_FLOOR_ENABLED ?? "false").toLowerCase() === "true",
        config: {
          bsTolerance: Number(process.env.VC_TP_SLIPPAGE_BS_TOLERANCE ?? "0.15"),
          maxDefers: Number(process.env.VC_TP_SLIPPAGE_MAX_DEFERS ?? "3"),
          discretionaryRules: (process.env.VC_TP_SLIPPAGE_DISCRETIONARY_RULES ?? "5_trail_retrace,6_theta_vs_momentum,10_near_atm,11_vol_spike").split(",").map((s) => s.trim()),
          enabledVenues: (process.env.VC_TP_SLIPPAGE_VENUES ?? "deribit,bullish").split(",").map((s) => s.trim().toLowerCase())
        },
        totals: {
          sold: totals.sold ?? 0,
          unfilled: totals.unfilled ?? 0,
          fallthroughMarket: totals.fallthrough_market ?? 0,
          error: totals.error ?? 0,
          held: totals.held ?? 0,
          dryRun: totals.dry_run ?? 0,
          skip: totals.skip ?? 0
        },
        floorSuccessRate,
        byRule,
        activeLegsWithDefers: deferRes.rows.map((r) => ({
          legId: String(r.leg_id),
          positionId: String(r.position_id),
          deferCount: Number(r.tp_defer_count)
        }))
      });
    } catch (err: any) {
      return reply.code(500).send({
        error: "slippage_floor_stats_failed",
        message: err?.message ?? "unknown"
      });
    }
  });

  // 2026-05-21 — SHADOW-ONLY debug endpoint for stress-testing the TP
  // slippage floor end-to-end.
  //
  // Discretionary rules (5/6/10/11) won't fire naturally on a fresh
  // mock-retained leg — running_max starts at first-tick value, so
  // "current < runningMax × 0.80" is impossible without state.
  // This endpoint forces a leg into a "rule X fires next tick" state
  // by writing the necessary fields directly. Used to validate the
  // unfilled → defer → fallthrough chain on shadow.
  //
  // GUARDRAILS:
  //   • Returns 403 unless PILOT_DEPLOYMENT_TIER=shadow
  //   • Returns 403 unless admin token matches
  //   • Only updates rows in volume_cover_hedge_leg by id
  //
  // Body shape:
  //   {
  //     legId: string,
  //     scenario: "force_rule_5_trail_retrace"
  //             | "force_rule_10_near_atm"
  //             | "set_state",
  //     // only for "set_state":
  //     runningMaxValueUsdc?: number,
  //     lastValueUsdc?: number,
  //     lastValueAt?: string (ISO),
  //     retainedRole?: "winner_post_trigger" | "loser_post_trigger" | "near_atm_post_close" | "stale_post_close",
  //     tpDeferCount?: number
  //   }
  app.post("/volume-cover/admin/debug/force-leg-tp-state", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const body = (req.body ?? {}) as Record<string, any>;
    const legId = String(body.legId ?? "");
    if (!legId) {
      return reply.code(400).send({ error: "missing_legId" });
    }
    const scenario = String(body.scenario ?? "set_state");

    try {
      // Read the current leg state
      const legRes = await pool.query(
        `SELECT id, position_id, contracts, buy_price_usdc, retained_role,
                running_max_value_usdc, last_value_usdc, last_value_at, tp_defer_count
         FROM volume_cover_hedge_leg
         WHERE id = $1`,
        [legId]
      );
      if (legRes.rows.length === 0) {
        return reply.code(404).send({ error: "leg_not_found", legId });
      }
      const leg = legRes.rows[0];
      const before = {
        retainedRole: leg.retained_role,
        runningMaxValueUsdc: leg.running_max_value_usdc !== null ? Number(leg.running_max_value_usdc) : null,
        lastValueUsdc: leg.last_value_usdc !== null ? Number(leg.last_value_usdc) : null,
        lastValueAt: leg.last_value_at,
        tpDeferCount: Number(leg.tp_defer_count ?? 0)
      };

      let updates: Array<{ col: string; val: any }> = [];
      let scenarioMeta: Record<string, unknown> = {};

      if (scenario === "force_rule_5_trail_retrace") {
        // Rule 5: current < runningMax × (1 - 0.20). To force fire on
        // next tick, set runningMax = current_bs_value × 5 (5× higher
        // than current → guaranteed retrace > 80%). Also bump role to
        // winner_post_trigger so rule 5 is actually evaluated.
        const initialCost = Number(leg.buy_price_usdc) * Number(leg.contracts);
        const forcedRunningMax = initialCost * 5;
        updates = [
          { col: "running_max_value_usdc", val: forcedRunningMax },
          { col: "retained_role", val: "winner_post_trigger" }
        ];
        scenarioMeta = {
          forcedRunningMax,
          rationale: "running_max set to 5× initial cost; next tick BS-implied current will be ~50% of initial → current < runningMax × 0.80 → rule 5 fires"
        };
      } else if (scenario === "force_rule_10_near_atm") {
        // Rule 10: when role=near_atm_post_close AND current < initial × 0.65 → fire.
        // Mock recovery is ~50% so it's already below 65% — just need role.
        updates = [
          { col: "retained_role", val: "near_atm_post_close" },
          { col: "running_max_value_usdc", val: Number(leg.buy_price_usdc) * Number(leg.contracts) }
        ];
        scenarioMeta = {
          rationale: "role flipped to near_atm_post_close; mock recovery (~50%) is below near_atm floor (65%) → rule 10 fires"
        };
      } else if (scenario === "set_state") {
        // Free-form: caller chooses what to update.
        if (typeof body.runningMaxValueUsdc === "number") {
          updates.push({ col: "running_max_value_usdc", val: body.runningMaxValueUsdc });
        }
        if (typeof body.lastValueUsdc === "number") {
          updates.push({ col: "last_value_usdc", val: body.lastValueUsdc });
        }
        if (typeof body.lastValueAt === "string") {
          updates.push({ col: "last_value_at", val: body.lastValueAt });
        }
        if (typeof body.retainedRole === "string") {
          updates.push({ col: "retained_role", val: body.retainedRole });
        }
        if (typeof body.tpDeferCount === "number") {
          updates.push({ col: "tp_defer_count", val: body.tpDeferCount });
        }
        if (updates.length === 0) {
          return reply.code(400).send({
            error: "no_fields_to_update",
            allowed: ["runningMaxValueUsdc", "lastValueUsdc", "lastValueAt", "retainedRole", "tpDeferCount"]
          });
        }
      } else {
        return reply.code(400).send({
          error: "unknown_scenario",
          allowed: ["force_rule_5_trail_retrace", "force_rule_10_near_atm", "set_state"]
        });
      }

      const setClauses = updates.map((u, i) => `${u.col} = $${i + 2}`).join(", ");
      const values = [legId, ...updates.map((u) => u.val)];
      await pool.query(
        `UPDATE volume_cover_hedge_leg SET ${setClauses} WHERE id = $1`,
        values
      );

      const afterRes = await pool.query(
        `SELECT retained_role, running_max_value_usdc, last_value_usdc, last_value_at, tp_defer_count
         FROM volume_cover_hedge_leg WHERE id = $1`,
        [legId]
      );
      const after = afterRes.rows[0];

      return reply.send({
        legId,
        scenario,
        scenarioMeta,
        before,
        after: {
          retainedRole: after.retained_role,
          runningMaxValueUsdc: after.running_max_value_usdc !== null ? Number(after.running_max_value_usdc) : null,
          lastValueUsdc: after.last_value_usdc !== null ? Number(after.last_value_usdc) : null,
          lastValueAt: after.last_value_at,
          tpDeferCount: Number(after.tp_defer_count ?? 0)
        },
        nextSteps: "wait 60-180s for HedgeManager ticks; re-fetch /admin/slippage-floor-stats to observe defer/fallthrough counters"
      });
    } catch (err: any) {
      return reply.code(500).send({
        error: "force_leg_tp_state_failed",
        message: err?.message ?? "unknown"
      });
    }
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
      const { getCachedBullishBalances } = await import("../pilot/bullishClient");
      const balances: any[] = await withTimeout(
        getCachedBullishBalances(pilotConfig.bullish, 30_000, 5_000),
        5_000
      );
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

    let deribitEquityBtc: number | null = null;
    let deribitBalanceBtc: number | null = null;
    let deribitError: string | null = null;
    let deribitEnv: string = "unknown";
    let deribitPaper: boolean = true;
    try {
      const { DeribitConnector } = await import("@foxify/connectors");
      deribitEnv = String(process.env.DERIBIT_ENV || "live").trim();
      deribitPaper = String(process.env.DERIBIT_PAPER || "true").trim().toLowerCase() === "true";
      const c = new DeribitConnector(
        deribitEnv === "live" ? "live" : "testnet",
        deribitPaper,
        {
          clientId: String(process.env.DERIBIT_CLIENT_ID || ""),
          clientSecret: String(process.env.DERIBIT_CLIENT_SECRET || "")
        }
      );
      const summary: any = await withTimeout(c.getAccountSummary("BTC"), 5_000);
      const eq = Number(summary?.result?.equity ?? NaN);
      const bal = Number(summary?.result?.balance ?? NaN);
      if (Number.isFinite(eq)) deribitEquityBtc = eq;
      if (Number.isFinite(bal)) deribitBalanceBtc = bal;
    } catch (err) {
      deribitError = (err as Error).message;
    }

    let spotBtcUsdc: number | null = null;
    let spotSourceName: string | null = null;
    try {
      const spot = await opts.spotSource();
      spotBtcUsdc = spot.spotBtcPrice;
      spotSourceName = (spot as any).source ?? null;
    } catch {
      // best-effort
    }

    const bullishBtcValueUsdc =
      bullishBtc !== null && spotBtcUsdc !== null ? bullishBtc * spotBtcUsdc : null;
    const bullishTotalUsdc =
      bullishUsdc !== null && bullishBtcValueUsdc !== null
        ? bullishUsdc + bullishBtcValueUsdc
        : bullishUsdc;

    const deribitEquityUsdc =
      deribitEquityBtc !== null && spotBtcUsdc !== null
        ? deribitEquityBtc * spotBtcUsdc
        : null;
    const deribitBalanceUsdc =
      deribitBalanceBtc !== null && spotBtcUsdc !== null
        ? deribitBalanceBtc * spotBtcUsdc
        : null;

    return {
      fetchedAtMs: Date.now(),
      wasError: bullishError !== null && deribitError !== null,
      payload: {
        generatedAtIso: new Date().toISOString(),
        spotBtcUsdc,
        spotSource: spotSourceName,
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
        },
        deribit: {
          connected: deribitError === null,
          error: deribitError,
          environment: deribitEnv,
          paperMode: deribitPaper,
          equityBtc: deribitEquityBtc,
          balanceBtc: deribitBalanceBtc,
          equityUsdc: deribitEquityUsdc,
          balanceUsdc: deribitBalanceUsdc
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

  // 2026-05-21 — SHADOW-ONLY Bullish test-buy endpoint.
  //
  // Places ONE limit-IOC buy on Bullish mainnet using whatever
  // PILOT_BULLISH_ALLOW_MARGIN is set to. Designed to verify whether
  // the "limited risk" account status removes the 3003 (margin
  // required) error that previously blocked debit option buys with
  // allowMargin=false.
  //
  // SAFETY (multi-layer):
  //   • Returns 403 unless PILOT_DEPLOYMENT_TIER=shadow
  //   • Admin-token gated
  //   • Hard cap on contracts (defaults 0.01, max 0.1)
  //   • Hard cap on premium (defaults $25, max $50)
  //   • Pre-flight refusal if (price × qty) > maxPremiumUsdc
  //   • Single Bullish API call per invocation — no chain lookup, no
  //     balance check (cuts rate-limit pressure)
  //   • IOC self-cancels at venue → no orphan orders
  //
  // Body shape:
  //   {
  //     symbol: "BTC-USDC-20260522-90000-C",   // explicit, user-supplied
  //     limitPriceUsdcPerBtc: 50,              // limit price for the BUY
  //     contractsBtc: 0.01,                    // size (0.01-0.1 max)
  //     maxPremiumUsdc: 25                     // hard cap (default $25)
  //   }
  app.post("/volume-cover/admin/bullish-test-buy", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const body = (req.body ?? {}) as Record<string, any>;
    const symbol = String(body.symbol ?? "").trim();
    const limitPriceUsdcPerBtc = Number(body.limitPriceUsdcPerBtc);
    const contractsBtc = Number(body.contractsBtc);
    const maxPremiumUsdc = Number(body.maxPremiumUsdc ?? 25);

    // Validate required fields
    if (!symbol) return reply.code(400).send({ error: "missing_symbol" });
    if (!Number.isFinite(limitPriceUsdcPerBtc) || limitPriceUsdcPerBtc <= 0) {
      return reply.code(400).send({ error: "invalid_limitPriceUsdcPerBtc" });
    }
    if (!Number.isFinite(contractsBtc) || contractsBtc <= 0) {
      return reply.code(400).send({ error: "invalid_contractsBtc" });
    }

    // Symbol shape sanity check
    if (!/^[A-Z]+-[A-Z]+-\d{8}-\d+(?:\.\d+)?-(C|P)$/i.test(symbol)) {
      return reply.code(400).send({
        error: "invalid_symbol_format",
        expected: "BTC-USDC-YYYYMMDD-STRIKE-(C|P)",
        provided: symbol
      });
    }

    // Hard caps — defense against fat-finger.
    // 2026-05-23: raised from 0.1 → 1.0 BTC and $50 → $2000 to support
    // pre-flip scale-up tests (0.1 BTC) and live production runs (1.0
    // BTC). Caller is still expected to pass a sensible maxPremiumUsdc
    // — these endpoint-side caps are the LAST-RESORT ceiling.
    if (contractsBtc > 1.0) {
      return reply.code(400).send({
        error: "contracts_exceed_safety_cap",
        provided: contractsBtc,
        maxAllowed: 1.0
      });
    }
    const cappedMaxPremium = Math.min(maxPremiumUsdc, 2000);

    // 2026-05-23: relaxed pre-flight check. The previous check computed
    // worst_case = limitPriceUsdcPerBtc × contractsBtc and rejected if
    // that exceeded the cap — but for IOC orders the limit is just a
    // ceiling; actual fill happens at the venue's resting opposite
    // price (much less). Equating "limit × qty" with "actual cost"
    // forced operators to inflate maxPremiumUsdc beyond any real
    // budget, defeating the cap's purpose.
    //
    // The actual safety net is still in place at three layers:
    //   1. limitPriceUsdcPerBtc itself caps the worst-case fill
    //   2. cappedMaxPremium (≤ $2000) bounds the worst-case
    //      blast radius
    //   3. the operator's $MAX_CONTRACTS_BTC script-side gate
    //
    // We log the worst-case for telemetry but no longer hard-reject.
    const worstCasePremiumUsdc = limitPriceUsdcPerBtc * contractsBtc;
    if (worstCasePremiumUsdc > cappedMaxPremium) {
      console.log(
        `[bullish-test-buy] worst-case premium $${worstCasePremiumUsdc.toFixed(2)} ` +
          `exceeds cap $${cappedMaxPremium}, but accepting because actual fill is at venue ` +
          `price (much lower). Operator should size limitPriceUsdcPerBtc with current ask in mind.`
      );
    }

    // Bullish prices options in BTC per contract, not USDC. We need to
    // convert. Each contract is 1 BTC of underlying; the price field
    // on Bullish for an option is BTC per contract.
    //
    //   priceBtcPerContract = limitPriceUsdcPerBtc / spot_usdc
    //
    // We don't fetch fresh spot here to avoid an extra API call that
    // could trip rate limits — the caller is expected to have computed
    // limitPriceUsdcPerBtc with current spot in mind.
    //
    // Bullish price precision for options = 8 decimals (BTC); we'll
    // pass the quantity at 2 decimals (option contracts).
    //
    // Actually inspection of placeBullishOption shows for options the
    // price is sent in USDC-per-BTC at 4 decimals (the wire format
    // Bullish accepts). We'll match that here.
    const formattedPrice = limitPriceUsdcPerBtc.toFixed(4);
    const formattedQty = Math.floor(contractsBtc * 100) / 100;
    const formattedQtyStr = formattedQty.toFixed(2);

    if (formattedQty <= 0) {
      return reply.code(400).send({
        error: "qty_below_min",
        provided: contractsBtc,
        rounded: formattedQty,
        message: "Bullish option min qty is 0.01 BTC"
      });
    }

    // Bullish requires numeric clientOrderId (error 6104 INVALID_CLIENT_ORDER_ID
    // on non-numeric strings). Match the production VC adapter format.
    const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999)));

    // Single Bullish API call: createSpotLimitOrder. The client's
    // V3CreateOrder path passes allowMargin from config — we use the
    // current PILOT_BULLISH_ALLOW_MARGIN env value (set to false on
    // shadow when testing limited-risk account status).
    // Reuse a single JWT session across admin endpoints to avoid
    // MAX_SESSION_COUNT_REACHED (errorCode 8400).
    const client = await getBullishAdminClient();

    const requestPayload = {
      symbol,
      side: "BUY" as const,
      price: formattedPrice,
      quantity: formattedQtyStr,
      clientOrderId
    };

    // 2026-05-23: expected_premium reference was previously bound to the
    // hard-rejecting pre-flight check that we relaxed yesterday. The
    // logging + response field still want the value. Recompute it here
    // from the actual formatted price × quantity that's about to go
    // on the wire — same math as the pre-flight used.
    const expectedPremiumUsdc =
      Number(formattedPrice) * Number(formattedQtyStr);

    console.log(
      `[bullish-test-buy] SUBMITTING symbol=${symbol} qty=${formattedQtyStr} ` +
        `price=${formattedPrice} expectedPremium=$${expectedPremiumUsdc.toFixed(2)} ` +
        `allowMargin=${pilotConfig.bullish.allowMargin}`
    );

    const startMs = Date.now();
    let rawResponse: unknown = null;
    let bullishError: string | null = null;
    let bullishHttpStatus: number | null = null;
    let bullishStatusReasonCode: number | null = null;
    let bullishErrorCode: string | null = null;

    try {
      rawResponse = await client.createSpotLimitOrder(requestPayload);
    } catch (err: any) {
      bullishError = err?.message ?? "unknown";
      // Best-effort: parse "bullish_http_NNN:{...}" pattern from the
      // Bullish client's error message format.
      const match = String(bullishError).match(/bullish_http_(\d+):(.*)$/s);
      if (match) {
        bullishHttpStatus = Number(match[1]);
        try {
          const errBody = JSON.parse(match[2]);
          bullishErrorCode = errBody.errorCodeName ?? errBody.errorCode ?? null;
          bullishStatusReasonCode = errBody.statusReasonCode ?? null;
        } catch {
          // Leave parsed fields null
        }
      }
    }

    const elapsedMs = Date.now() - startMs;

    // Try to extract status reason code from response shape too (for
    // accepted-but-rejected cases where order placed but failed at
    // exchange-level checks).
    if (rawResponse && typeof rawResponse === "object") {
      const r = rawResponse as Record<string, any>;
      bullishStatusReasonCode =
        bullishStatusReasonCode ??
        r.statusReasonCode ??
        r.data?.statusReasonCode ??
        null;
    }

    // 2026-05-21: Bullish's REST POST /orders is async — "Command
    // acknowledged" only confirms the create command was queued, NOT
    // that the order actually filled or even passed risk checks at
    // matching. Chain an order-status query to get the truth.
    let orderStatusFinal: any = null;
    let orderStatusError: string | null = null;
    const orderId = (rawResponse as any)?.orderId
      || (rawResponse as any)?.data?.orderId;
    if (!bullishError && orderId) {
      try {
        // Brief settle wait — Bullish typically resolves within 1s
        await new Promise((resolve) => setTimeout(resolve, 1500));
        orderStatusFinal = await client.getOrderStatus(String(orderId));
      } catch (statusErr: any) {
        orderStatusError = statusErr?.message ?? "unknown";
      }
    }

    // Re-derive truth from order status if available, since the
    // synchronous create response is misleading.
    const finalStatus = orderStatusFinal?.status ?? "UNKNOWN";
    const finalFillPrice = orderStatusFinal?.fillPrice ?? 0;
    const finalFillQty = orderStatusFinal?.fillQuantity ?? 0;
    const finalReasonCode =
      (orderStatusFinal?.raw as any)?.statusReasonCode ?? null;
    const finalReason = (orderStatusFinal?.raw as any)?.statusReason ?? null;
    const finalIs3003 =
      String(finalReasonCode || "") === "3003" ||
      bullishStatusReasonCode === 3003 ||
      bullishErrorCode === "3003";
    // 2026-05-22: Bullish IOC orders that fully fill go to terminal status
    // "CLOSED" with reasonCode 6002 (Executed) — they do NOT sit in
    // "FILLED" status because there is no resting order remaining. The
    // previous check (finalStatus === "FILLED") rejected every successful
    // IOC fill as a failure, masking real-money trades as "ok: false".
    // Authoritative truth: finalFillQty > 0 with no 3003/error AND not
    // explicitly Expired/Rejected. Bullish reason codes:
    //   6002 = Executed (success — full or partial fill, IOC terminal)
    //   6004 = Expired  (no fill at price — failure)
    //   3003 = margin rejection (failure)
    const reasonStr = String(finalReason ?? "").toLowerCase();
    const wasExpired = reasonStr === "expired" || String(finalReasonCode || "") === "6004";
    const wasRejected =
      reasonStr === "rejected" || finalStatus === "REJECTED" || finalIs3003;
    const trulyFilled =
      Number(finalFillQty) > 0 && !wasExpired && !wasRejected;
    const success = !bullishError && trulyFilled;

    return reply.send({
      ok: success,
      generatedAtIso: new Date().toISOString(),
      elapsedMs,
      config: {
        allowMargin: pilotConfig.bullish.allowMargin,
        bullishMainnet: pilotConfig.bullish.restBaseUrl.includes("api.exchange.bullish.com"),
        restBaseUrl: pilotConfig.bullish.restBaseUrl,
        orderTif: pilotConfig.bullish.orderTif,
        tradingAccountId: pilotConfig.bullish.tradingAccountId
      },
      request: {
        ...requestPayload,
        expectedPremiumUsdc: Number(expectedPremiumUsdc.toFixed(2)),
        cap: cappedMaxPremium
      },
      result: {
        rawResponse,
        bullishError,
        bullishHttpStatus,
        bullishErrorCode,
        bullishStatusReasonCode,
        is3003: finalIs3003,
        // Authoritative — chained from order-status query
        orderId,
        finalStatus,
        finalFillPrice,
        finalFillQty,
        finalReasonCode,
        finalReason,
        wasExpired,
        wasRejected,
        orderStatusError
      }
    });
  });

  // 2026-05-21 — Bullish single-symbol order book inspector.
  //
  // Returns the top of the book (and depth if requested) for a single
  // symbol. Use to diagnose whether the book has bids/asks before
  // attempting test orders, and to verify tick size from the actual
  // resting prices.
  //
  // 1 Bullish API call per invocation. No auth needed in the venue
  // call itself (orderbook is a public REST endpoint).
  //
  // 2026-05-24: Removed shadow-tier gate. This is READ-ONLY public
  // market data (no order placement, no PII, no balance exposure),
  // and is needed on live for ops validation + pricing analysis
  // workflows (e.g. comparing Bullish vs Deribit during proposal
  // negotiation calibration). Admin-token auth remains required.
  app.get<{ Querystring: { symbol?: string; depth?: string } }>(
    "/volume-cover/admin/bullish-orderbook",
    async (req, reply) => {
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

      const symbol = String(req.query.symbol ?? "").trim();
      if (!symbol) return reply.code(400).send({ error: "missing_symbol" });
      const depth = Math.max(1, Math.min(10, Number(req.query.depth ?? 5)));

      const client = await getBullishAdminClient();
      const startMs = Date.now();
      try {
        const book = await client.getHybridOrderBook(symbol);
        const topBid = book.bids[0] ?? null;
        const topAsk = book.asks[0] ?? null;
        const midPrice =
          topBid && topAsk
            ? (Number(topBid.price) + Number(topAsk.price)) / 2
            : null;
        const spreadPct =
          topBid && topAsk && midPrice
            ? ((Number(topAsk.price) - Number(topBid.price)) / midPrice) * 100
            : null;
        return reply.send({
          ok: true,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          symbol,
          summary: {
            topBid,
            topAsk,
            midPrice,
            spreadPct: spreadPct !== null ? Number(spreadPct.toFixed(2)) : null,
            bidLevels: book.bids.length,
            askLevels: book.asks.length
          },
          bids: book.bids.slice(0, depth),
          asks: book.asks.slice(0, depth)
        });
      } catch (err: any) {
        return reply.code(502).send({
          ok: false,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          symbol,
          error: err?.message ?? "unknown"
        });
      }
    }
  );

  // 2026-05-21 — SHADOW-ONLY Bullish order-status query.
  //
  // Returns Bullish's authoritative status for a given orderId. Use to
  // determine whether an "Command acknowledged" order actually filled,
  // expired, or was rejected at the matching engine.
  //
  // Bullish's REST POST /orders is async — the synchronous response
  // only confirms the create command was accepted into their queue.
  // Real status (FILLED / EXPIRED / REJECTED with reason) requires a
  // GET on the order.
  //
  // GET /volume-cover/admin/bullish-order-status/:orderId
  app.get<{ Params: { orderId: string } }>(
    "/volume-cover/admin/bullish-order-status/:orderId",
    async (req, reply) => {
      if (!isShadowTier()) {
        return reply.code(403).send({
          error: "forbidden",
          reason: "endpoint_requires_shadow_tier"
        });
      }
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

      const orderId = String(req.params.orderId || "").trim();
      if (!orderId || !/^\d+$/.test(orderId)) {
        return reply.code(400).send({
          error: "invalid_orderId",
          message: "orderId must be a numeric string"
        });
      }

      const client = await getBullishAdminClient();

      const startMs = Date.now();
      try {
        const status = await client.getOrderStatus(orderId);
        return reply.send({
          ok: true,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          orderId,
          status: status.status,
          fillPrice: status.fillPrice,
          fillQuantity: status.fillQuantity,
          fees: status.fees,
          raw: status.raw
        });
      } catch (err: any) {
        return reply.code(502).send({
          ok: false,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          orderId,
          error: err?.message ?? "unknown"
        });
      }
    }
  );

  // 2026-05-21 — SHADOW-ONLY Bullish asset-balances snapshot.
  //
  // Returns balance per asset (USDC, BTC, etc.) on the configured
  // trading account, fetched via the private WebSocket assetAccounts
  // topic. Use to verify USDC is actually parked on the correct
  // trading account before placing orders.
  //
  // GET /volume-cover/admin/bullish-asset-balances
  app.get("/volume-cover/admin/bullish-asset-balances", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const client = await getBullishAdminClient();

    const startMs = Date.now();
    try {
      const balances = await client.getAssetBalances({ timeoutMs: 8000 });
      return reply.send({
        ok: true,
        generatedAtIso: new Date().toISOString(),
        elapsedMs: Date.now() - startMs,
        tradingAccountId: pilotConfig.bullish.tradingAccountId,
        balances: balances.map((b) => ({
          asset: b.assetSymbol,
          available: b.availableQuantity,
          locked: b.lockedQuantity,
          borrowed: b.borrowedQuantity
        }))
      });
    } catch (err: any) {
      return reply.code(502).send({
        ok: false,
        generatedAtIso: new Date().toISOString(),
        elapsedMs: Date.now() - startMs,
        tradingAccountId: pilotConfig.bullish.tradingAccountId,
        error: err?.message ?? "unknown"
      });
    }
  });

  // 2026-05-23 — SHADOW-ONLY Bullish OPTION positions endpoint.
  //
  // Returns only the rows from assetAccounts that look like option
  // contracts (asset matches BTC-USDC-YYYYMMDD-NNNN-(P|C)). Used as
  // "definitive residual position verification" — after any
  // multi-leg test, hit this endpoint to see exactly what (if any)
  // option exposure remains.
  //
  // Long position: available > 0
  // Short position: borrowed > 0 (Bullish models naked-short option
  //                                exposure via the borrowed field on
  //                                the underlying contract asset row)
  //
  // Optional ?enrichMark=true triggers a per-symbol orderbook lookup
  // (mid price) so the response shows mark-to-market USDC value of
  // each position. Disabled by default to keep latency low.
  //
  // GET /volume-cover/admin/bullish-option-positions
  app.get<{ Querystring: { enrichMark?: string } }>(
    "/volume-cover/admin/bullish-option-positions",
    async (req, reply) => {
      if (!isShadowTier()) {
        return reply.code(403).send({
          error: "forbidden",
          reason: "endpoint_requires_shadow_tier"
        });
      }
      if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

      const enrichMark = String(req.query.enrichMark ?? "").toLowerCase() === "true";
      const client = await getBullishAdminClient();
      const startMs = Date.now();
      try {
        const balances = await client.getAssetBalances({ timeoutMs: 8000 });

        // Bullish option contract symbols: BTC-USDC-YYYYMMDD-NNNNN-{P,C}
        const optionSymbolRegex = /^([A-Z]+)-([A-Z]+)-(\d{8})-(\d+)-(P|C)$/;

        type OptionPositionView = {
          symbol: string;
          underlying: string;
          quote: string;
          expiryIso: string;
          strikeUsdc: number;
          optionKind: "put" | "call";
          availableQty: number;
          lockedQty: number;
          borrowedQty: number;
          netQty: number; // available - borrowed
          side: "long" | "short" | "neutral";
          markUsdc: number | null;
          markValueUsdc: number | null;
        };

        const parseExpiry = (yyyymmdd: string): string => {
          const y = yyyymmdd.slice(0, 4);
          const m = yyyymmdd.slice(4, 6);
          const d = yyyymmdd.slice(6, 8);
          return `${y}-${m}-${d}T08:00:00Z`; // Bullish 08:00 UTC settlement
        };

        const optionRows: OptionPositionView[] = [];
        for (const b of balances) {
          const m = b.assetSymbol.match(optionSymbolRegex);
          if (!m) continue;
          const available = Number(b.availableQuantity);
          const locked = Number(b.lockedQuantity);
          const borrowed = Number(b.borrowedQuantity);
          if (!Number.isFinite(available) || !Number.isFinite(borrowed)) continue;
          if (available === 0 && borrowed === 0 && locked === 0) continue;
          const net = available - borrowed;
          const side: OptionPositionView["side"] =
            net > 1e-9 ? "long" : net < -1e-9 ? "short" : "neutral";
          optionRows.push({
            symbol: b.assetSymbol,
            underlying: m[1],
            quote: m[2],
            expiryIso: parseExpiry(m[3]),
            strikeUsdc: Number(m[4]),
            optionKind: m[5] === "P" ? "put" : "call",
            availableQty: available,
            lockedQty: Number.isFinite(locked) ? locked : 0,
            borrowedQty: borrowed,
            netQty: net,
            side,
            markUsdc: null,
            markValueUsdc: null
          });
        }

        // Optional per-symbol mark-to-market via orderbook mid.
        if (enrichMark && optionRows.length > 0) {
          await Promise.all(
            optionRows.map(async (row) => {
              try {
                const book = await client.getHybridOrderBook(row.symbol);
                const topBid = Number(book.bids[0]?.price ?? NaN);
                const topAsk = Number(book.asks[0]?.price ?? NaN);
                if (Number.isFinite(topBid) && Number.isFinite(topAsk)) {
                  const mid = (topBid + topAsk) / 2;
                  row.markUsdc = Number(mid.toFixed(4));
                  row.markValueUsdc = Number((mid * row.netQty).toFixed(4));
                } else if (Number.isFinite(topBid)) {
                  row.markUsdc = topBid;
                  row.markValueUsdc = Number((topBid * row.netQty).toFixed(4));
                } else if (Number.isFinite(topAsk)) {
                  row.markUsdc = topAsk;
                  row.markValueUsdc = Number((topAsk * row.netQty).toFixed(4));
                }
              } catch {
                // Leave mark fields null; row still reported.
              }
            })
          );
        }

        // Group totals.
        const longCount = optionRows.filter((r) => r.side === "long").length;
        const shortCount = optionRows.filter((r) => r.side === "short").length;
        const totalMtmUsdc = optionRows.reduce(
          (sum, r) => sum + (r.markValueUsdc ?? 0),
          0
        );

        return reply.send({
          ok: true,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          tradingAccountId: pilotConfig.bullish.tradingAccountId,
          totals: {
            optionPositionsCount: optionRows.length,
            longCount,
            shortCount,
            totalMtmUsdc: enrichMark ? Number(totalMtmUsdc.toFixed(4)) : null
          },
          positions: optionRows
        });
      } catch (err: any) {
        return reply.code(502).send({
          ok: false,
          generatedAtIso: new Date().toISOString(),
          elapsedMs: Date.now() - startMs,
          tradingAccountId: pilotConfig.bullish.tradingAccountId,
          error: err?.message ?? "unknown"
        });
      }
    }
  );

  // 2026-05-21 — SHADOW-ONLY Bullish trading-accounts lister.
  //
  // Returns every trading account visible to the authenticated user
  // (the JWT we get from loginWithEcdsa). Useful for finding the
  // correct account ID when Bullish provisioned multiple sub-accounts
  // (spot, options, margin) and we need to know which to use for
  // option orders.
  //
  // Bypasses the config-side filter that getTradingAccounts() applies,
  // so we see the full list regardless of what's in
  // PILOT_BULLISH_TRADING_ACCOUNT_ID.
  app.get("/volume-cover/admin/bullish-list-accounts", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    // Build a client config that explicitly clears tradingAccountId
    // so the lister returns ALL accounts (the default getTradingAccounts
    // filters down to the configured one). Use shared wide-singleton to
    // avoid burning another Bullish session for diagnostic-only listing.
    const { getSharedWideBullishClient } = await import("../pilot/bullishClient");
    const client = getSharedWideBullishClient(pilotConfig.bullish);

    const startMs = Date.now();
    let raw: unknown = null;
    let errorMessage: string | null = null;

    try {
      raw = await client.getTradingAccounts();
    } catch (err: any) {
      errorMessage = err?.message ?? "unknown";
    }

    const elapsedMs = Date.now() - startMs;

    // Normalize the response to a flat list of {tradingAccountId, ...}
    let accounts: Array<Record<string, unknown>> | null = null;
    if (raw && typeof raw === "object") {
      const data = (raw as any).data;
      if (Array.isArray(data)) accounts = data;
      else if (Array.isArray(raw)) accounts = raw as any;
    }

    return reply.send({
      ok: errorMessage === null,
      generatedAtIso: new Date().toISOString(),
      elapsedMs,
      authUserId: "(check bullish-key-check endpoint for userId from metadata)",
      configuredTradingAccountId: pilotConfig.bullish.tradingAccountId || null,
      accounts: accounts
        ? accounts.map((a) => ({
            tradingAccountId: a.tradingAccountId ?? null,
            label: a.label ?? a.name ?? a.accountType ?? null,
            type: a.type ?? a.tradingAccountType ?? null,
            isPrimary: a.isPrimary ?? null,
            // Don't return balances here — that's a separate concern
            // and can be fetched explicitly via /admin/venue-balances
          }))
        : null,
      raw,
      error: errorMessage
    });
  });

  // 2026-05-21 — SHADOW-ONLY Bullish test-sell endpoint.
  //
  // Mirror of bullish-test-buy, but submits a SELL IOC limit order.
  // Designed for round-trip Phase 1 validation: buy a cheap option,
  // then sell it back to confirm the close path works on Bullish.
  //
  // Trick: we set the limit price LOW (e.g., $0.01/BTC) so IOC SELL
  // fills at the bid (price improvement), guaranteeing fill if any
  // bid exists. Conversely, the maxNotionalUsdc cap protects against
  // wildly-wrong fills (shouldn't happen on a real exchange but worth
  // belt-and-suspenders).
  //
  // SAFETY (mirrors test-buy):
  //   • 403 unless PILOT_DEPLOYMENT_TIER=shadow
  //   • Admin-token gated
  //   • Hard cap on contracts (≤ 0.1)
  //   • Hard cap on maxNotionalUsdc (≤ $50)
  //   • Single Bullish API call per invocation
  //   • IOC self-cancels at venue
  //
  // CRITICAL: this endpoint will only be safe if you actually own the
  // contracts you're trying to sell. Selling without an underlying
  // position would require margin (PILOT_BULLISH_ALLOW_MARGIN=false
  // means Bullish should reject; that's the system protecting you).
  //
  // Body shape:
  //   {
  //     symbol: "BTC-USDC-20260522-80000-C",
  //     limitPriceUsdcPerBtc: 0.01,          // low — fills at bid
  //     contractsBtc: 0.01,
  //     maxNotionalUsdc: 25                  // hard cap on assumed proceeds
  //   }
  app.post("/volume-cover/admin/bullish-test-sell", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const body = (req.body ?? {}) as Record<string, any>;
    const symbol = String(body.symbol ?? "").trim();
    const limitPriceUsdcPerBtc = Number(body.limitPriceUsdcPerBtc);
    const contractsBtc = Number(body.contractsBtc);
    const maxNotionalUsdc = Number(body.maxNotionalUsdc ?? 25);

    if (!symbol) return reply.code(400).send({ error: "missing_symbol" });
    if (!Number.isFinite(limitPriceUsdcPerBtc) || limitPriceUsdcPerBtc <= 0) {
      return reply.code(400).send({ error: "invalid_limitPriceUsdcPerBtc" });
    }
    if (!Number.isFinite(contractsBtc) || contractsBtc <= 0) {
      return reply.code(400).send({ error: "invalid_contractsBtc" });
    }

    if (!/^[A-Z]+-[A-Z]+-\d{8}-\d+(?:\.\d+)?-(C|P)$/i.test(symbol)) {
      return reply.code(400).send({
        error: "invalid_symbol_format",
        expected: "BTC-USDC-YYYYMMDD-STRIKE-(C|P)",
        provided: symbol
      });
    }

    // 2026-05-23: raised from 0.1 → 1.0 BTC and $50 → $2000 (same
    // rationale as bullish-test-buy — pre-flip + production scale).
    if (contractsBtc > 1.0) {
      return reply.code(400).send({
        error: "contracts_exceed_safety_cap",
        provided: contractsBtc,
        maxAllowed: 1.0
      });
    }
    const cappedMaxNotional = Math.min(maxNotionalUsdc, 2000);

    const formattedPrice = limitPriceUsdcPerBtc.toFixed(4);
    const formattedQty = Math.floor(contractsBtc * 100) / 100;
    const formattedQtyStr = formattedQty.toFixed(2);

    if (formattedQty <= 0) {
      return reply.code(400).send({
        error: "qty_below_min",
        provided: contractsBtc,
        rounded: formattedQty,
        message: "Bullish option min qty is 0.01 BTC"
      });
    }

    const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999)));

    const client = await getBullishAdminClient();

    const requestPayload = {
      symbol,
      side: "SELL" as const,
      price: formattedPrice,
      quantity: formattedQtyStr,
      clientOrderId
    };

    console.log(
      `[bullish-test-sell] SUBMITTING symbol=${symbol} qty=${formattedQtyStr} ` +
        `price=${formattedPrice} maxNotional=$${cappedMaxNotional} ` +
        `allowMargin=${pilotConfig.bullish.allowMargin}`
    );

    const startMs = Date.now();
    let rawResponse: unknown = null;
    let bullishError: string | null = null;
    let bullishHttpStatus: number | null = null;
    let bullishStatusReasonCode: number | null = null;
    let bullishErrorCode: string | null = null;

    try {
      rawResponse = await client.createSpotLimitOrder(requestPayload);
    } catch (err: any) {
      bullishError = err?.message ?? "unknown";
      const match = String(bullishError).match(/bullish_http_(\d+):(.*)$/s);
      if (match) {
        bullishHttpStatus = Number(match[1]);
        try {
          const errBody = JSON.parse(match[2]);
          bullishErrorCode = errBody.errorCodeName ?? errBody.errorCode ?? null;
          bullishStatusReasonCode = errBody.statusReasonCode ?? null;
        } catch {
          // Leave parsed fields null
        }
      }
    }

    const elapsedMs = Date.now() - startMs;

    if (rawResponse && typeof rawResponse === "object") {
      const r = rawResponse as Record<string, any>;
      bullishStatusReasonCode =
        bullishStatusReasonCode ??
        r.statusReasonCode ??
        r.data?.statusReasonCode ??
        null;
    }

    let orderStatusFinal: any = null;
    let orderStatusError: string | null = null;
    const orderId = (rawResponse as any)?.orderId
      || (rawResponse as any)?.data?.orderId;
    if (!bullishError && orderId) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        orderStatusFinal = await client.getOrderStatus(String(orderId));
      } catch (statusErr: any) {
        orderStatusError = statusErr?.message ?? "unknown";
      }
    }

    const finalStatus = orderStatusFinal?.status ?? "UNKNOWN";
    const finalFillPrice = orderStatusFinal?.fillPrice ?? 0;
    const finalFillQty = orderStatusFinal?.fillQuantity ?? 0;
    const finalReasonCode =
      (orderStatusFinal?.raw as any)?.statusReasonCode ?? null;
    const finalReason = (orderStatusFinal?.raw as any)?.statusReason ?? null;
    // 2026-05-22: see bullish-test-buy for the rationale. IOC SELL that
    // fully fills returns status=CLOSED + reason=Executed (6002); the
    // previous status==="FILLED" check incorrectly reported success=false
    // on every successful sale.
    const reasonStrSell = String(finalReason ?? "").toLowerCase();
    const wasExpired = reasonStrSell === "expired" || String(finalReasonCode || "") === "6004";
    const wasRejected = reasonStrSell === "rejected" || finalStatus === "REJECTED";
    const trulyFilled =
      Number(finalFillQty) > 0 && !wasExpired && !wasRejected;
    const success = !bullishError && trulyFilled;

    return reply.send({
      ok: success,
      generatedAtIso: new Date().toISOString(),
      elapsedMs,
      config: {
        allowMargin: pilotConfig.bullish.allowMargin,
        bullishMainnet: pilotConfig.bullish.restBaseUrl.includes("api.exchange.bullish.com"),
        restBaseUrl: pilotConfig.bullish.restBaseUrl,
        orderTif: pilotConfig.bullish.orderTif,
        tradingAccountId: pilotConfig.bullish.tradingAccountId
      },
      request: {
        ...requestPayload,
        cap: cappedMaxNotional
      },
      result: {
        rawResponse,
        bullishError,
        bullishHttpStatus,
        bullishErrorCode,
        bullishStatusReasonCode,
        orderId,
        finalStatus,
        finalFillPrice,
        finalFillQty,
        finalReasonCode,
        finalReason,
        wasExpired,
        wasRejected,
        orderStatusError
      }
    });
  });

  // ============================================================================
  // POST /volume-cover/admin/bullish-cross-account-sell
  //
  // 2026-05-24 — One-shot cross-sub-account sell endpoint.
  //
  // CONTEXT: pilotConfig.bullish.tradingAccountId is hard-wired to the
  // Options sub-account (111257696062450). Operators occasionally need to
  // sell positions that live on OTHER sub-accounts owned by the same
  // Bullish user (e.g. Primary 111804098837415). Bullish API auth is
  // USER-scoped (JWT obtained via ECDSA login covers all sub-accounts the
  // user owns); the sub-account is selected per-request via the
  // `tradingAccountId` field in the V3CreateOrder command body. The
  // standard test-sell endpoint uses `createSpotLimitOrder` which
  // hard-codes config.tradingAccountId — so this endpoint bypasses that
  // helper and submits the command directly via `submitCommand` with the
  // caller-provided `tradingAccountId`.
  //
  // SAFETY (mirrors bullish-test-sell):
  //   • 403 unless PILOT_DEPLOYMENT_TIER=shadow
  //   • Admin-token gated
  //   • Hard caps: contractsBtc ≤ 5.0, notional ≤ $5000
  //   • Hard-coded IOC TIF (self-cancels at venue if no match)
  //   • Single Bullish API call per invocation
  //   • Polls order status for ≤ 8s after submit using the same
  //     tradingAccountId (Bullish GET /orders/:id is per-sub-account)
  //
  // Body shape:
  //   {
  //     tradingAccountId: "111804098837415",          // required, 15 digits
  //     symbol: "BTC-USDC-20260526-77000-C",          // required
  //     side: "SELL",                                  // SELL only (safety)
  //     price: "580",                                  // limit price in USDC/BTC
  //     quantity: "0.498",                             // BTC contracts
  //     timeInForce: "IOC"                             // IOC only (safety)
  //   }
  // ============================================================================
  app.post("/volume-cover/admin/bullish-cross-account-sell", async (req, reply) => {
    if (!isShadowTier()) {
      return reply.code(403).send({
        error: "forbidden",
        reason: "endpoint_requires_shadow_tier"
      });
    }
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });

    const body = (req.body ?? {}) as Record<string, any>;
    const tradingAccountId = String(body.tradingAccountId ?? "").trim();
    const symbol = String(body.symbol ?? "").trim();
    const side = String(body.side ?? "SELL").trim().toUpperCase();
    const price = String(body.price ?? "").trim();
    const quantity = String(body.quantity ?? "").trim();
    const timeInForce = String(body.timeInForce ?? "IOC").trim().toUpperCase();
    // 2026-05-24: Bullish rejects orders with statusReasonCode 3003
    // ("Borrowing is unavailable, margin not enabled") on sub-accounts
    // that don't have margin enabled (e.g. Primary 111804098837415).
    // SELL-to-close of an existing long position never NEEDS margin, so
    // default the margin flags to FALSE here. Caller can override via
    // useMargin=true if explicitly needed (e.g. naked short open).
    const useMargin = body.useMargin === true;

    if (!/^\d{15}$/.test(tradingAccountId)) {
      return reply.code(400).send({ error: "tradingAccountId_must_be_15_digit_numeric_string" });
    }
    if (!symbol || !/^[A-Z]+-[A-Z]+-\d{8}-\d+-(C|P)$/i.test(symbol)) {
      return reply.code(400).send({
        error: "invalid_symbol_format",
        expected: "BTC-USDC-YYYYMMDD-STRIKE-(C|P)",
        provided: symbol
      });
    }
    if (side !== "SELL") {
      return reply.code(400).send({ error: "side_must_be_SELL", note: "BUY blocked on this endpoint for safety" });
    }
    if (timeInForce !== "IOC") {
      return reply.code(400).send({ error: "timeInForce_must_be_IOC", note: "DAY/GTC blocked for safety" });
    }
    const priceN = Number(price);
    const qtyN = Number(quantity);
    if (!Number.isFinite(priceN) || priceN <= 0) {
      return reply.code(400).send({ error: "invalid_price", provided: price });
    }
    if (!Number.isFinite(qtyN) || qtyN <= 0 || qtyN > 5.0) {
      return reply.code(400).send({ error: "invalid_quantity_or_exceeds_cap_5BTC", provided: quantity });
    }
    const notional = priceN * qtyN;
    if (notional > 5000) {
      return reply.code(400).send({ error: "notional_exceeds_cap_5000_USDC", notional });
    }

    const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999)));

    const client = await getBullishAdminClient();

    // Build V3CreateOrder command directly (bypass createSpotLimitOrder helper
    // which hard-codes config.tradingAccountId). Key order MUST match the
    // platform's helper so signed canonical string is consistent with what
    // the Bullish auth flow expects.
    const command: Record<string, unknown> = {
      commandType: "V3CreateOrder",
      symbol,
      type: "LIMIT",
      side,
      price,
      quantity,
      timeInForce,
      clientOrderId,
      tradingAccountId,
      allowMargin: useMargin,
      allowBorrow: useMargin,
      margin: useMargin
    };

    console.log(
      `[bullish-cross-account-sell] SUBMITTING tradingAccountId=${tradingAccountId} ` +
        `symbol=${symbol} side=${side} qty=${quantity} price=${price} TIF=${timeInForce} ` +
        `useMargin=${useMargin} clientOrderId=${clientOrderId}`
    );

    const startMs = Date.now();
    let rawResponse: unknown = null;
    let bullishError: string | null = null;
    let bullishHttpStatus: number | null = null;
    let bullishErrorCode: string | null = null;

    try {
      rawResponse = await client.submitCommand(command);
    } catch (err: any) {
      bullishError = err?.message ?? "unknown";
      const match = String(bullishError).match(/bullish_http_(\d+):(.*)$/s);
      if (match) {
        bullishHttpStatus = Number(match[1]);
        try {
          const errBody = JSON.parse(match[2]);
          bullishErrorCode = errBody.errorCodeName ?? errBody.errorCode ?? null;
        } catch {
          // Leave bullishErrorCode null
        }
      }
    }

    let orderStatusFinal: any = null;
    let orderStatusError: string | null = null;
    const orderId =
      (rawResponse as any)?.orderId || (rawResponse as any)?.data?.orderId;
    if (!bullishError && orderId) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        orderStatusFinal = await client.getOrderStatus(String(orderId), { tradingAccountId });
      } catch (statusErr: any) {
        orderStatusError = statusErr?.message ?? "unknown";
      }
    }

    const finalStatus = orderStatusFinal?.status ?? "UNKNOWN";
    const finalFillPrice = orderStatusFinal?.fillPrice ?? 0;
    const finalFillQty = orderStatusFinal?.fillQuantity ?? 0;
    const finalReasonCode = (orderStatusFinal?.raw as any)?.statusReasonCode ?? null;
    const finalReason = (orderStatusFinal?.raw as any)?.statusReason ?? null;
    const reasonStr = String(finalReason ?? "").toLowerCase();
    const wasExpired = reasonStr === "expired" || String(finalReasonCode || "") === "6004";
    const wasRejected = reasonStr === "rejected" || finalStatus === "REJECTED";
    const trulyFilled = Number(finalFillQty) > 0 && !wasExpired && !wasRejected;
    const success = !bullishError && trulyFilled;

    return reply.send({
      ok: success,
      generatedAtIso: new Date().toISOString(),
      elapsedMs: Date.now() - startMs,
      config: {
        platformDefaultTradingAccountId: pilotConfig.bullish.tradingAccountId,
        targetTradingAccountId: tradingAccountId,
        crossAccountSell:
          pilotConfig.bullish.tradingAccountId !== tradingAccountId,
        bullishMainnet: pilotConfig.bullish.restBaseUrl.includes("api.exchange.bullish.com"),
        restBaseUrl: pilotConfig.bullish.restBaseUrl
      },
      request: {
        command,
        notional
      },
      result: {
        rawResponse,
        bullishError,
        bullishHttpStatus,
        bullishErrorCode,
        orderId,
        finalStatus,
        finalFillPrice,
        finalFillQty,
        finalReasonCode,
        finalReason,
        wasExpired,
        wasRejected,
        orderStatusError
      }
    });
  });

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

    // Pull markets from Bullish via shared singleton (built-in 120s cache).
    const { getSharedBullishClient } = await import("../pilot/bullishClient");
    const client = getSharedBullishClient(pilotConfig.bullish);
    let markets: any[] = [];
    try {
      markets = await client.getMarkets({ cacheTtlMs: 120_000 });
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
    const { getSharedBullishClient } = await import("../pilot/bullishClient");
    const client = getSharedBullishClient(pilotConfig.bullish);
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
   * Dry-run an IOC limit BUY against live Deribit — proves the new
   * (post-2026-05-20) order path works end-to-end without spending.
   *
   * How it works:
   *   1. Pick a near-the-money BTC option (auto-resolved via getOrderBook).
   *   2. Place a LIMIT BUY at `ask × 0.10` (i.e. ~90% BELOW the market
   *      ask) with `time_in_force: immediate_or_cancel`.
   *   3. Deribit accepts the order (pre-flight reserve is tiny because
   *      limit_price × amount is tiny), tries to fill at the limit,
   *      finds no seller anywhere near that price, and instantly
   *      cancels the unfilled portion. Result: order_state="cancelled",
   *      filled_amount=0, ZERO BTC spent, ZERO fees.
   *
   * What this proves:
   *   • Deribit credentials work (private endpoint reached)
   *   • `time_in_force: immediate_or_cancel` is accepted by Deribit
   *   • Pre-flight margin math is honest (no 10039 rejection)
   *   • Our request shape (instrument_name, amount, type, price, TIF)
   *     is valid
   *
   * If THIS returns order_state="cancelled" with filled_amount=0, the
   * REAL activate (which uses the same code path with a higher limit
   * that WILL fill) is highly likely to succeed.
   *
   * Query params:
   *   - instrument (optional, default = BTC-23MAY26-77000-P): the
   *     instrument to test against. Pick something with a tight book.
   *   - amount (optional, default = 0.1): contracts. Min 0.1, multiples
   *     of 0.1.
   *
   * Auth: X-Admin-Token header (same as other admin endpoints).
   */
  app.post("/volume-cover/admin/deribit-dry-run-buy", async (req, reply) => {
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
      return reply.code(400).send({
        ok: false,
        error: "deribit_credentials_missing",
        message: "Set DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET in Render env."
      });
    }
    if (paperRaw === "true") {
      return reply.code(400).send({
        ok: false,
        error: "deribit_paper_mode",
        message:
          "DERIBIT_PAPER=true — dry-run only meaningful against live API. " +
          "Set DERIBIT_PAPER=false in Render env to run this test."
      });
    }

    const q = (req as any).query || {};
    const instrument = String(q.instrument || "BTC-23MAY26-77000-P").trim();
    const amountRaw = Number(q.amount || "0.1");
    const amount = Math.max(0.1, Math.floor(amountRaw * 10) / 10);

    const { DeribitConnector } = await import("@foxify/connectors");
    const connector = new DeribitConnector(
      env === "live" ? "live" : "testnet",
      false,
      {
        clientId: String(process.env.DERIBIT_CLIENT_ID || ""),
        clientSecret: String(process.env.DERIBIT_CLIENT_SECRET || "")
      }
    );

    // Step 1: fetch the orderbook to get a current ask we can size the
    // intentionally-too-low limit against.
    let bestAsk = 0;
    let bestBid = 0;
    let bookRaw: any = null;
    try {
      const book = await connector.getOrderBook(instrument);
      bookRaw = book;
      bestAsk = Number((book as any)?.result?.asks?.[0]?.[0] ?? 0);
      bestBid = Number((book as any)?.result?.bids?.[0]?.[0] ?? 0);
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        stage: "fetch_orderbook",
        instrument,
        error: (err as Error).message
      });
    }
    if (!Number.isFinite(bestAsk) || bestAsk <= 0) {
      return reply.code(502).send({
        ok: false,
        stage: "fetch_orderbook",
        error: "no_ask",
        instrument,
        bookSnippet: JSON.stringify(bookRaw).slice(0, 400)
      });
    }

    // Step 2: build a limit at ask × 0.10, snapped DOWN to tick
    // (further from the market = even less likely to fill).
    const rawLimit = bestAsk * 0.10;
    const tick = rawLimit >= 0.005 ? 0.0005 : 0.0001;
    const snappedLimit = Math.max(tick, Math.floor(rawLimit / tick) * tick);
    const limitPriceBtc = Number(snappedLimit.toFixed(4));

    console.log(
      `[DryRun] deribit-dry-run-buy REQUEST instrument=${instrument} amount=${amount} ` +
      `type=limit price=${limitPriceBtc} timeInForce=immediate_or_cancel ` +
      `(bestAsk=${bestAsk} bestBid=${bestBid} → limit at 10% of ask, IOC-cancels)`
    );

    let raw: any;
    let placeError: string | null = null;
    try {
      raw = await connector.placeOrder({
        instrument,
        amount,
        side: "buy",
        type: "limit",
        price: limitPriceBtc,
        timeInForce: "immediate_or_cancel"
      });
    } catch (err) {
      placeError = (err as Error).message;
    }

    console.log(`[DryRun] deribit-dry-run-buy RESPONSE: ${JSON.stringify(raw).slice(0, 800)}`);

    const orderData = raw?.result?.order ?? null;
    const orderState = String(orderData?.order_state ?? "unknown");
    const filledAmount = Number(orderData?.filled_amount ?? 0);
    const cancelledNoFill = orderState === "cancelled" && filledAmount === 0;

    return reply.send({
      ok: true,
      stage: "complete",
      request: {
        instrument,
        amount,
        side: "buy",
        type: "limit",
        price: limitPriceBtc,
        timeInForce: "immediate_or_cancel"
      },
      orderbook: { bestAsk, bestBid, askInBtc: bestAsk, bidInBtc: bestBid },
      response: {
        orderState,
        filledAmount,
        orderId: orderData?.order_id ?? null,
        cancelledNoFill,
        raw
      },
      placeError,
      verdict: cancelledNoFill
        ? "PASS — IOC limit at 10% of ask was accepted by Deribit and cancelled with zero fill. " +
          "Pre-flight + auth + time_in_force all confirmed working. Real activate at ask×1.15 will fill."
        : filledAmount > 0
        ? `WARNING — order partially or fully filled (${filledAmount} contracts). This shouldn't ` +
          `happen at 10% of ask. Check the book — there may be stale resting bids near limit.`
        : `REVIEW — order_state=${orderState}. Inspect 'response.raw' for Deribit's reason.`
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

    // Ledger entry: hedge_sell_in. Canonical source of truth for
    // realized proceeds. Without this row the weekly reconciler and
    // Foxify reports under-report Atticus inflows.
    const positionId = String(leg.position_id ?? "");
    let ledgerInserted: boolean = false;
    try {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: positionId || null,
        entryType: "hedge_sell_in",
        amountUsdc: sellResult.totalProceedsUsdc,
        reference: `vc_hedge_sell_force:${legId}`,
        metadata: {
          product: "volume_cover",
          source: "force-sell-leg",
          venue,
          option_kind: optionKind,
          strike_usdc: strikeUsdc,
          contracts_btc: contractsBtc,
          fill_price_usdc_per_btc: sellResult.fillPriceUsdcPerBtc,
          order_id: sellResult.orderId
        }
      });
      ledgerInserted = true;
    } catch (err) {
      req.log.warn(
        `[volume-cover/force-sell-leg] ledger insert failed for leg ${legId}: ${(err as Error).message}`
      );
    }

    // If this leg belongs to a triggered position, finalize that
    // position's salvage_event so Guard A (7d loss) and Guard B
    // (rolling salvage %) reflect realized proceeds.
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
      ledgerInserted,
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

    const positionId = String(leg.position_id ?? "");

    // Ledger entry: hedge_sell_in. Canonical source of truth for
    // realized proceeds even when the venue side already filled
    // and we are reconciling the DB after a 5xx.
    let ledgerInserted: boolean = false;
    try {
      await insertLedgerEntry(pool, {
        poolId: "atticus_hedge",
        protectionId: positionId || null,
        entryType: "hedge_sell_in",
        amountUsdc: body.totalProceedsUsdc,
        reference: `vc_hedge_sell_manual:${legId}`,
        metadata: {
          product: "volume_cover",
          source: "mark-leg-sold-manual",
          venue: String(leg.venue),
          option_kind: String(leg.option_kind),
          strike_usdc: Number(leg.strike_usdc),
          contracts_btc: Number(leg.contracts),
          fill_price_usdc_per_btc: body.fillPriceUsdcPerBtc,
          order_id: body.orderId,
          manual_reason: body.reason
        }
      });
      ledgerInserted = true;
    } catch (err) {
      req.log.warn(
        `[volume-cover/mark-leg-sold-manual] ledger insert failed for leg ${legId}: ${(err as Error).message}`
      );
    }

    let salvageFinalized: boolean | null = null;
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
      ledgerInserted,
      salvageFinalized
    });
  });

  /**
   * Clear test/admin-source pair_event rows from the audit log so
   * the Foxify dashboard "activations today" counter reflects only
   * real Foxify-driven activations.
   *
   * Default behavior (dry-run): returns the candidates that WOULD
   * be deleted. Pass ?confirm=true to actually delete.
   *
   * Candidates are pair_events where ANY of:
   *   - metadata.source = 'admin_test_activate'
   *   - foxify_pair_id starts with 'ops-smoke-'
   *   - foxify_pair_id starts with 'test-' or 'smoke-'
   *
   * Default window: last 72 hours (override with ?hours=N).
   *
   * Does NOT touch volume_cover_position or volume_cover_hedge_leg
   * rows — those should be cleaned via mark-legs-failed-batch or
   * direct close. This is purely audit-log cleanup.
   */
  app.post("/volume-cover/admin/clear-test-pair-events", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const confirm = String((req.query as any)?.confirm ?? "false").toLowerCase() === "true";
    const hoursRaw = Number((req.query as any)?.hours ?? 72);
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 720 ? hoursRaw : 72;

    const candidates = await pool.query(
      `SELECT id, foxify_pair_id, cell_id, result, received_at, metadata
         FROM volume_cover_pair_event
        WHERE received_at >= NOW() - ($1::text || ' hours')::interval
          AND (
            (metadata->>'source') = 'admin_test_activate'
            OR foxify_pair_id LIKE 'ops-smoke-%'
            OR foxify_pair_id LIKE 'test-%'
            OR foxify_pair_id LIKE 'smoke-%'
          )
        ORDER BY received_at DESC
        LIMIT 500`,
      [String(hours)]
    );

    if (!confirm) {
      return reply.send({
        dryRun: true,
        hours,
        candidateCount: candidates.rows.length,
        candidates: candidates.rows.map((r: any) => ({
          id: Number(r.id),
          foxifyPairId: String(r.foxify_pair_id),
          cellId: String(r.cell_id),
          result: String(r.result),
          receivedAt: r.received_at ? String(r.received_at) : null,
          source: (r.metadata && (r.metadata as any).source) ?? null
        })),
        note: "Dry run — no rows deleted. Re-call with ?confirm=true to delete."
      });
    }

    const del = await pool.query(
      `DELETE FROM volume_cover_pair_event
        WHERE received_at >= NOW() - ($1::text || ' hours')::interval
          AND (
            (metadata->>'source') = 'admin_test_activate'
            OR foxify_pair_id LIKE 'ops-smoke-%'
            OR foxify_pair_id LIKE 'test-%'
            OR foxify_pair_id LIKE 'smoke-%'
          )`,
      [String(hours)]
    );

    return reply.send({
      success: true,
      hours,
      deleted: del.rowCount ?? 0
    });
  });

  /**
   * Full inventory of open hedge legs across ALL positions
   * (including positions long-closed). Used for venue-vs-DB
   * reconciliation. Far broader than active-positions-detail,
   * which filters to positions closed within the last 6 hours.
   */
  app.get("/volume-cover/admin/all-open-legs", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const venueFilter = String((req.query as any)?.venue ?? "").toLowerCase().trim();
    const params: any[] = [];
    let where = "WHERE l.status = 'open'";
    if (venueFilter === "bullish" || venueFilter === "deribit") {
      where += " AND l.venue = $1";
      params.push(venueFilter);
    }
    const result = await pool.query(
      `SELECT l.id, l.position_id, l.venue, l.option_kind, l.strike_usdc,
              l.expiry_iso, l.contracts, l.buy_price_usdc, l.retained,
              l.retained_role, l.opened_at, l.status,
              l.spread_group_id, l.leg_role, l.initial_proceeds_usdc,
              p.status AS position_status, p.opened_at AS position_opened_at,
              p.closed_at AS position_closed_at, p.triggered_at AS position_triggered_at
         FROM volume_cover_hedge_leg l
         LEFT JOIN volume_cover_position p ON p.id = l.position_id
         ${where}
        ORDER BY l.opened_at DESC
        LIMIT 500`,
      params
    );
    return reply.send({
      count: result.rows.length,
      legs: result.rows.map((r: any) => ({
        legId: String(r.id),
        positionId: String(r.position_id ?? ""),
        venue: String(r.venue),
        optionKind: String(r.option_kind),
        strikeUsdc: Number(r.strike_usdc),
        expiryIso: String(r.expiry_iso),
        contractsBtc: Number(r.contracts),
        buyPriceUsdc: r.buy_price_usdc != null ? Number(r.buy_price_usdc) : null,
        retained: Boolean(r.retained),
        retainedRole: r.retained_role ? String(r.retained_role) : null,
        status: r.status ? String(r.status) : null,
        // 2026-05-23: spread-executor fields
        spreadGroupId: r.spread_group_id ? String(r.spread_group_id) : null,
        legRole: r.leg_role ? String(r.leg_role) : null,
        initialProceedsUsdc: r.initial_proceeds_usdc != null ? Number(r.initial_proceeds_usdc) : null,
        openedAt: r.opened_at ? String(r.opened_at) : null,
        positionStatus: r.position_status ? String(r.position_status) : null,
        positionOpenedAt: r.position_opened_at ? String(r.position_opened_at) : null,
        positionClosedAt: r.position_closed_at ? String(r.position_closed_at) : null,
        positionTriggeredAt: r.position_triggered_at ? String(r.position_triggered_at) : null
      }))
    });
  });

  /**
   * Manually mark a single open leg as status='failed' when the
   * operator has confirmed (via venue UI or a prior force-sell
   * 404/not-filled response) that no actual position exists on
   * the venue. Pure DB reconciliation. Writes audit metadata.
   *
   * Body: { "reason": "<string>", "evidence": "<string>" }
   *   e.g. evidence: "force-sell-leg returned bullish_http_404
   *                   at 2026-05-19T05:34Z"
   */
  app.post("/volume-cover/admin/mark-leg-failed-manual/:legId", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const legId = String((req.params as any)?.legId ?? "").trim();
    if (!legId) return reply.code(400).send({ error: "missing_legId_param" });

    const FailManualSchema = z.object({
      reason: z.string().min(1).max(512),
      evidence: z.string().min(1).max(1024)
    });
    const parse = FailManualSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const lookup = await pool.query(
      `SELECT id, status, venue, option_kind, strike_usdc, contracts
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
        message: "mark-leg-failed-manual is only valid for legs in status='open'."
      });
    }

    await pool.query(
      `UPDATE volume_cover_hedge_leg
          SET status = 'failed',
              closed_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        legId,
        JSON.stringify({
          manual_fail_mark: true,
          manual_fail_at: new Date().toISOString(),
          manual_fail_reason: body.reason,
          manual_fail_evidence: body.evidence
        })
      ]
    );

    return reply.send({
      success: true,
      legId,
      venue: String(leg.venue),
      optionKind: String(leg.option_kind),
      strikeUsdc: Number(leg.strike_usdc),
      contractsBtc: Number(leg.contracts),
      reason: body.reason,
      evidence: body.evidence
    });
  });

  /**
   * Batch variant of mark-leg-failed-manual. Marks every supplied
   * leg id that is currently status='open' as 'failed'. Skips
   * (does not error) on legs not found or already in a terminal
   * status; returns per-leg outcome list.
   *
   * Body: { "legIds": ["..."], "reason": "<string>", "evidence": "<string>" }
   */
  app.post("/volume-cover/admin/mark-legs-failed-batch", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const FailBatchSchema = z.object({
      legIds: z.array(z.string().min(1).max(256)).min(1).max(200),
      reason: z.string().min(1).max(512),
      evidence: z.string().min(1).max(1024)
    });
    const parse = FailBatchSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const auditMetadata = JSON.stringify({
      manual_fail_mark: true,
      manual_fail_at: new Date().toISOString(),
      manual_fail_reason: body.reason,
      manual_fail_evidence: body.evidence,
      manual_fail_batch: true
    });

    const results: Array<{
      legId: string;
      outcome: "marked_failed" | "not_found" | "already_terminal";
      previousStatus?: string;
    }> = [];

    for (const legId of body.legIds) {
      const lookup = await pool.query(
        `SELECT status FROM volume_cover_hedge_leg WHERE id = $1`,
        [legId]
      );
      if (lookup.rows.length === 0) {
        results.push({ legId, outcome: "not_found" });
        continue;
      }
      const status = String(lookup.rows[0].status);
      if (status !== "open") {
        results.push({ legId, outcome: "already_terminal", previousStatus: status });
        continue;
      }
      await pool.query(
        `UPDATE volume_cover_hedge_leg
            SET status = 'failed',
                closed_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [legId, auditMetadata]
      );
      results.push({ legId, outcome: "marked_failed" });
    }

    const summary = results.reduce(
      (acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return reply.send({
      success: true,
      reason: body.reason,
      evidence: body.evidence,
      summary,
      results
    });
  });

  /**
   * Backfill a missing `hedge_sell_in` ledger entry for a leg that
   * is already status='sold' in the DB. Idempotent: refuses if a
   * `vc_hedge_sell_*:<legId>` reference already exists. Use ONLY
   * to repair the small window of legs sold via the pre-fix
   * `mark-leg-sold-manual` / `force-sell-leg` routes that did not
   * write a ledger row.
   *
   * Body: { "totalProceedsUsdc": <number>, "reason": "<string>" }
   */
  app.post("/volume-cover/admin/backfill-ledger-sold-leg/:legId", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const legId = String((req.params as any)?.legId ?? "").trim();
    if (!legId) return reply.code(400).send({ error: "missing_legId_param" });

    const BackfillSchema = z.object({
      totalProceedsUsdc: z.number().nonnegative().finite(),
      reason: z.string().min(1).max(512)
    });
    const parse = BackfillSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid_request", issues: parse.error.issues });
    }
    const body = parse.data;

    const lookup = await pool.query(
      `SELECT id, position_id, venue, option_kind, strike_usdc, contracts,
              status, sell_price_usdc, sell_order_id
         FROM volume_cover_hedge_leg
        WHERE id = $1`,
      [legId]
    );
    if (lookup.rows.length === 0) {
      return reply.code(404).send({ error: "leg_not_found", legId });
    }
    const leg = lookup.rows[0];
    if (String(leg.status) !== "sold") {
      return reply.code(409).send({
        error: "leg_not_sold",
        currentStatus: String(leg.status),
        message: "Backfill only valid for legs already in status='sold'."
      });
    }

    // Idempotency: do not write a second ledger row for the same leg.
    const existing = await pool.query(
      `SELECT id, reference, amount_usdc
         FROM pilot_pool_ledger
        WHERE entry_type = 'hedge_sell_in'
          AND reference LIKE $1
        LIMIT 1`,
      [`vc_hedge_sell_%:${legId}`]
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({
        error: "ledger_already_exists",
        existingLedgerId: existing.rows[0].id,
        existingReference: existing.rows[0].reference,
        existingAmountUsdc: existing.rows[0].amount_usdc
      });
    }

    const positionId = String(leg.position_id ?? "");
    await insertLedgerEntry(pool, {
      poolId: "atticus_hedge",
      protectionId: positionId || null,
      entryType: "hedge_sell_in",
      amountUsdc: body.totalProceedsUsdc,
      reference: `vc_hedge_sell_backfill:${legId}`,
      metadata: {
        product: "volume_cover",
        source: "backfill-ledger-sold-leg",
        venue: String(leg.venue),
        option_kind: String(leg.option_kind),
        strike_usdc: Number(leg.strike_usdc),
        contracts_btc: Number(leg.contracts),
        fill_price_usdc_per_btc: leg.sell_price_usdc != null
          ? Number(leg.sell_price_usdc)
          : null,
        order_id: leg.sell_order_id ?? null,
        backfill_reason: body.reason
      }
    });

    return reply.send({
      success: true,
      legId,
      positionId,
      totalProceedsUsdc: body.totalProceedsUsdc,
      reason: body.reason
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
        hedgeRetained: true,
        coverageThroughIso: result.coverageThroughIso,
        daysBilled: result.daysHeld
      });
    } catch (err) {
      return reply.code(500).send({ error: "close_failed", message: (err as Error).message });
    }
  });

  /**
   * 2026-05-22: Archive a position. Adds metadata.archived=true so the
   * position is excluded from operational dashboards (active-positions-
   * detail, foxify daily report) and from rolling salvage statistics
   * (Guard A 7d-loss kill, Guard B salvage throttle). DB row + ledger
   * entries + hedge legs are preserved for audit.
   *
   * Use cases:
   *   - Internal operator test trades that shouldn't pollute production
   *     telemetry (e.g. the May 18 Bullish phantom-leg validation case)
   *   - Known-failure-class events where the loss is real but the
   *     salvage denominator is not representative of normal operations
   *
   * Guards:
   *   - 404 if position not found
   *   - 409 if any hedge leg is still status='open' at the venue.
   *     Position must be fully wound down (sold/failed/expired) before
   *     archive. This prevents accidentally hiding a position that
   *     still has live venue exposure from the operational view.
   *
   * Usage:
   *   POST /volume-cover/admin/positions/:id/archive
   *   body: { "reason": "may18_bullish_test_trade_no_business_value" }
   */
  app.post("/volume-cover/admin/positions/:id/archive", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const id = (req.params as any).id as string;
    const rawReason = (req.body as any)?.reason;
    const reason = typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim().slice(0, 256)
      : null;
    if (!reason) {
      return reply.code(400).send({
        error: "missing_reason",
        message: "Archive requires a non-empty `reason` (max 256 chars) so the audit trail captures why the position was excluded from telemetry."
      });
    }

    const position = await getPosition(pool, id);
    if (!position) return reply.code(404).send({ error: "position_not_found" });

    if (((position.metadata as any)?.archived as boolean | undefined) === true) {
      return reply.send({
        positionId: id,
        status: position.status,
        alreadyArchived: true,
        archiveMetadata: {
          archived: true,
          archive_reason: (position.metadata as any)?.archive_reason ?? null,
          archived_at: (position.metadata as any)?.archived_at ?? null
        }
      });
    }

    const legs = await listHedgeLegsForPosition(pool, id);
    const openLegs = legs.filter((l) => l.status === "open");
    if (openLegs.length > 0) {
      return reply.code(409).send({
        error: "open_legs_present",
        message:
          `Refusing to archive: ${openLegs.length} hedge leg(s) still status='open'. ` +
          `Wind down all legs (sell, expire, or mark-failed) before archiving so the ` +
          `position never silently hides live venue exposure from the ops view.`,
        openLegIds: openLegs.map((l) => l.id)
      });
    }

    const tokenHeader = String(
      (req.headers as any)["x-admin-token"] ?? (req.headers as any)["X-Admin-Token"] ?? ""
    );
    const updated = await markPositionArchived(pool, {
      id,
      reason,
      archivedByToken: tokenHeader || undefined
    });
    if (!updated) {
      return reply.code(500).send({ error: "archive_failed" });
    }
    return reply.send({
      positionId: id,
      status: updated.status,
      archived: true,
      archiveMetadata: {
        archived: true,
        archive_reason: reason,
        archived_at: (updated.metadata as any)?.archived_at ?? new Date().toISOString()
      },
      excludedFrom: [
        "active-positions-detail",
        "foxify-daily-report (triggeredToday count)",
        "rolling-5-trigger salvage pct (Guard B)",
        "rolling-24h trigger count",
        "rolling-7d Atticus loss (Guard A kill switch)"
      ]
    });
  });

  /**
   * 2026-05-24 (PR-F): mark a triggered position as "Foxify-acknowledged".
   *
   * Distinct from /archive: archive fully hides the position from every
   * Foxify-facing aggregate. Foxify-acknowledge is more surgical — the
   * position drops off the "My Active Protections" list (Foxify confirmed
   * they don't want to see it as an open protection anymore) but it STAYS
   * counted in the "Premium Paid (lifetime)" and "Payout Expecting" tallies
   * because the financial obligation is still real.
   *
   * Use case: stuck-in-`triggered` positions that Foxify's bot left without
   * sending the close confirmation (the May 22-24 incident). Premium was
   * already accrued at fireTrigger; payout was already obligated; only the
   * dashboard display semantic was off.
   *
   * Guards:
   *   - position.status MUST be 'triggered' (rejects 'active' to avoid
   *     hiding live positions; rejects 'closed' because there's nothing
   *     to acknowledge if the position was already cleanly closed).
   *   - reason required (audit trail).
   *   - No ledger writes; PR-E closePosition double-bill guard ensures
   *     any future close attempt also won't double-write.
   *
   * Usage:
   *   POST /volume-cover/admin/positions/:id/foxify-acknowledge
   *   body: { "reason": "stale_triggered_pre_hybrid_v3_dash_cleanup_2026_05_24" }
   */
  app.post("/volume-cover/admin/positions/:id/foxify-acknowledge", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const id = (req.params as any).id as string;
    const rawReason = (req.body as any)?.reason;
    const reason = typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim().slice(0, 256)
      : null;
    if (!reason) {
      return reply.code(400).send({
        error: "missing_reason",
        message:
          "Foxify-acknowledge requires a non-empty `reason` (max 256 chars). " +
          "This is a permanent audit trail for why the position was hidden " +
          "from Foxify's Active Protections list."
      });
    }

    const position = await getPosition(pool, id);
    if (!position) return reply.code(404).send({ error: "position_not_found" });

    if (position.status !== "triggered") {
      return reply.code(409).send({
        error: "position_not_triggered",
        message:
          `Foxify-acknowledge is only valid on positions in status='triggered'. ` +
          `This one is status='${position.status}'. Use /archive for closed/test positions.`,
        currentStatus: position.status
      });
    }

    if (((position.metadata as any)?.foxify_acknowledged as boolean | undefined) === true) {
      return reply.send({
        positionId: id,
        status: position.status,
        alreadyAcknowledged: true,
        acknowledgedMetadata: {
          foxify_acknowledged: true,
          foxify_acknowledged_reason: (position.metadata as any)?.foxify_acknowledged_reason ?? null,
          foxify_acknowledged_at: (position.metadata as any)?.foxify_acknowledged_at ?? null
        }
      });
    }

    const tokenHeader = String(
      (req.headers as any)["x-admin-token"] ?? (req.headers as any)["X-Admin-Token"] ?? ""
    );
    const updated = await markPositionFoxifyAcknowledged(pool, {
      id,
      reason,
      acknowledgedByToken: tokenHeader || undefined
    });
    if (!updated) {
      return reply.code(500).send({ error: "foxify_acknowledge_failed" });
    }
    return reply.send({
      positionId: id,
      status: updated.status,
      foxifyAcknowledged: true,
      acknowledgedMetadata: {
        foxify_acknowledged: true,
        foxify_acknowledged_reason: reason,
        foxify_acknowledged_at:
          (updated.metadata as any)?.foxify_acknowledged_at ?? new Date().toISOString()
      },
      hiddenFrom: [
        "/foxify/positions (My Active Protections list)",
        "/foxify/today activeCount (header counter)",
        "/foxify/status currentlyOpen counter"
      ],
      stillCountedIn: [
        "/foxify/today premiumBillableLifetimeUsdc (Premium Paid)",
        "/foxify/today payoutOwedTriggeredUsdc (Payout Expecting)",
        "/foxify/today foxifyNetLifetimeUsdc (Net Foxify-side)",
        "ledger entries (premium_in, payout_out — financial truth preserved)"
      ]
    });
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
  //
  // Optional query overrides:
  //   ?dryRun=true        — evaluate rules without selling
  //   ?iv=0.40            — annualized IV override (e.g. 0.40 = 40%)
  //                         critical: actual current BTC IV is far
  //                         lower than the default fallback, so
  //                         overriding here gives realistic values.
  //   ?spotUsdc=76800     — spot override (rare; for diagnostic).
  app.post("/volume-cover/admin/hedge-manager/run", async (req, reply) => {
    if (!isAdminAuthorized(req)) return reply.code(403).send({ error: "forbidden" });
    const q = (req.query as any) ?? {};
    const dryRun = String(q.dryRun ?? "false").toLowerCase() === "true";
    const ivOverrideRaw = q.iv != null && q.iv !== "" ? Number(q.iv) : null;
    const ivOverride =
      ivOverrideRaw != null && Number.isFinite(ivOverrideRaw) &&
      ivOverrideRaw > 0 && ivOverrideRaw < 5
        ? ivOverrideRaw
        : null;
    const spotOverrideRaw = q.spotUsdc != null && q.spotUsdc !== "" ? Number(q.spotUsdc) : null;
    const spotOverride =
      spotOverrideRaw != null && Number.isFinite(spotOverrideRaw) && spotOverrideRaw > 0
        ? spotOverrideRaw
        : null;
    try {
      const spotIvSource: SpotIvSource =
        opts.spotIvSource ??
        (async () => {
          const spot = await opts.spotSource();
          const fallbackIv = Number(process.env.VC_HM_FALLBACK_IV ?? 0.45);
          return {
            spotBtcUsdc: spotOverride ?? spot.spotBtcPrice,
            ivAnnualized: ivOverride ?? fallbackIv,
            asOfMs: spot.asOfMs
          };
        });
      const result = await runOneHedgeManagerTick({
        pool,
        executor: opts.hedgeExecutor,
        spotIvSource,
        dryRun
      });
      return reply.send({
        ...result,
        overrides: {
          ivOverride,
          spotOverride,
          fallbackIvEnv: Number(process.env.VC_HM_FALLBACK_IV ?? 0.45)
        }
      });
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
      premiumOverrideUsdc: z.number().positive().finite().optional(),
      // 2026-05-23: smoke-test override for spread cells. Force contracts
      // per leg (e.g., 0.01) so we can validate the wired path on Bullish
      // without sizing for the full $1k payout. Ignored on strangle cells.
      contractsOverrideBtc: z.number().positive().finite().lte(1).optional()
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
    // 2026-05-23: hysteretic classifier for consistency with main activate path.
    const metrics = await readSalvageMetrics(pool);
    const totalActiveLiability = await sumActivePayoutLiability(pool);
    let currentDvolForGuard = 0;
    let regime: VolRegime | null = null;
    try {
      const status = await getCurrentRegime();
      currentDvolForGuard = status.dvol ?? 0;
      const hysteretic = classifyVolumeCoverRegimeHysteretic(status.dvol);
      regime = hysteretic?.regime ?? null;
      if (!regime) regime = translatePilotRegime(status.regime);
    } catch (err) {
      req.log.warn(`[volume-cover/test-activate] regime fetch failed: ${(err as Error).message}`);
    }
    // 2026-05-24 (Hybrid v3): resolve premium + regime-adjusted payout
    // BEFORE the guard so liability check matches the actual obligation.
    const adminEarlyQuote = resolveDailyPremium({
      cell,
      dbOverrideDailyPremiumUsdc: cellRow.dailyPremiumUsdc,
      regime
    });
    const adminEffectivePayoutForGuard = adminEarlyQuote.payoutUsdc;

    const guardVerdict = checkAllGuardsForVolumeCoverActivate({
      foxifyPoolBalanceUsdc: 0,
      totalActivePayoutLiabilityUsdc: totalActiveLiability,
      newPayoutLiabilityUsdc: adminEffectivePayoutForGuard,
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
    const adminBaseDailyPremium = adminEarlyQuote.dailyPremiumUsdc;
    const adminEffectivePayout = adminEarlyQuote.payoutUsdc;
    const dailyPremium =
      body.premiumOverrideUsdc !== undefined
        ? body.premiumOverrideUsdc
        : adminBaseDailyPremium;

    try {
      const result = await openPosition(pool, opts.hedgeExecutor, {
        cell,
        foxifyPairId: body.foxifyPairId,
        pairLongNotionalUsdc: longNotional,
        pairShortNotionalUsdc: shortNotional,
        pairEntryBtcPrice: body.pairEntryBtcPrice,
        effectiveDailyPremiumUsdc: dailyPremium,
        // 2026-05-24 (Hybrid v3): regime-adjusted payout for admin test path.
        effectivePayoutUsdc: adminEffectivePayout,
        regime,
        // 2026-05-24 (Phase 0.3): pricing attribution. No surcharge on
        // admin test paths (no anti-bot). Base reflects regime overlay;
        // if operator overrode premium, base preserves regime-tiered
        // value so attribution still reflects "what we would have
        // charged" vs the override.
        baseDailyPremiumUsdc: adminBaseDailyPremium,
        surchargeMultiplierApplied: 1.0,
        // No fingerprint = no anti-bot, no ladder netting (intentional for test)
        fingerprintHash: null,
        // 2026-05-23: smoke-test sizing override (spread cells only).
        // Pass-through from operator request body for /admin/test-activate.
        contractsOverrideBtc: body.contractsOverrideBtc,
        metadata: {
          source: "admin_test_activate",
          requestIp: req.ip,
          regime,
          premiumOverrideUsdc: body.premiumOverrideUsdc ?? null,
          contractsOverrideBtc: body.contractsOverrideBtc ?? null
        }
      });

      return reply.code(201).send({
        positionId: result.position.id,
        status: result.position.status,
        cellId: cell.cellId,
        triggerHighBtc: result.position.triggerHighBtc,
        triggerLowBtc: result.position.triggerLowBtc,
        dailyPremiumUsdc: dailyPremium,
        payoutUsdc: adminEffectivePayout,
        basePayoutUsdc: adminEarlyQuote.basePayoutUsdc,
        payoutSource: adminEarlyQuote.payoutSource,
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
      const e = err as Error & { code?: string };
      // PR-A (2026-05-24): mirror /activate's depth-gate handling so
      // operator-driven test-activations also see a 503 retry signal.
      if (e.code === "spread_liquidity_gate_failed") {
        req.log.warn(
          `[volume-cover/test-activate] depth-gate abort: ${e.message} (no venue order placed; retry safe)`
        );
        return reply
          .header("Retry-After", "30")
          .code(503)
          .send({
            error: "venue_book_thin",
            message:
              "Bullish orderbook depth insufficient on one or more legs; please retry shortly.",
            retryAfterSeconds: 30
          });
      }
      req.log.error(`[volume-cover/test-activate] failed: ${e.message}`);
      return reply.code(500).send({
        error: "test_activate_failed",
        message: e.message
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
