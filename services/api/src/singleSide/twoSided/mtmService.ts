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
import { bsCall, bsPut } from "../../pilot/blackScholes";
import type { LiquidChainCache } from "./liquidChainCache";

const DEFAULT_RFR = 0.045;
// Bid-based salvage: bid is what we'd ACTUALLY receive on a market sell.
// 5% haircut accounts for fill slippage from bid (rare moves between quote
// fetch and actual fill, plus IOC limit-order semantics).
const BID_BASED_HAIRCUT = 0.95;
// BS-based fallback haircut: when we can't find a venue bid (cache miss,
// stale snapshot, illiquid strike), fall back to BS valuation. Apply a
// LARGER haircut because BS uses market-wide IV that overstates value
// for OTM/ITM strikes due to vol skew.
const BS_FALLBACK_HAIRCUT = 0.70;
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
  // Valuation methodology: tells operator HOW we computed the salvage so
  // they know the accuracy level. "venue_bid" = real venue prices used.
  // "bs_fallback" = theoretical Black-Scholes (less accurate; flag in logs).
  valuation_method: "venue_bid" | "bs_fallback" | "mixed";
  put_valuation_method: "venue_bid" | "bs_fallback";
  call_valuation_method: "venue_bid" | "bs_fallback";
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
      MAX(l.contracts_btc) AS contracts_btc
    FROM two_sided_pair p
    LEFT JOIN two_sided_pair_leg l ON p.pair_id = l.pair_id
    WHERE ${conds.join(" AND ")}
    GROUP BY p.pair_id, p.cell_id, p.status, p.spot_at_activation, p.trigger_down_price,
             p.trigger_up_price, p.hedge_cost_total_usdc, p.expires_at, p.created_at, p.is_shadow
    ORDER BY p.created_at DESC
  `;
  const result = await inputs.pool.query<ActivePairLite & { put_venue: string | null; call_venue: string | null }>(sql, params);

  /**
   * Value ONE leg using the cache's bid if available, else BS.
   * The cache lookup uses preferVenue (the venue we ACTUALLY bought on)
   * so we get the bid from the same venue we'd be selling to.
   */
  const valueLeg = (leg: {
    side: "put" | "call";
    strike: number;
    contracts: number;
    tenorRemainingHours: number;
    preferVenue: "deribit" | "bullish" | null;
  }): { valueTotal: number; perBtc: number; method: "venue_bid" | "bs_fallback"; sourceDetail: string } => {
    if (inputs.liquidChainCache) {
      const bid = inputs.liquidChainCache.getBidForLeg({
        strike: leg.strike,
        optType: leg.side,
        tenorRemainingHours: leg.tenorRemainingHours,
        preferVenue: leg.preferVenue ?? undefined
      });
      if (bid) {
        const perBtc = bid.bidUsdcPerBtc * BID_BASED_HAIRCUT;
        return {
          valueTotal: perBtc * leg.contracts,
          perBtc,
          method: "venue_bid",
          sourceDetail: `${bid.venue}:bid=${bid.bidUsdcPerBtc.toFixed(2)}USD haircut=${(BID_BASED_HAIRCUT * 100).toFixed(0)}%`
        };
      }
    }
    // BS fallback (less accurate due to vol skew vs index IV)
    const T = leg.tenorRemainingHours / (24 * 365);
    const raw = leg.side === "put"
      ? Math.max(0, bsPut(inputs.currentSpot, leg.strike, T, DEFAULT_RFR, inputs.ivAnnual))
      : Math.max(0, bsCall(inputs.currentSpot, leg.strike, T, DEFAULT_RFR, inputs.ivAnnual));
    const perBtc = raw * BS_FALLBACK_HAIRCUT;
    return {
      valueTotal: perBtc * leg.contracts,
      perBtc,
      method: "bs_fallback",
      sourceDetail: `bs(iv=${(inputs.ivAnnual * 100).toFixed(1)}%) haircut=${(BS_FALLBACK_HAIRCUT * 100).toFixed(0)}%`
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

    if (!Number.isFinite(putStrike) || !Number.isFinite(callStrike) || !Number.isFinite(contracts) || contracts <= 0) {
      continue;
    }

    const tenorRemainingHours = Math.max(0, (expiresAt.getTime() - now) / 3_600_000);

    const putV = valueLeg({ side: "put", strike: putStrike, contracts, tenorRemainingHours, preferVenue: putVenue });
    const callV = valueLeg({ side: "call", strike: callStrike, contracts, tenorRemainingHours, preferVenue: callVenue });

    const putValueTotal = putV.valueTotal;
    const callValueTotal = callV.valueTotal;
    const optionMark = putValueTotal + callValueTotal;
    // Values are already post-haircut per-leg, so mark == salvage estimate
    const estimatedSalvage = optionMark;
    const cost = Number(r.hedge_cost_total_usdc);
    const pnlAbs = estimatedSalvage - cost;
    const pnlPct = cost > 0 ? pnlAbs / cost : 0;

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
      pnl_if_close_now_usdc: pnlAbs,
      pnl_pct: pnlPct,
      valuation_method: overallMethod,
      put_valuation_method: putV.method,
      call_valuation_method: callV.method,
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
  for (const p of pairs) {
    byRec[p.recommendation] = (byRec[p.recommendation] ?? 0) + 1;
    byMethod[p.valuation_method] = (byMethod[p.valuation_method] ?? 0) + 1;
    totalCost += p.cost_paid_usdc;
    totalSalv += p.estimated_salvage_usdc;
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
    pairs
  };
};
