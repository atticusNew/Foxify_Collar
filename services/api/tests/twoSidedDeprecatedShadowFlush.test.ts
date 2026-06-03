/**
 * Deprecated-shadow flush — cancels deprecated OPEN shadow pairs, leaves production
 * cells, real pairs, and already-terminal pairs untouched.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ensureTwoSidedSchema, getPairById } from "../src/singleSide/twoSided/db";
import { flushDeprecatedOpenShadowPairs, isDeprecatedFlushEnabled } from "../src/singleSide/twoSided/deprecatedShadowFlush";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: "gen_random_uuid", returns: DataType.uuid, impure: true, implementation: () => randomUUID() });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureTwoSidedSchema(pool);
  return pool;
};

const add = async (pool: Pool, o: { isShadow: boolean; status: string; cell: string }): Promise<string> => {
  const pairId = randomUUID();
  const { insertPair } = await import("../src/singleSide/twoSided/db");
  await insertPair(pool, {
    pairId, cellId: o.cell, foxifyPairRef: `r-${pairId}`, isShadow: o.isShadow,
    spotAtActivation: 70_000, feedSnapshotAtActivation: {}, triggerDownPrice: 68_000, triggerUpPrice: 72_000,
    hedgeTenorDays: 3, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    tpForceExitAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    hedgeCostTotalUsdc: 500, foxifyCapitalFundedUsdc: 500, tierAtActivation: "tier_1",
    atticusFloorUsdc: 25, metadata: {}, regimeAtActivation: "moderate" as never, status: o.status as never
  });
  return pairId;
};

test("flushDeprecatedOpenShadowPairs: cancels only deprecated OPEN shadow pairs", async () => {
  const pool = await buildPool();
  const depOpen = await add(pool, { isShadow: true, status: "active", cell: "pair_50k_2pct" });        // deprecated + shadow + open → FLUSH
  const depTrig = await add(pool, { isShadow: true, status: "triggered", cell: "pair_50k_2pct" });      // deprecated + shadow + open → FLUSH
  const prodOpen = await add(pool, { isShadow: true, status: "active", cell: "pair_50k_3pct_atm_3d" }); // production → keep
  const depReal = await add(pool, { isShadow: false, status: "active", cell: "pair_50k_2pct" });        // real → keep
  const depSettled = await add(pool, { isShadow: true, status: "settled", cell: "pair_50k_2pct" });     // already terminal → keep

  // Dry run: counts but doesn't cancel.
  const dry = await flushDeprecatedOpenShadowPairs(pool, { dryRun: true });
  assert.equal(dry.flushed, 0);
  assert.equal(dry.ids.length, 2);
  assert.equal((await getPairById(pool, depOpen))!.status, "active", "dry run leaves it active");

  const res = await flushDeprecatedOpenShadowPairs(pool);
  assert.equal(res.flushed, 2);
  assert.equal((await getPairById(pool, depOpen))!.status, "cancelled");
  assert.equal((await getPairById(pool, depTrig))!.status, "cancelled");
  assert.equal((await getPairById(pool, prodOpen))!.status, "active", "production cell untouched");
  assert.equal((await getPairById(pool, depReal))!.status, "active", "real pair untouched");
  assert.equal((await getPairById(pool, depSettled))!.status, "settled", "terminal untouched");
});

test("isDeprecatedFlushEnabled: default on, off via env", () => {
  assert.equal(isDeprecatedFlushEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(isDeprecatedFlushEnabled({ SS_SHADOW_FLUSH_DEPRECATED: "false" } as unknown as NodeJS.ProcessEnv), false);
});
