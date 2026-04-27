/**
 * Unified hedge engine for the Kalshi rebuild — production-shape product.
 *
 * DESIGN GOALS (post-redesign):
 *
 *   1. Every market gets a quote at SOME achievable W. If the user's preferred
 *      tier (e.g. Shield, target W=70%) is infeasible for a given market
 *      because q × markup × (1+f) ≥ 1, the engine **falls back automatically**
 *      to the tightest feasible W ≥ target. The user's quote shows
 *      `effectiveW` so they know exactly what worst-case they're locking in.
 *
 *      No more silent NOT_OFFERED. No "sometimes Shield doesn't work."
 *
 *   2. User EV is computed and reported alongside fee. Format:
 *      "Pay $X fee. On loss (P(loss) = q), recover $R. EV cost = $X − q×R."
 *
 *   3. TP recovery on un-triggered Deribit overlays is modeled generically
 *      (no Foxify table). A 30-day BTC option spread that doesn't end in
 *      the money still has time-decay residual value mid-life. We use
 *      `tpRecoveryFrac × spreadHedgeCost` where tpRecoveryFrac is conservative
 *      (default 0.20 — i.e. recover 20% of paid premium on un-triggered).
 *      This is replaceable per-tier and is not derived from any pilot.
 *
 *   4. Markup is derived from a target net margin band, not picked.
 *      `markup = 1 / (1 - targetNetMargin - opCostFrac)`
 *      where opCostFrac is the fraction of revenue spent on operations
 *      (Kalshi fees on Atticus's leg, Deribit fees, infra). Default
 *      targetNetMargin=0.20, opCostFrac=0.05 → markup ≈ 1.33×.
 *
 *   5. NO_LEG_FEASIBILITY is an honest flag, not an offer flag. A market
 *      where `q × markup × (1+f) ≥ 1 + epsilon` cannot have a NO-leg
 *      protection of any positive face value; in that case the tier
 *      degrades to "spread overlay only" or to a higher W until feasible.
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

  // ─── Pricing parameters ───────────────────────────────────────────────────
  /** Risk-free rate for BS pricing. */
  riskFreeRate: number;
  /** Bid-ask widener as fraction of theoretical (e.g. 0.05 = +5% to net cost). */
  bidAskWidener: number;
  /** Vol risk premium scalar applied to rvol to estimate IV. */
  ivOverRvol: number;
  /** Skew slope: vol-pts added per unit OTM. */
  skewSlope: number;

  // ─── Markup derivation ────────────────────────────────────────────────────
  /**
   * Target NET margin (after operating costs). Markup is derived:
   *   markup = 1 / (1 - targetNetMargin - opCostFrac)
   * Default 0.20 = "20% net margin per trade after ops costs."
   */
  targetNetMargin: number;
  /**
   * Operating-cost fraction of revenue (Kalshi fees on Atticus's leg,
   * Deribit fees, infra, settlement gas). Default 0.05.
   */
  opCostFrac: number;

  // ─── Tier shape ───────────────────────────────────────────────────────────
  /**
   * TARGET worst-case loss as fraction of stake. The engine tries to
   * deliver this; if infeasible for a market it FALLS BACK to the tightest
   * achievable W ≥ targetW (graceful degradation). User receives quote
   * with `effectiveW` populated.
   *
   * 1.0 = no NO leg requested (pure overlay product, e.g. legacy Light/Std).
   */
  targetWorstCaseFracOfStake: number;
  /**
   * Sizing multiplier on the Deribit-leg notional (× user at-risk amount).
   * 0 = no overlay. 1.0 = matched. >1 = leveraged for tail upside.
   */
  putCallSizingMultiplier: number;
  /**
   * TP-recovery fraction on un-triggered Deribit overlays. Conservative
   * generic estimate of mid-life option-spread residual value. Default 0.20.
   *
   * Set to 0 for the most conservative platform-margin number; 0.20 is more
   * realistic for actual operations.
   */
  tpRecoveryFrac: number;

  // ─── Kalshi-side ──────────────────────────────────────────────────────────
  /** Effective Kalshi fee on NO win (typical 0.01-0.07). */
  kalshiFeeOnPayout: number;
};

/** Compute the effective markup from targetNetMargin + opCostFrac. */
function computeMarkup(cfg: TierConfig): number {
  const denom = 1 - cfg.targetNetMargin - cfg.opCostFrac;
  if (denom <= 0.05) return 2.0;
  return 1 / denom;
}

export type TierQuote = {
  tier: TierName;
  /** True iff this tier could be priced at any feasible W (always true after degradation). */
  offered: boolean;
  /**
   * The actual W achieved after degradation. May be ≥ tier's `targetWorstCaseFracOfStake`.
   * If equal to target, no degradation occurred. If 1.0, no NO leg was feasible
   * and the tier delivers only the spread overlay (or nothing).
   */
  effectiveW: number;
  /** True if effectiveW > target (i.e. the tier degraded for this market). */
  degraded: boolean;
  degradationReason?: string;

  instrument: HedgeInstrument;
  K_long: number;
  K_short: number;
  spreadWidth: number;

  protectedNotionalUsd: number;
  spreadHedgeCostUsd: number;
  noLegFaceUsd: number;
  noLegCostUsd: number;
  expectedKalshiFeeUsd: number;
  totalHedgeCostUsd: number;
  /** Markup actually applied (derived from targetNetMargin + opCostFrac). */
  markup: number;
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

  // User EV (computed under the Kalshi yesPrice as the implied probability).
  // userEv = q × (rebate + spreadEvPayoutUsd) + (1 − q) × 0 − chargeUsd
  // (spreadEvPayoutUsd uses BS-implied expected payout under risk-neutral measure)
  userEvUsd: number;
  userEvPctOfStake: number;
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
  platformTpRecoveryUsd: number;
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

/**
 * Compute the Deribit overlay's spread cost + max payout + expected payout.
 * Returns null if no strikes were available (rare on the synthetic grid).
 */
function priceSpreadOverlay(
  cfg: TierConfig,
  input: QuoteInput,
  protectedNotionalUsd: number,
): {
  K_long: number; K_short: number; spreadWidth: number;
  hedgeCostUsd: number; maxPayoutUsd: number; expectedPayoutUsd: number;
} | null {
  if (protectedNotionalUsd <= 0) return null;
  const { instrument } = adaptHedgeInstrument(input.eventType, input.userDirection, input.barrier);
  if (instrument === "none") return null;

  const chain = buildSyntheticChain(input.btcAtOpen, input.tenorDays);
  let strikes: { K_long: number; K_short: number } | null = null;
  for (let offset = 0; offset < 8 && !strikes; offset++) {
    strikes = instrument === "call"
      ? findCallSpreadStrikes(chain, input.barrier, offset)
      : findPutSpreadStrikes(chain, input.barrier, offset);
  }
  if (!strikes) return null;

  const { K_long, K_short } = strikes;
  const spreadWidth = Math.abs(K_short - K_long);
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
  const hedgeCostUsd = protectedNotionalUsd * grossedCostFracOfBtc;
  const maxPayoutUsd = (spreadWidth / input.btcAtOpen) * protectedNotionalUsd;

  // Risk-neutral expected payout = BS-theoretical net cost / (1+widener).
  // Equivalently: expected payout under RN measure = the un-widened spread price.
  const expectedPayoutUsd = protectedNotionalUsd * (netPxPerBtc / input.btcAtOpen);

  return { K_long, K_short, spreadWidth, hedgeCostUsd, maxPayoutUsd, expectedPayoutUsd };
}

export function quoteTier(input: QuoteInput): TierQuote {
  const cfg = TIER_CONFIGS[input.tier];
  const markup = computeMarkup(cfg);

  // At-risk = cost of the user's position.
  const userPriceFrac = input.userDirection === "yes"
    ? input.yesPrice / 100
    : (100 - input.yesPrice) / 100;
  const atRiskUsd = userPriceFrac * input.betSizeUsd;
  // Loss-leg price = price of the opposite Kalshi side.
  const q = input.userDirection === "yes"
    ? (100 - input.yesPrice) / 100
    : input.yesPrice / 100;

  const protectedNotionalUsd = atRiskUsd * cfg.putCallSizingMultiplier;
  const { instrument } = adaptHedgeInstrument(input.eventType, input.userDirection, input.barrier);

  // ── Spread overlay (independent of rebate sizing) ─────────────────────────
  const spread = priceSpreadOverlay(cfg, input, protectedNotionalUsd);
  const K_long = spread?.K_long ?? 0;
  const K_short = spread?.K_short ?? 0;
  const spreadWidth = spread?.spreadWidth ?? 0;
  const spreadHedgeCostUsd = spread?.hedgeCostUsd ?? 0;
  const spreadMaxPayoutUsd = spread?.maxPayoutUsd ?? 0;
  const spreadExpectedPayoutUsd = spread?.expectedPayoutUsd ?? 0;

  // ── Solve for rebate with graceful W-degradation ──────────────────────────
  // The denominator (1 - q × m × (1+f)) determines feasibility.
  // If denom ≤ 0, the user's side is so cheap (favorite) and Atticus's side
  // (NO) so expensive that no finite rebate works. We degrade W toward 1.0
  // until either (a) the math is feasible AND rebate ≤ atRisk, or
  // (b) we reach W = 1.0 (no NO leg).
  const f = cfg.kalshiFeeOnPayout;
  const denom = 1 - q * markup * (1 + f);

  let effectiveW = cfg.targetWorstCaseFracOfStake;
  let rebateFloorUsd = 0;
  let degraded = false;
  let degradationReason: string | undefined;

  if (effectiveW < 1.0) {
    if (denom <= 0.02) {
      // Truly infeasible: user is on a long-shot, Atticus's NO leg costs too much.
      effectiveW = 1.0;
      degraded = true;
      degradationReason = `q×m×(1+f)=${(q * markup * (1 + f)).toFixed(2)} ≥ 1; NO leg infeasible — overlay only`;
    } else {
      // Try target W. If rebate > atRisk, walk W up until feasible.
      const tryW = (W: number) => (atRiskUsd * (1 - W) + spreadHedgeCostUsd * markup) / denom;
      let W = cfg.targetWorstCaseFracOfStake;
      let rebate = tryW(W);
      while (rebate > atRiskUsd && W < 0.99) {
        W = Math.min(0.99, W + 0.01);
        rebate = tryW(W);
      }
      if (rebate > atRiskUsd) {
        // Even at W=0.99, can't fit. Set W = 1.0 (no NO leg).
        effectiveW = 1.0;
        degraded = true;
        degradationReason = `even at W=0.99 rebate ${rebate.toFixed(2)} > stake ${atRiskUsd.toFixed(2)}`;
      } else {
        if (W > cfg.targetWorstCaseFracOfStake + 0.001) {
          degraded = true;
          degradationReason = `target W=${cfg.targetWorstCaseFracOfStake.toFixed(2)} infeasible; degraded to W=${W.toFixed(2)}`;
        }
        effectiveW = W;
        rebateFloorUsd = Math.max(0, rebate);
      }
    }
  }

  const noLegFaceUsd = rebateFloorUsd;
  const noLegCostUsd = noLegFaceUsd * q;
  const expectedKalshiFeeUsd = noLegFaceUsd * f * q;

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const totalHedgeCostUsd = spreadHedgeCostUsd + noLegCostUsd + expectedKalshiFeeUsd;
  const chargeUsd = totalHedgeCostUsd * markup;
  const marginUsd = chargeUsd - totalHedgeCostUsd;
  const totalMaxPayoutUsd = rebateFloorUsd + spreadMaxPayoutUsd;
  const worstCaseLossUsd = atRiskUsd - rebateFloorUsd + chargeUsd;

  // ── User EV (under Kalshi yesPrice as risk-neutral probability) ───────────
  // userEv = q × rebateFloorUsd + spreadExpectedPayoutUsd − chargeUsd
  // (q = P(user loses); rebate is paid only on user-loss; spread payout
  // is risk-neutral expectation independent of bet outcome.)
  const userEvUsd = q * rebateFloorUsd + spreadExpectedPayoutUsd - chargeUsd;

  return {
    tier: input.tier,
    offered: true,
    effectiveW,
    degraded,
    degradationReason,
    instrument,
    K_long, K_short, spreadWidth,
    protectedNotionalUsd,
    spreadHedgeCostUsd,
    noLegFaceUsd,
    noLegCostUsd,
    expectedKalshiFeeUsd,
    totalHedgeCostUsd,
    markup,
    chargeUsd,
    marginUsd,
    atRiskUsd,
    feePctOfStake: atRiskUsd > 0 ? chargeUsd / atRiskUsd : 0,
    rebateFloorUsd,
    spreadMaxPayoutUsd,
    totalMaxPayoutUsd,
    worstCaseLossUsd,
    worstCaseLossFracOfStake: atRiskUsd > 0 ? worstCaseLossUsd / atRiskUsd : 0,
    userEvUsd,
    userEvPctOfStake: atRiskUsd > 0 ? userEvUsd / atRiskUsd : 0,
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

  // (No early-return for "not offered" — every quote is now offered after
  // graceful W-degradation. If effectiveW = 1.0 and overlay is none, the
  // tier delivers no protection but is still "offered" with zero economics.)

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

  // TP recovery on un-triggered Deribit overlay: if the spread didn't pay,
  // Atticus can sell back the un-expired option(s) for a fraction of paid
  // premium. Conservative generic estimate (no Foxify table). Only applied
  // when there was a Deribit overlay AND it didn't pay out.
  const tpRecoveryUsd = (q.spreadHedgeCostUsd > 0 && spreadPayoutUsd === 0)
    ? q.spreadHedgeCostUsd * cfg.tpRecoveryFrac
    : 0;

  // Platform net = revenue − spread cost − NO cost − realized Kalshi fee
  //              + TP recovery on un-triggered overlays
  // (Both Deribit spread and Kalshi NO are pass-through: their payouts cancel
  // the user-facing rebates, so platform retains charge − costs + TP salvage.)
  const platformNet = q.chargeUsd
    - q.spreadHedgeCostUsd
    - q.noLegCostUsd
    - platformKalshiFeePaid
    + tpRecoveryUsd;

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
    platformTpRecoveryUsd: tpRecoveryUsd,
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
/**
 * Tier ladder. Each tier is a target-W product with graceful degradation:
 * if the target W can't be priced, the engine falls back to the tightest
 * achievable W ≥ target. EVERY market gets a quote at SOME effective W.
 *
 * Markup is derived from `targetNetMargin + opCostFrac`, not picked.
 *   Default: targetNetMargin=0.20, opCostFrac=0.05 → markup = 1/(1−0.25) = 1.333.
 *
 * Calibration intent:
 *   Light    target W=95%. Retail entry.   Cheap fee, modest floor.
 *   Standard target W=85%. Retail "real protection".
 *   Shield   target W=70%. Institutional bar (B1 threshold).
 *   Shield+  target W=70% + Deribit overlay for additional tail-upside cash.
 *
 * TP recovery on un-triggered overlays: 0.20 (conservative generic estimate;
 * no Foxify table). Set per tier.
 */
const COMMON: Pick<TierConfig,
  "riskFreeRate" | "bidAskWidener" | "ivOverRvol" | "skewSlope" |
  "targetNetMargin" | "opCostFrac" | "kalshiFeeOnPayout" | "tpRecoveryFrac"
> = {
  riskFreeRate: 0.045,
  bidAskWidener: 0.10,
  ivOverRvol: 1.18,
  skewSlope: 0.30,
  targetNetMargin: 0.20,   // 20% net margin per trade
  opCostFrac: 0.05,        // 5% revenue eaten by ops costs
  kalshiFeeOnPayout: 0.03, // 3% Kalshi fee on Atticus's NO win
  tpRecoveryFrac: 0.20,    // recover 20% of un-triggered overlay premium
};

export const TIER_CONFIGS: Record<TierName, TierConfig> = {
  lite: {
    ...COMMON,
    description: "Light: target worst-case 95% of stake. Cheapest tier; small but guaranteed rebate on every loss.",
    targetWorstCaseFracOfStake: 0.95,
    putCallSizingMultiplier: 0.0,
  },
  standard: {
    ...COMMON,
    description: "Standard: target worst-case 85%. Solid rebate (~15% of stake) on every loss.",
    targetWorstCaseFracOfStake: 0.85,
    putCallSizingMultiplier: 0.0,
  },
  shield: {
    ...COMMON,
    description: "Shield: target worst-case 70%. Institutional B1 threshold. ~30% guaranteed rebate where feasible.",
    targetWorstCaseFracOfStake: 0.70,
    putCallSizingMultiplier: 0.0,
  },
  shield_plus: {
    ...COMMON,
    description: "Shield-Max: target worst-case 60%. Tightest deterministic floor; reserved for institutional / treasury accounts where W=70% isn't tight enough.",
    targetWorstCaseFracOfStake: 0.60,
    putCallSizingMultiplier: 0.0,
  },
};
