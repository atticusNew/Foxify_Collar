/**
 * PR C4 tests — cell-allowlist admin endpoints.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import { registerFoxifyV2Routes } from "../src/singleSide/twoSided/routes";
import { FeedService } from "../src/singleSide/twoSided/feedService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const ADMIN_TOKEN = "test-admin-c4";

const buildApp = async (): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
  process.env.FOXIFY_API_KEY = "test-foxify-c4";
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureDeferredPoolSchema(pool);
  await ensureNewbornReviewSchema(pool);
  await ensureCellAllowlistSchema(pool);

  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [{ source: "deribit", price: 75_000, ts: nowMs }],
      attempted: 1, succeeded: 1, perSourceStatus: { deribit: "ok" }, pollLatencyMs: 1
    }),
    log: () => {}
  });
  await feedService.tick();
  const dvolService = new DvolService({ fetchOverride: async () => 38, log: () => {} });
  await dvolService.tick();
  const anchorProvider: LiveAnchorProvider = {
    getAnchorForLeg: async () => ({ bullish: null, deribit: null })
  };
  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, {
    pool, feedService, dvolService, anchorProvider, executor: new MockStrangleExecutor()
  });
  await app.ready();
  return { app, cleanup: async () => { feedService.stop(); dvolService.stop(); await app.close(); } };
};

test("POST /admin/foxify/v2/cell-allowlist: enable cell in regime", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/cell-allowlist",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { regime: "stress", cell_id: "pair_50k_2pct", enabled: true, reason: "test" }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.regime, "stress");
    assert.equal(body.cell_id, "pair_50k_2pct");
    assert.equal(body.enabled, true);
    assert.ok(body.effective_allowlist.includes("pair_50k_2pct"));
  } finally { await cleanup(); }
});

test("POST cell-allowlist: rejects invalid regime", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/cell-allowlist",
      headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
      payload: { regime: "extreme", cell_id: "x", enabled: true }
    });
    assert.equal(r.statusCode, 400);
  } finally { await cleanup(); }
});

test("GET /admin/foxify/v2/cell-allowlist: returns full per-regime payload", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/cell-allowlist",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.ok(body.calm);
    assert.ok(body.calm.default_allowlist);
    assert.ok(body.calm.effective_allowlist);
    assert.ok(body.stress);
    assert.ok(Array.isArray(body.overrides));
  } finally { await cleanup(); }
});

test("GET cell-allowlist with regime query: returns single regime details", async () => {
  const { app, cleanup } = await buildApp();
  try {
    // Query moderate (which has cells in default per V3 sweep), since calm is now empty.
    const r = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/cell-allowlist?regime=moderate",
      headers: { "x-admin-token": ADMIN_TOKEN }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.regime, "moderate");
    assert.ok(body.default_allowlist.includes("pair_25k_5pct_otm_3d"));
  } finally { await cleanup(); }
});

test("POST cell-allowlist: requires admin token", async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/cell-allowlist",
      payload: { regime: "calm", cell_id: "x", enabled: true }
    });
    assert.equal(r.statusCode, 401);
  } finally { await cleanup(); }
});
