import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded,
  insertPosition,
  insertHedgeLeg,
  markHedgeLegRetained,
  listHedgeLegsForPosition,
  type HedgeLegRow
} from "../src/volumeCover/volumeCoverDb";
import { attemptLadderNettingForSpread } from "../src/volumeCover/ladderNetting";
import { findCellById } from "../src/volumeCover/matrix";
import type { SpreadStructure, SpreadLegSpec } from "../src/volumeCover/spreadHedge";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool);
  await seedCapitalPoolsIfNeeded(pool);
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  return pool;
};

const FP = "fp-spread-ladder";
const FP_OTHER = "fp-other-fingerprint";
const CELL_ID = "50k_2pct_1k";
const EXPIRY_FAR = "2026-06-15T08:00:00.000Z"; // ~21d out — well above 1d min tenor

const buildSpreadLegSpec = (overrides: Partial<SpreadLegSpec> & {
  legRole: SpreadLegSpec["legRole"];
}): SpreadLegSpec => ({
  optionKind: overrides.legRole.startsWith("put") ? "put" : "call",
  side: overrides.legRole.endsWith("long") ? "long" : "short",
  strikeIdealUsdc: 75_000,
  strikeActualUsdc: 75_000,
  contractsBtc: 1.0,
  expiryIso: EXPIRY_FAR,
  ...overrides
});

const buildNewSpreadStructure = (
  overrides: { positionId?: string; spreadGroupId?: string } = {}
): SpreadStructure => ({
  positionId: overrides.positionId ?? "vc-pos-NEW",
  cellId: CELL_ID,
  spreadGroupId: overrides.spreadGroupId ?? "vc-spread-NEW",
  design: "DB",
  venue: "bullish",
  fallbackVenue: null,
  legs: [
    buildSpreadLegSpec({ legRole: "put_long", strikeActualUsdc: 75_000, strikeIdealUsdc: 75_000 }),
    buildSpreadLegSpec({ legRole: "put_short", strikeActualUsdc: 74_000, strikeIdealUsdc: 74_000 }),
    buildSpreadLegSpec({ legRole: "call_long", strikeActualUsdc: 76_000, strikeIdealUsdc: 76_000 }),
    buildSpreadLegSpec({ legRole: "call_short", strikeActualUsdc: 77_000, strikeIdealUsdc: 77_000 })
  ],
  expectedNetDebitPerBtcUsdcIdeal: null,
  contractsBtcPerLeg: 1.0,
  spreadWidthUsdc: 1_000,
  triggerLowBtc: 73_500,
  triggerHighBtc: 76_500
});

const seedPriorPositionWithRetainedLongs = async (
  pool: any,
  params: {
    priorPositionId: string;
    fingerprintHash: string | null;
    putLongStrike: number;
    callLongStrike: number;
    putLongBuyPrice: number;
    callLongBuyPrice: number;
    contractsBtc: number;
    spreadGroupId: string;
    legExpiryIso?: string;
  }
): Promise<{ putLongId: string; callLongId: string }> => {
  await insertPosition(pool, {
    id: params.priorPositionId,
    cellId: CELL_ID,
    foxifyPairId: `pair-${params.priorPositionId}`,
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: params.fingerprintHash
  });

  const expiryIso = params.legExpiryIso ?? EXPIRY_FAR;
  const putLongId = `vc-leg-prior-put-${params.priorPositionId}`;
  const callLongId = `vc-leg-prior-call-${params.priorPositionId}`;

  await insertHedgeLeg(pool, {
    id: putLongId,
    positionId: params.priorPositionId,
    venue: "bullish",
    optionKind: "put",
    strikeUsdc: params.putLongStrike,
    expiryIso,
    contracts: params.contractsBtc,
    buyPriceUsdc: params.putLongBuyPrice,
    spreadGroupId: params.spreadGroupId,
    legRole: "put_long",
    initialProceedsUsdc: null
  });
  await insertHedgeLeg(pool, {
    id: callLongId,
    positionId: params.priorPositionId,
    venue: "bullish",
    optionKind: "call",
    strikeUsdc: params.callLongStrike,
    expiryIso,
    contracts: params.contractsBtc,
    buyPriceUsdc: params.callLongBuyPrice,
    spreadGroupId: params.spreadGroupId,
    legRole: "call_long",
    initialProceedsUsdc: null
  });

  // Mark retained (loser_post_trigger / winner_post_trigger arbitrary)
  await markHedgeLegRetained(pool, {
    id: putLongId,
    retainedReason: "trigger",
    retainedRole: "loser_post_trigger"
  });
  await markHedgeLegRetained(pool, {
    id: callLongId,
    retainedReason: "trigger",
    retainedRole: "winner_post_trigger"
  });
  return { putLongId, callLongId };
};

test("Bundle-3-B follow-up: no fingerprint still ladders when retained legs match (single-counterparty)", async () => {
  // Pre-2026-05-25: ladder netting required fingerprintHash, which
  // Foxify wasn't sending in production (verified via 12 historical
  // pair_event audit rows — all null) → 0% laddering ever fired.
  // Post follow-up: single-counterparty assumption locked in. Ladder
  // matches retained legs by cell + strike + expiry + recency,
  // independent of fingerprint state on either side.
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-NF",
    fingerprintHash: null, // prior has NO fingerprint either
    putLongStrike: 75_000,
    callLongStrike: 76_000,
    putLongBuyPrice: 590,
    callLongBuyPrice: 570,
    contractsBtc: 1.0,
    spreadGroupId: "vc-spread-PRIOR-NF"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-NF",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-NF",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: null
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-NF",
    spreadGroupId: "vc-spread-NEW-NF"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-NF",
    newSpreadGroupId: "vc-spread-NEW-NF",
    cell,
    fingerprintHash: null,
    structure
  });
  assert.equal(r.repurposedLegs.length, 2, "both longs ladder despite null fingerprint");
  assert.equal(r.legsToPlace.length, 2, "only shorts to place");
  assert.equal(r.estimatedSavingsUsdc, 590 * 1.0 + 570 * 1.0);
});

test("PR-Bundle-3-B: VOLUME_COVER_LADDER_NETTING_ENABLED=false bypasses entirely", async () => {
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  const structure = buildNewSpreadStructure();
  process.env.VOLUME_COVER_LADDER_NETTING_ENABLED = "false";
  try {
    const r = await attemptLadderNettingForSpread({
      pool,
      newPositionId: structure.positionId,
      newSpreadGroupId: structure.spreadGroupId,
      cell,
      fingerprintHash: FP,
      structure
    });
    assert.equal(r.repurposedLegs.length, 0);
    assert.equal(r.legsToPlace.length, 4);
    assert.equal(r.perLeg[0].reason, "feature_disabled");
  } finally {
    delete process.env.VOLUME_COVER_LADDER_NETTING_ENABLED;
  }
});

test("PR-Bundle-3-B: matching put_long + call_long retained → both ladder; 2 legs to place (shorts)", async () => {
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-A",
    fingerprintHash: FP,
    putLongStrike: 75_000,
    callLongStrike: 76_000,
    putLongBuyPrice: 590,
    callLongBuyPrice: 570,
    contractsBtc: 1.0,
    spreadGroupId: "vc-spread-PRIOR-A"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-A",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-A",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-A",
    spreadGroupId: "vc-spread-NEW-A"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-A",
    newSpreadGroupId: "vc-spread-NEW-A",
    cell,
    fingerprintHash: FP,
    structure
  });
  assert.equal(r.repurposedLegs.length, 2, "both longs ladder");
  assert.equal(r.legsToPlace.length, 2, "only shorts to place");
  const placedRoles = r.legsToPlace.map((l) => l.legRole).sort();
  assert.deepEqual(placedRoles, ["call_short", "put_short"]);
  assert.ok(r.ladderEventId, "audit event id set");
  // Estimated savings = sum of buy_price × contracts of repurposed legs
  assert.equal(r.estimatedSavingsUsdc, 590 * 1.0 + 570 * 1.0);

  // Verify the repurposed legs got the new spread group id + leg role
  const legs = await listHedgeLegsForPosition(pool, "vc-pos-NEW-A");
  assert.equal(legs.length, 2, "both legs re-pointed at new position");
  for (const leg of legs) {
    assert.equal(leg.spreadGroupId, "vc-spread-NEW-A", "spread group rewritten");
    assert.equal(leg.retained, false, "retention cleared after repurpose");
    assert.equal(leg.ladderHopCount, 1, "hop count incremented");
  }
});

test("PR-Bundle-3-B: only loser retained (winner_only mode) → half-ladder, 3 legs to place", async () => {
  // Simulates the post-Bundle-3-B trigger path: winner sold at trigger,
  // ONLY loser retained. Fresh position should ladder the loser long
  // and place fresh winner_long + both shorts.
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  // Manually seed only a put_long retained (HIGH trigger leaves put as loser)
  await insertPosition(pool, {
    id: "vc-pos-PRIOR-B",
    cellId: CELL_ID,
    foxifyPairId: "pair-PRIOR-B",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  await insertHedgeLeg(pool, {
    id: "vc-leg-loser-put-B",
    positionId: "vc-pos-PRIOR-B",
    venue: "bullish",
    optionKind: "put",
    strikeUsdc: 75_000,
    expiryIso: EXPIRY_FAR,
    contracts: 1.0,
    buyPriceUsdc: 590,
    spreadGroupId: "vc-spread-PRIOR-B",
    legRole: "put_long",
    initialProceedsUsdc: null
  });
  await markHedgeLegRetained(pool, {
    id: "vc-leg-loser-put-B",
    retainedReason: "trigger",
    retainedRole: "loser_post_trigger"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-B",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-B",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-B",
    spreadGroupId: "vc-spread-NEW-B"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-B",
    newSpreadGroupId: "vc-spread-NEW-B",
    cell,
    fingerprintHash: FP,
    structure
  });
  assert.equal(r.repurposedLegs.length, 1, "only put_long laddered");
  assert.equal(r.legsToPlace.length, 3, "3 legs to place fresh");
  const placedRoles = r.legsToPlace.map((l) => l.legRole).sort();
  assert.deepEqual(placedRoles, ["call_long", "call_short", "put_short"]);
  assert.equal(r.estimatedSavingsUsdc, 590);
});

test("Bundle-3-B follow-up: cross-fingerprint match allowed (single-counterparty)", async () => {
  // Pre-2026-05-25 this test asserted "different fingerprint → no
  // match." The fingerprint requirement was removed; now legs match
  // by cell + strike + expiry + recency regardless of fingerprint
  // state. Pilot has a single counterparty (Foxify) so cross-tenant
  // mismatch isn't a concern.
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-C",
    fingerprintHash: FP_OTHER,
    putLongStrike: 75_000,
    callLongStrike: 76_000,
    putLongBuyPrice: 590,
    callLongBuyPrice: 570,
    contractsBtc: 1.0,
    spreadGroupId: "vc-spread-PRIOR-C"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-C",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-C",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP // different from FP_OTHER on prior
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-C",
    spreadGroupId: "vc-spread-NEW-C"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-C",
    newSpreadGroupId: "vc-spread-NEW-C",
    cell,
    fingerprintHash: FP,
    structure
  });
  assert.equal(
    r.repurposedLegs.length,
    2,
    "ladder fires across fingerprints under single-counterparty assumption"
  );
  assert.equal(r.legsToPlace.length, 2);
  assert.equal(r.estimatedSavingsUsdc, 590 + 570);
});

test("PR-Bundle-3-B: strike too far (>1.5%) → no match", async () => {
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-D",
    fingerprintHash: FP,
    putLongStrike: 70_000, // ~7% below new structure's 75k
    callLongStrike: 81_000, // ~7% above new 76k
    putLongBuyPrice: 100,
    callLongBuyPrice: 100,
    contractsBtc: 1.0,
    spreadGroupId: "vc-spread-PRIOR-D"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-D",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-D",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-D",
    spreadGroupId: "vc-spread-NEW-D"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-D",
    newSpreadGroupId: "vc-spread-NEW-D",
    cell,
    fingerprintHash: FP,
    structure
  });
  assert.equal(r.repurposedLegs.length, 0, "strike too far → no match");
  assert.equal(r.legsToPlace.length, 4);
});

test("PR-Bundle-3-B: short legs are never eligible (perLeg flag)", async () => {
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-E",
    fingerprintHash: FP,
    putLongStrike: 75_000,
    callLongStrike: 76_000,
    putLongBuyPrice: 590,
    callLongBuyPrice: 570,
    contractsBtc: 1.0,
    spreadGroupId: "vc-spread-PRIOR-E"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-E",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-E",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-E",
    spreadGroupId: "vc-spread-NEW-E"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-E",
    newSpreadGroupId: "vc-spread-NEW-E",
    cell,
    fingerprintHash: FP,
    structure
  });
  // perLeg should have entries marking shorts as not eligible
  const shortRows = r.perLeg.filter(
    (p) => p.legRole === "put_short" || p.legRole === "call_short"
  );
  assert.equal(shortRows.length, 2);
  for (const s of shortRows) {
    assert.equal(s.matched, false);
    assert.equal(s.reason, "short_leg_not_eligible");
  }
});

test("PR-Bundle-3-B: contracts size mismatch (retained < new) → no match", async () => {
  const pool = await buildPool();
  const cell = findCellById(CELL_ID)!;
  await seedPriorPositionWithRetainedLongs(pool, {
    priorPositionId: "vc-pos-PRIOR-F",
    fingerprintHash: FP,
    putLongStrike: 75_000,
    callLongStrike: 76_000,
    putLongBuyPrice: 590,
    callLongBuyPrice: 570,
    contractsBtc: 0.5, // smaller than new structure's 1.0
    spreadGroupId: "vc-spread-PRIOR-F"
  });
  await insertPosition(pool, {
    id: "vc-pos-NEW-F",
    cellId: CELL_ID,
    foxifyPairId: "pair-NEW-F",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 75_500,
    triggerHighBtc: 77_010,
    triggerLowBtc: 73_990,
    dailyPremiumUsdc: 350,
    payoutUsdc: 1_000,
    fingerprintHash: FP
  });
  const structure = buildNewSpreadStructure({
    positionId: "vc-pos-NEW-F",
    spreadGroupId: "vc-spread-NEW-F"
  });
  const r = await attemptLadderNettingForSpread({
    pool,
    newPositionId: "vc-pos-NEW-F",
    newSpreadGroupId: "vc-spread-NEW-F",
    cell,
    fingerprintHash: FP,
    structure
  });
  assert.equal(r.repurposedLegs.length, 0, "contracts too small → no match");
  assert.equal(r.legsToPlace.length, 4);
});
