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
