/**
 * Hedge-architecture comparison — Phase A (pure, offline, deterministic, default-off).
 *
 * Phase 0 review (architecture): per-position BACK-TO-BACK on Bullish options is the most
 * expensive way to hedge this book. The option leg-crossing (~10% of premium) is NOT Atticus's
 * cost — it is FOXIFY's, paid in forgone upside (a tighter cap), and at $33–62/position it dwarfs
 * Atticus's ~$12 margin. A real options desk instead:
 *   1. INTERNALIZES the book — long-perp clients hand Atticus short puts, short-perp clients hand
 *      it short calls; on balanced flow these largely net in DELTA before any venue is touched.
 *   2. PERP-DELTA-HEDGES the net residual (perp ~1–2 bps vs ~10% of option premium → 10–30× cheaper).
 *   3. Sizes the RESERVE on the gross/netted warehoused book (delta hedge works in normal times,
 *      FAILS over a jump) — the gamma/gap tail.
 *   4. Uses back-to-back options only opportunistically for tail-shaping when a leg is cheap.
 *
 * This module compares the two architectures on the SAME book and the SAME Atticus profit, and
 * exposes the decision boundary as a function of the (to-be-MEASURED) Bullish option spread. It
 * does NOT pick the architecture — the measurement does. No live services; nothing imports this yet.
 */

import { solveAndPriceCreditCollar, type CreditCollarParams, type PerpSide, type AtticusSpreadConfig } from "./creditCollarPricer";
import { linearDownsideSkew } from "./skew";

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
const stdNormal = (rng: () => number) => {
  const u1 = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
};
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(0.5 * (s.length - 1))];
};
const round2 = (x: number) => +x.toFixed(2);
const round4 = (x: number) => +x.toFixed(4);

export type BookSpec = {
  spot: number;
  tenorDays: number;
  maxFloorPct: number;
  atmIv: number;
  skewSlopePer10pct: number;
  dailyNotionalUsdc: number;
  avgPositionNotionalUsdc: number;
  notionalLogSdPct: number;
  creditMode: "fixed_usdc" | "bps_of_notional";
  creditPerPositionUsdc: number;
  creditBpsOfNotional: number;
  longFraction: number;
  /** Net long bias in [−1,1]; drives the perp-hedge residual + the imbalanced-jump reserve. */
  netLongBias: number;
  seed: number;
};

export type CostModel = {
  /** Atticus's clean profit spread (held EQUAL across architectures), bps of notional. */
  profitBps: number;
  /** Atticus's clean profit floor, USDC/position. */
  minProfitUsdc: number;
  // ── back-to-back option execution (the MEASUREMENT that decides the architecture) ──
  optionRelHalfSpreadPct: number;       // per-leg half-spread as fraction of mid premium (flat fallback)
  optionAbsHalfSpreadUsdcPerBtc: number;
  backToBackWarehouseFraction: number;  // fraction NOT back-to-backed (reserve-bearing)
  /** MEASUREMENT-READY: wing/tenor-aware option half-spread at the ACTUAL strikes (overrides flat). */
  optionLegSpread?: AtticusSpreadConfig["legHalfSpreadUsdcPerBtc"];
  // ── internalize + perp residual hedge ──
  /**
   * Flow concurrency (Phase 0 review #1): fraction of the offsetting min(long,short) that actually
   * NETS within the hedging window. 1 = well-netted concurrent two-sided flow; 0 = streaky/directional
   * flow that nets nothing (Atticus warehouses gross). Drives the perp residual + the gap reserve.
   */
  nettingEfficiency: number;
  perpTopOfBookBps: number;             // perp top-of-book half-spread, bps of notional
  perpDepthUsdc: number;                // perp depth available near top of book (for the impact term)
  perpImpactCoefBps: number;            // impact bps per (clip / depth) — clip walks the book at scale
  dailyRehedgeTurnover: number;         // × residual notional re-hedged per day
  // ── shared reserve / capital ──
  reserveMultiple: number;
  costOfCapitalAnnual: number;
  stressJumpPct: number;                // correlated jump for the reserve, applied BOTH directions (±)
};

export type ArchResult = {
  architecture: "back_to_back" | "internalize_perp";
  positionsPerDay: number;
  feasibilityRate: number;
  medianCapPct: number;                 // upside Foxify surrenders (smaller = worse product)
  foxifyCostPerPositionUsdc: number;    // all-in cost above Foxify's own fee (the product price)
  atticusProfitPerDayUsdc: number;      // clean spread (held equal across architectures)
  residualDeltaNotionalUsdc: number;    // perp-hedged residual after concurrency netting
  perpHedgeCostPerDayUsdc: number;
  reserveUsdc: number;
  reserveDownWingUsdc: number;          // put-wing demand (−jump, long-perp clients)
  reserveUpWingUsdc: number;            // call-wing demand (+jump, short-perp clients)
  reserveBindingWing: "down" | "up";
  reserveCapitalCostPerDayUsdc: number;
  atticusNetPerDayUsdc: number;         // profit − Atticus-borne costs
  atticusNetPerYearUsdc: number;
  notes: string[];
};

export type ArchComparison = {
  inputs: { book: BookSpec; cost: CostModel };
  backToBack: ArchResult;
  internalizePerp: ArchResult;
  foxifyCostSavingPerPositionUsdc: number;   // back_to_back − internalize_perp (positive = internalize wins)
  feasibilityDeltaPct: number;               // internalize − back_to_back
  recommendation: string;
};

type Ticket = { side: PerpSide; notional: number; credit: number };

const buildBook = (book: BookSpec): Ticket[] => {
  const rng = mulberry32(book.seed >>> 0);
  const n = Math.max(1, Math.round(book.dailyNotionalUsdc / book.avgPositionNotionalUsdc));
  const tickets: Ticket[] = [];
  for (let i = 0; i < n; i++) {
    const side: PerpSide = rng() < book.longFraction ? "long" : "short";
    const z = stdNormal(rng);
    const sd = book.notionalLogSdPct;
    const notional = sd > 0 ? book.avgPositionNotionalUsdc * Math.exp(z * sd - 0.5 * sd * sd) : book.avgPositionNotionalUsdc;
    const credit = book.creditMode === "bps_of_notional" ? (notional * book.creditBpsOfNotional) / 1e4 : book.creditPerPositionUsdc;
    tickets.push({ side, notional, credit });
  }
  return tickets;
};

const profitFor = (cost: CostModel, notional: number) => Math.max((notional * cost.profitBps) / 1e4, cost.minProfitUsdc);

/**
 * Compare back-to-back vs internalize+perp on the same book and the same Atticus profit. Pure.
 */
export const compareHedgeArchitectures = (book: BookSpec, cost: CostModel): ArchComparison => {
  const skew = linearDownsideSkew(book.spot, book.atmIv, book.skewSlopePer10pct);
  const tickets = buildBook(book);
  const positions = tickets.length;

  const grossNotional = tickets.reduce((s, t) => s + t.notional, 0);
  const longNotional = tickets.filter((t) => t.side === "long").reduce((s, t) => s + t.notional, 0);
  const shortNotional = grossNotional - longNotional;
  const minSide = Math.min(longNotional, shortNotional);
  // Concurrency netting: only the concurrently-open offsetting min side nets, scaled by efficiency.
  const residualDeltaNotional = grossNotional - 2 * cost.nettingEfficiency * minSide;
  const stressExcess = Math.max(0, cost.stressJumpPct - book.maxFloorPct);

  const atticusProfitPerDay = tickets.reduce((s, t) => s + profitFor(cost, t.notional), 0);

  // Reserve stresses BOTH wings (Phase 0 review #2): a −jump hits the PUT wing (long-perp clients'
  // short puts); a +jump hits the CALL wing (short-perp clients' short calls). Size off whichever
  // the client mix concentrates. Delta hedge fails over the gap ⟹ full wing intrinsic.
  const wingReserve = (notionalOnWing: number) => notionalOnWing * stressExcess * cost.reserveMultiple;

  // ── Internalize + perp: book-level costs Atticus bears (then passed into Foxify's price). ──
  // Perp residual hedge with depth/impact at the clip you'd actually trade (not free 1.5 bps).
  const perpImpactBps = cost.perpDepthUsdc > 0 ? cost.perpImpactCoefBps * (residualDeltaNotional / cost.perpDepthUsdc) : 0;
  const perpHedgeCostPerDay = (residualDeltaNotional * (cost.perpTopOfBookBps + perpImpactBps)) / 1e4 * cost.dailyRehedgeTurnover;
  const intDownWing = wingReserve(longNotional);   // whole long side is naked-short puts (perp-only hedge)
  const intUpWing = wingReserve(shortNotional);
  const intReserve = Math.max(intDownWing, intUpWing);
  const intBindingWing: "down" | "up" = intDownWing >= intUpWing ? "down" : "up";
  const intReserveCapCostPerDay = (intReserve * cost.costOfCapitalAnnual) / 365;
  const intBookCostPerDay = perpHedgeCostPerDay + intReserveCapCostPerDay;
  const intBookCostPerPosition = positions > 0 ? intBookCostPerDay / positions : 0;

  // ── Back-to-back: option crossing is borne by FOXIFY (forgone upside). Atticus bears only the
  //    (small) reserve on the warehoused, un-back-to-backed fraction — also both wings. ──
  const wf = cost.backToBackWarehouseFraction;
  const b2bDownWing = wingReserve(longNotional * wf);
  const b2bUpWing = wingReserve(shortNotional * wf);
  const b2bReserve = Math.max(b2bDownWing, b2bUpWing);
  const b2bBindingWing: "down" | "up" = b2bDownWing >= b2bUpWing ? "down" : "up";
  const b2bReserveCapCostPerDay = (b2bReserve * cost.costOfCapitalAnnual) / 365;

  // Price each ticket under each architecture (same profit; different fills + Foxify-borne costs).
  let b2bFeasible = 0;
  let intFeasible = 0;
  const b2bCaps: number[] = [];
  const intCaps: number[] = [];
  const b2bFoxifyCosts: number[] = [];
  const intFoxifyCosts: number[] = [];

  for (const t of tickets) {
    const profit = profitFor(cost, t.notional);
    const common: CreditCollarParams = {
      side: t.side,
      spot: book.spot,
      notionalUsdc: t.notional,
      tenorDays: book.tenorDays,
      targetCreditUsdc: t.credit,
      maxFloorPct: book.maxFloorPct,
      referenceMode: "position"
    };

    // Back-to-back: touch fills; Atticus keeps `profit`; the credit must ALSO fund the option crossing.
    // Wing-aware spread at the actual strikes if supplied (measurement-ready), else flat fallback.
    const b2b = solveAndPriceCreditCollar(common, skew, {
      fillMode: "touch",
      relativeHalfSpreadPct: cost.optionRelHalfSpreadPct,
      absHalfSpreadUsdcPerBtc: cost.optionAbsHalfSpreadUsdcPerBtc,
      legHalfSpreadUsdcPerBtc: cost.optionLegSpread,
      spreadBps: 0,
      minMarginUsdc: profit
    });
    if (b2b.ok) {
      b2bFeasible++;
      b2bCaps.push(b2b.legs.cap_pct);
      // Foxify pays profit + the option crossing drag (in forgone upside).
      b2bFoxifyCosts.push(profit + b2b.fills.crossing_drag_usdc);
    }

    // Internalize+perp: mid fills (no option crossing); Atticus's margin = profit + book-cost passthrough.
    const intMargin = profit + intBookCostPerPosition;
    const int = solveAndPriceCreditCollar(common, skew, {
      fillMode: "mid",
      spreadBps: 0,
      minMarginUsdc: intMargin
    });
    if (int.ok) {
      intFeasible++;
      intCaps.push(int.legs.cap_pct);
      intFoxifyCosts.push(intMargin);
    }
  }

  const b2bResult: ArchResult = {
    architecture: "back_to_back",
    positionsPerDay: positions,
    feasibilityRate: round4(b2bFeasible / positions),
    medianCapPct: round4(median(b2bCaps)),
    foxifyCostPerPositionUsdc: round2(median(b2bFoxifyCosts)),
    atticusProfitPerDayUsdc: round2(atticusProfitPerDay),
    residualDeltaNotionalUsdc: 0,
    perpHedgeCostPerDayUsdc: 0,
    reserveUsdc: round2(b2bReserve),
    reserveDownWingUsdc: round2(b2bDownWing),
    reserveUpWingUsdc: round2(b2bUpWing),
    reserveBindingWing: b2bBindingWing,
    reserveCapitalCostPerDayUsdc: round2(b2bReserveCapCostPerDay),
    atticusNetPerDayUsdc: round2(atticusProfitPerDay - b2bReserveCapCostPerDay),
    atticusNetPerYearUsdc: round2((atticusProfitPerDay - b2bReserveCapCostPerDay) * 365),
    notes: [
      "Option crossing is borne by FOXIFY in forgone upside (a tighter cap), not by Atticus.",
      "Atticus net = clean profit − cost-of-capital on the small warehoused reserve."
    ]
  };

  const intResult: ArchResult = {
    architecture: "internalize_perp",
    positionsPerDay: positions,
    feasibilityRate: round4(intFeasible / positions),
    medianCapPct: round4(median(intCaps)),
    foxifyCostPerPositionUsdc: round2(median(intFoxifyCosts)),
    atticusProfitPerDayUsdc: round2(atticusProfitPerDay),
    residualDeltaNotionalUsdc: round2(residualDeltaNotional),
    perpHedgeCostPerDayUsdc: round2(perpHedgeCostPerDay),
    reserveUsdc: round2(intReserve),
    reserveDownWingUsdc: round2(intDownWing),
    reserveUpWingUsdc: round2(intUpWing),
    reserveBindingWing: intBindingWing,
    reserveCapitalCostPerDayUsdc: round2(intReserveCapCostPerDay),
    // Atticus passes book costs into Foxify's price, so it keeps the clean profit.
    atticusNetPerDayUsdc: round2(atticusProfitPerDay),
    atticusNetPerYearUsdc: round2(atticusProfitPerDay * 365),
    notes: [
      "Foxify is priced at MID (no option crossing) ⟹ surrenders far less upside for the same fee coverage.",
      "Atticus bears perp-hedge crossing + cost-of-capital on the LARGER gross/netted reserve, passed into margin.",
      "Reserve sized on the gross netted book under an imbalanced jump with the delta hedge failing over the gap."
    ]
  };

  const saving = b2bResult.foxifyCostPerPositionUsdc - intResult.foxifyCostPerPositionUsdc;
  const feasDelta = intResult.feasibilityRate - b2bResult.feasibilityRate;

  return {
    inputs: { book, cost },
    backToBack: b2bResult,
    internalizePerp: intResult,
    foxifyCostSavingPerPositionUsdc: round2(saving),
    feasibilityDeltaPct: round4(feasDelta),
    recommendation:
      saving > 0
        ? `internalize_perp cheaper for Foxify by $${round2(saving)}/position and widens feasibility by ${(feasDelta * 100).toFixed(0)}pts — prefer it UNLESS measured Bullish option spread is tight enough to flip this.`
        : `back_to_back competitive here (measured option spread is tight). Keep it; use perp-residual only for overflow.`
  };
};

// ──────────────────────────────────────────────────────────────────────────────
// Decision boundary: Foxify cost vs the (to-be-MEASURED) Bullish option half-spread.
// back-to-back cost scales with the option spread; internalize+perp does not. The crossover is the
// option spread below which back-to-back is the better product. MEASURE, don't assume.
// ──────────────────────────────────────────────────────────────────────────────

export type DecisionBoundaryRow = {
  optionRelHalfSpreadPct: number;
  backToBackFoxifyCostUsdc: number;
  internalizePerpFoxifyCostUsdc: number;
  backToBackCheaper: boolean;
};

// ──────────────────────────────────────────────────────────────────────────────
// Flow-concurrency sensitivity (Phase 0 review #1): the internalize line height depends on TEMPORAL
// two-sidedness, not just net balance. Streaky/directional flow nets nothing within the window →
// the perp residual + gap reserve grow → Foxify's internalize cost rises. Plot the two extremes so
// we see whether the ~2% crossover is robust or swings with Foxify's flow pattern.
// ──────────────────────────────────────────────────────────────────────────────

export type FlowSensitivityRow = {
  nettingEfficiency: number;
  residualDeltaNotionalUsdc: number;
  perpHedgeCostPerDayUsdc: number;
  reserveUsdc: number;
  internalizeFoxifyCostPerPositionUsdc: number;
};

export const internalizeLineFlowSensitivity = (
  book: BookSpec,
  cost: CostModel,
  nettingEfficiencies: number[]
): FlowSensitivityRow[] =>
  nettingEfficiencies.map((e) => {
    const cmp = compareHedgeArchitectures(book, { ...cost, nettingEfficiency: e });
    return {
      nettingEfficiency: e,
      residualDeltaNotionalUsdc: cmp.internalizePerp.residualDeltaNotionalUsdc,
      perpHedgeCostPerDayUsdc: cmp.internalizePerp.perpHedgeCostPerDayUsdc,
      reserveUsdc: cmp.internalizePerp.reserveUsdc,
      internalizeFoxifyCostPerPositionUsdc: cmp.internalizePerp.foxifyCostPerPositionUsdc
    };
  });

export const optionSpreadDecisionBoundary = (
  book: BookSpec,
  cost: CostModel,
  optionHalfSpreads: number[]
): { rows: DecisionBoundaryRow[]; crossoverHalfSpreadPct: number | null } => {
  const rows: DecisionBoundaryRow[] = [];
  let crossover: number | null = null;
  let prev: DecisionBoundaryRow | null = null;
  for (const s of [...optionHalfSpreads].sort((a, b) => a - b)) {
    const cmp = compareHedgeArchitectures(book, { ...cost, optionRelHalfSpreadPct: s });
    const row: DecisionBoundaryRow = {
      optionRelHalfSpreadPct: s,
      backToBackFoxifyCostUsdc: cmp.backToBack.foxifyCostPerPositionUsdc,
      internalizePerpFoxifyCostUsdc: cmp.internalizePerp.foxifyCostPerPositionUsdc,
      backToBackCheaper: cmp.backToBack.foxifyCostPerPositionUsdc <= cmp.internalizePerp.foxifyCostPerPositionUsdc
    };
    if (prev && prev.backToBackCheaper && !row.backToBackCheaper) crossover = s;
    rows.push(row);
    prev = row;
  }
  return { rows, crossoverHalfSpreadPct: crossover };
};
