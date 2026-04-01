import Decimal from "decimal.js";
import type { Pool } from "pg";
import { pilotConfig } from "./config";
import {
  insertLedgerEntry,
  insertPriceSnapshot,
  listActiveProtectionsForTriggerMonitor,
  patchProtectionForStatus
} from "./db";
import { resolvePriceSnapshot } from "./price";
import { isDrawdownBreached, resolveTriggerEconomicsFromProtection } from "./protectionMath";
import type { PriceSnapshotOutput } from "./price";

type TriggerMonitorResult = {
  scanned: number;
  triggered: number;
  skipped: number;
  priceErrors: number;
};

const buildTriggerMetadata = (params: {
  metadata: Record<string, unknown>;
  triggerPrice: Decimal;
  referencePrice: Decimal;
  triggerPayoutCreditUsd: Decimal;
  drawdownFloorPct: Decimal;
  protectionType: "long" | "short";
  requestId: string;
  priceSource: string;
  priceTimestamp: string;
  triggeredAt: string;
}): Record<string, unknown> => ({
  ...params.metadata,
  triggerStatus: "breached",
  triggerAt: params.triggeredAt,
  triggerPrice: params.triggerPrice.toFixed(10),
  triggerReferencePrice: params.referencePrice.toFixed(10),
  triggerPayoutCreditUsd: params.triggerPayoutCreditUsd.toFixed(10),
  drawdownFloorPct: params.drawdownFloorPct.toFixed(6),
  protectionType: params.protectionType,
  triggerRequestId: params.requestId,
  triggerPriceSource: params.priceSource,
  triggerPriceTimestamp: params.priceTimestamp
});

export const processTriggerMonitorCycle = async (
  pool: Pool,
  now: Date = new Date()
): Promise<TriggerMonitorResult> => {
  return processTriggerMonitorCycleWithResolver(pool, resolvePriceSnapshot, now);
};

export const processTriggerMonitorCycleWithResolver = async (
  pool: Pool,
  priceResolver: (typeof resolvePriceSnapshot) | ((config: any, input: any) => Promise<PriceSnapshotOutput>),
  now: Date = new Date()
): Promise<TriggerMonitorResult> => {
  const result: TriggerMonitorResult = {
    scanned: 0,
    triggered: 0,
    skipped: 0,
    priceErrors: 0
  };
  const candidates = await listActiveProtectionsForTriggerMonitor(pool, {
    limit: pilotConfig.triggerMonitorBatchSize
  });
  result.scanned = candidates.length;
  for (const protection of candidates) {
    const economics = resolveTriggerEconomicsFromProtection(protection);
    if (!economics) {
      result.skipped += 1;
      continue;
    }
    const requestId = pilotConfig.nextRequestId();
    let snapshot;
    try {
      snapshot = await priceResolver(
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
          now,
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
    } catch {
      result.priceErrors += 1;
      continue;
    }
    if (
      !isDrawdownBreached({
        protectionType: economics.protectionType,
        triggerPrice: economics.triggerPrice,
        referencePrice: snapshot.price
      })
    ) {
      continue;
    }
    const triggeredAt = now.toISOString();
    const updated = await patchProtectionForStatus(pool, {
      id: protection.id,
      expectedStatus: "active",
      patch: {
        status: "triggered",
        floor_price: economics.triggerPrice.toFixed(10),
        payout_due_amount: economics.triggerPayoutCreditUsd.toFixed(10),
        metadata: buildTriggerMetadata({
          metadata: protection.metadata || {},
          triggerPrice: economics.triggerPrice,
          referencePrice: snapshot.price,
          triggerPayoutCreditUsd: economics.triggerPayoutCreditUsd,
          drawdownFloorPct: economics.drawdownFloorPct,
          protectionType: economics.protectionType,
          requestId,
          priceSource: snapshot.priceSource,
          priceTimestamp: snapshot.priceTimestamp,
          triggeredAt
        })
      }
    });
    if (!updated) continue;
    await insertPriceSnapshot(pool, {
      protectionId: protection.id,
      snapshotType: "trigger",
      price: snapshot.price.toFixed(10),
      marketId: snapshot.marketId,
      priceSource: snapshot.priceSource,
      priceSourceDetail: snapshot.priceSourceDetail,
      endpointVersion: snapshot.endpointVersion,
      requestId: snapshot.requestId,
      priceTimestamp: snapshot.priceTimestamp
    });
    await insertLedgerEntry(pool, {
      protectionId: protection.id,
      entryType: "trigger_payout_due",
      amount: economics.triggerPayoutCreditUsd.toFixed(10),
      reference: `trigger:${snapshot.priceTimestamp}`
    });
    result.triggered += 1;
  }
  return result;
};

export const __setTriggerMonitorEnabledForTests = (enabled: boolean): void => {
  pilotConfig.triggerMonitorEnabled = enabled;
};

export const registerPilotTriggerMonitor = (pool: Pool): NodeJS.Timeout | null => {
  if (!pilotConfig.triggerMonitorEnabled) return null;
  const intervalMs = Math.max(1000, pilotConfig.triggerMonitorIntervalMs);
  const timer = setInterval(() => {
    void processTriggerMonitorCycle(pool).catch(() => {
      // Deliberately swallow to keep monitor loop healthy.
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
};
