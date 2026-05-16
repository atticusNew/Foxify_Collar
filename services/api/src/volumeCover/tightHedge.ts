/**
 * Volume Cover — TIGHT hedge construction & execution.
 *
 * Hedging structure:
 *   - Strangle: long put + long call
 *   - Strikes placed INSIDE trigger boundary (TIGHT) so options are
 *     already in-the-money when trigger fires
 *   - Expiry: 1-day (matches Foxify daily premium cadence)
 *   - Contract size: payout obligation / intrinsic-value-at-trigger
 *
 * For a $1,000 payout cell with 1% hedge inside 2% trigger:
 *   - Intrinsic value at trigger = 1% of BTC price = $800 at $80k spot
 *   - Hedge size = $1,000 / $800 = 1.25 BTC equivalent
 *   - On Bullish (0.1 BTC contracts): 13 contracts (round up)
 *
 * Multi-venue routing: Bullish primary for ±2%/±5%, Deribit for wider
 * tiers, per existing pilot/multiVenueRouter logic adapted to Volume
 * Cover trigger pcts.
 */

import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { computeHedgeStrikes, computeTriggerPrices, type CellDefinition } from "./matrix";
import {
  applyVolBufferAndRound,
  getGridStepUsdc,
  snapHedgeStrike,
  type VolRegime
} from "./strikeGrid";

export type HedgeVenueChoice = "bullish" | "deribit";

export type HedgeLegSpec = {
  optionKind: "put" | "call";
  strikeUsdc: number;
  expiryIso: string;
  /** BTC notional to be hedged for this leg */
  contractsBtc: number;
  /** Intrinsic value of one BTC at trigger price (in USDC) */
  intrinsicAtTriggerUsdc: number;
  /** Payout this leg is obligated to cover (= position payout for symmetric strangle) */
  payoutCoverageUsdc: number;
};

export type HedgeStructure = {
  positionId: string;
  cellId: string;
  venue: HedgeVenueChoice;
  legs: HedgeLegSpec[];
  expectedTotalCostUsdc: number;
};

/**
 * Multi-venue routing for Volume Cover trigger pcts.
 *
 * Diverges from the per-trade pilot router because Volume Cover trigger
 * pcts (2/5/10/15) don't 1:1 to pilot SL tiers; we route based on
 * Bullish strike grid availability at the TIGHT hedge strike (which is
 * INSIDE the trigger, so closer to spot than the pilot product needs).
 *
 * Day 1 routing decision:
 *   ±2% trigger (1% hedge strike) → Bullish primary (tight ATM coverage)
 *   ±5% trigger (3% hedge strike) → Bullish primary, Deribit fallback
 *   ±10% trigger (5% hedge strike) → Deribit primary (Bullish 5% strikes sparse)
 *   ±15% trigger (7% hedge strike) → Deribit primary
 *
 * Operator override via VOLUME_COVER_VENUE_ROUTING_JSON env.
 */
/** Normalized to JS String() output (no trailing zeros). 0.10 → "0.1", 0.02 → "0.02". */
const DEFAULT_ROUTING: Record<string, { primary: HedgeVenueChoice; fallback: HedgeVenueChoice | null }> = {
  "0.02": { primary: "bullish", fallback: "deribit" },
  "0.05": { primary: "bullish", fallback: "deribit" },
  "0.1":  { primary: "deribit", fallback: "bullish" },
  "0.15": { primary: "deribit", fallback: null }
};

const normalizeTriggerKey = (triggerPct: number): string => {
  // Use a fixed-precision representation then strip trailing zeros so
  // 0.10 and 0.1 both resolve to "0.1"; 0.020 and 0.02 both resolve to "0.02".
  const fixed = triggerPct.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
};

export const resolveHedgeVenue = (cell: CellDefinition): {
  primary: HedgeVenueChoice;
  fallback: HedgeVenueChoice | null;
} => {
  const key = normalizeTriggerKey(cell.triggerPct);
  const envRaw = process.env.VOLUME_COVER_VENUE_ROUTING_JSON;
  if (envRaw && envRaw.trim()) {
    try {
      const parsed = JSON.parse(envRaw);
      // Try both normalized and raw keys to support either env format
      const envEntry = parsed[key] ?? parsed[String(cell.triggerPct)];
      if (envEntry) {
        return {
          primary: envEntry.primary || DEFAULT_ROUTING[key]?.primary || "bullish",
          fallback: envEntry.fallback === undefined
            ? (DEFAULT_ROUTING[key]?.fallback ?? null)
            : envEntry.fallback
        };
      }
    } catch {
      // Fall through to default on parse error
    }
  }
  return DEFAULT_ROUTING[key] || { primary: "bullish", fallback: "deribit" };
};

/**
 * Compute the BTC contract size required so that the strangle's total
 * intrinsic value at trigger covers the cell's payout obligation.
 *
 * Returns a generous size (rounded up to venue contract granularity)
 * so we are over-hedged rather than under-hedged.
 */
export const computeHedgeContractSize = (params: {
  cell: CellDefinition;
  entryBtcPrice: number;
  /** Venue contract granularity in BTC. Bullish=0.1, Deribit=0.1 typically. */
  contractGranularityBtc?: number;
  /** Optional vol regime for vol-buffered sizing (P1c). null = no buffer. */
  regime?: VolRegime | null;
}): { contractsBtc: number; intrinsicAtTriggerUsdc: number } => {
  const granularity = params.contractGranularityBtc ?? 0.1;
  // Intrinsic at trigger = (trigger_price - hedge_strike) per BTC
  // Trigger is at entry × (1 ± triggerPct); hedge strike is at entry × (1 ± hedgePct)
  // For the put leg at downside trigger: intrinsic = hedge_strike - trigger_price
  //   = entry × (1 - hedgePct) - entry × (1 - triggerPct)
  //   = entry × (triggerPct - hedgePct)
  // For the call leg at upside trigger: same formula by symmetry.
  const intrinsicPerBtc = new Decimal(params.entryBtcPrice).mul(
    new Decimal(params.cell.triggerPct).minus(params.cell.hedgePct)
  );
  if (intrinsicPerBtc.lte(0)) {
    throw new Error(
      `Volume Cover hedge sizing failed: intrinsicPerBtc=${intrinsicPerBtc.toString()} for cell ${params.cell.cellId}`
    );
  }
  // Required BTC = payout / intrinsic per BTC
  const baseRequiredBtc = new Decimal(params.cell.payoutUsdc).div(intrinsicPerBtc).toNumber();
  // P1c: vol-buffer + grid round-up
  const contractsBtc = applyVolBufferAndRound({
    baseContractsBtc: baseRequiredBtc,
    regime: params.regime ?? null,
    granularityBtc: granularity
  });
  return {
    contractsBtc,
    intrinsicAtTriggerUsdc: intrinsicPerBtc.toNumber()
  };
};

/**
 * Build a TIGHT hedge structure (without executing).
 *
 * Returns the spec for both option legs; lifecycle layer wires this
 * into the venue adapter for actual order placement.
 *
 * Expiry: 1-day from now, snapped to next venue-supported expiry
 * boundary (typically 08:00 UTC). For MVP we use 1-day rolling and
 * let the venue adapter snap to the nearest available expiry.
 */
export const buildHedgeStructure = (params: {
  positionId: string;
  cell: CellDefinition;
  entryBtcPrice: number;
  expiryHorizonDays?: number;
  contractGranularityBtc?: number;
  /** Venue-mark unit prices (USDC per BTC) — optional, used for expectedTotalCostUsdc */
  venueMarkPutPriceUsdc?: number;
  venueMarkCallPriceUsdc?: number;
  /** P1c: optional vol regime for sizing buffer + can override grid step */
  regime?: VolRegime | null;
  /** P1c: optional grid-step override (e.g., from venue strike grid lookup). */
  gridStepUsdcOverride?: number;
}): HedgeStructure => {
  const venue = resolveHedgeVenue(params.cell);
  // P1c: compute ideal strikes, then snap to venue grid (round toward
  // spot) so strikes always exist on venue AND stay inside the trigger
  // band. Falls back to ideal-only behavior if grid step is 0.
  const { putStrikeBtc: idealPutStrike, callStrikeBtc: idealCallStrike } = computeHedgeStrikes({
    cell: params.cell,
    entryBtcPrice: params.entryBtcPrice
  });
  const { triggerLowBtc, triggerHighBtc } = computeTriggerPrices({
    cell: params.cell,
    entryBtcPrice: params.entryBtcPrice
  });
  const gridStep = params.gridStepUsdcOverride ?? getGridStepUsdc(venue.primary);
  const putStrikeBtc = snapHedgeStrike({
    optionKind: "put",
    idealStrikeUsdc: idealPutStrike,
    spotUsdc: params.entryBtcPrice,
    triggerBoundaryUsdc: triggerLowBtc,
    gridStepUsdc: gridStep
  });
  const callStrikeBtc = snapHedgeStrike({
    optionKind: "call",
    idealStrikeUsdc: idealCallStrike,
    spotUsdc: params.entryBtcPrice,
    triggerBoundaryUsdc: triggerHighBtc,
    gridStepUsdc: gridStep
  });
  const { contractsBtc, intrinsicAtTriggerUsdc } = computeHedgeContractSize({
    cell: params.cell,
    entryBtcPrice: params.entryBtcPrice,
    contractGranularityBtc: params.contractGranularityBtc,
    regime: params.regime ?? null
  });
  // P1a (2026-05-16): default tenor 1d → 14d (matched-tenor hedge).
  // Production previously had no rollover for the 1-day hedge while
  // VC positions can live up to 14 days — a 14d matched hedge eliminates
  // that uncovered-from-day-2 gap. See PLAN §7 P1a + §13.
  const horizonDays = params.expiryHorizonDays ?? 14;
  const expiryDate = new Date(Date.now() + horizonDays * 86_400_000);
  // Snap to 08:00 UTC (typical option expiry boundary on Bullish/Deribit).
  expiryDate.setUTCHours(8, 0, 0, 0);
  // If snap pulled us back before now (e.g., we're after 08:00 today
  // and asked for "tomorrow"), advance one day.
  if (expiryDate.getTime() < Date.now()) {
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
  }
  // Sanity: matched-tenor must be ≥ horizon - 1 day (after 08:00 snap).
  // For 14d horizon, expiry must be ≥ 13 days out.
  if (horizonDays >= 14) {
    const minExpiryMs = Date.now() + (horizonDays - 1) * 86_400_000;
    if (expiryDate.getTime() < minExpiryMs) {
      expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
    }
  }
  const expiryIso = expiryDate.toISOString();

  const expectedPut = (params.venueMarkPutPriceUsdc ?? estimateOptionUnitCostUsdc(params.cell)) * contractsBtc;
  const expectedCall = (params.venueMarkCallPriceUsdc ?? estimateOptionUnitCostUsdc(params.cell)) * contractsBtc;

  return {
    positionId: params.positionId,
    cellId: params.cell.cellId,
    venue: venue.primary,
    legs: [
      {
        optionKind: "put",
        strikeUsdc: putStrikeBtc,
        expiryIso,
        contractsBtc,
        intrinsicAtTriggerUsdc,
        payoutCoverageUsdc: params.cell.payoutUsdc
      },
      {
        optionKind: "call",
        strikeUsdc: callStrikeBtc,
        expiryIso,
        contractsBtc,
        intrinsicAtTriggerUsdc,
        payoutCoverageUsdc: params.cell.payoutUsdc
      }
    ],
    expectedTotalCostUsdc: expectedPut + expectedCall
  };
};

/**
 * Rough per-BTC option unit cost estimate, used when venue mark not yet
 * available (e.g., quote phase). 14-day TENOR estimates (P1a 2026-05-16
 * — switched from 1-day rolling to 14-day matched-tenor hedge).
 *
 * BS reference at $80k spot, vol 0.65, r 0.045, T=14/365:
 *   ±2% trigger / 1% hedge: long put 1% OTM ≈ $1,500/BTC; same for call
 *   ±5% trigger / 3% hedge: long put 3% OTM ≈ $700/BTC
 *   ±10% trigger / 5% hedge: long put 5% OTM ≈ $300/BTC
 *   ±15% trigger / 7% hedge: long put 7% OTM ≈ $150/BTC
 *
 * Returns USDC unit cost for ONE BTC of one leg (put OR call). Actual
 * cost computed by venue at execute time; this is just for capacity
 * planning / routing decisions.
 */
const UNIT_COST_BY_TRIGGER: Record<string, number> = {
  "0.02": 1500,
  "0.05": 700,
  "0.1":  300,
  "0.15": 150
};

export const estimateOptionUnitCostUsdc = (cell: CellDefinition): number => {
  const key = normalizeTriggerKey(cell.triggerPct);
  return UNIT_COST_BY_TRIGGER[key] ?? 100;
};

/**
 * Generate venue-agnostic hedge leg IDs.
 */
export const newHedgeLegId = (): string => `vc-leg-${randomUUID()}`;

/**
 * Execution interface — what lifecycle.ts will call.
 *
 * Decoupled from venue adapter so we can mock it cleanly in tests
 * and swap actual venue order placement without touching this module.
 */
export interface HedgeExecutor {
  /**
   * Place a buy market IOC order for one option leg.
   * Returns fill details on success or throws on failure.
   */
  buyOptionLeg(params: {
    venue: HedgeVenueChoice;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contractsBtc: number;
  }): Promise<{
    venue: HedgeVenueChoice;
    fillPriceUsdcPerBtc: number;
    totalCostUsdc: number;
    orderId: string;
  }>;

  /**
   * Sell an open option leg back to the market for salvage.
   */
  sellOptionLeg(params: {
    venue: HedgeVenueChoice;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contractsBtc: number;
  }): Promise<{
    venue: HedgeVenueChoice;
    fillPriceUsdcPerBtc: number;
    totalProceedsUsdc: number;
    orderId: string;
  }>;
}

/**
 * Execute a full TIGHT hedge structure (both legs). Returns the
 * actual fill details to be persisted to volume_cover_hedge_leg.
 *
 * If primary venue fails on a leg, falls back to the secondary venue.
 * If both fail on either leg, throws and caller MUST roll back the
 * position (mark cancelled, refund any premium debit).
 */
export const executeHedgeStructure = async (params: {
  structure: HedgeStructure;
  cell: CellDefinition;
  executor: HedgeExecutor;
}): Promise<{
  venue: HedgeVenueChoice;
  legs: Array<{
    legId: string;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contractsBtc: number;
    fillPriceUsdcPerBtc: number;
    totalCostUsdc: number;
    orderId: string;
    venue: HedgeVenueChoice;
  }>;
  totalCostUsdc: number;
}> => {
  const routing = resolveHedgeVenue(params.cell);
  const filled: Array<{
    legId: string;
    optionKind: "put" | "call";
    strikeUsdc: number;
    expiryIso: string;
    contractsBtc: number;
    fillPriceUsdcPerBtc: number;
    totalCostUsdc: number;
    orderId: string;
    venue: HedgeVenueChoice;
  }> = [];

  for (const leg of params.structure.legs) {
    let lastError: Error | null = null;
    let fill: {
      venue: HedgeVenueChoice;
      fillPriceUsdcPerBtc: number;
      totalCostUsdc: number;
      orderId: string;
    } | null = null;

    for (const venue of [routing.primary, routing.fallback].filter(Boolean) as HedgeVenueChoice[]) {
      try {
        fill = await params.executor.buyOptionLeg({
          venue,
          optionKind: leg.optionKind,
          strikeUsdc: leg.strikeUsdc,
          expiryIso: leg.expiryIso,
          contractsBtc: leg.contractsBtc
        });
        if (fill) break;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // try fallback
      }
    }

    if (!fill) {
      // Roll back any already-filled legs by selling them
      for (const f of filled) {
        try {
          await params.executor.sellOptionLeg({
            venue: f.venue,
            optionKind: f.optionKind,
            strikeUsdc: f.strikeUsdc,
            expiryIso: f.expiryIso,
            contractsBtc: f.contractsBtc
          });
        } catch {
          // best-effort rollback; lifecycle layer must alert
        }
      }
      throw new Error(
        `Volume Cover hedge execution failed for ${leg.optionKind} leg: ${lastError?.message ?? "no_venue_filled"}`
      );
    }

    filled.push({
      legId: newHedgeLegId(),
      optionKind: leg.optionKind,
      strikeUsdc: leg.strikeUsdc,
      expiryIso: leg.expiryIso,
      contractsBtc: leg.contractsBtc,
      fillPriceUsdcPerBtc: fill.fillPriceUsdcPerBtc,
      totalCostUsdc: fill.totalCostUsdc,
      orderId: fill.orderId,
      venue: fill.venue
    });
  }

  return {
    venue: filled[0]?.venue ?? routing.primary,
    legs: filled,
    totalCostUsdc: filled.reduce((s, f) => s + f.totalCostUsdc, 0)
  };
};
