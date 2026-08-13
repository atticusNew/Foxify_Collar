import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureCapitalPoolSchema, seedCapitalPoolsIfNeeded } from "../src/pilot/capitalPoolSchema";
import { insertLedgerEntry } from "../src/pilot/capitalPoolLedger";
import {
  computeSettlementTotals,
  createDraftSettlement,
  approveSettlement,
  listRecentSettlements,
  generateSettlementReport
} from "../src/pilot/settlementRunner";

/**
 * WS#0 settlement runner tests (Bundle C cutover, rev 6).
 */

const buildMemPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  return pool;
};

// ── Totals computation ──

test("computeSettlementTotals: empty ledger → all zeros", async () => {
  const pool = await buildMemPool();
  const totals = await computeSettlementTotals({
    pool,
    poolId: "foxify_trader",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  assert.equal(totals.totalPremiumInUsdc, 0);
  assert.equal(totals.netPnLUsdc, 0);
});

test("computeSettlementTotals: profitable week scenario", async () => {
  const pool = await buildMemPool();
  // Simulate one week of operations:
  // 50 trades at $100 premium each = +$5000
  // 5 triggers paying out $1000 each = -$5000
  // Hedge cost ~$1500
  // TP recovery ~$400
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 5000 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -5000 });
  await insertLedgerEntry(pool, { poolId: "atticus_hedge", entryType: "hedge_buy_out", amountUsdc: -1500 });
  await insertLedgerEntry(pool, { poolId: "atticus_hedge", entryType: "hedge_sell_in", amountUsdc: 400 });

  const foxifyTotals = await computeSettlementTotals({
    pool, poolId: "foxify_trader",
    periodStart: new Date(0), periodEnd: new Date(Date.now() + 86400_000)
  });
  // Foxify pool sees premium and payouts only
  assert.equal(foxifyTotals.totalPremiumInUsdc, 5000);
  assert.equal(foxifyTotals.totalPayoutOutUsdc, 5000);
  assert.equal(foxifyTotals.netPnLUsdc, 0, "Foxify net = +5000 - 5000 = 0");
});

// ── Draft settlement ──

test("createDraftSettlement: positive net P&L → distributable amount > 0", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 1000 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -200 });

  const run = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  assert.equal(run.status, "draft");
  // Net P&L = 1000 - 200 = 800; weekly_25 = 25% × 800 = 200
  assert.equal(Number(run.netPnLUsdc), 800);
  assert.equal(Number(run.distributableUsdc), 200);
});

test("createDraftSettlement: negative net P&L → distributable = $0", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 100 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -1000 });

  const run = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  // Net P&L = 100 - 1000 = -900; distributable cannot be negative
  assert.equal(Number(run.netPnLUsdc), -900);
  assert.equal(Number(run.distributableUsdc), 0,
    "Negative P&L period must produce $0 distribution (not negative)");
});

test("createDraftSettlement: end_of_period_75 distributes 75%", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 4000 });
  const run = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "end_of_period_75",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  assert.equal(Number(run.netPnLUsdc), 4000);
  assert.equal(Number(run.distributableUsdc), 3000, "75% of 4000 = 3000");
});

// ── Approval ──

test("approveSettlement: draft → approved + ledger entry created", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 1000 });
  const draft = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });

  const approved = await approveSettlement({
    pool,
    settlementId: draft.id,
    actor: "operator@atticus.io",
    paymentTxRef: "wire_xyz123"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "operator@atticus.io");
  assert.equal(approved.paymentTxRef, "wire_xyz123");

  // Verify ledger entry created
  const ledgerCheck = await pool.query(
    `SELECT * FROM pilot_pool_ledger WHERE entry_type = 'weekly_distribution_out'`
  );
  assert.equal(ledgerCheck.rows.length, 1);
  assert.equal(Number(ledgerCheck.rows[0].amount_usdc), -250); // 25% of 1000 = 250, signed negative
});

test("approveSettlement: idempotent re-approval returns existing record", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 1000 });
  const draft = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  await approveSettlement({ pool, settlementId: draft.id, actor: "ops" });
  // Second approval — should not error, should not double-emit ledger entry
  await approveSettlement({ pool, settlementId: draft.id, actor: "ops" });

  const ledgerCheck = await pool.query(
    `SELECT * FROM pilot_pool_ledger WHERE entry_type = 'weekly_distribution_out'`
  );
  assert.equal(ledgerCheck.rows.length, 1, "Idempotent — no double-emit");
});

test("approveSettlement: unknown ID throws", async () => {
  const pool = await buildMemPool();
  let threw = false;
  try {
    await approveSettlement({ pool, settlementId: "nonexistent", actor: "ops" });
  } catch (e: any) {
    threw = true;
    assert.equal(e.message, "settlement_not_found");
  }
  assert.equal(threw, true);
});

test("approveSettlement: zero distributable doesn't create ledger entry", async () => {
  const pool = await buildMemPool();
  // No premium income → net P&L 0 → distributable 0
  const draft = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  await approveSettlement({ pool, settlementId: draft.id, actor: "ops" });
  const ledgerCheck = await pool.query(
    `SELECT * FROM pilot_pool_ledger WHERE entry_type = 'weekly_distribution_out'`
  );
  assert.equal(ledgerCheck.rows.length, 0,
    "Zero distributable must not create a ledger entry");
});

// ── List + report ──

test("listRecentSettlements: returns drafts sorted DESC by created_at", async () => {
  const pool = await buildMemPool();
  for (let i = 0; i < 3; i++) {
    await createDraftSettlement({
      pool, poolId: "foxify_trader",
      settlementType: "weekly_25",
      periodStart: new Date(Date.now() - (i + 1) * 86400_000),
      periodEnd: new Date(Date.now() - i * 86400_000)
    });
  }
  const recent = await listRecentSettlements({ pool, poolId: "foxify_trader", limit: 5 });
  assert.equal(recent.length, 3);
});

test("generateSettlementReport: contains all required sections", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 1500 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -300 });
  const draft = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  const report = generateSettlementReport(draft);
  assert.ok(report.includes("Foxify Pilot — Settlement Report"));
  assert.ok(report.includes("Money flow this period"));
  assert.ok(report.includes("Settlement"));
  assert.ok(report.includes(draft.id), "Report should contain settlement ID");
  assert.ok(report.includes("$1,500.00"), "Premium income shown formatted");
  assert.ok(report.includes("$300.00"), "Payout shown formatted");
});

test("generateSettlementReport: negative P&L period explicitly states no distribution", async () => {
  const pool = await buildMemPool();
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "premium_in", amountUsdc: 100 });
  await insertLedgerEntry(pool, { poolId: "foxify_trader", entryType: "payout_out", amountUsdc: -1000 });
  const draft = await createDraftSettlement({
    pool, poolId: "foxify_trader",
    settlementType: "weekly_25",
    periodStart: new Date(0),
    periodEnd: new Date(Date.now() + 86400_000)
  });
  const report = generateSettlementReport(draft);
  assert.ok(report.includes("No distribution this period"));
});
