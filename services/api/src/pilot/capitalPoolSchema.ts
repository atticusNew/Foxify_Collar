import type { Pool } from "pg";

/**
 * WS#0 (Bundle C cutover, rev 6) — Foxify capital segregation schema.
 *
 * Three additive tables enabling the two-pool architecture:
 *
 *   pilot_capital_pools     — pool definitions (Atticus hedge / Foxify trader)
 *   pilot_pool_ledger       — every dollar in/out of either pool
 *   pilot_settlement_runs   — weekly + end-of-period settlement runs
 *
 * Plus a helper view:
 *
 *   pilot_pool_balances     — current balance + T+5/T+7 withdrawable per pool
 *
 * Migration is IDEMPOTENT (CREATE TABLE IF NOT EXISTS). Safe to call on
 * every boot. Adds zero risk to existing tables/data.
 *
 * Foxify deposit starts at $0 in rev 6 (per user 2026-05-13 reply 3).
 * Architecture supports later pre-funding without code change — operator
 * inserts a row into pilot_capital_pools + a deposit ledger entry.
 *
 * Schema is operator-tunable via UPDATE statements without code change:
 *   - withdrawal_lockup_days    (T+5 vs T+7 etc.)
 *   - weekly_distribution_pct   (25% default)
 *   - end_of_period_distribution_pct (75% default)
 */

export const ensureCapitalPoolSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_capital_pools (
      pool_id TEXT PRIMARY KEY,
      pool_name TEXT NOT NULL,
      bullish_trading_account_id TEXT,
      partner TEXT NOT NULL,
      initial_deposit_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      target_balance_usdc NUMERIC(20, 8),
      withdrawal_lockup_days INTEGER NOT NULL DEFAULT 7,
      weekly_distribution_pct NUMERIC(6, 4) NOT NULL DEFAULT 0.25,
      end_of_period_distribution_pct NUMERIC(6, 4) NOT NULL DEFAULT 0.75,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT pilot_capital_pools_partner_check
        CHECK (partner IN ('atticus', 'foxify')),
      CONSTRAINT pilot_capital_pools_status_check
        CHECK (status IN ('active', 'paused', 'closed')),
      CONSTRAINT pilot_capital_pools_distributions_sum
        CHECK (weekly_distribution_pct + end_of_period_distribution_pct <= 1.0)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_pool_ledger (
      id BIGSERIAL PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES pilot_capital_pools(pool_id),
      protection_id TEXT,
      entry_type TEXT NOT NULL,
      amount_usdc NUMERIC(20, 8) NOT NULL,
      reference TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reversed_by_id BIGINT REFERENCES pilot_pool_ledger(id),
      CONSTRAINT pilot_pool_ledger_entry_type_check CHECK (
        entry_type IN (
          'deposit',
          'withdrawal',
          'premium_in',
          'premium_out',
          'payout_out',
          'hedge_buy_out',
          'hedge_sell_in',
          'weekly_distribution_out',
          'end_of_period_distribution_out',
          'reconciliation_adjustment'
        )
      )
    );
  `);

  // Index creation is best-effort — wrap in try/catch since pg-mem
  // (used in tests) doesn't support CREATE INDEX IF NOT EXISTS, and on
  // re-runs against real Postgres the second create would error too
  // without the IF NOT EXISTS qualifier. Both pg-mem and real Postgres
  // behave correctly here: best-effort idempotent creation.
  const safeCreateIndex = async (sql: string): Promise<void> => {
    try { await pool.query(sql); } catch { /* index may already exist */ }
  };
  await safeCreateIndex(`
    CREATE INDEX idx_pilot_pool_ledger_pool_created
      ON pilot_pool_ledger (pool_id, created_at)
  `);
  await safeCreateIndex(`
    CREATE INDEX idx_pilot_pool_ledger_protection
      ON pilot_pool_ledger (protection_id)
  `);
  await safeCreateIndex(`
    CREATE INDEX idx_pilot_pool_ledger_effective
      ON pilot_pool_ledger (effective_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pilot_settlement_runs (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES pilot_capital_pools(pool_id),
      settlement_type TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      total_premium_in_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      total_payout_out_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      total_hedge_buy_out_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      total_hedge_sell_in_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      net_pnl_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      distributable_usdc NUMERIC(20, 8) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      payment_tx_ref TEXT,
      report_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT pilot_settlement_runs_type_check
        CHECK (settlement_type IN ('weekly_25', 'end_of_period_75', 'manual')),
      CONSTRAINT pilot_settlement_runs_status_check
        CHECK (status IN ('draft', 'approved', 'paid', 'failed', 'cancelled')),
      CONSTRAINT pilot_settlement_runs_period_order
        CHECK (period_end > period_start)
    );
  `);

  await safeCreateIndex(`
    CREATE INDEX idx_pilot_settlement_runs_pool_status
      ON pilot_settlement_runs (pool_id, status, created_at)
  `);

  // View — current balance + T+5/T+7 withdrawable per pool.
  // Drop+create so changes to the view definition apply on redeploy.
  // Wrap in try/catch — pg-mem doesn't support DROP VIEW IF EXISTS, and
  // first run on real Postgres has nothing to drop.
  try { await pool.query(`DROP VIEW pilot_pool_balances`); } catch { /* ok */ }
  try { await pool.query(`
    CREATE VIEW pilot_pool_balances AS
    SELECT
      pool_id,
      SUM(amount_usdc) AS current_balance_usdc,
      SUM(CASE WHEN effective_at <= NOW() - INTERVAL '7 days'
              THEN amount_usdc ELSE 0 END) AS withdrawable_balance_usdc_t7,
      SUM(CASE WHEN effective_at <= NOW() - INTERVAL '5 days'
              THEN amount_usdc ELSE 0 END) AS withdrawable_balance_usdc_t5,
      MAX(effective_at) FILTER (WHERE entry_type = 'deposit')
        AS last_deposit_at,
      COUNT(*) AS ledger_entry_count
    FROM pilot_pool_ledger
    WHERE reversed_by_id IS NULL
    GROUP BY pool_id;
  `); } catch { /* pg-mem may not support FILTER clause; getPoolBalance has fallback */ }
};

/**
 * Insert the canonical seed rows for the Atticus and Foxify pools.
 * Idempotent — uses ON CONFLICT to skip if already seeded.
 *
 * Atticus pool: $12,000 initial deposit (rev 6 lock).
 * Foxify pool: $0 initial deposit (rev 6 lock — pre-funding deferred).
 *
 * If Foxify later pre-funds, operator records via the deposit ledger
 * entry (no need to update this seed).
 */
export const seedCapitalPoolsIfNeeded = async (pool: Pool): Promise<void> => {
  await pool.query(`
    INSERT INTO pilot_capital_pools
      (pool_id, pool_name, partner, initial_deposit_usdc,
       target_balance_usdc, withdrawal_lockup_days,
       weekly_distribution_pct, end_of_period_distribution_pct, status)
    VALUES
      ('atticus_hedge', 'Atticus Hedge Pool', 'atticus', 12000, 12000, 7, 0.0, 0.0, 'active'),
      ('foxify_trader', 'Foxify Trader Pool', 'foxify', 0, 25000, 7, 0.25, 0.75, 'active')
    ON CONFLICT (pool_id) DO NOTHING;
  `);
};
