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
  getConfiguredFillOptimizer,
  type FillOptimizerConfig,
  type FillSubmitFn,
  type FillResult
} from "./fillOptimizer";

// ─── PR-G2 (2026-05-25): mid-IOC short-leg buyback ───────────────────
//
// At trigger fire and at Foxify-close, the spread executor must BUY back
// the two short legs to flatten the position. The pre-PR-G2 default ran
// these buybacks through the standard `executeOptimizedFill` with a
// `VC_FILL_OPTIMIZER_IMPROVEMENT_FRACTION` of 0.25 (25% inside spread).
//
// On Trade 1 (Foxify-001 trigger, 2026-05-23) the realized short-leg
// buyback cost was $1,100 to extinguish ~$300 of fair-value time premium
// — i.e., we paid roughly the worst-case ask. Pushing the first attempt
// to the mid (0.5) keeps the same fall-through behavior (worst-case ask
// on Expired, then deep-cross if `VC_FILL_OPTIMIZER_DEEP_CROSS_BPS` is
// set) but tries to capture price improvement first.
//
// Tuned via `VC_SPREAD_SHORT_BUYBACK_MID_FRACTION` env (default 0.5):
//   • 0.5  = true mid (PR-G2 default)
//   • 0.25 = legacy optimizer behavior (parity with pre-PR-G2)
//   • 0    = no improvement attempt; cross to ask immediately
//
// Hard-clamped to [0, 0.5] (the same range the underlying optimizer
// enforces for `improvementFraction`) so a misconfigured env can't
// place an order outside the bid/ask band.
const SHORT_BUYBACK_MID_FRACTION_DEFAULT = 0.5;

const getShortBuybackMidFraction = (): number => {
  const raw = process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  if (raw === undefined || raw === null || raw === "") {
    return SHORT_BUYBACK_MID_FRACTION_DEFAULT;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return SHORT_BUYBACK_MID_FRACTION_DEFAULT;
  return Math.max(0, Math.min(0.5, n));
};

/**
 * Build a fill-optimizer config tuned for the short-leg buyback path.
 * Spreads the standard env-driven config and overrides only
 * `improvementFraction`. The deep-cross fall-through behavior is
 * inherited from the standard config so a thin-book buyback still
 * walks to next-level liquidity rather than failing.
 *
 * Test override: pass `cfgOverride` to inject a deterministic config.
 */
const buildShortBuybackOptimizerCfg = (
  cfgOverride?: FillOptimizerConfig
): FillOptimizerConfig => {
  const base = cfgOverride ?? getConfiguredFillOptimizer();
  return {
    ...base,
    improvementFraction: cfgOverride
      ? cfgOverride.improvementFraction
      : getShortBuybackMidFraction()
  };
};

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
  /**
   * Phase 0.2a → PR-A (2026-05-24): depth-aware gate config snapshot
   * for this check.
   *
   *   minDepthBtcFloor    — absolute lower bound (BTC). Env:
   *                         VC_SPREAD_MIN_DEPTH_BTC.
   *   depthRatio          — fraction of contractsBtcPerLeg required as
   *                         visible depth on the crossing side. Env:
   *                         VC_SPREAD_DEPTH_RATIO_REQUIRED.
   *   enforced            — when false, depth shortfalls only log
   *                         telemetry (legacy log-only mode). When true,
   *                         a thin leg fails the gate. Env:
   *                         VC_SPREAD_DEPTH_GATE_ENFORCED.
   *   effectiveMinDepthBtc — actual threshold applied for this check,
   *                         computed as
   *                           max(minDepthBtcFloor, depthRatio × contractsBtcPerLeg).
   */
  depthGate: {
    minDepthBtcFloor: number;
    depthRatio: number;
    enforced: boolean;
    effectiveMinDepthBtc: number;
  };
  legChecks: Array<{
    legRole: SpreadLegSpec["legRole"];
    symbol: string;
    crossesSide: "BUY" | "SELL";
    topBidUsdc: number | null;
    topAskUsdc: number | null;
    /** Observed depth in BTC on the side we're crossing. */
    observedDepthBtc: number | null;
    /** Depth sufficient iff observedDepth ≥ effectiveMinDepthBtc. */
    depthSufficient: boolean;
    sufficient: boolean;
    reason: string | null;
  }>;
};

/**
 * Phase 0.2a → PR-A (2026-05-24): read depth-gate config from env.
 *
 * Defaults:
 *   VC_SPREAD_MIN_DEPTH_BTC=0.3          absolute floor in BTC
 *   VC_SPREAD_DEPTH_RATIO_REQUIRED=0.7   fraction of contract size required
 *   VC_SPREAD_DEPTH_GATE_ENFORCED=false  log-only until flipped on Render
 *
 * Effective threshold per leg (computed in checkSpreadLiquidity from this
 * config + structure.contractsBtcPerLeg):
 *   max(VC_SPREAD_MIN_DEPTH_BTC, VC_SPREAD_DEPTH_RATIO_REQUIRED × contractsBtcPerLeg)
 *
 * Rationale (post Foxify-001):
 *   The 50k_2pct_1k cell sizes ~1.0–1.3 BTC per leg at current spot. A
 *   flat absolute floor (0.3 BTC) only catches the worst tail; partial
 *   fills observed at 0.56 BTC depth on 77k-C with ~1 BTC orders. The
 *   ratio knob makes the threshold scale with order size: at 1.32 BTC
 *   contract × 0.7 ratio = 0.92 BTC required — would have caught the
 *   Foxify-001 partial-fill scenario. The absolute floor is preserved
 *   for the small/test cells where ratio×contracts is near zero.
 */
export const getConfiguredDepthGate = (): {
  minDepthBtcFloor: number;
  depthRatio: number;
  enforced: boolean;
} => {
  const rawFloor = process.env.VC_SPREAD_MIN_DEPTH_BTC;
  const rawRatio = process.env.VC_SPREAD_DEPTH_RATIO_REQUIRED;
  const rawEnf = process.env.VC_SPREAD_DEPTH_GATE_ENFORCED;
  const floorRaw = rawFloor !== undefined && rawFloor !== "" ? Number(rawFloor) : NaN;
  const minDepthBtcFloor = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : 0.3;
  const ratioRaw = rawRatio !== undefined && rawRatio !== "" ? Number(rawRatio) : NaN;
  const depthRatio = Number.isFinite(ratioRaw) && ratioRaw >= 0 ? ratioRaw : 0.7;
  const enforced = String(rawEnf ?? "").trim().toLowerCase() === "true";
  return { minDepthBtcFloor, depthRatio, enforced };
};

/**
 * Hardened liquidity gate (mirror of the E3 microtest's Phase 1).
 * For BUYs we need a resting ASK; for SELLs we need a resting BID.
 * Missing the side we cross would cause `Expired` returns at IOC time.
 *
 * Phase 0.2a → PR-A (2026-05-24): depth-aware checking. The effective
 * minimum depth required scales with the per-leg contract size:
 *
 *   effectiveMinDepthBtc = max(minDepthBtcFloor, depthRatio × contractsBtcPerLeg)
 *
 * This catches the Foxify-001 partial-fill failure mode where ~1 BTC
 * orders crossed into ~0.5 BTC tops without tripping the old flat 0.3
 * BTC floor. The gate is LOG-ONLY by default; flipping
 * VC_SPREAD_DEPTH_GATE_ENFORCED=true upgrades thin legs to a hard fail.
 */
export const checkSpreadLiquidity = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  action: "open" | "close";
  /**
   * Override the env-driven depth gate config. Tests use this to
   * exercise enforce/log-only paths without env shenanigans.
   */
  depthGateOverride?: {
    minDepthBtcFloor: number;
    depthRatio: number;
    enforced: boolean;
  };
}): Promise<LiquidityCheck> => {
  const cfg = params.depthGateOverride ?? getConfiguredDepthGate();
  const contractsBtc = params.structure.contractsBtcPerLeg;
  const ratioComponent = cfg.depthRatio * contractsBtc;
  const effectiveMinDepthBtc = Math.max(cfg.minDepthBtcFloor, ratioComponent);
  const depthGate: LiquidityCheck["depthGate"] = {
    minDepthBtcFloor: cfg.minDepthBtcFloor,
    depthRatio: cfg.depthRatio,
    enforced: cfg.enforced,
    effectiveMinDepthBtc
  };
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
    let observedDepthBtc: number | null = null;
    if (side === "BUY") {
      sufficient = typeof book.topAskUsdc === "number" && book.topAskUsdc > 0;
      if (!sufficient) reason = "no_resting_ask_for_buy";
      observedDepthBtc = typeof book.askQtyBtc === "number" ? book.askQtyBtc : null;
    } else {
      sufficient = typeof book.topBidUsdc === "number" && book.topBidUsdc > 0;
      if (!sufficient) reason = "no_resting_bid_for_sell";
      observedDepthBtc = typeof book.bidQtyBtc === "number" ? book.bidQtyBtc : null;
    }

    // Depth check (telemetry always, enforcement gated)
    const depthSufficient =
      observedDepthBtc !== null && observedDepthBtc >= effectiveMinDepthBtc;
    if (!depthSufficient) {
      console.warn(
        `[spreadExecutor] thin depth observed legRole=${leg.legRole} symbol=${symbol} ` +
          `side=${side} observed=${observedDepthBtc ?? "null"} BTC ` +
          `effectiveMin=${effectiveMinDepthBtc} BTC (floor=${cfg.minDepthBtcFloor}, ratio=${cfg.depthRatio}, ` +
          `contracts=${contractsBtc}) enforced=${depthGate.enforced} action=${params.action} ` +
          `groupId=${params.structure.spreadGroupId}`
      );
      if (depthGate.enforced) {
        sufficient = false;
        reason = reason ?? `thin_depth_on_${side === "BUY" ? "ask" : "bid"}_${observedDepthBtc ?? "null"}_lt_${effectiveMinDepthBtc}`;
      }
    }

    if (!sufficient) allPassed = false;
    checks.push({
      legRole: leg.legRole,
      symbol,
      crossesSide: side,
      topBidUsdc: book.topBidUsdc,
      topAskUsdc: book.topAskUsdc,
      observedDepthBtc,
      depthSufficient,
      sufficient,
      reason
    });
  }
  return { passed: allPassed, legChecks: checks, depthGate };
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
  const liquidity: LiquidityCheck = params.skipLiquidityGate
    ? {
        passed: true,
        legChecks: [],
        depthGate: {
          minDepthBtcFloor: 0,
          depthRatio: 0,
          enforced: false,
          effectiveMinDepthBtc: 0
        }
      }
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
  /**
   * 2026-05-23: dual-mode return. When `sellLongsAtTrigger=true` (the
   * default after first live trigger post-mortem), `longLegsSold` is
   * populated with actual fills + prices. When false (legacy behavior),
   * `longLegsRetained` is populated and longs are kept for hedge mgr.
   * EXACTLY ONE of these arrays has fills; the other is empty.
   */
  longLegsSold: OpenLegRecord[];
  longLegsRetained: Array<{
    legRole: SpreadLegSpec["legRole"];
    symbol: string;
    contractsBtc: number;
    strikeActualUsdc: number;
  }>;
  failedAt: SpreadLegSpec["legRole"] | null;
  errorReason: string | null;
  shortLegProceedsUsdc: number;
  longLegProceedsUsdc: number;
};

/**
 * 2026-05-23 (Foxify-001 trigger post-mortem): how to handle the LONG
 * legs of a [DB] spread when the trigger fires. Originally a boolean
 * (`VC_SPREAD_SELL_LONGS_AT_TRIGGER`); 2026-05-25 (PR-Bundle-3-B)
 * generalized to a 3-way mode because the winner and loser have very
 * different profiles at trigger:
 *
 *   `both`        — sell both longs immediately at trigger fire (legacy
 *                   PR-C default). Captures the winner's peak intrinsic
 *                   but eats the loser's residual time value AND leaves
 *                   nothing to ladder-net into the next position.
 *   `winner_only` — sell the winner immediately (peak capture, PR-C
 *                   benefit), retain the loser for the hedge manager's
 *                   Rule 7 (loser_floor) + Rule 10 (near-ATM days
 *                   remaining). Retained loser is also eligible for
 *                   ladder netting into a same-fingerprint reopen.
 *                   *** RECOMMENDED DEFAULT post-Bundle-3-B ***
 *   `none`        — retain BOTH longs (legacy pre-PR-C behavior; useful
 *                   only when reverting to debug something).
 *
 * Backward-compat: if `VC_SPREAD_LONG_TRIGGER_POLICY` is unset, fall
 * through to the legacy `VC_SPREAD_SELL_LONGS_AT_TRIGGER` boolean
 * (true → "both", false → "none"). Without either env, default to
 * `winner_only`.
 */
export type LongTriggerPolicy = "both" | "winner_only" | "none";

export const getConfiguredLongTriggerPolicy = (): LongTriggerPolicy => {
  const raw = process.env.VC_SPREAD_LONG_TRIGGER_POLICY;
  if (typeof raw === "string" && raw.length > 0) {
    const v = raw.trim().toLowerCase();
    if (v === "both" || v === "winner_only" || v === "none") return v;
    // Fall through silently on garbage rather than block; default applies.
  }
  // Legacy boolean fallback for back-compat with pre-Bundle-3-B envs.
  const legacy = process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER;
  if (legacy !== undefined && legacy !== null && legacy !== "") {
    return String(legacy).trim().toLowerCase() === "false" ? "none" : "both";
  }
  return "winner_only";
};

/**
 * Legacy boolean form, preserved for tests + old env reads. Maps the
 * 3-way mode back to a boolean for paths that only care whether ANY
 * long-sell happens at trigger. Use `getConfiguredLongTriggerPolicy`
 * for full fidelity.
 */
const shouldSellLongsAtTrigger = (): boolean => {
  const policy = getConfiguredLongTriggerPolicy();
  return policy === "both" || policy === "winner_only";
};

/**
 * 2026-05-24 (PR-C): Parallelize the two long-leg sales after shorts
 * close. Sequential implementation paid 50-200ms inter-leg jitter +
 * waited for winner-side fill before placing loser-side, costing
 * ~1-3s wall-clock during a fire while BTC mean-reverts. Parallel
 * execution overlaps the IOC + status-poll for both legs concurrently.
 *
 * Default ON. Disable via VC_SPREAD_PARALLEL_LONG_SELLS=false to
 * recover legacy sequential ordering (winner-first, then loser).
 *
 * Note: log/audit ordering is preserved as winner-first regardless of
 * actual fill ordering by sorting `longLegsSold` after Promise.all.
 */
const shouldParallelizeLongSells = (): boolean => {
  const raw = process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  if (raw === undefined || raw === null || raw === "") return true; // default ON
  return String(raw).trim().toLowerCase() !== "false";
};

export const partialCloseSpreadOnTrigger = async (params: {
  structure: SpreadStructure;
  adapter: SpreadExecutorAdapter;
  triggerDirection: "high" | "low";
  randFn?: () => number;
  /**
   * Legacy boolean override (kept for back-compat). When set, mapped to
   *   true  → policy "both"
   *   false → policy "none"
   * Prefer `longTriggerPolicyOverride` for new code paths.
   */
  sellLongsAtTriggerOverride?: boolean;
  /**
   * PR-Bundle-3-B (2026-05-25): explicit 3-way policy override. Wins
   * over `sellLongsAtTriggerOverride` and the env. Used by:
   *   • Foxify-close path (closePosition): `none` (retain both)
   *   • Tests asserting specific behavior
   */
  longTriggerPolicyOverride?: LongTriggerPolicy;
  /**
   * PR-G2: override the fill-optimizer config used for the SHORT-leg
   * buyback path (test-only). Production reads
   * VC_SPREAD_SHORT_BUYBACK_MID_FRACTION via getShortBuybackMidFraction.
   * The long-sale path is NOT affected by this override; long sales
   * keep the standard env-driven optimizer config.
   */
  shortBuybackOptimizerCfgOverride?: FillOptimizerConfig;
}): Promise<SpreadPartialCloseResult> => {
  const jitterCfg = getConfiguredHedgeJitter();
  // PR-G2: build the short-buyback-specific optimizer config ONCE (so the
  // env read is consistent across the two short legs of this trigger).
  // Long sales below intentionally do NOT pass cfg, so they keep the
  // standard 0.25 improvement fraction — only short buybacks aim at mid.
  const shortBuybackCfg = buildShortBuybackOptimizerCfg(
    params.shortBuybackOptimizerCfgOverride
  );
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
      // PR-G2: try mid first on short buybacks (default fraction 0.5).
      // Falls through to worst-case ask + deep-cross via the standard
      // optimizer cascade if mid expires.
      cfg: shortBuybackCfg,
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

  // ─── 2026-05-25 (PR-Bundle-3-B): long-trigger policy ───
  // Resolve the policy in this precedence:
  //   1. Explicit `longTriggerPolicyOverride` from caller (test injection
  //      OR Foxify-close path setting "none")
  //   2. Legacy `sellLongsAtTriggerOverride` boolean (back-compat;
  //      true → "both", false → "none")
  //   3. Env-driven default via getConfiguredLongTriggerPolicy
  //      (post-Bundle-3-B default: "winner_only")
  let longTriggerPolicy: LongTriggerPolicy;
  if (params.longTriggerPolicyOverride !== undefined) {
    longTriggerPolicy = params.longTriggerPolicyOverride;
  } else if (params.sellLongsAtTriggerOverride !== undefined) {
    longTriggerPolicy = params.sellLongsAtTriggerOverride ? "both" : "none";
  } else {
    longTriggerPolicy = getConfiguredLongTriggerPolicy();
  }
  // Winner is on the trigger side; loser is the opposite wing.
  const winnerRole: SpreadLegSpec["legRole"] =
    params.triggerDirection === "high" ? "call_long" : "put_long";
  const loserRole: SpreadLegSpec["legRole"] =
    params.triggerDirection === "high" ? "put_long" : "call_long";
  const longLegsOrder: SpreadLegSpec["legRole"][] = [winnerRole, loserRole];

  const longLegsSold: OpenLegRecord[] = [];
  const longLegsRetained: SpreadPartialCloseResult["longLegsRetained"] = [];
  let longLegProceedsUsdc = 0;

  // 2026-05-24 (PR-C): per-leg sale task. Returns either a sold record
  // or a retained stub. Used by both sequential and parallel paths.
  type LongSaleOutcome =
    | {
        kind: "sold";
        order: number;
        legRole: SpreadLegSpec["legRole"];
        record: OpenLegRecord;
      }
    | {
        kind: "retained";
        order: number;
        legRole: SpreadLegSpec["legRole"];
        retained: SpreadPartialCloseResult["longLegsRetained"][number];
      }
    | null;

  const sellOneLong = async (
    role: SpreadLegSpec["legRole"],
    order: number
  ): Promise<LongSaleOutcome> => {
    const leg = params.structure.legs.find((l) => l.legRole === role);
    if (!leg) return null;
    const symbol = params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso });
    const side: "BUY" | "SELL" = "SELL"; // close a long by selling
    const book = await params.adapter.getOrderbookTop({ symbol });
    if (
      !Number.isFinite(book.topBidUsdc as number) ||
      !Number.isFinite(book.topAskUsdc as number)
    ) {
      // Fallback to retain: orderbook unavailable, hedge manager
      // will try again later via legacy Rule 4/5/7 path.
      console.warn(
        `[spreadExecutor] long sell skipped (no orderbook) legRole=${leg.legRole}; falling back to retain`
      );
      return {
        kind: "retained",
        order,
        legRole: leg.legRole,
        retained: {
          legRole: leg.legRole,
          symbol,
          contractsBtc: leg.contractsBtc,
          strikeActualUsdc: leg.strikeActualUsdc
        }
      };
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
    if (result.filled) {
      const record = fillResultToLegRecord(leg, symbol, side, result);
      return { kind: "sold", order, legRole: leg.legRole, record };
    }
    // Sell failed — fall back to retain so hedge manager can
    // attempt later via its existing rule curve. This is the same
    // path strangle mode legs take. NOT considered fatal: trigger
    // partial-close was still successful (shorts closed); we just
    // retain instead of sell on this one leg.
    console.warn(
      `[spreadExecutor] long sell failed legRole=${leg.legRole} reason=${result.finalReason}; falling back to retain`
    );
    return {
      kind: "retained",
      order,
      legRole: leg.legRole,
      retained: {
        legRole: leg.legRole,
        symbol,
        contractsBtc: leg.contractsBtc,
        strikeActualUsdc: leg.strikeActualUsdc
      }
    };
  };

  const collectLongOutcomes = (outcomes: Array<LongSaleOutcome>): void => {
    // Sort by intended order (winner-first) for stable log/audit shape
    // regardless of which leg's IOC settled first on the wire.
    const ordered = outcomes
      .filter((o): o is NonNullable<LongSaleOutcome> => o !== null)
      .sort((a, b) => a.order - b.order);
    for (const outcome of ordered) {
      if (outcome.kind === "sold") {
        longLegsSold.push(outcome.record);
        longLegProceedsUsdc +=
          outcome.record.fillPriceUsdcPerBtc * outcome.record.fillQtyBtc;
      } else {
        longLegsRetained.push(outcome.retained);
      }
    }
  };

  // If a short leg failed earlier, do NOT attempt long sales — bail
  // out cleanly. Caller will handle the partial-close failure.
  if (failedAt === null && longTriggerPolicy !== "none") {
    // Resolve the SET of long-roles to sell based on policy.
    //   "both"        → sell winner + loser (legacy PR-C behavior)
    //   "winner_only" → sell winner only; loser falls through to retain
    //   "none"        → handled by the else-branch (no sales)
    const rolesToSell: SpreadLegSpec["legRole"][] =
      longTriggerPolicy === "winner_only" ? [winnerRole] : longLegsOrder;
    const rolesToRetain: SpreadLegSpec["legRole"][] =
      longTriggerPolicy === "winner_only" ? [loserRole] : [];

    if (rolesToSell.length === 1 || !shouldParallelizeLongSells()) {
      // Sequential — necessary for winner_only (only one leg to sell)
      // and legacy escape for "both" if VC_SPREAD_PARALLEL_LONG_SELLS=false.
      const outcomes: LongSaleOutcome[] = [];
      for (let i = 0; i < rolesToSell.length; i++) {
        if (i > 0) {
          const pace = sampleInterLegPacingMs({ cfg: jitterCfg, randFn: params.randFn });
          if (pace > 0) await jitterSleepMs(pace);
        }
        outcomes.push(await sellOneLong(rolesToSell[i], i));
      }
      collectLongOutcomes(outcomes);
    } else {
      // Parallel: kick off both long sales concurrently. Each task
      // independently fetches its orderbook + fires IOC. The total
      // wall-clock is max(t_winner, t_loser) instead of sum, which
      // matters during trigger fire (every 100ms costs intrinsic).
      const tasks = rolesToSell.map((role, i) => sellOneLong(role, i));
      const settled = await Promise.all(tasks);
      collectLongOutcomes(settled);
    }

    // Add retained-loser stubs (winner_only mode). Symbol resolution
    // mirrors the orderbook-unavailable branch of sellOneLong so the
    // hedge manager can pick them up cleanly via the regular Rule 7
    // (loser_floor) + Rule 10 (near-ATM-days) path.
    for (const role of rolesToRetain) {
      const leg = params.structure.legs.find((l) => l.legRole === role);
      if (!leg) continue;
      longLegsRetained.push({
        legRole: leg.legRole,
        symbol: params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso }),
        contractsBtc: leg.contractsBtc,
        strikeActualUsdc: leg.strikeActualUsdc
      });
    }
  } else if (failedAt === null) {
    // policy === "none": retain both longs for the hedge manager.
    for (const leg of params.structure.legs.filter((l) => l.side === "long")) {
      longLegsRetained.push({
        legRole: leg.legRole,
        symbol: params.adapter.resolveSymbol({ leg, expiryIso: leg.expiryIso }),
        contractsBtc: leg.contractsBtc,
        strikeActualUsdc: leg.strikeActualUsdc
      });
    }
  }

  return {
    ok: failedAt === null,
    spreadGroupId: params.structure.spreadGroupId,
    triggerDirection: params.triggerDirection,
    shortLegsClosed: closedShorts,
    longLegsSold,
    longLegsRetained,
    failedAt,
    errorReason,
    shortLegProceedsUsdc: Number(shortLegProceedsUsdc.toFixed(4)),
    longLegProceedsUsdc: Number(longLegProceedsUsdc.toFixed(4))
  };
};

// ─── Utilities re-exported for tests ─────────────────────────────────

export const __testHelpers = {
  orderLegsForOpen,
  orderLegsForClose,
  sideForLeg,
  reverseSideForRollback,
  shouldParallelizeLongSells,
  // PR-G2 short-buyback mid-IOC primitives — re-exported for tests so the
  // env-default + override behavior can be asserted without spawning a
  // subprocess.
  getShortBuybackMidFraction,
  buildShortBuybackOptimizerCfg,
  // PR-Bundle-3-B long-trigger policy resolver — re-exported for tests.
  shouldSellLongsAtTrigger,
  newSpreadGroupId: () => `vc-spread-${randomUUID()}`
};
