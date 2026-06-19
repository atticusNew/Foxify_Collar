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
  economics: {
    openedNotionalUsdc: number;
    totalServiceFeeUsdc: number;
    totalCreditAccruedUsdc: number;
    totalPayoutToFoxifyUsdc: number;
    totalNetToFoxifyUsdc: number;
    realizedServiceFeeBps: number;   // serviceFee / openedNotional × 1e4
    avgServiceFeePerPositionUsdc: number;
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
  const rejReasons: Record<string, number> = {};

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
    if (s.lifecycleComplete) lifecycle += 1;
    maxPeakRatio = Math.max(maxPeakRatio, s.peakNetExposureRatio);
    sumPeakRatio += s.peakNetExposureRatio;
    maxPeakNotional = Math.max(maxPeakNotional, s.peakNetNotionalUsdc);
    for (const [reason, n] of Object.entries(s.rejectionsByReason)) rejReasons[reason] = (rejReasons[reason] ?? 0) + n;
  }

  const allVerifiedRate = rate(allVerified, sessions);
  const allReconciledRate = rate(allReconciled, sessions);
  const lifecycleCompleteRate = rate(lifecycle, sessions);
  const oracleHealthyRate = rate(oracleHealthy, sessions);
  const realizedServiceFeeBps = openedNotional > 0 ? +((serviceFee / openedNotional) * 1e4).toFixed(4) : 0;

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

  const hardFail = sessions > 0 && (allVerifiedRate < 1 || withDrift > 0 || lifecycleCompleteRate < 0.9);
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
    economics: {
      openedNotionalUsdc: round2(openedNotional),
      totalServiceFeeUsdc: round2(serviceFee),
      totalCreditAccruedUsdc: round2(credit),
      totalPayoutToFoxifyUsdc: round2(payout),
      totalNetToFoxifyUsdc: round2(net),
      realizedServiceFeeBps,
      avgServiceFeePerPositionUsdc: opened > 0 ? round2(serviceFee / opened) : 0
    },
    verdict,
    flags,
    notes: [
      `Realized service fee ${realizedServiceFeeBps} bps vs target ${targetBps} bps (shadow, paper-settled).`,
      "TRACK_RECORD_CLEAN requires: 100% oracle-verified + reconciled, ≥95% lifecycle complete, exposure within band, ≥90% oracle healthy, and enough sessions.",
      "Shadow only — zero capital. This track record gates the decision to flip Tier-1 (still default-off)."
    ]
  };
};
