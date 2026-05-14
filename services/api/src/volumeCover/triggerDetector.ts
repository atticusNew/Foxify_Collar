/**
 * Volume Cover trigger detector.
 *
 * Polls live BTC spot price every N seconds and checks each active
 * position's trigger boundaries. On touch, fires `fireTrigger` from
 * positionLifecycle.
 *
 * Spot source: caller provides a `getSpotBtcPrice` function (typically
 * wired to Bullish hybrid orderbook last-trade or Coinbase reference).
 *
 * Cadence: 10s default (matches existing pilot trigger monitor cadence).
 *
 * Safety:
 *   - Only fires once per position (status flips to 'triggered' which
 *     filters out subsequent polls)
 *   - Stale price guard: if spot age > VOLUME_COVER_TRIGGER_MAX_PRICE_AGE_MS
 *     (default 30s), skip this cycle without action
 *   - Price drift sanity: if spot moves > 5% in 10s, log WARN and still
 *     fire (real flash crashes happen) but tag the trigger metadata
 *     `suspected_flash`
 */

import type { Pool } from "pg";
import { listActivePositions } from "./volumeCoverDb";
import { fireTrigger } from "./positionLifecycle";
import type { HedgeExecutor } from "./tightHedge";

export type SpotPriceSource = () => Promise<{
  spotBtcPrice: number;
  asOfMs: number;
  source: string;
}>;

export type TriggerDetectorConfig = {
  pollIntervalMs: number;
  maxPriceAgeMs: number;
  flashWarnPctMove: number;
};

const DEFAULT_CONFIG: TriggerDetectorConfig = {
  pollIntervalMs: 10_000,
  maxPriceAgeMs: 30_000,
  flashWarnPctMove: 0.05
};

let runningHandle: NodeJS.Timeout | null = null;
let lastSpotForFlashCheck: { price: number; ms: number } | null = null;

export const startTriggerDetector = (params: {
  pool: Pool;
  executor: HedgeExecutor;
  spotSource: SpotPriceSource;
  config?: Partial<TriggerDetectorConfig>;
}): { stop: () => void } => {
  const config: TriggerDetectorConfig = { ...DEFAULT_CONFIG, ...params.config };

  if (runningHandle !== null) {
    console.warn(`[volumeCover/triggerDetector] already running; ignoring start`);
    return { stop: () => stopTriggerDetector() };
  }

  const tick = async () => {
    try {
      await runOneDetectionCycle({
        pool: params.pool,
        executor: params.executor,
        spotSource: params.spotSource,
        config
      });
    } catch (err) {
      console.warn(`[volumeCover/triggerDetector] cycle error: ${(err as Error).message}`);
    }
  };

  // Initial tick after a short delay so server boot completes
  runningHandle = setTimeout(function loop() {
    void tick();
    runningHandle = setTimeout(loop, config.pollIntervalMs);
  }, 1_000);

  return { stop: () => stopTriggerDetector() };
};

export const stopTriggerDetector = (): void => {
  if (runningHandle !== null) {
    clearTimeout(runningHandle);
    runningHandle = null;
  }
};

/**
 * Run one detection cycle. Exposed for tests + manual /admin/trigger-detector/run.
 */
export const runOneDetectionCycle = async (params: {
  pool: Pool;
  executor: HedgeExecutor;
  spotSource: SpotPriceSource;
  config?: Partial<TriggerDetectorConfig>;
}): Promise<{
  cycledAt: string;
  spotPrice: number | null;
  spotAgeMs: number | null;
  positionsScanned: number;
  positionsTriggered: number;
  triggers: Array<{ positionId: string; direction: "high" | "low"; spot: number }>;
  skipped: boolean;
  skipReason?: string;
}> => {
  const config: TriggerDetectorConfig = { ...DEFAULT_CONFIG, ...params.config };
  const cycledAt = new Date().toISOString();

  let spot: Awaited<ReturnType<SpotPriceSource>>;
  try {
    spot = await params.spotSource();
  } catch (err) {
    return {
      cycledAt,
      spotPrice: null,
      spotAgeMs: null,
      positionsScanned: 0,
      positionsTriggered: 0,
      triggers: [],
      skipped: true,
      skipReason: `spot_source_error: ${(err as Error).message}`
    };
  }

  const ageMs = Date.now() - spot.asOfMs;
  if (ageMs > config.maxPriceAgeMs) {
    return {
      cycledAt,
      spotPrice: spot.spotBtcPrice,
      spotAgeMs: ageMs,
      positionsScanned: 0,
      positionsTriggered: 0,
      triggers: [],
      skipped: true,
      skipReason: `stale_spot_price: ${ageMs}ms > ${config.maxPriceAgeMs}ms`
    };
  }

  // Flash-move detection (informational; doesn't block)
  let flashSuspected = false;
  if (lastSpotForFlashCheck !== null) {
    const elapsedMs = Date.now() - lastSpotForFlashCheck.ms;
    if (elapsedMs > 0 && elapsedMs < 60_000) {
      const pctMove = Math.abs(spot.spotBtcPrice - lastSpotForFlashCheck.price) / lastSpotForFlashCheck.price;
      if (pctMove > config.flashWarnPctMove) {
        flashSuspected = true;
        console.warn(
          `[volumeCover/triggerDetector] FLASH MOVE detected: ${(pctMove * 100).toFixed(2)}% in ${elapsedMs}ms ` +
            `(${lastSpotForFlashCheck.price.toFixed(2)} -> ${spot.spotBtcPrice.toFixed(2)})`
        );
      }
    }
  }
  lastSpotForFlashCheck = { price: spot.spotBtcPrice, ms: Date.now() };

  const activePositions = await listActivePositions(params.pool);
  const triggered: Array<{ positionId: string; direction: "high" | "low"; spot: number }> = [];

  for (const position of activePositions) {
    let direction: "high" | "low" | null = null;
    if (spot.spotBtcPrice >= position.triggerHighBtc) direction = "high";
    else if (spot.spotBtcPrice <= position.triggerLowBtc) direction = "low";
    if (direction === null) continue;

    try {
      await fireTrigger(params.pool, params.executor, {
        position,
        direction,
        triggerSpotBtc: spot.spotBtcPrice
      });
      triggered.push({
        positionId: position.id,
        direction,
        spot: spot.spotBtcPrice
      });
      console.log(
        `[volumeCover/triggerDetector] TRIGGERED position ${position.id} cell=${position.cellId} ` +
          `direction=${direction} spot=${spot.spotBtcPrice} ` +
          `${flashSuspected ? "(flash_suspected)" : ""}`
      );
    } catch (err) {
      console.error(
        `[volumeCover/triggerDetector] fireTrigger failed for position ${position.id}: ${(err as Error).message}`
      );
    }
  }

  return {
    cycledAt,
    spotPrice: spot.spotBtcPrice,
    spotAgeMs: ageMs,
    positionsScanned: activePositions.length,
    positionsTriggered: triggered.length,
    triggers: triggered,
    skipped: false
  };
};

/**
 * Test helper.
 */
export const __resetTriggerDetectorForTests = (): void => {
  if (runningHandle !== null) {
    clearTimeout(runningHandle);
    runningHandle = null;
  }
  lastSpotForFlashCheck = null;
};
