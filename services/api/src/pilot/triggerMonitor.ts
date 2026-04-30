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
import { handleBiweeklyClose, sweepBiweeklyNaturalExpiries } from "./biweeklyClose";

const resolveBullishTriggerPrice = async (requestId: string, marketId: string): Promise<PriceSnapshotOutput> => {
  const { BullishTradingClient, resolveBullishMarketSymbol } = await import("./bullish");
  const symbol = resolveBullishMarketSymbol(marketId, pilotConfig.bullish);
  const client = new BullishTradingClient(pilotConfig.bullish);
  const book = await client.getOrderBook(symbol);
  const bestBid = book.bids?.[0]?.[0] ?? null;
  const bestAsk = book.asks?.[0]?.[0] ?? null;
  if (!bestBid && !bestAsk) throw new Error("bullish_no_orderbook_data");
  const mid = bestBid && bestAsk
    ? new Decimal(bestBid).plus(bestAsk).div(2)
    : new Decimal(bestBid || bestAsk!);
  const now = new Date().toISOString();
  return {
    price: mid,
    marketId,
    priceSource: "bullish_orderbook_mid",
    priceSourceDetail: "bullish_trigger_monitor_mid",
    endpointVersion: pilotConfig.endpointVersion,
    requestId,
    priceTimestamp: now
  };
};

type TriggerMonitorResult = {
  scanned: number;
  triggered: number;
  skipped: number;
  priceErrors: number;
  fallbackSignals: number;
  pauseSignals: number;
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
  triggerPriceTimestamp: params.priceTimestamp,
  hedge_status: "active",
});

const shouldSignalFallback = (triggerRatePct: number): boolean =>
  triggerRatePct >= pilotConfig.rolloutGuards.fallbackTriggerHitRatePct;

const shouldSignalPause = (triggerRatePct: number): boolean =>
  triggerRatePct >= pilotConfig.rolloutGuards.pauseTriggerHitRatePct;

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
    priceErrors: 0,
    fallbackSignals: 0,
    pauseSignals: 0
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
    let snapshot: PriceSnapshotOutput;
    try {
      const useBullish = pilotConfig.lockedProfile.name === "bullish_locked_v1"
        && pilotConfig.bullish.enabled;
      if (useBullish) {
        snapshot = await resolveBullishTriggerPrice(requestId, protection.marketId);
      } else {
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
      }
    } catch (err: any) {
      result.priceErrors += 1;
      console.warn(`[TriggerMonitor] Price error for ${protection.id}: ${err?.message || "unknown"}`);
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
    console.log(`[TriggerMonitor] TRIGGERED: protection=${protection.id} type=${economics.protectionType} spot=$${snapshot.price.toFixed(2)} floor=$${economics.triggerPrice.toFixed(2)} payout=$${economics.triggerPayoutCreditUsd.toFixed(2)} source=${snapshot.priceSource}`);
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

    // Biweekly trigger close-handling (PR 4 of biweekly cutover, 2026-04-30).
    // Per CEO direction: when a biweekly protection triggers, the
    // protection closes for the user (subscription billing stops, payout
    // delivered) but the underlying Deribit hedge stays open for the
    // platform (hedge_retained_for_platform=true). The hedge manager
    // owns disposition from there.
    //
    // For legacy 1-day protections (tenor_days=1), this branch is skipped
    // and the existing hedge-manager-on-trigger behavior runs unchanged.
    if (updated.tenorDays >= 2) {
      try {
        const closeResult = await handleBiweeklyClose({
          pool,
          req: {
            protectionId: protection.id,
            closedBy: "trigger",
            nowMs: now.getTime()
          }
        });
        if (closeResult.status === "ok") {
          console.log(
            `[TriggerMonitor] biweekly close-on-trigger: ${protection.id} ` +
              `daysBilled=${closeResult.daysBilled} ` +
              `accumulatedCharge=$${closeResult.accumulatedChargeUsd.toFixed(2)} ` +
              `hedgeRetained=${closeResult.hedgeRetainedForPlatform}`
          );
        } else {
          console.warn(
            `[TriggerMonitor] biweekly close-on-trigger FAILED for ${protection.id}: ${closeResult.reason} ${closeResult.message}. Trade is in 'triggered' state without closed_at — operator action may be needed.`
          );
        }
      } catch (closeErr: any) {
        console.error(
          `[TriggerMonitor] biweekly close-on-trigger threw for ${protection.id}: ${closeErr?.message ?? "unknown"}`
        );
      }
    }

    result.triggered += 1;
  }
  const triggerRatePct = result.scanned > 0 ? (result.triggered / result.scanned) * 100 : 0;
  if (shouldSignalFallback(triggerRatePct)) {
    result.fallbackSignals += 1;
  }
  if (shouldSignalPause(triggerRatePct)) {
    result.pauseSignals += 1;
  }

  // Biweekly natural-expiry sweep (PR 4 of biweekly cutover, 2026-04-30).
  // Closes biweekly protections that have hit their 14-day max tenor.
  // Cheap query (indexed on tenor_days, closed_at) — runs every cycle.
  // No-op if no biweekly protections are open. Errors logged only;
  // the trigger monitor's main flow is unaffected.
  try {
    await sweepBiweeklyNaturalExpiries({ pool, nowMs: now.getTime() });
  } catch (sweepErr: any) {
    console.warn(
      `[TriggerMonitor] biweekly natural-expiry sweep threw: ${sweepErr?.message ?? "unknown"}`
    );
  }

  return result;
};

export const __setTriggerMonitorEnabledForTests = (enabled: boolean): void => {
  pilotConfig.triggerMonitorEnabled = enabled;
};

/**
 * R7 — Optional alert-emit callback. When provided (typically a closure
 * around a PilotMonitor.recordEvent), the trigger-monitor surfaces
 * `trigger_monitor_price_errors` and `trigger_monitor_cycle_error` events
 * to the alert layer for webhook fan-out. Decoupled from PilotMonitor for
 * test isolation.
 */
type AlertEmitter = (alert: {
  level: "info" | "warning" | "critical";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}) => void;

export const registerPilotTriggerMonitor = (
  pool: Pool,
  onAlert?: AlertEmitter
): NodeJS.Timeout | null => {
  if (!pilotConfig.triggerMonitorEnabled) {
    console.log("[TriggerMonitor] Disabled (PILOT_TRIGGER_MONITOR_ENABLED=false)");
    return null;
  }
  const intervalMs = Math.max(1000, pilotConfig.triggerMonitorIntervalMs);
  let consecutivePriceErrors = 0;
  let alertedAtConsecutiveCount = 0;
  const timer = setInterval(async () => {
    try {
      const result = await processTriggerMonitorCycle(pool);
      if (result.triggered > 0) {
        console.log(`[TriggerMonitor] Cycle: scanned=${result.scanned} triggered=${result.triggered} priceErrors=${result.priceErrors}`);
        // R7 — surface every trigger event as an info-level alert for
        // webhook fan-out. Operators want to know immediately when a user
        // position triggers.
        onAlert?.({
          level: "info",
          code: "trigger_fired",
          message: `${result.triggered} protection(s) triggered this cycle (scanned=${result.scanned}).`,
          details: { triggered: result.triggered, scanned: result.scanned }
        });
      }
      if (result.priceErrors > 0) {
        consecutivePriceErrors += result.priceErrors;
        if (consecutivePriceErrors >= 10) {
          console.error(`[TriggerMonitor] ⚠ ${consecutivePriceErrors} consecutive price errors — price feeds may be degraded`);
          // R7 — fire ONE alert per crossing of the 10-consecutive threshold
          // (don't repeat every cycle while the failure persists).
          if (alertedAtConsecutiveCount < consecutivePriceErrors - consecutivePriceErrors % 10) {
            onAlert?.({
              level: "critical",
              code: "trigger_monitor_price_errors",
              message: `Trigger monitor has ${consecutivePriceErrors} consecutive price errors. Coinbase + Deribit perp price feeds may both be degraded. Trigger detection is paused.`,
              details: { consecutiveErrors: consecutivePriceErrors }
            });
            alertedAtConsecutiveCount = consecutivePriceErrors - consecutivePriceErrors % 10;
          }
        }
      } else {
        consecutivePriceErrors = 0;
        alertedAtConsecutiveCount = 0;
      }
    } catch (err: any) {
      console.error(`[TriggerMonitor] Cycle error: ${err?.message || "unknown"}`);
      onAlert?.({
        level: "critical",
        code: "trigger_monitor_cycle_error",
        message: `Trigger monitor cycle threw: ${err?.message || "unknown"}. Trigger detection skipped this cycle.`,
        details: { error: String(err?.message || err) }
      });
    }
  }, intervalMs);
  timer.unref?.();
  console.log(`[TriggerMonitor] Started: interval=${intervalMs}ms batchSize=${pilotConfig.triggerMonitorBatchSize}`);
  return timer;
};
