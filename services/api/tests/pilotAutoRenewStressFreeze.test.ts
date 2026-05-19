import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection
} from "../src/pilot/db.js";
import { runAutoRenewCycle } from "../src/pilot/autoRenew.js";
import {
  __resetRegimeClassifierForTests,
  __setCachedRegimeForTests
} from "../src/pilot/regimeClassifier.js";

// PR B (Gap 4) — auto-renew freeze in stress regime regression tests.
//
// We don't need a working venue; the freeze short-circuits before any
// quote is requested. A no-op venue stub is sufficient.
//
// Coverage targets:
//   1. Stress regime → cycle short-circuits with frozenForRegime set,
//      no protections renewed, no venue calls, no errors.
//   2. Normal/calm regime → cycle proceeds (we test that it doesn't
//      short-circuit; full renewal flow has its own tests).
//   3. Override env var → freeze bypassed even in stress.

const noOpVenue = {
  name: "noop_test",
  health: async () => ({ status: "ok" }),
  quote: async () => {
    throw new Error("venue.quote should not be called when freeze is active");
  },
  execute: async () => {
    throw new Error("venue.execute should not be called when freeze is active");
  }
} as any;

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedExpiringRenewable = async (pool: any) => {
  // Seed a single auto-renew=true protection that's about to expire,
  // so the queryExpiringProtections SQL would normally pick it up.
  const expiringSoon = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10m from now
  return (
    await insertProtection(pool, {
      userHash: "u_freeze_test",
      hashVersion: 1,
      status: "active" as any,
      tierName: "SL 2%",
      drawdownFloorPct: "0.02",
      slPct: 2,
      hedgeStatus: "active",
      marketId: "BTC-USD",
      protectedNotional: "10000",
      foxifyExposureNotional: "10000",
      expiryAt: expiringSoon,
      autoRenew: true,
      renewWindowMinutes: 1440,
      metadata: {}
    })
  ).id;
};

test("Gap 4 — stress regime freezes the entire renewal cycle (no venue calls, no renewals)", async () => {
  const pool = await buildPool();
  await seedExpiringRenewable(pool);

  __resetRegimeClassifierForTests();
  __setCachedRegimeForTests({
    regime: "stress",
    dvol: 95,
    rvol: null,
    source: "dvol",
    timestamp: new Date().toISOString()
  });
  delete process.env.PILOT_AUTO_RENEW_STRESS_ALLOWED;

  const result = await runAutoRenewCycle({ pool, venue: noOpVenue });

  assert.equal(result.frozenForRegime, "stress", "cycle reports frozen for stress regime");
  assert.equal(result.scanned, 0, "no protections scanned (cycle short-circuited)");
  assert.equal(result.renewed, 0, "no renewals");
  assert.equal(result.errors, 0, "no errors");
  // The implicit assertion is that the noOpVenue.quote/execute throws if
  // called — we'd see errors > 0 if the freeze didn't short-circuit.
});

test("Gap 4 — calm regime allows renewal cycle to proceed past the freeze check", async () => {
  const pool = await buildPool();
  // No seed needed — we just verify the cycle does NOT short-circuit
  // on regime grounds. The downstream noOpVenue would throw if it
  // got to a quote, but we're not seeding any expiring protections,
  // so the SQL query returns empty.

  __resetRegimeClassifierForTests();
  __setCachedRegimeForTests({
    regime: "calm",
    dvol: 35,
    rvol: null,
    source: "dvol",
    timestamp: new Date().toISOString()
  });
  delete process.env.PILOT_AUTO_RENEW_STRESS_ALLOWED;

  const result = await runAutoRenewCycle({ pool, venue: noOpVenue });

  assert.equal(result.frozenForRegime, undefined, "no freeze in calm regime");
  assert.equal(result.scanned, 0, "no expiring protections to scan in this test");
});

test("Gap 4 — env override (PILOT_AUTO_RENEW_STRESS_ALLOWED=true) bypasses the freeze even in stress", async () => {
  const pool = await buildPool();
  // No seed. Just verify the freeze does NOT engage when the override
  // env is set.

  __resetRegimeClassifierForTests();
  __setCachedRegimeForTests({
    regime: "stress",
    dvol: 95,
    rvol: null,
    source: "dvol",
    timestamp: new Date().toISOString()
  });
  process.env.PILOT_AUTO_RENEW_STRESS_ALLOWED = "true";

  try {
    const result = await runAutoRenewCycle({ pool, venue: noOpVenue });
    assert.equal(result.frozenForRegime, undefined, "override bypasses freeze");
    assert.equal(result.scanned, 0, "no expiring protections seeded for this test");
  } finally {
    delete process.env.PILOT_AUTO_RENEW_STRESS_ALLOWED;
  }
});
