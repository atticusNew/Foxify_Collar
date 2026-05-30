/**
 * Gate snapshot persistence — writes gate observations to disk so we can
 * answer historical questions like "what % of the time has the signal been
 * GO over the last N days?"
 *
 * Complementary to gateHistory.ts (the in-memory ring) — that's optimized
 * for fast trend/sustained-good computation in /foxify/v2/should_activate;
 * this module captures the longer record needed for analytics.
 *
 * Sampling strategy:
 *   - Persist every snapshot the gate computes (i.e. every poll), but
 *     deduplicate: if the previous snapshot in DB is < MIN_PERSIST_GAP_MS
 *     old AND the (regime, good_to_activate, signal_tier) hasn't changed,
 *     skip the write to avoid table bloat.
 *   - Net effect: ~1 row per 30s on a quiet system, more rows on transitions.
 */

import type { Pool } from "pg";

const MIN_PERSIST_GAP_MS = 30_000; // 30s minimum between identical persisted rows

export type PersistedSnapshot = {
  ts: Date;
  good_to_activate: boolean;
  regime: string | null;
  dvol: number | null;
  vrp: number | null;
  iv_annual: number | null;
  rv_annual: number | null;
  signal_tier: string | null;
  signal_score: number | null;
};

export const ensureGateSnapshotSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_gate_snapshot (
      snapshot_id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      good_to_activate BOOLEAN NOT NULL,
      regime TEXT,
      dvol NUMERIC(8,3),
      vrp NUMERIC(8,5),
      iv_annual NUMERIC(8,5),
      rv_annual NUMERIC(8,5),
      signal_tier TEXT,
      signal_score NUMERIC(8,4)
    );
    CREATE INDEX IF NOT EXISTS idx_two_sided_gate_snapshot_ts
      ON two_sided_gate_snapshot(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_two_sided_gate_snapshot_regime_good
      ON two_sided_gate_snapshot(regime, good_to_activate, ts);
  `);
};

/**
 * Persist a snapshot iff it represents new information vs the latest row.
 * Returns true if a row was written, false if deduplicated.
 */
export const persistGateSnapshotIfChanged = async (
  pool: Pool,
  snap: PersistedSnapshot
): Promise<boolean> => {
  // Fetch latest persisted row to dedupe
  const latest = await pool.query<{
    ts: Date;
    good_to_activate: boolean;
    regime: string | null;
    signal_tier: string | null;
  }>(
    `SELECT ts, good_to_activate, regime, signal_tier
       FROM two_sided_gate_snapshot
      ORDER BY ts DESC LIMIT 1`
  );
  if (latest.rows.length > 0) {
    const last = latest.rows[0];
    const ageMs = snap.ts.getTime() - new Date(last.ts).getTime();
    if (
      ageMs < MIN_PERSIST_GAP_MS &&
      last.good_to_activate === snap.good_to_activate &&
      last.regime === snap.regime &&
      last.signal_tier === snap.signal_tier
    ) {
      return false;
    }
  }
  await pool.query(
    `INSERT INTO two_sided_gate_snapshot
      (ts, good_to_activate, regime, dvol, vrp, iv_annual, rv_annual, signal_tier, signal_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      snap.ts,
      snap.good_to_activate,
      snap.regime,
      snap.dvol,
      snap.vrp,
      snap.iv_annual,
      snap.rv_annual,
      snap.signal_tier,
      snap.signal_score
    ]
  );
  return true;
};

export type SignalDistribution = {
  window_start: string;
  window_end: string;
  total_samples: number;
  good_samples: number;
  good_pct: number;
  by_regime: Record<string, { samples: number; good: number; good_pct: number }>;
  by_tier: Record<string, number>;
  transitions: number; // count of good_to_activate flips in the window
};

/**
 * Compute "how often was the signal GO?" over an arbitrary window.
 * Critical for answering CEO's question with hard data.
 */
export const computeSignalDistribution = async (
  pool: Pool,
  windowHours: number
): Promise<SignalDistribution> => {
  const windowMs = windowHours * 3_600_000;
  const start = new Date(Date.now() - windowMs);

  const allRowsRes = await pool.query<{ good_to_activate: boolean }>(
    `SELECT good_to_activate FROM two_sided_gate_snapshot WHERE ts >= $1 ORDER BY ts ASC`,
    [start]
  );
  const allRows = allRowsRes.rows;
  let goodCount = 0;
  let transitions = 0;
  let prev: boolean | null = null;
  for (const r of allRows) {
    if (r.good_to_activate) goodCount++;
    if (prev !== null && prev !== r.good_to_activate) transitions++;
    prev = r.good_to_activate;
  }
  const totals = { total: allRows.length, good: goodCount, transitions };

  // Use SUM(CASE) rather than COUNT(*) FILTER for broader SQL-engine compat
  const byRegimeRes = await pool.query<{ regime: string | null; samples: number; good: number }>(
    `SELECT regime,
            COUNT(*)::int AS samples,
            SUM(CASE WHEN good_to_activate = TRUE THEN 1 ELSE 0 END)::int AS good
       FROM two_sided_gate_snapshot
      WHERE ts >= $1
      GROUP BY regime
      ORDER BY regime`,
    [start]
  );

  const byTierRes = await pool.query<{ signal_tier: string | null; n: number }>(
    `SELECT signal_tier, COUNT(*)::int AS n
       FROM two_sided_gate_snapshot
      WHERE ts >= $1
      GROUP BY signal_tier
      ORDER BY signal_tier`,
    [start]
  );

  return {
    window_start: start.toISOString(),
    window_end: new Date().toISOString(),
    total_samples: Number(totals.total),
    good_samples: Number(totals.good),
    good_pct: totals.total > 0 ? Number(totals.good) / Number(totals.total) : 0,
    by_regime: Object.fromEntries(
      byRegimeRes.rows.map((r) => [
        r.regime ?? "unknown",
        {
          samples: Number(r.samples),
          good: Number(r.good),
          good_pct: Number(r.samples) > 0 ? Number(r.good) / Number(r.samples) : 0
        }
      ])
    ),
    by_tier: Object.fromEntries(byTierRes.rows.map((r) => [r.signal_tier ?? "unknown", Number(r.n)])),
    transitions: Number(totals.transitions)
  };
};
