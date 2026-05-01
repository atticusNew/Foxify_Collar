import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import { getV7PremiumPer1k, getV7TenorDays, isValidSlTier, slPctToTierLabel } from "./v7Pricing";
import type { PilotVenueAdapter } from "./venue";
import type { ProtectionRecord } from "./types";
import {
  insertProtection,
  insertLedgerEntry,
  insertPriceSnapshot,
  insertVenueExecution,
  patchProtection,
  getProtection
} from "./db";
import { resolvePriceSnapshot, type PriceSnapshotOutput } from "./price";
import { computeTriggerPrice } from "./floor";
import { getCurrentRegime } from "./regimeClassifier";

type AutoRenewResult = {
  scanned: number;
  renewed: number;
  skipped: number;
  errors: number;
  /** Set when Gap 4 freeze was active for the cycle. */
  frozenForRegime?: string;
};

/**
 * Gap 4 — Auto-renew freeze in stress regime.
 *
 * When the regime classifier reports 'stress' (DVOL above the
 * configured stressAbove threshold, default 65), we don't want to
 * auto-buy fresh protection at peak premium. Trader can still
 * manually open a new position; this just disables the silent
 * renewal that would otherwise compound exposure during a vol spike.
 * Re-enables automatically when volatility drops back to normal/calm.
 *
 * Setting PILOT_AUTO_RENEW_STRESS_ALLOWED=true bypasses this guard
 * (e.g., if downstream analysis shows we want auto-renew during
 * stress). Default behavior is to freeze.
 *
 * If the regime classifier is unavailable (Deribit data outage) we
 * fail OPEN — auto-renew proceeds. The conservative alternative
 * would be fail-closed (always freeze on data unavailability) but
 * that risks freezing renewals just because of a transient API
 * blip, which would surprise traders.
 */
const isAutoRenewFrozenByVolatilityRegime = async (): Promise<{ frozen: boolean; regime: string }> => {
  const allowAlways = String(process.env.PILOT_AUTO_RENEW_STRESS_ALLOWED || "")
    .trim()
    .toLowerCase() === "true";
  if (allowAlways) return { frozen: false, regime: "override_allow_always" };
  try {
    const status = await getCurrentRegime();
    return { frozen: status.regime === "stress", regime: status.regime };
  } catch (err: any) {
    console.warn(
      `[AutoRenew] Could not determine regime (${err?.message || "unknown"}); failing OPEN — proceeding with renewal cycle.`
    );
    return { frozen: false, regime: "unavailable_fail_open" };
  }
};

const queryExpiringProtections = async (pool: Pool): Promise<ProtectionRecord[]> => {
  const result = await pool.query(`
    SELECT *
    FROM pilot_protections
    WHERE auto_renew = true
      AND (
        (status = 'active' AND expiry_at <= NOW() + INTERVAL '30 minutes' AND expiry_at > NOW() - INTERVAL '2 hours')
        OR
        (status = 'triggered' AND expiry_at > NOW() - INTERVAL '24 hours')
      )
    ORDER BY expiry_at ASC
    LIMIT 50
  `);
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    userHash: String(row.user_hash),
    hashVersion: Number(row.hash_version),
    status: String(row.status) as ProtectionRecord["status"],
    tierName: row.tier_name ? String(row.tier_name) : null,
    drawdownFloorPct: row.drawdown_floor_pct ? String(row.drawdown_floor_pct) : null,
    floorPrice: row.floor_price ? String(row.floor_price) : null,
    slPct: row.sl_pct != null ? Number(row.sl_pct) : null,
    hedgeStatus: row.hedge_status ? String(row.hedge_status) : null,
    regime: row.regime ? String(row.regime) : null,
    regimeSource: row.regime_source ? String(row.regime_source) : null,
    dvolAtPurchase: row.dvol_at_purchase != null ? Number(row.dvol_at_purchase) : null,
    marketId: String(row.market_id),
    protectedNotional: String(row.protected_notional),
    entryPrice: row.entry_price ? String(row.entry_price) : null,
    entryPriceSource: row.entry_price_source ? String(row.entry_price_source) : null,
    entryPriceTimestamp: row.entry_price_timestamp ? new Date(String(row.entry_price_timestamp)).toISOString() : null,
    expiryAt: new Date(String(row.expiry_at)).toISOString(),
    expiryPrice: null,
    expiryPriceSource: null,
    expiryPriceTimestamp: null,
    autoRenew: Boolean(row.auto_renew),
    renewWindowMinutes: Number(row.renew_window_minutes || 1440),
    venue: row.venue ? String(row.venue) : null,
    instrumentId: row.instrument_id ? String(row.instrument_id) : null,
    side: row.side ? String(row.side) : null,
    size: row.size ? String(row.size) : null,
    executionPrice: row.execution_price ? String(row.execution_price) : null,
    premium: row.premium ? String(row.premium) : null,
    executedAt: row.executed_at ? new Date(String(row.executed_at)).toISOString() : null,
    externalOrderId: row.external_order_id ? String(row.external_order_id) : null,
    externalExecutionId: row.external_execution_id ? String(row.external_execution_id) : null,
    payoutDueAmount: null,
    payoutSettledAmount: null,
    payoutSettledAt: null,
    payoutTxRef: null,
    foxifyExposureNotional: String(row.foxify_exposure_notional || row.protected_notional),
    // Biweekly subscription fields. Auto-renew currently runs only against
    // legacy 1-day protections; defaults match. PR 4 will revisit auto-renew
    // semantics for biweekly.
    tenorDays: row.tenor_days === null || row.tenor_days === undefined ? 1 : Number(row.tenor_days),
    dailyRateUsdPer1k:
      row.daily_rate_usd_per_1k === null || row.daily_rate_usd_per_1k === undefined
        ? null
        : String(row.daily_rate_usd_per_1k),
    accumulatedChargeUsd:
      row.accumulated_charge_usd === null || row.accumulated_charge_usd === undefined
        ? "0"
        : String(row.accumulated_charge_usd),
    daysBilled:
      row.days_billed === null || row.days_billed === undefined ? 0 : Number(row.days_billed),
    closedAt: row.closed_at ? new Date(String(row.closed_at)).toISOString() : null,
    closedBy: row.closed_by ? String(row.closed_by) : null,
    hedgeRetainedForPlatform: Boolean(row.hedge_retained_for_platform),
    metadata: (typeof row.metadata === "object" && row.metadata ? row.metadata : {}) as Record<string, unknown>,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  }));
};

export const runAutoRenewCycle = async (params: {
  pool: Pool;
  venue: PilotVenueAdapter;
}): Promise<AutoRenewResult> => {
  const result: AutoRenewResult = { scanned: 0, renewed: 0, skipped: 0, errors: 0 };

  // Gap 4 — freeze auto-renew in stress regime.
  const freezeStatus = await isAutoRenewFrozenByVolatilityRegime();
  if (freezeStatus.frozen) {
    console.warn(
      `[AutoRenew] FROZEN — regime is '${freezeStatus.regime}'. Skipping all auto-renewals this cycle. ` +
      `Set PILOT_AUTO_RENEW_STRESS_ALLOWED=true to override.`
    );
    result.frozenForRegime = freezeStatus.regime;
    return result;
  }

  let expiring: ProtectionRecord[];
  try {
    expiring = await queryExpiringProtections(params.pool);
  } catch (err: any) {
    console.error(`[AutoRenew] Failed to query expiring protections: ${err?.message}`);
    return result;
  }
  result.scanned = expiring.length;
  if (!expiring.length) return result;

  console.log(
    `[AutoRenew] Found ${expiring.length} expiring protections with auto-renew (regime=${freezeStatus.regime}, freeze=off)`
  );

  for (const protection of expiring) {
    try {
      if (protection.metadata?.renewedTo) {
        result.skipped++;
        continue;
      }

      const slPct = protection.slPct;
      if (!slPct || !isValidSlTier(slPct)) {
        console.warn(`[AutoRenew] Skipping ${protection.id}: invalid slPct=${slPct}`);
        result.skipped++;
        continue;
      }

      const notional = new Decimal(protection.protectedNotional);
      const ratePer1k = getV7PremiumPer1k(slPct);
      const tenorDays = getV7TenorDays(slPct);
      const premiumUsd = notional.div(1000).mul(ratePer1k);
      const protectionType: "long" | "short" =
        String(protection.metadata?.protectionType || protection.side || "long") === "short" ? "short" : "long";
      const optionType = protectionType === "short" ? "C" : "P";

      const requestId = pilotConfig.nextRequestId();
      let snapshot: PriceSnapshotOutput;
      try {
        snapshot = await resolvePriceSnapshot(
          {
            primaryUrl: pilotConfig.referencePriceUrl,
            fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
            primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
            fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
            freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
            requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
            requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
          },
          {
            marketId: protection.marketId,
            now: new Date(),
            requestId,
            endpointVersion: pilotConfig.endpointVersion
          }
        );
      } catch (err: any) {
        console.error(`[AutoRenew] FAILED price for ${protection.id} (${protectionType}): ${err?.message}`);
        result.errors++;
        continue;
      }

      const newEntryPrice = snapshot.price;
      const drawdownFloor = new Decimal(slPct).div(100);
      const newTriggerPrice = computeTriggerPrice(newEntryPrice, drawdownFloor, protectionType);
      const quantity = notional.div(newEntryPrice).toDecimalPlaces(8).toNumber();
      const newExpiryAt = new Date(Date.now() + tenorDays * 86400000).toISOString();

      let quote;
      try {
        quote = await params.venue.quote({
          marketId: protection.marketId,
          instrumentId: `${protection.marketId}-${tenorDays}D-${optionType}`,
          protectedNotional: notional.toNumber(),
          quantity,
          side: "buy",
          protectionType,
          drawdownFloorPct: drawdownFloor.toNumber(),
          triggerPrice: newTriggerPrice.toNumber(),
          requestedTenorDays: tenorDays,
          clientPremiumUsd: premiumUsd.toNumber()
        });
      } catch (err: any) {
        console.error(`[AutoRenew] FAILED quote for ${protection.id} (${protectionType} ${optionType}): ${err?.message}`);
        result.errors++;
        continue;
      }

      let execution;
      try {
        execution = await params.venue.execute(quote);
      } catch (err: any) {
        console.error(`[AutoRenew] FAILED execution for ${protection.id} (${protectionType}): ${err?.message}`);
        result.errors++;
        continue;
      }

      if (execution.status !== "success") {
        console.error(`[AutoRenew] FAILED execution status for ${protection.id} (${protectionType}): ${execution.status}`);
        result.errors++;
        continue;
      }

      const newProtection = await insertProtection(params.pool, {
        userHash: protection.userHash,
        hashVersion: protection.hashVersion,
        status: "active",
        tierName: slPctToTierLabel(slPct),
        drawdownFloorPct: drawdownFloor.toFixed(6),
        slPct,
        hedgeStatus: "active",
        marketId: protection.marketId,
        protectedNotional: notional.toFixed(10),
        foxifyExposureNotional: protection.foxifyExposureNotional,
        expiryAt: newExpiryAt,
        autoRenew: true,
        renewWindowMinutes: protection.renewWindowMinutes,
        metadata: {
          renewedFrom: protection.id,
          renewalRequestId: requestId,
          slPct,
          protectionType,
          entryPrice: newEntryPrice.toFixed(10),
          triggerPrice: newTriggerPrice.toFixed(10),
          premiumUsd: premiumUsd.toFixed(10),
          hedgeCostUsd: execution.premium.toFixed(10),
          venue: execution.venue,
          instrumentId: execution.instrumentId,
          externalOrderId: execution.externalOrderId
        }
      });

      await patchProtection(params.pool, newProtection.id, {
        entry_price: newEntryPrice.toFixed(10),
        entry_price_source: snapshot.priceSource,
        entry_price_timestamp: snapshot.priceTimestamp,
        floor_price: newTriggerPrice.toFixed(10),
        venue: execution.venue,
        instrument_id: execution.instrumentId,
        side: execution.side,
        size: new Decimal(execution.quantity).toFixed(10),
        execution_price: new Decimal(execution.executionPrice).toFixed(10),
        premium: premiumUsd.toFixed(10),
        executed_at: execution.executedAt,
        external_order_id: execution.externalOrderId,
        external_execution_id: execution.externalExecutionId
      });

      await insertPriceSnapshot(params.pool, {
        protectionId: newProtection.id,
        snapshotType: "entry",
        price: newEntryPrice.toFixed(10),
        marketId: protection.marketId,
        priceSource: snapshot.priceSource,
        priceSourceDetail: snapshot.priceSourceDetail,
        endpointVersion: snapshot.endpointVersion,
        requestId,
        priceTimestamp: snapshot.priceTimestamp
      });

      await insertVenueExecution(params.pool, newProtection.id, execution);

      await insertLedgerEntry(params.pool, {
        protectionId: newProtection.id,
        entryType: "premium_due",
        amount: premiumUsd.toFixed(10),
        reference: `auto_renew:${protection.id}`
      });

      await patchProtection(params.pool, protection.id, {
        status: "expired_otm",
        metadata: {
          ...protection.metadata,
          renewedTo: newProtection.id,
          renewedAt: new Date().toISOString()
        }
      });

      console.log(
        `[AutoRenew] Renewed ${protection.id} → ${newProtection.id} (${protectionType} ${protection.status === "triggered" ? "post-trigger" : "expiry"}): SL=${slPct}% premium=$${premiumUsd.toFixed(2)} entry=$${newEntryPrice.toFixed(0)} trigger=$${newTriggerPrice.toFixed(0)} instrument=${execution.instrumentId}`
      );
      result.renewed++;
    } catch (err: any) {
      console.error(`[AutoRenew] Error renewing ${protection.id}: ${err?.message}`);
      result.errors++;
    }
  }

  console.log(
    `[AutoRenew] Cycle complete: scanned=${result.scanned} renewed=${result.renewed} skipped=${result.skipped} errors=${result.errors}`
  );
  return result;
};
