import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection,
  getProtection
} from "../src/pilot/db.js";
import {
  cancelBiweeklyCloseRequest,
  handleBiweeklyClose,
  requestBiweeklyClose,
  sweepScheduledCloses
} from "../src/pilot/biweeklyClose.js";

// Deferred-close regression coverage (2026-05-06).
//
// Per CEO direction: when a trader requests close mid-day, protection
// stays active until the next billing-day boundary so they get every
// hour of every day they pay for. Status='active' persists; sweep
// converts due requests to actual closes via handleBiweeklyClose.
//
// 6 focused tests:
//   1. requestBiweeklyClose schedules at next billing-day boundary
//   2. Idempotent re-request returns existing schedule (newlyRequested=false)
//   3. cancelBiweeklyCloseRequest clears the schedule (undo)
//   4. sweepScheduledCloses fires due requests via handleBiweeklyClose
//   5. Sweep does NOT close requests that aren't due yet
//   6. Refuses to schedule on already-closed protections

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedBiweekly = async (pool: any, opts: { activatedAtMs: number }) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-deferred-close-test",
    hashVersion: 1,
    status: "active" as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(opts.activatedAtMs + 14 * 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    tenorDays: 14,
    dailyRateUsdPer1k: "2.5",
    metadata: { product: "biweekly", protectionType: "long" }
  });
  await pool.query(
    `UPDATE pilot_protections SET created_at = $1::timestamptz WHERE id = $2`,
    [new Date(opts.activatedAtMs).toISOString(), seeded.id]
  );
  return seeded.id;
};

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

test("requestBiweeklyClose: schedules at next billing-day boundary", async () => {
  const pool = await buildPool();
  const activatedAt = Date.now() - 6 * HOUR_MS; // 6h ago
  const id = await seedBiweekly(pool, { activatedAtMs: activatedAt });

  const result = await requestBiweeklyClose({ pool, protectionId: id });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.newlyRequested, true);
  // 6h elapsed → ceil(0.25) = 1 day → boundary = activation + 24h
  const expectedEffectiveMs = activatedAt + 1 * DAY_MS;
  const actualEffectiveMs = new Date(result.closeEffectiveAt).getTime();
  assert.ok(Math.abs(actualEffectiveMs - expectedEffectiveMs) < 1000, "boundary at activation+24h");
  assert.equal(result.daysBilledAtEffective, 1);
  assert.equal(result.accumulatedChargeAtEffectiveUsd, 25); // 1d × $2.50 × $10k/1000

  // Status stays active so trigger monitor + hedge manager keep working.
  const after = await getProtection(pool, id);
  assert.equal(after!.status, "active");
  assert.equal(after!.closedAt, null);
  assert.ok(after!.closeRequestedAt);
  assert.ok(after!.closeEffectiveAt);
});

test("requestBiweeklyClose: idempotent — second call returns existing schedule with newlyRequested=false", async () => {
  const pool = await buildPool();
  const activatedAt = Date.now() - 6 * HOUR_MS;
  const id = await seedBiweekly(pool, { activatedAtMs: activatedAt });

  const first = await requestBiweeklyClose({ pool, protectionId: id });
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.equal(first.newlyRequested, true);

  const second = await requestBiweeklyClose({ pool, protectionId: id });
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.newlyRequested, false);
  assert.equal(second.closeEffectiveAt, first.closeEffectiveAt);
});

test("cancelBiweeklyCloseRequest: clears the schedule and protection continues normally", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { activatedAtMs: Date.now() - 6 * HOUR_MS });
  await requestBiweeklyClose({ pool, protectionId: id });

  const cancelResult = await cancelBiweeklyCloseRequest({ pool, protectionId: id });
  assert.equal(cancelResult.status, "ok");
  if (cancelResult.status !== "ok") return;
  assert.equal(cancelResult.cleared, true);
  assert.equal(cancelResult.protection.status, "active");
  assert.equal(cancelResult.protection.closeRequestedAt, null);
  assert.equal(cancelResult.protection.closeEffectiveAt, null);

  // Cancel again is a no-op (cleared=false).
  const second = await cancelBiweeklyCloseRequest({ pool, protectionId: id });
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.cleared, false);
});

test("sweepScheduledCloses: fires due requests via handleBiweeklyClose", async () => {
  const pool = await buildPool();
  // Activated 26h ago. We schedule the close as if "now" were 1h after
  // activation (= 25h ago in real time): daysHeld ≈ 1h (under 1d) →
  // ceil = 1 → boundary = activation + 24h = 2h ago in real time → DUE.
  const activatedAt = Date.now() - 26 * HOUR_MS;
  const id = await seedBiweekly(pool, { activatedAtMs: activatedAt });
  await requestBiweeklyClose({ pool, protectionId: id, nowMs: activatedAt + 1 * HOUR_MS });

  const result = await sweepScheduledCloses({ pool });
  assert.equal(result.scanned, 1);
  assert.equal(result.closed, 1);
  assert.equal(result.errors, 0);

  const after = await getProtection(pool, id);
  assert.equal(after!.status, "cancelled");
  assert.equal(after!.closedBy, "user_close");
  assert.ok(after!.closedAt);
  assert.equal(Number(after!.accumulatedChargeUsd), 25); // 1 day billed
});

test("sweepScheduledCloses: leaves not-yet-due requests alone", async () => {
  const pool = await buildPool();
  // Activated 6h ago → boundary in ~18h (not due).
  const id = await seedBiweekly(pool, { activatedAtMs: Date.now() - 6 * HOUR_MS });
  await requestBiweeklyClose({ pool, protectionId: id });

  const result = await sweepScheduledCloses({ pool });
  assert.equal(result.scanned, 0);
  assert.equal(result.closed, 0);

  const after = await getProtection(pool, id);
  assert.equal(after!.status, "active");
  assert.ok(after!.closeRequestedAt, "request still pending");
});

test("requestBiweeklyClose: refuses already-closed protections", async () => {
  const pool = await buildPool();
  const id = await seedBiweekly(pool, { activatedAtMs: Date.now() - 6 * HOUR_MS });

  // Close immediately first via handleBiweeklyClose.
  const closed = await handleBiweeklyClose({
    pool,
    req: { protectionId: id, closedBy: "user_close" }
  });
  assert.equal(closed.status, "ok");

  // Now try to schedule a deferred close on the closed row.
  const result = await requestBiweeklyClose({ pool, protectionId: id });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.reason, "already_closed");
  }
});
