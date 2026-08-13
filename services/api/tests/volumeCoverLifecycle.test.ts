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

  // P1d: hedge_buy_out at open. Premium NOT ledgered at open
  // (proportional accrual; entry written at close/trigger only).
  const ledger = await pool.query(
    `SELECT entry_type, pool_id, amount_usdc FROM pilot_pool_ledger WHERE protection_id = $1 ORDER BY id`,
    [result.position.id]
  );
  const types = ledger.rows.map((r: any) => r.entry_type);
  assert.ok(types.includes("hedge_buy_out"), "hedge_buy_out at open");
  assert.ok(!types.includes("premium_in"), "premium_in NOT at open (accrual at close/trigger)");
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

test("fireTrigger: P1b — retains both legs (winner+loser tags), no sell calls, payout ledgered", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-TRIG-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  // Spy executor: should NOT have sellOptionLeg called.
  let sellCalls = 0;
  const spyExecutor = buildMockExecutor({
    sellOptionLeg: async (params) => {
      sellCalls++;
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 0,
        totalProceedsUsdc: 0,
        orderId: "SHOULD-NOT-BE-CALLED"
      };
    }
  });

  const result = await fireTrigger(pool, spyExecutor, {
    position: opened.position,
    direction: "low"
  });

  // P1b: NO sell calls during fireTrigger; hedge manager owns disposition
  assert.equal(sellCalls, 0, "fireTrigger must not call sellOptionLeg");

  // Salvage event recorded with hedge_retained metadata
  const stats = await computeRollingSalvageStats(pool, 5);
  assert.equal(stats.count, 1);

  // Position transitioned
  const fresh = await getPosition(pool, opened.position.id);
  assert.equal(fresh?.status, "triggered");
  assert.equal(fresh?.triggeredDirection, "low");

  // Hedge legs RETAINED (status='open', retained=true) with role tags
  const legs = await listHedgeLegsForPosition(pool, opened.position.id);
  assert.equal(legs.length, 2);
  for (const l of legs) {
    assert.equal(l.status, "open", `leg ${l.id} should still be open`);
    assert.equal(l.retained, true, `leg ${l.id} should be retained`);
    assert.equal(l.retainedReason, "trigger");
  }
  // direction='low' → put is winner, call is loser
  const put = legs.find((l) => l.optionKind === "put")!;
  const call = legs.find((l) => l.optionKind === "call")!;
  assert.equal(put.retainedRole, "winner_post_trigger");
  assert.equal(call.retainedRole, "loser_post_trigger");

  // payout_out present; NO hedge_sell_in yet (manager owns disposition).
  // Retention audit lives on hedge_leg.retained + salvage_event metadata,
  // not in pilot_pool_ledger (which is reserved for financial entries).
  const ledger = await pool.query(
    `SELECT entry_type FROM pilot_pool_ledger WHERE protection_id = $1`,
    [opened.position.id]
  );
  const types = ledger.rows.map((r: any) => r.entry_type);
  assert.ok(types.includes("payout_out"), "payout_out must be ledgered");
  assert.ok(!types.includes("hedge_sell_in"), "hedge_sell_in must NOT be present until manager sells");

  // Salvage event must record hedge_retained=true and pending finalization
  const sv = await pool.query(
    `SELECT metadata FROM volume_cover_salvage_event WHERE position_id = $1`,
    [opened.position.id]
  );
  assert.equal(sv.rows.length, 1);
  const svMeta = typeof sv.rows[0].metadata === "string" ? JSON.parse(sv.rows[0].metadata) : sv.rows[0].metadata;
  assert.equal(svMeta.hedge_retained, true);
  assert.equal(svMeta.finalized, false);

  assert.equal(result.payoutOwedUsdc, opened.position.payoutUsdc);
  assert.equal(result.hedgeRetainedLegIds.length, 2);
});

test("closePosition: P1b — retains legs (no sell), tags near_atm vs stale by spot", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-CLOSE-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  let sellCalls = 0;
  const spyExecutor = buildMockExecutor({
    sellOptionLeg: async (params) => {
      sellCalls++;
      return { venue: params.venue, fillPriceUsdcPerBtc: 0, totalProceedsUsdc: 0, orderId: "X" };
    }
  });

  // Spot is far above put strike $79,200 and far above call strike $80,800
  // → put leg is "stale" (spot moved away from strike), call is near-ATM
  const result = await closePosition(pool, spyExecutor, {
    position: opened.position,
    reason: "foxify_early_close",
    currentSpotBtc: 81_000
  });
  assert.equal(sellCalls, 0, "closePosition must not call sellOptionLeg");
  assert.equal(result.hedgeRetainedLegIds.length, 2);

  const fresh = await getPosition(pool, opened.position.id);
  assert.equal(fresh?.status, "closed");
  assert.match(fresh?.closeReason ?? "", /foxify_early_close/);

  const legs = await listHedgeLegsForPosition(pool, opened.position.id);
  for (const l of legs) {
    assert.equal(l.status, "open");
    assert.equal(l.retained, true);
    assert.equal(l.retainedReason, "foxify_close");
  }
  const put = legs.find((l) => l.optionKind === "put")!;
  const call = legs.find((l) => l.optionKind === "call")!;
  // spot 81_000 vs put strike 79_200: 81000 - 79200 = 1800 → 2.2% above → STALE put
  assert.equal(put.retainedRole, "stale_post_close");
  // spot 81_000 vs call strike 80_800: 200 above → 0.25% → near-ATM
  assert.equal(call.retainedRole, "near_atm_post_close");

  // No hedge_sell_in yet (manager owns disposition); retention audit
  // is on the leg row, not the financial ledger.
  const ledger = await pool.query(
    `SELECT entry_type FROM pilot_pool_ledger WHERE protection_id = $1`,
    [opened.position.id]
  );
  const types = ledger.rows.map((r: any) => r.entry_type);
  assert.ok(!types.includes("hedge_sell_in"));
});
