/**
 * Fastify plugin registering the /foxify/v2/* HTTP surface.
 *
 * Routes (per TRIGGER_SOURCE_AND_FEED_SPEC.md §4-§7 + PR A3 plan):
 *
 *   POST   /foxify/v2/activate                    → handleActivate
 *   POST   /foxify/v2/close                       → handleClose
 *   GET    /foxify/v2/status                      → computeFoxifyStatus
 *   GET    /foxify/v2/pairs/:pair_id              → getPairDetail
 *   GET    /foxify/v2/pairs/:pair_id/events       → getPairEventTimeline
 *   GET    /foxify/v2/pairs/:pair_id/explain      → explainPairOutcome
 *   GET    /foxify/v2/pairs/:pair_id/feed-audit   → trigger feed snapshot replay
 *   GET    /foxify/v2/feed/current                → feedService.getCurrentFeed
 *   GET    /foxify/v2/feed/health                 → feed degradation status
 *   GET    /foxify/v2/regime                      → current regime + DVOL + cell allowlist
 *
 *   POST   /admin/foxify/v2/halt                  → recordHalt
 *   POST   /admin/foxify/v2/resume                → clearHalt
 *   POST   /admin/foxify/v2/deferred-pool         → togglePool
 *   POST   /admin/foxify/v2/webhook-config        → set webhook url + hmac secret
 *   POST   /admin/foxify/v2/newborn-review/clear  → clearNewbornReview(regime)
 *   GET    /admin/foxify/v2/diagnostics           → full system status snapshot
 *
 * Auth:
 *   /foxify/v2/*       → X-Foxify-Token bearer, compared constant-time to FOXIFY_API_KEY env
 *   /admin/foxify/v2/* → X-Admin-Token bearer, compared constant-time to PILOT_ADMIN_TOKEN env
 *
 * Phase 0 uses simple static-bearer compare (matches existing VC admin pattern).
 * HMAC-over-payload signing for inbound Foxify can be added in a future commit
 * if Foxify wants stronger auth.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { timingSafeEqual } from "node:crypto";
import { handleActivate, type ActivateDeps } from "./activateHandler";
import { handleClose } from "./closeHandler";
import {
  computeFoxifyStatus,
  explainPairOutcome,
  getPairDetail,
  getPairEventTimeline
} from "./dashboardService";
import {
  clearHalt,
  getHaltState,
  recordHalt,
  type HaltKind,
  type HaltReason
} from "./guardrails";
import { togglePool, getPoolState } from "./deferredPool";
import { clearNewbornReview, classifyRegime, getNewbornState, type Regime } from "./featureFlag";
import { getEventsForPair, getPairById } from "./db";
import { FeedService } from "./feedService";
import { DvolService } from "./dvolService";
import type { LiveAnchorProvider } from "./quoteEngine";
import type { StrangleExecutor } from "./executor";
import type { ExecutionRuntime } from "./executionRuntime";
import type { LiquidChainCache } from "./liquidChainCache";

export type FoxifyV2RoutesDeps = {
  pool: Pool;
  feedService: FeedService;
  dvolService: DvolService;
  anchorProvider: LiveAnchorProvider;
  executor: StrangleExecutor;
  /** Phase 0: pass null; PR A6 wires the registry for handleClose's force-spawn. */
  getRuntime?: (pairId: string) => ExecutionRuntime | null;
  spawnRuntimeForceClose?: (pairId: string) => Promise<void>;
  /**
   * Force-trigger a pair (for validation testing). Transitions an active
   * pair to 'triggered' with a synthetic trigger snapshot, then spawns
   * the ExecutionRuntime to handle the close lifecycle. SHADOW ONLY.
   * Production wires this; tests can omit.
   */
  forceTriggerPair?: (
    pairId: string,
    side: "down" | "up",
    mode?: "natural" | "fast",
    spotOverride?: number
  ) => Promise<{ ok: true; pair_id: string; triggered_at: string; runtime_started: boolean; mode: "natural" | "fast"; spot_override?: number; note: string } | { ok: false; error: string; details?: Record<string, unknown> }>;
  /** Feature flag config (used for newborn threshold etc). */
  newbornReviewThreshold?: number;
  /** PR B1 unwind queue — when provided, surfaced in /admin/foxify/v2/diagnostics. */
  unwindQueue?: { stats: () => { queueDepth: number; longestWaitMs: number; totalGranted: number; totalForceGranted: number; totalDenied: number; currentlyInWindow: number } };
  /**
   * Liquid-strike chain cache. When provided, quoteEngine refines target strikes
   * to nearest liquid strike. Production wires this; tests typically omit it
   * (default behaviour: target strike, no shift).
   */
  liquidChainCache?: LiquidChainCache | null;
  /**
   * Realized-vol service. When provided, /foxify/v2/should_activate computes
   * vol risk premium (IV - RV) for calm-regime tactical override.
   */
  rvService?: import("./rvService").RvService;
  /**
   * Shadow auto-activator instance (env-gated). When provided, exposes
   * /admin/foxify/v2/shadow-auto/status so the operator can inspect recent
   * decisions and the audit trail.
   */
  shadowAutoActivator?: import("./shadowAutoActivator").ShadowAutoActivator;
  /**
   * Config for the shadow auto-activator (exposed via the status endpoint
   * so the operator can see the active thresholds at a glance).
   */
  shadowAutoActivatorConfig?: import("./shadowAutoActivator").AutoActivatorConfig;
};

// ───────────────────────── Auth helpers ─────────────────────────

const safeCompare = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
};

const checkFoxifyToken = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  const expected = process.env.FOXIFY_API_KEY ?? "";
  const provided = (req.headers["x-foxify-token"] as string | undefined) ?? "";
  if (!expected || !provided || !safeCompare(expected, provided)) {
    await reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Foxify-Token" });
    return false;
  }
  return true;
};

const checkAdminToken = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  const expected = process.env.PILOT_ADMIN_TOKEN ?? "";
  const provided = (req.headers["x-admin-token"] as string | undefined) ?? "";
  if (!expected || !provided || !safeCompare(expected, provided)) {
    await reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Admin-Token" });
    return false;
  }
  return true;
};

// ───────────────────────── Plugin ─────────────────────────

export const registerFoxifyV2Routes: FastifyPluginAsync<FoxifyV2RoutesDeps> = async (app, deps) => {
  // ── Robust body parsing (scoped to this plugin's encapsulated context) ──
  // Operators frequently POST admin endpoints with `curl -d '{}'` (which sends
  // application/x-www-form-urlencoded) or with no body / no Content-Type. The
  // default JSON-only parser rejects those with 415. This catch-all accepts any
  // non-JSON content type (and empty bodies), parsing as JSON when possible and
  // falling back to {} otherwise — so admin POSTs never 415 on a missing header.
  // application/json keeps Fastify's stricter default parser (most-specific match).
  // ENCAPSULATED: does NOT affect pilot / volumeCover / other app routes.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => {
    const raw = typeof body === "string" ? body.trim() : "";
    if (raw === "") return done(null, {});
    try { done(null, JSON.parse(raw)); } catch { done(null, {}); }
  });

  // Wrap handleActivate with deps closure
  const activateDeps: ActivateDeps = {
    pool: deps.pool,
    anchorProvider: deps.anchorProvider,
    executor: deps.executor,
    liquidChainCache: deps.liquidChainCache ?? null,
    getFeed: () => deps.feedService.getCurrentFeed(),
    feedVersion: "v1.0.0",
    getCurrentRegime: () => deps.dvolService.getCurrentDvol()?.regime ?? null,
    preActivateGuard: async ({ pairHedgeCostUsdc }) => {
      // Plumbs DVOL into guardrails.canActivate
      const { canActivate } = await import("./guardrails");
      const dvol = deps.dvolService.getCurrentDvol()?.dvol ?? null;
      const regime = deps.dvolService.getCurrentDvol()?.regime ?? null;
      return canActivate(deps.pool, {
        dvol,
        capitalAvailableUsdc: null, // capital pool check is operator-side for Phase 0
        pairHedgeCostUsdc,
        currentRegime: regime ?? undefined,
        newbornReviewThreshold: deps.newbornReviewThreshold ?? 3
      });
    }
  };

  // ─── Foxify-facing ───

  app.post(
    "/foxify/v2/activate",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const result = await handleActivate(req.body, activateDeps);
      reply.code(result.status).send(result.body);
    }
  );

  app.post(
    "/foxify/v2/close",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const result = await handleClose(req.body, {
        pool: deps.pool,
        getRuntime: deps.getRuntime ?? (() => null),
        spawnRuntimeForceClose: deps.spawnRuntimeForceClose ?? (async () => {})
      });
      reply.code(result.status).send(result.body);
    }
  );

  app.get(
    "/foxify/v2/status",
    { preHandler: checkFoxifyToken },
    async (_req, reply) => {
      const halt = await getHaltState(deps.pool);
      const status = await computeFoxifyStatus(deps.pool, {
        haltStatus: {
          foxifyHalt: halt.foxifyHalt,
          atticusHalt: halt.atticusHalt,
          reason: halt.atticusHaltReason ?? halt.foxifyHaltReason
        }
      });
      reply.send(status);
    }
  );

  app.get<{ Params: { pair_id: string } }>(
    "/foxify/v2/pairs/:pair_id",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const detail = await getPairDetail(deps.pool, req.params.pair_id);
      if (!detail) {
        reply.code(404).send({ error: "pair_not_found" });
        return;
      }
      reply.send(detail);
    }
  );

  app.get<{ Params: { pair_id: string } }>(
    "/foxify/v2/pairs/:pair_id/events",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const timeline = await getPairEventTimeline(deps.pool, req.params.pair_id);
      if (!timeline) {
        reply.code(404).send({ error: "pair_not_found" });
        return;
      }
      reply.send(timeline);
    }
  );

  app.get<{ Params: { pair_id: string } }>(
    "/foxify/v2/pairs/:pair_id/explain",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const r = await explainPairOutcome(deps.pool, req.params.pair_id);
      if (!r) {
        reply.code(404).send({ error: "pair_not_found" });
        return;
      }
      reply.send(r);
    }
  );

  app.get<{ Params: { pair_id: string } }>(
    "/foxify/v2/pairs/:pair_id/feed-audit",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const pair = await getPairById(deps.pool, req.params.pair_id);
      if (!pair) {
        reply.code(404).send({ error: "pair_not_found" });
        return;
      }
      // Audit = trigger_feed_snapshot if triggered, else feed_snapshot_at_activation
      reply.send({
        pair_id: pair.pairId,
        activation_feed: pair.feedSnapshotAtActivation,
        trigger_feed: pair.triggerFeedSnapshot,
        triggered_at: pair.triggeredAt,
        trigger_side: pair.triggerSide,
        status: pair.status
      });
    }
  );

  /**
   * GET /foxify/v2/pairs/mtm
   *
   * Mark-to-market for ALL active Foxify pairs in one shot. Used by Foxify
   * bot to decide when to early-close a pair (via POST /foxify/v2/close)
   * to capture intermediate option appreciation that would cover their perp
   * friction even without a trigger fire.
   *
   * Each pair includes:
   *   - cost_paid_usdc                  (what Foxify paid up front)
   *   - estimated_salvage_usdc          (what we'd credit if closed RIGHT NOW)
   *   - pnl_if_close_now_usdc + pnl_pct (closing P&L vs cost)
   *   - distance_to_trigger_*_pct       (how close to firing the auto-close)
   *   - tenor_remaining_hours
   *   - recommendation                  (HOLD | WATCH | TAKE_PROFIT_AVAILABLE
   *                                       | STRONG_TAKE_PROFIT | TRIGGERED | EXPIRED)
   *   - recommendation_reason           (human-readable explanation)
   *
   * Query params:
   *   ?tp_threshold_pct=0.30    (TAKE_PROFIT_AVAILABLE when pnl >= this)
   *   ?watch_threshold_pct=0.05 (WATCH when pnl >= this)
   *   ?pair_id=...              (filter to one pair)
   *
   * Updated every call (no caching) - real spot, real BS valuation.
   * Auth: X-Foxify-Token.
   */
  app.get<{ Querystring: { tp_threshold_pct?: string; watch_threshold_pct?: string; pair_id?: string } }>(
    "/foxify/v2/pairs/mtm",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const feed = deps.feedService.getCurrentFeed();
      if (!feed || feed.canonicalPrice == null) {
        reply.code(503).send({ error: "feed_unavailable", message: "Cannot compute MTM without canonical spot" });
        return;
      }
      const dvol = deps.dvolService.getCurrentDvol();
      const iv = dvol?.sigmaAnnual ?? 0.35;
      const tpThresholdPct = req.query.tp_threshold_pct != null ? Number(req.query.tp_threshold_pct) : undefined;
      const watchThresholdPct = req.query.watch_threshold_pct != null ? Number(req.query.watch_threshold_pct) : undefined;
      const { listActivePairMtm, summarizeMtm } = await import("./mtmService");
      const nowMs = Date.now();
      const pairs = await listActivePairMtm({
        pool: deps.pool,
        currentSpot: feed.canonicalPrice,
        ivAnnual: iv,
        liquidChainCache: deps.liquidChainCache ?? null,
        includeShadow: false, // Foxify-facing: only their real pairs
        pairIdFilter: req.query.pair_id,
        tpThresholdPct,
        watchThresholdPct,
        nowMs
      });
      const summary = summarizeMtm(pairs, {
        currentSpot: feed.canonicalPrice,
        ivAnnual: iv,
        tpThresholdPct: tpThresholdPct ?? 0.30,
        watchThresholdPct: watchThresholdPct ?? 0.05,
        nowMs
      });
      reply.send(summary);
    }
  );

  /**
   * GET /foxify/v2/pairs/:pair_id/mtm — same shape, single pair.
   */
  app.get<{ Params: { pair_id: string }; Querystring: { tp_threshold_pct?: string; watch_threshold_pct?: string } }>(
    "/foxify/v2/pairs/:pair_id/mtm",
    { preHandler: checkFoxifyToken },
    async (req, reply) => {
      const feed = deps.feedService.getCurrentFeed();
      if (!feed || feed.canonicalPrice == null) {
        reply.code(503).send({ error: "feed_unavailable", message: "Cannot compute MTM without canonical spot" });
        return;
      }
      const dvol = deps.dvolService.getCurrentDvol();
      const iv = dvol?.sigmaAnnual ?? 0.35;
      const tpThresholdPct = req.query.tp_threshold_pct != null ? Number(req.query.tp_threshold_pct) : undefined;
      const watchThresholdPct = req.query.watch_threshold_pct != null ? Number(req.query.watch_threshold_pct) : undefined;
      const { listActivePairMtm } = await import("./mtmService");
      const pairs = await listActivePairMtm({
        pool: deps.pool,
        currentSpot: feed.canonicalPrice,
        ivAnnual: iv,
        liquidChainCache: deps.liquidChainCache ?? null,
        includeShadow: false,
        pairIdFilter: req.params.pair_id,
        tpThresholdPct,
        watchThresholdPct
      });
      if (pairs.length === 0) {
        reply.code(404).send({ error: "pair_not_found_or_not_active", pair_id: req.params.pair_id });
        return;
      }
      reply.send(pairs[0]);
    }
  );

  app.get("/foxify/v2/feed/current", { preHandler: checkFoxifyToken }, async (_req, reply) => {
    const feed = deps.feedService.getCurrentFeed();
    if (!feed) {
      reply.code(503).send({ error: "feed_uninitialized" });
      return;
    }
    reply.send(feed);
  });

  app.get("/foxify/v2/feed/health", { preHandler: checkFoxifyToken }, async (_req, reply) => {
    reply.send(deps.feedService.getHealth());
  });

  /**
   * GET /foxify/v2/should_activate
   *
   * Polling endpoint for Foxify's bot. Returns whether the current moment is
   * good for activating a new pair, based on:
   *   - DVOL regime (moderate/elevated/stress always OK; calm conditional)
   *   - Vol risk premium (VRP = IV - RV) — calm with negative VRP is OK
   *   - Halt state
   *
   * Foxify's bot should poll this endpoint and only call /activate when
   * `good_to_activate: true`. The `recommended_cells` field tells the bot
   * which cells to activate; `next_check_signal` indicates what condition
   * the bot should monitor for if currently waiting.
   *
   * Auth: X-Foxify-Token (same as other foxify-side endpoints).
   */
  app.get("/foxify/v2/should_activate", { preHandler: checkFoxifyToken }, async (_req, reply) => {
    const { selectStructureForRegime } = await import("./structureSelector");
    const { getEffectiveAllowlist } = await import("./cellAllowlist");
    if (!deps.rvService) {
      // RvService not wired — degrade to regime-only gate
      const dvol = deps.dvolService.getCurrentDvol();
      const halt = await getHaltState(deps.pool);
      const haltActive = halt.foxifyHalt || halt.atticusHalt;
      const good = !haltActive && dvol?.regime && dvol.regime !== "calm";
      const { classifySignalTier } = await import("./activationGate");
      const tierInfo = classifySignalTier({
        regime: dvol?.regime ?? null,
        vrp: null,
        calmVrpThreshold: -0.015,
        dvol: dvol?.dvol ?? null
      });
      reply.send({
        good_to_activate: Boolean(good),
        regime: dvol?.regime ?? null,
        dvol: dvol?.dvol ?? null,
        iv_annual: dvol?.sigmaAnnual ?? null,
        rv_annual: null,
        vrp: null,
        vrp_threshold_for_calm: -0.015,
        reason: haltActive
          ? `halt_active:${halt.atticusHalt ? "atticus" : "foxify"}:${halt.atticusHaltReason ?? halt.foxifyHaltReason ?? "unknown"}`
          : dvol?.regime === "calm"
            ? "calm_regime_default_halt_rv_service_not_configured"
            : dvol?.regime
              ? `regime_${dvol.regime}_positive_ev`
              : "dvol_unavailable",
        recommended_cells: good && dvol?.regime ? await getEffectiveAllowlist(deps.pool, dvol.regime) : [],
        recommended_structure: dvol?.regime ? selectStructureForRegime(dvol.regime).structure : null,
        structure_rationale: dvol?.regime ? selectStructureForRegime(dvol.regime).rationale : null,
        next_check_signal: "regime_change_or_rv_service_enabled",
        asOf: new Date().toISOString(),
        signal_tier: tierInfo.tier,
        signal_score: tierInfo.score,
        signal_label: tierInfo.label
      });
      return;
    }
    const { computeActivationGate } = await import("./activationGate");
    const { recordGateSnapshot, computeVrpTrend, computeConsecutiveGoodSeconds } = await import("./gateHistory");
    const result = await computeActivationGate({
      dvolService: deps.dvolService,
      rvService: deps.rvService,
      liquidChainCache: deps.liquidChainCache ?? null
    });
    // Overlay halt state — even if gate says good, if halt is active, block
    const halt = await getHaltState(deps.pool);
    const haltActive = halt.foxifyHalt || halt.atticusHalt;
    const finalGoodToActivate = !haltActive && result.good_to_activate;

    // Record snapshot for trend computation BEFORE responding (in-memory ring)
    const nowMs = Date.now();
    recordGateSnapshot({
      asOfMs: nowMs,
      vrp: result.vrp,
      goodToActivate: finalGoodToActivate,
      regime: result.regime
    });

    // Also persist to DB (deduped, ~1 row per 30s on quiet, more on transitions)
    void (async () => {
      try {
        const { persistGateSnapshotIfChanged, ensureGateSnapshotSchema } = await import("./gateSnapshotPersist");
        await ensureGateSnapshotSchema(deps.pool);
        await persistGateSnapshotIfChanged(deps.pool, {
          ts: new Date(nowMs),
          good_to_activate: finalGoodToActivate,
          regime: result.regime,
          dvol: result.dvol,
          vrp: result.vrp,
          iv_annual: result.iv_annual,
          rv_annual: result.rv_annual,
          signal_tier: result.signal_tier,
          signal_score: result.signal_score
        });
      } catch {
        // never block the response on persistence; the in-memory ring still works
      }
    })();
    const vrpTrend5min = computeVrpTrend(5, nowMs);
    const vrpTrend15min = computeVrpTrend(15, nowMs);
    const consecutiveGoodSeconds = computeConsecutiveGoodSeconds(nowMs);

    const trends = {
      vrp_change_5min: vrpTrend5min.delta,
      vrp_change_15min: vrpTrend15min.delta,
      consecutive_good_seconds: consecutiveGoodSeconds,
      sustained_signal_confidence: consecutiveGoodSeconds == null ? "insufficient_history"
        : consecutiveGoodSeconds === 0 ? "currently_bad"
        : consecutiveGoodSeconds < 60 ? "low_just_flipped_good"
        : consecutiveGoodSeconds < 180 ? "medium_1-3min_sustained"
        : "high_3min+_sustained"
    };

    // Cell-level opportunities: per-cell EV regardless of global signal.
    // Foxify bot can opt to act on cell-level opportunities even when the
    // global gate says WAIT (e.g. in calm regime, far-OTM cells often have
    // +EV even when VRP hasn't crossed the global threshold).
    let cellOpportunities: import("./cellOpportunities").CellOpportunity[] = [];
    try {
      const feed = deps.feedService.getCurrentFeed();
      if (feed && feed.canonicalPrice != null) {
        const { computeCellOpportunities } = await import("./cellOpportunities");
        const { resolveCurrentTier } = await import("./tierResolver");
        const tier = await resolveCurrentTier(deps.pool, nowMs);
        const opps = await computeCellOpportunities({
          spot: feed.canonicalPrice,
          regime: (result.regime ?? "calm") as "calm" | "moderate" | "elevated" | "stress",
          anchorProvider: deps.anchorProvider,
          liquidChainCache: deps.liquidChainCache ?? null,
          tier,
          nowMs
        });
        cellOpportunities = opps.opportunities;
      }
    } catch (e) {
      // Never block the gate response on cell-opp computation. Empty list signals
      // "couldn't compute" — bot falls back to recommended_cells (global signal).
      console.error(`[FoxifyV2] cell opportunities computation failed: ${(e as Error).message}`);
    }

    if (haltActive) {
      reply.send({
        ...result,
        good_to_activate: false,
        reason: `halt_active:${halt.atticusHalt ? "atticus" : "foxify"}:${halt.atticusHaltReason ?? halt.foxifyHaltReason ?? "unknown"}`,
        recommended_cells: [],
        cell_opportunities: [],
        trends
      });
      return;
    }
    const recSel = result.regime ? selectStructureForRegime(result.regime) : null;
    const recCells = (finalGoodToActivate && result.regime)
      ? await getEffectiveAllowlist(deps.pool, result.regime) : [];
    reply.send({ ...result, trends, cell_opportunities: cellOpportunities,
      recommended_cells: recCells,
      recommended_structure: recSel?.structure ?? null, structure_rationale: recSel?.rationale ?? null });
  });

  app.get("/foxify/v2/regime", { preHandler: checkFoxifyToken }, async (_req, reply) => {
    const dvol = deps.dvolService.getCurrentDvol();
    const halt = await getHaltState(deps.pool);
    reply.send({
      dvol: dvol?.dvol ?? null,
      sigma_annual: dvol?.sigmaAnnual ?? null,
      regime: dvol?.regime ?? null,
      as_of_ms: dvol?.asOfMs ?? null,
      halt: {
        foxify: halt.foxifyHalt,
        atticus: halt.atticusHalt,
        reason: halt.atticusHaltReason ?? halt.foxifyHaltReason
      }
    });
  });

  // ─── Admin ───

  app.post<{ Body: { kind: HaltKind; reason: HaltReason | string; notes?: string } }>(
    "/admin/foxify/v2/halt",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { kind, reason, notes } = req.body;
      if (kind !== "foxify" && kind !== "atticus") {
        reply.code(400).send({ error: "invalid_request", message: "kind must be 'foxify' or 'atticus'" });
        return;
      }
      const state = await recordHalt(deps.pool, kind, reason as HaltReason, "admin_api", notes ?? "");
      reply.send(state);
    }
  );

  app.post<{ Body: { kind: HaltKind; notes?: string } }>(
    "/admin/foxify/v2/resume",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { kind, notes } = req.body;
      if (kind !== "foxify" && kind !== "atticus") {
        reply.code(400).send({ error: "invalid_request", message: "kind must be 'foxify' or 'atticus'" });
        return;
      }
      const state = await clearHalt(deps.pool, kind, "admin_api", notes ?? "", false);
      reply.send(state);
    }
  );

  app.post<{ Body: { active: boolean; notes?: string } }>(
    "/admin/foxify/v2/deferred-pool",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { active, notes } = req.body;
      if (typeof active !== "boolean") {
        reply.code(400).send({ error: "invalid_request", message: "active must be boolean" });
        return;
      }
      const state = await togglePool(deps.pool, active, notes ?? "");
      reply.send(state);
    }
  );

  /**
   * POST /admin/foxify/v2/webhook-config/test
   *
   * Fires a synthetic PairClosedPayload to either the configured webhook URL
   * (when body is empty) or to a one-off url/secret override (when body
   * provides them — useful for testing against requestbin.com / webhook.site
   * / Foxify's staging URL without changing production config).
   *
   * Does NOT write to two_sided_webhook_attempt (test-only, no retry chain).
   * Returns: { sent, http_status, http_body_preview, signature_sent,
   *           payload_preview, latency_ms, error }
   *
   * Use to:
   *   - Validate signature verification on the receiver side
   *   - Sanity-check payload shape and HMAC implementation
   *   - Pre-flight the webhook URL/secret before going live
   */
  app.post<{ Body?: { test_url?: string; test_secret?: string; override_payload?: Record<string, unknown> } }>(
    "/admin/foxify/v2/webhook-config/test",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const body = req.body ?? {};
      const { getWebhookConfig } = await import("./webhookConfig");
      const { testFireWebhook } = await import("./webhookDelivery");
      let url: string | undefined = typeof body.test_url === "string" ? body.test_url : undefined;
      let secret: string | undefined = typeof body.test_secret === "string" ? body.test_secret : undefined;
      if (!url || !secret) {
        const cfg = await getWebhookConfig(deps.pool);
        if (!url) url = cfg.webhookUrl ?? undefined;
        if (!secret) secret = cfg.hmacSecret ?? undefined;
      }
      if (!url || !secret) {
        reply.code(400).send({
          error: "no_webhook_configured",
          message: "Either set webhook config via POST /admin/foxify/v2/webhook-config first, OR pass test_url + test_secret in this request body."
        });
        return;
      }
      const result = await testFireWebhook(url, secret, body.override_payload as Record<string, unknown> | undefined);
      reply.send({
        webhook_url: url,
        used_override_config: Boolean(typeof body.test_url === "string" || typeof body.test_secret === "string"),
        ...result
      });
    }
  );

  app.post<{ Body: { webhook_url: string; hmac_secret: string } }>(
    "/admin/foxify/v2/webhook-config",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { webhook_url, hmac_secret } = req.body;
      if (!webhook_url || !hmac_secret) {
        reply.code(400).send({ error: "invalid_request", message: "webhook_url and hmac_secret required" });
        return;
      }
      try {
        const { setWebhookConfig } = await import("./webhookConfig");
        const cfg = await setWebhookConfig(deps.pool, webhook_url, hmac_secret);
        reply.send({ stored: true, updated_at: cfg.updatedAt });
      } catch (e) {
        reply.code(400).send({ error: "invalid_request", message: (e as Error).message });
      }
    }
  );

  app.post<{ Body: { regime: Regime; notes?: string } }>(
    "/admin/foxify/v2/newborn-review/clear",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { regime, notes } = req.body;
      if (!["calm", "moderate", "elevated", "stress"].includes(regime)) {
        reply.code(400).send({ error: "invalid_request", message: "regime must be calm|moderate|elevated|stress" });
        return;
      }
      await clearNewbornReview(deps.pool, regime);
      const state = await getNewbornState(deps.pool, regime, deps.newbornReviewThreshold ?? 3);
      reply.send({ regime, cleared: true, state, notes: notes ?? "" });
    }
  );

  // Prometheus metrics scrape — typically network-gated rather than token-gated
  app.get("/metrics", async (_req, reply) => {
    const { getMetrics } = await import("./metrics");
    reply.type("text/plain; version=0.0.4; charset=utf-8").send(getMetrics().renderPrometheus());
  });

  app.post<{ Body: { regime: "calm" | "moderate" | "elevated" | "stress"; cell_id: string; enabled: boolean; reason?: string } }>(
    "/admin/foxify/v2/cell-allowlist",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { regime, cell_id, enabled, reason } = req.body;
      if (!["calm", "moderate", "elevated", "stress"].includes(regime)) {
        reply.code(400).send({ error: "invalid_request", message: "regime must be calm|moderate|elevated|stress" });
        return;
      }
      if (typeof cell_id !== "string" || cell_id.length === 0) {
        reply.code(400).send({ error: "invalid_request", message: "cell_id required" });
        return;
      }
      if (typeof enabled !== "boolean") {
        reply.code(400).send({ error: "invalid_request", message: "enabled must be boolean" });
        return;
      }
      const { setCellOverride, getEffectiveAllowlist } = await import("./cellAllowlist");
      await setCellOverride(deps.pool, regime, cell_id, enabled, reason ?? "", "admin_api");
      const effective = await getEffectiveAllowlist(deps.pool, regime);
      reply.send({ regime, cell_id, enabled, reason: reason ?? "", effective_allowlist: effective });
    }
  );

  app.get<{ Querystring: { regime?: string } }>(
    "/admin/foxify/v2/cell-allowlist",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const regime = req.query.regime;
      const { getEffectiveAllowlist, getOverrides, DEFAULT_CELL_ALLOWLIST } = await import("./cellAllowlist");
      if (regime && ["calm", "moderate", "elevated", "stress"].includes(regime)) {
        const r = regime as "calm" | "moderate" | "elevated" | "stress";
        reply.send({
          regime: r,
          default_allowlist: DEFAULT_CELL_ALLOWLIST[r],
          overrides: await getOverrides(deps.pool, r),
          effective_allowlist: await getEffectiveAllowlist(deps.pool, r)
        });
      } else {
        const all: Record<string, unknown> = {};
        for (const r of ["calm", "moderate", "elevated", "stress"] as const) {
          all[r] = {
            default_allowlist: DEFAULT_CELL_ALLOWLIST[r],
            effective_allowlist: await getEffectiveAllowlist(deps.pool, r)
          };
        }
        all.overrides = await getOverrides(deps.pool);
        reply.send(all);
      }
    }
  );

  /**
   * GET /admin/foxify/v2/signal-distribution?hours=24
   *
   * Returns the historical distribution of the activation signal over the
   * last N hours. Answers questions like "what % of time was signal GO?",
   * "how many transitions?", and "broken down by regime, what's the GO rate?"
   *
   * Uses the persisted two_sided_gate_snapshot table (populated by every
   * gate computation, deduped to ~1 row per 30s on quiet stretches).
   */
  app.get<{ Querystring: { hours?: string } }>(
    "/admin/foxify/v2/signal-distribution",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const hours = Math.max(0.1, Math.min(720, Number(req.query.hours ?? "24")));
      const { computeSignalDistribution, ensureGateSnapshotSchema } = await import("./gateSnapshotPersist");
      await ensureGateSnapshotSchema(deps.pool);
      const dist = await computeSignalDistribution(deps.pool, hours);
      reply.send({
        window_hours: hours,
        ...dist,
        interpretation: dist.total_samples > 0
          ? `Over the last ${hours}h, the signal was GO ${(dist.good_pct * 100).toFixed(1)}% of the time (${dist.good_samples} of ${dist.total_samples} sampled snapshots). Signal flipped state ${dist.transitions} times.`
          : "No samples collected in this window yet (system may have just deployed or table just created)."
      });
    }
  );

  /**
   * GET /admin/foxify/v2/shadow-auto/status
   *
   * Inspect the shadow auto-activator: current config, last check, last
   * activation, and the most recent N audit rows. Works even when the
   * auto-activator is disabled — falls back to reading the audit table
   * directly so the operator can still see historical activity.
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/admin/foxify/v2/shadow-auto/status",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "20")));
      const { readAutoActivatorStatus, readAutoActivatorConfig, ensureShadowAuditSchema } = await import("./shadowAutoActivator");
      // Ensure schema exists for first-time reads (idempotent CREATE IF NOT EXISTS).
      await ensureShadowAuditSchema(deps.pool);
      const cfg = deps.shadowAutoActivatorConfig ?? readAutoActivatorConfig();
      const status = await readAutoActivatorStatus(deps.pool, cfg, limit);
      reply.send(status);
    }
  );

  /**
   * POST /admin/foxify/v2/shadow-auto/test-activate
   *
   * Force-fire a single shadow activation right now, bypassing the
   * good_to_activate / sustained-good / rate-limit / regime-allowlist
   * gates. Still respects: cell exists + enabled + triggerPct ≤ 5%,
   * and Atticus halt (unless ignore_halt=true).
   *
   * Body: { cell_id?: string, ignore_halt?: boolean }
   *  - cell_id omitted → auto-picks first eligible cell (recommended_cells
   *    if any, else first registered enabled ≤5% cell)
   *  - ignore_halt=true → fires even when halt is active (for testing
   *    halt-recovery flows)
   *
   * Writes an audit row with decision="test_activated" so the entry is
   * clearly distinguishable from the auto-loop's "activated" rows.
   *
   * Intended for operator use when the signal won't naturally fire
   * (e.g. calm market) and you need to observe end-to-end lifecycle.
   */
  app.post<{ Body?: { cell_id?: string; ignore_halt?: boolean } }>(
    "/admin/foxify/v2/shadow-auto/test-activate",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      if (!deps.rvService) {
        reply.code(503).send({ error: "rv_service_unavailable", message: "RvService not wired; cannot compute gate. Set up FOXIFY_V2 deps first." });
        return;
      }
      const body = req.body ?? {};
      const { forceShadowActivation, readAutoActivatorConfig, ensureShadowAuditSchema } = await import("./shadowAutoActivator");
      await ensureShadowAuditSchema(deps.pool);
      const cfg = deps.shadowAutoActivatorConfig ?? readAutoActivatorConfig();
      const result = await forceShadowActivation(
        {
          pool: deps.pool,
          dvolService: deps.dvolService,
          rvService: deps.rvService,
          feedService: deps.feedService,
          liquidChainCache: deps.liquidChainCache ?? null,
          anchorProvider: deps.anchorProvider,
          config: cfg
        },
        {
          cellId: typeof body.cell_id === "string" ? body.cell_id : undefined,
          ignoreHalt: body.ignore_halt === true
        }
      );
      const statusCode = result.decision.startsWith("test_activated") ? 201 : 422;
      reply.code(statusCode).send({
        decision: result.decision,
        signal_tier: result.signal_tier,
        chosen_cell_id: result.chosen_cell_id,
        pair_id: result.pair_id,
        audit_id: result.audit_id
      });
    }
  );

  /**
   * POST /admin/foxify/v2/cell-sweep
   *
   * Runs the Foxify-duration cell optimization sweep. By default uses
   * current live spot + current calibration. Persists results to
   * two_sided_cell_sweep_run/_result so caller can later query
   * /admin/foxify/v2/cell-sweep/latest for the rankings.
   *
   * Body (optional):
   *   { spot?, notionals?, triggers?, strikeMoneyness?, tenors?,
   *     autoClosePnlPcts?, autoCloseAbsoluteUsdcs?, nPaths?, venue?,
   *     structures? }
   *   structures: subset of ["strangle","straddle","straddle_gamma_scalp"]
   *     (default strangle+straddle). Straddle = ATM (moneyness=0); strangle =
   *     non-zero OTM-wing moneyness; straddle_gamma_scalp = ATM delta-hedged via
   *     perp (needs FOXIFY_PERP_FRICTION_BPS env or body.perpFrictionBps).
   *   perpFrictionBps / perpFundingBpsPerDay: REAL perp costs for gamma scalp.
   *
   * Heads up: this is HEAVY — default config is ~4,800 cells × 12 auto-close
   * combos = 57,600 sims at 500 paths each ≈ 28.8M iterations. Plan ~30 min.
   * For faster iteration use smaller grid or fewer auto-close combos.
   */
  app.post<{ Body?: Record<string, unknown> }>("/admin/foxify/v2/cell-sweep",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { runFullCellSweep, ensureCellSweepSchema } = await import("./cellSweep");
      const { classifyRegime } = await import("./featureFlag");
      const feed = deps.feedService.getCurrentFeed();
      const body = req.body ?? {};
      const spot = typeof body.spot === "number" ? body.spot : feed?.canonicalPrice;
      if (!spot || spot <= 0) {
        reply.code(503).send({ error: "feed_unavailable", message: "Cannot sweep without canonical spot" });
        return;
      }
      if (!deps.liquidChainCache) {
        reply.code(503).send({ error: "chain_cache_unavailable", message: "Sweep requires liquidChainCache for real-price lookups" });
        return;
      }
      const currentDvol = deps.dvolService.getCurrentDvol();
      if (!currentDvol) {
        reply.code(503).send({ error: "dvol_unavailable", message: "Cannot determine current regime without live DVOL" });
        return;
      }
      const currentRegime = classifyRegime(currentDvol.dvol);
      try {
        await ensureCellSweepSchema(deps.pool);
      } catch (e) {
        reply.code(500).send({ error: "schema_init_failed", message: (e as Error).message });
        return;
      }
      // Venue mode: auto (default), bullish, deribit
      const venueParam = typeof body.venue === "string" ? body.venue : "auto";
      if (venueParam !== "auto" && venueParam !== "bullish" && venueParam !== "deribit") {
        reply.code(400).send({ error: "invalid_request", message: "venue must be 'auto' | 'bullish' | 'deribit'" });
        return;
      }
      // Structure mode: which option structures to sweep (default strangle+straddle).
      const VALID_STRUCTURES = ["strangle", "straddle", "straddle_gamma_scalp"];
      let structuresParam: Array<"strangle" | "straddle" | "straddle_gamma_scalp"> | undefined;
      if (body.structures !== undefined) {
        if (!Array.isArray(body.structures) ||
            body.structures.length === 0 ||
            !body.structures.every((s) => typeof s === "string" && VALID_STRUCTURES.includes(s))) {
          reply.code(400).send({ error: "invalid_request", message: "structures must be a non-empty subset of ['strangle','straddle','straddle_gamma_scalp']" });
          return;
        }
        structuresParam = body.structures as Array<"strangle" | "straddle" | "straddle_gamma_scalp">;
      }
      // Gamma-scalp cells need REAL perp friction (env, NOT hardcoded). Body may
      // override for what-if analysis; otherwise read FOXIFY_PERP_FRICTION_BPS.
      const wantsGammaScalp = (structuresParam ?? []).includes("straddle_gamma_scalp");
      const perpFrictionBps = typeof body.perpFrictionBps === "number"
        ? body.perpFrictionBps
        : (process.env.FOXIFY_PERP_FRICTION_BPS != null ? Number(process.env.FOXIFY_PERP_FRICTION_BPS) : undefined);
      const perpFundingBpsPerDay = typeof body.perpFundingBpsPerDay === "number"
        ? body.perpFundingBpsPerDay
        : (process.env.FOXIFY_PERP_FUNDING_BPS_PER_DAY != null ? Number(process.env.FOXIFY_PERP_FUNDING_BPS_PER_DAY) : undefined);
      if (wantsGammaScalp && (perpFrictionBps == null || !Number.isFinite(perpFrictionBps) || perpFrictionBps < 0)) {
        reply.code(400).send({ error: "invalid_request", message: "straddle_gamma_scalp requires real perp friction: set FOXIFY_PERP_FRICTION_BPS env (or pass perpFrictionBps in body) — no hardcoded default" });
        return;
      }
      const acceptedAt = new Date().toISOString();
      const config: Parameters<typeof runFullCellSweep>[1] = {
        spot,
        notionals: Array.isArray(body.notionals) ? body.notionals as number[] : undefined,
        triggers: Array.isArray(body.triggers) ? body.triggers as number[] : undefined,
        strikeMoneyness: Array.isArray(body.strikeMoneyness) ? body.strikeMoneyness as number[] : undefined,
        tenors: Array.isArray(body.tenors) ? body.tenors as number[] : undefined,
        autoClosePnlPcts: Array.isArray(body.autoClosePnlPcts) ? body.autoClosePnlPcts as number[] : undefined,
        autoCloseAbsoluteUsdcs: Array.isArray(body.autoCloseAbsoluteUsdcs) ? body.autoCloseAbsoluteUsdcs as number[] : undefined,
        nPaths: typeof body.nPaths === "number" ? body.nPaths : undefined,
        venue: venueParam,
        structures: structuresParam,
        perpFrictionBps,
        perpFundingBpsPerDay,
        atticusSplitPct: typeof body.atticusSplitPct === "number" ? body.atticusSplitPct
          : (process.env.SS_ATTICUS_SPLIT_PCT != null ? Number(process.env.SS_ATTICUS_SPLIT_PCT) : undefined),
        atticusFloorUsdc: typeof body.atticusFloorUsdc === "number" ? body.atticusFloorUsdc
          : (process.env.SS_ATTICUS_FLOOR_USDC != null ? Number(process.env.SS_ATTICUS_FLOOR_USDC) : undefined),
        perpPairFrictionUsdc: typeof body.perpPairFrictionUsdc === "number" ? body.perpPairFrictionUsdc
          : (process.env.FOXIFY_PERP_FRICTION_USDC != null ? Number(process.env.FOXIFY_PERP_FRICTION_USDC) : undefined),
        liquidChainCache: deps.liquidChainCache,
        dvolService: deps.dvolService,
        currentRegime
      };
      void runFullCellSweep(deps.pool, config, {
        progressLog: (msg) => console.log(`[cellSweep] ${msg}`),
        persistResults: true
      }).then((report) => {
        console.log(`[cellSweep] completed runId=${report.runId} results=${report.resultCount}`);
      }).catch((e) => {
        console.error(`[cellSweep] failed: ${(e as Error).message}`);
      });
      reply.code(202).send({
        accepted_at: acceptedAt,
        message: "Sweep launched in background. Poll /admin/foxify/v2/cell-sweep/latest for results.",
        spot,
        current_regime: currentRegime,
        venue: venueParam,
        structures: structuresParam ?? ["strangle", "straddle"],
        note: "Cells in non-current regimes are marked 'estimate' (chain only knows TODAY). Real-time cell selection should use rankings.<regime>.topCells where result_tier='real'. Each topCell carries params.structure ('strangle'|'straddle'); see rankings.<regime>.structure_verdict for the per-regime comparison."
      });
    }
  );

  /**
   * GET /admin/foxify/v2/cell-sweep/latest
   *
   * Returns the latest COMPLETED sweep's rankings (filtered by completed_at
   * IS NOT NULL — won't return stalled or failed runs). 404 if no sweep
   * has ever completed.
   */
  app.get("/admin/foxify/v2/cell-sweep/latest",
    { preHandler: checkAdminToken },
    async (_req, reply) => {
      const { getLatestSweepRun } = await import("./cellSweep");
      const report = await getLatestSweepRun(deps.pool);
      if (!report) {
        reply.code(404).send({ error: "no_completed_sweep", message: "No completed sweep yet. POST /admin/foxify/v2/cell-sweep to run one, or GET /admin/foxify/v2/cell-sweep/runs to see all runs (including stalled)." });
        return;
      }
      reply.send(report);
    }
  );

  /**
   * GET /admin/foxify/v2/cell-sweep/runs
   *
   * Lists ALL recent sweep runs with status (completed / in_progress / failed_or_stalled).
   * Use this to see whether a sweep crashed or is still going. Runs older
   * than 15 min without a completed_at are tagged "failed_or_stalled".
   */
  app.get<{ Querystring: { limit?: string } }>(
    "/admin/foxify/v2/cell-sweep/runs",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { listSweepRuns } = await import("./cellSweep");
      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? "10")));
      const runs = await listSweepRuns(deps.pool, { limit });
      reply.send({
        count: runs.length,
        runs,
        summary: {
          completed: runs.filter((r) => r.status === "completed").length,
          in_progress: runs.filter((r) => r.status === "in_progress").length,
          failed_or_stalled: runs.filter((r) => r.status === "failed_or_stalled").length
        }
      });
    }
  );

  /**
   * GET /admin/foxify/v2/regime-calibration
   *
   * Inspect the empirical regime calibration: per-regime sigma + cost
   * markup, whether each comes from real history or synthetic fallback,
   * sample counts, and the synthetic-default reference.
   *
   * Use to verify that history is accumulating and that sigmas/markups
   * are converging to plausible values before we trust the MC sweep.
   */
  app.get("/admin/foxify/v2/regime-calibration", { preHandler: checkAdminToken }, async (_req, reply) => {
    const { getCalibrationSummary } = await import("./regimeCalibration");
    const summary = await getCalibrationSummary(deps.pool);
    reply.send(summary);
  });

  /**
   * GET /admin/foxify/v2/realized-vs-mc — production-readiness reconciliation.
   * Per cell: realized mean Foxify net from SETTLED shadow pairs vs the MC's
   * prediction at the requested regime; flags within ±15%. Real data only
   * (cost+realism from real chain, sigma from empirical calibration).
   * Query: ?regime= (default current), n_paths=, auto_close_abs=, auto_close_pct=
   */
  app.get<{ Querystring: { regime?: string; n_paths?: string; auto_close_abs?: string; auto_close_pct?: string } }>(
    "/admin/foxify/v2/realized-vs-mc",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { reconcileRealizedVsMc } = await import("./realizedVsMc");
      const { classifyRegime } = await import("./featureFlag");
      const feed = deps.feedService.getCurrentFeed();
      const spot = feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const currentDvol = deps.dvolService.getCurrentDvol();
      const valid = ["calm", "moderate", "elevated", "stress"];
      const regime = (valid.includes(req.query.regime ?? "")
        ? req.query.regime
        : (currentDvol ? classifyRegime(currentDvol.dvol) : "calm")) as "calm" | "moderate" | "elevated" | "stress";
      try {
        const report = await reconcileRealizedVsMc(deps.pool, {
          regime, spot, liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
          nPaths: req.query.n_paths ? Number(req.query.n_paths) : undefined,
          autoCloseAbsoluteUsdc: req.query.auto_close_abs ? Number(req.query.auto_close_abs) : undefined,
          autoClosePnlPct: req.query.auto_close_pct ? Number(req.query.auto_close_pct) : undefined
        });
        reply.send(report);
      } catch (e) {
        reply.code(500).send({ error: "reconcile_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/vega-timing — calm-edge research (pure REAL DVOL history).
   * Backtests: does buying a long-vega ATM straddle when IV is in a LOW percentile
   * (calm) and exiting after a hold profit from IV expansion (vega) beyond theta?
   * Query: ?entry_percentile=0.25&hold_days=2&tenor_days=7&lookback_days=30&calm_only=true
   */
  app.get<{ Querystring: { entry_percentile?: string; hold_days?: string; tenor_days?: string; lookback_days?: string; calm_only?: string; ref_spot?: string; granularity_hours?: string } }>(
    "/admin/foxify/v2/vega-timing",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { backtestVegaTiming } = await import("./vegaTimingBacktest");
      const q = req.query;
      const numQ = (v: string | undefined): number | undefined => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
      try {
        const result = await backtestVegaTiming(deps.pool, {
          entryPercentile: numQ(q.entry_percentile),
          holdDays: numQ(q.hold_days),
          tenorDays: numQ(q.tenor_days),
          lookbackDays: numQ(q.lookback_days),
          refSpot: numQ(q.ref_spot),
          granularityHours: numQ(q.granularity_hours),
          calmOnly: q.calm_only !== "false"
        });
        reply.send(result);
      } catch (e) {
        reply.code(500).send({ error: "vega_timing_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * POST /admin/foxify/v2/dvol-backfill
   *
   * Phase 6: backfill historical Deribit DVOL into two_sided_dvol_history so
   * regime calibration becomes EMPIRICAL for ALL regimes immediately (instead of
   * waiting ~2 weeks for live accumulation). REAL data (Deribit's published vol
   * index, historical), idempotent (minute-dedupe). Run once, then re-check
   * GET /admin/foxify/v2/regime-calibration — non-calm regimes should flip to
   * empirical_median, making the cell sweep's cross-regime results actionable.
   *
   * Body (optional): { days?=90, resolutionSec?=3600, windowDays?=10 }
   */
  app.post<{ Body?: { days?: number; resolutionSec?: number; windowDays?: number } }>(
    "/admin/foxify/v2/dvol-backfill",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { backfillDvolHistory } = await import("../../../scripts/calibration/backfillDvolHistory");
      const body = req.body ?? {};
      const days = typeof body.days === "number" && body.days > 0 ? Math.min(365, body.days) : 90;
      const resolutionSec = typeof body.resolutionSec === "number" && body.resolutionSec > 0 ? body.resolutionSec : 3600;
      const windowDays = typeof body.windowDays === "number" && body.windowDays > 0 ? Math.min(30, body.windowDays) : 10;
      try {
        const result = await backfillDvolHistory(deps.pool, {
          days, resolutionSec, windowDays,
          log: (msg) => console.log(`[dvolBackfill] ${msg}`)
        });
        reply.send({
          ok: true,
          ...result,
          oldestIso: result.oldestMs ? new Date(result.oldestMs).toISOString() : null,
          newestIso: result.newestMs ? new Date(result.newestMs).toISOString() : null,
          note: "Re-check GET /admin/foxify/v2/regime-calibration — regimes with >=100 samples now use empirical_median."
        });
      } catch (e) {
        reply.code(502).send({ error: "backfill_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/structure-selector
   *
   * Phase 5 (read-only): shows which option STRUCTURE the regime selector would
   * route to for each regime + the current live regime's selection. INFORMATIONAL
   * ONLY — not yet wired into the live activation gate (that waits until the cell
   * sweep + DVOL backfill validate per-regime winners). Override mapping via env
   * SS_STRUCTURE_BY_REGIME (JSON).
   */
  app.get("/admin/foxify/v2/structure-selector", { preHandler: checkAdminToken }, async (_req, reply) => {
    const { getFullStructureMap, selectStructureForRegime } = await import("./structureSelector");
    const { classifyRegime } = await import("./featureFlag");
    const currentDvol = deps.dvolService.getCurrentDvol();
    const currentRegime = currentDvol ? classifyRegime(currentDvol.dvol) : null;
    reply.send({
      current_dvol: currentDvol?.dvol ?? null,
      current_regime: currentRegime,
      current_selection: currentRegime ? selectStructureForRegime(currentRegime) : null,
      map: getFullStructureMap(),
      wired_into_activation: false,
      note: "Informational only. The regime→structure mapping is the CTO strategic framework; cell parameters within each structure are still gated by cellAllowlist (validated by the sweep). Wiring into live activation is deferred until Phase 4/4.5 winners are validated on real data."
    });
  });

  /**
   * POST /admin/foxify/v2/iron-condor-probe
   *
   * Phase 7: price a SHORT iron condor from the REAL chain (sell inner put+call,
   * buy outer wings) and run the income MC across regimes. Answers "can a calm
   * iron condor collect enough credit to cover Foxify's perp friction?" with real
   * bid/ask — not synthetic. Selling requires venue margin (available on Bullish).
   *
   * Body (optional): { spot?, notional?=50000, shortWidthPct?=0.03, wingWidthPct?=0.02,
   *   tenorDays?=3, profitTargetUsdc?=250, trailStopUsdc?=300, perpPairFrictionUsdc?, nPaths?=500 }
   */
  app.post<{ Body?: Record<string, unknown> }>(
    "/admin/foxify/v2/iron-condor-probe",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { priceOption } = await import("./optionPricing");
      const { getRegimeCalibration } = await import("./regimeCalibration");
      const { classifyRegime } = await import("./featureFlag");
      const { runIronCondorMc } = await import("./ironCondorMc");
      const b = req.body ?? {};
      const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
      const feed = deps.feedService.getCurrentFeed();
      const spot = typeof b.spot === "number" ? b.spot : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable", message: "need canonical spot" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const currentDvol = deps.dvolService.getCurrentDvol();
      if (!currentDvol) { reply.code(503).send({ error: "dvol_unavailable" }); return; }
      const currentRegime = classifyRegime(currentDvol.dvol);

      const notional = num(b.notional, 50000);
      const shortWidthPct = num(b.shortWidthPct, 0.03);
      const wingWidthPct = num(b.wingWidthPct, 0.02);
      const tenorDays = num(b.tenorDays, 3);
      const profitTargetUsdc = num(b.profitTargetUsdc, 250);
      const trailStopUsdc = num(b.trailStopUsdc, 300);
      const friction = typeof b.perpPairFrictionUsdc === "number" ? b.perpPairFrictionUsdc
        : (process.env.FOXIFY_PERP_FRICTION_USDC != null ? Number(process.env.FOXIFY_PERP_FRICTION_USDC) : 0);
      const nPaths = num(b.nPaths, 500);
      const contractsBtc = +(notional / spot).toFixed(3);
      const snap = (x: number): number => Math.round(x / 1000) * 1000;
      const putShort = snap(spot * (1 - shortWidthPct));
      const putLong = snap(spot * (1 - shortWidthPct - wingWidthPct));
      const callShort = snap(spot * (1 + shortWidthPct));
      const callLong = snap(spot * (1 + shortWidthPct + wingWidthPct));
      const tenorMs = tenorDays * 86_400_000;
      const px = (strike: number, optType: "put" | "call") => priceOption({
        spot, strike, optType, tenorRemainingMs: tenorMs, contractsBtc,
        venue: null, instrumentSymbol: null, liquidChainCache: deps.liquidChainCache,
        dvolService: deps.dvolService, purpose: "fair_value", bidHaircut: 1.0
      });
      const pPutShort = px(putShort, "put");
      const pPutLong = px(putLong, "put");
      const pCallShort = px(callShort, "call");
      const pCallLong = px(callLong, "call");
      const strikes = { put_long: putLong, put_short: putShort, call_short: callShort, call_long: callLong };
      // Need real BID on the legs we SELL + real ASK on the wings we BUY.
      const missing: string[] = [];
      if (pPutShort.bid_per_btc == null) missing.push("put_short.bid");
      if (pPutLong.ask_per_btc == null) missing.push("put_long.ask");
      if (pCallShort.bid_per_btc == null) missing.push("call_short.bid");
      if (pCallLong.ask_per_btc == null) missing.push("call_long.ask");
      if (missing.length > 0) { reply.send({ ok: false, error: "chain_unavailable", missing, strikes }); return; }
      const entryCreditPerBtc = (pPutShort.bid_per_btc! - pPutLong.ask_per_btc!) + (pCallShort.bid_per_btc! - pCallLong.ask_per_btc!);
      const entryCreditUsdc = entryCreditPerBtc * contractsBtc;
      if (!(entryCreditUsdc > 0)) {
        reply.send({ ok: false, error: "non_positive_credit", entry_credit_usdc: +entryCreditUsdc.toFixed(2), strikes,
          note: "Net credit is <= 0 at these strikes/widths (wings cost more than the inner legs pay). Widen shortWidthPct or narrow wingWidthPct." });
        return;
      }
      const calibration = await getRegimeCalibration(deps.pool);
      const regimes: Array<"calm" | "moderate" | "elevated" | "stress"> = ["calm", "moderate", "elevated", "stress"];
      const byRegime: Record<string, unknown> = {};
      for (const regime of regimes) {
        const sigma = calibration[regime].sigma;
        const mc = await runIronCondorMc({
          cellId: `ic_${regime}`, spot,
          putShortStrike: putShort, putLongStrike: putLong, callShortStrike: callShort, callLongStrike: callLong,
          tenorDays, regime, sigmaAnnual: sigma, contractsBtc, entryCreditUsdc, profitTargetUsdc, trailStopUsdc, nPaths
        });
        byRegime[regime] = {
          tier: regime === currentRegime ? "real" : "estimate",
          sigma_used: sigma, sigma_source: calibration[regime].sigmaSource,
          mean_net_usdc: +mc.meanFoxifyNetUsdc.toFixed(2),
          pct_profitable: +mc.pctProfitable.toFixed(4),
          // The option's own net = the MAX perp friction this structure can cover
          // while staying >= 0. (Negative ⇒ loses even at $0 friction.)
          breakeven_friction_usdc: +mc.meanFoxifyNetUsdc.toFixed(2),
          net_after_friction_usdc: +(mc.meanFoxifyNetUsdc - friction).toFixed(2),
          covers_friction: mc.meanFoxifyNetUsdc - friction >= 0,
          p5_usdc: +mc.p5FoxifyNetUsdc.toFixed(2), p95_usdc: +mc.p95FoxifyNetUsdc.toFixed(2),
          exit_distribution: mc.exitDistribution, max_loss_usdc: +mc.maxLossUsdc.toFixed(2)
        };
      }
      reply.send({
        ok: true, spot, current_regime: currentRegime, notional, contracts_btc: contractsBtc,
        strikes, tenor_days: tenorDays,
        entry_credit_usdc: +entryCreditUsdc.toFixed(2), max_profit_usdc: +entryCreditUsdc.toFixed(2),
        profit_target_usdc: profitTargetUsdc, trail_stop_usdc: trailStopUsdc, perp_pair_friction_usdc: friction,
        by_regime: byRegime,
        note: "SHORT iron condor priced from REAL chain bid/ask. Per-tick buyback uses BS at calibration sigma. Selling requires venue margin (Bullish). Only current_regime is REAL tier; others are estimate. Condor profits in CALM (range-bound), loses in high vol — mirror image of the long straddle."
      });
    }
  );

  /**
   * GET /admin/foxify/v2/ev-by-regime
   *
   * Cross-regime EV matrix per cell, with real-bid realism applied. Answers
   * "are there ANY market conditions under which these cells profit?"
   *
   * For each cell × each regime in {calm, moderate, elevated, stress}:
   *   - Run live MC sim with that regime's vol + cost markup
   *   - Apply the SAME realism multiplier as gate_with_ev (real_bid / bs at current spot)
   *   - Report Foxify EV %, trigger rate, verdict
   *
   * Use to see if a cell that's NEGATIVE in calm becomes PROFITABLE in elevated/stress
   * (typical: higher vol → tighter spreads → higher real-bid haircut → better EV).
   *
   * Query params (optional):
   *   ?realism_override=0.85  — fix realism multiplier (skip per-cell bid lookup)
   *   ?cells=cellA,cellB      — restrict to listed cells
   */
  app.get<{ Querystring: { realism_override?: string; cells?: string } }>(
    "/admin/foxify/v2/ev-by-regime",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { PHASE_0_CELLS } = await import("./cellConfig");
      const { resolveCurrentTier } = await import("./tierResolver");
      const { buildQuote } = await import("./quoteEngine");
      const { computeLiveCellEv } = await import("./liveCellEvService");
      const { priceOption: priceOpt } = await import("./optionPricing");

      // Validate query inputs FIRST (cheap) before doing any DB/tier work
      const realismOverride = req.query.realism_override != null
        ? Number(req.query.realism_override)
        : undefined;
      if (realismOverride != null && (!Number.isFinite(realismOverride) || realismOverride < 0 || realismOverride > 1.5)) {
        reply.code(400).send({ error: "invalid_request", message: "realism_override must be in [0, 1.5]" });
        return;
      }
      const cellFilter = req.query.cells ? req.query.cells.split(",").map((s) => s.trim()).filter(Boolean) : null;

      const feed = deps.feedService.getCurrentFeed();
      if (!feed || feed.health === "unavailable" || feed.canonicalPrice == null) {
        reply.code(503).send({ error: "feed_unavailable", message: "Cannot price cells without canonical spot" });
        return;
      }
      const spot = feed.canonicalPrice;
      const tier = await resolveCurrentTier(deps.pool, Date.now());

      const REGIMES = ["calm", "moderate", "elevated", "stress"] as const;
      const cellResults: Array<Record<string, unknown>> = [];

      for (const cellId of Object.keys(PHASE_0_CELLS)) {
        if (cellFilter && !cellFilter.includes(cellId)) continue;
        const cell = PHASE_0_CELLS[cellId];
        if (!cell.enabled) {
          cellResults.push({ cellId, ok: false, reason: "cell_deprecated" });
          continue;
        }
        try {
          const quote = await buildQuote({
            cell, spot, anchorProvider: deps.anchorProvider, tier,
            liquidChainCache: deps.liquidChainCache ?? null
          });
          if (!quote.ok) {
            cellResults.push({ cellId, ok: false, reason: quote.reason });
            continue;
          }
          const liveCost = quote.totalHedgeCostUsdc;

          // Compute realism multiplier (override OR derived from chain)
          let realismMultiplier = 1.0;
          let realismSource = "bs_only_legacy";
          let bidDetail: Record<string, number | null> = {};
          if (realismOverride != null) {
            realismMultiplier = realismOverride;
            realismSource = "override";
          } else if (deps.liquidChainCache) {
            const tenorMs = cell.hedgeTenorDays * 86_400_000;
            const putP = priceOpt({
              spot, strike: quote.putStrike, optType: "put",
              tenorRemainingMs: tenorMs, contractsBtc: cell.contractsBtc,
              venue: quote.putLeg.venue, instrumentSymbol: quote.putLeg.symbol,
              liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
              purpose: "fair_value", bidHaircut: 1.0
            });
            const callP = priceOpt({
              spot, strike: quote.callStrike, optType: "call",
              tenorRemainingMs: tenorMs, contractsBtc: cell.contractsBtc,
              venue: quote.callLeg.venue, instrumentSymbol: quote.callLeg.symbol,
              liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
              purpose: "fair_value", bidHaircut: 1.0
            });
            const realPutBid = putP.bid_per_btc ?? 0;
            const realCallBid = callP.bid_per_btc ?? 0;
            const bsPutVal = putP.bs_theoretical_per_btc;
            const bsCallVal = callP.bs_theoretical_per_btc;
            if (bsPutVal + bsCallVal > 0 && realPutBid + realCallBid > 0) {
              realismMultiplier = Math.max(0, Math.min(1.5, (realPutBid + realCallBid) / (bsPutVal + bsCallVal)));
              realismSource = "bid_calibrated";
              bidDetail = {
                real_put_bid: realPutBid,
                real_call_bid: realCallBid,
                bs_put: bsPutVal,
                bs_call: bsCallVal
              };
            } else {
              realismSource = "bid_unavailable_using_bs";
            }
          }

          // Sweep all regimes
          const byRegime: Record<string, unknown> = {};
          for (const regime of REGIMES) {
            const evSim = await computeLiveCellEv({
              cellId, spot, hedgeCostAtCalm: liveCost,
              putStrike: quote.putStrike, callStrike: quote.callStrike,
              tenorDays: cell.hedgeTenorDays,
              triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
              regime, contractsBtc: cell.contractsBtc,
              salvageRealismMultiplier: realismMultiplier
            });
            const evPct = evSim.hedgeCost > 0 ? evSim.meanFoxifyEv / evSim.hedgeCost : 0;
            const worstPct = evSim.hedgeCost > 0 ? evSim.p5FoxifyEv / evSim.hedgeCost : 0;
            const verdict =
              evPct > 0.20 ? "PROFITABLE" :
              evPct > 0.05 ? "MARGINAL_PROFITABLE" :
              evPct > -0.05 ? "BREAK_EVEN" :
              evPct > -0.20 ? "MARGINAL_NEGATIVE" : "NEGATIVE";
            byRegime[regime] = {
              cost_at_regime: evSim.hedgeCost,
              mean_salvage: evSim.meanSalvage,
              trigger_rate: evSim.triggerRate,
              foxify_ev_pct: evPct,
              worst_case_pct: worstPct,
              foxify_ev_usdc: evSim.meanFoxifyEv,
              verdict
            };
          }

          // Cross-regime summary: any regime profitable?
          const profitableRegimes = REGIMES.filter((r) => {
            const v = (byRegime[r] as { verdict: string }).verdict;
            return v === "PROFITABLE" || v === "MARGINAL_PROFITABLE";
          });
          const bestRegime = REGIMES.reduce<{ regime: string; ev_pct: number } | null>((best, r) => {
            const evPct = (byRegime[r] as { foxify_ev_pct: number }).foxify_ev_pct;
            if (!best || evPct > best.ev_pct) return { regime: r, ev_pct: evPct };
            return best;
          }, null);

          cellResults.push({
            cellId,
            ok: true,
            live_cost: liveCost,
            put_venue: quote.putLeg.venue,
            call_venue: quote.callLeg.venue,
            actual_strikes: { put: quote.putStrike, call: quote.callStrike },
            realism: {
              multiplier: realismMultiplier,
              source: realismSource,
              ...bidDetail
            },
            by_regime: byRegime,
            summary: {
              profitable_in_regimes: profitableRegimes,
              best_regime: bestRegime?.regime,
              best_regime_ev_pct: bestRegime?.ev_pct,
              recommendation: profitableRegimes.length === 0
                ? "AVOID_ALL_REGIMES — no condition produces positive EV with current realism"
                : profitableRegimes.length === 4
                  ? "ROBUST_ALL_REGIMES — profitable in every regime"
                  : `SELECTIVE — profitable only in ${profitableRegimes.join(", ")}`
            }
          });
        } catch (e) {
          cellResults.push({ cellId, ok: false, reason: "sim_threw", message: (e as Error).message });
        }
      }

      reply.send({
        asOf: new Date().toISOString(),
        spot,
        realism_override: realismOverride ?? null,
        regimes: REGIMES,
        cells: cellResults,
        methodology: {
          ev_estimation: "Live MC sim per cell × regime. 2k paths each. Bootstrap (calm + bars) else GBM. Cached per (cellId, regime, cost-bucket, realism-bucket).",
          realism_calibration: "By default, multiplier = (real_put_bid + real_call_bid) / (bs_put_at_spot + bs_call_at_spot) for the cell's strikes at current spot, applied uniformly to all salvages in MC. ?realism_override=X to fix at a specific value (e.g. 0.85 = assume 15% bid haircut everywhere). Same path as gate_with_ev — cross-checks consistency.",
          regime_definitions: {
            calm: "DVOL <40, σ=0.35, cost markup 1.00",
            moderate: "DVOL 40-50, σ=0.55, cost markup 1.15",
            elevated: "DVOL 50-65, σ=0.75, cost markup 1.35",
            stress: "DVOL >65, σ=0.95, cost markup 1.60"
          },
          interpretation: {
            ROBUST_ALL_REGIMES: "Cell is profitable across all market conditions — strong candidate for steady allocation",
            SELECTIVE: "Cell only profits in certain regimes — operator should gate activations by regime",
            AVOID_ALL_REGIMES: "No regime produces positive EV — cell may be structurally broken for current calibration"
          }
        }
      });
    }
  );

  /**
   * GET /admin/foxify/v2/chain-probe
   *
   * Dumps raw bid/ask data from the LiquidChainCache for arbitrary strikes,
   * so we can independently verify what quotes Bullish/Deribit are publishing
   * for the strikes our picker selects. Critical for diagnosing
   * "too-good-to-be-true" cell economics.
   *
   * Query params:
   *   ?strikes=73000,75000   (CSV of strike prices in USD)
   *   ?opt_type=both|put|call (default: both)
   *   ?tenor_hours=48         (target tenor; default: 48)
   *   ?force_refresh=true     (bypass TTL and pull fresh)
   *
   * Returns per-strike, per-side: bid USDC/BTC, ask USDC/BTC, spread %,
   * mark IV, venue, instrument name, tenor hours. Plus snapshot age and
   * venue health.
   */
  app.get<{ Querystring: { strikes?: string; opt_type?: "both" | "put" | "call"; tenor_hours?: string; force_refresh?: "true" | "false" } }>(
    "/admin/foxify/v2/chain-probe",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      if (!deps.liquidChainCache) {
        reply.code(503).send({ error: "chain_cache_unavailable", message: "LiquidChainCache not configured on this server" });
        return;
      }
      const strikesRaw = req.query.strikes ?? "";
      const strikes = strikesRaw.split(",").map((s) => Number(s.trim())).filter((s) => Number.isFinite(s) && s > 0);
      if (strikes.length === 0) {
        reply.code(400).send({ error: "invalid_request", message: "?strikes=<csv of strike prices> required (e.g. ?strikes=73000,75000)" });
        return;
      }
      const optType = req.query.opt_type ?? "both";
      if (!["both", "put", "call"].includes(optType)) {
        reply.code(400).send({ error: "invalid_request", message: "opt_type must be 'both'|'put'|'call'" });
        return;
      }
      const tenorHours = Number(req.query.tenor_hours ?? "48");
      if (!Number.isFinite(tenorHours) || tenorHours <= 0) {
        reply.code(400).send({ error: "invalid_request", message: "tenor_hours must be a positive number" });
        return;
      }
      const forceRefresh = req.query.force_refresh === "true";

      // Pull/refresh snapshot
      const now = Date.now();
      const snapshot = forceRefresh
        ? await deps.liquidChainCache.refresh(now)
        : await deps.liquidChainCache.getChain(now);
      if (!snapshot) {
        reply.code(503).send({ error: "no_chain_snapshot", message: "Chain cache returned null — all venues unreachable" });
        return;
      }

      const wantPut = optType === "both" || optType === "put";
      const wantCall = optType === "both" || optType === "call";

      const result = strikes.map((strike) => {
        const sideResults: Record<string, unknown> = { strike };
        for (const side of (["put", "call"] as const)) {
          if (side === "put" && !wantPut) continue;
          if (side === "call" && !wantCall) continue;
          // Get all quotes matching this strike+side from the raw snapshot
          const allMatches = snapshot.quotes.filter(
            (q) => q.strike === strike && q.optType === side
          );
          // Sort by tenor closeness to requested tenor
          allMatches.sort((a, b) =>
            Math.abs(a.tenorHours - tenorHours) - Math.abs(b.tenorHours - tenorHours)
          );
          sideResults[`${side}_quotes`] = allMatches.slice(0, 6).map((q) => ({
            venue: q.venue,
            instrument: q.instrument_name,
            tenor_days: +(q.tenorHours / 24).toFixed(2),
            bid_usdc_per_btc: q.bidUsdcPerBtc,
            ask_usdc_per_btc: q.askUsdcPerBtc,
            mid_usdc_per_btc: q.midUsdcPerBtc,
            spread_pct: q.spreadPct,
            mark_iv: q.markIv,
            has_bid: q.bidUsdcPerBtc > 0,
            // For 1 BTC of contracts, what would we pay/receive?
            // (handy for sanity-checking against displayed cell costs)
            cost_for_1_btc_ask: q.askUsdcPerBtc,
            proceeds_for_1_btc_bid: q.bidUsdcPerBtc
          }));
          // Also surface our picker's chosen bid (matches what ShadowCloseExecutor uses)
          const pickerChoice = deps.liquidChainCache!.getBidForLeg({
            strike,
            optType: side,
            tenorRemainingHours: tenorHours,
            preferVenue: "bullish"
          });
          sideResults[`${side}_picker_bid_choice`] = pickerChoice
            ? {
                venue: pickerChoice.venue,
                instrument: pickerChoice.instrumentName,
                bid_usdc_per_btc: pickerChoice.bidUsdcPerBtc,
                ask_usdc_per_btc: pickerChoice.askUsdcPerBtc,
                spread_pct: pickerChoice.spreadPct,
                tenor_hours: pickerChoice.tenorHours,
                mark_iv: pickerChoice.markIv
              }
            : null;
        }
        return sideResults;
      });

      reply.send({
        snapshot_fetched_at: new Date(snapshot.fetchedAtMs).toISOString(),
        snapshot_age_ms: now - snapshot.fetchedAtMs,
        spot: snapshot.spot,
        venue_status: snapshot.venueStatus,
        requested_tenor_hours: tenorHours,
        strikes: result,
        interpretation_guide: {
          spread_pct_red_flag: "spread > 20% suggests illiquid quote; sell-side execution will be poor",
          missing_bid: "bid_usdc_per_btc = 0 means venue has no resting buyer — we'd fall back to BS valuation on close",
          ask_vs_picker: "if ask quoted is much lower than BS theoretical for similar strikes, the quote may be stale or thin"
        }
      });
    }
  );

  /**
   * GET /admin/foxify/v2/bullish-whitelist-probe
   *
   * Fires a single test request from this server's IP to either:
   *   - registered.api.exchange.bullish.com (default — to check whitelist)
   *   - api.exchange.bullish.com (the public endpoint we currently use)
   * Returns the raw HTTP status, response body preview, and timing so we
   * can tell exactly what Bullish's edge is doing for our IP.
   *
   * Interpretation guide:
   *   - HTTP 200/401/403 with JSON body → reached Bullish, whitelist OK
   *   - HTTP 403 with "forbidden" / "blocked" / Cloudflare body → NOT whitelisted
   *   - HTTP 429 → reached server, just rate-limited (still good signal)
   *   - timeout / ECONNREFUSED / network error → blocked at network layer
   *
   * No authentication is attempted — we're only probing the network path.
   * Use query param ?endpoint=public to probe the public endpoint instead.
   */
  app.get<{ Querystring: { endpoint?: "registered" | "public"; path?: string } }>(
    "/admin/foxify/v2/bullish-whitelist-probe",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const which = req.query.endpoint === "public" ? "public" : "registered";
      const host = which === "registered" ? "registered.api.exchange.bullish.com" : "api.exchange.bullish.com";
      // Use a lightweight public-ish path; "/trading-api/v1/time" is a server-time endpoint
      // that exists on Bullish and doesn't require auth — perfect for connectivity check.
      const path = req.query.path && typeof req.query.path === "string" ? req.query.path : "/trading-api/v1/time";
      const url = `https://${host}${path}`;
      const startMs = Date.now();
      let result: {
        ok: boolean;
        url: string;
        http_status: number | null;
        body_preview: string | null;
        latency_ms: number;
        error: string | null;
        interpretation: string;
      };
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": "Atticus-WhitelistProbe/1.0" },
          signal: ctrl.signal
        }).finally(() => clearTimeout(timer));
        const text = await res.text().catch(() => "");
        const preview = text.slice(0, 500);
        let interpretation: string;
        if (res.status === 200) interpretation = "REACHED_AND_OK — whitelist + endpoint healthy";
        else if (res.status === 401) interpretation = "REACHED_NEEDS_AUTH — whitelist OK (server is asking for credentials)";
        else if (res.status === 403) {
          const lower = preview.toLowerCase();
          if (lower.includes("cloudflare") || lower.includes("blocked") || lower.includes("not allowed")) {
            interpretation = "BLOCKED — appears to be edge/firewall block (likely NOT whitelisted yet)";
          } else {
            interpretation = "REACHED_BUT_FORBIDDEN — server reached, returned 403 with non-block body (could be auth-related)";
          }
        }
        else if (res.status === 429) interpretation = "REACHED_RATE_LIMITED — server reached, just rate limited";
        else interpretation = `REACHED_HTTP_${res.status} — server responded, see body_preview`;
        result = {
          ok: res.status >= 200 && res.status < 500,
          url,
          http_status: res.status,
          body_preview: preview,
          latency_ms: Date.now() - startMs,
          error: null,
          interpretation
        };
      } catch (e) {
        const msg = (e as Error).message;
        let interpretation = `NETWORK_ERROR — ${msg}`;
        if (msg.includes("ETIMEDOUT") || msg.includes("aborted") || msg.includes("timeout")) {
          interpretation = "TIMEOUT — request never got a response (likely blocked at network layer; NOT whitelisted)";
        } else if (msg.includes("ECONNREFUSED")) {
          interpretation = "CONNECTION_REFUSED — server refused TCP connection (NOT whitelisted)";
        } else if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN")) {
          interpretation = "DNS_ERROR — could not resolve hostname";
        }
        result = {
          ok: false,
          url,
          http_status: null,
          body_preview: null,
          latency_ms: Date.now() - startMs,
          error: msg,
          interpretation
        };
      }
      reply.send(result);
    }
  );

  /**
   * POST /admin/foxify/v2/force-trigger
   *
   * Validation tool. Synthetically triggers a SHADOW pair so we can observe
   * the full close lifecycle (active → triggered → unwinding → settled)
   * without waiting for BTC to actually cross a boundary in real markets.
   *
   * Body: { pair_id: string, side?: "down" | "up" (default "up") }
   *
   * Strictly limited to is_shadow=true pairs — refuses to touch real pairs.
   * The transition is RECORDED in the audit trail with a synthetic trigger
   * feed_snapshot, then ExecutionRuntime spawns and the close stack handles
   * the rest exactly as it would for a real trigger event.
   *
   * Use to validate: trigger detector → ExecutionRuntime → close executor
   * → settlement path end-to-end before going live.
   */
  app.post<{ Body: { pair_id: string; side?: "down" | "up"; mode?: "natural" | "fast"; spot_override?: number } }>(
    "/admin/foxify/v2/force-trigger",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { pair_id } = req.body ?? {};
      const side = req.body?.side ?? "up";
      const mode = req.body?.mode ?? "natural";
      // Optional: override the spot the runtime sees. Used to simulate
      // "what if spot were AT trigger boundary right now?" without waiting
      // for BTC to actually move. Combined with mode=fast, this answers the
      // critical question: what salvage do we receive when option is deep ITM?
      const spotOverride = typeof req.body?.spot_override === "number" && Number.isFinite(req.body.spot_override) && req.body.spot_override > 0
        ? req.body.spot_override
        : undefined;
      if (!pair_id || typeof pair_id !== "string") {
        reply.code(400).send({ error: "invalid_request", message: "pair_id required (string)" });
        return;
      }
      if (side !== "down" && side !== "up") {
        reply.code(400).send({ error: "invalid_request", message: "side must be 'down' or 'up'" });
        return;
      }
      if (mode !== "natural" && mode !== "fast") {
        reply.code(400).send({ error: "invalid_request", message: "mode must be 'natural' or 'fast'" });
        return;
      }
      if (!deps.forceTriggerPair) {
        reply.code(503).send({ error: "force_trigger_unavailable", message: "forceTriggerPair callback not wired in server" });
        return;
      }
      const result = await deps.forceTriggerPair(pair_id, side, mode, spotOverride);
      if (!result.ok) {
        reply.code(409).send(result);
        return;
      }
      reply.code(202).send(result);
    }
  );

  /**
   * GET /admin/foxify/v2/settled-summary
   *
   * Aggregated view of all settled pairs broken down by exit_mode. Includes
   * total counts, costs, salvages, and net PnL per category. Plus the most
   * recent N settled pairs with full settlement detail.
   *
   * Designed so the operator doesn't need direct DB access for PnL reporting.
   *
   * Query params:
   *   ?recent_limit=20    (number of recent pairs to return in detail)
   *   ?include_live=true  (default false — shadow only)
   */
  app.get<{ Querystring: { recent_limit?: string; include_live?: string } }>(
    "/admin/foxify/v2/settled-summary",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const recentLimit = Math.max(1, Math.min(200, Number(req.query.recent_limit ?? "20")));
      const includeLive = req.query.include_live === "true";

      // Aggregate by exit_mode
      const aggSql = `
        SELECT exit_mode,
               COUNT(*)::int AS n,
               SUM(hedge_cost_total_usdc::numeric)::float AS total_cost,
               SUM(salvage_proceeds_usdc::numeric)::float AS total_salvage,
               SUM(foxify_share_usdc::numeric)::float AS total_foxify_share,
               SUM(atticus_share_usdc::numeric)::float AS total_atticus_share
        FROM two_sided_pair
        WHERE status = 'settled'
          ${includeLive ? "" : "AND is_shadow = TRUE"}
        GROUP BY exit_mode
        ORDER BY exit_mode
      `;
      const aggRes = await deps.pool.query(aggSql);
      const byExitMode = aggRes.rows.map((r) => {
        const cost = Number(r.total_cost ?? 0);
        const salvage = Number(r.total_salvage ?? 0);
        return {
          exit_mode: r.exit_mode,
          count: Number(r.n),
          total_cost_usdc: cost,
          total_salvage_usdc: salvage,
          total_foxify_share_usdc: Number(r.total_foxify_share ?? 0),
          total_atticus_share_usdc: Number(r.total_atticus_share ?? 0),
          net_pnl_usdc: salvage - cost,
          pnl_pct_of_cost: cost > 0 ? (salvage - cost) / cost : 0
        };
      });

      // Overall totals
      const totalCount = byExitMode.reduce((s, r) => s + r.count, 0);
      const totalCost = byExitMode.reduce((s, r) => s + r.total_cost_usdc, 0);
      const totalSalvage = byExitMode.reduce((s, r) => s + r.total_salvage_usdc, 0);
      const totalFoxify = byExitMode.reduce((s, r) => s + r.total_foxify_share_usdc, 0);
      const totalAtticus = byExitMode.reduce((s, r) => s + r.total_atticus_share_usdc, 0);

      // Recent settled pairs with full detail
      const recentSql = `
        SELECT pair_id, cell_id, exit_mode, closed_reason, is_shadow,
               hedge_cost_total_usdc::float AS cost,
               salvage_proceeds_usdc::float AS salvage,
               foxify_share_usdc::float AS foxify_share,
               atticus_share_usdc::float AS atticus_share,
               closed_at, created_at
        FROM two_sided_pair
        WHERE status = 'settled'
          ${includeLive ? "" : "AND is_shadow = TRUE"}
        ORDER BY closed_at DESC
        LIMIT ${recentLimit}
      `;
      const recentRes = await deps.pool.query(recentSql);
      const recentPairs = recentRes.rows.map((r) => {
        const cost = Number(r.cost ?? 0);
        const salvage = Number(r.salvage ?? 0);
        return {
          pair_id: r.pair_id,
          cell_id: r.cell_id,
          exit_mode: r.exit_mode,
          closed_reason: r.closed_reason,
          is_shadow: r.is_shadow,
          cost_usdc: cost,
          salvage_usdc: salvage,
          net_pnl_usdc: salvage - cost,
          pnl_pct: cost > 0 ? (salvage - cost) / cost : 0,
          foxify_share_usdc: Number(r.foxify_share ?? 0),
          atticus_share_usdc: Number(r.atticus_share ?? 0),
          closed_at: r.closed_at,
          created_at: r.created_at
        };
      });

      reply.send({
        as_of: new Date().toISOString(),
        filter: includeLive ? "shadow + live" : "shadow only",
        overall: {
          total_settled: totalCount,
          total_cost_usdc: totalCost,
          total_salvage_usdc: totalSalvage,
          total_foxify_share_usdc: totalFoxify,
          total_atticus_share_usdc: totalAtticus,
          net_pnl_usdc: totalSalvage - totalCost,
          pnl_pct_of_cost: totalCost > 0 ? (totalSalvage - totalCost) / totalCost : 0
        },
        by_exit_mode: byExitMode,
        recent_pairs: recentPairs
      });
    }
  );

  /**
   * GET /admin/foxify/v2/venue-routing
   *
   * Shows WHERE pair legs are being bought (Bullish vs Deribit) and WHY
   * the picker chose each venue. Two sections:
   *
   * 1. historical: aggregate stats across active pairs (volume + count
   *    by venue, broken down by cell)
   *
   * 2. forward: what the picker WOULD do RIGHT NOW for each cell,
   *    including the cost comparison between venues and the picker's
   *    reasoning ("deribit cheaper by 3.2%", "bullish only — deribit
   *    insufficient depth", etc.)
   *
   * Query params:
   *   ?include_closed=true  - include closed/settled pairs in historical (default: active only)
   *   ?cells=cell1,cell2    - restrict forward analysis to specific cells
   */
  app.get<{ Querystring: { include_closed?: string; cells?: string } }>(
    "/admin/foxify/v2/venue-routing",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { getHistoricalRoutingStats, getForwardRoutingExplanation } = await import("./venueRouting");
      const includeClosed = req.query.include_closed === "true";
      const cellsFilter = req.query.cells?.split(",").map((s) => s.trim()).filter(Boolean);

      const historical = await getHistoricalRoutingStats(deps.pool, { activeOnly: !includeClosed });

      // Forward-looking — needs feed + anchor provider
      let forward: import("./venueRouting").CellRoutingExplanation[] = [];
      const feed = deps.feedService.getCurrentFeed();
      if (feed && feed.canonicalPrice != null) {
        try {
          forward = await getForwardRoutingExplanation({
            spot: feed.canonicalPrice,
            anchorProvider: deps.anchorProvider,
            liquidChainCache: deps.liquidChainCache ?? null,
            cells: cellsFilter
          });
        } catch (e) {
          console.error(`[venue-routing] forward analysis failed: ${(e as Error).message}`);
        }
      }

      reply.send({ historical, forward });
    }
  );

  /**
   * GET /admin/foxify/v2/pairs/mtm
   *
   * Operator-facing version of /foxify/v2/pairs/mtm. Same shape, but
   * INCLUDES shadow pairs (Foxify-facing version excludes them).
   * Useful for monitoring shadow lifecycle, validating MTM math against
   * test-fired pairs, and seeing TP-AVAILABLE opportunities in the shadow
   * portfolio.
   *
   * Query params:
   *   ?include_shadow=false   (default true)
   *   ?tp_threshold_pct=0.30
   *   ?watch_threshold_pct=0.05
   *   ?pair_id=...
   */
  app.get<{ Querystring: { include_shadow?: string; tp_threshold_pct?: string; watch_threshold_pct?: string; pair_id?: string } }>(
    "/admin/foxify/v2/pairs/mtm",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const feed = deps.feedService.getCurrentFeed();
      if (!feed || feed.canonicalPrice == null) {
        reply.code(503).send({ error: "feed_unavailable", message: "Cannot compute MTM without canonical spot" });
        return;
      }
      const dvol = deps.dvolService.getCurrentDvol();
      const iv = dvol?.sigmaAnnual ?? 0.35;
      const tpThresholdPct = req.query.tp_threshold_pct != null ? Number(req.query.tp_threshold_pct) : undefined;
      const watchThresholdPct = req.query.watch_threshold_pct != null ? Number(req.query.watch_threshold_pct) : undefined;
      const includeShadow = req.query.include_shadow !== "false";
      const { listActivePairMtm, summarizeMtm } = await import("./mtmService");
      const nowMs = Date.now();
      const pairs = await listActivePairMtm({
        pool: deps.pool,
        currentSpot: feed.canonicalPrice,
        ivAnnual: iv,
        liquidChainCache: deps.liquidChainCache ?? null,
        includeShadow,
        pairIdFilter: req.query.pair_id,
        tpThresholdPct,
        watchThresholdPct,
        nowMs
      });
      const summary = summarizeMtm(pairs, {
        currentSpot: feed.canonicalPrice,
        ivAnnual: iv,
        tpThresholdPct: tpThresholdPct ?? 0.30,
        watchThresholdPct: watchThresholdPct ?? 0.05,
        nowMs
      });
      reply.send({ ...summary, includes_shadow: includeShadow });
    }
  );

  /**
   * GET /admin/foxify/v2/shadow-pairs?limit=20&status=active
   *
   * List recent shadow pairs (is_shadow=true), most-recent first. Lets
   * operators inspect ongoing/closed shadow lifecycle without needing
   * the Foxify token. Each entry includes status, cost, trigger band,
   * expiry, and salvage/settlement if closed.
   */
  app.get<{ Querystring: { limit?: string; status?: string } }>(
    "/admin/foxify/v2/shadow-pairs",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "20")));
      const statusFilter = req.query.status;
      const params: unknown[] = [limit];
      let where = "WHERE is_shadow = TRUE";
      if (statusFilter && typeof statusFilter === "string" && statusFilter.length > 0) {
        where += ` AND status = $${params.length + 1}`;
        params.push(statusFilter);
      }
      const result = await deps.pool.query(
        `SELECT pair_id, cell_id, status, is_shadow,
                spot_at_activation, trigger_down_price, trigger_up_price,
                hedge_tenor_days, expires_at, tp_force_exit_at,
                hedge_cost_total_usdc, foxify_capital_funded_usdc,
                tier_at_activation, atticus_floor_usdc,
                triggered_at, trigger_side, closed_at, closed_reason,
                salvage_proceeds_usdc, uplift_usdc,
                foxify_share_usdc, atticus_share_usdc, exit_mode,
                metadata, created_at, updated_at
           FROM two_sided_pair
           ${where}
           ORDER BY created_at DESC
           LIMIT $1`,
        params
      );
      const counts = await deps.pool.query(
        `SELECT status, COUNT(*)::int AS n
           FROM two_sided_pair
          WHERE is_shadow = TRUE
          GROUP BY status`
      );
      reply.send({
        asOf: new Date().toISOString(),
        total_shadow: counts.rows.reduce((s, r) => s + Number(r.n), 0),
        by_status: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
        pairs: result.rows
      });
    }
  );

  app.get("/admin/foxify/v2/diagnostics", { preHandler: checkAdminToken }, async (_req, reply) => {
    const halt = await getHaltState(deps.pool);
    const pool = await getPoolState(deps.pool).catch(() => null);
    const status = await computeFoxifyStatus(deps.pool, {
      haltStatus: {
        foxifyHalt: halt.foxifyHalt,
        atticusHalt: halt.atticusHalt,
        reason: halt.atticusHaltReason ?? halt.foxifyHaltReason
      }
    });
    const dvol = deps.dvolService.getCurrentDvol();
    const feedHealth = deps.feedService.getHealth();
    // Refresh & surface liquid chain cache venue status
    let liquidChainStatus: unknown = null;
    if (deps.liquidChainCache) {
      try {
        const snap = await deps.liquidChainCache.getChain();
        liquidChainStatus = snap ? {
          fetched_at: new Date(snap.fetchedAtMs).toISOString(),
          spot: snap.spot,
          total_quote_count: snap.quotes.length,
          venue_status: snap.venueStatus
        } : { ok: false, reason: "cache empty (no providers returned data)" };
      } catch (e) {
        liquidChainStatus = { ok: false, reason: (e as Error).message };
      }
    }
    reply.send({
      asOf: new Date().toISOString(),
      halt,
      status,
      dvol,
      feed: feedHealth,
      deferredPool: pool,
      unwindQueue: deps.unwindQueue?.stats() ?? null,
      liquidChainCache: liquidChainStatus,
      env: {
        live_enabled: process.env.SS_TWO_SIDED_LIVE_ENABLED === "true",
        boot_halt: process.env.SS_TWO_SIDED_BOOT_HALT !== "false",
        max_pairs_per_day: Number(process.env.SS_TWO_SIDED_MAX_PAIRS_PER_DAY ?? "2"),
        cell_allowlist: (process.env.SS_TWO_SIDED_CELL_ALLOWLIST ?? "pair_50k_2pct")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      }
    });
  });

  /**
   * GET /admin/foxify/v2/gate_with_ev
   *
   * Combined view: activation gate signal + per-cell EV estimate at current
   * live conditions. Lets operator validate "would the gate say activate?"
   * AND "what's the actual EV per cell right now?" in one call.
   *
   * EV estimation method: starts from V6 sweep reference (per-cell EV at
   * V6's measured cost), applies linear cost-delta adjustment to current
   * live cost. Not a fresh MC sim (too expensive per request), but a fast
   * sanity check based on real V6 data + real live cost.
   *
   * Auth: X-Admin-Token.
   */
  app.get<{ Querystring: { use_real_bids?: "true" | "false"; show_both?: "true" | "false" } }>("/admin/foxify/v2/gate_with_ev", { preHandler: checkAdminToken }, async (req, reply) => {
    const useRealBids = req.query.use_real_bids !== "false"; // default: show real-bid view
    const showBoth = req.query.show_both === "true";          // optional: side-by-side
    const { PHASE_0_CELLS } = await import("./cellConfig");
    const { resolveCurrentTier } = await import("./tierResolver");
    const { buildQuote } = await import("./quoteEngine");
    const { computeActivationGate } = await import("./activationGate");
    const { priceOption } = await import("./optionPricing");

    // Gate result (or degraded if no rvService)
    let gate: Awaited<ReturnType<typeof computeActivationGate>> | { reason: string; good_to_activate: false };
    if (deps.rvService) {
      gate = await computeActivationGate({
        dvolService: deps.dvolService,
        rvService: deps.rvService,
        liquidChainCache: deps.liquidChainCache ?? null
      });
    } else {
      gate = { reason: "rv_service_not_wired", good_to_activate: false };
    }
    const halt = await getHaltState(deps.pool);
    const haltActive = halt.foxifyHalt || halt.atticusHalt;

    const feed = deps.feedService.getCurrentFeed();
    if (!feed || feed.health === "unavailable" || feed.canonicalPrice == null) {
      reply.code(503).send({ error: "feed_unavailable", message: "Cannot price cells without canonical spot" });
      return;
    }
    const spot = feed.canonicalPrice;
    const tier = await resolveCurrentTier(deps.pool, Date.now());

    const regime = (deps.dvolService.getCurrentDvol()?.regime ?? "calm") as "calm" | "moderate" | "elevated" | "stress";
    const { computeLiveCellEv } = await import("./liveCellEvService");

    const results: Array<Record<string, unknown>> = [];
    for (const cellId of Object.keys(PHASE_0_CELLS)) {
      const cell = PHASE_0_CELLS[cellId];
      if (!cell.enabled) {
        results.push({ cellId, ok: false, reason: "cell_deprecated" });
        continue;
      }
      try {
        const quote = await buildQuote({
          cell, spot, anchorProvider: deps.anchorProvider, tier,
          liquidChainCache: deps.liquidChainCache ?? null
        });
        if (!quote.ok) {
          results.push({ cellId, ok: false, reason: quote.reason });
          continue;
        }
        const liveCost = quote.totalHedgeCostUsdc;

        // REALISM MULTIPLIER (Phase 1 — uses unified priceOption primitive)
        //
        // Compute the ratio of current real bid to current BS theoretical
        // for THIS cell's actual strikes. The MC sim values salvage via BS;
        // multiplying by this ratio simulates the bid-side discount we'd
        // actually receive. When use_real_bids=false (legacy), multiplier
        // is 1.0 (pure BS, overstates EV).
        //
        // Migrated to priceOption to ensure THIS calculation sees the SAME
        // bid as MTM and ShadowCloseExecutor would for the same instruments.
        let realismMultiplier = 1.0;
        let realismDetail: Record<string, number | string | null> = { mode: "bs_only_legacy" };
        if (useRealBids && deps.liquidChainCache) {
          const tenorMs = cell.hedgeTenorDays * 86_400_000;
          const putPricing = priceOption({
            spot,
            strike: quote.putStrike,
            optType: "put",
            tenorRemainingMs: tenorMs,
            contractsBtc: cell.contractsBtc,
            venue: quote.putLeg.venue,
            instrumentSymbol: quote.putLeg.symbol,
            liquidChainCache: deps.liquidChainCache,
            dvolService: deps.dvolService,
            purpose: "fair_value", // gets us mid+BS for ratio calc
            bidHaircut: 1.0
          });
          const callPricing = priceOption({
            spot,
            strike: quote.callStrike,
            optType: "call",
            tenorRemainingMs: tenorMs,
            contractsBtc: cell.contractsBtc,
            venue: quote.callLeg.venue,
            instrumentSymbol: quote.callLeg.symbol,
            liquidChainCache: deps.liquidChainCache,
            dvolService: deps.dvolService,
            purpose: "fair_value",
            bidHaircut: 1.0
          });
          const realPutBid = putPricing.bid_per_btc ?? 0;
          const realCallBid = callPricing.bid_per_btc ?? 0;
          const bsPutAtSpot = putPricing.bs_theoretical_per_btc;
          const bsCallAtSpot = callPricing.bs_theoretical_per_btc;
          const bsCombined = bsPutAtSpot + bsCallAtSpot;
          const realCombined = realPutBid + realCallBid;
          if (bsCombined > 0 && realCombined > 0) {
            realismMultiplier = Math.max(0, Math.min(1.5, realCombined / bsCombined));
            realismDetail = {
              mode: "real_bid_calibrated",
              real_put_bid_usdc_per_btc: realPutBid,
              real_call_bid_usdc_per_btc: realCallBid,
              real_combined_per_btc: realCombined,
              bs_put_at_spot_per_btc: bsPutAtSpot,
              bs_call_at_spot_per_btc: bsCallAtSpot,
              bs_combined_per_btc: bsCombined,
              multiplier: realismMultiplier,
              iv_used: putPricing.iv_used,
              iv_source: putPricing.iv_source,
              put_source: putPricing.source,
              call_source: callPricing.source,
              interpretation: realismMultiplier < 0.7
                ? "real_bids_well_below_bs_high_skew_or_thin_market"
                : realismMultiplier < 0.95
                  ? "moderate_haircut_normal_for_otm"
                  : "real_bids_match_bs_theoretical"
            };
          } else {
            realismDetail = {
              mode: "bs_only_no_bid_data",
              real_put_bid_usdc_per_btc: realPutBid,
              real_call_bid_usdc_per_btc: realCallBid,
              put_source: putPricing.source,
              call_source: callPricing.source,
              note: "no_real_bid_in_chain_cache_falling_back_to_bs"
            };
          }
        }

        // Live MC sim — no hardcoded reference. Runs 2k paths per (cell, regime,
        // cost-bucket), cached 5min. Reflects current cost + current strikes +
        // current spot. Always-fresh empirical EV.
        const evSim = await computeLiveCellEv({
          cellId, spot, hedgeCostAtCalm: liveCost,
          putStrike: quote.putStrike, callStrike: quote.callStrike,
          tenorDays: cell.hedgeTenorDays,
          triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
          regime, contractsBtc: cell.contractsBtc,
          salvageRealismMultiplier: realismMultiplier
        });

        // Optional: also compute BS-only EV side-by-side for comparison
        let evSimBsOnly: Awaited<ReturnType<typeof computeLiveCellEv>> | null = null;
        if (showBoth && useRealBids && realismMultiplier !== 1.0) {
          evSimBsOnly = await computeLiveCellEv({
            cellId, spot, hedgeCostAtCalm: liveCost,
            putStrike: quote.putStrike, callStrike: quote.callStrike,
            tenorDays: cell.hedgeTenorDays,
            triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
            regime, contractsBtc: cell.contractsBtc,
            salvageRealismMultiplier: 1.0
          });
        }

        // Foxify-facing EV as PERCENT of cost (the meaningful unit for a
        // cost-payer). $200 gain on $100 spend reads very differently from
        // $200 gain on $5,000 spend even though the absolute number is the same.
        const foxifyEvPct = liveCost > 0 ? (evSim.meanFoxifyEv / liveCost) : 0;
        const worstCasePct = liveCost > 0 ? (evSim.p5FoxifyEv / liveCost) : 0;
        // Verdict now driven by % return, not raw dollars, so it's
        // comparable across cells of very different sizes.
        const verdict =
          foxifyEvPct > 0.20 ? "✅ PROFITABLE" :
          foxifyEvPct > 0.05 ? "✅ MARGINAL_PROFITABLE" :
          foxifyEvPct > -0.05 ? "⚠️ BREAK_EVEN" :
          foxifyEvPct > -0.20 ? "⚠️ MARGINAL_NEGATIVE" :
          "❌ NEGATIVE";
        // Trigger-likelihood is a SEPARATE axis from EV verdict.
        // Same cell can be "GO + FREQUENT" (high EV, expect many fast closes)
        // OR "GO + TAIL" (high EV, expect to time-decay with rare jackpots).
        const { labelTriggerLikelihood } = await import("./cellOpportunities");
        const triggerLikelihood = labelTriggerLikelihood(evSim.triggerRate);
        // Optional side-by-side comparison
        const bsOnlyComparison = evSimBsOnly ? {
          mean_salvage_bs_only: evSimBsOnly.meanSalvage,
          foxify_ev_pct_bs_only: liveCost > 0 ? evSimBsOnly.meanFoxifyEv / liveCost : 0,
          foxify_ev_usdc_bs_only: evSimBsOnly.meanFoxifyEv,
          overstatement_pct: liveCost > 0
            ? ((evSimBsOnly.meanFoxifyEv - evSim.meanFoxifyEv) / liveCost)
            : 0
        } : null;

        results.push({
          cellId,
          ok: true,
          liveCost,
          putVenue: quote.putLeg.venue,
          callVenue: quote.callLeg.venue,
          actualStrikes: { put: quote.putStrike, call: quote.callStrike },
          mc: {
            hedge_cost_at_regime: evSim.hedgeCost,
            mean_salvage: evSim.meanSalvage,
            trigger_rate: evSim.triggerRate,
            // Foxify-facing EV expressed as %-of-cost (primary metric)
            foxify_ev_pct: foxifyEvPct,
            // Worst 5% outcome expressed as %-of-cost (bounded loss)
            worst_case_pct: worstCasePct,
            // Raw dollar EVs kept for context — Foxify only (Atticus EV
            // intentionally omitted from operator view per design decision:
            // operator/CEO cares only about Foxify-side economics)
            foxify_ev_usdc: evSim.meanFoxifyEv,
            worst_case_usdc: evSim.p5FoxifyEv,
            pct_profitable_paths: evSim.pctProfit,
            // Trigger likelihood label (separate axis from EV verdict)
            trigger_likelihood: triggerLikelihood,
            n_paths: evSim.nPaths,
            path_generator: evSim.pathGenerator,
            bars_source: evSim.barsSource,
            bars_count: evSim.barsCount,
            // NEW: realism calibration audit
            salvage_realism_multiplier: evSim.salvageRealismMultiplier,
            realism_detail: realismDetail,
            ...(bsOnlyComparison ? { bs_only_comparison: bsOnlyComparison } : {})
          },
          ev_verdict: verdict,
          trigger_likelihood: triggerLikelihood
        });
      } catch (e) {
        results.push({ cellId, ok: false, reason: "quote_or_sim_threw", message: (e as Error).message });
      }
    }

    reply.send({
      asOf: new Date().toISOString(),
      spot,
      regime,
      tier: tier.label,
      halt_active: haltActive,
      gate,
      cells: results,
      query_params: {
        use_real_bids: useRealBids,
        show_both: showBoth,
        use_real_bids_description: "When true (DEFAULT), MC salvage values are scaled by the ratio of (current real bid) / (current BS theoretical) for each cell's actual strikes. When false, legacy BS-only sim (overstates EV).",
        show_both_description: "When true, response includes mc.bs_only_comparison for each cell so you can see exactly how much the BS-only model was overstating."
      },
      methodology: {
        ev_estimation: useRealBids
          ? "Live MC sim per cell, salvage CALIBRATED to current real bids via salvage_realism_multiplier. The multiplier = (real_put_bid + real_call_bid) / (bs_put_at_spot + bs_call_at_spot) for the cell's actual strikes. Reflects what we'd actually receive on close, not what BS theoretical says. 2k paths each. Path generator: bootstrap (calm + bars) else GBM. Cached 5min per (cellId, regime, cost-bucket, realism-bucket)."
          : "Live MC sim per cell, BS-only salvage (LEGACY). Overstates EV when real bids trade below BS theoretical (common for OTM strikes due to vol skew and spread). Set ?use_real_bids=true to calibrate.",
        ev_units: "mc.foxify_ev_pct is the expected return AS A FRACTION OF COST (0.50 = +50% return on cost paid). mc.worst_case_pct is the 5th-percentile return (1-in-20 bad day). Verdict thresholds: PROFITABLE >+20%, MARGINAL_PROFITABLE +5-20%, BREAK_EVEN -5 to +5%, MARGINAL_NEGATIVE -5 to -20%, NEGATIVE <-20%.",
        trigger_likelihood: "Separate axis from EV verdict. FREQUENT >=60% trigger rate (most pairs close fast), OCCASIONAL 30-60% (mixed), RARE 10-30% (most time-decay; tail captures big), TAIL <10% (rare jackpots, mostly time-decay). A 'GO + TAIL' cell has high EV but most pairs will expire unfired — operational pattern differs from a 'GO + FREQUENT' cell with the same EV.",
        realism_calibration: "salvage_realism_multiplier < 1.0 means real bids trade below BS theoretical for this cell's strikes. multiplier=0.5 means halving every MC salvage; multiplier=1.0 means no haircut. Validated against live shadow probes 2026-05-30.",
        gate_logic: "good_to_activate=true when regime in {moderate, elevated, stress} OR (regime=calm AND vrp < calmVrpThreshold). Halt overrides.",
        note_on_atticus_ev: "Atticus-side EV intentionally omitted from this response. This view is for Foxify/operator visibility into the pass-through economics."
      }
    });
  });

  /**
   * GET /admin/foxify/v2/cell-costs
   *
   * Returns LIVE hedge cost projections for every cell in the registry, using
   * the same buildQuote path that activations use. Lets operator see at-a-glance
   * which cells are currently tradable and at what cost without spinning up
   * shadow activations.
   *
   * Query params (optional):
   *   ?cells=pair_50k_2pct,pair_25k_5pct_otm_3d    — restrict to listed cells
   */
  app.get<{ Querystring: { cells?: string } }>("/admin/foxify/v2/cell-costs", { preHandler: checkAdminToken }, async (req, reply) => {
    const { PHASE_0_CELLS } = await import("./cellConfig");
    const { resolveCurrentTier } = await import("./tierResolver");
    const { buildQuote } = await import("./quoteEngine");
    const feed = deps.feedService.getCurrentFeed();
    if (!feed || feed.health === "unavailable" || feed.canonicalPrice == null) {
      reply.code(503).send({ error: "feed_unavailable", message: "Spot feed not currently aggregating; cannot price cells" });
      return;
    }
    const spot = feed.canonicalPrice;
    const tier = await resolveCurrentTier(deps.pool, Date.now());
    const requested = req.query.cells?.split(",").map((s) => s.trim()).filter(Boolean) ?? Object.keys(PHASE_0_CELLS);
    const results: Array<Record<string, unknown>> = [];
    for (const cellId of requested) {
      const cell = PHASE_0_CELLS[cellId];
      if (!cell) {
        results.push({ cellId, error: "unknown_cell" });
        continue;
      }
      if (!cell.enabled) {
        results.push({ cellId, ok: false, reason: "cell_deprecated", message: "Cell exists in registry for backward compat but is disabled (always -EV per V5/V6)" });
        continue;
      }
      try {
        const quote = await buildQuote({
          cell,
          spot,
          anchorProvider: deps.anchorProvider,
          tier,
          liquidChainCache: deps.liquidChainCache ?? null
        });
        if (!quote.ok) {
          results.push({
            cellId,
            ok: false,
            reason: quote.reason,
            details: quote.details
          });
          continue;
        }
        results.push({
          cellId,
          ok: true,
          spot,
          targetStrikes: { put: quote.targetPutStrike, call: quote.targetCallStrike },
          actualStrikes: { put: quote.putStrike, call: quote.callStrike },
          strikeShifted: { put: quote.putStrikeShifted, call: quote.callStrikeShifted },
          putLeg: {
            venue: quote.putLeg.venue,
            symbol: quote.putLeg.symbol,
            askUsdcPerBtc: quote.putLeg.askUsdcPerBtc,
            legCostUsdc: quote.putLeg.legCostUsdc
          },
          callLeg: {
            venue: quote.callLeg.venue,
            symbol: quote.callLeg.symbol,
            askUsdcPerBtc: quote.callLeg.askUsdcPerBtc,
            legCostUsdc: quote.callLeg.legCostUsdc
          },
          totalHedgeCostUsdc: quote.totalHedgeCostUsdc,
          contractsBtc: quote.contractsBtc,
          triggerPctDown: cell.triggerPctDown,
          triggerPctUp: cell.triggerPctUp,
          hedgeTenorDays: cell.hedgeTenorDays,
          fromStabilityCache: Boolean(quote.fromStabilityCache)
        });
      } catch (e) {
        results.push({ cellId, ok: false, reason: "build_quote_threw", message: (e as Error).message });
      }
    }
    reply.send({
      asOf: new Date().toISOString(),
      spot,
      regime: deps.dvolService.getCurrentDvol()?.regime ?? null,
      utcHour: new Date().getUTCHours(),
      tier: tier.label,
      results
    });
  });
};
