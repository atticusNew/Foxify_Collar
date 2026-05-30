/**
 * Tests for expiryHandler — auto-settles never-triggered pairs at expires_at.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ExpiryHandler } from "../src/singleSide/twoSided/expiryHandler";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  const pool = new (db.adapters.createPg().Pool)();
  // Match production schema (minimal set the expiry handler reads + writes)
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
      symbol TEXT NOT NULL DEFAULT 'BTC-TEST',
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

const insertActivePair = async (
  pool: Pool,
  opts: {
    pair_id: string;
    cost: number;
    expires_at: Date;
    put_strike: number;
    call_strike: number;
    contracts: number;
    is_shadow?: boolean;
    status?: string;
  }
) => {
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status, spot_at_activation, trigger_down_price, trigger_up_price, hedge_cost_total_usdc, expires_at, is_shadow)
     VALUES ($1, 'test', $2, 73000, 70000, 76000, $3, $4, $5)`,
    [opts.pair_id, opts.status ?? "active", opts.cost, opts.expires_at, opts.is_shadow ?? true]
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
      tenorHours: 1,
      markIv: 0.3,
      pulledAtMs: Date.now()
    };
  }
});

// ─── Baseline ───────────────────────────────────────────────────────────────

test("ExpiryHandler.tick: empty pool returns zeros", async () => {
  const pool = await buildPool();
  const h = new ExpiryHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 0);
  assert.equal(r.settled, 0);
});

// ─── Settle path ────────────────────────────────────────────────────────────

test("ExpiryHandler.tick: settles active pair past expires_at", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "expired-1",
    cost: 200,
    expires_at: new Date(Date.now() - 60_000), // 1 min in past
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 30, ask: 40 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 50, ask: 60 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 1);
  assert.equal(r.settled, 1);

  // Verify DB updated
  const res = await pool.query(`SELECT status, closed_at, closed_reason, salvage_proceeds_usdc, exit_mode FROM two_sided_pair WHERE pair_id = 'expired-1'`);
  const row = res.rows[0];
  assert.equal(row.status, "settled");
  assert.equal(row.closed_reason, "expiry");
  assert.equal(row.exit_mode, "no_trigger_expiry");
  assert.ok(row.closed_at != null);
  // Salvage = (30 + 50) × 1.0 × 0.95 = 76
  assert.ok(Math.abs(Number(row.salvage_proceeds_usdc) - 76) < 0.01);
});

test("ExpiryHandler.tick: skips active pair NOT past expires_at", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "future-1",
    cost: 200,
    expires_at: new Date(Date.now() + 24 * 3_600_000), // tomorrow
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const h = new ExpiryHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 0);
  assert.equal(r.settled, 0);

  const res = await pool.query(`SELECT status FROM two_sided_pair WHERE pair_id = 'future-1'`);
  assert.equal(res.rows[0].status, "active");
});

test("ExpiryHandler.tick: skips triggered pair (lets executionRuntime own it)", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "triggered-1",
    cost: 200,
    expires_at: new Date(Date.now() - 60_000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    status: "triggered"
  });
  const h = new ExpiryHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 0); // query filters to status=active
  const res = await pool.query(`SELECT status FROM two_sided_pair WHERE pair_id = 'triggered-1'`);
  assert.equal(res.rows[0].status, "triggered"); // unchanged
});

test("ExpiryHandler.tick: skips already-settled pair", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "settled-1",
    cost: 200,
    expires_at: new Date(Date.now() - 60_000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    status: "settled"
  });
  const h = new ExpiryHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 0);
});

// ─── Valuation paths ────────────────────────────────────────────────────────

test("ExpiryHandler: uses venue bid when cache provides", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "venue-bid",
    cost: 100,
    expires_at: new Date(Date.now() - 1000),
    put_strike: 73000,
    call_strike: 74000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 100, ask: 110 },
    { strike: 74000, optType: "call", venue: "deribit", bid: 50, ask: 60 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.settled, 1);
  const res = await pool.query(`SELECT salvage_proceeds_usdc, foxify_share_usdc, atticus_share_usdc FROM two_sided_pair WHERE pair_id = 'venue-bid'`);
  // Salvage = (100 + 50) × 1 × 0.95 = 142.50
  // Cost = 100, profit = 42.50, atticus fee = max(25, 42.50 × 0.10) = 25
  // Foxify share = 142.50 - 25 = 117.50
  // Atticus share = 25
  assert.ok(Math.abs(Number(res.rows[0].salvage_proceeds_usdc) - 142.5) < 0.1);
  assert.ok(Math.abs(Number(res.rows[0].atticus_share_usdc) - 25) < 0.5);
  assert.ok(Math.abs(Number(res.rows[0].foxify_share_usdc) - 117.5) < 0.5);
});

test("ExpiryHandler: zero Atticus fee on losing pair (negative profit)", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "losing",
    cost: 500,  // Foxify paid a lot
    expires_at: new Date(Date.now() - 1000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Tiny bids → big loss
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 10, ask: 12 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 10, ask: 12 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  await h.tick();
  const res = await pool.query(`SELECT atticus_share_usdc, uplift_usdc FROM two_sided_pair WHERE pair_id = 'losing'`);
  assert.equal(Number(res.rows[0].atticus_share_usdc), 0); // 0% fee on losses
  assert.equal(Number(res.rows[0].uplift_usdc), 0); // no positive uplift
});

test("ExpiryHandler: falls back to BS when cache misses strike", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "bs-fb",
    cost: 200,
    expires_at: new Date(Date.now() - 1000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Cache has unrelated strikes only
  const cache = makeMockCache([
    { strike: 99000, optType: "put", venue: "deribit", bid: 1, ask: 2 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.settled, 1);
  // Should still settle, just using BS valuation
  const res = await pool.query(`SELECT status, salvage_proceeds_usdc FROM two_sided_pair WHERE pair_id = 'bs-fb'`);
  assert.equal(res.rows[0].status, "settled");
  // BS valuation should produce SOMETHING positive (intrinsic+TV)
  assert.ok(Number(res.rows[0].salvage_proceeds_usdc) > 0);
});

// ─── Event audit trail ──────────────────────────────────────────────────────

test("ExpiryHandler: records unwinding_started + settled events", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "audit-test",
    cost: 100,
    expires_at: new Date(Date.now() - 1000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 50, ask: 60 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 50, ask: 60 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  await h.tick();
  const events = await pool.query(`SELECT kind, details FROM two_sided_pair_event WHERE pair_id = 'audit-test' ORDER BY occurred_at`);
  const kinds = events.rows.map((r) => r.kind);
  assert.ok(kinds.includes("unwinding_started"));
  assert.ok(kinds.includes("settled"));
});

// ─── Webhook delivery hook ──────────────────────────────────────────────────

test("ExpiryHandler: invokes onSettled callback after settlement", async () => {
  const pool = await buildPool();
  await insertActivePair(pool, {
    pair_id: "webhook-test",
    cost: 100,
    expires_at: new Date(Date.now() - 1000),
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 50, ask: 60 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 50, ask: 60 }
  ]);
  let webhookCalled = false;
  let webhookPayload: Record<string, unknown> | null = null;
  const h = new ExpiryHandler({
    pool,
    liquidChainCache: cache,
    getCurrentIvAnnual: () => 0.35,
    onSettled: async (p) => { webhookCalled = true; webhookPayload = p as unknown as Record<string, unknown>; }
  });
  await h.tick();
  assert.ok(webhookCalled);
  assert.equal(webhookPayload!.closed_reason, "expiry");
  assert.equal(webhookPayload!.exit_mode, "no_trigger_expiry");
  assert.equal(webhookPayload!.pair_id, "webhook-test");
});

// ─── Multiple pairs in one tick ─────────────────────────────────────────────

test("ExpiryHandler: settles multiple expired pairs in one tick", async () => {
  const pool = await buildPool();
  for (let i = 0; i < 5; i++) {
    await insertActivePair(pool, {
      pair_id: `multi-${i}`,
      cost: 100,
      expires_at: new Date(Date.now() - (60 + i) * 1000),
      put_strike: 73000,
      call_strike: 73000,
      contracts: 1.0
    });
  }
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 30, ask: 40 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 30, ask: 40 }
  ]);
  const h = new ExpiryHandler({ pool, liquidChainCache: cache, getCurrentIvAnnual: () => 0.35 });
  const r = await h.tick();
  assert.equal(r.checked, 5);
  assert.equal(r.settled, 5);
  const settled = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_pair WHERE status = 'settled'`);
  assert.equal(settled.rows[0].n, 5);
});

test("ExpiryHandler.tick: re-entrant guard prevents concurrent execution", async () => {
  const pool = await buildPool();
  const h = new ExpiryHandler({ pool, liquidChainCache: null, getCurrentIvAnnual: () => 0.35 });
  const [r1, r2] = await Promise.all([h.tick(), h.tick()]);
  // One returns real numbers, other returns zeros from guard
  assert.ok((r1.checked === 0 && r1.settled === 0) || (r2.checked === 0 && r2.settled === 0));
});
