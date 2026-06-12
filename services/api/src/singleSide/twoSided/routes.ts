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
import { timingSafeEqual, randomUUID } from "node:crypto";
import { handleActivate, isCalmLossLeaderEnabled, calmMaxLossUsdc, type ActivateDeps } from "./activateHandler";
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
import { clearNewbornReview, classifyRegime, getNewbornState, isLiveExecutionEnabled, type Regime } from "./featureFlag";
import { getEventsForPair, getPairById } from "./db";
import { FeedService } from "./feedService";
import { DvolService } from "./dvolService";
import type { LiveAnchorProvider } from "./quoteEngine";
import type { StrangleExecutor } from "./executor";
import { ShadowStrangleExecutor } from "./shadowExecutor";
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
  /**
   * Optional Bullish client for the authenticated whitelist/auth probe endpoint
   * (GET /admin/foxify/v2/bullish-auth-probe). Runs SERVER-SIDE so the call
   * originates from the deployment's whitelisted IP. Structural type to avoid
   * coupling routes to the pilot client; production passes the shared client.
   */
  bullishProbeClient?: {
    getTradingAccounts: () => Promise<unknown>;
    getMarkets?: (params?: { forceRefresh?: boolean; cacheTtlMs?: number }) => Promise<Array<Record<string, unknown>>>;
    getHybridOrderBook?: (symbol: string) => Promise<{ bids?: Array<{ price: string | number }>; asks?: Array<{ price: string | number }> }>;
  } | null;
  /**
   * Optional Phase C: per-venue balance reader for the pre-fire balance guard on
   * the LIVE activation path. Production wires it from the shared Bullish client
   * (getAssetBalances) + the credentialed Deribit connector (getAccountSummary).
   * Omitted in shadow-only deploys + tests → guard is a no-op.
   */
  venueBalanceReader?: import("./venueBalanceGuard").VenueBalanceReader;
  /**
   * Optional Phase C: per-venue position reader for the live↔venue reconciliation
   * probe (GET /admin/foxify/v2/venue-positions). Production wires it from the
   * credentialed Deribit connector (getPositions) + the Bullish client
   * (getAssetBalances). Omitted in shadow-only deploys + tests.
   */
  venuePositionReader?: import("./venueReconciliation").VenuePositionReader;
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

/**
 * READ-ONLY demo gate for the prospect-facing Protected-Leverage widget. Accepts EITHER the
 * full admin token (x-admin-token) OR a dedicated read-only demo token (x-demo-token, env
 * SS_DEMO_READONLY_TOKEN). The demo token is safe to share externally: it only unlocks the
 * read-only floor-quote / wick-insurance endpoints below — it CANNOT reach any other admin
 * route (each of those still requires checkAdminToken).
 */
const checkDemoOrAdminToken = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  const admin = process.env.PILOT_ADMIN_TOKEN ?? "";
  const demo = process.env.SS_DEMO_READONLY_TOKEN ?? "";
  const adminProvided = (req.headers["x-admin-token"] as string | undefined) ?? "";
  const demoProvided = (req.headers["x-demo-token"] as string | undefined) ?? "";
  if (admin && adminProvided && safeCompare(admin, adminProvided)) return true;
  if (demo && demoProvided && safeCompare(demo, demoProvided)) return true;
  await reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Admin-Token or X-Demo-Token" });
  return false;
};

// Short in-memory TTL cache for the read-only demo quote endpoints (each fires several live
// venue probes). Keeps the prospect widget snappy and shields venues from rapid slider spam.
const _demoQuoteCache = new Map<string, { at: number; data: unknown }>();
const DEMO_QUOTE_TTL_MS = 20_000;
const demoCacheGet = (key: string): unknown | null => {
  const e = _demoQuoteCache.get(key);
  if (e && Date.now() - e.at < DEMO_QUOTE_TTL_MS) return e.data;
  return null;
};
const demoCacheSet = (key: string, data: unknown): void => {
  _demoQuoteCache.set(key, { at: Date.now(), data });
  if (_demoQuoteCache.size > 200) { const k = _demoQuoteCache.keys().next().value; if (k) _demoQuoteCache.delete(k); }
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
    // Hard rail: is_shadow=true ALWAYS uses this paper executor, even when
    // `executor` is the LIVE one — a shadow request can never place real orders.
    shadowExecutor: new ShadowStrangleExecutor(),
    liquidChainCache: deps.liquidChainCache ?? null,
    getFeed: () => deps.feedService.getCurrentFeed(),
    feedVersion: "v1.0.0",
    getCurrentRegime: () => deps.dvolService.getCurrentDvol()?.regime ?? null,
    venueBalanceReader: deps.venueBalanceReader,
    preActivateGuard: async ({ pairHedgeCostUsdc, isShadow }) => {
      // Plumbs DVOL into guardrails.canActivate
      const { canActivate } = await import("./guardrails");
      const dvol = deps.dvolService.getCurrentDvol()?.dvol ?? null;
      const regime = deps.dvolService.getCurrentDvol()?.regime ?? null;
      return canActivate(deps.pool, {
        dvol,
        capitalAvailableUsdc: null, // capital pool check is operator-side for Phase 0
        pairHedgeCostUsdc,
        currentRegime: regime ?? undefined,
        newbornReviewThreshold: deps.newbornReviewThreshold ?? 3,
        isShadow
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
    const { recordGateSnapshot, computeVrpTrend, computeDvolTrend, computeConsecutiveGoodSeconds } = await import("./gateHistory");
    const { computeRegimeProximity } = await import("./regimeProximity");
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
      regime: result.regime,
      dvol: result.dvol
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

    // Regime proximity — heads-up as DVOL nears the next boundary (pre-position
    // before the binary good_to_activate flip). Trend from the DVOL ring (15min).
    const dvolTrend15 = computeDvolTrend(15, nowMs);
    const regimeProximity = computeRegimeProximity(result.dvol, { trendDelta: dvolTrend15.delta });

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
        trends,
        regime_proximity: regimeProximity
      });
      return;
    }
    const recSel = result.regime ? selectStructureForRegime(result.regime) : null;
    const recCells = (finalGoodToActivate && result.regime)
      ? await getEffectiveAllowlist(deps.pool, result.regime) : [];
    // Calm loss-leader: when enabled and the market is calm, surface it as an
    // explicit, budgeted opt-in so the bot can CHOOSE to buy volume at a capped
    // per-pair loss (good_to_activate stays false — calm is not a +EV GO).
    const calmLossLeader = (result.regime === "calm" && isCalmLossLeaderEnabled())
      ? {
          enabled: true,
          max_loss_usdc: calmMaxLossUsdc(),
          eligible_cells: await getEffectiveAllowlist(deps.pool, "calm"),
          note: "Optional volume loss-leader. Activates only for cells whose premium (max loss) <= max_loss_usdc. Loss shrinks as DVOL rises toward moderate; see /admin/foxify/v2/breakeven-ladder."
        }
      : { enabled: false };
    reply.send({ ...result, trends, regime_proximity: regimeProximity, cell_opportunities: cellOpportunities,
      recommended_cells: recCells,
      recommended_structure: recSel?.structure ?? null, structure_rationale: recSel?.rationale ?? null,
      calm_loss_leader: calmLossLeader });
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

  /**
   * GET /foxify/v2/cells — Foxify-safe catalog of available protection cells.
   *
   * Lists the ENABLED cells with their PROTECTION STRUCTURE (notional, trigger band,
   * tenor window, strike geometry) + the regimes where each is offered to the bot by
   * default. Deliberately Foxify-safe: NO economics/EV/calibration/pricing internals —
   * just "here are the protection structures and when they're used". Powers the
   * Foxify dashboard's "available cells" menu even when the bot isn't activating.
   */
  app.get("/foxify/v2/cells", { preHandler: checkFoxifyToken }, async (_req, reply) => {
    const { PHASE_0_CELLS, cellStatus } = await import("./cellConfig");
    const { isCellAllowedInRegimeDefault } = await import("./cellAllowlist");
    const regimes = ["calm", "moderate", "elevated", "stress"] as const;
    const structureOf = (putItm: number, callItm: number): string => {
      if (putItm === 0 && callItm === 0) return "atm_straddle";
      if (putItm < 0 || callItm < 0) return "otm_strangle";
      return "itm_guts_strangle";
    };
    const cells = Object.values(PHASE_0_CELLS)
      .filter((c) => c.enabled)
      .map((c) => ({
        cell_id: c.cellId,
        status: cellStatus(c.cellId),
        structure: structureOf(c.putStrikeItmPct, c.callStrikeItmPct),
        notional_usdc_per_leg: c.notionalUsdcPerLeg,
        trigger_pct_down: c.triggerPctDown,
        trigger_pct_up: c.triggerPctUp,
        hedge_tenor_days: c.hedgeTenorDays,
        put_strike_itm_pct: c.putStrikeItmPct,
        call_strike_itm_pct: c.callStrikeItmPct,
        // strike offsets relative to spot (put strike = spot×(1+putStrikeItmPct))
        offered_in_regimes: regimes.filter((r) => isCellAllowedInRegimeDefault(c.cellId, r))
      }));
    reply.send({ count: cells.length, cells });
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

  /**
   * GET /admin/foxify/v2/newborn-review — per-regime newborn-review state for the admin UI.
   * Shows triggers/approvals/threshold + auto-approve progress (validated settlements vs N),
   * so the operator can see what's gating and one-click CLEAR (POST .../clear) from the panel.
   */
  app.get("/admin/foxify/v2/newborn-review", { preHandler: checkAdminToken }, async (_req, reply) => {
    const threshold = deps.newbornReviewThreshold ?? 3;
    const { getNewbornState, newbornAutoApproveAfterN } = await import("./featureFlag");
    const { countValidatedSettlementsByRegime } = await import("./db");
    const { PRODUCTION_CELLS } = await import("./cellConfig");
    const autoN = newbornAutoApproveAfterN();
    const regimes = ["calm", "moderate", "elevated", "stress"] as const;
    const rows = await Promise.all(regimes.map(async (r) => {
      const st = await getNewbornState(deps.pool, r, threshold);
      // Match the gate: organic + production-cell settled pairs only.
      const validated = await countValidatedSettlementsByRegime(deps.pool, r, PRODUCTION_CELLS);
      return {
        regime: r,
        triggers_observed: st.triggersObserved,
        operator_approved_count: st.operatorApprovedCount,
        review_required: st.reviewRequired,
        threshold,
        pending_review: Math.max(0, st.triggersObserved - st.operatorApprovedCount),
        validated_settlements: validated,
        auto_approve_after_n: autoN > 0 ? autoN : null,
        auto_approve_eligible: autoN > 0 && validated >= autoN
      };
    }));
    reply.send({ threshold, auto_approve_after_n: autoN > 0 ? autoN : null, regimes: rows });
  });

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
   * POST /admin/foxify/v2/shadow-auto/seed-settlements
   *
   * Batch helper to BUILD the realized-vs-MC validation dataset without manual
   * looping: force-activates N shadow pairs (bypassing signal/allowlist, shadow-
   * only — zero real money) and force-triggers each (mode=fast) so they head to
   * settlement via the runtime. After they settle, GET /realized-vs-mc shows the
   * reconciliation. Intended for calm markets where the signal won't fire.
   *
   * Body: { cell_id?, count?=5 (1..25), side?="down"|"up" }
   */
  app.post<{ Body?: { cell_id?: string; count?: number; side?: "down" | "up" } }>(
    "/admin/foxify/v2/shadow-auto/seed-settlements",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      if (!deps.rvService) { reply.code(503).send({ error: "rv_service_unavailable" }); return; }
      if (!deps.forceTriggerPair) { reply.code(503).send({ error: "force_trigger_unavailable", message: "forceTriggerPair not wired" }); return; }
      const body = req.body ?? {};
      const count = Math.max(1, Math.min(25, Math.floor(Number(body.count ?? 5))));
      const cellId = typeof body.cell_id === "string" ? body.cell_id : undefined;
      const side: "down" | "up" = body.side === "up" ? "up" : "down";
      const { forceShadowActivation, readAutoActivatorConfig, ensureShadowAuditSchema } = await import("./shadowAutoActivator");
      await ensureShadowAuditSchema(deps.pool);
      const cfg = deps.shadowAutoActivatorConfig ?? readAutoActivatorConfig();
      const activated: string[] = [];
      const triggered: string[] = [];
      const failures: Array<Record<string, unknown>> = [];
      for (let i = 0; i < count; i++) {
        try {
          const act = await forceShadowActivation(
            { pool: deps.pool, dvolService: deps.dvolService, rvService: deps.rvService, feedService: deps.feedService, liquidChainCache: deps.liquidChainCache ?? null, anchorProvider: deps.anchorProvider, config: cfg },
            { cellId, ignoreHalt: true }
          );
          if (!act.pair_id) { failures.push({ i, step: "activate", decision: act.decision }); continue; }
          activated.push(act.pair_id);
          const trig = await deps.forceTriggerPair(act.pair_id, side, "fast");
          if (trig.ok) triggered.push(act.pair_id);
          else failures.push({ i, step: "trigger", pair_id: act.pair_id, error: trig.error });
        } catch (e) {
          failures.push({ i, step: "exception", error: (e as Error).message });
        }
      }
      reply.send({
        requested: count, activated: activated.length, triggered: triggered.length,
        pair_ids: activated, failures,
        note: "SHADOW ONLY (no real money). Pairs were force-triggered (mode=fast) and settle via the runtime shortly. Re-check GET /admin/foxify/v2/realized-vs-mc?regime=<current> once settled. Tagged with the regime at activation (calm now)."
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
      const sweepRunId = randomUUID();
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
        regimes: Array.isArray(body.regimes)
          ? (body.regimes as string[]).filter((r) => ["calm", "moderate", "elevated", "stress"].includes(r)) as Parameters<typeof runFullCellSweep>[1]["regimes"]
          : undefined,
        liquidChainCache: deps.liquidChainCache,
        dvolService: deps.dvolService,
        currentRegime
      };
      void runFullCellSweep(deps.pool, config, {
        progressLog: (msg) => console.log(`[cellSweep] ${msg}`),
        persistResults: true,
        runId: sweepRunId
      }).then((report) => {
        console.log(`[cellSweep] completed runId=${report.runId} results=${report.resultCount}`);
      }).catch((e) => {
        console.error(`[cellSweep] failed runId=${sweepRunId}: ${(e as Error).message}`);
      });
      reply.code(202).send({
        accepted_at: acceptedAt,
        run_id: sweepRunId,
        message: "Sweep launched in background. Poll /admin/foxify/v2/cell-sweep/runs (by run_id) or /admin/foxify/v2/cell-sweep/latest for results.",
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
  app.get<{ Querystring: { weighting?: string; half_life_days?: string; bypass_cache?: string } }>(
    "/admin/foxify/v2/regime-calibration", { preHandler: checkAdminToken }, async (req, reply) => {
    const { getCalibrationSummary, getRegimeCalibration } = await import("./regimeCalibration");
    // ?bypass_cache=true → recompute from DB (use right after a dvol-backfill;
    // the 5-min cache otherwise serves the pre-backfill calibration).
    const bypassCache = req.query.bypass_cache === "true";
    // ?weighting=ewma|median → return that calibration view (for A/B vs median);
    // no param → the standard summary (env-driven default).
    if (req.query.weighting === "ewma" || req.query.weighting === "median") {
      const cal = await getRegimeCalibration(deps.pool, {
        weighting: req.query.weighting,
        halfLifeDays: req.query.half_life_days ? Number(req.query.half_life_days) : undefined,
        bypassCache: true
      });
      reply.send({ weighting: req.query.weighting, half_life_days: req.query.half_life_days ? Number(req.query.half_life_days) : 14, calibration: cal });
      return;
    }
    const summary = await getCalibrationSummary(deps.pool, undefined, { bypassCache });
    reply.send(summary);
  });

  /**
   * GET /admin/foxify/v2/realized-vs-mc — production-readiness reconciliation.
   * Per cell: realized mean Foxify net from SETTLED shadow pairs vs the MC's
   * prediction at the requested regime; flags within ±15%. Real data only
   * (cost+realism from real chain, sigma from empirical calibration).
   * Query: ?regime= (default current), n_paths=, auto_close_abs=, auto_close_pct=
   */
  /**
   * POST /admin/foxify/v2/respawn-close
   *
   * OPERATOR RECOVERY: re-drive a pair stuck in "unwinding" (or "triggered") back through
   * the force-close runtime. Used when a force-close runtime died/aborted and left the pair
   * hung in unwinding with its legs unsold. Spawns a fresh force-close runtime → it sells
   * both legs on the next tick (REAL orders when live execution is on; Bullish legs
   * serialized). Body: { pair_id }. For "active" pairs use POST /foxify/v2/close instead.
   */
  app.post<{ Body: { pair_id?: string } }>(
    "/admin/foxify/v2/respawn-close",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const pairId = req.body?.pair_id;
      if (!pairId || typeof pairId !== "string") {
        reply.code(400).send({ error: "invalid_request", message: "pair_id required (string)" });
        return;
      }
      if (!deps.spawnRuntimeForceClose) {
        reply.code(503).send({ error: "spawn_unavailable", message: "spawnRuntimeForceClose not wired in server" });
        return;
      }
      const { getPairById } = await import("./db");
      const pair = await getPairById(deps.pool, pairId);
      if (!pair) { reply.code(404).send({ error: "pair_not_found" }); return; }
      if (pair.status !== "unwinding" && pair.status !== "triggered") {
        reply.code(409).send({
          error: "not_respawnable",
          message: `pair status=${pair.status}; respawn-close only re-drives 'unwinding'/'triggered'. For 'active' use POST /foxify/v2/close.`,
          details: { status: pair.status }
        });
        return;
      }
      await deps.spawnRuntimeForceClose(pairId);
      reply.send({
        ok: true,
        pair_id: pairId,
        from_status: pair.status,
        note: "Re-spawned the force-close runtime. It sells both legs on the next tick (REAL orders if live; Bullish legs serialized). Re-check pair status in ~30-60s; expect 'settled'. WARNING: only use this when the legs are STILL HELD. If the legs were already closed OUT OF BAND (manually on the venue), use POST /admin/foxify/v2/reconcile-settle instead — respawn-close would try to re-sell positions you no longer hold."
      });
    }
  );

  /**
   * POST /admin/foxify/v2/reconcile-settle
   *
   * OUT-OF-BAND CLOSE RECONCILIATION: settle a pair from REAL venue proceeds
   * WITHOUT placing any venue orders. Use when a pair's legs were closed directly
   * on the venue (Bullish/Deribit UI/API) so our system never recorded it and the
   * pair is stuck in active/triggered/unwinding. Walks the pair to 'settled' using
   * the SAME split math as the live runtime (computeSplit + pinned tier floor), so
   * P&L / ledgers stay consistent. Places NO orders — pure bookkeeping.
   *
   * Body: {
   *   pair_id: string,
   *   put_proceeds_usdc?: number, call_proceeds_usdc?: number,   // preferred (writes leg sell_*)
   *   salvage_proceeds_usdc?: number,                            // OR a single total
   *   net_pnl_usdc?: number,                                     // OR net P&L (MTM-settled venues e.g. Bullish)
   *   hedge_cost_override_usdc?: number,                         // correct recorded cost to the true venue fill
   *   closed_reason?: "foxify_close"|"expiry"|"trigger",         // default foxify_close
   *   exit_mode?: ExitMode,                                      // default foxify_close
   *   note?: string,
   *   deliver_webhook?: boolean,                                 // default false
   *   force?: boolean                                            // CORRECT an already-settled pair in place
   * }
   * force:true overwrites a 'settled' pair's salvage/shares with the true venue
   * numbers and reverses the prior counterparty-ledger split (no status change).
   * 'cancelled' is never correctable. Without force, terminal pairs are refused.
   */
  app.post<{ Body: {
    pair_id?: string;
    put_proceeds_usdc?: number;
    call_proceeds_usdc?: number;
    salvage_proceeds_usdc?: number;
    net_pnl_usdc?: number;
    hedge_cost_override_usdc?: number;
    closed_reason?: string;
    exit_mode?: string;
    note?: string;
    deliver_webhook?: boolean;
    force?: boolean;
  } }>(
    "/admin/foxify/v2/reconcile-settle",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const b = req.body ?? {};
      if (!b.pair_id || typeof b.pair_id !== "string") {
        reply.code(400).send({ error: "invalid_request", message: "pair_id required (string)" });
        return;
      }
      const { reconcileSettlePair } = await import("./reconcileSettle");
      const validReason = (b.closed_reason === "foxify_close" || b.closed_reason === "expiry" || b.closed_reason === "trigger")
        ? b.closed_reason : undefined;
      const result = await reconcileSettlePair(deps.pool, {
        pairId: b.pair_id,
        putProceedsUsdc: typeof b.put_proceeds_usdc === "number" ? b.put_proceeds_usdc : undefined,
        callProceedsUsdc: typeof b.call_proceeds_usdc === "number" ? b.call_proceeds_usdc : undefined,
        salvageProceedsUsdc: typeof b.salvage_proceeds_usdc === "number" ? b.salvage_proceeds_usdc : undefined,
        netPnlUsdc: typeof b.net_pnl_usdc === "number" ? b.net_pnl_usdc : undefined,
        hedgeCostOverrideUsdc: typeof b.hedge_cost_override_usdc === "number" ? b.hedge_cost_override_usdc : undefined,
        closedReason: validReason,
        exitMode: typeof b.exit_mode === "string" ? (b.exit_mode as never) : undefined,
        note: typeof b.note === "string" ? b.note : undefined,
        deliverWebhook: b.deliver_webhook === true,
        force: b.force === true
      });
      if (!result.ok) {
        const code = result.error === "pair_not_found" ? 404
          : result.error === "already_terminal" ? 409
          : 400;
        reply.code(code).send({ error: result.error, message: result.message, details: result.details ?? null });
        return;
      }
      reply.send({
        ok: true,
        pair_id: result.pair.pairId,
        status: result.pair.status,
        corrected: result.corrected,
        stepped_from: result.steppedFrom,
        per_leg_applied: result.perLegApplied,
        salvage_proceeds_usdc: result.salvageProceedsUsdc,
        hedge_cost_total_usdc: result.pair.hedgeCostTotalUsdc,
        uplift_usdc: result.split.upliftUsdc,
        foxify_share_usdc: result.split.foxifyShareUsdc,
        atticus_share_usdc: result.split.atticusShareUsdc,
        outcome: result.split.outcomeCategory,
        note: result.corrected
          ? "CORRECTED an already-settled pair to the true venue numbers; prior split reversed in the ledger (net = corrected). View it in GET /admin/foxify/v2/live-pnl."
          : "Reconciled from real venue proceeds; NO orders placed. Pair is now 'settled' and excluded from bootResurrect. View it in GET /admin/foxify/v2/live-pnl."
      });
    }
  );

  /**
   * GET /admin/foxify/v2/live-pnl
   *
   * Cumulative P&L over settled REAL (is_shadow=FALSE) pairs — the live-money
   * counterpart to loss-leader-scorecard (which is shadow-only). Shows total cost,
   * salvage, Foxify net, Atticus share, wins/losses, and a per-pair breakdown
   * (including pairs reconciled via reconcile-settle, flagged reconciled:true).
   *
   * Query: ?cells=a,b (filter by cell), ?since_iso= (created_at >=).
   */
  app.get<{ Querystring: { cells?: string; since_iso?: string } }>(
    "/admin/foxify/v2/live-pnl",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { computeLivePnl } = await import("./livePnl");
      const cells = req.query.cells ? req.query.cells.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const sinceIso = req.query.since_iso && req.query.since_iso.length > 0 ? req.query.since_iso : undefined;
      const out = await computeLivePnl(deps.pool, { cells, sinceIso });
      reply.send(out);
    }
  );

  /**
   * GET /admin/foxify/v2/stuck-pairs
   *
   * Read-only detector for pairs that may need reconciliation: any non-terminal
   * pair (active/triggered/unwinding) with age, past-expiry, runtime-presence, and
   * legs-sold flags. Flags `likely_out_of_band` when a pair is 'unwinding', older
   * than the threshold, and has NO live runtime — i.e. a close that stalled or was
   * done on-venue and never synced. Use this to FIND pairs for reconcile-settle.
   *
   * Query: ?stale_minutes= (default 15).
   */
  app.get<{ Querystring: { stale_minutes?: string } }>(
    "/admin/foxify/v2/stuck-pairs",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const staleMinutes = req.query.stale_minutes ? Number(req.query.stale_minutes) : 15;
      const { getRuntimeRegistry } = await import("./runtimeRegistry");
      const { detectStuckPairs } = await import("./stuckPairs");
      const reg = getRuntimeRegistry();
      const report = await detectStuckPairs(deps.pool, {
        staleMinutes,
        hasRuntime: (pairId) => reg.getRuntime(pairId) != null
      });
      reply.send(report);
    }
  );

  /**
   * GET /admin/foxify/v2/loss-leader-scorecard
   *
   * Cumulative realized-PnL scorecard for the calm loss-leader cells — the RIGHT
   * way to judge a long-convexity position (vs the within-15% gate, which flags
   * false on every real move). Splits WINS (convexity payoffs) from LOSSES (calm
   * bleed) so the "does the payoff outweigh the bleed?" economics are explicit.
   *
   * Query: ?regime= (optional filter by regime-at-activation), ?organic_only=true|false
   *        (default true — excludes force-triggered/test pairs), ?cells=a,b (default the
   *        wired loss-leader cells).
   */
  /**
   * GET /admin/foxify/v2/close-fill-calibration
   *
   * Estimate-vs-realized close-fill stats for tuning the close slippage haircut.
   * Every settled close logs the pre-haircut combined value, applied haircut, and
   * realized proceeds; this aggregates the LIVE closes (shadow closes value at the
   * same bid they "fill" at, so they're ~1.0 and excluded from tuning). Surfaces a
   * recommendation once ≥5 live closes accrue. Query: ?cells=a,b.
   */
  app.get<{ Querystring: { cells?: string } }>(
    "/admin/foxify/v2/close-fill-calibration",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { getCloseFillCalibration } = await import("./closeFillCalibration");
      const cells = req.query.cells ? req.query.cells.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const out = await getCloseFillCalibration(deps.pool, { cells });
      reply.send(out);
    }
  );

  app.get<{ Querystring: { regime?: string; organic_only?: string; cells?: string } }>(
    "/admin/foxify/v2/loss-leader-scorecard",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { computeLossLeaderScorecard } = await import("./lossLeaderScorecard");
      const regimeRaw = req.query.regime;
      const regime = (regimeRaw === "calm" || regimeRaw === "moderate" || regimeRaw === "elevated" || regimeRaw === "stress")
        ? regimeRaw : undefined;
      const organicOnly = req.query.organic_only !== "false";
      const cells = req.query.cells ? req.query.cells.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const scorecard = await computeLossLeaderScorecard(deps.pool, { regime, organicOnly, cells });
      reply.send(scorecard);
    }
  );

  app.get<{ Querystring: { regime?: string; n_paths?: string; auto_close_abs?: string; auto_close_pct?: string; weighting?: string; half_life_days?: string; organic_only?: string } }>(
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
          autoClosePnlPct: req.query.auto_close_pct ? Number(req.query.auto_close_pct) : undefined,
          weighting: req.query.weighting === "ewma" ? "ewma" : (req.query.weighting === "median" ? "median" : undefined),
          halfLifeDays: req.query.half_life_days ? Number(req.query.half_life_days) : undefined,
          // Organic-only by default (excludes force-triggered/test pairs that distort
          // the gate). Pass ?organic_only=false to include them (e.g. plumbing checks).
          organicOnly: req.query.organic_only !== "false"
        });
        reply.send(report);
      } catch (e) {
        reply.code(500).send({ error: "reconcile_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/foxify-economics — Foxify-SHAREABLE expected economics.
   * PRODUCTION cells only, for a regime (default current): real-chain cost, MC
   * expected net / %profitable / p5-p95, and the realized overlay (organic settled
   * shadow) + validated flag. Curated to be safe to share with the partner — NOT
   * the raw shadow position list. Query: ?regime=&n_paths=&min_validated_n=
   */
  app.get<{ Querystring: { regime?: string; n_paths?: string; min_validated_n?: string } }>(
    "/admin/foxify/v2/foxify-economics",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { computeFoxifyEconomics } = await import("./foxifyEconomics");
      const { classifyRegime } = await import("./featureFlag");
      const feed = deps.feedService.getCurrentFeed();
      const spot = feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const currentDvol = deps.dvolService.getCurrentDvol();
      const regime = (["calm", "moderate", "elevated", "stress"].includes(req.query.regime ?? "")
        ? req.query.regime
        : (currentDvol ? classifyRegime(currentDvol.dvol) : "calm")) as "calm" | "moderate" | "elevated" | "stress";
      try {
        const report = await computeFoxifyEconomics(deps.pool, {
          regime, spot, liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
          nPaths: req.query.n_paths ? Number(req.query.n_paths) : undefined,
          minValidatedN: req.query.min_validated_n ? Number(req.query.min_validated_n) : undefined
        });
        reply.send(report);
      } catch (e) {
        reply.code(500).send({ error: "economics_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/structure-comparison — side-by-side hedge structures.
   * For a cell + regime: two-sided straddle vs one-sided put/call vs collar — net cost,
   * 1-day theta drag, MC mean net / %profitable / p5-p95. Answers whether a directional
   * (one-sided/collar) hedge beats the full two-sided straddle for Foxify's bet.
   * Query: ?cell_id=&regime=&n_paths=
   */
  app.get<{ Querystring: { cell_id?: string; regime?: string; regimes?: string; n_paths?: string; auto_close_pct?: string; auto_close_abs?: string; win_rate?: string; frictionless?: string } }>(
    "/admin/foxify/v2/structure-comparison",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { compareStructures } = await import("./structureComparison");
      const { classifyRegime } = await import("./featureFlag");
      const { PHASE_0_CELLS } = await import("./cellConfig");
      const feed = deps.feedService.getCurrentFeed();
      const spot = feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const cellId = req.query.cell_id || "pair_10k_atm_2d";
      if (!PHASE_0_CELLS[cellId]) { reply.code(400).send({ error: "unknown_cell", message: `cell '${cellId}' not in config`, known: Object.keys(PHASE_0_CELLS) }); return; }
      const valid = ["calm", "moderate", "elevated", "stress"] as const;
      // regimes CSV (default moderate,elevated,stress) — see where structures flip +EV.
      const currentDvol = deps.dvolService.getCurrentDvol();
      const fallback = req.query.regime && (valid as readonly string[]).includes(req.query.regime)
        ? req.query.regime
        : (currentDvol ? classifyRegime(currentDvol.dvol) : "moderate");
      const regimes = (req.query.regimes
        ? req.query.regimes.split(",").map((s) => s.trim()).filter((r) => (valid as readonly string[]).includes(r))
        : ["moderate", "elevated", "stress"]) as Array<"calm" | "moderate" | "elevated" | "stress">;
      const regimeList = regimes.length ? regimes : [fallback as "calm" | "moderate" | "elevated" | "stress"];
      const autoClosePnlPct = req.query.auto_close_pct != null && Number.isFinite(Number(req.query.auto_close_pct)) ? Number(req.query.auto_close_pct) : undefined;
      const autoCloseAbsoluteUsdc = req.query.auto_close_abs != null && Number.isFinite(Number(req.query.auto_close_abs)) ? Number(req.query.auto_close_abs) : undefined;
      const directionalWinRate = req.query.win_rate != null && Number.isFinite(Number(req.query.win_rate)) ? Number(req.query.win_rate) : undefined;
      const frictionless = req.query.frictionless === "true";
      try {
        const reports = [];
        for (const regime of regimeList) {
          reports.push(await compareStructures(deps.pool, {
            cellId, regime, spot, liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
            nPaths: req.query.n_paths ? Number(req.query.n_paths) : undefined,
            autoClosePnlPct, autoCloseAbsoluteUsdc, directionalWinRate, frictionless
          }));
        }
        reply.send({ cell_id: cellId, spot, directional_win_rate: directionalWinRate ?? 0.5, frictionless, regimes: reports });
      } catch (e) {
        reply.code(500).send({ error: "comparison_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/okx-probe — READ-ONLY liquidity probe. Shows OKX vs Bullish vs
   * Deribit spread/depth at a cell's strikes (OKX via public REST, no keys). Purely
   * additive — does not touch routing/execution. Query: ?cell_id=
   */
  app.get<{ Querystring: { cell_id?: string } }>(
    "/admin/foxify/v2/okx-probe",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { okxProbe } = await import("./okxProbe");
      const { PHASE_0_CELLS, computeStrikes } = await import("./cellConfig");
      const { priceCandidateLeg } = await import("./cellSweep");
      const feed = deps.feedService.getCurrentFeed();
      const spot = feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const cellId = req.query.cell_id || "pair_10k_atm_2d";
      const cell = PHASE_0_CELLS[cellId];
      if (!cell) { reply.code(400).send({ error: "unknown_cell", known: Object.keys(PHASE_0_CELLS) }); return; }
      const { putStrike, callStrike } = computeStrikes(cell, spot);
      try {
        const okx = await okxProbe({ spot, putStrike, callStrike, tenorDays: cell.hedgeTenorDays });
        // Bullish + Deribit at the same strikes from the existing chain cache (read-only).
        const sprd = (ask: number | null, bid: number | null) =>
          ask != null && bid != null && ask + bid > 0 ? +(((ask - bid) / ((ask + bid) / 2))).toFixed(4) : null;
        const venueLeg = (strike: number, optType: "put" | "call", v: "bullish" | "deribit") => {
          if (!deps.liquidChainCache) return { ask: null, bid: null, spread_pct: null };
          const r = priceCandidateLeg(spot, strike, optType, cell.hedgeTenorDays, cell.contractsBtc, deps.liquidChainCache, deps.dvolService, v);
          return { ask: r.askPerBtc, bid: r.bidPerBtc, spread_pct: sprd(r.askPerBtc, r.bidPerBtc) };
        };
        const compare = (["put", "call"] as const).map((optType) => {
          const strike = optType === "put" ? putStrike : callStrike;
          const okxLeg = okx.legs.find((l) => l.opt_type === optType);
          return {
            leg: optType, strike,
            okx: okxLeg ? { ask: okxLeg.ask_usdc_per_btc, bid: okxLeg.bid_usdc_per_btc, spread_pct: okxLeg.spread_pct, bid_size: okxLeg.bid_size, ask_size: okxLeg.ask_size, instId: okxLeg.instId } : null,
            bullish: venueLeg(strike, optType, "bullish"),
            deribit: venueLeg(strike, optType, "deribit")
          };
        });
        reply.send({ as_of: new Date().toISOString(), cell_id: cellId, spot, okx_status: okx.ok ? "ok" : okx.error, okx_expiry: okx.expiry_iso ?? null, comparison: compare,
          note: "READ-ONLY measurement. OKX = public market data (no trading). Spreads are unitless (compare directly). OKX sizes are contracts (~0.01 BTC each — confirm multiplier). OKX is NOT a routing/execution venue yet." });
      } catch (e) {
        reply.code(500).send({ error: "okx_probe_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/floor-quote — READ-ONLY leverage-additive / perp-floor-protection
   * calculator (the engine behind the prospect widget). Prices a protective PUT at the floor
   * across Bullish + Deribit + OKX (best ask) and returns max-loss with/without the floor,
   * the floor cost, payoff curve, and the leverage-additive headline. No orders/execution.
   * Query: ?size=(BTC)&leverage=&floor_pct=&tenor_days=&spot=(override)
   */
  app.get<{ Querystring: { size?: string; leverage?: string; floor_pct?: string; tenor_days?: string; spot?: string } }>(
    "/admin/foxify/v2/floor-quote",
    { preHandler: checkDemoOrAdminToken },
    async (req, reply) => {
      const { computeFloorEconomics, bestPutVenue } = await import("./floorQuote");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const feed = deps.feedService.getCurrentFeed();
      const spot = req.query.spot != null && Number(req.query.spot) > 0 ? Number(req.query.spot) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const sizeBtc = Number(req.query.size ?? "1");
      const leverage = Number(req.query.leverage ?? "10");
      const floorPct = Number(req.query.floor_pct ?? "0.10");
      const tenorDays = Number(req.query.tenor_days ?? "7");
      if (!(sizeBtc > 0) || !(leverage > 0) || !(floorPct > 0 && floorPct < 1) || !(tenorDays > 0)) {
        reply.code(400).send({ error: "invalid_request", message: "size>0, leverage>0, 0<floor_pct<1, tenor_days>0" });
        return;
      }
      const floorStrike = spot * (1 - floorPct);
      // Price the protective put at the floor across all three venues — DIRECTLY at the
      // target strike+tenor (not the vol-facility chain cache, which only holds ~2d ATM).
      const okxPut = await okxProbe({ spot, putStrike: floorStrike, callStrike: floorStrike, tenorDays })
        .then((o) => o.legs.find((l) => l.opt_type === "put"))
        .catch(() => null);
      const [deribit, bullish] = await Promise.all([
        deribitPutProbe({ spot, strike: floorStrike, tenorDays }),
        bullishPutProbe(deps.bullishProbeClient, { spot, strike: floorStrike, tenorDays })
      ]);
      const quotes: Array<{ venue: string; ask_usdc_per_btc: number | null; instrument?: string | null }> = [
        { venue: "okx", ask_usdc_per_btc: okxPut?.ask_usdc_per_btc ?? null, instrument: okxPut?.instId ?? null },
        { venue: "deribit", ask_usdc_per_btc: deribit.ask_usdc_per_btc, instrument: deribit.instrument },
        { venue: "bullish", ask_usdc_per_btc: bullish.ask_usdc_per_btc, instrument: bullish.instrument }
      ];

      const best = bestPutVenue(quotes);
      if (!best || best.ask_usdc_per_btc == null) {
        reply.code(503).send({ error: "no_put_quote", message: `No live protective-put quote at ~${Math.round(floorStrike)} across venues`, venue_quotes: quotes });
        return;
      }
      const econ = computeFloorEconomics({ spot, sizeBtc, leverage, floorPct, tenorDays }, best.ask_usdc_per_btc);
      reply.send({
        as_of: new Date().toISOString(),
        inputs: { spot, size_btc: sizeBtc, leverage, floor_pct: floorPct, tenor_days: tenorDays },
        floor_venue: best.venue, floor_put_instrument: best.instrument ?? null, floor_put_ask_usdc_per_btc: best.ask_usdc_per_btc,
        venue_quotes: quotes,
        ...econ,
        note: "READ-ONLY illustrative quote. Floor = protective put priced live (best of Bullish/Deribit/OKX). Simplified liquidation (ignores maintenance margin/funding/fees/slippage). leverage_additive = extra leverage an unprotected position would carry the same max loss as the floored one."
      });
    }
  );

  /**
   * GET /admin/foxify/v2/floor-quote/tiers — READ-ONLY "Protected Leverage" tier bundle (the
   * engine behind the prospect widget for Sai). For ONE loaded leveraged position it returns
   * the position card + a small menu of protective-PUT floor tiers framed as "risk X% of your
   * margin", each priced as the cheapest LONG PUT across Bullish + Deribit + OKX. One call,
   * no client-side fan-out. No orders/execution.
   * Query: ?collateral=(USDC margin)|size=(BTC)&leverage=&tenor_days=&spot=(override)&tiers=0.25,0.5,0.75
   *   collateral (USDC the trader posts) is the preferred input → notional = collateral×leverage,
   *   sizeBtc = notional/spot. `size` (BTC) still works as a fallback.
   */
  app.get<{ Querystring: { size?: string; collateral?: string; leverage?: string; tenor_days?: string; spot?: string; tiers?: string; side?: string } }>(
    "/admin/foxify/v2/floor-quote/tiers",
    { preHandler: checkDemoOrAdminToken },
    async (req, reply) => {
      const { buildFloorTierBundle, strikeForMarginFraction, DEFAULT_TIER_FRACTIONS } = await import("./floorTiers");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const feed = deps.feedService.getCurrentFeed();
      const spot = req.query.spot != null && Number(req.query.spot) > 0 ? Number(req.query.spot) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const leverage = Number(req.query.leverage ?? "10");
      const tenorDays = Number(req.query.tenor_days ?? "3");
      const side: "long" | "short" = req.query.side === "short" ? "short" : "long";
      const optType: "put" | "call" = side === "short" ? "call" : "put"; // shorts protect upside with calls
      // Collateral (USDC margin posted) is the preferred input; derive BTC size from it.
      const collateral = req.query.collateral != null ? Number(req.query.collateral) : null;
      const sizeBtc = collateral != null && collateral > 0 && leverage > 0
        ? (collateral * leverage) / spot
        : Number(req.query.size ?? "1");
      if (!(sizeBtc > 0) || !(leverage > 0) || leverage > 40 || !(tenorDays > 0)) {
        reply.code(400).send({ error: "invalid_request", message: "collateral>0 (or size>0), 0<leverage<=40, tenor_days>0" });
        return;
      }
      const fractions = (req.query.tiers
        ? req.query.tiers.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0 && n < 4)
        : [...DEFAULT_TIER_FRACTIONS]);
      if (fractions.length === 0) { reply.code(400).send({ error: "invalid_request", message: "tiers must be comma-separated fractions in (0,4)" }); return; }

      const cacheKey = `tiers:${side}:${sizeBtc.toFixed(6)}:${leverage}:${tenorDays}:${Math.round(spot / 10) * 10}:${fractions.join(",")}`;
      const cached = demoCacheGet(cacheKey);
      if (cached) { reply.send(cached); return; }

      // Price the cheapest protective option at each tier's strike across all three venues, in
      // parallel — PUTs (below spot) for longs, CALLs (above spot) for shorts.
      const priceStrike = async (strike: number): Promise<{ venue: string; ask_usdc_per_btc: number | null; instrument?: string | null; strike?: number | null } | null> => {
        const okxLeg = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays })
          .then((o) => o.legs.find((l) => l.opt_type === optType))
          .catch(() => null);
        const [deribit, bullish] = await Promise.all([
          deribitPutProbe({ spot, strike, tenorDays, optType }),
          bullishPutProbe(deps.bullishProbeClient, { spot, strike, tenorDays, optType })
        ]);
        // Carry the ACTUAL listed strike each venue priced (they snap to their grid) so the tier
        // economics describe one real instrument, not the theoretical target strike.
        const quotes = [
          { venue: "okx", ask_usdc_per_btc: okxLeg?.ask_usdc_per_btc ?? null, instrument: okxLeg?.instId ?? null, strike: okxLeg?.strike ?? null },
          { venue: "deribit", ask_usdc_per_btc: deribit.ask_usdc_per_btc, instrument: deribit.instrument, strike: deribit.strike ?? null },
          { venue: "bullish", ask_usdc_per_btc: bullish.ask_usdc_per_btc, instrument: bullish.instrument, strike: bullish.strike ?? null }
        ].filter((q) => q.ask_usdc_per_btc != null && q.ask_usdc_per_btc > 0);
        if (quotes.length === 0) return null;
        return quotes.reduce((b, q) => (q.ask_usdc_per_btc! < b.ask_usdc_per_btc! ? q : b));
      };

      const priced = await Promise.all(
        fractions.map(async (f) => {
          const { strike } = strikeForMarginFraction(spot, leverage, f, side);
          return [f, await priceStrike(strike)] as const;
        })
      );
      const quotesByFraction = new Map(priced);

      const bundle = buildFloorTierBundle({ spot, sizeBtc, leverage, tenorDays, side, fractions }, quotesByFraction);
      const payload = {
        as_of: new Date().toISOString(),
        ...bundle,
        note: `READ-ONLY illustrative quote (Phase 1, cross-venue). ${side === "short" ? "SHORT: protective CALL ceiling above spot (liq on a pump)." : "LONG: protective PUT floor below spot (liq on a drop)."} Each tier = cheapest live ${optType.toUpperCase()} across Bullish/Deribit/OKX. 'Risk X% of margin' caps your loss; worst case = that + premium. Simplified liquidation. The perp still liquidates on the exchange; the option bounds NET loss — true no-liquidation needs exchange margin integration.`
      };
      demoCacheSet(cacheKey, payload);
      reply.send(payload);
    }
  );

  /**
   * GET /admin/foxify/v2/wick-insurance — RESEARCH: what protection actually works at HIGH
   * leverage (30–40×). Prices the "don't get wicked out" structures around the liquidation
   * zone across Bullish + Deribit + OKX, as a % of margin (the decision number):
   *   - single_put : long put at K1 (spot×(1−k1_pct))
   *   - put_spread : long K1 / short deeper K2 (spot×(1−k2_pct))
   * Bullish requires server-side creds + whitelisted IP (i.e. run on Render).
   * Query: ?collateral=&leverage=&tenor_days=&k1_pct=0.015&k2_pct=0.05&spot=(override)
   */
  app.get<{ Querystring: { collateral?: string; leverage?: string; tenor_days?: string; k1_pct?: string; k2_pct?: string; spot?: string; side?: string } }>(
    "/admin/foxify/v2/wick-insurance",
    { preHandler: checkDemoOrAdminToken },
    async (req, reply) => {
      const { computeWickInsurance } = await import("./wickInsurance");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const feed = deps.feedService.getCurrentFeed();
      const spot = req.query.spot != null && Number(req.query.spot) > 0 ? Number(req.query.spot) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const collateral = Number(req.query.collateral ?? "1000");
      const leverage = Number(req.query.leverage ?? "40");
      const tenorDays = Number(req.query.tenor_days ?? "1");
      const k1Pct = Number(req.query.k1_pct ?? "0.015");
      const k2Pct = Number(req.query.k2_pct ?? "0.05");
      const side: "long" | "short" = req.query.side === "short" ? "short" : "long";
      const optType: "put" | "call" = side === "short" ? "call" : "put";
      if (!(collateral > 0) || !(leverage > 0) || !(tenorDays > 0) || !(k1Pct > 0 && k1Pct < 1) || !(k2Pct > k1Pct && k2Pct < 1)) {
        reply.code(400).send({ error: "invalid_request", message: "collateral>0, leverage>0, tenor_days>0, 0<k1_pct<k2_pct<1" });
        return;
      }
      // long: protective puts BELOW spot; short: protective calls ABOVE spot. K2 is deeper OTM.
      const k1 = side === "short" ? spot * (1 + k1Pct) : spot * (1 - k1Pct);
      const k2 = side === "short" ? spot * (1 + k2Pct) : spot * (1 - k2Pct);

      const wkCacheKey = `wick:${side}:${collateral}:${leverage}:${tenorDays}:${k1Pct}:${k2Pct}:${Math.round(spot / 10) * 10}`;
      const wkCached = demoCacheGet(wkCacheKey);
      if (wkCached) { reply.send(wkCached); return; }

      // Long leg (K1) ask + short leg (K2) bid, per venue, in parallel.
      const [okxK1, okxK2, derK1, derK2, bullK1, bullK2] = await Promise.all([
        okxProbe({ spot, putStrike: k1, callStrike: k1, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null),
        okxProbe({ spot, putStrike: k2, callStrike: k2, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null),
        deribitPutProbe({ spot, strike: k1, tenorDays, optType }),
        deribitPutProbe({ spot, strike: k2, tenorDays, optType }),
        bullishPutProbe(deps.bullishProbeClient, { spot, strike: k1, tenorDays, optType }),
        bullishPutProbe(deps.bullishProbeClient, { spot, strike: k2, tenorDays, optType })
      ]);

      const quotes = [
        { venue: "okx", k1AskUsdcPerBtc: okxK1?.ask_usdc_per_btc ?? null, k1Strike: okxK1?.strike ?? null, k2BidUsdcPerBtc: okxK2?.bid_usdc_per_btc ?? null, k2Strike: okxK2?.strike ?? null },
        { venue: "deribit", k1AskUsdcPerBtc: derK1.ask_usdc_per_btc, k1Strike: derK1.strike ?? null, k2BidUsdcPerBtc: derK2.bid_usdc_per_btc ?? null, k2Strike: derK2.strike ?? null },
        { venue: "bullish", k1AskUsdcPerBtc: bullK1.ask_usdc_per_btc, k1Strike: bullK1.strike ?? null, k2BidUsdcPerBtc: bullK2.bid_usdc_per_btc ?? null, k2Strike: bullK2.strike ?? null }
      ];

      const result = computeWickInsurance({ spot, collateralUsdc: collateral, leverage, tenorDays, side }, quotes);
      const wkPayload = {
        as_of: new Date().toISOString(),
        inputs: { spot, collateral, leverage, tenor_days: tenorDays, side, k1_pct: k1Pct, k2_pct: k2Pct, k1_target: +k1.toFixed(2), k2_target: +k2.toFixed(2) },
        ...result,
        note: "READ-ONLY research. 'Wick insurance' at high leverage: value is staying in the trade through a spike (no forced liquidation) + keeping upside, NOT reducing max loss. single_put = long put@K1; put_spread = long K1 / short K2 (cheaper, but exposed again below K2). pct_margin is premium ÷ posted margin. Bullish only prices when run server-side (creds + whitelisted IP)."
      };
      demoCacheSet(wkCacheKey, wkPayload);
      reply.send(wkPayload);
    }
  );

  /**
   * GET /admin/foxify/v2/pooled-tail-hedge — PLATFORM-economics research (Phase 2 backstop).
   * Models hedging the deep-crash tail at the BOOK level on the NET (long−short) exposure vs
   * every position self-insuring its gross tail. Prices the band-edge put live (cheapest of
   * OKX/Deribit/Bullish). Admin-only (internal economics, not trader-facing).
   * Query: ?long_notional=&short_notional=&band_pct=0.04&tenor_days=7&stress_haircut=0.25&premiums=&spot=(override)
   */
  app.get<{ Querystring: { long_notional?: string; short_notional?: string; band_pct?: string; tenor_days?: string; stress_haircut?: string; premiums?: string; spot?: string } }>(
    "/admin/foxify/v2/pooled-tail-hedge",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { computePooledTailHedge } = await import("./pooledTailHedge");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const feed = deps.feedService.getCurrentFeed();
      const spot = req.query.spot != null && Number(req.query.spot) > 0 ? Number(req.query.spot) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const longNotionalUsdc = Number(req.query.long_notional ?? "5000000");
      const shortNotionalUsdc = Number(req.query.short_notional ?? "4000000");
      const bandPct = Number(req.query.band_pct ?? "0.04");
      const tenorDays = Number(req.query.tenor_days ?? "7");
      const stressHaircut = req.query.stress_haircut != null ? Number(req.query.stress_haircut) : 0.25;
      const premiums = req.query.premiums != null ? Number(req.query.premiums) : undefined;
      if (!(longNotionalUsdc >= 0) || !(shortNotionalUsdc >= 0) || !(bandPct > 0 && bandPct < 1) || !(tenorDays > 0) || !(stressHaircut >= 0 && stressHaircut <= 1)) {
        reply.code(400).send({ error: "invalid_request", message: "long_notional>=0, short_notional>=0, 0<band_pct<1, tenor_days>0, 0<=stress_haircut<=1" });
        return;
      }
      // Net-short books hedge the PUMP tail with CALLS (strike above spot); net-long/flat hedge
      // the CRASH tail with PUTS (strike below spot).
      const hedgeSide: "put" | "call" = (longNotionalUsdc - shortNotionalUsdc) < 0 ? "call" : "put";
      const strike = hedgeSide === "call" ? spot * (1 + bandPct) : spot * (1 - bandPct);
      const okxLeg = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === hedgeSide)).catch(() => null);
      const [deribit, bullish] = await Promise.all([
        deribitPutProbe({ spot, strike, tenorDays, optType: hedgeSide }),
        bullishPutProbe(deps.bullishProbeClient, { spot, strike, tenorDays, optType: hedgeSide })
      ]);
      const asks = [
        { venue: "okx", ask: okxLeg?.ask_usdc_per_btc ?? null },
        { venue: "deribit", ask: deribit.ask_usdc_per_btc },
        { venue: "bullish", ask: bullish.ask_usdc_per_btc }
      ].filter((q) => q.ask != null && q.ask > 0) as { venue: string; ask: number }[];
      if (asks.length === 0) { reply.code(503).send({ error: "no_quote", message: `no ${hedgeSide} quote near ${Math.round(strike)}` }); return; }
      const best = asks.reduce((b, q) => (q.ask < b.ask ? q : b));

      const result = computePooledTailHedge({ spot, longNotionalUsdc, shortNotionalUsdc, bandPct, tenorDays, stressHaircut, premiumsCollectedUsdc: premiums }, best.ask);
      reply.send({
        as_of: new Date().toISOString(),
        inputs: { spot, long_notional_usdc: longNotionalUsdc, short_notional_usdc: shortNotionalUsdc, band_pct: bandPct, tenor_days: tenorDays, stress_haircut: stressHaircut },
        hedge_instrument: { side: hedgeSide, strike: +strike.toFixed(2), venue: best.venue, ask_usdc_per_btc: best.ask },
        ...result,
        note: "READ-ONLY platform economics. Pooled hedge prices the band-edge option on the NET (long−short) book — a crash hurts longs but helps shorts, so net << gross. Net-long/flat hedged with PUTS (crash), net-short with CALLS (pump). stress_haircut hedges a fraction of (gross−net) for gap safety. Ignores basis/roll/funding."
      });
    }
  );

  // ── Public-safe demo (UNGATED) ──────────────────────────────────────────────
  // Background refresher keeps a sanitized preset matrix warm (OKX+Deribit only, never the
  // Bullish client). Public requests read ONLY this cache → no live venue calls per request.
  if (process.env.SS_PUBLIC_DEMO_ENABLED !== "false") {
    const tick = async () => {
      try {
        const { refreshPublicSnapshots } = await import("./publicSnapshot");
        await refreshPublicSnapshots(() => deps.feedService.getCurrentFeed()?.canonicalPrice);
      } catch { /* best-effort */ }
    };
    setTimeout(() => { void tick(); }, 5_000);
    const iv = setInterval(() => { void tick(); }, 120_000);
    if (typeof iv.unref === "function") iv.unref();
  }

  /**
   * GET /public/protect — UNGATED, sanitized, cache-served Protected-Leverage demo data.
   * No token. No live venue calls (reads the background snapshot). Percentages only — no venue
   * names, no instruments, no absolute strikes/market levels. Leverage snaps to a preset.
   * Query: ?side=long|short&leverage=&tenor_days=
   */
  app.get<{ Querystring: { side?: string; leverage?: string; tenor_days?: string } }>(
    "/public/protect",
    async (req, reply) => {
      const { getPublicSnapshot, PUBLIC_PRESET_TENOR, PUBLIC_PRESET_LEVERAGE, nearestPresetLeverage } = await import("./publicSnapshot");
      const side: "long" | "short" = req.query.side === "short" ? "short" : "long";
      const levRaw = Number(req.query.leverage ?? "10");
      const tenRaw = Number(req.query.tenor_days ?? "1");
      const leverage = nearestPresetLeverage(Number.isFinite(levRaw) && levRaw > 0 ? levRaw : 10);
      const tenor = PUBLIC_PRESET_TENOR.reduce((b, t) => (Math.abs(t - tenRaw) < Math.abs(b - tenRaw) ? t : b), PUBLIC_PRESET_TENOR[0]);
      const snap = getPublicSnapshot(side, leverage, tenor);
      if (!snap) { reply.code(503).send({ error: "warming_up", message: "Demo data is warming up — retry in a moment." }); return; }
      reply.send({
        ...snap,
        presets: { leverage: [...PUBLIC_PRESET_LEVERAGE], tenor_days: [...PUBLIC_PRESET_TENOR] },
        note: "Indicative, ~2-minute delayed. Illustrative simulation only — not an offer, not financial advice, not a live product."
      });
    }
  );

  /**
   * POST /admin/foxify/v2/perp-protect/quote — PERP PROTECT (separate product from Protected
   * Leverage). Prices protection for a trader's REAL open perp position (entry/size/side/leverage)
   * — the Bybit-Perp-Protect equivalent. Underwriter model; settlement_style pluggable (european
   * now). Returns single (capped) + optional spread (cheaper, banded) options, priced cheapest
   * across OKX/Deribit/Bullish. Phase 1 = QUOTE only (no execution yet).
   * Body: { side, size_btc, entry_price, leverage, tenor_days, mark_price?, settlement_style? }
   */
  app.post<{ Body: { side?: string; size_btc?: number; entry_price?: number; leverage?: number; tenor_days?: number; mark_price?: number; settlement_style?: string } }>(
    "/admin/foxify/v2/perp-protect/quote",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { buildPerpProtectQuote, liquidationOf } = await import("./perpProtectQuote");
      const { strikeForMarginFraction } = await import("./floorTiers");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const b = (req.body ?? {}) as { side?: string; size_btc?: number; entry_price?: number; leverage?: number; tenor_days?: number; mark_price?: number; settlement_style?: string };
      const feed = deps.feedService.getCurrentFeed();
      const spot = b.mark_price != null && Number(b.mark_price) > 0 ? Number(b.mark_price) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const side: "long" | "short" = b.side === "short" ? "short" : "long";
      const sizeBtc = Number(b.size_btc ?? 0);
      const entryPrice = Number(b.entry_price ?? spot);
      const leverage = Number(b.leverage ?? 0);
      const tenorDays = Number(b.tenor_days ?? 7);
      const settlementStyle = (["european", "american", "auto_close"].includes(b.settlement_style ?? "") ? b.settlement_style : "european") as "european" | "american" | "auto_close";
      if (!(sizeBtc > 0) || !(entryPrice > 0) || !(leverage > 0) || leverage > 100 || !(tenorDays > 0)) {
        reply.code(400).send({ error: "invalid_request", message: "size_btc>0, entry_price>0, 0<leverage<=100, tenor_days>0" });
        return;
      }
      const optType: "put" | "call" = side === "short" ? "call" : "put";

      // Probe a strike across venues → cheapest ask (long) + highest bid (short), with actual strikes.
      const probeStrike = async (strike: number) => {
        const okx = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null);
        const [der, bull] = await Promise.all([
          deribitPutProbe({ spot, strike, tenorDays, optType }),
          bullishPutProbe(deps.bullishProbeClient, { spot, strike, tenorDays, optType })
        ]);
        const rows = [
          { ask: okx?.ask_usdc_per_btc ?? null, bid: okx?.bid_usdc_per_btc ?? null, strike: okx?.strike ?? null },
          { ask: der.ask_usdc_per_btc, bid: der.bid_usdc_per_btc ?? null, strike: der.strike ?? null },
          { ask: bull.ask_usdc_per_btc, bid: bull.bid_usdc_per_btc ?? null, strike: bull.strike ?? null }
        ];
        const asks = rows.filter((r) => r.ask != null && r.ask > 0 && r.strike != null) as { ask: number; bid: number | null; strike: number }[];
        const bids = rows.filter((r) => r.bid != null && r.bid > 0 && r.strike != null) as { ask: number | null; bid: number; strike: number }[];
        const bestAsk = asks.length ? asks.reduce((a, r) => (r.ask < a.ask ? r : a)) : null;
        const bestBid = bids.length ? bids.reduce((a, r) => (r.bid > a.bid ? r : a)) : null;
        return { bestAsk, bestBid };
      };

      // Single-option tiers: Safer / Balanced / Cheapest at fraction/leverage from spot.
      const singleFracs = [0.25, 0.5, 0.75];
      const singleStrikes = singleFracs.map((f) => strikeForMarginFraction(spot, leverage, f, side).strike);
      // Spread legs: long just inside the liq distance, short deeper.
      const liqMove = 1 / leverage;
      const k1 = side === "short" ? spot * (1 + Math.max(0.005, liqMove * 0.8)) : spot * (1 - Math.max(0.005, liqMove * 0.8));
      const k2 = side === "short" ? spot * (1 + Math.min(0.5, liqMove * 1.6)) : spot * (1 - Math.min(0.5, liqMove * 1.6));

      const [s0, s1, s2, spL, spS] = await Promise.all([
        probeStrike(singleStrikes[0]), probeStrike(singleStrikes[1]), probeStrike(singleStrikes[2]),
        probeStrike(k1), probeStrike(k2)
      ]);
      const singles = [s0, s1, s2]
        .map((p) => (p.bestAsk ? { strike: p.bestAsk.strike, askUsdcPerBtc: p.bestAsk.ask } : null))
        .filter((x): x is { strike: number; askUsdcPerBtc: number } => x != null);
      const spread = spL.bestAsk && spS.bestBid
        ? { long: { strike: spL.bestAsk.strike, askUsdcPerBtc: spL.bestAsk.ask }, short: { strike: spS.bestBid.strike, askUsdcPerBtc: 0, bidUsdcPerBtc: spS.bestBid.bid } }
        : null;

      const quote = buildPerpProtectQuote({ spot, entryPrice, sizeBtc, side, leverage, tenorDays }, { singles, spread, settlementStyle });
      const liq = liquidationOf({ spot, entryPrice, sizeBtc, side, leverage, tenorDays });
      reply.send({
        as_of: new Date().toISOString(),
        quote_id: `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        quote_expires_at: new Date(Date.now() + 30_000).toISOString(),
        ...quote,
        liquidation: { price: +liq.price.toFixed(2), move_pct: +liq.movePct.toFixed(4) },
        note: "READ-ONLY quote (Phase 1, underwriter model). Protection for a REAL perp position; single = gap-proof capped, spread = cheaper but exposed beyond the short strike. Priced cheapest across Bullish/Deribit/OKX. European settlement (pluggable). No execution yet."
      });
    }
  );

  /**
   * POST /admin/foxify/v2/fee-recovery/quote — FEE-RECOVERY COVER (Foxify's concrete 2026-06 ask).
   * Fixed-payout ONE-TOUCH: refund a flat cash amount (fees + slippage budget) when a directional
   * perp's stop level (e.g. -3%) is TOUCHED within a short tenor (e.g. 24h). The option leg is
   * priced from REAL listed exchange quotes — a replicating vertical spread straddling the barrier,
   * cheapest ask (long leg) + best bid (short leg) across OKX/Deribit/Bullish — NOT Black-Scholes.
   * Returns the exchange-derived fair value, the loaded premium, and the FULL economics for BOTH
   * sides (incl. the breakeven hit-rate Foxify's real positions must clear). Phase 1 = QUOTE ONLY.
   *
   * Body: { side, notional_usdc, trigger_pct, tenor_days, payout_usdc, mark_price?,
   *         load_pct?, touch_multiplier?, min_premium_usdc?, spread_half_pct?,
   *         trades_per_day?, foxify_real_touch_rate? }
   */
  app.post<{ Body: {
    side?: string; notional_usdc?: number; trigger_pct?: number; tenor_days?: number; payout_usdc?: number;
    mark_price?: number; load_pct?: number; touch_multiplier?: number; min_premium_usdc?: number;
    spread_half_pct?: number; trades_per_day?: number; foxify_real_touch_rate?: number;
  } }>(
    "/admin/foxify/v2/fee-recovery/quote",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { buildFeeRecoveryQuote, barrierPrice } = await import("./feeRecoveryQuote");
      const { okxProbe } = await import("./okxProbe");
      const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
      const b = (req.body ?? {}) as Record<string, unknown>;
      const feed = deps.feedService.getCurrentFeed();
      const spot = b.mark_price != null && Number(b.mark_price) > 0 ? Number(b.mark_price) : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }

      const side: "long" | "short" = b.side === "short" ? "short" : "long";
      const notionalUsdc = Number(b.notional_usdc ?? 0);
      const triggerPct = Number(b.trigger_pct ?? 0.03);
      const tenorDays = Number(b.tenor_days ?? 1);
      const payoutUsdc = Number(b.payout_usdc ?? 0);
      if (!(notionalUsdc > 0) || !(triggerPct > 0 && triggerPct < 1) || !(tenorDays > 0) || !(payoutUsdc > 0)) {
        reply.code(400).send({ error: "invalid_request", message: "notional_usdc>0, 0<trigger_pct<1, tenor_days>0, payout_usdc>0" });
        return;
      }
      const config = {
        loadPct: b.load_pct != null ? Number(b.load_pct) : undefined,
        touchMultiplier: b.touch_multiplier != null ? Number(b.touch_multiplier) : undefined,
        minPremiumUsdc: b.min_premium_usdc != null ? Number(b.min_premium_usdc) : undefined
      };
      const econ = {
        tradesPerDay: b.trades_per_day != null ? Number(b.trades_per_day) : undefined,
        foxifyRealTouchRate: b.foxify_real_touch_rate != null ? Number(b.foxify_real_touch_rate) : null
      };

      const optType: "put" | "call" = side === "short" ? "call" : "put";
      const barrier = barrierPrice(side, spot, triggerPct);
      // Tight vertical straddling the barrier: inner leg (closer to spot) = BUY; outer leg (deeper) = SELL.
      const halfPct = b.spread_half_pct != null && Number(b.spread_half_pct) > 0 ? Number(b.spread_half_pct) : 0.01;
      const halfWidth = Math.max(spot * halfPct, spot * 0.005);
      const innerTarget = side === "short" ? barrier - halfWidth : barrier + halfWidth; // closer to spot
      const outerTarget = side === "short" ? barrier + halfWidth : barrier - halfWidth; // deeper OTM

      // Probe a strike across venues → cheapest ask + best bid, with actual snapped strikes.
      const probeStrike = async (strike: number) => {
        const okx = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null);
        const [der, bull] = await Promise.all([
          deribitPutProbe({ spot, strike, tenorDays, optType }),
          bullishPutProbe(deps.bullishProbeClient, { spot, strike, tenorDays, optType })
        ]);
        const rows = [
          { ask: okx?.ask_usdc_per_btc ?? null, bid: okx?.bid_usdc_per_btc ?? null, strike: okx?.strike ?? null },
          { ask: der.ask_usdc_per_btc, bid: der.bid_usdc_per_btc ?? null, strike: der.strike ?? null },
          { ask: bull.ask_usdc_per_btc, bid: bull.bid_usdc_per_btc ?? null, strike: bull.strike ?? null }
        ];
        const asks = rows.filter((r) => r.ask != null && r.ask > 0 && r.strike != null) as { ask: number; bid: number | null; strike: number }[];
        const bids = rows.filter((r) => r.bid != null && r.bid > 0 && r.strike != null) as { ask: number | null; bid: number; strike: number }[];
        const bestAsk = asks.length ? asks.reduce((a, r) => (r.ask < a.ask ? r : a)) : null;
        const bestBid = bids.length ? bids.reduce((a, r) => (r.bid > a.bid ? r : a)) : null;
        return { bestAsk, bestBid };
      };

      const [inner, outer] = await Promise.all([probeStrike(innerTarget), probeStrike(outerTarget)]);
      if (!inner.bestAsk || !outer.bestBid) {
        reply.code(503).send({ error: "chain_unavailable", message: "no live ask on inner leg or bid on outer leg across venues", inner_strike_target: +innerTarget.toFixed(2), outer_strike_target: +outerTarget.toFixed(2) });
        return;
      }

      const result = buildFeeRecoveryQuote(
        { side, spot, notionalUsdc, triggerPct, tenorDays, payoutUsdc },
        { longStrike: inner.bestAsk.strike, longAskUsdcPerBtc: inner.bestAsk.ask, shortStrike: outer.bestBid.strike, shortBidUsdcPerBtc: outer.bestBid.bid },
        config, econ
      );
      if (!result.ok) {
        reply.code(422).send({ error: result.error, message: result.message,
          inner_strike: inner.bestAsk.strike, outer_strike: outer.bestBid.strike,
          hint: "venue strike snapping may have collapsed/inverted the spread; widen spread_half_pct" });
        return;
      }

      reply.send({
        as_of: new Date().toISOString(),
        quote_id: `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        quote_expires_at: new Date(Date.now() + 30_000).toISOString(),
        ...result
      });
    }
  );

  /**
   * ─────────── SHADOW PROTECTION (Phase 2) — live, paper-settled fee-recovery covers ───────────
   * A clean, separate demo that runs the full protection lifecycle against the REAL BTC feed and
   * REAL option pricing (pass-through + flat ops fee), settled on paper (zero capital). Produces a
   * live validation scorecard (realized vs implied touch, per-side P&L). The same engine accepts a
   * real venue executor later — settlement logic is identical.
   *
   *   POST /admin/foxify/v2/protection/activate   { side?, trigger_pct, tenor_days, payout_usdc, foxify_ref?, require_go?, ops_fee_usdc? }
   *   POST /admin/foxify/v2/protection/tick       (manual monitor pass; also runs automatically every 60s)
   *   GET  /admin/foxify/v2/protection/positions
   *   GET  /admin/foxify/v2/protection/positions/:id
   *   GET  /admin/foxify/v2/protection/scorecard
   */
  let _protectionService: import("./protection/protectionService").ProtectionService | null = null;
  let _protectionSignal: import("./protection/protectionSignal").LiveSignalService | null = null;
  let _protectionAuto: import("./protection/protectionAutoActivator").ProtectionAutoActivator | null = null;
  let _protectionProbeVenues: ((strike: number, optType: "put" | "call", tenorDays: number, spot: number) => Promise<Array<{ venue: string; instrument: string | null; strike: number | null; ask: number | null; bid: number | null; executable: boolean }>>) | null = null;
  const getProtectionService = async () => {
    if (_protectionService) return _protectionService;
    const { ProtectionService } = await import("./protection/protectionService");
    const { PostgresProtectionStore } = await import("./protection/protectionStorePg");
    const { LiveSignalService } = await import("./protection/protectionSignal");
    const { buildFeeRecoveryQuote, barrierPrice } = await import("./feeRecoveryQuote");
    const { okxProbe } = await import("./okxProbe");
    const { deribitPutProbe, bullishPutProbe } = await import("./venuePutProbes");
    const touchMultiplier = Number(process.env.PROTECTION_TOUCH_MULTIPLIER ?? "2");
    const sigSide = (process.env.PROTECTION_SIGNAL_SIDE === "short" ? "short" : "long") as "long" | "short";
    const sigTriggerPct = Number(process.env.PROTECTION_SIGNAL_TRIGGER_PCT ?? "0.03");
    const sigTenorHours = Number(process.env.PROTECTION_SIGNAL_TENOR_HOURS ?? "24");
    const defaultOpsFee = Number(process.env.PROTECTION_OPS_FEE_USDC ?? "1");
    const spreadHalfPct = Number(process.env.PROTECTION_SPREAD_HALF_PCT ?? "0.01");

    // Per-venue quotes (with venue tag + instrument) for a strike — used by the live planner and the
    // venue-comparison endpoint. OKX is included for comparison but is NOT executable (no executor).
    type VenueQuote = { venue: string; instrument: string | null; strike: number | null; ask: number | null; bid: number | null; executable: boolean };
    const probeVenues = async (strike: number, optType: "put" | "call", tenorDays: number, spot: number): Promise<VenueQuote[]> => {
      const okx = await okxProbe({ spot, putStrike: strike, callStrike: strike, tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null);
      const [der, bull] = await Promise.all([
        deribitPutProbe({ spot, strike, tenorDays, optType }),
        bullishPutProbe(deps.bullishProbeClient, { spot, strike, tenorDays, optType })
      ]);
      return [
        { venue: "deribit", instrument: der.instrument, strike: der.strike ?? null, ask: der.ask_usdc_per_btc, bid: der.bid_usdc_per_btc ?? null, executable: true },
        { venue: "bullish", instrument: bull.instrument, strike: bull.strike ?? null, ask: bull.ask_usdc_per_btc, bid: bull.bid_usdc_per_btc ?? null, executable: Boolean(deps.bullishProbeClient) },
        { venue: "okx", instrument: okx?.instId ?? null, strike: okx?.strike ?? null, ask: okx?.ask_usdc_per_btc ?? null, bid: okx?.bid_usdc_per_btc ?? null, executable: false }
      ];
    };
    _protectionProbeVenues = probeVenues;

    const priceCover = async (req: { side: "long" | "short"; spot: number; triggerPct: number; tenorDays: number; payoutUsdc: number }) => {
      const optType: "put" | "call" = req.side === "short" ? "call" : "put";
      const barrier = barrierPrice(req.side, req.spot, req.triggerPct);
      const halfWidth = Math.max(req.spot * spreadHalfPct, req.spot * 0.005);
      const innerTarget = req.side === "short" ? barrier - halfWidth : barrier + halfWidth;
      const outerTarget = req.side === "short" ? barrier + halfWidth : barrier - halfWidth;
      const probeStrike = async (strike: number) => {
        const okx = await okxProbe({ spot: req.spot, putStrike: strike, callStrike: strike, tenorDays: req.tenorDays }).then((o) => o.legs.find((l) => l.opt_type === optType)).catch(() => null);
        const [der, bull] = await Promise.all([
          deribitPutProbe({ spot: req.spot, strike, tenorDays: req.tenorDays, optType }),
          bullishPutProbe(deps.bullishProbeClient, { spot: req.spot, strike, tenorDays: req.tenorDays, optType })
        ]);
        const rows = [
          { ask: okx?.ask_usdc_per_btc ?? null, bid: okx?.bid_usdc_per_btc ?? null, strike: okx?.strike ?? null },
          { ask: der.ask_usdc_per_btc, bid: der.bid_usdc_per_btc ?? null, strike: der.strike ?? null },
          { ask: bull.ask_usdc_per_btc, bid: bull.bid_usdc_per_btc ?? null, strike: bull.strike ?? null }
        ];
        const asks = rows.filter((r) => r.ask != null && r.ask > 0 && r.strike != null) as { ask: number; bid: number | null; strike: number }[];
        const bids = rows.filter((r) => r.bid != null && r.bid > 0 && r.strike != null) as { ask: number | null; bid: number; strike: number }[];
        return {
          bestAsk: asks.length ? asks.reduce((a, r) => (r.ask < a.ask ? r : a)) : null,
          bestBid: bids.length ? bids.reduce((a, r) => (r.bid > a.bid ? r : a)) : null
        };
      };
      const [inner, outer] = await Promise.all([probeStrike(innerTarget), probeStrike(outerTarget)]);
      if (!inner.bestAsk || !outer.bestBid) throw new Error("chain_unavailable: no live ask/bid for the replicating legs");
      const q = buildFeeRecoveryQuote(
        { side: req.side, spot: req.spot, notionalUsdc: req.payoutUsdc * 1000, triggerPct: req.triggerPct, tenorDays: req.tenorDays, payoutUsdc: req.payoutUsdc },
        { longStrike: inner.bestAsk.strike, longAskUsdcPerBtc: inner.bestAsk.ask, shortStrike: outer.bestBid.strike, shortBidUsdcPerBtc: outer.bestBid.bid },
        { loadPct: 0, touchMultiplier }, {}
      );
      if (!q.ok) throw new Error(`${q.error}: ${q.message}`);
      const opsFee = defaultOpsFee;
      return {
        hedgeCostUsdc: q.pricing.fair_value_usdc,
        impliedTouch: q.pricing.implied_touch_prob,
        opsFeeUsdc: opsFee,
        premiumUsdc: +(q.pricing.fair_value_usdc + opsFee).toFixed(2),
        payoutUsdc: req.payoutUsdc
      };
    };

    // Live adaptive signal (warmed from recent market data, refreshed every 30min).
    _protectionSignal = new LiveSignalService({ side: sigSide, triggerPct: sigTriggerPct, tenorHours: sigTenorHours });
    void _protectionSignal.start();

    // ── Multi-venue executor + planner (built only when live execution is enabled) ──
    const liveEnabled = String(process.env.PROTECTION_LIVE_EXECUTION ?? "false").toLowerCase() === "true";
    let executor: import("./protection/hedgeExecutor").HedgeExecutor | undefined;
    let planLiveHedge: import("./protection/protectionService").PlanLiveHedgeFn | undefined;
    if (liveEnabled) {
      const { MultiVenueHedgeExecutor } = await import("./protection/hedgeExecutor");
      const { DeribitConnector } = await import("@foxify/connectors");
      const { DeribitLegAdapter, BullishLegAdapter } = await import("./liveVenueAdapters");
      const deribitLive = new DeribitConnector("live", true);
      const deribitLeg = new DeribitLegAdapter(deribitLive as unknown as { placeOrder: (r: unknown) => Promise<unknown> }, {
        getCurrentSpotUsd: () => deps.feedService.getCurrentFeed()?.canonicalPrice ?? null
      });
      let bullishLeg: InstanceType<typeof BullishLegAdapter> | undefined;
      try {
        const { pilotConfig } = await import("../../pilot/config");
        const tradingAccountId = pilotConfig.bullish?.tradingAccountId;
        if (deps.bullishProbeClient && tradingAccountId) {
          bullishLeg = new BullishLegAdapter(deps.bullishProbeClient as never, { tradingAccountId });
        }
      } catch { /* bullish execution optional */ }
      executor = new MultiVenueHedgeExecutor({ deribit: deribitLeg, bullish: bullishLeg });

      planLiveHedge = async ({ side, spot, triggerPct, tenorDays, contractsBtc }) => {
        const optType: "put" | "call" = side === "short" ? "call" : "put";
        const barrier = barrierPrice(side, spot, triggerPct);
        const halfWidth = Math.max(spot * spreadHalfPct, spot * 0.005);
        const innerTarget = side === "short" ? barrier - halfWidth : barrier + halfWidth;
        const outerTarget = side === "short" ? barrier + halfWidth : barrier - halfWidth;
        const innerQuotes = await probeVenues(innerTarget, optType, tenorDays, spot);
        const outerQuotes = await probeVenues(outerTarget, optType, tenorDays, spot);
        const innerExec = innerQuotes.filter((q) => (q.venue === "deribit" || (q.venue === "bullish" && bullishLeg)) && q.ask != null && q.ask > 0 && q.strike != null);
        const outerExec = outerQuotes.filter((q) => (q.venue === "deribit" || (q.venue === "bullish" && bullishLeg)) && q.bid != null && q.bid > 0 && q.strike != null);
        if (!innerExec.length || !outerExec.length) throw new Error("no executable venue for one of the legs");
        const inner = innerExec.reduce((a, b) => (b.ask! < a.ask! ? b : a));
        const outer = outerExec.reduce((a, b) => (b.bid! > a.bid! ? b : a));
        return {
          side, contractsBtc,
          inner: { venue: inner.venue as "deribit" | "bullish", instrument: inner.instrument!, strike: inner.strike!, askUsdcPerBtc: inner.ask!, bidUsdcPerBtc: inner.bid ?? 0 },
          outer: { venue: outer.venue as "deribit" | "bullish", instrument: outer.instrument!, strike: outer.strike!, askUsdcPerBtc: outer.ask ?? 0, bidUsdcPerBtc: outer.bid! }
        };
      };
    }

    _protectionService = new ProtectionService({
      store: new PostgresProtectionStore(deps.pool),
      getSpot: () => deps.feedService.getCurrentFeed()?.canonicalPrice ?? null,
      priceCover,
      getSignal: () => _protectionSignal?.getSignal() ?? "NA",
      executor,
      planLiveHedge,
      defaultOpsFeeUsdc: defaultOpsFee
    });
    // Auto-monitor every 60s (shadow mode) so covers settle on touch/expiry without manual ticks.
    const timer = setInterval(() => { void _protectionService?.tick(); }, 60_000);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();

    // Optional auto-activator: opens a shadow cover each interval when the signal is GO (builds the track record).
    if (String(process.env.PROTECTION_AUTO_ACTIVATE_ENABLED ?? "false").toLowerCase() === "true") {
      const { ProtectionAutoActivator } = await import("./protection/protectionAutoActivator");
      _protectionAuto = new ProtectionAutoActivator({
        service: _protectionService,
        intervalMs: Number(process.env.PROTECTION_AUTO_ACTIVATE_INTERVAL_MS ?? String(60 * 60_000)),
        params: {
          side: sigSide, triggerPct: sigTriggerPct, tenorDays: sigTenorHours / 24,
          payoutUsdc: Number(process.env.PROTECTION_AUTO_PAYOUT_USDC ?? "60"),
          requireGo: String(process.env.PROTECTION_AUTO_REQUIRE_GO ?? "true").toLowerCase() === "true",
          mode: "shadow"
        }
      });
      _protectionAuto.start();
    }
    return _protectionService;
  };

  app.post<{ Body: { side?: string; trigger_pct?: number; tenor_days?: number; payout_usdc?: number; contracts_btc?: number; foxify_ref?: string; require_go?: boolean; ops_fee_usdc?: number; signal_override?: string; mode?: string } }>(
    "/admin/foxify/v2/protection/activate",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const svc = await getProtectionService();
      const b = req.body ?? {};
      const side = b.side === "short" ? "short" : "long";
      const mode: "shadow" | "live" = b.mode === "live" ? "live" : "shadow";
      // LIVE = real money. Hard-gate + size cap.
      if (mode === "live") {
        if (String(process.env.PROTECTION_LIVE_EXECUTION ?? "false").toLowerCase() !== "true") {
          reply.code(403).send({ error: "live_execution_disabled", message: "set PROTECTION_LIVE_EXECUTION=true to place real orders" }); return;
        }
      }
      const maxContracts = Number(process.env.PROTECTION_LIVE_MAX_CONTRACTS_BTC ?? "0.1");
      const result = await svc.activate({
        foxifyRef: b.foxify_ref ?? null,
        side,
        triggerPct: Number(b.trigger_pct ?? 0.03),
        tenorDays: Number(b.tenor_days ?? 1),
        payoutUsdc: Number(b.payout_usdc ?? 60),
        contractsBtc: mode === "live" ? Math.min(Number(b.contracts_btc ?? 0.1), maxContracts) : undefined,
        requireGo: b.require_go === true,
        signalOverride: (["GO", "WAIT", "NA"].includes(b.signal_override ?? "") ? b.signal_override : undefined) as "GO" | "WAIT" | "NA" | undefined,
        mode
      });
      if (!result.ok) {
        const transient = ["feed_unavailable", "pricing_failed", "planning_failed", "hedge_open_failed", "live_unavailable"].includes(result.error);
        reply.code(transient ? 503 : 400).send(result); return;
      }
      reply.code(result.reused ? 200 : 201).send({ ok: true, reused: result.reused, cover: result.cover });
    }
  );

  // Manually settle + unwind an active cover now (forced) — operator-driven live test / early close.
  app.post<{ Params: { id: string } }>("/admin/foxify/v2/protection/positions/:id/close", { preHandler: checkAdminToken }, async (req, reply) => {
    const svc = await getProtectionService();
    const r = await svc.forceClose(req.params.id);
    if (!r.ok) { reply.code(r.error === "not_found" ? 404 : 400).send(r); return; }
    reply.send({ ok: true, cover: r.cover });
  });

  // Venue price comparison for the replicating legs (Deribit/Bullish executable, OKX comparison-only).
  app.get<{ Querystring: { side?: string; trigger_pct?: string; tenor_days?: string } }>(
    "/admin/foxify/v2/protection/venue-quotes",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      await getProtectionService();
      const { barrierPrice } = await import("./feeRecoveryQuote");
      const side = req.query.side === "short" ? "short" : "long";
      const optType: "put" | "call" = side === "short" ? "call" : "put";
      const triggerPct = Number(req.query.trigger_pct ?? "0.03");
      const tenorDays = Number(req.query.tenor_days ?? "1");
      const spot = deps.feedService.getCurrentFeed()?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const barrier = barrierPrice(side, spot, triggerPct);
      const halfWidth = Math.max(spot * 0.01, spot * 0.005);
      const innerTarget = side === "short" ? barrier - halfWidth : barrier + halfWidth;
      const outerTarget = side === "short" ? barrier + halfWidth : barrier - halfWidth;
      if (!_protectionProbeVenues) { reply.code(503).send({ error: "not_initialized" }); return; }
      const [innerQuotes, outerQuotes] = await Promise.all([_protectionProbeVenues(innerTarget, optType, tenorDays, spot), _protectionProbeVenues(outerTarget, optType, tenorDays, spot)]);
      reply.send({ as_of: new Date().toISOString(), spot, side, barrier_price: +barrier.toFixed(2), inner_leg_buy: innerQuotes, outer_leg_sell: outerQuotes,
        note: "inner = leg you BUY (lowest ask wins); outer = leg you SELL (highest bid wins). Deribit/Bullish are executable; OKX is comparison-only." });
    }
  );

  app.post("/admin/foxify/v2/protection/tick", { preHandler: checkAdminToken }, async (_req, reply) => {
    const svc = await getProtectionService();
    const res = await svc.tick();
    reply.send({ ok: true, spot: res.spot, evaluated: res.evaluated, settled_now: res.settled });
  });

  app.get("/admin/foxify/v2/protection/positions", { preHandler: checkAdminToken }, async (_req, reply) => {
    const svc = await getProtectionService();
    reply.send({ positions: await svc.list() });
  });

  app.get<{ Params: { id: string } }>("/admin/foxify/v2/protection/positions/:id", { preHandler: checkAdminToken }, async (req, reply) => {
    const svc = await getProtectionService();
    const cover = await svc.get(req.params.id);
    if (!cover) { reply.code(404).send({ error: "not_found" }); return; }
    reply.send({ cover });
  });

  app.get("/admin/foxify/v2/protection/scorecard", { preHandler: checkAdminToken }, async (_req, reply) => {
    const svc = await getProtectionService();
    reply.send({ as_of: new Date().toISOString(), scorecard: await svc.scorecard() });
  });

  app.get("/admin/foxify/v2/protection/signal", { preHandler: checkAdminToken }, async (_req, reply) => {
    await getProtectionService(); // ensures the signal service is started
    reply.send({ as_of: new Date().toISOString(), signal: _protectionSignal?.getDetail() ?? { state: "NA", reason: "not_initialized" } });
  });

  app.get("/admin/foxify/v2/protection/auto-status", { preHandler: checkAdminToken }, async (_req, reply) => {
    await getProtectionService();
    reply.send({ as_of: new Date().toISOString(), auto_activator: _protectionAuto?.status() ?? { running: false, note: "disabled (set PROTECTION_AUTO_ACTIVATE_ENABLED=true)" } });
  });


  /**
   * GET /admin/foxify/v2/breakeven-win-rate — for each structure, the MINIMUM directional
   * hit-rate Foxify needs for +EV (in a regime, frictions on/off). The decision number.
   * Query: ?cell_id=&regime=&frictionless=&n_paths=
   */
  app.get<{ Querystring: { cell_id?: string; regime?: string; frictionless?: string; n_paths?: string } }>(
    "/admin/foxify/v2/breakeven-win-rate",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { computeBreakevenWinRates } = await import("./breakevenWinRate");
      const { classifyRegime } = await import("./featureFlag");
      const { PHASE_0_CELLS } = await import("./cellConfig");
      const feed = deps.feedService.getCurrentFeed();
      const spot = feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const cellId = req.query.cell_id || "pair_10k_atm_2d";
      if (!PHASE_0_CELLS[cellId]) { reply.code(400).send({ error: "unknown_cell", message: `cell '${cellId}' not in config`, known: Object.keys(PHASE_0_CELLS) }); return; }
      const currentDvol = deps.dvolService.getCurrentDvol();
      const regime = (["calm", "moderate", "elevated", "stress"].includes(req.query.regime ?? "")
        ? req.query.regime
        : (currentDvol ? classifyRegime(currentDvol.dvol) : "moderate")) as "calm" | "moderate" | "elevated" | "stress";
      try {
        const report = await computeBreakevenWinRates(deps.pool, {
          cellId, regime, spot, liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
          frictionless: req.query.frictionless === "true",
          nPaths: req.query.n_paths ? Number(req.query.n_paths) : undefined
        });
        reply.send(report);
      } catch (e) {
        reply.code(500).send({ error: "breakeven_failed", message: (e as Error).message });
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
   * POST /admin/foxify/v2/scaling-projection — 30-day capital-scaling projection.
   * From a hedge budget, projects concurrent pairs + cumulative volume/profit +
   * drawdown over N days, recycling profits (no split), with LIVE pricing + the
   * MC's real net distribution (p5/median/p95).
   * Body: { cell_id, regime?, budget_usdc, days?=30, cycle_days?, market_availability?,
   *         max_concurrent?, n_runs?, spot?,
   *         realized_mode? ('off'|'blend'|'replace', default env/blend),
   *         min_validated_settlements? (default env/20) }
   * Once a cell has >= N regime-tagged validated shadow settlements, the net
   * distribution shifts from MC (estimate) toward the REAL realized one
   * (response: net_source, blend_weight, realized_n, realized_mean_net_usdc).
   */
  app.post<{ Body?: Record<string, unknown> }>(
    "/admin/foxify/v2/scaling-projection",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { projectScaling } = await import("./scalingProjection");
      const b = req.body ?? {};
      const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const feed = deps.feedService.getCurrentFeed();
      const spot = typeof b.spot === "number" ? b.spot : feed?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const cellId = typeof b.cell_id === "string" ? b.cell_id : "pair_50k_3pct_atm_3d";
      const validRegimes = ["calm", "moderate", "elevated", "stress"];
      const regime = (typeof b.regime === "string" && validRegimes.includes(b.regime) ? b.regime : "moderate") as "calm" | "moderate" | "elevated" | "stress";
      const budgetUsdc = num(b.budget_usdc);
      if (!budgetUsdc || budgetUsdc <= 0) { reply.code(400).send({ error: "invalid_request", message: "budget_usdc (positive number) required" }); return; }
      // Realized-net wiring controls (Deliverable 1). Default to env/blend when omitted.
      const validModes = ["off", "blend", "replace"];
      const realizedMode = (typeof b.realized_mode === "string" && validModes.includes(b.realized_mode))
        ? (b.realized_mode as "off" | "blend" | "replace") : undefined;
      if (b.realized_mode !== undefined && realizedMode === undefined) {
        reply.code(400).send({ error: "invalid_request", message: "realized_mode must be 'off' | 'blend' | 'replace'" }); return;
      }
      try {
        const result = await projectScaling(deps.pool, {
          cellId, regime, budgetUsdc, spot,
          liquidChainCache: deps.liquidChainCache, dvolService: deps.dvolService,
          days: num(b.days), cycleDays: num(b.cycle_days), marketAvailability: num(b.market_availability),
          maxConcurrent: num(b.max_concurrent), nRuns: num(b.n_runs),
          realizedMode, minValidatedSettlements: num(b.min_validated_settlements)
        });
        reply.send(result);
      } catch (e) {
        reply.code(500).send({ error: "projection_failed", message: (e as Error).message });
      }
    }
  );

  /**
   * GET /admin/foxify/v2/breakeven-ladder
   *
   * Phase 2 (calm loss-leader decision input). For one candidate cell, runs the MC
   * across a DVOL ladder at the REAL current chain cost and returns net-vs-DVOL +
   * the interpolated breakeven DVOL (where loss -> profit). Lets the bot/CEO see
   * "at current DVOL this cell loses ~$X; it turns positive at DVOL Y."
   *
   * Query: ?notional=25000 ?moneyness=-0.05 ?tenor_days=1 ?structure=strangle
   *        ?trigger=0.03 ?auto_close_pct=0.30 ?auto_close_abs=250
   *        ?dvols=30,35,40,45,50 ?venue=deribit ?n_paths=800
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/admin/foxify/v2/breakeven-ladder", { preHandler: checkAdminToken }, async (req, reply) => {
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable" }); return; }
      const spot = deps.feedService.getCurrentFeed()?.canonicalPrice;
      if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
      const q = req.query;
      const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
      const structure = q.structure === "straddle" ? "straddle" : "strangle";
      const dvols = (q.dvols ? q.dvols.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) : [30, 35, 40, 45, 50]);
      const venue = (q.venue === "bullish" || q.venue === "deribit") ? q.venue : "auto";
      const { computeBreakevenLadder } = await import("./breakevenLadder");
      try {
        const result = await computeBreakevenLadder({
          spot,
          notionalUsdcPerLeg: num(q.notional, 25000),
          strikeMoneynessPct: num(q.moneyness, structure === "straddle" ? 0 : -0.05),
          tenorDays: num(q.tenor_days, 1),
          structure,
          triggerPct: num(q.trigger, 0.03),
          autoClosePnlPct: num(q.auto_close_pct, 0.30),
          autoCloseAbsoluteUsdc: num(q.auto_close_abs, 250),
          dvols: dvols.length ? dvols : [30, 35, 40, 45, 50],
          liquidChainCache: deps.liquidChainCache,
          dvolService: deps.dvolService,
          venue,
          nPaths: q.n_paths ? Number(q.n_paths) : 800,
          perpPairFrictionUsdc: q.perp_pair_friction != null ? Number(q.perp_pair_friction)
            : (process.env.FOXIFY_PERP_FRICTION_USDC != null ? Number(process.env.FOXIFY_PERP_FRICTION_USDC) : 0)
        });
        if (!result.ok) { reply.code(503).send(result); return; }
        reply.send(result);
      } catch (e) {
        reply.code(500).send({ error: "ladder_failed", message: (e as Error).message });
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
   * Body (optional): { days?=90, resolutionSec?=3600, windowDays?=10,
   *   start_iso?, end_iso? } — when BOTH start_iso+end_iso are given they target
   *   an explicit HISTORICAL window (e.g. a past elevated/stress period to make
   *   those regimes' calibration empirical). Span capped at 400 days.
   */
  app.post<{ Body?: { days?: number; resolutionSec?: number; windowDays?: number; start_iso?: string; end_iso?: string } }>(
    "/admin/foxify/v2/dvol-backfill",
    { preHandler: checkAdminToken },
    async (req, reply) => {
      const { backfillDvolHistory } = await import("../../../scripts/calibration/backfillDvolHistory");
      const body = req.body ?? {};
      const days = typeof body.days === "number" && body.days > 0 ? Math.min(365, body.days) : 90;
      const resolutionSec = typeof body.resolutionSec === "number" && body.resolutionSec > 0 ? body.resolutionSec : 3600;
      const windowDays = typeof body.windowDays === "number" && body.windowDays > 0 ? Math.min(30, body.windowDays) : 10;
      // Optional explicit historical window (target a past volatile period).
      let startMs: number | undefined;
      let endMs: number | undefined;
      if (typeof body.start_iso === "string" && typeof body.end_iso === "string") {
        const s = Date.parse(body.start_iso);
        const e = Date.parse(body.end_iso);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
          reply.code(400).send({ error: "invalid_request", message: "start_iso/end_iso must be valid ISO timestamps with end_iso > start_iso" });
          return;
        }
        if (e - s > 400 * 86_400_000) {
          reply.code(400).send({ error: "invalid_request", message: "explicit window span capped at 400 days" });
          return;
        }
        startMs = s; endMs = e;
      }
      try {
        const result = await backfillDvolHistory(deps.pool, {
          days, resolutionSec, windowDays, startMs, endMs,
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
   * GET /admin/foxify/v2/bullish-auth-probe
   *
   * DEFINITIVE Bullish whitelist + auth test. Unlike bullish-whitelist-probe
   * (unauthenticated network reachability), this makes ONE *authenticated*
   * Bullish call (getTradingAccounts — signed, account-scoped) using the server's
   * shared client, so it originates from the deployment's WHITELISTED IP
   * (Singapore). Single request — no hammering. Interpretation:
   *   - success (accounts returned)  → whitelist + ECDSA auth WORKING ✅
   *   - 401 / signature / auth error → creds loaded but signing/metadata wrong
   *   - 403 / forbidden              → IP NOT whitelisted (or account not permissioned)
   *   - 429 / rate_limit             → reached + authed, just rate-limited
   *   - timeout / network            → blocked at network layer (NOT whitelisted)
   */
  app.get("/admin/foxify/v2/bullish-auth-probe", { preHandler: checkAdminToken }, async (_req, reply) => {
    if (!deps.bullishProbeClient) {
      reply.code(503).send({ error: "bullish_client_unavailable", message: "No Bullish client wired (PILOT_BULLISH_ENABLED=false or creds missing). Cannot run authenticated probe." });
      return;
    }
    const startMs = Date.now();
    try {
      const accounts = await deps.bullishProbeClient.getTradingAccounts();
      const n = Array.isArray(accounts) ? accounts.length
        : (accounts && typeof accounts === "object" && Array.isArray((accounts as { data?: unknown[] }).data)) ? (accounts as { data: unknown[] }).data.length
        : (accounts != null ? 1 : 0);
      reply.send({
        ok: true,
        authenticated: true,
        whitelist: "active",
        trading_accounts_count: n,
        latency_ms: Date.now() - startMs,
        interpretation: "REACHED_AND_AUTHED — Bullish whitelist + ECDSA auth working from the deployment IP ✅"
      });
    } catch (e) {
      const msg = (e as Error).message;
      const lower = msg.toLowerCase();
      let interpretation: string;
      let whitelist: "active" | "likely_not_whitelisted" | "unknown" = "unknown";
      if (msg.includes("429") || lower.includes("rate_limit") || lower.includes("96100")) {
        interpretation = "REACHED_RATE_LIMITED — authed request reached Bullish, just rate-limited (whitelist OK)";
        whitelist = "active";
      } else if (msg.includes("401") || lower.includes("signature") || lower.includes("unauthorized") || lower.includes("auth")) {
        interpretation = "AUTH_ERROR — creds loaded but signing/metadata likely wrong (run pilot:bullish:auth-debug)";
        whitelist = "unknown";
      } else if (msg.includes("403") || lower.includes("forbidden") || lower.includes("not allowed")) {
        interpretation = "FORBIDDEN — IP likely NOT whitelisted (or account lacks permission)";
        whitelist = "likely_not_whitelisted";
      } else if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("aborted") || lower.includes("econnrefused")) {
        interpretation = "TIMEOUT/REFUSED — blocked at network layer (NOT whitelisted)";
        whitelist = "likely_not_whitelisted";
      } else {
        interpretation = `ERROR — ${msg}`;
      }
      reply.send({ ok: false, authenticated: false, whitelist, latency_ms: Date.now() - startMs, error: msg, interpretation });
    }
  });

  /**
   * GET /admin/foxify/v2/venue-positions  (alias: /admin/foxify/v2/bullish-positions)
   *
   * Live↔venue reconciliation probe. Compares our live (non-shadow) held legs against
   * the venues' actual reported positions/holdings. Surfaces PHANTOM (we hold per DB,
   * venue doesn't), ORPHAN (venue holds, no DB record), and size deltas. Read-only.
   */
  const venuePositionsHandler = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.venuePositionReader) {
      reply.code(503).send({ error: "venue_position_reader_unavailable", message: "No venue position reader wired (shadow-only deploy or creds missing)." });
      return;
    }
    try {
      const { reconcileVenuePositions } = await import("./venueReconciliation");
      const report = await reconcileVenuePositions(deps.pool, deps.venuePositionReader);
      reply.send(report);
    } catch (e) {
      reply.code(500).send({ error: "reconciliation_failed", message: (e as Error).message });
    }
  };
  app.get("/admin/foxify/v2/venue-positions", { preHandler: checkAdminToken }, venuePositionsHandler);
  app.get("/admin/foxify/v2/bullish-positions", { preHandler: checkAdminToken }, venuePositionsHandler);

  /**
   * GET /admin/foxify/v2/settlement-funnel
   *
   * Explains WHY active positions aren't (yet) feeding the realized-vs-MC validation
   * gate: open vs settled, regime-tagged vs untagged, organic vs seeded, per cell.
   * Read-only.
   */
  app.get("/admin/foxify/v2/settlement-funnel", { preHandler: checkAdminToken }, async (_req, reply) => {
    try {
      const { getSettlementFunnel } = await import("./settlementFunnel");
      const funnel = await getSettlementFunnel(deps.pool);
      reply.send(funnel);
    } catch (e) {
      reply.code(500).send({ error: "funnel_failed", message: (e as Error).message });
    }
  });

  /**
   * POST /admin/foxify/v2/flush-deprecated-shadow
   *
   * On-demand flush of deprecated OPEN shadow pairs → cancelled (paper noise cleanup).
   * The shadow auto-loop also does this each tick; this is the manual trigger. Body:
   * { dry_run?: true } to preview the count/ids without cancelling.
   */
  app.post<{ Body: { dry_run?: boolean } }>("/admin/foxify/v2/flush-deprecated-shadow", { preHandler: checkAdminToken }, async (req, reply) => {
    try {
      const { flushDeprecatedOpenShadowPairs } = await import("./deprecatedShadowFlush");
      const dryRun = req.body?.dry_run === true;
      const result = await flushDeprecatedOpenShadowPairs(deps.pool, { dryRun });
      reply.send({ ...result, dry_run: dryRun, note: dryRun ? "preview only — no pairs cancelled" : "deprecated open shadow pairs cancelled (paper; excluded from realized stats)" });
    } catch (e) {
      reply.code(500).send({ error: "flush_failed", message: (e as Error).message });
    }
  });

  /**
   * GET /admin/foxify/v2/bullish-markets-probe
   *
   * Diagnoses WHY the Bullish chain yields 0 quotes despite working auth. Pulls
   * the authed Bullish markets list and reports the FULL filter funnel + Bullish's
   * actual BTC-option expiry calendar and strike range, so we can see whether the
   * provider's strike/tenor window (centerTenorDays/tenorWindowDays/strikeWindowUsdc)
   * is excluding real liquidity (likely cause: Bullish lists sparse weekly/monthly
   * expiries that miss the narrow 0.5–3.5d window Deribit's daily expiries always hit).
   *
   * Query: ?tenor_days=3 ?strike_window=6000 ?tenor_window_days=1.5 (the window to TEST)
   */
  app.get<{ Querystring: { tenor_days?: string; strike_window?: string; tenor_window_days?: string } }>(
    "/admin/foxify/v2/bullish-markets-probe", { preHandler: checkAdminToken }, async (req, reply) => {
    const client = deps.bullishProbeClient;
    if (!client || typeof client.getMarkets !== "function") {
      reply.code(503).send({ error: "bullish_client_unavailable", message: "No Bullish client (or getMarkets) wired." });
      return;
    }
    const nowMs = Date.now();
    const spot = deps.feedService.getCurrentFeed()?.canonicalPrice ?? 75_000;
    const targetTenorDays = Number(req.query.tenor_days ?? "3");
    const strikeWindow = Number(req.query.strike_window ?? "6000");
    const tenorWindowDays = Number(req.query.tenor_window_days ?? "1.5");
    const targetTenorMs = targetTenorDays * 86_400_000;
    const tenorWindowMs = tenorWindowDays * 86_400_000;
    try {
      const markets = await client.getMarkets({ forceRefresh: true });
      const num = (v: unknown): number => Number(v ?? "0");
      const isBtcOption = (m: Record<string, unknown>): boolean =>
        String(m.underlyingBaseSymbol ?? "").toUpperCase() === "BTC" &&
        ["PUT", "CALL"].includes(String(m.optionType ?? "").toUpperCase());
      const btcOpts = markets.filter(isBtcOption);
      const enabled = btcOpts.filter((m) => m.marketEnabled && m.createOrderEnabled);
      // Distinct expiries (days-to-expiry) across enabled BTC options.
      const expiryDaysSet = new Map<string, number>();
      for (const m of enabled) {
        const iso = String(m.expiryDatetime ?? "");
        const t = Date.parse(iso);
        if (Number.isFinite(t)) expiryDaysSet.set(iso, +((t - nowMs) / 86_400_000).toFixed(2));
      }
      const expiries = [...expiryDaysSet.entries()].map(([iso, days]) => ({ iso, days })).sort((a, b) => a.days - b.days);
      const strikes = enabled.map((m) => num(m.optionStrikePrice)).filter((s) => s > 0);
      const withinStrike = enabled.filter((m) => Math.abs(num(m.optionStrikePrice) - spot) <= strikeWindow);
      const withinTenor = enabled.filter((m) => {
        const t = Date.parse(String(m.expiryDatetime ?? ""));
        return Number.isFinite(t) && t > nowMs && Math.abs((t - nowMs) - targetTenorMs) <= tenorWindowMs;
      });
      const withinBoth = withinTenor.filter((m) => Math.abs(num(m.optionStrikePrice) - spot) <= strikeWindow);
      // Sample the orderbooks of the strikes NEAREST spot (ATM is where liquidity
      // lives — one ITM sample can be misleadingly empty). Distinguishes genuinely
      // empty books vs throttled fetches (429) vs RFQ/quote-driven (no resting book).
      const orderbookSamples: Array<Record<string, unknown>> = [];
      if (typeof client.getHybridOrderBook === "function") {
        const nearest = [...withinBoth]
          .sort((a, b) => Math.abs(num(a.optionStrikePrice) - spot) - Math.abs(num(b.optionStrikePrice) - spot))
          .slice(0, 6);
        for (const m of nearest) {
          try {
            const ob = await client.getHybridOrderBook(String(m.symbol));
            orderbookSamples.push({
              symbol: m.symbol, strike: num(m.optionStrikePrice), opt: String(m.optionType),
              top_bid: ob.bids?.[0]?.price ?? null, top_ask: ob.asks?.[0]?.price ?? null,
              has_book: (ob.bids?.length ?? 0) > 0 && (ob.asks?.length ?? 0) > 0
            });
          } catch (e) {
            orderbookSamples.push({ symbol: m.symbol, strike: num(m.optionStrikePrice), error: (e as Error).message });
          }
        }
      }
      const booksWithLiquidity = orderbookSamples.filter((s) => s.has_book === true).length;
      const fetchErr = orderbookSamples.find((s) => s.error)?.error as string | undefined;
      reply.send({
        ok: true,
        spot,
        tested_window: { target_tenor_days: targetTenorDays, tenor_window_days: tenorWindowDays, strike_window_usdc: strikeWindow },
        funnel: {
          total_markets: markets.length,
          btc_options: btcOpts.length,
          enabled_btc_options: enabled.length,
          within_strike_window: withinStrike.length,
          within_tenor_window: withinTenor.length,
          within_both: withinBoth.length
        },
        btc_option_expiries: expiries,
        btc_strike_range: strikes.length ? { min: Math.min(...strikes), max: Math.max(...strikes), count: strikes.length } : null,
        orderbook_samples: orderbookSamples,
        near_atm_books_with_liquidity: booksWithLiquidity,
        diagnosis:
          enabled.length === 0 ? "Bullish lists NO enabled BTC options right now (account/market gating)."
          : withinTenor.length === 0 ? `Bullish lists BTC options but NONE within ±${tenorWindowDays}d of ${targetTenorDays}d — sparse expiry calendar vs the provider window. Nearest expiries: ${expiries.slice(0, 5).map((e) => e.days + "d").join(", ")}. FIX: widen tenor window or align cell tenor to a listed expiry.`
          : withinBoth.length === 0 ? `Expiry matches but strikes outside ±$${strikeWindow} of spot ${spot}. Widen strike window.`
          : fetchErr ? `Orderbook fetches ERRORING (likely 429 rate-limit): "${fetchErr}". Auth OK but the data endpoint is throttled → 0 quotes. FIX: widen BULLISH_RATE_LIMIT_BACKOFF_MS / slow the poll, or use authed higher-limit host.`
          : booksWithLiquidity === 0 ? `${withinBoth.length} contracts match the window but ALL ${orderbookSamples.length} sampled NEAR-ATM orderbooks are EMPTY (no resting bids/asks). Either Bullish MMs pulled resting liquidity, OR Bullish options are RFQ/quote-driven (liquidity appears on request, not as a resting book) — in which case the provider must request a quote rather than read top-of-book.`
          : `${booksWithLiquidity}/${orderbookSamples.length} near-ATM orderbooks HAVE resting liquidity — Bullish IS quotable. The earlier 0 was transient/rate-limit or an unlucky ITM sample; re-run chain-probe (force_refresh).`
      });
    } catch (e) {
      reply.send({ ok: false, error: (e as Error).message, interpretation: "Authed markets fetch failed — see error (429 rate-limit / auth / network)." });
    }
  });

  /**
   * GET /admin/foxify/v2/venue-probe
   *
   * Shows EXACTLY what venue each leg would be routed to (and WHY), using the same
   * pickLegVenue logic + live anchors a real activation uses — WITHOUT activating,
   * and regardless of regime (selection is pure price/round-trip, regime-independent).
   * Per leg: every venue's ask/bid/spread/round-trip cost (2·ask−bid), the chosen
   * venue, the best venue, and whether the partner tie-breaker fired.
   *
   * Query: ?cell_id=pair_50k_3pct_atm_3d
   */
  app.get<{ Querystring: { cell_id?: string; snap_to_bullish?: "true" | "false" } }>(
    "/admin/foxify/v2/venue-probe", { preHandler: checkAdminToken }, async (req, reply) => {
    const { PHASE_0_CELLS, computeStrikes } = await import("./cellConfig");
    const { pickLegVenue } = await import("./quoteEngine");
    type Anchor = Parameters<typeof pickLegVenue>[0];
    const cellId = req.query.cell_id ?? "pair_50k_3pct_atm_3d";
    const snapToBullish = req.query.snap_to_bullish === "true";
    const cell = PHASE_0_CELLS[cellId];
    if (!cell) { reply.code(400).send({ error: "unknown_cell", message: `cell '${cellId}' not in config`, known: Object.keys(PHASE_0_CELLS) }); return; }
    const spot = deps.feedService.getCurrentFeed()?.canonicalPrice;
    if (!spot || spot <= 0) { reply.code(503).send({ error: "feed_unavailable" }); return; }
    const { putStrike, callStrike } = computeStrikes(cell, spot);
    const contractsBtc = +(cell.notionalUsdcPerLeg / spot).toFixed(3);
    const partnerVenue = String(process.env.SS_VENUE_PARTNER ?? "").toLowerCase() || null;
    const maxSpreadPct = Number(process.env.SS_VENUE_PARTNER_MAX_SPREAD_PCT ?? "0");
    const rt = (a: { askUsdcPerBtc: number; bidUsdcPerBtc?: number }): number =>
      (a.bidUsdcPerBtc != null && a.bidUsdcPerBtc > 0) ? +(2 * a.askUsdcPerBtc - a.bidUsdcPerBtc).toFixed(2) : a.askUsdcPerBtc;
    const describe = (a: { venue: string; askUsdcPerBtc: number; bidUsdcPerBtc?: number; depthWithin2pctBtc: number } | null) =>
      a ? { venue: a.venue, ask: a.askUsdcPerBtc, bid: a.bidUsdcPerBtc ?? null, roundtrip_cost: rt(a), depth: a.depthWithin2pctBtc } : null;

    // ── SNAP-TO-BULLISH WHAT-IF (read-only; does NOT change activation routing) ──
    // For each leg, snap to Bullish's NEAREST listed strike and compare BOTH venues
    // at that snapped strike (Deribit shown at the same strike for apples-to-apples).
    // Shows whether aligning cell strikes to Bullish's grid would make Bullish win.
    if (snapToBullish) {
      if (!deps.liquidChainCache) { reply.code(503).send({ error: "chain_cache_unavailable", message: "snap_to_bullish needs liquidChainCache" }); return; }
      const chain = await deps.liquidChainCache.getChain();
      if (!chain) { reply.code(503).send({ error: "no_chain_snapshot" }); return; }
      const targetHours = cell.hedgeTenorDays * 24;
      const pulledAt = new Date(chain.fetchedAtMs).toISOString();
      const inTenor = (q: { tenorHours: number }) => Math.abs(q.tenorHours - targetHours) <= 36;
      const legsSnap: Array<Record<string, unknown>> = [];
      for (const [optType, targetStrike] of [["put", putStrike], ["call", callStrike]] as const) {
        const bull = chain.quotes
          .filter((q) => q.venue === "bullish" && q.optType === optType && inTenor(q) && q.bidUsdcPerBtc > 0)
          .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike) || Math.abs(a.tenorHours - targetHours) - Math.abs(b.tenorHours - targetHours))[0] ?? null;
        const snappedStrike = bull?.strike ?? targetStrike;
        const der = chain.quotes
          .filter((q) => q.venue === "deribit" && q.optType === optType && q.strike === snappedStrike && inTenor(q))
          .sort((a, b) => Math.abs(a.tenorHours - targetHours) - Math.abs(b.tenorHours - targetHours))[0] ?? null;
        const mk = (q: typeof bull, venue: "bullish" | "deribit"): Anchor =>
          q ? { venue, symbol: q.instrument_name, askUsdcPerBtc: q.askUsdcPerBtc, bidUsdcPerBtc: q.bidUsdcPerBtc, depthWithin2pctBtc: 999, pulledAt } : null;
        const bAnchor = mk(bull, "bullish");
        const dAnchor = mk(der, "deribit");
        const decision = pickLegVenue(bAnchor, dAnchor, contractsBtc);
        legsSnap.push({
          leg: optType, target_strike: targetStrike, snapped_bullish_strike: snappedStrike, snapped: snappedStrike !== targetStrike,
          chosen_venue: decision.chosen?.venue ?? null,
          best_venue: decision.best_venue ?? null,
          partner_preferred: decision.partner_preferred ?? false,
          spread_vs_best_pct: decision.spread_vs_best_pct ?? null,
          candidates: [describe(bAnchor), describe(dAnchor)].filter(Boolean)
        });
      }
      reply.send({
        cell_id: cellId, mode: "snap_to_bullish", spot, contracts_btc: contractsBtc, tenor_days: cell.hedgeTenorDays,
        current_regime: deps.dvolService.getCurrentDvol()?.regime ?? null,
        partner_routing: { partner: partnerVenue, max_spread_pct: maxSpreadPct, active: !!(partnerVenue && maxSpreadPct > 0) },
        legs: legsSnap,
        note: "WHAT-IF ONLY — does NOT change activation. Each leg snapped to Bullish's nearest listed strike; both venues compared at that strike. Shows if aligning cell strikes to Bullish's grid would let Bullish win the round-trip."
      });
      return;
    }

    const legs: Array<Record<string, unknown>> = [];
    for (const [optType, strike] of [["put", putStrike], ["call", callStrike]] as const) {
      const anchors = await deps.anchorProvider.getAnchorForLeg(strike, optType, cell.hedgeTenorDays);
      const decision = pickLegVenue(anchors.bullish, anchors.deribit, contractsBtc);
      legs.push({
        leg: optType, strike,
        chosen_venue: decision.chosen?.venue ?? null,
        reason: decision.reason,
        best_venue: decision.best_venue ?? null,
        partner_preferred: decision.partner_preferred ?? false,
        spread_vs_best_pct: decision.spread_vs_best_pct ?? null,
        candidates: [describe(anchors.bullish), describe(anchors.deribit)].filter(Boolean)
      });
    }
    reply.send({
      cell_id: cellId, mode: "exact_strike", spot, contracts_btc: contractsBtc, tenor_days: cell.hedgeTenorDays,
      current_regime: deps.dvolService.getCurrentDvol()?.regime ?? null,
      partner_routing: { partner: partnerVenue, max_spread_pct: maxSpreadPct, active: !!(partnerVenue && maxSpreadPct > 0) },
      legs,
      note: "Selection ranks by ROUND-TRIP cost (2·ask−bid) since options are venue-locked (buy+sell same venue). Legs are chosen INDEPENDENTLY. Add ?snap_to_bullish=true for the strike-alignment what-if. Regime-independent — valid in calm."
    });
  });

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
    // Regime proximity — heads-up as DVOL nears the next regime boundary (admin widget).
    let regimeProximity: unknown = null;
    try {
      const { computeRegimeProximity } = await import("./regimeProximity");
      const { computeDvolTrend } = await import("./gateHistory");
      regimeProximity = computeRegimeProximity(dvol?.dvol ?? null, { trendDelta: computeDvolTrend(15).delta });
    } catch { /* non-fatal */ }
    reply.send({
      asOf: new Date().toISOString(),
      halt,
      status,
      dvol,
      regime_proximity: regimeProximity,
      feed: feedHealth,
      deferredPool: pool,
      unwindQueue: deps.unwindQueue?.stats() ?? null,
      liquidChainCache: liquidChainStatus,
      env: {
        // live_enabled = the live GATE (SS_TWO_SIDED_LIVE_ENABLED).
        live_enabled: process.env.SS_TWO_SIDED_LIVE_ENABLED === "true",
        // live_execution = the EXECUTOR flag (FOXIFY_V2_LIVE_EXECUTION). These are
        // DIFFERENT: real orders need BOTH. executor_mode shows which executor is
        // actually wired so "live gate on but still paper-trading" can't hide.
        live_execution: isLiveExecutionEnabled(),
        executor_mode: isLiveExecutionEnabled() ? "live" : "shadow",
        foxify_v2_live_execution_raw: process.env.FOXIFY_V2_LIVE_EXECUTION ?? null,
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
