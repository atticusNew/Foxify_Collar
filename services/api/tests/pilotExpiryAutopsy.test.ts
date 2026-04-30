import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection
} from "../src/pilot/db.js";
import { runHedgeManagementCycle } from "../src/pilot/hedgeManager.js";
import {
  recordSpotSample,
  __resetSpotHistoryForTests
} from "../src/pilot/spotHistory.js";

// Expiry autopsy block regression coverage (added 2026-04-30).
//
// Every hedge that hits the isExpired branch:
//   - Is marked expired_settled (atomic write via markExpiredWithAutopsy
//     using JS-side read-merge-write — works in pg-mem and real Postgres).
//   - Has the rich expiryAutopsy block stamped to metadata in the same
//     write, capturing:
//       expiredAt, protectionType, strike, spotAtExpiry,
//       intrinsicAtExpiryUsd, itmAtExpiry, autoSettlementCandidate,
//       totalNoBidRetries (carried from metadata.noBidRetryCount),
//       heldToExpiryReason (carried from metadata.heldToExpiryReason
//         if the no-bid backstop fired earlier),
//       hoursTriggerToExpiry, hedgeStatus, finalStatus
//   - Logs an "expired ITM (auto-settlement candidate)" or
//     "expired OTM" line for operator visibility.
//
// Tests cover:
//   1. SHORT expires ITM (call: spot > strike) — auto-settlement candidate
//   2. SHORT expires OTM (call: spot < strike) — 3df5cfa1 final-state mirror
//   3. LONG expires ITM (put: spot < strike) — auto-settlement candidate
//   4. Autopsy carries forward noBidRetryCount and heldToExpiryReason
//   5. Never-triggered protection (active → expired_otm) has
//      hoursTriggerToExpiry = null

const HOUR_MS = 3600 * 1000;

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const noopSell = async () => ({
  status: "sold",
  fillPrice: 0,
  totalProceeds: 0,
  orderId: null,
  details: {}
});

const captureCycle = async (params: {
  pool: any;
  currentSpot: number;
  currentIV: number;
}) => {
  const captured: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: any[]) => captured.push(args.map(String).join(" "));
  console.warn = (...args: any[]) => captured.push(args.map(String).join(" "));
  console.error = (...args: any[]) => captured.push(args.map(String).join(" "));
  try {
    await runHedgeManagementCycle({
      pool: params.pool,
      venue: {} as any,
      sellOption: noopSell,
      currentSpot: params.currentSpot,
      currentIV: params.currentIV
    });
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return captured;
};

const seedExpiredHedge = async (
  pool: any,
  opts: {
    direction: "long" | "short";
    triggeredAtMs: number | null;
    expiryAtMs: number;
    triggerPrice: number;
    strike: number;
    hedgeQty?: number;
    extraMetadata?: Record<string, unknown>;
  }
) => {
  const status = opts.triggeredAtMs ? "triggered" : "active";
  const seeded = await insertProtection(pool, {
    userHash: "hh-autopsy",
    hashVersion: 1,
    status: status as any,
    tierName: "SL 2%",
    drawdownFloorPct: "0.02",
    slPct: 2,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(opts.expiryAtMs).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {
      protectionType: opts.direction,
      ...(opts.triggeredAtMs && {
        triggerMonitorAt: new Date(opts.triggeredAtMs).toISOString(),
        triggerAt: new Date(opts.triggeredAtMs).toISOString()
      }),
      ...(opts.extraMetadata || {})
    }
  });
  const optionLetter = opts.direction === "short" ? "C" : "P";
  await pool.query(
    `UPDATE pilot_protections SET
       venue = 'deribit_test',
       instrument_id = $1,
       side = 'buy',
       size = $2,
       execution_price = '0.001',
       premium = '60',
       payout_due_amount = '200',
       floor_price = $3
     WHERE id = $4`,
    [
      `BTC-30APR26-${opts.strike}-${optionLetter}`,
      String(opts.hedgeQty ?? 0.131),
      String(opts.triggerPrice.toFixed(10)),
      seeded.id
    ]
  );
  return seeded.id;
};

const readAutopsy = async (pool: any, id: string) => {
  const r = await pool.query("SELECT metadata FROM pilot_protections WHERE id = $1", [id]);
  return r.rows[0].metadata.expiryAutopsy as Record<string, unknown> | undefined;
};

test("expiry autopsy: SHORT expires ITM (spot > strike) → itmAtExpiry=true, auto-settlement candidate", async () => {
  __resetSpotHistoryForTests();
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77800, now - h * HOUR_MS);

  // SHORT 2% protection, hedge = call strike $77,500. Expired 1 second ago.
  // currentSpot $77,800 → call ITM by $300 per contract.
  // intrinsic = $300 × 0.5 BTC = $150 → auto-settlement candidate.
  const id = await seedExpiredHedge(pool, {
    direction: "short",
    triggeredAtMs: now - 4 * HOUR_MS,
    expiryAtMs: now - 1000,
    triggerPrice: 77621.84,
    strike: 77500,
    hedgeQty: 0.5
  });

  const logs = await captureCycle({ pool, currentSpot: 77800, currentIV: 0.40 });

  // Trade marked expired_settled
  const r = await pool.query(
    "SELECT hedge_status FROM pilot_protections WHERE id = $1",
    [id]
  );
  assert.equal(r.rows[0].hedge_status, "expired_settled");

  // Autopsy block stamped
  const autopsy = await readAutopsy(pool, id);
  assert.ok(autopsy, "expiryAutopsy block should be stamped on expiry");
  assert.equal(autopsy!.itmAtExpiry, true);
  assert.equal(autopsy!.autoSettlementCandidate, true);
  assert.equal(autopsy!.protectionType, "short");
  assert.equal(autopsy!.strike, 77500);
  assert.equal(autopsy!.spotAtExpiry, 77800);
  assert.equal(Number(autopsy!.intrinsicAtExpiryUsd), 150);
  assert.equal(autopsy!.totalNoBidRetries, 0);
  assert.equal(autopsy!.heldToExpiryReason, null);
  assert.ok(typeof autopsy!.hoursTriggerToExpiry === "number");

  // ITM log line fires
  const itmLog = logs.find((l) => l.includes("expired ITM (auto-settlement candidate)"));
  assert.ok(itmLog, `expected ITM log line; got: ${logs.filter((l) => l.includes("expired")).join("\n")}`);
  assert.ok(itmLog!.includes("intrinsic=$150.00"));
});

test("expiry autopsy: SHORT expires OTM (spot < strike) → itmAtExpiry=false, no auto-settlement (3df5cfa1 mirror)", async () => {
  __resetSpotHistoryForTests();
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  // Mirror of 3df5cfa1's final state: SHORT 2% with strike $77,500
  // expires when spot has retraced below strike → call OTM, intrinsic $0.
  const id = await seedExpiredHedge(pool, {
    direction: "short",
    triggeredAtMs: now - 9.6 * HOUR_MS,
    expiryAtMs: now - 1000,
    triggerPrice: 77621.84,
    strike: 77500,
    hedgeQty: 0.131
  });

  const logs = await captureCycle({ pool, currentSpot: 77400, currentIV: 0.40 });

  const r = await pool.query("SELECT hedge_status FROM pilot_protections WHERE id = $1", [id]);
  assert.equal(r.rows[0].hedge_status, "expired_settled");

  const autopsy = await readAutopsy(pool, id);
  assert.ok(autopsy);
  assert.equal(autopsy!.itmAtExpiry, false);
  assert.equal(autopsy!.autoSettlementCandidate, false);
  assert.equal(Number(autopsy!.intrinsicAtExpiryUsd), 0);

  const otmLog = logs.find((l) => l.includes("expired OTM"));
  assert.ok(otmLog, `expected OTM log; got: ${logs.filter((l) => l.includes("expired")).join("\n")}`);
  assert.ok(otmLog!.includes("No auto-settlement"));
});

test("expiry autopsy: LONG expires ITM (put: spot < strike) → itmAtExpiry=true", async () => {
  __resetSpotHistoryForTests();
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(75200, now - h * HOUR_MS);

  // LONG 2% protection, hedge = put strike $75,500. Expired 1 second ago.
  // currentSpot $75,200 → put ITM by $300 per contract → auto-settlement.
  const id = await seedExpiredHedge(pool, {
    direction: "long",
    triggeredAtMs: now - 5 * HOUR_MS,
    expiryAtMs: now - 1000,
    triggerPrice: 75500,
    strike: 75500,
    hedgeQty: 0.4
  });

  await captureCycle({ pool, currentSpot: 75200, currentIV: 0.40 });

  const r = await pool.query("SELECT hedge_status FROM pilot_protections WHERE id = $1", [id]);
  assert.equal(r.rows[0].hedge_status, "expired_settled");

  const autopsy = await readAutopsy(pool, id);
  assert.ok(autopsy);
  assert.equal(autopsy!.itmAtExpiry, true);
  assert.equal(autopsy!.protectionType, "long");
  assert.equal(autopsy!.strike, 75500);
  assert.equal(autopsy!.spotAtExpiry, 75200);
  assert.equal(Number(autopsy!.intrinsicAtExpiryUsd), 120); // $300 × 0.4
});

test("expiry autopsy: carries forward noBidRetryCount and heldToExpiryReason from metadata", async () => {
  __resetSpotHistoryForTests();
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  // Mirror the post-no-bid-backstop state: protection has 285 prior
  // no_bid retries and the backstop already stamped heldToExpiryReason.
  // The autopsy block should preserve both for downstream queryability.
  const id = await seedExpiredHedge(pool, {
    direction: "short",
    triggeredAtMs: now - 9.6 * HOUR_MS,
    expiryAtMs: now - 1000,
    triggerPrice: 77621.84,
    strike: 77500,
    hedgeQty: 0.131,
    extraMetadata: {
      noBidRetryCount: 285,
      heldToExpiryReason: "deribit_persistent_no_bid",
      heldToExpiryAt: new Date(now - 8 * HOUR_MS).toISOString()
    }
  });

  await captureCycle({ pool, currentSpot: 77400, currentIV: 0.40 });

  const autopsy = await readAutopsy(pool, id);
  assert.ok(autopsy);
  assert.equal(autopsy!.totalNoBidRetries, 285);
  assert.equal(autopsy!.heldToExpiryReason, "deribit_persistent_no_bid");
  assert.equal(autopsy!.itmAtExpiry, false); // strike $77,500 > spot $77,400
});

test("expiry autopsy: never-triggered protection has hoursTriggerToExpiry=null", async () => {
  __resetSpotHistoryForTests();
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(76000, now - h * HOUR_MS);

  // LONG 2% protection that NEVER triggered — spot stayed above floor
  // for the whole tenor, hedge expires worthless. status='active' here
  // (will become expired_settled after the cycle); the queryManagedHedges
  // WHERE clause picks it up because hedge_status='active'.
  const id = await seedExpiredHedge(pool, {
    direction: "long",
    triggeredAtMs: null,
    expiryAtMs: now - 1000,
    triggerPrice: 75500,
    strike: 75500,
    hedgeQty: 0.13
  });

  await captureCycle({ pool, currentSpot: 76000, currentIV: 0.40 });

  const autopsy = await readAutopsy(pool, id);
  assert.ok(autopsy);
  assert.equal(autopsy!.hoursTriggerToExpiry, null);
  assert.equal(autopsy!.itmAtExpiry, false); // put strike $75,500 < spot $76,000
});

// Operational query example (works in real Postgres):
//   SELECT id,
//          metadata->'expiryAutopsy'->>'itmAtExpiry',
//          metadata->'expiryAutopsy'->>'intrinsicAtExpiryUsd',
//          metadata->'expiryAutopsy'->>'totalNoBidRetries',
//          metadata->'expiryAutopsy'->>'heldToExpiryReason'
//   FROM pilot_protections
//   WHERE metadata ? 'expiryAutopsy'
//     AND (metadata->'expiryAutopsy'->>'itmAtExpiry')::bool = true
//   ORDER BY (metadata->'expiryAutopsy'->>'expiredAt') DESC;
//
// Surfaces every hedge that auto-settled ITM and may need reconciliation
// against Deribit's settlement history.
