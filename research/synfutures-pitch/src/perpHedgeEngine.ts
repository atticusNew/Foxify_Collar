/**
 * Perp protection engine for the SynFutures pitch backtest.
 *
 * MODELS TWO PRODUCT VARIANTS:
 *   1. Single-premium: trader pays once at entry for fixed-tenor protection
 *      (5, 7, or 14 days). If trade closes early, residual option value is
 *      refunded minus a small unwind fee.
 *   2. Day-rate (mechanism D, theta-following): trader is debited daily
 *      based on the option's current theta. Cancel anytime, refund residual.
 *
 * Both use a real Deribit BTC/ETH put-or-call vertical-spread as the
 * underlying hedge. The adapter chooses put for long perps (loss when BTC
 * drops), call for short perps (loss when BTC rises).
 *
 * Foxify-clean: no imports from any pilot path.
 */

import { putSpreadCost, callSpreadCost, putSpreadPayout, callSpreadPayout } from "./math.js";
import type { ChainSnapshot } from "./deribitClient.js";
import type { SyntheticPerpTrade } from "./syntheticPerpTrades.js";

// ─── Tier config ─────────────────────────────────────────────────────────────

export type ProductMode = "single_premium" | "day_rate";

export type TierConfig = {
  description: string;
  mode: ProductMode;
  longOtmFromSpotFrac: number;  // 0.02 = 2% OTM put long-leg (or call long-leg for shorts)
  spreadWidthFrac: number;      // fraction of spot
  sizingMultiplier: number;     // × user notional → protected notional
  hedgeTenorDays: number;       // 5, 7, 14 typical
  riskFreeRate: number;
  ivOverRvol: number;
  skewSlope: number;
  bidAskWidener: number;
  // Markup derivation
  targetNetMargin: number;
  opCostFrac: number;
  // Day-rate-specific
  earlyUnwindHaircutFrac: number;   // Atticus loses this much on bid-ask when selling residual back to Deribit
};

const COMMON: Pick<TierConfig,
  "riskFreeRate" | "ivOverRvol" | "skewSlope" | "bidAskWidener" |
  "targetNetMargin" | "opCostFrac" | "earlyUnwindHaircutFrac"
> = {
  riskFreeRate: 0.045,
  ivOverRvol: 1.10,           // calibrated against live Deribit (see kalshi calibration analysis)
  skewSlope: 0.20,
  bidAskWidener: 0.0,         // pricing already calibrated; explicit widener=0
  // 25% net margin + 5% ops cost → markup ~1.43×. Higher than Kalshi (13%)
  // because perp protection has more rolling/operational complexity, and
  // target band per pitch brief is 20-30%.
  targetNetMargin: 0.25,
  opCostFrac: 0.05,
  earlyUnwindHaircutFrac: 0.05,  // 5% bid-ask haircut on early Deribit unwind
};

export const TIERS: Record<string, TierConfig> = {
  // Single-premium: 7-day Deribit spread.
  // Sizing 2.5× → fee ~5% of notional, drawdown reduction ~35-50% of margin
  // on adverse-move trades.
  "single_premium_7d": {
    ...COMMON,
    description: "Single premium for 7-day protection. Residual refunded on early close.",
    mode: "single_premium",
    longOtmFromSpotFrac: 0.02,
    spreadWidthFrac: 0.06,
    sizingMultiplier: 2.5,
    hedgeTenorDays: 7,
  },
  // Day-rate variant on a 14-day spread (theta-following).
  // Sizing 4× — day-rate users pay only for time held; can afford bigger
  // protected notional because they amortize.
  "day_rate_14d": {
    ...COMMON,
    description: "Day-rate (theta-following) on a 14-day Deribit spread. Cancel anytime.",
    mode: "day_rate",
    longOtmFromSpotFrac: 0.02,
    spreadWidthFrac: 0.06,
    sizingMultiplier: 4.0,
    hedgeTenorDays: 14,
  },
};

export function computeMarkup(cfg: TierConfig): number {
  const denom = 1 - cfg.targetNetMargin - cfg.opCostFrac;
  return denom > 0.05 ? 1 / denom : 2.0;
}

// ─── Quote ───────────────────────────────────────────────────────────────────

export type QuoteInput = {
  trade: SyntheticPerpTrade;
  spotAtEntry: number;
  rvolAtEntry: number;
  cfg: TierConfig;
  liveChain?: ChainSnapshot | null;  // optional live calibration
};

export type Quote = {
  cfg: TierConfig;
  hedgeable: boolean;
  notHedgeableReason?: string;
  // Strikes
  K_long: number;
  K_short: number;
  spreadWidth: number;
  protectedNotionalUsd: number;
  // Pricing
  hedgeCostUsd: number;          // Atticus pays Deribit at entry
  markup: number;
  // For single-premium: total user fee at entry
  // For day-rate: daily theta × markup × (expected hold), but we report
  //   the cumulative across the actual hold for accounting in settlement
  initialUserChargeUsd: number;  // 0 for day_rate; = hedgeCost × markup for single_premium
  feePerDayInitialUsd: number;   // 0 for single_premium; theta × markup at day 0
  spreadMaxPayoutUsd: number;
  // Headlines
  feePctOfNotional: number;      // Atticus charge as % of protected notional (capital efficiency)
};

export function quote(input: QuoteInput): Quote {
  const { trade, spotAtEntry, rvolAtEntry, cfg } = input;
  const markup = computeMarkup(cfg);
  const protectedNotionalUsd = trade.notionalUsd * cfg.sizingMultiplier;

  // Adapter: long perp loses on price down → buy PUT spread.
  //          short perp loses on price up → buy CALL spread.
  const optType: "put" | "call" = trade.side === "long" ? "put" : "call";

  const K_long = optType === "put"
    ? spotAtEntry * (1 - cfg.longOtmFromSpotFrac)
    : spotAtEntry * (1 + cfg.longOtmFromSpotFrac);
  const K_short = optType === "put"
    ? K_long - spotAtEntry * cfg.spreadWidthFrac
    : K_long + spotAtEntry * cfg.spreadWidthFrac;
  const spreadWidth = Math.abs(K_long - K_short);

  // BS pricing with skew
  const T = cfg.hedgeTenorDays / 365;
  const atmIv = rvolAtEntry * cfg.ivOverRvol;
  const otmLong = Math.abs(K_long - spotAtEntry) / spotAtEntry;
  const otmShort = Math.abs(K_short - spotAtEntry) / spotAtEntry;
  const ivLong = atmIv + cfg.skewSlope * otmLong;
  const ivShort = atmIv + cfg.skewSlope * otmShort;

  const netPxPerSpot = optType === "put"
    ? putSpreadCost(spotAtEntry, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort)
    : callSpreadCost(spotAtEntry, K_long, K_short, T, cfg.riskFreeRate, ivLong, ivShort);
  const grossedFracOfNotional = (netPxPerSpot / spotAtEntry) * (1 + cfg.bidAskWidener);
  const hedgeCostUsd = protectedNotionalUsd * grossedFracOfNotional;
  const spreadMaxPayoutUsd = (spreadWidth / spotAtEntry) * protectedNotionalUsd;

  // Pricing per product mode
  let initialUserChargeUsd = 0;
  let feePerDayInitialUsd = 0;
  if (cfg.mode === "single_premium") {
    initialUserChargeUsd = hedgeCostUsd * markup;
  } else {
    // Day-rate (theta-following). Initial daily fee approximated as
    // hedgeCost / hedgeTenorDays × (early-time theta multiplier 0.5).
    // Mid-tenor theta is roughly avg = hedgeCost / hedgeTenorDays;
    // early-tenor is lower, late-tenor higher. We approximate the
    // initial-day theta as 0.5 × avg theta.
    const avgTheta = hedgeCostUsd / cfg.hedgeTenorDays;
    feePerDayInitialUsd = avgTheta * 0.5 * markup;
  }

  return {
    cfg,
    hedgeable: hedgeCostUsd > 0 && spreadWidth > 0,
    K_long, K_short, spreadWidth,
    protectedNotionalUsd,
    hedgeCostUsd,
    markup,
    initialUserChargeUsd,
    feePerDayInitialUsd,
    spreadMaxPayoutUsd,
    feePctOfNotional: trade.notionalUsd > 0 ? (initialUserChargeUsd || feePerDayInitialUsd * cfg.hedgeTenorDays) / trade.notionalUsd : 0,
  };
}

// ─── Settlement ──────────────────────────────────────────────────────────────

export type SettlementInput = {
  q: Quote;
  trade: SyntheticPerpTrade;
  spotAtEntry: number;
  spotAtExit: number;
  // Path data for drawdown calc
  worstAdverseSpot: number;  // for long: minLow over hold window; for short: maxHigh
};

export type Settlement = {
  // Perp economics (no hedge)
  perpPnlUsd: number;            // unhedged P&L at exit (sign: + win, - loss)
  perpMaxDrawdownUsd: number;    // worst paper loss during hold (always ≤ 0)
  perpLiquidatedUnhedged: boolean;
  // Hedge
  hedgePayoutAtExitUsd: number;  // option-spread value at exit
  hedgePayoutAtMaxDrawdownUsd: number;  // option-spread value at the worst-adverse spot
  // Total user economics
  totalUserFeeUsd: number;       // single-premium charge OR cumulative day-rate over hold
  netUserPnlUsd: number;         // perpPnl + hedgePayout - fee
  drawdownReductionUsd: number;  // perp DD - (perp DD + hedge value at adverse spot)
  drawdownReductionPctOfMargin: number;
  drawdownReductionPctOfNotional: number;
  liquidationPrevented: boolean; // unhedged would liquidate but hedged would not
  // Atticus economics
  atticusGrossRevenue: number;
  atticusHedgeCost: number;
  atticusNetMargin: number;
};

export function settle(input: SettlementInput): Settlement {
  const { q, trade, spotAtEntry, spotAtExit, worstAdverseSpot } = input;
  const cfg = q.cfg;

  // ── Perp P&L (unhedged) ──────────────────────────────────────────────────
  // Long perp: pnl = notional × (exit/entry - 1)
  // Short perp: pnl = notional × (entry/exit - 1)
  const perpReturn = trade.side === "long"
    ? (spotAtExit - spotAtEntry) / spotAtEntry
    : (spotAtEntry - spotAtExit) / spotAtEntry;
  const perpPnlUsdRaw = trade.notionalUsd * perpReturn;
  // Liquidation: loss > margin (approx; ignores fees/funding for backtest simplicity)
  const liqMove = -1 / trade.leverage;  // perp return at which margin is wiped
  const perpReturnAtAdverse = trade.side === "long"
    ? (worstAdverseSpot - spotAtEntry) / spotAtEntry
    : (spotAtEntry - worstAdverseSpot) / spotAtEntry;
  const perpLiquidatedUnhedged = perpReturnAtAdverse <= liqMove;
  // If liquidated, P&L is -margin (capped). Else use exit P&L.
  const perpPnlUsd = perpLiquidatedUnhedged ? -trade.marginUsd : perpPnlUsdRaw;
  // Max drawdown is the worst paper loss seen during hold.
  const perpMaxDrawdownUsd = trade.notionalUsd * Math.min(0, perpReturnAtAdverse);

  // ── Hedge payout ──────────────────────────────────────────────────────────
  const hedgePayoutAtExitUsd = trade.side === "long"
    ? putSpreadPayout(q.K_long, q.K_short, spotAtEntry, spotAtExit, q.protectedNotionalUsd)
    : callSpreadPayout(q.K_long, q.K_short, spotAtEntry, spotAtExit, q.protectedNotionalUsd);
  const hedgePayoutAtMaxDrawdownUsd = trade.side === "long"
    ? putSpreadPayout(q.K_long, q.K_short, spotAtEntry, worstAdverseSpot, q.protectedNotionalUsd)
    : callSpreadPayout(q.K_long, q.K_short, spotAtEntry, worstAdverseSpot, q.protectedNotionalUsd);

  // Whether the hedge would have prevented liquidation:
  // At the worst adverse spot, perp loss = perpMaxDrawdownUsd (negative).
  // Hedge payout at that point = hedgePayoutAtMaxDrawdownUsd.
  // Liquidation prevented iff: |perpMaxDrawdownUsd| - hedgePayoutAtMaxDrawdownUsd < marginUsd.
  const realizedLossAtAdverseAfterHedge = Math.abs(perpMaxDrawdownUsd) - hedgePayoutAtMaxDrawdownUsd;
  const liquidationPrevented = perpLiquidatedUnhedged && realizedLossAtAdverseAfterHedge < trade.marginUsd;

  // ── User fee ──────────────────────────────────────────────────────────────
  // Common: time the position spent open (capped at hedge tenor).
  const tenorDaysActual = Math.min(trade.holdDays, cfg.hedgeTenorDays);
  const decayFraction = tenorDaysActual / cfg.hedgeTenorDays;

  // Residual hedge value at the moment user closes (Atticus sells back to Deribit).
  // Approximation: max(linear time-decay residual, intrinsic-at-exit). Real BS would
  // give somewhere in between; this is a slight upper bound.
  const linearResidual = q.hedgeCostUsd * Math.max(0, 1 - decayFraction);
  const grossResidual = Math.max(linearResidual, hedgePayoutAtExitUsd);
  const residualNetOfHaircut = grossResidual * (1 - cfg.earlyUnwindHaircutFrac);

  let totalUserFeeUsd = 0;
  if (cfg.mode === "single_premium") {
    // User paid initialUserChargeUsd at entry. On early close, residual is refunded.
    // Refund = residualNetOfHaircut × markup (we refund the full marked-up value, not
    // just the markup portion, otherwise the user is paying for unconsumed protection
    // that Atticus is also recouping via the unwind sale → double-counted).
    const refundToUser = trade.holdDays < cfg.hedgeTenorDays
      ? residualNetOfHaircut * q.markup
      : 0;
    totalUserFeeUsd = Math.max(0, q.initialUserChargeUsd - refundToUser);
  } else {
    // Day-rate (theta-following). Cumulative fee = theta integral × markup =
    // (hedgeCost × decayFraction) × markup. Linear approximation; real theta is
    // nonlinear but the integral over [0, t] equals the actual change in option
    // value over that window, which equals (hedgeCost - residual_at_t).
    // So a more accurate accounting: cumulative theta = hedgeCost - residual.
    const thetaIntegral = q.hedgeCostUsd - linearResidual;
    totalUserFeeUsd = thetaIntegral * q.markup;
  }

  // ── Net user economics ───────────────────────────────────────────────────
  // Hedged P&L = perpPnl + hedgePayoutAtExit (if exit before liq) − fee
  // If unhedged would have liquidated but hedge prevented it:
  //   user gets back perpPnlUsdRaw at exit + hedge payout − fee, NOT capped at -margin
  let hedgedPnl: number;
  if (liquidationPrevented) {
    // The hedge paid enough during the drawdown to keep the perp alive; user
    // continues to exit. Assume they exit at spotAtExit with full perp P&L.
    hedgedPnl = perpPnlUsdRaw + hedgePayoutAtExitUsd - totalUserFeeUsd;
  } else if (perpLiquidatedUnhedged) {
    // Even with hedge, would have liquidated. Hedge pays out at the moment
    // of liquidation (worst-adverse spot). User loses margin, gets hedge payout.
    hedgedPnl = -trade.marginUsd + hedgePayoutAtMaxDrawdownUsd - totalUserFeeUsd;
  } else {
    // No liquidation. Standard exit.
    hedgedPnl = perpPnlUsd + hedgePayoutAtExitUsd - totalUserFeeUsd;
  }
  const netUserPnlUsd = hedgedPnl;

  // Drawdown reduction (the headline metric)
  const ddUnhedgedAbs = Math.abs(perpMaxDrawdownUsd);
  const ddHedgedAbs = Math.max(0, ddUnhedgedAbs - hedgePayoutAtMaxDrawdownUsd);
  // Drawdown reduction (USD) capped at the unhedged drawdown — the hedge
  // can produce payouts larger than the unhedged loss for high-leverage
  // positions, but reporting "120% drawdown reduction" is misleading. We
  // cap at 100% (i.e., the hedge fully eliminates the drawdown). The excess
  // payout still flows to the user via netUserPnlUsd, just not into this metric.
  const drawdownReductionUsdRaw = ddUnhedgedAbs - ddHedgedAbs;
  const drawdownReductionUsd = Math.min(drawdownReductionUsdRaw, ddUnhedgedAbs);
  const drawdownReductionPctOfMargin = trade.marginUsd > 0
    ? Math.min(100, (drawdownReductionUsd / trade.marginUsd) * 100)
    : 0;
  const drawdownReductionPctOfNotional = trade.notionalUsd > 0
    ? (drawdownReductionUsd / trade.notionalUsd) * 100
    : 0;

  // Atticus net margin.
  //   Cash flows for Atticus:
  //     IN at entry : nothing (single-premium charges user at entry, but day-rate doesn't)
  //     OUT at entry: hedgeCostUsd (paid to Deribit for the spread)
  //     For single-premium: IN initialUserChargeUsd at entry; OUT refundToUser at exit
  //     For day-rate:       IN totalUserFeeUsd over the hold window
  //     IN at exit:  residualNetOfHaircut (sells unused option back to Deribit; only
  //                  applies when the spread didn't pay out fully — when it DID pay out,
  //                  the payout already flowed through to the user, so residual is the
  //                  remaining time-value, often near 0 if option is deep ITM).
  //
  //   Cleaner: Atticus collects (totalUserFeeUsd) from the user, pays (hedgeCostUsd) to
  //   Deribit, recovers (residualNetOfHaircut) from Deribit on early close. Net:
  //
  //     atticusNetMargin = totalUserFeeUsd − hedgeCostUsd + residualNetOfHaircut
  //                        − hedgePayoutAtExit  (because that's already passed to user)
  //
  //   But wait: the hedgePayout to user IS the residual (when ITM). They're the same thing
  //   in cash-flow terms. To avoid double-counting, simplify: Atticus net = revenue from
  //   user − net cost to Atticus = totalUserFee − (hedgeCost − residualValueRecoveredOrPaidThrough).
  //   Which simplifies to: atticus_margin = totalUserFee − decay_consumed × (1 + unwind_haircut_loss)
  //
  //   Practical model:
  const decayConsumedByDeribit = q.hedgeCostUsd * decayFraction;  // value lost to time
  const unwindHaircutLoss = grossResidual * cfg.earlyUnwindHaircutFrac;  // bid-ask cost on early sell
  const atticusGrossRevenue = totalUserFeeUsd;
  const atticusNetMargin = totalUserFeeUsd - decayConsumedByDeribit - unwindHaircutLoss;

  return {
    perpPnlUsd,
    perpMaxDrawdownUsd,
    perpLiquidatedUnhedged,
    hedgePayoutAtExitUsd,
    hedgePayoutAtMaxDrawdownUsd,
    totalUserFeeUsd,
    netUserPnlUsd,
    drawdownReductionUsd,
    drawdownReductionPctOfMargin,
    drawdownReductionPctOfNotional,
    liquidationPrevented,
    atticusGrossRevenue,
    atticusHedgeCost: q.hedgeCostUsd,
    atticusNetMargin,
  };
}
