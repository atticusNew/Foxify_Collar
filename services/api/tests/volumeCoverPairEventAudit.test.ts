import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded,
  insertPairEvent,
  listRecentPairEvents,
  computePairEventLatencyStats
} from "../src/volumeCover/volumeCoverDb";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  return pool;
};

const baseEvent = (overrides: Partial<Parameters<typeof insertPairEvent>[1]> = {}) => ({
  foxifyPairId: "FX-AUDIT-1",
  cellId: "50k_2pct_1k",
  fingerprintHash: "fp-audit",
  pairEntryBtcPrice: 80_000,
  result: "activated" as const,
  rejectReason: null,
  positionId: "vc-pos-test",
  receivedAtIso: new Date(Date.now() - 1500).toISOString(),
  guardsPassedAtIso: new Date(Date.now() - 1200).toISOString(),
  hedgeBuySubmittedAtIso: new Date(Date.now() - 800).toISOString(),
  hedgeFillAtIso: new Date(Date.now() - 200).toISOString(),
  responseSentAtIso: new Date().toISOString(),
  totalLatencyMs: 1500,
  laddered: false,
  ladderSavingsUsdc: 0,
  metadata: {},
  ...overrides
});

test("pair-event audit: insert + listRecent returns inserted row", async () => {
  const pool = await buildPool();
  const ev = baseEvent();
  const { id } = await insertPairEvent(pool, ev);
  assert.ok(id.startsWith("vc-evt-"));

  const recent = await listRecentPairEvents(pool, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, id);
  assert.equal(recent[0].result, "activated");
  assert.equal(recent[0].totalLatencyMs, 1500);
});

test("pair-event audit: rejected events recorded with rejectReason", async () => {
  const pool = await buildPool();
  await insertPairEvent(pool, baseEvent({
    foxifyPairId: "FX-REJ-1",
    result: "rejected",
    rejectReason: "antibot:layer1_repeat_cell_window",
    positionId: null,
    guardsPassedAtIso: null,
    hedgeBuySubmittedAtIso: null,
    hedgeFillAtIso: null,
    totalLatencyMs: 50
  }));
  const recent = await listRecentPairEvents(pool, 10);
  assert.equal(recent[0].result, "rejected");
  assert.equal(recent[0].rejectReason, "antibot:layer1_repeat_cell_window");
  assert.equal(recent[0].guardsPassedAtIso, null);
});

test("pair-event audit: idempotent events recorded with positionId", async () => {
  const pool = await buildPool();
  await insertPairEvent(pool, baseEvent({
    foxifyPairId: "FX-IDEMP-1",
    result: "idempotent",
    positionId: "vc-pos-existing",
    totalLatencyMs: 25
  }));
  const recent = await listRecentPairEvents(pool, 10);
  assert.equal(recent[0].result, "idempotent");
  assert.equal(recent[0].positionId, "vc-pos-existing");
});

test("pair-event audit: laddered flag + savings recorded", async () => {
  const pool = await buildPool();
  await insertPairEvent(pool, baseEvent({
    foxifyPairId: "FX-LADDER-1",
    laddered: true,
    ladderSavingsUsdc: 117.50
  }));
  const recent = await listRecentPairEvents(pool, 10);
  assert.equal(recent[0].laddered, true);
  assert.equal(recent[0].ladderSavingsUsdc, 117.50);
});

test("pair-event audit: latency stats compute P50/P95/P99 over activated events", async () => {
  const pool = await buildPool();
  // Insert 100 activated events with latencies 100ms, 200ms, ... 10000ms
  for (let i = 1; i <= 100; i++) {
    await insertPairEvent(pool, baseEvent({
      foxifyPairId: `FX-LAT-${i}`,
      totalLatencyMs: i * 100
    }));
  }
  // Insert one rejected event that should be excluded from stats
  await insertPairEvent(pool, baseEvent({
    foxifyPairId: "FX-REJ-LAT",
    result: "rejected",
    rejectReason: "test",
    totalLatencyMs: 99999  // would skew stats if included
  }));

  const stats = await computePairEventLatencyStats(pool, 24);
  assert.equal(stats.count, 100, "rejected events excluded");
  // Percentile bucketing: floor(n*p) → P50 may be 5000 or 5100 depending on impl
  assert.ok((stats.p50Ms ?? 0) >= 4_900 && (stats.p50Ms ?? 0) <= 5_100);
  assert.ok((stats.p95Ms ?? 0) >= 9_400 && (stats.p95Ms ?? 0) <= 9_600);
  assert.ok((stats.p99Ms ?? 0) >= 9_800 && (stats.p99Ms ?? 0) <= 10_000);
  assert.ok((stats.avgMs ?? 0) >= 4_900 && (stats.avgMs ?? 0) <= 5_100);
});

test("pair-event audit: empty window returns nulls", async () => {
  const pool = await buildPool();
  const stats = await computePairEventLatencyStats(pool, 24);
  assert.equal(stats.count, 0);
  assert.equal(stats.p50Ms, null);
});
