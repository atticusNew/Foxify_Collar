/**
 * Tests for gate snapshot persistence + signal distribution.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import {
  ensureGateSnapshotSchema,
  persistGateSnapshotIfChanged,
  computeSignalDistribution,
  type PersistedSnapshot
} from "../src/singleSide/twoSided/gateSnapshotPersist";

const buildPool = async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pool = new (db.adapters.createPg().Pool)();
  await ensureGateSnapshotSchema(pool);
  return pool;
};

const sampleSnap = (overrides: Partial<PersistedSnapshot> = {}): PersistedSnapshot => ({
  ts: new Date(),
  good_to_activate: false,
  regime: "calm",
  dvol: 35,
  vrp: 0.005,
  iv_annual: 0.35,
  rv_annual: 0.345,
  signal_tier: "slightly_negative",
  signal_score: -0.17,
  ...overrides
});

test("ensureGateSnapshotSchema creates the table", async () => {
  const pool = await buildPool();
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_gate_snapshot`);
  assert.equal(r.rows[0].n, 0);
});

test("persistGateSnapshotIfChanged: first row always persists", async () => {
  const pool = await buildPool();
  const written = await persistGateSnapshotIfChanged(pool, sampleSnap());
  assert.equal(written, true);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_gate_snapshot`);
  assert.equal(r.rows[0].n, 1);
});

test("persistGateSnapshotIfChanged: dedupes identical row within 30s", async () => {
  const pool = await buildPool();
  const ts = new Date();
  await persistGateSnapshotIfChanged(pool, sampleSnap({ ts }));
  const written = await persistGateSnapshotIfChanged(
    pool,
    sampleSnap({ ts: new Date(ts.getTime() + 5_000) }) // 5s later, identical state
  );
  assert.equal(written, false);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM two_sided_gate_snapshot`);
  assert.equal(r.rows[0].n, 1);
});

test("persistGateSnapshotIfChanged: persists when good_to_activate changes", async () => {
  const pool = await buildPool();
  const ts = new Date();
  await persistGateSnapshotIfChanged(pool, sampleSnap({ ts, good_to_activate: false }));
  const written = await persistGateSnapshotIfChanged(
    pool,
    sampleSnap({ ts: new Date(ts.getTime() + 1_000), good_to_activate: true })
  );
  assert.equal(written, true);
});

test("persistGateSnapshotIfChanged: persists when tier changes", async () => {
  const pool = await buildPool();
  const ts = new Date();
  await persistGateSnapshotIfChanged(pool, sampleSnap({ ts, signal_tier: "slightly_negative" }));
  const written = await persistGateSnapshotIfChanged(
    pool,
    sampleSnap({ ts: new Date(ts.getTime() + 1_000), signal_tier: "slightly_positive" })
  );
  assert.equal(written, true);
});

test("persistGateSnapshotIfChanged: persists when gap > 30s even if identical state", async () => {
  const pool = await buildPool();
  const ts = new Date();
  await persistGateSnapshotIfChanged(pool, sampleSnap({ ts }));
  const written = await persistGateSnapshotIfChanged(
    pool,
    sampleSnap({ ts: new Date(ts.getTime() + 35_000) }) // 35s later, beyond dedup window
  );
  assert.equal(written, true);
});

test("computeSignalDistribution: computes good_pct correctly", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // 5 snapshots, 3 GO and 2 WAIT
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO two_sided_gate_snapshot (ts, good_to_activate, regime, signal_tier)
       VALUES ($1, $2, 'elevated', 'positive')`,
      [new Date(now - (5 - i) * 60_000).toISOString(), i < 3]
    );
  }
  const dist = await computeSignalDistribution(pool, 24);
  assert.equal(dist.total_samples, 5);
  assert.equal(dist.good_samples, 3);
  assert.equal(dist.good_pct, 0.6);
});

test("computeSignalDistribution: counts transitions", async () => {
  const pool = await buildPool();
  const now = Date.now();
  // sequence: false, true, true, false, true → 3 transitions
  const seq = [false, true, true, false, true];
  for (let i = 0; i < seq.length; i++) {
    await pool.query(
      `INSERT INTO two_sided_gate_snapshot (ts, good_to_activate, regime)
       VALUES ($1, $2, 'calm')`,
      [new Date(now - (seq.length - i) * 60_000).toISOString(), seq[i]]
    );
  }
  const dist = await computeSignalDistribution(pool, 24);
  assert.equal(dist.transitions, 3);
});

test("computeSignalDistribution: breaks down by regime", async () => {
  const pool = await buildPool();
  const now = Date.now();
  const data: Array<{ regime: string; good: boolean }> = [
    { regime: "calm", good: false },
    { regime: "calm", good: false },
    { regime: "calm", good: true },
    { regime: "moderate", good: true },
    { regime: "moderate", good: true },
    { regime: "elevated", good: true }
  ];
  for (let i = 0; i < data.length; i++) {
    await pool.query(
      `INSERT INTO two_sided_gate_snapshot (ts, good_to_activate, regime)
       VALUES ($1, $2, $3)`,
      [new Date(now - (data.length - i) * 60_000).toISOString(), data[i].good, data[i].regime]
    );
  }
  const dist = await computeSignalDistribution(pool, 24);
  assert.equal(dist.by_regime.calm.samples, 3);
  assert.equal(dist.by_regime.calm.good, 1);
  assert.equal(dist.by_regime.calm.good_pct, 1 / 3);
  assert.equal(dist.by_regime.moderate.good_pct, 1);
  assert.equal(dist.by_regime.elevated.good_pct, 1);
});

test("computeSignalDistribution: empty window returns zero", async () => {
  const pool = await buildPool();
  const dist = await computeSignalDistribution(pool, 24);
  assert.equal(dist.total_samples, 0);
  assert.equal(dist.good_pct, 0);
});
