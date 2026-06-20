import assert from "node:assert/strict";
import test from "node:test";
import { reconcileShadowLifecycle } from "../src/singleSide/twoSided/creditCollar/lifecycleShadow";
import { openLedger } from "../src/singleSide/twoSided/creditCollar/collateralLedger";
import type { OpenPosition } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";
import type { OracleTick, PriceSample } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  ref: "p1",
  side: "long",
  notionalUsdc: 50_000,
  spotAtEntry: 63_000,
  putStrike: 61_000,
  callStrike: 65_000,
  foxifyCreditUsdc: 70,
  serviceFeeUsdc: 10,
  floorPctUsed: 0.03,
  openedAtMs: NOW - DAY / 2, // held half the tenor
  expiresAtMs: NOW + DAY / 2,
  ...over
});

const samples = (prices: Record<string, number>): PriceSample[] =>
  Object.entries(prices).map(([source, priceUsd]) => ({ source, priceUsd, tsMs: NOW - 100 }));

test("overlay: basis from venue marks, vesting accrual, healthy collateral", () => {
  const r = reconcileShadowLifecycle({
    open: [pos(), pos({ ref: "p2" })],
    nowMs: NOW,
    ticks: [{ tsMs: NOW, priceUsd: 63_000 }],
    oracleMedianUsd: 63_000,
    usableSamples: samples({ deribit: 63_010, okx: 62_995, coinbase: 63_000 }),
    ledger: openLedger(250_000, { minBufferUsdc: 25_000 }),
    tenorMs: DAY,
    basisMaxBps: 25
  });
  assert.ok(r.report.basisBps > 0 && r.report.basisWithinTolerance, "small venue dispersion is within tolerance");
  assert.equal(r.report.openPositions, 2);
  assert.equal(r.report.fullCreditUsdc, 140);
  // Held half the tenor (linear) ⟹ ~50% vested.
  assert.ok(Math.abs(r.report.vestProgressPct - 50) < 1, `got ${r.report.vestProgressPct}`);
  assert.equal(r.report.collateralHalted, false);
});

test("overlay: wide basis flags defer-settle", () => {
  const r = reconcileShadowLifecycle({
    open: [pos()],
    nowMs: NOW,
    ticks: [{ tsMs: NOW, priceUsd: 63_000 }],
    oracleMedianUsd: 63_000,
    usableSamples: samples({ deribit: 63_000, thin: 63_400 }), // ~63 bps
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25
  });
  assert.equal(r.report.basisWithinTolerance, false);
  assert.ok(r.report.flags.some((f) => /basis_wide/.test(f)));
});

test("overlay: partner feed shows a closed perp with no barrier ⟹ orphan detected", () => {
  const r = reconcileShadowLifecycle({
    open: [pos({ ref: "a" }), pos({ ref: "b" })],
    nowMs: NOW,
    ticks: [{ tsMs: NOW, priceUsd: 63_000 }], // no barrier
    oracleMedianUsd: 63_000,
    usableSamples: samples({ deribit: 63_000, okx: 63_005 }),
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25,
    partnerStates: { a: { isOpen: false, sizeUsd: 0, markPriceUsd: 63_000 }, b: { isOpen: true, sizeUsd: 50_000, markPriceUsd: 63_000 } },
    partnerFeedHealthy: true
  });
  assert.equal(r.report.orphansDetected, 1);
  assert.ok(r.report.flags.some((f) => /orphan_protection:a/.test(f)));
});

test("overlay: degraded partner feed is flagged", () => {
  const r = reconcileShadowLifecycle({
    open: [pos()],
    nowMs: NOW,
    ticks: [{ tsMs: NOW, priceUsd: 63_000 }],
    oracleMedianUsd: 63_000,
    usableSamples: samples({ deribit: 63_000, okx: 63_005 }),
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25,
    partnerFeedHealthy: false
  });
  assert.equal(r.report.partnerFeedHealthy, false);
  assert.ok(r.report.flags.includes("partner_feed_degraded"));
});

test("overlay: a barrier touch routes a modeled gap to the reserve (collateral intact)", () => {
  const ticks: OracleTick[] = [0, 1, 2, 3].map((i) => ({ tsMs: NOW + i * 1000, priceUsd: 65_500 })); // above the cap
  const r = reconcileShadowLifecycle({
    open: [pos()],
    nowMs: NOW,
    ticks,
    oracleMedianUsd: 65_500,
    usableSamples: samples({ deribit: 65_500, okx: 65_490 }),
    ledger: openLedger(250_000),
    tenorMs: DAY,
    basisMaxBps: 25,
    persistTicks: 3
  });
  assert.equal(r.report.barrierTouchesDetected, 1);
  assert.ok(r.report.gapToReserveUsdc > 0, "on-time touch gap absorbed by the reserve");
  assert.equal(r.report.gapToFoxifyUsdc, 0);
  assert.equal(r.ledger.availableUsdc, 250_000, "reserve-absorbed gaps do not debit Foxify collateral");
});
