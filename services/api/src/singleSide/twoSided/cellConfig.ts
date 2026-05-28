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
