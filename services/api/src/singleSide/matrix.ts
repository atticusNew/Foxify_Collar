/**
 * Single-Side Protection Matrix — Pilot relaunch (2026-05-16)
 *
 * Replacement for the deprecated biweekly product. Foxify-facing
 * single-leg directional protection. Foxify bot opens a long/short
 * perp on their venue + buys our protection on the matching side.
 *
 * Differences from Volume Cover (strangle):
 *   - ONE option per cover (put for short cover, call for long cover)
 *   - Smaller hedge cost per cover; cleaner economics
 *   - Direction-aware (side: "long" | "short" determines option kind)
 *
 * 5 cells (per CEO 2026-05-16). 50k/2% added back per user request.
 *
 * Tenor decision is CELL-CONDITIONAL based on Bullish liquidity per
 * report 26_BIWEEKLY_BULLISH_LIVE_PRICING_REPORT.md:
 *   - 5% trigger cells: 3-day expiry has 6% spread, tradeable
 *   - 7% trigger cells: 5% OTM strike at 3-day has 26% spread,
 *     unusable. Use 6-day expiry where spread is ~5%.
 *
 * Pricing (calm-regime base) anchored to LIVE Bullish prices:
 *   - 50k/2%/$1k:   $310/day  (3d, 1% OTM hedge)
 *   - 50k/5%/$2.5k: $140/day  (3d, 3% OTM hedge)
 *   - 50k/7%/$3.5k: $310/day  (6d, 5% OTM hedge)
 *   - 200k/5%/$10k: $600/day  (3d, 3% OTM hedge)  ← CEO launch product
 *   - 200k/7%/$14k: $1,250/day (6d, 5% OTM hedge)
 *
 * IV-aware dynamic pricing applies on top of base price.
 * Regime overlays apply on top of IV-scaled price.
 */

import Decimal from "decimal.js";

export type SingleSideCellId =
  | "ss_50k_2pct_1k"
  | "ss_50k_5pct_2_5k"
  | "ss_50k_7pct_3_5k"
  | "ss_200k_5pct_10k"
  | "ss_200k_7pct_14k";

export type SingleSideDirection = "long" | "short";

export type SingleSideCellDefinition = {
  cellId: SingleSideCellId;
  /** Trader's perp notional, USDC. */
  notionalUsdc: number;
  /** Trigger distance from entry, fraction (0.02 = ±2%). */
  triggerPct: number;
  /** Fixed payout to Foxify on touch, USDC. */
  payoutUsdc: number;
  /** Hedge strike distance from spot, fraction (must be < triggerPct). */
  hedgePct: number;
  /** Calm-regime base premium, USD per cover per day. */
  dailyPremiumUsdc: number;
  /** Hedge tenor in days — cell-conditional per Bullish liquidity. */
  hedgeTenorDays: number;
  /** Conservative max concurrent positions per day per cell. */
  defaultThrottleMaxPerDay: number;
};

/**
 * Canonical 5-cell matrix. Anchored to live Bullish pricing 2026-05-16.
 * Tenor cell-conditional per liquidity findings.
 */
export const SINGLE_SIDE_MATRIX: readonly SingleSideCellDefinition[] = [
  {
    cellId: "ss_50k_2pct_1k",
    notionalUsdc: 50_000,
    triggerPct: 0.02,
    payoutUsdc: 1_000,
    hedgePct: 0.01,
    dailyPremiumUsdc: 310,
    hedgeTenorDays: 3,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "ss_50k_5pct_2_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.05,
    payoutUsdc: 2_500,
    hedgePct: 0.03,
    dailyPremiumUsdc: 140,
    hedgeTenorDays: 3,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "ss_50k_7pct_3_5k",
    notionalUsdc: 50_000,
    triggerPct: 0.07,
    payoutUsdc: 3_500,
    hedgePct: 0.05,
    dailyPremiumUsdc: 310,
    hedgeTenorDays: 6,
    defaultThrottleMaxPerDay: 5
  },
  {
    cellId: "ss_200k_5pct_10k",
    notionalUsdc: 200_000,
    triggerPct: 0.05,
    payoutUsdc: 10_000,
    hedgePct: 0.03,
    dailyPremiumUsdc: 600,
    hedgeTenorDays: 3,
    defaultThrottleMaxPerDay: 3
  },
  {
    cellId: "ss_200k_7pct_14k",
    notionalUsdc: 200_000,
    triggerPct: 0.07,
    payoutUsdc: 14_000,
    hedgePct: 0.05,
    dailyPremiumUsdc: 1_250,
    hedgeTenorDays: 6,
    defaultThrottleMaxPerDay: 2
  }
];

export const findCellById = (cellId: string): SingleSideCellDefinition | null => {
  return SINGLE_SIDE_MATRIX.find((c) => c.cellId === cellId) ?? null;
};

export const findCellByDimensions = (params: {
  notionalUsdc: number;
  triggerPct: number;
}): SingleSideCellDefinition | null => {
  return SINGLE_SIDE_MATRIX.find(
    (c) =>
      c.notionalUsdc === params.notionalUsdc &&
      Math.abs(c.triggerPct - params.triggerPct) < 0.001
  ) ?? null;
};

/**
 * Compute the trigger price for a cover at a given entry spot.
 *
 * For LONG cover (Foxify trader long perp; protects against drop):
 *   trigger = entry × (1 - triggerPct)  ← only this side
 *
 * For SHORT cover (Foxify trader short perp; protects against rise):
 *   trigger = entry × (1 + triggerPct)  ← only this side
 *
 * Note: single-side has only ONE trigger boundary, not two.
 */
export const computeSingleSideTriggerPrice = (params: {
  cell: SingleSideCellDefinition;
  entryBtcPrice: number;
  direction: SingleSideDirection;
}): number => {
  const entry = new Decimal(params.entryBtcPrice);
  const offset = entry.mul(params.cell.triggerPct);
  if (params.direction === "long") {
    // Long cover triggers when spot drops below entry × (1 - triggerPct)
    return entry.minus(offset).toNumber();
  }
  // Short cover triggers when spot rises above entry × (1 + triggerPct)
  return entry.plus(offset).toNumber();
};

/**
 * Compute the hedge strike for a cover.
 *
 * SHORT cover → buy CALL hedge. Strike at entry × (1 + hedgePct)
 *   (call is OTM at entry; becomes ITM if spot rises past strike;
 *    fully ITM at trigger; intrinsic at trigger = entry × (triggerPct - hedgePct))
 *
 * LONG cover → buy PUT hedge. Strike at entry × (1 - hedgePct)
 *   (put OTM at entry; ITM if spot drops; fully ITM at trigger.)
 */
export const computeSingleSideHedgeStrike = (params: {
  cell: SingleSideCellDefinition;
  entryBtcPrice: number;
  direction: SingleSideDirection;
}): { strikeUsdc: number; optionKind: "put" | "call" } => {
  const entry = new Decimal(params.entryBtcPrice);
  const hedgeOffset = entry.mul(params.cell.hedgePct);
  if (params.direction === "long") {
    return {
      strikeUsdc: entry.minus(hedgeOffset).toNumber(),
      optionKind: "put"
    };
  }
  return {
    strikeUsdc: entry.plus(hedgeOffset).toNumber(),
    optionKind: "call"
  };
};

/**
 * Required hedge contract size in BTC.
 * Sized so that intrinsic-at-trigger × contracts = payout.
 *
 *   intrinsic_at_trigger_per_BTC = entry × (triggerPct - hedgePct)
 *   contracts = payout / intrinsic_at_trigger_per_BTC
 *
 * Then rounded UP to venue contract granularity (typically 0.1 BTC).
 *
 * P1c-equivalent: applies optional vol-buffer multiplier when regime
 * is provided (1.0× calm, 1.05× moderate, 1.10× elevated, 1.15× stress).
 */
export const computeSingleSideHedgeSize = (params: {
  cell: SingleSideCellDefinition;
  entryBtcPrice: number;
  granularityBtc?: number;
  volBufferMultiplier?: number;
}): { contractsBtc: number; intrinsicAtTriggerUsdc: number } => {
  const granularity = params.granularityBtc ?? 0.1;
  const buffer = params.volBufferMultiplier ?? 1.0;
  const intrinsicPerBtc = new Decimal(params.entryBtcPrice).mul(
    new Decimal(params.cell.triggerPct).minus(params.cell.hedgePct)
  );
  if (intrinsicPerBtc.lte(0)) {
    throw new Error(
      `single-side hedge sizing failed: intrinsicPerBtc=${intrinsicPerBtc.toString()} for cell ${params.cell.cellId}`
    );
  }
  const baseContracts = new Decimal(params.cell.payoutUsdc).div(intrinsicPerBtc);
  const buffered = baseContracts.mul(buffer);
  const contractsBtc = buffered
    .div(granularity)
    .toDecimalPlaces(0, Decimal.ROUND_UP)
    .mul(granularity);
  return {
    contractsBtc: contractsBtc.toNumber(),
    intrinsicAtTriggerUsdc: intrinsicPerBtc.toNumber()
  };
};

/**
 * Validate matrix invariants. Called at module load.
 */
const validateMatrix = (): void => {
  for (const cell of SINGLE_SIDE_MATRIX) {
    if (cell.hedgePct >= cell.triggerPct) {
      throw new Error(
        `single-side matrix invariant: ${cell.cellId} hedgePct ${cell.hedgePct} >= triggerPct ${cell.triggerPct}`
      );
    }
    if (cell.payoutUsdc <= 0 || cell.dailyPremiumUsdc <= 0 || cell.notionalUsdc <= 0) {
      throw new Error(`single-side matrix invariant: ${cell.cellId} non-positive value`);
    }
    if (cell.hedgeTenorDays < 1 || cell.hedgeTenorDays > 14) {
      throw new Error(`single-side matrix invariant: ${cell.cellId} tenor ${cell.hedgeTenorDays} out of range [1,14]`);
    }
  }
};

validateMatrix();
