import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureCapitalPoolSchema, seedCapitalPoolsIfNeeded } from "../src/pilot/capitalPoolSchema";
import { getPoolBalance, listLedgerEntries } from "../src/pilot/capitalPoolLedger";
import {
  recordActivationLedgerWrites,
  recordTriggerLedgerWrite,
  recordTpSellLedgerWrite
} from "../src/pilot/poolLifecycleHooks";

/**
 * WS#0 (Bundle C cutover, rev 6) — Pool lifecycle hooks integration tests.
 *
 * Verifies the full protection lifecycle correctly emits pool ledger
 * entries at each stage:
 *
 *   activate success → premium_in (Foxify) + hedge_buy_out (Atticus)
 *   trigger fire     → payout_out (Foxify)
 *   TP sell success  → hedge_sell_in (Atticus)
 *
 * These hooks are wired into routes.ts (activate), triggerMonitor.ts,
 * and hedgeManager.ts respectively. Without these writes the pool
 * tables would be perpetually empty + the architecture decorative.
 */

const buildMemPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  return pool;
};

test("Activate hook: writes premium_in to Foxify + hedge_buy_out to Atticus", async () => {
  const pool = await buildMemPool();
  await recordActivationLedgerWrites({
    pool,
    protectionId: "prot_123",
    clientPremiumUsd: 100,
    hedgeCostUsd: 85,
    marketId: "BTC-USD",
    externalOrderId: "deribit_order_xyz"
  });

  const foxifyBalance = await getPoolBalance(pool, "foxify_trader");
  const atticusBalance = await getPoolBalance(pool, "atticus_hedge");
  assert.equal(Number(foxifyBalance!.currentBalanceUsdc), 100, "Foxify gains client premium");
  assert.equal(Number(atticusBalance!.currentBalanceUsdc), -85, "Atticus loses realized hedge cost");
});

test("Activate hook: zero hedge cost → no Atticus entry but Foxify still gets premium", async () => {
  const pool = await buildMemPool();
  await recordActivationLedgerWrites({
    pool,
    protectionId: "prot_zerohedge",
    clientPremiumUsd: 100,
    hedgeCostUsd: 0,
    marketId: "BTC-USD",
    externalOrderId: null
  });
  const foxifyEntries = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  const atticusEntries = await listLedgerEntries(pool, { poolId: "atticus_hedge" });
  assert.equal(foxifyEntries.length, 1);
  assert.equal(atticusEntries.length, 0);
});

test("Activate hook: zero premium → no Foxify entry but Atticus still gets hedge", async () => {
  const pool = await buildMemPool();
  await recordActivationLedgerWrites({
    pool,
    protectionId: "prot_freebie",
    clientPremiumUsd: 0,
    hedgeCostUsd: 50,
    marketId: "BTC-USD",
    externalOrderId: "x"
  });
  const foxifyEntries = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  const atticusEntries = await listLedgerEntries(pool, { poolId: "atticus_hedge" });
  assert.equal(foxifyEntries.length, 0);
  assert.equal(atticusEntries.length, 1);
});

test("Trigger hook: writes payout_out (signed negative) to Foxify pool", async () => {
  const pool = await buildMemPool();
  await recordTriggerLedgerWrite({
    pool,
    protectionId: "prot_triggered",
    payoutOwedUsd: 1000
  });
  const foxifyEntries = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  assert.equal(foxifyEntries.length, 1);
  assert.equal(foxifyEntries[0].entryType, "payout_out");
  assert.equal(Number(foxifyEntries[0].amountUsdc), -1000, "Payout MUST be signed negative");
});

test("Trigger hook: zero payout → no entry (no liability)", async () => {
  const pool = await buildMemPool();
  await recordTriggerLedgerWrite({
    pool,
    protectionId: "prot_x",
    payoutOwedUsd: 0
  });
  const entries = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  assert.equal(entries.length, 0);
});

test("TP sell hook: writes hedge_sell_in (positive) to Atticus pool", async () => {
  const pool = await buildMemPool();
  await recordTpSellLedgerWrite({
    pool,
    protectionId: "prot_sold",
    proceedsUsd: 75,
    reason: "take_profit_prime",
    orderId: "deribit_order_abc"
  });
  const entries = await listLedgerEntries(pool, { poolId: "atticus_hedge" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entryType, "hedge_sell_in");
  assert.equal(Number(entries[0].amountUsdc), 75);
});

test("Full lifecycle simulation: activate → trigger → TP sell, balances net correctly", async () => {
  const pool = await buildMemPool();
  // Trader buys $50k 2% protection at $500 premium; we hedge for $400; trigger fires for $1000 payout; we sell hedge for $750
  const protectionId = "prot_full_lifecycle";

  // 1. Activate
  await recordActivationLedgerWrites({
    pool, protectionId,
    clientPremiumUsd: 500,
    hedgeCostUsd: 400,
    marketId: "BTC-USD",
    externalOrderId: "ord_1"
  });

  // 2. Trigger
  await recordTriggerLedgerWrite({
    pool, protectionId,
    payoutOwedUsd: 1000
  });

  // 3. TP sell
  await recordTpSellLedgerWrite({
    pool, protectionId,
    proceedsUsd: 750,
    reason: "take_profit_prime",
    orderId: "ord_2"
  });

  // Foxify pool: +500 premium − 1000 payout = −500
  const foxifyBalance = await getPoolBalance(pool, "foxify_trader");
  assert.equal(Number(foxifyBalance!.currentBalanceUsdc), -500,
    "Foxify pool net = premium − payout = 500 − 1000 = −500");

  // Atticus pool: −400 hedge + 750 sell = +350
  const atticusBalance = await getPoolBalance(pool, "atticus_hedge");
  assert.equal(Number(atticusBalance!.currentBalanceUsdc), 350,
    "Atticus pool net = -hedge + sell = -400 + 750 = +350");

  // Combined platform P&L = +500 - 1000 - 400 + 750 = -150 (loss; trader won)
  const combined = Number(foxifyBalance!.currentBalanceUsdc) + Number(atticusBalance!.currentBalanceUsdc);
  assert.equal(combined, -150,
    "Combined platform P&L on this trade = -150 (trader won by $150 net of all flows)");
});

test("OTM-expired lifecycle: activate → no trigger → no TP sell, premium retained", async () => {
  const pool = await buildMemPool();
  await recordActivationLedgerWrites({
    pool, protectionId: "prot_otm",
    clientPremiumUsd: 100,
    hedgeCostUsd: 30,
    marketId: "BTC-USD",
    externalOrderId: "ord_otm"
  });
  // No trigger, no TP sell — option expires worthless

  const foxifyBalance = await getPoolBalance(pool, "foxify_trader");
  const atticusBalance = await getPoolBalance(pool, "atticus_hedge");

  assert.equal(Number(foxifyBalance!.currentBalanceUsdc), 100, "Foxify keeps full premium on OTM expiry");
  assert.equal(Number(atticusBalance!.currentBalanceUsdc), -30, "Atticus eats full hedge cost on OTM expiry");
  // Platform P&L = +100 - 30 = +70 (good outcome — most days)
  const combined = Number(foxifyBalance!.currentBalanceUsdc) + Number(atticusBalance!.currentBalanceUsdc);
  assert.equal(combined, 70, "OTM expiry net P&L = premium − hedge = +70");
});

test("Per-protection lookup: list ledger entries by protection_id metadata", async () => {
  const pool = await buildMemPool();
  await recordActivationLedgerWrites({
    pool, protectionId: "prot_A",
    clientPremiumUsd: 100, hedgeCostUsd: 50,
    marketId: "BTC-USD", externalOrderId: "x"
  });
  await recordActivationLedgerWrites({
    pool, protectionId: "prot_B",
    clientPremiumUsd: 200, hedgeCostUsd: 75,
    marketId: "BTC-USD", externalOrderId: "y"
  });

  const allFoxify = await listLedgerEntries(pool, { poolId: "foxify_trader" });
  const protAEntries = allFoxify.filter((e) => e.protectionId === "prot_A");
  const protBEntries = allFoxify.filter((e) => e.protectionId === "prot_B");
  assert.equal(protAEntries.length, 1);
  assert.equal(protBEntries.length, 1);
  assert.equal(Number(protAEntries[0].amountUsdc), 100);
  assert.equal(Number(protBEntries[0].amountUsdc), 200);
});
