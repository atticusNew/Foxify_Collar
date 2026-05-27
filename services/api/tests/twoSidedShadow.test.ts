/**
 * PR 7 tests — shadow trade infrastructure.
 *
 *  - Activate with isShadow=true → pair recorded with is_shadow=true
 *  - ShadowStrangleExecutor returns fills at the live ask
 *  - Activate without isShadow → is_shadow=false
 *  - Reconciliation: drift below threshold → no alert
 *  - Reconciliation: drift above threshold + min samples → alert
 *  - Reconciliation: alert suppressed under min sample size
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  getPairById,
  updatePairStatus,
  insertPair
} from "../src/singleSide/twoSided/db";
import { handleActivate } from "../src/singleSide/twoSided/activateHandler";
import { ShadowStrangleExecutor } from "../src/singleSide/twoSided/shadowExecutor";
import { computeShadowReconciliation } from "../src/singleSide/twoSided/shadowReconciliation";
import type { AggregatedFeed } from "../src/singleSide/twoSided/feedAggregator";
import type { LiveAnchorProvider } from "../src/singleSide/twoSided/quoteEngine";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const makeFeed = (): AggregatedFeed => {
  const now = Date.now();
  return {
    canonicalPrice: 76_000,
    asOfMs: now,
    sources: [
      { source: "bullish", price: 76_000, ts: now },
      { source: "deribit", price: 76_001, ts: now },
      { source: "coinbase", price: 75_999, ts: now }
    ],
    rejected: [],
    expired: [],
    health: "healthy",
    medianCalcDescription: "median=76000"
  };
};

const makeAnchors = (): LiveAnchorProvider => ({
  getAnchorForLeg: async (strike, optionType) => {
    if (optionType === "put") {
      return {
        bullish: { venue: "bullish", symbol: `BTC-USDC-20260530-${strike}-P`, askUsdcPerBtc: 1_150, depthWithin2pctBtc: 3, pulledAt: new Date().toISOString() },
        deribit: null
      };
    }
    return {
      bullish: null,
      deribit: { venue: "deribit", symbol: `BTC-31MAY26-${strike}-C`, askUsdcPerBtc: 1_162.86, depthWithin2pctBtc: 3, pulledAt: new Date().toISOString() }
    };
  }
});

// ─── ShadowStrangleExecutor unit tests ───

test("ShadowStrangleExecutor: returns fills at max acceptable", async () => {
  const exec = new ShadowStrangleExecutor();
  const r = await exec.executeStrangle({
    pairId: "p1",
    putLeg: { venue: "bullish", symbol: "x", strikeUsdc: 77_000, contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150, legRole: "long_put" },
    callLeg: { venue: "deribit", symbol: "y", strikeUsdc: 75_000, contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_162.86, legRole: "long_call" }
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.putLeg.filledAskUsdcPerBtc, 1_150);
    assert.equal(r.callLeg.filledAskUsdcPerBtc, 1_162.86);
  }
});

test("ShadowStrangleExecutor: forceFailReason returns both_failed", async () => {
  const exec = new ShadowStrangleExecutor({ forceFailReason: "depth_insufficient" });
  const r = await exec.executeStrangle({
    pairId: "p1",
    putLeg: { venue: "bullish", symbol: "x", strikeUsdc: 77_000, contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150, legRole: "long_put" },
    callLeg: { venue: "deribit", symbol: "y", strikeUsdc: 75_000, contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_162.86, legRole: "long_call" }
  });
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "both_failed");
    assert.equal((r.putLegResult as { ok: false; reason: string }).reason, "depth_insufficient");
  }
});

// ─── Activate handler with isShadow ───

test("handleActivate: isShadow=true sets is_shadow column", async () => {
  const pool = await buildPool();
  const res = await handleActivate(
    {
      cellId: "pair_50k_2pct",
      maxAcceptableHedgeCostUsdc: 3_500,
      foxifyPairRef: "fxy-shadow-1",
      isShadow: true
    },
    {
      pool,
      anchorProvider: makeAnchors(),
      executor: new ShadowStrangleExecutor(),
      getFeed: () => makeFeed()
    }
  );
  assert.equal(res.status, 201);
  if (res.status !== 201) return;
  const pair = await getPairById(pool, res.body.pair_id);
  assert.ok(pair);
  assert.equal(pair!.isShadow, true);
});

test("handleActivate: isShadow omitted defaults to false", async () => {
  const pool = await buildPool();
  const res = await handleActivate(
    { cellId: "pair_50k_2pct", maxAcceptableHedgeCostUsdc: 3_500, foxifyPairRef: "fxy-live-1" },
    {
      pool,
      anchorProvider: makeAnchors(),
      executor: new ShadowStrangleExecutor(), // executor irrelevant to flag
      getFeed: () => makeFeed()
    }
  );
  assert.equal(res.status, 201);
  if (res.status !== 201) return;
  const pair = await getPairById(pool, res.body.pair_id);
  assert.equal(pair!.isShadow, false);
});

// ─── Reconciliation ───

const seedSettledShadowPair = async (pool: ReturnType<typeof newDb> extends infer _ ? Awaited<ReturnType<typeof buildPool>> : never, pairId: string, foxifyShareUsdc: number, hedgeCostUsdc: number, closedAtIso: string) => {
  const p = await insertPair(pool, {
    pairId,
    cellId: "pair_50k_2pct",
    foxifyPairRef: pairId + "-ref",
    spotAtActivation: 76_000,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 74_480,
    triggerUpPrice: 77_520,
    hedgeTenorDays: 3,
    expiresAt: closedAtIso,
    tpForceExitAt: closedAtIso,
    hedgeCostTotalUsdc: hedgeCostUsdc,
    foxifyCapitalFundedUsdc: hedgeCostUsdc,
    tierAtActivation: "tier_1",
    atticusFloorUsdc: 25,
    metadata: {},
    isShadow: true,
    status: "pending"
  });
  // Walk through states: pending → active → unwinding → settled
  await updatePairStatus(pool, p.pairId, "active");
  await updatePairStatus(pool, p.pairId, "unwinding");
  await updatePairStatus(pool, p.pairId, "settled", {
    closedAt: closedAtIso,
    closedReason: "trigger",
    salvageProceedsUsdc: foxifyShareUsdc + 100, // arbitrary
    upliftUsdc: foxifyShareUsdc - hedgeCostUsdc,
    foxifyShareUsdc,
    atticusShareUsdc: 100,
    exitMode: "capture_window_peak"
  });
};

test("computeShadowReconciliation: within drift threshold → no alert", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Seed 12 settled shadow pairs with realized Foxify EV ≈ +$543 (matches predicted)
  for (let i = 0; i < 12; i++) {
    const realizedEvPerPair = 543 + (i % 3) * 10; // small variance around mean
    const hedge = 3_238;
    const foxifyShare = hedge + realizedEvPerPair;
    await seedSettledShadowPair(pool, `p-${i}`, foxifyShare, hedge, new Date(now - i * 3_600_000).toISOString());
  }
  const r = await computeShadowReconciliation(pool, { nowMs: now });
  assert.equal(r.shadowPairsSettled, 12);
  assert.ok(Math.abs(r.driftPct) < 0.05, `drift ${r.driftPct} should be small`);
  assert.equal(r.alert, false);
});

test("computeShadowReconciliation: drift > threshold + n>=10 → alert", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Seed 15 settled shadow pairs with realized Foxify EV ≈ +$100 (way below predicted $543)
  for (let i = 0; i < 15; i++) {
    const hedge = 3_238;
    const foxifyShare = hedge + 100;
    await seedSettledShadowPair(pool, `bad-${i}`, foxifyShare, hedge, new Date(now - i * 3_600_000).toISOString());
  }
  const r = await computeShadowReconciliation(pool, { nowMs: now });
  assert.equal(r.shadowPairsSettled, 15);
  assert.ok(r.driftPct < -0.5, `expected large negative drift, got ${r.driftPct}`);
  assert.equal(r.alert, true);
});

test("computeShadowReconciliation: alert suppressed when n < 10", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // Only 5 pairs with bad drift — under min sample size
  for (let i = 0; i < 5; i++) {
    const hedge = 3_238;
    const foxifyShare = hedge + 100;
    await seedSettledShadowPair(pool, `few-${i}`, foxifyShare, hedge, new Date(now - i * 3_600_000).toISOString());
  }
  const r = await computeShadowReconciliation(pool, { nowMs: now });
  assert.equal(r.shadowPairsSettled, 5);
  assert.equal(r.alert, false, "alert must be suppressed under min sample size");
});
