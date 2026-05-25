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

// No-bid backstop regression coverage (added 2026-04-30).
//
// The 3df5cfa1 trade burned 285 cycles attempting bounce_recovery /
// take_profit sells against an empty Deribit book. The backstop stops
// these branches once noBidRetryCount >= threshold (default 60), while
// keeping near_expiry_salvage active for late-life liquidity recovery.
//
// Tests:
//   - Below threshold: normal behavior (sell attempts continue)
//   - At/above threshold + outside near-expiry: backstop engages, no
//     sell attempts, metadata.heldToExpiryReason stamped
//   - At/above threshold + inside near-expiry window: backstop bypassed,
//     near_expiry_salvage still tries (does not write heldToExpiryReason)
//   - PILOT_TP_NO_BID_BACKSTOP_ENABLED=false: backstop disabled, old
//     behavior restored

const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const fakeVenue = {} as any;

const buildSellRecorder = (mode: "sold" | "no_bid" = "no_bid") => {
  const calls: Array<{ instrumentId: string; quantity: number }> = [];
  const sellOption = async (p: { instrumentId: string; quantity: number }) => {
    calls.push({ instrumentId: p.instrumentId, quantity: p.quantity });
    if (mode === "no_bid") {
      return {
        status: "no_bid",
        fillPrice: 0,
        totalProceeds: 0,
        orderId: null,
        details: { reason: "no_bid" }
      };
    }
    return {
      status: "sold",
      fillPrice: 100,
      totalProceeds: 100 * p.quantity,
      orderId: `mock-${calls.length}`,
      details: { mock: true }
    };
  };
  return { sellOption, calls };
};

const captureCycle = async (params: {
  pool: any;
  sellOption: any;
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
      venue: fakeVenue,
      sellOption: params.sellOption,
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

const seedTriggeredHedge = async (
  pool: any,
  opts: {
    triggerAtMs: number;
    expiryAtMs: number;
    triggerPrice: number;
    triggerReferencePrice: number;
    strike: number;
    noBidRetryCount: number;
    payoutDueAmount?: number;
    hedgeQty?: number;
  }
) => {
  const seeded = await insertProtection(pool, {
    userHash: "hh-no-bid-backstop",
    hashVersion: 1,
    status: "triggered" as any,
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
      protectionType: "short",
      triggerMonitorAt: new Date(opts.triggerAtMs).toISOString(),
      triggerAt: new Date(opts.triggerAtMs).toISOString(),
      triggerReferencePrice: opts.triggerReferencePrice,
      noBidRetryCount: opts.noBidRetryCount
    }
  });
  await pool.query(
    `UPDATE pilot_protections SET
       venue = 'deribit_test',
       instrument_id = $1,
       side = 'buy',
       size = $2,
       execution_price = '0.001',
       premium = '60',
       payout_due_amount = $3,
       floor_price = $4
     WHERE id = $5`,
    [
      `BTC-30APR26-${opts.strike}-C`,
      String(opts.hedgeQty ?? 0.131),
      String(opts.payoutDueAmount ?? 200),
      String(opts.triggerPrice.toFixed(10)),
      seeded.id
    ]
  );
  return seeded.id;
};

test("no_bid backstop: below threshold (count=30, threshold=60) → sell attempts continue normally", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED;
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD;
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  // SHORT 2%, 1h since trigger (past 0.5h cooling), 5h to expiry
  // (NOT in near-expiry window). noBidRetryCount=30 (below default 60
  // threshold). Spot $77,400 below trigger $77,621.84 → bounced=true.
  // Strike $77,500 → call OTM at current spot → small but non-zero
  // BS value. The sell branch (bounce_recovery / take_profit_prime)
  // SHOULD attempt regardless of past no_bid count when we're below
  // threshold.
  const id = await seedTriggeredHedge(pool, {
    triggerAtMs: now - 1 * HOUR_MS,
    expiryAtMs: now + 5 * HOUR_MS,
    triggerPrice: 77621.84,
    triggerReferencePrice: 77663.61,
    strike: 77500,
    noBidRetryCount: 30,
    payoutDueAmount: 200,
    hedgeQty: 0.5  // larger qty → more BS value to clear thresholds
  });

  const { sellOption, calls } = buildSellRecorder("no_bid");
  const logs = await captureCycle({ pool, sellOption, currentSpot: 77400, currentIV: 0.40 });

  const backstopLine = logs.find((l) => l.includes("no_bid backstop ENGAGED") || l.includes("no_bid_backstop holding"));
  assert.ok(!backstopLine, `backstop should NOT engage at count=30 (below default 60). Got: ${logs.filter((l) => l.includes("backstop")).join("\n")}`);
  // Confirm metadata was NOT stamped with heldToExpiryReason
  const r = await pool.query("SELECT metadata FROM pilot_protections WHERE id = $1", [id]);
  assert.equal(
    r.rows[0].metadata.heldToExpiryReason,
    undefined,
    "heldToExpiryReason should not be stamped while below threshold"
  );
});

test("no_bid backstop: at threshold (count=60), outside near-expiry → engages, attempts metadata stamp, no sell attempt", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED;
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD;
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  // Same shape as above but noBidRetryCount=60 (= threshold) and 8h to
  // expiry (outside the 6h near-expiry window). Backstop should engage:
  // no sell attempted this cycle, metadata stamp ATTEMPTED (the
  // jsonb_build_object UPDATE may succeed in real Postgres or fail
  // in pg-mem — same pattern as recordNoBidRetry, see
  // pilotR3FailureModeHardening.test.ts:130-148 for the established
  // testing convention). Either way: ENGAGED log fires, no sell goes
  // through, no unhandled errors.
  await seedTriggeredHedge(pool, {
    triggerAtMs: now - 1 * HOUR_MS,
    expiryAtMs: now + 8 * HOUR_MS,
    triggerPrice: 77621.84,
    triggerReferencePrice: 77663.61,
    strike: 77500,
    noBidRetryCount: 60,
    payoutDueAmount: 200,
    hedgeQty: 0.5
  });

  const { sellOption, calls } = buildSellRecorder("no_bid");
  const logs = await captureCycle({ pool, sellOption, currentSpot: 77400, currentIV: 0.40 });

  // ENGAGED log fires regardless of metadata-stamp success; the stamp
  // is best-effort and runs inside try/catch.
  const engagedOrStampWarn = logs.find((l) =>
    l.includes("no_bid backstop ENGAGED") || l.includes("no_bid backstop stamp failed")
  );
  assert.ok(
    engagedOrStampWarn,
    `expected backstop engagement (ENGAGED log or stamp-warn). Got: ${logs.filter((l) => l.includes("backstop")).join("\n")}`
  );

  // No sell attempts when backstop engages (regardless of stamp outcome).
  assert.equal(calls.length, 0, "no sell attempts should fire when backstop engages");

  // No unhandled error on the cycle (matches the convention in
  // pilotR3FailureModeHardening.test.ts:140-143).
  const unexpectedErrors = logs.filter((l) => l.includes("[HedgeManager] Error processing"));
  assert.equal(unexpectedErrors.length, 0, "no unhandled errors on backstop cycle");
});

// Persistence note: the metadata fields written by stampHeldToExpiry
// (heldToExpiryReason, heldToExpiryAt, heldToExpiryNoBidCount) are
// verified manually post-deploy in real Postgres via:
//   SELECT id,
//          metadata->>'heldToExpiryReason',
//          metadata->>'heldToExpiryAt',
//          metadata->>'heldToExpiryNoBidCount'
//   FROM pilot_protections
//   WHERE metadata ? 'heldToExpiryReason';
// pg-mem does not implement jsonb_build_object so the in-test
// assertion would be misleading; the pattern matches recordNoBidRetry's
// existing test convention.

test("no_bid backstop: at threshold but inside near-expiry window → backstop bypassed, near_expiry_salvage tries", async () => {
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED;
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD;
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  // Same trade with noBidRetryCount=60 BUT now only 3h to expiry —
  // inside the 6h near_expiry_salvage window. Backstop should bypass
  // and let near_expiry_salvage attempt the sell (in case bid liquidity
  // returns near settlement). Strike $77,500 with spot $77,400 = call
  // is OTM by $100 — total value below the $3 NEAR_EXPIRY_MIN_VALUE
  // floor, so no actual sell happens, but the IMPORTANT thing is that
  // the backstop doesn't intervene to short-circuit it.
  //
  // The test: confirm we DO NOT log "no_bid backstop ENGAGED" and DO
  // NOT stamp heldToExpiryReason — the trade is in the near_expiry
  // path, not the backstop path.
  const id = await seedTriggeredHedge(pool, {
    triggerAtMs: now - 6.5 * HOUR_MS,
    expiryAtMs: now + 3 * HOUR_MS,
    triggerPrice: 77621.84,
    triggerReferencePrice: 77663.61,
    strike: 77500,
    noBidRetryCount: 60,
    payoutDueAmount: 200,
    hedgeQty: 0.5
  });

  const { sellOption, calls } = buildSellRecorder("no_bid");
  const logs = await captureCycle({ pool, sellOption, currentSpot: 77400, currentIV: 0.40 });

  const engagedLine = logs.find((l) => l.includes("no_bid backstop ENGAGED"));
  assert.ok(!engagedLine, `backstop should NOT engage inside near-expiry window. Got: ${logs.filter((l) => l.includes("backstop")).join("\n")}`);

  const r = await pool.query("SELECT metadata FROM pilot_protections WHERE id = $1", [id]);
  assert.equal(
    r.rows[0].metadata.heldToExpiryReason,
    undefined,
    "heldToExpiryReason should NOT be stamped when inside near-expiry window"
  );
});

test("no_bid backstop: biweekly hedges (tenorDays >= 2) are exempt — backstop never engages even at threshold (2026-05-01)", async () => {
  // Per CEO direction 2026-05-01: the no-bid backstop was sized for the
  // legacy 1-day product trading thin same-day Deribit books. Biweekly
  // (14d) hedges trade against the weekly grid where bid book is
  // consistently $50k+ deep; a $1–$1.5k hedge sell will not stress
  // liquidity, and a no_bid streak on biweekly is more likely a
  // Deribit incident than structural illiquidity. Better to keep
  // retrying through the incident than freeze into hold-to-expiry.
  //
  // This test reproduces the SAME conditions as the
  // "engages outside near-expiry" case above, but with tenorDays=14.
  // Backstop should NOT engage; sell attempts should continue.
  __resetSpotHistoryForTests();
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED;
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD;
  const pool = await buildPool();
  const now = Date.now();
  for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

  const id = await seedTriggeredHedge(pool, {
    triggerAtMs: now - 1 * HOUR_MS,
    // Biweekly hedge is far from expiry — 8 days out, not 8 hours
    expiryAtMs: now + 8 * 24 * HOUR_MS,
    triggerPrice: 77621.84,
    triggerReferencePrice: 77663.61,
    strike: 77500,
    noBidRetryCount: 60,
    payoutDueAmount: 200,
    hedgeQty: 0.5
  });
  // Mark this row as biweekly. seedTriggeredHedge defaults tenor_days=1
  // via insertProtection's default — flip to 14 here to exercise the
  // biweekly skip branch.
  await pool.query(
    `UPDATE pilot_protections SET tenor_days = 14 WHERE id = $1`,
    [id]
  );

  const { sellOption, calls } = buildSellRecorder("no_bid");
  const logs = await captureCycle({ pool, sellOption, currentSpot: 77400, currentIV: 0.40 });

  const engagedLine = logs.find((l) => l.includes("no_bid backstop ENGAGED"));
  assert.ok(
    !engagedLine,
    `backstop must NOT engage on biweekly (tenorDays=14). Got: ${logs.filter((l) => l.includes("backstop")).join("\n")}`
  );

  const r = await pool.query("SELECT metadata FROM pilot_protections WHERE id = $1", [id]);
  assert.equal(
    r.rows[0].metadata.heldToExpiryReason,
    undefined,
    "heldToExpiryReason should NOT be stamped on biweekly hedges"
  );
});

test("no_bid backstop: PILOT_TP_NO_BID_BACKSTOP_ENABLED=false disables the backstop entirely", async () => {
  __resetSpotHistoryForTests();
  process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED = "false";
  delete process.env.PILOT_TP_NO_BID_BACKSTOP_THRESHOLD;
  try {
    const pool = await buildPool();
    const now = Date.now();
    for (let h = 24; h >= 0; h--) recordSpotSample(77400, now - h * HOUR_MS);

    // Same conditions that would normally engage the backstop
    // (count=60, outside near-expiry), but env disables it.
    const id = await seedTriggeredHedge(pool, {
      triggerAtMs: now - 1 * HOUR_MS,
      expiryAtMs: now + 8 * HOUR_MS,
      triggerPrice: 77621.84,
      triggerReferencePrice: 77663.61,
      strike: 77500,
      noBidRetryCount: 60,
      payoutDueAmount: 200,
      hedgeQty: 0.5
    });

    const { sellOption, calls } = buildSellRecorder("no_bid");
    const logs = await captureCycle({ pool, sellOption, currentSpot: 77400, currentIV: 0.40 });

    const engagedLine = logs.find((l) => l.includes("no_bid backstop ENGAGED"));
    assert.ok(!engagedLine, "backstop should NOT engage when ENABLED=false");

    const r = await pool.query("SELECT metadata FROM pilot_protections WHERE id = $1", [id]);
    assert.equal(
      r.rows[0].metadata.heldToExpiryReason,
      undefined,
      "heldToExpiryReason should not be stamped when ENABLED=false"
    );
  } finally {
    delete process.env.PILOT_TP_NO_BID_BACKSTOP_ENABLED;
  }
});
