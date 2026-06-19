/**
 * Forward settlement — Phase A (pure, offline). Fixes the compressed-settle-at-entry artifact: a
 * position is opened at T and settled at its REAL expiry (T+tenor) against the oracle price AT THAT
 * TIME, so floors actually pay and caps actually cap. This is what turns the shadow track record from
 * "the machinery runs" into "the ECONOMICS hold under real price moves."
 *
 * Pure: open positions + the current cycle's signed oracle are injected; no I/O. Settlement only
 * happens on an ECDSA-VERIFIED snapshot (fail-closed) — an unverifiable oracle defers, never settles.
 */

import { verifySnapshot, computeSettlementTwap, type OracleSnapshot, type OracleTick } from "./referenceOracle";
import type { PerpSide } from "./creditCollarPricer";

export type OpenPosition = {
  ref: string;
  side: PerpSide;
  notionalUsdc: number;
  spotAtEntry: number;
  putStrike: number;
  callStrike: number;
  foxifyCreditUsdc: number;
  serviceFeeUsdc: number;
  floorPctUsed: number;
  openedAtMs: number;
  expiresAtMs: number;
};

export type SettlementOutcome = {
  ref: string;
  side: PerpSide;
  notionalUsdc: number;
  spotAtEntry: number;
  settlePriceUsd: number;
  movePct: number;                 // (settle − entry)/entry
  putIntrinsicUsd: number;
  callIntrinsicUsd: number;
  payoutToFoxifyUsdc: number;      // collar option payoff to Foxify (can be ±)
  foxifyCreditUsdc: number;        // accrued credit, netted in
  netToFoxifyUsdc: number;         // credit + payout
  serviceFeeUsdc: number;          // Atticus margin
  floorBreached: boolean;          // settle beyond the protective floor (the floor actually paid)
  capBreached: boolean;            // settle beyond the cap (upside surrendered)
  oracleVerified: boolean;
  openedAtMs: number;
  settledAtMs: number;
  heldMs: number;
};

const round2 = (x: number) => +x.toFixed(2);

/** Pure collar payoff at a settlement price. Long-perp: long put − short call; short-perp: mirror. */
export const computeCollarSettlement = (
  pos: OpenPosition,
  settlePriceUsd: number
): { contractsBtc: number; putIntrinsicUsd: number; callIntrinsicUsd: number; payoutToFoxifyUsdc: number; netToFoxifyUsdc: number; floorBreached: boolean; capBreached: boolean } => {
  const contractsBtc = pos.notionalUsdc / pos.spotAtEntry;
  const putIntrinsic = Math.max(0, pos.putStrike - settlePriceUsd) * contractsBtc;
  const callIntrinsic = Math.max(0, settlePriceUsd - pos.callStrike) * contractsBtc;
  const payout = pos.side === "long" ? putIntrinsic - callIntrinsic : callIntrinsic - putIntrinsic;
  // "floor" = the protective leg (long put for long-perp; long call for short-perp).
  const floorBreached = pos.side === "long" ? settlePriceUsd < pos.putStrike : settlePriceUsd > pos.callStrike;
  const capBreached = pos.side === "long" ? settlePriceUsd > pos.callStrike : settlePriceUsd < pos.putStrike;
  return {
    contractsBtc,
    putIntrinsicUsd: round2(putIntrinsic),
    callIntrinsicUsd: round2(callIntrinsic),
    payoutToFoxifyUsdc: round2(payout),
    netToFoxifyUsdc: round2(pos.foxifyCreditUsdc + payout),
    floorBreached,
    capBreached
  };
};

export type CycleOracle = {
  snapshot: OracleSnapshot;
  signatureHex: string;
  publicKeyPem: string;
  settlementTwapTicks: OracleTick[];
  windowStartMs: number;
  windowEndMs: number;
};

/**
 * Settle every open position whose expiry has passed, at the current cycle's ECDSA-verified settlement
 * TWAP. Unmatured positions stay open; if the oracle can't be verified or the TWAP is unavailable,
 * matured positions are DEFERRED (kept open) rather than settled on an untrusted price. Pure.
 */
export const settleMatured = (
  open: OpenPosition[],
  nowMs: number,
  oracle: CycleOracle
): { settled: SettlementOutcome[]; stillOpen: OpenPosition[]; oracleVerified: boolean; settlePriceUsd: number | null; deferred: number } => {
  const oracleVerified = verifySnapshot(oracle.snapshot, oracle.signatureHex, oracle.publicKeyPem);
  const twap = computeSettlementTwap(oracle.settlementTwapTicks, oracle.windowStartMs, oracle.windowEndMs);
  const canSettle = oracleVerified && twap.ok;
  const settlePriceUsd = twap.ok ? twap.twapUsd : null;

  const settled: SettlementOutcome[] = [];
  const stillOpen: OpenPosition[] = [];
  let deferred = 0;

  for (const p of open) {
    if (p.expiresAtMs > nowMs) {
      stillOpen.push(p);
      continue;
    }
    if (!canSettle || settlePriceUsd == null) {
      // Matured but oracle impaired → defer to a later cycle (fail-closed, per the settlement policy).
      stillOpen.push(p);
      deferred += 1;
      continue;
    }
    const s = computeCollarSettlement(p, settlePriceUsd);
    settled.push({
      ref: p.ref,
      side: p.side,
      notionalUsdc: p.notionalUsdc,
      spotAtEntry: p.spotAtEntry,
      settlePriceUsd,
      movePct: +((settlePriceUsd - p.spotAtEntry) / p.spotAtEntry).toFixed(6),
      putIntrinsicUsd: s.putIntrinsicUsd,
      callIntrinsicUsd: s.callIntrinsicUsd,
      payoutToFoxifyUsdc: s.payoutToFoxifyUsdc,
      foxifyCreditUsdc: p.foxifyCreditUsdc,
      netToFoxifyUsdc: s.netToFoxifyUsdc,
      serviceFeeUsdc: p.serviceFeeUsdc,
      floorBreached: s.floorBreached,
      capBreached: s.capBreached,
      oracleVerified: true,
      openedAtMs: p.openedAtMs,
      settledAtMs: nowMs,
      heldMs: nowMs - p.openedAtMs
    });
  }
  return { settled, stillOpen, oracleVerified, settlePriceUsd, deferred };
};

// ── Settlement aggregate (the REAL economics) ─────────────────────────────────

export type SettlementAggregate = {
  settledPositions: number;
  totalNotionalUsdc: number;
  totalPayoutToFoxifyUsdc: number;   // book-level collar payoff — should be ~small for a delta-flat book
  bookNetPayoutBps: number;          // payout / notional × 1e4 (delta-neutrality check)
  totalServiceFeeUsdc: number;       // Atticus realized margin
  totalCreditAccruedUsdc: number;
  totalNetToFoxifyUsdc: number;
  pctFloorBreached: number;          // how often the floor actually paid
  pctCapBreached: number;            // how often the cap surrendered upside
  avgPayoutPerPositionUsdc: number;
  worstPayoutUsdc: number;
  bestPayoutUsdc: number;
  avgHeldHours: number;
  oracleVerifiedRate: number;
};

export const aggregateSettlements = (outcomes: SettlementOutcome[]): SettlementAggregate => {
  const n = outcomes.length;
  if (n === 0) {
    return {
      settledPositions: 0, totalNotionalUsdc: 0, totalPayoutToFoxifyUsdc: 0, bookNetPayoutBps: 0,
      totalServiceFeeUsdc: 0, totalCreditAccruedUsdc: 0, totalNetToFoxifyUsdc: 0, pctFloorBreached: 0,
      pctCapBreached: 0, avgPayoutPerPositionUsdc: 0, worstPayoutUsdc: 0, bestPayoutUsdc: 0, avgHeldHours: 0, oracleVerifiedRate: 0
    };
  }
  const notional = outcomes.reduce((s, o) => s + o.notionalUsdc, 0);
  const payout = outcomes.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);
  const fee = outcomes.reduce((s, o) => s + o.serviceFeeUsdc, 0);
  const credit = outcomes.reduce((s, o) => s + o.foxifyCreditUsdc, 0);
  const net = outcomes.reduce((s, o) => s + o.netToFoxifyUsdc, 0);
  const payouts = outcomes.map((o) => o.payoutToFoxifyUsdc);
  return {
    settledPositions: n,
    totalNotionalUsdc: round2(notional),
    totalPayoutToFoxifyUsdc: round2(payout),
    bookNetPayoutBps: notional > 0 ? +((payout / notional) * 1e4).toFixed(4) : 0,
    totalServiceFeeUsdc: round2(fee),
    totalCreditAccruedUsdc: round2(credit),
    totalNetToFoxifyUsdc: round2(net),
    pctFloorBreached: +(outcomes.filter((o) => o.floorBreached).length / n).toFixed(4),
    pctCapBreached: +(outcomes.filter((o) => o.capBreached).length / n).toFixed(4),
    avgPayoutPerPositionUsdc: round2(payout / n),
    worstPayoutUsdc: round2(Math.min(...payouts)),
    bestPayoutUsdc: round2(Math.max(...payouts)),
    avgHeldHours: +(outcomes.reduce((s, o) => s + o.heldMs, 0) / n / 3_600_000).toFixed(2),
    oracleVerifiedRate: +(outcomes.filter((o) => o.oracleVerified).length / n).toFixed(4)
  };
};
