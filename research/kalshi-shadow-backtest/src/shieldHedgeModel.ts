/**
 * Shield protection model — deterministic-floor variant.
 *
 * RELATIONSHIP TO PRIOR MODELS:
 *   - v1 hedgeModel.ts:        single-tier, Foxify-prior put spread.
 *   - v2 tieredHedgeModel.ts:  two-tier put spreads (Lite, Standard).
 *   - v3 (this file):          adds a deterministic-floor mechanism that
 *                              pays a fixed rebate on any losing Kalshi
 *                              outcome, regardless of BTC path.
 *
 * Why a separate file: the put-spread machinery is BTC-state-dependent
 * (payoff = f(BTC)). Shield is Kalshi-outcome-dependent (payoff = $R if
 * YES loses, else 0). Different math, different operational requirements.
 *
 * MECHANISM:
 *   On a Kalshi YES contract with YES priced at y (cents, 0-100):
 *     - User stake = (y/100) × face value
 *     - NO contract trades at (100 - y) cents and pays $1 if YES loses
 *     - To deliver a fixed $R rebate on YES-loss, Atticus buys $R of NO
 *       face value at cost R × (100 - y)/100
 *     - Charge to user = NO cost × markup (Foxify-style 1.40-1.45×)
 *     - Cash flow: YES loses → Atticus collects $R from Kalshi → pays $R
 *       to user. Atticus net = charge − NO cost (deterministic margin).
 *
 *   This is a *contract-deterministic* floor. There is no path-dependency.
 *   The only failure mode is Kalshi counterparty risk, which is the same
 *   counterparty risk the user already takes by depositing on Kalshi.
 *
 * SHIELD+ (HYBRID):
 *   Combines the NO leg (deterministic floor) with a smaller put spread
 *   (variable upside on BTC drops). The NO leg gives the institutional
 *   "max-loss is bounded" story; the put spread gives the retail
 *   "double rebate when BTC clearly moves against you" story.
 *
 * KALSHI FEE ASSUMPTION:
 *   Kalshi charges variable fees on net winnings (typical 1-7% depending
 *   on contract). For pure-NO-leg Shield, Atticus pays the fee on the NO
 *   payout when it wins. We model this as a 3% effective fee on payout
 *   (mid-range; tunable per contract).
 *
 * COUNTERPARTY-RISK DISCLOSURE:
 *   The Shield "guarantee" is a contractual commitment: Atticus collects
 *   the NO payout from Kalshi and forwards it to the user. The user's
 *   exposure is therefore Kalshi's settlement reliability + Atticus's
 *   solvency on the floor. The structure does NOT add credit risk beyond
 *   what the user already accepts by holding a Kalshi contract.
 *
 * ISOLATION:
 *   Imports nothing from services/api, services/hedging, packages/shared,
 *   or any other live Foxify pilot code. Imports only from sibling files
 *   in this research package. Cannot affect the live pilot.
 */

import { bsPut, impliedVolFromRealized, ivForMoneyness, putSpreadPayout } from "./math.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Pure-NO-leg Shield: deterministic rebate floor, no BTC exposure.
 */
export type ShieldConfig = {
  kind: "shield";
  /**
   * Deterministic rebate floor as a fraction of the user's at-risk stake.
   * 0.25 = "guaranteed 25% of stake back on any losing Kalshi outcome".
   */
  rebateFloorFracOfStake: number;
  /** Markup on Atticus's NO leg cost. */
  markup: number;
  /** Effective Kalshi fee on the NO payout (when YES loses). */
  kalshiFeeOnPayout: number;
};

/**
 * Shield+ hybrid: NO leg (deterministic floor) + put spread (BTC upside).
 * Used to deliver a smaller deterministic floor PLUS additional payout
 * when BTC moves materially against the user.
 */
export type ShieldPlusConfig = {
  kind: "shieldPlus";
  rebateFloorFracOfStake: number;
  /** Long-put strike as fraction below entry (the BTC overlay). */
  longOtmPct: number;
  shortOtmPct: number;
  /** Sizing multiplier on the BTC put-spread leg (× at-risk amount). */
  putSpreadSizingMultiplier: number;
  markup: number;
  kalshiFeeOnPayout: number;
  riskFreeRate: number;
};

// ─── Quote ───────────────────────────────────────────────────────────────────

export type ShieldQuote = {
  kind: "shield";
  rebateFloorUsd: number;        // Fixed dollar rebate user gets on loss
  noLegFaceUsd: number;          // Atticus's NO contract face value purchased
  noLegCostUsd: number;          // Atticus's actual cost (face × NO price)
  hedgeCostUsd: number;          // = noLegCostUsd (no other legs)
  chargeUsd: number;             // What user pays
  marginUsd: number;             // chargeUsd - hedgeCostUsd - expectedKalshiFee
  atRiskUsd: number;
  feePctOfStake: number;
  worstCaseLossUsd: number;      // Max possible realised loss for user
  worstCaseLossFracOfStake: number;
};

export type ShieldPlusQuote = {
  kind: "shieldPlus";
  rebateFloorUsd: number;
  noLegFaceUsd: number;
  noLegCostUsd: number;
  // Put-spread leg
  K_long: number;
  K_short: number;
  spreadWidthUsd: number;
  putSpreadCostUsd: number;
  putSpreadProtectedNotionalUsd: number;
  // Aggregate
  hedgeCostUsd: number;          // = noLegCostUsd + putSpreadCostUsd
  chargeUsd: number;
  marginUsd: number;
  atRiskUsd: number;
  feePctOfStake: number;
  worstCaseLossUsd: number;      // = stake - rebateFloor + chargeUsd (BTC=open case is worst)
  worstCaseLossFracOfStake: number;
  maxPayoutUsd: number;          // Total potential payout (NO + put spread max)
};

// ─── Quote functions ─────────────────────────────────────────────────────────

export function quoteShield(params: {
  cfg: ShieldConfig;
  yesPrice: number;        // 0-100 cents
  betSizeUsd: number;
}): ShieldQuote {
  const atRiskUsd = (params.yesPrice / 100) * params.betSizeUsd;
  const rebateFloorUsd = atRiskUsd * params.cfg.rebateFloorFracOfStake;

  // Buy $rebateFloor of NO face value. Cost = face × NO_price.
  // NO price (cents) = 100 - yesPrice, so cost fraction = (100-yes)/100.
  const noPriceFrac = (100 - params.yesPrice) / 100;
  const noLegFaceUsd = rebateFloorUsd;  // Face = payout
  const noLegCostUsd = noLegFaceUsd * noPriceFrac;

  // Expected Kalshi fee on payout (paid by Atticus, in expectation):
  // We assume Atticus absorbs this; included in the cost basis for charging.
  const expectedKalshiFee = noLegFaceUsd * params.cfg.kalshiFeeOnPayout
    * (params.yesPrice / 100);  // Probability-weighted by P(YES loses) ≈ NO price
  // Note: Kalshi fee actually only paid if NO wins. P(NO wins) = (100-yes)/100,
  // not yes/100. Correcting:
  const expectedKalshiFeeCorrected = noLegFaceUsd * params.cfg.kalshiFeeOnPayout
    * noPriceFrac;

  const hedgeCostUsd = noLegCostUsd + expectedKalshiFeeCorrected;
  const chargeUsd = hedgeCostUsd * params.cfg.markup;
  const marginUsd = chargeUsd - hedgeCostUsd;

  // Worst case for user: pay charge, Kalshi YES loses, get rebate back.
  // worstLoss = stake - rebateFloor + chargeUsd (i.e. you keep paying chargeUsd
  // out of pocket on top of the net loss after rebate).
  const worstCaseLossUsd = atRiskUsd - rebateFloorUsd + chargeUsd;

  return {
    kind: "shield",
    rebateFloorUsd,
    noLegFaceUsd,
    noLegCostUsd,
    hedgeCostUsd,
    chargeUsd,
    marginUsd,
    atRiskUsd,
    feePctOfStake: chargeUsd / atRiskUsd,
    worstCaseLossUsd,
    worstCaseLossFracOfStake: worstCaseLossUsd / atRiskUsd,
  };
}

export function quoteShieldPlus(params: {
  cfg: ShieldPlusConfig;
  yesPrice: number;
  betSizeUsd: number;
  btcAtOpen: number;
  rvol: number;
  tenorDays: number;
}): ShieldPlusQuote {
  const atRiskUsd = (params.yesPrice / 100) * params.betSizeUsd;
  const rebateFloorUsd = atRiskUsd * params.cfg.rebateFloorFracOfStake;

  // NO leg
  const noPriceFrac = (100 - params.yesPrice) / 100;
  const noLegFaceUsd = rebateFloorUsd;
  const noLegCostUsd = noLegFaceUsd * noPriceFrac;
  const expectedKalshiFee = noLegFaceUsd * params.cfg.kalshiFeeOnPayout * noPriceFrac;

  // Put-spread leg
  const T = params.tenorDays / 365;
  const K_long = params.btcAtOpen * (1 - params.cfg.longOtmPct);
  const K_short = params.btcAtOpen * (1 - params.cfg.shortOtmPct);
  const spreadWidthUsd = K_long - K_short;

  const atm_iv = impliedVolFromRealized(params.rvol);
  const ivLong = ivForMoneyness(atm_iv, params.cfg.longOtmPct);
  const ivShort = ivForMoneyness(atm_iv, params.cfg.shortOtmPct);
  const longPx = bsPut(params.btcAtOpen, K_long, T, params.cfg.riskFreeRate, ivLong);
  const shortPx = bsPut(params.btcAtOpen, K_short, T, params.cfg.riskFreeRate, ivShort);
  const netPxPerBtc = Math.max(0, longPx - shortPx);
  const spreadCostFracOfProtected = netPxPerBtc / params.btcAtOpen;

  const putSpreadProtectedNotionalUsd = atRiskUsd * params.cfg.putSpreadSizingMultiplier;
  const putSpreadCostUsd = putSpreadProtectedNotionalUsd * spreadCostFracOfProtected;
  const putSpreadMaxPayoutUsd = (spreadWidthUsd / params.btcAtOpen) * putSpreadProtectedNotionalUsd;

  // Aggregate
  const hedgeCostUsd = noLegCostUsd + expectedKalshiFee + putSpreadCostUsd;
  const chargeUsd = hedgeCostUsd * params.cfg.markup;
  const marginUsd = chargeUsd - hedgeCostUsd;

  // Worst case: BTC ends exactly at open (put spread = $0), Kalshi loses,
  // user gets rebate, pays charge.
  // worstLoss = stake - rebateFloor + chargeUsd
  const worstCaseLossUsd = atRiskUsd - rebateFloorUsd + chargeUsd;

  return {
    kind: "shieldPlus",
    rebateFloorUsd,
    noLegFaceUsd,
    noLegCostUsd,
    K_long,
    K_short,
    spreadWidthUsd,
    putSpreadCostUsd,
    putSpreadProtectedNotionalUsd,
    hedgeCostUsd,
    chargeUsd,
    marginUsd,
    atRiskUsd,
    feePctOfStake: chargeUsd / atRiskUsd,
    worstCaseLossUsd,
    worstCaseLossFracOfStake: worstCaseLossUsd / atRiskUsd,
    maxPayoutUsd: rebateFloorUsd + putSpreadMaxPayoutUsd,
  };
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

export type ShieldOutcome = {
  kind: "shield";
  hedgeTriggered: boolean;       // True iff Kalshi YES lost (NO won)
  shieldPayoutUsd: number;       // = rebateFloorUsd if YES lost, else 0
  putSpreadPayoutUsd: number;    // 0 for pure Shield (no put leg)
  totalPayoutUsd: number;
  kalshiPnlUsd: number;
  userNetWithProtectionUsd: number;
  userSavedUsd: number;
  recoveryPctOfStake: number;
  platformRevenueUsd: number;
  platformHedgeCostUsd: number;
  platformKalshiFeeUsd: number;  // Realized fee paid to Kalshi on NO win
  platformNetPnlUsd: number;
};

export type ShieldPlusOutcome = ShieldOutcome & { kind: "shieldPlus" };

export function computeShieldOutcome(params: {
  quote: ShieldQuote;
  kalshiOutcome: "yes" | "no";
  yesPrice: number;
  betSizeUsd: number;
  cfg: ShieldConfig;
}): ShieldOutcome {
  const atRisk = (params.yesPrice / 100) * params.betSizeUsd;
  const yesWon = params.kalshiOutcome === "yes";
  const kalshiPnl = yesWon ? params.betSizeUsd - atRisk : -atRisk;

  const shieldPayoutUsd = yesWon ? 0 : params.quote.rebateFloorUsd;
  const totalPayoutUsd = shieldPayoutUsd;

  const userNet = kalshiPnl - params.quote.chargeUsd + totalPayoutUsd;
  const userSaved = userNet - kalshiPnl;

  // Realized Kalshi fee: only when NO wins (YES loses)
  const platformKalshiFee = yesWon ? 0 : params.quote.noLegFaceUsd * params.cfg.kalshiFeeOnPayout;

  // Platform: collect charge, paid NO cost upfront. NO payout cancels
  // shield payout to user (cash flow pass-through). Net = charge - NO cost
  // - realized Kalshi fee.
  const platformNet = params.quote.chargeUsd - params.quote.noLegCostUsd - platformKalshiFee;

  return {
    kind: "shield",
    hedgeTriggered: !yesWon,
    shieldPayoutUsd,
    putSpreadPayoutUsd: 0,
    totalPayoutUsd,
    kalshiPnlUsd: kalshiPnl,
    userNetWithProtectionUsd: userNet,
    userSavedUsd: userSaved,
    recoveryPctOfStake: atRisk > 0 ? totalPayoutUsd / atRisk : 0,
    platformRevenueUsd: params.quote.chargeUsd,
    platformHedgeCostUsd: params.quote.noLegCostUsd,
    platformKalshiFeeUsd: platformKalshiFee,
    platformNetPnlUsd: platformNet,
  };
}

export function computeShieldPlusOutcome(params: {
  quote: ShieldPlusQuote;
  cfg: ShieldPlusConfig;
  kalshiOutcome: "yes" | "no";
  yesPrice: number;
  betSizeUsd: number;
  btcAtOpen: number;
  btcAtSettle: number;
}): ShieldPlusOutcome {
  const atRisk = (params.yesPrice / 100) * params.betSizeUsd;
  const yesWon = params.kalshiOutcome === "yes";
  const kalshiPnl = yesWon ? params.betSizeUsd - atRisk : -atRisk;

  const shieldPayoutUsd = yesWon ? 0 : params.quote.rebateFloorUsd;
  const putSpreadPayoutUsd = putSpreadPayout(
    params.quote.K_long,
    params.quote.K_short,
    params.btcAtOpen,
    params.btcAtSettle,
    params.quote.putSpreadProtectedNotionalUsd,
  );
  const totalPayoutUsd = shieldPayoutUsd + putSpreadPayoutUsd;

  const userNet = kalshiPnl - params.quote.chargeUsd + totalPayoutUsd;
  const userSaved = userNet - kalshiPnl;

  const platformKalshiFee = yesWon ? 0 : params.quote.noLegFaceUsd * params.cfg.kalshiFeeOnPayout;

  // Platform net: charge - all hedge costs - realized Kalshi fee.
  // Both legs (NO + put spread) are pass-through — payouts cancel between
  // Atticus's positions and user's protection delivery.
  const platformNet = params.quote.chargeUsd
    - params.quote.noLegCostUsd
    - params.quote.putSpreadCostUsd
    - platformKalshiFee;

  return {
    kind: "shieldPlus",
    hedgeTriggered: !yesWon || putSpreadPayoutUsd > 0,
    shieldPayoutUsd,
    putSpreadPayoutUsd,
    totalPayoutUsd,
    kalshiPnlUsd: kalshiPnl,
    userNetWithProtectionUsd: userNet,
    userSavedUsd: userSaved,
    recoveryPctOfStake: atRisk > 0 ? totalPayoutUsd / atRisk : 0,
    platformRevenueUsd: params.quote.chargeUsd,
    platformHedgeCostUsd: params.quote.noLegCostUsd + params.quote.putSpreadCostUsd,
    platformKalshiFeeUsd: platformKalshiFee,
    platformNetPnlUsd: platformNet,
  };
}

// ─── Tier configs ────────────────────────────────────────────────────────────
// Ready-made configurations consumed by mainTiered.ts.

export const SHIELD_CONFIG: ShieldConfig = {
  // Pure money-back-guarantee tier.
  // 40% of stake guaranteed back on any losing Kalshi outcome.
  //
  // Calibration math (typical $58 stake, YES @ 58¢):
  //   NO leg face = $58 × 0.40 = $23.20
  //   NO leg cost = $23.20 × 0.42 = $9.74 (NO price)
  //   Kalshi fee  = $23.20 × 0.03 × 0.42 ≈ $0.29 expected
  //   Total cost  ≈ $10.03
  //   Charge      = $10.03 × 1.40 = $14.04 (~24% of stake)
  //   Worst case  = $58 - $23.20 + $14.04 = $48.84 = ~84% of stake
  //
  // We use markup = 1.40 (not 1.45) to keep the fee modest. 40% floor is the
  // smallest cleanly-marketable "real money back" promise; 30% leaves worst
  // case ~95% which barely improves B1, and 50% pushes fee past 25% of stake
  // which feels expensive even with the institutional pitch.
  kind: "shield",
  rebateFloorFracOfStake: 0.40,
  markup: 1.40,
  kalshiFeeOnPayout: 0.03,
};

export const SHIELD_PLUS_CONFIG: ShieldPlusConfig = {
  // Hybrid: 30% NO-leg deterministic floor + smaller put-spread overlay.
  //
  // Design intent:
  //   The NO leg gives the institutional "max-loss bounded" story.
  //   The put-spread overlay gives extra payout on BTC-down-AND-Kalshi-loss
  //   joint events — historically the worst tail months. Since the floor
  //   already kicks in on every losing market, the put spread is a
  //   *concentrated* upside add-on, not a primary protection mechanism.
  //
  // We use a tighter put spread (5% OTM long, 25% OTM short, 1.0× sizing)
  // so that the put-spread overhead doesn't dominate the fee. The headline
  // is: "30% guaranteed back on every loss, plus another 0-20% if BTC fell."
  kind: "shieldPlus",
  rebateFloorFracOfStake: 0.30,
  longOtmPct: 0.05,
  shortOtmPct: 0.25,
  putSpreadSizingMultiplier: 1.0,
  markup: 1.40,
  kalshiFeeOnPayout: 0.03,
  riskFreeRate: 0.045,
};
