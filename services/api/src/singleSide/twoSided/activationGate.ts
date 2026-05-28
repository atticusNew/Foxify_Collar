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
      venue_status: venueStatus
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
      venue_status: venueStatus
    };
  }

  // Path 2 — calm regime: check VRP for tactical override
  if (vrp == null) {
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
      venue_status: venueStatus
    };
  }

  // Format VRP with explicit sign and 2dp percentage for human-readable reasons
  const vrpPct = `${vrp >= 0 ? "+" : ""}${(vrp * 100).toFixed(2)}%`;
  const thresholdPct = `${(calmVrpThreshold * 100).toFixed(2)}%`;

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
      venue_status: venueStatus
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
    venue_status: venueStatus
  };
};
