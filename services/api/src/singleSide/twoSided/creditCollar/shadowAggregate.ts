/**
 * Shadow scorecard aggregator — Phase A (pure, offline). Rolls a history of Tier-0 shadow sessions
 * into a TRACK RECORD the operator reviews before flipping any live tier: open/halt/reject rates,
 * oracle health %, settlement-verification + reconciliation drift, exposure discipline, and realized
 * service-fee bps vs the modeled target. Pure: takes the stored records, no I/O.
 */

import type { ShadowScorecard } from "./shadowRunner";

export type ShadowRunRecord = {
  tsMs: number;
  scorecard: ShadowScorecard;
  spotUsd?: number;
  oracleSources?: string[];
};

export type ShadowAggregate = {
  sessions: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  positions: {
    attempted: number;
    opened: number;
    halted: number;
    rejected: number;
    openRate: number;
    haltRate: number;
    rejectRate: number;
  };
  rejectionsByReason: Record<string, number>;
  oracle: {
    healthyRate: number;          // status === "healthy"
    safeForActivationRate: number;
    allVerifiedRate: number;      // sessions where every settlement verified
  };
  reconciliation: {
    allReconciledRate: number;
    sessionsWithDrift: number;
  };
  lifecycleCompleteRate: number;
  exposure: {
    maxPeakNetExposureRatio: number;
    avgPeakNetExposureRatio: number;
    maxPeakNetNotionalUsdc: number;
  };
  floor: {
    /** Deepest floor the solver needed across sessions — the regime signal (calm ⟹ deeper). */
    maxFloorPctUsed: number;
    avgFloorPctUsed: number;
  };
  economics: {
    openedNotionalUsdc: number;
    totalServiceFeeUsdc: number;
    totalCreditAccruedUsdc: number;
    totalPayoutToFoxifyUsdc: number;
    totalNetToFoxifyUsdc: number;
    realizedServiceFeeBps: number;   // serviceFee / openedNotional × 1e4
    avgServiceFeePerPositionUsdc: number;
  };
  /**
   * Capital-aware economics from the MEASURED short-leg IM (Deribit sweep). The short-option exchange
   * margin is the binding capital; this converts it into a per-throughput bps drag (held for the tenor)
   * and reports the realized service fee NET of that capital cost — the number that actually matters.
   */
  capital: {
    shortOptionImFraction: number;
    shortOptionGrossNotionalFraction: number;
    portfolioMarginNettingFactor: number;
    costOfCapitalAnnual: number;
    tenorDays: number;
    /** IM posted per unit notional opened (USD/USD). */
    imFractionOfNotional: number;
    /** Cost-of-capital drag on throughput, bps (= im × coc × tenor/365). */
    capitalCostBps: number;
    /** Realized service fee minus the capital drag. */
    capitalAwareNetServiceFeeBps: number;
    /** Total IM that would have been posted for the opened notional (point-in-time proxy). */
    impliedShortOptionMarginUsdc: number;
  };
  verdict: "TRACK_RECORD_CLEAN" | "WATCH" | "DEGRADED" | "NO_DATA";
  flags: string[];
  notes: string[];
};

export type ShadowAggregateConfig = {
  /** Exposure band the steered book is expected to hold (default 0.15, the breaker halt band). */
  exposureBandPct?: number;
  /** Minimum sessions before a CLEAN verdict is allowed (default 10). */
  minSessionsForClean?: number;
  /** Target service-fee bps to compare realized against (default 2). */
  targetServiceFeeBps?: number;
  /** Sessions in the recent window used for the DEGRADED alarm (default 25). */
  recentWindowForVerdict?: number;
  /** Measured capital inputs (Deribit margin sweep + PM-netting). Drives capital-aware net bps. */
  capital?: {
    shortOptionImFraction?: number;            // measured IM / notional (default 0.1393, sweep conservative)
    shortOptionGrossNotionalFraction?: number; // share of open book carried as short options (default 1.0)
    portfolioMarginNettingFactor?: number;     // measured PM netting (default 1.0 = isolated)
    costOfCapitalAnnual?: number;              // default 0.12
    tenorDays?: number;                        // holding period for IM (default 1)
  };
};

const rate = (n: number, d: number) => (d > 0 ? +(n / d).toFixed(4) : 0);
const round2 = (x: number) => +x.toFixed(2);

export const aggregateShadowScorecards = (records: ShadowRunRecord[], cfg: ShadowAggregateConfig = {}): ShadowAggregate => {
  const band = cfg.exposureBandPct ?? 0.15;
  const minClean = cfg.minSessionsForClean ?? 10;
  const targetBps = cfg.targetServiceFeeBps ?? 2;

  const sessions = records.length;
  const sc = records.map((r) => r.scorecard);

  let attempted = 0, opened = 0, halted = 0, rejected = 0;
  let openedNotional = 0, serviceFee = 0, credit = 0, payout = 0, net = 0;
  let oracleHealthy = 0, safeActivation = 0, allVerified = 0, allReconciled = 0, lifecycle = 0, withDrift = 0;
  let maxPeakRatio = 0, sumPeakRatio = 0, maxPeakNotional = 0;
  let maxFloorUsed = 0, sumFloorUsed = 0, floorSessions = 0;
  const rejReasons: Record<string, number> = {};

  // Effective lifecycle completeness — retroactively corrects records stored before the fix: a cycle
  // that opened 0 BECAUSE the oracle wasn't safe for activation was correct fail-closed behavior,
  // not a failure. Derived from stored fields so historical sessions benefit without clearing data.
  const effLifecycleComplete = (s: ShadowScorecard): boolean => s.lifecycleComplete || (s.opened === 0 && !s.oracle.safeForActivation);

  for (const s of sc) {
    attempted += s.attempted;
    opened += s.opened;
    halted += s.halted;
    rejected += s.rejected;
    openedNotional += s.openedNotionalUsdc;
    serviceFee += s.serviceFeeAccruedUsdc;
    credit += s.foxifyCreditAccruedUsdc;
    payout += s.totalPayoutToFoxifyUsdc;
    net += s.totalNetToFoxifyUsdc;
    if (s.oracle.status === "healthy") oracleHealthy += 1;
    if (s.oracle.safeForActivation) safeActivation += 1;
    if (s.allSettledOracleVerified) allVerified += 1;
    if (s.allReconciled) allReconciled += 1;
    else withDrift += 1;
    if (effLifecycleComplete(s)) lifecycle += 1;
    maxPeakRatio = Math.max(maxPeakRatio, s.peakNetExposureRatio);
    sumPeakRatio += s.peakNetExposureRatio;
    maxPeakNotional = Math.max(maxPeakNotional, s.peakNetNotionalUsdc);
    if (s.opened > 0) {
      maxFloorUsed = Math.max(maxFloorUsed, s.maxFloorPctUsed ?? 0);
      sumFloorUsed += s.avgFloorPctUsed ?? 0;
      floorSessions += 1;
    }
    for (const [reason, n] of Object.entries(s.rejectionsByReason)) rejReasons[reason] = (rejReasons[reason] ?? 0) + n;
  }

  const allVerifiedRate = rate(allVerified, sessions);
  const allReconciledRate = rate(allReconciled, sessions);
  const lifecycleCompleteRate = rate(lifecycle, sessions);
  const oracleHealthyRate = rate(oracleHealthy, sessions);
  const realizedServiceFeeBps = openedNotional > 0 ? +((serviceFee / openedNotional) * 1e4).toFixed(4) : 0;

  // ── Capital-aware economics (measured short-leg IM → bps drag on throughput) ──
  const capImFraction = cfg.capital?.shortOptionImFraction ?? 0.1393;
  const capGrossFraction = cfg.capital?.shortOptionGrossNotionalFraction ?? 1.0;
  const capPmNetting = cfg.capital?.portfolioMarginNettingFactor ?? 1.0;
  const capCoc = cfg.capital?.costOfCapitalAnnual ?? 0.12;
  const capTenorDays = cfg.capital?.tenorDays ?? 1;
  const imFractionOfNotional = capImFraction * capGrossFraction * capPmNetting;
  const capitalCostBps = +(imFractionOfNotional * capCoc * (capTenorDays / 365) * 1e4).toFixed(4);
  const capitalAwareNetServiceFeeBps = +(realizedServiceFeeBps - capitalCostBps).toFixed(4);
  const impliedShortOptionMarginUsdc = round2(openedNotional * imFractionOfNotional);

  // Verdict + flags: the bar for a clean track record before any live tier.
  // NB: with 0 sessions the rates are vacuously 0 — that's NO_DATA (warming up), NOT a DEGRADED fail.
  const flags: string[] = [];
  if (sessions === 0) {
    flags.push("no sessions yet — first shadow cycle runs on boot (~15–20s); collecting data");
  } else {
    if (allVerifiedRate < 1) flags.push(`oracle verification failed in ${Math.round((1 - allVerifiedRate) * sessions)} session(s)`);
    if (withDrift > 0) flags.push(`venue-vs-ledger reconciliation drift in ${withDrift} session(s)`);
    if (lifecycleCompleteRate < 0.95) flags.push(`lifecycle incomplete in ${Math.round((1 - lifecycleCompleteRate) * sessions)} session(s)`);
    if (maxPeakRatio > band + 1e-9) flags.push(`peak net exposure ${(maxPeakRatio * 100).toFixed(1)}% exceeded the ${(band * 100).toFixed(0)}% band`);
    if (oracleHealthyRate < 0.9) flags.push(`oracle below 'healthy' in ${(100 - oracleHealthyRate * 100).toFixed(0)}% of sessions`);
    if (sessions < minClean) flags.push(`only ${sessions} session(s) — need ≥ ${minClean} for a CLEAN verdict`);
  }

  // DEGRADED is a MATERIAL, RECENT alarm — not a single historical blip. Compute the failure rates
  // over the most recent window; a lone old failure drops CLEAN→WATCH (via the all-time `clean` gate
  // below), but only a recent CLUSTER trips DEGRADED.
  const recentWindow = cfg.recentWindowForVerdict ?? 25;
  const recent = [...records].sort((a, b) => b.tsMs - a.tsMs).slice(0, recentWindow).map((r) => r.scorecard);
  const rN = recent.length;
  const rUnverifiedRate = rN > 0 ? recent.filter((s) => !s.allSettledOracleVerified).length / rN : 0;
  const rDriftRate = rN > 0 ? recent.filter((s) => !s.allReconciled).length / rN : 0;
  const rLifecycleIncompleteRate = rN > 0 ? recent.filter((s) => !effLifecycleComplete(s)).length / rN : 0;
  const rExposureBreach = recent.some((s) => s.peakNetExposureRatio > band + 1e-9);
  const hardFail = rN > 0 && (rUnverifiedRate > 0.1 || rDriftRate > 0.1 || rLifecycleIncompleteRate > 0.2 || rExposureBreach);

  const clean = sessions >= minClean && allVerifiedRate === 1 && allReconciledRate === 1 && lifecycleCompleteRate >= 0.95 && maxPeakRatio <= band + 1e-9 && oracleHealthyRate >= 0.9;
  const verdict: ShadowAggregate["verdict"] = sessions === 0 ? "NO_DATA" : hardFail ? "DEGRADED" : clean ? "TRACK_RECORD_CLEAN" : "WATCH";

  return {
    sessions,
    firstTsMs: records.length ? Math.min(...records.map((r) => r.tsMs)) : null,
    lastTsMs: records.length ? Math.max(...records.map((r) => r.tsMs)) : null,
    positions: {
      attempted,
      opened,
      halted,
      rejected,
      openRate: rate(opened, attempted),
      haltRate: rate(halted, attempted),
      rejectRate: rate(rejected, attempted)
    },
    rejectionsByReason: rejReasons,
    oracle: { healthyRate: oracleHealthyRate, safeForActivationRate: rate(safeActivation, sessions), allVerifiedRate },
    reconciliation: { allReconciledRate, sessionsWithDrift: withDrift },
    lifecycleCompleteRate,
    exposure: {
      maxPeakNetExposureRatio: +maxPeakRatio.toFixed(4),
      avgPeakNetExposureRatio: rate(sumPeakRatio, sessions),
      maxPeakNetNotionalUsdc: round2(maxPeakNotional)
    },
    floor: {
      maxFloorPctUsed: +maxFloorUsed.toFixed(4),
      avgFloorPctUsed: floorSessions > 0 ? +(sumFloorUsed / floorSessions).toFixed(4) : 0
    },
    economics: {
      openedNotionalUsdc: round2(openedNotional),
      totalServiceFeeUsdc: round2(serviceFee),
      totalCreditAccruedUsdc: round2(credit),
      totalPayoutToFoxifyUsdc: round2(payout),
      totalNetToFoxifyUsdc: round2(net),
      realizedServiceFeeBps,
      avgServiceFeePerPositionUsdc: opened > 0 ? round2(serviceFee / opened) : 0
    },
    capital: {
      shortOptionImFraction: capImFraction,
      shortOptionGrossNotionalFraction: capGrossFraction,
      portfolioMarginNettingFactor: capPmNetting,
      costOfCapitalAnnual: capCoc,
      tenorDays: capTenorDays,
      imFractionOfNotional: +imFractionOfNotional.toFixed(6),
      capitalCostBps,
      capitalAwareNetServiceFeeBps,
      impliedShortOptionMarginUsdc
    },
    verdict,
    flags,
    notes: [
      `Realized service fee ${realizedServiceFeeBps} bps vs target ${targetBps} bps (shadow, paper-settled).`,
      `Capital-aware: ${realizedServiceFeeBps} bps − ${capitalCostBps} bps capital drag (measured IM ${(capImFraction * 100).toFixed(1)}%/notional × ${capGrossFraction} gross × PM ${capPmNetting} × ${(capCoc * 100).toFixed(0)}%/yr × ${capTenorDays}d) = ${capitalAwareNetServiceFeeBps} bps net.`,
      "TRACK_RECORD_CLEAN requires: 100% oracle-verified + reconciled, ≥95% lifecycle complete, exposure within band, ≥90% oracle healthy, and enough sessions.",
      "Shadow only — zero capital. This track record gates the decision to flip Tier-1 (still default-off)."
    ]
  };
};
