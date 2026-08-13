/**
 * Foxify Volume Cover — Matrix (single source of truth)
 *
 * Six cells, validated by:
 *   - docs/foxify-pilot-bundle-c/14_SALVAGE_BAND_STRESS_RESULTS.md
 *   - services/api/scripts/backtest/ironCondor/salvageBandStressTest.ts
 *
 * Pricing model: per-pair (Foxify per-leg billing rejected). One Atticus
 * cover per paired long+short trader position. Premium quoted is the
 * total daily cost to Foxify for the pair; one fixed payout on touch.
 *
 * Hedge structure: TIGHT strangle. Strikes placed INSIDE the trigger
 * boundary (hedgePct < triggerPct) so the option is already deep ITM
 * at trigger and salvages near full payout amount.
 */

import Decimal from "decimal.js";

export type CellId =
  | "50k_2pct_1k"
  | "50k_5pct_2_5k"
  | "50k_10pct_5k"
  | "200k_5pct_10k"
  | "200k_10pct_20k"
  | "200k_15pct_30k"
  | "1k_2pct_20";

export type CellDefinition = {
  cellId: CellId;
  /** Pair notional, USDC, EACH leg (so $50k = $50k long + $50k short) */
  notionalUsdc: number;
  /** Trigger distance from entry, fraction (0.02 = ±2%) */
  triggerPct: number;
  /** Fixed payout to Foxify on touch trigger, USDC */
  payoutUsdc: number;
  /** Hedge strike distance from spot, fraction (0.01 = strikes 1% from spot) */
  hedgePct: number;
  /** Daily premium charged to Foxify, USDC, per pair */
  dailyPremiumUsdc: number;
  /**
   * Conservative reference: maximum positions per day per cell
   * Day 1 of pilot. Operator can raise via admin toggle once
   * salvage validated.
   */
  defaultThrottleMaxPerDay: number;
  /**
   * Whether this cell is enabled at first seed. Defaults to true.
   * Set to false for test/diagnostic cells that must be explicitly
   * enabled by operator before use.
   */
  defaultEnabled?: boolean;
};

/**
 * Canonical matrix. Backtested + salvage-band stress validated.
 *
 * IMPORTANT: dailyPremiumUsdc here is the BASE matrix price (the
 * "current" column in salvage band test). Pricing layer can apply
 * regime overlays on top, but base values must match the validated
 * salvage scenarios.
 */
export const MATRIX: readonly CellDefinition[] = [
  {
    cellId: "50k_2pct_1k",
    notionalUsdc: 50_000,
    triggerPct: 0.02,
    payoutUsdc: 1_000,
    hedgePct: 0.01,
    dailyPremiumUsdc: 350,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "50k_5pct_2_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.05,
    payoutUsdc: 2_500,
    hedgePct: 0.03,
    dailyPremiumUsdc: 200,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "50k_10pct_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.10,
    payoutUsdc: 5_000,
    hedgePct: 0.05,
    dailyPremiumUsdc: 100,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "200k_5pct_10k",
    notionalUsdc: 200_000,
    triggerPct: 0.05,
    payoutUsdc: 10_000,
    hedgePct: 0.03,
    dailyPremiumUsdc: 800,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "200k_10pct_20k",
    notionalUsdc: 200_000,
    triggerPct: 0.10,
    payoutUsdc: 20_000,
    hedgePct: 0.05,
    dailyPremiumUsdc: 400,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "200k_15pct_30k",
    notionalUsdc: 200_000,
    triggerPct: 0.15,
    payoutUsdc: 30_000,
    hedgePct: 0.07,
    dailyPremiumUsdc: 370,
    defaultThrottleMaxPerDay: 5
  },
  /**
   * 1k_2pct_20 — TEST/DIAGNOSTIC CELL
   *
   * NOT a production cell. Exists solely to enable cheap real-money
   * validation of the full TP curve / Bullish execution path. Same
   * shape as 50k_2pct_1k but 1/50th the size:
   *   - $1k notional, ±2% trigger, $20 payout
   *   - Hedge contracts size = max(0.026 BTC base, 0.1 BTC granularity)
   *     → effectively 0.1 BTC per leg = ~$18 in real Bullish premium
   *   - Net cost per round-trip: $5-15 after recovery
   *
   * DISABLED by default. Operator must explicitly enable via admin
   * dashboard ('Toggle' button on Cells row) before activating.
   *
   * Hedge math note: the granularity-rounded contracts size means
   * this cell's hedge OVER-COVERS the $20 payout (intrinsic at
   * trigger ~$77 per leg). That's intentional for the test cell —
   * makes salvage > 100% on trigger, which is fine for validation
   * (loss is bounded by hedge cost, not payout).
   *
   * Throttle 1/day for safety; bump if needed.
   */
  {
    cellId: "1k_2pct_20",
    notionalUsdc: 1_000,
    triggerPct: 0.02,
    payoutUsdc: 20,
    hedgePct: 0.01,
    dailyPremiumUsdc: 1,
    defaultThrottleMaxPerDay: 1,
    defaultEnabled: false
  }
];

/**
 * Lookup by cell id. Returns null if no match.
 */
export const findCellById = (cellId: string): CellDefinition | null => {
  return MATRIX.find((c) => c.cellId === cellId) ?? null;
};

/**
 * Lookup cell by (notionalUsdc, triggerPct). Returns null if no match.
 * Tolerance: notional must match exactly; trigger pct compared with
 * 0.001 epsilon (so 0.02 vs 0.0200001 still matches).
 */
export const findCellByDimensions = (params: {
  notionalUsdc: number;
  triggerPct: number;
}): CellDefinition | null => {
  return MATRIX.find(
    (c) =>
      c.notionalUsdc === params.notionalUsdc &&
      Math.abs(c.triggerPct - params.triggerPct) < 0.001
  ) ?? null;
};

/**
 * Compute trigger price boundaries for a position opened at a given
 * BTC entry price.
 */
export const computeTriggerPrices = (params: {
  cell: CellDefinition;
  entryBtcPrice: number;
}): { triggerHighBtc: number; triggerLowBtc: number } => {
  const entry = new Decimal(params.entryBtcPrice);
  const triggerOffset = entry.mul(params.cell.triggerPct);
  return {
    triggerHighBtc: entry.plus(triggerOffset).toNumber(),
    triggerLowBtc: entry.minus(triggerOffset).toNumber()
  };
};

/**
 * Compute TIGHT hedge strike prices for a cell at a given entry price.
 * Strikes are placed INSIDE the trigger boundary (closer to spot) so
 * the option is already in-the-money when the trigger fires.
 */
export const computeHedgeStrikes = (params: {
  cell: CellDefinition;
  entryBtcPrice: number;
}): { putStrikeBtc: number; callStrikeBtc: number } => {
  const entry = new Decimal(params.entryBtcPrice);
  const hedgeOffset = entry.mul(params.cell.hedgePct);
  return {
    putStrikeBtc: entry.minus(hedgeOffset).toNumber(),
    callStrikeBtc: entry.plus(hedgeOffset).toNumber()
  };
};

/**
 * Sanity check: hedge strike must be inside trigger boundary
 * (hedgePct < triggerPct) — this is the TIGHT structure invariant.
 * Throws if invariant violated. Called once at module load and in
 * unit tests.
 */
const validateMatrixInvariants = (): void => {
  for (const cell of MATRIX) {
    if (cell.hedgePct >= cell.triggerPct) {
      throw new Error(
        `Volume Cover matrix invariant violated: cell ${cell.cellId} ` +
          `has hedgePct ${cell.hedgePct} >= triggerPct ${cell.triggerPct}; ` +
          `TIGHT structure requires hedge strikes INSIDE trigger boundary.`
      );
    }
    if (cell.payoutUsdc <= 0 || cell.dailyPremiumUsdc <= 0 || cell.notionalUsdc <= 0) {
      throw new Error(
        `Volume Cover matrix invariant violated: cell ${cell.cellId} has non-positive USDC value.`
      );
    }
  }
};

validateMatrixInvariants();
