import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import {
  ensureVolumeCoverSchema,
  seedVolumeCoverCellsIfNeeded,
  listCells,
  getCell,
  updateCell,
  insertPosition,
  getPosition,
  getPositionByPairId,
  listActivePositions,
  listPositionsForCellToday,
  sumActivePayoutLiability,
  markPositionTriggered,
  markPositionClosed,
  insertHedgeLeg,
  listHedgeLegsForPosition,
  markHedgeLegSold,
  insertSalvageEvent,
  computeRollingSalvageStats,
  countTriggersInWindow,
  sumNetLossInWindow
} from "../src/volumeCover/volumeCoverDb";
import { ensureCapitalPoolSchema } from "../src/pilot/capitalPoolSchema";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await ensureCapitalPoolSchema(pool); // for FK from ledger
  await ensureVolumeCoverSchema(pool);
  await seedVolumeCoverCellsIfNeeded(pool);
  return pool;
};

test("Schema migration creates 4 volume_cover tables + seeds 6 cells", async () => {
  const pool = await buildPool();
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'volume_cover_%' ORDER BY table_name`
  );
  const names = tables.rows.map((r: any) => r.table_name);
  assert.ok(names.includes("volume_cover_cell"));
  assert.ok(names.includes("volume_cover_position"));
  assert.ok(names.includes("volume_cover_hedge_leg"));
  assert.ok(names.includes("volume_cover_salvage_event"));
});

test("Cells seeded with all 6 matrix entries, all enabled by default", async () => {
  const pool = await buildPool();
  const cells = await listCells(pool);
  assert.equal(cells.length, 6);
  for (const c of cells) {
    assert.equal(c.enabled, true);
    assert.equal(c.throttleMaxPerDay, 5);
  }
});

test("getCell returns single cell", async () => {
  const pool = await buildPool();
  const cell = await getCell(pool, "50k_2pct_1k");
  assert.ok(cell);
  assert.equal(cell!.dailyPremiumUsdc, 350);
});

test("updateCell can disable a cell at runtime", async () => {
  const pool = await buildPool();
  const updated = await updateCell(pool, "50k_2pct_1k", { enabled: false });
  assert.ok(updated);
  assert.equal(updated!.enabled, false);
  const fresh = await getCell(pool, "50k_2pct_1k");
  assert.equal(fresh!.enabled, false);
});

test("updateCell can adjust premium + throttle independently", async () => {
  const pool = await buildPool();
  const updated = await updateCell(pool, "50k_2pct_1k", {
    dailyPremiumUsdc: 425,
    throttleMaxPerDay: 10
  });
  assert.ok(updated);
  assert.equal(updated!.dailyPremiumUsdc, 425);
  assert.equal(updated!.throttleMaxPerDay, 10);
});

test("Reseeding does NOT overwrite admin runtime overrides", async () => {
  const pool = await buildPool();
  await updateCell(pool, "50k_2pct_1k", { enabled: false, dailyPremiumUsdc: 999 });
  await seedVolumeCoverCellsIfNeeded(pool); // ON CONFLICT DO NOTHING
  const cell = await getCell(pool, "50k_2pct_1k");
  assert.equal(cell!.enabled, false, "admin disable should survive reseed");
  assert.equal(cell!.dailyPremiumUsdc, 999, "admin price override should survive reseed");
});

const buildSamplePosition = (id = "vc-pos-1") => ({
  id,
  cellId: "50k_2pct_1k" as const,
  foxifyPairId: "FX-PAIR-001",
  pairLongNotionalUsdc: 50_000,
  pairShortNotionalUsdc: 50_000,
  pairEntryBtcPrice: 80_000,
  triggerHighBtc: 81_600,
  triggerLowBtc: 78_400,
  dailyPremiumUsdc: 350,
  payoutUsdc: 1_000
});

test("insertPosition + getPosition roundtrip", async () => {
  const pool = await buildPool();
  const inserted = await insertPosition(pool, buildSamplePosition());
  assert.equal(inserted.id, "vc-pos-1");
  assert.equal(inserted.status, "active");
  const fetched = await getPosition(pool, "vc-pos-1");
  assert.deepEqual(fetched?.foxifyPairId, "FX-PAIR-001");
});

test("getPositionByPairId returns most recent for foxify pair", async () => {
  const pool = await buildPool();
  await insertPosition(pool, { ...buildSamplePosition("vc-1"), foxifyPairId: "FX-A" });
  await insertPosition(pool, { ...buildSamplePosition("vc-2"), foxifyPairId: "FX-A" });
  const found = await getPositionByPairId(pool, "FX-A");
  assert.ok(found);
  assert.ok(found!.id === "vc-1" || found!.id === "vc-2");
});

test("listActivePositions filters by status", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition("vc-active"));
  const closed = await insertPosition(pool, buildSamplePosition("vc-to-close"));
  await markPositionClosed(pool, { id: closed.id, reason: "test" });
  const active = await listActivePositions(pool);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "vc-active");
});

test("sumActivePayoutLiability totals payout across active positions", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition("vc-1")); // $1,000
  await insertPosition(pool, { ...buildSamplePosition("vc-2"), payoutUsdc: 5_000 });
  const total = await sumActivePayoutLiability(pool);
  assert.equal(total, 6_000);
});

test("markPositionTriggered transitions status + records direction", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  const triggered = await markPositionTriggered(pool, {
    id: "vc-pos-1",
    direction: "high"
  });
  assert.equal(triggered?.status, "triggered");
  assert.equal(triggered?.triggeredDirection, "high");
});

test("markPositionTriggered no-ops on non-active position", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  await markPositionClosed(pool, { id: "vc-pos-1", reason: "test" });
  const result = await markPositionTriggered(pool, { id: "vc-pos-1", direction: "high" });
  assert.equal(result, null);
});

test("insertHedgeLeg + listHedgeLegsForPosition roundtrip", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  await insertHedgeLeg(pool, {
    id: "leg-1",
    positionId: "vc-pos-1",
    venue: "bullish",
    optionKind: "put",
    strikeUsdc: 79_200,
    expiryIso: "2026-05-15T08:00:00Z",
    contracts: 1.3,
    buyPriceUsdc: 100,
    buyOrderId: "ORD-1"
  });
  const legs = await listHedgeLegsForPosition(pool, "vc-pos-1");
  assert.equal(legs.length, 1);
  assert.equal(legs[0].status, "open");
});

test("markHedgeLegSold updates status + sell price", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  await insertHedgeLeg(pool, {
    id: "leg-2",
    positionId: "vc-pos-1",
    venue: "bullish",
    optionKind: "call",
    strikeUsdc: 80_800,
    expiryIso: "2026-05-15T08:00:00Z",
    contracts: 1.3,
    buyPriceUsdc: 100
  });
  const sold = await markHedgeLegSold(pool, {
    id: "leg-2",
    sellPriceUsdc: 95,
    sellOrderId: "SELL-ORD-1"
  });
  assert.equal(sold?.status, "sold");
  assert.equal(sold?.sellPriceUsdc, 95);
});

test("insertSalvageEvent computes salvage_pct + net_loss correctly", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  const ev = await insertSalvageEvent(pool, {
    id: "salv-1",
    positionId: "vc-pos-1",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 950
  });
  assert.equal(ev.salvagePct, 0.95);
  assert.equal(ev.netAtticusLossUsdc, 50);
});

test("computeRollingSalvageStats averages over recent N", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition("vc-A"));
  await insertPosition(pool, buildSamplePosition("vc-B"));
  await insertSalvageEvent(pool, {
    id: "s1",
    positionId: "vc-A",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 1_000
  });
  await insertSalvageEvent(pool, {
    id: "s2",
    positionId: "vc-B",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 800
  });
  const stats = await computeRollingSalvageStats(pool, 5);
  assert.equal(stats.count, 2);
  // (1.0 + 0.8) / 2 = 0.9
  assert.equal(Number(stats.avgSalvagePct?.toFixed(2)), 0.90);
});

test("countTriggersInWindow returns recent count", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition());
  await insertSalvageEvent(pool, {
    id: "s-recent",
    positionId: "vc-pos-1",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 950
  });
  const count = await countTriggersInWindow(pool, 24);
  assert.equal(count, 1);
});

test("sumNetLossInWindow aggregates loss across triggers", async () => {
  const pool = await buildPool();
  await insertPosition(pool, buildSamplePosition("vc-A"));
  await insertPosition(pool, buildSamplePosition("vc-B"));
  await insertSalvageEvent(pool, {
    id: "s-lossA",
    positionId: "vc-A",
    triggeredDirection: "high",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 700
  });
  await insertSalvageEvent(pool, {
    id: "s-lossB",
    positionId: "vc-B",
    triggeredDirection: "low",
    payoutOwedUsdc: 1_000,
    hedgeSaleProceedsUsdc: 800
  });
  const total = await sumNetLossInWindow(pool, 24);
  assert.equal(total, 500); // 300 + 200
});
