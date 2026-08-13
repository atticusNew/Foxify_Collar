import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  sumLedgerByType,
  insertLedgerEntry,
  type PoolId,
  type LedgerEntryType
} from "./capitalPoolLedger";

/**
 * WS#0 (Bundle C cutover, rev 6) — Weekly settlement runner.
 *
 * Computes a draft settlement run for a given pool over a given period,
 * persists it as 'draft' status, and (when approved by operator) emits
 * the corresponding ledger entries for distribution.
 *
 * Cadence:
 *   - Weekly: 25% of net P&L → Foxify wallet
 *   - End-of-period: 75% retained P&L → Foxify wallet (final settlement)
 *
 * Both run via admin-triggered endpoints (no auto-cron until operator
 * confirms the math on dry-runs). This keeps Foxify's first money flow
 * under explicit human approval.
 *
 * Net P&L formula (Interpretation A per rev 6):
 *   net_pnl = total_premium_in
 *           + total_hedge_sell_in
 *           - total_payout_out
 *           - total_hedge_buy_out
 *
 * Distributable amount = net_pnl × pct_for_settlement_type
 *   weekly_25 → 25%
 *   end_of_period_75 → 75%
 */

export type SettlementType = "weekly_25" | "end_of_period_75" | "manual";
export type SettlementStatus = "draft" | "approved" | "paid" | "failed" | "cancelled";

export type SettlementRun = {
  id: string;
  poolId: PoolId;
  settlementType: SettlementType;
  periodStart: string;
  periodEnd: string;
  totalPremiumInUsdc: string;
  totalPayoutOutUsdc: string;
  totalHedgeBuyOutUsdc: string;
  totalHedgeSellInUsdc: string;
  netPnLUsdc: string;
  distributableUsdc: string;
  status: SettlementStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  paymentTxRef: string | null;
  reportUrl: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const SETTLEMENT_PCT: Record<SettlementType, number> = {
  weekly_25: 0.25,
  end_of_period_75: 0.75,
  manual: 1.0
};

/**
 * Compute settlement totals from the ledger (pure function — no writes).
 */
export const computeSettlementTotals = async (params: {
  pool: Pool;
  poolId: PoolId;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{
  totalPremiumInUsdc: number;
  totalPayoutOutUsdc: number;
  totalHedgeBuyOutUsdc: number;
  totalHedgeSellInUsdc: number;
  netPnLUsdc: number;
}> => {
  const totals = await sumLedgerByType(params.pool, {
    poolId: params.poolId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd
  });
  // sumLedgerByType returns signed amounts (premium_in positive, payout_out negative, etc.)
  // but the ledger convention has payout_out and hedge_buy_out STORED as negative numbers.
  // We want absolute values for the "out" totals when reporting.
  const premiumIn = Number(totals.premium_in || 0);
  const payoutOutAbs = Math.abs(Number(totals.payout_out || 0));
  const hedgeBuyOutAbs = Math.abs(Number(totals.hedge_buy_out || 0));
  const hedgeSellIn = Number(totals.hedge_sell_in || 0);
  // Net P&L: premium income + hedge recovery - payouts - hedge cost
  const netPnL = premiumIn + hedgeSellIn - payoutOutAbs - hedgeBuyOutAbs;
  return {
    totalPremiumInUsdc: premiumIn,
    totalPayoutOutUsdc: payoutOutAbs,
    totalHedgeBuyOutUsdc: hedgeBuyOutAbs,
    totalHedgeSellInUsdc: hedgeSellIn,
    netPnLUsdc: netPnL
  };
};

/**
 * Create a draft settlement run. Computes totals, stores as 'draft',
 * does NOT emit any distribution ledger entries (those happen on approve).
 */
export const createDraftSettlement = async (params: {
  pool: Pool;
  poolId: PoolId;
  settlementType: SettlementType;
  periodStart: Date;
  periodEnd: Date;
  metadata?: Record<string, unknown>;
}): Promise<SettlementRun> => {
  const totals = await computeSettlementTotals(params);
  const distributable =
    totals.netPnLUsdc > 0
      ? totals.netPnLUsdc * SETTLEMENT_PCT[params.settlementType]
      : 0;

  const id = `set_${randomUUID()}`;
  const result = await params.pool.query(
    `INSERT INTO pilot_settlement_runs (
       id, pool_id, settlement_type, period_start, period_end,
       total_premium_in_usdc, total_payout_out_usdc, total_hedge_buy_out_usdc,
       total_hedge_sell_in_usdc, net_pnl_usdc, distributable_usdc,
       status, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft', $12
     )
     RETURNING *`,
    [
      id,
      params.poolId,
      params.settlementType,
      params.periodStart.toISOString(),
      params.periodEnd.toISOString(),
      totals.totalPremiumInUsdc.toString(),
      totals.totalPayoutOutUsdc.toString(),
      totals.totalHedgeBuyOutUsdc.toString(),
      totals.totalHedgeSellInUsdc.toString(),
      totals.netPnLUsdc.toString(),
      distributable.toString(),
      JSON.stringify(params.metadata || {})
    ]
  );
  return rowToSettlementRun(result.rows[0]);
};

/**
 * Approve a draft settlement run. Emits the distribution ledger entry
 * (negative amount, type weekly_distribution_out or end_of_period_distribution_out).
 *
 * Requires status='draft'. Idempotent if status is already 'approved' or 'paid'
 * (returns the existing record without re-emitting the ledger entry).
 */
export const approveSettlement = async (params: {
  pool: Pool;
  settlementId: string;
  actor: string;
  paymentTxRef?: string;
}): Promise<SettlementRun> => {
  const existing = await params.pool.query(
    "SELECT * FROM pilot_settlement_runs WHERE id = $1",
    [params.settlementId]
  );
  if (existing.rows.length === 0) {
    throw new Error("settlement_not_found");
  }
  const run = rowToSettlementRun(existing.rows[0]);
  if (run.status === "approved" || run.status === "paid") {
    return run; // idempotent
  }
  if (run.status !== "draft") {
    throw new Error(`settlement_not_approvable:${run.status}`);
  }

  const distributable = Number(run.distributableUsdc);
  if (distributable > 0) {
    const entryType: LedgerEntryType =
      run.settlementType === "end_of_period_75"
        ? "end_of_period_distribution_out"
        : "weekly_distribution_out";
    await insertLedgerEntry(params.pool, {
      poolId: run.poolId,
      entryType,
      amountUsdc: -Math.abs(distributable),
      reference: `settlement:${run.id}`,
      metadata: {
        settlementId: run.id,
        approvedBy: params.actor,
        paymentTxRef: params.paymentTxRef || null
      }
    });
  }

  const updateResult = await params.pool.query(
    `UPDATE pilot_settlement_runs
     SET status = 'approved',
         approved_by = $2,
         approved_at = NOW(),
         paid_at = NOW(),
         payment_tx_ref = $3
     WHERE id = $1
     RETURNING *`,
    [params.settlementId, params.actor, params.paymentTxRef || null]
  );
  return rowToSettlementRun(updateResult.rows[0]);
};

/**
 * List recent settlement runs (defaults to last 10).
 */
export const listRecentSettlements = async (params: {
  pool: Pool;
  poolId?: PoolId;
  limit?: number;
}): Promise<SettlementRun[]> => {
  const limit = Math.min(100, Math.max(1, params.limit ?? 10));
  const result = params.poolId
    ? await params.pool.query(
        `SELECT * FROM pilot_settlement_runs WHERE pool_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [params.poolId, limit]
      )
    : await params.pool.query(
        `SELECT * FROM pilot_settlement_runs ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
  return result.rows.map(rowToSettlementRun);
};

/**
 * Generate a Foxify-shareable Markdown report for a settlement run.
 */
export const generateSettlementReport = (run: SettlementRun): string => {
  const fmtUsd = (n: number | string): string => {
    const num = Number(n);
    const sign = num < 0 ? "-" : "";
    return `${sign}$${Math.abs(num).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  };
  const periodStartIso = run.periodStart.split("T")[0];
  const periodEndIso = run.periodEnd.split("T")[0];

  return `# Foxify Pilot — Settlement Report (${run.settlementType})

**Period:** ${periodStartIso} to ${periodEndIso}
**Pool:** ${run.poolId}
**Settlement ID:** ${run.id}
**Status:** ${run.status}
${run.approvedBy ? `**Approved by:** ${run.approvedBy} at ${run.approvedAt}` : ""}
${run.paymentTxRef ? `**Payment ref:** ${run.paymentTxRef}` : ""}

## Money flow this period

| Component                  | USD |
|----------------------------|-----|
| Premium income (in)        | ${fmtUsd(run.totalPremiumInUsdc)} |
| Payouts to triggered (out) | -${fmtUsd(run.totalPayoutOutUsdc)} |
| Hedge cost (out)           | -${fmtUsd(run.totalHedgeBuyOutUsdc)} |
| TP recovery (in)           | ${fmtUsd(run.totalHedgeSellInUsdc)} |
| **Net P&L**                | **${fmtUsd(run.netPnLUsdc)}** |

## Settlement

| Item | Amount |
|------|--------|
| Distribution % | ${(SETTLEMENT_PCT[run.settlementType] * 100).toFixed(0)}% of net P&L |
| Distributable amount | ${fmtUsd(run.distributableUsdc)} |
| Withholding (retained for end-of-pilot) | ${fmtUsd(Number(run.netPnLUsdc) - Number(run.distributableUsdc))} |

${Number(run.distributableUsdc) > 0 ? `**Status:** ${run.status === "approved" ? "Approved — payment processed" : "Awaiting operator approval"}` : "**Status:** No distribution this period (net P&L was negative or zero)"}

---
*Generated automatically by the Atticus settlement runner. Questions: ops@atticus.*`;
};

const rowToSettlementRun = (row: any): SettlementRun => ({
  id: String(row.id),
  poolId: row.pool_id as PoolId,
  settlementType: row.settlement_type as SettlementType,
  periodStart: new Date(row.period_start).toISOString(),
  periodEnd: new Date(row.period_end).toISOString(),
  totalPremiumInUsdc: String(row.total_premium_in_usdc ?? "0"),
  totalPayoutOutUsdc: String(row.total_payout_out_usdc ?? "0"),
  totalHedgeBuyOutUsdc: String(row.total_hedge_buy_out_usdc ?? "0"),
  totalHedgeSellInUsdc: String(row.total_hedge_sell_in_usdc ?? "0"),
  netPnLUsdc: String(row.net_pnl_usdc ?? "0"),
  distributableUsdc: String(row.distributable_usdc ?? "0"),
  status: row.status as SettlementStatus,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  paymentTxRef: row.payment_tx_ref,
  reportUrl: row.report_url,
  metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {}),
  createdAt: new Date(row.created_at).toISOString()
});
