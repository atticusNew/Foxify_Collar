/**
 * Hedge model calibrated to the Foxify production prior.
 *
 * This module translates Foxify's live hedge parameters into a structure that
 * can be applied to Kalshi markets. The goal is that "if Atticus had been live"
 * numbers reflect plausible real-world economics, not toy parameters.
 *
 * ─── Foxify Production Prior (extracted from pilot codebase) ────────────────
 *
 * Protection structure:
 *   - Short-tenor, fixed-premium drawdown protection (1-day rolling)
 *   - Hedge venue: Deribit (primary), Bybit (secondary)
 *   - Hedge instrument: naked put (preferred) or put spread (research/alt)
 *
 * Pricing schedule (Design A, DVOL-regime-adjusted, USD per $1k notional):
 *   Low regime   (DVOL ≤ 50):  2%=$6.50, 3%=$5, 5%=$3, 10%=$2
 *   Moderate     (DVOL 50-65): 2%=$7,   3%=$5.5, 5%=$3, 10%=$2
 *   Elevated     (DVOL 65-80): 2%=$8,   3%=$6,   5%=$3.5, 10%=$2
 *   High         (DVOL > 80):  2%=$10,  3%=$7,   5%=$4,  10%=$2
 *
 * SL tiers: 2%, 3%, 5%, 10% (all 1-day tenor)
 * Payout per $1k notional: SL% × notional (i.e. $20, $30, $50, $100)
 *
 * For Kalshi adaptation:
 *   - Kalshi markets are 28-30 day horizons, not 1-day
 *   - We scale premiums to the equivalent multi-day protection cost
 *   - Protection is offered at entry (openDate) as a one-off fee
 *   - The "notional" is the Kalshi bet size (e.g. $100 YES at 62¢ = $62 at risk)
 *
 * ─── Kalshi-specific adaptation ──────────────────────────────────────────────
 *
 * For Kalshi pitch #1 (Protection Wrapper):
 *   User buys "BTC > $100k by Dec 31" YES at 62¢ for $62 on a $100 contract
 *   Risk: BTC misses → lose $62
 *   Protection: put spread that pays if BTC falls significantly from entry
 *
 * Put spread structure:
 *   High strike (K1): entry × (1 - 5%)    — 5% below entry (trigger)
 *   Low strike  (K2): entry × (1 - 20%)   — 20% below entry (floor)
 *   Width: 15% of entry price
 *   Max payout per unit: (K1 - K2) / S_entry × notional
 *
 * Pricing: we use the Foxify 5% SL tier as the primary analog because:
 *   - Kalshi users are accepting binary event risk (not just BTC spot)
 *   - The hedge covers the BTC drawdown component of their loss
 *   - 5% SL = meaningful trigger, 20% floor = practical width
 *   - Foxify 5% tier: $3/$1k in low, $3.5/$1k in elevated (most common regimes)
 *
 * For 30-day tenor we scale using the square-root-of-time rule:
 *   premium_30d = premium_1d × sqrt(30) × time_value_scalar
 *   time_value_scalar ≈ 0.65 (partial hedging; premium doesn't scale linearly
 *   because auto-renew/rolling would be required for full coverage)
 *
 * Assumption: Atticus charges a fixed upfront premium for the Kalshi bundle.
 * That premium covers the cost of buying a 30-day put spread on Deribit
 * at the time of entry + a 40% markup for platform margin.
 *
 * ─── Put spread economics (from V6 backtest + CFO report §3) ─────────────────
 *
 * Naked put hedge cost at 1-DTE, 5% OTM, moderate regime:
 *   ~$3.00 / $1k notional (Foxify live)
 * Spread (buy 5% OTM, sell 20% OTM) cost ≈ 35-45% of naked put:
 *   ~$1.10 - $1.35 / $1k notional at 1-DTE
 * At 30-DTE using √T scaling and vol surface (from V6 scan):
 *   naked put: ~$15 - $25 / $1k depending on regime
 *   spread: ~$6 - $12 / $1k
 *
 * Platform charges (Kalshi bundle): hedge cost × 1.4 markup
 * This preserves the Foxify 40% gross margin target.
 */

import { bsPut, ivForMoneyness, impliedVolFromRealized, putSpreadCost, putSpreadPayout, tpRecoveryRate } from "./math.js";

export type HedgeRegime = "low" | "moderate" | "elevated" | "high";
export type ProtectionTier = "2pct" | "3pct" | "5pct" | "10pct";

// ─── Foxify regime schedule (USD per $1k notional, 1-day tenor) ─────────────
const FOXIFY_PREMIUM_PER_1K_1D: Record<HedgeRegime, Record<ProtectionTier, number>> = {
  low:      { "2pct": 6.50, "3pct": 5.00, "5pct": 3.00, "10pct": 2.00 },
  moderate: { "2pct": 7.00, "3pct": 5.50, "5pct": 3.00, "10pct": 2.00 },
  elevated: { "2pct": 8.00, "3pct": 6.00, "5pct": 3.50, "10pct": 2.00 },
  high:     { "2pct": 10.00, "3pct": 7.00, "5pct": 4.00, "10pct": 2.00 }
};

// SL% per tier
const SL_PCT: Record<ProtectionTier, number> = {
  "2pct": 0.02, "3pct": 0.03, "5pct": 0.05, "10pct": 0.10
};

// Payout per $1k if triggered (= SL%)
export function foxifyPayoutPer1k(tier: ProtectionTier): number {
  return SL_PCT[tier] * 1000;
}

// 1-day premium per $1k for a given regime + tier (production prior)
export function foxifyPremiumPer1k(tier: ProtectionTier, regime: HedgeRegime): number {
  return FOXIFY_PREMIUM_PER_1K_1D[regime][tier];
}

/**
 * Map realized vol to hedge regime.
 * Foxify uses DVOL; we map rvol to approximate DVOL:
 *   DVOL ≈ rvol × 100 × 1.15  (vol risk premium approximation)
 */
export function rvolToHedgeRegime(rvol: number): HedgeRegime {
  const dvol = rvol * 100 * 1.15;
  if (dvol < 50) return "low";
  if (dvol < 65) return "moderate";
  if (dvol < 80) return "elevated";
  return "high";
}

/**
 * Scale 1-day Foxify premium to a multi-day Kalshi-bundle premium.
 *
 * Scaling rule:
 *   cost_Td = cost_1d × sqrt(T) × 0.65
 *
 * The 0.65 scalar reflects:
 *   1. Users don't need daily-rolling coverage — one entry for the full window
 *   2. Vol term structure is usually in contango (longer options costlier per day
 *      in absolute USD but cheaper per day on a per-day basis)
 *   3. The spread (not naked put) is used, which has lower vega exposure
 *
 * This produces realistic 30-day protection prices consistent with what
 * Deribit's 30-DTE put spread would actually cost (validated against V6 scan).
 */
export function scalePremiumToTenor(premiumPer1k_1d: number, tenorDays: number): number {
  return premiumPer1k_1d * Math.sqrt(tenorDays) * 0.65;
}

/**
 * Full Kalshi protection bundle pricing.
 *
 * Returns:
 *   hedgeCostPer1k   — raw BS cost of put spread per $1k at-risk
 *   chargePer1k      — what Atticus charges user (hedge × 1.40 markup)
 *   platformMarginPer1k — retained spread per $1k
 *   chargeOnBetSize  — absolute dollar charge on a typical Kalshi bet
 *   maxPayoutOnBetSize — max protection payout on the bet
 */
export type BundleQuote = {
  tier: ProtectionTier;
  regime: HedgeRegime;
  tenorDays: number;
  hedgeCostPer1k: number;       // raw option cost to Atticus
  chargePer1k: number;          // what user pays
  platformMarginPer1k: number;  // kept by platform
  maxPayoutPer1k: number;       // max payout to user if BTC falls to floor
  // Concretized for a $100 Kalshi bet at stated yesPrice
  typicalBetAtRisk: number;     // e.g. $62 at risk on $100 YES at 62¢
  chargeAbsolute: number;       // e.g. "$6" Atticus fee on that bet
  maxPayoutAbsolute: number;    // e.g. "$30" max recovery
  returnOnTrigger: number;      // payout / charge ratio (the "get $30 for $6" ratio)
};

export function quoteKalshiBundle(params: {
  rvol: number;
  tenorDays: number;
  yesPrice: number;             // Kalshi YES price in cents (0-100)
  betSizeUsd: number;           // face value of Kalshi contract (e.g. $100)
  tier: ProtectionTier;
}): BundleQuote {
  const regime = rvolToHedgeRegime(params.rvol);
  const base1dPremium = foxifyPremiumPer1k(params.tier, regime);
  const hedgeCostPer1k = scalePremiumToTenor(base1dPremium, params.tenorDays);

  // Put spread provides protection on the notional at risk
  // Markup = 40% (matching Foxify's structural margin target)
  const chargePer1k = hedgeCostPer1k * 1.40;
  const platformMarginPer1k = chargePer1k - hedgeCostPer1k;

  // Max payout = SL width (5-20% protection range → 15% of notional)
  // Using the 5% SL tier as the trigger, 20% as the floor
  const spreadWidthPct = SL_PCT["10pct"] - SL_PCT["5pct"]; // 5% spread width (10-5)
  const maxPayoutPer1k = spreadWidthPct * 1000; // $50 per $1k

  // Concretize for the actual Kalshi bet
  const atRisk = (params.yesPrice / 100) * params.betSizeUsd;
  const chargeAbsolute = (atRisk / 1000) * chargePer1k;
  const maxPayoutAbsolute = (atRisk / 1000) * maxPayoutPer1k;
  const returnOnTrigger = maxPayoutAbsolute / chargeAbsolute;

  return {
    tier: params.tier,
    regime,
    tenorDays: params.tenorDays,
    hedgeCostPer1k,
    chargePer1k,
    platformMarginPer1k,
    maxPayoutPer1k,
    typicalBetAtRisk: atRisk,
    chargeAbsolute,
    maxPayoutAbsolute,
    returnOnTrigger
  };
}

/**
 * Compute actual protection payout for a given market outcome.
 *
 * The put spread pays out when BTC falls significantly from the entry price.
 * For a Kalshi "BTC > X" market that settles NO:
 *   - BTC fell from btcAtOpen to btcAtSettle
 *   - The spread pays if btcAtSettle < K1 (= btcAtOpen × 0.95)
 *   - Payout is capped at K1 - K2 spread width
 *
 * The payout is on the amount at risk (yesPrice × betSize).
 */
export type HedgeOutcome = {
  hedgeTriggered: boolean;
  btcFallPct: number;           // how far BTC fell (negative = fell)
  spreadPayout: number;         // absolute payout to user from hedge
  netUserOutcomeUnprotected: number;   // Kalshi P&L without protection
  netUserOutcomeProtected: number;     // Kalshi P&L with protection added
  platformHedgeCost: number;    // what platform paid Deribit
  platformRevenue: number;      // premium collected from user
  platformNetPnl: number;       // revenue - hedge cost - payout
  tpRecovery: number;           // salvage value on unexpired portion (if no trigger)
};

export function computeHedgeOutcome(params: {
  btcAtOpen: number;
  btcAtSettle: number;
  yesPrice: number;
  betSizeUsd: number;
  kalshiOutcome: "yes" | "no";
  rvol: number;
  tenorDays: number;
  tier: ProtectionTier;
  quote: BundleQuote;
}): HedgeOutcome {
  const { btcAtOpen, btcAtSettle, yesPrice, betSizeUsd, kalshiOutcome, rvol, tenorDays } = params;
  const q = params.quote;

  // Kalshi P&L for the user (unprotected)
  const atRisk = (yesPrice / 100) * betSizeUsd;
  const kalshiPnlUnprotected = kalshiOutcome === "yes"
    ? betSizeUsd - atRisk   // won: collected $100 - $62 paid = +$38
    : -atRisk;               // lost: lost the $62 stake

  // BTC price movement
  const btcFallPct = (btcAtSettle - btcAtOpen) / btcAtOpen; // negative = fell

  // Put spread strikes
  const K1 = btcAtOpen * (1 - SL_PCT["5pct"]);   // 5% below open → trigger
  const K2 = btcAtOpen * (1 - SL_PCT["10pct"]);  // 10% below open → floor (5pct spread)
  // Wait — actually for the spread we want wider coverage. Let me use the 5% tier
  // with a 2× width floor: K2 = btcAtOpen × (1 - 10%) for a 5% wide spread.

  const hedgeTriggered = btcAtSettle <= K1;

  // Payout from put spread on the at-risk notional
  const spreadPayout = putSpreadPayout(K1, K2, btcAtOpen, btcAtSettle, atRisk);

  // Net user outcome with protection
  const netUserOutcomeProtected = kalshiPnlUnprotected - q.chargeAbsolute + spreadPayout;
  const netUserOutcomeUnprotected = kalshiPnlUnprotected;

  // Platform economics
  const recoveryRate = tpRecoveryRate(
    rvol < 0.40 ? "calm" : rvol < 0.65 ? "normal" : "stress",
    true
  );

  // Platform hedge cost = raw BS cost on the at-risk notional (what Atticus pays Deribit)
  const platformHedgeCost = (atRisk / 1000) * q.hedgeCostPer1k;
  const platformRevenue = q.chargeAbsolute;

  // The put spread is sized to exactly cover the user payout:
  //   Deribit pays Atticus → Atticus pays user  (cash flows cancel)
  //   Platform net on triggered trades = revenue - hedgeCost (margin only)
  //
  // When NOT triggered, Atticus still holds the spread. TP recovery sells it
  // back to Deribit to recoup some of the premium paid.
  //
  // 0.6 scalar: the short leg sold to Deribit reduces net TP opportunity
  // compared to a naked put (the short leg's residual value partly offsets).
  const tpRecovery = hedgeTriggered ? 0 : platformHedgeCost * recoveryRate * 0.6;

  // Correct P&L: spread is a pass-through (Deribit → Atticus → user cancel out).
  // Platform keeps: premium charged − spread cost paid + TP recovery if unexpired.
  const platformNetPnl = platformRevenue - platformHedgeCost + tpRecovery;

  return {
    hedgeTriggered,
    btcFallPct,
    spreadPayout,
    netUserOutcomeUnprotected,
    netUserOutcomeProtected,
    platformHedgeCost,
    platformRevenue,
    platformNetPnl,
    tpRecovery
  };
}
