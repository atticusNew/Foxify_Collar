/**
 * Cell configuration for the two-sided cooperative volume facility.
 *
 * Phase 0: ONE cell only — pair_50k_2pct (ITM guts strangle).
 * Per PLAN.md §7, the 5% cells are dropped (negative EV under cooperative model)
 * and 100k/3% + 25k/1.5% are Phase 1 candidates pending MC validation.
 */

export type TwoSidedCell = {
  cellId: string;
  notionalUsdcPerLeg: number;          // Foxify perp notional, each side
  triggerPctDown: number;              // 0.02 = ±2%
  triggerPctUp: number;
  contractsBtc: number;                // strangle contracts per leg
  hedgeTenorDays: number;
  /** Strike selection: ITM guts — put strike ABOVE spot, call strike BELOW spot,
   * both 1.3% ITM, snapped to $1k grid. */
  putStrikeItmPct: number;             // 0.013 = put strike is spot × 1.013
  callStrikeItmPct: number;            // 0.013 = call strike is spot × 0.987
  strikeGridUsdc: number;              // Bullish $1k grid
  enabled: boolean;
};

export const PHASE_0_CELLS: Record<string, TwoSidedCell> = {
  // ── Phase 0 (calm baseline) ──
  pair_50k_2pct: {
    cellId: "pair_50k_2pct",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.02,
    triggerPctUp: 0.02,
    contractsBtc: 1.4,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0.013,
    callStrikeItmPct: 0.013,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  // ── Phase 1 cells (per Wave C2 sweep) ──
  pair_100k_3pct_itm_short: {
    cellId: "pair_100k_3pct_itm_short",
    notionalUsdcPerLeg: 100_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 2.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: 0.005,
    callStrikeItmPct: 0.005,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_3pct_atm: {
    cellId: "pair_50k_3pct_atm",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 1.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_5pct_otm: {
    cellId: "pair_50k_5pct_otm",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 1.0,
    hedgeTenorDays: 2,
    putStrikeItmPct: -0.015,  // 1.5% OTM
    callStrikeItmPct: -0.020,  // 2.0% OTM (asymmetric: BTC put-skew)
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * DEPRECATED 2026-05-28. Live MC shows 0% trigger rate at calm (5% boundary
   * in 1d tenor is effectively unreachable at typical BTC vol). Always -EV.
   * Kept in registry for backward compat with old shadow pairs; operator
   * cannot activate (enabled: false). Use pair_25k_5pct_otm_3d instead.
   */
  pair_25k_5pct_otm_short: {
    cellId: "pair_25k_5pct_otm_short",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5,
    hedgeTenorDays: 1,
    putStrikeItmPct: -0.020,
    callStrikeItmPct: -0.025,
    strikeGridUsdc: 1_000,
    enabled: false
  },
  /**
   * pair_25k_5pct_otm_3d — TOP MODERATE-REGIME CELL per cell-redesign sweep
   * 2026-05-28. V3 MC: +$252/pair Foxify EV at moderate regime (DVOL 40-60),
   * crushing pair_25k_5pct_otm_short's +$41. Identical strike geometry, just
   * 3d tenor instead of 1d — more time-value to capture on actual moves.
   * Still loss-making at calm (-$104/pair) — DO NOT include in calm allowlist.
   */
  pair_25k_5pct_otm_3d: {
    cellId: "pair_25k_5pct_otm_3d",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.05,
    triggerPctUp: 0.05,
    contractsBtc: 0.5,
    hedgeTenorDays: 3,
    putStrikeItmPct: -0.020,
    callStrikeItmPct: -0.025,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  pair_50k_4pct_otm_short: {
    cellId: "pair_50k_4pct_otm_short",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.04,
    triggerPctUp: 0.04,
    contractsBtc: 1.0,
    hedgeTenorDays: 1,
    putStrikeItmPct: -0.010,
    callStrikeItmPct: -0.015,
    strikeGridUsdc: 1_000,
    enabled: true
  },
  /**
   * DEPRECATED 2026-05-28. Structurally always -EV across all regimes per
   * V5/V6 sweeps. 4h tenor + 1% boundary + ATM strikes = trigger rate ~26%
   * but salvage per trigger too small (1% × $73k × 0.3 BTC = $220 max raw
   * payoff vs $300-400 cost). Kept for backward compat; cannot activate.
   */
  pair_25k_1pct_atm_micro: {
    cellId: "pair_25k_1pct_atm_micro",
    notionalUsdcPerLeg: 25_000,
    triggerPctDown: 0.01,
    triggerPctUp: 0.01,
    contractsBtc: 0.3,
    hedgeTenorDays: 0.167,  // 4h
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: false
  },
  /**
   * pair_50k_3pct_atm_3d — moderate+ STRADDLE, the friction-aware sweep winner
   * (real-priced 2026-05-31): ATM straddle, 3% trigger, 3-day tenor. Estimate-tier
   * net +$238 (moderate) / +$809 (elevated) / +$1,285 (stress), all 100% profitable
   * and covering the ~$200-300 perp friction with room. NOT for calm (stand-down).
   * NOTE: contractsBtc≈0.68 = 50k notional / ~$74k spot — sizing should track the
   * perp notional (Foxify opens perps at the same size as protection); the legacy
   * hardcoded contractsBtc on older cells is stale vs current spot. Activation is
   * still globally gated by SS_TWO_SIDED_LIVE_ENABLED=false (shadow-only).
   */
  pair_50k_3pct_atm_3d: {
    cellId: "pair_50k_3pct_atm_3d",
    notionalUsdcPerLeg: 50_000,
    triggerPctDown: 0.03,
    triggerPctUp: 0.03,
    contractsBtc: 0.68,
    hedgeTenorDays: 3,
    putStrikeItmPct: 0,
    callStrikeItmPct: 0,
    strikeGridUsdc: 1_000,
    enabled: true
  }
};

/** Pick put + call strikes for the given spot, snapping to grid. */
export const computeStrikes = (cell: TwoSidedCell, spotUsdc: number): { putStrike: number; callStrike: number } => {
  const rawPut = spotUsdc * (1 + cell.putStrikeItmPct);
  const rawCall = spotUsdc * (1 - cell.callStrikeItmPct);
  // Snap put UP to nearest grid (ensures ≥ desired ITM-ness, conservative)
  // Snap call DOWN to nearest grid (same logic for call ITM)
  const putStrike = Math.ceil(rawPut / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  const callStrike = Math.floor(rawCall / cell.strikeGridUsdc) * cell.strikeGridUsdc;
  return { putStrike, callStrike };
};

export const computeTriggerBoundaries = (cell: TwoSidedCell, spotUsdc: number): { triggerDown: number; triggerUp: number } => ({
  triggerDown: spotUsdc * (1 - cell.triggerPctDown),
  triggerUp: spotUsdc * (1 + cell.triggerPctUp)
});

export const getCellOrThrow = (cellId: string): TwoSidedCell => {
  const cell = PHASE_0_CELLS[cellId];
  if (!cell) throw new Error(`Unknown cell: ${cellId}`);
  if (!cell.enabled) throw new Error(`Cell disabled: ${cellId}`);
  return cell;
};
