import type { Pool, PoolClient } from "pg";
import { insertLedgerEntry, type PoolId } from "./capitalPoolLedger";

/**
 * WS#0 (Bundle C cutover, rev 6) — Pool lifecycle hooks.
 *
 * Wraps the capital pool ledger writes that should happen at each
 * stage of a protection's lifecycle:
 *
 *   - Activate success → Foxify pool gains premium_in; Atticus pool loses hedge_buy_out
 *   - Trigger fires    → Foxify pool loses payout_out
 *   - TP sell succeeds → Atticus pool gains hedge_sell_in
 *
 * All writes are best-effort. Failure to write a ledger entry MUST NOT
 * fail the user-facing trade flow — the capital pool architecture is
 * accounting infrastructure, not load-bearing for protection delivery.
 *
 * Each hook is a thin wrapper around insertLedgerEntry that:
 *   1. Logs the intent (operator visibility)
 *   2. Inserts the ledger entry
 *   3. Catches and logs any error without throwing
 *
 * If the capital pool migration didn't run (e.g. fresh deploy hasn't
 * picked up the schema yet), all hooks silently no-op.
 */

const FOXIFY_POOL: PoolId = "foxify_trader";
const ATTICUS_POOL: PoolId = "atticus_hedge";

/**
 * Called after a successful protection activation. Writes:
 *   - Foxify pool:  +premium_in (client paid this premium → pool gains)
 *   - Atticus pool: -hedge_buy_out (we paid the venue this much → pool loses)
 *
 * Both writes use the same protection_id so /admin/pools/:id/ledger?protection=
 * can show the per-protection trace.
 */
export const recordActivationLedgerWrites = async (params: {
  pool: Pool | PoolClient;
  protectionId: string;
  clientPremiumUsd: number;
  hedgeCostUsd: number;
  marketId: string;
  externalOrderId: string | null;
}): Promise<void> => {
  // Foxify pool: premium_in
  if (params.clientPremiumUsd > 0) {
    try {
      await insertLedgerEntry(params.pool, {
        poolId: FOXIFY_POOL,
        protectionId: params.protectionId,
        entryType: "premium_in",
        amountUsdc: params.clientPremiumUsd,
        reference: `activate:${params.protectionId}`,
        metadata: {
          marketId: params.marketId,
          source: "activate_handler"
        }
      });
    } catch (err: any) {
      console.warn(
        `[PoolHooks] foxify premium_in write failed for ${params.protectionId}: ${err?.message ?? err}`
      );
    }
  }

  // Atticus pool: hedge_buy_out (signed negative)
  if (params.hedgeCostUsd > 0) {
    try {
      await insertLedgerEntry(params.pool, {
        poolId: ATTICUS_POOL,
        protectionId: params.protectionId,
        entryType: "hedge_buy_out",
        amountUsdc: -Math.abs(params.hedgeCostUsd),
        reference: `activate:${params.protectionId}`,
        metadata: {
          marketId: params.marketId,
          externalOrderId: params.externalOrderId,
          source: "activate_handler"
        }
      });
    } catch (err: any) {
      console.warn(
        `[PoolHooks] atticus hedge_buy_out write failed for ${params.protectionId}: ${err?.message ?? err}`
      );
    }
  }
};

/**
 * Called when a protection triggers (trigger monitor cycle). Writes:
 *   - Foxify pool: -payout_out (we owe the trader this much → pool loses)
 *
 * The actual payout settlement to the trader's external wallet is a
 * separate event tracked by /admin/protections/:id/payout-settled.
 * The ledger entry here represents the LIABILITY accrual at trigger time.
 */
export const recordTriggerLedgerWrite = async (params: {
  pool: Pool | PoolClient;
  protectionId: string;
  payoutOwedUsd: number;
}): Promise<void> => {
  if (params.payoutOwedUsd <= 0) return;
  try {
    await insertLedgerEntry(params.pool, {
      poolId: FOXIFY_POOL,
      protectionId: params.protectionId,
      entryType: "payout_out",
      amountUsdc: -Math.abs(params.payoutOwedUsd),
      reference: `trigger:${params.protectionId}`,
      metadata: {
        source: "trigger_monitor",
        triggeredAt: new Date().toISOString()
      }
    });
  } catch (err: any) {
    console.warn(
      `[PoolHooks] foxify payout_out write failed for ${params.protectionId}: ${err?.message ?? err}`
    );
  }
};

/**
 * Called when the hedge manager successfully sells the option (TP recovery).
 * Writes:
 *   - Atticus pool: +hedge_sell_in (we received this much from selling the option)
 *
 * The proceeds reduce the net effective hedge cost. Pool tracking lets
 * settlement runs compute true net P&L.
 */
export const recordTpSellLedgerWrite = async (params: {
  pool: Pool | PoolClient;
  protectionId: string;
  proceedsUsd: number;
  reason: string;
  orderId: string | null;
}): Promise<void> => {
  if (params.proceedsUsd <= 0) return;
  try {
    await insertLedgerEntry(params.pool, {
      poolId: ATTICUS_POOL,
      protectionId: params.protectionId,
      entryType: "hedge_sell_in",
      amountUsdc: params.proceedsUsd,
      reference: `tp_sell:${params.protectionId}`,
      metadata: {
        source: "hedge_manager",
        sellReason: params.reason,
        orderId: params.orderId,
        soldAt: new Date().toISOString()
      }
    });
  } catch (err: any) {
    console.warn(
      `[PoolHooks] atticus hedge_sell_in write failed for ${params.protectionId}: ${err?.message ?? err}`
    );
  }
};
