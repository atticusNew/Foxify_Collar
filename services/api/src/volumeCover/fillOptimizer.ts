/**
 * Volume Cover empirical fill optimizer (2026-05-23).
 *
 * Captures the price improvement Bullish IOC matching gives beyond the
 * worst-case ask/bid. From E2/E3 microtests:
 *
 *   E2: predicted round-trip $0.50, actual $0.15 → $0.35 favorable
 *   E3: predicted round-trip $1.90, actual $0.60 → $1.30 favorable
 *
 * Both runs filled at the original bid/ask exactly, but the round-trip
 * cash delta on the operator account was materially better than the
 * fill-price arithmetic predicted. Hypothesis: Bullish's matching
 * engine occasionally fills at price improvement, plus the maker side
 * of the book sometimes refreshes inside between the bid and the ask
 * by the time our IOC arrives.
 *
 * Algorithm (per leg):
 *
 *   targetPrice = side === BUY
 *     ? ask - (ask - bid) * improvementFraction      // we want lower
 *     : bid + (ask - bid) * improvementFraction      // we want higher
 *
 *   1. Submit IOC limit at targetPrice
 *   2. On Executed (any fill quantity): success — improvement captured
 *   3. On Expired (no fill at improved price): submit IOC limit at the
 *      original worst-case price (bid for SELL, ask for BUY). This is
 *      the same behavior as today's executor, so this fallback is
 *      no-worse-than-baseline.
 *
 * No capital risk on the first attempt — IOC returns instantly. Costs
 * ~100ms latency on the expired-retry path. Expected savings:
 * $24-64/round-trip-cycle at production size.
 *
 * This module is pure planning logic. The actual order submission is
 * delegated to the caller-provided fillFn so we can keep it venue-
 * agnostic and test it without a Bullish dependency.
 */

import Decimal from "decimal.js";

// ─── Config ──────────────────────────────────────────────────────────

export type FillOptimizerConfig = {
  enabled: boolean;
  /** 0..0.5; how far inside the spread to aim. 0.25 = quarter-way. */
  improvementFraction: number;
  /** Maximum improved attempts per leg (default 1; > 1 only matters if randomized). */
  maxAttempts: number;
};

const DEFAULTS: FillOptimizerConfig = {
  enabled: true,
  improvementFraction: 0.25,
  maxAttempts: 1
};

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() !== "false";
};

export const getConfiguredFillOptimizer = (): FillOptimizerConfig => {
  const fraction = readNumber("VC_FILL_OPTIMIZER_IMPROVEMENT_FRACTION", DEFAULTS.improvementFraction);
  return {
    enabled: readBool("VC_FILL_OPTIMIZER_ENABLED", DEFAULTS.enabled),
    improvementFraction: Math.max(0, Math.min(0.5, fraction)),
    maxAttempts: Math.max(1, Math.min(5, readNumber("VC_FILL_OPTIMIZER_MAX_ATTEMPTS", DEFAULTS.maxAttempts)))
  };
};

// ─── Target-price math ───────────────────────────────────────────────

export type Side = "BUY" | "SELL";

/**
 * Compute the improved-price target for a side, given top-of-book.
 * Rounds to tick size (0.01 USDC for Bullish options).
 *
 * Returns null when bid/ask are not both finite or spread <= 0
 * (caller should fall back to the worst-case price).
 */
export const computeImprovedTargetPrice = (params: {
  side: Side;
  topBidUsdc: number;
  topAskUsdc: number;
  improvementFraction: number;
  tickSizeUsdc?: number;
}): number | null => {
  const tick = params.tickSizeUsdc ?? 0.01;
  if (!Number.isFinite(params.topBidUsdc) || !Number.isFinite(params.topAskUsdc)) return null;
  const spread = params.topAskUsdc - params.topBidUsdc;
  if (spread <= 0) return null;
  const adjust = spread * params.improvementFraction;
  const raw = new Decimal(
    params.side === "BUY" ? params.topAskUsdc - adjust : params.topBidUsdc + adjust
  );
  const ticks = raw.div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return ticks.mul(tick).toNumber();
};

// ─── Execution helper ────────────────────────────────────────────────

export type FillResult = {
  filled: boolean;
  fillPriceUsdc: number | null;
  fillQtyBtc: number | null;
  finalReason: string | null;
  orderId: string | null;
  attempts: number;
  attemptedPrices: number[];
  raw?: unknown;
};

/** Caller-supplied function that submits ONE IOC limit at a specific price. */
export type FillSubmitFn = (params: {
  side: Side;
  symbol: string;
  priceUsdc: number;
  quantityBtc: number;
}) => Promise<{
  filled: boolean;
  fillPriceUsdc: number | null;
  fillQtyBtc: number | null;
  finalReason: string | null; // expected: 'Executed' | 'Expired' | other
  orderId: string | null;
  raw?: unknown;
}>;

/**
 * Two-attempt fill execution:
 *   attempt 1: improved-price IOC limit (if cfg.enabled and bid/ask valid)
 *   attempt 2 (only on Expired): worst-case bid/ask IOC limit
 *
 * If the optimizer is disabled OR bid/ask are unusable, this falls
 * straight through to the worst-case submission (single attempt).
 *
 * Returns a FillResult with attempts + attemptedPrices for telemetry.
 */
export const executeOptimizedFill = async (params: {
  side: Side;
  symbol: string;
  quantityBtc: number;
  topBidUsdc: number;
  topAskUsdc: number;
  tickSizeUsdc?: number;
  cfg?: FillOptimizerConfig;
  submitFn: FillSubmitFn;
}): Promise<FillResult> => {
  const cfg = params.cfg ?? getConfiguredFillOptimizer();
  const worstCasePrice = params.side === "BUY" ? params.topAskUsdc : params.topBidUsdc;
  const attemptedPrices: number[] = [];

  // Try the improved price first if the optimizer is enabled.
  if (cfg.enabled) {
    const improved = computeImprovedTargetPrice({
      side: params.side,
      topBidUsdc: params.topBidUsdc,
      topAskUsdc: params.topAskUsdc,
      improvementFraction: cfg.improvementFraction,
      tickSizeUsdc: params.tickSizeUsdc
    });
    if (improved !== null && improved > 0) {
      attemptedPrices.push(improved);
      const r1 = await params.submitFn({
        side: params.side,
        symbol: params.symbol,
        priceUsdc: improved,
        quantityBtc: params.quantityBtc
      });
      if (r1.filled) {
        return {
          filled: true,
          fillPriceUsdc: r1.fillPriceUsdc,
          fillQtyBtc: r1.fillQtyBtc,
          finalReason: r1.finalReason,
          orderId: r1.orderId,
          attempts: 1,
          attemptedPrices,
          raw: r1.raw
        };
      }
      // Only fall through to attempt 2 when the venue returned
      // Expired (no liquidity at improved price). On any other failure
      // (rejected, error), do NOT retry — we don't want to compound
      // a genuine failure.
      if (r1.finalReason && r1.finalReason.toLowerCase() !== "expired") {
        return {
          filled: false,
          fillPriceUsdc: r1.fillPriceUsdc,
          fillQtyBtc: r1.fillQtyBtc,
          finalReason: r1.finalReason,
          orderId: r1.orderId,
          attempts: 1,
          attemptedPrices,
          raw: r1.raw
        };
      }
    }
  }

  // Fallback / baseline: submit at worst-case bid/ask.
  attemptedPrices.push(worstCasePrice);
  const r2 = await params.submitFn({
    side: params.side,
    symbol: params.symbol,
    priceUsdc: worstCasePrice,
    quantityBtc: params.quantityBtc
  });
  return {
    filled: r2.filled,
    fillPriceUsdc: r2.fillPriceUsdc,
    fillQtyBtc: r2.fillQtyBtc,
    finalReason: r2.finalReason,
    orderId: r2.orderId,
    attempts: attemptedPrices.length,
    attemptedPrices,
    raw: r2.raw
  };
};
