/**
 * OKX settlement reconciliation — after a live position expires (08:00 UTC daily), verify that the
 * venue's ACTUAL settlement matches what the hedge should have paid, and measure the oracle-vs-venue
 * basis. Two distinct questions, kept separate on purpose:
 *
 *   1. VENUE INTEGRITY (drives the mismatch halt): did OKX's realized cash flow on our two legs equal
 *      the collar payoff at OKX'S OWN delivery price for our exact contracts? A discrepancy here means
 *      fills/positions/ledger disagree with the venue — halt new issuance until resolved.
 *   2. BASIS (informational alert): our oracle settlement price vs OKX's delivery price. This is the
 *      known reference basis (6–14 bps observed) — measured and reported, not a halt condition.
 *
 * Venue data (delivery price + bills) can lag the expiry: records start as "pending_venue_data" and
 * are re-attempted on later cycles. Pure comparator; fetch/assembly is deps-injected.
 */

import { parseOkxOption } from "../../okxProbe";
import type { SettlementOutcome } from "../forwardSettlement";
import type { LiveReconRecord } from "./liveExecutionStore";

const round2 = (x: number) => +x.toFixed(2);

/** Venue-side data assembled from public delivery history + private bills. */
export type OkxSettlementData = {
  /** OKX delivery/exercise price per expired instId (USD). */
  deliveryPxByInstId: Record<string, number>;
  /** Net settlement cash flow per instId from account bills, in BTC (positive = credited to us). */
  cashFlowBtcByInstId: Record<string, number | undefined>;
};

/** Collar payoff (USD) at a settlement price for the HEDGE legs (long protective, short funding). Pure. */
export const hedgePayoffUsd = (side: "long" | "short", putStrike: number, callStrike: number, contractsBtc: number, priceUsd: number): number => {
  const put = Math.max(0, putStrike - priceUsd) * contractsBtc;
  const call = Math.max(0, priceUsd - callStrike) * contractsBtc;
  return side === "long" ? put - call : call - put;
};

/**
 * Reconcile one settled okx_live position against venue data. Requires outcome.liveMeta (real fills).
 * Pure — returns the record to persist; the caller decides on halts/alerts.
 */
export const reconcileLiveSettlement = (
  outcome: SettlementOutcome,
  okx: OkxSettlementData,
  opts: { toleranceUsdc: number; nowMs: number }
): LiveReconRecord => {
  const meta = outcome.liveMeta;
  const notes: string[] = [];
  const base: Omit<LiveReconRecord, "status"> = {
    tsMs: opts.nowMs,
    ref: outcome.ref,
    putInstId: meta?.putInstId ?? null,
    callInstId: meta?.callInstId ?? null,
    ourSettlePriceUsd: outcome.settlePriceUsd,
    okxDeliveryPriceUsd: null,
    priceDiffUsd: null,
    ourPayoutUsdc: outcome.payoutToFoxifyUsdc,
    okxCashFlowUsdc: null,
    cashDiffUsdc: null,
    toleranceUsdc: opts.toleranceUsdc,
    notes
  };

  if (!meta) {
    notes.push("no liveMeta on the settled outcome — cannot reconcile a non-live position");
    return { ...base, status: "mismatch" };
  }

  const putParsed = parseOkxOption(meta.putInstId);
  const callParsed = parseOkxOption(meta.callInstId);
  if (!putParsed || !callParsed) {
    notes.push(`could not parse strikes from instIds ${meta.putInstId}/${meta.callInstId}`);
    return { ...base, status: "mismatch" };
  }

  const deliveryPx = okx.deliveryPxByInstId[meta.putInstId] ?? okx.deliveryPxByInstId[meta.callInstId] ?? null;
  if (deliveryPx == null) {
    notes.push("OKX delivery price not yet published for this expiry — retry next cycle");
    return { ...base, status: "pending_venue_data" };
  }

  const putCashBtc = okx.cashFlowBtcByInstId[meta.putInstId];
  const callCashBtc = okx.cashFlowBtcByInstId[meta.callInstId];
  if (putCashBtc == null && callCashBtc == null) {
    // Expired fully OTM legs may produce NO bills at all — that is a legitimate $0 settlement.
    const contractsBtc = meta.contracts * meta.ctValBtc;
    const expected = hedgePayoffUsd(outcome.side, putParsed.strike, callParsed.strike, contractsBtc, deliveryPx);
    if (Math.abs(expected) <= opts.toleranceUsdc) {
      notes.push("no settlement bills and expected payoff ≈ 0 (both legs expired OTM) — reconciled at $0");
      const priceDiff = round2(outcome.settlePriceUsd - deliveryPx);
      return { ...base, okxDeliveryPriceUsd: deliveryPx, priceDiffUsd: priceDiff, okxCashFlowUsdc: 0, cashDiffUsdc: round2(0 - expected), status: "matched" };
    }
    notes.push(`expected non-zero settlement (${round2(expected)} USD) but no OKX bills found — retry next cycle`);
    return { ...base, okxDeliveryPriceUsd: deliveryPx, priceDiffUsd: round2(outcome.settlePriceUsd - deliveryPx), status: "pending_venue_data" };
  }

  const contractsBtc = meta.contracts * meta.ctValBtc;
  const expectedUsd = hedgePayoffUsd(outcome.side, putParsed.strike, callParsed.strike, contractsBtc, deliveryPx);
  const okxCashUsd = round2(((putCashBtc ?? 0) + (callCashBtc ?? 0)) * deliveryPx);
  const cashDiff = round2(okxCashUsd - expectedUsd);
  const priceDiff = round2(outcome.settlePriceUsd - deliveryPx);

  const matched = Math.abs(cashDiff) <= opts.toleranceUsdc;
  if (!matched) notes.push(`venue cash ${okxCashUsd} differs from expected payoff-at-delivery ${round2(expectedUsd)} by ${cashDiff} (tolerance ${opts.toleranceUsdc})`);
  notes.push(`oracle-vs-venue basis: ${priceDiff} USD (${round2((priceDiff / deliveryPx) * 1e4)} bps) — informational`);

  return {
    ...base,
    okxDeliveryPriceUsd: deliveryPx,
    priceDiffUsd: priceDiff,
    okxCashFlowUsdc: okxCashUsd,
    cashDiffUsdc: cashDiff,
    status: matched ? "matched" : "mismatch"
  };
};

// ── Venue-data assembly (deps-injected fetchers; thin) ────────────────────────

export type ReconFetchers = {
  getDeliveryExerciseHistory: () => Promise<{ ok: boolean; data: Array<{ ts?: string; details?: Array<{ insId?: string; px?: string; type?: string }> }> }>;
  getBills: () => Promise<{ ok: boolean; data: Array<{ instId?: string; type?: string; subType?: string; balChg?: string; ts?: string }> }>;
};

/** OKX bill types/subTypes that are settlement cash flows for options (delivery/exercise family). */
const SETTLEMENT_BILL_TYPE_DELIVERY = "3"; // type 3 = delivery/exercise
const SETTLEMENT_BILL_SUBTYPES = new Set(["112", "113", "170", "171", "172"]); // delivery long/short · exercised · counterparty exercised · expired OTM

export const isSettlementBill = (b: { type?: string; subType?: string }): boolean =>
  (b.subType != null && SETTLEMENT_BILL_SUBTYPES.has(String(b.subType))) || String(b.type ?? "") === SETTLEMENT_BILL_TYPE_DELIVERY;

/** Pull + shape the venue data for a set of instIds. Errors degrade to empty maps (⟹ pending). */
export const fetchOkxSettlementData = async (fetchers: ReconFetchers, instIds: string[]): Promise<OkxSettlementData> => {
  const want = new Set(instIds);
  const deliveryPxByInstId: Record<string, number> = {};
  const cashFlowBtcByInstId: Record<string, number> = {};
  try {
    const hist = await fetchers.getDeliveryExerciseHistory();
    for (const row of hist.data ?? []) {
      for (const d of row.details ?? []) {
        const id = String(d.insId ?? "");
        const px = Number(d.px ?? NaN);
        if (want.has(id) && Number.isFinite(px) && px > 0) deliveryPxByInstId[id] = px;
      }
    }
  } catch (e) {
    console.error(`[okx-recon] delivery history fetch failed: ${(e as Error).message}`);
  }
  try {
    const bills = await fetchers.getBills();
    for (const b of bills.data ?? []) {
      const id = String(b.instId ?? "");
      if (!want.has(id) || !isSettlementBill(b)) continue;
      const chg = Number(b.balChg ?? NaN);
      if (Number.isFinite(chg)) cashFlowBtcByInstId[id] = (cashFlowBtcByInstId[id] ?? 0) + chg;
    }
  } catch (e) {
    console.error(`[okx-recon] bills fetch failed: ${(e as Error).message}`);
  }
  return { deliveryPxByInstId, cashFlowBtcByInstId };
};
