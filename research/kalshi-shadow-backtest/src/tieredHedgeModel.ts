/**
 * Tiered hedge model for the Kalshi shadow backtest (v2).
 *
 * RELATIONSHIP TO v1:
 *   - v1 = src/hedgeModel.ts  (Foxify-tier-scaled, single tier, 5% trigger / 5% width)
 *   - v2 = src/tieredHedgeModel.ts  (this file: direct BS pricing, two tiers,
 *           configurable strike geometry, calibrated to "feel like real money")
 *
 * v1 stays untouched — both versions can be run independently.
 *
 * GOAL (per the project brief):
 *   Two protection tiers (Lite, Standard) targeting:
 *
 *     Lite:     fee ≈ 5–7% of stake,  recovery ≈ 20–30% of loss in bad states.
 *     Standard: fee ≈ 10–15% of stake, recovery ≈ 40–60% of loss in bad states.
 *
 *   Pricing is solved "backwards": choose strike geometry such that the
 *   raw 30-day BTC put spread cost (priced via Black-Scholes on the actual
 *   strikes), markup-included, lands in the target fee band. Then verify
 *   recovery numbers in losing markets.
 *
 *   Profitability rails:
 *     - Markup 1.4× (Lite) / 1.5× (Standard) — preserves Foxify-like margin.
 *     - Spread is fully hedged on Deribit (Atticus does not warehouse).
 *     - Platform retains markup minus hedge cost ± TP salvage on un-triggered.
 *
 * ISOLATION:
 *   Imports only from ./math.js (math primitives) — same as v1.
 *   No imports from services/api, services/hedging, or anything in the live
 *   Foxify pilot. Cannot affect the pilot.
 */

import {
  bsPut,
  impliedVolFromRealized,
  ivForMoneyness,
  putSpreadPayout,
  tpRecoveryRate,
  classifyRegime,
} from "./math.js";

// ─── Tier configuration ──────────────────────────────────────────────────────
// Single source of truth for tier strike geometry & markup. Re-tuning happens
// here only — main script reads this config.

export type TierName = "lite" | "standard";

export type TierConfig = {
  /** Long-put strike as fraction below entry (e.g. 0.02 = 2% OTM). 0 = ATM. */
  longOtmPct: number;
  /** Short-put strike as fraction below entry (e.g. 0.18 = 18% OTM). */
  shortOtmPct: number;
  /** Markup applied to raw hedge cost to get the user-facing charge. */
  markup: number;
  /** Risk-free rate assumption for BS (annualised). */
  riskFreeRate: number;
  /**
   * Sizing multiplier on the protected notional, expressed as a multiple of
   * the at-risk amount. 1.0 = "1:1 hedge" (Foxify-default). 1.5 = "buy a put
   * spread on 1.5× the at-risk amount" — costs ~1.5× the raw hedge but pays
   * ~1.5× more per percent of BTC drop. Use this to lift recovery into the
   * brief's target bands without forcing wider strikes (which add cost
   * non-linearly).
   */
  sizingMultiplier: number;
};

export const TIER_CONFIGS: Record<TierName, TierConfig> = {
  // Lite — close-to-ATM long leg so even small (3-5%) BTC dips contribute.
  // 20% OTM short leg → 19% wide spread (enough headroom for typical 8-12%
  // monthly BTC drops on losing markets without the cap binding).
  // 1:1 sizing keeps the lite product simple; recovery scales with BTC drop.
  // Targets: ~5-7% fee of stake; protection accrues from -1% BTC drop.
  lite: {
    longOtmPct: 0.01,
    shortOtmPct: 0.20,
    markup: 1.40,
    riskFreeRate: 0.045,
    sizingMultiplier: 1.0,
  },
  // Standard — ATM long leg ("insured bet" feel: protection accrues from
  // any BTC drop). 30% wide spread (caps payout at 30% × protected notional;
  // for 1.7× sizing the cap = 51% of stake, which is enough to absorb every
  // observed BTC drawdown in the dataset without binding).
  // 1.7× sizing multiplier: we hedge 1.7× the at-risk amount, so each 1%
  // BTC drop produces 1.7% of stake in payout. This is the lever that lifts
  // recovery on deep-drop months toward the brief's target without forcing
  // the fee out of the 10-15% band.
  // Markup 1.45× preserves a ~31% gross margin (Foxify-style).
  // Calibrated targets:
  //   Fee ~ 1.7 × 5–6% (BS spread cost) × 1.45 ≈ 12–15% of stake. ✓
  //   Deep-drop recovery (≥10% drop): 1.7 × avg_drop ≈ 25–35% of stake.
  // The full 40-60% recovery target requires a hybrid (put-spread + small
  // Kalshi-NO leg) — documented as the v3 next-stage pilot ask.
  standard: {
    longOtmPct: 0.00,
    shortOtmPct: 0.30,
    markup: 1.45,
    riskFreeRate: 0.045,
    sizingMultiplier: 1.7,
  },
};

// ─── Quote ───────────────────────────────────────────────────────────────────

export type TieredBundleQuote = {
  tier: TierName;
  // Strike geometry (absolute USD)
  K_long: number;
  K_short: number;
  spreadWidthUsd: number;
  // Vols used for pricing
  rvol: number;
  ivLong: number;
  ivShort: number;
  // Sizing
  sizingMultiplier: number;
  protectedNotionalUsd: number;  // = atRisk × sizingMultiplier
  // Raw and charged costs as fraction of at-risk notional
  hedgeCostFracOfAtRisk: number;
  chargeFracOfAtRisk: number;
  // Concretized for a typical Kalshi bet
  atRiskUsd: number;             // = (yesPrice/100) * betSize
  hedgeCostUsd: number;          // what platform pays Deribit
  chargeUsd: number;             // what user pays Atticus
  marginUsd: number;             // chargeUsd - hedgeCostUsd
  maxPayoutUsd: number;          // = width/spot × protectedNotional
  feePctOfStake: number;         // chargeUsd / atRiskUsd
  maxRecoveryPctOfStake: number; // maxPayoutUsd / atRiskUsd
  returnOnTrigger: number;       // maxPayoutUsd / chargeUsd
};

/**
 * Quote a tiered Kalshi protection bundle.
 *
 * Pricing is direct Black-Scholes on the actual strikes with vol-skew applied.
 * The at-risk amount is the YES cost of the contract (e.g. $58 on a $100 face
 * at 58¢ YES) — that is the user's exposure, and that's what we hedge.
 */
export function quoteTieredBundle(params: {
  tier: TierName;
  rvol: number;
  tenorDays: number;
  yesPrice: number;          // 0-100 cents
  betSizeUsd: number;        // contract face value
  btcAtOpen: number;         // USD spot at market open
}): TieredBundleQuote {
  const cfg = TIER_CONFIGS[params.tier];
  const T = params.tenorDays / 365;

  const K_long = params.btcAtOpen * (1 - cfg.longOtmPct);
  const K_short = params.btcAtOpen * (1 - cfg.shortOtmPct);
  const spreadWidthUsd = K_long - K_short;

  const atm_iv = impliedVolFromRealized(params.rvol);
  const ivLong = ivForMoneyness(atm_iv, cfg.longOtmPct);
  const ivShort = ivForMoneyness(atm_iv, cfg.shortOtmPct);

  // Per-1-BTC-notional put prices in USD. To turn into cost fraction of
  // notional (in BTC terms), divide by btcAtOpen.
  const longPx = bsPut(params.btcAtOpen, K_long, T, cfg.riskFreeRate, ivLong);
  const shortPx = bsPut(params.btcAtOpen, K_short, T, cfg.riskFreeRate, ivShort);
  const netPxPerBtc = Math.max(0, longPx - shortPx);

  // Spread cost as a fraction of the protected BTC notional. Multiplying by
  // protectedNotional (= atRisk × sizingMultiplier) gives total hedge cost.
  const spreadCostFracOfProtected = netPxPerBtc / params.btcAtOpen;

  const atRiskUsd = (params.yesPrice / 100) * params.betSizeUsd;
  const protectedNotionalUsd = atRiskUsd * cfg.sizingMultiplier;
  const hedgeCostUsd = protectedNotionalUsd * spreadCostFracOfProtected;
  const chargeUsd = hedgeCostUsd * cfg.markup;
  const marginUsd = chargeUsd - hedgeCostUsd;

  // Convenience ratios expressed against at-risk stake (the user-facing denom).
  const hedgeCostFracOfAtRisk = hedgeCostUsd / atRiskUsd;
  const chargeFracOfAtRisk = chargeUsd / atRiskUsd;

  // Max payout = spread width × protected notional / spot.
  const maxPayoutUsd = (spreadWidthUsd / params.btcAtOpen) * protectedNotionalUsd;

  return {
    tier: params.tier,
    K_long,
    K_short,
    spreadWidthUsd,
    rvol: params.rvol,
    ivLong,
    ivShort,
    sizingMultiplier: cfg.sizingMultiplier,
    protectedNotionalUsd,
    hedgeCostFracOfAtRisk,
    chargeFracOfAtRisk,
    atRiskUsd,
    hedgeCostUsd,
    chargeUsd,
    marginUsd,
    maxPayoutUsd,
    feePctOfStake: chargeFracOfAtRisk,
    maxRecoveryPctOfStake: maxPayoutUsd / atRiskUsd,
    returnOnTrigger: chargeUsd > 0 ? maxPayoutUsd / chargeUsd : 0,
  };
}

// ─── Outcome ─────────────────────────────────────────────────────────────────

export type TieredHedgeOutcome = {
  tier: TierName;
  hedgeTriggered: boolean;
  btcMovePct: number;             // signed; negative = fell
  spreadPayoutUsd: number;        // protection payout to user
  // User economics (Kalshi binary + Atticus protection)
  kalshiPnlUsd: number;           // unprotected Kalshi outcome
  userNetWithProtectionUsd: number;
  userSavedUsd: number;           // = userNetWithProtection - kalshiPnlUsd
  recoveryPctOfStake: number;     // spreadPayout / atRisk; 0 if not triggered
  recoveryPctOfRealizedLoss: number; // spreadPayout / |kalshiPnl| if losing, else 0
  // Platform economics
  platformRevenueUsd: number;
  platformHedgeCostUsd: number;
  tpRecoveryUsd: number;
  platformNetPnlUsd: number;
};

export function computeTieredOutcome(params: {
  tier: TierName;
  btcAtOpen: number;
  btcAtSettle: number;
  yesPrice: number;
  betSizeUsd: number;
  kalshiOutcome: "yes" | "no";
  rvol: number;
  quote: TieredBundleQuote;
}): TieredHedgeOutcome {
  const { tier, btcAtOpen, btcAtSettle, yesPrice, betSizeUsd, kalshiOutcome, rvol, quote } = params;

  const atRisk = (yesPrice / 100) * betSizeUsd;
  const kalshiPnl = kalshiOutcome === "yes"
    ? betSizeUsd - atRisk    // YES paid: receive $100 face, paid $atRisk
    : -atRisk;                // NO outcome: lose the $atRisk stake

  const btcMovePct = (btcAtSettle - btcAtOpen) / btcAtOpen;

  // Payout is computed on the PROTECTED notional, which may exceed at-risk
  // when the tier uses a sizingMultiplier > 1. The user receives this payout
  // directly (Atticus passes through the Deribit fill).
  const spreadPayoutUsd = putSpreadPayout(
    quote.K_long,
    quote.K_short,
    btcAtOpen,
    btcAtSettle,
    quote.protectedNotionalUsd,
  );
  const hedgeTriggered = spreadPayoutUsd > 0;

  const userNetWithProtection = kalshiPnl - quote.chargeUsd + spreadPayoutUsd;
  const userSaved = userNetWithProtection - kalshiPnl;

  // Recovery metric: only meaningful on losing trades, where kalshiPnl < 0.
  const recoveryPctOfRealizedLoss = kalshiPnl < 0 ? spreadPayoutUsd / Math.abs(kalshiPnl) : 0;
  const recoveryPctOfStake = atRisk > 0 ? spreadPayoutUsd / atRisk : 0;

  // Platform: revenue - hedge cost ± TP salvage on un-triggered.
  // Spread cash flows cancel: Deribit pays Atticus the same amount Atticus
  // pays user. Platform keeps charge - hedgeCost + TP recovery.
  const regime = classifyRegime(rvol);
  const tpRate = tpRecoveryRate(regime, /* isSpread */ true);
  // 0.6 scalar: short-leg residual offsets some salvage value (matches v1).
  const tpRecovery = hedgeTriggered ? 0 : quote.hedgeCostUsd * tpRate * 0.6;
  const platformNetPnl = quote.chargeUsd - quote.hedgeCostUsd + tpRecovery;

  return {
    tier,
    hedgeTriggered,
    btcMovePct,
    spreadPayoutUsd,
    kalshiPnlUsd: kalshiPnl,
    userNetWithProtectionUsd: userNetWithProtection,
    userSavedUsd: userSaved,
    recoveryPctOfStake,
    recoveryPctOfRealizedLoss,
    platformRevenueUsd: quote.chargeUsd,
    platformHedgeCostUsd: quote.hedgeCostUsd,
    tpRecoveryUsd: tpRecovery,
    platformNetPnlUsd: platformNetPnl,
  };
}
