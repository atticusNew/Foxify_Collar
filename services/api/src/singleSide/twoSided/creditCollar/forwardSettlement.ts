/**
 * Forward settlement — Phase A (pure, offline). The single settlement engine for the credit collar.
 *
 * SETTLEMENT MODEL (chosen design): TOUCH-FIRST, EUROPEAN FALLBACK.
 *   1. BARRIER TOUCH (priority): if the oracle confirms price has touched a strike during the
 *      position's life, the collar settles AT THE BARRIER (the touched strike). This is the
 *      touch-managed path — Atticus unwinds its hedge at the touch (locking the matched book and
 *      releasing margin early) and Foxify must close the perp at the barrier (enforced elsewhere via
 *      the close-SLA + gap accountability). At the barrier the option is at-the-money, so the unwind
 *      is clean; an optional modeled slippage (touchGapBps) captures gapping past the level.
 *   2. EUROPEAN EXPIRY (fallback): a position that drifts to its expiry WITHOUT touching either
 *      strike settles European-style on the oracle settlement TWAP. This is the guaranteed terminal
 *      path for the no-touch case.
 *
 * Both paths are FAIL-CLOSED on an ECDSA-VERIFIED snapshot — an unverifiable oracle defers (keeps the
 * position open), never settles on an untrusted price. Touch detection is anti-wick (tick-persistent).
 * Credit is VESTED at settlement (barrier_close vs expiry) so the netted credit is what was earned.
 *
 * Pure: open positions + the current cycle's signed oracle (incl. its tick stream) are injected; no I/O.
 */

import { verifySnapshot, computeSettlementTwap, type OracleSnapshot, type OracleTick } from "./referenceOracle";
import { detectBarrier, type BarrierSide } from "./barrierLifecycle";
import { computeVestedCredit, type VestingCurve } from "./creditVesting";
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

/** How the position concluded: at a barrier touch (touch-managed) or European at expiry (fallback). */
export type SettlementType = "barrier_touch" | "european_expiry";

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
  foxifyCreditUsdc: number;        // full accrued credit (pre-vesting)
  netToFoxifyUsdc: number;         // VESTED credit + payout (what Foxify actually keeps)
  serviceFeeUsdc: number;          // Atticus margin
  floorBreached: boolean;          // settle beyond the protective floor (the floor actually paid)
  capBreached: boolean;            // settle beyond the cap (upside surrendered)
  oracleVerified: boolean;
  openedAtMs: number;
  settledAtMs: number;
  heldMs: number;
  // ── Settlement model (touch-first / European fallback) ──
  settlementType: SettlementType;      // barrier_touch vs european_expiry
  barrierSide: BarrierSide;            // "floor" | "ceiling" (touch) | "none" (European)
  vestedCreditUsdc: number;            // credit realized after time-vesting at the conclusion
  creditClawbackUsdc: number;          // full credit − vested (unearned, withheld/returned)
  // ── Capital (measured short-leg IM, Deribit) ──
  shortLegMarginUsdc: number;          // IM posted to carry this position's short option leg
  capitalCostUsdc: number;             // cost-of-capital on that IM over the actual holding period
  atticusNetAfterCapitalUsdc: number;  // serviceFee − capitalCost (the real margin net of capital)
};

/**
 * Settlement-model config. Touch is ON by default (the chosen design). persistTicks is the anti-wick
 * confirmation depth on the oracle tick stream; touchGapBps models slippage past the barrier at the
 * touch; vesting shapes how the credit vests at the conclusion.
 */
export type SettlementLifecycleConfig = {
  enableBarrierTouch?: boolean;    // default true (touch-first); false ⟹ pure European
  persistTicks?: number;           // anti-wick tick persistence to confirm a touch (default 3)
  touchGapBps?: number;            // modeled adverse slippage past the barrier at touch (default 0)
  vesting?: {
    curve?: VestingCurve;          // default "linear"
    convexity?: number;            // exponent for "convex"
    barrierFullVest?: boolean;     // a touch realizes full credit (product choice); default time-vested
    earlyClosePenaltyPct?: number; // anti-churn haircut on voluntary early close
  };
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
 * Settle the open book under the TOUCH-FIRST / EUROPEAN-FALLBACK model. Pure.
 *
 * Per position, in priority order:
 *   1. BARRIER TOUCH — if the (verified) oracle tick stream confirms a strike touch (anti-wick),
 *      settle AT THE BARRIER (touched strike + optional modeled slippage), credit vests barrier_close,
 *      capital costed over the held-to-touch period. Applies even before expiry — a touch can happen
 *      mid-life. This is the path that releases Atticus's hedge margin early.
 *   2. EUROPEAN EXPIRY — else, a position whose expiry has passed settles on the settlement TWAP,
 *      credit vests fully (expiry). The guaranteed terminal path for the no-touch case.
 *   3. Otherwise the position stays open.
 *
 * Fail-closed: touch needs a VERIFIED snapshot (the ticks are only trusted if the oracle verifies);
 * European needs verified snapshot AND a valid TWAP. A matured position that can't be settled on a
 * trusted price is DEFERRED (kept open), never settled on an untrusted one.
 */
export const settleMatured = (
  open: OpenPosition[],
  nowMs: number,
  oracle: CycleOracle,
  capital: SettlementCapitalConfig = {},
  lifecycle: SettlementLifecycleConfig = {}
): {
  settled: SettlementOutcome[];
  stillOpen: OpenPosition[];
  oracleVerified: boolean;
  settlePriceUsd: number | null;
  deferred: number;
  touchSettled: number;
  europeanSettled: number;
} => {
  const oracleVerified = verifySnapshot(oracle.snapshot, oracle.signatureHex, oracle.publicKeyPem);
  const twap = computeSettlementTwap(oracle.settlementTwapTicks, oracle.windowStartMs, oracle.windowEndMs);
  const twapPriceUsd = twap.ok ? twap.twapUsd : null;
  const imFraction = capital.shortOptionImFraction ?? 0.1393;
  const pmNetting = capital.portfolioMarginNettingFactor ?? 1.0;
  const coc = capital.costOfCapitalAnnual ?? 0.12;

  const enableTouch = lifecycle.enableBarrierTouch !== false; // default ON (touch-first)
  const persist = lifecycle.persistTicks ?? 3;
  const touchGapBps = Math.max(0, lifecycle.touchGapBps ?? 0);

  const settled: SettlementOutcome[] = [];
  const stillOpen: OpenPosition[] = [];
  let deferred = 0;
  let touchSettled = 0;
  let europeanSettled = 0;

  // Build a settled outcome at a given price + conclusion (credit vested per the reason). Pure.
  const buildOutcome = (
    p: OpenPosition,
    settlePriceUsd: number,
    settledAtMs: number,
    settlementType: SettlementType,
    barrierSide: BarrierSide
  ): SettlementOutcome => {
    const s = computeCollarSettlement(p, settlePriceUsd);
    const heldMs = Math.max(0, settledAtMs - p.openedAtMs);
    const tenorMs = Math.max(1, p.expiresAtMs - p.openedAtMs);
    const vest = computeVestedCredit(
      {
        fullCreditUsdc: p.foxifyCreditUsdc,
        tenorMs,
        curve: lifecycle.vesting?.curve,
        convexity: lifecycle.vesting?.convexity,
        // A barrier touch is INVOLUNTARY (price hit the level) ⟹ full credit is earned by default.
        // Time-vesting/clawback is the anti-farming lever for VOLUNTARY early closes (the orphan path
        // in barrierLifecycle), not for legitimate barrier triggers. Override to false to time-vest.
        barrierFullVest: lifecycle.vesting?.barrierFullVest ?? true,
        earlyClosePenaltyPct: lifecycle.vesting?.earlyClosePenaltyPct
      },
      heldMs,
      settlementType === "barrier_touch" ? "barrier_close" : "expiry"
    );
    // Capital: IM posted to carry the short option leg, costed over the real holding period.
    const shortLegMargin = p.notionalUsdc * imFraction * pmNetting;
    const capitalCost = shortLegMargin * coc * (heldMs / YEAR_MS);
    // Net to Foxify uses the VESTED credit (what was earned), not the full accrual.
    const netToFoxify = vest.realizedCreditUsdc + s.payoutToFoxifyUsdc;
    return {
      ref: p.ref,
      side: p.side,
      notionalUsdc: p.notionalUsdc,
      spotAtEntry: p.spotAtEntry,
      settlePriceUsd: round2(settlePriceUsd),
      movePct: +((settlePriceUsd - p.spotAtEntry) / p.spotAtEntry).toFixed(6),
      putIntrinsicUsd: s.putIntrinsicUsd,
      callIntrinsicUsd: s.callIntrinsicUsd,
      payoutToFoxifyUsdc: s.payoutToFoxifyUsdc,
      foxifyCreditUsdc: p.foxifyCreditUsdc,
      netToFoxifyUsdc: round2(netToFoxify),
      serviceFeeUsdc: p.serviceFeeUsdc,
      floorBreached: s.floorBreached,
      capBreached: s.capBreached,
      oracleVerified: true,
      openedAtMs: p.openedAtMs,
      settledAtMs,
      heldMs,
      settlementType,
      barrierSide,
      vestedCreditUsdc: vest.realizedCreditUsdc,
      creditClawbackUsdc: vest.clawbackUsdc,
      shortLegMarginUsdc: round2(shortLegMargin),
      capitalCostUsdc: round2(capitalCost),
      atticusNetAfterCapitalUsdc: round2(p.serviceFeeUsdc - capitalCost)
    };
  };

  for (const p of open) {
    // 1) Barrier touch (priority over expiry). Trust the tick stream only if the snapshot verifies.
    const touch =
      enableTouch && oracleVerified
        ? detectBarrier(oracle.settlementTwapTicks, p.putStrike, p.callStrike, persist)
        : { barrier: "none" as BarrierSide, confirmTsMs: null as number | null };
    if (touch.barrier !== "none") {
      const barrierPrice = touch.barrier === "floor" ? p.putStrike : p.callStrike;
      const gapAbs = (touchGapBps / 1e4) * barrierPrice;
      // Adverse slippage direction: floor closes a touch BELOW the floor; ceiling ABOVE the ceiling.
      const settlePx = touch.barrier === "floor" ? barrierPrice - gapAbs : barrierPrice + gapAbs;
      const settledAt = touch.confirmTsMs != null ? Math.min(nowMs, Math.max(p.openedAtMs, touch.confirmTsMs)) : nowMs;
      settled.push(buildOutcome(p, settlePx, settledAt, "barrier_touch", touch.barrier));
      touchSettled += 1;
      continue;
    }

    // 2) European fallback at expiry.
    if (p.expiresAtMs > nowMs) {
      stillOpen.push(p);
      continue;
    }
    if (!oracleVerified || !twap.ok || twapPriceUsd == null) {
      // Matured but oracle impaired → defer (fail-closed, per the settlement policy).
      stillOpen.push(p);
      deferred += 1;
      continue;
    }
    settled.push(buildOutcome(p, twapPriceUsd, nowMs, "european_expiry", "none"));
    europeanSettled += 1;
  }
  return { settled, stillOpen, oracleVerified, settlePriceUsd: twapPriceUsd, deferred, touchSettled, europeanSettled };
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
  // ── Settlement model breakdown (touch-first / European fallback) ──
  touchSettlements: number;          // settled at a barrier touch (touch-managed)
  europeanSettlements: number;       // settled European at expiry (no-touch fallback)
  pctTouchSettled: number;           // touch / total (how often the touch path engaged)
  totalCreditClawbackUsdc: number;   // credit withheld via vesting (unearned at early conclusion)
  avgPayoutPerPositionUsdc: number;
  worstPayoutUsdc: number;
  bestPayoutUsdc: number;
  avgHeldHours: number;
  oracleVerifiedRate: number;
  // ── Capital-aware (measured short-leg IM) ──
  peakShortLegMarginUsdc: number;        // max single-position IM (point-in-time capital proxy)
  totalCapitalCostUsdc: number;          // summed cost-of-capital over holding periods
  totalAtticusNetAfterCapitalUsdc: number; // serviceFee − capital cost, book level
  realizedServiceFeeBps: number;         // serviceFee / notional × 1e4
  capitalAwareNetServiceFeeBps: number;  // (serviceFee − capitalCost) / notional × 1e4
};

export const aggregateSettlements = (outcomes: SettlementOutcome[]): SettlementAggregate => {
  const n = outcomes.length;
  if (n === 0) {
    return {
      settledPositions: 0, totalNotionalUsdc: 0, totalPayoutToFoxifyUsdc: 0, bookNetPayoutBps: 0,
      totalServiceFeeUsdc: 0, totalCreditAccruedUsdc: 0, totalNetToFoxifyUsdc: 0, pctFloorBreached: 0,
      pctCapBreached: 0, touchSettlements: 0, europeanSettlements: 0, pctTouchSettled: 0, totalCreditClawbackUsdc: 0,
      avgPayoutPerPositionUsdc: 0, worstPayoutUsdc: 0, bestPayoutUsdc: 0, avgHeldHours: 0, oracleVerifiedRate: 0,
      peakShortLegMarginUsdc: 0, totalCapitalCostUsdc: 0, totalAtticusNetAfterCapitalUsdc: 0, realizedServiceFeeBps: 0, capitalAwareNetServiceFeeBps: 0
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
  const clawback = outcomes.reduce((s, o) => s + (o.creditClawbackUsdc ?? 0), 0);
  // Older ledger rows (pre settlement-model) have no settlementType → treat as European.
  const touchCount = outcomes.filter((o) => o.settlementType === "barrier_touch").length;
  const europeanCount = n - touchCount;
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
    touchSettlements: touchCount,
    europeanSettlements: europeanCount,
    pctTouchSettled: +(touchCount / n).toFixed(4),
    totalCreditClawbackUsdc: round2(clawback),
    avgPayoutPerPositionUsdc: round2(payout / n),
    worstPayoutUsdc: round2(Math.min(...payouts)),
    bestPayoutUsdc: round2(Math.max(...payouts)),
    avgHeldHours: +(outcomes.reduce((s, o) => s + o.heldMs, 0) / n / 3_600_000).toFixed(2),
    oracleVerifiedRate: +(outcomes.filter((o) => o.oracleVerified).length / n).toFixed(4),
    peakShortLegMarginUsdc: round2(peakMargin),
    totalCapitalCostUsdc: round2(capitalCost),
    totalAtticusNetAfterCapitalUsdc: round2(atticusNetAfterCapital),
    realizedServiceFeeBps: notional > 0 ? +((fee / notional) * 1e4).toFixed(4) : 0,
    capitalAwareNetServiceFeeBps: notional > 0 ? +(((fee - capitalCost) / notional) * 1e4).toFixed(4) : 0
  };
};
