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
  /** Hedge-venue (Bullish) fee paid to OPEN the collar legs. Held-to-expiry pays only this. Default 0. */
  openFeeUsdc?: number;
  /**
   * True (pass_through model) when the COLLAR itself funds the Bullish open fee — so the fee is not
   * borne by Atticus's net (it's already covered by the funded credit). Default false (embedded model:
   * the fee comes out of Atticus's margin).
   */
  feesFundedByCollar?: boolean;
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
  // ── Back-to-back hedge leg (the flatness proof) ──
  hedgeReceiptUsdc: number;            // Atticus's identical hedge on Bullish pays the SAME collar payoff
  atticusOptionNetUsdc: number;        // hedgeReceipt − payoutToFoxify ⟹ ~0 in architecture A (same index)
  // ── Capital (measured short-leg IM) + real Bullish option fees ──
  shortLegMarginUsdc: number;          // IM posted to carry this position's short option leg
  capitalCostUsdc: number;             // cost-of-capital on that IM over the actual holding period
  optionFeesUsdc: number;              // realized Bullish open fee (held-to-expiry pays only the open)
  atticusNetAfterCapitalUsdc: number;  // serviceFee − capitalCost (kept for continuity)
  atticusNetAfterFeesAndCapitalUsdc: number; // serviceFee + optionNet − fees − capitalCost (fully grounded)
};

/**
 * Measured capital inputs (Deribit margin sweep + PM-netting). Short-leg IM as a fraction of notional,
 * the portfolio-margin netting that applies on a balanced book, and the annual cost of that capital.
 */
export type SettlementCapitalConfig = {
  shortOptionImFraction?: number;        // default 0.1393 (sweep, conservative)
  portfolioMarginNettingFactor?: number; // default 1.0 (isolated); ~0.2216 measured on PM
  costOfCapitalAnnual?: number;          // default 0.12
};

const YEAR_MS = 365 * 86_400_000;

const round2 = (x: number) => +x.toFixed(2);

/**
 * Pure collar payoff at a settlement price. Long-perp: long put − short call; short-perp: mirror.
 *
 * Also books the back-to-back HEDGE leg: Atticus hedges by holding the IDENTICAL collar on Bullish, so
 * its receipt is the SAME payoff evaluated at the hedge-venue settlement price. In architecture A (the
 * collar AND the hedge both settle on the Bullish index) `hedgeSettlePriceUsd === settlePriceUsd`, so
 * the receipt equals the payout and Atticus's option net is exactly 0 — flat by construction. A non-zero
 * `atticusOptionNetUsdc` is precisely the settlement basis between the Foxify reference and the hedge
 * index (e.g. an architecture-B bilateral trade settling on a different index). Pass the two prices
 * separately to MEASURE that basis instead of asserting flatness.
 */
export const computeCollarSettlement = (
  pos: OpenPosition,
  settlePriceUsd: number,
  hedgeSettlePriceUsd: number = settlePriceUsd
): { contractsBtc: number; putIntrinsicUsd: number; callIntrinsicUsd: number; payoutToFoxifyUsdc: number; netToFoxifyUsdc: number; floorBreached: boolean; capBreached: boolean; hedgeReceiptUsdc: number; atticusOptionNetUsdc: number } => {
  const contractsBtc = pos.notionalUsdc / pos.spotAtEntry;
  const payoffAt = (s: number): number => {
    const put = Math.max(0, pos.putStrike - s) * contractsBtc;
    const call = Math.max(0, s - pos.callStrike) * contractsBtc;
    return pos.side === "long" ? put - call : call - put;
  };
  const putIntrinsic = Math.max(0, pos.putStrike - settlePriceUsd) * contractsBtc;
  const callIntrinsic = Math.max(0, settlePriceUsd - pos.callStrike) * contractsBtc;
  const payout = payoffAt(settlePriceUsd);
  // Atticus's back-to-back hedge on Bullish pays the same collar payoff at the hedge-venue price.
  const hedgeReceipt = payoffAt(hedgeSettlePriceUsd);
  const atticusOptionNet = hedgeReceipt - payout;
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
    capBreached,
    hedgeReceiptUsdc: round2(hedgeReceipt),
    atticusOptionNetUsdc: round2(atticusOptionNet)
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
  oracle: CycleOracle,
  capital: SettlementCapitalConfig = {}
): { settled: SettlementOutcome[]; stillOpen: OpenPosition[]; oracleVerified: boolean; settlePriceUsd: number | null; deferred: number } => {
  const oracleVerified = verifySnapshot(oracle.snapshot, oracle.signatureHex, oracle.publicKeyPem);
  const twap = computeSettlementTwap(oracle.settlementTwapTicks, oracle.windowStartMs, oracle.windowEndMs);
  const canSettle = oracleVerified && twap.ok;
  const settlePriceUsd = twap.ok ? twap.twapUsd : null;
  const imFraction = capital.shortOptionImFraction ?? 0.1393;
  const pmNetting = capital.portfolioMarginNettingFactor ?? 1.0;
  const coc = capital.costOfCapitalAnnual ?? 0.12;

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
    // Architecture A: the collar and its back-to-back hedge both settle on the same Bullish index, so
    // the hedge price equals the settlement price ⟹ option net 0. (A future basis feed would pass a
    // separate hedge price here to MEASURE the residual.)
    const s = computeCollarSettlement(p, settlePriceUsd, settlePriceUsd);
    const heldMs = nowMs - p.openedAtMs;
    // Capital: IM posted to carry this position's short option leg, costed over the real holding period.
    const shortLegMargin = p.notionalUsdc * imFraction * pmNetting;
    const capitalCost = shortLegMargin * coc * (Math.max(0, heldMs) / YEAR_MS);
    // Real Bullish open fee (held-to-expiry pays only the open). Default 0 for legacy positions.
    const optionFees = Math.max(0, p.openFeeUsdc ?? 0);
    // In pass_through the collar funds the fee (it's inside the credit), so Atticus's net doesn't bear it
    // again; in embedded the fee comes out of Atticus's margin. serviceFeeUsdc is Atticus's gross revenue.
    const feeBorneByAtticus = p.feesFundedByCollar ? 0 : optionFees;
    const atticusNetAfterFeesAndCapital = p.serviceFeeUsdc + s.atticusOptionNetUsdc - feeBorneByAtticus - capitalCost;
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
      heldMs,
      hedgeReceiptUsdc: s.hedgeReceiptUsdc,
      atticusOptionNetUsdc: s.atticusOptionNetUsdc,
      shortLegMarginUsdc: round2(shortLegMargin),
      capitalCostUsdc: round2(capitalCost),
      optionFeesUsdc: round2(optionFees),
      atticusNetAfterCapitalUsdc: round2(p.serviceFeeUsdc - capitalCost),
      atticusNetAfterFeesAndCapitalUsdc: round2(atticusNetAfterFeesAndCapital)
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
  // ── Back-to-back flatness proof (the number that replaces the misleading raw Foxify-payout swing) ──
  totalHedgeReceiptUsdc: number;         // summed receipt from the identical hedge legs on Bullish
  totalAtticusOptionNetUsdc: number;     // hedgeReceipt − payoutToFoxify, book level ⟹ ~0 if truly flat
  bookHedgedNetBps: number;              // atticus option net / notional × 1e4 (flatness residual; ~0)
  // ── Capital-aware (measured short-leg IM) + real Bullish fees ──
  peakShortLegMarginUsdc: number;        // max single-position IM (point-in-time capital proxy)
  totalCapitalCostUsdc: number;          // summed cost-of-capital over holding periods
  totalOptionFeesUsdc: number;           // summed realized Bullish open fees
  totalAtticusNetAfterCapitalUsdc: number; // serviceFee − capital cost, book level (continuity)
  totalAtticusNetAfterFeesAndCapitalUsdc: number; // serviceFee + optionNet − fees − capital (grounded)
  realizedServiceFeeBps: number;         // serviceFee / notional × 1e4
  capitalAwareNetServiceFeeBps: number;  // (serviceFee − capitalCost) / notional × 1e4
  netAfterFeesAndCapitalBps: number;     // (serviceFee − fees − capitalCost) / notional × 1e4
};

export const aggregateSettlements = (outcomes: SettlementOutcome[]): SettlementAggregate => {
  const n = outcomes.length;
  if (n === 0) {
    return {
      settledPositions: 0, totalNotionalUsdc: 0, totalPayoutToFoxifyUsdc: 0, bookNetPayoutBps: 0,
      totalServiceFeeUsdc: 0, totalCreditAccruedUsdc: 0, totalNetToFoxifyUsdc: 0, pctFloorBreached: 0,
      pctCapBreached: 0, avgPayoutPerPositionUsdc: 0, worstPayoutUsdc: 0, bestPayoutUsdc: 0, avgHeldHours: 0, oracleVerifiedRate: 0,
      totalHedgeReceiptUsdc: 0, totalAtticusOptionNetUsdc: 0, bookHedgedNetBps: 0,
      peakShortLegMarginUsdc: 0, totalCapitalCostUsdc: 0, totalOptionFeesUsdc: 0, totalAtticusNetAfterCapitalUsdc: 0,
      totalAtticusNetAfterFeesAndCapitalUsdc: 0, realizedServiceFeeBps: 0, capitalAwareNetServiceFeeBps: 0, netAfterFeesAndCapitalBps: 0
    };
  }
  const notional = outcomes.reduce((s, o) => s + o.notionalUsdc, 0);
  const payout = outcomes.reduce((s, o) => s + o.payoutToFoxifyUsdc, 0);
  const fee = outcomes.reduce((s, o) => s + o.serviceFeeUsdc, 0);
  const credit = outcomes.reduce((s, o) => s + o.foxifyCreditUsdc, 0);
  const net = outcomes.reduce((s, o) => s + o.netToFoxifyUsdc, 0);
  const capitalCost = outcomes.reduce((s, o) => s + (o.capitalCostUsdc ?? 0), 0);
  const atticusNetAfterCapital = outcomes.reduce((s, o) => s + (o.atticusNetAfterCapitalUsdc ?? o.serviceFeeUsdc), 0);
  const peakMargin = outcomes.reduce((m, o) => Math.max(m, o.shortLegMarginUsdc ?? 0), 0);
  // Back-to-back hedge leg: receipt defaults to the Foxify payout when absent (architecture A, net 0).
  const hedgeReceipt = outcomes.reduce((s, o) => s + (o.hedgeReceiptUsdc ?? o.payoutToFoxifyUsdc), 0);
  const optionNet = outcomes.reduce((s, o) => s + (o.atticusOptionNetUsdc ?? 0), 0);
  const optionFees = outcomes.reduce((s, o) => s + (o.optionFeesUsdc ?? 0), 0);
  const atticusNetAfterFeesAndCapital = outcomes.reduce((s, o) => s + (o.atticusNetAfterFeesAndCapitalUsdc ?? o.atticusNetAfterCapitalUsdc ?? o.serviceFeeUsdc), 0);
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
    oracleVerifiedRate: +(outcomes.filter((o) => o.oracleVerified).length / n).toFixed(4),
    totalHedgeReceiptUsdc: round2(hedgeReceipt),
    totalAtticusOptionNetUsdc: round2(optionNet),
    bookHedgedNetBps: notional > 0 ? +((optionNet / notional) * 1e4).toFixed(4) : 0,
    peakShortLegMarginUsdc: round2(peakMargin),
    totalCapitalCostUsdc: round2(capitalCost),
    totalOptionFeesUsdc: round2(optionFees),
    totalAtticusNetAfterCapitalUsdc: round2(atticusNetAfterCapital),
    totalAtticusNetAfterFeesAndCapitalUsdc: round2(atticusNetAfterFeesAndCapital),
    realizedServiceFeeBps: notional > 0 ? +((fee / notional) * 1e4).toFixed(4) : 0,
    capitalAwareNetServiceFeeBps: notional > 0 ? +(((fee - capitalCost) / notional) * 1e4).toFixed(4) : 0,
    // Use the per-position net (which already respects feesFundedByCollar) rather than blindly subtracting fees.
    netAfterFeesAndCapitalBps: notional > 0 ? +((atticusNetAfterFeesAndCapital / notional) * 1e4).toFixed(4) : 0
  };
};
