/**
 * Volume Cover spread executor (Track 2 PR #2, 2026-05-23).
 *
 * Production analog of `bullish_spread_e2e_microtest.sh`. Provides the
 * sequenced 4-leg open/close path for [DB] TIGHT-spread hedges with
 * full rollback safety, hedge-pool reuse, jitter, and fill-optimizer
 * integration.
 *
 * Safety invariants (mirrors the E3 microtest):
 *
 *   OPEN sequence (longs first):
 *     1. BUY  long_put      — no naked exposure yet
 *     2. SELL short_put     — covered by long_put
 *     3. BUY  long_call     — covered combination still
 *     4. SELL short_call    — covered by long_call
 *
 *   CLOSE sequence (shorts first, reverse):
 *     1. BUY  short_call back — long_call still covers it
 *     2. SELL long_call       — call side flat
 *     3. BUY  short_put back  — long_put still covers it
 *     4. SELL long_put        — fully flat
 *
 *   ROLLBACK (on partial open failure):
 *     Unwind already-opened legs in reverse order of opening. Each
 *     rollback fill is a real Bullish order against the live book.
 *
 *   PARTIAL CLOSE ON TRIGGER (Item 1 from 2026-05-22 product spec):
 *     When Foxify's trigger fires, close BOTH wings of the spread but
 *     RETAIN the long legs as Atticus salvage. Specifically:
 *       - Close winning wing fully (collect the spread value)
 *       - Close losing wing's short-leg back (free margin)
 *       - Retain BOTH long legs in Atticus's pocket for sale at
 *         discretion (salvage)
 *
 * This module is venue-agnostic at the executor interface boundary:
 * caller passes a `SpreadExecutor` with buy/sell capabilities and
 * orderbook reads. The Bullish-specific adapter lives elsewhere.
 */

import { randomUUID } from "node:crypto";
import type { SpreadLegSpec, SpreadStructure } from "./spreadHedge";
import {
  sampleOpenDelayMs,
  sampleInterLegPacingMs,
  jitterSleepMs,
  getConfiguredHedgeJitter
} from "./hedgeJitter";
import {
  executeOptimizedFill,
  type FillSubmitFn,
  type FillResult
} from "./fillOptimizer";

// ─── Executor interface ──────────────────────────────────────────────

export type ExecutorOrderResult = {
  filled: boolean;
  fillPriceUsdcPerBtc: number;
  fillQtyBtc: number;
  finalReason: string | null;
  orderId: string | null;
  raw?: unknown;
};

export type OrderbookTop = {
  topBidUsdc: number | null;
  topAskUsdc: number | null;
  bidQtyBtc: number | null;
  askQtyBtc: number | null;
};

/**
 * Minimum surface the spread executor needs. Concrete adapters
 * (Bullish, Deribit) implement this around their venue SDK.
 */
export type SpreadExecutorAdapter = {
  /** Read top-of-book for a venue symbol. Returns null bid/ask if missing. */
  getOrderbookTop(params: { symbol: string }): Promise<OrderbookTop>;

  /**
   * Submit ONE IOC limit order at the given price. This is the
   * primitive that the fill optimizer composes around. The executor
   * uses the venue's standard side semantics (BUY = buying the option,
   * SELL = selling the option / opening a short).
   */
  submitIocLimit(params: {
    symbol: string;
    side: "BUY" | "SELL";
    priceUsdcPerBtc: number;
    quantityBtc: number;
    intent: "open" | "close" | "rollback";
    legRole: SpreadLegSpec["legRole"];
    spreadGroupId: string;
  }): Promise<ExecutorOrderResult>;

  /**
   * Map a SpreadLegSpec to the venue's contract symbol. e.g. for
   * Bullish: BTC-USDC-YYYYMMDD-STRIKE-(P|C).
   */
  resolveSymbol(params: {
    leg: SpreadLegSpec;
    expiryIso: string;
  }): string;
};

// ─── Leg helpers ─────────────────────────────────────────────────────

type LegPlacement = {
  legRole: SpreadLegSpec["legRole"];
  symbol: string;
  side: "BUY" | "SELL";
  contractsBtc: number;
  strikeUsdc: number;
  expiryIso: string;
};

/**
 * Order legs for the sequenced OPEN flow. Longs first then shorts
 * within each wing; put pair before call pair.
 */
const orderLegsForOpen = (legs: SpreadLegSpec[]): SpreadLegSpec[] => {
  const order: SpreadLegSpec["legRole"][] = ["put_long", "put_short", "call_long", "call_short"];
  return [...legs].sort((a, b) => order.indexOf(a.legRole) - order.indexOf(b.legRole));
};

/**
 * Order legs for the sequenced CLOSE flow. Shorts first then longs
 * within each wing; reverse direction (call pair before put pair).
 */
const orderLegsForClose = (legs: SpreadLegSpec[]): SpreadLegSpec[] => {
  const order: SpreadLegSpec["legRole"][] = ["call_short", "call_long", "put_short", "put_long"];
  return [...legs].sort((a, b) => order.indexOf(a.legRole) - order.indexOf(b.legRole));
};

const sideForLeg = (leg: SpreadLegSpec, action: "open" | "close"): "BUY" | "SELL" => {
  // OPEN: longs BUY, shorts SELL
  // CLOSE: longs SELL, shorts BUY (reverse direction)
  if (action === "open") {
    return leg.side === "long" ? "BUY" : "SELL";
  }
  return leg.side === "long" ? "SELL" : "BUY";
};

const reverseSideForRollback = (openSide: "BUY" | "SELL"): "BUY" | "SELL" =>
  openSide === "BUY" ? "SELL" : "BUY";

// ─── Pre-trade liquidity gate ────────────────────────────────────────

export type LiquidityCheck = {
  passed: boolean;
  legChecks: Array<{
    legRole: SpreadLegSpec["legRole"];
    symbol: string;
    crossesSide: "BUY" | "SELL";
    topBidUsdc: number | null;
    topAskUsdc: number | null;
    sufficient: boolean;
    reason: string | null;
  }>;
};

/**
 * Hardened liquidity gate (mirror of the E3 microtest's Phase 1).
 * For BUYs we need a resting ASK; for SELLs we need a resting BID.
 * Missing the side we cross would cause `Expired` returns at IOC time.
 */
export const checkSpreadLiquidity = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  action: "open" | "close";
}): Promise<LiquidityCheck> => {
  const sequence = params.action === "open"
    ? orderLegsForOpen(params.structure.legs)
    : orderLegsForClose(params.structure.legs);
  const checks: LiquidityCheck["legChecks"] = [];
  let allPassed = true;
  for (const leg of sequence) {
    const symbol = params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso });
    const side = sideForLeg(leg, params.action);
    const book = await params.adapter.getOrderbookTop({ symbol });
    let sufficient = false;
    let reason: string | null = null;
    if (side === "BUY") {
      sufficient = typeof book.topAskUsdc === "number" && book.topAskUsdc > 0;
      if (!sufficient) reason = "no_resting_ask_for_buy";
    } else {
      sufficient = typeof book.topBidUsdc === "number" && book.topBidUsdc > 0;
      if (!sufficient) reason = "no_resting_bid_for_sell";
    }
    if (!sufficient) allPassed = false;
    checks.push({
      legRole: leg.legRole,
      symbol,
      crossesSide: side,
      topBidUsdc: book.topBidUsdc,
      topAskUsdc: book.topAskUsdc,
      sufficient,
      reason
    });
  }
  return { passed: allPassed, legChecks: checks };
};

// ─── Open result types ───────────────────────────────────────────────

export type OpenLegRecord = {
  legRole: SpreadLegSpec["legRole"];
  symbol: string;
  side: "BUY" | "SELL";
  fillPriceUsdcPerBtc: number;
  fillQtyBtc: number;
  orderId: string | null;
  attempts: number;
  attemptedPrices: number[];
};

export type SpreadOpenResult = {
  ok: boolean;
  spreadGroupId: string;
  legs: OpenLegRecord[];
  failedAt: SpreadLegSpec["legRole"] | null;
  rollbackResults: OpenLegRecord[];
  errorReason: string | null;
  liquidityCheck: LiquidityCheck;
  netDebitUsdc: number;
};

// ─── OPEN ────────────────────────────────────────────────────────────

const submitFnFor = (
  adapter: SpreadExecutorAdapter,
  symbol: string,
  intent: "open" | "close" | "rollback",
  legRole: SpreadLegSpec["legRole"],
  spreadGroupId: string
): FillSubmitFn => async ({ side, priceUsdc, quantityBtc }) => {
  const r = await adapter.submitIocLimit({
    symbol,
    side,
    priceUsdcPerBtc: priceUsdc,
    quantityBtc,
    intent,
    legRole,
    spreadGroupId
  });
  return {
    filled: r.filled,
    fillPriceUsdc: r.fillPriceUsdcPerBtc,
    fillQtyBtc: r.fillQtyBtc,
    finalReason: r.finalReason,
    orderId: r.orderId,
    raw: r.raw
  };
};

const fillResultToLegRecord = (
  leg: SpreadLegSpec,
  symbol: string,
  side: "BUY" | "SELL",
  result: FillResult
): OpenLegRecord => ({
  legRole: leg.legRole,
  symbol,
  side,
  fillPriceUsdcPerBtc: result.fillPriceUsdc ?? 0,
  fillQtyBtc: result.fillQtyBtc ?? 0,
  orderId: result.orderId,
  attempts: result.attempts,
  attemptedPrices: result.attemptedPrices
});

/**
 * Sequenced 4-leg open with rollback. Each leg's IOC is routed through
 * the fill optimizer (improved-price first, fallback to worst-case on
 * Expired). Random open-delay + inter-leg pacing applied per
 * hedgeJitter config.
 */
export const openSpread = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  /** When true, skip the liquidity gate (test path only). */
  skipLiquidityGate?: boolean;
  /** RNG override for deterministic tests. */
  randFn?: () => number;
  /** Override jitter config (test injection). */
  noJitter?: boolean;
}): Promise<SpreadOpenResult> => {
  const jitterCfg = params.noJitter
    ? {
        ...getConfiguredHedgeJitter(),
        openDelayEnabled: false,
        interLegEnabled: false
      }
    : getConfiguredHedgeJitter();

  // 1) Liquidity gate
  const liquidity = params.skipLiquidityGate
    ? { passed: true, legChecks: [] as LiquidityCheck["legChecks"] }
    : await checkSpreadLiquidity({
        structure: params.structure,
        adapter: params.adapter,
        action: "open"
      });

  if (!liquidity.passed) {
    return {
      ok: false,
      spreadGroupId: params.structure.spreadGroupId,
      legs: [],
      failedAt: null,
      rollbackResults: [],
      errorReason: "liquidity_gate_failed",
      liquidityCheck: liquidity,
      netDebitUsdc: 0
    };
  }

  // 2) Optional random open delay before first leg
  const openDelayMs = sampleOpenDelayMs({ cfg: jitterCfg, randFn: params.randFn });
  if (openDelayMs > 0) await jitterSleepMs(openDelayMs);

  // 3) Sequenced open
  const sequence = orderLegsForOpen(params.structure.legs);
  const placed: Array<{ leg: SpreadLegSpec; placement: LegPlacement; record: OpenLegRecord }> = [];
  let failedAt: SpreadLegSpec["legRole"] | null = null;
  let errorReason: string | null = null;

  for (let i = 0; i < sequence.length; i++) {
    const leg = sequence[i];
    if (i > 0) {
      const pace = sampleInterLegPacingMs({ cfg: jitterCfg, randFn: params.randFn });
      if (pace > 0) await jitterSleepMs(pace);
    }
    const symbol = params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso });
    const side = sideForLeg(leg, "open");
    const book = await params.adapter.getOrderbookTop({ symbol });
    if (
      !Number.isFinite(book.topBidUsdc as number) ||
      !Number.isFinite(book.topAskUsdc as number)
    ) {
      failedAt = leg.legRole;
      errorReason = `book_unavailable_for_${leg.legRole}`;
      break;
    }
    const fill = await executeOptimizedFill({
      side,
      symbol,
      quantityBtc: leg.contractsBtc,
      topBidUsdc: book.topBidUsdc as number,
      topAskUsdc: book.topAskUsdc as number,
      submitFn: submitFnFor(
        params.adapter,
        symbol,
        "open",
        leg.legRole,
        params.structure.spreadGroupId
      )
    });
    if (!fill.filled) {
      failedAt = leg.legRole;
      errorReason = fill.finalReason ? `leg_${leg.legRole}_${fill.finalReason}` : `leg_${leg.legRole}_unfilled`;
      break;
    }
    placed.push({
      leg,
      placement: {
        legRole: leg.legRole,
        symbol,
        side,
        contractsBtc: leg.contractsBtc,
        strikeUsdc: leg.strikeActualUsdc,
        expiryIso: leg.expiryIso
      },
      record: fillResultToLegRecord(leg, symbol, side, fill)
    });
  }

  if (failedAt !== null) {
    // Rollback the already-placed legs in reverse order.
    const rollback = await rollbackPlacedLegs({
      adapter: params.adapter,
      placed,
      spreadGroupId: params.structure.spreadGroupId
    });
    return {
      ok: false,
      spreadGroupId: params.structure.spreadGroupId,
      legs: placed.map((p) => p.record),
      failedAt,
      rollbackResults: rollback,
      errorReason,
      liquidityCheck: liquidity,
      netDebitUsdc: 0
    };
  }

  // 4) Compute net debit (sum BUYs paid − sum SELLs received).
  const netDebitUsdc = placed.reduce((sum, p) => {
    const legCostPerBtc = p.record.side === "BUY"
      ? p.record.fillPriceUsdcPerBtc
      : -p.record.fillPriceUsdcPerBtc;
    return sum + legCostPerBtc * p.record.fillQtyBtc;
  }, 0);

  return {
    ok: true,
    spreadGroupId: params.structure.spreadGroupId,
    legs: placed.map((p) => p.record),
    failedAt: null,
    rollbackResults: [],
    errorReason: null,
    liquidityCheck: liquidity,
    netDebitUsdc: Number(netDebitUsdc.toFixed(4))
  };
};

// ─── Rollback ────────────────────────────────────────────────────────

const rollbackPlacedLegs = async (params: {
  adapter: SpreadExecutorAdapter;
  placed: Array<{ leg: SpreadLegSpec; placement: LegPlacement; record: OpenLegRecord }>;
  spreadGroupId: string;
}): Promise<OpenLegRecord[]> => {
  const results: OpenLegRecord[] = [];
  // Reverse the placement order — last opened gets unwound first.
  for (let i = params.placed.length - 1; i >= 0; i--) {
    const entry = params.placed[i];
    const reverseSide = reverseSideForRollback(entry.placement.side);
    const book = await params.adapter.getOrderbookTop({ symbol: entry.placement.symbol });
    if (
      !Number.isFinite(book.topBidUsdc as number) ||
      !Number.isFinite(book.topAskUsdc as number)
    ) {
      // No liquidity to unwind — record as failed rollback for operator action.
      results.push({
        legRole: entry.leg.legRole,
        symbol: entry.placement.symbol,
        side: reverseSide,
        fillPriceUsdcPerBtc: 0,
        fillQtyBtc: 0,
        orderId: null,
        attempts: 0,
        attemptedPrices: []
      });
      continue;
    }
    const result = await executeOptimizedFill({
      side: reverseSide,
      symbol: entry.placement.symbol,
      quantityBtc: entry.placement.contractsBtc,
      topBidUsdc: book.topBidUsdc as number,
      topAskUsdc: book.topAskUsdc as number,
      submitFn: submitFnFor(
        params.adapter,
        entry.placement.symbol,
        "rollback",
        entry.leg.legRole,
        params.spreadGroupId
      )
    });
    results.push(fillResultToLegRecord(entry.leg, entry.placement.symbol, reverseSide, result));
  }
  return results;
};

// ─── CLOSE (full sequenced) ──────────────────────────────────────────

export type SpreadCloseResult = {
  ok: boolean;
  spreadGroupId: string;
  legs: OpenLegRecord[];
  failedAt: SpreadLegSpec["legRole"] | null;
  errorReason: string | null;
  totalProceedsUsdc: number;
};

export const closeSpread = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  randFn?: () => number;
}): Promise<SpreadCloseResult> => {
  const jitterCfg = getConfiguredHedgeJitter();
  const sequence = orderLegsForClose(params.structure.legs);
  const closed: OpenLegRecord[] = [];
  let failedAt: SpreadLegSpec["legRole"] | null = null;
  let errorReason: string | null = null;

  for (let i = 0; i < sequence.length; i++) {
    const leg = sequence[i];
    if (i > 0) {
      const pace = sampleInterLegPacingMs({ cfg: jitterCfg, randFn: params.randFn });
      if (pace > 0) await jitterSleepMs(pace);
    }
    const symbol = params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso });
    const side = sideForLeg(leg, "close");
    const book = await params.adapter.getOrderbookTop({ symbol });
    if (
      !Number.isFinite(book.topBidUsdc as number) ||
      !Number.isFinite(book.topAskUsdc as number)
    ) {
      failedAt = leg.legRole;
      errorReason = `book_unavailable_for_${leg.legRole}`;
      break;
    }
    const result = await executeOptimizedFill({
      side,
      symbol,
      quantityBtc: leg.contractsBtc,
      topBidUsdc: book.topBidUsdc as number,
      topAskUsdc: book.topAskUsdc as number,
      submitFn: submitFnFor(
        params.adapter,
        symbol,
        "close",
        leg.legRole,
        params.structure.spreadGroupId
      )
    });
    if (!result.filled) {
      failedAt = leg.legRole;
      errorReason = result.finalReason ? `leg_${leg.legRole}_${result.finalReason}` : `leg_${leg.legRole}_unfilled`;
      break;
    }
    closed.push(fillResultToLegRecord(leg, symbol, side, result));
  }

  // Total proceeds = sum (SELLs received − BUYs paid). For close, longs
  // are sold (proceeds in), shorts are bought back (proceeds out).
  const totalProceedsUsdc = closed.reduce((sum, l) => {
    const sign = l.side === "SELL" ? 1 : -1;
    return sum + sign * l.fillPriceUsdcPerBtc * l.fillQtyBtc;
  }, 0);

  return {
    ok: failedAt === null,
    spreadGroupId: params.structure.spreadGroupId,
    legs: closed,
    failedAt,
    errorReason,
    totalProceedsUsdc: Number(totalProceedsUsdc.toFixed(4))
  };
};

// ─── PARTIAL CLOSE ON TRIGGER (Item 1) ───────────────────────────────

/**
 * Item 1 partial-close on Foxify trigger:
 *
 *   - Close the SHORT leg of the WINNING wing first (capture proceeds)
 *   - Close the SHORT leg of the LOSING wing back (free margin)
 *   - RETAIN both LONG legs in Atticus's pocket for salvage
 *
 * The long legs become the "salvage retention" — Atticus chooses when
 * to sell them (separately tracked in volume_cover_hedge_leg with
 * retained_role).
 *
 * Note: this is NOT the same as closeSpread. closeSpread closes ALL 4
 * legs and ends the hedge pool entry. This partial-close consumes the
 * pool entry's capacity by $1k but leaves Atticus with two long
 * options to monetize on his timing.
 */
export type SpreadPartialCloseResult = {
  ok: boolean;
  spreadGroupId: string;
  triggerDirection: "high" | "low";
  shortLegsClosed: OpenLegRecord[];
  longLegsRetained: Array<{
    legRole: SpreadLegSpec["legRole"];
    symbol: string;
    contractsBtc: number;
    strikeActualUsdc: number;
  }>;
  failedAt: SpreadLegSpec["legRole"] | null;
  errorReason: string | null;
  shortLegProceedsUsdc: number;
};

export const partialCloseSpreadOnTrigger = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  triggerDirection: "high" | "low";
  randFn?: () => number;
}): Promise<SpreadPartialCloseResult> => {
  const jitterCfg = getConfiguredHedgeJitter();
  // Per Item 1: close BOTH wings' SHORT legs immediately. Retain both LONG legs.
  // Close order: winning side short FIRST (to lock in proceeds), then losing side short.
  // For high trigger: winning side is calls; losing side is puts.
  // For low  trigger: winning side is puts;  losing side is calls.
  const shortLegsByDirection: Record<"high" | "low", SpreadLegSpec["legRole"][]> = {
    high: ["call_short", "put_short"],
    low: ["put_short", "call_short"]
  };
  const shortOrder = shortLegsByDirection[params.triggerDirection];
  const shortLegs = shortOrder
    .map((role) => params.structure.legs.find((l) => l.legRole === role))
    .filter((l): l is SpreadLegSpec => !!l);

  const closedShorts: OpenLegRecord[] = [];
  let failedAt: SpreadLegSpec["legRole"] | null = null;
  let errorReason: string | null = null;

  for (let i = 0; i < shortLegs.length; i++) {
    const leg = shortLegs[i];
    if (i > 0) {
      const pace = sampleInterLegPacingMs({ cfg: jitterCfg, randFn: params.randFn });
      if (pace > 0) await jitterSleepMs(pace);
    }
    const symbol = params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso });
    const side: "BUY" | "SELL" = "BUY"; // close a short by buying back
    const book = await params.adapter.getOrderbookTop({ symbol });
    if (
      !Number.isFinite(book.topBidUsdc as number) ||
      !Number.isFinite(book.topAskUsdc as number)
    ) {
      failedAt = leg.legRole;
      errorReason = `book_unavailable_for_${leg.legRole}`;
      break;
    }
    const result = await executeOptimizedFill({
      side,
      symbol,
      quantityBtc: leg.contractsBtc,
      topBidUsdc: book.topBidUsdc as number,
      topAskUsdc: book.topAskUsdc as number,
      submitFn: submitFnFor(
        params.adapter,
        symbol,
        "close",
        leg.legRole,
        params.structure.spreadGroupId
      )
    });
    if (!result.filled) {
      failedAt = leg.legRole;
      errorReason = result.finalReason
        ? `leg_${leg.legRole}_${result.finalReason}`
        : `leg_${leg.legRole}_unfilled`;
      break;
    }
    closedShorts.push(fillResultToLegRecord(leg, symbol, side, result));
  }

  const shortLegProceedsUsdc = closedShorts.reduce(
    (sum, l) => sum + -1 * l.fillPriceUsdcPerBtc * l.fillQtyBtc, // BUY = cost
    0
  );

  const longLegsRetained: SpreadPartialCloseResult["longLegsRetained"] = params.structure.legs
    .filter((l) => l.side === "long")
    .map((l) => ({
      legRole: l.legRole,
      symbol: params.adapter.resolveSymbol({ leg: l, expiryIso: l.expiryIso }),
      contractsBtc: l.contractsBtc,
      strikeActualUsdc: l.strikeActualUsdc
    }));

  return {
    ok: failedAt === null,
    spreadGroupId: params.structure.spreadGroupId,
    triggerDirection: params.triggerDirection,
    shortLegsClosed: closedShorts,
    longLegsRetained,
    failedAt,
    errorReason,
    shortLegProceedsUsdc: Number(shortLegProceedsUsdc.toFixed(4))
  };
};

// ─── Utilities re-exported for tests ─────────────────────────────────

export const __testHelpers = {
  orderLegsForOpen,
  orderLegsForClose,
  sideForLeg,
  reverseSideForRollback,
  newSpreadGroupId: () => `vc-spread-${randomUUID()}`
};
