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
  fireTrigger,
  closePosition
} from "../src/volumeCover/positionLifecycle";
import {
  runOneHedgeManagerTick,
  __resetHedgeManagerForTests,
  type SpotIvSource
} from "../src/volumeCover/volumeCoverHedgeManager";
import { findCellById } from "../src/volumeCover/matrix";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";

// Force full curve (default; explicit for clarity). Disable thin-window
// since the test environment may run during 04:00-06:00 UTC.
process.env.VC_HM_USE_STUB = "false";
process.env.VC_TP_THIN_WINDOW_UTC_START = "0";
process.env.VC_TP_THIN_WINDOW_UTC_END = "0";

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
  const sellCalls: any[] = [];
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => ({
      venue: params.venue,
      fillPriceUsdcPerBtc: 100,
      totalCostUsdc: 100 * params.contractsBtc,
      orderId: "BUY"
    }),
    sellOptionLeg: async (params) => {
      sellCalls.push(params);
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 50,
        totalProceedsUsdc: 50 * params.contractsBtc,
        orderId: `SELL-${sellCalls.length}`
      };
    }
  };
  return { executor, sellCalls };
};

const spotIv = (spot: number, iv = 0.65): SpotIvSource =>
  async () => ({ spotBtcUsdc: spot, ivAnnualized: iv, asOfMs: Date.now() });

test("Full curve: rule 1 (time decay) overrides everything", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET expiry_iso = NOW() + interval '1 hour' WHERE position_id = $1`,
    [opened.position.id]
  );
  const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(80_000) });
  assert.equal(result.legsActioned, 2);
  assert.ok(result.actions.every((a) => a.rule === "1_time_decay_exit"));
  assert.equal(sellCalls.length, 2);
});

test("Full curve: rule 4 (active follow-through) holds winner ≤30min post-trigger", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  // retained_at is now (within last second), so within 30min window
  const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(78_000) });
  // Winner (put) should be HELD by rule 4
  const winnerAction = result.actions.find(
    (a) => a.rule === "4_active_followthrough"
  );
  assert.ok(winnerAction, `expected rule 4 hold for winner, got ${JSON.stringify(result.actions)}`);
  // Loser (call) — 7_loser_floor or 7_loser_grace? Within retention <4h grace,
  // value not <20% of cost (BS still substantial). Should be no_match → held.
  // No fresh sells:
  assert.equal(sellCalls.length, 0);
});

test("Full curve: rule 5 (trailing-max retracement) sells winner on 20% retrace", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-5",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  // Backdate retained_at past follow-through window (40 min ago)
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = NOW() - interval '40 minutes' WHERE position_id = $1`,
    [opened.position.id]
  );
  // Set running_max manually (very high) and current value will be far below
  // forcing rule 5 to fire. Winner is the put (low trigger).
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET running_max_value_usdc = 10000
     WHERE position_id = $1 AND retained_role = 'winner_post_trigger'`,
    [opened.position.id]
  );
  const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(80_000) });
  const winnerSold = result.actions.find(
    (a) => a.rule === "5_trail_retrace" && a.action === "sold"
  );
  assert.ok(winnerSold, `expected rule 5 to sell winner, got ${JSON.stringify(result.actions)}`);
});

test("Full curve: rule 8 (loser reversal) upgrades to near_atm without selling", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-8",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  // Backdate retained_at to clear rule 4 window
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = NOW() - interval '45 minutes' WHERE position_id = $1`,
    [opened.position.id]
  );
  // direction='low' → put winner, call loser. Set spot back near entry
  // so call (loser) value is high (>0.5× initial)
  const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(80_000) });
  const reversal = result.actions.find((a) => a.rule === "8_loser_reversal_upgrade");
  assert.ok(reversal, `expected rule 8 reversal, got ${JSON.stringify(result.actions)}`);
  // Verify role updated in DB
  const legs = await listHedgeLegsForPosition(pool, opened.position.id);
  const callLeg = legs.find((l) => l.optionKind === "call")!;
  assert.equal(callLeg.retainedRole, "near_atm_post_close");
  assert.equal(sellCalls.length, 0); // loser not sold; just upgraded
});

test("Full curve: rule 9 (stale exit) sells stale_post_close after 1h", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-9",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  // closePosition with spot far from put strike → put becomes stale
  await closePosition(pool, executor, {
    position: opened.position,
    reason: "test",
    currentSpotBtc: 81_000
  });
  // Backdate retained_at by 90 min
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = NOW() - interval '90 minutes' WHERE position_id = $1`,
    [opened.position.id]
  );
  const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(81_000) });
  const staleSold = result.actions.find((a) => a.rule === "9_stale_exit" && a.action === "sold");
  assert.ok(staleSold, `expected rule 9 stale exit, got ${JSON.stringify(result.actions)}`);
});

test("Full curve: rule 12 (hard floor) catches collapsed value", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-12",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await closePosition(pool, executor, {
    position: opened.position,
    reason: "test",
    currentSpotBtc: 80_000
  });
  // Spot moves dramatically AND IV crashes → both legs collapse below 10%
  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: spotIv(95_000, 0.10)  // big up move + low IV
  });
  // PUT now far OTM with low IV → value < 10% → rule 12 sell
  const hardFloorSold = result.actions.find((a) => a.rule === "12_hard_floor" && a.action === "sold");
  assert.ok(hardFloorSold, `expected rule 12 hard floor, got ${JSON.stringify(result.actions)}`);
});

test("Full curve: thin-window defer (rule 2) skips tick when in 04:00-06:00 UTC", async () => {
  __resetHedgeManagerForTests();
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-FC-2-defer",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  // Backdate retained_at past rule 4 window so we'd otherwise evaluate rule 5+
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = NOW() - interval '45 minutes' WHERE position_id = $1`,
    [opened.position.id]
  );

  // Override env to make the CURRENT hour land in thin window (whatever it is)
  const currentUtcHour = new Date().getUTCHours();
  const originalStart = process.env.VC_TP_THIN_WINDOW_UTC_START;
  const originalEnd = process.env.VC_TP_THIN_WINDOW_UTC_END;
  process.env.VC_TP_THIN_WINDOW_UTC_START = String(currentUtcHour);
  process.env.VC_TP_THIN_WINDOW_UTC_END = String((currentUtcHour + 1) % 24);
  try {
    const result = await runOneHedgeManagerTick({ pool, executor, spotIvSource: spotIv(80_000) });
    // All actions should be rule 2 defers; legs scanned but not sold.
    assert.equal(sellCalls.length, 0);
    assert.ok(result.actions.every((a) => a.rule === "2_thin_window_defer"));
  } finally {
    process.env.VC_TP_THIN_WINDOW_UTC_START = originalStart ?? "0";
    process.env.VC_TP_THIN_WINDOW_UTC_END = originalEnd ?? "0";
  }
});
