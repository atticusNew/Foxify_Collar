import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import { computePutRecoveryValue } from "./blackScholes";
import { bsCall } from "./blackScholes";
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
  protectionType: string;
  status: string;
  metadata: Record<string, unknown>;
};

type HedgeManagementResult = {
  scanned: number;
  tpSold: number;
  expired: number;
  errors: number;
  skipped: number;
};

const RISK_FREE_RATE = 0;

const queryManagedHedges = async (pool: Pool): Promise<ManagedHedge[]> => {
  const result = await pool.query(`
    SELECT id, instrument_id, venue, size, premium, metadata, side,
           expiry_at, hedge_status, sl_pct, payout_due_amount, status
    FROM pilot_protections
    WHERE hedge_status = 'active'
      AND instrument_id IS NOT NULL
      AND size IS NOT NULL
      AND (status = 'triggered' OR status = 'active')
    ORDER BY expiry_at ASC
    LIMIT 200
  `);
  return result.rows.map((row: Record<string, unknown>) => {
    const meta = (row.metadata || {}) as Record<string, unknown>;
    const protType = String(meta.protectionType || row.side || "long");
    const instrumentId = String(row.instrument_id || "");
    const strikeMatch = instrumentId.match(/(\d+)-(P|C)$/);
    const optionStrike = strikeMatch ? Number(strikeMatch[1]) : 0;
    return {
      protectionId: String(row.id),
      instrumentId,
      venue: String(row.venue || ""),
      quantity: Number(row.size || 0),
      entryPremium: Number(row.premium || 0),
      strike: optionStrike || Number(meta.triggerPrice || meta.floorPrice || 0),
      expiryMs: new Date(String(row.expiry_at)).getTime(),
      hedgeStatus: String(row.hedge_status || "active"),
      slPct: row.sl_pct !== null && row.sl_pct !== undefined ? Number(row.sl_pct) : null,
      payoutDueAmount: Number(row.payout_due_amount || 0),
      protectionType: protType === "short" ? "short" : "long",
      status: String(row.status || "active"),
      metadata: meta
    };
  });
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

const computeOptionValue = (params: {
  protectionType: string;
  currentSpot: number;
  strike: number;
  expiryMs: number;
  sigma: number;
  quantity: number;
  nowMs: number;
}): { totalValue: number; intrinsicValue: number; timeValue: number } => {
  if (params.protectionType === "short") {
    const T = Math.max(0, params.expiryMs - params.nowMs) / (365.25 * 24 * 3600 * 1000);
    const intrinsic = Math.max(0, params.currentSpot - params.strike);
    const total = T > 0 && params.sigma > 0
      ? bsCall(params.currentSpot, params.strike, T, RISK_FREE_RATE, params.sigma)
      : intrinsic;
    const timeVal = Math.max(0, total - intrinsic);
    return {
      totalValue: Math.max(intrinsic, total) * params.quantity,
      intrinsicValue: intrinsic * params.quantity,
      timeValue: timeVal * params.quantity
    };
  }
  const recovery = computePutRecoveryValue({
    currentSpot: params.currentSpot,
    strike: params.strike,
    expiryMs: params.expiryMs,
    sigma: params.sigma,
    riskFreeRate: RISK_FREE_RATE,
    nowMs: params.nowMs
  });
  return {
    totalValue: recovery.totalValue * params.quantity,
    intrinsicValue: recovery.intrinsicValue * params.quantity,
    timeValue: recovery.timeValue * params.quantity
  };
};

export const runHedgeManagementCycle = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
  currentSpot: number;
  currentIV: number;
}): Promise<HedgeManagementResult> => {
  const result: HedgeManagementResult = { scanned: 0, tpSold: 0, expired: 0, errors: 0, skipped: 0 };
  const tpMultiplier = pilotConfig.v7.tpThresholdMultiplier;

  let hedges: ManagedHedge[];
  try {
    hedges = await queryManagedHedges(params.pool);
  } catch (err: any) {
    console.error(`[HedgeManager] Failed to query hedges: ${err?.message}`);
    return result;
  }
  result.scanned = hedges.length;
  if (!hedges.length) return result;

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

      if (hedge.quantity <= 0 || hedge.strike <= 0) {
        console.log(`[HedgeManager] Skip ${hedge.protectionId}: qty=${hedge.quantity} strike=${hedge.strike}`);
        result.skipped++;
        continue;
      }

      // Only attempt TP sells on TRIGGERED protections
      if (hedge.status !== "triggered") {
        result.skipped++;
        continue;
      }

      console.log(`[HedgeManager] Processing triggered: ${hedge.protectionId} instrument=${hedge.instrumentId} qty=${hedge.quantity} strike=${hedge.strike} type=${hedge.protectionType}`);

      const optionVal = computeOptionValue({
        protectionType: hedge.protectionType,
        currentSpot: params.currentSpot,
        strike: hedge.strike,
        expiryMs: hedge.expiryMs,
        sigma: params.currentIV / 100,
        quantity: hedge.quantity,
        nowMs: now
      });

      const tpTarget = hedge.payoutDueAmount > 0
        ? hedge.payoutDueAmount * 0.5
        : hedge.entryPremium;

      const shouldTakeProfit = optionVal.totalValue >= tpTarget;
      const shouldSellNearExpiry = isNearExpiry && optionVal.totalValue > 10;
      const shouldSellAnyValue = optionVal.intrinsicValue > 0 && hedge.expiryMs - now < 4 * 3600 * 1000;

      if (!shouldTakeProfit && !shouldSellNearExpiry && !shouldSellAnyValue) continue;

      const reason = shouldTakeProfit ? "take_profit" : shouldSellAnyValue ? "near_expiry_salvage" : "near_expiry_itm";
      console.log(
        `[HedgeManager] ${reason}: protection=${hedge.protectionId} type=${hedge.protectionType} instrument=${hedge.instrumentId} optionValue=$${optionVal.totalValue.toFixed(2)} target=$${tpTarget.toFixed(2)} intrinsic=$${optionVal.intrinsicValue.toFixed(2)}`
      );

      const sellFn = typeof params.venue.sellOption === "function"
        ? params.venue.sellOption.bind(params.venue)
        : null;
      if (!sellFn) {
        console.warn(`[HedgeManager] sellOption not available on venue (type=${typeof params.venue.sellOption}, constructor=${params.venue.constructor?.name})`);
        result.skipped++;
        continue;
      }

      const sellQty = Math.max(0.1, Math.floor(hedge.quantity * 10) / 10);
      console.log(`[HedgeManager] Attempting sell: instrument=${hedge.instrumentId} qty=${sellQty} (raw=${hedge.quantity})`);

      try {
        const sellResult = await sellFn({
          instrumentId: hedge.instrumentId,
          quantity: sellQty
        });

        console.log(`[HedgeManager] Sell result: status=${sellResult.status} fillPrice=${sellResult.fillPrice} proceeds=${sellResult.totalProceeds} orderId=${sellResult.orderId}`);

        if (sellResult.status === "sold") {
          await updateHedgeStatus(params.pool, hedge.protectionId, "tp_sold", {
            hedgeManagerAction: reason,
            sellResult: {
              fillPrice: sellResult.fillPrice,
              totalProceeds: sellResult.totalProceeds,
              orderId: sellResult.orderId
            },
            bsRecovery: {
              totalValue: optionVal.totalValue,
              intrinsicValue: optionVal.intrinsicValue,
              timeValue: optionVal.timeValue
            },
            soldAt: new Date().toISOString()
          });
          result.tpSold++;
        } else {
          console.warn(`[HedgeManager] Sell FAILED for ${hedge.protectionId}: ${JSON.stringify(sellResult.details).slice(0, 300)}`);
          result.errors++;
        }
      } catch (sellErr: any) {
        console.error(`[HedgeManager] sellOption THREW for ${hedge.protectionId}: ${sellErr?.message}`);
        result.errors++;
      }
    } catch (err: any) {
      console.error(`[HedgeManager] Error processing ${hedge.protectionId}: ${err?.message}`);
      result.errors++;
    }
  }

  console.log(
    `[HedgeManager] Cycle complete: scanned=${result.scanned} tpSold=${result.tpSold} expired=${result.expired} errors=${result.errors} skipped=${result.skipped}`
  );
  return result;
};
