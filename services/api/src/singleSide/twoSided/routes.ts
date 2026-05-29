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
        recommended_cells: [],
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
    reply.send({ ...result, trends, cell_opportunities: cellOpportunities });
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
  app.get("/admin/foxify/v2/gate_with_ev", { preHandler: checkAdminToken }, async (_req, reply) => {
    const { PHASE_0_CELLS } = await import("./cellConfig");
    const { resolveCurrentTier } = await import("./tierResolver");
    const { buildQuote } = await import("./quoteEngine");
    const { computeActivationGate } = await import("./activationGate");

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

        // Live MC sim — no hardcoded reference. Runs 2k paths per (cell, regime,
        // cost-bucket), cached 5min. Reflects current cost + current strikes +
        // current spot. Always-fresh empirical EV.
        const evSim = await computeLiveCellEv({
          cellId, spot, hedgeCostAtCalm: liveCost,
          putStrike: quote.putStrike, callStrike: quote.callStrike,
          tenorDays: cell.hedgeTenorDays,
          triggerPctDown: cell.triggerPctDown, triggerPctUp: cell.triggerPctUp,
          regime, contractsBtc: cell.contractsBtc
        });

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
            bars_count: evSim.barsCount
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
      methodology: {
        ev_estimation: "Live MC sim per cell. 2k paths each. Path generator: bootstrap (calm + bars available) else GBM. Cached 5min per (cellId, regime, cost-bucket). NO HARDCODED REFERENCE — always fresh. Per-cell mc.path_generator field shows which was used; mc.bars_source shows where bars came from (tmp_file, deribit_30d, etc).",
        ev_units: "mc.foxify_ev_pct is the expected return AS A FRACTION OF COST (0.50 = +50% return on cost paid). mc.worst_case_pct is the 5th-percentile return (1-in-20 bad day). Verdict thresholds: PROFITABLE >+20%, MARGINAL_PROFITABLE +5-20%, BREAK_EVEN -5 to +5%, MARGINAL_NEGATIVE -5 to -20%, NEGATIVE <-20%.",
        trigger_likelihood: "Separate axis from EV verdict. FREQUENT >=60% trigger rate (most pairs close fast), OCCASIONAL 30-60% (mixed), RARE 10-30% (most time-decay; tail captures big), TAIL <10% (rare jackpots, mostly time-decay). A 'GO + TAIL' cell has high EV but most pairs will expire unfired — operational pattern differs from a 'GO + FREQUENT' cell with the same EV.",
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
