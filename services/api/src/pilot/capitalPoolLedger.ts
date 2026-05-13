import type { Pool, PoolClient } from "pg";

/**
 * WS#0 (Bundle C cutover, rev 6) — Capital pool ledger CRUD.
 *
 * Pure data access for the pilot_pool_ledger table. Used by:
 *   - admin endpoints (deposit, withdraw, settlement)
 *   - settlement runner (computes period totals)
 *   - downstream activate/trigger paths (premium_in, payout_out, etc.)
 *
 * Money convention: amount_usdc is SIGNED.
 *   Positive = inflow to pool
 *   Negative = outflow from pool
 *
 * Examples:
 *   Foxify deposit:           +25000 to foxify_trader pool
 *   Trader pays premium:      +50    to foxify_trader pool (Interpretation A)
 *                             -50    from foxify_trader pool to atticus
 *                                    (depending on Interpretation A/B)
 *   Trigger payout to trader: -1000  from foxify_trader pool
 *   Atticus buys hedge:       -85    from atticus_hedge pool
 *   TP recovery proceeds:     +60    to atticus_hedge pool
 *   Weekly settlement:        -X     from foxify_trader pool (paid out)
 *
 * Interpretation A (rev 6 default per user 2026-05-13 reply):
 *   Foxify pool acts as trader-facing balance.
 *   premium_in = trader bought protection; pool grew
 *   payout_out = trigger fired; pool paid out
 *   weekly_distribution_out = 25% of net P&L paid to Foxify wallet
 */

export type PoolId = "atticus_hedge" | "foxify_trader";
export type LedgerEntryType =
  | "deposit"
  | "withdrawal"
  | "premium_in"
  | "premium_out"
  | "payout_out"
  | "hedge_buy_out"
  | "hedge_sell_in"
  | "weekly_distribution_out"
  | "end_of_period_distribution_out"
  | "reconciliation_adjustment";

export type LedgerEntry = {
  id: number;
  poolId: PoolId;
  protectionId: string | null;
  entryType: LedgerEntryType;
  amountUsdc: string; // string to preserve numeric precision
  reference: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  effectiveAt: string;
  reversedById: number | null;
};

export type PoolBalance = {
  poolId: PoolId;
  currentBalanceUsdc: string;
  withdrawableBalanceUsdcT5: string;
  withdrawableBalanceUsdcT7: string;
  lastDepositAt: string | null;
  ledgerEntryCount: number;
};

export const insertLedgerEntry = async (
  pool: Pool | PoolClient,
  entry: {
    poolId: PoolId;
    protectionId?: string | null;
    entryType: LedgerEntryType;
    amountUsdc: string | number;
    reference?: string | null;
    metadata?: Record<string, unknown>;
    effectiveAt?: string;
  }
): Promise<LedgerEntry> => {
  const result = await pool.query(
    `INSERT INTO pilot_pool_ledger
       (pool_id, protection_id, entry_type, amount_usdc, reference, metadata, effective_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
     RETURNING id, pool_id, protection_id, entry_type, amount_usdc, reference,
               metadata, created_at, effective_at, reversed_by_id`,
    [
      entry.poolId,
      entry.protectionId ?? null,
      entry.entryType,
      String(entry.amountUsdc),
      entry.reference ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.effectiveAt ?? null
    ]
  );
  return rowToLedgerEntry(result.rows[0]);
};

export const getPoolBalance = async (
  pool: Pool | PoolClient,
  poolId: PoolId
): Promise<PoolBalance | null> => {
  const result = await pool.query(
    `SELECT pool_id, current_balance_usdc, withdrawable_balance_usdc_t5,
            withdrawable_balance_usdc_t7, last_deposit_at, ledger_entry_count
     FROM pilot_pool_balances WHERE pool_id = $1`,
    [poolId]
  );
  const r = result.rows[0];
  if (!r) {
    // No ledger entries yet; report zero balance with the correct pool ID
    const exists = await pool.query(
      "SELECT 1 FROM pilot_capital_pools WHERE pool_id = $1",
      [poolId]
    );
    if (exists.rows.length === 0) return null;
    return {
      poolId,
      currentBalanceUsdc: "0",
      withdrawableBalanceUsdcT5: "0",
      withdrawableBalanceUsdcT7: "0",
      lastDepositAt: null,
      ledgerEntryCount: 0
    };
  }
  return {
    poolId: r.pool_id as PoolId,
    currentBalanceUsdc: String(r.current_balance_usdc ?? "0"),
    withdrawableBalanceUsdcT5: String(r.withdrawable_balance_usdc_t5 ?? "0"),
    withdrawableBalanceUsdcT7: String(r.withdrawable_balance_usdc_t7 ?? "0"),
    lastDepositAt: r.last_deposit_at ? new Date(r.last_deposit_at).toISOString() : null,
    ledgerEntryCount: Number(r.ledger_entry_count ?? 0)
  };
};

export const listLedgerEntries = async (
  pool: Pool | PoolClient,
  params: {
    poolId: PoolId;
    fromMs?: number;
    toMs?: number;
    limit?: number;
    offset?: number;
  }
): Promise<LedgerEntry[]> => {
  const limit = Math.min(1000, Math.max(1, params.limit ?? 100));
  const offset = Math.max(0, params.offset ?? 0);
  const fromIso = params.fromMs ? new Date(params.fromMs).toISOString() : null;
  const toIso = params.toMs ? new Date(params.toMs).toISOString() : null;
  const result = await pool.query(
    `SELECT id, pool_id, protection_id, entry_type, amount_usdc, reference,
            metadata, created_at, effective_at, reversed_by_id
     FROM pilot_pool_ledger
     WHERE pool_id = $1
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)
       AND reversed_by_id IS NULL
     ORDER BY created_at DESC
     LIMIT $4 OFFSET $5`,
    [params.poolId, fromIso, toIso, limit, offset]
  );
  return result.rows.map(rowToLedgerEntry);
};

/**
 * Sum ledger entries by entry type for a given period.
 * Used by settlement runs to compute totals.
 */
export const sumLedgerByType = async (
  pool: Pool | PoolClient,
  params: { poolId: PoolId; periodStart: Date; periodEnd: Date }
): Promise<Record<LedgerEntryType, string>> => {
  const result = await pool.query(
    `SELECT entry_type, SUM(amount_usdc) AS total
     FROM pilot_pool_ledger
     WHERE pool_id = $1
       AND created_at >= $2
       AND created_at < $3
       AND reversed_by_id IS NULL
     GROUP BY entry_type`,
    [params.poolId, params.periodStart.toISOString(), params.periodEnd.toISOString()]
  );
  const totals: Record<string, string> = {
    deposit: "0",
    withdrawal: "0",
    premium_in: "0",
    premium_out: "0",
    payout_out: "0",
    hedge_buy_out: "0",
    hedge_sell_in: "0",
    weekly_distribution_out: "0",
    end_of_period_distribution_out: "0",
    reconciliation_adjustment: "0"
  };
  for (const r of result.rows) {
    totals[String(r.entry_type)] = String(r.total ?? "0");
  }
  return totals as Record<LedgerEntryType, string>;
};

const rowToLedgerEntry = (row: any): LedgerEntry => ({
  id: Number(row.id),
  poolId: row.pool_id as PoolId,
  protectionId: row.protection_id,
  entryType: row.entry_type as LedgerEntryType,
  amountUsdc: String(row.amount_usdc),
  reference: row.reference,
  metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {}),
  createdAt: new Date(row.created_at).toISOString(),
  effectiveAt: new Date(row.effective_at).toISOString(),
  reversedById: row.reversed_by_id !== null ? Number(row.reversed_by_id) : null
});
