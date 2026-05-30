/**
 * Deferred-settlement pool (PR 6 + PLAN.md §4).
 *
 * Foxify-elected mechanic for the scale-up phase: when active, Atticus's
 * tier-split share accrues to a ledger but is NOT paid out; all salvage stays
 * in the joint pool to fund new pair activations. On de-activation, the
 * accrued Atticus balance is settled.
 *
 * For Phase 0:
 *   - Two tables: two_sided_deferred_pool_state (global toggle)
 *                 two_sided_deferred_pool_ledger (per-pair accrual entries)
 *   - togglePool(active: boolean) → flips global state
 *   - recordAccrual(pair_id, atticus_share) → ledger entry
 *   - getPoolBalance() → sum of unsettled atticus_share entries
 *   - settleAccruedBalance() → marks all ledger entries as settled, returns total
 */

import type { Pool, PoolClient } from "pg";

export type DeferredPoolState = {
  active: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  notes: string;
};

export type DeferredPoolLedgerEntry = {
  ledgerId: string;
  pairId: string;
  atticusShareUsdc: number;
  upliftUsdc: number;
  accruedAt: string;
  settledAt: string | null;
};

export const ensureDeferredPoolSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_deferred_pool_state (
      singleton_key TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (singleton_key = 'singleton'),
      active BOOLEAN NOT NULL DEFAULT FALSE,
      activated_at TIMESTAMPTZ,
      deactivated_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT ''
    );
  `);
  await pool.query(`
    INSERT INTO two_sided_deferred_pool_state (singleton_key) VALUES ('singleton')
    ON CONFLICT DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_deferred_pool_ledger (
      ledger_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      atticus_share_usdc NUMERIC(20, 8) NOT NULL,
      uplift_usdc NUMERIC(20, 8) NOT NULL,
      accrued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );
  `);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_deferred_pool_ledger_pair_idx ON two_sided_deferred_pool_ledger(pair_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS two_sided_deferred_pool_ledger_unsettled_idx ON two_sided_deferred_pool_ledger(settled_at);`);
  } catch {/* pg-mem may not support */}
};

export const getPoolState = async (pool: Pool | PoolClient): Promise<DeferredPoolState> => {
  const r = await pool.query(`SELECT * FROM two_sided_deferred_pool_state WHERE singleton_key = 'singleton'`);
  const row = r.rows[0];
  return {
    active: Boolean(row?.active),
    activatedAt: row?.activated_at ?? null,
    deactivatedAt: row?.deactivated_at ?? null,
    notes: row?.notes ?? ""
  };
};

export const togglePool = async (pool: Pool | PoolClient, active: boolean, notes = ""): Promise<DeferredPoolState> => {
  const now = new Date().toISOString();
  if (active) {
    await pool.query(
      `UPDATE two_sided_deferred_pool_state
       SET active = TRUE, activated_at = $1, deactivated_at = NULL, notes = $2
       WHERE singleton_key = 'singleton'`,
      [now, notes]
    );
  } else {
    await pool.query(
      `UPDATE two_sided_deferred_pool_state
       SET active = FALSE, deactivated_at = $1, notes = $2
       WHERE singleton_key = 'singleton'`,
      [now, notes]
    );
  }
  return getPoolState(pool);
};

export const recordAccrual = async (
  pool: Pool | PoolClient,
  input: { ledgerId: string; pairId: string; atticusShareUsdc: number; upliftUsdc: number }
): Promise<DeferredPoolLedgerEntry> => {
  const r = await pool.query(
    `INSERT INTO two_sided_deferred_pool_ledger (ledger_id, pair_id, atticus_share_usdc, uplift_usdc)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [input.ledgerId, input.pairId, input.atticusShareUsdc, input.upliftUsdc]
  );
  const row = r.rows[0];
  return {
    ledgerId: row.ledger_id,
    pairId: row.pair_id,
    atticusShareUsdc: Number(row.atticus_share_usdc),
    upliftUsdc: Number(row.uplift_usdc),
    accruedAt: row.accrued_at,
    settledAt: row.settled_at ?? null
  };
};

export const getPoolBalance = async (pool: Pool | PoolClient): Promise<{ unsettledUsdc: number; entryCount: number }> => {
  const r = await pool.query(
    `SELECT COALESCE(SUM(atticus_share_usdc), 0) AS total, COUNT(*)::int AS n
     FROM two_sided_deferred_pool_ledger
     WHERE settled_at IS NULL`
  );
  return { unsettledUsdc: Number(r.rows[0]?.total ?? 0), entryCount: r.rows[0]?.n ?? 0 };
};

export const settleAccruedBalance = async (
  pool: Pool | PoolClient
): Promise<{ settledUsdc: number; entryCount: number }> => {
  const now = new Date().toISOString();
  const r = await pool.query(
    `UPDATE two_sided_deferred_pool_ledger
     SET settled_at = $1
     WHERE settled_at IS NULL
     RETURNING atticus_share_usdc`,
    [now]
  );
  const total = r.rows.reduce((s: number, row: { atticus_share_usdc: string | number }) => s + Number(row.atticus_share_usdc), 0);
  return { settledUsdc: total, entryCount: r.rows.length };
};
