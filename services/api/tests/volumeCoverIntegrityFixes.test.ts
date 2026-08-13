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
  finalizeSalvageProceedsForPosition,
  computeRollingSalvageStats,
  listHedgeLegsForPosition
} from "../src/volumeCover/volumeCoverDb";
import {
  openPosition,
  fireTrigger
} from "../src/volumeCover/positionLifecycle";
import {
  executeHedgeStructure,
  buildHedgeStructure
} from "../src/volumeCover/tightHedge";
import { findCellById } from "../src/volumeCover/matrix";
import { recordTriggerEvent } from "../src/volumeCover/salvageTracker";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";

// Batch 2 integrity / alerting regression tests. Keeps the focus tight:
// one test per real-money invariant that production cannot regress.

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

const buildFillingExecutor = (): HedgeExecutor => ({
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-BUY-${Math.random().toString(36).slice(2, 9)}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: params.optionKind === "put" ? 800 : 5,
    totalProceedsUsdc: (params.optionKind === "put" ? 800 : 5) * params.contractsBtc,
    orderId: `MOCK-SELL-${Math.random().toString(36).slice(2, 9)}`
  })
});

test("tightHedge rollback failure throws err.orphans so caller can route an alert", async () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "test-pos",
    cell,
    entryBtcPrice: 80_000
  });

  let buyCount = 0;
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      buyCount++;
      if (buyCount === 1) {
        return {
          venue: params.venue,
          fillPriceUsdcPerBtc: 90,
          totalCostUsdc: 90 * params.contractsBtc,
          orderId: "BUY-LEG-1"
        };
      }
      throw new Error("forced_leg2_failure");
    },
    sellOptionLeg: async () => {
      throw new Error("forced_rollback_sell_failure");
    }
  };

  let caught: any = null;
  try {
    await executeHedgeStructure({ structure, cell, executor });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "executeHedgeStructure must throw when leg-2 fails on all venues");
  assert.ok(
    Array.isArray(caught.orphans) && caught.orphans.length >= 1,
    "thrown error must carry an .orphans array describing orphan venue legs"
  );
  assert.equal(caught.orphans[0].orderId, "BUY-LEG-1");
  assert.match(String(caught.message), /orphans=/);
});

test("openPosition: insertHedgeLeg failure triggers compensating sell + position closed", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;

  // Break the SECOND insertHedgeLeg by killing the legs table mid-flight.
  // pg-mem will error on the second insert because it cannot find the
  // table; first insert may also fail — we just need an insert failure
  // after a successful buy.
  const realQuery = pool.query.bind(pool);
  let insertAttempts = 0;
  (pool as any).query = (sql: any, params?: any) => {
    if (
      typeof sql === "string" &&
      sql.includes("INSERT INTO volume_cover_hedge_leg")
    ) {
      insertAttempts++;
      throw new Error("simulated_db_outage_on_insert");
    }
    return realQuery(sql, params);
  };

  let compensatingSells = 0;
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => ({
      venue: params.venue,
      fillPriceUsdcPerBtc: 90,
      totalCostUsdc: 90 * params.contractsBtc,
      orderId: `BUY-${params.optionKind}`
    }),
    sellOptionLeg: async (params) => {
      compensatingSells++;
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 80,
        totalProceedsUsdc: 80 * params.contractsBtc,
        orderId: `SELL-${params.optionKind}`
      };
    }
  };

  let caught: any = null;
  try {
    await openPosition(pool, executor, {
      cell,
      foxifyPairId: "FX-ATOMICITY-1",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "openPosition must throw when insertHedgeLeg fails");
  assert.match(String(caught.message), /volume_cover_hedge_persist_failed/);
  assert.ok(insertAttempts >= 1, "the broken insert must have been attempted");
  assert.equal(
    compensatingSells,
    2,
    "compensating sell must be called for every successfully-bought venue leg"
  );

  // Restore so other tests can use the pool.
  (pool as any).query = realQuery;
});

test("finalizeSalvageProceedsForPosition: increments proceeds and recomputes salvage_pct + net_loss", async () => {
  const pool = await buildPool();

  // Open a position so the FK passes
  const cell = findCellById("50k_2pct_1k")!;
  const result = await openPosition(pool, buildFillingExecutor(), {
    cell,
    foxifyPairId: "FX-SALVAGE-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  const positionId = result.position.id;

  await recordTriggerEvent(pool, {
    positionId,
    triggeredDirection: "low",
    payoutOwedUsdc: 1000,
    hedgeSaleProceedsUsdc: 0,
    metadata: { test: true }
  });

  const first = await finalizeSalvageProceedsForPosition(pool, {
    positionId,
    proceedsUsdcDelta: 600,
    legId: "leg-1"
  });
  assert.ok(first, "first finalize must return the updated row");
  assert.equal(first!.hedgeSaleProceedsUsdc, 600);
  assert.equal(first!.salvagePct, 0.6);
  assert.equal(first!.netAtticusLossUsdc, 400);

  const second = await finalizeSalvageProceedsForPosition(pool, {
    positionId,
    proceedsUsdcDelta: 200,
    legId: "leg-2"
  });
  assert.equal(second!.hedgeSaleProceedsUsdc, 800);
  assert.equal(second!.salvagePct, 0.8);
  assert.equal(second!.netAtticusLossUsdc, 200);

  // Guard B rolling stats should now reflect the finalized proceeds.
  const stats = await computeRollingSalvageStats(pool, 5);
  assert.equal(stats.count, 1);
  assert.equal(Number(stats.avgSalvagePct), 0.8);

  // No-op behavior on zero/negative
  const noop = await finalizeSalvageProceedsForPosition(pool, {
    positionId,
    proceedsUsdcDelta: 0
  });
  assert.equal(noop, null);

  // Idempotency caveat: the helper is increment-based, so a second
  // call with the same legId would double-count. Tested separately
  // in the hedge-manager wrapper (caller is expected to call once
  // per sold leg, immediately after the ledger entry).
});

test("volume_cover_hedge_leg_status_check: 'sold' and 'failed' are valid; 'closed' and 'cancelled' are NOT", async () => {
  // Locks the schema contract that force-sell-leg + cleanup-bullish-phantom-legs
  // both depend on. Regression guard for the production 500 where the route
  // wrote 'closed' but the CHECK only allows open|sold|expired|failed.
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const result = await openPosition(pool, buildFillingExecutor(), {
    cell,
    foxifyPairId: "FX-CHECK-CONSTRAINT-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  const legs = await listHedgeLegsForPosition(pool, result.position.id);
  assert.ok(legs.length >= 1);
  const legId = legs[0].id;

  // 'sold' and 'failed' must succeed
  await pool.query(`UPDATE volume_cover_hedge_leg SET status='sold' WHERE id=$1`, [legId]);
  await pool.query(`UPDATE volume_cover_hedge_leg SET status='failed' WHERE id=$1`, [legId]);

  // 'closed' and 'cancelled' must throw on the CHECK
  await assert.rejects(
    () => pool.query(`UPDATE volume_cover_hedge_leg SET status='closed' WHERE id=$1`, [legId]),
    /check|constraint/i
  );
  await assert.rejects(
    () => pool.query(`UPDATE volume_cover_hedge_leg SET status='cancelled' WHERE id=$1`, [legId]),
    /check|constraint/i
  );
});

test("finalizeSalvageProceedsForPosition: returns null when no salvage_event exists (pre-trigger close)", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const result = await openPosition(pool, buildFillingExecutor(), {
    cell,
    foxifyPairId: "FX-SALVAGE-NULL",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  const r = await finalizeSalvageProceedsForPosition(pool, {
    positionId: result.position.id,
    proceedsUsdcDelta: 100
  });
  assert.equal(r, null, "must return null when position has no salvage_event yet");
});
