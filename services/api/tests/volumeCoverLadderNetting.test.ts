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
  listHedgeLegsForPosition
} from "../src/volumeCover/volumeCoverDb";
import {
  openPosition,
  closePosition,
  fireTrigger
} from "../src/volumeCover/positionLifecycle";
import { findCellById } from "../src/volumeCover/matrix";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";

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

const buildSpyExecutor = () => {
  let buyCalls = 0;
  let sellCalls = 0;
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      buyCalls++;
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 90,
        totalCostUsdc: 90 * params.contractsBtc,
        orderId: `BUY-${buyCalls}`
      };
    },
    sellOptionLeg: async (params) => {
      sellCalls++;
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 50,
        totalProceedsUsdc: 50 * params.contractsBtc,
        orderId: `SELL-${sellCalls}`
      };
    }
  };
  return {
    executor,
    getBuyCount: () => buyCalls,
    getSellCount: () => sellCalls
  };
};

test("P1e: same-fingerprint same-cell reopen within 30min repurposes both legs", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const fp = "fingerprint-A";
  const { executor, getBuyCount } = buildSpyExecutor();

  // First cover
  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-LADDER-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  const firstBuyCount = getBuyCount();
  assert.equal(firstBuyCount, 2, "first cover buys both legs");
  assert.equal(first.laddered, false);

  // Foxify closes
  await closePosition(pool, executor, {
    position: first.position,
    reason: "foxify_close",
    currentSpotBtc: 80_000
  });

  // Second cover same fingerprint same cell, same entry price
  const second = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-LADDER-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });

  assert.equal(second.laddered, true);
  assert.equal(second.ladderedLegIds.length, 2);
  assert.equal(getBuyCount(), firstBuyCount, "second cover should NOT have bought any legs");
  assert.ok(second.ladderEstimatedSavingsUsdc > 0);
  assert.ok(second.ladderEventId !== null);

  // Both legs now point to second position
  const legs = await listHedgeLegsForPosition(pool, second.position.id);
  assert.equal(legs.length, 2);
  for (const l of legs) {
    assert.equal(l.repurposedFromPositionId, first.position.id);
    assert.equal(l.ladderHopCount, 1);
    assert.equal(l.retained, false);
    assert.equal(l.status, "open");
  }
});

test("P1e: different fingerprint does NOT repurpose", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-A",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: "fp-A"
  });
  await closePosition(pool, executor, {
    position: first.position,
    reason: "test",
    currentSpotBtc: 80_000
  });
  const before = getBuyCount();

  const second = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-B",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: "fp-B"
  });
  assert.equal(second.laddered, false);
  assert.equal(getBuyCount() - before, 2, "second cover bought 2 fresh legs");
});

test("P1e: different cell does NOT repurpose", async () => {
  const pool = await buildPool();
  const cellA = findCellById("50k_2pct_1k")!;
  const cellB = findCellById("50k_5pct_2_5k")!;
  const fp = "fp-cross-cell";
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell: cellA,
    foxifyPairId: "FX-CC-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  await closePosition(pool, executor, {
    position: first.position,
    reason: "test",
    currentSpotBtc: 80_000
  });
  const before = getBuyCount();

  const second = await openPosition(pool, executor, {
    cell: cellB,
    foxifyPairId: "FX-CC-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  assert.equal(second.laddered, false);
  assert.equal(getBuyCount() - before, 2);
});

test("P1e: spot moved >1.5% away — strike mismatch, no repurpose", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const fp = "fp-strike-mismatch";
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-SM-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  await closePosition(pool, executor, {
    position: first.position,
    reason: "test",
    currentSpotBtc: 80_000
  });
  const before = getBuyCount();

  // Reopen at $82k spot (2.5% higher) — new ideal strikes 81180 / 82820
  // are >1.5% off original 79200/80800
  const second = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-SM-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 82_000,
    fingerprintHash: fp
  });
  assert.equal(second.laddered, false);
  assert.equal(getBuyCount() - before, 2);
});

test("P1e: max one ladder hop per leg lineage", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const fp = "fp-multi-hop";
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-H-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  await closePosition(pool, executor, {
    position: first.position,
    reason: "test",
    currentSpotBtc: 80_000
  });

  // Hop 1
  const second = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-H-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  assert.equal(second.laddered, true);
  await closePosition(pool, executor, {
    position: second.position,
    reason: "test",
    currentSpotBtc: 80_000
  });
  const beforeHop2 = getBuyCount();

  // Attempted hop 2 — should fall back to fresh buy
  const third = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-H-3",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  assert.equal(third.laddered, false, "hop cap should prevent second repurpose");
  assert.equal(getBuyCount() - beforeHop2, 2, "third cover buys fresh");
});

test("P1e: trigger then reopen also repurposes (winner+loser legs)", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const fp = "fp-trigger-reopen";
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-TR-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  // Fire trigger (low) — both legs go to retained
  await fireTrigger(pool, executor, {
    position: first.position,
    direction: "low"
  });
  const before = getBuyCount();

  // Foxify reopens at slightly different spot but within tolerance
  // (entry $79.5k = 0.625% from prior — strikes ideal 78705/80295,
  // within 1.5% of prior 79200/80800)
  const second = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-TR-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 79_500,
    fingerprintHash: fp
  });
  assert.equal(second.laddered, true);
  assert.equal(getBuyCount() - before, 0, "no fresh buys on reopen after trigger");
  assert.equal(second.ladderedLegIds.length, 2);
});

test("P1e: env disable flag prevents netting", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const fp = "fp-disabled";
  const { executor, getBuyCount } = buildSpyExecutor();

  const first = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-OFF-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000,
    fingerprintHash: fp
  });
  await closePosition(pool, executor, {
    position: first.position,
    reason: "test",
    currentSpotBtc: 80_000
  });

  const original = process.env.VOLUME_COVER_LADDER_NETTING_ENABLED;
  process.env.VOLUME_COVER_LADDER_NETTING_ENABLED = "false";
  try {
    const before = getBuyCount();
    const second = await openPosition(pool, executor, {
      cell,
      foxifyPairId: "FX-OFF-2",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000,
      fingerprintHash: fp
    });
    assert.equal(second.laddered, false);
    assert.equal(getBuyCount() - before, 2);
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_LADDER_NETTING_ENABLED;
    else process.env.VOLUME_COVER_LADDER_NETTING_ENABLED = original;
  }
});
