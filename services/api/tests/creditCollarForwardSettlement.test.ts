import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCollarSettlement,
  settleMatured,
  aggregateSettlements,
  type OpenPosition,
  type CycleOracle
} from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import { loadOpenPositions, saveOpenPositions, appendSettlements, loadSettlements } from "../src/singleSide/twoSided/creditCollar/forwardSettlementStore";
import { aggregateOracle, signSnapshot, generateOracleKeyPair, type PriceSample, type OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const NOW = 1_800_000_000_000;
const ENTRY = 100_000;

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  ref: "p1",
  side: "long",
  notionalUsdc: 50_000,
  spotAtEntry: ENTRY,
  putStrike: 96_000, // 4% floor
  callStrike: 101_000, // 1% cap
  foxifyCreditUsdc: 75,
  serviceFeeUsdc: 10,
  floorPctUsed: 0.04,
  openedAtMs: NOW - 2 * 3_600_000,
  expiresAtMs: NOW - 60_000, // matured
  ...over
});

const oracleAt = (settlePriceUsd: number, pubKeyOverride?: string): CycleOracle & { keys: { publicKeyPem: string } } => {
  const samples: PriceSample[] = [
    { source: "deribit", priceUsd: settlePriceUsd, tsMs: NOW - 200 },
    { source: "okx", priceUsd: settlePriceUsd + 10, tsMs: NOW - 200 },
    { source: "coinbase", priceUsd: settlePriceUsd - 10, tsMs: NOW - 200 }
  ];
  const snapshot = aggregateOracle(samples, NOW);
  const keys = generateOracleKeyPair();
  const signatureHex = signSnapshot(snapshot, keys.privateKeyPem);
  const ticks: OracleTick[] = [
    { tsMs: NOW - 1_800_000, priceUsd: settlePriceUsd },
    { tsMs: NOW, priceUsd: settlePriceUsd }
  ];
  return { snapshot, signatureHex, publicKeyPem: pubKeyOverride ?? keys.publicKeyPem, settlementTwapTicks: ticks, windowStartMs: NOW - 1_800_000, windowEndMs: NOW, keys };
};

test("computeCollarSettlement: long-perp down move pays the put floor; up move caps", () => {
  const down = computeCollarSettlement(pos(), 92_000); // −8%, below 96k floor
  assert.ok(down.putIntrinsicUsd > 0 && down.callIntrinsicUsd === 0);
  assert.equal(down.payoutToFoxifyUsdc, 2000); // (96000-92000)*0.5
  assert.equal(down.floorBreached, true);
  assert.equal(down.netToFoxifyUsdc, 2075); // + $75 credit

  const up = computeCollarSettlement(pos(), 105_000); // +5%, above 101k cap
  assert.equal(up.putIntrinsicUsd, 0);
  assert.ok(up.callIntrinsicUsd > 0);
  assert.ok(up.payoutToFoxifyUsdc < 0, "short call owes on a rally past the cap");
  assert.equal(up.capBreached, true);
});

test("computeCollarSettlement: short-perp mirror (long call ceiling, short put)", () => {
  const sp = pos({ side: "short", putStrike: 99_000, callStrike: 104_000 });
  const up = computeCollarSettlement(sp, 108_000); // rally → long call pays
  assert.ok(up.payoutToFoxifyUsdc > 0);
  const down = computeCollarSettlement(sp, 95_000); // drop → short put owes
  assert.ok(down.payoutToFoxifyUsdc < 0);
});

test("settleMatured: settles matured on a verified oracle; keeps unmatured", () => {
  const oracle = oracleAt(92_000);
  const matured = pos({ ref: "m", expiresAtMs: NOW - 60_000 });
  const fresh = pos({ ref: "f", expiresAtMs: NOW + 3_600_000 });
  const r = settleMatured([matured, fresh], NOW, oracle);
  assert.equal(r.settled.length, 1);
  assert.equal(r.settled[0].ref, "m");
  assert.equal(r.settled[0].payoutToFoxifyUsdc, 2000);
  assert.equal(r.stillOpen.length, 1);
  assert.equal(r.stillOpen[0].ref, "f");
  assert.equal(r.deferred, 0);
});

test("settleMatured: unverifiable oracle DEFERS matured positions (fail-closed)", () => {
  const impostor = generateOracleKeyPair();
  const oracle = oracleAt(92_000, impostor.publicKeyPem); // wrong pubkey → verify fails
  const r = settleMatured([pos({ ref: "m" })], NOW, oracle);
  assert.equal(r.oracleVerified, false);
  assert.equal(r.settled.length, 0);
  assert.equal(r.stillOpen.length, 1, "matured but unverified ⟹ kept open (deferred)");
  assert.equal(r.deferred, 1);
});

test("aggregateSettlements: realized economics incl. delta-neutral book net + floor-hit rate", () => {
  const oracleDown = oracleAt(92_000);
  const longDown = settleMatured([pos({ ref: "L", side: "long" })], NOW, oracleDown).settled; // put pays +2000
  const shortDown = settleMatured([pos({ ref: "S", side: "short", putStrike: 96_000, callStrike: 101_000 })], NOW, oracleDown).settled; // short put owes −2000
  const agg = aggregateSettlements([...longDown, ...shortDown]);
  assert.equal(agg.settledPositions, 2);
  // delta-flat: long pays +2000, short owes −2000 ⟹ book net ~0.
  assert.equal(agg.totalPayoutToFoxifyUsdc, 0);
  assert.equal(agg.bookNetPayoutBps, 0);
  assert.equal(agg.totalServiceFeeUsdc, 20);
  assert.ok(agg.pctFloorBreached > 0);
});

test("settleMatured: folds measured short-leg IM into per-position capital + net-after-capital", () => {
  // 2h hold; notional 50k; IM 13.93%/notional × PM 0.2216; 12%/yr.
  const oracle = oracleAt(99_000);
  const cap = { shortOptionImFraction: 0.1393, portfolioMarginNettingFactor: 0.2216, costOfCapitalAnnual: 0.12 };
  const r = settleMatured([pos({ ref: "c", openedAtMs: NOW - 2 * 3_600_000, expiresAtMs: NOW - 60_000 })], NOW, oracle, cap);
  assert.equal(r.settled.length, 1);
  const o = r.settled[0];
  // shortLegMargin = 50000 × 0.1393 × 0.2216 ≈ 1543.6
  assert.ok(Math.abs(o.shortLegMarginUsdc - 50_000 * 0.1393 * 0.2216) < 1, `got ${o.shortLegMarginUsdc}`);
  // capitalCost = IM × 0.12 × (2h / 8760h) ≈ tiny
  const expectedCost = o.shortLegMarginUsdc * 0.12 * (2 / 8760);
  assert.ok(Math.abs(o.capitalCostUsdc - expectedCost) < 0.01, `got ${o.capitalCostUsdc}`);
  assert.ok(Math.abs(o.atticusNetAfterCapitalUsdc - (o.serviceFeeUsdc - o.capitalCostUsdc)) < 1e-6);
});

test("aggregateSettlements: capital-aware net bps below gross service-fee bps", () => {
  const oracle = oracleAt(99_000);
  const cap = { shortOptionImFraction: 0.1393, portfolioMarginNettingFactor: 1.0, costOfCapitalAnnual: 0.12 };
  // Long hold (24h) so the capital drag is material.
  const settled = settleMatured([pos({ ref: "x", openedAtMs: NOW - 24 * 3_600_000, expiresAtMs: NOW - 60_000 })], NOW, oracle, cap).settled;
  const agg = aggregateSettlements(settled);
  assert.ok(agg.totalCapitalCostUsdc > 0);
  assert.ok(agg.peakShortLegMarginUsdc > 0);
  assert.ok(agg.capitalAwareNetServiceFeeBps < agg.realizedServiceFeeBps, "capital drag lowers net bps");
});

test("aggregateSettlements: empty is well-defined", () => {
  const agg = aggregateSettlements([]);
  assert.equal(agg.settledPositions, 0);
  assert.equal(agg.bookNetPayoutBps, 0);
  assert.equal(agg.capitalAwareNetServiceFeeBps, 0);
  assert.equal(agg.totalCapitalCostUsdc, 0);
  assert.equal(agg.touchSettlements, 0);
  assert.equal(agg.europeanSettlements, 0);
  assert.equal(agg.pctTouchSettled, 0);
});

// ── Settlement model: touch-first / European fallback ─────────────────────────

const oracleWithTicks = (snapshotPriceUsd: number, tickPrices: number[], pubKeyOverride?: string): CycleOracle => {
  const samples: PriceSample[] = [
    { source: "deribit", priceUsd: snapshotPriceUsd, tsMs: NOW - 200 },
    { source: "okx", priceUsd: snapshotPriceUsd + 10, tsMs: NOW - 200 },
    { source: "coinbase", priceUsd: snapshotPriceUsd - 10, tsMs: NOW - 200 }
  ];
  const snapshot = aggregateOracle(samples, NOW);
  const keys = generateOracleKeyPair();
  const signatureHex = signSnapshot(snapshot, keys.privateKeyPem);
  const windowStartMs = NOW - tickPrices.length * 60_000;
  const ticks: OracleTick[] = tickPrices.map((p, i) => ({ tsMs: windowStartMs + (i + 1) * 60_000 - 60_000 + 1, priceUsd: p }));
  return { snapshot, signatureHex, publicKeyPem: pubKeyOverride ?? keys.publicKeyPem, settlementTwapTicks: ticks, windowStartMs, windowEndMs: NOW };
};

test("settleMatured: BARRIER TOUCH (floor) settles at the strike, before expiry, full credit", () => {
  // putStrike 96k; ticks dip and persist ≤ 96k ⟹ floor touch confirmed. Position NOT yet matured.
  const oracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000]);
  const p = pos({ ref: "t", openedAtMs: NOW - 2 * 3_600_000, expiresAtMs: NOW + 22 * 3_600_000 });
  const r = settleMatured([p], NOW, oracle);
  assert.equal(r.touchSettled, 1);
  assert.equal(r.europeanSettled, 0);
  assert.equal(r.settled.length, 1);
  assert.equal(r.stillOpen.length, 0, "touch settles even though expiry has not passed");
  const o = r.settled[0];
  assert.equal(o.settlementType, "barrier_touch");
  assert.equal(o.barrierSide, "floor");
  assert.equal(o.settlePriceUsd, 96_000, "settles AT the barrier (ATM) with no modeled gap");
  assert.equal(o.payoutToFoxifyUsdc, 0, "option is ATM at the barrier — clean unwind");
  assert.equal(o.vestedCreditUsdc, 75, "involuntary barrier touch ⟹ full credit (barrierFullVest default)");
  assert.equal(o.creditClawbackUsdc, 0);
  assert.equal(o.netToFoxifyUsdc, 75);
});

test("settleMatured: BARRIER TOUCH (ceiling) settles at the cap", () => {
  const oracle = oracleWithTicks(102_000, [100_000, 102_000, 103_000, 104_000]);
  const p = pos({ ref: "c", openedAtMs: NOW - 3_600_000, expiresAtMs: NOW + 22 * 3_600_000 });
  const r = settleMatured([p], NOW, oracle);
  assert.equal(r.touchSettled, 1);
  const o = r.settled[0];
  assert.equal(o.barrierSide, "ceiling");
  assert.equal(o.settlePriceUsd, 101_000);
  assert.equal(o.payoutToFoxifyUsdc, 0);
});

test("settleMatured: touchGapBps models adverse slippage past the barrier (the floor pays the gap)", () => {
  const oracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000]);
  const p = pos({ ref: "g", openedAtMs: NOW - 3_600_000, expiresAtMs: NOW + 22 * 3_600_000 });
  const r = settleMatured([p], NOW, oracle, {}, { touchGapBps: 50 }); // 0.5% slip past the floor
  const o = r.settled[0];
  // gap = 0.005 × 96000 = 480; settle = 95520; put pays 480 × 0.5 contracts = 240.
  assert.equal(o.settlePriceUsd, 95_520);
  assert.equal(o.payoutToFoxifyUsdc, 240);
  assert.equal(o.floorBreached, true);
  assert.equal(o.netToFoxifyUsdc, 75 + 240);
});

test("settleMatured: enableBarrierTouch=false ⟹ pure European fallback (legacy)", () => {
  const oracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000]); // would touch the floor
  const p = pos({ ref: "e", expiresAtMs: NOW - 60_000 }); // matured
  const r = settleMatured([p], NOW, oracle, {}, { enableBarrierTouch: false });
  assert.equal(r.touchSettled, 0);
  assert.equal(r.europeanSettled, 1);
  assert.equal(r.settled[0].settlementType, "european_expiry");
  assert.equal(r.settled[0].barrierSide, "none");
});

test("settleMatured: barrier touch can be TIME-VESTED via barrierFullVest=false (clawback applies)", () => {
  const oracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000]);
  const p = pos({ ref: "v", openedAtMs: NOW - 2 * 3_600_000, expiresAtMs: NOW + 22 * 3_600_000 }); // ~2h of 24h
  const r = settleMatured([p], NOW, oracle, {}, { vesting: { barrierFullVest: false } });
  const o = r.settled[0];
  assert.ok(o.vestedCreditUsdc < 75, `time-vested ⟹ partial credit, got ${o.vestedCreditUsdc}`);
  assert.ok(o.creditClawbackUsdc > 0, "the unearned portion is clawed back");
  assert.ok(Math.abs(o.vestedCreditUsdc + o.creditClawbackUsdc - 75) < 0.05, "vested + clawback = full credit");
});

test("settleMatured: unverified oracle does NOT touch-settle and defers matured (fail-closed)", () => {
  const impostor = generateOracleKeyPair();
  const oracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000], impostor.publicKeyPem);
  const p = pos({ ref: "u", expiresAtMs: NOW - 60_000 }); // matured + would touch
  const r = settleMatured([p], NOW, oracle);
  assert.equal(r.oracleVerified, false);
  assert.equal(r.touchSettled, 0, "ticks are not trusted on an unverifiable oracle");
  assert.equal(r.settled.length, 0);
  assert.equal(r.deferred, 1);
  assert.equal(r.stillOpen.length, 1);
});

test("aggregateSettlements: surfaces touch vs European breakdown + clawback", () => {
  const touchOracle = oracleWithTicks(95_000, [98_000, 95_000, 94_000, 93_000]);
  const touch = settleMatured([pos({ ref: "T", openedAtMs: NOW - 3_600_000, expiresAtMs: NOW + 22 * 3_600_000 })], NOW, touchOracle).settled;
  const euroOracle = oracleAt(99_000);
  const euro = settleMatured([pos({ ref: "E", expiresAtMs: NOW - 60_000 })], NOW, euroOracle).settled;
  const agg = aggregateSettlements([...touch, ...euro]);
  assert.equal(agg.settledPositions, 2);
  assert.equal(agg.touchSettlements, 1);
  assert.equal(agg.europeanSettlements, 1);
  assert.equal(agg.pctTouchSettled, 0.5);
  assert.ok(agg.totalCreditClawbackUsdc >= 0);
});

test("store: open positions replace; settlements append; round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "fwd-store-"));
  const openPath = join(dir, "open.jsonl");
  const ledgerPath = join(dir, "settlements.jsonl");
  try {
    saveOpenPositions([pos({ ref: "a" }), pos({ ref: "b" })], openPath);
    assert.equal(loadOpenPositions(openPath).length, 2);
    saveOpenPositions([pos({ ref: "a" })], openPath); // replace (b settled out)
    assert.equal(loadOpenPositions(openPath).length, 1);

    const oracle = oracleAt(92_000);
    const settled = settleMatured([pos({ ref: "a" })], NOW, oracle).settled;
    appendSettlements(settled, ledgerPath);
    appendSettlements(settled, ledgerPath);
    assert.equal(loadSettlements(ledgerPath).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
