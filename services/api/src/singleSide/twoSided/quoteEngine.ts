/**
 * Quote engine — given a cell + live anchors + spot, compute the strangle
 * quote (per-leg ask, depth check, venue routing, total hedge cost).
 *
 * Quote returned is valid for QUOTE_TTL_MS (default 30s per spec). The activate
 * handler should re-verify the quote isn't expired before executing.
 *
 * Per-leg venue routing: pick the lower-ask venue per leg subject to
 * depth-within-2% ≥ DEPTH_HEADROOM_FACTOR × contracts. If no venue qualifies,
 * surface 503 with reason.
 */

import { randomUUID } from "node:crypto";
import { computeStrikes, computeTriggerBoundaries, type TwoSidedCell } from "./cellConfig";
import type { TierDefinition, Venue } from "./types";

export const QUOTE_TTL_MS = 30_000;
export const DEPTH_HEADROOM_FACTOR = 1.2; // require depth ≥ 1.2× contracts

export type LegAnchorQuote = {
  venue: Venue;
  symbol: string;          // venue's instrument symbol
  askUsdcPerBtc: number;
  depthWithin2pctBtc: number;
  pulledAt: string;        // ISO
};

export type LiveAnchorProvider = {
  /** Get live anchor for a given (strike, type) — returns null if no qualifying anchor.
   * Production impl polls Bullish + Deribit chains; tests inject deterministic values. */
  getAnchorForLeg: (
    strike: number,
    optionType: "put" | "call",
    tenorDays: number
  ) => Promise<{ bullish: LegAnchorQuote | null; deribit: LegAnchorQuote | null }>;
};

export type QuoteResult =
  | {
      ok: true;
      quoteId: string;
      validUntilMs: number;
      spot: number;
      putStrike: number;
      callStrike: number;
      contractsBtc: number;
      triggerDownPrice: number;
      triggerUpPrice: number;
      hedgeTenorDays: number;
      putLeg: { venue: Venue; symbol: string; askUsdcPerBtc: number; legCostUsdc: number; depthBtc: number; pulledAt: string };
      callLeg: { venue: Venue; symbol: string; askUsdcPerBtc: number; legCostUsdc: number; depthBtc: number; pulledAt: string };
      totalHedgeCostUsdc: number;
      tier: TierDefinition;
    }
  | {
      ok: false;
      reason:
        | "no_qualifying_venue_for_put"
        | "no_qualifying_venue_for_call"
        | "depth_insufficient_put"
        | "depth_insufficient_call"
        | "anchor_fetch_failed";
      details: Record<string, unknown>;
    };

const pickLegVenue = (
  bullish: LegAnchorQuote | null,
  deribit: LegAnchorQuote | null,
  contractsBtc: number
): { chosen: LegAnchorQuote | null; reason: "ok" | "no_venue" | "depth_insufficient" } => {
  const candidates: LegAnchorQuote[] = [];
  for (const c of [bullish, deribit]) {
    if (!c) continue;
    if (!Number.isFinite(c.askUsdcPerBtc) || c.askUsdcPerBtc <= 0) continue;
    if (!Number.isFinite(c.depthWithin2pctBtc) || c.depthWithin2pctBtc < contractsBtc * DEPTH_HEADROOM_FACTOR) continue;
    candidates.push(c);
  }
  if (candidates.length === 0) {
    // Was there a venue with quote but insufficient depth?
    const hadAnyQuote = (bullish && bullish.askUsdcPerBtc > 0) || (deribit && deribit.askUsdcPerBtc > 0);
    if (hadAnyQuote) return { chosen: null, reason: "depth_insufficient" };
    return { chosen: null, reason: "no_venue" };
  }
  candidates.sort((a, b) => a.askUsdcPerBtc - b.askUsdcPerBtc);
  return { chosen: candidates[0], reason: "ok" };
};

export const buildQuote = async (params: {
  cell: TwoSidedCell;
  spot: number;
  anchorProvider: LiveAnchorProvider;
  tier: TierDefinition;
  nowMs?: number;
}): Promise<QuoteResult> => {
  const { cell, spot, anchorProvider, tier } = params;
  const now = params.nowMs ?? Date.now();
  const { putStrike, callStrike } = computeStrikes(cell, spot);
  const { triggerDown, triggerUp } = computeTriggerBoundaries(cell, spot);

  let putAnchors, callAnchors;
  try {
    [putAnchors, callAnchors] = await Promise.all([
      anchorProvider.getAnchorForLeg(putStrike, "put", cell.hedgeTenorDays),
      anchorProvider.getAnchorForLeg(callStrike, "call", cell.hedgeTenorDays)
    ]);
  } catch (e) {
    return { ok: false, reason: "anchor_fetch_failed", details: { message: (e as Error).message } };
  }

  const putPick = pickLegVenue(putAnchors.bullish, putAnchors.deribit, cell.contractsBtc);
  if (putPick.reason !== "ok" || !putPick.chosen) {
    return {
      ok: false,
      reason: putPick.reason === "depth_insufficient" ? "depth_insufficient_put" : "no_qualifying_venue_for_put",
      details: {
        putStrike,
        bullish_ask: putAnchors.bullish?.askUsdcPerBtc ?? null,
        bullish_depth: putAnchors.bullish?.depthWithin2pctBtc ?? null,
        deribit_ask: putAnchors.deribit?.askUsdcPerBtc ?? null,
        deribit_depth: putAnchors.deribit?.depthWithin2pctBtc ?? null,
        required_depth: cell.contractsBtc * DEPTH_HEADROOM_FACTOR
      }
    };
  }
  const callPick = pickLegVenue(callAnchors.bullish, callAnchors.deribit, cell.contractsBtc);
  if (callPick.reason !== "ok" || !callPick.chosen) {
    return {
      ok: false,
      reason: callPick.reason === "depth_insufficient" ? "depth_insufficient_call" : "no_qualifying_venue_for_call",
      details: {
        callStrike,
        bullish_ask: callAnchors.bullish?.askUsdcPerBtc ?? null,
        bullish_depth: callAnchors.bullish?.depthWithin2pctBtc ?? null,
        deribit_ask: callAnchors.deribit?.askUsdcPerBtc ?? null,
        deribit_depth: callAnchors.deribit?.depthWithin2pctBtc ?? null,
        required_depth: cell.contractsBtc * DEPTH_HEADROOM_FACTOR
      }
    };
  }

  const putLegCost = putPick.chosen.askUsdcPerBtc * cell.contractsBtc;
  const callLegCost = callPick.chosen.askUsdcPerBtc * cell.contractsBtc;
  const total = putLegCost + callLegCost;

  return {
    ok: true,
    quoteId: randomUUID(),
    validUntilMs: now + QUOTE_TTL_MS,
    spot,
    putStrike,
    callStrike,
    contractsBtc: cell.contractsBtc,
    triggerDownPrice: triggerDown,
    triggerUpPrice: triggerUp,
    hedgeTenorDays: cell.hedgeTenorDays,
    putLeg: {
      venue: putPick.chosen.venue,
      symbol: putPick.chosen.symbol,
      askUsdcPerBtc: putPick.chosen.askUsdcPerBtc,
      legCostUsdc: putLegCost,
      depthBtc: putPick.chosen.depthWithin2pctBtc,
      pulledAt: putPick.chosen.pulledAt
    },
    callLeg: {
      venue: callPick.chosen.venue,
      symbol: callPick.chosen.symbol,
      askUsdcPerBtc: callPick.chosen.askUsdcPerBtc,
      legCostUsdc: callLegCost,
      depthBtc: callPick.chosen.depthWithin2pctBtc,
      pulledAt: callPick.chosen.pulledAt
    },
    totalHedgeCostUsdc: total,
    tier
  };
};
