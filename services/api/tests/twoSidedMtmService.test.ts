/**
 * Tests for mtmService — mark-to-market for active pairs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  listActivePairMtm,
  summarizeMtm,
  type PairMtm
} from "../src/singleSide/twoSided/mtmService";

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
      spot_at_activation NUMERIC NOT NULL,
      trigger_down_price NUMERIC NOT NULL,
      trigger_up_price NUMERIC NOT NULL,
      hedge_cost_total_usdc NUMERIC NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_shadow BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS two_sided_pair_leg (
      leg_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      leg_role TEXT NOT NULL,
      strike_usdc NUMERIC NOT NULL,
      contracts_btc NUMERIC NOT NULL,
      venue TEXT,
      symbol TEXT,
      buy_ask_usdc_per_btc NUMERIC,
      buy_cost_usdc NUMERIC
    );
  `);
  return pool;
};

const insertPair = async (
  pool: Pool,
  opts: {
    pair_id: string;
    cell_id: string;
    spot_at_activation: number;
    trigger_down: number;
    trigger_up: number;
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [opts.pair_id, opts.cell_id, opts.status ?? "active", opts.spot_at_activation, opts.trigger_down, opts.trigger_up, opts.cost, opts.expires_at, opts.is_shadow ?? false]
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

// ─── Baseline: empty pool returns no rows ───────────────────────────────────

test("listActivePairMtm: empty pool returns []", async () => {
  const pool = await buildPool();
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  assert.equal(r.length, 0);
});

// ─── Active pair valuation ──────────────────────────────────────────────────

test("listActivePairMtm: returns one row per active pair with correct shape", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 48 * 3_600_000); // 48h out
  await insertPair(pool, {
    pair_id: "pair-1",
    cell_id: "pair_50k_5pct_otm",
    spot_at_activation: 73000,
    trigger_down: 69350,
    trigger_up: 76650,
    cost: 300,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 74000,
    contracts: 1.0
  });
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  assert.equal(r.length, 1);
  const p = r[0];
  assert.equal(p.pair_id, "pair-1");
  assert.equal(p.cell_id, "pair_50k_5pct_otm");
  assert.equal(p.cost_paid_usdc, 300);
  assert.equal(p.put_strike, 73000);
  assert.equal(p.call_strike, 74000);
  assert.ok(p.current_option_mark_usdc > 0, "option should have positive value");
  assert.ok(p.estimated_salvage_usdc < p.current_option_mark_usdc, "salvage should be < mark (slippage haircut)");
  assert.ok(p.tenor_remaining_hours > 47 && p.tenor_remaining_hours <= 48);
});

test("listActivePairMtm: option mark INCREASES when spot moves toward call strike (gamma)", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 48 * 3_600_000);
  await insertPair(pool, {
    pair_id: "p1",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 69000,
    trigger_up: 77000,
    cost: 300,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 74000,
    contracts: 1.0
  });
  const lowSpot = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  const midSpot = await listActivePairMtm({ pool, currentSpot: 74500, ivAnnual: 0.35 });
  const highSpot = await listActivePairMtm({ pool, currentSpot: 76000, ivAnnual: 0.35 });
  // As spot moves UP toward call strike then through it, call_value grows fast
  assert.ok(
    highSpot[0].current_option_mark_usdc > midSpot[0].current_option_mark_usdc,
    `expected mark to grow with spot: ${midSpot[0].current_option_mark_usdc} -> ${highSpot[0].current_option_mark_usdc}`
  );
  assert.ok(midSpot[0].current_option_mark_usdc > lowSpot[0].current_option_mark_usdc);
});

// ─── pnl_pct and recommendation logic ───────────────────────────────────────

test("listActivePairMtm: HOLD recommendation when option below cost", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 12 * 3_600_000); // 12h
  await insertPair(pool, {
    pair_id: "deep-otm",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 69000,
    trigger_up: 77000,
    cost: 10_000, // expensive cost so option is way underwater
    expires_at: expiresAt,
    put_strike: 60000,
    call_strike: 90000,
    contracts: 0.1
  });
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  assert.equal(r[0].recommendation, "HOLD");
  assert.ok(r[0].pnl_pct < 0);
});

test("listActivePairMtm: TAKE_PROFIT_AVAILABLE when option appreciated past threshold", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  // Set up a pair with cheap cost and ATM strikes — option will be worth much more than cost
  await insertPair(pool, {
    pair_id: "deep-itm",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 100, // Tiny cost
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Move spot 2% up — call strike now ITM, salvage way above $100 cost
  const r = await listActivePairMtm({ pool, currentSpot: 74500, ivAnnual: 0.35, tpThresholdPct: 0.30 });
  assert.ok(
    r[0].recommendation === "TAKE_PROFIT_AVAILABLE" || r[0].recommendation === "STRONG_TAKE_PROFIT",
    `expected TP recommendation, got ${r[0].recommendation} with pnl_pct=${r[0].pnl_pct}`
  );
  assert.ok(r[0].pnl_pct >= 0.30);
});

test("listActivePairMtm: TRIGGERED when spot crossed trigger boundary", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "trig",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // spot 76500 — past the upper trigger
  const r = await listActivePairMtm({ pool, currentSpot: 76500, ivAnnual: 0.35 });
  assert.equal(r[0].recommendation, "TRIGGERED");
  assert.ok(r[0].closest_trigger_pct < 0);
});

test("listActivePairMtm: EXPIRED when tenor elapsed", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() - 60_000); // already past
  await insertPair(pool, {
    pair_id: "exp",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  assert.equal(r[0].recommendation, "EXPIRED");
});

// ─── Filtering ──────────────────────────────────────────────────────────────

test("listActivePairMtm: includeShadow=false excludes shadow pairs", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "real",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    is_shadow: false
  });
  await insertPair(pool, {
    pair_id: "shadow",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    is_shadow: true
  });
  const withShadow = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, includeShadow: true });
  const noShadow = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, includeShadow: false });
  assert.equal(withShadow.length, 2);
  assert.equal(noShadow.length, 1);
  assert.equal(noShadow[0].pair_id, "real");
});

test("listActivePairMtm: pairIdFilter returns single pair", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "a",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  await insertPair(pool, {
    pair_id: "b",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 500,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, pairIdFilter: "a" });
  assert.equal(r.length, 1);
  assert.equal(r[0].pair_id, "a");
});

// ─── summarizeMtm ───────────────────────────────────────────────────────────

test("summarizeMtm: aggregates totals + counts by recommendation", () => {
  const now = Date.now();
  const samplePairs: PairMtm[] = [
    {
      pair_id: "1", cell_id: "x", is_shadow: false, cost_paid_usdc: 100,
      spot_at_activation: 73000, current_spot: 73000,
      put_strike: 73000, call_strike: 73000, contracts_btc: 1,
      current_put_value_usdc: 30, current_call_value_usdc: 30,
      current_option_mark_usdc: 60, estimated_salvage_usdc: 53,
      pnl_if_close_now_usdc: -47, pnl_pct: -0.47,
      trigger_down_price: 70000, trigger_up_price: 76000,
      distance_to_trigger_down_pct: 0.04, distance_to_trigger_up_pct: 0.04,
      closest_trigger_pct: 0.04, tenor_remaining_hours: 24,
      expires_at: new Date(now + 24 * 3_600_000).toISOString(),
      recommendation: "HOLD", recommendation_reason: ""
    },
    {
      pair_id: "2", cell_id: "x", is_shadow: false, cost_paid_usdc: 100,
      spot_at_activation: 73000, current_spot: 74000,
      put_strike: 73000, call_strike: 73000, contracts_btc: 1,
      current_put_value_usdc: 10, current_call_value_usdc: 200,
      current_option_mark_usdc: 210, estimated_salvage_usdc: 185,
      pnl_if_close_now_usdc: 85, pnl_pct: 0.85,
      trigger_down_price: 70000, trigger_up_price: 76000,
      distance_to_trigger_down_pct: 0.055, distance_to_trigger_up_pct: 0.027,
      closest_trigger_pct: 0.027, tenor_remaining_hours: 24,
      expires_at: new Date(now + 24 * 3_600_000).toISOString(),
      recommendation: "STRONG_TAKE_PROFIT", recommendation_reason: ""
    }
  ];
  const summary = summarizeMtm(samplePairs, {
    currentSpot: 74000, ivAnnual: 0.35, tpThresholdPct: 0.30, watchThresholdPct: 0.05, nowMs: now
  });
  assert.equal(summary.total_active, 2);
  assert.equal(summary.total_cost_paid_usdc, 200);
  assert.equal(summary.total_estimated_salvage_usdc, 238);
  assert.equal(summary.total_pnl_if_close_all_now_usdc, 38);
  assert.equal(summary.by_recommendation.HOLD, 1);
  assert.equal(summary.by_recommendation.STRONG_TAKE_PROFIT, 1);
});
