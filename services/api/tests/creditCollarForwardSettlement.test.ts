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

test("aggregateSettlements: empty is well-defined", () => {
  const agg = aggregateSettlements([]);
  assert.equal(agg.settledPositions, 0);
  assert.equal(agg.bookNetPayoutBps, 0);
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
