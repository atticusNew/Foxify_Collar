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
   * TARGET WORST-CASE LOSS as fraction of stake (the central design parameter).
   *
   * Rebate face is solved analytically so that user's worst-case realized
   * loss does not exceed `targetWorstCaseFracOfStake` × stake. Specifically:
   *
   *   worstCase = stake - rebate + fee
   *   We want   worstCase ≤ W × stake
   *   With     fee = noLegCost × markup, noLegCost = rebate × q (q = Kalshi
   *           loss-leg price as a fraction)
   *   →        rebate ≥ stake × (1 - W) / (1 - q × markup)
   *
   * The denominator `(1 - q × markup)` must be positive for the tier to be
   * offerable. When q × markup ≥ 1 (loss is so likely that Kalshi NO costs
   * more than 1/markup × face), the tier is marked NOT_OFFERED for that
   * market — an honest, contract-grounded feasibility flag.
   *
   * Setting targetWorstCaseFracOfStake = 1.0 disables the NO leg entirely
   * (no rebate floor) — used by Light tier when paired with a put/call
   * overlay only.
   */
  targetWorstCaseFracOfStake: number;
  /**
   * Sizing multiplier on the Deribit-leg notional (× user at-risk amount).
   * 0 = no Deribit overlay. 1.0 = matched. >1 = leveraged for tail upside.
   */
  putCallSizingMultiplier: number;
  /** Effective Kalshi fee on NO win, e.g. 0.03 for 3%. */
  kalshiFeeOnPayout: number;
  /** Vol risk premium scalar applied to rvol to estimate IV. */
  ivOverRvol: number;
  /** Skew slope: vol-pts added per unit OTM (parameterised, not Foxify-baked). */
  skewSlope: number;
};

export type TierQuote = {
  tier: TierName;
  /** True iff this tier could be priced for this market under target W. */
  offered: boolean;
  /** Diagnostic when offered=false (e.g. "loss-leg too expensive"). */
  notOfferedReason?: string;
  instrument: HedgeInstrument;
  // Strike geometry (zero for "none" instrument or when offered=false)
  K_long: number;
  K_short: number;
  spreadWidth: number;
  // Notional
  protectedNotionalUsd: number;
  // Costs (USD on user stake basis)
  spreadHedgeCostUsd: number;
  noLegFaceUsd: number;
  noLegCostUsd: number;
  expectedKalshiFeeUsd: number;
  totalHedgeCostUsd: number;
  chargeUsd: number;
  marginUsd: number;
  // Headlines
  atRiskUsd: number;
  feePctOfStake: number;
  rebateFloorUsd: number;
  spreadMaxPayoutUsd: number;
  totalMaxPayoutUsd: number;
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
  //   YES bet: user paid yesPrice/100 × face value (their loss exposure).
  //   NO  bet: user paid (1 - yesPrice/100) × face value.
  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRiskUsd = userPriceFrac * input.betSizeUsd;

  // Loss-leg price = price of the *opposite* Kalshi side (what Atticus buys
  // to deliver a rebate when the user loses).
  const lossLegPriceFrac = input.userDirection === "yes"
    ? (100 - input.yesPrice) / 100
    : input.yesPrice / 100;

  const protectedNotionalUsd = atRiskUsd * cfg.putCallSizingMultiplier;
  const { instrument } = adaptHedgeInstrument(input.eventType, input.userDirection, input.barrier);

  // ── Solve rebate face from target worst-case W ────────────────────────────
  //
  // worstCase = stake - rebate + fee
  // fee       = (rebate × q + rebate × q × kalshiFee + spreadCost) × markup
  //           = rebate × q × (1 + kalshiFee) × markup + spreadCost × markup
  //
  // So:
  //   worstCase = stake - rebate + rebate × q(1+f)m + spreadCost × m
  //             = stake - rebate × (1 - qm(1+f)) + spreadCost × m
  // Set worstCase = W × stake:
  //   rebate = (stake × (1 - W) + spreadCost × m) / (1 - qm(1+f))
  //
  // We compute spreadCost first (independent of rebate), then solve for rebate.

  // ── Deribit overlay leg cost ──────────────────────────────────────────────
  let K_long = 0, K_short = 0, spreadWidth = 0;
  let spreadHedgeCostUsd = 0;
  let spreadMaxPayoutUsd = 0;

  if (instrument !== "none" && cfg.putCallSizingMultiplier > 0) {
    const chain = buildSyntheticChain(input.btcAtOpen, input.tenorDays);
    let strikes: { K_long: number; K_short: number } | null = null;
    for (let offset = 0; offset < 8 && !strikes; offset++) {
      strikes = instrument === "call"
        ? findCallSpreadStrikes(chain, input.barrier, offset)
        : findPutSpreadStrikes(chain, input.barrier, offset);
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
      const grossedCostFracOfBtc = (netPxPerBtc / input.btcAtOpen) * (1 + cfg.bidAskWidener);
      spreadHedgeCostUsd = protectedNotionalUsd * grossedCostFracOfBtc;
      spreadMaxPayoutUsd = (spreadWidth / input.btcAtOpen) * protectedNotionalUsd;
    }
  }

  // ── Solve for rebate face ──────────────────────────────────────────────────
  let noLegFaceUsd = 0;
  let noLegCostUsd = 0;
  let expectedKalshiFeeUsd = 0;
  let rebateFloorUsd = 0;
  let offered = true;
  let notOfferedReason: string | undefined;

  if (cfg.targetWorstCaseFracOfStake < 1.0) {
    // Need a rebate to bring worst-case below 100%.
    const W = cfg.targetWorstCaseFracOfStake;
    const q = lossLegPriceFrac;
    const m = cfg.markup;
    const f = cfg.kalshiFeeOnPayout;
    const denom = 1 - q * m * (1 + f);

    // Feasibility: denom must be positive for any finite rebate to satisfy W.
    if (denom <= 0.05) {
      // Loss is so likely + markup so high that Kalshi-NO leg cost ≥ 1/markup.
      // Rebate face would have to be infinite. Honest "not offered" flag.
      offered = false;
      notOfferedReason = `loss-leg too expensive (q=${(q * 100).toFixed(0)}¢, q×m×(1+f)=${(q * m * (1 + f)).toFixed(2)} ≥ 1 / max-feasible)`;
    } else {
      const numerator = atRiskUsd * (1 - W) + spreadHedgeCostUsd * m;
      const rebateNeeded = numerator / denom;

      // Cap the rebate at "won't pay back more than user actually lost":
      // a rebate > atRiskUsd is uneconomical (paying back more than the loss).
      // If the math demands rebate > atRiskUsd, declare not offered at this W.
      if (rebateNeeded > atRiskUsd) {
        offered = false;
        notOfferedReason = `target W=${W.toFixed(2)} requires rebate ${rebateNeeded.toFixed(2)} > stake ${atRiskUsd.toFixed(2)}`;
      } else {
        rebateFloorUsd = rebateNeeded;
        noLegFaceUsd = rebateFloorUsd;
        noLegCostUsd = noLegFaceUsd * q;
        expectedKalshiFeeUsd = noLegFaceUsd * f * q;
      }
    }
  }

  // If not offered, zero everything Deribit-side too (we don't quote partial).
  if (!offered) {
    spreadHedgeCostUsd = 0;
    spreadMaxPayoutUsd = 0;
    K_long = 0; K_short = 0; spreadWidth = 0;
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const totalHedgeCostUsd = spreadHedgeCostUsd + noLegCostUsd + expectedKalshiFeeUsd;
  const chargeUsd = totalHedgeCostUsd * cfg.markup;
  const marginUsd = chargeUsd - totalHedgeCostUsd;
  const totalMaxPayoutUsd = rebateFloorUsd + spreadMaxPayoutUsd;
  const worstCaseLossUsd = offered ? (atRiskUsd - rebateFloorUsd + chargeUsd) : atRiskUsd;

  return {
    tier: input.tier,
    offered,
    notOfferedReason,
    instrument: offered ? instrument : "none",
    K_long, K_short, spreadWidth,
    protectedNotionalUsd: offered ? protectedNotionalUsd : 0,
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

  // If the tier wasn't offered for this market, the user holds the position
  // unprotected. Report as zero protection economics so aggregates are honest.
  if (!q.offered) {
    return {
      tier: q.tier,
      hedgeTriggered: false,
      spreadPayoutUsd: 0,
      shieldPayoutUsd: 0,
      totalPayoutUsd: 0,
      kalshiPnlUsd: kalshiPnl,
      userNetWithProtectionUsd: kalshiPnl,
      userSavedUsd: 0,
      recoveryPctOfStake: 0,
      platformRevenueUsd: 0,
      platformHedgeCostUsd: 0,
      platformKalshiFeePaidUsd: 0,
      platformNetPnlUsd: 0,
    };
  }

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

  // NO-leg payout: triggered when user loses on Kalshi (regardless of BTC path).
  // The NO leg is "active" iff a rebate was solved for at quote time.
  const hasNoLeg = q.rebateFloorUsd > 0;
  const shieldPayoutUsd = (hasNoLeg && !userWon) ? q.rebateFloorUsd : 0;

  const totalPayoutUsd = spreadPayoutUsd + shieldPayoutUsd;
  const userNet = kalshiPnl - q.chargeUsd + totalPayoutUsd;

  // Realized Kalshi fee: only when NO-leg actually wins
  const platformKalshiFeePaid = (hasNoLeg && !userWon)
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
  // Two product families:
  //
  //   PROBABILISTIC FAMILY (Light, Standard) — for retail volume.
  //     - Cheap fee (5-15% of stake).
  //     - BTC-path-driven recovery: pays only when underlying moves the
  //       wrong direction relative to the user's bet.
  //     - W = 1.0 (no NO leg). Pure put/call spread overlay.
  //     - Crosses retail behavioral threshold A2 on tail-down months;
  //       does NOT cross deterministic-floor threshold B2.
  //     - Story: "Pay a few dollars more, get a meaningful rebate when
  //       the trade goes badly against you."
  //
  //   DETERMINISTIC FAMILY (Shield, Shield+) — for institutional / treasury.
  //     - Higher fee (15-25% of stake).
  //     - Contract-bounded worst case via Kalshi-NO leg.
  //     - W < 1.0. Solved analytically per market.
  //     - Crosses ALL retail thresholds A1/A2/A3 + institutional B1/B2.
  //     - Story: "Worst-case loss bounded by contract at X% of stake on
  //       every losing outcome — that's the threshold risk policies
  //       require to whitelist a prediction market product."

  // ── Light (W=95%, retail entry) ──────────────────────────────────────────
  // Worst-case loss capped at 95% of stake. Translates to ~5% guaranteed
  // rebate on every losing outcome.
  // Math: fee/stake ≈ q × m × (1-W) / (1 - qm(1+f))
  //   At yes=58 (q=0.42): fee/stake ≈ 7.5%, rebate/stake ≈ 12.7%
  //   At yes=72 (q=0.28): fee/stake ≈ 4.5%, rebate/stake ≈ 12.7%
  // P(payout|loss) = 100%. A1 ✅ A2 ✅ A3 ✅ on every offered market.
  lite: {
    description: "Light: worst-case capped at 95%. Cheapest deterministic floor; ~5% guaranteed rebate.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    targetWorstCaseFracOfStake: 0.95,
    putCallSizingMultiplier: 0.0,
    kalshiFeeOnPayout: 0.03,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Standard (W=85%, retail "real money back") ───────────────────────────
  standard: {
    description: "Standard: worst-case capped at 85%. ~15% guaranteed rebate on every loss.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    targetWorstCaseFracOfStake: 0.85,
    putCallSizingMultiplier: 0.0,
    kalshiFeeOnPayout: 0.03,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Shield (W=70%, institutional bar) ─────────────────────────────────────
  // Worst-case capped at 70% — crosses institutional B1 threshold.
  // Markets where q × m × (1+f) ≥ 1 are NOT_OFFERED (honest).
  shield: {
    description: "Shield: worst-case capped at 70%. Crosses institutional B1 bar. ~30% guaranteed rebate.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    targetWorstCaseFracOfStake: 0.70,
    putCallSizingMultiplier: 0.0,
    kalshiFeeOnPayout: 0.03,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },

  // ── Shield+ (W=70% + tail-upside overlay) ────────────────────────────────
  // Same W as Shield, plus 1.0× BTC option-spread overlay for additional
  // recovery on materially-against-user BTC paths.
  shield_plus: {
    description: "Shield+: 70%-W floor + BTC-overlay for tail-upside cash recovery.",
    markup: 1.40,
    riskFreeRate: 0.045,
    bidAskWidener: 0.10,
    targetWorstCaseFracOfStake: 0.70,
    putCallSizingMultiplier: 1.0,
    kalshiFeeOnPayout: 0.03,
    ivOverRvol: 1.18,
    skewSlope: 0.30,
  },
};
