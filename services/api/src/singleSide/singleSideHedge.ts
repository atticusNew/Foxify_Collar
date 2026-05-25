/**
 * Single-Side hedge construction (single leg, direction-aware).
 *
 * Differences from VC strangle:
 *   - ONE leg per cover (put for long cover, call for short cover)
 *   - Direction passed in by activate handler
 *   - Strike + size derived from matrix.computeSingleSideHedgeStrike +
 *     matrix.computeSingleSideHedgeSize
 *
 * Reuses VC infrastructure where shared:
 *   - strikeGrid.ts: snap-toward-spot grid round, vol buffer
 *   - venueStrikeGrid.ts: live venue chain lookup
 *   - tightHedge.ts: HedgeExecutor type, executeHedgeStructure pattern
 *
 * Tenor: cell-conditional (3-day for 5% cells; 6-day for 7% cells).
 * Snap to next venue-supported expiry boundary >= cell.hedgeTenorDays.
 */

import { randomUUID } from "node:crypto";
import {
  computeSingleSideHedgeStrike,
  computeSingleSideHedgeSize,
  type SingleSideCellDefinition,
  type SingleSideDirection
} from "./matrix";
import {
  resolveHedgeVenue,
  type HedgeExecutor,
  type HedgeVenueChoice
} from "../volumeCover/tightHedge";
import {
  applyVolBufferAndRound,
  getGridStepUsdc,
  snapHedgeStrike,
  type VolRegime
} from "../volumeCover/strikeGrid";
import { pickClosestStrike } from "../volumeCover/venueStrikeGrid";

export type SingleSideHedgeLeg = {
  legId: string;
  optionKind: "put" | "call";
  strikeUsdc: number;
  expiryIso: string;
  contractsBtc: number;
  intrinsicAtTriggerUsdc: number;
  payoutCoverageUsdc: number;
};

export type SingleSideHedgeStructure = {
  positionId: string;
  cellId: string;
  direction: SingleSideDirection;
  venue: HedgeVenueChoice;
  /** Single-element array (single leg) — same shape as VC for reuse. */
  legs: SingleSideHedgeLeg[];
  expectedTotalCostUsdc: number;
};

const CONTRACT_GRANULARITY_BTC = 0.1;

const computeExpiryIso = (tenorDays: number, nowMs: number = Date.now()): string => {
  const expiryDate = new Date(nowMs + tenorDays * 86_400_000);
  expiryDate.setUTCHours(8, 0, 0, 0);
  if (expiryDate.getTime() < nowMs) {
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
  }
  // Sanity: must be at least tenorDays - 1 from now
  const minMs = nowMs + (tenorDays - 1) * 86_400_000;
  if (expiryDate.getTime() < minMs) {
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
  }
  return expiryDate.toISOString();
};

/**
 * Build a single-side hedge structure (no execution yet).
 *
 * Async because it can use venueStrikeGrid live chain lookup. Falls
 * back to static grid snap when no provider wired or fetch fails.
 */
export const buildSingleSideHedge = async (params: {
  positionId: string;
  cell: SingleSideCellDefinition;
  direction: SingleSideDirection;
  entryBtcPrice: number;
  regime?: VolRegime | null;
  /** Override granularity (default 0.1 BTC). */
  contractGranularityBtc?: number;
  /** Override tenor for testing (default = cell.hedgeTenorDays). */
  tenorDaysOverride?: number;
  /** Test-only: override expiry calculation timestamp. */
  nowMs?: number;
}): Promise<SingleSideHedgeStructure> => {
  const { cell, direction, entryBtcPrice } = params;
  const tenorDays = params.tenorDaysOverride ?? cell.hedgeTenorDays;
  const expiryIso = computeExpiryIso(tenorDays, params.nowMs);

  // Compute ideal strike + option kind
  const ideal = computeSingleSideHedgeStrike({ cell, entryBtcPrice, direction });

  // Resolve venue (Bullish primary for 2%/5%; Deribit primary for 7%+)
  // — adapted for single-side cells.
  const venueChoice = resolveSingleSideVenue(cell);
  const gridStep = getGridStepUsdc(venueChoice.primary);

  // Compute trigger boundary for the snap call
  const triggerBoundary =
    direction === "long"
      ? entryBtcPrice * (1 - cell.triggerPct)
      : entryBtcPrice * (1 + cell.triggerPct);

  // Try live venue chain lookup first (catches non-grid strikes)
  let snappedStrike: number;
  try {
    const live = await pickClosestStrike({
      query: { venue: venueChoice.primary, expiryIso, optionKind: ideal.optionKind },
      idealStrikeUsdc: ideal.strikeUsdc,
      spotUsdc: entryBtcPrice,
      triggerBoundaryUsdc: triggerBoundary
    });
    snappedStrike =
      live ??
      snapHedgeStrike({
        optionKind: ideal.optionKind,
        idealStrikeUsdc: ideal.strikeUsdc,
        spotUsdc: entryBtcPrice,
        triggerBoundaryUsdc: triggerBoundary,
        gridStepUsdc: gridStep
      });
  } catch {
    snappedStrike = snapHedgeStrike({
      optionKind: ideal.optionKind,
      idealStrikeUsdc: ideal.strikeUsdc,
      spotUsdc: entryBtcPrice,
      triggerBoundaryUsdc: triggerBoundary,
      gridStepUsdc: gridStep
    });
  }

  // Vol-buffered sizing
  const volBuffer = volBufferFor(params.regime ?? null);
  const sized = computeSingleSideHedgeSize({
    cell,
    entryBtcPrice,
    granularityBtc: params.contractGranularityBtc ?? CONTRACT_GRANULARITY_BTC,
    volBufferMultiplier: volBuffer
  });

  return {
    positionId: params.positionId,
    cellId: cell.cellId,
    direction,
    venue: venueChoice.primary,
    legs: [
      {
        legId: `ss-leg-${randomUUID()}`,
        optionKind: ideal.optionKind,
        strikeUsdc: snappedStrike,
        expiryIso,
        contractsBtc: sized.contractsBtc,
        intrinsicAtTriggerUsdc: sized.intrinsicAtTriggerUsdc,
        payoutCoverageUsdc: cell.payoutUsdc
      }
    ],
    expectedTotalCostUsdc: 0 // populated by executor; reused by VC pattern
  };
};

const VOL_BUFFERS: Record<VolRegime, number> = {
  calm: 1.0,
  moderate: 1.05,
  elevated: 1.10,
  stress: 1.15
};

const volBufferFor = (regime: VolRegime | null): number => {
  if (process.env.SS_VOL_BUFFER_ENABLED === "false") return 1.0;
  if (!regime) return 1.0;
  return VOL_BUFFERS[regime] ?? 1.0;
};

/**
 * Resolve the primary + fallback venue for a single-side cell.
 * Reuses VC routing logic; just adapts to SS cell types.
 *
 * Default: 2%/5% triggers route Bullish primary; 7%+ triggers route
 * Deribit primary because Bullish 5% OTM strikes have poor liquidity
 * at 3-day expiry (per BULLISH_LIVE_PRICING_REPORT).
 */
const resolveSingleSideVenue = (cell: SingleSideCellDefinition): {
  primary: HedgeVenueChoice;
  fallback: HedgeVenueChoice | null;
} => {
  const envOverride = process.env.SS_VENUE_ROUTING_JSON;
  if (envOverride) {
    try {
      const parsed = JSON.parse(envOverride);
      const entry = parsed[cell.cellId];
      if (entry?.primary) {
        return {
          primary: entry.primary,
          fallback: entry.fallback ?? null
        };
      }
    } catch {
      // ignore parse error; fall through
    }
  }
  if (cell.triggerPct <= 0.05) {
    return { primary: "bullish", fallback: "deribit" };
  }
  return { primary: "deribit", fallback: "bullish" };
};

/**
 * Execute a single-side hedge structure (single leg, single venue).
 * Falls back to secondary venue on primary failure.
 *
 * Returns the fill details for persistence.
 */
export const executeSingleSideHedge = async (params: {
  structure: SingleSideHedgeStructure;
  cell: SingleSideCellDefinition;
  executor: HedgeExecutor;
}): Promise<{
  venue: HedgeVenueChoice;
  leg: {
    legId: string;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contractsBtc: number;
    fillPriceUsdcPerBtc: number;
    totalCostUsdc: number;
    orderId: string;
    venue: HedgeVenueChoice;
  };
  totalCostUsdc: number;
}> => {
  const routing = resolveSingleSideVenue(params.cell);
  const leg = params.structure.legs[0];
  if (!leg) throw new Error("singleSide hedge structure missing leg");

  let lastError: Error | null = null;
  let fill: {
    venue: HedgeVenueChoice;
    fillPriceUsdcPerBtc: number;
    totalCostUsdc: number;
    orderId: string;
  } | null = null;

  const venuesToTry = [routing.primary, routing.fallback].filter(Boolean) as HedgeVenueChoice[];
  for (const venue of venuesToTry) {
    try {
      fill = await params.executor.buyOptionLeg({
        venue,
        optionKind: leg.optionKind,
        strikeUsdc: leg.strikeUsdc,
        expiryIso: leg.expiryIso,
        contractsBtc: leg.contractsBtc
      });
      if (fill) break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!fill) {
    throw new Error(
      `single-side hedge buy failed: ${lastError?.message ?? "no_venue_filled"}`
    );
  }

  return {
    venue: fill.venue,
    leg: {
      legId: leg.legId,
      optionKind: leg.optionKind,
      strikeUsdc: leg.strikeUsdc,
      expiryIso: leg.expiryIso,
      contractsBtc: leg.contractsBtc,
      fillPriceUsdcPerBtc: fill.fillPriceUsdcPerBtc,
      totalCostUsdc: fill.totalCostUsdc,
      orderId: fill.orderId,
      venue: fill.venue
    },
    totalCostUsdc: fill.totalCostUsdc
  };
};
