/**
 * Mark-to-Market service for active two-sided pairs.
 *
 * Surfaces real-time option value vs cost paid, distance to trigger, and
 * a take-profit recommendation so Foxify's bot can decide when to early-close
 * (via /foxify/v2/close) to capture intermediate appreciation.
 *
 * Why this matters:
 *   Foxify runs delta-neutral perp pairs (long + short on partner venues).
 *   When BTC moves directionally, the losing perp accrues loss + funding +
 *   fees even before the option trigger fires. The option ALSO appreciates
 *   on the same move (gamma exposure). If Foxify can SEE the live option
 *   mark, they can early-close to capture that appreciation and cover the
 *   losing perp's friction without waiting for the trigger.
 *
 * Math:
 *   Per-leg value = Black-Scholes mid value × contracts × slippage haircut
 *   Pair value    = put_value + call_value
 *   PnL           = pair_value − cost_paid
 *
 * The slippage haircut (default 88%) models the realistic gap between
 * theoretical BS mark and what we'd ACTUALLY get if we sold both legs at
 * market right now. Tighter than the 82% used in MC sim because MC assumes
 * the worst-case trigger-moment sale, while a deliberate early-close lets
 * us be patient about the sale.
 */

import type { Pool } from "pg";
import type { LiquidChainCache } from "./liquidChainCache";
import { priceOption, RISK_FREE_RATE } from "./optionPricing";
import { combinedStraddleGreeks } from "../../../scripts/backtest/singleSide/coreEngine";

const DEFAULT_TP_THRESHOLD_PCT = 0.30; // suggest TAKE_PROFIT_AVAILABLE at +30% pnl
const DEFAULT_WATCH_THRESHOLD_PCT = 0.05; // suggest WATCH at +5% pnl

export type ActivePairLite = {
  pair_id: string;
  cell_id: string;
  status: string;
  spot_at_activation: number;
  trigger_down_price: number;
  trigger_up_price: number;
  hedge_cost_total_usdc: number;
  expires_at: Date;
  created_at: Date;
  put_strike: number;
  call_strike: number;
  contracts_btc: number;
  is_shadow: boolean;
};

export type PairMtm = {
  pair_id: string;
  cell_id: string;
  is_shadow: boolean;
  cost_paid_usdc: number;
  spot_at_activation: number;
  current_spot: number;
  put_strike: number;
  call_strike: number;
  contracts_btc: number;
  // Mark-to-market (what Foxify would receive if they early-closed RIGHT NOW)
  current_put_value_usdc: number;
  current_call_value_usdc: number;
  current_option_mark_usdc: number;
  estimated_salvage_usdc: number;     // after slippage haircut; what we'd actually credit
  pnl_if_close_now_usdc: number;       // estimated_salvage - cost
  pnl_pct: number;                      // pnl / cost
  // ── Venue-UI-comparable MID mark (informational; NOT used for TP) ──
  // Exchanges (e.g. Bullish/Deribit UIs) show unrealized PnL at the MID/mark
  // price. On a wide book the mid sits well above the executable bid, so the
  // venue UI looks MORE profitable than what we'd actually realize on a sale.
  // We expose both so a -$X executable read vs a +$Y venue-UI read is explained
  // by the bid-ask spread, not mistaken for a bug. The TP/close engine uses the
  // EXECUTABLE (bid) pnl above — selling a long option fills at the bid.
  current_put_mark_mid_usdc: number;     // mid-based leg mark (≈ venue UI), no haircut
  current_call_mark_mid_usdc: number;
  current_option_mark_mid_usdc: number;  // put_mid + call_mid (≈ venue UI total mark)
  pnl_if_close_now_mid_usdc: number;     // mid mark - cost (the venue-UI-comparable unrealized PnL)
  pnl_pct_mid: number;
  put_spread_pct?: number;               // bid-ask width on the put quote (null on BS fallback)
  call_spread_pct?: number;              // bid-ask width on the call quote
  mark_basis_note: string;               // explains executable-vs-mid for operators
  // ── Valuation freshness (why our line is steady while the venue UI flaps) ──
  // When a venue's own book/mark momentarily drops out (e.g. Bullish's thin ATM
  // mark blinking to 0), the venue UI's MTM jumps. We HOLD the last-good venue
  // value for a short TTL so our mark stays steady. valuation_held=true means at
  // least one leg is being held from cache this poll (not freshly priced).
  valuation_held: boolean;
  put_valuation_stabilized: boolean;
  call_valuation_stabilized: boolean;
  put_quote_age_ms?: number;             // age of the fresh put quote (null when held/BS)
  call_quote_age_ms?: number;
  // ── Exact-vs-proxy diagnostic (catches fuzzy mis-valuation) ──
  // *_symbol_held = the instrument we actually OWN; *_instrument_used = what we PRICED
  // against. If they differ (and match_tier=fuzzy_strike_tenor), the value is a PROXY
  // off a different strike/tenor — investigate why the exact bid wasn't found.
  put_symbol_held?: string | null;
  call_symbol_held?: string | null;
  put_instrument_used?: string;
  call_instrument_used?: string;
  // VALIDATION: surfaces the raw bid used per leg so operators can
  // independently verify against the live venue order book.
  put_bid_used_usdc_per_btc?: number;   // null when valuation_method='bs_fallback'
  call_bid_used_usdc_per_btc?: number;  // null when valuation_method='bs_fallback'
  put_venue?: string;                    // venue the put leg is HELD on (from the leg record)
  call_venue?: string;                   // venue the call leg is HELD on (from the leg record)
  put_valuation_venue?: string;          // venue we PRICED the put against this poll (may differ from held)
  call_valuation_venue?: string;         // venue we PRICED the call against this poll (may differ from held)
  // Valuation methodology: tells operator HOW we computed the salvage so
  // they know the accuracy level. "venue_bid" = real venue prices used.
  // "bs_fallback" = theoretical Black-Scholes (less accurate; flag in logs).
  valuation_method: "venue_bid" | "bs_fallback" | "mixed";
  put_valuation_method: "venue_bid" | "bs_fallback";
  call_valuation_method: "venue_bid" | "bs_fallback";
  // Tier of bid match — exact_symbol is most accurate, fuzzy is a proxy
  // (different expiry sharing strike) which may overstate value
  put_match_tier?: "exact_symbol" | "fuzzy_strike_tenor" | "bs_theoretical";
  call_match_tier?: "exact_symbol" | "fuzzy_strike_tenor" | "bs_theoretical";
  // Trigger geometry
  trigger_down_price: number;
  trigger_up_price: number;
  distance_to_trigger_down_pct: number; // negative = past trigger
  distance_to_trigger_up_pct: number;
  closest_trigger_pct: number;          // signed; sign matches which side is closer
  // Time
  tenor_remaining_hours: number;
  expires_at: string;
  // Operator-actionable recommendation
  recommendation: "HOLD" | "WATCH" | "TAKE_PROFIT_AVAILABLE" | "STRONG_TAKE_PROFIT" | "TRIGGERED" | "EXPIRED";
  recommendation_reason: string;
  /** Live position greeks at current spot/IV/remaining-tenor. delta/gamma per $1; vega per 1% IV; theta per day. */
  greeks: { delta: number; gamma: number; vega_per_pct: number; theta_per_day: number };
};

export type ListMtmInputs = {
  pool: Pool;
  currentSpot: number;
  ivAnnual: number;
  /**
   * Optional liquid chain cache for venue-bid lookups. When provided, MTM
   * uses ACTUAL bid prices from Bullish/Deribit for valuation (much more
   * accurate than BS). When omitted or when cache misses a strike, falls
   * back to Black-Scholes with the provided ivAnnual.
   */
  liquidChainCache?: LiquidChainCache | null;
  includeShadow?: boolean;
  pairIdFilter?: string;
  tpThresholdPct?: number;
  watchThresholdPct?: number;
  nowMs?: number;
};

const computeRecommendation = (
  pnlPct: number,
  closestTriggerPct: number,
  tenorRemainingHours: number,
  tpThresholdPct: number,
  watchThresholdPct: number
): { recommendation: PairMtm["recommendation"]; reason: string } => {
  if (tenorRemainingHours <= 0) {
    return { recommendation: "EXPIRED", reason: "tenor_elapsed" };
  }
  // closest_trigger_pct close to 0 (or negative) means already at/past trigger
  if (closestTriggerPct <= 0) {
    return { recommendation: "TRIGGERED", reason: "spot_crossed_trigger_boundary" };
  }
  if (pnlPct >= tpThresholdPct * 2) {
    return {
      recommendation: "STRONG_TAKE_PROFIT",
      reason: `pnl_pct=+${(pnlPct * 100).toFixed(0)}% well above tp_threshold=+${(tpThresholdPct * 100).toFixed(0)}%`
    };
  }
  if (pnlPct >= tpThresholdPct) {
    return {
      recommendation: "TAKE_PROFIT_AVAILABLE",
      reason: `pnl_pct=+${(pnlPct * 100).toFixed(0)}% above tp_threshold=+${(tpThresholdPct * 100).toFixed(0)}%`
    };
  }
  if (pnlPct >= watchThresholdPct) {
    return {
      recommendation: "WATCH",
      reason: `pnl_pct=+${(pnlPct * 100).toFixed(0)}% appreciating but below tp_threshold=+${(tpThresholdPct * 100).toFixed(0)}%`
    };
  }
  return {
    recommendation: "HOLD",
    reason: pnlPct >= 0
      ? `pnl_pct=+${(pnlPct * 100).toFixed(0)}% — barely positive, holding for more appreciation or trigger`
      : `pnl_pct=${(pnlPct * 100).toFixed(0)}% — option below cost, hold for move toward trigger`
  };
};

// ── MTM value stability (avoid venue_bid ↔ bs_fallback jitter) ──────────────
// When the exact-instrument bid momentarily drops out of the chain snapshot (a
// refresh race), priceOption falls back to Black-Scholes — which severely
// UNDERvalues the OTM wings (BS has no skew), making the MTM jitter (observed:
// $11.89 venue_bid → $1.27 BS for the same position seconds apart). We cache the
// last-good venue valuation per instrument for a short TTL and substitute it when
// a poll yields a BS fallback, so the mark stays stable instead of collapsing to
// the skew-blind theoretical value.
type LastGoodVenueVal = { valuePerBtc: number; rawBid?: number; midPerBtc?: number; spreadPct?: number; venue?: string; matchTier: "exact_symbol" | "fuzzy_strike_tenor"; atMs: number };
const _lastGoodVenueVal = new Map<string, LastGoodVenueVal>();
const LAST_GOOD_TTL_MS = 5 * 60_000;
/** Test hook to reset the module-level stability cache. */
export const __clearMtmStabilityCache = (): void => { _lastGoodVenueVal.clear(); };

export type LegValuation = {
  valuePerBtc: number;
  method: "venue_bid" | "bs_fallback";
  matchTier: "exact_symbol" | "fuzzy_strike_tenor" | "bs_theoretical";
  rawBidUsdcPerBtc?: number;
  /** Bid-ask MID per BTC (the venue-UI-comparable mark; null on BS fallback). */
  midPerBtc?: number;
  /** Bid-ask spread fraction at the quote (e.g. 0.25 = 25% wide). */
  spreadPct?: number;
  venue?: string;
  sourceDetail: string;
};

/**
 * Stabilize a leg valuation: cache fresh venue_bid values; when a poll yields a BS
 * fallback (exact bid missing this refresh) but a recent venue value exists, return
 * that instead of the skew-blind BS value. Pure w.r.t. the passed cache map (testable).
 */
export const stabilizeLegValuation = (
  cache: Map<string, LastGoodVenueVal>,
  key: string,
  v: LegValuation,
  nowMs: number,
  ttlMs: number = LAST_GOOD_TTL_MS
): { v: LegValuation; stabilized: boolean } => {
  if (v.method === "venue_bid" && (v.matchTier === "exact_symbol" || v.matchTier === "fuzzy_strike_tenor")) {
    cache.set(key, { valuePerBtc: v.valuePerBtc, rawBid: v.rawBidUsdcPerBtc, midPerBtc: v.midPerBtc, spreadPct: v.spreadPct, venue: v.venue, matchTier: v.matchTier, atMs: nowMs });
    return { v, stabilized: false };
  }
  const lg = cache.get(key);
  if (lg && nowMs - lg.atMs <= ttlMs) {
    const ageS = Math.round((nowMs - lg.atMs) / 1000);
    return {
      v: {
        valuePerBtc: lg.valuePerBtc,
        method: "venue_bid",
        matchTier: lg.matchTier,
        rawBidUsdcPerBtc: lg.rawBid,
        midPerBtc: lg.midPerBtc,
        spreadPct: lg.spreadPct,
        venue: lg.venue,
        sourceDetail: `last_good_venue_bid (${ageS}s old — exact bid missing this refresh; held to avoid BS-undervaluation jitter on the OTM wings)`
      },
      stabilized: true
    };
  }
  return { v, stabilized: false };
};

/**
 * Load all active pairs (joined with their put + call leg strikes), compute
 * MTM for each. Pure function — no I/O beyond the DB read.
 */
export const listActivePairMtm = async (inputs: ListMtmInputs): Promise<PairMtm[]> => {
  const now = inputs.nowMs ?? Date.now();
  const tpThresholdPct = inputs.tpThresholdPct ?? DEFAULT_TP_THRESHOLD_PCT;
  const watchThresholdPct = inputs.watchThresholdPct ?? DEFAULT_WATCH_THRESHOLD_PCT;
  const includeShadow = inputs.includeShadow !== false;

  // Pull active pairs joined with leg strikes
  const params: unknown[] = [];
  const conds: string[] = ["p.status = 'active'"];
  if (!includeShadow) {
    conds.push(`p.is_shadow = FALSE`);
  }
  if (inputs.pairIdFilter) {
    params.push(inputs.pairIdFilter);
    conds.push(`p.pair_id = $${params.length}`);
  }
  // No SQL ::float8 casts — pg-mem doesn't support them and Postgres
  // numeric → JS number conversion at the pg driver level works fine
  // for the magnitudes we deal with. We Number() everything below.
  const sql = `
    SELECT
      p.pair_id,
      p.cell_id,
      p.status,
      p.spot_at_activation,
      p.trigger_down_price,
      p.trigger_up_price,
      p.hedge_cost_total_usdc,
      p.expires_at,
      p.created_at,
      p.is_shadow,
      MAX(CASE WHEN l.leg_role IN ('long_put', 'put') THEN l.strike_usdc ELSE NULL END) AS put_strike,
      MAX(CASE WHEN l.leg_role IN ('long_call', 'call') THEN l.strike_usdc ELSE NULL END) AS call_strike,
      MAX(CASE WHEN l.leg_role IN ('long_put', 'put') THEN l.venue ELSE NULL END) AS put_venue,
      MAX(CASE WHEN l.leg_role IN ('long_call', 'call') THEN l.venue ELSE NULL END) AS call_venue,
      MAX(CASE WHEN l.leg_role IN ('long_put', 'put') THEN l.symbol ELSE NULL END) AS put_symbol,
      MAX(CASE WHEN l.leg_role IN ('long_call', 'call') THEN l.symbol ELSE NULL END) AS call_symbol,
      MAX(l.contracts_btc) AS contracts_btc
    FROM two_sided_pair p
    LEFT JOIN two_sided_pair_leg l ON p.pair_id = l.pair_id
    WHERE ${conds.join(" AND ")}
    GROUP BY p.pair_id, p.cell_id, p.status, p.spot_at_activation, p.trigger_down_price,
             p.trigger_up_price, p.hedge_cost_total_usdc, p.expires_at, p.created_at, p.is_shadow
    ORDER BY p.created_at DESC
  `;
  const result = await inputs.pool.query<ActivePairLite & { put_venue: string | null; call_venue: string | null; put_symbol: string | null; call_symbol: string | null }>(sql, params);

  /**
   * Value ONE leg using the unified pricing primitive (priceOption).
   *
   * Delegates 100% of the cascade decision (exact → fuzzy → bs) to optionPricing
   * so MTM, ShadowCloseExecutor, runtime TP loop, and EV all use the same logic.
   * This eliminates the previous bug where each component had its own slightly
   * different fallback rules producing inconsistent values.
   */
  const valueLeg = (leg: {
    side: "put" | "call";
    strike: number;
    contracts: number;
    tenorRemainingHours: number;
    preferVenue: "deribit" | "bullish" | null;
    instrumentSymbol: string | null;
  }): {
    valueTotal: number;
    perBtc: number;
    midPerBtc?: number;
    spreadPct?: number;
    method: "venue_bid" | "bs_fallback";
    matchTier: "exact_symbol" | "fuzzy_strike_tenor" | "bs_theoretical";
    sourceDetail: string;
    rawBidUsdcPerBtc?: number;
    venue?: string;
    /** True when this poll's value was HELD from the last-good cache (exact bid
     *  missing this refresh) instead of freshly priced — explains a steady line
     *  while the venue's own book/mark is flapping. */
    stabilized: boolean;
    /** Age (ms) of the fresh venue quote used this poll (null when stabilized/BS). */
    quoteAgeMs?: number;
    /** The instrument symbol we actually PRICED against this poll. When this differs
     *  from the held symbol, the value came from a fuzzy PROXY (different strike/tenor)
     *  — a key accuracy red flag for both MTM and TP. */
    instrumentUsed?: string;
  } => {
    const result = priceOption({
      spot: inputs.currentSpot,
      strike: leg.strike,
      optType: leg.side,
      tenorRemainingMs: leg.tenorRemainingHours * 3_600_000,
      contractsBtc: leg.contracts,
      venue: leg.preferVenue,
      instrumentSymbol: leg.instrumentSymbol,
      liquidChainCache: inputs.liquidChainCache ?? null,
      ivAnnualOverride: inputs.ivAnnual,
      purpose: "mtm",
      nowMs: inputs.nowMs
    });
    const method: "venue_bid" | "bs_fallback" =
      result.source === "bs_only" ? "bs_fallback" : "venue_bid";
    const matchTier: "exact_symbol" | "fuzzy_strike_tenor" | "bs_theoretical" =
      result.source === "exact_symbol" ? "exact_symbol"
        : result.source === "fuzzy_strike_tenor" ? "fuzzy_strike_tenor"
        : "bs_theoretical";
    const sourceDetail = result.source === "bs_only"
      ? `bs(iv=${(result.iv_used * 100).toFixed(1)}%/${result.iv_source}) haircut=${(result.haircut_applied * 100).toFixed(0)}%`
      : `${result.venue_used}:${result.source} ${result.instrument_used} bid=${result.bid_per_btc?.toFixed(2)}USD haircut=${(result.haircut_applied * 100).toFixed(0)}%`;
    // Stabilize: if this poll fell back to BS but we have a recent venue value for
    // this exact instrument, hold the last-good venue value (avoids the wing jitter).
    const key = leg.instrumentSymbol ?? `${leg.side}:${leg.strike}`;
    const { v: stable, stabilized } = stabilizeLegValuation(
      _lastGoodVenueVal,
      key,
      { valuePerBtc: result.primary_value_per_btc, method, matchTier, rawBidUsdcPerBtc: result.bid_per_btc ?? undefined, midPerBtc: result.mid_per_btc ?? undefined, spreadPct: result.spread_pct ?? undefined, venue: result.venue_used ?? undefined, sourceDetail },
      now
    );
    return {
      valueTotal: stable.valuePerBtc * leg.contracts,
      perBtc: stable.valuePerBtc,
      midPerBtc: stable.midPerBtc,
      spreadPct: stable.spreadPct,
      method: stable.method,
      matchTier: stable.matchTier,
      sourceDetail: stable.sourceDetail,
      rawBidUsdcPerBtc: stable.rawBidUsdcPerBtc,
      venue: stable.venue,
      stabilized,
      quoteAgeMs: result.age_ms ?? undefined,
      instrumentUsed: result.instrument_used ?? undefined
    };
  };

  const out: PairMtm[] = [];
  for (const r of result.rows) {
    const expiresAt = new Date(r.expires_at);
    const putStrike = Number(r.put_strike);
    const callStrike = Number(r.call_strike);
    const contracts = Number(r.contracts_btc);
    const putVenue = (r.put_venue as "deribit" | "bullish" | null) ?? null;
    const callVenue = (r.call_venue as "deribit" | "bullish" | null) ?? null;
    const putSymbol = (r.put_symbol as string | null) ?? null;
    const callSymbol = (r.call_symbol as string | null) ?? null;

    if (!Number.isFinite(putStrike) || !Number.isFinite(callStrike) || !Number.isFinite(contracts) || contracts <= 0) {
      continue;
    }

    const tenorRemainingHours = Math.max(0, (expiresAt.getTime() - now) / 3_600_000);

    const putV = valueLeg({ side: "put", strike: putStrike, contracts, tenorRemainingHours, preferVenue: putVenue, instrumentSymbol: putSymbol });
    const callV = valueLeg({ side: "call", strike: callStrike, contracts, tenorRemainingHours, preferVenue: callVenue, instrumentSymbol: callSymbol });

    const putValueTotal = putV.valueTotal;
    const callValueTotal = callV.valueTotal;
    const optionMark = putValueTotal + callValueTotal;
    // Values are already post-haircut per-leg, so mark == salvage estimate
    const estimatedSalvage = optionMark;
    const cost = Number(r.hedge_cost_total_usdc);
    const pnlAbs = estimatedSalvage - cost;
    const pnlPct = cost > 0 ? pnlAbs / cost : 0;

    // Venue-UI-comparable MID mark. Fall back to the executable per-leg value when
    // a mid isn't available (BS fallback) so the totals stay coherent.
    const putMidTotal = (putV.midPerBtc ?? putV.perBtc) * contracts;
    const callMidTotal = (callV.midPerBtc ?? callV.perBtc) * contracts;
    const optionMarkMid = putMidTotal + callMidTotal;
    const pnlMidAbs = optionMarkMid - cost;
    const pnlMidPct = cost > 0 ? pnlMidAbs / cost : 0;

    const overallMethod: "venue_bid" | "bs_fallback" | "mixed" =
      putV.method === callV.method ? putV.method : "mixed";

    const distDown = (inputs.currentSpot - Number(r.trigger_down_price)) / inputs.currentSpot;
    const distUp = (Number(r.trigger_up_price) - inputs.currentSpot) / inputs.currentSpot;
    const closestTriggerPct = Math.min(distDown, distUp);

    const rec = computeRecommendation(pnlPct, closestTriggerPct, tenorRemainingHours, tpThresholdPct, watchThresholdPct);

    out.push({
      pair_id: r.pair_id,
      cell_id: r.cell_id,
      is_shadow: r.is_shadow,
      cost_paid_usdc: cost,
      spot_at_activation: Number(r.spot_at_activation),
      current_spot: inputs.currentSpot,
      put_strike: putStrike,
      call_strike: callStrike,
      contracts_btc: contracts,
      current_put_value_usdc: putValueTotal,
      current_call_value_usdc: callValueTotal,
      current_option_mark_usdc: optionMark,
      estimated_salvage_usdc: estimatedSalvage,
      current_put_mark_mid_usdc: putMidTotal,
      current_call_mark_mid_usdc: callMidTotal,
      current_option_mark_mid_usdc: optionMarkMid,
      pnl_if_close_now_mid_usdc: pnlMidAbs,
      pnl_pct_mid: pnlMidPct,
      put_spread_pct: putV.spreadPct,
      call_spread_pct: callV.spreadPct,
      valuation_held: putV.stabilized || callV.stabilized,
      put_valuation_stabilized: putV.stabilized,
      call_valuation_stabilized: callV.stabilized,
      put_quote_age_ms: putV.quoteAgeMs,
      call_quote_age_ms: callV.quoteAgeMs,
      put_symbol_held: putSymbol,
      call_symbol_held: callSymbol,
      put_instrument_used: putV.instrumentUsed,
      call_instrument_used: callV.instrumentUsed,
      mark_basis_note:
        "pnl_if_close_now_usdc is the EXECUTABLE (bid×haircut) value — what you'd actually receive selling now, and the basis for TP/close. pnl_if_close_now_mid_usdc is the MID mark (≈ exchange UI unrealized PnL); the gap is the bid-ask spread (see *_spread_pct).",
      greeks: combinedStraddleGreeks(inputs.currentSpot, putStrike, callStrike, contracts, tenorRemainingHours / 24 / 365, RISK_FREE_RATE, inputs.ivAnnual ?? 0.35),
      pnl_if_close_now_usdc: pnlAbs,
      pnl_pct: pnlPct,
      valuation_method: overallMethod,
      put_valuation_method: putV.method,
      call_valuation_method: callV.method,
      put_bid_used_usdc_per_btc: putV.rawBidUsdcPerBtc,
      call_bid_used_usdc_per_btc: callV.rawBidUsdcPerBtc,
      // put_venue/call_venue = where the position is HELD (from the leg record) — the truthful
      // answer to "what venue is this on". Falls back to the valuation venue only if the leg
      // venue is somehow missing. The venue we PRICED against this poll (which can differ when
      // the held strike isn't currently quoted on the held venue) is put/call_valuation_venue.
      // (Previously put_venue reported the valuation venue, which falsely looked like the
      //  position had "moved" to Deribit when Bullish stopped quoting the strike — see 2026-06-02.)
      put_venue: putVenue ?? putV.venue,
      call_venue: callVenue ?? callV.venue,
      put_valuation_venue: putV.venue,
      call_valuation_venue: callV.venue,
      put_match_tier: putV.matchTier,
      call_match_tier: callV.matchTier,
      trigger_down_price: Number(r.trigger_down_price),
      trigger_up_price: Number(r.trigger_up_price),
      distance_to_trigger_down_pct: distDown,
      distance_to_trigger_up_pct: distUp,
      closest_trigger_pct: closestTriggerPct,
      tenor_remaining_hours: tenorRemainingHours,
      expires_at: expiresAt.toISOString(),
      recommendation: rec.recommendation,
      recommendation_reason: rec.reason
    });
  }
  return out;
};

export type MtmSummary = {
  as_of: string;
  current_spot: number;
  iv_annual: number;
  tp_threshold_pct: number;
  watch_threshold_pct: number;
  total_active: number;
  by_recommendation: Record<string, number>;
  by_valuation_method: Record<string, number>;
  total_cost_paid_usdc: number;
  total_estimated_salvage_usdc: number;
  total_pnl_if_close_all_now_usdc: number;
  /** Venue-UI-comparable MID totals (informational; TP uses the executable totals above). */
  total_estimated_mark_mid_usdc: number;
  total_pnl_if_close_all_now_mid_usdc: number;
  pairs: PairMtm[];
};

export const summarizeMtm = (
  pairs: PairMtm[],
  meta: { currentSpot: number; ivAnnual: number; tpThresholdPct: number; watchThresholdPct: number; nowMs: number }
): MtmSummary => {
  const byRec: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  let totalCost = 0;
  let totalSalv = 0;
  let totalMid = 0;
  for (const p of pairs) {
    byRec[p.recommendation] = (byRec[p.recommendation] ?? 0) + 1;
    byMethod[p.valuation_method] = (byMethod[p.valuation_method] ?? 0) + 1;
    totalCost += p.cost_paid_usdc;
    totalSalv += p.estimated_salvage_usdc;
    totalMid += p.current_option_mark_mid_usdc;
  }
  return {
    as_of: new Date(meta.nowMs).toISOString(),
    current_spot: meta.currentSpot,
    iv_annual: meta.ivAnnual,
    tp_threshold_pct: meta.tpThresholdPct,
    watch_threshold_pct: meta.watchThresholdPct,
    total_active: pairs.length,
    by_recommendation: byRec,
    by_valuation_method: byMethod,
    total_cost_paid_usdc: totalCost,
    total_estimated_salvage_usdc: totalSalv,
    total_pnl_if_close_all_now_usdc: totalSalv - totalCost,
    total_estimated_mark_mid_usdc: totalMid,
    total_pnl_if_close_all_now_mid_usdc: totalMid - totalCost,
    pairs
  };
};
