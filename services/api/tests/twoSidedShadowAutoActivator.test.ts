/**
 * Tests for the shadow auto-activator.
 *
 * Covers:
 *   - pickEligibleCell: filters by trigger %, allowlist, enabled flag
 *   - ensureShadowAuditSchema: creates the audit table
 *   - countActivationsInCurrentWindow: counts only "activated" rows in window
 *   - runAutoActivatorTick: decision tree (halt, not-good, not-sustained,
 *     rate-limit, no-eligible-cell, activated)
 *   - readAutoActivatorStatus: surfaces last check + last activation + totals
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  ensureShadowAuditSchema,
  forceShadowActivation,
  pickEligibleCell,
  countActivationsInCurrentWindow,
  runAutoActivatorTick,
  readAutoActivatorConfig,
  readAutoActivatorStatus,
  type AutoActivatorConfig
} from "../src/singleSide/twoSided/shadowAutoActivator";
import { ensureCellAllowlistSchema } from "../src/singleSide/twoSided/cellAllowlist";
import { ensureGuardrailsSchema } from "../src/singleSide/twoSided/guardrails";
import type { DvolService } from "../src/singleSide/twoSided/dvolService";
import type { RvService } from "../src/singleSide/twoSided/rvService";
import type { FeedService } from "../src/singleSide/twoSided/feedService";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import {
  __resetGateHistory as clearHistoryForTesting,
  recordGateSnapshot
} from "../src/singleSide/twoSided/gateHistory";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  // pg-mem doesn't auto-load gen_random_uuid; register a stub. Use `impure: true`
  // so pg-mem doesn't cache the result and reuse the same UUID across inserts.
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  const pool = new (db.adapters.createPg().Pool)();
  // Auxiliary tables the audit refs (two_sided_pair FK) and the halt + allowlist used by tick.
  // pair_id is TEXT in production schema to match existing data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair (
      pair_id TEXT PRIMARY KEY
    );
  `);
  await ensureCellAllowlistSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureShadowAuditSchema(pool);
  return pool;
};

// ─── pickEligibleCell ──────────────────────────────────────────────────────

test("pickEligibleCell returns first recommended cell when all checks pass", () => {
  const picked = pickEligibleCell(
    ["pair_50k_5pct_otm", "pair_25k_5pct_otm_3d"],
    ["pair_50k_5pct_otm", "pair_25k_5pct_otm_3d"],
    0.05
  );
  assert.equal(picked, "pair_50k_5pct_otm");
});

test("pickEligibleCell skips cell when trigger % exceeds max", () => {
  // Force a synthetic >5% trigger by passing maxTriggerPct lower than any registered cell
  const picked = pickEligibleCell(
    ["pair_50k_5pct_otm", "pair_50k_2pct"],
    ["pair_50k_5pct_otm", "pair_50k_2pct"],
    0.025 // < 5% — only pair_50k_2pct (2%) qualifies
  );
  assert.equal(picked, "pair_50k_2pct");
});

test("pickEligibleCell skips disabled cells", () => {
  // pair_25k_5pct_otm_short is deprecated/disabled in cellConfig
  const picked = pickEligibleCell(["pair_25k_5pct_otm_short", "pair_50k_2pct"], ["pair_50k_2pct"], 0.05);
  assert.equal(picked, "pair_50k_2pct");
});

test("pickEligibleCell respects regime allowlist", () => {
  // pair_50k_2pct is in registry but not in our restricted allowlist
  const picked = pickEligibleCell(["pair_50k_2pct", "pair_50k_5pct_otm"], ["pair_50k_5pct_otm"], 0.05);
  assert.equal(picked, "pair_50k_5pct_otm");
});

test("pickEligibleCell empty allowlist allows any registered+enabled cell ≤ maxTriggerPct", () => {
  const picked = pickEligibleCell(["pair_50k_5pct_otm"], [], 0.05);
  assert.equal(picked, "pair_50k_5pct_otm");
});

test("pickEligibleCell returns null when no recommended cell is eligible", () => {
  const picked = pickEligibleCell(["pair_25k_5pct_otm_short", "nonexistent_cell"], ["pair_50k_2pct"], 0.05);
  assert.equal(picked, null);
});

test("pickEligibleCell returns null on empty recommendations", () => {
  assert.equal(pickEligibleCell([], ["pair_50k_2pct"], 0.05), null);
});

// ─── ensureShadowAuditSchema + count ───────────────────────────────────────

test("ensureShadowAuditSchema creates the audit table and indices", async () => {
  const pool = await buildPool();
  // pg-mem's information_schema may have multiple rows; just verify we can SELECT from the table
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_shadow_audit`);
  assert.equal(r.rows[0].n, 0);
});

test("countActivationsInCurrentWindow counts only 'activated' rows in window", async () => {
  const pool = await buildPool();
  const now = Date.now();
  const insertAt = async (offsetMs: number, decision: string) => {
    await pool.query(
      `INSERT INTO two_sided_shadow_audit (
        checked_at, good_to_activate, signal_tier, signal_score,
        recommended_cells, decision
      ) VALUES ($1, TRUE, 'positive', 0.8, '[]'::jsonb, $2)`,
      [new Date(now + offsetMs).toISOString(), decision]
    );
  };
  await insertAt(-30_000, "activated"); // 30s ago — in 60s window
  await insertAt(-50_000, "skipped:rate_limit"); // skip doesn't count
  await insertAt(-80_000, "activated"); // 80s ago — OUT of 60s window
  await insertAt(-10_000, "activated"); // 10s ago — in window
  const n = await countActivationsInCurrentWindow(pool, 60, now);
  assert.equal(n, 2);
});

// ─── runAutoActivatorTick decision tree ────────────────────────────────────

const buildConfig = (overrides: Partial<AutoActivatorConfig> = {}): AutoActivatorConfig => ({
  enabled: true,
  policy: "conservative",
  pollMs: 60_000,
  sustainedGoodSeconds: 60,
  maxPerGoodWindow: 3,
  maxPerDay: 1000, // tests don't care unless explicitly testing the cap
  maxCellTriggerPct: 0.05,
  maxShadowCostUsdc: 100_000,
  ...overrides
});

const stubDvolService = (regime: "calm" | "moderate" | "elevated" | "stress", dvol: number, iv: number): DvolService =>
  ({
    getCurrentDvol: () => ({ regime, dvol, sigmaAnnual: iv, asOfMs: Date.now(), source: "test" })
  }) as unknown as DvolService;

const stubRvService = (rv: number): RvService =>
  ({
    getCurrentRv: () => ({ rvAnnual: rv, barCount: 288, meanSpot: 73_000, asOfMs: Date.now() })
  }) as unknown as RvService;

const stubFeedService: FeedService = ({
  getCurrentFeed: () => null
} as unknown) as FeedService;

const stubAnchorProvider: LiveAnchorProvider = ({} as unknown) as LiveAnchorProvider;

test("runAutoActivatorTick: halt active → skipped:halt", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  // Force atticus halt
  await pool.query(
    `UPDATE two_sided_halt_state SET atticus_halt = TRUE, atticus_halt_reason = 'cost_overrun', atticus_halt_since = NOW()
     WHERE singleton_key = 'singleton'`
  );
  const result = await runAutoActivatorTick({
    pool,
    dvolService: stubDvolService("elevated", 65, 0.55),
    rvService: stubRvService(0.4),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig()
  });
  assert.match(result.decision, /^skipped:halt:/);
});

test("runAutoActivatorTick: gate says not good → skipped:not_good", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const result = await runAutoActivatorTick({
    pool,
    // Calm regime with positive VRP (iv > rv by 1%) → not_good
    dvolService: stubDvolService("calm", 35, 0.35),
    rvService: stubRvService(0.34),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig()
  });
  assert.match(result.decision, /^skipped:not_good:/);
});

test("runAutoActivatorTick: good but not sustained → skipped:not_sustained", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const result = await runAutoActivatorTick({
    pool,
    // Elevated regime → good_to_activate true
    dvolService: stubDvolService("elevated", 65, 0.55),
    rvService: stubRvService(0.4),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ sustainedGoodSeconds: 60 })
  });
  // First tick — only 1 snapshot recorded; consecutiveGoodSeconds <= 0
  assert.equal(result.decision, "skipped:not_sustained");
});

test("runAutoActivatorTick: rate-limited when window already saturated", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  // Pre-seed gate history with sustained good for 5 minutes
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    recordGateSnapshot({ asOfMs: now - (30 - i) * 10_000, vrp: -0.02, goodToActivate: true, regime: "elevated" });
  }
  // Pre-seed audit with maxPerWindow activations in the last minute
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO two_sided_shadow_audit (
        checked_at, good_to_activate, signal_tier, signal_score,
        recommended_cells, decision
      ) VALUES ($1, TRUE, 'positive', 1, '[]'::jsonb, 'activated')`,
      [new Date(now - 30_000 - i * 5_000).toISOString()]
    );
  }
  const result = await runAutoActivatorTick({
    pool,
    dvolService: stubDvolService("elevated", 65, 0.55),
    rvService: stubRvService(0.4),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ sustainedGoodSeconds: 30, maxPerGoodWindow: 3 }),
    nowMs: () => now
  });
  assert.equal(result.decision, "skipped:rate_limit");
});

test("runAutoActivatorTick: happy path — activates via override deps", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const now = Date.now();
  // Sustained-good history
  for (let i = 0; i < 30; i++) {
    recordGateSnapshot({ asOfMs: now - (30 - i) * 10_000, vrp: -0.02, goodToActivate: true, regime: "elevated" });
  }
  // Insert a placeholder two_sided_pair row that activateDepsOverride will return
  const pairId = "11111111-1111-4111-8111-111111111111";
  await pool.query(`INSERT INTO two_sided_pair (pair_id) VALUES ($1)`, [pairId]);
  const result = await runAutoActivatorTick({
    pool,
    dvolService: stubDvolService("elevated", 65, 0.55),
    rvService: stubRvService(0.4),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ sustainedGoodSeconds: 30 }),
    nowMs: () => now,
    activateDepsOverride: () => ({
      pool,
      anchorProvider: stubAnchorProvider,
      executor: { executeStrangle: async () => ({ ok: true, putLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() }, callLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() } }) } as unknown as import("../src/singleSide/twoSided/executor").StrangleExecutor,
      getFeed: () => null,
      feedVersion: "test",
      nowMs: () => now,
      liquidChainCache: null,
      getCurrentRegime: () => "elevated"
    })
  });
  // The actual handleActivate may not reach 201 in our minimal stub (no feed), so we accept either activated or skipped:activate_failed
  // What we're really testing: the gate passed all checks and reached the activation step
  assert.ok(
    result.decision === "activated" || result.decision.startsWith("skipped:activate_failed") || result.decision === "skipped:activate_error",
    `expected activation attempt, got: ${result.decision}`
  );
  assert.ok(result.chosen_cell_id !== null, "should have picked a cell before attempting to activate");
});

// ─── readAutoActivatorStatus ───────────────────────────────────────────────

test("readAutoActivatorStatus returns config, last check, last activation, totals", async () => {
  const pool = await buildPool();
  const cfg = buildConfig({ enabled: false });
  const status = await readAutoActivatorStatus(pool, cfg);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.config, cfg);
  assert.equal(status.last_check, null);
  assert.equal(status.last_activation, null);
  assert.equal(status.totals.last_24h, 0);
  assert.equal(status.totals.activations_last_24h, 0);
});

test("readAutoActivatorStatus surfaces recent audit rows in DESC order", async () => {
  const pool = await buildPool();
  const cfg = buildConfig();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO two_sided_shadow_audit (
        checked_at, good_to_activate, signal_tier, signal_score,
        recommended_cells, decision
      ) VALUES ($1, FALSE, 'slightly_negative', $2, '[]'::jsonb, 'skipped:not_good')`,
      [new Date(now - i * 1000).toISOString(), -0.1 * i]
    );
  }
  const status = await readAutoActivatorStatus(pool, cfg, 3);
  assert.equal(status.recent_audit.length, 3);
  // most recent first
  assert.ok(status.recent_audit[0].checked_at >= status.recent_audit[1].checked_at);
  assert.equal(status.totals.last_24h, 5);
});

// ─── Config reader ─────────────────────────────────────────────────────────

test("readAutoActivatorConfig defaults to disabled when env unset", () => {
  const cfg = readAutoActivatorConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pollMs, 60_000);
  assert.equal(cfg.sustainedGoodSeconds, 60);
  assert.equal(cfg.maxPerGoodWindow, 3);
  assert.equal(cfg.maxCellTriggerPct, 0.05);
});

test("readAutoActivatorConfig: SHADOW_AUTO_ACTIVATE=true enables", () => {
  const cfg = readAutoActivatorConfig({ SHADOW_AUTO_ACTIVATE: "true" });
  assert.equal(cfg.enabled, true);
});

// ─── forceShadowActivation (test-fire bypass) ──────────────────────────────

test("forceShadowActivation: respects halt by default", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  await pool.query(
    `UPDATE two_sided_halt_state SET atticus_halt = TRUE, atticus_halt_reason = 'cost_overrun', atticus_halt_since = NOW()
     WHERE singleton_key = 'singleton'`
  );
  const result = await forceShadowActivation({
    pool,
    dvolService: stubDvolService("calm", 35, 0.35),
    rvService: stubRvService(0.35),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig()
  });
  assert.match(result.decision, /^test_skipped:halt:/);
});

test("forceShadowActivation: ignore_halt=true overrides halt check", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  await pool.query(
    `UPDATE two_sided_halt_state SET atticus_halt = TRUE, atticus_halt_reason = 'manual', atticus_halt_since = NOW()
     WHERE singleton_key = 'singleton'`
  );
  const result = await forceShadowActivation(
    {
      pool,
      dvolService: stubDvolService("calm", 35, 0.35),
      rvService: stubRvService(0.35),
      feedService: stubFeedService,
      liquidChainCache: null,
      anchorProvider: stubAnchorProvider,
      config: buildConfig(),
      activateDepsOverride: () => ({
        pool,
        anchorProvider: stubAnchorProvider,
        executor: { executeStrangle: async () => ({ ok: true, putLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() }, callLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() } }) } as unknown as import("../src/singleSide/twoSided/executor").StrangleExecutor,
        getFeed: () => null,
        feedVersion: "test",
        nowMs: () => Date.now(),
        liquidChainCache: null,
        getCurrentRegime: () => "calm"
      })
    },
    { ignoreHalt: true }
  );
  // halt skipped; should proceed past halt check (will fail activate due to no feed, but past halt)
  assert.ok(!/^test_skipped:halt:/.test(result.decision), `should not be halt-skipped, got: ${result.decision}`);
});

test("forceShadowActivation: rejects unknown cell", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const result = await forceShadowActivation(
    {
      pool,
      dvolService: stubDvolService("calm", 35, 0.35),
      rvService: stubRvService(0.35),
      feedService: stubFeedService,
      liquidChainCache: null,
      anchorProvider: stubAnchorProvider,
      config: buildConfig()
    },
    { cellId: "nonexistent_cell" }
  );
  assert.match(result.decision, /^test_skipped:invalid_cell:/);
});

test("forceShadowActivation: rejects disabled cell", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  // pair_25k_5pct_otm_short is deprecated/disabled in cellConfig
  const result = await forceShadowActivation(
    {
      pool,
      dvolService: stubDvolService("calm", 35, 0.35),
      rvService: stubRvService(0.35),
      feedService: stubFeedService,
      liquidChainCache: null,
      anchorProvider: stubAnchorProvider,
      config: buildConfig()
    },
    { cellId: "pair_25k_5pct_otm_short" }
  );
  assert.match(result.decision, /^test_skipped:invalid_cell:/);
});

test("forceShadowActivation: auto-picks a cell when none specified, even in calm regime", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  // In calm, gate.recommended_cells is [] — auto-picker should fall back to registry scan
  const result = await forceShadowActivation(
    {
      pool,
      dvolService: stubDvolService("calm", 35, 0.35),
      rvService: stubRvService(0.35),
      feedService: stubFeedService,
      liquidChainCache: null,
      anchorProvider: stubAnchorProvider,
      config: buildConfig(),
      activateDepsOverride: () => ({
        pool,
        anchorProvider: stubAnchorProvider,
        executor: { executeStrangle: async () => ({ ok: true, putLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() }, callLeg: { filledAskUsdcPerBtc: 500, filledAtIso: new Date().toISOString() } }) } as unknown as import("../src/singleSide/twoSided/executor").StrangleExecutor,
        getFeed: () => null,
        feedVersion: "test",
        nowMs: () => Date.now(),
        liquidChainCache: null,
        getCurrentRegime: () => "calm"
      })
    }
  );
  // Should have picked a cell — won't be no_eligible_cell
  assert.ok(!/no_eligible_cell/.test(result.decision), `should have picked a cell, got: ${result.decision}`);
  assert.ok(result.chosen_cell_id !== null, "should have auto-picked a cell");
});

test("readAutoActivatorConfig: env overrides win", () => {
  const cfg = readAutoActivatorConfig({
    SHADOW_AUTO_ACTIVATE: "true",
    SHADOW_AUTO_POLL_MS: "30000",
    SHADOW_AUTO_SUSTAINED_SEC: "120",
    SHADOW_AUTO_MAX_PER_WINDOW: "5",
    SHADOW_AUTO_MAX_CELL_TRIGGER_PCT: "0.03",
    SHADOW_AUTO_MAX_COST_USDC: "50000"
  });
  assert.equal(cfg.pollMs, 30_000);
  assert.equal(cfg.sustainedGoodSeconds, 120);
  assert.equal(cfg.maxPerGoodWindow, 5);
  assert.equal(cfg.maxCellTriggerPct, 0.03);
  assert.equal(cfg.maxShadowCostUsdc, 50_000);
});

// ─── Policy ───────────────────────────────────────────────────────────────

test("readAutoActivatorConfig: policy defaults to conservative", () => {
  const cfg = readAutoActivatorConfig({});
  assert.equal(cfg.policy, "conservative");
});

test("readAutoActivatorConfig: SHADOW_AUTO_POLICY=opportunistic sets policy", () => {
  const cfg = readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "opportunistic" });
  assert.equal(cfg.policy, "opportunistic");
});

test("readAutoActivatorConfig: SHADOW_AUTO_POLICY=hybrid sets policy", () => {
  const cfg = readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "hybrid" });
  assert.equal(cfg.policy, "hybrid");
});

test("readAutoActivatorConfig: SHADOW_AUTO_POLICY case-insensitive + trim", () => {
  assert.equal(readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "  OPPORTUNISTIC  " }).policy, "opportunistic");
  assert.equal(readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "Hybrid" }).policy, "hybrid");
});

test("readAutoActivatorConfig: invalid SHADOW_AUTO_POLICY falls back to conservative", () => {
  assert.equal(readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "garbage" }).policy, "conservative");
  assert.equal(readAutoActivatorConfig({ SHADOW_AUTO_POLICY: "" }).policy, "conservative");
});

test("runAutoActivatorTick: conservative policy skips when global signal WAIT", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const result = await runAutoActivatorTick({
    pool,
    dvolService: stubDvolService("calm", 35, 0.35),
    rvService: stubRvService(0.34), // VRP positive, signal WAIT
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ policy: "conservative" })
  });
  assert.match(result.decision, /^skipped:not_good:/);
});

test("runAutoActivatorTick: daily cap (maxPerDay) blocks further activations", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  // Pre-seed 10 'activated' rows TODAY in the audit table
  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 10; i++) {
    await pool.query(
      `INSERT INTO two_sided_shadow_audit (
        checked_at, good_to_activate, signal_tier, signal_score,
        recommended_cells, decision
      ) VALUES ($1, TRUE, 'positive', 1, '[]'::jsonb, 'activated')`,
      [new Date(dayStart.getTime() + i * 60_000).toISOString()]
    );
  }
  // Pre-seed sustained-good history so we'd otherwise proceed
  for (let i = 0; i < 30; i++) {
    recordGateSnapshot({ asOfMs: now - (30 - i) * 10_000, vrp: -0.02, goodToActivate: true, regime: "elevated" });
  }
  const result = await runAutoActivatorTick({
    pool,
    dvolService: stubDvolService("elevated", 65, 0.55),
    rvService: stubRvService(0.4),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ policy: "conservative", maxPerDay: 10, sustainedGoodSeconds: 30 }),
    nowMs: () => now
  });
  assert.equal(result.decision, "skipped:daily_cap");
});

test("runAutoActivatorTick: conservative policy proceeds when global signal GO", async () => {
  const pool = await buildPool();
  clearHistoryForTesting();
  const result = await runAutoActivatorTick({
    pool,
    // moderate regime → always good_to_activate
    dvolService: stubDvolService("moderate", 50, 0.50),
    rvService: stubRvService(0.40),
    feedService: stubFeedService,
    liquidChainCache: null,
    anchorProvider: stubAnchorProvider,
    config: buildConfig({ policy: "conservative" })
  });
  // First-tick — no sustained history — will skip with not_sustained
  assert.equal(result.decision, "skipped:not_sustained");
});
