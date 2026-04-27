/**
 * Unified hedge engine for the Kalshi rebuild.
 *
 * Replaces the prior package's split between tieredHedgeModel.ts (put-spread
 * tiers) and shieldHedgeModel.ts (NO-leg tiers). The unified engine:
 *
 *   1. Calls adaptHedgeInstrument(eventType, direction, barrier) to determine
 *      whether the Deribit overlay is a CALL spread, PUT spread, or NONE
 *      (HIT events, where Shield-only is the right product).
 *
 *   2. Calls strikeSelector to find concrete strikes from a synthetic Deribit
 *      chain. Honors the 0..7 offset ladder.
 *
 *   3. Prices the spread leg with Black-Scholes + an explicit bid-ask widener
 *      passed by the caller. No Foxify IV calibration.
 *
 *   4. For Shield / Shield+, prices the Kalshi-NO leg from yesPrice + a
 *      configurable Kalshi fee assumption.
 *
 *   5. Computes pass-through platform economics (charge − hedge cost on the
 *      losing path). No TP-recovery model in this rebuild — un-triggered
 *      hedges are conservatively booked at zero salvage.
 *
 * Tier definitions live at the bottom of this file (single config block,
 * for ease of re-tuning).
 */

import {
  bsPut,
  bsCall,
  putSpreadCost,
  callSpreadCost,
  putSpreadPayout,
  callSpreadPayout,
} from "./math.js";
import {
  adaptHedgeInstrument,
  type EventType,
  type UserDirection,
  type HedgeInstrument,
} from "./kalshiEventTypes.js";
import {
  buildSyntheticChain,
  findCallSpreadStrikes,
  findPutSpreadStrikes,
} from "./strikeSelector.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TierName = "lite" | "standard" | "shield" | "shield_plus";

export type TierConfig = {
  /** Human-readable description for reports / pitches. */
  description: string;
  /** Markup applied to total raw hedge cost. */
  markup: number;
  /** Risk-free rate for BS pricing. */
  riskFreeRate: number;
  /** Bid-ask widener as fraction of theoretical (e.g. 0.05 = +5% to net cost). */
  bidAskWidener: number;
  /**
   * Sizing multiplier on the Deribit-leg notional (× user at-risk amount).
   * 1.0 = match user stake. >1 lifts payout-per-percent at proportional cost.
   */
  putCallSizingMultiplier: number;
  /** If true, include a Kalshi-NO leg sized to deliver a fixed rebate floor. */
  useShieldNoLeg: boolean;
  /** Rebate floor as fraction of stake. 0 = no floor. Used iff useShieldNoLeg. */
  rebateFloorFracOfStake: number;
  /** Effective Kalshi fee on NO win, e.g. 0.03 for 3%. */
  kalshiFeeOnPayout: number;
  /**
   * Strike OTM hint for the Deribit overlay (long leg, fraction of underlying).
   * The strikeSelector will snap to the closest available strike >= barrier
   * for call spreads or <= barrier for put spreads, so this is a hint not
   * an exact strike. 0 = ATM, 0.05 = 5% OTM, etc.
   *
   * IMPORTANT: For Kalshi events the "barrier" is the event strike K, not
   * the spot. The OTM hint is applied relative to spot for tier-shaping
   * purposes only when the event barrier is far from spot; otherwise the
   * barrier itself anchors strike selection.
   */
  longLegSpotOtmHint: number;
  /** Spread width as fraction of spot (used to set the short leg). */
  spreadWidthSpotFrac: number;
  /** Vol risk premium scalar applied to rvol to estimate IV. */
  ivOverRvol: number;
  /** Skew slope: vol-pts added per unit OTM (parameterised, not Foxify-baked). */
  skewSlope: number;
};

export type TierQuote = {
  tier: TierName;
  instrument: HedgeInstrument;
  // Strike geometry (zero for "none" instrument)
  K_long: number;
  K_short: number;
  spreadWidth: number;
  // Notional
  protectedNotionalUsd: number;
  // Costs (USD on user stake basis)
  spreadHedgeCostUsd: number;        // Deribit-leg cost (post bid-ask widener)
  noLegFaceUsd: number;              // Kalshi-NO leg face value (= rebate floor)
  noLegCostUsd: number;              // Atticus's cost to buy that NO leg
  expectedKalshiFeeUsd: number;
  totalHedgeCostUsd: number;
  chargeUsd: number;
  marginUsd: number;
  // Headlines
  atRiskUsd: number;
  feePctOfStake: number;
  rebateFloorUsd: number;
  spreadMaxPayoutUsd: number;
  totalMaxPayoutUsd: number;          // = rebateFloorUsd + spreadMaxPayoutUsd
  worstCaseLossUsd: number;
  worstCaseLossFracOfStake: number;
};

export type TierOutcome = {
  tier: TierName;
  hedgeTriggered: boolean;
  spreadPayoutUsd: number;
  shieldPayoutUsd: number;
  totalPayoutUsd: number;
  kalshiPnlUsd: number;
  userNetWithProtectionUsd: number;
  userSavedUsd: number;
  recoveryPctOfStake: number;
  platformRevenueUsd: number;
  platformHedgeCostUsd: number;
  platformKalshiFeePaidUsd: number;
  platformNetPnlUsd: number;
};

// ─── Quote ───────────────────────────────────────────────────────────────────

export type QuoteInput = {
  tier: TierName;
  eventType: EventType;
  userDirection: UserDirection;
  barrier: number;          // Kalshi event strike K (USD)
  yesPrice: number;         // 0-100 cents at open
  betSizeUsd: number;       // contract face value (e.g. 100)
  btcAtOpen: number;
  rvol: number;
  tenorDays: number;
};

export function quoteTier(input: QuoteInput): TierQuote {
  const cfg = TIER_CONFIGS[input.tier];
  // At-risk = the *cost* of the position the user opened.
  //   YES bet: user paid yesPrice/100 × face value, that's their loss exposure.
  //   NO  bet: user paid (1 - yesPrice/100) × face value (i.e. the NO price).
  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRiskUsd = userPriceFrac * input.betSizeUsd;
  const protectedNotionalUsd = atRiskUsd * cfg.putCallSizingMultiplier;

  const { instrument } = adaptHedgeInstrument(
    input.eventType,
    input.userDirection,
    input.barrier,
  );

  // ── Deribit overlay leg (call OR put spread, or none for HIT) ─────────────
  let K_long = 0, K_short = 0, spreadWidth = 0;
  let spreadHedgeCostUsd = 0;
  let spreadMaxPayoutUsd = 0;

  if (instrument !== "none") {
    const chain = buildSyntheticChain(input.btcAtOpen, input.tenorDays);

    let strikes: { K_long: number; K_short: number } | null = null;
    let offset = 0;
    while (offset < 8 && !strikes) {
      strikes = instrument === "call"
        ? findCallSpreadStrikes(chain, input.barrier, offset)
        : findPutSpreadStrikes(chain, input.barrier, offset);
      offset++;
    }

    if (strikes) {
      K_long = strikes.K_long;
      K_short = strikes.K_short;
      spreadWidth = Math.abs(K_short - K_long);

      const T = input.tenorDays / 365;
      const atmIv = input.rvol * cfg.ivOverRvol;
      const otmLong = Math.abs(K_long - input.btcAtOpen) / input.btcAtOpen;
      const otmShort = Math.abs(K_short - input.btcAtOpen) / input.btcAtOpen;
      const ivLong = atmIv + cfg.skewSlope * otmLong;
      const ivShort = atmIv + cfg.skewSlope * otmShort;

      const netPxPerBtc = instrument === "call"
        ? callSpreadCost(input.btcAtOpen, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort)
        : putSpreadCost(input.btcAtOpen, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort);

      // Apply bid-ask widener (transparent, parameterized)
      const grossedCostFracOfBtc = (netPxPerBtc / input.btcAtOpen) * (1 + cfg.bidAskWidener);
      spreadHedgeCostUsd = protectedNotionalUsd * grossedCostFracOfBtc;
      spreadMaxPayoutUsd = (spreadWidth / input.btcAtOpen) * protectedNotionalUsd;
    }
    // else: no strikes available — spread leg contributes zero (genuine
    // limitation, not silently hidden). Caller can detect via spreadWidth=0.
  }

  // ── Kalshi-NO leg (Shield mechanism) ──────────────────────────────────────
  let noLegFaceUsd = 0;
  let noLegCostUsd = 0;
  let expectedKalshiFeeUsd = 0;
  let rebateFloorUsd = 0;

  if (cfg.useShieldNoLeg) {
    rebateFloorUsd = atRiskUsd * cfg.rebateFloorFracOfStake;
    noLegFaceUsd = rebateFloorUsd;
    // For YES bets: we want to win when YES loses → buy NO contracts (price = 1 - yesPrice/100).
    // For NO bets:  we want to win when NO loses (i.e. YES wins) → buy YES contracts (price = yesPrice/100).
    // Either way the "loss-protection leg" probability = P(user loses) = price of the opposite side.
    const lossLegPriceFrac = input.userDirection === "yes"
      ? (100 - input.yesPrice) / 100
      : input.yesPrice / 100;
    noLegCostUsd = noLegFaceUsd * lossLegPriceFrac;
    // Expected Kalshi fee: paid by Atticus when the loss-leg wins.
    expectedKalshiFeeUsd = noLegFaceUsd * cfg.kalshiFeeOnPayout * lossLegPriceFrac;
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const totalHedgeCostUsd = spreadHedgeCostUsd + noLegCostUsd + expectedKalshiFeeUsd;
  const chargeUsd = totalHedgeCostUsd * cfg.markup;
  const marginUsd = chargeUsd - totalHedgeCostUsd;
  const totalMaxPayoutUsd = rebateFloorUsd + spreadMaxPayoutUsd;

  // Worst-case realized loss (across all settlement scenarios):
  //   user loses Kalshi → atRiskUsd loss → recover at minimum rebateFloor
  //   pays chargeUsd at entry
  //   spread leg payout depends on path; worst case for user is when the
  //   spread expires worthless (e.g. BTC ends at open price for a put-spread
  //   ABOVE-YES bet). In that case payout = rebateFloorUsd only.
  const worstCaseLossUsd = atRiskUsd - rebateFloorUsd + chargeUsd;

  return {
    tier: input.tier,
    instrument,
    K_long,
    K_short,
    spreadWidth,
    protectedNotionalUsd,
    spreadHedgeCostUsd,
    noLegFaceUsd,
    noLegCostUsd,
    expectedKalshiFeeUsd,
    totalHedgeCostUsd,
    chargeUsd,
    marginUsd,
    atRiskUsd,
    feePctOfStake: atRiskUsd > 0 ? chargeUsd / atRiskUsd : 0,
    rebateFloorUsd,
    spreadMaxPayoutUsd,
    totalMaxPayoutUsd,
    worstCaseLossUsd,
    worstCaseLossFracOfStake: atRiskUsd > 0 ? worstCaseLossUsd / atRiskUsd : 0,
  };
}

// ─── Outcome ─────────────────────────────────────────────────────────────────

export type OutcomeInput = {
  quote: TierQuote;
  eventType: EventType;
  userDirection: UserDirection;
  yesPrice: number;
  betSizeUsd: number;
  kalshiOutcome: "yes" | "no";   // settled Kalshi result (derived from price)
  btcAtOpen: number;
  btcAtSettle: number;
};

export function settleTier(input: OutcomeInput): TierOutcome {
  const q = input.quote;
  const cfg = TIER_CONFIGS[q.tier];
  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRisk = userPriceFrac * input.betSizeUsd;

  const userWon = input.kalshiOutcome === input.userDirection;
  const kalshiPnl = userWon ? input.betSizeUsd - atRisk : -atRisk;

  // Spread-leg payout (instrument-aware)
  let spreadPayoutUsd = 0;
  if (q.instrument === "call" && q.spreadWidth > 0) {
    spreadPayoutUsd = callSpreadPayout(
      q.K_long, q.K_short,
      input.btcAtOpen, input.btcAtSettle,
      q.protectedNotionalUsd,
    );
  } else if (q.instrument === "put" && q.spreadWidth > 0) {
    spreadPayoutUsd = putSpreadPayout(
      q.K_long, q.K_short,
      input.btcAtOpen, input.btcAtSettle,
      q.protectedNotionalUsd,
    );
  }

  // NO-leg payout: triggered when user loses on Kalshi (regardless of BTC path)
  const shieldPayoutUsd = (cfg.useShieldNoLeg && !userWon) ? q.rebateFloorUsd : 0;

  const totalPayoutUsd = spreadPayoutUsd + shieldPayoutUsd;
  const userNet = kalshiPnl - q.chargeUsd + totalPayoutUsd;

  // Realized Kalshi fee: only when NO-leg actually wins
  const platformKalshiFeePaid = (cfg.useShieldNoLeg && !userWon)
    ? q.noLegFaceUsd * cfg.kalshiFeeOnPayout
    : 0;

  // Platform net = revenue − spread cost − NO cost − realized Kalshi fee
  // (Both Deribit spread and Kalshi NO are pass-through: their payouts cancel
  // the user-facing rebates, so platform retains charge − costs.)
  const platformNet = q.chargeUsd
    - q.spreadHedgeCostUsd
    - q.noLegCostUsd
    - platformKalshiFeePaid;

  return {
    tier: q.tier,
    hedgeTriggered: totalPayoutUsd > 0,
    spreadPayoutUsd,
    shieldPayoutUsd,
    totalPayoutUsd,
    kalshiPnlUsd: kalshiPnl,
    userNetWithProtectionUsd: userNet,
    userSavedUsd: userNet - kalshiPnl,
    recoveryPctOfStake: atRisk > 0 ? totalPayoutUsd / atRisk : 0,
    platformRevenueUsd: q.chargeUsd,
    platformHedgeCostUsd: q.spreadHedgeCostUsd + q.noLegCostUsd,
    platformKalshiFeePaidUsd: platformKalshiFeePaid,
    platformNetPnlUsd: platformNet,
  };
}

// ─── Tier configuration block (single source of truth) ───────────────────────

/**
 * Re-tuning happens here only. Each tier's parameters are explicit and
 * locally documented. No Foxify defaults; every constant is justified
 * by the role it plays in the product, not by inheritance.
 *
 * Common parameters (same across tiers unless noted):
 *   bidAskWidener    = 0.10  (10% widener on theoretical option price; ballpark
 *                             Deribit 30-day vertical-spread bid-ask cost)
 *   ivOverRvol       = 1.18  (vol risk premium of ~18% — consistent with public
 *                             Deribit DVOL/RV studies; replaceable per tier)
 *   skewSlope        = 0.30  (modest skew adjustment, ~3 vol-pts per 10% OTM)
 *   riskFreeRate     = 0.045
 *   kalshiFeeOnPayout= 0.03  (3% effective fee on NO win, mid-of-range; tunable)
 */
export const TIER_CONFIGS: Record<TierName, TierConfig> = {
  // ── Lite (rebate, retail-coupon) ──────────────────────────────────────────
  // Cheapest tier. Modest sizing. No NO-leg. Pays only when BTC moves the
  // adapter-determined wrong direction (call OR put depending on event/dir).
  lite: {
    description: "Light protection: BTC-move-driven rebate; no deterministic floor.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    putCallSizingMultiplier: 1.0,
    useShieldNoLeg: false,
    rebateFloorFracOfStake: 0,
    kalshiFeeOnPayout: 0.03,
    longLegSpotOtmHint: 0.01,
    spreadWidthSpotFrac: 0.19,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Standard (rebate, larger sizing) ──────────────────────────────────────
  // Same instrument as Lite but with 1.7× sizing; bigger fee, bigger payout
  // when BTC moves materially. Still no deterministic floor.
  standard: {
    description: "Standard protection: 1.7×-sized rebate; meaningful BTC-tail cash recovery.",
    markup: 1.45,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    putCallSizingMultiplier: 1.7,
    useShieldNoLeg: false,
    rebateFloorFracOfStake: 0,
    kalshiFeeOnPayout: 0.03,
    longLegSpotOtmHint: 0.0,
    spreadWidthSpotFrac: 0.30,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Shield (deterministic floor, NO leg only) ────────────────────────────
  // Pure money-back guarantee tier. Kalshi-NO leg sized to deliver a fixed
  // rebate on any losing outcome. No Deribit overlay (spreadWidth=0 is
  // fine; quoteTier handles instrument="put"/"call" but with sizing 0 below).
  shield: {
    description: "Shield: 40% guaranteed back on every losing Kalshi outcome (Kalshi-NO leg).",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    putCallSizingMultiplier: 0.0, // zero out the spread leg; pure NO-leg product
    useShieldNoLeg: true,
    rebateFloorFracOfStake: 0.40,
    kalshiFeeOnPayout: 0.03,
    longLegSpotOtmHint: 0,
    spreadWidthSpotFrac: 0,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Shield+ (hybrid: NO leg + small spread overlay) ──────────────────────
  // Deterministic floor + extra payout when the BTC path moves materially.
  shield_plus: {
    description: "Shield+: 30% guaranteed floor + BTC-tail spread overlay.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    putCallSizingMultiplier: 1.0,
    useShieldNoLeg: true,
    rebateFloorFracOfStake: 0.30,
    kalshiFeeOnPayout: 0.03,
    longLegSpotOtmHint: 0.05,
    spreadWidthSpotFrac: 0.20,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },
};
