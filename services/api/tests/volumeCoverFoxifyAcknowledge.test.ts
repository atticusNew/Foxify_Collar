/**
 * Unit tests for the 2026-05-24 (PR-F) Foxify-acknowledge mark and the
 * Recent Activity rejected/failed filter.
 *
 * Background: PR-E fixed the dashboard premium projection so triggered
 * positions stop accruing past their trigger moment. That made the Foxify
 * dash numbers reconcile to ledger truth ($770/$1600/+$830 for the May 22-24
 * incident) — but the 2 stale triggered positions were still visible in the
 * "My Active Protections" section because the dash query is `status IN
 * ('active','triggered')`. Closing them via /admin/positions/:id/close is
 * blocked by the route guard (409 position_not_active), and archiving
 * them removes them from BOTH the active list AND the lifetime aggregate
 * (which is the wrong tradeoff — the financial obligation is still real).
 *
 * PR-F adds a third state: foxify_acknowledged. The position is hidden
 * from the Active Protections list but stays counted in the lifetime
 * Premium Paid + Payout Expecting + Net Foxify aggregates.
 *
 * Plus a Recent Activity filter to suppress 'rejected' and 'failed' events
 * (lifetime_cap_exceeded, daily_throttle, leg_*_submit_error, etc.) so the
 * Foxify-facing feed shows only signal events.
 */

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
  getPosition,
  insertPairEvent,
  listRecentPairEvents,
  markPositionFoxifyAcknowledged,
  markPositionTriggered
} from "../src/volumeCover/volumeCoverDb";
import { openPosition } from "../src/volumeCover/positionLifecycle";
import { findCellById } from "../src/volumeCover/matrix";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";

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

const buildMockExecutor = (overrides: Partial<HedgeExecutor> = {}): HedgeExecutor => ({
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-BUY-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 5,
    totalProceedsUsdc: 5 * params.contractsBtc,
    orderId: `MOCK-SELL-${Math.random()}`
  }),
  ...overrides
});

// ────────────────────── markPositionFoxifyAcknowledged ──────────────────────

test("PR-F: markPositionFoxifyAcknowledged sets metadata + preserves prior keys", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-PRF-ACK-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await markPositionTriggered(pool, {
    id: opened.position.id,
    direction: "low"
  });

  // Seed a pre-existing metadata key so we can verify the merge preserves it.
  // Mirrors a realistic case where the position was opened via /admin/test-activate
  // (which sets metadata.source) or had any other prior metadata write.
  await pool.query(
    `UPDATE volume_cover_position SET metadata = $2::jsonb WHERE id = $1`,
    [opened.position.id, JSON.stringify({ source: "foxify_api", regime: "calm" })]
  );

  const updated = await markPositionFoxifyAcknowledged(pool, {
    id: opened.position.id,
    reason: "stale_triggered_pre_hybrid_v3_dash_cleanup",
    acknowledgedByToken: "abc123def456"
  });

  assert.ok(updated, "must return updated position row");
  const meta = updated!.metadata as Record<string, unknown>;
  // New keys present
  assert.equal(meta.foxify_acknowledged, true);
  assert.equal(meta.foxify_acknowledged_reason, "stale_triggered_pre_hybrid_v3_dash_cleanup");
  assert.match(
    String(meta.foxify_acknowledged_at),
    /^\d{4}-\d{2}-\d{2}T/,
    "ISO timestamp expected"
  );
  // Token prefix MUST be redacted (first 6 chars only)
  assert.equal(meta.foxify_acknowledged_by_token_prefix, "abc123...");
  // Prior metadata keys MUST survive the merge
  assert.equal(meta.source, "foxify_api", "pre-existing source key must survive merge");
  assert.equal(meta.regime, "calm", "pre-existing regime key must survive merge");
});

test("PR-F: markPositionFoxifyAcknowledged returns null for missing position", async () => {
  const pool = await buildPool();
  const result = await markPositionFoxifyAcknowledged(pool, {
    id: "vc-pos-does-not-exist",
    reason: "test"
  });
  assert.equal(result, null);
});

test("PR-F: markPositionFoxifyAcknowledged is idempotent — second call overwrites reason+at", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-PRF-ACK-IDEMPOTENT",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await markPositionTriggered(pool, { id: opened.position.id, direction: "low" });

  await markPositionFoxifyAcknowledged(pool, {
    id: opened.position.id,
    reason: "first_attempt"
  });
  // Sleep 5ms so the timestamps differ in the merge
  await new Promise((r) => setTimeout(r, 5));
  const second = await markPositionFoxifyAcknowledged(pool, {
    id: opened.position.id,
    reason: "second_attempt_with_better_reason"
  });

  const meta = second!.metadata as Record<string, unknown>;
  assert.equal(meta.foxify_acknowledged, true);
  assert.equal(meta.foxify_acknowledged_reason, "second_attempt_with_better_reason");
});

// ────────────────────── listRecentPairEvents excludeResults ──────────────────────

test("PR-F: listRecentPairEvents with excludeResults filters out rejected+failed", async () => {
  const pool = await buildPool();

  // Seed the activity log with a realistic mix matching the May 22-24 dash:
  // 1 activated (real position open), then a barrage of failed/rejected
  // events from bot retry storms.
  const seedEvent = async (overrides: {
    foxifyPairId: string;
    result: "activated" | "idempotent" | "rejected" | "failed";
    rejectReason?: string | null;
    receivedAtIso: string;
  }) => {
    await insertPairEvent(pool, {
      foxifyPairId: overrides.foxifyPairId,
      cellId: "50k_2pct_1k",
      fingerprintHash: null,
      pairEntryBtcPrice: 80_000,
      result: overrides.result,
      rejectReason: overrides.rejectReason ?? null,
      positionId: null,
      receivedAtIso: overrides.receivedAtIso,
      guardsPassedAtIso: null,
      hedgeBuySubmittedAtIso: null,
      hedgeFillAtIso: null,
      responseSentAtIso: overrides.receivedAtIso,
      totalLatencyMs: 100,
      laddered: false,
      ladderSavingsUsdc: 0,
      metadata: {}
    });
  };

  await seedEvent({ foxifyPairId: "p1", result: "activated", receivedAtIso: "2026-05-23T15:00:00Z" });
  await seedEvent({ foxifyPairId: "p2", result: "rejected", rejectReason: "lifetime_cap_exceeded", receivedAtIso: "2026-05-23T15:01:00Z" });
  await seedEvent({ foxifyPairId: "p3", result: "rejected", rejectReason: "daily_throttle_exceeded", receivedAtIso: "2026-05-23T15:02:00Z" });
  await seedEvent({ foxifyPairId: "p4", result: "failed", rejectReason: "leg_put_long_submit_error", receivedAtIso: "2026-05-23T15:03:00Z" });
  await seedEvent({ foxifyPairId: "p5", result: "activated", receivedAtIso: "2026-05-23T15:04:00Z" });
  await seedEvent({ foxifyPairId: "p6", result: "idempotent", receivedAtIso: "2026-05-23T15:05:00Z" });

  // No filter — admin view sees everything
  const adminAll = await listRecentPairEvents(pool, 100);
  assert.equal(adminAll.length, 6, "admin view returns all 6 events");

  // PR-F filter — Foxify view excludes rejected + failed
  const foxifyView = await listRecentPairEvents(pool, 100, {
    excludeResults: ["rejected", "failed"]
  });
  assert.equal(foxifyView.length, 3, "Foxify view returns 3 (2 activated + 1 idempotent)");

  const visibleResults = foxifyView.map((e) => e.result).sort();
  assert.deepEqual(
    visibleResults,
    ["activated", "activated", "idempotent"],
    "only success-class results are visible to Foxify"
  );
});

test("PR-F: listRecentPairEvents excludeResults=[] is identical to no filter", async () => {
  const pool = await buildPool();
  await insertPairEvent(pool, {
    foxifyPairId: "p1",
    cellId: "50k_2pct_1k",
    fingerprintHash: null,
    pairEntryBtcPrice: 80_000,
    result: "rejected",
    rejectReason: "test_reason",
    positionId: null,
    receivedAtIso: "2026-05-23T15:00:00Z",
    guardsPassedAtIso: null,
    hedgeBuySubmittedAtIso: null,
    hedgeFillAtIso: null,
    responseSentAtIso: "2026-05-23T15:00:00Z",
    totalLatencyMs: 100,
    laddered: false,
    ladderSavingsUsdc: 0,
    metadata: {}
  });

  const noFilter = await listRecentPairEvents(pool, 100);
  const emptyFilter = await listRecentPairEvents(pool, 100, { excludeResults: [] });

  assert.equal(noFilter.length, 1);
  assert.equal(emptyFilter.length, 1);
  assert.equal(noFilter[0].id, emptyFilter[0].id);
});

test("PR-F: listRecentPairEvents respects DESC ordering with filter applied", async () => {
  const pool = await buildPool();
  // Seed in non-monotonic order to confirm ORDER BY received_at DESC
  await insertPairEvent(pool, {
    foxifyPairId: "old",
    cellId: "50k_2pct_1k",
    fingerprintHash: null,
    pairEntryBtcPrice: 80_000,
    result: "activated",
    rejectReason: null,
    positionId: null,
    receivedAtIso: "2026-05-20T10:00:00Z",
    guardsPassedAtIso: null,
    hedgeBuySubmittedAtIso: null,
    hedgeFillAtIso: null,
    responseSentAtIso: "2026-05-20T10:00:00Z",
    totalLatencyMs: 100,
    laddered: false,
    ladderSavingsUsdc: 0,
    metadata: {}
  });
  await insertPairEvent(pool, {
    foxifyPairId: "new",
    cellId: "50k_2pct_1k",
    fingerprintHash: null,
    pairEntryBtcPrice: 80_000,
    result: "activated",
    rejectReason: null,
    positionId: null,
    receivedAtIso: "2026-05-23T10:00:00Z",
    guardsPassedAtIso: null,
    hedgeBuySubmittedAtIso: null,
    hedgeFillAtIso: null,
    responseSentAtIso: "2026-05-23T10:00:00Z",
    totalLatencyMs: 100,
    laddered: false,
    ladderSavingsUsdc: 0,
    metadata: {}
  });

  const filtered = await listRecentPairEvents(pool, 100, {
    excludeResults: ["rejected", "failed"]
  });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].foxifyPairId, "new", "newest first (DESC by received_at)");
  assert.equal(filtered[1].foxifyPairId, "old");
});

test("PR-F: listRecentPairEvents excludeResults LIMIT applies AFTER filtering", async () => {
  const pool = await buildPool();
  // 5 rejected events + 2 activated. With limit=3 and the rejected filter
  // we should still get 2 activated events back, NOT zero (which would
  // happen if we LIMITed before filtering).
  const seedAt = async (id: string, result: "activated" | "rejected", iso: string) => {
    await insertPairEvent(pool, {
      foxifyPairId: id,
      cellId: "50k_2pct_1k",
      fingerprintHash: null,
      pairEntryBtcPrice: 80_000,
      result,
      rejectReason: result === "rejected" ? "noise" : null,
      positionId: null,
      receivedAtIso: iso,
      guardsPassedAtIso: null,
      hedgeBuySubmittedAtIso: null,
      hedgeFillAtIso: null,
      responseSentAtIso: iso,
      totalLatencyMs: 100,
      laddered: false,
      ladderSavingsUsdc: 0,
      metadata: {}
    });
  };
  await seedAt("noise1", "rejected", "2026-05-23T15:01:00Z");
  await seedAt("noise2", "rejected", "2026-05-23T15:02:00Z");
  await seedAt("noise3", "rejected", "2026-05-23T15:03:00Z");
  await seedAt("real1", "activated", "2026-05-23T15:04:00Z");
  await seedAt("noise4", "rejected", "2026-05-23T15:05:00Z");
  await seedAt("noise5", "rejected", "2026-05-23T15:06:00Z");
  await seedAt("real2", "activated", "2026-05-23T15:07:00Z");

  const result = await listRecentPairEvents(pool, 100, {
    excludeResults: ["rejected", "failed"]
  });
  assert.equal(result.length, 2);
  const ids = result.map((e) => e.foxifyPairId).sort();
  assert.deepEqual(ids, ["real1", "real2"]);
});
