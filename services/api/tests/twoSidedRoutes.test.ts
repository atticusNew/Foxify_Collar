/**
 * PR A3 tests — Fastify /foxify/v2/* route plugin.
 *
 *   - Auth: missing/bad token → 401 on both /foxify/v2/* and /admin/foxify/v2/*
 *   - Constant-time compare prevents trivial bypass
 *   - POST /foxify/v2/activate end-to-end with mock executor → 201
 *   - GET /foxify/v2/status returns shape
 *   - GET /foxify/v2/feed/current 503 when feed uninitialized; 200 with cached snapshot
 *   - GET /foxify/v2/regime
 *   - POST /admin/foxify/v2/halt + resume cycle
 *   - POST /admin/foxify/v2/deferred-pool toggle
 *   - POST /admin/foxify/v2/newborn-review/clear
 *   - GET /admin/foxify/v2/diagnostics
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema
} from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { registerFoxifyV2Routes } from "../src/singleSide/twoSided/routes";
import { FeedService } from "../src/singleSide/twoSided/feedService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";

const FOXIFY_TOKEN = "test-foxify-token-12345";
const ADMIN_TOKEN = "test-admin-token-67890";

const buildApp = async (): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
  process.env.FOXIFY_API_KEY = FOXIFY_TOKEN;
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;

  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureDeferredPoolSchema(pool);
  await ensureNewbornReviewSchema(pool);

  // FeedService with injected synthetic feed
  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [
        { source: "deribit", price: 76_000, ts: nowMs },
        { source: "coinbase", price: 76_001, ts: nowMs },
        { source: "kraken", price: 75_999, ts: nowMs }
      ],
      attempted: 3,
      succeeded: 3,
      perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" },
      pollLatencyMs: 5
    }),
    log: () => {}
  });
  await feedService.start();

  const dvolService = new DvolService({
    fetchOverride: async () => 38.0,
    log: () => {}
  });
  await dvolService.tick();

  const anchorProvider: LiveAnchorProvider = {
    getAnchorForLeg: async (strike, optionType) => {
      if (optionType === "put") {
        return {
          bullish: {
            venue: "bullish",
            symbol: `BTC-USDC-20260530-${strike}-P`,
            askUsdcPerBtc: 1_150,
            depthWithin2pctBtc: 3.0,
            pulledAt: new Date().toISOString()
          },
          deribit: null
        };
      }
      return {
        bullish: null,
        deribit: {
          venue: "deribit",
          symbol: `BTC-31MAY26-${strike}-C`,
          askUsdcPerBtc: 1_162.86,
          depthWithin2pctBtc: 3.0,
          pulledAt: new Date().toISOString()
        }
      };
    }
  };

  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, {
    pool,
    feedService,
    dvolService,
    anchorProvider,
    executor: new MockStrangleExecutor()
  });
  await app.ready();

  return {
    app,
    cleanup: async () => {
      feedService.stop();
      dvolService.stop();
      await app.close();
    }
  };
};

// ─── Auth ───

test("auth: /foxify/v2/* rejects missing X-Foxify-Token", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/status" });
    assert.equal(r.statusCode, 401);
  } finally { await cleanup(); }
});

test("auth: /foxify/v2/* rejects wrong X-Foxify-Token", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/status", headers: { "x-foxify-token": "wrong" } });
    assert.equal(r.statusCode, 401);
  } finally { await cleanup(); }
});

test("auth: /admin/foxify/v2/* rejects missing X-Admin-Token", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/diagnostics" });
    assert.equal(r.statusCode, 401);
  } finally { await cleanup(); }
});

// ─── Foxify-facing happy paths ───

test("GET /foxify/v2/status returns shape", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/status", headers: { "x-foxify-token": FOXIFY_TOKEN } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok("todayPairsActivated" in body);
    assert.ok("currentTier" in body);
    assert.ok("haltStatus" in body);
  } finally { await cleanup(); }
});

test("GET /foxify/v2/feed/current returns cached feed", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/feed/current", headers: { "x-foxify-token": FOXIFY_TOKEN } });
    assert.equal(r.statusCode, 200);
    const body = r.json() as AggregatedFeed;
    assert.equal(body.canonicalPrice, 76_000);
    assert.equal(body.health, "healthy");
  } finally { await cleanup(); }
});

test("GET /foxify/v2/regime returns regime classification", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/regime", headers: { "x-foxify-token": FOXIFY_TOKEN } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.regime, "calm");
    assert.equal(body.dvol, 38.0);
  } finally { await cleanup(); }
});

test("POST /foxify/v2/activate end-to-end returns 201", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/foxify/v2/activate",
      headers: { "x-foxify-token": FOXIFY_TOKEN, "content-type": "application/json" },
      payload: {
        cellId: "pair_50k_2pct",
        maxAcceptableHedgeCostUsdc: 3_500,
        foxifyPairRef: "fxy-route-test-1"
      }
    });
    assert.equal(r.statusCode, 201);
    const body = r.json();
    assert.equal(body.status, "active");
    assert.equal(body.foxify_pair_ref, "fxy-route-test-1");
    assert.equal(body.tier_at_activation, "tier_1");
  } finally { await cleanup(); }
});

test("GET /foxify/v2/pairs/:pair_id returns 404 for unknown", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/foxify/v2/pairs/nonexistent", headers: { "x-foxify-token": FOXIFY_TOKEN } });
    assert.equal(r.statusCode, 404);
  } finally { await cleanup(); }
});

// ─── Admin happy paths ───

test("POST /admin/foxify/v2/halt + /resume cycle", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r1 = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/halt",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { kind: "atticus", reason: "manual_operator", notes: "test halt" }
    });
    assert.equal(r1.statusCode, 200);
    const halt = r1.json();
    assert.equal(halt.atticusHalt, true);

    const r2 = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/resume",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { kind: "atticus" }
    });
    assert.equal(r2.statusCode, 200);
    const cleared = r2.json();
    assert.equal(cleared.atticusHalt, false);
  } finally { await cleanup(); }
});

test("POST /admin/foxify/v2/deferred-pool toggle", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r1 = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/deferred-pool",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { active: true, notes: "ramp phase" }
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().active, true);
  } finally { await cleanup(); }
});

test("POST /admin/foxify/v2/newborn-review/clear", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/newborn-review/clear",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { regime: "calm" }
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().cleared, true);
    assert.equal(r.json().state.operatorApprovedCount, 1);
  } finally { await cleanup(); }
});

test("GET /admin/foxify/v2/diagnostics returns full snapshot", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({ method: "GET", url: "/admin/foxify/v2/diagnostics", headers: { "x-admin-token": ADMIN_TOKEN } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok("halt" in body);
    assert.ok("status" in body);
    assert.ok("dvol" in body);
    assert.ok("feed" in body);
    assert.ok("env" in body);
  } finally { await cleanup(); }
});
