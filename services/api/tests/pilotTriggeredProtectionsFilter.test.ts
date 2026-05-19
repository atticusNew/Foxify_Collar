import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection
} from "../src/pilot/db.js";

// Regression for the 2026-04-22 ghost-rows bug:
//
// The Triggered Trades tab was showing protections that never actually
// triggered (expired naturally without BTC crossing the trigger price).
// Root cause: the SQL filter included `hedge_status IN
// ('expired_settled', 'expired_worthless')` to surface completed
// trades — but those statuses also fire when a non-triggered protection
// runs out its expiry clock.
//
// Fix: only include protections that have a real trigger marker
// (status in (triggered, reconcile_pending), OR metadata.triggeredAt /
// triggerAt set, OR hedge_status='tp_sold' which only ever follows a
// real trigger).
//
// This test reproduces the SQL clause directly and verifies it
// includes/excludes the right rows.

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seed = async (
  pool: any,
  opts: { status: string; hedgeStatus: string; metadata?: Record<string, unknown> }
) => {
  const { id } = await insertProtection(pool, {
    userHash: "test",
    hashVersion: 1,
    status: opts.status as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: opts.hedgeStatus,
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date().toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: opts.metadata || {}
  });
  return id;
};

test("triggered-protections filter — includes only real triggers, excludes natural expiries", async () => {
  const pool = await buildPool();

  const trulyTriggeredA = await seed(pool, {
    status: "triggered",
    hedgeStatus: "active"
  });
  const trulyTriggeredB = await seed(pool, {
    status: "active",
    hedgeStatus: "tp_sold",
    metadata: { triggeredAt: "2026-04-22T12:00:00Z" }
  });
  const trulyTriggeredC = await seed(pool, {
    status: "active",
    hedgeStatus: "tp_sold"  // tp_sold alone qualifies
  });
  const trulyTriggeredD = await seed(pool, {
    status: "reconcile_pending",
    hedgeStatus: "active"
  });
  // Legacy "triggerAt" field (older code path used this name)
  const trulyTriggeredE = await seed(pool, {
    status: "active",
    hedgeStatus: "active",
    metadata: { triggerAt: "2026-04-22T12:00:00Z" }
  });

  // GHOST candidates — these MUST NOT appear in the Triggered tab.
  // Pre-fix behavior incorrectly included these.
  const ghostExpiredSettled = await seed(pool, {
    status: "active",
    hedgeStatus: "expired_settled"  // ran out clock, never triggered
  });
  const ghostExpiredWorthless = await seed(pool, {
    status: "active",
    hedgeStatus: "expired_worthless"
  });
  const ghostStillActive = await seed(pool, {
    status: "active",
    hedgeStatus: "active"
  });

  const result = await pool.query(
    `
      SELECT id FROM pilot_protections p
      WHERE p.status IN ('triggered', 'reconcile_pending')
         OR (p.metadata->>'triggeredAt') IS NOT NULL
         OR (p.metadata->>'triggerAt') IS NOT NULL
         OR p.hedge_status = 'tp_sold'
    `
  );
  const ids = new Set((result.rows as Array<{ id: string }>).map((r) => String(r.id)));

  // Real triggers must be present
  assert.ok(ids.has(trulyTriggeredA), "status=triggered should be included");
  assert.ok(ids.has(trulyTriggeredB), "tp_sold + triggeredAt should be included");
  assert.ok(ids.has(trulyTriggeredC), "tp_sold alone should be included");
  assert.ok(ids.has(trulyTriggeredD), "reconcile_pending should be included");
  assert.ok(ids.has(trulyTriggeredE), "legacy triggerAt should be included");

  // Ghosts must be absent
  assert.ok(!ids.has(ghostExpiredSettled),
    "expired_settled WITHOUT trigger marker should NOT appear (this is the bug fix)");
  assert.ok(!ids.has(ghostExpiredWorthless),
    "expired_worthless WITHOUT trigger marker should NOT appear");
  assert.ok(!ids.has(ghostStillActive),
    "active not-yet-triggered should NOT appear");

  assert.equal(ids.size, 5, "exactly 5 truly-triggered rows");
});

test("triggered-protections filter — expired_settled WITH trigger marker IS still included (real trigger that later expired)", async () => {
  // Edge case: a real trigger fired, hedge wasn't sold, then the
  // protection's expiry cycle ran. status would be expired-something,
  // hedge_status expired_settled, but metadata.triggeredAt IS set
  // because the trigger genuinely fired. This SHOULD appear in the
  // Triggered tab as a real (but unrecovered) trigger.
  const pool = await buildPool();

  const realTriggerThatExpired = await seed(pool, {
    status: "active",
    hedgeStatus: "expired_settled",
    metadata: { triggeredAt: "2026-04-22T12:00:00Z" }
  });

  const result = await pool.query(
    `
      SELECT id FROM pilot_protections p
      WHERE p.status IN ('triggered', 'reconcile_pending')
         OR (p.metadata->>'triggeredAt') IS NOT NULL
         OR (p.metadata->>'triggerAt') IS NOT NULL
         OR p.hedge_status = 'tp_sold'
    `
  );
  const ids = new Set((result.rows as Array<{ id: string }>).map((r) => String(r.id)));
  assert.ok(ids.has(realTriggerThatExpired),
    "real trigger (metadata.triggeredAt present) is included even when later expired");
});
