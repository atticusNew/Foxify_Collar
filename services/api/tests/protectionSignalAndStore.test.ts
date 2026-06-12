/**
 * Live adaptive signal (pure computeLiveSignal) + Postgres-backed store (pg-mem).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { computeLiveSignal } from "../src/singleSide/twoSided/protection/protectionSignal";
import { PostgresProtectionStore } from "../src/singleSide/twoSided/protection/protectionStorePg";
import { openCover, settleCover } from "../src/singleSide/twoSided/protection/protectionLifecycle";
import type { Candle, DvolPoint } from "../src/singleSide/twoSided/feeRecoveryBacktest";

// Build hourly candles where, in the recent window, −3% gets touched far MORE than DVOL implies → GO.
const buildBullishForBuyer = (): { candles: Candle[]; dvol: DvolPoint[] } => {
  const candles: Candle[] = [];
  const dvol: DvolPoint[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  const price = 100000;
  for (let i = 0; i < 600; i++) {
    const tsMs = t0 + i * 3_600_000;
    // every other hour dips −4% (a touch for a 3% long cover) → very high realized touch
    const dip = i % 2 === 0;
    candles.push({ tsMs, close: price, high: price * 1.001, low: dip ? price * 0.96 : price * 0.999 });
    dvol.push({ tsMs, dvol: 30 }); // low implied vol → low implied touch → realized >> implied
  }
  return { candles, dvol };
};

test("computeLiveSignal: GO when trailing realized >> implied", () => {
  const { candles, dvol } = buildBullishForBuyer();
  const r = computeLiveSignal(candles, dvol, { side: "long", triggerPct: 0.03, tenorHours: 1, vrpLookbackHours: 240, minSamples: 30 });
  assert.equal(r.state, "GO");
  assert.ok((r.trailing_realized ?? 0) > (r.trailing_implied ?? 1));
  assert.ok((r.edge_pts ?? 0) > 0);
});

test("computeLiveSignal: WAIT when no touches (realized below implied)", () => {
  const candles: Candle[] = [];
  const dvol: DvolPoint[] = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 600; i++) {
    candles.push({ tsMs: t0 + i * 3_600_000, close: 100000, high: 100100, low: 99900 }); // never dips 3%
    dvol.push({ tsMs: t0 + i * 3_600_000, dvol: 60 }); // high implied
  }
  const r = computeLiveSignal(candles, dvol, { side: "long", triggerPct: 0.03, tenorHours: 1, vrpLookbackHours: 240, minSamples: 30 });
  assert.equal(r.state, "WAIT");
});

test("computeLiveSignal: NA on insufficient data", () => {
  const r = computeLiveSignal([], [], { side: "long", triggerPct: 0.03, tenorHours: 24, minSamples: 50 });
  assert.equal(r.state, "NA");
});

test("PostgresProtectionStore: put/get/findByRef/list/active round-trip", async () => {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const store = new PostgresProtectionStore(pool as any);

  const base = { spot: 100000, triggerPct: 0.03, tenorMs: 86_400_000, payoutUsdc: 60, premiumUsdc: 12, hedgeCostUsdc: 11, opsFeeUsdc: 1, impliedTouch: 0.18, nowMs: 1_000_000 };
  const c1 = openCover({ ...base, id: "c1", foxifyRef: "ref-1" });
  const c2 = openCover({ ...base, id: "c2", foxifyRef: "ref-2" });
  await store.put(c1);
  await store.put(c2);

  assert.equal((await store.get("c1"))?.id, "c1");
  assert.equal((await store.findByRef("ref-2"))?.id, "c2");
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.active()).length, 2);

  // settle c1 → no longer active, persisted
  const settled = settleCover(c1, { touched: true, settlePrice: 97000, nowMs: 1_000_001 });
  await store.put(settled);
  assert.equal((await store.active()).length, 1);
  assert.equal((await store.get("c1"))?.status, "settled_touch");
  assert.equal((await store.get("c1"))?.foxify_pnl_usdc, 48);
});
