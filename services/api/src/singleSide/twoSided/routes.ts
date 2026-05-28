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
      reply.send({
        good_to_activate: Boolean(good),
        regime: dvol?.regime ?? null,
        dvol: dvol?.dvol ?? null,
        iv_annual: dvol?.sigmaAnnual ?? null,
        rv_annual: null,
        vrp: null,
        vrp_threshold_for_calm: -0.02,
        reason: haltActive
          ? `halt_active:${halt.atticusHalt ? "atticus" : "foxify"}:${halt.atticusHaltReason ?? halt.foxifyHaltReason ?? "unknown"}`
          : dvol?.regime === "calm"
            ? "calm_regime_default_halt_rv_service_not_configured"
            : dvol?.regime
              ? `regime_${dvol.regime}_positive_ev`
              : "dvol_unavailable",
        recommended_cells: [],
        next_check_signal: "regime_change_or_rv_service_enabled",
        asOf: new Date().toISOString()
      });
      return;
    }
    const { computeActivationGate } = await import("./activationGate");
    const result = await computeActivationGate({
      dvolService: deps.dvolService,
      rvService: deps.rvService,
      liquidChainCache: deps.liquidChainCache ?? null
    });
    // Overlay halt state — even if gate says good, if halt is active, block
    const halt = await getHaltState(deps.pool);
    if (halt.foxifyHalt || halt.atticusHalt) {
      reply.send({
        ...result,
        good_to_activate: false,
        reason: `halt_active:${halt.atticusHalt ? "atticus" : "foxify"}:${halt.atticusHaltReason ?? halt.foxifyHaltReason ?? "unknown"}`,
        recommended_cells: []
      });
      return;
    }
    reply.send(result);
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
            foxify_ev: evSim.meanFoxifyEv,
            atticus_ev: evSim.meanAtticusEv,
            pct_profit: evSim.pctProfit,
            p5_foxify_ev: evSim.p5FoxifyEv,
            n_paths: evSim.nPaths,
            path_generator: evSim.pathGenerator,
            bars_source: evSim.barsSource,
            bars_count: evSim.barsCount
          },
          ev_verdict: evSim.meanFoxifyEv > 100 ? "✅ PROFITABLE" :
                      evSim.meanFoxifyEv > 0 ? "⚠️ MARGINAL_POSITIVE" :
                      evSim.meanFoxifyEv > -100 ? "⚠️ MARGINAL_NEGATIVE" :
                      "❌ NEGATIVE"
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
        gate_logic: "good_to_activate=true when regime in {moderate, elevated, stress} OR (regime=calm AND vrp < calmVrpThreshold). Halt overrides."
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
