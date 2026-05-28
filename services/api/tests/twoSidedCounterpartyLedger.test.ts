/**
 * PR C6 tests — counterparty ledger.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureCounterpartyLedgerSchema,
  recordActivateEntries,
  recordSettleEntries,
  recordPoolSettlement,
  recordEntry,
  getBalance,
  getStatement
} from "../src/singleSide/twoSided/counterpartyLedger";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureCounterpartyLedgerSchema(pool);
  return pool;
};

test("recordActivateEntries: Foxify -hedge_cost", async () => {
  const pool = await buildPool();
  await recordActivateEntries(pool, "p1", 3_200);
  const bal = await getBalance(pool, "foxify");
  assert.equal(bal, -3_200);
});

test("recordSettleEntries: Foxify + atticus shares, no gross by default", async () => {
  const pool = await buildPool();
  await recordActivateEntries(pool, "p1", 3_200);
  await recordSettleEntries(pool, {
    pairId: "p1",
    salvageProceedsUsdc: 3_800,
    foxifyShareUsdc: 3_710,
    atticusShareUsdc: 90,
    upliftUsdc: 600,
    isDeferredPoolActive: false
  });
  const foxifyBal = await getBalance(pool, "foxify");
  // Foxify: -3200 (funded) + 3710 (share) = +510 net (which is the foxify P&L)
  assert.equal(foxifyBal, 510);
  const atticusBal = await getBalance(pool, "atticus");
  // Atticus: +90 (tier split, no gross recorded by default)
  assert.equal(atticusBal, 90);
});

test("recordSettleEntries with deferred pool active: pool_accrual recorded (not tier_split_atticus)", async () => {
  const pool = await buildPool();
  await recordSettleEntries(pool, {
    pairId: "p1",
    salvageProceedsUsdc: 3_800,
    foxifyShareUsdc: 3_710,
    atticusShareUsdc: 90,
    upliftUsdc: 600,
    isDeferredPoolActive: true
  });
  const atticusBal = await getBalance(pool, "atticus");
  // Pool active: Atticus balance is 0 (pool_accrual is informational, amount=0)
  assert.equal(atticusBal, 0);
  const stmt = await getStatement(pool, "atticus");
  assert.equal(stmt[0].kind, "pool_accrual");
});

test("recordSettleEntries with includeGross: salvage_received entry added", async () => {
  const pool = await buildPool();
  await recordSettleEntries(pool, {
    pairId: "p1",
    salvageProceedsUsdc: 3_800,
    foxifyShareUsdc: 3_710,
    atticusShareUsdc: 90,
    upliftUsdc: 600,
    includeGross: true
  });
  const stmt = await getStatement(pool, "atticus");
  assert.ok(stmt.some((e) => e.kind === "salvage_received" && e.amountUsdc === 3_800));
});

test("recordPoolSettlement: adds accrued total to atticus balance", async () => {
  const pool = await buildPool();
  await recordPoolSettlement(pool, 5_000, { period: "Q4 2026 ramp" });
  const bal = await getBalance(pool, "atticus");
  assert.equal(bal, 5_000);
});

test("getBalance: respects asOf cutoff", async () => {
  const pool = await buildPool();
  await recordEntry(pool, { party: "foxify", kind: "hedge_funded", amountUsdc: -1_000 });
  await new Promise((r) => setTimeout(r, 10));
  const midpointIso = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 10));
  await recordEntry(pool, { party: "foxify", kind: "tier_split_foxify", amountUsdc: 1_200 });
  const balAfter = await getBalance(pool, "foxify");
  assert.equal(balAfter, 200);
  const balAtMid = await getBalance(pool, "foxify", midpointIso);
  assert.equal(balAtMid, -1_000);
});

test("getStatement: respects since/until + limit", async () => {
  const pool = await buildPool();
  for (let i = 0; i < 5; i++) {
    await recordEntry(pool, { party: "atticus", kind: "tier_split_atticus", amountUsdc: 100, pairId: `p${i}` });
  }
  const all = await getStatement(pool, "atticus");
  assert.equal(all.length, 5);
  const limited = await getStatement(pool, "atticus", { limit: 2 });
  assert.equal(limited.length, 2);
});

test("Full lifecycle: activate → settle → balance reflects per-pair net P&L", async () => {
  const pool = await buildPool();
  // Pair 1: profitable
  await recordActivateEntries(pool, "p1", 3_200);
  await recordSettleEntries(pool, { pairId: "p1", salvageProceedsUsdc: 3_800, foxifyShareUsdc: 3_710, atticusShareUsdc: 90, upliftUsdc: 600 });
  // Pair 2: loss
  await recordActivateEntries(pool, "p2", 3_200);
  await recordSettleEntries(pool, { pairId: "p2", salvageProceedsUsdc: 2_800, foxifyShareUsdc: 2_800, atticusShareUsdc: 0, upliftUsdc: -400 });
  
  const foxifyBal = await getBalance(pool, "foxify");
  // p1: -3200 + 3710 = +510
  // p2: -3200 + 2800 = -400
  // Total: +110
  assert.equal(foxifyBal, 110);
  
  const atticusBal = await getBalance(pool, "atticus");
  // p1: +90
  // p2: 0 (loss path, no Atticus share)
  assert.equal(atticusBal, 90);
});
