import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  __setPilotPoolForTests,
  ensurePilotSchema,
  insertProtection,
  sumLiveHedgeCostUsdSince
} from "../src/pilot/db.js";

// REGRESSION (2026-04-23 v2) — sumLiveHedgeCostUsdSince must:
//   1. Sum execution_price × quantity (real Deribit cost), not premium
//      (client-facing premium). PR #85's first version summed premium
//      and inflated cumulative spend ~10×, blowing the Day-1 $100 cap
//      after just three real test trades.
//   2. Distinguish real vs paper fills by checking details.raw.testnet
//      and details.raw.status — NOT just the venue label. When
//      PILOT_VENUE_MODE=deribit_live was set but DERIBIT_PAPER=true,
//      paper fills were tagged venue='deribit_live' anyway.
//
// This test reproduces both failure modes so they can't recur silently.

const buildPool = async () => {
  __setPilotPoolForTests(null);
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensurePilotSchema(pool);
  return pool;
};

const seedExecution = async (
  pool: any,
  opts: {
    side: "buy" | "sell";
    venue: string;
    status: string;
    quantity: string;
    executionPriceUsd: string; // per-contract Deribit cost in USD
    premiumUsd: string;        // client-facing premium in USD
    rawTestnet?: boolean;       // true = testnet, false = mainnet, undefined = no testnet field
    rawStatus?: string;          // 'paper_filled' / 'paper_rejected' for paper fills
    createdAtIso: string;
  },
  protectionId: string
) => {
  const details: any = { raw: {} };
  if (opts.rawTestnet !== undefined) details.raw.testnet = opts.rawTestnet;
  if (opts.rawStatus) details.raw.status = opts.rawStatus;

  await pool.query(
    `INSERT INTO pilot_venue_executions
       (id, quote_id, venue, status, instrument_id, side, quantity,
        execution_price, premium, executed_at, external_order_id,
        external_execution_id, protection_id, details, created_at)
     VALUES ($1, $2, $3, $4, 'BTC-XXAPRXX-XXXXX-P', $5, $6,
             $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      `exec-${Math.random().toString(36).slice(2, 10)}`,
      `quote-${Math.random().toString(36).slice(2, 10)}`,
      opts.venue,
      opts.status,
      opts.side,
      opts.quantity,
      opts.executionPriceUsd,
      opts.premiumUsd,
      opts.createdAtIso,
      `ord-${Math.random().toString(36).slice(2, 10)}`,
      `extexec-${Math.random().toString(36).slice(2, 10)}`,
      protectionId,
      JSON.stringify(details),
      opts.createdAtIso
    ]
  );
};

const seedTestProtection = async (pool: any) => {
  const { id } = await insertProtection(pool, {
    userHash: "test-user",
    hashVersion: 1,
    status: "active" as any,
    tierName: "SL 5%",
    drawdownFloorPct: "0.05",
    slPct: 5,
    hedgeStatus: "active",
    marketId: "BTC-USD",
    protectedNotional: "10000",
    foxifyExposureNotional: "10000",
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    autoRenew: false,
    renewWindowMinutes: 1440,
    metadata: {}
  });
  return id;
};

test("REGRESSION: sumLiveHedgeCostUsdSince uses execution_price × quantity, not premium", async () => {
  // The c84dbbe9-style bug. A trade with $30 client premium but
  // $5.48 real Deribit cost should contribute $5.48 to the cap, NOT $30.
  const pool = await buildPool();
  const pid = await seedTestProtection(pool);

  const startIso = "2026-04-23T20:00:00Z";
  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "54.79",  // real per-contract Deribit cost
    premiumUsd: "30.00",          // client-facing premium (NOT what we want)
    rawTestnet: false,
    createdAtIso: "2026-04-23T20:30:00Z"
  }, pid);

  const startMs = Date.parse(startIso);
  const sum = await sumLiveHedgeCostUsdSince(pool, startMs);

  // Expected: 0.1 × $54.79 = $5.479
  assert.ok(
    Math.abs(sum - 5.479) < 0.01,
    `Expected ~$5.48 (execution_price × quantity); got $${sum.toFixed(2)}. ` +
    `If this fails, the SQL is summing the wrong column (likely 'premium' = client-facing).`
  );
});

test("REGRESSION: sumLiveHedgeCostUsdSince ignores paper fills tagged venue=deribit_live", async () => {
  // The PILOT_VENUE_MODE=deribit_live + DERIBIT_PAPER=true bug.
  // Paper fills get venue='deribit_live' from the live adapter wrapper,
  // but the connector in paper mode never actually hit Deribit. They
  // must NOT count toward the cap.
  const pool = await buildPool();
  const pid = await seedTestProtection(pool);

  const startIso = "2026-04-23T20:00:00Z";

  // 3 paper fills tagged venue=deribit_live
  for (let i = 0; i < 3; i++) {
    await seedExecution(pool, {
      side: "buy",
      venue: "deribit_live",       // misleading label
      status: "success",
      quantity: "0.1",
      executionPriceUsd: "54.79",
      premiumUsd: "30.00",
      rawStatus: "paper_filled",   // the truth — these were paper fills
      createdAtIso: `2026-04-23T20:${30 + i}:00Z`
    }, pid);
  }

  // 1 real fill
  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "54.79",
    premiumUsd: "30.00",
    rawTestnet: false,             // real Deribit response
    createdAtIso: "2026-04-23T20:45:00Z"
  }, pid);

  const sum = await sumLiveHedgeCostUsdSince(pool, Date.parse(startIso));

  // Expected: only the 1 real fill counts = ~$5.48
  assert.ok(
    Math.abs(sum - 5.479) < 0.01,
    `Expected only the 1 real fill (~$5.48); got $${sum.toFixed(2)}. ` +
    `If this fails, paper fills tagged venue='deribit_live' are leaking into the live cap.`
  );
});

test("sumLiveHedgeCostUsdSince ignores SELL executions (only counts cash outflow)", async () => {
  const pool = await buildPool();
  const pid = await seedTestProtection(pool);
  const startIso = "2026-04-23T20:00:00Z";

  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "54.79",
    premiumUsd: "30.00",
    rawTestnet: false,
    createdAtIso: "2026-04-23T20:30:00Z"
  }, pid);
  await seedExecution(pool, {
    side: "sell",                   // TP sell — should NOT count
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "33.00",
    premiumUsd: "0.00",
    rawTestnet: false,
    createdAtIso: "2026-04-23T22:00:00Z"
  }, pid);

  const sum = await sumLiveHedgeCostUsdSince(pool, Date.parse(startIso));
  assert.ok(
    Math.abs(sum - 5.479) < 0.01,
    `Only the BUY should count; got $${sum.toFixed(2)}`
  );
});

test("sumLiveHedgeCostUsdSince ignores executions BEFORE startMs", async () => {
  const pool = await buildPool();
  const pid = await seedTestProtection(pool);
  const cutoffIso = "2026-04-23T20:00:00Z";

  // Real fill 1 hour BEFORE cutoff — must NOT count
  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "100.00",
    premiumUsd: "30.00",
    rawTestnet: false,
    createdAtIso: "2026-04-23T19:00:00Z"
  }, pid);
  // Real fill 30 min AFTER cutoff — must count
  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "success",
    quantity: "0.1",
    executionPriceUsd: "50.00",
    premiumUsd: "30.00",
    rawTestnet: false,
    createdAtIso: "2026-04-23T20:30:00Z"
  }, pid);

  const sum = await sumLiveHedgeCostUsdSince(pool, Date.parse(cutoffIso));
  assert.ok(
    Math.abs(sum - 5.0) < 0.01,
    `Only the post-cutoff fill should count; got $${sum.toFixed(2)}`
  );
});

test("sumLiveHedgeCostUsdSince ignores failed executions", async () => {
  const pool = await buildPool();
  const pid = await seedTestProtection(pool);
  const startIso = "2026-04-23T20:00:00Z";

  await seedExecution(pool, {
    side: "buy",
    venue: "deribit_live",
    status: "failure",              // Deribit rejected the order
    quantity: "0",
    executionPriceUsd: "0",
    premiumUsd: "30.00",
    rawTestnet: false,
    createdAtIso: "2026-04-23T20:30:00Z"
  }, pid);

  const sum = await sumLiveHedgeCostUsdSince(pool, Date.parse(startIso));
  assert.equal(sum, 0, "Failed orders should not count");
});
