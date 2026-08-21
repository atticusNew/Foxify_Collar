/**
 * OKX live collar UNWIND — close BOTH legs on screen and verify flat. Used by (a) the pair-atomicity
 * abort (sibling collar filled but its pair leg failed) and (b) the agreed early-close policy.
 *
 * Ordering is the safety argument: the hedge holds LONG protective + SHORT funding. We buy back the
 * SHORT leg FIRST — if that fails we stop BEFORE touching the long leg, so the position is still a
 * complete, fully-hedged collar and simply rides to expiry (the documented fail-safe). Only after the
 * short is closed do we sell the long; a stranded long-only residue is bounded (premium already paid)
 * and is alerted for manual completion, never naked short exposure.
 */

import type { PerpSide } from "../creditCollarPricer";
import type { LiveExecClient } from "./okxLiveCollarExecutor";
import { premiumUsd, iocClosePxBtc } from "./okxLivePlanner";

export type UnwindTarget = {
  side: PerpSide;
  putInstId: string;
  callInstId: string;
  contracts: number;
  ctValBtc: number;
};

export type UnwindLegClose = {
  instId: string;
  action: "buy" | "sell";     // the CLOSING action
  closedContracts: number;
  avgPxBtc: number | null;
  feeBtc: number;
};

export type UnwindReport = {
  outcome: "closed" | "rides_to_expiry" | "long_residue";
  complete: boolean;                 // both legs fully closed + venue flat
  fundingClose: UnwindLegClose;      // buy back the short leg (FIRST)
  protectiveClose: UnwindLegClose;   // sell the long leg (second)
  verifiedFlat: boolean | null;
  /** Net USD realized by the unwind: protective sale proceeds − funding buy-back cost − fees. */
  unwindValueUsdc: number | null;
  notes: string[];
};

const parseNum = (v: string | undefined | null): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const unwindLiveCollar = async (
  client: LiveExecClient,
  target: UnwindTarget,
  opts: {
    spotUsd: number;
    pollTries?: number;
    pollDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    clOrdPrefix?: string;
    /**
     * RETRY contexts (the knockout monitor) MUST set this: reads the venue's actual positions
     * first and never re-closes an already-flat leg. Single-shot contexts (pair-atomicity abort,
     * quote-floor breach) keep the original behavior unchanged.
     */
    checkVenueFirst?: boolean;
  }
): Promise<UnwindReport> => {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollTries = opts.pollTries ?? 10;
  const pollDelayMs = opts.pollDelayMs ?? 1_000;
  const notes: string[] = [];

  // Long-perp hedge: long put (protective), short call (funding). Short-perp: mirror.
  const fundingInstId = target.side === "long" ? target.callInstId : target.putInstId;
  const protectiveInstId = target.side === "long" ? target.putInstId : target.callInstId;

  // ── IDEMPOTENCY GUARD (live incident, Aug 21): the unwind must read the VENUE's positions
  // before placing anything. A retry loop whose previous attempt actually filled — but whose
  // fill confirmation failed — must NOT re-close an already-flat leg: OKX does not honor
  // reduceOnly on options, so a repeated "close" buy OPENS a fresh long instead of rejecting
  // (five accumulated calls on the canary account before the laptop slept). Venue truth first;
  // if the venue can't be read, we proceed on the caller's belief exactly as before.
  let venueFundingOpen: number | null = null;
  let venueProtectiveOpen: number | null = null;
  if (opts.checkVenueFirst) {
    try {
      const pos = await client.getPositions("OPTION");
      const find = (instId: string) => (pos.data ?? []).find((p) => p.instId === instId);
      venueFundingOpen = Math.abs(Number(find(fundingInstId)?.pos ?? 0));
      venueProtectiveOpen = Math.abs(Number(find(protectiveInstId)?.pos ?? 0));
    } catch (e) {
      notes.push(`pre-unwind position check failed (${(e as Error).message}) — proceeding on caller state`);
    }
  }
  if (venueFundingOpen === 0 && venueProtectiveOpen === 0) {
    notes.push("venue already FLAT on both legs — nothing to unwind (a previous attempt completed)");
    return {
      outcome: "closed",
      complete: true,
      fundingClose: { instId: fundingInstId, action: "buy", closedContracts: 0, avgPxBtc: null, feeBtc: 0 },
      protectiveClose: { instId: protectiveInstId, action: "sell", closedContracts: 0, avgPxBtc: null, feeBtc: 0 },
      verifiedFlat: true,
      unwindValueUsdc: 0,
      notes
    };
  }

  const closeLeg = async (instId: string, action: "buy" | "sell", tag: string): Promise<UnwindLegClose> => {
    const out: UnwindLegClose = { instId, action, closedContracts: 0, avgPxBtc: null, feeBtc: 0 };
    // OKX options reject market orders — price an aggressive IOC limit off the live book.
    const top = await client.getBookTop(instId);
    const book = top.data?.[0];
    const px = iocClosePxBtc(action, { bidPxBtc: parseNum(book?.bids?.[0]?.[0]), askPxBtc: parseNum(book?.asks?.[0]?.[0]) }, 0.05);
    if (px == null) {
      notes.push(`close ${action} ${instId}: EMPTY BOOK — no safe IOC reference; not closed`);
      return out;
    }
    const res = await client.placeOrder({
      instId,
      side: action,
      ordType: "ioc",
      px: String(px),
      sz: String(target.contracts),
      tdMode: "cross",
      reduceOnly: true,
      clOrdId: opts.clOrdPrefix ? `${opts.clOrdPrefix}${tag}` : undefined
    });
    const ordId = res.data?.[0]?.ordId;
    if (!res.ok || !ordId) {
      notes.push(`close ${action} ${instId} REJECTED: ${res.code} ${res.data?.[0]?.sMsg ?? res.msg}`);
      return out;
    }
    for (let i = 0; i < pollTries; i++) {
      const q = await client.getOrder(instId, ordId);
      const snap = q.data?.[0];
      if (snap?.state === "filled") {
        out.closedContracts = parseNum(snap.accFillSz) ?? target.contracts;
        out.avgPxBtc = parseNum(snap.avgPx);
        const fee = parseNum(snap.fee);
        if (fee != null) out.feeBtc = -fee;
        return out;
      }
      if (snap?.state === "canceled") {
        out.closedContracts = parseNum(snap.accFillSz) ?? 0;
        out.avgPxBtc = parseNum(snap.avgPx);
        notes.push(`close order ${ordId} on ${instId} canceled at ${out.closedContracts}/${target.contracts}`);
        return out;
      }
      await sleep(pollDelayMs);
    }
    notes.push(`close order ${ordId} on ${instId} did not confirm within ${pollTries} polls`);
    return out;
  };

  // 1) Buy back the SHORT (funding) leg first — unless the venue says it is already flat
  //    (a prior attempt's fill that we failed to confirm). Never re-buy a closed short.
  let fundingClose: UnwindLegClose;
  if (venueFundingOpen === 0) {
    notes.push(`funding leg ${fundingInstId} already flat at the venue — skipping buy-back`);
    fundingClose = { instId: fundingInstId, action: "buy", closedContracts: target.contracts, avgPxBtc: null, feeBtc: 0 };
  } else {
    const closeQty = venueFundingOpen != null ? Math.min(target.contracts, venueFundingOpen) : target.contracts;
    if (closeQty !== target.contracts) notes.push(`funding leg shows ${venueFundingOpen} open at the venue — closing ${closeQty}, not ${target.contracts}`);
    fundingClose = await closeLeg(fundingInstId, "buy", "UF");
  }
  if (fundingClose.closedContracts < target.contracts) {
    notes.push("short-leg buy-back incomplete — ABORTING unwind before touching the long leg; position stays fully hedged and rides to expiry");
    return {
      outcome: "rides_to_expiry",
      complete: false,
      fundingClose,
      protectiveClose: { instId: protectiveInstId, action: "sell", closedContracts: 0, avgPxBtc: null, feeBtc: 0 },
      verifiedFlat: null,
      unwindValueUsdc: null,
      notes
    };
  }

  // 2) Sell the LONG (protective) leg — same venue-truth guard (selling an already-sold long
  //    would open a naked short, which is worse than the re-buy case).
  let protectiveClose: UnwindLegClose;
  if (venueProtectiveOpen === 0) {
    notes.push(`protective leg ${protectiveInstId} already flat at the venue — skipping sale`);
    protectiveClose = { instId: protectiveInstId, action: "sell", closedContracts: target.contracts, avgPxBtc: null, feeBtc: 0 };
  } else {
    protectiveClose = await closeLeg(protectiveInstId, "sell", "UP");
  }
  const longResidue = protectiveClose.closedContracts < target.contracts;

  // 3) Verify flat at the venue.
  let verifiedFlat: boolean | null = null;
  try {
    const pos = await client.getPositions("OPTION");
    const residual = (pos.data ?? []).filter((p) => (p.instId === target.putInstId || p.instId === target.callInstId) && Math.abs(Number(p.pos ?? 0)) > 1e-9);
    verifiedFlat = residual.length === 0;
    if (!verifiedFlat) notes.push(`venue still reports: ${residual.map((p) => `${p.instId}=${p.pos}`).join(", ")}`);
  } catch (e) {
    notes.push(`flat check failed: ${(e as Error).message}`);
  }

  const complete = !longResidue && verifiedFlat !== false;
  const proceeds = protectiveClose.avgPxBtc != null ? premiumUsd(protectiveClose.avgPxBtc, protectiveClose.closedContracts, target.ctValBtc, opts.spotUsd) : 0;
  const cost = fundingClose.avgPxBtc != null ? premiumUsd(fundingClose.avgPxBtc, fundingClose.closedContracts, target.ctValBtc, opts.spotUsd) : 0;
  const feesUsd = +((fundingClose.feeBtc + protectiveClose.feeBtc) * opts.spotUsd).toFixed(2);
  const unwindValueUsdc = +(proceeds - cost - feesUsd).toFixed(2);

  if (longResidue) notes.push(`LONG RESIDUE: ${target.contracts - protectiveClose.closedContracts} protective contracts still open (bounded risk — complete manually)`);

  return {
    outcome: longResidue ? "long_residue" : "closed",
    complete,
    fundingClose,
    protectiveClose,
    verifiedFlat,
    unwindValueUsdc,
    notes
  };
};
