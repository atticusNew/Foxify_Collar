import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateShadowScorecards, type ShadowRunRecord } from "../src/singleSide/twoSided/creditCollar/shadowAggregate";
import { appendScorecard, loadScorecards, filterSince } from "../src/singleSide/twoSided/creditCollar/shadowStore";
import type { ShadowScorecard } from "../src/singleSide/twoSided/creditCollar/shadowRunner";

const mkScorecard = (over: Partial<ShadowScorecard> = {}): ShadowScorecard => ({
  label: "tier0_shadow_paper_settled",
  mode: "shadow",
  oracle: { status: "healthy", priceUsd: 62_000, safeForActivation: true, signatureValid: true },
  attempted: 20,
  opened: 20,
  openedNotionalUsdc: 1_000_000,
  halted: 0,
  rejected: 0,
  rejectionsByReason: {},
  peakNetExposureRatio: 0.09,
  peakNetNotionalUsdc: 50_000,
  maxFloorPctUsed: 0.04,
  avgFloorPctUsed: 0.04,
  serviceFeeAccruedUsdc: 200,
  foxifyCreditAccruedUsdc: 1_500,
  settlements: 20,
  allSettledOracleVerified: true,
  allReconciled: true,
  totalPayoutToFoxifyUsdc: -120,
  totalNetToFoxifyUsdc: 1_380,
  settlementPriceUsd: 62_000,
  lifecycleComplete: true,
  notes: [],
  ...over
});

const rec = (tsMs: number, over: Partial<ShadowScorecard> = {}): ShadowRunRecord => ({ tsMs, scorecard: mkScorecard(over) });

test("aggregate: clean cohort ⟹ TRACK_RECORD_CLEAN with realized service-fee bps", () => {
  const records = Array.from({ length: 12 }, (_, i) => rec(1000 + i));
  const agg = aggregateShadowScorecards(records);
  assert.equal(agg.sessions, 12);
  assert.equal(agg.verdict, "TRACK_RECORD_CLEAN");
  assert.equal(agg.positions.openRate, 1);
  assert.equal(agg.oracle.allVerifiedRate, 1);
  assert.equal(agg.reconciliation.allReconciledRate, 1);
  assert.equal(agg.lifecycleCompleteRate, 1);
  // $200 fee / $1m notional × 1e4 = 2 bps.
  assert.equal(agg.economics.realizedServiceFeeBps, 2);
  assert.equal(agg.flags.length, 0);
});

test("aggregate: capital-aware net bps subtracts the measured short-leg IM drag", () => {
  const records = Array.from({ length: 12 }, (_, i) => rec(1000 + i));
  // Measured IM 13.93%/notional, full gross carry, isolated (PM=1), 12%/yr, 1-day hold.
  const agg = aggregateShadowScorecards(records, {
    capital: { shortOptionImFraction: 0.1393, shortOptionGrossNotionalFraction: 1.0, portfolioMarginNettingFactor: 1.0, costOfCapitalAnnual: 0.12, tenorDays: 1 }
  });
  assert.equal(agg.economics.realizedServiceFeeBps, 2);
  // capitalCostBps = 0.1393 × 1 × 1 × 0.12 × (1/365) × 1e4 ≈ 0.4580 bps
  assert.ok(Math.abs(agg.capital.capitalCostBps - 0.458) < 0.01, `got ${agg.capital.capitalCostBps}`);
  assert.ok(Math.abs(agg.capital.capitalAwareNetServiceFeeBps - (2 - agg.capital.capitalCostBps)) < 1e-6);
  // Portfolio-margin netting halves the drag.
  const pm = aggregateShadowScorecards(records, {
    capital: { shortOptionImFraction: 0.1393, shortOptionGrossNotionalFraction: 1.0, portfolioMarginNettingFactor: 0.5, costOfCapitalAnnual: 0.12, tenorDays: 1 }
  });
  assert.ok(Math.abs(pm.capital.capitalCostBps - agg.capital.capitalCostBps / 2) < 1e-6, "PM netting halves the capital drag");
  assert.ok(pm.capital.capitalAwareNetServiceFeeBps > agg.capital.capitalAwareNetServiceFeeBps);
});

test("aggregate: a 0-open cycle that correctly declined (oracle not safe) is NOT counted incomplete", () => {
  // Stored lifecycleComplete=false (old code), opened=0, oracle not safe ⟹ reclassified as complete.
  const declined = rec(50, {
    opened: 0,
    openedNotionalUsdc: 0,
    halted: 20,
    lifecycleComplete: false,
    oracle: { status: "degraded", priceUsd: 62_000, safeForActivation: false, signatureValid: true }
  });
  const records = [...Array.from({ length: 11 }, (_, i) => rec(i)), declined];
  const agg = aggregateShadowScorecards(records);
  assert.equal(agg.lifecycleCompleteRate, 1, "safe declines count as complete (correct fail-closed)");
  assert.notEqual(agg.verdict, "DEGRADED");
});

test("aggregate: too few sessions ⟹ WATCH (not CLEAN) even if clean", () => {
  const agg = aggregateShadowScorecards([rec(1), rec(2)]);
  assert.equal(agg.verdict, "WATCH");
  assert.ok(agg.flags.some((f) => /session/.test(f)));
});

test("aggregate: MATERIAL recent failures ⟹ DEGRADED", () => {
  // A recent cluster of reconciliation drift (well above the 10% recent threshold).
  const records = [
    ...Array.from({ length: 6 }, (_, i) => rec(i)),
    ...Array.from({ length: 6 }, (_, i) => rec(100 + i, { allReconciled: false }))
  ];
  const agg = aggregateShadowScorecards(records);
  assert.equal(agg.verdict, "DEGRADED");
  assert.ok(agg.flags.some((f) => /reconciliation drift/.test(f)));
});

test("aggregate: a SINGLE old blip among many clean ⟹ WATCH, not DEGRADED (transient-tolerant)", () => {
  // One ancient failure, then 30 clean recent sessions — the recent window is clean ⟹ not DEGRADED.
  const records = [
    rec(1, { allSettledOracleVerified: false, allReconciled: false, lifecycleComplete: false }),
    ...Array.from({ length: 30 }, (_, i) => rec(1000 + i))
  ];
  const agg = aggregateShadowScorecards(records);
  assert.equal(agg.verdict, "WATCH", "a lone historical blip must not permanently alarm");
  // The all-time blip still shows up as an informational flag.
  assert.ok(agg.flags.some((f) => /oracle verification failed|reconciliation drift|lifecycle incomplete/.test(f)));
});

test("aggregate: exposure breach beyond band is flagged", () => {
  const records = [...Array.from({ length: 11 }, (_, i) => rec(i)), rec(50, { peakNetExposureRatio: 0.4 })];
  const agg = aggregateShadowScorecards(records, { exposureBandPct: 0.15 });
  assert.equal(agg.exposure.maxPeakNetExposureRatio, 0.4);
  assert.ok(agg.flags.some((f) => /exposure/.test(f)));
  assert.notEqual(agg.verdict, "TRACK_RECORD_CLEAN");
});

test("aggregate: empty history ⟹ NO_DATA (warming up), NOT DEGRADED", () => {
  const agg = aggregateShadowScorecards([]);
  assert.equal(agg.sessions, 0);
  assert.equal(agg.positions.openRate, 0);
  assert.equal(agg.economics.realizedServiceFeeBps, 0);
  assert.equal(agg.verdict, "NO_DATA");
  assert.ok(agg.flags.some((f) => /no sessions yet/.test(f)));
});

test("store: append + load round-trips JSONL; filterSince works", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-store-"));
  const path = join(dir, "scorecards.jsonl");
  try {
    appendScorecard(rec(1000), path);
    appendScorecard(rec(2000), path);
    appendScorecard(rec(3000), path);
    const loaded = loadScorecards(path);
    assert.equal(loaded.length, 3);
    assert.equal(filterSince(loaded, 2000).length, 2);
    const agg = aggregateShadowScorecards(loaded);
    assert.equal(agg.sessions, 3);
    assert.equal(agg.firstTsMs, 1000);
    assert.equal(agg.lastTsMs, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
