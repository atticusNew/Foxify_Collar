/**
 * Pricing harness report — Phase A (pure, offline). Feeds the CAPTURED venue dataset into the
 * existing credit solver + hedge-architecture comparison + Model-B sim and emits, on a single run,
 * every remaining priced input to greenlight Tier 1:
 *   - measured spreads/depth summary + daily-option-listing answer,
 *   - credit + feasibility + cap tightness + crossing drag for a $50k position at the (parameterized) fee,
 *   - whether the ~2 bps service fee survives REAL hedge costs at rebates = 0, per ramp tier,
 *   - the soft venue-routing recommendation.
 *
 * Fee is PARAMETERIZED (slot in $75 when confirmed). Skew + leg spreads are built from REAL captured
 * mids/spreads; perp cost from REAL captured depth/impact. Pure: takes the dataset, no I/O.
 */

import { impliedVolFromPrice } from "../../../../../scripts/backtest/singleSide/coreEngine";
import { solveAndPriceCreditCollar, type SkewCurve, type AtticusSpreadConfig } from "../creditCollarPricer";
import { compareHedgeArchitectures, type BookSpec, type CostModel } from "../hedgeArchitectureCompare";
import { simulateModelBVolume, type ModelBConfig } from "../modelBVolumeSim";
import { recommendRouting, type RoutingConfig, type LegRouting } from "./routing";
import type { CaptureDataset, Venue, WingSpreadRow } from "./capture";

const RFR = 0.045;
const round2 = (x: number) => +x.toFixed(2);

export type HarnessReportConfig = {
  positionNotionalUsdc: number;     // $50k
  feeUsdc: number | null;           // PARAMETERIZED — Foxify fee target ($75 when confirmed)
  serviceFeeBps: number;            // ~2 bps target
  minServiceFeeUsdc: number;
  tenorDays: number;                // prefer daily/~1d
  maxFloorPct: number;              // floor ~3–5% OTM
  rampTiersDailyUsd: number[];      // $100k → $50m
  peakResidualPct: number;          // ~0.11 (clip = tier × this)
  reserveMultiple: number;
  costOfCapitalAnnual: number;
  stressJumpPct: number;
  intradayTimingBufferPct: number;
  routing: RoutingConfig;
};

// ── Skew curve from captured mids (real implied vol per wing strike) ──────────

const buildSkewFromCapture = (
  dataset: CaptureDataset,
  tenorDays: number
): { skew: SkewCurve; points: Array<{ strike: number; iv: number }>; ok: boolean } => {
  const spot = dataset.spotUsd;
  const T = tenorDays / 365;
  // Median mid per (strike,optType) across venues at ~the requested tenor.
  const byKey = new Map<string, number[]>();
  const strikeType = new Map<string, { strike: number; optType: "put" | "call" }>();
  for (const r of dataset.options) {
    if (Math.abs(r.tenorDays - tenorDays) > 1) continue;
    if (r.midUsdcPerBtc == null) continue;
    const optType: "put" | "call" = r.wing === "floor_put" ? "put" : "call";
    const key = `${r.strike}:${optType}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r.midUsdcPerBtc);
    strikeType.set(key, { strike: r.strike, optType });
  }
  const points: Array<{ strike: number; iv: number }> = [];
  for (const [key, mids] of byKey) {
    const st = strikeType.get(key)!;
    const mid = mids.sort((a, b) => a - b)[Math.floor(mids.length / 2)];
    const iv = impliedVolFromPrice(mid, spot, st.strike, T, RFR, st.optType);
    if (iv != null && iv > 0) points.push({ strike: st.strike, iv });
  }
  points.sort((a, b) => a.strike - b.strike);

  const skew: SkewCurve = (strike: number) => {
    if (points.length === 0) return 0.5; // degraded fallback
    if (strike <= points[0].strike) return points[0].iv;
    if (strike >= points[points.length - 1].strike) return points[points.length - 1].iv;
    for (let i = 1; i < points.length; i++) {
      if (strike <= points[i].strike) {
        const a = points[i - 1];
        const b = points[i];
        const w = (strike - a.strike) / (b.strike - a.strike);
        return a.iv + w * (b.iv - a.iv);
      }
    }
    return points[points.length - 1].iv;
  };
  return { skew, points, ok: points.length >= 2 };
};

// ── Leg half-spread model from captured wing spreads (routing-aware) ──────────

const buildLegSpreadFromCapture = (
  dataset: CaptureDataset,
  tenorDays: number,
  routing: LegRouting[]
): NonNullable<AtticusSpreadConfig["legHalfSpreadUsdcPerBtc"]> => {
  const chosenFor = (wing: "floor_put" | "cap_call"): Venue | null => routing.find((r) => r.wing === wing)?.chosenVenue ?? null;
  const rowsFor = (wing: "floor_put" | "cap_call"): WingSpreadRow[] => {
    const v = chosenFor(wing);
    const all = dataset.options.filter((r) => r.wing === wing && Math.abs(r.tenorDays - tenorDays) <= 1 && r.halfSpreadUsdcPerBtc != null);
    const onChosen = v ? all.filter((r) => r.venue === v) : [];
    return (onChosen.length > 0 ? onChosen : all).sort((a, b) => a.strike - b.strike);
  };
  const interp = (rows: WingSpreadRow[], strike: number): number | null => {
    if (rows.length === 0) return null;
    if (strike <= rows[0].strike) return rows[0].halfSpreadUsdcPerBtc;
    if (strike >= rows[rows.length - 1].strike) return rows[rows.length - 1].halfSpreadUsdcPerBtc;
    for (let i = 1; i < rows.length; i++) {
      if (strike <= rows[i].strike) {
        const a = rows[i - 1];
        const b = rows[i];
        const w = (strike - a.strike) / (b.strike - a.strike);
        return (a.halfSpreadUsdcPerBtc as number) + w * ((b.halfSpreadUsdcPerBtc as number) - (a.halfSpreadUsdcPerBtc as number));
      }
    }
    return rows[rows.length - 1].halfSpreadUsdcPerBtc;
  };
  const puts = rowsFor("floor_put");
  const calls = rowsFor("cap_call");
  return ({ strike, optType, midPerBtc }) => {
    const rows = optType === "put" ? puts : calls;
    const v = interp(rows, strike);
    return v != null ? v : Math.max(midPerBtc * 0.1, 1.5); // fallback if a wing wasn't captured
  };
};

// ── Perp all-in cost (top-of-book half-spread + measured impact) at a clip ────

const perpAllInBpsAtClip = (dataset: CaptureDataset, venue: Venue, clipUsd: number): { bps: number; exhausted: boolean } | null => {
  const rows = dataset.perp.filter((p) => p.venue === venue && p.impactBps != null);
  if (rows.length === 0) return null;
  // nearest captured clip; take the worse (max) of buy/sell.
  const clips = [...new Set(rows.map((r) => r.clipUsd))].sort((a, b) => Math.abs(a - clipUsd) - Math.abs(b - clipUsd));
  const nearestClip = clips[0];
  const atClip = rows.filter((r) => r.clipUsd === nearestClip);
  const worst = atClip.sort((a, b) => (b.impactBps as number) - (a.impactBps as number))[0];
  const topHalfBps = worst.topOfBookSpreadBps != null ? worst.topOfBookSpreadBps / 2 : 0;
  return { bps: topHalfBps + (worst.impactBps as number), exhausted: atClip.some((r) => r.bookExhausted) };
};

/** Best perp venue for the residual hedge at a clip: prefer a NON-exhausted book, then the cheapest. */
const bestPerpAtClip = (dataset: CaptureDataset, clipUsd: number): { venue: Venue; bps: number; exhausted: boolean } | null => {
  const venues: Venue[] = ["bullish", "deribit", "okx"];
  const results = venues
    .map((v) => ({ v, r: perpAllInBpsAtClip(dataset, v, clipUsd) }))
    .filter((x): x is { v: Venue; r: { bps: number; exhausted: boolean } } => x.r != null);
  if (results.length === 0) return null;
  results.sort((a, b) => Number(a.r.exhausted) - Number(b.r.exhausted) || a.r.bps - b.r.bps);
  return { venue: results[0].v, bps: results[0].r.bps, exhausted: results[0].r.exhausted };
};

// ── The single-run report ─────────────────────────────────────────────────────

export type HarnessReport = {
  capturedAtMs: number;
  spotUsd: number;
  feeParameterized: boolean;
  dailyOptionListing: Record<Venue, boolean>;
  skewOk: boolean;
  skewIvPoints: Array<{ strike: number; iv: number }>;
  routing: LegRouting[];
  creditQuote:
    | { ok: true; feasible: true; putStrike: number; callStrike: number; capPct: number; floorPct: number; fairCreditMid: number; fundableCredit: number; crossingDrag: number; atticusServiceFeeUsdc: number; foxifyEvUsdc: number }
    | { ok: true; feasible: false; reason: string }
    | { ok: false; reason: string };
  architecture: { backToBackFoxifyCostUsdc: number; internalizeFoxifyCostUsdc: number; recommendation: string } | null;
  serviceFeeSurvives: Array<{ tierDailyUsd: number; clipUsd: number; perpVenue: Venue | null; perpAllInBps: number | null; bookExhausted: boolean; netPerDayUsdc: number; annualNetUsdc: number; verdict: string }>;
  greenlightTier1: boolean;
  blockers: string[];
  notes: string[];
};

export const runPricingReport = (dataset: CaptureDataset, cfg: HarnessReportConfig): HarnessReport => {
  const blockers: string[] = [];
  const spot = dataset.spotUsd;
  const fee = cfg.feeUsdc;
  const feeParameterized = fee == null;
  if (feeParameterized) blockers.push("Foxify fee not confirmed — slot in $75 to finalize feasibility/credit.");

  const { skew, points: skewIvPoints, ok: skewOk } = buildSkewFromCapture(dataset, cfg.tenorDays);
  if (!skewOk) blockers.push("Skew curve under-determined (<2 implied-vol points captured at this tenor).");

  const routing = recommendRouting(dataset.options, cfg.tenorDays, cfg.routing);
  const legSpread = buildLegSpreadFromCapture(dataset, cfg.tenorDays, routing);

  // ── Credit + feasibility for the $50k position at the (parameterized) fee ──
  let creditQuote: HarnessReport["creditQuote"];
  if (fee == null) {
    creditQuote = { ok: false, reason: "fee_not_confirmed" };
  } else {
    const serviceFee = Math.max((cfg.positionNotionalUsdc * cfg.serviceFeeBps) / 1e4, cfg.minServiceFeeUsdc);
    const q = solveAndPriceCreditCollar(
      { side: "long", spot, notionalUsdc: cfg.positionNotionalUsdc, tenorDays: cfg.tenorDays, targetCreditUsdc: fee, maxFloorPct: cfg.maxFloorPct, referenceMode: "net_book_delta" },
      skew,
      { fillMode: "touch", legHalfSpreadUsdcPerBtc: legSpread, spreadBps: 0, minMarginUsdc: serviceFee }
    );
    if (q.ok) {
      creditQuote = {
        ok: true,
        feasible: true,
        putStrike: q.legs.putStrike,
        callStrike: q.legs.callStrike,
        capPct: q.legs.cap_pct,
        floorPct: q.legs.floor_pct,
        fairCreditMid: q.economics.fair_credit_mid_usdc,
        fundableCredit: q.economics.fundable_credit_usdc,
        crossingDrag: q.fills.crossing_drag_usdc,
        atticusServiceFeeUsdc: q.economics.atticus_margin_usdc,
        foxifyEvUsdc: q.economics.foxify_market_implied_ev_usdc
      };
    } else {
      creditQuote = { ok: true, feasible: false, reason: q.error };
      blockers.push(`Credit infeasible at $${fee} fee / ${(cfg.maxFloorPct * 100).toFixed(0)}% floor on real spreads: ${q.error}.`);
    }
  }

  // ── Architecture comparison on real spreads + perp depth ($50m reference tier) ──
  let architecture: HarnessReport["architecture"] = null;
  const refTier = cfg.rampTiersDailyUsd[cfg.rampTiersDailyUsd.length - 1];
  const refClip = refTier * cfg.peakResidualPct;
  const bullishPerp = bestPerpAtClip(dataset, refClip);
  if (skewOk && fee != null && bullishPerp) {
    const book: BookSpec = {
      spot, tenorDays: cfg.tenorDays, maxFloorPct: cfg.maxFloorPct, atmIv: skew(spot, "call"), skewSlopePer10pct: 0.12,
      dailyNotionalUsdc: refTier, avgPositionNotionalUsdc: cfg.positionNotionalUsdc, notionalLogSdPct: 0.3,
      creditMode: "fixed_usdc", creditPerPositionUsdc: fee, creditBpsOfNotional: 20, longFraction: 0.55, netLongBias: 0.3, seed: 42
    };
    const cost: CostModel = {
      profitBps: cfg.serviceFeeBps, minProfitUsdc: cfg.minServiceFeeUsdc,
      optionRelHalfSpreadPct: 0.1, optionAbsHalfSpreadUsdcPerBtc: 1.5, optionLegSpread: legSpread, backToBackWarehouseFraction: 0.15,
      nettingEfficiency: 0.9, perpTopOfBookBps: bullishPerp.bps, perpDepthUsdc: 1e12, perpImpactCoefBps: 0, dailyRehedgeTurnover: 2,
      reserveMultiple: cfg.reserveMultiple, costOfCapitalAnnual: cfg.costOfCapitalAnnual, stressJumpPct: cfg.stressJumpPct
    };
    const cmp = compareHedgeArchitectures(book, cost);
    architecture = {
      backToBackFoxifyCostUsdc: cmp.backToBack.foxifyCostPerPositionUsdc,
      internalizeFoxifyCostUsdc: cmp.internalizePerp.foxifyCostPerPositionUsdc,
      recommendation: cmp.recommendation
    };
  }

  // ── Does the ~2 bps service fee survive REAL hedge costs at rebates=0, per ramp tier? ──
  const serviceFeeSurvives: HarnessReport["serviceFeeSurvives"] = [];
  if (skewOk && fee != null) {
    for (const tier of cfg.rampTiersDailyUsd) {
      const clip = tier * cfg.peakResidualPct;
      const perp = bestPerpAtClip(dataset, clip);
      const mb: ModelBConfig = {
        dailyNotionalUsdc: tier, avgPositionNotionalUsdc: cfg.positionNotionalUsdc, spot,
        tenorDays: cfg.tenorDays, maxFloorPct: cfg.maxFloorPct, atmIv: skew(spot, "call"), skewSlopePer10pct: 0.12,
        serviceFeeBps: cfg.serviceFeeBps, minServiceFeeUsdc: cfg.minServiceFeeUsdc, creditBpsOfNotional: (fee / cfg.positionNotionalUsdc) * 1e4,
        steerComplianceProb: 0.9, flowStreakiness: 0.85, targetNetBandPct: 0.1,
        perpTopOfBookBps: perp ? perp.bps : 2.0, perpDepthUsdc: 1e12, perpImpactCoefBps: 0, dailyRehedgeTurnover: 2,
        reserveMultiple: cfg.reserveMultiple, costOfCapitalAnnual: cfg.costOfCapitalAnnual, stressJumpPct: cfg.stressJumpPct,
        intradayTimingBufferPct: cfg.intradayTimingBufferPct, maxDirectionalExposureBand: 0.15, days: 250, seed: 42
      };
      const r = simulateModelBVolume(mb);
      serviceFeeSurvives.push({
        tierDailyUsd: tier,
        clipUsd: clip,
        perpVenue: perp ? perp.venue : null,
        perpAllInBps: perp ? +perp.bps.toFixed(3) : null,
        bookExhausted: perp ? perp.exhausted : false,
        netPerDayUsdc: r.ok ? r.netServiceRevenuePerDayUsdc : 0,
        annualNetUsdc: r.ok ? r.annualizedNetUsdc : 0,
        verdict: r.ok ? r.verdict : "ERROR"
      });
    }
  }

  // Surface gates as explicit blockers so the greenlight reasoning is transparent.
  if (dataset.dailyListing.bullish === false) {
    blockers.push("Bullish daily BTC option listing NOT detected — gates tenor-aligned back-to-back hedging (confirm the Bullish option market/endpoint on Render).");
  }
  const notViableTiers = serviceFeeSurvives.filter((t) => t.verdict === "NOT_VIABLE").map((t) => `$${(t.tierDailyUsd / 1e6).toFixed(2)}m`);
  if (notViableTiers.length > 0) blockers.push(`Service fee NOT viable at ramp tier(s): ${notViableTiers.join(", ")} (small-book / cost).`);
  const exhaustedClips = serviceFeeSurvives.filter((t) => t.bookExhausted).map((t) => `$${(t.clipUsd / 1e6).toFixed(2)}m`);
  if (exhaustedClips.length > 0) blockers.push(`Perp book exhausted at clip(s): ${exhaustedClips.join(", ")} — deepen the perp book fetch to measure impact at scale.`);

  const feasibleCredit = creditQuote.ok && "feasible" in creditQuote && creditQuote.feasible;
  // Greenlight Tier 1 ($1m+) specifically: fee confirmed, real skew, feasible credit, the $1m+ tiers
  // not NOT_VIABLE, and no hard blockers (incl. Bullish daily-listing confirmation).
  const tier1PlusViable = serviceFeeSurvives.filter((t) => t.tierDailyUsd >= 1_000_000).every((t) => t.verdict !== "NOT_VIABLE");
  const greenlightTier1 = !feeParameterized && skewOk && feasibleCredit && tier1PlusViable && blockers.length === 0;

  return {
    capturedAtMs: dataset.capturedAtMs,
    spotUsd: round2(spot),
    feeParameterized,
    dailyOptionListing: dataset.dailyListing,
    skewOk,
    skewIvPoints: skewIvPoints.map((p) => ({ strike: p.strike, iv: +p.iv.toFixed(4) })),
    routing,
    creditQuote,
    architecture,
    serviceFeeSurvives,
    greenlightTier1,
    blockers,
    notes: [
      "READ/QUOTE-ONLY. Skew + leg spreads built from REAL captured mids/spreads; perp cost from REAL depth/impact.",
      "Fee parameterized — slot in $75 when Foxify confirms to finalize credit/feasibility.",
      "Architecture = soft cost-optimization (Bullish-weighted); decided by these measured numbers, not assumption.",
      ...dataset.notes
    ]
  };
};
