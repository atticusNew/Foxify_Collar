/**
 * Perp Protect route — end-to-end through the real Fastify handler (pg-mem + synthetic feed).
 *
 * Validates the USD-NOTIONAL sizing path (size_usd → size_btc at mark) and the admin-only
 * surfaces (venues_used, price_competitiveness gate). Venue probes hit the network and may return
 * nothing offline → we assert on the position math (deterministic from inputs + mark) and the
 * payload shape, NOT on specific option prices.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import { ensureDeferredPoolSchema } from "../src/singleSide/twoSided/deferredPool";
import { ensureNewbornReviewSchema } from "../src/singleSide/twoSided/featureFlag";
import { registerFoxifyV2Routes } from "../src/singleSide/twoSided/routes";
import { FeedService } from "../src/singleSide/twoSided/feedService";
import { DvolService } from "../src/singleSide/twoSided/dvolService";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const ADMIN_TOKEN = "pp-admin-token-abc";
const DEMO_TOKEN = "pp-demo-token-xyz";
const MARK = 76_000;

const buildApp = async (): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.SS_DEMO_READONLY_TOKEN = DEMO_TOKEN;
  process.env.PERP_PROTECT_BYBIT_CHECK = "false"; // don't hit Bybit in the harness

  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureCellAllowlistSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureDeferredPoolSchema(pool);
  await ensureNewbornReviewSchema(pool);

  const feedService = new FeedService({
    pollOverride: async ({ nowMs }) => ({
      samples: [
        { source: "deribit", price: MARK, ts: nowMs },
        { source: "coinbase", price: MARK + 1, ts: nowMs },
        { source: "kraken", price: MARK - 1, ts: nowMs }
      ],
      attempted: 3, succeeded: 3,
      perSourceStatus: { deribit: "ok", coinbase: "ok", kraken: "ok" },
      pollLatencyMs: 5
    }),
    log: () => {}
  });
  await feedService.start();
  const dvolService = new DvolService({ fetchOverride: async () => 50.0, log: () => {} });
  await dvolService.tick();
  const anchorProvider: LiveAnchorProvider = { getAnchorForLeg: async () => ({ bullish: null, deribit: null }) };

  const app = Fastify({ logger: false });
  await app.register(registerFoxifyV2Routes, { pool, feedService, dvolService, anchorProvider, executor: new MockStrangleExecutor() });
  await app.ready();
  return { app, cleanup: async () => { feedService.stop(); dvolService.stop(); await app.close(); } };
};

test("perp-protect: size_usd is treated as USD notional (size_btc = size_usd / mark)", { timeout: 30_000 }, async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/perp-protect/quote",
      headers: { "x-demo-token": DEMO_TOKEN },
      payload: { side: "long", size_usd: 38_000, leverage: 10, tenor_days: 3, entry_price: MARK }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    // 38,000 USD notional at a 76,000 mark → 0.5 BTC; margin = notional / leverage.
    assert.equal(body.position.size_btc, 0.5);
    assert.equal(body.position.notional_usdc, 38_000);
    assert.equal(body.position.margin_usdc, 3_800);
    assert.ok(Array.isArray(body.options));
    // Trader (demo) payload must NOT carry internal diagnostics.
    assert.equal(body.price_competitiveness, undefined);
    assert.equal(body.venues_used, undefined);
    assert.equal(body.venues_considered, undefined);
    assert.equal(body.bybit_benchmark, undefined);
  } finally { await cleanup(); }
});

test("perp-protect: size_btc still works (back-compat) and admin sees venues_used", { timeout: 30_000 }, async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/perp-protect/quote",
      headers: { "x-admin-token": ADMIN_TOKEN },
      payload: { side: "short", size_btc: 0.25, leverage: 5, tenor_days: 1, entry_price: MARK }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.position.size_btc, 0.25);
    assert.equal(body.position.notional_usdc, 0.25 * MARK);
    // Admin payload includes the coverage surfaces (arrays; may be empty offline).
    assert.ok(Array.isArray(body.venues_used));
    assert.ok(Array.isArray(body.venues_considered));
  } finally { await cleanup(); }
});

test("perp-protect/spot: lightweight live mark from the feed (no venue probes)", { timeout: 30_000 }, async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "GET",
      url: "/admin/foxify/v2/perp-protect/spot",
      headers: { "x-demo-token": DEMO_TOKEN }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.spot, MARK);
    assert.ok(typeof body.as_of === "string");
  } finally { await cleanup(); }
});

test("perp-protect: rejects when neither size_usd nor size_btc is positive", { timeout: 30_000 }, async () => {
  const { app, cleanup } = await buildApp();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/admin/foxify/v2/perp-protect/quote",
      headers: { "x-demo-token": DEMO_TOKEN },
      payload: { side: "long", leverage: 10, tenor_days: 3, entry_price: MARK }
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, "invalid_request");
  } finally { await cleanup(); }
});
