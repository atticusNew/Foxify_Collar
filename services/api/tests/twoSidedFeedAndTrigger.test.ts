/**
 * PR 2 tests — feed aggregator + trigger detector.
 *
 * Aggregator (pure, no I/O):
 *   - drops expired samples
 *   - rejects outliers > 0.5% from tentative median
 *   - returns "healthy" with >=3 sources, "degraded" with 2, "unavailable" with <2
 *   - canonical price = median of survivors
 *
 * Detector:
 *   - skips trigger check when feed unavailable / stale (no auto-trigger on missing data)
 *   - detects down-side crossing (canonical <= trigger_down_price)
 *   - detects up-side crossing (canonical >= trigger_up_price)
 *   - records trigger_detected event + transitions pair to triggered
 *   - invokes onTrigger callback
 *   - idempotent: re-tick on already-triggered pair is a no-op
 *   - callback failures don't block other pairs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  aggregateFeed,
  isFeedStale,
  type AggregatedFeed,
  type FeedSourceSample
} from "../src/singleSide/twoSided/feedAggregator";
import { TriggerDetector } from "../src/singleSide/twoSided/triggerDetector";
import {
  ensureTwoSidedSchema,
  insertPair,
  updatePairStatus,
  getPairById,
  getEventsForPair
} from "../src/singleSide/twoSided/db";
import type { PairRecord, TriggerSide } from "../src/singleSide/twoSided/types";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const samplePair = (overrides: Record<string, unknown> = {}) => ({
  pairId: "p-" + Math.random().toString(36).slice(2, 10),
  cellId: "pair_50k_2pct",
  foxifyPairRef: "fxy-" + Math.random().toString(36).slice(2, 10),
  spotAtActivation: 76_000,
  feedSnapshotAtActivation: {},
  triggerDownPrice: 74_480,
  triggerUpPrice: 77_520,
  hedgeTenorDays: 3,
  expiresAt: "2026-05-30T18:00:00Z",
  tpForceExitAt: "2026-05-30T14:00:00Z",
  hedgeCostTotalUsdc: 3_238,
  foxifyCapitalFundedUsdc: 3_238,
  tierAtActivation: "tier_1" as const,
  atticusFloorUsdc: 25,
  metadata: {},
  ...overrides
});

// ─── feedAggregator tests ───

test("aggregateFeed: healthy 5-source median, no rejects", () => {
  const now = 1_000_000;
  const samples: FeedSourceSample[] = [
    { source: "bullish", price: 76_000.0, ts: now - 200 },
    { source: "deribit", price: 76_001.0, ts: now - 150 },
    { source: "coinbase", price: 76_002.5, ts: now - 100 },
    { source: "binance", price: 76_000.5, ts: now - 250 },
    { source: "kraken", price: 75_999.0, ts: now - 300 }
  ];
  const r = aggregateFeed(samples, { nowMs: now });
  assert.equal(r.health, "healthy");
  assert.equal(r.sources.length, 5);
  assert.equal(r.rejected.length, 0);
  // median of [75999, 76000, 76000.5, 76001, 76002.5] = 76000.5
  assert.equal(r.canonicalPrice, 76_000.5);
});

test("aggregateFeed: outlier rejected at >0.5%", () => {
  const now = 1_000_000;
  const samples: FeedSourceSample[] = [
    { source: "bullish", price: 76_000, ts: now - 100 },
    { source: "deribit", price: 76_010, ts: now - 100 },
    { source: "coinbase", price: 76_005, ts: now - 100 },
    { source: "binance", price: 77_000, ts: now - 100 }, // ~1.3% above → outlier
    { source: "kraken", price: 75_995, ts: now - 100 }
  ];
  const r = aggregateFeed(samples, { nowMs: now });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].source, "binance");
  assert.equal(r.health, "healthy"); // 4 survivors
});

test("aggregateFeed: expired samples dropped", () => {
  const now = 10_000;
  const samples: FeedSourceSample[] = [
    { source: "bullish", price: 76_000, ts: now - 200 },
    { source: "deribit", price: 76_001, ts: now - 2_000 }, // expired (>1500ms)
    { source: "coinbase", price: 76_002, ts: now - 100 }
  ];
  const r = aggregateFeed(samples, { nowMs: now, maxAgeMs: 1_500 });
  assert.equal(r.expired.length, 1);
  assert.equal(r.expired[0].source, "deribit");
  assert.equal(r.sources.length, 2);
  assert.equal(r.health, "degraded"); // 2 survivors
});

test("aggregateFeed: unavailable with 0-1 survivors", () => {
  const now = 1_000;
  // All stale
  const r0 = aggregateFeed([{ source: "bullish", price: 76_000, ts: now - 5_000 }], { nowMs: now });
  assert.equal(r0.canonicalPrice, null);
  assert.equal(r0.health, "unavailable");
  // Only 1 fresh
  const r1 = aggregateFeed([{ source: "bullish", price: 76_000, ts: now - 100 }], { nowMs: now });
  assert.equal(r1.canonicalPrice, 76_000);
  assert.equal(r1.health, "unavailable");
});

test("isFeedStale: respects threshold", () => {
  const now = 10_000;
  assert.equal(isFeedStale(null, now, 5_000), true);
  assert.equal(isFeedStale(now - 4_000, now, 5_000), false);
  assert.equal(isFeedStale(now - 6_000, now, 5_000), true);
});

// ─── triggerDetector tests ───

const makeFeed = (price: number, asOfMs: number, health: "healthy" | "degraded" | "unavailable" = "healthy"): AggregatedFeed => ({
  canonicalPrice: price,
  asOfMs,
  sources: [
    { source: "bullish", price, ts: asOfMs },
    { source: "deribit", price: price + 1, ts: asOfMs },
    { source: "coinbase", price: price - 1, ts: asOfMs }
  ],
  rejected: [],
  expired: [],
  health,
  medianCalcDescription: `median=${price.toFixed(2)}`
});

test("TriggerDetector: down crossing fires", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");

  const now = 1_000_000;
  let onTriggerCalled: { pair: PairRecord; side: TriggerSide } | null = null;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(74_400, now), // below 74480 down threshold
    onTrigger: (p, side) => {
      onTriggerCalled = { pair: p, side };
    },
    log: () => {} // silence
  });

  const r = await det.tick(now);
  assert.equal(r.checked, 1);
  assert.equal(r.triggered, 1);

  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "triggered");
  assert.equal(fresh!.triggerSide, "down");
  assert.ok(fresh!.triggeredAt);
  assert.ok(fresh!.triggerFeedSnapshot, "feed snapshot must be recorded");
  assert.equal((fresh!.triggerFeedSnapshot as Record<string, unknown>).canonical_price, 74_400);

  const events = await getEventsForPair(pool, pair.pairId);
  const triggerEv = events.find((e) => e.kind === "trigger_detected");
  assert.ok(triggerEv);
  assert.equal(triggerEv!.details.side, "down");
  assert.equal(onTriggerCalled !== null, true, "onTrigger callback must fire");
  assert.equal(onTriggerCalled!.side, "down");
});

test("TriggerDetector: up crossing fires", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const now = 1_000_000;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(77_600, now), // above 77520 up threshold
    onTrigger: () => {},
    log: () => {}
  });
  const r = await det.tick(now);
  assert.equal(r.triggered, 1);
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.triggerSide, "up");
});

test("TriggerDetector: no crossing → no trigger", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const now = 1_000_000;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(76_000, now), // mid-range
    onTrigger: () => assert.fail("onTrigger should not fire"),
    log: () => {}
  });
  const r = await det.tick(now);
  assert.equal(r.checked, 1);
  assert.equal(r.triggered, 0);
  const fresh = await getPairById(pool, pair.pairId);
  assert.equal(fresh!.status, "active");
});

test("TriggerDetector: feed unavailable → no trigger, halt counter incremented", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const det = new TriggerDetector({
    pool,
    getFeed: () => null,
    onTrigger: () => assert.fail("onTrigger must not fire when feed unavailable"),
    log: () => {}
  });
  const r = await det.tick(1_000_000);
  assert.equal(r.checked, 0);
  assert.equal(r.triggered, 0);
  assert.equal(det.stats().haltCount, 1);
});

test("TriggerDetector: feed stale → no trigger, stale counter incremented", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const now = 1_000_000;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(74_400, now - 10_000), // 10s old
    onTrigger: () => assert.fail("onTrigger must not fire when feed stale"),
    log: () => {},
    staleHealthyMs: 5_000
  });
  const r = await det.tick(now);
  assert.equal(r.triggered, 0);
  assert.equal(det.stats().staleCount, 1);
});

test("TriggerDetector: already-triggered pair is skipped on subsequent tick", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const now = 1_000_000;
  let callbackCount = 0;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(74_400, now),
    onTrigger: () => {
      callbackCount++;
    },
    log: () => {}
  });
  await det.tick(now);
  // Manual second tick — pair is now `triggered`, no longer `active`, so it won't be re-picked
  await det.tick(now + 1000);
  assert.equal(callbackCount, 1, "callback must fire exactly once");
});

test("TriggerDetector: onTrigger callback failure does not block other pairs", async () => {
  const pool = await buildPool();
  const p1 = await insertPair(pool, samplePair({ pairId: "p1", foxifyPairRef: "fxy-p1" }));
  const p2 = await insertPair(pool, samplePair({ pairId: "p2", foxifyPairRef: "fxy-p2" }));
  await updatePairStatus(pool, p1.pairId, "active");
  await updatePairStatus(pool, p2.pairId, "active");
  const now = 1_000_000;
  const fired: string[] = [];
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(74_400, now),
    onTrigger: (pair) => {
      fired.push(pair.pairId);
      if (pair.pairId === "p1") throw new Error("simulated callback failure");
    },
    log: () => {}
  });
  const r = await det.tick(now);
  // Both pairs MUST be transitioned despite callback error on p1
  assert.equal(r.triggered, 2);
  const f1 = await getPairById(pool, "p1");
  const f2 = await getPairById(pool, "p2");
  assert.equal(f1!.status, "triggered");
  assert.equal(f2!.status, "triggered");
  assert.deepEqual(fired.sort(), ["p1", "p2"]);
});

test("TriggerDetector: stats counter accuracy", async () => {
  const pool = await buildPool();
  const pair = await insertPair(pool, samplePair());
  await updatePairStatus(pool, pair.pairId, "active");
  const now = 1_000_000;
  const det = new TriggerDetector({
    pool,
    getFeed: () => makeFeed(76_000, now),
    onTrigger: () => {},
    log: () => {}
  });
  await det.tick(now);
  await det.tick(now + 1_000);
  await det.tick(now + 2_000);
  const s = det.stats();
  assert.equal(s.ticksRun, 3);
  assert.equal(s.triggersFiredCount, 0);
  assert.equal(s.haltCount, 0);
});
