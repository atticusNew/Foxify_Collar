/**
 * Atticus options-hedge engine for Kalshi BTC bets.
 *
 * PRODUCT (this version supersedes all prior NO-leg variants):
 *
 *   User holds a Kalshi BTC bet. Atticus brings them a **real Deribit BTC
 *   options vertical spread** that pays when BTC moves against the bet.
 *   Atticus is a procurement bridge to a deeper options market; we do NOT
 *   take the other side of the user's Kalshi bet, do NOT act as a Kalshi
 *   market maker, do NOT warehouse risk.
 *
 *   Why this matters for Kalshi:
 *     - A Kalshi MM cannot sell a 30-day BTC put spread. Only an options
 *       exchange can. Atticus is the bridge.
 *     - Brings options-market depth (Deribit handles ~$30B BTC options OI)
 *       to Kalshi traders without integration on Kalshi's side.
 *     - Unlocks institutional flow that today can't size into Kalshi BTC
 *       contracts because the binary 100% loss is unbounded vs treasury
 *       risk policy.
 *
 *   Why this matters for the user:
 *     - Defined-risk overlay at a real options-market price (not a
 *       synthetic counter-bet, not a coupon).
 *     - Capital-efficient: small premium (~1-3% of stake on a 5%-OTM put
 *       spread) protects materially against tail moves.
 *
 *   Why this works for Atticus:
 *     - Markup on real fill cost. Pure pass-through. Margin = chargeUsd −
 *       (long_ask − short_bid) − Deribit fees − ops costs.
 *
 * MECHANISM:
 *
 *   1. Adapter (kalshiEventTypes.ts) maps (event_type × user_direction) to
 *      put-spread or call-spread instrument:
 *
 *        ABOVE-YES: user loses if BTC < K → buy PUT spread below K
 *        ABOVE-NO:  user loses if BTC ≥ K → buy CALL spread at/above K
 *        BELOW-YES: user loses if BTC > K → buy CALL spread above K
 *        BELOW-NO:  user loses if BTC ≤ K → buy PUT spread at/below K
 *        HIT-YES/NO: not directly hedgeable with vanilla puts/calls (would
 *                    need barrier options); marked NOT_HEDGEABLE.
 *
 *   2. Pricing: live Deribit chain when available (deribitClient.ts).
 *      Fallback: BS-theoretical + bid-ask widener for historical-date
 *      markets where the chain isn't accessible.
 *
 *   3. Sizing: protected-notional multiplier × user at-risk. 1.0 = matched
 *      hedge (most capital efficient for user). >1 leverages the put
 *      spread's max-payout for tail-event recovery.
 *
 *   4. Charge: hedge cost × markup. Markup is derived from target net
 *      margin + ops cost fraction.
 *
 *   5. Settlement at expiry: spread payout depends on BTC at settle.
 *      Atticus passes Deribit fill through to user net of fees.
 */

import {
  bsCall, bsPut,
  callSpreadCost, putSpreadCost,
  callSpreadPayout, putSpreadPayout,
} from "./math.js";
import {
  adaptHedgeInstrument,
  type EventType, type UserDirection, type HedgeInstrument,
} from "./kalshiEventTypes.js";
import {
  type DeribitChainSnapshot, findClosestExpiry, findVerticalSpread,
} from "./deribitClient.js";

// ─── Tier configuration ──────────────────────────────────────────────────────

export type TierName = "lite" | "standard" | "shield" | "shield_plus";

export type TierConfig = {
  description: string;
  /**
   * Strike geometry: long-leg OTM hint as fraction of barrier.
   *   0.0  = long leg at-the-Kalshi-barrier (max protection, max cost)
   *   0.05 = long leg 5% past the barrier (cheaper, less protection)
   * For PUT spreads (ABOVE-YES, BELOW-NO) "past the barrier" means below.
   * For CALL spreads (ABOVE-NO, BELOW-YES) it means above.
   */
  longOtmFromBarrierFrac: number;
  /** Width of spread as fraction of underlying (caps max payout). */
  spreadWidthFrac: number;
  /** Notional sizing multiplier (× user at-risk amount). */
  sizingMultiplier: number;
  /** Target net margin (markup is derived from this + opCostFrac). */
  targetNetMargin: number;
  opCostFrac: number;
  /** Risk-free rate, vol params for BS fallback pricing. */
  riskFreeRate: number;
  ivOverRvol: number;
  skewSlope: number;
  /** Bid-ask widener applied to BS-theoretical when live chain unavailable. */
  bidAskWidener: number;
};

function computeMarkup(cfg: TierConfig): number {
  const denom = 1 - cfg.targetNetMargin - cfg.opCostFrac;
  if (denom <= 0.05) return 2.0;
  return 1 / denom;
}

const COMMON: Pick<TierConfig,
  "targetNetMargin" | "opCostFrac" | "riskFreeRate" | "ivOverRvol" | "skewSlope" | "bidAskWidener"
> = {
  // 13% net margin + 5% ops costs → markup 1.22×.
  // This is a sustainable insurance/wrap product margin band:
  //   - Above options MM (1-5%): we add structure, not just liquidity.
  //   - Below traditional MGA (15-25%): we have less risk capital exposure
  //     because the hedge is fully Deribit-pre-funded (pass-through).
  targetNetMargin: 0.13,
  opCostFrac: 0.05,
  riskFreeRate: 0.045,
  // ivOverRvol 1.10 + skewSlope 0.20 + zero widener — calibrated against the
  // live Deribit chain (see _calibrationCheck.ts). Synthetic now matches live
  // within ±15% on a 30-DTE BTC ATM/12%-width vertical. Without this
  // recalibration the prior synthetic was over-pricing by ~30-50%.
  ivOverRvol: 1.10,
  skewSlope: 0.20,
  bidAskWidener: 0.0,
};

/**
 * Four tiers — different strike geometries / sizing, NOT different products.
 *
 * The user trades off premium (fee % of stake) against protection depth.
 * All four use the SAME mechanism: a real Deribit BTC vertical spread,
 * priced at live mid-or-fill prices.
 */
export const TIER_CONFIGS: Record<TierName, TierConfig> = {
  lite: {
    ...COMMON,
    description: "Light: 5% OTM long leg, narrow 5% spread width. Cheapest tier; protects deep tail moves only.",
    longOtmFromBarrierFrac: 0.05,
    spreadWidthFrac: 0.05,
    sizingMultiplier: 1.0,
  },
  standard: {
    ...COMMON,
    description: "Standard: 2% OTM long leg, 8% spread width. Balanced premium/protection.",
    longOtmFromBarrierFrac: 0.02,
    spreadWidthFrac: 0.08,
    sizingMultiplier: 1.0,
  },
  shield: {
    ...COMMON,
    description: "Shield: ATM long leg, 12% spread width. Material protection from any adverse BTC move.",
    longOtmFromBarrierFrac: 0.0,
    spreadWidthFrac: 0.12,
    sizingMultiplier: 1.0,
  },
  shield_plus: {
    ...COMMON,
    description: "Shield-Max: ATM long leg, 12% spread width, 2× sized. Tail-event recovery for institutional desks.",
    longOtmFromBarrierFrac: 0.0,
    spreadWidthFrac: 0.12,
    sizingMultiplier: 2.0,
  },
};

// ─── Quote ───────────────────────────────────────────────────────────────────

export type PricingSource = "live_deribit" | "bs_synthetic" | "not_hedgeable";

export type QuoteInput = {
  tier: TierName;
  eventType: EventType;
  userDirection: UserDirection;
  barrier: number;             // Kalshi event strike K (USD)
  yesPrice: number;            // 0-100 cents
  betSizeUsd: number;          // contract face (e.g. 100)
  btcAtOpen: number;           // BTC spot at market open
  rvol: number;                // 30-day realized vol
  tenorDays: number;
  liveChain?: DeribitChainSnapshot;  // pass for current-date markets
};

export type TierQuote = {
  tier: TierName;
  hedgeable: boolean;
  notHedgeableReason?: string;
  instrument: HedgeInstrument;
  pricingSource: PricingSource;

  // Strikes (in BTC USD)
  K_long: number;
  K_short: number;
  spreadWidth: number;

  // Sizing
  atRiskUsd: number;
  protectedNotionalUsd: number;

  // Pricing
  hedgeCostUsd: number;        // Atticus pays Deribit (long_ask - short_bid) × protectedNotional
  markup: number;
  chargeUsd: number;           // user pays Atticus
  marginUsd: number;
  feePctOfStake: number;
  feePctOfNotional: number;    // CAPITAL EFFICIENCY metric: fee / protectedNotional

  // Payout characteristics
  spreadMaxPayoutUsd: number;
  recoveryRatio: number;       // maxPayout / fee — how much the user gets per $1 paid in tail event
  /**
   * Range of BTC moves where the hedge pays anything.
   *   PUT spread: pays when BTC < K_long. Trigger threshold = K_long.
   *   CALL spread: pays when BTC > K_long. Trigger threshold = K_long.
   * Reported as % move from btcAtOpen (negative = down).
   */
  triggerBtcMovePct: number;
  /** BTC move at which max payout is reached. */
  maxPayoutBtcMovePct: number;

  // User EV under risk-neutral measure (BS-implied)
  userEvUsd: number;
  userEvPctOfStake: number;
};

export function quoteTier(input: QuoteInput): TierQuote {
  const cfg = TIER_CONFIGS[input.tier];
  const markup = computeMarkup(cfg);

  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRiskUsd = userPriceFrac * input.betSizeUsd;
  const protectedNotionalUsd = atRiskUsd * cfg.sizingMultiplier;

  const { instrument } = adaptHedgeInstrument(input.eventType, input.userDirection, input.barrier);

  // HIT events use barrier options not vanilla spreads — flag and bail.
  if (instrument === "none") {
    return makeNotHedgeable(input, cfg, markup, atRiskUsd, protectedNotionalUsd,
      "HIT events require barrier options (knock-in/knock-out); not part of this product.");
  }

  // ── Strike selection ──────────────────────────────────────────────────────
  // Default geometry from tier config:
  //   PUT spread (loss-region "below"): K_long = barrier × (1 - longOtmFromBarrierFrac)
  //                                     K_short = K_long - barrier × spreadWidthFrac
  //   CALL spread (loss-region "above"): K_long = barrier × (1 + longOtmFromBarrierFrac)
  //                                      K_short = K_long + barrier × spreadWidthFrac
  let K_long: number, K_short: number;
  if (instrument === "put") {
    K_long = input.barrier * (1 - cfg.longOtmFromBarrierFrac);
    K_short = K_long - input.barrier * cfg.spreadWidthFrac;
  } else {
    K_long = input.barrier * (1 + cfg.longOtmFromBarrierFrac);
    K_short = K_long + input.barrier * cfg.spreadWidthFrac;
  }

  // ── Pricing: try live Deribit, fall back to BS-synthetic ─────────────────
  let hedgeCostUsd: number;
  let pricingSource: PricingSource;

  if (input.liveChain) {
    // Snap K_long, K_short to listed strikes near our targets
    const expiry = findClosestExpiry(input.liveChain, input.tenorDays, 6);
    const optType: "C" | "P" = instrument === "put" ? "P" : "C";
    const liveSpread = expiry ? findVerticalSpread(input.liveChain, expiry, optType, K_long) : null;
    if (liveSpread) {
      K_long = liveSpread.K_long;
      K_short = liveSpread.K_short;
      const longUsd = (liveSpread.longRow.ask ?? 0) * (liveSpread.longRow.underlying ?? input.btcAtOpen);
      const shortUsd = (liveSpread.shortRow.bid ?? 0) * (liveSpread.shortRow.underlying ?? input.btcAtOpen);
      const netPerBtcOfNotional = Math.max(0, longUsd - shortUsd);
      // Convert "USD per BTC of notional" to "USD on protectedNotional".
      // Deribit prices are PER BTC-equivalent, so:
      //   hedge cost on protectedNotionalUsd = netPerBtcOfNotional × (protectedNotionalUsd / underlying)
      hedgeCostUsd = netPerBtcOfNotional * (protectedNotionalUsd / input.btcAtOpen);
      pricingSource = "live_deribit";
    } else {
      pricingSource = "bs_synthetic";
      hedgeCostUsd = bsSyntheticCost(cfg, input, instrument, K_long, K_short, protectedNotionalUsd);
    }
  } else {
    pricingSource = "bs_synthetic";
    hedgeCostUsd = bsSyntheticCost(cfg, input, instrument, K_long, K_short, protectedNotionalUsd);
  }

  const spreadWidth = Math.abs(K_long - K_short);
  const spreadMaxPayoutUsd = (spreadWidth / input.btcAtOpen) * protectedNotionalUsd;
  const chargeUsd = hedgeCostUsd * markup;
  const marginUsd = chargeUsd - hedgeCostUsd;
  const feePctOfStake = atRiskUsd > 0 ? chargeUsd / atRiskUsd : 0;
  const feePctOfNotional = protectedNotionalUsd > 0 ? chargeUsd / protectedNotionalUsd : 0;
  const recoveryRatio = chargeUsd > 0 ? spreadMaxPayoutUsd / chargeUsd : 0;

  const triggerBtcMovePct = ((K_long - input.btcAtOpen) / input.btcAtOpen) * 100;
  const maxPayoutBtcMovePct = ((K_short - input.btcAtOpen) / input.btcAtOpen) * 100;

  // ── User EV under BS measure ──────────────────────────────────────────────
  // Expected payout under risk-neutral measure ≈ pre-widener BS spread cost.
  // (We back out the "fair" cost by removing the bid-ask widener on synthetic
  // pricing, or use the mark-mid for live pricing.)
  const evExpectedPayout = pricingSource === "bs_synthetic"
    ? hedgeCostUsd / (1 + cfg.bidAskWidener)
    : hedgeCostUsd;  // For live, mid-of-bid-ask is approximately the EV
  const userEvUsd = evExpectedPayout - chargeUsd;

  return {
    tier: input.tier,
    hedgeable: true,
    instrument,
    pricingSource,
    K_long, K_short, spreadWidth,
    atRiskUsd,
    protectedNotionalUsd,
    hedgeCostUsd,
    markup,
    chargeUsd,
    marginUsd,
    feePctOfStake,
    feePctOfNotional,
    spreadMaxPayoutUsd,
    recoveryRatio,
    triggerBtcMovePct,
    maxPayoutBtcMovePct,
    userEvUsd,
    userEvPctOfStake: atRiskUsd > 0 ? userEvUsd / atRiskUsd : 0,
  };
}

function bsSyntheticCost(
  cfg: TierConfig,
  input: QuoteInput,
  instrument: "put" | "call",
  K_long: number,
  K_short: number,
  protectedNotionalUsd: number,
): number {
  const T = input.tenorDays / 365;
  const atmIv = input.rvol * cfg.ivOverRvol;
  const otmLong = Math.abs(K_long - input.btcAtOpen) / input.btcAtOpen;
  const otmShort = Math.abs(K_short - input.btcAtOpen) / input.btcAtOpen;
  const ivLong = atmIv + cfg.skewSlope * otmLong;
  const ivShort = atmIv + cfg.skewSlope * otmShort;
  const netPerBtcSpot = instrument === "put"
    ? putSpreadCost(input.btcAtOpen, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort)
    : callSpreadCost(input.btcAtOpen, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort);
  // BS price is in USD per BTC of notional; multiply by widener and scale.
  return netPerBtcSpot * (1 + cfg.bidAskWidener) * (protectedNotionalUsd / input.btcAtOpen);
}

function makeNotHedgeable(
  input: QuoteInput, _cfg: TierConfig, markup: number,
  atRiskUsd: number, protectedNotionalUsd: number, reason: string,
): TierQuote {
  return {
    tier: input.tier,
    hedgeable: false,
    notHedgeableReason: reason,
    instrument: "none",
    pricingSource: "not_hedgeable",
    K_long: 0, K_short: 0, spreadWidth: 0,
    atRiskUsd, protectedNotionalUsd: 0,
    hedgeCostUsd: 0, markup, chargeUsd: 0, marginUsd: 0,
    feePctOfStake: 0, feePctOfNotional: 0,
    spreadMaxPayoutUsd: 0, recoveryRatio: 0,
    triggerBtcMovePct: 0, maxPayoutBtcMovePct: 0,
    userEvUsd: 0, userEvPctOfStake: 0,
  };
}

// ─── Settlement ──────────────────────────────────────────────────────────────

export type TierOutcome = {
  tier: TierName;
  hedgeTriggered: boolean;
  spreadPayoutUsd: number;
  /** Kept for CSV compatibility with prior runs. Always 0 in this product. */
  shieldPayoutUsd: number;
  totalPayoutUsd: number;
  kalshiPnlUsd: number;
  userNetWithProtectionUsd: number;
  userSavedUsd: number;
  recoveryPctOfStake: number;
  platformRevenueUsd: number;
  platformHedgeCostUsd: number;
  /** Always 0 — no NO leg, no Kalshi fee in this product. */
  platformKalshiFeePaidUsd: number;
  platformTpRecoveryUsd: number;
  platformNetPnlUsd: number;
};

export type OutcomeInput = {
  quote: TierQuote;
  eventType: EventType;
  userDirection: UserDirection;
  yesPrice: number;
  betSizeUsd: number;
  kalshiOutcome: "yes" | "no";
  btcAtOpen: number;
  btcAtSettle: number;
};

export function settleTier(input: OutcomeInput): TierOutcome {
  const q = input.quote;
  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRisk = userPriceFrac * input.betSizeUsd;
  const userWon = input.kalshiOutcome === input.userDirection;
  const kalshiPnl = userWon ? input.betSizeUsd - atRisk : -atRisk;

  if (!q.hedgeable) {
    return {
      tier: q.tier, hedgeTriggered: false,
      spreadPayoutUsd: 0, shieldPayoutUsd: 0, totalPayoutUsd: 0,
      kalshiPnlUsd: kalshiPnl,
      userNetWithProtectionUsd: kalshiPnl,
      userSavedUsd: 0, recoveryPctOfStake: 0,
      platformRevenueUsd: 0, platformHedgeCostUsd: 0,
      platformKalshiFeePaidUsd: 0, platformTpRecoveryUsd: 0, platformNetPnlUsd: 0,
    };
  }

  // Spread payout depends on instrument and BTC at settle
  let spreadPayoutUsd = 0;
  if (q.instrument === "put" && q.spreadWidth > 0) {
    spreadPayoutUsd = putSpreadPayout(q.K_long, q.K_short, input.btcAtOpen, input.btcAtSettle, q.protectedNotionalUsd);
  } else if (q.instrument === "call" && q.spreadWidth > 0) {
    spreadPayoutUsd = callSpreadPayout(q.K_long, q.K_short, input.btcAtOpen, input.btcAtSettle, q.protectedNotionalUsd);
  }

  // TP recovery: 20% generic salvage on un-triggered spreads (mid-life
  // residual value). Conservative, parameterless.
  const tpRecoveryFrac = 0.20;
  const tpRecoveryUsd = (q.hedgeCostUsd > 0 && spreadPayoutUsd === 0)
    ? q.hedgeCostUsd * tpRecoveryFrac
    : 0;

  const totalPayoutUsd = spreadPayoutUsd;
  const userNet = kalshiPnl - q.chargeUsd + totalPayoutUsd;
  const platformNet = q.chargeUsd - q.hedgeCostUsd + tpRecoveryUsd;

  return {
    tier: q.tier,
    hedgeTriggered: spreadPayoutUsd > 0,
    spreadPayoutUsd, shieldPayoutUsd: 0, totalPayoutUsd,
    kalshiPnlUsd: kalshiPnl,
    userNetWithProtectionUsd: userNet,
    userSavedUsd: userNet - kalshiPnl,
    recoveryPctOfStake: atRisk > 0 ? totalPayoutUsd / atRisk : 0,
    platformRevenueUsd: q.chargeUsd,
    platformHedgeCostUsd: q.hedgeCostUsd,
    platformKalshiFeePaidUsd: 0,
    platformTpRecoveryUsd: tpRecoveryUsd,
    platformNetPnlUsd: platformNet,
  };
}
