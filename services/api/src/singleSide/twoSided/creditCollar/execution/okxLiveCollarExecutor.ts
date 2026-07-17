/**
 * OKX LIVE collar executor — the real-order twin of the demo executor, built for the pilot's hard
 * invariant: BOTH legs of a collar fill or NEITHER stands. Per collar:
 *
 *   1. Both legs placed CONCURRENTLY as band-capped marketable limits (cross to touch, never beyond
 *      model-mid × (1 ± band) — a fill outside the slippage band is impossible by construction).
 *   2. Poll to a deadline → cancel unfilled → retry ONCE for the remainder at refreshed touch (same
 *      band anchor) → cancel again.
 *   3. If both legs are NOT fully filled after the retry: unwind EVERY contract that did fill
 *      (reduceOnly market), verify flat via positions, and abort cleanly. Partial fills are never
 *      kept: the position is exactly its intended size, or nothing.
 *
 * Real premiums + venue fees are read from the venue's own order records (avgPx / fee / feeCcy).
 * Deps-injected client ⟹ unit-testable with scripted fake venues; the same code runs demo and live.
 */

import type { OkxLegOrder } from "./okxExecutionClient";
import { fillWithinBand, premiumUsd, bandCappedLimitPxBtc, type LiveCollarPlan, type PlannedLeg } from "./okxLivePlanner";

export type LiveExecClient = {
  mode: "demo" | "live";
  placeOrder: (o: OkxLegOrder) => Promise<{ ok: boolean; code: string; msg: string; data: Array<{ ordId?: string; sCode?: string; sMsg?: string }> }>;
  getOrder: (instId: string, ordId: string) => Promise<{ ok: boolean; data: Array<{ state?: string; avgPx?: string; accFillSz?: string; fee?: string; feeCcy?: string }> }>;
  cancelOrder: (instId: string, ordId: string) => Promise<{ ok: boolean; data: unknown[] }>;
  getBookTop: (instId: string) => Promise<{ ok: boolean; data: Array<{ bids?: string[][]; asks?: string[][] }> }>;
  getPositions: (instType?: string) => Promise<{ ok: boolean; data: Array<{ instId?: string; pos?: string; imr?: string }> }>;
};

export type LiveExecutorOpts = {
  bandPct: number;              // max slippage vs model mid, per leg (env LIVE_SLIPPAGE_BAND_PCT)
  fillTimeoutMs?: number;       // per attempt (default 20_000)
  pollDelayMs?: number;         // default 1_000
  spotUsd: number;              // for USD conversion of BTC premiums/fees
  tdMode?: "cross" | "isolated";
  clOrdPrefix?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LiveLegResult = {
  instId: string;
  action: "buy" | "sell";
  requestedContracts: number;
  filledContracts: number;
  avgPxBtc: number | null;
  feeBtc: number;               // venue fee in BTC (positive = cost; rebates net against it)
  ordIds: string[];
  withinBand: boolean | null;   // null when unfilled
  slippagePctVsMid: number | null; // (fill − mid)/mid signed so + = worse for us on both sides
  lastState: string;
};

export type LiveUnwindResult = {
  attempted: boolean;
  protectiveClosed: number;
  fundingClosed: number;
  complete: boolean;            // every filled contract was closed AND venue reports flat
  verifiedFlat: boolean | null; // getPositions check (null if the check itself failed)
  notes: string[];
};

export type LiveCollarExecutionReport = {
  mode: "demo" | "live";
  outcome: "filled" | "aborted_no_fill" | "aborted_unwound" | "naked_leg_unresolved";
  safe: boolean;                // no naked exposure left standing
  protective: LiveLegResult;
  funding: LiveLegResult;
  unwind: LiveUnwindResult | null;
  /** Realized economics (only when outcome === "filled"). */
  protectivePremiumUsdc: number | null;  // paid for the floor leg
  fundingPremiumUsdc: number | null;     // received for the cap leg
  venueFeeUsdc: number | null;           // both legs' realized venue fees, USD
  netCreditUsdc: number | null;          // funding − protective − fees
  alerts: string[];
  errors: string[];
};

type LegTracker = {
  leg: PlannedLeg;
  requested: number;
  filled: number;
  weightedPx: number;   // Σ(px × contracts) for avg
  feeBtc: number;
  ordIds: string[];
  lastState: string;
};

const parseNum = (v: string | undefined | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Absorb a final order snapshot (filled or canceled-with-partials) into the tracker. Pure-ish. */
const absorbOrder = (t: LegTracker, snap: { state?: string; avgPx?: string; accFillSz?: string; fee?: string } | undefined): void => {
  if (!snap) return;
  const acc = parseNum(snap.accFillSz) ?? 0;
  const px = parseNum(snap.avgPx);
  if (acc > 0 && px != null) {
    t.filled += acc;
    t.weightedPx += px * acc;
  }
  const fee = parseNum(snap.fee);
  if (fee != null) t.feeBtc += -fee; // OKX fee is negative when charged; store cost as positive
  if (snap.state) t.lastState = snap.state;
};

const legResult = (t: LegTracker, bandPct: number): LiveLegResult => {
  const avgPx = t.filled > 0 ? t.weightedPx / t.filled : null;
  const mid = t.leg.modelMidPxBtc;
  const signedSlip = avgPx != null && mid > 0 ? (t.leg.action === "buy" ? (avgPx - mid) / mid : (mid - avgPx) / mid) : null;
  return {
    instId: t.leg.instId,
    action: t.leg.action,
    requestedContracts: t.requested,
    filledContracts: t.filled,
    avgPxBtc: avgPx != null ? +avgPx.toFixed(8) : null,
    feeBtc: +t.feeBtc.toFixed(8),
    ordIds: t.ordIds,
    withinBand: avgPx != null ? fillWithinBand(t.leg.action, avgPx, mid, bandPct) : null,
    slippagePctVsMid: signedSlip != null ? +signedSlip.toFixed(6) : null,
    lastState: t.lastState
  };
};

/**
 * Execute one collar live: both legs or neither. Returns the full report; NEVER throws on venue
 * errors (they land in report.errors and drive the outcome).
 */
export const executeLiveCollar = async (client: LiveExecClient, plan: LiveCollarPlan, opts: LiveExecutorOpts): Promise<LiveCollarExecutionReport> => {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const fillTimeoutMs = opts.fillTimeoutMs ?? 20_000;
  const pollDelayMs = opts.pollDelayMs ?? 1_000;
  const errors: string[] = [];
  const alerts: string[] = [];

  const trackers: Record<"protective" | "funding", LegTracker> = {
    protective: { leg: plan.protective, requested: plan.contracts, filled: 0, weightedPx: 0, feeBtc: 0, ordIds: [], lastState: "unplaced" },
    funding: { leg: plan.funding, requested: plan.contracts, filled: 0, weightedPx: 0, feeBtc: 0, ordIds: [], lastState: "unplaced" }
  };

  const touchOf = async (leg: PlannedLeg): Promise<number | null> => {
    try {
      const book = await client.getBookTop(leg.instId);
      const top = book.data?.[0];
      const raw = leg.action === "buy" ? top?.asks?.[0]?.[0] : top?.bids?.[0]?.[0];
      return parseNum(raw ?? null);
    } catch (e) {
      errors.push(`book read failed for ${leg.instId}: ${(e as Error).message}`);
      return null;
    }
  };

  // One attempt: place band-capped limits for every leg with remaining size, poll to deadline, cancel stragglers.
  const attempt = async (attemptNo: number): Promise<void> => {
    type OpenOrder = { key: "protective" | "funding"; ordId: string; done: boolean };
    const openOrders: OpenOrder[] = [];

    for (const key of ["protective", "funding"] as const) {
      const t = trackers[key];
      const remaining = t.requested - t.filled;
      if (remaining <= 0) continue;
      const touch = await touchOf(t.leg);
      const limitPx = bandCappedLimitPxBtc(t.leg.action, t.leg.modelMidPxBtc, touch, opts.bandPct, t.leg.tickSz);
      const res = await client.placeOrder({
        instId: t.leg.instId,
        side: t.leg.action,
        ordType: "limit",
        sz: String(remaining),
        px: String(limitPx),
        tdMode: opts.tdMode ?? "cross",
        clOrdId: opts.clOrdPrefix ? `${opts.clOrdPrefix}${key === "protective" ? "P" : "F"}${attemptNo}` : undefined
      });
      const ordId = res.data?.[0]?.ordId;
      if (!res.ok || !ordId) {
        const detail = res.data?.[0]?.sMsg ?? res.msg;
        errors.push(`place ${t.leg.action} ${t.leg.instId} attempt ${attemptNo} failed: ${res.code} ${detail}`);
        t.lastState = "place_failed";
        continue;
      }
      t.ordIds.push(ordId);
      t.lastState = "live";
      openOrders.push({ key, ordId, done: false });
    }

    const deadline = now() + fillTimeoutMs;
    while (openOrders.some((o) => !o.done) && now() < deadline) {
      for (const o of openOrders) {
        if (o.done) continue;
        const t = trackers[o.key];
        const q = await client.getOrder(t.leg.instId, o.ordId);
        const snap = q.data?.[0];
        if (snap?.state === "filled" || snap?.state === "canceled") {
          absorbOrder(t, snap);
          o.done = true;
        }
      }
      if (openOrders.some((o) => !o.done)) await sleep(pollDelayMs);
    }

    // Deadline: cancel stragglers, then absorb the FINAL snapshot (captures partial fills + fees).
    for (const o of openOrders) {
      if (o.done) continue;
      const t = trackers[o.key];
      try {
        await client.cancelOrder(t.leg.instId, o.ordId);
      } catch (e) {
        errors.push(`cancel ${o.ordId} failed: ${(e as Error).message}`);
      }
      const q = await client.getOrder(t.leg.instId, o.ordId);
      const snap = q.data?.[0];
      if (snap?.state === "filled" || snap?.state === "canceled") {
        absorbOrder(t, snap);
      } else {
        // Order may still be live (cancel raced) — absorb what we can see and flag it.
        absorbOrder(t, snap);
        if (snap?.state === "live" || snap?.state === "partially_filled") {
          errors.push(`order ${o.ordId} on ${t.leg.instId} still ${snap.state} after cancel — verify manually`);
        }
      }
      o.done = true;
    }
  };

  await attempt(1);
  const incompleteAfter1 = (["protective", "funding"] as const).some((k) => trackers[k].filled < trackers[k].requested);
  if (incompleteAfter1) await attempt(2);

  const prot = trackers.protective;
  const fund = trackers.funding;
  const fullyFilled = prot.filled === prot.requested && fund.filled === fund.requested;
  const anyFill = prot.filled > 0 || fund.filled > 0;

  let unwind: LiveUnwindResult | null = null;
  let outcome: LiveCollarExecutionReport["outcome"];

  if (fullyFilled) {
    outcome = "filled";
  } else if (!anyFill) {
    outcome = "aborted_no_fill";
  } else {
    // Incomplete: unwind EVERY filled contract (both-or-neither extends to fills). reduceOnly market.
    alerts.push(`ONE-SIDED/PARTIAL FILL on ${plan.protective.instId}/${plan.funding.instId} (protective ${prot.filled}/${prot.requested}, funding ${fund.filled}/${fund.requested}) — unwinding all fills`);
    const notes: string[] = [];
    let protClosed = 0;
    let fundClosed = 0;
    const closeLeg = async (t: LegTracker): Promise<number> => {
      if (t.filled <= 0) return 0;
      const res = await client.placeOrder({
        instId: t.leg.instId,
        side: t.leg.action === "buy" ? "sell" : "buy",
        ordType: "market",
        sz: String(t.filled),
        tdMode: opts.tdMode ?? "cross",
        reduceOnly: true,
        clOrdId: opts.clOrdPrefix ? `${opts.clOrdPrefix}U${t.leg.role === "protective" ? "P" : "F"}` : undefined
      });
      const ordId = res.data?.[0]?.ordId;
      if (!res.ok || !ordId) {
        notes.push(`unwind ${t.leg.instId} REJECTED: ${res.code} ${res.data?.[0]?.sMsg ?? res.msg}`);
        return 0;
      }
      // Confirm the market close actually filled.
      for (let i = 0; i < 10; i++) {
        const q = await client.getOrder(t.leg.instId, ordId);
        const snap = q.data?.[0];
        if (snap?.state === "filled") {
          const closed = parseNum(snap.accFillSz) ?? t.filled;
          const fee = parseNum(snap.fee);
          if (fee != null) t.feeBtc += -fee;
          notes.push(`closed ${closed} on ${t.leg.instId} @ ${snap.avgPx ?? "?"}`);
          return closed;
        }
        if (snap?.state === "canceled") break;
        await sleep(pollDelayMs);
      }
      notes.push(`unwind order ${ordId} on ${t.leg.instId} did not confirm filled`);
      return 0;
    };
    // Close the SHORT (funding) leg first — a stranded short is the dangerous side.
    fundClosed = await closeLeg(fund);
    protClosed = await closeLeg(prot);

    // Verify flat at the venue.
    let verifiedFlat: boolean | null = null;
    try {
      const pos = await client.getPositions("OPTION");
      const residual = (pos.data ?? []).filter(
        (p) => (p.instId === plan.protective.instId || p.instId === plan.funding.instId) && Math.abs(Number(p.pos ?? 0)) > 1e-9
      );
      verifiedFlat = residual.length === 0;
      if (!verifiedFlat) notes.push(`venue still reports positions: ${residual.map((p) => `${p.instId}=${p.pos}`).join(", ")}`);
    } catch (e) {
      verifiedFlat = null;
      notes.push(`flat check failed: ${(e as Error).message}`);
    }

    const complete = fundClosed >= fund.filled && protClosed >= prot.filled && verifiedFlat !== false;
    unwind = { attempted: true, protectiveClosed: protClosed, fundingClosed: fundClosed, complete, verifiedFlat, notes };
    outcome = complete ? "aborted_unwound" : "naked_leg_unresolved";
    if (!complete) alerts.push(`CRITICAL: unwind incomplete on ${plan.protective.instId}/${plan.funding.instId} — MANUAL INTERVENTION REQUIRED (naked exposure possible)`);
  }

  const protRes = legResult(prot, opts.bandPct);
  const fundRes = legResult(fund, opts.bandPct);
  if (outcome === "filled") {
    if (protRes.withinBand === false || fundRes.withinBand === false) {
      alerts.push(`FILL OUTSIDE SLIPPAGE BAND (protective withinBand=${protRes.withinBand}, funding withinBand=${fundRes.withinBand}) — limit-price guard should have prevented this; investigate`);
    }
  }

  const protPremium = outcome === "filled" && protRes.avgPxBtc != null ? premiumUsd(protRes.avgPxBtc, prot.filled, plan.ctValBtc, opts.spotUsd) : null;
  const fundPremium = outcome === "filled" && fundRes.avgPxBtc != null ? premiumUsd(fundRes.avgPxBtc, fund.filled, plan.ctValBtc, opts.spotUsd) : null;
  const feeUsd = outcome === "filled" ? +((prot.feeBtc + fund.feeBtc) * opts.spotUsd).toFixed(2) : null;
  const netCredit = protPremium != null && fundPremium != null && feeUsd != null ? +(fundPremium - protPremium - feeUsd).toFixed(2) : null;

  return {
    mode: client.mode,
    outcome,
    safe: outcome === "filled" || outcome === "aborted_no_fill" || outcome === "aborted_unwound",
    protective: protRes,
    funding: fundRes,
    unwind,
    protectivePremiumUsdc: protPremium,
    fundingPremiumUsdc: fundPremium,
    venueFeeUsdc: feeUsd,
    netCreditUsdc: netCredit,
    alerts,
    errors
  };
};
