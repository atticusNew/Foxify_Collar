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
 * Default thresholds (per consolidated #23 and PLAN §3):
 *   DVOL < 50:    calm
 *   50 ≤ DVOL <65: moderate
 *   65 ≤ DVOL <80: elevated
 *   DVOL ≥ 80:    stress
 *
 * Defaults are preserved for backward-compatibility with existing
 * tests + stress-pause guardrail. For production-tighter thresholds
 * (Foxify spread cell pricing, 2026-05-23 operator decision), set:
 *   VC_REGIME_DVOL_CALM_BELOW=35
 *   VC_REGIME_DVOL_MODERATE_BELOW=50
 *   VC_REGIME_DVOL_ELEVATED_BELOW=65
 *
 * Above 80 the stress-pause guardrail (VC_STRESS_PAUSE_DVOL_THRESHOLD)
 * separately halts new cell openings — independent of pricing tier.
 */
export type VolRegimeThresholds = {
  calmBelow: number;
  moderateBelow: number;
  elevatedBelow: number;
};

const DEFAULT_THRESHOLDS: VolRegimeThresholds = {
  calmBelow: 50,
  moderateBelow: 65,
  elevatedBelow: 80
};

const readEnvNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const getConfiguredVolRegimeThresholds = (): VolRegimeThresholds => ({
  calmBelow: readEnvNumber("VC_REGIME_DVOL_CALM_BELOW", DEFAULT_THRESHOLDS.calmBelow),
  moderateBelow: readEnvNumber("VC_REGIME_DVOL_MODERATE_BELOW", DEFAULT_THRESHOLDS.moderateBelow),
  elevatedBelow: readEnvNumber("VC_REGIME_DVOL_ELEVATED_BELOW", DEFAULT_THRESHOLDS.elevatedBelow)
});

export const classifyVolumeCoverRegime = (
  dvol: number | null | undefined,
  thresholdsOverride?: VolRegimeThresholds
): VolRegime | null => {
  if (typeof dvol !== "number" || !Number.isFinite(dvol)) return null;
  const t = thresholdsOverride ?? getConfiguredVolRegimeThresholds();
  if (dvol < t.calmBelow) return "calm";
  if (dvol < t.moderateBelow) return "moderate";
  if (dvol < t.elevatedBelow) return "elevated";
  return "stress";
};

// ─── Hysteresis wrapper ────────────────────────────────────────────────
//
// Without hysteresis the classifier flips regimes the moment DVOL crosses
// a threshold, which can cause boundary jitter that:
//   - Spams operator/log channels with regime changes
//   - Bounces premium between two tiers within minutes
//   - Triggers redundant hedge re-quoting in adjacent code paths
//
// Hysteresis enforces a minimum interval between regime flips. While
// the cooldown is active the LAST committed regime is returned regardless
// of the current raw classification. Reset on process restart (in-memory
// state; no DB persistence — keeps a restart cleanly re-classifying).

export type RegimeWithHysteresis = {
  regime: VolRegime;
  rawClassification: VolRegime;
  flipSuppressed: boolean;
  lastFlipAtMs: number;
  asOfMs: number;
};

type HysteresisState = {
  currentRegime: VolRegime | null;
  lastFlipAtMs: number;
};

const hysteresisState: HysteresisState = {
  currentRegime: null,
  lastFlipAtMs: 0
};

const DEFAULT_FLIP_INTERVAL_MS = 3_600_000; // 1 hour

const readFlipIntervalMs = (): number => {
  const raw = process.env.VC_REGIME_HYSTERESIS_MIN_FLIP_INTERVAL_MS;
  if (!raw) return DEFAULT_FLIP_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FLIP_INTERVAL_MS;
};

/**
 * Classify with hysteresis cooldown. Same input as
 * classifyVolumeCoverRegime but enforces minimum interval between
 * committed regime flips (default 1h, configurable via env).
 *
 * Returns null if dvol is unusable (matches base classifier).
 */
export const classifyVolumeCoverRegimeHysteretic = (
  dvol: number | null | undefined,
  opts?: {
    thresholds?: VolRegimeThresholds;
    minFlipIntervalMs?: number;
    nowMs?: number;
  }
): RegimeWithHysteresis | null => {
  const raw = classifyVolumeCoverRegime(dvol, opts?.thresholds);
  if (!raw) return null;

  const now = opts?.nowMs ?? Date.now();
  const minInterval = opts?.minFlipIntervalMs ?? readFlipIntervalMs();

  // First-ever classification: commit immediately.
  if (hysteresisState.currentRegime === null) {
    hysteresisState.currentRegime = raw;
    hysteresisState.lastFlipAtMs = now;
    return {
      regime: raw,
      rawClassification: raw,
      flipSuppressed: false,
      lastFlipAtMs: now,
      asOfMs: now
    };
  }

  // Classification unchanged: trivial.
  if (raw === hysteresisState.currentRegime) {
    return {
      regime: raw,
      rawClassification: raw,
      flipSuppressed: false,
      lastFlipAtMs: hysteresisState.lastFlipAtMs,
      asOfMs: now
    };
  }

  // Classification differs from committed: check cooldown.
  const elapsed = now - hysteresisState.lastFlipAtMs;
  if (elapsed < minInterval) {
    // Still in cooldown — suppress the flip, return the committed regime.
    return {
      regime: hysteresisState.currentRegime,
      rawClassification: raw,
      flipSuppressed: true,
      lastFlipAtMs: hysteresisState.lastFlipAtMs,
      asOfMs: now
    };
  }

  // Cooldown elapsed — commit the new regime.
  hysteresisState.currentRegime = raw;
  hysteresisState.lastFlipAtMs = now;
  return {
    regime: raw,
    rawClassification: raw,
    flipSuppressed: false,
    lastFlipAtMs: now,
    asOfMs: now
  };
};

export const __resetVolRegimeHysteresisForTests = (): void => {
  hysteresisState.currentRegime = null;
  hysteresisState.lastFlipAtMs = 0;
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
