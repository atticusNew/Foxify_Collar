import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensurePilotSchema,
  getDailyTierUsageForUser,
  insertProtection,
  sumActiveProtectionNotional
} from "../src/pilot/db.js";

// R2.B / R2.D — DB-layer regression tests for the new cap-enforcement
// helpers. The HTTP route additions in routes.ts compose these primitives;
// we exercise the primitives here to ensure they correctly:
//   - Sum protected_notional only over OPEN statuses (active, pending, triggered)
//   - Exclude expired/cancelled/failed protections from the active sum
//   - Group correctly by sl_pct for per-tier tally
//   - Bracket the daily window correctly (date inclusion)

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const insertN = async (
  pool: any,
  opts: {
    userHash: string;
    status: string;
    notional: number;
    slPct?: number;
    createdAtIso?: string;
  }
) => {
  const id = await insertProtection(pool, {
    userHash: opts.userHash,
    hashVersion: 1,
    status: opts.status as any,
    tierName: opts.slPct ? `SL ${opts.slPct}%` : "SL 2%",
    drawdownFloorPct: opts.slPct ? String(opts.slPct / 100) : "0.02",
    slPct: opts.slPct ?? 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: String(opts.notional),
    foxifyExposureNotional: String(opts.notional),
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {}
  });
  if (opts.createdAtIso) {
    await pool.query(
      `UPDATE pilot_protections SET created_at = $1 WHERE id = $2`,
      [opts.createdAtIso, id.id]
    );
  }
  return id;
};

test("sumActiveProtectionNotional + getDailyTierUsageForUser correctly count only open / per-tier / per-day rows (R2.B + R2.D)", async () => {
  const pool = await buildPool();

  // Seed a mix of statuses for one user across multiple tiers and days.
  const today = new Date(Date.UTC(2026, 3, 19, 12, 0, 0));
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
  const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
  const dayEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString();

  // OPEN today — counted in active sum AND today's tier sum
  await insertN(pool, { userHash: "u1", status: "active", notional: 10000, slPct: 2, createdAtIso: today.toISOString() });
  await insertN(pool, { userHash: "u1", status: "active", notional: 25000, slPct: 2, createdAtIso: today.toISOString() });
  await insertN(pool, { userHash: "u1", status: "active", notional: 15000, slPct: 3, createdAtIso: today.toISOString() });

  // pending_activation today — counted in active sum AND today's tier sum
  await insertN(pool, { userHash: "u1", status: "pending_activation", notional: 5000, slPct: 5, createdAtIso: today.toISOString() });

  // triggered today — counted in active sum AND today's tier sum
  await insertN(pool, { userHash: "u1", status: "triggered", notional: 20000, slPct: 2, createdAtIso: today.toISOString() });

  // expired_otm today — NOT counted in active, NOT counted in active tier sum
  // BUT IS counted in today's tier-usage by createdAt (per R2.D logic which
  // sums by created_at regardless of status, mirroring the existing daily
  // cap behavior).
  await insertN(pool, { userHash: "u1", status: "expired_otm", notional: 8000, slPct: 2, createdAtIso: today.toISOString() });

  // cancelled today — same: not active, but counted in tier-usage by createdAt
  await insertN(pool, { userHash: "u1", status: "cancelled", notional: 7000, slPct: 2, createdAtIso: today.toISOString() });

  // active YESTERDAY — counted in active sum (still open today) but NOT in
  // today's tier-usage window (created_at < today's start)
  await insertN(pool, { userHash: "u1", status: "active", notional: 12000, slPct: 2, createdAtIso: yesterday.toISOString() });

  // active for a DIFFERENT user — must not pollute u1's totals
  await insertN(pool, { userHash: "u2", status: "active", notional: 99999, slPct: 2, createdAtIso: today.toISOString() });

  // ── Assert: aggregate active sum for u1 ────────────────────────────────
  const active = Number(await sumActiveProtectionNotional(pool, "u1"));
  // active(today): 10000 + 25000 + 15000 = 50000
  // pending_activation(today): 5000
  // triggered(today): 20000
  // active(yesterday, still open): 12000
  // expired/cancelled NOT counted: 8000+7000=15000 excluded
  // u2: not in u1 sum
  // expected: 50000 + 5000 + 20000 + 12000 = 87000
  assert.equal(active, 87000, "aggregate active sum should include active+pending+triggered, exclude expired/cancelled");

  // ── Assert: per-tier usage for u1 today by SL tier ─────────────────────
  const tier2Today = Number(await getDailyTierUsageForUser(pool, "u1", 2, dayStart, dayEnd));
  // Today's SL 2% rows: 10000 + 25000 + 20000 + 8000 + 7000 = 70000
  // (yesterday's 12000 NOT counted; expired/cancelled count toward today's
  // tier USAGE since they consumed the daily cap when activated)
  assert.equal(tier2Today, 70000, "today's SL 2% tier usage includes all today-created regardless of current status");

  const tier3Today = Number(await getDailyTierUsageForUser(pool, "u1", 3, dayStart, dayEnd));
  assert.equal(tier3Today, 15000, "today's SL 3% tier usage = 15000");

  const tier5Today = Number(await getDailyTierUsageForUser(pool, "u1", 5, dayStart, dayEnd));
  assert.equal(tier5Today, 5000, "today's SL 5% tier usage = 5000");

  const tier10Today = Number(await getDailyTierUsageForUser(pool, "u1", 10, dayStart, dayEnd));
  assert.equal(tier10Today, 0, "today's SL 10% tier usage = 0 (no rows)");
});
