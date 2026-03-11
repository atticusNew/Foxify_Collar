import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  computeFloorPrice,
  computePayoutDue,
  normalizeTierName,
  resolveDrawdownFloorPct,
  resolveExpiryDays,
  resolveRenewWindowMinutes
} from "../src/pilot/floor";

test("normalizeTierName falls back to Bronze for unknown tier", () => {
  assert.equal(normalizeTierName("Unknown"), "Pro (Bronze)");
  assert.equal(normalizeTierName("Pro (Gold)"), "Pro (Gold)");
});

test("resolveDrawdownFloorPct uses provided valid value else tier default", () => {
  assert.equal(resolveDrawdownFloorPct({ tierName: "Pro (Silver)" }).toFixed(2), "0.15");
  assert.equal(
    resolveDrawdownFloorPct({ tierName: "Pro (Silver)", drawdownFloorPct: 0.11 }).toFixed(2),
    "0.11"
  );
});

test("resolveExpiryDays and renew window use bounded values", () => {
  assert.equal(resolveExpiryDays({ tierName: "Pro (Bronze)", requestedDays: 9 }), 9);
  assert.equal(resolveExpiryDays({ tierName: "Pro (Bronze)", requestedDays: 0 }), 7);
  assert.equal(resolveRenewWindowMinutes({ tierName: "Pro (Gold)", requestedMinutes: 240 }), 240);
});

test("computeFloorPrice and payout respect floor threshold", () => {
  const entry = new Decimal(100000);
  const drawdown = new Decimal(0.2);
  const floor = computeFloorPrice(entry, drawdown);
  assert.equal(floor.toFixed(0), "80000");

  const noPayout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    floorPrice: floor,
    expiryPrice: new Decimal(85000)
  });
  assert.equal(noPayout.toFixed(2), "0.00");

  const payout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    floorPrice: floor,
    expiryPrice: new Decimal(70000)
  });
  assert.equal(payout.toFixed(2), "1000.00");
});

