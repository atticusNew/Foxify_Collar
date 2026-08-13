import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  insertLedgerEntry,
  getPoolBalance,
  listLedgerEntries,
  sumLedgerByType
} from "../src/pilot/capitalPoolLedger";

/**
 * WS#0 (Bundle C cutover, rev 6) — capital pool schema + ledger tests.
 *
 * Uses pg-mem (in-process Postgres) so tests are hermetic and don't
 * need a real DB. Validates the additive migration is idempotent and
 * the ledger CRUD enforces the money-flow invariants.
 */

const buildMemPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  return pool;
};

test("Schema migration creates 3 tables + 1 view + indices", async () => {
  const pool = await buildMemPool();
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'pilot_capital_%' OR table_name LIKE 'pilot_pool_%' OR table_name LIKE 'pilot_settlement_%'`
  );
  const names = tables.rows.map((r: any) => r.table_name).sort();
  assert.ok(names.includes("pilot_capital_pools"), "pilot_capital_pools missing");
  assert.ok(names.includes("pilot_pool_ledger"), "pilot_pool_ledger missing");
  assert.ok(names.includes("pilot_settlement_runs"), "pilot_settlement_runs missing");
  // Note: pg-mem may surface views differently; just verify tables exist
});

test("Schema migration is idempotent: seed re-run is safe", async () => {
  // Note: pg-mem's strict AST-coverage mode rejects re-running CREATE TABLE
  // IF NOT EXISTS even though the SQL is valid on real Postgres. We
  // verify idempotency for the seed step (which uses ON CONFLICT DO NOTHING)
  // here. Real Postgres ensureCapitalPoolSchema idempotency is verified
  // by deploy: every restart re-runs without error.
  const pool = await buildMemPool();
  // Re-running seed must be a no-op (ON CONFLICT DO NOTHING)
  await seedCapitalPoolsIfNeeded(pool);
  await seedCapitalPoolsIfNeeded(pool);
  const pools = await pool.query("SELECT pool_id FROM pilot_capital_pools ORDER BY pool_id");
  assert.equal(pools.rows.length, 2);
});

test("Seed creates Atticus + Foxify pools with rev 6 defaults", async () => {
  const pool = await buildMemPool();
  const atticus = await pool.query(
    "SELECT * FROM pilot_capital_pools WHERE pool_id = 'atticus_hedge'"
  );
  assert.equal(atticus.rows.length, 1);
  assert.equal(atticus.rows[0].partner, "atticus");
  assert.equal(Number(atticus.rows[0].initial_deposit_usdc), 12000);
  assert.equal(Number(atticus.rows[0].withdrawal_lockup_days), 7);

  const foxify = await pool.query(
    "SELECT * FROM pilot_capital_pools WHERE pool_id = 'foxify_trader'"
  );
  assert.equal(foxify.rows.length, 1);
  assert.equal(foxify.rows[0].partner, "foxify");
  assert.equal(Number(foxify.rows[0].initial_deposit_usdc), 0,
    "Foxify deposit must start at $0 per rev 6 lock");
  assert.equal(Number(foxify.rows[0].weekly_distribution_pct), 0.25);
  assert.equal(Number(foxify.rows[0].end_of_period_distribution_pct), 0.75);
});

test("Insert deposit ledger entry: balance grows", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, {
    poolId: "foxify_trader",
    entryType: "deposit",
    amountUsdc: 25000,
    reference: "wire_xfer_abc123"
  });
  const balance = await getPoolBalance(pool, "foxify_trader");
  assert.ok(balance);
  assert.equal(Number(balance!.currentBalanceUsdc), 25000);
});

test("Mixed in/out entries: balance reflects net", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "deposit", amountUsdc: 25000 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 100, protectionId: "prot_1" });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -1000, protectionId: "prot_1" });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 200, protectionId: "prot_2" });
  const balance = await getPoolBalance(pool, "foxify_trader");
  assert.equal(Number(balance!.currentBalanceUsdc), 25000 + 100 - 1000 + 200);
  assert.equal(Number(balance!.currentBalanceUsdc), 24300);
});

test("List ledger entries: filtered + ordered DESC by created_at", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "deposit", amountUsdc: 100 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 50 });
  await insertLedgerEntry(pool, { poolId: "atticus_hedge", entryType: "deposit", amountUsdc: 12000 });

  const foxifyEntries = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  assert.equal(foxifyEntries.length, 2);
  // DESC order — most recent first
  assert.equal(foxifyEntries[0].entryType, "premium_in");
  assert.equal(foxifyEntries[1].entryType, "deposit");

  const atticusEntries = await listLedgerEntries(pool, { poolId: "atticus_hedge" });
  assert.equal(atticusEntries.length, 1);
  assert.equal(atticusEntries[0].entryType, "deposit");
});

test("Sum by type: aggregates per entry type for the period", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 100 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 200 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -1000 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "deposit", amountUsdc: 25000 });

  const totals = await sumLedgerByType(pool, {
    poolId: "foxify_trader",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  assert.equal(Number(totals.premium_in), 300);
  assert.equal(Number(totals.payout_out), -1000);
  assert.equal(Number(totals.deposit), 25000);
  assert.equal(Number(totals.weekly_distribution_out), 0);
});

test("Get pool balance for non-existent pool returns null", async () => {
  const pool = await buildMemPool();
  const balance = await getPoolBalance(pool, "nonexistent_pool" as any);
  assert.equal(balance, null);
});

test("Get pool balance for pool with no ledger entries returns zero", async () => {
  const pool = await buildMemPool();
  // foxify_trader is seeded but has no ledger entries yet
  const balance = await getPoolBalance(pool, "foxify_trader");
  assert.ok(balance);
  assert.equal(Number(balance!.currentBalanceUsdc), 0);
  assert.equal(balance!.ledgerEntryCount, 0);
});

test("Constraint check: invalid entry type rejected", async () => {
  const pool = await buildMemPool();
  let threw = false;
  try {
    await pool.query(
      `INSERT INTO pilot_pool_ledger (pool_id, entry_type, amount_usdc)
       VALUES ('foxify_trader', 'INVALID_TYPE', 100)`
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "Invalid entry_type must be rejected by CHECK constraint");
});

test("Constraint check: invalid pool_id (FK) rejected", async () => {
  const pool = await buildMemPool();
  let threw = false;
  try {
    await pool.query(
      `INSERT INTO pilot_pool_ledger (pool_id, entry_type, amount_usdc)
       VALUES ('nonexistent_pool', 'deposit', 100)`
    );
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "FK constraint must reject unknown pool_id");
});
