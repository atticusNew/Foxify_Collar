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

// Tier names retained for backward-compat with prior CSV/main schema.
// Light is intentionally degenerate (zero sizing, used as a control row that
// produces $0 economics). Live product surface is Standard + Shield only.
export type TierName = "lite" | "standard" | "shield" | "shield_plus";

export type TierConfig = {
  description: string;
  /**
   * Strike geometry. Long-leg position is expressed as OTM-from-spot (BTC
   * underlying), NOT OTM-from-Kalshi-barrier. This is critical for retail-
   * tuned tiers because BTC's actual *price path* matters more than the
   * Kalshi barrier for whether the spread pays — a Kalshi "BTC > $80k" bet
   * when BTC is at $79k loses if BTC stays at $79k, but a 5%-OTM-from-spot
   * put would never trigger. We need ATM-from-spot for those cases.
   *
   *   0.0  = long leg at-the-money (max cost, max protection from any move)
   *   0.02 = long leg 2% OTM from spot (slightly cheaper)
   *
   * For PUT spreads, "OTM from spot" means below current spot.
   * For CALL spreads, "OTM from spot" means above current spot.
   */
  longOtmFromSpotFrac: number;
  /** Width of spread as fraction of spot (caps max payout). */
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
 * TIERS — retail-tuned for typical Kalshi BTC stakes ($35-60).
 *
 *   Light tier is now deprecated (zero-sizing control row); live product
 *   surface is Standard and Shield only. Shield-Max retained as the high-end
 *   variant (2× sizing) for tail-event recovery on institutional accounts.
 *
 * SIZING CALIBRATION (the central knob):
 *   Each tier's `sizingMultiplier` controls the protected BTC notional as a
 *   multiple of the user's at-risk stake. Higher sizing → bigger payout per
 *   adverse BTC %, but higher fee.
 *
 *   For a 30-DTE BTC vertical spread:
 *     spread cost ≈ 4-5% of notional (Standard, 2%-OTM/8% width)
 *                ≈ 6-7% of notional (Shield, ATM/10% width)
 *     payout per 1% adverse BTC move ≈ 1% of notional
 *
 *   With markup 1.22 and BTC down 12-15% (typical losing-month tail):
 *     Standard sizing 2.5× → fee ~12% of stake, payout on 12% drop
 *                           ≈ 2.5 × 12% × stake = 30% of stake ✓ in target
 *     Shield  sizing 1.7× → fee ~17% of stake, payout on 12% drop
 *                          ≈ 1.7 × 10% (capped at width) × stake = 17%...
 *                          but on >10% drop, full width hits → 17% always.
 *                          Need higher sizing to hit 40-60% recovery target.
 *
 *   Targets per the trader-perspective brief:
 *     Standard: fee 10-15% / stake; rebate on BTC-down losers 30-40% / stake
 *     Shield:   fee 15-20% / stake; rebate on BTC-down losers 40-60% / stake
 */
export const TIER_CONFIGS: Record<TierName, TierConfig> = {
  // Deprecated control row — zero-sizing, contributes no economics. Kept in
  // the schema so the CSV/aggregator code paths don't need to change.
  lite: {
    ...COMMON,
    description: "(deprecated control row — not offered as a live product)",
    longOtmFromSpotFrac: 0.0,
    spreadWidthFrac: 0.0,
    sizingMultiplier: 0.0,
  },
  // Standard: retail "real money back" tier.
  // Target per user PRD: fee target 15% (hard cap 16%), avg rebate 30-35%.
  // 2%-OTM-from-spot, 5% width, 6.5× sizing (slightly tightened from 7×
  // per user feedback — smooths tails without dropping below 30%).
  standard: {
    ...COMMON,
    description: "Standard: 2%-OTM-from-spot put/call, 5% width, 6.5× sized. Fee ~14% of stake; rebate ~28-35% of stake on BTC-adverse losing months.",
    longOtmFromSpotFrac: 0.02,
    spreadWidthFrac: 0.05,
    sizingMultiplier: 6.5,
  },
  // Shield: retail "insured bet" tier.
  // Target per user PRD: fee target 18% (hard cap 20%), avg rebate 35-40%.
  // 1%-OTM-from-spot, 6% width, 7× sizing (kept at 7× — empirically
  // dropping to 6.5× shaves recovery below 35% before fee falls meaningfully).
  shield: {
    ...COMMON,
    description: "Shield: 1%-OTM-from-spot put/call, 6% width, 7× sized. Fee ~18-19% of stake; rebate ~35-42% of stake on BTC-adverse losing months.",
    longOtmFromSpotFrac: 0.01,
    spreadWidthFrac: 0.06,
    sizingMultiplier: 7.0,
  },
  // Shield-Max: institutional / treasury variant.
  // ATM, 8% width, 12× sizing. Recovery cap = 96% of stake.
  shield_plus: {
    ...COMMON,
    description: "Shield-Max: ATM-from-spot put/call, 8% width, 12× sized. For institutional/treasury accounts. Fee ~30-40% of stake; rebate up to ~95% of stake.",
    longOtmFromSpotFrac: 0.0,
    spreadWidthFrac: 0.08,
    sizingMultiplier: 12.0,
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

  // ── Strike selection (spot-anchored) ──────────────────────────────────────
  // Long leg is X% OTM from current SPOT, not from the Kalshi barrier.
  // This ensures the spread engages on actual BTC moves regardless of where
  // the Kalshi barrier sits relative to spot.
  let K_long: number, K_short: number;
  if (instrument === "put") {
    K_long = input.btcAtOpen * (1 - cfg.longOtmFromSpotFrac);
    K_short = K_long - input.btcAtOpen * cfg.spreadWidthFrac;
  } else {
    K_long = input.btcAtOpen * (1 + cfg.longOtmFromSpotFrac);
    K_short = K_long + input.btcAtOpen * cfg.spreadWidthFrac;
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
