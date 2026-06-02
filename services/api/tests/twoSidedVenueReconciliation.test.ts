/**
 * Phase C — live↔venue reconciliation probe tests.
 *
 * Builds live + shadow pairs with held legs in pg-mem and reconciles against a
 * mock venue position reader. Asserts:
 *   - matched Deribit leg (position present, size delta reported)
 *   - phantom Deribit leg (DB holds, venue empty)
 *   - orphan Deribit position (venue holds, no DB record)
 *   - Bullish matched + missing via asset balances
 *   - shadow pairs and already-sold legs are EXCLUDED from expected holdings
 *   - venue read error is reported (not thrown)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema, insertPair, insertPairLeg } from "../src/singleSide/twoSided/db";
import { reconcileVenuePositions, type VenuePositionReader } from "../src/singleSide/twoSided/venueReconciliation";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const addPair = async (pool: Pool, opts: { cellId: string; isShadow: boolean; status: string }): Promise<string> => {
  const pairId = randomUUID();
  await insertPair(pool, {
    pairId, cellId: opts.cellId, foxifyPairRef: `ref-${pairId}`, isShadow: opts.isShadow,
    spotAtActivation: 70_000,
    feedSnapshotAtActivation: {}, triggerDownPrice: 68_000, triggerUpPrice: 72_000,
    hedgeTenorDays: 3, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    tpForceExitAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    hedgeCostTotalUsdc: 500, foxifyCapitalFundedUsdc: 500, tierAtActivation: "tier_1",
    atticusFloorUsdc: 25, metadata: {}, regimeAtActivation: "moderate", status: opts.status as never
  });
  return pairId;
};

const addLeg = async (pool: Pool, pairId: string, opts: {
  role: "long_put" | "long_call"; venue: "bullish" | "deribit"; symbol: string; contractsBtc: number;
  buyFilled: boolean; sellFilled: boolean;
}): Promise<void> => {
  await insertPairLeg(pool, {
    legId: randomUUID(), pairId, legRole: opts.role, venue: opts.venue, symbol: opts.symbol,
    strikeUsdc: 70_000, contractsBtc: opts.contractsBtc, buyAskUsdcPerBtc: 1_000, buyCostUsdc: 100,
    buyFilledAt: opts.buyFilled ? new Date().toISOString() : null,
    liveAnchorAskUsdcPerBtc: 1_000, liveAnchorPulledAt: new Date().toISOString(), metadata: {}
  });
  if (opts.sellFilled) {
    await pool.query(
      `UPDATE two_sided_pair_leg SET sell_filled_at = NOW(), sell_ask_usdc_per_btc = 900, sell_proceeds_usdc = 90 WHERE pair_id = $1 AND leg_role = $2`,
      [pairId, opts.role]
    );
  }
};

test("reconcileVenuePositions: matched / phantom / orphan + bullish matched/missing + exclusions", async () => {
  const pool = await buildPool();

  // Live pair A: deribit put held (will MATCH), bullish call held (will MATCH).
  const a = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "active" });
  await addLeg(pool, a, { role: "long_put", venue: "deribit", symbol: "BTC-5JUN26-70000-P", contractsBtc: 0.6, buyFilled: true, sellFilled: false });
  await addLeg(pool, a, { role: "long_call", venue: "bullish", symbol: "BTC-USDC-20260605-70000-C", contractsBtc: 0.6, buyFilled: true, sellFilled: false });

  // Live pair B: deribit call held but venue shows NOTHING (PHANTOM).
  const b = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "triggered" });
  await addLeg(pool, b, { role: "long_call", venue: "deribit", symbol: "BTC-5JUN26-72000-C", contractsBtc: 0.5, buyFilled: true, sellFilled: false });

  // Live pair C: bullish put held but no matching balance (MISSING).
  const c = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "active" });
  await addLeg(pool, c, { role: "long_put", venue: "bullish", symbol: "BTC-USDC-20260605-68000-P", contractsBtc: 0.4, buyFilled: true, sellFilled: false });

  // SHADOW pair (must be excluded entirely).
  const s = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: true, status: "active" });
  await addLeg(pool, s, { role: "long_put", venue: "deribit", symbol: "BTC-5JUN26-69000-P", contractsBtc: 0.3, buyFilled: true, sellFilled: false });

  // ALREADY-SOLD leg in a live pair (must be excluded — we no longer hold it).
  const d = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "unwinding" });
  await addLeg(pool, d, { role: "long_call", venue: "deribit", symbol: "BTC-5JUN26-71000-C", contractsBtc: 0.2, buyFilled: true, sellFilled: true });

  const reader: VenuePositionReader = {
    getDeribitPositions: async () => [
      { instrument_name: "BTC-5JUN26-70000-P", size: 0.6 },     // matches pair A put
      { instrument_name: "BTC-5JUN26-99000-C", size: 1.2 }      // ORPHAN — no DB record
      // pair B's 72000-C deliberately absent → phantom
    ],
    getBullishAssetBalances: async () => [
      { assetSymbol: "USDC", availableQuantity: "10000" },
      { assetSymbol: "BTC-USDC-20260605-70000-C", availableQuantity: "0.6" } // matches pair A call
      // pair C's 68000-P deliberately absent → missing
    ]
  };

  const r = await reconcileVenuePositions(pool, reader);

  // Expected held legs: A(put deribit, call bullish), B(call deribit), C(put bullish) = 4.
  // Shadow + already-sold excluded.
  assert.equal(r.expected_held_legs, 4);
  assert.equal(r.expected.deribit.length, 2);
  assert.equal(r.expected.bullish.length, 2);

  // Deribit recon
  assert.equal(r.deribit.available, true);
  assert.equal(r.summary.deribit_matched, 1);
  assert.equal(r.deribit.matched[0].symbol, "BTC-5JUN26-70000-P");
  assert.equal(r.deribit.matched[0].size_delta_btc, 0);
  assert.equal(r.summary.deribit_phantom, 1);
  assert.equal(r.deribit.phantom[0].symbol, "BTC-5JUN26-72000-C");
  assert.equal(r.summary.deribit_orphan, 1);
  assert.equal(r.deribit.orphan[0].instrument, "BTC-5JUN26-99000-C");

  // Bullish recon
  assert.equal(r.bullish.available, true);
  assert.equal(r.summary.bullish_matched, 1);
  assert.equal(r.bullish.matched[0].symbol, "BTC-USDC-20260605-70000-C");
  assert.equal(r.summary.bullish_missing, 1);
  assert.equal(r.bullish.missing[0].symbol, "BTC-USDC-20260605-68000-P");
  // Option-like balances captured (the held call symbol), USDC excluded.
  assert.ok(r.bullish.option_like_balances.some((b) => b.assetSymbol === "BTC-USDC-20260605-70000-C"));
  assert.ok(!r.bullish.option_like_balances.some((b) => b.assetSymbol === "USDC"));

  // Not clean (we have phantom + missing).
  assert.equal(r.summary.clean, false);
});

test("reconcileVenuePositions: venue read error is reported, not thrown", async () => {
  const pool = await buildPool();
  const a = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "active" });
  await addLeg(pool, a, { role: "long_put", venue: "deribit", symbol: "BTC-5JUN26-70000-P", contractsBtc: 0.6, buyFilled: true, sellFilled: false });

  const reader: VenuePositionReader = {
    getDeribitPositions: async () => { throw new Error("deribit 503"); }
  };
  const r = await reconcileVenuePositions(pool, reader);
  assert.equal(r.deribit.available, false);
  assert.equal(r.deribit.error, "deribit 503");
  assert.equal(r.summary.clean, false); // error ⇒ not clean
});

test("reconcileVenuePositions: all matched ⇒ clean=true", async () => {
  const pool = await buildPool();
  const a = await addPair(pool, { cellId: "pair_50k_2pct", isShadow: false, status: "active" });
  await addLeg(pool, a, { role: "long_put", venue: "deribit", symbol: "BTC-5JUN26-70000-P", contractsBtc: 0.6, buyFilled: true, sellFilled: false });

  const reader: VenuePositionReader = {
    getDeribitPositions: async () => [{ instrument_name: "BTC-5JUN26-70000-P", size: 0.6 }],
    getBullishAssetBalances: async () => []
  };
  const r = await reconcileVenuePositions(pool, reader);
  assert.equal(r.summary.clean, true);
  assert.equal(r.summary.deribit_phantom, 0);
});
