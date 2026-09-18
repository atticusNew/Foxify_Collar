/**
 * Tests for the position-archive feature (2026-05-22).
 *
 * Coverage:
 *   1. DB layer (`markPositionArchived` + salvage-stat exclusion)
 *      - markPositionArchived sets metadata.archived=true + reason + ts
 *      - computeRollingSalvageStats excludes archived positions
 *      - countTriggersInWindow excludes archived positions
 *      - sumNetLossInWindow excludes archived positions
 *      - Non-archived positions are still counted normally
 *
 *   2. Route layer (POST /volume-cover/admin/positions/:id/archive)
 *      - 403 without admin token
 *      - 404 on unknown position
 *      - 400 when reason missing/empty
 *      - 409 when any hedge leg is still status='open'
 *      - 200 happy path with full audit metadata in response
 *      - Idempotent: second archive returns alreadyArchived=true
 *      - Side-effect: salvage stats exclude the archived position
 *
 * No changes to the default behavior of the system: an archive endpoint
 * must be explicitly called, otherwise all positions remain visible.
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  registerVolumeCoverRoutes,
  __resetVolumeCoverRoutesForTests
} from "../src/volumeCover/volumeCoverRoutes";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded,
  insertPosition,
  insertHedgeLeg,
  markHedgeLegSold,
  insertSalvageEvent,
  markPositionArchived,
  computeRollingSalvageStats,
  countTriggersInWindow,
  sumNetLossInWindow,
  getPosition
} from "../src/volumeCover/volumeCoverDb";
import { __resetCircuitBreakerForTests } from "../src/pilot/circuitBreaker";
import { __resetVolumeCoverGuardrailsForTests } from "../src/volumeCover/volumeCoverGuardrails";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";
import type { SpotPriceSource } from "../src/volumeCover/triggerDetector";

const ADMIN_TOKEN = "test-admin-token-archive-1234567890";

const mockExecutor: HedgeExecutor = {
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 80,
    totalProceedsUsdc: 80 * params.contractsBtc,
    orderId: `MOCK-SELL-${Math.random()}`
  })
};

const mockSpotSource: SpotPriceSource = async () => ({
  spotBtcPrice: 80_000,
  asOfMs: Date.now(),
  source: "test_mock"
});

const buildPoolOnly = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  return pool;
};

const buildRouteHarness = async () => {
  process.env.PILOT_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FOXIFY_API_KEY_HMAC_SECRET = "secret";
  process.env.PILOT_GUARDS_ALL_DISABLED = "true";
  process.env.VOLUME_COVER_GUARDS_ALL_DISABLED = "false";
  __resetVolumeCoverRoutesForTests();
  __resetVolumeCoverGuardrailsForTests();
  __resetCircuitBreakerForTests();

  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);

  const app = Fastify();
  await registerVolumeCoverRoutes(app, {
    pool,
    hedgeExecutor: mockExecutor,
    spotSource: mockSpotSource
  });
  await app.ready();
  return {
    app,
    pool,
    close: async () => {
      await app.close();
      await pool.end?.();
    }
  };
};

const adminHeaders = () => ({
  "x-admin-token": ADMIN_TOKEN,
  "content-type": "application/json"
});

const samplePosition = (overrides: Partial<{ id: string; foxifyPairId: string }> = {}) => ({
  id: overrides.id ?? "vc-pos-archive-1",
  cellId: "50k_2pct_1k" as const,
  foxifyPairId: overrides.foxifyPairId ?? "FX-PAIR-ARCHIVE",
  pairLongNotionalUsdc: 50_000,
  pairShortNotionalUsdc: 50_000,
  pairEntryBtcPrice: 80_000,
  triggerHighBtc: 81_600,
  triggerLowBtc: 78_400,
  dailyPremiumUsdc: 350,
  payoutUsdc: 1_000
});

// ─── DB-layer tests ───────────────────────────────────────────────

test("markPositionArchived sets metadata.archived=true with reason + timestamp", async () => {
  const pool = await buildPoolOnly();
  await insertPosition(pool, samplePosition());
  const result = await markPositionArchived(pool, {
    id: "vc-pos-archive-1",
    reason: "test_trade_no_business_value",
    archivedByToken: "tok-abc123def456"
  });
  assert.ok(result);
  assert.equal((result!.metadata as any).archived, true);
  assert.equal((result!.metadata as any).archive_reason, "test_trade_no_business_value");
  assert.ok(typeof (result!.metadata as any).archived_at === "string");
  assert.equal((result!.metadata as any).archived_by_token_prefix, "tok-ab...");
});

test("markPositionArchived preserves prior metadata keys", async () => {
  const pool = await buildPoolOnly();
  await insertPosition(pool, samplePosition({ id: "vc-meta-prior" }));
  await pool.query(
    `UPDATE volume_cover_position SET metadata = '{"foo":"bar"}'::jsonb WHERE id = $1`,
    ["vc-meta-prior"]
  );
  await markPositionArchived(pool, {
    id: "vc-meta-prior",
    reason: "merge_test"
  });
  const after = await getPosition(pool, "vc-meta-prior");
  assert.equal((after!.metadata as any).foo, "bar");
  assert.equal((after!.metadata as any).archived, true);
});

test("computeRollingSalvageStats excludes archived positions", async () => {
  const pool = await buildPoolOnly();
  // Two triggers: one normal, one will be archived
  await insertPosition(pool, samplePosition({ id: "vc-good", foxifyPairId: "FX-G" }));
  await insertPosition(pool, samplePosition({ id: "vc-bad-test", foxifyPairId: "FX-B" }));

  await insertSalvageEvent(pool, {
    id: "salv-good",
    positionId: "vc-good",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 900 // 90% salvage
  });
  await insertSalvageEvent(pool, {
    id: "salv-bad",
    positionId: "vc-bad-test",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 0 // 0% salvage — would drag average down
  });

  // Without archive: avg = 45%
  const before = await computeRollingSalvageStats(pool, 5);
  assert.equal(before.count, 2);
  assert.equal(Number(before.avgSalvagePct?.toFixed(2)), 0.45);

  // After archive: only the good event remains in stats
  await markPositionArchived(pool, {
    id: "vc-bad-test",
    reason: "phantom_leg_test_trade"
  });
  const after = await computeRollingSalvageStats(pool, 5);
  assert.equal(after.count, 1);
  assert.equal(Number(after.avgSalvagePct?.toFixed(2)), 0.90);
});

test("countTriggersInWindow excludes archived positions", async () => {
  const pool = await buildPoolOnly();
  await insertPosition(pool, samplePosition({ id: "vc-keep", foxifyPairId: "FX-K" }));
  await insertPosition(pool, samplePosition({ id: "vc-hide", foxifyPairId: "FX-H" }));
  await insertSalvageEvent(pool, {
    id: "t-k",
    positionId: "vc-keep",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 800
  });
  await insertSalvageEvent(pool, {
    id: "t-h",
    positionId: "vc-hide",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 800
  });
  assert.equal(await countTriggersInWindow(pool, 24), 2);
  await markPositionArchived(pool, { id: "vc-hide", reason: "test" });
  assert.equal(await countTriggersInWindow(pool, 24), 1);
});

test("sumNetLossInWindow excludes archived positions", async () => {
  const pool = await buildPoolOnly();
  await insertPosition(pool, samplePosition({ id: "vc-real", foxifyPairId: "FX-R" }));
  await insertPosition(pool, samplePosition({ id: "vc-test", foxifyPairId: "FX-T" }));
  await insertSalvageEvent(pool, {
    id: "l-real",
    positionId: "vc-real",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 700 // $300 net loss
  });
  await insertSalvageEvent(pool, {
    id: "l-test",
    positionId: "vc-test",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 0 // $1000 net loss — would trigger kill switch
  });
  // Before archive: $1,300 total loss — would trip $1k kill switch
  assert.equal(await sumNetLossInWindow(pool, 24 * 7), 1_300);
  await markPositionArchived(pool, {
    id: "vc-test",
    reason: "test_trade_dont_count_against_kill_switch"
  });
  // After archive: only $300 of real loss remains
  assert.equal(await sumNetLossInWindow(pool, 24 * 7), 300);
});

// ─── Route-layer tests ────────────────────────────────────────────

test("POST /admin/positions/:id/archive rejects without admin token", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition());
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      payload: { reason: "test" }
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await harness.close();
  }
});

test("POST /admin/positions/:id/archive returns 404 for unknown id", async () => {
  const harness = await buildRouteHarness();
  try {
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-nonexistent/archive",
      headers: adminHeaders(),
      payload: { reason: "test" }
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, "position_not_found");
  } finally {
    await harness.close();
  }
});

test("POST /admin/positions/:id/archive returns 400 when reason missing/empty", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition());
    const noReason = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: {}
    });
    assert.equal(noReason.statusCode, 400);
    assert.equal(noReason.json().error, "missing_reason");

    const emptyReason = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: { reason: "   " }
    });
    assert.equal(emptyReason.statusCode, 400);
  } finally {
    await harness.close();
  }
});

test("POST /admin/positions/:id/archive returns 409 when hedge legs are still open", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition());
    await insertHedgeLeg(harness.pool, {
      id: "leg-still-open",
      positionId: "vc-pos-archive-1",
      venue: "deribit",
      optionKind: "put",
      strikeUsdc: 79_200,
      expiryIso: "2026-05-25T08:00:00Z",
      contracts: 1.0,
      buyPriceUsdc: 100,
      status: "open"
    });
    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: { reason: "test_archive_with_open_leg" }
    });
    assert.equal(r.statusCode, 409);
    const body = r.json();
    assert.equal(body.error, "open_legs_present");
    assert.deepEqual(body.openLegIds, ["leg-still-open"]);
  } finally {
    await harness.close();
  }
});

test("POST /admin/positions/:id/archive succeeds when all legs are wound down", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition());
    await insertHedgeLeg(harness.pool, {
      id: "leg-sold",
      positionId: "vc-pos-archive-1",
      venue: "deribit",
      optionKind: "put",
      strikeUsdc: 79_200,
      expiryIso: "2026-05-25T08:00:00Z",
      contracts: 1.0,
      buyPriceUsdc: 100
    });
    await markHedgeLegSold(harness.pool, { id: "leg-sold", sellPriceUsdc: 90 });
    await insertHedgeLeg(harness.pool, {
      id: "leg-failed",
      positionId: "vc-pos-archive-1",
      venue: "bullish",
      optionKind: "call",
      strikeUsdc: 80_800,
      expiryIso: "2026-05-25T08:00:00Z",
      contracts: 1.0,
      buyPriceUsdc: 100,
      status: "failed"
    });

    const r = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: { reason: "may18_bullish_test_trade_no_business_value" }
    });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.archived, true);
    assert.equal(body.archiveMetadata.archive_reason, "may18_bullish_test_trade_no_business_value");
    assert.ok(Array.isArray(body.excludedFrom));
    assert.ok(body.excludedFrom.length >= 4);
  } finally {
    await harness.close();
  }
});

test("POST /admin/positions/:id/archive is idempotent — second call returns alreadyArchived", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition());

    const first = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: { reason: "first_call" }
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().archived, true);

    const second = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-pos-archive-1/archive",
      headers: adminHeaders(),
      payload: { reason: "second_call_should_no_op" }
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().alreadyArchived, true);
    assert.equal(second.json().archiveMetadata.archive_reason, "first_call");
  } finally {
    await harness.close();
  }
});

test("End-to-end: archive removes position from rolling salvage stat", async () => {
  const harness = await buildRouteHarness();
  try {
    await insertPosition(harness.pool, samplePosition({ id: "vc-real-trade", foxifyPairId: "FX-R" }));
    await insertPosition(harness.pool, samplePosition({ id: "vc-test-trade", foxifyPairId: "FX-T" }));
    await insertSalvageEvent(harness.pool, {
      id: "s-real",
      positionId: "vc-real-trade",
      triggeredDirection: "low",
      payoutOwedUsdc: 1_000,
      hedgeSaleProceedsUsdc: 900 // 90% salvage
    });
    await insertSalvageEvent(harness.pool, {
      id: "s-test",
      positionId: "vc-test-trade",
      triggeredDirection: "high",
      payoutOwedUsdc: 1_000,
      hedgeSaleProceedsUsdc: 0 // 0% salvage — phantom-leg test trade
    });

    // Confirm both events count before archive
    const beforeStats = await computeRollingSalvageStats(harness.pool, 5);
    assert.equal(beforeStats.count, 2);

    // Archive the test trade via the route
    const archiveRes = await harness.app.inject({
      method: "POST",
      url: "/volume-cover/admin/positions/vc-test-trade/archive",
      headers: adminHeaders(),
      payload: { reason: "phantom_leg_validation" }
    });
    assert.equal(archiveRes.statusCode, 200);

    // Salvage stat now reflects only the real trade
    const afterStats = await computeRollingSalvageStats(harness.pool, 5);
    assert.equal(afterStats.count, 1);
    assert.equal(Number(afterStats.avgSalvagePct?.toFixed(2)), 0.90);
  } finally {
    await harness.close();
  }
});
