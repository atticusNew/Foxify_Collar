/**
 * PR A8 tests — newborn-review enforcement.
 *
 *   - canActivate: with currentRegime + triggers_observed > approved → blocked with newborn_review reason
 *   - canActivate: triggers_observed = approved → activation passes
 *   - canActivate: approvedCount >= threshold → reviewRequired false, activation passes
 *   - canActivate: regime not provided → newborn gate skipped (legacy behavior)
 *   - TriggerDetector: on trigger, recordNewbornForRegime invoked with regime
 *   - End-to-end: trigger → activate blocked → operator clears → activate passes
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { ensureTwoSidedSchema, insertPair, updatePairStatus, getPairById } from "../src/singleSide/twoSided/db";
import { ensureGuardrailsSchema, canActivate } from "../src/singleSide/twoSided/guardrails";
import {
  ensureNewbornReviewSchema,
  recordNewbornTrigger,
  clearNewbornReview,
  getNewbornState
} from "../src/singleSide/twoSided/featureFlag";
import { TriggerDetector } from "../src/singleSide/twoSided/triggerDetector";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  await ensureGuardrailsSchema(pool);
  await ensureNewbornReviewSchema(pool);
  return pool;
};

test("canActivate: newborn pending review → blocked with newborn_review reason", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "calm");
  // 1 trigger observed, 0 approved → reviewRequired
  const r = await canActivate(pool, {
    dvol: 38,
    capitalAvailableUsdc: null,
    pairHedgeCostUsdc: 3_200,
    currentRegime: "calm",
    newbornReviewThreshold: 3
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "newborn_review");
  assert.ok(r.details);
});

test("canActivate: triggers_observed = approved → activation passes (caught up)", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "calm");
  await clearNewbornReview(pool, "calm");
  const r = await canActivate(pool, {
    dvol: 38,
    capitalAvailableUsdc: null,
    pairHedgeCostUsdc: 3_200,
    currentRegime: "calm",
    newbornReviewThreshold: 3
  });
  assert.equal(r.ok, true);
});

test("canActivate: approvedCount >= threshold → reviewRequired false", async () => {
  const pool = await buildPool();
  // Clear 3 reviews → operatorApprovedCount = 3, threshold = 3 → reviewRequired=false
  for (let i = 0; i < 3; i++) await clearNewbornReview(pool, "calm");
  const r = await canActivate(pool, {
    dvol: 38,
    capitalAvailableUsdc: null,
    pairHedgeCostUsdc: 3_200,
    currentRegime: "calm",
    newbornReviewThreshold: 3
  });
  assert.equal(r.ok, true);
});

test("canActivate: regime not provided → newborn gate skipped", async () => {
  const pool = await buildPool();
  // Record pending review on calm — but caller doesn't pass currentRegime → gate skipped
  await recordNewbornTrigger(pool, "calm");
  const r = await canActivate(pool, {
    dvol: 38,
    capitalAvailableUsdc: null,
    pairHedgeCostUsdc: 3_200
    // no currentRegime
  });
  assert.equal(r.ok, true, "newborn gate must be opt-in via currentRegime");
});

test("canActivate: regime-isolated — moderate trigger doesn't block calm activation", async () => {
  const pool = await buildPool();
  await recordNewbornTrigger(pool, "moderate");
  const r = await canActivate(pool, {
    dvol: 38, // calm
    capitalAvailableUsdc: null,
    pairHedgeCostUsdc: 3_200,
    currentRegime: "calm",
    newbornReviewThreshold: 3
  });
  assert.equal(r.ok, true);
});

test("TriggerDetector: invokes recordNewbornForRegime on trigger", async () => {
  const pool = await buildPool();
  // Create + activate a pair so trigger detector finds it
  const p = await insertPair(pool, {
    pairId: "p1", cellId: "pair_50k_2pct", foxifyPairRef: "fxy-1",
    spotAtActivation: 76_000, feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480, triggerUpPrice: 77_520, hedgeTenorDays: 3,
    expiresAt: "2026-05-30T18:00:00Z", tpForceExitAt: "2026-05-30T14:00:00Z",
    hedgeCostTotalUsdc: 3_200, foxifyCapitalFundedUsdc: 3_200,
    tierAtActivation: "tier_1", atticusFloorUsdc: 25, metadata: {}
  });
  await updatePairStatus(pool, p.pairId, "active");
  
  let recordedRegime: string | null = null;
  const det = new TriggerDetector({
    pool,
    getFeed: (): AggregatedFeed => ({
      canonicalPrice: 74_400, // below down trigger
      asOfMs: Date.now(),
      sources: [], rejected: [], expired: [],
      health: "healthy",
      medianCalcDescription: "test"
    }),
    onTrigger: () => {},
    getCurrentRegime: () => "calm",
    recordNewbornForRegime: async (r) => { recordedRegime = r; },
    log: () => {}
  });
  await det.tick();
  assert.equal(recordedRegime, "calm");
});

test("End-to-end: trigger → activate blocked → operator clears → activate passes", async () => {
  const pool = await buildPool();
  // Simulate: 1 trigger observed in calm regime
  await recordNewbornTrigger(pool, "calm");
  
  // Activation blocked
  const r1 = await canActivate(pool, {
    dvol: 38, capitalAvailableUsdc: null, pairHedgeCostUsdc: 3_200,
    currentRegime: "calm", newbornReviewThreshold: 3
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "newborn_review");
  
  // Operator clears
  await clearNewbornReview(pool, "calm");
  
  // Activation passes
  const r2 = await canActivate(pool, {
    dvol: 38, capitalAvailableUsdc: null, pairHedgeCostUsdc: 3_200,
    currentRegime: "calm", newbornReviewThreshold: 3
  });
  assert.equal(r2.ok, true);
});
