/**
 * Tests for shadowAutoTpHandler — auto-closes shadow pairs on TP threshold.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ShadowAutoTpHandler, readAutoTpConfig } from "../src/singleSide/twoSided/shadowAutoTpHandler";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  const pool = new (db.adapters.createPg().Pool)();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair (
      pair_id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      status TEXT NOT NULL,
      foxify_pair_ref TEXT NOT NULL DEFAULT '',
      spot_at_activation NUMERIC NOT NULL,
      feed_snapshot_at_activation JSONB DEFAULT '{}',
      trigger_down_price NUMERIC NOT NULL,
      trigger_up_price NUMERIC NOT NULL,
      hedge_tenor_days NUMERIC NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ NOT NULL,
      tp_force_exit_at TIMESTAMPTZ,
      hedge_cost_total_usdc NUMERIC NOT NULL,
      foxify_capital_funded_usdc NUMERIC DEFAULT 0,
      tier_at_activation TEXT NOT NULL DEFAULT 'tier_1',
      atticus_floor_usdc NUMERIC DEFAULT 25,
      triggered_at TIMESTAMPTZ,
      trigger_side TEXT,
      trigger_feed_snapshot JSONB,
      closed_at TIMESTAMPTZ,
      closed_reason TEXT,
      salvage_proceeds_usdc NUMERIC,
      uplift_usdc NUMERIC,
      foxify_share_usdc NUMERIC,
      atticus_share_usdc NUMERIC,
      exit_mode TEXT,
      is_shadow BOOLEAN NOT NULL DEFAULT FALSE,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS two_sided_pair_leg (
      leg_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      leg_role TEXT NOT NULL,
      venue TEXT NOT NULL DEFAULT 'deribit',
      symbol TEXT NOT NULL DEFAULT 'TEST',
      strike_usdc NUMERIC NOT NULL,
      contracts_btc NUMERIC NOT NULL,
      buy_ask_usdc_per_btc NUMERIC,
      buy_cost_usdc NUMERIC,
      buy_filled_at TIMESTAMPTZ,
      sell_ask_usdc_per_btc NUMERIC,
      sell_proceeds_usdc NUMERIC,
      sell_filled_at TIMESTAMPTZ,
      live_anchor_ask_usdc_per_btc NUMERIC,
      live_anchor_pulled_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS two_sided_pair_event (
      event_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      details JSONB DEFAULT '{}'
    );
  `);
  return pool;
};

const insertActiveShadow = async (
  pool: Pool,
  opts: {
    pair_id: string;
    cost: number;
    expires_at?: Date;
    put_strike: number;
    call_strike: number;
    contracts: number;
    is_shadow?: boolean;
  }
) => {
  const expiresAt = opts.expires_at ?? new Date(Date.now() + 24 * 3_600_000);
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status, spot_at_activation, trigger_down_price, trigger_up_price, hedge_cost_total_usdc, expires_at, is_shadow)
     VALUES ($1, 'test', 'active', 73000, 70000, 76000, $2, $3, $4)`,
    [opts.pair_id, opts.cost, expiresAt, opts.is_shadow ?? true]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, strike_usdc, contracts_btc)
     VALUES ($1, $2, 'long_put', $3, $4)`,
    [randomUUID(), opts.pair_id, opts.put_strike, opts.contracts]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, strike_usdc, contracts_btc)
     VALUES ($1, $2, 'long_call', $3, $4)`,
    [randomUUID(), opts.pair_id, opts.call_strike, opts.contracts]
  );
};

const makeMockCache = (quotes: Array<{ strike: number; optType: "put" | "call"; venue: "deribit" | "bullish"; bid: number; ask: number }>): any => ({
  getCached: () => ({ spot: 73000 }),
  getBidForLeg: (opts: { strike: number; optType: "put" | "call"; preferVenue?: "deribit" | "bullish" }) => {
    const matching = quotes.filter((q) => q.strike === opts.strike && q.optType === opts.optType);
    if (matching.length === 0) return null;
    const preferred = opts.preferVenue
      ? matching.find((q) => q.venue === opts.preferVenue) ?? matching[0]
      : matching[0];
    return {
      bidUsdcPerBtc: preferred.bid,
      askUsdcPerBtc: preferred.ask,
      midUsdcPerBtc: (preferred.bid + preferred.ask) / 2,
      spreadPct: 0.1,
      venue: preferred.venue,
      instrumentName: "test",
      tenorHours: 24,
      markIv: 0.3,
      pulledAtMs: Date.now()
    };
  }
});

const baseConfig = (overrides: Partial<{ tpThresholdPct: number; maxPerTick: number }> = {}) => ({
  enabled: true,
  pollMs: 60_000,
  tpThresholdPct: 0.50,
  maxPerTick: 20,
  ...overrides
});

// ─── Baseline ───────────────────────────────────────────────────────────────

test("ShadowAutoTpHandler.tick: empty pool returns zeros", async () => {
  const pool = await buildPool();
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  const r = await h.tick();
  assert.equal(r.checked, 0);
  assert.equal(r.closed, 0);
});

// ─── TP threshold ──────────────────────────────────────────────────────────

test("ShadowAutoTpHandler.tick: closes pair above TP threshold", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "high-tp",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Big bids → high pnl above 50% threshold
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 100, ask: 110 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 100, ask: 110 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  const r = await h.tick();
  // Salvage = (100 + 100) × 1 × 0.95 = 190. Cost = 100. PnL = 90%. Above 50% threshold.
  assert.equal(r.closed, 1);
  const res = await pool.query(`SELECT status, closed_reason, exit_mode, salvage_proceeds_usdc FROM two_sided_pair WHERE pair_id = 'high-tp'`);
  assert.equal(res.rows[0].status, "settled");
  assert.equal(res.rows[0].closed_reason, "foxify_close");
  assert.equal(res.rows[0].exit_mode, "foxify_close");
  assert.ok(Math.abs(Number(res.rows[0].salvage_proceeds_usdc) - 190) < 0.5);
});

test("ShadowAutoTpHandler.tick: leaves pair below TP threshold alone", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "below-tp",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Small bids → low pnl below 50% threshold
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 30, ask: 35 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 30, ask: 35 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  const r = await h.tick();
  // Salvage = (30 + 30) × 0.95 = 57. Cost = 100. PnL = -43%. Below 50% threshold.
  assert.equal(r.closed, 0);
  const res = await pool.query(`SELECT status FROM two_sided_pair WHERE pair_id = 'below-tp'`);
  assert.equal(res.rows[0].status, "active");
});

test("ShadowAutoTpHandler.tick: respects custom tp threshold", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "custom-tp",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Salvage = (60 + 60) × 0.95 = 114. PnL = +14%. Threshold 10% would catch it.
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 60, ask: 65 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 60, ask: 65 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig({ tpThresholdPct: 0.10 }) });
  const r = await h.tick();
  assert.equal(r.closed, 1);
});

// ─── Safety guards ─────────────────────────────────────────────────────────

test("ShadowAutoTpHandler.tick: REFUSES to close non-shadow (live) pairs", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "live-pair",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    is_shadow: false // live pair
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 200, ask: 220 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 200, ask: 220 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  const r = await h.tick();
  // Even though pnl would be very high, the handler must NEVER touch live pairs
  assert.equal(r.checked, 0); // query filters to is_shadow=true
  assert.equal(r.closed, 0);
  const res = await pool.query(`SELECT status FROM two_sided_pair WHERE pair_id = 'live-pair'`);
  assert.equal(res.rows[0].status, "active");
});

test("ShadowAutoTpHandler.tick: ignores pairs past expires_at (expiry handler owns)", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "expired",
    cost: 100,
    expires_at: new Date(Date.now() - 1000), // past
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 200, ask: 220 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 200, ask: 220 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  const r = await h.tick();
  assert.equal(r.checked, 0); // query filters to expires_at > now
});

test("ShadowAutoTpHandler.tick: respects maxPerTick limit", async () => {
  const pool = await buildPool();
  for (let i = 0; i < 10; i++) {
    await insertActiveShadow(pool, {
      pair_id: `bulk-${i}`,
      cost: 100,
      put_strike: 73000,
      call_strike: 73000,
      contracts: 1.0
    });
  }
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 100, ask: 110 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 100, ask: 110 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig({ maxPerTick: 3 }) });
  const r = await h.tick();
  assert.equal(r.closed, 3); // only 3 in one tick
  const stillActive = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_pair WHERE status = 'active'`);
  assert.equal(stillActive.rows[0].n, 7);
});

// ─── Fee logic ─────────────────────────────────────────────────────────────

test("ShadowAutoTpHandler: Atticus fee charged at 10% of profit, min $25 floor", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "fee-test",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Salvage = (200 + 200) × 0.95 = 380. PnL = +280%. Profit = 280. Atticus = max(25, 28) = 28.
  // Foxify = 380 - 28 = 352.
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 200, ask: 220 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 200, ask: 220 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  await h.tick();
  const res = await pool.query(`SELECT salvage_proceeds_usdc, foxify_share_usdc, atticus_share_usdc, uplift_usdc FROM two_sided_pair WHERE pair_id = 'fee-test'`);
  assert.ok(Math.abs(Number(res.rows[0].salvage_proceeds_usdc) - 380) < 1);
  assert.ok(Math.abs(Number(res.rows[0].atticus_share_usdc) - 28) < 1, `expected ~$28 fee, got ${res.rows[0].atticus_share_usdc}`);
  assert.ok(Math.abs(Number(res.rows[0].foxify_share_usdc) - 352) < 1, `expected ~$352 foxify, got ${res.rows[0].foxify_share_usdc}`);
});

// ─── Config ────────────────────────────────────────────────────────────────

test("readAutoTpConfig: defaults when env unset", () => {
  const cfg = readAutoTpConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pollMs, 60_000);
  assert.equal(cfg.tpThresholdPct, 0.50);
  assert.equal(cfg.maxPerTick, 20);
});

test("readAutoTpConfig: env overrides work", () => {
  const cfg = readAutoTpConfig({
    SHADOW_AUTO_TP_ENABLED: "true",
    SHADOW_AUTO_TP_POLL_MS: "30000",
    SHADOW_AUTO_TP_THRESHOLD_PCT: "0.30",
    SHADOW_AUTO_TP_MAX_PER_TICK: "5"
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.pollMs, 30_000);
  assert.equal(cfg.tpThresholdPct, 0.30);
  assert.equal(cfg.maxPerTick, 5);
});

// ─── Audit trail ───────────────────────────────────────────────────────────

test("ShadowAutoTpHandler: records audit events with auto_tp_capture flag", async () => {
  const pool = await buildPool();
  await insertActiveShadow(pool, {
    pair_id: "audit-test",
    cost: 100,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 100, ask: 110 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 100, ask: 110 }
  ]);
  const h = new ShadowAutoTpHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35, config: baseConfig() });
  await h.tick();
  const events = await pool.query(`SELECT kind, details FROM two_sided_pair_event WHERE pair_id = 'audit-test' ORDER BY occurred_at`);
  assert.equal(events.rows.length, 2);
  assert.equal(events.rows[0].kind, "unwinding_started");
  assert.equal(events.rows[1].kind, "settled");
  const settledDetails = events.rows[1].details;
  assert.equal(settledDetails.auto_tp_capture, true);
  assert.equal(settledDetails.closed_reason, "foxify_close");
});
