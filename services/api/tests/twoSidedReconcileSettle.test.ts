/**
 * Tests — reconcileSettlePair (out-of-band close reconciliation).
 *
 * Settles a pair from REAL venue proceeds WITHOUT placing any orders. Used when
 * legs were closed directly on the venue and the DB never synced (the live
 * Deribit/Bullish test pairs stuck in 'unwinding').
 *
 * Coverage:
 *   - unwinding + per-leg proceeds → settled, salvage=put+call, split matches
 *     computeSplit, leg sell_* written, metadata.reconciled, events present
 *   - unwinding + total salvage only → settled, legs' sell_proceeds stay NULL
 *   - uplift-negative (salvage < cost) → atticus 0, foxify = salvage (loss path)
 *   - active → settled steps through unwinding (stepped_from=active)
 *   - triggered → settled steps through unwinding (stepped_from=triggered)
 *   - already settled → already_terminal
 *   - pending → not_settleable
 *   - negative / NaN proceeds → invalid_proceeds
 *   - tracked runtime is stopped + deregistered before reconcile
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureTwoSidedSchema,
  insertPair,
  insertPairLeg,
  getPairById,
  getLegsForPair,
  getEventsForPair,
  updatePairStatus
} from "../src/singleSide/twoSided/db";
import { reconcileSettlePair } from "../src/singleSide/twoSided/reconcileSettle";
import { computeSplit } from "../src/singleSide/twoSided/settlementEngine";
import { getTierByLabel } from "../src/singleSide/twoSided/tierResolver";
import { __resetRegistryForTests, getRuntimeRegistry } from "../src/singleSide/twoSided/runtimeRegistry";
import type { ExecutionRuntime } from "../src/singleSide/twoSided/executionRuntime";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const NOW = Date.parse("2026-06-02T12:00:00Z");
const EXPIRES_AT = NOW + 1 * 86_400_000;
const FORCE_EXIT = EXPIRES_AT - 4 * 3_600_000;

type Pool = Awaited<ReturnType<typeof buildPool>>;

const seedPair = async (
  pool: Pool,
  opts: {
    pairId?: string;
    ref?: string;
    status?: "active" | "triggered" | "unwinding";
    hedgeCost?: number;
    floor?: number;
    tier?: "tier_1" | "tier_2";
    isShadow?: boolean;
  } = {}
) => {
  const pairId = opts.pairId ?? "pair-recon-1";
  const p = await insertPair(pool, {
    pairId,
    cellId: "pair_25k_5otm_strangle_1d",
    foxifyPairRef: opts.ref ?? `fxy-${pairId}`,
    spotAtActivation: 71_500,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 69_355,
    triggerUpPrice: 73_645,
    hedgeTenorDays: 1,
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    tpForceExitAt: new Date(FORCE_EXIT).toISOString(),
    hedgeCostTotalUsdc: opts.hedgeCost ?? 22.53,
    foxifyCapitalFundedUsdc: opts.hedgeCost ?? 22.53,
    tierAtActivation: opts.tier ?? "tier_2",
    atticusFloorUsdc: opts.floor ?? 30,
    metadata: {},
    status: "pending",
    isShadow: opts.isShadow ?? false
  });
  await insertPairLeg(pool, {
    legId: `${pairId}-put`,
    pairId: p.pairId,
    legRole: "long_put",
    venue: "deribit",
    symbol: "BTC-3JUN26-68000-P",
    strikeUsdc: 68_000,
    contractsBtc: 0.35,
    buyAskUsdcPerBtc: 42.92,
    buyCostUsdc: 15.02,
    buyFilledAt: new Date(NOW - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 42.92,
    liveAnchorPulledAt: new Date(NOW - 3_600_000).toISOString(),
    metadata: {}
  });
  await insertPairLeg(pool, {
    legId: `${pairId}-call`,
    pairId: p.pairId,
    legRole: "long_call",
    venue: "deribit",
    symbol: "BTC-3JUN26-75000-C",
    strikeUsdc: 75_000,
    contractsBtc: 0.35,
    buyAskUsdcPerBtc: 21.46,
    buyCostUsdc: 7.51,
    buyFilledAt: new Date(NOW - 3_600_000).toISOString(),
    liveAnchorAskUsdcPerBtc: 21.46,
    liveAnchorPulledAt: new Date(NOW - 3_600_000).toISOString(),
    metadata: {}
  });
  await updatePairStatus(pool, p.pairId, "active");
  if (opts.status === "triggered" || opts.status === "unwinding") {
    await updatePairStatus(pool, p.pairId, "triggered", { triggeredAt: new Date(NOW).toISOString(), triggerSide: "down" });
  }
  if (opts.status === "unwinding") {
    await updatePairStatus(pool, p.pairId, "unwinding");
  }
  return p;
};

test("reconcile: unwinding + per-leg proceeds → settled with canonical split + leg sell info", async () => {
  const pool = await buildPool();
  const hedgeCost = 22.53;
  await seedPair(pool, { status: "unwinding", hedgeCost, floor: 30, tier: "tier_2" });

  const putProceeds = 60;
  const callProceeds = 40;
  const res = await reconcileSettlePair(pool, {
    pairId: "pair-recon-1",
    putProceedsUsdc: putProceeds,
    callProceedsUsdc: callProceeds,
    note: "closed both legs on Deribit UI",
    nowMs: NOW
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.steppedFrom, "unwinding");
  assert.equal(res.perLegApplied, true);
  assert.equal(res.salvageProceedsUsdc, 100);

  // Split must match the canonical engine exactly.
  const tier = getTierByLabel("tier_2");
  const expected = computeSplit({ salvageProceedsUsdc: 100, hedgeCostUsdc: hedgeCost, tier: { ...tier, atticusFloorUsdc: 30 } });
  assert.equal(res.split.foxifyShareUsdc, expected.foxifyShareUsdc);
  assert.equal(res.split.atticusShareUsdc, expected.atticusShareUsdc);

  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.status, "settled");
  assert.equal(fresh!.salvageProceedsUsdc, 100);
  assert.equal(fresh!.exitMode, "foxify_close");
  assert.equal(fresh!.closedReason, "foxify_close");
  assert.equal(fresh!.foxifyShareUsdc, expected.foxifyShareUsdc);
  assert.equal((fresh!.metadata as { reconciled?: boolean }).reconciled, true);

  // Leg sell columns written.
  const legs = await getLegsForPair(pool, "pair-recon-1");
  const putLeg = legs.find((l) => l.legRole === "long_put")!;
  const callLeg = legs.find((l) => l.legRole === "long_call")!;
  assert.equal(putLeg.sellProceedsUsdc, putProceeds);
  assert.equal(callLeg.sellProceedsUsdc, callProceeds);
  assert.ok(putLeg.sellFilledAt != null);
  assert.ok(callLeg.sellFilledAt != null);

  // Events.
  const events = await getEventsForPair(pool, "pair-recon-1");
  assert.ok(events.some((e) => e.kind === "manual_reconcile"));
  assert.ok(events.some((e) => e.kind === "settled"));
});

test("reconcile: unwinding + total salvage only → settled, legs' sell_proceeds stay NULL", async () => {
  const pool = await buildPool();
  await seedPair(pool, { status: "unwinding", hedgeCost: 22.53 });
  const res = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 18, nowMs: NOW });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.perLegApplied, false);
  assert.equal(res.salvageProceedsUsdc, 18);
  const legs = await getLegsForPair(pool, "pair-recon-1");
  assert.equal(legs.find((l) => l.legRole === "long_put")!.sellProceedsUsdc, null);
  assert.equal(legs.find((l) => l.legRole === "long_call")!.sellProceedsUsdc, null);
  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.salvageProceedsUsdc, 18);
});

test("reconcile: uplift-negative (salvage < cost) → atticus 0, foxify = salvage (loss path)", async () => {
  const pool = await buildPool();
  const hedgeCost = 22.53;
  await seedPair(pool, { status: "unwinding", hedgeCost });
  const res = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 5, nowMs: NOW });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.split.outcomeCategory, "uplift_negative");
  assert.equal(res.split.atticusShareUsdc, 0);
  assert.equal(res.split.foxifyShareUsdc, 5);
  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.atticusShareUsdc, 0);
  assert.equal(fresh!.foxifyShareUsdc, 5);
});

test("reconcile: active → settled steps through unwinding (stepped_from=active)", async () => {
  const pool = await buildPool();
  await seedPair(pool, { status: "active", hedgeCost: 22.53 });
  const res = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 30, nowMs: NOW });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.steppedFrom, "active");
  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.status, "settled");
});

test("reconcile: triggered → settled steps through unwinding (stepped_from=triggered)", async () => {
  const pool = await buildPool();
  await seedPair(pool, { status: "triggered", hedgeCost: 22.53 });
  const res = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 30, nowMs: NOW });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.steppedFrom, "triggered");
  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.status, "settled");
});

test("reconcile: already settled → already_terminal (idempotency guard)", async () => {
  const pool = await buildPool();
  await seedPair(pool, { status: "unwinding", hedgeCost: 22.53 });
  const first = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 18, nowMs: NOW });
  assert.equal(first.ok, true);
  const second = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 18, nowMs: NOW });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error, "already_terminal");
});

test("reconcile: pending pair → not_settleable", async () => {
  const pool = await buildPool();
  const p = await insertPair(pool, {
    pairId: "pair-pending",
    cellId: "pair_25k_5otm_strangle_1d",
    foxifyPairRef: "fxy-pending",
    spotAtActivation: 71_500,
    feedSnapshotAtActivation: {},
    triggerDownPrice: 69_355,
    triggerUpPrice: 73_645,
    hedgeTenorDays: 1,
    expiresAt: new Date(EXPIRES_AT).toISOString(),
    tpForceExitAt: new Date(FORCE_EXIT).toISOString(),
    hedgeCostTotalUsdc: 22.53,
    foxifyCapitalFundedUsdc: 22.53,
    tierAtActivation: "tier_2",
    atticusFloorUsdc: 30,
    metadata: {},
    status: "pending"
  });
  const res = await reconcileSettlePair(pool, { pairId: p.pairId, salvageProceedsUsdc: 10, nowMs: NOW });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error, "not_settleable");
});

test("reconcile: missing pair → pair_not_found", async () => {
  const pool = await buildPool();
  const res = await reconcileSettlePair(pool, { pairId: "nope", salvageProceedsUsdc: 10, nowMs: NOW });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error, "pair_not_found");
});

test("reconcile: invalid proceeds (negative / none) → invalid_proceeds", async () => {
  const pool = await buildPool();
  await seedPair(pool, { status: "unwinding", hedgeCost: 22.53 });
  const neg = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: -5, nowMs: NOW });
  assert.equal(neg.ok, false);
  if (!neg.ok) assert.equal(neg.error, "invalid_proceeds");

  // none supplied
  await seedPair(pool, { pairId: "pair-recon-2", ref: "fxy-2", status: "unwinding", hedgeCost: 22.53 });
  const none = await reconcileSettlePair(pool, { pairId: "pair-recon-2", nowMs: NOW });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.error, "invalid_proceeds");

  // pair-recon-1 must remain unsettled after the rejected call
  const fresh = await getPairById(pool, "pair-recon-1");
  assert.equal(fresh!.status, "unwinding");
});

test("reconcile: stops + deregisters a tracked runtime before settling", async () => {
  __resetRegistryForTests();
  const pool = await buildPool();
  await seedPair(pool, { status: "unwinding", hedgeCost: 22.53 });
  const reg = getRuntimeRegistry();
  let stopped = false;
  // Inject a fake runtime into the registry map via spawn-like access.
  (reg as unknown as { runtimes: Map<string, ExecutionRuntime> }).runtimes.set(
    "pair-recon-1",
    { stop: () => { stopped = true; } } as unknown as ExecutionRuntime
  );
  assert.equal(reg.size(), 1);
  const res = await reconcileSettlePair(pool, { pairId: "pair-recon-1", salvageProceedsUsdc: 18, nowMs: NOW });
  assert.equal(res.ok, true);
  assert.equal(stopped, true, "tracked runtime stopped");
  assert.equal(reg.getRuntime("pair-recon-1"), null, "tracked runtime deregistered");
  __resetRegistryForTests();
});
