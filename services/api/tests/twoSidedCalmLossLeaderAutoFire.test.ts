/**
 * Calm loss-leader AUTO-FIRE (Phase 3 wiring).
 *
 * The shadow auto-loop now autonomously fires budget-eligible loss-leader cells
 * in calm when SS_TWO_SIDED_CALM_LOSS_LEADER=true — turning the calm_loss_leader
 * signal from "capable" into "actually generating (shadow) volume".
 *
 * Verifies: branch routing (taken only in calm + loss-leader on), primary-first
 * cell ordering, per-pair budget enforcement (over-budget → skip), calm-shadow
 * suppression, and the daily cap. No live Bullish/Deribit — anchors are stubbed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runAutoActivatorTick, type AutoActivatorConfig } from "../src/singleSide/twoSided/shadowAutoActivator";
import { ensureTwoSidedSchema } from "../src/singleSide/twoSided/db";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import { ensureShadowAuditSchema } from "../src/singleSide/twoSided/shadowAutoActivator";
import { CALM_LOSS_LEADER_CELLS } from "../src/singleSide/twoSided/cellConfig";
import type { DvolService } from "../src/singleSide/twoSided/dvolService";
import type { RvService } from "../src/singleSide/twoSided/rvService";
import type { FeedService } from "../src/singleSide/twoSided/feedService";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);     // creates two_sided_pair (+ legs/events) used by activation
  await ensureCellAllowlistSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureShadowAuditSchema(pool);
  return pool;
};

const buildConfig = (overrides: Partial<AutoActivatorConfig> = {}): AutoActivatorConfig => ({
  enabled: true,
  policy: "conservative",
  pollMs: 60_000,
  sustainedGoodSeconds: 60,
  maxPerGoodWindow: 3,
  maxPerDay: 1000,
  maxCellTriggerPct: 0.05,
  maxShadowCostUsdc: 1_000_000,
  ...overrides
});

const stubDvol = (): DvolService =>
  ({ getCurrentDvol: () => ({ regime: "calm", dvol: 35, sigmaAnnual: 0.35, asOfMs: Date.now() }) }) as unknown as DvolService;
const stubRv = (): RvService =>
  ({ getCurrentRv: () => ({ rvAnnual: 0.34, barCount: 288, meanSpot: 76_000, asOfMs: Date.now() }) }) as unknown as RvService;

const makeFeed = (price = 76_000): AggregatedFeed => ({
  canonicalPrice: price, asOfMs: Date.now(),
  sources: [{ source: "deribit", price, ts: Date.now() }, { source: "bullish", price: price + 1, ts: Date.now() }],
  rejected: [], expired: [], health: "healthy", medianCalcDescription: `median=${price}`
});
const stubFeed = (price = 76_000): FeedService => ({ getCurrentFeed: () => makeFeed(price) }) as unknown as FeedService;

// Anchors: each leg ~$1,150/btc ask → 25k/76k ≈ 0.329 BTC → premium ≈ $757 total.
const anchorProvider: LiveAnchorProvider = {
  getAnchorForLeg: async (strike, optionType) => optionType === "put"
    ? { bullish: null, deribit: { venue: "deribit", symbol: `BTC-${strike}-P`, askUsdcPerBtc: 1_150, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() } }
    : { bullish: null, deribit: { venue: "deribit", symbol: `BTC-${strike}-C`, askUsdcPerBtc: 1_160, depthWithin2pctBtc: 5.0, pulledAt: new Date().toISOString() } }
};

const baseDeps = (pool: Pool, now: number) => ({
  pool,
  dvolService: stubDvol(),
  rvService: stubRv(),
  feedService: stubFeed(),
  liquidChainCache: null,
  anchorProvider,
  config: buildConfig(),
  nowMs: () => now
});

const withLossLeader = async (
  env: { enabled?: boolean; maxLoss?: string; allowShadow?: string },
  fn: () => Promise<void>
) => {
  const prev = {
    ll: process.env.SS_TWO_SIDED_CALM_LOSS_LEADER,
    max: process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC,
    shadow: process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW,
    allow: process.env.SS_TWO_SIDED_ALLOW_CALM
  };
  delete process.env.SS_TWO_SIDED_ALLOW_CALM; // never blanket-allow in these tests
  if (env.enabled === undefined) delete process.env.SS_TWO_SIDED_CALM_LOSS_LEADER;
  else process.env.SS_TWO_SIDED_CALM_LOSS_LEADER = env.enabled ? "true" : "false";
  if (env.maxLoss === undefined) delete process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC;
  else process.env.SS_TWO_SIDED_CALM_MAX_LOSS_USDC = env.maxLoss;
  if (env.allowShadow === undefined) delete process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW;
  else process.env.SS_TWO_SIDED_ALLOW_CALM_SHADOW = env.allowShadow;
  try { await fn(); } finally {
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore("SS_TWO_SIDED_CALM_LOSS_LEADER", prev.ll);
    restore("SS_TWO_SIDED_CALM_MAX_LOSS_USDC", prev.max);
    restore("SS_TWO_SIDED_ALLOW_CALM_SHADOW", prev.shadow);
    restore("SS_TWO_SIDED_ALLOW_CALM", prev.allow);
  }
};

test("auto-fire: loss-leader ON in calm → fires the 2d PRIMARY cell within budget", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await withLossLeader({ enabled: true, maxLoss: "5000" }, async () => {
    const r = await runAutoActivatorTick(baseDeps(pool, now));
    assert.equal(r.decision, "activated", `expected activated, got ${r.decision}`);
    assert.equal(r.chosen_cell_id, CALM_LOSS_LEADER_CELLS[0], "fires the primary (2d) cell first");
    assert.ok(r.pair_id, "wrote a pair");
  });
});

test("auto-fire: premium over budget → skipped:loss_leader_over_budget (tries both, none fit)", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Premium ~$757 >> $50 budget → both candidates rejected by the handler's budget gate.
  await withLossLeader({ enabled: true, maxLoss: "50" }, async () => {
    const r = await runAutoActivatorTick(baseDeps(pool, now));
    assert.equal(r.decision, "skipped:loss_leader_over_budget", `got ${r.decision}`);
    // Last attempted candidate is the cheaper fallback (1d).
    assert.equal(r.chosen_cell_id, CALM_LOSS_LEADER_CELLS[CALM_LOSS_LEADER_CELLS.length - 1]);
  });
});

test("auto-fire: loss-leader OFF in calm → normal stand-down (skipped:not_good), branch NOT taken", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await withLossLeader({ enabled: false }, async () => {
    const r = await runAutoActivatorTick(baseDeps(pool, now));
    assert.match(r.decision, /^skipped:not_good/, `got ${r.decision}`);
  });
});

test("auto-fire: calm-shadow suppressed (SS_TWO_SIDED_ALLOW_CALM_SHADOW=false) → skipped:calm_disabled", async () => {
  const pool = await buildPool();
  const now = Date.now();
  await withLossLeader({ enabled: true, maxLoss: "5000", allowShadow: "false" }, async () => {
    const r = await runAutoActivatorTick(baseDeps(pool, now));
    assert.equal(r.decision, "skipped:calm_disabled");
  });
});

test("auto-fire: daily cap reached → skipped:daily_cap", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Pre-seed 2 'activated' rows today; cap at 2.
  for (let i = 0; i < 2; i++) {
    await pool.query(
      `INSERT INTO two_sided_shadow_audit (checked_at, good_to_activate, signal_tier, signal_score, recommended_cells, decision)
       VALUES ($1, FALSE, 'stand_down', 0, '[]'::jsonb, 'activated')`,
      [new Date(now - i * 1000).toISOString()]
    );
  }
  await withLossLeader({ enabled: true, maxLoss: "5000" }, async () => {
    const deps = { ...baseDeps(pool, now), config: buildConfig({ maxPerDay: 2 }) };
    const r = await runAutoActivatorTick(deps);
    assert.equal(r.decision, "skipped:daily_cap");
  });
});
