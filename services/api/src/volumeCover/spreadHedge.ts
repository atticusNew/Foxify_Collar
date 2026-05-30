/**
 * Volume Cover — vertical spread hedge construction (Track 2 scaffold, 2026-05-22).
 *
 * Mirrors `tightHedge.ts` for the spread strategy. Builds a 4-leg
 * [DB] TIGHT-spread structure:
 *
 *     bear put spread (long K2, short K1, K1 < K2)
 *       +
 *     bull call spread (long K3, short K4, K3 < K4)
 *
 * with K2/K3 INSIDE trigger boundary (TIGHT) and K1/K4 PAST trigger.
 *
 * This module is PURE CONSTRUCTION: it does not place orders, does not
 * write to the database, and does not assume any venue is online. The
 * execution path (Track 2 PR #2) wraps this with the sequenced 4-leg
 * placement + rollback logic. Probe scripts and unit tests can drive
 * this module directly without any side effects.
 *
 * Sizing (intrinsic-floor at trigger):
 *
 *     contracts_BTC = payoutUsdc / max( K2_actual − triggerLow,
 *                                       K4_actual − triggerHigh )
 *
 * The MAX intentionally over-covers the smaller side. We could be more
 * granular and pick separate contract counts per side, but symmetric
 * sizing keeps the rollback path simpler and absorbs a tiny amount of
 * over-hedging cost.
 *
 * Venue routing default (per operator directive 2026-05-22):
 *
 *     primary  = Bullish  (cheaper $620/BTC on 50k_2pct_1k vs Deribit $620+)
 *     fallback = Deribit  (proven execution, finer $500 strike grid)
 *
 * Per-cell override via `VOLUME_COVER_SPREAD_VENUE_ROUTING_JSON` env. The
 * fallback is NOT atomic — venue selection happens BEFORE the first leg;
 * once a leg is placed the entire spread must complete on that venue
 * (or be rolled back).
 *
 * Design doc: docs/VOLUME_COVER_SPREAD_DESIGN_2026_05_22.md
 */

import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";

import {
  computeSpreadStrikesDB,
  computeTriggerPrices,
  type CellDefinition
} from "./matrix";
import type { HedgeVenueChoice } from "./tightHedge";

export type SpreadDesign = "DB"; // [DA] reserved for future addition; not yet implemented.

export type SpreadLegRole = "put_long" | "put_short" | "call_long" | "call_short";

export type SpreadLegSpec = {
  legRole: SpreadLegRole;
  optionKind: "put" | "call";
  side: "long" | "short";
  /**
   * Ideal strike requested by the design formula (USDC). The venue
   * strike-snapper will resolve this to the closest listed strike.
   */
  strikeIdealUsdc: number;
  /**
   * Actual strike chosen on the venue (USDC). Equals `strikeIdealUsdc`
   * when no snapping is performed (e.g., when the caller hasn't yet
   * routed to a venue). The execution layer must set this before
   * placing orders.
   */
  strikeActualUsdc: number;
  /** BTC contract size, MUST be the same across all 4 legs of one spread group. */
  contractsBtc: number;
  expiryIso: string;
};

export type SpreadStructure = {
  positionId: string;
  cellId: string;
  spreadGroupId: string;
  design: SpreadDesign;
  venue: HedgeVenueChoice;
  fallbackVenue: HedgeVenueChoice | null;
  legs: SpreadLegSpec[];
  /**
   * Pure-construction view of the expected per-pair cost using the
   * IDEAL strikes (no venue prices yet). The execution layer replaces
   * this with the realized cost after fills.
   */
  expectedNetDebitPerBtcUsdcIdeal: number | null;
  contractsBtcPerLeg: number;
  spreadWidthUsdc: number;
  triggerLowBtc: number;
  triggerHighBtc: number;
};

// ---------------------------------------------------------------------------
// Venue routing
// ---------------------------------------------------------------------------

const SPREAD_ROUTING_DEFAULT: Record<string, { primary: HedgeVenueChoice; fallback: HedgeVenueChoice | null }> = {
  // 2026-05-22: Bullish-primary for ALL spread cells initially, per user
  // direction. Per-cell flip via VOLUME_COVER_SPREAD_VENUE_ROUTING_JSON.
  "0.02": { primary: "bullish", fallback: "deribit" },
  "0.05": { primary: "bullish", fallback: "deribit" },
  "0.1":  { primary: "bullish", fallback: "deribit" },
  "0.15": { primary: "bullish", fallback: "deribit" }
};

const normalizeTriggerKey = (triggerPct: number): string => {
  const fixed = triggerPct.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed;
};

export const resolveSpreadVenue = (cell: CellDefinition): {
  primary: HedgeVenueChoice;
  fallback: HedgeVenueChoice | null;
} => {
  const key = normalizeTriggerKey(cell.triggerPct);
  const envRaw = process.env.VOLUME_COVER_SPREAD_VENUE_ROUTING_JSON;
  if (envRaw && envRaw.trim()) {
    try {
      const parsed = JSON.parse(envRaw);
      const entry = parsed[cell.cellId] ?? parsed[key] ?? parsed[String(cell.triggerPct)];
      if (entry) {
        return {
          primary: entry.primary || SPREAD_ROUTING_DEFAULT[key]?.primary || "bullish",
          fallback: entry.fallback === undefined
            ? (SPREAD_ROUTING_DEFAULT[key]?.fallback ?? null)
            : entry.fallback
        };
      }
    } catch {
      // Fall through to default on parse error.
    }
  }
  return SPREAD_ROUTING_DEFAULT[key] || { primary: "bullish", fallback: "deribit" };
};

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Intrinsic-floor sizing formula. Returns the BTC contract count needed so
 * the spread's intrinsic-value-at-trigger ≥ payout. Same contract count is
 * used on BOTH sides (the put spread and the call spread) for rollback
 * simplicity.
 *
 *   max_payoff_at_trigger_put  = K2_actual − triggerLow
 *   max_payoff_at_trigger_call = K4_actual − triggerHigh   (mirror)
 *   contracts_btc = payoutUsdc / min(max_payoff_at_trigger_put, max_payoff_at_trigger_call)
 *
 * Rounds UP to venue contract granularity (Bullish: 0.01 BTC; Deribit: 0.1 BTC
 * for options). Caller passes the venue grid; we don't infer it here.
 */
export const computeSpreadContractSize = (params: {
  cell: CellDefinition;
  putLongStrikeActualUsdc: number;
  callLongStrikeActualUsdc: number;
  triggerLowBtc: number;
  triggerHighBtc: number;
  venueContractGranularityBtc: number;
}): { contractsBtc: number; intrinsicAtTriggerUsdc: number } => {
  const putIntrinsic = new Decimal(params.putLongStrikeActualUsdc).minus(params.triggerLowBtc);
  const callIntrinsic = new Decimal(params.callLongStrikeActualUsdc).minus(params.triggerHighBtc);

  // Both intrinsics SHOULD be positive (K2 > triggerLow because TIGHT places
  // longs inside trigger). If a venue grid snap pushed one outside trigger,
  // intrinsic could be 0 or negative on that side — caller must validate.
  const minIntrinsic = Decimal.min(putIntrinsic.abs(), callIntrinsic.abs());
  if (minIntrinsic.lte(0)) {
    throw new Error(
      `Spread sizing impossible: intrinsic at trigger ≤ 0 for cell ${params.cell.cellId} ` +
        `(put intrinsic ${putIntrinsic.toString()}, call intrinsic ${callIntrinsic.toString()}). ` +
        `Check actual venue strikes vs trigger boundary.`
    );
  }

  const raw = new Decimal(params.cell.payoutUsdc).div(minIntrinsic);
  const granularity = new Decimal(params.venueContractGranularityBtc);
  // Ceil to next multiple of granularity (over-hedge).
  const contracts = raw.div(granularity).ceil().mul(granularity).toNumber();
  return {
    contractsBtc: contracts,
    intrinsicAtTriggerUsdc: minIntrinsic.toNumber()
  };
};

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a SpreadStructure for [DB] TIGHT-spread at the given entry price.
 *
 * `strikeSnapper(targetUsdc, side, kind)` lets the caller plug in venue-
 * specific snapping (Bullish $1k grid vs Deribit $500 grid). If omitted,
 * the ideal strikes are used unsnapped — useful for unit tests and probe
 * scripts that don't need venue-accurate strikes.
 *
 * `venueContractGranularityBtc` defaults to 0.01 (Bullish standard); callers
 * routing to Deribit should pass 0.1.
 *
 * Returns a SpreadStructure with `legs` ordered for sequenced execution
 * (see design doc §9): put_long → put_short → call_long → call_short.
 */
export const buildSpreadStructureDB = (params: {
  positionId: string;
  cell: CellDefinition;
  entryBtcPrice: number;
  expiryIso: string;
  venue: HedgeVenueChoice;
  fallbackVenue: HedgeVenueChoice | null;
  /** Optional venue strike snapper. If omitted, ideal strikes are used. */
  strikeSnapper?: (params: {
    targetUsdc: number;
    side: "long" | "short";
    kind: "put" | "call";
  }) => number;
  venueContractGranularityBtc?: number;
}): SpreadStructure => {
  const ideal = computeSpreadStrikesDB({
    cell: params.cell,
    entryBtcPrice: params.entryBtcPrice
  });
  const triggers = computeTriggerPrices({
    cell: params.cell,
    entryBtcPrice: params.entryBtcPrice
  });

  const snap = params.strikeSnapper
    ? (targetUsdc: number, side: "long" | "short", kind: "put" | "call") =>
        params.strikeSnapper!({ targetUsdc, side, kind })
    : (targetUsdc: number) => targetUsdc;

  const putShortActual  = snap(ideal.putShortIdealUsdc,  "short", "put");
  const putLongActual   = snap(ideal.putLongIdealUsdc,   "long",  "put");
  const callLongActual  = snap(ideal.callLongIdealUsdc,  "long",  "call");
  const callShortActual = snap(ideal.callShortIdealUsdc, "short", "call");

  const granularity = params.venueContractGranularityBtc ?? 0.01;
  const sizing = computeSpreadContractSize({
    cell: params.cell,
    putLongStrikeActualUsdc: putLongActual,
    callLongStrikeActualUsdc: callLongActual,
    triggerLowBtc: triggers.triggerLowBtc,
    triggerHighBtc: triggers.triggerHighBtc,
    venueContractGranularityBtc: granularity
  });

  const spreadGroupId = `vc-spread-${randomUUID()}`;

  const legs: SpreadLegSpec[] = [
    {
      legRole: "put_long",
      optionKind: "put",
      side: "long",
      strikeIdealUsdc: ideal.putLongIdealUsdc,
      strikeActualUsdc: putLongActual,
      contractsBtc: sizing.contractsBtc,
      expiryIso: params.expiryIso
    },
    {
      legRole: "put_short",
      optionKind: "put",
      side: "short",
      strikeIdealUsdc: ideal.putShortIdealUsdc,
      strikeActualUsdc: putShortActual,
      contractsBtc: sizing.contractsBtc,
      expiryIso: params.expiryIso
    },
    {
      legRole: "call_long",
      optionKind: "call",
      side: "long",
      strikeIdealUsdc: ideal.callLongIdealUsdc,
      strikeActualUsdc: callLongActual,
      contractsBtc: sizing.contractsBtc,
      expiryIso: params.expiryIso
    },
    {
      legRole: "call_short",
      optionKind: "call",
      side: "short",
      strikeIdealUsdc: ideal.callShortIdealUsdc,
      strikeActualUsdc: callShortActual,
      contractsBtc: sizing.contractsBtc,
      expiryIso: params.expiryIso
    }
  ];

  return {
    positionId: params.positionId,
    cellId: params.cell.cellId,
    spreadGroupId,
    design: "DB",
    venue: params.venue,
    fallbackVenue: params.fallbackVenue,
    legs,
    expectedNetDebitPerBtcUsdcIdeal: null, // populated by the quote step
    contractsBtcPerLeg: sizing.contractsBtc,
    spreadWidthUsdc: ideal.spreadWidthUsdc,
    triggerLowBtc: triggers.triggerLowBtc,
    triggerHighBtc: triggers.triggerHighBtc
  };
};

// ---------------------------------------------------------------------------
// Feature flagging
// ---------------------------------------------------------------------------

export type HedgeStrategy = "strangle" | "spread" | "auto";

/**
 * Read the active hedge strategy from env.
 *
 *   VOLUME_COVER_HEDGE_STRATEGY=strangle (default — current behavior)
 *   VOLUME_COVER_HEDGE_STRATEGY=spread   (force spread for ALL cells)
 *   VOLUME_COVER_HEDGE_STRATEGY=auto     (per-cell allowlist, see below)
 *
 * In `auto` mode, the spread path is taken only when `cellId` appears in
 * `VC_SPREAD_CELL_ALLOWLIST` (comma-separated). All other cells use the
 * strangle path. This is the path to one-cell-at-a-time live cutover.
 */
export const getHedgeStrategy = (): HedgeStrategy => {
  const raw = String(process.env.VOLUME_COVER_HEDGE_STRATEGY ?? "strangle").toLowerCase().trim();
  if (raw === "spread") return "spread";
  if (raw === "auto") return "auto";
  return "strangle";
};

export const isSpreadCellAllowed = (cellId: string): boolean => {
  const strategy = getHedgeStrategy();
  if (strategy === "spread") return true;
  if (strategy === "strangle") return false;
  // auto mode
  const allowRaw = String(process.env.VC_SPREAD_CELL_ALLOWLIST ?? "").trim();
  if (!allowRaw) return false;
  const allowed = new Set(allowRaw.split(",").map((s) => s.trim()).filter(Boolean));
  return allowed.has(cellId);
};
