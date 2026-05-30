/**
 * Salvage tracker — single source of truth for live salvage telemetry.
 *
 * Reads from volume_cover_salvage_event table. No in-memory state;
 * restart-safe.
 *
 * Provides three derived metrics for guards + reporting:
 *   - rolling-5-trigger salvage rate (Guard B)
 *   - rolling-24h trigger count (Guard C)
 *   - rolling-7day Atticus net loss (Guard A)
 */

import type { Pool } from "pg";
import {
  computeRollingSalvageStats,
  countTriggersInWindow,
  sumNetLossInWindow,
  insertSalvageEvent,
  type SalvageEventRow
} from "./volumeCoverDb";
import { randomUUID } from "node:crypto";

export type SalvageMetrics = {
  rolling5TriggerSalvagePct: number | null;
  rolling5TriggerSampleCount: number;
  rolling24hTriggerCount: number;
  rolling7dayAtticusLossUsdc: number;
};

/**
 * Read all metrics needed by guards in one batched call.
 */
export const readSalvageMetrics = async (pool: Pool): Promise<SalvageMetrics> => {
  const [rolling5, count24h, loss7d] = await Promise.all([
    computeRollingSalvageStats(pool, 5),
    countTriggersInWindow(pool, 24),
    sumNetLossInWindow(pool, 24 * 7)
  ]);
  return {
    rolling5TriggerSalvagePct: rolling5.avgSalvagePct,
    rolling5TriggerSampleCount: rolling5.count,
    rolling24hTriggerCount: count24h,
    rolling7dayAtticusLossUsdc: loss7d
  };
};

/**
 * Record a trigger event with full salvage details. Wraps insertSalvageEvent
 * with id generation and convenience.
 */
export const recordTriggerEvent = async (
  pool: Pool,
  params: {
    positionId: string;
    triggeredDirection: "high" | "low";
    payoutOwedUsdc: number;
    hedgeSaleProceedsUsdc: number;
    metadata?: Record<string, unknown>;
  }
): Promise<SalvageEventRow> => {
  return insertSalvageEvent(pool, {
    id: `vc-salv-${randomUUID()}`,
    positionId: params.positionId,
    triggeredDirection: params.triggeredDirection,
    payoutOwedUsdc: params.payoutOwedUsdc,
    hedgeSaleProceedsUsdc: params.hedgeSaleProceedsUsdc,
    metadata: params.metadata
  });
};

/**
 * Convenience for the dashboard / Foxify report.
 */
export const summarizeSalvageForReport = async (
  pool: Pool
): Promise<{
  rolling5: SalvageMetrics & { state: "normal" | "throttle" | "halt" };
}> => {
  const metrics = await readSalvageMetrics(pool);
  const throttlePct = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_THROTTLE_PCT ?? "0.85");
  const haltPct = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_HALT_PCT ?? "0.70");
  const minSamples = Number(process.env.VOLUME_COVER_GUARD_SALVAGE_MIN_SAMPLES ?? "3");

  let state: "normal" | "throttle" | "halt" = "normal";
  if (
    metrics.rolling5TriggerSalvagePct !== null &&
    metrics.rolling5TriggerSampleCount >= minSamples
  ) {
    if (metrics.rolling5TriggerSalvagePct < haltPct) state = "halt";
    else if (metrics.rolling5TriggerSalvagePct < throttlePct) state = "throttle";
  }

  return { rolling5: { ...metrics, state } };
};
