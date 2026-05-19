/**
 * P1c — Volume Cover strike grid utilities.
 *
 * Production previously used exact computed strikes (entry × (1 ± hedgePct))
 * which often don't exist on venue strike grids. The venue would either
 * reject the order or fill a nearby strike, silently degrading hedge
 * geometry.
 *
 * This module provides:
 *   - Venue-specific default grid step (Bullish $200, Deribit $1000)
 *   - "Round toward spot" snap that keeps strikes INSIDE the trigger
 *     band — never round outside the band even if it costs grid bias
 *   - Vol-aware sizing buffer that scales hedge size by regime to
 *     mitigate realized-vol surprises
 *
 * Grid step values are static defaults; venueStrikeGrid lookups (live
 * REST queries) are a Phase 2 enhancement (see PLAN §10.1). For Phase 1
 * we lock to documented grid increments.
 */

import Decimal from "decimal.js";
import type { HedgeVenueChoice } from "./tightHedge";

/**
 * Default grid step (USDC) for each venue's BTC option strikes.
 *
 * Sources:
 *   - Bullish: 1-day grid ~$200 increments near spot, sparser further out
 *   - Deribit: weekly/monthly $1000 increments (some weeks $500); we
 *     pick $1000 conservatively to ensure quoted strikes always exist
 *
 * Per-cell venue is resolved via tightHedge.resolveHedgeVenue.
 */
const DEFAULT_GRID_STEP_USDC: Record<HedgeVenueChoice, number> = {
  bullish: 200,
  deribit: 1000
};

export const getGridStepUsdc = (venue: HedgeVenueChoice): number => {
  // Operator override via env. Format:
  //   VOLUME_COVER_STRIKE_GRID_BULLISH=200
  //   VOLUME_COVER_STRIKE_GRID_DERIBIT=1000
  const envVar = `VOLUME_COVER_STRIKE_GRID_${venue.toUpperCase()}`;
  const envVal = process.env[envVar];
  if (envVal) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_GRID_STEP_USDC[venue] ?? 1000;
};

/**
 * Snap an ideal strike to the nearest available grid value, biased
 * toward spot so the option retains intrinsic value. Constrained to
 * remain INSIDE [triggerBoundary, spot] for the put or
 * [spot, triggerBoundary] for the call.
 *
 *   PUT:  round UP toward spot, but ≤ spot AND ≥ trigger_low + 1 step
 *   CALL: round DOWN toward spot, but ≥ spot AND ≤ trigger_high - 1 step
 *
 * Falls back to the safe boundary value if rounding would exit the band.
 */
export const snapHedgeStrike = (params: {
  optionKind: "put" | "call";
  idealStrikeUsdc: number;
  spotUsdc: number;
  triggerBoundaryUsdc: number; // trigger_low for put, trigger_high for call
  gridStepUsdc: number;
}): number => {
  const { optionKind, idealStrikeUsdc, spotUsdc, triggerBoundaryUsdc, gridStepUsdc } = params;
  if (gridStepUsdc <= 0) return idealStrikeUsdc;

  if (optionKind === "put") {
    // Strike must be > triggerLow and ≤ spot. Round UP (toward spot).
    const snapped = Math.ceil(idealStrikeUsdc / gridStepUsdc) * gridStepUsdc;
    if (snapped > spotUsdc) {
      // Round-up overshot spot; use the largest grid value ≤ spot.
      const downSnapped = Math.floor(spotUsdc / gridStepUsdc) * gridStepUsdc;
      return Math.max(downSnapped, triggerBoundaryUsdc + gridStepUsdc);
    }
    if (snapped <= triggerBoundaryUsdc) {
      // Snapped inside or below trigger; bump up one grid step.
      return triggerBoundaryUsdc + gridStepUsdc;
    }
    return snapped;
  }

  // Call: strike must be < triggerHigh and ≥ spot. Round DOWN (toward spot).
  const snapped = Math.floor(idealStrikeUsdc / gridStepUsdc) * gridStepUsdc;
  if (snapped < spotUsdc) {
    const upSnapped = Math.ceil(spotUsdc / gridStepUsdc) * gridStepUsdc;
    return Math.min(upSnapped, triggerBoundaryUsdc - gridStepUsdc);
  }
  if (snapped >= triggerBoundaryUsdc) {
    return triggerBoundaryUsdc - gridStepUsdc;
  }
  return snapped;
};

/**
 * Vol-buffered sizing multiplier. Increases hedge contract count in
 * higher-vol regimes to absorb realized-vol surprises that would
 * otherwise leave Atticus under-hedged at trigger time.
 *
 * Calm:     1.00× (no buffer)
 * Moderate: 1.05× (5% buffer)
 * Elevated: 1.10× (10% buffer)
 * Stress:   1.15× (15% buffer)
 *
 * Disable globally with VC_VOL_BUFFER_ENABLED=false.
 */
export type VolRegime = "calm" | "moderate" | "elevated" | "stress";

const VOL_BUFFER_BY_REGIME: Record<VolRegime, number> = {
  calm: 1.0,
  moderate: 1.05,
  elevated: 1.1,
  stress: 1.15
};

export const getVolBufferMultiplier = (regime: VolRegime | null | undefined): number => {
  if (process.env.VC_VOL_BUFFER_ENABLED === "false") return 1.0;
  if (!regime) return 1.0;
  return VOL_BUFFER_BY_REGIME[regime] ?? 1.0;
};

/**
 * Apply vol-buffer to a base BTC contract size, then round UP to the
 * venue's contract granularity (typically 0.1 BTC).
 */
export const applyVolBufferAndRound = (params: {
  baseContractsBtc: number;
  regime: VolRegime | null | undefined;
  granularityBtc?: number;
}): number => {
  const granularity = params.granularityBtc ?? 0.1;
  const multiplier = getVolBufferMultiplier(params.regime);
  const buffered = new Decimal(params.baseContractsBtc).mul(multiplier);
  return buffered
    .div(granularity)
    .toDecimalPlaces(0, Decimal.ROUND_UP)
    .mul(granularity)
    .toNumber();
};

/**
 * Volume Cover-specific 4-bucket regime classification, applied to
 * DVOL (the BTC daily-vol index from Deribit). Tighter than the pilot's
 * 3-bucket scheme so we get a distinct "elevated" tier for vol-buffer
 * sizing + future regime price overlays.
 *
 * Thresholds (per consolidated #23 and PLAN §3):
 *   DVOL < 50:    calm
 *   50 ≤ DVOL <65: moderate
 *   65 ≤ DVOL <80: elevated
 *   DVOL ≥ 80:    stress
 */
export const classifyVolumeCoverRegime = (dvol: number | null | undefined): VolRegime | null => {
  if (typeof dvol !== "number" || !Number.isFinite(dvol)) return null;
  if (dvol < 50) return "calm";
  if (dvol < 65) return "moderate";
  if (dvol < 80) return "elevated";
  return "stress";
};

/**
 * Translate the pilot's V7Regime (calm|normal|stress) into VC's
 * 4-bucket VolRegime. Used as a fallback when DVOL is unavailable.
 *   calm   → calm
 *   normal → moderate (we conservatively map to lower of two middle buckets)
 *   stress → stress
 */
export const translatePilotRegime = (
  pilotRegime: "calm" | "normal" | "stress" | null | undefined
): VolRegime | null => {
  if (!pilotRegime) return null;
  if (pilotRegime === "calm") return "calm";
  if (pilotRegime === "stress") return "stress";
  return "moderate";
};
