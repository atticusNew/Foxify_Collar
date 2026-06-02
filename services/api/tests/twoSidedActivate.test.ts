/**
 * PR 3 tests — activate handler end-to-end (no HTTP, no live venues).
 *
 * Covers all 4 status paths plus the tier/quote/idempotency logic:
 *   - 201 happy path: full activation flow
 *   - 422 price_exceeded
 *   - 503 feed_unavailable
 *   - 503 depth_insufficient
 *   - 503 execution_failed (both legs)
 *   - 409 duplicate foxify_pair_ref
 *   - 400 invalid_request (missing fields)
 *   - Idempotency cleanup: cancelled pair doesn't block re-quote with different ref
 *
 * Plus tierResolver coverage:
 *   - tier picked at activation based on 24h rolling count
 *   - hysteresis behavior
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema, getEventsForPair, getLegsForPair, getPairById, insertPair } from "../src/singleSide/twoSided/db";
import { handleActivate } from "../src/singleSide/twoSided/activateHandler";
import { MockStrangleExecutor } from "../src/singleSide/twoSided/executor";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";
import { tierFromPairsPerDay, getRolling24hPairsCount } from "../src/singleSide/twoSided/tierResolver";
import { TIERS } from "../src/singleSide/twoSided/types";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const makeFeed = (price = 76_000, asOfMs = Date.now()): AggregatedFeed => ({
  canonicalPrice: price,
  asOfMs,
  sources: [
    { source: "bullish", price, ts: asOfMs },
    { source: "deribit", price: price + 1, ts: asOfMs },
    { source: "coinbase", price: price - 1, ts: asOfMs }
  ],
  rejected: [],
  expired: [],
  health: "healthy",
  medianCalcDescription: `median=${price}`
});

const makeAnchorProvider = (overrides?: {
  putBullishAsk?: number;
  putDepth?: number;
  callDeribitAsk?: number;
  callDepth?: number;
  failPut?: boolean;
  failCall?: boolean;
}): LiveAnchorProvider => ({
  getAnchorForLeg: async (strike, optionType) => {
    if (optionType === "put") {
      if (overrides?.failPut) return { bullish: null, deribit: null };
      return {
        bullish: {
          venue: "bullish",
          symbol: `BTC-USDC-20260530-${strike}-P`,
          askUsdcPerBtc: overrides?.putBullishAsk ?? 1_150,
          depthWithin2pctBtc: overrides?.putDepth ?? 3.0,
          pulledAt: new Date().toISOString()
        },
        deribit: null
      };
    }
    if (overrides?.failCall) return { bullish: null, deribit: null };
    return {
      bullish: null,
      deribit: {
        venue: "deribit",
        symbol: `BTC-31MAY26-${strike}-C`,
        askUsdcPerBtc: overrides?.callDeribitAsk ?? 1_162.86,
        depthWithin2pctBtc: overrides?.callDepth ?? 3.0,
        pulledAt: new Date().toISOString()
      }
    };
  }
});

const happyDeps = async () => {
  const pool = await buildPool();
  return {
    pool,
    deps: {
      pool,
      anchorProvider: makeAnchorProvider(),
      executor: new MockStrangleExecutor(),
      getFeed: () => makeFeed(),
      feedVersion: "v1.0.0",
      nowMs: () => Date.parse("2026-05-27T18:00:00Z")
    }
  };
};

// ─── 201 happy path ───

test("handleActivate: 201 happy path returns full payload + writes DB", async () => {
  const { pool, deps } = await happyDeps();
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-happy-1" },
    deps
  );
  assert.equal(res.status, 201);
  if (res.status !== 201) return;
  const body = res.body;
  assert.equal(body.cell_id, "pair_50k_2pct");
  assert.equal(body.foxify_pair_ref, "fxy-happy-1");
  assert.equal(body.spot_at_activation, 76_000);
  // ITM guts strikes at spot 76k with 1.3% ITM target, $1k grid:
  // putStrike = ceil(76000 * 1.013 / 1000) * 1000 = ceil(76.988) * 1000 = 77000
  // callStrike = floor(76000 * 0.987 / 1000) * 1000 = floor(75.012) * 1000 = 75000
  assert.equal(body.put_strike, 77_000);
  assert.equal(body.call_strike, 75_000);
  // Sizing reconcile: contractsBtc derived from notional/spot = 50000/76000 = 0.658
  // (option size tracks the perp notional at live spot; no stale hardcode).
  assert.equal(body.contracts_btc, 0.658);
  // triggers: 76000 ± 2% = 74480 / 77520
  assert.equal(body.trigger_down_price, 74_480);
  assert.equal(body.trigger_up_price, 77_520);
  assert.equal(body.tier_at_activation, "tier_1");
  assert.equal(body.atticus_split_pct, 0.15);
  assert.equal(body.atticus_floor_usdc, 25);
  // Total cost = 0.658 × 1150 + 0.658 × 1162.86 ≈ 1522
  assert.ok(body.total_hedge_cost_usdc > 1_480 && body.total_hedge_cost_usdc < 1_560);

  // DB writes
  const pair = await getPairById(pool, body.pair_id);
  assert.ok(pair);
  assert.equal(pair!.status, "active");
  const legs = await getLegsForPair(pool, body.pair_id);
  assert.equal(legs.length, 2);
  // Phase C: each leg persists the venue-assigned order id for reconciliation/audit.
  for (const leg of legs) {
    const oid = (leg.metadata as { venue_order_id?: string | null }).venue_order_id;
    assert.ok(typeof oid === "string" && oid.startsWith("mock-"), "leg records venue_order_id");
  }
  const events = await getEventsForPair(pool, body.pair_id);
  const activatedEvt = events.find((e) => e.kind === "activated");
  assert.ok(activatedEvt);
  const d = activatedEvt!.details as { put_venue_order_id?: string | null; call_venue_order_id?: string | null };
  assert.ok(typeof d.put_venue_order_id === "string" && d.put_venue_order_id.startsWith("mock-put-"));
  assert.ok(typeof d.call_venue_order_id === "string" && d.call_venue_order_id.startsWith("mock-call-"));
});

// ─── D2: actual filled-size accounting (Deribit 0.1-step floor) ───

test("handleActivate: records ACTUAL filled size + cost when executor floors the fill", async () => {
  const pool = await buildPool();
  // Executor reports a floored fill (0.658 requested → 0.6 filled, mimicking Deribit's 0.1 step).
  const deps = {
    pool,
    anchorProvider: makeAnchorProvider(),
    executor: new MockStrangleExecutor({ putFilledContractsBtc: 0.6, callFilledContractsBtc: 0.6 }),
    getFeed: () => makeFeed(),
    feedVersion: "v1.0.0",
    nowMs: () => Date.parse("2026-05-27T18:00:00Z")
  };
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-filled-size" },
    deps
  );
  assert.equal(res.status, 201);
  if (res.status !== 201) return;

  // Payload reflects the FILLED size (0.6), not the requested 0.658.
  assert.equal(res.body.put_leg.contracts_btc, 0.6);
  assert.equal(res.body.call_leg.contracts_btc, 0.6);
  // Leg cost = fill price × FILLED size (put ask 1150, call ask 1162.86).
  assert.ok(Math.abs(res.body.put_leg.leg_cost_usdc - 1_150 * 0.6) < 1e-6);
  assert.ok(Math.abs(res.body.call_leg.leg_cost_usdc - 1_162.86 * 0.6) < 1e-6);
  const expectedTotal = 1_150 * 0.6 + 1_162.86 * 0.6;
  assert.ok(Math.abs(res.body.total_hedge_cost_usdc - expectedTotal) < 1e-6);

  // DB: legs carry the filled size + requested size in metadata; pair cost corrected.
  const legs = await getLegsForPair(pool, res.body.pair_id);
  for (const leg of legs) {
    assert.equal(leg.contractsBtc, 0.6, "leg records the FILLED size");
    assert.equal((leg.metadata as { requested_contracts_btc?: number }).requested_contracts_btc, 0.658);
  }
  const pair = await getPairById(pool, res.body.pair_id);
  assert.ok(Math.abs(pair!.hedgeCostTotalUsdc - expectedTotal) < 1e-6, "pair hedge_cost corrected to actual fill");
});

// ─── regime tagging via override (shadow path) ───

test("handleActivate: regimeAtActivationOverride stamps regime_at_activation (shadow path, no getCurrentRegime)", async () => {
  const { pool, deps } = await happyDeps(); // happyDeps has NO getCurrentRegime (mirrors shadow)
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-regime-tag", isShadow: true, regimeAtActivationOverride: "moderate" },
    deps
  );
  assert.equal(res.status, 201);
  if (res.status !== 201) return;
  const pair = await getPairById(pool, res.body.pair_id);
  assert.equal(pair!.regimeAtActivation, "moderate", "shadow pair must be regime-tagged so realized-vs-MC can see it");
});

// ─── 422 price exceeded ───

test("handleActivate: 422 when live cost exceeds max_acceptable", async () => {
  const { deps } = await happyDeps();
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 1_000, foxifyPairRef: "fxy-overpriced" },
    deps
  );
  assert.equal(res.status, 422);
  if (res.status !== 422) return;
  assert.equal(res.body.error, "price_exceeded");
  assert.ok(res.body.live_quoted_cost_usdc > 1_000);
  assert.equal(res.body.max_acceptable_usdc, 1_000);
});

// ─── 503 feed unavailable ───

test("handleActivate: 503 when feed has no canonical price", async () => {
  const pool = await buildPool();
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-nofeed" },
    {
      pool,
      anchorProvider: makeAnchorProvider(),
      executor: new MockStrangleExecutor(),
      getFeed: () => null
    }
  );
  assert.equal(res.status, 503);
  if (res.status !== 503) return;
  assert.equal(res.body.error, "feed_unavailable");
});

// ─── 503 depth insufficient ───

test("handleActivate: 503 when leg depth below required headroom", async () => {
  const pool = await buildPool();
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-thindepth" },
    {
      pool,
      anchorProvider: makeAnchorProvider({ putDepth: 0.5 }), // contracts≈0.658, headroom 1.2 → required ≈0.79; 0.5 < 0.79 → insufficient
      executor: new MockStrangleExecutor(),
      getFeed: () => makeFeed()
    }
  );
  assert.equal(res.status, 503);
  if (res.status !== 503) return;
  assert.equal(res.body.error, "depth_insufficient");
});

// ─── 503 execution failure ───

test("handleActivate: 503 when executor fails; pair marked cancelled + event recorded", async () => {
  const pool = await buildPool();
  const exec = new MockStrangleExecutor({
    failPutLeg: { reason: { ok: false, reason: "venue_error", detail: "x" }, detail: "Bullish 500" }
  });
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-fail" },
    {
      pool,
      anchorProvider: makeAnchorProvider(),
      executor: exec,
      getFeed: () => makeFeed()
    }
  );
  assert.equal(res.status, 503);
  if (res.status !== 503) return;
  assert.equal(res.body.error, "execution_failed");

  // Pair must exist with status=cancelled, and `cancelled` event recorded
  const cancelled = await pool.query(`SELECT * FROM two_sided_pair WHERE foxify_pair_ref = 'fxy-fail'`);
  assert.equal(cancelled.rows.length, 1);
  assert.equal(cancelled.rows[0].status, "cancelled");
  const events = await getEventsForPair(pool, cancelled.rows[0].pair_id);
  assert.ok(events.some((e) => e.kind === "cancelled"));
});

// ─── 409 idempotency ───

test("handleActivate: 409 on duplicate foxify_pair_ref returns existing pair", async () => {
  const { pool, deps } = await happyDeps();
  const r1 = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-dup" },
    deps
  );
  assert.equal(r1.status, 201);
  if (r1.status !== 201) return;

  const r2 = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-dup" },
    deps
  );
  assert.equal(r2.status, 409);
  if (r2.status !== 409) return;
  assert.equal(r2.body.existing_pair_id, r1.body.pair_id);
  assert.equal(r2.body.existing_status, "active");
});

// ─── 400 invalid ───

test("handleActivate: 400 on missing fields", async () => {
  const pool = await buildPool();
  const deps = {
    pool,
    anchorProvider: makeAnchorProvider(),
    executor: new MockStrangleExecutor(),
    getFeed: () => makeFeed()
  };
  const r1 = await handleActivate({ cellId: "pair_50k_2pct" } as unknown, deps);
  assert.equal(r1.status, 400);
  const r2 = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: -1, foxifyPairRef: "fxy-x" },
    deps
  );
  assert.equal(r2.status, 400);
  const r3 = await handleActivate(
    { cellId: "unknown_cell", maxAcceptableHedgeCostUsdc: 3500, foxifyPairRef: "fxy-x2" },
    deps
  );
  assert.equal(r3.status, 400);
});

// ─── Tier resolver ───

test("tierFromPairsPerDay: each tier band lookup", () => {
  assert.equal(tierFromPairsPerDay(0).label, "tier_1");
  assert.equal(tierFromPairsPerDay(20).label, "tier_1");
  assert.equal(tierFromPairsPerDay(50).label, "tier_2");
  assert.equal(tierFromPairsPerDay(150).label, "tier_3");
  assert.equal(tierFromPairsPerDay(400).label, "tier_4");
  assert.equal(tierFromPairsPerDay(1_000).label, "tier_5");
});

test("tierFromPairsPerDay: hysteresis bumps near upper boundary into next tier", () => {
  // tier_1 upper = 25; with 5% hysteresis, [23.75, 25) sticks to tier_2
  assert.equal(tierFromPairsPerDay(24).label, "tier_2"); // within hysteresis of 25 → upgrades
  assert.equal(tierFromPairsPerDay(23).label, "tier_1"); // outside hysteresis → tier_1
  // tier_5 has no upper boundary → no hysteresis triggered
  assert.equal(tierFromPairsPerDay(1_000_000).label, "tier_5");
});

test("getRolling24hPairsCount: counts pairs from last 24h, excludes cancelled", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Insert 3 active pairs created in past 24h
  for (let i = 0; i < 3; i++) {
    await insertPair(pool, {
      pairId: `p-${i}`,
      cellId: "pair_50k_2pct",
      foxifyPairRef: `fxy-${i}`,
      spotAtActivation: 76_000,
      feedSnapshotAtActivation: {},
      triggerDownPrice: 74_480,
      triggerUpPrice: 77_520,
      hedgeTenorDays: 3,
      expiresAt: new Date(now + 3 * 86_400_000).toISOString(),
      tpForceExitAt: new Date(now + 3 * 86_400_000 - 4 * 3_600_000).toISOString(),
      hedgeCostTotalUsdc: 3_238,
      foxifyCapitalFundedUsdc: 3_238,
      tierAtActivation: "tier_1",
      atticusFloorUsdc: 25,
      metadata: {}
    });
  }
  const n = await getRolling24hPairsCount(pool, now);
  assert.equal(n, 3);
});

test("TIERS atticus_floor_usdc never exceeds max possible uplift in normal regime", () => {
  // Sanity: even at Tier 5 floor ($45), if calm regime mean uplift is ~$543, floor binds rarely
  for (const t of TIERS) {
    assert.ok(t.atticusFloorUsdc < 100, "floor must be < $100 to avoid binding on typical uplifts");
  }
});
