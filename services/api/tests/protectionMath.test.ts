import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  computeDrawdownLossBudgetUsd,
  isDrawdownBreached,
  resolveTriggerEconomicsFromProtection
} from "../src/pilot/protectionMath";
import type { ProtectionRecord } from "../src/pilot/types";

const baseProtection = (overrides: Partial<ProtectionRecord> = {}): ProtectionRecord => ({
  id: "p-1",
  userHash: "u",
  hashVersion: 1,
  status: "active",
  tierName: "Pro (Bronze)",
  drawdownFloorPct: "0.200000",
  floorPrice: "80000.0000000000",
  slPct: null,
  hedgeStatus: null,
  regime: null,
  regimeSource: null,
  dvolAtPurchase: null,
  marketId: "BTC-USD",
  protectedNotional: "5000.0000000000",
  entryPrice: "100000.0000000000",
  entryPriceSource: "reference_snapshot_quote",
  entryPriceTimestamp: new Date().toISOString(),
  expiryAt: new Date(Date.now() + 86400000).toISOString(),
  expiryPrice: null,
  expiryPriceSource: null,
  expiryPriceTimestamp: null,
  autoRenew: false,
  renewWindowMinutes: 1440,
  venue: "mock_falconx",
  instrumentId: "BTC-USD-7D-P",
  side: "buy",
  size: "0.0500000000",
  executionPrice: "100.0000000000",
  premium: "25.0000000000",
  executedAt: new Date().toISOString(),
  externalOrderId: "order-1",
  externalExecutionId: "exec-1",
  payoutDueAmount: null,
  payoutSettledAmount: null,
  payoutSettledAt: null,
  payoutTxRef: null,
  foxifyExposureNotional: "5000.0000000000",
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides
});

test("computeDrawdownLossBudgetUsd returns protectedNotional * drawdown", () => {
  const budget = computeDrawdownLossBudgetUsd(new Decimal("5000"), new Decimal("0.2"));
  assert.equal(budget.toFixed(10), "1000.0000000000");
});

test("isDrawdownBreached handles long and short trigger directions", () => {
  const longBreached = isDrawdownBreached({
    protectionType: "long",
    triggerPrice: new Decimal("80000"),
    referencePrice: new Decimal("79999.99")
  });
  const shortBreached = isDrawdownBreached({
    protectionType: "short",
    triggerPrice: new Decimal("115000"),
    referencePrice: new Decimal("115000")
  });
  assert.equal(longBreached, true);
  assert.equal(shortBreached, true);
});

test("resolveTriggerEconomicsFromProtection returns trigger and credit", () => {
  const economics = resolveTriggerEconomicsFromProtection(baseProtection());
  assert.ok(economics);
  assert.equal(economics?.protectionType, "long");
  assert.equal(economics?.triggerPrice.toFixed(10), "80000.0000000000");
  assert.equal(economics?.triggerPayoutCreditUsd.toFixed(10), "1000.0000000000");
});

test("resolveTriggerEconomicsFromProtection derives short trigger from drawdown", () => {
  const economics = resolveTriggerEconomicsFromProtection(
    baseProtection({
      instrumentId: "BTC-USD-7D-C",
      floorPrice: null,
      drawdownFloorPct: "0.150000"
    })
  );
  assert.ok(economics);
  assert.equal(economics?.protectionType, "short");
  assert.equal(economics?.triggerPrice.toFixed(10), "115000.0000000000");
  assert.equal(economics?.triggerPayoutCreditUsd.toFixed(10), "750.0000000000");
});
