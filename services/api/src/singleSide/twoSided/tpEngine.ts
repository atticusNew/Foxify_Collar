/**
 * Theta-aware TP engine for the two-sided strangle (PR 4).
 *
 * Mirrors the logic validated in scripts/backtest/singleSide/runTwoSidedStrangleProof.ts
 * (simulateTwoSidedPath), adapted for production runtime where the input is a
 * stream of real-time spot polls instead of a pre-generated bar path.
 *
 * The runtime loop (PR 5) is responsible for:
 *   1. Polling the canonical Atticus feed every N seconds.
 *   2. Computing the current combined option value (BS-based via optionValueLookup).
 *   3. Tracking the running peak since trigger fire.
 *   4. Calling tpEvaluate() each poll → receiving a TpDecision.
 *   5. Executing the sell when decision.action === "sell".
 *
 * Parameters match MC tuning (validated 2026-05-27 against bootstrap of real BTC bars):
 *   - capture window: 30 minutes post-trigger (sell at peak × slip if reached)
 *   - trail retrace: 15% pullback from peak (after capture window expired)
 *   - hard floor: 10% of original hedge cost (after capture window expired)
 *   - force exit: at expiry-4h (TP_FORCE_EXIT)
 *   - slippage: depth-aware (worst-leg-wins) from anchors
 *
 * Decision is PURE — no I/O, no DB. Caller threads in the inputs.
 */

import type { ExitMode } from "./types";

export const CAPTURE_WINDOW_MS = 30 * 60_000;
export const TRAIL_RETRACE_FACTOR = 0.85;       // sell if current < peak × 0.85
export const HARD_FLOOR_FRACTION = 0.10;        // sell if current < hedge_cost × 0.10
export const DEFAULT_SLIPPAGE = 0.85;

export type TpInput = {
  hedgeCostUsdc: number;
  triggeredAtMs: number;
  tpForceExitAtMs: number;          // expiry - 4h; force sell at or beyond this
  currentMs: number;
  currentValueUsdc: number;         // combined put + call value at current spot
  peakValueSinceTriggerUsdc: number; // updated by caller — max(currentValue, prior peak)
  slippageHaircut: number;          // from depth-aware slippage, e.g. 0.85
  /** If true, treat as Foxify-initiated early close — sell at current value with slip. */
  foxifyForceClose?: boolean;
};

export type TpDecision = {
  action: "wait" | "sell";
  reason: ExitMode | null;
  projectedSalvageUsdc: number;     // expected proceeds if we sell now
  msInCaptureWindow: number;
  msToForceExit: number;
};

export const tpEvaluate = (input: TpInput): TpDecision => {
  const {
    hedgeCostUsdc,
    triggeredAtMs,
    tpForceExitAtMs,
    currentMs,
    currentValueUsdc,
    peakValueSinceTriggerUsdc,
    slippageHaircut,
    foxifyForceClose
  } = input;

  const msSinceTrigger = currentMs - triggeredAtMs;
  const msToForceExit = tpForceExitAtMs - currentMs;
  const msInCaptureWindow = Math.max(0, CAPTURE_WINDOW_MS - msSinceTrigger);

  // Foxify-initiated force close (early close) — sell at current with slippage
  if (foxifyForceClose) {
    return {
      action: "sell",
      reason: "foxify_close",
      projectedSalvageUsdc: currentValueUsdc * slippageHaircut,
      msInCaptureWindow,
      msToForceExit
    };
  }

  // Force exit at expiry-4h
  if (currentMs >= tpForceExitAtMs) {
    return {
      action: "sell",
      reason: "force_expiry",
      projectedSalvageUsdc: currentValueUsdc * slippageHaircut,
      msInCaptureWindow,
      msToForceExit
    };
  }

  // Capture window: sell at peak (with slippage) once the window closes
  // Production semantics: the call loop tracks peak; when msSinceTrigger crosses
  // CAPTURE_WINDOW_MS, we snap to peak. Slippage applied to peak.
  if (msSinceTrigger >= CAPTURE_WINDOW_MS && msSinceTrigger < CAPTURE_WINDOW_MS + 60_000) {
    return {
      action: "sell",
      reason: "capture_window_peak",
      projectedSalvageUsdc: peakValueSinceTriggerUsdc * slippageHaircut,
      msInCaptureWindow,
      msToForceExit
    };
  }

  // Post-capture-window: trail retrace fires if current drops below peak × TRAIL_RETRACE_FACTOR
  if (msSinceTrigger >= CAPTURE_WINDOW_MS && peakValueSinceTriggerUsdc > 0) {
    if (currentValueUsdc < peakValueSinceTriggerUsdc * TRAIL_RETRACE_FACTOR) {
      return {
        action: "sell",
        reason: "trail_retrace",
        projectedSalvageUsdc: currentValueUsdc * slippageHaircut,
        msInCaptureWindow,
        msToForceExit
      };
    }
  }

  // Hard floor (after capture window): sell if value collapses to <10% of hedge cost
  if (msSinceTrigger >= CAPTURE_WINDOW_MS) {
    if (currentValueUsdc < hedgeCostUsdc * HARD_FLOOR_FRACTION) {
      return {
        action: "sell",
        reason: "hard_floor",
        projectedSalvageUsdc: currentValueUsdc * slippageHaircut,
        msInCaptureWindow,
        msToForceExit
      };
    }
  }

  // Default: wait
  return {
    action: "wait",
    reason: null,
    projectedSalvageUsdc: currentValueUsdc * slippageHaircut, // informational
    msInCaptureWindow,
    msToForceExit
  };
};
