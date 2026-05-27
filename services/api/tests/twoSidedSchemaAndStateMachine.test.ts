/**
 * PR 1 tests — two-sided schema + state machine.
 *
 * Covers:
 *  - schema migration up (idempotent)
 *  - state machine valid + invalid transitions
 *  - insertPair + getPairById
 *  - insertPairLeg + getLegsForPair
 *  - updatePairStatus enforces transitions
 *  - foxify_pair_ref uniqueness (idempotency key)
 *  - recordPairEvent + getEventsForPair
 *  - metadata JSONB round-trip
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  insertPairLeg,
  getPairById,
  getPairByFoxifyRef,
  getLegsForPair,
  updatePairStatus,
  recordPairEvent,
  getEventsForPair
} from "../src/singleSide/twoSided/db";
import {
  assertValidTransition,
  isValidTransition,
  isTerminal,
  IllegalStateTransitionError
} from "../src/singleSide/twoSided/stateMachine";
import { TIERS } from "../src/singleSide/twoSided/types";
import type { PairStatus } from "../src/singleSide/twoSided/types";

const buildPool = async () => {
  // noAstCoverageCheck suppresses pg-mem warning when CREATE TABLE combines inline
  // column constraints (PRIMARY KEY/NOT NULL) with table-level CONSTRAINT ... CHECK.
  // Real Postgres handles both first-class; pg-mem applies the schema but warns.
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const samplePair = (overrides: Partial<Parameters<typeof insertPair>[1]> = {}) => ({
  pairId: "p-" + Math.random().toString(36).slice(2, 10),
  cellId: "pair_50k_2pct",
  foxifyPairRef: "fxy-" + Math.random().toString(36).slice(2, 10),
  spotAtActivation: 76_000,
  feedSnapshotAtActivation: { sources: [{ name: "bullish", price: 76001 }], median: 76_000 },
  triggerDownPrice: 74_480,
  triggerUpPrice: 77_520,
  hedgeTenorDays: 3,
  expiresAt: "2026-05-30T18:00:00Z",
  tpForceExitAt: "2026-05-30T14:00:00Z",
  hedgeCostTotalUsdc: 3_238,
  foxifyCapitalFundedUsdc: 3_238,
  tierAtActivation: "tier_1" as const,
  atticusFloorUsdc: 25,
  metadata: { activation_source: "foxify_bot" },
  ...overrides
});

test("ensureTwoSidedSchema is idempotent (re-run does not throw)", async () => {
  const pool = await buildPool();
  await ensureTwoSidedSchema(pool); // already called in buildPool; second call must not throw
  await ensureTwoSidedSchema(pool); // third for good measure
  // pg-mem doesn't expose end() but no throw is the assertion
});

test("state machine: valid transitions are accepted", () => {
  assert.equal(isValidTransition("pending", "active"), true);
  assert.equal(isValidTransition("pending", "cancelled"), true);
  assert.equal(isValidTransition("active", "triggered"), true);
  assert.equal(isValidTransition("active", "unwinding"), true);
  assert.equal(isValidTransition("triggered", "unwinding"), true);
  assert.equal(isValidTransition("unwinding", "settled"), true);
});

test("state machine: illegal transitions are rejected", () => {
  const illegal: Array<[PairStatus, PairStatus]> = [
    ["pending", "settled"],
    ["pending", "triggered"],
    ["active", "settled"],
    ["triggered", "settled"],
    ["settled", "active"],
    ["cancelled", "active"],
    ["unwinding", "triggered"]
  ];
  for (const [from, to] of illegal) {
    assert.equal(isValidTransition(from, to), false, `${from}→${to} should be invalid`);
    assert.throws(() => assertValidTransition(from, to), IllegalStateTransitionError);
  }
});

test("state machine: settled and cancelled are terminal", () => {
  assert.equal(isTerminal("settled"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("active"), false);
});

test("insertPair + getPairById round-trip", async () => {
  const pool = await buildPool();
  const input = samplePair();
  const inserted = await insertPair(pool, input);
  assert.equal(inserted.pairId, input.pairId);
  assert.equal(inserted.status, "pending");
  assert.equal(inserted.cellId, "pair_50k_2pct");
  assert.equal(inserted.tierAtActivation, "tier_1");
  assert.equal(inserted.atticusFloorUsdc, 25);
  assert.equal(inserted.foxifyPairRef, input.foxifyPairRef);
  const fetched = await getPairById(pool, input.pairId);
  assert.ok(fetched);
  assert.equal(fetched!.pairId, input.pairId);
  assert.deepEqual(fetched!.metadata, { activation_source: "foxify_bot" });
});

test("foxify_pair_ref is unique (idempotency key)", async () => {
  const pool = await buildPool();
  const ref = "fxy-dup-ref";
  await insertPair(pool, samplePair({ foxifyPairRef: ref }));
  await assert.rejects(
    () => insertPair(pool, samplePair({ foxifyPairRef: ref })),
    /duplicate|unique|constraint/i
  );
});

test("getPairByFoxifyRef returns same pair", async () => {
  const pool = await buildPool();
  const ref = "fxy-lookup-ref";
  const inserted = await insertPair(pool, samplePair({ foxifyPairRef: ref }));
  const found = await getPairByFoxifyRef(pool, ref);
  assert.ok(found);
  assert.equal(found!.pairId, inserted.pairId);
});

test("insertPairLeg + getLegsForPair", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  const putLeg = await insertPairLeg(pool, {
    legId: "leg-put-1",
    pairId: pair.pairId,
    legRole: "long_put",
    venue: "bullish",
    symbol: "BTC-USDC-20260530-77000-P",
    strikeUsdc: 77_000,
    contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_150,
    buyCostUsdc: 1_610,
    buyFilledAt: "2026-05-27T18:42:14.880Z",
    liveAnchorAskUsdcPerBtc: 1_150,
    liveAnchorPulledAt: "2026-05-27T18:42:00.000Z",
    metadata: {}
  });
  const callLeg = await insertPairLeg(pool, {
    legId: "leg-call-1",
    pairId: pair.pairId,
    legRole: "long_call",
    venue: "deribit",
    symbol: "BTC-31MAY26-75000-C",
    strikeUsdc: 75_000,
    contractsBtc: 1.4,
    buyAskUsdcPerBtc: 1_162.86,
    buyCostUsdc: 1_628,
    buyFilledAt: "2026-05-27T18:42:14.910Z",
    liveAnchorAskUsdcPerBtc: 1_162.86,
    liveAnchorPulledAt: "2026-05-27T18:42:00.000Z",
    metadata: {}
  });
  const legs = await getLegsForPair(pool, pair.pairId);
  assert.equal(legs.length, 2);
  // order is by leg_role alphabetical: long_call before long_put
  assert.equal(legs[0].legRole, "long_call");
  assert.equal(legs[1].legRole, "long_put");
  assert.equal(legs[1].buyCostUsdc, 1_610);
  assert.equal(legs[0].venue, "deribit");
});

test("updatePairStatus: valid transition succeeds, illegal rejects with error", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  // pending → active
  const active = await updatePairStatus(pool, pair.pairId, "active");
  assert.equal(active.status, "active");
  // active → settled is illegal
  await assert.rejects(
    () => updatePairStatus(pool, pair.pairId, "settled"),
    IllegalStateTransitionError
  );
  // active → triggered ok
  const triggered = await updatePairStatus(pool, pair.pairId, "triggered", {
    triggeredAt: "2026-05-28T03:00:00Z",
    triggerSide: "down",
    triggerFeedSnapshot: { canonical_price: 74_400, sources: [{ name: "bullish", price: 74_401 }] }
  });
  assert.equal(triggered.status, "triggered");
  assert.equal(triggered.triggerSide, "down");
  assert.deepEqual(triggered.triggerFeedSnapshot, {
    canonical_price: 74_400,
    sources: [{ name: "bullish", price: 74_401 }]
  });
});

test("recordPairEvent + getEventsForPair (append-only log)", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await recordPairEvent(pool, { pairId: pair.pairId, kind: "activated", details: { spot: 76_000 } });
  await recordPairEvent(pool, { pairId: pair.pairId, kind: "trigger_detected", details: { side: "down", price: 74_400 } });
  const events = await getEventsForPair(pool, pair.pairId);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "activated");
  assert.equal(events[1].kind, "trigger_detected");
  assert.equal(events[1].details.side, "down");
});

test("TIERS configuration matches PLAN.md §3", () => {
  // Defensive: the production tier shape is referenced by settlement + dashboards.
  // Lock it in here so a typo can't silently shift the deal economics.
  assert.equal(TIERS.length, 5);
  assert.equal(TIERS[0].label, "tier_1");
  assert.equal(TIERS[0].atticusPct, 0.15);
  assert.equal(TIERS[0].atticusFloorUsdc, 25);
  assert.equal(TIERS[4].label, "tier_5");
  assert.equal(TIERS[4].atticusPct, 0.08);
  assert.equal(TIERS[4].atticusFloorUsdc, 45);
  assert.equal(TIERS[4].maxPairsPerDay, null);
  // Monotone: Atticus pct decreases, floor increases
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i].atticusPct < TIERS[i - 1].atticusPct, `tier ${i} pct must be < prior`);
    assert.ok(TIERS[i].atticusFloorUsdc > TIERS[i - 1].atticusFloorUsdc, `tier ${i} floor must be > prior`);
    assert.ok(Math.abs(TIERS[i].atticusPct + TIERS[i].foxifyPct - 1) < 1e-9, `tier ${i} pcts must sum to 1`);
  }
});
