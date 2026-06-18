/**
 * Atticus-book sim — Phase A (pure, offline, deterministic). DIRECTIONALLY ENCOURAGING, NOT
 * VALIDATED: the headline numbers are only as good as the leg-fill, book-imbalance, and Foxify
 * notional/fee/hold-time assumptions underneath them (Phase 0 review #1–#5). Treat as a framework
 * that exposes those assumptions, not a result.
 *
 * What it models, at REBATES = 0 (the viability bar):
 *   - Embedded spread = the POST-CROSSING margin from the pricer (legs filled at the touch:
 *     protective leg bought at ask, funding leg sold at bid). This is the #1 swing.
 *   - Residual delta-hedge tracking + gap/basis loss on the warehoused fraction.
 *   - Cost-of-capital on the reserve.
 *   - Reserve STRESS on an IMBALANCED (net-long) book under a real correlated jump — the
 *     scenario that breaks a reserve sized off the average day (Foxify net-long into a crash).
 *   - Feasibility rate + call-strike tightness across a notional/fee distribution (the product
 *     shape, not just "does one cell work").
 *
 * No live services, no execution. Bullish rebates/fee-holiday are pure upside and excluded.
 */

import { solveAndPriceCreditCollar, type CreditCollarParams, type AtticusSpreadConfig, type PerpSide, type SkewCurve } from "./creditCollarPricer";
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

const stdNormal = (rng: () => number): number => {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))));
  return sortedAsc[idx];
};
const median = (xs: number[]): number => percentile([...xs].sort((a, b) => a - b), 0.5);
const round2 = (x: number) => +x.toFixed(2);

export type SimConfig = {
  /** Total protected notional opened per day (the volume tier). */
  dailyNotionalUsdc: number;
  /** Mean notional per position. PLACEHOLDER until Foxify's real distribution is supplied. */
  avgPositionNotionalUsdc: number;
  /** Lognormal spread of per-position notional (0 = homogeneous). Drives feasibility dispersion. */
  notionalLogSdPct: number;
  /** Days to simulate. */
  days: number;
  spot: number;
  tenorDays: number;
  /** How the per-position credit (Foxify fee/ops cost) is set. PLACEHOLDER until real data. */
  creditMode: "fixed_usdc" | "bps_of_notional";
  /** Fixed credit per position (creditMode = fixed_usdc). */
  creditPerPositionUsdc: number;
  /** Credit as bps of notional (creditMode = bps_of_notional) — more realistic (fees are ~bps-based). */
  creditBpsOfNotional: number;
  /** Max floor (% OTM) — the protective-leg cap. */
  maxFloorPct: number;
  atmIv: number;
  skewSlopePer10pct: number;
  /** Fraction of each collar hedged back-to-back in Bullish options (rest warehoused/delta-hedged). */
  backToBackFraction: number;
  /** Per-leg HALF-spread as fraction of mid premium (the leg-crossing cost — #1 swing). */
  legRelativeHalfSpreadPct: number;
  /** Per-leg HALF-spread absolute floor in USDC/BTC. */
  legAbsHalfSpreadUsdcPerBtc: number;
  /** Leg fill mode: "touch" (realistic) or "mid" (optimistic). */
  fillMode: "mid" | "touch";
  /** Extra market-impact slippage at scale BEYOND the quoted half-spread, in bps of notional. */
  extraImpactBps: number;
  /** Residual tracking error retained on the warehoused fraction (0 = perfect hedge, 1 = naked). */
  residualTrackingError: number;
  /** Net long bias of the book in [−1, 1] (+ = net long). The imbalance that breaks the reserve. */
  netLongBias: number;
  /** Non-netting gap/basis cost, bps of warehoused notional per 1% breach beyond the floor. */
  gapBasisBpsPerPct: number;
  /** Reserve held = expected daily short-leg payout × this multiple. */
  reserveMultiple: number;
  /** Annual cost-of-capital on the reserve. */
  costOfCapitalAnnual: number;
  /** Correlated stress jump (e.g. 0.12 = a −12% BTC day) for the reserve stress test. */
  stressJumpPct: number;
  /** Fraction long vs short for the MC P&L book composition (0.5 = balanced). */
  longFraction: number;
  seed: number;
};

export type SimResult =
  | {
      ok: true;
      label: "directionally_encouraging_not_validated";
      inputs: SimConfig;
      collarsPerDay: number;
      pricedOk: number;
      pricedInfeasible: number;
      feasibilityRate: number;
      medianCapPct: number;             // upside Foxify surrenders (the product-shape number)
      medianAtticusMarginBps: number;   // post-crossing
      medianCrossingDragUsdc: number;   // mid-credit − fundable-credit per position
      fillMode: "mid" | "touch";
      grossMarginPerDayUsdc: number;     // CONSERVATIVE: controlled embedded spread (margin floor)
      gridSlackPerDayUsdc: number;       // extra capture from coarse strike grid (passed to Foxify, not booked)
      extraImpactPerDayUsdc: number;
      expectedResidualPerDayUsdc: number;
      capitalCostPerDayUsdc: number;
      meanNetDailyPnlUsdc: number;
      p50NetDailyPnlUsdc: number;
      p5NetDailyPnlUsdc: number;
      p1NetDailyPnlUsdc: number;
      worstDayUsdc: number;
      maxCumulativeDrawdownUsdc: number;
      reserveUsdc: number;
      drawdownCoverageRatio: number;    // reserve / MC max drawdown
      stressJumpDemandUsdc: number;     // imbalanced-book payout under the jump
      stressCoverageRatio: number;      // reserve / stress demand (THE reserve test)
      profitableDayFraction: number;
      annualizedNetPnlUsdc: number;
      verdict: "VIABLE_AT_REBATES_ZERO" | "MARGINAL" | "NOT_VIABLE";
      notes: string[];
    }
  | { ok: false; error: string; message: string };

const creditFor = (cfg: SimConfig, notional: number): number =>
  cfg.creditMode === "bps_of_notional" ? (notional * cfg.creditBpsOfNotional) / 1e4 : cfg.creditPerPositionUsdc;

/**
 * Run the Atticus-book sim. Pure + deterministic given the seed.
 */
export const simulateAtticusBook = (cfg: SimConfig): SimResult => {
  if (!(cfg.dailyNotionalUsdc > 0)) return { ok: false, error: "invalid_notional", message: "dailyNotionalUsdc must be > 0" };
  if (!(cfg.avgPositionNotionalUsdc > 0)) return { ok: false, error: "invalid_position", message: "avgPositionNotionalUsdc must be > 0" };
  if (!(cfg.days > 0)) return { ok: false, error: "invalid_days", message: "days must be > 0" };

  const rng = mulberry32(cfg.seed >>> 0);
  const skew = linearDownsideSkew(cfg.spot, cfg.atmIv, cfg.skewSlopePer10pct);
  const collarsPerDay = Math.max(1, Math.round(cfg.dailyNotionalUsdc / cfg.avgPositionNotionalUsdc));
  const spreadConfig: AtticusSpreadConfig = {
    riskFreeRate: 0.045,
    fillMode: cfg.fillMode,
    relativeHalfSpreadPct: cfg.legRelativeHalfSpreadPct,
    absHalfSpreadUsdcPerBtc: cfg.legAbsHalfSpreadUsdcPerBtc
  };

  type Priced = { side: PerpSide; notional: number; contracts: number; capturedMargin: number; requiredMargin: number; putStrike: number; callStrike: number };
  const book: Priced[] = [];
  let pricedInfeasible = 0;
  const capPcts: number[] = [];
  const marginBpsArr: number[] = [];
  const crossingDrags: number[] = [];

  for (let i = 0; i < collarsPerDay; i++) {
    const side: PerpSide = rng() < cfg.longFraction ? "long" : "short";
    const z = stdNormal(rng);
    const sd = cfg.notionalLogSdPct;
    const notional = sd > 0 ? cfg.avgPositionNotionalUsdc * Math.exp(z * sd - 0.5 * sd * sd) : cfg.avgPositionNotionalUsdc;
    const params: CreditCollarParams = {
      side,
      spot: cfg.spot,
      notionalUsdc: notional,
      tenorDays: cfg.tenorDays,
      targetCreditUsdc: creditFor(cfg, notional),
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
      notional,
      contracts: q.position.contracts_btc,
      capturedMargin: q.economics.atticus_margin_usdc,   // what Atticus would book if it pockets grid slack
      requiredMargin: q.economics.required_margin_usdc,  // the controlled embedded spread (conservative)
      putStrike: q.legs.putStrike,
      callStrike: q.legs.callStrike
    });
    capPcts.push(q.legs.cap_pct);
    marginBpsArr.push(q.economics.atticus_margin_bps);
    crossingDrags.push(q.fills.crossing_drag_usdc);
  }

  const totalAttempted = book.length + pricedInfeasible;
  const feasibilityRate = totalAttempted > 0 ? book.length / totalAttempted : 0;

  if (book.length === 0) {
    return {
      ok: false,
      error: "no_feasible_collars",
      message: `0/${totalAttempted} collars priced feasibly (fill=${cfg.fillMode}). Credit/notional too high vs skew, or floor too tight.`
    };
  }

  // CONSERVATIVE revenue: book the controlled embedded spread (margin floor), NOT the grid-overshoot
  // capture. On a coarse listed-strike grid the loosest-acceptable funding strike overshoots the
  // target; that slack belongs to Foxify (a looser cap / bigger credit under competition), so we do
  // NOT count it as Atticus revenue. gridSlack is reported separately as upside.
  const grossMarginPerDay = book.reduce((s, b) => s + b.requiredMargin, 0);
  const gridSlackPerDay = book.reduce((s, b) => s + Math.max(0, b.capturedMargin - b.requiredMargin), 0);
  const feasibleGrossNotional = book.reduce((s, b) => s + b.notional, 0);
  const warehousedNotional = feasibleGrossNotional * (1 - cfg.backToBackFraction);
  const netLongSignedNotional = warehousedNotional * cfg.netLongBias; // + = net long (loses on down moves)
  const extraImpactPerDay = (feasibleGrossNotional * cfg.extraImpactBps) / 1e4 * cfg.backToBackFraction;

  // RESERVE sized off the STRESS, not the average day (Phase 0 review #2): an imbalanced (net-long)
  // book under a correlated jump, with the delta hedge FAILING over the gap (prudent). The
  // back-to-back fraction is self-funded by its bought legs; only the warehoused net-long side needs
  // reserve. The margin must then clear cost-of-capital on THIS (larger) reserve at rebates = 0.
  const longShareOfWarehoused = Math.min(1, Math.max(0, 0.5 + cfg.netLongBias / 2));
  const stressExcess = Math.max(0, cfg.stressJumpPct - cfg.maxFloorPct);
  const stressJumpDemandUsdc = warehousedNotional * longShareOfWarehoused * stressExcess;
  const reserveUsdc = stressJumpDemandUsdc * cfg.reserveMultiple;
  const stressCoverageRatio = stressJumpDemandUsdc > 1e-9 ? reserveUsdc / stressJumpDemandUsdc : Number.POSITIVE_INFINITY;
  const capitalCostPerDay = (reserveUsdc * cfg.costOfCapitalAnnual) / 365;

  const dailySigma = cfg.atmIv * Math.sqrt(cfg.tenorDays / 365);

  const dailyPnls: number[] = [];
  let sumResidual = 0;

  for (let d = 0; d < cfg.days; d++) {
    const systemic = stdNormal(rng);
    const ret = systemic * dailySigma - 0.5 * dailySigma * dailySigma;
    const moveMult = Math.exp(ret) - 1;
    const breachExcess = Math.max(0, Math.abs(moveMult) - cfg.maxFloorPct);

    // (1) directional residual on the imbalanced warehoused net delta (net long loses on down moves).
    const directionalResidual = netLongSignedNotional * moveMult * cfg.residualTrackingError;
    // (2) gap/basis loss on breaches — always a cost.
    const gapLoss = warehousedNotional * (cfg.gapBasisBpsPerPct / 1e4) * (breachExcess / 0.01);

    const dayResidual = directionalResidual - gapLoss;
    sumResidual += dayResidual;

    dailyPnls.push(grossMarginPerDay - extraImpactPerDay + dayResidual);
  }

  const dailyPnlsNet = dailyPnls.map((x) => x - capitalCostPerDay);
  const sorted = [...dailyPnlsNet].sort((a, b) => a - b);
  const mean = dailyPnlsNet.reduce((s, x) => s + x, 0) / dailyPnlsNet.length;
  const worstDay = sorted[0];
  const profitableDays = dailyPnlsNet.filter((x) => x > 0).length / dailyPnlsNet.length;

  let cum = 0, pk = 0, mdd = 0;
  for (const x of dailyPnlsNet) {
    cum += x;
    pk = Math.max(pk, cum);
    mdd = Math.max(mdd, pk - cum);
  }

  const drawdownCoverageRatio = mdd > 1e-9 ? reserveUsdc / mdd : Number.POSITIVE_INFINITY;
  const annualized = mean * 365;

  // Verdict requires: positive net at rebates=0, majority profitable days, reserve covers BOTH the MC
  // drawdown AND the imbalanced jump stress, and a non-trivial feasibility rate.
  const isViable =
    mean > 0 && profitableDays >= 0.5 && drawdownCoverageRatio >= 1 && stressCoverageRatio >= 1 && feasibilityRate >= 0.6;
  const isMarginal = mean > 0 && (drawdownCoverageRatio < 1 || stressCoverageRatio < 1 || feasibilityRate < 0.6);

  return {
    ok: true,
    label: "directionally_encouraging_not_validated",
    inputs: cfg,
    collarsPerDay,
    pricedOk: book.length,
    pricedInfeasible,
    feasibilityRate: +feasibilityRate.toFixed(4),
    medianCapPct: +median(capPcts).toFixed(4),
    medianAtticusMarginBps: +median(marginBpsArr).toFixed(4),
    medianCrossingDragUsdc: round2(median(crossingDrags)),
    fillMode: cfg.fillMode,
    grossMarginPerDayUsdc: round2(grossMarginPerDay),
    gridSlackPerDayUsdc: round2(gridSlackPerDay),
    extraImpactPerDayUsdc: round2(extraImpactPerDay),
    expectedResidualPerDayUsdc: round2(sumResidual / cfg.days),
    capitalCostPerDayUsdc: round2(capitalCostPerDay),
    meanNetDailyPnlUsdc: round2(mean),
    p50NetDailyPnlUsdc: round2(percentile(sorted, 0.5)),
    p5NetDailyPnlUsdc: round2(percentile(sorted, 0.05)),
    p1NetDailyPnlUsdc: round2(percentile(sorted, 0.01)),
    worstDayUsdc: round2(worstDay),
    maxCumulativeDrawdownUsdc: round2(mdd),
    reserveUsdc: round2(reserveUsdc),
    drawdownCoverageRatio: +drawdownCoverageRatio.toFixed(2),
    stressJumpDemandUsdc: round2(stressJumpDemandUsdc),
    stressCoverageRatio: +stressCoverageRatio.toFixed(2),
    profitableDayFraction: +profitableDays.toFixed(4),
    annualizedNetPnlUsdc: round2(annualized),
    verdict: isViable ? "VIABLE_AT_REBATES_ZERO" : isMarginal ? "MARGINAL" : "NOT_VIABLE",
    notes: [
      "DIRECTIONALLY ENCOURAGING, NOT VALIDATED — depends on leg-fill, imbalance, and Foxify notional/fee/hold inputs.",
      `Legs filled at ${cfg.fillMode} (touch = protective ask + funding bid; the real competition for credit).`,
      "Rebates = 0. Bullish rebates/fee-holiday are pure upside on top.",
      "Reserve stress = imbalanced net-long book under a correlated jump with the delta hedge failing over the gap.",
      "Feasibility + median cap_pct show the PRODUCT SHAPE (how much upside Foxify actually surrenders)."
    ]
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Feasibility sweep over a notional × fee grid — answers "feasibility rate + call-strike
// tightness" across Foxify's (still unknown) distribution. The credit-as-% of notional is the
// driver: $100 on $150k (6.7 bps) is fundable; $100 on $30k (33 bps) likely is not, vs skew.
// ──────────────────────────────────────────────────────────────────────────────

export type FeasibilityCell = {
  notionalUsdc: number;
  feeUsdc: number;
  creditBps: number;
  feasible: boolean;
  capPct: number | null;          // upside surrendered (null if infeasible)
  atticusMarginBps: number | null;
  crossingDragUsdc: number | null;
  reason: string | null;
};

export type FeasibilitySweep = {
  fillMode: "mid" | "touch";
  cells: FeasibilityCell[];
  feasibilityRate: number;
  medianCapPctFeasible: number | null;
};

export const feasibilitySweep = (
  notionals: number[],
  fees: number[],
  base: { spot: number; tenorDays: number; maxFloorPct: number; side?: PerpSide },
  skew: SkewCurve,
  spreadConfig: AtticusSpreadConfig = {}
): FeasibilitySweep => {
  const cells: FeasibilityCell[] = [];
  for (const notionalUsdc of notionals) {
    for (const feeUsdc of fees) {
      const q = solveAndPriceCreditCollar(
        {
          side: base.side ?? "long",
          spot: base.spot,
          notionalUsdc,
          tenorDays: base.tenorDays,
          targetCreditUsdc: feeUsdc,
          maxFloorPct: base.maxFloorPct,
          referenceMode: "position"
        },
        skew,
        spreadConfig
      );
      cells.push({
        notionalUsdc,
        feeUsdc,
        creditBps: +((feeUsdc / notionalUsdc) * 1e4).toFixed(2),
        feasible: q.ok,
        capPct: q.ok ? q.legs.cap_pct : null,
        atticusMarginBps: q.ok ? q.economics.atticus_margin_bps : null,
        crossingDragUsdc: q.ok ? q.fills.crossing_drag_usdc : null,
        reason: q.ok ? null : q.error
      });
    }
  }
  const feasibleCells = cells.filter((c) => c.feasible);
  const caps = feasibleCells.map((c) => c.capPct as number);
  return {
    fillMode: spreadConfig.fillMode === "mid" ? "mid" : "touch",
    cells,
    feasibilityRate: cells.length > 0 ? +(feasibleCells.length / cells.length).toFixed(4) : 0,
    medianCapPctFeasible: caps.length > 0 ? +median(caps).toFixed(4) : null
  };
};
