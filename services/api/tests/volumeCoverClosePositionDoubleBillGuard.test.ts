/**
 * Unit test for the 2026-05-24 (PR-E) closePosition double-bill guard.
 *
 * Background: fireTrigger() writes a `premium_in` ledger entry capped at the
 * trigger moment (accrual_basis: "trigger_close"). The /admin/positions/:id/close
 * route currently rejects non-active closes with 409 position_not_active, so
 * this guard is defense-in-depth for the case where someone lifts that gate
 * to operator-finalize a stuck-in-triggered position (which is exactly the
 * cleanup workflow the May 22-24 dash incident would have benefitted from
 * if it had not been blocked).
 *
 * Without the guard, calling closePosition on a triggered position writes a
 * SECOND `premium_in` entry of (closeMs − openedMs)/86400000 days × dailyRate.
 * For the May 22 30k position this would have been $840 of phantom premium
 * billed on top of the already-correct $420 from fireTrigger.
 */

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
  getPosition
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
    const isPut = params.optionKind === "put";
    return {
      venue: params.venue,
      fillPriceUsdcPerBtc: isPut ? 800 : 5,
      totalProceedsUsdc: (isPut ? 800 : 5) * params.contractsBtc,
      orderId: `MOCK-SELL-${Math.random()}`
    };
  },
  ...overrides
});

const countPremiumInEntries = async (pool: any, positionId: string): Promise<{
  count: number;
  byBasis: Record<string, number>;
  totalUsdc: number;
}> => {
  const r = await pool.query(
    `SELECT amount_usdc, metadata
     FROM pilot_pool_ledger
     WHERE protection_id = $1 AND entry_type = 'premium_in'
     ORDER BY id`,
    [positionId]
  );
  const byBasis: Record<string, number> = {};
  let totalUsdc = 0;
  for (const row of r.rows) {
    const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata ?? {};
    const basis = String(meta.accrual_basis ?? "unknown");
    byBasis[basis] = (byBasis[basis] ?? 0) + 1;
    totalUsdc += Number(row.amount_usdc);
  }
  return { count: r.rows.length, byBasis, totalUsdc };
};

test("PR-E closePosition: triggered position is NOT re-billed at close", async () => {
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-PR-E-DOUBLE-BILL",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  // Step 1: fire trigger. fireTrigger writes premium_in with
  // accrual_basis: "trigger_close" capped at the trigger moment.
  await fireTrigger(pool, buildMockExecutor(), {
    position: opened.position,
    direction: "low"
  });

  const afterTrigger = await countPremiumInEntries(pool, opened.position.id);
  assert.equal(
    afterTrigger.count,
    1,
    "fireTrigger must write exactly 1 premium_in entry"
  );
  assert.equal(
    afterTrigger.byBasis.trigger_close ?? 0,
    1,
    "the entry must be tagged accrual_basis=trigger_close"
  );
  const triggerPremiumUsdc = afterTrigger.totalUsdc;

  // Step 2: simulate a lift of the route's status='active' gate by calling
  // closePosition directly on the now-triggered position. Pre-PR-E this
  // would have appended a second premium_in. Post-PR-E it skips.
  const triggered = await getPosition(pool, opened.position.id);
  assert.equal(triggered?.status, "triggered", "precondition: position is triggered");
  await closePosition(pool, buildMockExecutor(), {
    position: triggered!,
    reason: "admin_finalize_post_trigger_dash_cleanup"
  });

  const afterClose = await countPremiumInEntries(pool, opened.position.id);
  assert.equal(
    afterClose.count,
    1,
    "closePosition on a triggered position must NOT write a second premium_in"
  );
  assert.equal(
    afterClose.totalUsdc,
    triggerPremiumUsdc,
    "total premium_in must equal the trigger-time amount (no double-bill)"
  );
  assert.equal(
    afterClose.byBasis.foxify_close ?? 0,
    0,
    "no foxify_close-basis entry should be written for a triggered position"
  );
});

test("PR-E closePosition: ACTIVE position close still writes premium_in (regression guard)", async () => {
  // The PR-E guard must not affect the normal Foxify-close path. A position
  // closed without ever triggering should still get its premium_in written
  // with accrual_basis="foxify_close".
  const pool = await buildPool();
  const cell = findCellById("50k_2pct_1k")!;
  const opened = await openPosition(pool, buildMockExecutor(), {
    cell,
    foxifyPairId: "FX-PR-E-NORMAL-CLOSE",
    pairLongNotionalUsdc: 50_000,
    pairShortNotionalUsdc: 50_000,
    pairEntryBtcPrice: 80_000
  });

  await closePosition(pool, buildMockExecutor(), {
    position: opened.position,
    reason: "foxify_early_close_regression_test"
  });

  const after = await countPremiumInEntries(pool, opened.position.id);
  assert.equal(
    after.count,
    1,
    "closePosition on ACTIVE position must write exactly 1 premium_in"
  );
  assert.equal(
    after.byBasis.foxify_close ?? 0,
    1,
    "the entry must be tagged accrual_basis=foxify_close"
  );
  assert.ok(
    after.totalUsdc > 0,
    "premium amount should be > 0 (at least 1 day × dailyRate)"
  );
});
