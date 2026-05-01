import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensurePilotSchema,
  getProtection,
  insertProtection,
  patchProtectionForStatus
} from "../src/pilot/db.js";

// Regression test for the new auto-renew toggle endpoint behavior at the
// data-layer level. The HTTP route in routes.ts adds 404/409/idempotent-replay
// handling on top of this; we exercise the underlying patch + optimistic-lock
// semantics here, since those are the load-bearing primitives the endpoint
// composes.

const buildMemPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

test("auto-renew toggle: patchProtectionForStatus flips auto_renew + appends audit metadata, optimistic lock guards on status", async () => {
  const pool = await buildMemPool();

  // Seed a protection with auto_renew=true and a partial metadata payload.
  const seeded = await insertProtection(pool, {
    userHash: "h1",
    hashVersion: 1,
    status: "active",
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: true,
    renewWindowMinutes: 1440,
    metadata: { quoteId: "q-seed", protectionType: "long" }
  });
  assert.equal(seeded.autoRenew, true, "seeded with auto_renew=true");

  // ── 1. Toggle OFF on an active protection: should succeed and append audit ──
  const auditTs = new Date().toISOString();
  const auditEntry = { ts: auditTs, enabled: false, previous: true };
  const off = await patchProtectionForStatus(pool, {
    id: seeded.id,
    expectedStatus: "active",
    patch: {
      auto_renew: false,
      metadata: {
        ...(seeded.metadata || {}),
        autoRenewToggles: [auditEntry],
        lastAutoRenewToggleAt: auditTs,
        lastAutoRenewToggleValue: false
      }
    }
  });
  assert.ok(off, "expected non-null on successful toggle");
  assert.equal(off!.autoRenew, false, "auto_renew flipped to false");
  const offMd = off!.metadata as Record<string, unknown>;
  assert.equal(offMd.quoteId, "q-seed", "prior metadata preserved");
  assert.equal(offMd.lastAutoRenewToggleValue, false, "audit field set");
  assert.ok(Array.isArray(offMd.autoRenewToggles), "audit array exists");
  assert.equal((offMd.autoRenewToggles as any[]).length, 1, "one audit entry recorded");

  // ── 2. Toggle ON again: audit array grows, value flips back ──
  const auditTs2 = new Date(Date.now() + 1000).toISOString();
  const auditEntry2 = { ts: auditTs2, enabled: true, previous: false };
  const on = await patchProtectionForStatus(pool, {
    id: seeded.id,
    expectedStatus: "active",
    patch: {
      auto_renew: true,
      metadata: {
        ...(off!.metadata || {}),
        autoRenewToggles: [
          ...((off!.metadata as any)?.autoRenewToggles || []),
          auditEntry2
        ],
        lastAutoRenewToggleAt: auditTs2,
        lastAutoRenewToggleValue: true
      }
    }
  });
  assert.ok(on, "expected non-null on second toggle");
  assert.equal(on!.autoRenew, true, "auto_renew flipped back to true");
  const onMd = on!.metadata as Record<string, unknown>;
  assert.equal((onMd.autoRenewToggles as any[]).length, 2, "two audit entries");
  assert.equal(onMd.lastAutoRenewToggleValue, true, "audit reflects latest toggle");

  // ── 3. Optimistic-lock guard: try to toggle a protection whose status changed ──
  // Manually flip the row to 'triggered' to simulate the scheduler racing.
  await pool.query(
    `UPDATE pilot_protections SET status = 'triggered' WHERE id = $1`,
    [seeded.id]
  );
  const blocked = await patchProtectionForStatus(pool, {
    id: seeded.id,
    expectedStatus: "active",
    patch: { auto_renew: false }
  });
  assert.equal(
    blocked,
    null,
    "optimistic lock should reject toggle once status leaves 'active' (return null → endpoint surfaces 409)"
  );

  // Confirm the row still has the prior auto_renew=true (no blind overwrite).
  const fresh = await getProtection(pool, seeded.id);
  assert.equal(fresh?.autoRenew, true, "auto_renew value unchanged after blocked toggle");
  assert.equal(fresh?.status, "triggered", "status unchanged from manual update");
});
