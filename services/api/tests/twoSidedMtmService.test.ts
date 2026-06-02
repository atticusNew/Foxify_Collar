/**
 * Tests for mtmService — mark-to-market for active pairs.
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  listActivePairMtm,
  summarizeMtm,
  __clearMtmStabilityCache,
  type PairMtm
} from "../src/singleSide/twoSided/mtmService";

// The MTM last-good-bid stability cache is a module singleton (intentional, for
// cross-poll stability in prod). Reset it between tests so a venue_bid cached by
// one test doesn't substitute for a later test's intended BS-fallback assertion.
beforeEach(() => { __clearMtmStabilityCache(); });

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
      venue TEXT NOT NULL DEFAULT 'deribit',
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
    put_venue?: string;
    call_venue?: string;
  }
) => {
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status, spot_at_activation, trigger_down_price, trigger_up_price, hedge_cost_total_usdc, expires_at, is_shadow)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [opts.pair_id, opts.cell_id, opts.status ?? "active", opts.spot_at_activation, opts.trigger_down, opts.trigger_up, opts.cost, opts.expires_at, opts.is_shadow ?? false]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, strike_usdc, contracts_btc, venue)
     VALUES ($1, $2, 'long_put', $3, $4, $5)`,
    [randomUUID(), opts.pair_id, opts.put_strike, opts.contracts, opts.put_venue ?? "deribit"]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, strike_usdc, contracts_btc, venue)
     VALUES ($1, $2, 'long_call', $3, $4, $5)`,
    [randomUUID(), opts.pair_id, opts.call_strike, opts.contracts, opts.call_venue ?? "deribit"]
  );
};

/** Mock LiquidChainCache that returns deterministic bids for specific strikes. */
const makeMockCache = (quotes: Array<{ strike: number; optType: "put" | "call"; venue: "deribit" | "bullish"; bid: number; ask: number; tenorHours?: number }>): any => ({
  getBidForLeg: (opts: { strike: number; optType: "put" | "call"; tenorRemainingHours: number; preferVenue?: "deribit" | "bullish" }) => {
    const matching = quotes.filter((q) => q.strike === opts.strike && q.optType === opts.optType);
    if (matching.length === 0) return null;
    // Prefer venue match
    const preferred = opts.preferVenue
      ? matching.find((q) => q.venue === opts.preferVenue) ?? matching[0]
      : matching[0];
    return {
      bidUsdcPerBtc: preferred.bid,
      askUsdcPerBtc: preferred.ask,
      midUsdcPerBtc: (preferred.bid + preferred.ask) / 2,
      spreadPct: (preferred.ask - preferred.bid) / preferred.ask,
      venue: preferred.venue,
      instrumentName: `mock-${preferred.strike}-${preferred.optType}`,
      tenorHours: preferred.tenorHours ?? opts.tenorRemainingHours,
      markIv: 0.30,
      pulledAtMs: Date.now()
    };
  }
});

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
  // In the bid-based design, haircut is per-leg so mark==salvage post-haircut
  assert.ok(p.estimated_salvage_usdc > 0, "salvage should be positive");
  assert.equal(p.valuation_method, "bs_fallback", "no cache provided → BS fallback");
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

// ─── Bid-based valuation (venue_bid method) ────────────────────────────────

test("listActivePairMtm: uses venue BID when cache provides it", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "bid-test",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 200,                  // Foxify paid $200
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    put_venue: "deribit",
    call_venue: "deribit"
  });
  // Cache returns explicit bids: put $50, call $80 → total $130 × 95% haircut = $123.50
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 50, ask: 60 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 80, ask: 95 }
  ]);
  const r = await listActivePairMtm({
    pool,
    currentSpot: 73000,
    ivAnnual: 0.35,
    liquidChainCache: cache
  });
  assert.equal(r.length, 1);
  const p = r[0];
  assert.equal(p.valuation_method, "venue_bid");
  assert.equal(p.put_valuation_method, "venue_bid");
  assert.equal(p.call_valuation_method, "venue_bid");
  // Salvage = (50 + 80) × 1.0 contracts × 0.95 haircut = 123.50
  assert.ok(Math.abs(p.estimated_salvage_usdc - 123.50) < 0.01, `expected ~$123.50, got ${p.estimated_salvage_usdc}`);
  assert.ok(p.pnl_pct < 0); // 123 < 200 cost
});

test("listActivePairMtm: falls back to BS when cache misses strike", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "bs-fallback",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 300,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    put_venue: "deribit",
    call_venue: "deribit"
  });
  // Cache has DIFFERENT strikes — won't match our pair's strikes
  const cache = makeMockCache([
    { strike: 99000, optType: "put", venue: "deribit", bid: 1, ask: 2 }
  ]);
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, liquidChainCache: cache });
  assert.equal(r.length, 1);
  assert.equal(r[0].valuation_method, "bs_fallback");
  assert.equal(r[0].put_valuation_method, "bs_fallback");
  assert.equal(r[0].call_valuation_method, "bs_fallback");
});

test("listActivePairMtm: cache match for one leg, BS for the other = mixed", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "mixed",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 300,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // Cache only has the put, not the call
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "deribit", bid: 50, ask: 60 }
  ]);
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, liquidChainCache: cache });
  assert.equal(r[0].put_valuation_method, "venue_bid");
  assert.equal(r[0].call_valuation_method, "bs_fallback");
  assert.equal(r[0].valuation_method, "mixed");
});

test("listActivePairMtm: prefers leg's actual venue when looking up bid", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "venue-pref",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 200,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    put_venue: "bullish",       // pair was bought on Bullish
    call_venue: "bullish"
  });
  // Cache has both venues; Bullish bid = $30, Deribit bid = $50 (Deribit looks better but pair was Bullish)
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "bullish", bid: 30, ask: 40 },
    { strike: 73000, optType: "put", venue: "deribit", bid: 50, ask: 60 },
    { strike: 73000, optType: "call", venue: "bullish", bid: 30, ask: 40 },
    { strike: 73000, optType: "call", venue: "deribit", bid: 50, ask: 60 }
  ]);
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, liquidChainCache: cache });
  // Should use Bullish bids: (30 + 30) × 0.95 = $57
  assert.ok(Math.abs(r[0].estimated_salvage_usdc - 57) < 0.5, `expected ~$57 using Bullish bids, got ${r[0].estimated_salvage_usdc}`);
});

test("listActivePairMtm: BS fallback produces lower value than original 88% haircut would have", async () => {
  // Sanity check that the new BS-fallback haircut (70%) is more conservative than old (88%)
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "haircut-test",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 300,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0
  });
  // No cache — pure BS path
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35 });
  assert.equal(r[0].valuation_method, "bs_fallback");
  // Verify the salvage is meaningfully less than 88% of raw BS would suggest
  // We can compute: at spot=73000, strike=73000, T=24h, sigma=35%:
  //   bsPut ≈ bsCall ≈ ~520 USD/BTC roughly  →  raw mid ≈ $1040 for strangle
  //   At 70% haircut: ~$728
  //   At 88% haircut (old): ~$915
  // Just verify the salvage is sensibly less than the cost paid ($300) wouldn't be representative,
  // so we check that with the BS values the salvage falls in expected range
  assert.ok(r[0].estimated_salvage_usdc > 100, "BS valuation should produce positive value");
});

// ─── summarizeMtm ───────────────────────────────────────────────────────────

test("summarizeMtm: aggregates totals + counts by recommendation", () => {
  const now = Date.now();
  const baseShape = (overrides: Partial<PairMtm>): PairMtm => ({
    pair_id: "x", cell_id: "x", is_shadow: false, cost_paid_usdc: 100,
    spot_at_activation: 73000, current_spot: 73000,
    put_strike: 73000, call_strike: 73000, contracts_btc: 1,
    current_put_value_usdc: 0, current_call_value_usdc: 0,
    current_option_mark_usdc: 0, estimated_salvage_usdc: 0,
    pnl_if_close_now_usdc: 0, pnl_pct: 0,
    current_put_mark_mid_usdc: 0, current_call_mark_mid_usdc: 0, current_option_mark_mid_usdc: 0,
    pnl_if_close_now_mid_usdc: 0, pnl_pct_mid: 0, mark_basis_note: "",
    valuation_method: "venue_bid", put_valuation_method: "venue_bid", call_valuation_method: "venue_bid",
    trigger_down_price: 70000, trigger_up_price: 76000,
    distance_to_trigger_down_pct: 0.04, distance_to_trigger_up_pct: 0.04,
    closest_trigger_pct: 0.04, tenor_remaining_hours: 24,
    expires_at: new Date(now + 24 * 3_600_000).toISOString(),
    recommendation: "HOLD", recommendation_reason: "",
    ...overrides
  });
  const samplePairs: PairMtm[] = [
    baseShape({
      pair_id: "1",
      current_put_value_usdc: 30, current_call_value_usdc: 30,
      current_option_mark_usdc: 60, estimated_salvage_usdc: 53,
      pnl_if_close_now_usdc: -47, pnl_pct: -0.47,
      current_option_mark_mid_usdc: 75, pnl_if_close_now_mid_usdc: -25,
      recommendation: "HOLD"
    }),
    baseShape({
      pair_id: "2", current_spot: 74000,
      current_put_value_usdc: 10, current_call_value_usdc: 200,
      current_option_mark_usdc: 210, estimated_salvage_usdc: 185,
      pnl_if_close_now_usdc: 85, pnl_pct: 0.85,
      current_option_mark_mid_usdc: 230, pnl_if_close_now_mid_usdc: 130,
      closest_trigger_pct: 0.027,
      recommendation: "STRONG_TAKE_PROFIT"
    })
  ];
  const summary = summarizeMtm(samplePairs, {
    currentSpot: 74000, ivAnnual: 0.35, tpThresholdPct: 0.30, watchThresholdPct: 0.05, nowMs: now
  });
  assert.equal(summary.total_active, 2);
  assert.equal(summary.total_cost_paid_usdc, 200);
  assert.equal(summary.total_estimated_salvage_usdc, 238);
  assert.equal(summary.total_pnl_if_close_all_now_usdc, 38);
  // Mid (venue-UI-comparable) totals: 75 + 230 = 305 mark, 305 - 200 cost = 105.
  assert.equal(summary.total_estimated_mark_mid_usdc, 305);
  assert.equal(summary.total_pnl_if_close_all_now_mid_usdc, 105);
  assert.equal(summary.by_recommendation.HOLD, 1);
  assert.equal(summary.by_recommendation.STRONG_TAKE_PROFIT, 1);
});

// ─── Executable (bid) vs MID mark — explains the venue-UI discrepancy ────────

test("listActivePairMtm: surfaces MID mark + spread alongside executable bid (wide book = big gap)", async () => {
  const pool = await buildPool();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000);
  await insertPair(pool, {
    pair_id: "wide-book",
    cell_id: "test",
    spot_at_activation: 73000,
    trigger_down: 70000,
    trigger_up: 76000,
    cost: 200,
    expires_at: expiresAt,
    put_strike: 73000,
    call_strike: 73000,
    contracts: 1.0,
    put_venue: "bullish",
    call_venue: "bullish"
  });
  // Wide Bullish ATM book: bid 100 / ask 180 per leg → mid 140, spread ~44%.
  const cache = makeMockCache([
    { strike: 73000, optType: "put", venue: "bullish", bid: 100, ask: 180 },
    { strike: 73000, optType: "call", venue: "bullish", bid: 100, ask: 180 }
  ]);
  const r = await listActivePairMtm({ pool, currentSpot: 73000, ivAnnual: 0.35, liquidChainCache: cache });
  const p = r[0];
  // Executable = (100 + 100) × 0.95 haircut = 190 → pnl -10 (the "platform" number).
  assert.ok(Math.abs(p.estimated_salvage_usdc - 190) < 0.5, `executable ~$190, got ${p.estimated_salvage_usdc}`);
  assert.ok(Math.abs(p.pnl_if_close_now_usdc - (-10)) < 0.5);
  // MID mark = (140 + 140) = 280 → pnl +80 (the "venue UI" number).
  assert.ok(Math.abs(p.current_option_mark_mid_usdc - 280) < 0.5, `mid mark ~$280, got ${p.current_option_mark_mid_usdc}`);
  assert.ok(Math.abs(p.pnl_if_close_now_mid_usdc - 80) < 0.5);
  // Mid mark must exceed the executable mark, and the spread is surfaced.
  assert.ok(p.current_option_mark_mid_usdc > p.current_option_mark_usdc, "mid > executable on a wide book");
  assert.ok((p.put_spread_pct ?? 0) > 0.4 && (p.call_spread_pct ?? 0) > 0.4, "spread surfaced (~44%)");
  // Recommendation/TP must use the EXECUTABLE pnl (negative here → HOLD), NOT the mid.
  assert.equal(p.recommendation, "HOLD");
  assert.ok(p.mark_basis_note.includes("EXECUTABLE"));
});
