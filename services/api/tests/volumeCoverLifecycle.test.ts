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
  getPosition,
  listHedgeLegsForPosition,
  computeRollingSalvageStats
} from "../src/volumeCover/volumeCoverDb";
import {
  openPosition,
  fireTrigger,
  closePosition
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

const buildMockExecutor = (overrides: Partial<HedgeExecutor> = {}): HedgeExecutor => ({
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-BUY-${Math.random()}`
  }),
  sellOptionLeg: async (params) => {
    // Sell the winning leg at full intrinsic (~$800/BTC for ±2% TIGHT),
    // and the losing leg at near-zero. For the strangle we have a put
    // and a call; on a "low" trigger, the put is the winner.
    const isPut = params.optionKind === "put";
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: isPut ? 800 : 5, // mocked: put salvages near full
      totalProceedsUsdc: (isPut ? 800 : 5) * params.contractsBtc,
      orderId: `MOCK-SELL-${Math.random()}`
    };
  },
  ...overrides
});

test("openPosition: happy path persists position + hedge legs + ledger entries", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const result = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-INTEG-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  assert.equal(result.position.status, "active");
  assert.equal(result.position.triggerHighBtc, 81_600);
  assert.equal(result.position.triggerLowBtc, 78_400);
  assert.equal(result.hedgeLegs.length, 2);
  assert.ok(result.totalHedgeCostUsdc > 0);

  // Ledger entries posted (premium_in to foxify, hedge_buy_out from atticus)
  const ledger = await pool.query(
    `SELECT entry_type, pool_id, amount_usdc FROM pilot_pool_ledger WHERE protection_id = $1 ORDER BY id`,
    [result.position.id]
  );
  const types = ledger.rows.map((r: any) => r.entry_type);
  assert.ok(types.includes("premium_in"));
  assert.ok(types.includes("hedge_buy_out"));
});

test("openPosition: hedge failure cancels position and throws", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const failingExecutor = buildMockExecutor({
    buyOptionLeg: async () => {
      throw new Error("primary_dead");
    }
  });
  await assert.rejects(
    openPosition(pool, failingExecutor, {
      cell,
      foxifyPairId: "FX-FAIL-1",
      pairLongNotionalUsdc: 50_000,
      pairShortNotionalUsdc: 50_000,
      pairEntryBtcPrice: 80_000
    }),
    /hedge_execution_failed/i
  );

  // Position should exist and be marked closed (cancellation path)
  const r = await pool.query(
    `SELECT id, status FROM volume_cover_position WHERE foxify_pair_id = $1`,
    ["FX-FAIL-1"]
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].status, "closed");
});

test("fireTrigger: sells legs, records salvage, ledger entries, marks triggered", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-TRIG-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  const result = await fireTrigger(pool, buildMockExecutor(), {
    position: opened.position,
    direction: "low"
  });

  // Salvage event recorded
  const stats = await computeRollingSalvageStats(pool, 5);
  assert.equal(stats.count, 1);
  assert.ok(stats.avgSalvagePct! > 0);

  // Position transitioned
  const fresh = await getPosition(pool, opened.position.id);
  assert.equal(fresh?.status, "triggered");
  assert.equal(fresh?.triggeredDirection, "low");

  // All hedge legs sold
  const legs = await listHedgeLegsForPosition(pool, opened.position.id);
  for (const l of legs) {
    assert.equal(l.status, "sold");
  }

  // payout_out + hedge_sell_in ledger entries
  const ledger = await pool.query(
    `SELECT entry_type FROM pilot_pool_ledger WHERE protection_id = $1`,
    [opened.position.id]
  );
  const types = ledger.rows.map((r: any) => r.entry_type);
  assert.ok(types.includes("payout_out"));
  assert.ok(types.includes("hedge_sell_in"));

  // salvage proceeds positive
  assert.ok(result.totalProceedsUsdc > 0);
});

test("closePosition: sells open legs at market and marks closed", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-CLOSE-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  const result = await closePosition(pool, buildMockExecutor(), {
    position: opened.position,
    reason: "foxify_early_close"
  });
  assert.equal(result.legsSold, 2);

  const fresh = await getPosition(pool, opened.position.id);
  assert.equal(fresh?.status, "closed");
  assert.match(fresh?.closeReason ?? "", /foxify_early_close/);
});
