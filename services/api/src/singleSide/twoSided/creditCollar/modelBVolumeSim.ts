/**
 * Model-B volume-engine sim — Phase A (pure, offline, default-off). The canonical business model:
 * because the book is STEERED FLAT by the inventory signal (Atticus controls what Foxify opens next,
 * inventory-neutral only), Foxify carries little aggregate directional risk, so Atticus's revenue is
 * a thin SERVICE FEE on notional throughput (~1–2.4 bps), NOT a risk premium. The headline is a
 * service-fee revenue line — NOT "fee recovery for Foxify".
 *
 * Validates at $50m/day with high realized netting efficiency (internalize the bulk, perp-hedge the
 * small residual) and REBATES = 0. The one place real capital is at risk is the gap/jump reserve,
 * sized off an imbalanced-residual ±12% BOTH-wing jump (never the average balanced day), plus the
 * intraday stop→TWAP timing gap (deep put is the gap-through backstop; Foxify made whole at 24h TWAP).
 *
 * EV guardrail (Model-B-proof): Foxify EV ≤ −Atticus service fee, hard-rejected if positive. The
 * volume framing does NOT relax this.
 */

import { solveAndPriceCreditCollar, type PerpSide } from "./creditCollarPricer";
import { linearDownsideSkew } from "./skew";
import { recommendNextSide, assertInventoryNeutralPolicy, type InventoryPolicy } from "./inventoryBalancer";

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
const round2 = (x: number) => +x.toFixed(2);

export type ModelBConfig = {
  dailyNotionalUsdc: number;
  avgPositionNotionalUsdc: number;
  spot: number;
  tenorDays: number;
  maxFloorPct: number;
  atmIv: number;
  skewSlopePer10pct: number;

  /** Atticus's service fee (the revenue), bps of notional throughput. */
  serviceFeeBps: number;
  /** Service fee floor per position, USDC. */
  minServiceFeeUsdc: number;
  /** Foxify per-position fee/credit as bps of notional — the REMAINING CALIBRATION UNKNOWN. */
  creditBpsOfNotional: number;

  /** How reliably the inventory signal steers flow toward net-flat (1 = perfect control). */
  steerComplianceProb: number;
  /**
   * Streakiness of the UNSTEERED arrivals in [0,1]: 0 = iid (self-cancelling noise), 1 = highly
   * persistent runs (long for an hour, short the next). This is what makes intra-window concurrency
   * bite — uncontrolled streaky flow accumulates net delta before the signal can correct it.
   */
  flowStreakiness: number;
  /** Inventory band the signal targets. */
  targetNetBandPct: number;

  // perp residual hedge (internalize the bulk, hedge the small residual)
  perpTopOfBookBps: number;
  perpDepthUsdc: number;
  perpImpactCoefBps: number;
  dailyRehedgeTurnover: number;

  // reserve / capital
  reserveMultiple: number;
  costOfCapitalAnnual: number;
  stressJumpPct: number;                // ±jump for the both-wing reserve (e.g. 0.12)
  /** Extra reserve for the stop→24h-TWAP timing gap (deep-put gap-through backstop), as a fraction. */
  intradayTimingBufferPct: number;

  /**
   * MEASURED exchange initial margin to carry ONE short option leg, as a fraction of that leg's
   * notional (e.g. 0.132 from the Deribit margin sweep for a ~2% OTM 3-day call). Opt-in: 0/undefined
   * ⟹ legacy behaviour (no option-margin capital booked, e.g. pure perp-residual hedging).
   */
  shortOptionImFraction?: number;
  /**
   * Gross short-option notional carried at the hedge venue as a fraction of DAILY GROSS — i.e. how
   * much option exposure is back-to-back hedged with short options rather than perps, accounting for
   * tenor overlap. A delta-flat OPTIONS book still posts margin on BOTH short wings (no delta netting),
   * so this is driven by GROSS, not net. Default 0 (no option-margin capital).
   */
  shortOptionGrossNotionalFraction?: number;
  /**
   * Portfolio-margin netting factor in [0,1] applied to the short-option margin: 1 = isolated/multi-
   * ccy (no offset between the long put and short call), <1 = portfolio margin nets the long leg
   * against the short leg (OKX/Deribit PM). Default 1 (conservative, no netting).
   */
  portfolioMarginNettingFactor?: number;
  /**
   * Max peak directional exposure (peak |net| / daily gross) the book may carry before it is deemed
   * to have crossed from "service fee on a flat book" into forbidden directional WAREHOUSING. Above
   * this, Model B is not viable as a service business — the system must HALT/de-risk, not warehouse.
   * Default 0.15.
   */
  maxDirectionalExposureBand: number;

  days: number;
  seed: number;
};

export type ModelBResult =
  | {
      ok: true;
      label: "model_b_service_fee_volume_engine";
      inputs: ModelBConfig;
      positionsPerDay: number;
      feasibilityRate: number;
      foxifyFeeBps: number;               // the calibration unknown, echoed
      // ── flow / inventory ──
      realizedNettingEfficiency: number;  // 1 − avg|net|/gross (steered-flat quality)
      avgIntradayResidualUsdc: number;
      peakNetLongUsdc: number;
      peakNetShortUsdc: number;
      /** peak |net| / daily gross — above maxDirectionalExposureBand = forbidden warehousing. */
      peakDirectionalExposureRatio: number;
      // ── revenue (SERVICE FEE, not fee recovery) ──
      serviceFeeRevenuePerDayUsdc: number;
      serviceFeeBpsRealized: number;
      perpHedgeCostPerDayUsdc: number;
      reserveCapitalCostPerDayUsdc: number;
      netServiceRevenuePerDayUsdc: number;
      annualizedNetUsdc: number;
      annualizedNetBps: number;
      // ── reserve (the only real-capital risk) ──
      reserveDownWingUsdc: number;
      reserveUpWingUsdc: number;
      reserveBindingWing: "down" | "up";
      intradayTimingGapReserveUsdc: number;
      /** Measured exchange margin posted to carry the short option legs of the hedge (0 if perp-only). */
      shortOptionMarginUsdc: number;
      shortOptionMarginCostPerDayUsdc: number;
      reserveUsdc: number;
      // ── guardrail ──
      foxifyEvPerPositionUsdc: number;    // = −service fee (must be ≤ −service fee)
      evGuardrailHeld: boolean;
      verdict: "VIABLE_AT_REBATES_ZERO" | "MARGINAL" | "NOT_VIABLE";
      notes: string[];
    }
  | { ok: false; error: string; message: string };

/**
 * Run the Model-B volume sim. Pure + deterministic. Steers flow flat via the inventory signal,
 * measures realized netting efficiency, and proves the service fee clears perp + reserve cost at
 * rebates = 0 — while the reserve survives the imbalanced ±12% both-wing jump + timing gap.
 */
export const simulateModelBVolume = (cfg: ModelBConfig): ModelBResult => {
  if (!(cfg.dailyNotionalUsdc > 0)) return { ok: false, error: "invalid_notional", message: "dailyNotionalUsdc must be > 0" };
  if (!(cfg.avgPositionNotionalUsdc > 0)) return { ok: false, error: "invalid_position", message: "avgPositionNotionalUsdc must be > 0" };
  if (!(cfg.days > 0)) return { ok: false, error: "invalid_days", message: "days must be > 0" };

  const policy: InventoryPolicy = { targetNetBandPct: cfg.targetNetBandPct, allowDirectionalBias: false, directionalTiltSigned: 0 };
  assertInventoryNeutralPolicy(policy); // hard rule: no directional warehousing

  const rng = mulberry32(cfg.seed >>> 0);
  const skew = linearDownsideSkew(cfg.spot, cfg.atmIv, cfg.skewSlopePer10pct);
  const positionsPerDay = Math.max(1, Math.round(cfg.dailyNotionalUsdc / cfg.avgPositionNotionalUsdc));
  const serviceFeeFor = (notional: number) => Math.max((notional * cfg.serviceFeeBps) / 1e4, cfg.minServiceFeeUsdc);

  // ── Feasibility + EV guardrail on a representative ticket priced at MID (internalize path) ──
  let feasible = 0;
  let evHeld = true;
  let evPerPosition = 0;
  const sampleN = Math.min(positionsPerDay, 200);
  for (let i = 0; i < sampleN; i++) {
    const notional = cfg.avgPositionNotionalUsdc;
    const credit = (notional * cfg.creditBpsOfNotional) / 1e4;
    const serviceFee = serviceFeeFor(notional);
    const q = solveAndPriceCreditCollar(
      { side: "long", spot: cfg.spot, notionalUsdc: notional, tenorDays: cfg.tenorDays, targetCreditUsdc: credit, maxFloorPct: cfg.maxFloorPct, referenceMode: "net_book_delta" },
      skew,
      { fillMode: "mid", spreadBps: 0, minMarginUsdc: serviceFee }
    );
    if (q.ok) {
      feasible++;
      evPerPosition = q.economics.foxify_market_implied_ev_usdc;
      // Model-B-proof guardrail: Foxify EV ≤ −service fee (never positive).
      if (!(q.economics.foxify_market_implied_ev_usdc <= -serviceFee + 1e-6)) evHeld = false;
    }
  }
  const feasibilityRate = sampleN > 0 ? feasible / sampleN : 0;

  // ── Simulate inventory-steered flow over the days; measure realized netting efficiency + residual ──
  let sumAbsNetOverPositions = 0;
  let countNetSamples = 0;
  let peakNetLong = 0;
  let peakNetShort = 0;

  for (let d = 0; d < cfg.days; d++) {
    let longN = 0;
    let shortN = 0;
    let baseSide: PerpSide = rng() < 0.5 ? "long" : "short"; // the client-driven arrival side
    for (let i = 0; i < positionsPerDay; i++) {
      const notional = cfg.avgPositionNotionalUsdc;
      const gross = longN + shortN;
      const net = longN - shortN;
      const imbalance = gross > 0 ? Math.abs(net) / gross : 0;
      const inv = {
        longNotionalUsdc: longN,
        shortNotionalUsdc: shortN,
        grossNotionalUsdc: gross,
        netNotionalUsdc: net,
        imbalanceRatio: imbalance,
        withinBand: imbalance <= cfg.targetNetBandPct
      };
      const rec = recommendNextSide(inv, notional, policy);
      // Client arrivals run in STREAKS: keep baseSide with prob streakiness, else flip to a fresh draw.
      if (rng() >= cfg.flowStreakiness) baseSide = rng() < 0.5 ? "long" : "short";
      // Atticus steers (flattening side) only on the fraction it can control; otherwise the streaky
      // client arrival goes through and accumulates net delta.
      const side: PerpSide = rng() < cfg.steerComplianceProb ? rec.side : baseSide;
      if (side === "long") longN += notional;
      else shortN += notional;
      const newNet = longN - shortN;
      sumAbsNetOverPositions += Math.abs(newNet);
      countNetSamples += 1;
      if (newNet > peakNetLong) peakNetLong = newNet;
      if (-newNet > peakNetShort) peakNetShort = -newNet;
    }
  }

  const grossPerDay = positionsPerDay * cfg.avgPositionNotionalUsdc;
  const avgIntradayResidual = countNetSamples > 0 ? sumAbsNetOverPositions / countNetSamples : 0;
  const realizedNettingEfficiency = grossPerDay > 0 ? Math.max(0, 1 - avgIntradayResidual / grossPerDay) : 0;

  // ── Service-fee revenue (the headline) ──
  const serviceFeeRevenuePerDay = positionsPerDay * serviceFeeFor(cfg.avgPositionNotionalUsdc);
  const serviceFeeBpsRealized = grossPerDay > 0 ? (serviceFeeRevenuePerDay / grossPerDay) * 1e4 : 0;

  // ── Perp residual hedge cost (depth/impact at the residual clip) ──
  const perpImpactBps = cfg.perpDepthUsdc > 0 ? cfg.perpImpactCoefBps * (avgIntradayResidual / cfg.perpDepthUsdc) : 0;
  const perpHedgeCostPerDay = (avgIntradayResidual * (cfg.perpTopOfBookBps + perpImpactBps)) / 1e4 * cfg.dailyRehedgeTurnover;

  // ── Reserve: imbalanced-residual ±12% BOTH-wing jump (peak intraday, not average) + timing gap ──
  const stressExcess = Math.max(0, cfg.stressJumpPct - cfg.maxFloorPct);
  const downWing = peakNetLong * stressExcess * cfg.reserveMultiple;   // put wing (−jump, long-heavy residual)
  const upWing = peakNetShort * stressExcess * cfg.reserveMultiple;    // call wing (+jump, short-heavy residual)
  const jumpWing = Math.max(downWing, upWing);
  const bindingWing: "down" | "up" = downWing >= upWing ? "down" : "up";
  const timingGapReserve = jumpWing * cfg.intradayTimingBufferPct;     // stop-instant → 24h TWAP carry

  // ── Measured short-option exchange margin (opt-in; from the Deribit margin sweep) ──
  // A delta-flat OPTIONS book still posts IM on BOTH short wings (margin doesn't net on delta), so
  // this scales with GROSS short-option notional carried at the hedge venue, not the net residual.
  const imFraction = cfg.shortOptionImFraction ?? 0;
  const grossOptFraction = cfg.shortOptionGrossNotionalFraction ?? 0;
  const pmNetting = cfg.portfolioMarginNettingFactor ?? 1;
  const shortOptionGrossNotional = grossPerDay * grossOptFraction;
  const shortOptionMargin = shortOptionGrossNotional * imFraction * pmNetting;
  const shortOptionMarginCostPerDay = (shortOptionMargin * cfg.costOfCapitalAnnual) / 365;

  const reserve = jumpWing + timingGapReserve + shortOptionMargin;
  const reserveCapitalCostPerDay = ((jumpWing + timingGapReserve) * cfg.costOfCapitalAnnual) / 365;

  const netServiceRevenuePerDay = serviceFeeRevenuePerDay - perpHedgeCostPerDay - reserveCapitalCostPerDay - shortOptionMarginCostPerDay;
  const annualizedNet = netServiceRevenuePerDay * 365;
  const annualizedNetBps = grossPerDay > 0 ? (netServiceRevenuePerDay / grossPerDay) * 1e4 : 0;

  const peakDirectionalExposureRatio = grossPerDay > 0 ? Math.max(peakNetLong, peakNetShort) / grossPerDay : 1;
  // The book must stay genuinely FLAT (a service business). Crossing the band = directional
  // warehousing (forbidden) ⟹ NOT viable as Model B regardless of nominal fee coverage, because the
  // running P&L only charges cost-of-capital on the reserve, not the tail LOSS a directional book
  // takes when the jump actually hits.
  const flatBook = peakDirectionalExposureRatio <= cfg.maxDirectionalExposureBand;
  const isViable = netServiceRevenuePerDay > 0 && evHeld && feasibilityRate >= 0.6 && flatBook;
  const isMarginal = netServiceRevenuePerDay > 0 && evHeld && feasibilityRate >= 0.6 && !flatBook && peakDirectionalExposureRatio <= 2 * cfg.maxDirectionalExposureBand;

  return {
    ok: true,
    label: "model_b_service_fee_volume_engine",
    inputs: cfg,
    positionsPerDay,
    feasibilityRate: +feasibilityRate.toFixed(4),
    foxifyFeeBps: cfg.creditBpsOfNotional,
    realizedNettingEfficiency: +realizedNettingEfficiency.toFixed(4),
    avgIntradayResidualUsdc: round2(avgIntradayResidual),
    peakNetLongUsdc: round2(peakNetLong),
    peakNetShortUsdc: round2(peakNetShort),
    peakDirectionalExposureRatio: +peakDirectionalExposureRatio.toFixed(4),
    serviceFeeRevenuePerDayUsdc: round2(serviceFeeRevenuePerDay),
    serviceFeeBpsRealized: +serviceFeeBpsRealized.toFixed(4),
    perpHedgeCostPerDayUsdc: round2(perpHedgeCostPerDay),
    reserveCapitalCostPerDayUsdc: round2(reserveCapitalCostPerDay),
    netServiceRevenuePerDayUsdc: round2(netServiceRevenuePerDay),
    annualizedNetUsdc: round2(annualizedNet),
    annualizedNetBps: +annualizedNetBps.toFixed(4),
    reserveDownWingUsdc: round2(downWing),
    reserveUpWingUsdc: round2(upWing),
    reserveBindingWing: bindingWing,
    intradayTimingGapReserveUsdc: round2(timingGapReserve),
    shortOptionMarginUsdc: round2(shortOptionMargin),
    shortOptionMarginCostPerDayUsdc: round2(shortOptionMarginCostPerDay),
    reserveUsdc: round2(reserve),
    foxifyEvPerPositionUsdc: round2(evPerPosition),
    evGuardrailHeld: evHeld,
    verdict: !evHeld ? "NOT_VIABLE" : isViable ? "VIABLE_AT_REBATES_ZERO" : isMarginal ? "MARGINAL" : "NOT_VIABLE",
    notes: [
      "Model B: revenue is a SERVICE FEE on notional throughput, NOT fee recovery / risk premium.",
      "Book steered flat by the inventory signal (net-book-delta, inventory-neutral only; no directional warehousing).",
      "Internalize the bulk; perp-hedge the small intraday residual (depth/impact priced at the clip).",
      "Reserve = imbalanced ±12% both-wing jump on the PEAK intraday residual + stop→24h-TWAP timing gap.",
      "Rebates = 0 (viability bar). EV guardrail enforced: Foxify EV ≤ −service fee.",
      "Foxify per-position fee (bps of notional) is the remaining calibration unknown — feasibility shown as a function of it.",
      imFraction > 0
        ? `Short-option exchange margin booked: measured IM ${(imFraction * 100).toFixed(1)}%/notional × ${(grossOptFraction * 100).toFixed(0)}% gross option carry × PM netting ${pmNetting} ⟹ $${round2(shortOptionMargin)} capital (cost $${round2(shortOptionMarginCostPerDay)}/day). Flat OPTIONS books post IM on BOTH short wings — use Portfolio Margin to net.`
        : "Short-option exchange margin NOT booked (perp-residual hedging assumed; set shortOptionImFraction + shortOptionGrossNotionalFraction from the Deribit margin sweep to include it)."
    ]
  };
};
