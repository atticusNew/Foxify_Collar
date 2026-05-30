/**
 * Tests for venueRouting — historical + forward-looking venue analysis.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb, DataType } from "pg-mem";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getHistoricalRoutingStats } from "../src/singleSide/twoSided/venueRouting";

const buildPool = async (): Promise<Pool> => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID()
  });
  const pool = new (db.adapters.createPg().Pool)();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_pair (
      pair_id TEXT PRIMARY KEY,
      cell_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS two_sided_pair_leg (
      leg_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      leg_role TEXT NOT NULL,
      venue TEXT NOT NULL,
      strike_usdc NUMERIC,
      contracts_btc NUMERIC,
      buy_cost_usdc NUMERIC
    );
  `);
  return pool;
};

const insertPairWithLegs = async (
  pool: Pool,
  opts: { pair_id: string; cell_id: string; status: string; put_venue: string; call_venue: string; put_cost: number; call_cost: number }
) => {
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status) VALUES ($1, $2, $3)`,
    [opts.pair_id, opts.cell_id, opts.status]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, venue, buy_cost_usdc) VALUES ($1, $2, 'long_put', $3, $4)`,
    [randomUUID(), opts.pair_id, opts.put_venue, opts.put_cost]
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, venue, buy_cost_usdc) VALUES ($1, $2, 'long_call', $3, $4)`,
    [randomUUID(), opts.pair_id, opts.call_venue, opts.call_cost]
  );
};

test("getHistoricalRoutingStats: empty pool returns zeros", async () => {
  const pool = await buildPool();
  const s = await getHistoricalRoutingStats(pool);
  assert.equal(s.total_legs, 0);
  assert.equal(s.by_venue.bullish.leg_count, 0);
  assert.equal(s.by_venue.deribit.leg_count, 0);
});

test("getHistoricalRoutingStats: aggregates correctly across pairs", async () => {
  const pool = await buildPool();
  // 3 pairs: 2 all-deribit, 1 mixed (bullish put + deribit call)
  await insertPairWithLegs(pool, { pair_id: "a", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "deribit", put_cost: 100, call_cost: 200 });
  await insertPairWithLegs(pool, { pair_id: "b", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "deribit", put_cost: 150, call_cost: 250 });
  await insertPairWithLegs(pool, { pair_id: "c", cell_id: "c2", status: "active", put_venue: "bullish", call_venue: "deribit", put_cost: 90, call_cost: 180 });

  const s = await getHistoricalRoutingStats(pool);
  assert.equal(s.total_legs, 6);
  assert.equal(s.by_venue.bullish.leg_count, 1);
  assert.equal(s.by_venue.deribit.leg_count, 5);
  assert.equal(s.by_venue.bullish.cost_usdc, 90);
  assert.equal(s.by_venue.deribit.cost_usdc, 100 + 200 + 150 + 250 + 180);
});

test("getHistoricalRoutingStats: by_cell breakdown sums to total", async () => {
  const pool = await buildPool();
  await insertPairWithLegs(pool, { pair_id: "a", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "bullish", put_cost: 100, call_cost: 100 });
  await insertPairWithLegs(pool, { pair_id: "b", cell_id: "c2", status: "active", put_venue: "bullish", call_venue: "bullish", put_cost: 50, call_cost: 50 });

  const s = await getHistoricalRoutingStats(pool);
  assert.equal(s.by_cell.length, 2);
  const cell1 = s.by_cell.find((c) => c.cell_id === "c1");
  const cell2 = s.by_cell.find((c) => c.cell_id === "c2");
  assert.equal(cell1!.bullish_legs, 1);
  assert.equal(cell1!.deribit_legs, 1);
  assert.equal(cell1!.bullish_pct, 0.5);
  assert.equal(cell2!.bullish_legs, 2);
  assert.equal(cell2!.deribit_legs, 0);
  assert.equal(cell2!.bullish_pct, 1);
});

test("getHistoricalRoutingStats: activeOnly excludes closed pairs", async () => {
  const pool = await buildPool();
  await insertPairWithLegs(pool, { pair_id: "active1", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "deribit", put_cost: 100, call_cost: 100 });
  await insertPairWithLegs(pool, { pair_id: "closed1", cell_id: "c1", status: "closed", put_venue: "bullish", call_venue: "bullish", put_cost: 50, call_cost: 50 });

  const activeOnly = await getHistoricalRoutingStats(pool, { activeOnly: true });
  assert.equal(activeOnly.total_legs, 2);
  assert.equal(activeOnly.by_venue.bullish.leg_count, 0);

  const all = await getHistoricalRoutingStats(pool, { activeOnly: false });
  assert.equal(all.total_legs, 4);
  assert.equal(all.by_venue.bullish.leg_count, 2);
});

test("getHistoricalRoutingStats: pct_of_total normalizes correctly", async () => {
  const pool = await buildPool();
  // 4 deribit legs, 1 bullish leg = 80/20
  await insertPairWithLegs(pool, { pair_id: "a", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "deribit", put_cost: 100, call_cost: 100 });
  await insertPairWithLegs(pool, { pair_id: "b", cell_id: "c1", status: "active", put_venue: "deribit", call_venue: "deribit", put_cost: 100, call_cost: 100 });
  // 1 mixed pair: 1 bullish put
  await pool.query(
    `INSERT INTO two_sided_pair (pair_id, cell_id, status) VALUES ('c', 'c1', 'active')`
  );
  await pool.query(
    `INSERT INTO two_sided_pair_leg (leg_id, pair_id, leg_role, venue, buy_cost_usdc) VALUES ($1, 'c', 'long_put', 'bullish', 50)`,
    [randomUUID()]
  );

  const s = await getHistoricalRoutingStats(pool);
  assert.equal(s.total_legs, 5);
  assert.equal(s.by_venue.deribit.pct_of_total, 0.8);
  assert.equal(s.by_venue.bullish.pct_of_total, 0.2);
});
