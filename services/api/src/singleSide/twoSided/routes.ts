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
    getFeed: () => deps.feedService.getCurrentFeed(),
    feedVersion: "v1.0.0",
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
    reply.send({
      asOf: new Date().toISOString(),
      halt,
      status,
      dvol,
      feed: feedHealth,
      deferredPool: pool,
      unwindQueue: deps.unwindQueue?.stats() ?? null,
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
};
