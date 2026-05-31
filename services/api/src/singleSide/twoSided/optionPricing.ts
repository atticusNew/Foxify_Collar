/**
 * Unified option pricing primitive — the SINGLE canonical answer to
 * "what is this option worth right now?".
 *
 * BEFORE THIS MODULE EXISTED, eight different code paths each priced
 * options their own way:
 *
 *   - mtmService.valueLeg            → tiered bid lookup + BS fallback (own rules)
 *   - closeExecutor.lookupBidForLeg  → tiered bid lookup + BS fallback (own rules)
 *   - executionRuntime.tick          → pure BS via computeCombinedOptionValue
 *   - liveCellEvService              → pure BS with hardcoded REGIME_SIGMAS
 *   - routes.gate_with_ev (realism)  → inline BS with hardcoded sigma=0.36
 *   - routes.ev-by-regime (realism)  → same inline BS
 *   - quoteEngine (activation cost)  → live venue ask
 *   - expiryHandler                  → mtmService (already indirected)
 *
 * Each had subtle differences: different fallback rules, different sigma
 * assumptions, different haircuts, no shared cache lifecycle. The result
 * was that the same active pair could report THREE different values in
 * three different endpoints, and operator + CEO + Foxify saw inconsistent
 * numbers depending on which probe they fired.
 *
 * This module fixes that. Every caller uses one API. Every caller gets
 * the same answer for the same inputs.
 *
 * Pricing cascade (in priority order):
 *
 *   1. EXACT instrument symbol bid on the holding venue
 *      → most accurate when valuing a position we actually own
 *
 *   2. FUZZY strike+tenor bid on the same venue (proxy)
 *      → less accurate; the matched quote may be different expiry
 *      → only used when exact_symbol unavailable
 *
 *   3. BLACK-SCHOLES theoretical (with bs_fallback_haircut)
 *      → least accurate; uses live DVOL for IV
 *      → only used when no bid reachable
 *
 * The `purpose` parameter shapes the response interpretation:
 *
 *   - "mtm"               — mark-to-market; what's the position WORTH right now
 *                            (informational, drives auto-TP decisions)
 *   - "salvage_estimate"  — close-out value; what we'd RECEIVE selling now
 *                            (drives shadow close executor + EV salvages)
 *   - "fair_value"        — neutral theoretical; what BOTH sides agree
 *                            (drives TP curve tracking, peak detection)
 *
 * "mtm" and "salvage_estimate" both apply bid-side haircuts; "fair_value"
 * does not. All three use the same source cascade.
 */

import type { LiquidChainCache } from "./liquidChainCache";
import type { DvolService } from "./dvolService";
import { bsPut, bsCall } from "../../../scripts/backtest/singleSide/coreEngine";

// ──────────────────────────── Constants ────────────────────────────

/**
 * Risk-free rate for Black-Scholes valuation. Tunable via env (rare).
 * Default matches US Treasury 1Y rate as of 2026; only revises every
 * ~6 months so hardcode is acceptable as long as it's centralized here.
 */
export const RISK_FREE_RATE = Number(process.env.BS_RISK_FREE_RATE ?? "0.045");

/**
 * Haircut applied to real venue bid to model fill slippage.
 * Real bids may not fill at top-of-book due to size + latency.
 */
export const DEFAULT_BID_HAIRCUT = Number(process.env.BS_BID_HAIRCUT ?? "0.95");

/**
 * Haircut applied to BS theoretical when used as fallback.
 * BS systematically overstates value for OTM strikes due to vol skew;
 * empirically calibrated against real-bid shadow probes (avg ratio 0.5-0.7).
 */
export const DEFAULT_BS_FALLBACK_HAIRCUT = Number(process.env.BS_FALLBACK_HAIRCUT ?? "0.70");

/**
 * Maximum tenor drift in hours for fuzzy match. 36h = ±1.5 days.
 * Tighter than this would miss legitimate proxies; looser would risk
 * crossing expiry boundaries (wrong product).
 */
export const DEFAULT_MAX_TENOR_DRIFT_HOURS = Number(process.env.BS_MAX_TENOR_DRIFT_HOURS ?? "36");

/**
 * Stale quote threshold. Quotes older than this trigger a warning but
 * are still used (rejecting them entirely would break unwinding when
 * chain refresh is slow).
 */
export const STALE_QUOTE_WARN_MS = Number(process.env.STALE_QUOTE_WARN_MS ?? "180000");

/**
 * Last-resort IV fallback when DVOL service is unavailable. Documented as
 * "neutral mid-vol" — should rarely fire in production.
 */
export const NEUTRAL_IV_FALLBACK = Number(process.env.NEUTRAL_IV_FALLBACK ?? "0.36");

const MS_PER_YEAR = 365 * 86_400_000;

// ──────────────────────────── Types ────────────────────────────

export type OptionPricingPurpose = "mtm" | "salvage_estimate" | "fair_value";

export type OptionPricingInputs = {
  /** Current BTC spot (USD). */
  spot: number;
  /** Option strike (USD). */
  strike: number;
  /** "put" or "call". */
  optType: "put" | "call";
  /** Milliseconds until option expiry. Zero or negative → expired (returns intrinsic only). */
  tenorRemainingMs: number;
  /** Number of BTC contracts. Output `*_total` fields scale by this. */
  contractsBtc: number;
  /** Venue we hold the option on (for exact-symbol lookup). Optional but recommended. */
  venue?: "deribit" | "bullish" | null;
  /** Specific instrument symbol (e.g. "BTC-1JUN26-73000-P"). Optional but recommended. */
  instrumentSymbol?: string | null;
  /** Liquid chain cache. If omitted, falls straight to BS. */
  liquidChainCache?: LiquidChainCache | null;
  /** DVOL service for live IV. If omitted, falls back to NEUTRAL_IV_FALLBACK. */
  dvolService?: DvolService | null;
  /** Override IV in BS valuation. Used by MC sims to evaluate at synthetic σ. */
  ivAnnualOverride?: number;
  /** What this lookup is for (drives haircut application). */
  purpose: OptionPricingPurpose;
  /** Override default bid haircut (e.g. for stress-testing slippage assumptions). */
  bidHaircut?: number;
  /** Override default BS fallback haircut. */
  bsFallbackHaircut?: number;
  /** Override default tenor drift window. */
  maxTenorDriftHours?: number;
  /** Optional now-ms (for deterministic tests). */
  nowMs?: number;
};

export type PricingSource =
  | "exact_symbol"            // ← bid on the exact instrument we hold
  | "fuzzy_strike_tenor"      // ← bid on similar strike+tenor (proxy)
  | "bs_only";                // ← Black-Scholes (theoretical)

export type IvSource =
  | "live_dvol"               // pulled from DvolService at call time
  | "override"                // explicit ivAnnualOverride provided
  | "default_36"              // fell back to NEUTRAL_IV_FALLBACK
  | "from_chain_mark_iv";     // taken from matched quote's markIv field

export type OptionPricingResult = {
  /**
   * The single answer most callers want. Per-BTC, post-haircut, ready to use.
   * For purpose=mtm/salvage_estimate: bid (or BS fallback) × haircut.
   * For purpose=fair_value: mid (or BS fallback), no haircut.
   */
  primary_value_per_btc: number;
  /** Same as primary_value_per_btc × contractsBtc. */
  primary_value_total: number;
  /** Raw bid in USDC/BTC (null when BS-only fallback). */
  bid_per_btc: number | null;
  /** Raw ask in USDC/BTC (null when BS-only fallback). */
  ask_per_btc: number | null;
  /** Bid-ask mid in USDC/BTC (null when BS-only fallback). */
  mid_per_btc: number | null;
  /** BS theoretical value in USDC/BTC (always computed; useful for comparison). */
  bs_theoretical_per_btc: number;
  /** Which tier of the cascade fired. */
  source: PricingSource;
  /** Sigma actually used in BS computation (annualized). */
  iv_used: number;
  /** Where the IV came from. */
  iv_source: IvSource;
  /** Bid-ask spread % (null when BS-only). */
  spread_pct: number | null;
  /** Age of the quote in ms (null when BS-only). */
  age_ms: number | null;
  /** Venue the quote came from (null when BS-only). */
  venue_used: "deribit" | "bullish" | null;
  /** Instrument symbol the quote came from (null when BS-only). */
  instrument_used: string | null;
  /** Haircut actually applied to primary_value (1.0 = none). */
  haircut_applied: number;
  /** Diagnostic warnings (stale quote, fallback fired, etc). */
  warnings: string[];
};

// ──────────────────────────── Implementation ────────────────────────────

/**
 * Resolve IV using priority: explicit override → live DVOL → neutral fallback.
 */
const resolveIv = (
  inputs: OptionPricingInputs,
  nowMs: number
): { iv: number; source: IvSource } => {
  if (inputs.ivAnnualOverride != null && Number.isFinite(inputs.ivAnnualOverride) && inputs.ivAnnualOverride > 0) {
    return { iv: inputs.ivAnnualOverride, source: "override" };
  }
  if (inputs.dvolService) {
    const dvol = inputs.dvolService.getCurrentDvol(nowMs);
    if (dvol && Number.isFinite(dvol.sigmaAnnual) && dvol.sigmaAnnual > 0) {
      return { iv: dvol.sigmaAnnual, source: "live_dvol" };
    }
  }
  return { iv: NEUTRAL_IV_FALLBACK, source: "default_36" };
};

/**
 * Compute Black-Scholes theoretical (always, regardless of cascade outcome —
 * useful for the bs_theoretical_per_btc field in the result).
 */
const computeBsTheoretical = (
  spot: number,
  strike: number,
  optType: "put" | "call",
  tenorRemainingMs: number,
  ivAnnual: number
): number => {
  if (tenorRemainingMs <= 0) {
    // Expired — intrinsic only
    return Math.max(0, optType === "put" ? strike - spot : spot - strike);
  }
  const T = tenorRemainingMs / MS_PER_YEAR;
  const v = optType === "put"
    ? bsPut(spot, strike, T, RISK_FREE_RATE, ivAnnual)
    : bsCall(spot, strike, T, RISK_FREE_RATE, ivAnnual);
  return Math.max(0, v);
};

/**
 * Price the option using the canonical cascade.
 *
 * Pure function except for reading from injected services (DvolService,
 * LiquidChainCache). Deterministic when nowMs is provided.
 */
export const priceOption = (inputs: OptionPricingInputs): OptionPricingResult => {
  const nowMs = inputs.nowMs ?? Date.now();
  const warnings: string[] = [];

  if (!Number.isFinite(inputs.spot) || inputs.spot <= 0) {
    throw new Error(`priceOption: invalid spot ${inputs.spot}`);
  }
  if (!Number.isFinite(inputs.strike) || inputs.strike <= 0) {
    throw new Error(`priceOption: invalid strike ${inputs.strike}`);
  }
  if (!Number.isFinite(inputs.contractsBtc) || inputs.contractsBtc <= 0) {
    throw new Error(`priceOption: invalid contractsBtc ${inputs.contractsBtc}`);
  }

  const { iv, source: ivSource } = resolveIv(inputs, nowMs);
  const bsTheoretical = computeBsTheoretical(
    inputs.spot,
    inputs.strike,
    inputs.optType,
    inputs.tenorRemainingMs,
    iv
  );

  const tenorRemainingHours = Math.max(0, inputs.tenorRemainingMs / 3_600_000);
  const bidHaircut = inputs.bidHaircut ?? DEFAULT_BID_HAIRCUT;
  const bsHaircut = inputs.bsFallbackHaircut ?? DEFAULT_BS_FALLBACK_HAIRCUT;
  const maxTenorDrift = inputs.maxTenorDriftHours ?? DEFAULT_MAX_TENOR_DRIFT_HOURS;

  // ─── Cascade Tier 1: exact instrument symbol ───
  if (inputs.liquidChainCache && inputs.venue && inputs.instrumentSymbol) {
    const exact = inputs.liquidChainCache.getBidForSymbol({
      venue: inputs.venue,
      instrumentSymbol: inputs.instrumentSymbol
    });
    if (exact && exact.bidUsdcPerBtc > 0) {
      const age = nowMs - exact.pulledAtMs;
      if (age > STALE_QUOTE_WARN_MS) {
        warnings.push(`stale_quote_${age}ms_threshold_${STALE_QUOTE_WARN_MS}ms`);
      }
      const haircut = inputs.purpose === "fair_value" ? 1.0 : bidHaircut;
      const primaryValuePerBtc = inputs.purpose === "fair_value"
        ? exact.midUsdcPerBtc
        : exact.bidUsdcPerBtc * haircut;
      return {
        primary_value_per_btc: primaryValuePerBtc,
        primary_value_total: primaryValuePerBtc * inputs.contractsBtc,
        bid_per_btc: exact.bidUsdcPerBtc,
        ask_per_btc: exact.askUsdcPerBtc,
        mid_per_btc: exact.midUsdcPerBtc,
        bs_theoretical_per_btc: bsTheoretical,
        source: "exact_symbol",
        iv_used: iv,
        iv_source: ivSource,
        spread_pct: exact.spreadPct,
        age_ms: age,
        venue_used: exact.venue,
        instrument_used: exact.instrumentName,
        haircut_applied: haircut,
        warnings
      };
    }
    if (exact) {
      warnings.push("exact_symbol_has_zero_bid_falling_through");
    }
  }

  // ─── Cascade Tier 2: fuzzy strike+tenor on preferred venue ───
  if (inputs.liquidChainCache) {
    const fuzzy = inputs.liquidChainCache.getBidForLeg({
      strike: inputs.strike,
      optType: inputs.optType,
      tenorRemainingHours,
      preferVenue: inputs.venue ?? undefined,
      maxTenorDriftHours: maxTenorDrift
    });
    if (fuzzy && fuzzy.bidUsdcPerBtc > 0) {
      const age = nowMs - fuzzy.pulledAtMs;
      if (age > STALE_QUOTE_WARN_MS) {
        warnings.push(`stale_quote_${age}ms_threshold_${STALE_QUOTE_WARN_MS}ms`);
      }
      const tenorMismatch = fuzzy.tenorHours - tenorRemainingHours;
      if (Math.abs(tenorMismatch) > 6) {
        warnings.push(`fuzzy_tenor_drift_${tenorMismatch.toFixed(1)}h_used_proxy_instrument`);
      }
      const haircut = inputs.purpose === "fair_value" ? 1.0 : bidHaircut;
      const primaryValuePerBtc = inputs.purpose === "fair_value"
        ? fuzzy.midUsdcPerBtc
        : fuzzy.bidUsdcPerBtc * haircut;
      return {
        primary_value_per_btc: primaryValuePerBtc,
        primary_value_total: primaryValuePerBtc * inputs.contractsBtc,
        bid_per_btc: fuzzy.bidUsdcPerBtc,
        ask_per_btc: fuzzy.askUsdcPerBtc,
        mid_per_btc: fuzzy.midUsdcPerBtc,
        bs_theoretical_per_btc: bsTheoretical,
        source: "fuzzy_strike_tenor",
        iv_used: iv,
        iv_source: ivSource,
        spread_pct: fuzzy.spreadPct,
        age_ms: age,
        venue_used: fuzzy.venue,
        instrument_used: fuzzy.instrumentName,
        haircut_applied: haircut,
        warnings
      };
    }
  }

  // ─── Cascade Tier 3: BS theoretical (last resort) ───
  warnings.push(`bs_fallback_no_venue_bid_available_spot=${inputs.spot}_strike=${inputs.strike}_tenor=${tenorRemainingHours.toFixed(1)}h`);
  const haircut = inputs.purpose === "fair_value" ? 1.0 : bsHaircut;
  const primaryValuePerBtc = bsTheoretical * haircut;
  return {
    primary_value_per_btc: primaryValuePerBtc,
    primary_value_total: primaryValuePerBtc * inputs.contractsBtc,
    bid_per_btc: null,
    ask_per_btc: null,
    mid_per_btc: null,
    bs_theoretical_per_btc: bsTheoretical,
    source: "bs_only",
    iv_used: iv,
    iv_source: ivSource,
    spread_pct: null,
    age_ms: null,
    venue_used: null,
    instrument_used: null,
    haircut_applied: haircut,
    warnings
  };
};

/**
 * Convenience: combined put + call value using the same cascade for each leg.
 * Used by MTM, runtime TP loop, EV salvage estimation, etc.
 */
export const priceStrangle = (legs: {
  put: Omit<OptionPricingInputs, "purpose">;
  call: Omit<OptionPricingInputs, "purpose">;
  purpose: OptionPricingPurpose;
}): {
  put: OptionPricingResult;
  call: OptionPricingResult;
  combined_value_total: number;
  combined_bs_theoretical: number;
} => {
  const put = priceOption({ ...legs.put, optType: "put", purpose: legs.purpose });
  const call = priceOption({ ...legs.call, optType: "call", purpose: legs.purpose });
  return {
    put,
    call,
    combined_value_total: put.primary_value_total + call.primary_value_total,
    combined_bs_theoretical: (put.bs_theoretical_per_btc + call.bs_theoretical_per_btc) *
      (legs.put.contractsBtc /* both legs same contracts in this model */)
  };
};
