import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureCapitalPoolSchema,
  seedCapitalPoolsIfNeeded
} from "../src/pilot/capitalPoolSchema";
import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded
} from "../src/volumeCover/volumeCoverDb";
import { openPosition, closePosition, fireTrigger } from "../src/volumeCover/positionLifecycle";
import { findCellById } from "../src/volumeCover/matrix";
import {
  buildWeeklySettlement,
  daysActiveInWindow,
  resolveWeekRange,
  renderWeeklySettlementMarkdown
} from "../src/volumeCover/weeklyReconciler";
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

const buildMockExecutor = (): HedgeExecutor => ({
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 90,
    totalCostUsdc: 90 * params.contractsBtc,
    orderId: `MOCK-BUY-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 50,
    totalProceedsUsdc: 50 * params.contractsBtc,
    orderId: `MOCK-SELL-${Math.random()}`
  })
});

test("daysActiveInWindow: full week active = 7 days", () => {
  const days = daysActiveInWindow({
    openedAtIso: "2026-05-11T00:00:00Z",
    closedAtIso: "2026-05-18T00:00:00Z",
    windowStartIso: "2026-05-11T00:00:00Z",
    windowEndIso: "2026-05-18T00:00:00Z"
  });
  assert.equal(days, 7);
});

test("daysActiveInWindow: opened mid-week, still open at week end", () => {
  const days = daysActiveInWindow({
    openedAtIso: "2026-05-13T00:00:00Z",
    closedAtIso: null,
    windowStartIso: "2026-05-11T00:00:00Z",
    windowEndIso: "2026-05-18T00:00:00Z",
    nowMs: new Date("2026-05-18T00:00:00Z").getTime()
  });
  assert.equal(days, 5); // 13,14,15,16,17 = 5 days
});

test("daysActiveInWindow: partial day rounds UP (per Foxify per-day billing)", () => {
  const days = daysActiveInWindow({
    openedAtIso: "2026-05-13T08:00:00Z",
    closedAtIso: "2026-05-13T20:00:00Z",
    windowStartIso: "2026-05-11T00:00:00Z",
    windowEndIso: "2026-05-18T00:00:00Z"
  });
  assert.equal(days, 1); // 12h rounds up to 1 full day
});

test("daysActiveInWindow: position outside window = 0 days", () => {
  const days = daysActiveInWindow({
    openedAtIso: "2026-05-01T00:00:00Z",
    closedAtIso: "2026-05-05T00:00:00Z",
    windowStartIso: "2026-05-11T00:00:00Z",
    windowEndIso: "2026-05-18T00:00:00Z"
  });
  assert.equal(days, 0);
});

test("resolveWeekRange: 2026-W20 maps to a 7-day window", () => {
  const w = resolveWeekRange("2026-W20");
  const start = new Date(w.startIso);
  const end = new Date(w.endIso);
  assert.equal(end.getTime() - start.getTime(), 7 * 86_400_000);
  assert.equal(w.label, "2026-W20");
});

test("resolveWeekRange: invalid label throws", () => {
  assert.throws(() => resolveWeekRange("garbage"), /Invalid week label/);
});

test("buildWeeklySettlement: P1d — close after 5d charges 5d × dailyPremium", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!; // $350/day
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-WK-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  // Stub the position open + close timestamps to land in a known week.
  const weekStartIso = "2026-05-11T00:00:00Z"; // Monday
  const weekEndIso = "2026-05-18T00:00:00Z";
  await pool.query(
    `UPDATE volume_cover_position SET opened_at = $1::timestamptz WHERE id = $2`,
    [weekStartIso, opened.position.id]
  );

  // Simulate close 5 days into the week
  const closedAtIso = "2026-05-16T00:00:00Z";
  await pool.query(
    `UPDATE volume_cover_position SET closed_at = $1::timestamptz, status = 'closed' WHERE id = $2`,
    [closedAtIso, opened.position.id]
  );

  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: new Date(weekEndIso).getTime()
  });

  assert.equal(settlement.perPosition.length, 1);
  const rollup = settlement.perPosition[0];
  assert.equal(rollup.daysActiveInWeek, 5);
  assert.equal(rollup.premiumOwedUsdc, 5 * 350); // $1,750
  assert.equal(settlement.totals.grossPremiumInUsdc, 1_750);
});

test("buildWeeklySettlement: triggered position credits payout in trigger week", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-WK-2",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await pool.query(
    `UPDATE volume_cover_position SET opened_at = $1::timestamptz WHERE id = $2`,
    ["2026-05-12T00:00:00Z", opened.position.id]
  );

  // Trigger the position
  await fireTrigger(pool, buildMockExecutor(), {
    position: { ...opened.position, openedAt: "2026-05-12T00:00:00Z" } as any,
    direction: "low"
  });
  await pool.query(
    `UPDATE volume_cover_position SET triggered_at = $1::timestamptz WHERE id = $2`,
    ["2026-05-13T00:00:00Z", opened.position.id]
  );

  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: new Date("2026-05-18T00:00:00Z").getTime()
  });

  const rollup = settlement.perPosition[0];
  assert.equal(rollup.triggered, true);
  assert.equal(rollup.payoutOwedUsdc, 1_000);
  assert.equal(settlement.totals.grossPayoutOutUsdc, 1_000);
});

test("buildWeeklySettlement: 25% partial settlement amount computed correctly", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  // Open + close to trigger hedge_buy_out + premium_in flows
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-WK-3",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  // Force into target week
  await pool.query(
    `UPDATE volume_cover_position SET opened_at = $1::timestamptz WHERE id = $2`,
    ["2026-05-13T00:00:00Z", opened.position.id]
  );
  await pool.query(
    `UPDATE pilot_pool_ledger SET effective_at = $1::timestamptz WHERE protection_id = $2`,
    ["2026-05-13T00:00:00Z", opened.position.id]
  );

  // Close 2 days later
  await closePosition(pool, buildMockExecutor(), {
    position: { ...opened.position, openedAt: "2026-05-13T00:00:00Z" } as any,
    reason: "test"
  });
  await pool.query(
    `UPDATE volume_cover_position SET closed_at = $1::timestamptz WHERE id = $2`,
    ["2026-05-15T00:00:00Z", opened.position.id]
  );

  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: new Date("2026-05-18T00:00:00Z").getTime()
  });

  // Partial 25% must be 25% of net obligation, but never negative.
  assert.ok(settlement.partial25PctUsdc >= 0);
  assert.ok(
    Math.abs(settlement.partial25PctUsdc - settlement.totals.netAtticusObligationUsdc * 0.25) < 0.01 ||
      settlement.totals.netAtticusObligationUsdc < 0
  );
});

test("renderWeeklySettlementMarkdown: produces non-empty markdown summary", async () => {
  const settlement = {
    week: { startIso: "2026-05-11T00:00:00Z", endIso: "2026-05-18T00:00:00Z", label: "2026-W20" },
    perPosition: [],
    totals: {
      grossPremiumInUsdc: 0,
      grossPayoutOutUsdc: 0,
      grossHedgeBuyOutUsdc: 0,
      grossHedgeSellInUsdc: 0,
      netAtticusObligationUsdc: 0
    },
    partial25PctUsdc: 0,
    reconciliation: {
      checked: false,
      venueReportedBalanceUsdc: null,
      ledgerExpectedBalanceUsdc: null,
      driftPct: null,
      driftHalt: false,
      driftMessage: null
    },
    generatedAtIso: "2026-05-18T00:00:00Z"
  };
  const md = renderWeeklySettlementMarkdown(settlement);
  assert.match(md, /Volume Cover/);
  assert.match(md, /2026-W20/);
  assert.match(md, /Reconciliation drift check/);
});

test("§12.4 reconciliation drift halt: drift > 1% trips driftHalt", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-DRIFT-1",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  await pool.query(
    `UPDATE volume_cover_position SET opened_at = $1::timestamptz WHERE id = $2`,
    ["2026-05-13T00:00:00Z", opened.position.id]
  );
  // Move ledger entries into target week
  await pool.query(
    `UPDATE pilot_pool_ledger SET effective_at = $1::timestamptz WHERE protection_id = $2`,
    ["2026-05-13T00:00:00Z", opened.position.id]
  );

  // Ledger sum is roughly hedge_buy_out (negative ~$117 from 1.3 BTC × $90).
  // Stub a venue fetcher that returns wildly different value.
  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: new Date("2026-05-18T00:00:00Z").getTime(),
    venueBalanceFetcher: async () => 5_000  // way off ledger
  });

  assert.equal(settlement.reconciliation.checked, true);
  assert.equal(settlement.reconciliation.driftHalt, true);
  assert.ok((settlement.reconciliation.driftPct ?? 0) > 0.01);
});

test("§12.4 reconciliation: venue fetch error sets checked=false (no auto-halt)", async () => {
  const pool = await buildPool();
  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: new Date("2026-05-18T00:00:00Z").getTime(),
    venueBalanceFetcher: async () => {
      throw new Error("venue_api_unreachable");
    }
  });
  assert.equal(settlement.reconciliation.checked, false);
  assert.equal(settlement.reconciliation.driftHalt, false);
  assert.match(settlement.reconciliation.driftMessage ?? "", /venue_balance_fetch_failed/);
});

test("§12.4 reconciliation: venue balance close to ledger \u2192 driftHalt=false", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-DRIFT-OK",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });
  // Read actual ledger sum to set venue balance within 1% of it.
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_usdc), 0) AS s
     FROM pilot_pool_ledger
     WHERE pool_id = 'atticus_hedge' AND reference LIKE 'vc_%'`
  );
  const ledgerSum = Number(r.rows[0].s);
  const settlement = await buildWeeklySettlement({
    pool,
    weekLabel: "2026-W20",
    nowMs: Date.now(),
    venueBalanceFetcher: async () => ledgerSum * 1.005  // 0.5% off
  });
  assert.equal(settlement.reconciliation.checked, true);
  assert.equal(settlement.reconciliation.driftHalt, false, `drift was ${(settlement.reconciliation.driftPct ?? 0) * 100}%`);
});
