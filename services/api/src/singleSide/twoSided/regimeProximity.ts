/**
 * Regime-proximity signal — how close DVOL is to the next regime boundary, and
 * which way it's trending. Surfaced on /foxify/v2/should_activate so the operator
 * (and Foxify's bot) get a HEADS-UP as DVOL approaches the calm→moderate line,
 * instead of only the binary good_to_activate flip AFTER the cross.
 *
 * Learned from the 2026-06-02 cross: a DVOL-threshold gate is inherently lagging
 * (DVOL rises because price already moved). Proximity + trend let you pre-position.
 *
 * Pure function — bands match classifyRegime (calm<40, moderate<60, elevated<85, stress).
 */

import { classifyRegime, type Regime } from "./featureFlag";

export const REGIME_BANDS: ReadonlyArray<{ regime: Regime; lo: number; hi: number }> = [
  { regime: "calm", lo: 0, hi: 40 },
  { regime: "moderate", lo: 40, hi: 60 },
  { regime: "elevated", lo: 60, hi: 85 },
  { regime: "stress", lo: 85, hi: Infinity }
];

const UP: Record<Regime, Regime | null> = { calm: "moderate", moderate: "elevated", elevated: "stress", stress: null };

export type RegimeTrend = "rising" | "falling" | "flat" | "unknown";

export type RegimeProximity = {
  dvol: number | null;
  regime: Regime | null;
  next_regime_up: Regime | null;
  next_threshold_up: number | null;   // DVOL value of the next-up boundary
  dvol_to_next_up: number | null;      // distance to next-up boundary (>=0)
  lower_threshold: number | null;      // current regime's lower boundary (null for calm)
  dvol_to_lower: number | null;        // distance down to dropping a regime
  approaching_up: boolean;             // within nearBandUp of the next-up boundary
  near_lower: boolean;                 // within nearBandUp of the lower boundary (about to drop)
  trend: RegimeTrend;
  trend_delta: number | null;          // DVOL change over the trend lookback
  note: string;
};

export const computeRegimeProximity = (
  dvol: number | null | undefined,
  opts: { nearBandUp?: number; trendDelta?: number | null } = {}
): RegimeProximity => {
  const nearBand = opts.nearBandUp ?? 2.0;
  if (dvol == null || !Number.isFinite(dvol)) {
    return {
      dvol: null, regime: null, next_regime_up: null, next_threshold_up: null,
      dvol_to_next_up: null, lower_threshold: null, dvol_to_lower: null,
      approaching_up: false, near_lower: false, trend: "unknown", trend_delta: null,
      note: "DVOL unavailable."
    };
  }
  const regime = classifyRegime(dvol);
  const band = REGIME_BANDS.find((b) => b.regime === regime)!;
  const nextUp = UP[regime];
  const nextThresholdUp = Number.isFinite(band.hi) ? band.hi : null;
  const dvolToNextUp = nextThresholdUp != null ? +(nextThresholdUp - dvol).toFixed(2) : null;
  const lowerThreshold = band.lo > 0 ? band.lo : null;
  const dvolToLower = lowerThreshold != null ? +(dvol - lowerThreshold).toFixed(2) : null;
  const approachingUp = dvolToNextUp != null && dvolToNextUp <= nearBand;
  const nearLower = dvolToLower != null && dvolToLower <= nearBand;

  const td = opts.trendDelta;
  const trend: RegimeTrend = td == null ? "unknown" : td > 0.2 ? "rising" : td < -0.2 ? "falling" : "flat";

  let note: string;
  if (nextUp && approachingUp) {
    note = `DVOL ${dvol.toFixed(1)} is ${dvolToNextUp} below the ${nextUp} line (${nextThresholdUp})` +
      (trend === "rising" ? ` and RISING — a cross into ${nextUp} looks imminent; pre-position.` : trend === "falling" ? ` but FALLING — may not cross.` : `.`);
  } else if (nearLower && trend === "falling") {
    note = `DVOL ${dvol.toFixed(1)} is only ${dvolToLower} above the lower ${regime} boundary and FALLING — risk of dropping a regime.`;
  } else if (nextThresholdUp != null) {
    note = `DVOL ${dvol.toFixed(1)} in ${regime}; ${dvolToNextUp} to ${nextUp} (${nextThresholdUp}). Trend ${trend}.`;
  } else {
    note = `DVOL ${dvol.toFixed(1)} in ${regime} (top band). Trend ${trend}.`;
  }

  return {
    dvol: +dvol.toFixed(2), regime, next_regime_up: nextUp, next_threshold_up: nextThresholdUp,
    dvol_to_next_up: dvolToNextUp, lower_threshold: lowerThreshold, dvol_to_lower: dvolToLower,
    approaching_up: approachingUp, near_lower: nearLower, trend, trend_delta: td ?? null, note
  };
};
