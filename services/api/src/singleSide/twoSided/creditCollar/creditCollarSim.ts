/**
 * Atticus-book sim — Phase A (pure, offline, deterministic). Proves the embedded spread CLEARS
 * costs and that the reserve covers worst-case drawdown, at REBATES = 0 (the viability bar).
 *
 * What it models, per the Phase 0 review (Q5): the spread must clear, in sim,
 *   (i)   hedge execution slippage (crossing bid/ask to back-to-back the legs on Bullish),
 *   (ii)  residual delta-hedge tracking error on the warehoused fraction,
 *   (iii) cost-of-capital on the reserve held against the short (floor) leg,
 * with NO rebate income. Drawdown is driven by a SHARED daily market shock across the book
 * (positions are correlated — this is what makes the tail real), plus idiosyncratic noise.
 *
 * This is a planning/validation tool, not a production path. It depends on no live services.
 */

import { solveAndPriceCreditCollar, type CreditCollarParams, type AtticusSpreadConfig, type PerpSide } from "./creditCollarPricer";
import { linearDownsideSkew } from "./skew";

/** Deterministic RNG (mulberry32) so sim runs are reproducible. */
const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Box-Muller standard normal from a uniform RNG. */
const stdNormal = (rng: () => number): number => {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

export type SimConfig = {
  /** Total protected notional opened per day (the volume tier, e.g. 5_000_000). */
  dailyNotionalUsdc: number;
  /** Average notional per position (book is split into dailyNotional/avgPosition collars). */
  avgPositionNotionalUsdc: number;
  /** Number of days to simulate. */
  days: number;
  /** Market spot. */
  spot: number;
  /** Tenor in days. */
  tenorDays: number;
  /** Foxify fee/credit per position (the target credit). */
  creditPerPositionUsdc: number;
  /** Max floor (% OTM) — the protective-leg cap. */
  maxFloorPct: number;
  /** Annualized vol used both for skew ATM and the terminal price simulation. */
  atmIv: number;
  /** Downside skew slope (IV pts per 10% strike drop). */
  skewSlopePer10pct: number;
  /** Fraction of each collar hedged back-to-back in Bullish options (rest is warehoused/delta-hedged). */
  backToBackFraction: number;
  /** Bid/ask slippage paid to cross on the back-to-back legs, in bps of notional. */
  hedgeSlippageBps: number;
  /** Residual tracking error retained on the warehoused fraction (0 = perfect delta hedge, 1 = naked). */
  residualTrackingError: number;
  /**
   * Fraction of gross book that is net-directional (rarely perfectly long/short balanced). The
   * delta-balanced part offsets across the book; this imbalanced part carries directional tail risk.
   */
  bookImbalanceFraction: number;
  /**
   * Non-netting gap/basis cost in bps of warehoused notional per 1% of breach beyond the floor —
   * models that even a "hedged" 24h book slips over gaps/calendar/venue basis on big moves.
   */
  gapBasisBpsPerPct: number;
  /** Reserve held against the book, as a multiple of expected short-leg payout. */
  reserveMultiple: number;
  /** Annual cost-of-capital on the reserve. */
  costOfCapitalAnnual: number;
  /** Fraction of long positions vs short (0.5 = balanced). */
  longFraction: number;
  /** RNG seed. */
  seed: number;
};

export type SimResult = {
  ok: true;
  inputs: SimConfig;
  collarsPerDay: number;
  pricedOk: number;
  pricedInfeasible: number;
  grossMarginPerDayUsdc: number;       // locked embedded spread before costs
  hedgeSlippagePerDayUsdc: number;
  expectedResidualPerDayUsdc: number;  // mean of warehoused residual (≈0, but tails matter)
  capitalCostPerDayUsdc: number;
  meanNetDailyPnlUsdc: number;
  p50NetDailyPnlUsdc: number;
  p5NetDailyPnlUsdc: number;
  p1NetDailyPnlUsdc: number;
  worstDayUsdc: number;
  maxCumulativeDrawdownUsdc: number;
  reserveUsdc: number;
  reserveCoverageRatio: number;        // reserve / max drawdown (>1 = covered)
  profitableDayFraction: number;
  annualizedNetPnlUsdc: number;
  verdict: "VIABLE_AT_REBATES_ZERO" | "MARGINAL" | "NOT_VIABLE";
  notes: string[];
} | { ok: false; error: string; message: string };

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
};

/**
 * Run the Atticus-book sim. Pure + deterministic given the seed. Returns daily P&L stats,
 * worst-case drawdown, and reserve coverage at rebates = 0.
 */
export const simulateAtticusBook = (cfg: SimConfig): SimResult => {
  if (!(cfg.dailyNotionalUsdc > 0)) return { ok: false, error: "invalid_notional", message: "dailyNotionalUsdc must be > 0" };
  if (!(cfg.avgPositionNotionalUsdc > 0)) return { ok: false, error: "invalid_position", message: "avgPositionNotionalUsdc must be > 0" };
  if (!(cfg.days > 0)) return { ok: false, error: "invalid_days", message: "days must be > 0" };

  const rng = mulberry32(cfg.seed >>> 0);
  const skew = linearDownsideSkew(cfg.spot, cfg.atmIv, cfg.skewSlopePer10pct);
  const collarsPerDay = Math.max(1, Math.round(cfg.dailyNotionalUsdc / cfg.avgPositionNotionalUsdc));
  const spreadConfig: AtticusSpreadConfig = { riskFreeRate: 0.045 };

  // Price the representative book once (homogeneous notional for the planning model).
  type Priced = { side: PerpSide; notional: number; contracts: number; grossMargin: number; putStrike: number; callStrike: number };
  const book: Priced[] = [];
  let pricedInfeasible = 0;
  for (let i = 0; i < collarsPerDay; i++) {
    const side: PerpSide = rng() < cfg.longFraction ? "long" : "short";
    const params: CreditCollarParams = {
      side,
      spot: cfg.spot,
      notionalUsdc: cfg.avgPositionNotionalUsdc,
      tenorDays: cfg.tenorDays,
      targetCreditUsdc: cfg.creditPerPositionUsdc,
      maxFloorPct: cfg.maxFloorPct,
      referenceMode: "position"
    };
    const q = solveAndPriceCreditCollar(params, skew, spreadConfig);
    if (!q.ok) {
      pricedInfeasible++;
      continue;
    }
    book.push({
      side,
      notional: cfg.avgPositionNotionalUsdc,
      contracts: q.position.contracts_btc,
      grossMargin: q.economics.atticus_margin_usdc,
      putStrike: q.legs.putStrike,
      callStrike: q.legs.callStrike
    });
  }

  if (book.length === 0) {
    return { ok: false, error: "no_feasible_collars", message: "no collars priced feasibly at these inputs" };
  }

  const grossMarginPerDay = book.reduce((s, b) => s + b.grossMargin, 0);
  const hedgeSlippagePerDay = book.reduce((s, b) => s + (b.notional * cfg.hedgeSlippageBps) / 1e4 * cfg.backToBackFraction, 0);

  // Reserve sizing: expected short-leg (floor) payout under the terminal distribution × reserveMultiple.
  // Estimated via the floor distance and lognormal tail probability — approximated empirically below.
  const dailySigma = cfg.atmIv * Math.sqrt(cfg.tenorDays / 365);

  const grossNotional = book.reduce((s, b) => s + b.notional, 0);
  const warehousedNotional = grossNotional * (1 - cfg.backToBackFraction);
  // Net-directional warehoused exposure (the part that does NOT offset across the book).
  const netDirectionalNotional = warehousedNotional * cfg.bookImbalanceFraction;

  // Book-level loss model on a shared systemic daily shock. Two non-netting tail channels:
  //   (1) directional residual: the imbalanced, imperfectly-hedged net delta loses on a move,
  //   (2) gap/basis loss: even the "hedged" book slips over a breach beyond the floor.
  // The delta-balanced majority of the book offsets and is captured only via gross margin.
  const dailyPnls: number[] = [];
  let estShortLegPayoutSum = 0;
  let sumResidual = 0;

  for (let d = 0; d < cfg.days; d++) {
    const systemic = stdNormal(rng);
    const ret = systemic * dailySigma - 0.5 * dailySigma * dailySigma;
    const moveAbs = Math.abs(Math.exp(ret) - 1);
    const breachExcess = Math.max(0, moveAbs - cfg.maxFloorPct);

    // (1) directional residual: net delta × move × retained tracking error (sign can help or hurt;
    // we keep the signed P&L so good and bad days both occur).
    const directionalResidual = -Math.sign(ret) * netDirectionalNotional * (Math.exp(ret) - 1) * cfg.residualTrackingError;
    // (2) gap/basis loss on breaches (always a cost — slippage doesn't pay you).
    const gapLoss = warehousedNotional * (cfg.gapBasisBpsPerPct / 1e4) * (breachExcess / 0.01);

    const dayResidual = directionalResidual - gapLoss;
    sumResidual += dayResidual;

    // Short-leg payout Atticus funds on a breach (≈ half the book on the breached side, beyond floor).
    const shortLegPayoutDay = (grossNotional / 2) * breachExcess;
    estShortLegPayoutSum += shortLegPayoutDay;

    dailyPnls.push(grossMarginPerDay - hedgeSlippagePerDay + dayResidual);
  }

  const expectedShortLegPayoutPerDay = estShortLegPayoutSum / cfg.days;
  const reserveUsdc = expectedShortLegPayoutPerDay * cfg.reserveMultiple;
  const capitalCostPerDay = (reserveUsdc * cfg.costOfCapitalAnnual) / 365;

  // Fold capital cost into daily P&L (it's a real cost the spread must clear).
  const dailyPnlsNet = dailyPnls.map((x) => x - capitalCostPerDay);
  const sorted = [...dailyPnlsNet].sort((a, b) => a - b);
  const mean = dailyPnlsNet.reduce((s, x) => s + x, 0) / dailyPnlsNet.length;
  const worstDay = sorted[0];
  const profitableDays = dailyPnlsNet.filter((x) => x > 0).length / dailyPnlsNet.length;

  // Recompute drawdown including capital cost.
  let cum2 = 0, pk2 = 0, mdd2 = 0;
  for (const x of dailyPnlsNet) {
    cum2 += x;
    pk2 = Math.max(pk2, cum2);
    mdd2 = Math.max(mdd2, pk2 - cum2);
  }

  const reserveCoverageRatio = mdd2 > 1e-9 ? reserveUsdc / mdd2 : Number.POSITIVE_INFINITY;
  const annualized = mean * 365;

  const expectedResidualPerDay = sumResidual / cfg.days;

  const isViable = mean > 0 && reserveCoverageRatio >= 1 && profitableDays >= 0.5;
  const isMarginal = mean > 0 && (reserveCoverageRatio < 1 || profitableDays < 0.5);

  const round2 = (x: number) => +x.toFixed(2);

  return {
    ok: true,
    inputs: cfg,
    collarsPerDay: book.length,
    pricedOk: book.length,
    pricedInfeasible,
    grossMarginPerDayUsdc: round2(grossMarginPerDay),
    hedgeSlippagePerDayUsdc: round2(hedgeSlippagePerDay),
    expectedResidualPerDayUsdc: round2(expectedResidualPerDay),
    capitalCostPerDayUsdc: round2(capitalCostPerDay),
    meanNetDailyPnlUsdc: round2(mean),
    p50NetDailyPnlUsdc: round2(percentile(sorted, 0.5)),
    p5NetDailyPnlUsdc: round2(percentile(sorted, 0.05)),
    p1NetDailyPnlUsdc: round2(percentile(sorted, 0.01)),
    worstDayUsdc: round2(worstDay),
    maxCumulativeDrawdownUsdc: round2(mdd2),
    reserveUsdc: round2(reserveUsdc),
    reserveCoverageRatio: +reserveCoverageRatio.toFixed(2),
    profitableDayFraction: +profitableDays.toFixed(4),
    annualizedNetPnlUsdc: round2(annualized),
    verdict: isViable ? "VIABLE_AT_REBATES_ZERO" : isMarginal ? "MARGINAL" : "NOT_VIABLE",
    notes: [
      "Rebates = 0 (viability bar). Bullish rebates/fee-holiday are pure upside on top.",
      "Drawdown driven by a shared systemic daily shock across the book (correlated tail).",
      "Gross margin is the embedded spread; net clears hedge slippage + residual + cost-of-capital on reserve.",
      "Reserve = expected short-leg payout/day × reserveMultiple. Coverage ratio ≥ 1 means reserve covers max drawdown."
    ]
  };
};
