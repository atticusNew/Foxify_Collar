/**
 * Activation gate — combines DVOL regime + IV/RV vol risk premium to recommend
 * whether THIS moment is good for Foxify's bot to activate a new pair.
 *
 * Logic:
 *   - regime moderate/elevated/stress (DVOL ≥ 40) → activate (existing default)
 *   - regime calm (DVOL < 40):
 *       - if VRP = (IV - RV) is negative (implied < realized) → good (rare)
 *       - if VRP positive (typical calm pattern) → wait
 *
 * Returns a structured recommendation that Foxify's bot can poll and act on.
 * Also surfaces the cheapest currently-tradable cell so the bot knows what to
 * activate when the signal is green.
 */

import type { DvolService } from "./dvolService";
import type { RvService } from "./rvService";
import type { LiquidChainCache } from "./liquidChainCache";

export type ActivationGateInputs = {
  dvolService: DvolService;
  rvService: RvService;
  liquidChainCache?: LiquidChainCache | null;
  /** VRP threshold for calm-regime override. Tightened to -0.015 (was -0.02)
   * 2026-05-28 based on observation that pair_50k_5pct_otm showed +EV at
   * VRP=-1.01% (with Bullish active), suggesting -2% was too conservative.
   * -1.5% catches that scenario while still requiring meaningfully negative
   * vol risk premium. Operator may override per-call. */
  calmVrpThreshold?: number;
  nowMs?: number;
};

export type SignalTier = "negative" | "slightly_negative" | "slightly_positive" | "positive";

export type ActivationGateResult = {
  good_to_activate: boolean;
  regime: "calm" | "moderate" | "elevated" | "stress" | null;
  dvol: number | null;
  iv_annual: number | null;
  rv_annual: number | null;
  vrp: number | null;                     // IV - RV
  vrp_threshold_for_calm: number;
  /** Human-readable reason: why good_to_activate is true OR false */
  reason: string;
  /** Cells operator + V6 suggest for current conditions (ranked by EV) */
  recommended_cells: string[];
  /** What the bot should poll for if not currently good */
  next_check_signal: string;
  asOf: string;
  /** Optional venue routing health */
  venue_status?: { deribit?: boolean; bullish?: boolean };
  /**
   * Tier breakout of the underlying signal strength. ADDITIVE — does not
   * change the binary good_to_activate decision (which still uses precise
   * VRP vs threshold), but exposes more nuance for the operator/CEO.
   *
   *  - negative          → clear WAIT (calm regime, IV well above RV)
   *  - slightly_negative → borderline WAIT (calm regime, IV modestly above RV)
   *  - slightly_positive → borderline GO (just crossed favorable threshold)
   *  - positive          → clear GO (active regime OR calm with deeply negative VRP)
   *
   * In calm regime, tier is driven by VRP gap vs threshold.
   * In moderate/elevated/stress regimes, tier is driven by DVOL depth into the band.
   */
  signal_tier: SignalTier;
  /** Continuous score in [-1, +1] used to derive signal_tier. */
  signal_score: number;
  /** One-line plain-English interpretation of the tier. */
  signal_label: string;
};

/**
 * Classify the activation signal into one of 4 tiers using the SAME precise
 * measurements that drive the binary good_to_activate decision (regime + VRP).
 * Pure function — no I/O.
 *
 * Calm regime (decision based on VRP < calmVrpThreshold):
 *   gap = calmVrpThreshold − VRP    (positive ⇒ favorable)
 *   score = clamp(gap / 0.015, −1, +1)
 *
 * Moderate/elevated/stress regime (decision is always good_to_activate):
 *   score derived from DVOL depth into the band, capped at +1.
 *
 * Bucket thresholds (symmetric around 0):
 *   score ≤ −0.5            → "negative"
 *   −0.5 < score ≤  0       → "slightly_negative"
 *    0  < score ≤  0.5      → "slightly_positive"
 *   score >  0.5            → "positive"
 */
export const classifySignalTier = (params: {
  regime: "calm" | "moderate" | "elevated" | "stress" | null;
  vrp: number | null;
  calmVrpThreshold: number;
  dvol: number | null;
}): { tier: SignalTier; score: number; label: string } => {
  const { regime, vrp, calmVrpThreshold, dvol } = params;

  // No regime info → can't classify; assume worst-case negative
  if (regime == null) {
    return {
      tier: "negative",
      score: -1,
      label: "Signal unavailable — no regime data, treating as WAIT"
    };
  }

  // Stress: always strong positive
  if (regime === "stress") {
    return {
      tier: "positive",
      score: 1,
      label: "Strong GO — stress regime, high realized volatility, options pay back fast"
    };
  }

  // Elevated: positive, score grows past 0.5 as DVOL climbs from 60 toward 100
  if (regime === "elevated") {
    const d = dvol ?? 65;
    const score = Math.min(1, 0.5 + (d - 60) / 40);
    return {
      tier: "positive",
      score: Math.max(0.5, score),
      label: "Strong GO — elevated regime, sustained realized volatility"
    };
  }

  // Moderate: borderline good — sits in slightly_positive band
  if (regime === "moderate") {
    const d = dvol ?? 50;
    // DVOL 40 → 0.05, DVOL 60 → 0.45 (stays in slightly_positive)
    const score = Math.min(0.45, Math.max(0.05, (d - 40) / 45));
    return {
      tier: "slightly_positive",
      score,
      label: "Borderline GO — moderate regime, conditions are favorable but not deep"
    };
  }

  // Calm: tier driven by VRP gap vs threshold
  if (vrp == null) {
    return {
      tier: "negative",
      score: -1,
      label: "Strong WAIT — calm regime and RV data unavailable, defaulting to halt"
    };
  }

  // gap > 0 means VRP is below the threshold (favorable); gap < 0 means VRP exceeds threshold (unfavorable)
  const gap = calmVrpThreshold - vrp;
  // Scale: 1.5% wide bands on either side of the threshold
  const score = Math.max(-1, Math.min(1, gap / 0.015));

  if (score <= -0.5) {
    return {
      tier: "negative",
      score,
      label: "Strong WAIT — calm regime, implied vol well above realized (options expensive)"
    };
  }
  if (score <= 0) {
    return {
      tier: "slightly_negative",
      score,
      label: "Borderline WAIT — calm regime, implied modestly above realized (VRP narrowing)"
    };
  }
  if (score <= 0.5) {
    return {
      tier: "slightly_positive",
      score,
      label: "Borderline GO — calm regime, VRP just crossed favorable threshold"
    };
  }
  return {
    tier: "positive",
    score,
    label: "Strong GO — calm regime with deeply negative VRP (realized > implied, +EV to buy)"
  };
};

export const computeActivationGate = async (inputs: ActivationGateInputs): Promise<ActivationGateResult> => {
  const now = inputs.nowMs ?? Date.now();
  const dvolSample = inputs.dvolService.getCurrentDvol(now);
  const rvSample = inputs.rvService.getCurrentRv(now);
  const calmVrpThreshold = inputs.calmVrpThreshold ?? -0.015;
  const asOf = new Date(now).toISOString();

  // Venue status from cache (if provided)
  let venueStatus: { deribit?: boolean; bullish?: boolean } | undefined;
  if (inputs.liquidChainCache) {
    const snap = inputs.liquidChainCache.getCached();
    if (snap) {
      venueStatus = {
        deribit: snap.venueStatus.deribit?.ok,
        bullish: snap.venueStatus.bullish?.ok
      };
    }
  }

  // Bail out if DVOL is missing — can't make a regime call without it
  if (!dvolSample) {
    const tierInfo = classifySignalTier({ regime: null, vrp: null, calmVrpThreshold, dvol: null });
    return {
      good_to_activate: false,
      regime: null,
      dvol: null,
      iv_annual: null,
      rv_annual: rvSample?.rvAnnual ?? null,
      vrp: null,
      vrp_threshold_for_calm: calmVrpThreshold,
      reason: "dvol_unavailable",
      recommended_cells: [],
      next_check_signal: "dvol_available",
      asOf,
      venue_status: venueStatus,
      signal_tier: tierInfo.tier,
      signal_score: tierInfo.score,
      signal_label: tierInfo.label
    };
  }

  const ivAnnual = dvolSample.sigmaAnnual;
  const rvAnnual = rvSample?.rvAnnual ?? null;
  const vrp = rvAnnual != null ? ivAnnual - rvAnnual : null;

  // Path 1 — moderate/elevated/stress: always good per V5/V6 sweeps
  if (dvolSample.regime !== "calm") {
    const recommended =
      dvolSample.regime === "moderate"
        ? ["pair_50k_2pct", "pair_25k_5pct_otm_3d", "pair_50k_5pct_otm"]
        : dvolSample.regime === "elevated"
          ? ["pair_50k_2pct", "pair_50k_5pct_otm", "pair_25k_5pct_otm_3d", "pair_50k_4pct_otm_short"]
          : ["pair_50k_2pct", "pair_50k_5pct_otm", "pair_25k_5pct_otm_3d", "pair_50k_4pct_otm_short"];
    const tierInfo = classifySignalTier({ regime: dvolSample.regime, vrp, calmVrpThreshold, dvol: dvolSample.dvol });
    return {
      good_to_activate: true,
      regime: dvolSample.regime,
      dvol: dvolSample.dvol,
      iv_annual: ivAnnual,
      rv_annual: rvAnnual,
      vrp,
      vrp_threshold_for_calm: calmVrpThreshold,
      reason: `regime_${dvolSample.regime}_positive_ev_per_v6_sweep`,
      recommended_cells: recommended,
      next_check_signal: "regime_change",
      asOf,
      venue_status: venueStatus,
      signal_tier: tierInfo.tier,
      signal_score: tierInfo.score,
      signal_label: tierInfo.label
    };
  }

  // Path 2 — calm regime: check VRP for tactical override
  if (vrp == null) {
    const tierInfo = classifySignalTier({ regime: "calm", vrp: null, calmVrpThreshold, dvol: dvolSample.dvol });
    return {
      good_to_activate: false,
      regime: "calm",
      dvol: dvolSample.dvol,
      iv_annual: ivAnnual,
      rv_annual: null,
      vrp: null,
      vrp_threshold_for_calm: calmVrpThreshold,
      reason: "calm_regime_default_halt_and_rv_unavailable",
      recommended_cells: [],
      next_check_signal: "rv_data_available",
      asOf,
      venue_status: venueStatus,
      signal_tier: tierInfo.tier,
      signal_score: tierInfo.score,
      signal_label: tierInfo.label
    };
  }

  // Format VRP with explicit sign and 2dp percentage for human-readable reasons
  const vrpPct = `${vrp >= 0 ? "+" : ""}${(vrp * 100).toFixed(2)}%`;
  const thresholdPct = `${(calmVrpThreshold * 100).toFixed(2)}%`;

  const calmTierInfo = classifySignalTier({ regime: "calm", vrp, calmVrpThreshold, dvol: dvolSample.dvol });

  if (vrp < calmVrpThreshold) {
    // VRP below threshold — realized vol outpacing implied. Buying is +EV.
    return {
      good_to_activate: true,
      regime: "calm",
      dvol: dvolSample.dvol,
      iv_annual: ivAnnual,
      rv_annual: rvAnnual,
      vrp,
      vrp_threshold_for_calm: calmVrpThreshold,
      reason: `calm_regime_vrp_${vrpPct}_below_threshold_${thresholdPct}_buying_is_+ev`,
      // OTM cells dominate when calm + negative VRP (low trigger threshold captures realized moves)
      recommended_cells: ["pair_25k_5pct_otm_3d", "pair_50k_5pct_otm", "pair_25k_5pct_otm_short"],
      next_check_signal: "vrp_rises_above_threshold_or_regime_changes",
      asOf,
      venue_status: venueStatus,
      signal_tier: calmTierInfo.tier,
      signal_score: calmTierInfo.score,
      signal_label: calmTierInfo.label
    };
  }

  // Calm + VRP above threshold — typical pattern, hold
  return {
    good_to_activate: false,
    regime: "calm",
    dvol: dvolSample.dvol,
    iv_annual: ivAnnual,
    rv_annual: rvAnnual,
    vrp,
    vrp_threshold_for_calm: calmVrpThreshold,
    reason: `calm_regime_vrp_${vrpPct}_above_threshold_${thresholdPct}_implied_is_rich`,
    recommended_cells: [],
    next_check_signal: "vrp_drops_below_threshold_or_dvol_crosses_40",
    asOf,
    venue_status: venueStatus,
    signal_tier: calmTierInfo.tier,
    signal_score: calmTierInfo.score,
    signal_label: calmTierInfo.label
  };
};
