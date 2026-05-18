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
  type SpotIvSource
} from "../src/volumeCover/volumeCoverHedgeManager";
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
  let sellCalls: Array<{ optionKind: "put" | "call"; strikeUsdc: number; contractsBtc: number }> = [];
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => ({
      venue: params.venue,
      fillPriceUsdcPerBtc: 100,
      totalCostUsdc: 100 * params.contractsBtc,
      orderId: "BUY"
    }),
    sellOptionLeg: async (params) => {
      sellCalls.push({
        optionKind: params.optionKind,
        strikeUsdc: params.strikeUsdc,
        contractsBtc: params.contractsBtc
      });
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 60,
        totalProceedsUsdc: 60 * params.contractsBtc,
        orderId: `SELL-${sellCalls.length}`
      };
    }
  };
  return { executor, sellCalls };
};

const buildSpotIvSource = (spotBtcUsdc: number, iv = 0.65, asOfMs?: number): SpotIvSource =>
  async () => ({
    spotBtcUsdc,
    ivAnnualized: iv,
    asOfMs: asOfMs ?? Date.now()
  });

// P1f stub-mode tests: explicitly enable stub via env at file load.
// Full 12-rule curve has its own test suite below.
process.env.VC_HM_USE_STUB = "true";

test("P1f: rule 1 — time-decay forced exit fires when expiry < 4h", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });

  // Set expiry to 1h from now to force rule 1
  const oneHourFromNow = new Date(Date.now() + 3_600_000).toISOString();
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET expiry_iso = $1::timestamptz WHERE position_id = $2`,
    [oneHourFromNow, opened.position.id]
  );

  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(80_000)
  });

  assert.equal(result.legsScanned, 2);
  assert.equal(result.legsActioned, 2);
  assert.equal(sellCalls.length, 2);
  for (const a of result.actions) {
    assert.equal(a.rule, "1_time_decay_exit");
    assert.equal(a.action, "sold");
  }

  // Verify legs are now status='sold' and ledger has hedge_sell_in
  const legs = await listHedgeLegsForPosition(pool, opened.position.id);
  for (const l of legs) assert.equal(l.status, "sold");
  const ledger = await pool.query(
    `SELECT entry_type FROM pilot_pool_ledger WHERE protection_id = $1`,
    [opened.position.id]
  );
  assert.ok(ledger.rows.some((r: any) => r.entry_type === "hedge_sell_in"));
});

test("P1f: rule 7 — loser leg sells via grace timeout (4h post-trigger)", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  // direction='low' → put winner, call loser
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });

  // Backdate the LOSER leg retained_at by 5h so grace (4h) is exceeded.
  // Winner stays at "now" so W1 (24h) doesn't fire.
  const fiveHoursAgo = new Date(Date.now() - 5 * 3_600_000).toISOString();
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = $1::timestamptz
     WHERE position_id = $2 AND retained_role = 'loser_post_trigger'`,
    [fiveHoursAgo, opened.position.id]
  );

  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(80_000)
  });

  // Only the loser leg should sell via grace; winner held (W1 not yet)
  assert.equal(sellCalls.length, 1);
  assert.equal(sellCalls[0].optionKind, "call");
  const callAction = result.actions.find((a) => a.action === "sold")!;
  assert.match(callAction.rule, /^7_loser/);
});

test("P1f: rule 12 — hard floor sells when value < 10% of cost", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-3",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await closePosition(pool, executor, {
    position: opened.position,
    reason: "test_close",
    currentSpotBtc: 80_000
  });
  // Foxify-close → near_atm_post_close legs. Move spot far away to
  // collapse value below 10% (pathological vol drop simulated via
  // spotIvSource = 70_000 with low IV).
  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(95_000, 0.20) // big spot move + low IV → call far ITM, put worthless
  });

  // The PUT is now far OTM with low IV → value < 10% of initial → rule 12
  // The CALL is far ITM → value HIGH → not floor; W1 timecap not yet
  // (same tick as retention), so "no_match" → held
  const sold = result.actions.filter((a) => a.action === "sold");
  assert.ok(sold.length >= 1, `expected at least 1 sold action, got ${result.actions.length}`);
  const putSold = sold.find((a) => a.rule === "12_hard_floor");
  assert.ok(putSold, "put leg should hit hard floor at low IV + big spot move");
});

test("P1f: rule W1 stub — winner-side time cap forces sell after 24h", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-W1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });

  // Backdate retained_at by 25 hours to force W1
  const longAgoIso = new Date(Date.now() - 25 * 3_600_000).toISOString();
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET retained_at = $1::timestamptz WHERE position_id = $2`,
    [longAgoIso, opened.position.id]
  );

  // Spot stays near entry — winner has good intrinsic still
  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(80_000)
  });

  // Both legs > 24h retained: winner triggers W1, loser triggers
  // grace (4h) — should sell both.
  assert.equal(result.legsActioned, 2);
  assert.equal(sellCalls.length, 2);
  const winnerAction = result.actions.find((a) => a.rule.startsWith("W1_stub"));
  assert.ok(winnerAction, "W1 winner timecap should fire");
});

test("P1f: dry-run mode logs without selling", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor, sellCalls } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-DRY",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });
  // Force rule 1 fire
  await pool.query(
    `UPDATE volume_cover_hedge_leg SET expiry_iso = NOW() + interval '1 hour' WHERE position_id = $1`,
    [opened.position.id]
  );

  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(80_000),
    dryRun: true
  });

  assert.equal(sellCalls.length, 0, "dry-run must NOT call sellOptionLeg");
  assert.equal(result.legsActioned, 0);
  assert.ok(result.actions.every((a) => a.action === "dry_run"));

  // Telemetry rows still inserted
  const telem = await pool.query(`SELECT action FROM volume_cover_hedge_leg_telemetry`);
  assert.ok(telem.rows.length >= 2);
  assert.ok(telem.rows.every((r: any) => r.action === "dry_run"));
});

test("P1f: stale spot/iv source skips tick", async () => {
  const pool = await buildPool();
  const { executor } = buildSpyExecutor();
  // Spot from 10 minutes ago
  const staleSource: SpotIvSource = async () => ({
    spotBtcUsdc: 80_000,
    ivAnnualized: 0.65,
    asOfMs: Date.now() - 10 * 60_000
  });
  const result = await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: staleSource
  });
  assert.equal(result.skipped, true);
  assert.match(result.skipReason ?? "", /stale_spot_iv/);
});

test("P1f: telemetry records both held and sold actions", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const { executor } = buildSpyExecutor();
  const opened = await openPosition(pool, executor, {
    cell,
    foxifyPairId: "FX-HM-TELEM",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await fireTrigger(pool, executor, { position: opened.position, direction: "low" });

  await runOneHedgeManagerTick({
    pool,
    executor,
    spotIvSource: buildSpotIvSource(80_000)
  });

  const telem = await pool.query(
    `SELECT leg_id, rule_evaluated, action FROM volume_cover_hedge_leg_telemetry ORDER BY id`
  );
  assert.ok(telem.rows.length >= 2);
  // At least one row per leg
  const distinctLegs = new Set(telem.rows.map((r: any) => r.leg_id));
  assert.ok(distinctLegs.size >= 2);
});
