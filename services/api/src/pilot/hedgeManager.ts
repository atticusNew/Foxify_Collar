import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import { computePutRecoveryValue } from "./blackScholes";
import type { PilotVenueAdapter } from "./venue";

type ManagedHedge = {
  protectionId: string;
  instrumentId: string;
  venue: string;
  quantity: number;
  entryPremium: number;
  strike: number;
  expiryMs: number;
  hedgeStatus: string;
  slPct: number | null;
  payoutDueAmount: number;
  metadata: Record<string, unknown>;
};

type HedgeManagementResult = {
  scanned: number;
  tpSold: number;
  expired: number;
  errors: number;
};

const RISK_FREE_RATE = 0;

const queryManagedHedges = async (pool: Pool): Promise<ManagedHedge[]> => {
  const result = await pool.query(`
    SELECT id, instrument_id, venue, size, premium, metadata,
           expiry_at, hedge_status, sl_pct, payout_due_amount
    FROM pilot_protections
    WHERE hedge_status = 'active'
      AND instrument_id IS NOT NULL
      AND size IS NOT NULL
      AND (status = 'triggered' OR status = 'active')
    ORDER BY expiry_at ASC
    LIMIT 200
  `);
  return result.rows.map((row: Record<string, unknown>) => ({
    protectionId: String(row.id),
    instrumentId: String(row.instrument_id || ""),
    venue: String(row.venue || ""),
    quantity: Number(row.size || 0),
    entryPremium: Number(row.premium || 0),
    strike: Number((row.metadata as Record<string, unknown>)?.triggerPrice || 0),
    expiryMs: new Date(String(row.expiry_at)).getTime(),
    hedgeStatus: String(row.hedge_status || "active"),
    slPct: row.sl_pct !== null && row.sl_pct !== undefined ? Number(row.sl_pct) : null,
    payoutDueAmount: Number(row.payout_due_amount || 0),
    metadata: (row.metadata || {}) as Record<string, unknown>
  }));
};

const updateHedgeStatus = async (
  pool: Pool,
  protectionId: string,
  hedgeStatus: string,
  metadata: Record<string, unknown>
): Promise<void> => {
  await pool.query(
    `UPDATE pilot_protections
     SET hedge_status = $1, metadata = metadata || $2::jsonb, updated_at = NOW()
     WHERE id = $3`,
    [hedgeStatus, JSON.stringify(metadata), protectionId]
  );
};

export const runHedgeManagementCycle = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
  currentSpot: number;
  currentIV: number;
}): Promise<HedgeManagementResult> => {
  const result: HedgeManagementResult = { scanned: 0, tpSold: 0, expired: 0, errors: 0 };
  const tpMultiplier = pilotConfig.v7.tpThresholdMultiplier;

  let hedges: ManagedHedge[];
  try {
    hedges = await queryManagedHedges(params.pool);
  } catch (err: any) {
    console.error(`[HedgeManager] Failed to query hedges: ${err?.message}`);
    return result;
  }
  result.scanned = hedges.length;

  for (const hedge of hedges) {
    try {
      const now = Date.now();
      const isNearExpiry = hedge.expiryMs - now < 24 * 3600 * 1000;
      const isExpired = hedge.expiryMs <= now;

      if (isExpired) {
        await updateHedgeStatus(params.pool, hedge.protectionId, "expired_settled", {
          hedgeManagerAction: "expired",
          expiredAt: new Date().toISOString()
        });
        result.expired++;
        continue;
      }

      if (hedge.quantity <= 0 || hedge.strike <= 0) continue;

      const recovery = computePutRecoveryValue({
        currentSpot: params.currentSpot,
        strike: hedge.strike,
        expiryMs: hedge.expiryMs,
        sigma: params.currentIV / 100,
        riskFreeRate: RISK_FREE_RATE,
        nowMs: now
      });

      const optionValuePerUnit = recovery.totalValue;
      const totalOptionValue = optionValuePerUnit * hedge.quantity;
      const tpTarget = hedge.payoutDueAmount > 0
        ? hedge.payoutDueAmount * tpMultiplier
        : hedge.entryPremium * 2;

      const shouldTakeProfit = totalOptionValue >= tpTarget;
      const shouldSellNearExpiry = isNearExpiry && recovery.intrinsicValue > 0;

      if (shouldTakeProfit || shouldSellNearExpiry) {
        const reason = shouldTakeProfit ? "take_profit" : "near_expiry_itm";
        console.log(
          `[HedgeManager] ${reason}: protection=${hedge.protectionId} optionValue=$${totalOptionValue.toFixed(2)} target=$${tpTarget.toFixed(2)} intrinsic=$${(recovery.intrinsicValue * hedge.quantity).toFixed(2)}`
        );

        if (params.venue.sellOption) {
          const sellResult = await params.venue.sellOption({
            instrumentId: hedge.instrumentId,
            quantity: hedge.quantity
          });

          if (sellResult.status === "sold") {
            await updateHedgeStatus(params.pool, hedge.protectionId, "tp_sold", {
              hedgeManagerAction: reason,
              sellResult: {
                fillPrice: sellResult.fillPrice,
                totalProceeds: sellResult.totalProceeds,
                orderId: sellResult.orderId
              },
              bsRecovery: {
                totalValue: totalOptionValue,
                intrinsicValue: recovery.intrinsicValue * hedge.quantity,
                timeValue: recovery.timeValue * hedge.quantity
              },
              soldAt: new Date().toISOString()
            });
            result.tpSold++;
          } else {
            console.warn(`[HedgeManager] Sell failed for ${hedge.protectionId}: ${JSON.stringify(sellResult.details)}`);
            result.errors++;
          }
        }
      }
    } catch (err: any) {
      console.error(`[HedgeManager] Error processing ${hedge.protectionId}: ${err?.message}`);
      result.errors++;
    }
  }

  console.log(
    `[HedgeManager] Cycle complete: scanned=${result.scanned} tpSold=${result.tpSold} expired=${result.expired} errors=${result.errors}`
  );
  return result;
};
