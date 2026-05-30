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
  | "30k_2pct_600"
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
  /**
   * Hedge tenor in days for this cell. Tenor is matched to expected
   * Foxify hold time + safety margin so the hedge never expires
   * uncovered. Calibrated 2026-05-19 from refined Monte Carlo using
   * hourly BTC OHLC + observed Foxify hold pattern (closes at ~18.75%
   * of payout in cumulative premium):
   *   - 2% cells: hold ~0.5d → 3d tenor (6× cushion, no uncov tail)
   *   - 5% cells: hold ~2.4d → 5d tenor (2× cushion)
   *   - 10%/15% cells: hold ~9-12d → 14d tenor (>= max hold)
   * Falling back to 14d for any cell that doesn't set this honors
   * the pre-2026-05-19 default behavior.
   *
   * Lower tenors save ~50-70% upfront premium for short-hold cells.
   * MUST NOT be set lower than ~1.5× expected hold or uncovered
   * post-expiry triggers become a tail-risk problem.
   */
  expiryHorizonDays?: number;
  /**
   * Track 2 — vertical spread width in USDC. Defines the strike distance
   * between the long leg (inside trigger) and the short leg (past trigger).
   * Used only by `VOLUME_COVER_HEDGE_STRATEGY=spread` (or `auto` with the
   * cell on the spread-allowlist); ignored by the strangle path.
   *
   * Design B (TIGHT-spread):
   *   long  put  K2 = closest strike to (spot − hedgePct×spot)        (inside trigger)
   *   short put  K1 = K2 − spreadWidthUsdc                            (past trigger)
   *   long  call K3 = closest strike to (spot + hedgePct×spot)        (inside trigger)
   *   short call K4 = K3 + spreadWidthUsdc                            (past trigger)
   *
   * Sizing recipe (intrinsic-floor at trigger):
   *   contracts = payoutUsdc / max(K2 − triggerLow, K4 − triggerHigh)
   *
   * Cell-by-cell rationale lives in
   * docs/VOLUME_COVER_SPREAD_DESIGN_2026_05_22.md §3.
   */
  spreadWidthUsdc?: number;
  /**
   * Track 2 — when true, this cell is allowed to operate in shadow tier
   * only. Activation in the live tier is rejected at the lifecycle gate
   * with `reason: "cell_shadow_only"`. Used to keep diagnostic and
   * test-only cells (`1k_2pct_20`, `30k_2pct_600`) out of live Foxify
   * traffic per operator directive (2026-05-22).
   */
  shadowOnly?: boolean;
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
  /**
   * 30k_2pct_600 — capital-efficient pilot variant of the 2% product.
   *
   * Same trigger/hedge structure as 50k_2pct_1k but smaller notional + payout.
   * Added 2026-05-20 to unblock the live pilot launch when Deribit account
   * balance was insufficient for the 1.3-BTC-per-leg sizing of the 50k
   * cell at then-current IV. Hedge cost ~$1,200 per pair vs ~$1,700 for
   * 50k, so 0.05 BTC ($~3,800) of Deribit collateral comfortably runs
   * 1 pair (or 0.03 BTC tight).
   *
   * Premium scales linearly with payout: $210/day = 60% × 50k's $350.
   * Hedge contracts: $600 / $775.17 ≈ 0.78 BTC → rounded to 0.8 BTC.
   */
  {
    cellId: "30k_2pct_600",
    notionalUsdc: 30_000,
    triggerPct: 0.02,
    payoutUsdc: 600,
    hedgePct: 0.01,
    dailyPremiumUsdc: 210,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 3,
    spreadWidthUsdc: 2_000,
    // 2026-05-22: per operator directive, 30k cell never goes to live
    // production for Foxify. Retained in matrix solely to preserve
    // shadow-tier diagnostic value. Live tier rejects activation.
    shadowOnly: true
  },
  {
    cellId: "50k_2pct_1k",
    notionalUsdc: 50_000,
    triggerPct: 0.02,
    payoutUsdc: 1_000,
    hedgePct: 0.01,
    dailyPremiumUsdc: 350,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 3,
    // 2026-05-23: lowered from 2_000 → 1_000 after live orderbook probe
    // revealed Bullish does NOT list 73k/79k strikes at the 3d weekly
    // expiry — only every $1k from 74k-78k. The $1k width matches what
    // E3/E5 microtests validated (74k/75k/77k/78k all listed).
    spreadWidthUsdc: 1_000
  },
  {
    cellId: "50k_5pct_2_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.05,
    payoutUsdc: 2_500,
    hedgePct: 0.03,
    dailyPremiumUsdc: 200,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 5,
    spreadWidthUsdc: 4_000
  },
  {
    cellId: "50k_10pct_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.10,
    payoutUsdc: 5_000,
    hedgePct: 0.05,
    dailyPremiumUsdc: 100,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 14,
    spreadWidthUsdc: 8_000
  },
  {
    cellId: "200k_5pct_10k",
    notionalUsdc: 200_000,
    triggerPct: 0.05,
    payoutUsdc: 10_000,
    hedgePct: 0.03,
    dailyPremiumUsdc: 800,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 5,
    spreadWidthUsdc: 4_000
  },
  {
    cellId: "200k_10pct_20k",
    notionalUsdc: 200_000,
    triggerPct: 0.10,
    payoutUsdc: 20_000,
    hedgePct: 0.05,
    dailyPremiumUsdc: 400,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 14,
    spreadWidthUsdc: 8_000
  },
  {
    cellId: "200k_15pct_30k",
    notionalUsdc: 200_000,
    triggerPct: 0.15,
    payoutUsdc: 30_000,
    hedgePct: 0.07,
    dailyPremiumUsdc: 370,
    defaultThrottleMaxPerDay: 5,
    expiryHorizonDays: 14,
    spreadWidthUsdc: 12_000
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
    defaultEnabled: false,
    expiryHorizonDays: 3,
    spreadWidthUsdc: 2_000,
    // 2026-05-22: explicit shadowOnly to match operator directive; this
    // is a diagnostic cell only and must not appear in live activation
    // requests.
    shadowOnly: true
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
 * Compute the four IDEAL strike prices for a [DB] TIGHT-spread at the
 * given entry price. These are the "request" strikes; the venue-aware
 * spread builder snaps each to the nearest listed strike on the chosen
 * venue (so K2_actual may differ from K2_ideal by up to half a grid tick).
 *
 *   K1 = K2 − spreadWidthUsdc                  (short put, past trigger)
 *   K2 = spot − hedgePct × spot                (long  put, inside trigger)
 *   K3 = spot + hedgePct × spot                (long  call, inside trigger)
 *   K4 = K3 + spreadWidthUsdc                  (short call, past trigger)
 *
 * Throws if the cell has no `spreadWidthUsdc` set — spread design requires
 * an explicit width per cell to avoid silently mis-sizing capital efficiency.
 */
export const computeSpreadStrikesDB = (params: {
  cell: CellDefinition;
  entryBtcPrice: number;
}): {
  putShortIdealUsdc: number;
  putLongIdealUsdc: number;
  callLongIdealUsdc: number;
  callShortIdealUsdc: number;
  spreadWidthUsdc: number;
} => {
  const width = params.cell.spreadWidthUsdc;
  if (!width || width <= 0) {
    throw new Error(
      `Volume Cover spread strike resolver: cell ${params.cell.cellId} ` +
        `is missing spreadWidthUsdc; cannot compute [DB] strikes.`
    );
  }
  const entry = new Decimal(params.entryBtcPrice);
  const hedgeOffset = entry.mul(params.cell.hedgePct);
  const putLong = entry.minus(hedgeOffset);
  const callLong = entry.plus(hedgeOffset);
  return {
    putShortIdealUsdc: putLong.minus(width).toNumber(),
    putLongIdealUsdc: putLong.toNumber(),
    callLongIdealUsdc: callLong.toNumber(),
    callShortIdealUsdc: callLong.plus(width).toNumber(),
    spreadWidthUsdc: width
  };
};

/**
 * Sanity check: hedge strike must be inside trigger boundary
 * (hedgePct < triggerPct) — this is the TIGHT structure invariant.
 * Throws if invariant violated. Called once at module load and in
 * unit tests.
 *
 * Track 2 additions:
 *   - `spreadWidthUsdc`, if set, must be > 0 and > 2 × hedgeOffset_at_$70k
 *     (loose lower bound: width must place short legs OUTSIDE trigger)
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
    if (cell.spreadWidthUsdc !== undefined) {
      if (cell.spreadWidthUsdc <= 0) {
        throw new Error(
          `Volume Cover matrix invariant violated: cell ${cell.cellId} ` +
            `has non-positive spreadWidthUsdc ${cell.spreadWidthUsdc}.`
        );
      }
      // Width must place short legs past trigger at a reasonable spot.
      // Lower bound check uses spot=$70k as a conservative point.
      const minWidthForSpot70k = (cell.triggerPct - cell.hedgePct) * 70_000;
      if (cell.spreadWidthUsdc < minWidthForSpot70k * 0.5) {
        throw new Error(
          `Volume Cover matrix invariant violated: cell ${cell.cellId} ` +
            `spreadWidthUsdc ${cell.spreadWidthUsdc} is too narrow to ` +
            `place short legs past trigger (min ~${minWidthForSpot70k.toFixed(0)} at spot $70k).`
        );
      }
    }
  }
};

validateMatrixInvariants();
