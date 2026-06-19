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

test("aggregate: too few sessions ⟹ WATCH (not CLEAN) even if clean", () => {
  const agg = aggregateShadowScorecards([rec(1), rec(2)]);
  assert.equal(agg.verdict, "WATCH");
  assert.ok(agg.flags.some((f) => /session/.test(f)));
});

test("aggregate: reconciliation drift or oracle failure ⟹ DEGRADED", () => {
  const records = [
    ...Array.from({ length: 11 }, (_, i) => rec(i)),
    rec(99, { allReconciled: false }),
    rec(100, { allSettledOracleVerified: false, lifecycleComplete: false })
  ];
  const agg = aggregateShadowScorecards(records);
  assert.equal(agg.verdict, "DEGRADED");
  assert.equal(agg.reconciliation.sessionsWithDrift, 1);
  assert.ok(agg.flags.some((f) => /reconciliation drift/.test(f)));
  assert.ok(agg.flags.some((f) => /oracle verification failed/.test(f)));
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
