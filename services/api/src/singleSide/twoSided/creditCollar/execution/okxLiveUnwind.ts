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

// OKX BTC option price tick (BTC per BTC underlying). Mark-referenced prices MUST land on a tick —
// off-tick prices are rejected outright, which looks like "no liquidity" to the retry loop.
const TICK_BTC = 0.0001;
const floorTick = (px: number): number => Math.max(TICK_BTC, +(Math.floor(px / TICK_BTC + 1e-9) * TICK_BTC).toFixed(8));
const ceilTick = (px: number): number => Math.max(TICK_BTC, +(Math.ceil(px / TICK_BTC - 1e-9) * TICK_BTC).toFixed(8));

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
    /**
     * A LONG protective residue worth ≤ this (at venue mark) that cannot find a bid is ABANDONED
     * as dust and the unwind reports complete: a long option is risk-free (premium already paid),
     * it settles itself at expiry, and hammering an empty bid side forever only generates alert
     * noise (live incident, Aug 21: a ~$1 OTM put with zero bids paged the operator every retry).
     * Never applies to the SHORT funding leg. Set 0 to disable.
     */
    dustMaxUsd?: number;
    /**
     * Deeper sell rungs (mark×0.5, then the minimum tick — IOC limits still fill AT the best bid,
     * the limit only floors the price) are used only when the leg's total mark value is ≤ this:
     * fire-sale pricing is for closing near-worthless legs, never for dumping real value.
     */
    fireSaleMaxUsd?: number;
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

  const dustMaxUsd = opts.dustMaxUsd ?? 20;
  const fireSaleMaxUsd = opts.fireSaleMaxUsd ?? 50;
  const legMarkPx = new Map<string, number>(); // instId → venue mark (BTC), for the dust decision

  const closeLeg = async (instId: string, action: "buy" | "sell", tag: string, qty: number): Promise<UnwindLegClose> => {
    const out: UnwindLegClose = { instId, action, closedContracts: 0, avgPxBtc: null, feeBtc: 0 };
    // OKX options reject market orders — every close is an IOC LIMIT walked down a price ladder:
    // book-referenced first, then venue mark (thin ITM/OTM books cancel bid-referenced IOCs
    // forever), and — for SELLS of near-worthless legs only — mark×0.5 and finally the minimum
    // tick. An IOC limit still fills AT the best bid (the limit only floors the price), so the
    // min-tick rung takes whatever bid exists; it is gated by fireSaleMaxUsd so real value is
    // never dumped. All prices are tick-aligned (off-tick prices are rejected outright).
    const pxCandidates: number[] = [];
    const top = await client.getBookTop(instId);
    const book = top.data?.[0];
    const bookPx = iocClosePxBtc(action, { bidPxBtc: parseNum(book?.bids?.[0]?.[0]), askPxBtc: parseNum(book?.asks?.[0]?.[0]) }, 0.05);
    if (bookPx != null) pxCandidates.push(bookPx);
    const getMark = (client as { getMarkPrice?: (i: string) => Promise<{ data?: Array<{ markPx?: string }> }> }).getMarkPrice;
    if (typeof getMark === "function") {
      try {
        const mk = await getMark.call(client, instId);
        const mark = parseNum(mk.data?.[0]?.markPx);
        if (mark != null && mark > 0) {
          legMarkPx.set(instId, mark);
          pxCandidates.push(action === "sell" ? floorTick(mark * 0.9) : ceilTick(mark * 1.1));
          const legValueUsd = mark * qty * target.ctValBtc * opts.spotUsd;
          if (action === "sell" && legValueUsd <= fireSaleMaxUsd) {
            pxCandidates.push(floorTick(mark * 0.5), TICK_BTC);
          }
        }
      } catch {
        /* mark unavailable — book price only */
      }
    }
    const ladder = [...new Set(pxCandidates)];
    if (ladder.length === 0) {
      notes.push(`close ${action} ${instId}: EMPTY BOOK and no mark — no safe IOC reference; not closed`);
      return out;
    }
    for (let attempt = 0; attempt < ladder.length; attempt++) {
      const px = ladder[attempt];
      const res = await client.placeOrder({
        instId,
        side: action,
        ordType: "ioc",
        px: String(px),
        sz: String(qty),
        tdMode: "cross",
        reduceOnly: true,
        clOrdId: opts.clOrdPrefix ? `${opts.clOrdPrefix}${tag}${attempt === 0 ? "" : String(attempt)}` : undefined
      });
      const ordId = res.data?.[0]?.ordId;
      if (!res.ok || !ordId) {
        notes.push(`close ${action} ${instId} REJECTED at ${px}: ${res.code} ${res.data?.[0]?.sMsg ?? res.msg}`);
        continue; // try the next price reference
      }
      for (let i = 0; i < pollTries; i++) {
        const q = await client.getOrder(instId, ordId);
        const snap = q.data?.[0];
        if (snap?.state === "filled") {
          out.closedContracts = parseNum(snap.accFillSz) ?? qty;
          out.avgPxBtc = parseNum(snap.avgPx);
          const fee = parseNum(snap.fee);
          if (fee != null) out.feeBtc = -fee;
          return out;
        }
        if (snap?.state === "canceled") {
          out.closedContracts = parseNum(snap.accFillSz) ?? 0;
          out.avgPxBtc = parseNum(snap.avgPx);
          notes.push(`close order ${ordId} on ${instId} canceled at ${out.closedContracts}/${qty}${attempt < ladder.length - 1 && out.closedContracts === 0 ? " — walking down the price ladder" : ""}`);
          break; // 0-filled cancel ⟹ try the next price; partial fill ⟹ report and stop
        }
        await sleep(pollDelayMs);
      }
      if (out.closedContracts > 0) return out;
      if (out.avgPxBtc == null && out.closedContracts === 0 && attempt === ladder.length - 1) {
        notes.push(`close order on ${instId} did not fill at any rung of the price ladder this pass`);
      }
    }
    return out;
  };

  // 1) Buy back the SHORT (funding) leg first — unless the venue says it is already flat
  //    (a prior attempt's fill that we failed to confirm). Never re-buy a closed short.
  let fundingClose: UnwindLegClose;
  let fundingDone: boolean;
  if (venueFundingOpen === 0) {
    notes.push(`funding leg ${fundingInstId} already flat at the venue — skipping buy-back`);
    fundingClose = { instId: fundingInstId, action: "buy", closedContracts: target.contracts, avgPxBtc: null, feeBtc: 0 };
    fundingDone = true;
  } else {
    const closeQty = venueFundingOpen != null ? Math.min(target.contracts, venueFundingOpen) : target.contracts;
    if (closeQty !== target.contracts) notes.push(`funding leg shows ${venueFundingOpen} open at the venue — closing ${closeQty}, not ${target.contracts}`);
    fundingClose = await closeLeg(fundingInstId, "buy", "UF", closeQty);
    fundingDone = fundingClose.closedContracts >= closeQty;
  }
  if (!fundingDone) {
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
  let protectiveQty = target.contracts;
  if (venueProtectiveOpen === 0) {
    notes.push(`protective leg ${protectiveInstId} already flat at the venue — skipping sale`);
    protectiveClose = { instId: protectiveInstId, action: "sell", closedContracts: target.contracts, avgPxBtc: null, feeBtc: 0 };
    protectiveQty = 0;
  } else {
    protectiveQty = venueProtectiveOpen != null ? Math.min(target.contracts, venueProtectiveOpen) : target.contracts;
    if (protectiveQty !== target.contracts) notes.push(`protective leg shows ${venueProtectiveOpen} open at the venue — closing ${protectiveQty}, not ${target.contracts}`);
    protectiveClose = await closeLeg(protectiveInstId, "sell", "UP", protectiveQty);
  }
  let longResidue = protectiveQty > 0 && protectiveClose.closedContracts < protectiveQty;

  // 2b) DUST ABANDONMENT — a long residue that cannot find a bid and is worth ≤ dustMaxUsd at the
  //     venue's own mark is written off, not retried forever: a long option is risk-free (premium
  //     already paid), it settles itself at expiry, and every retry against an empty bid side is
  //     pure alert noise. The unwind reports COMPLETE; the note records what was left and why.
  let dusted = false;
  if (longResidue && dustMaxUsd > 0) {
    const residueContracts = protectiveQty - protectiveClose.closedContracts;
    const markPx = legMarkPx.get(protectiveInstId);
    const residueUsd = markPx != null ? +(markPx * residueContracts * target.ctValBtc * opts.spotUsd).toFixed(2) : null;
    if (residueUsd != null && residueUsd <= dustMaxUsd) {
      dusted = true;
      longResidue = false;
      notes.push(
        `protective residue ${residueContracts} contract(s) ≈ $${residueUsd} ≤ dust line $${dustMaxUsd} — ` +
          `ABANDONED AS DUST: long option, risk bounded at zero, settles itself at expiry (no manual action needed, no further retries)`
      );
    }
  }

  // 3) Verify flat at the venue. A dusted protective residue is expected to remain — only the
  //    funding leg must be flat for the unwind to count as complete in that case.
  let verifiedFlat: boolean | null = null;
  let fundingFlatAtVenue: boolean | null = null;
  try {
    const pos = await client.getPositions("OPTION");
    const residual = (pos.data ?? []).filter((p) => (p.instId === target.putInstId || p.instId === target.callInstId) && Math.abs(Number(p.pos ?? 0)) > 1e-9);
    verifiedFlat = residual.length === 0;
    fundingFlatAtVenue = !residual.some((p) => p.instId === fundingInstId);
    if (!verifiedFlat) notes.push(`venue still reports: ${residual.map((p) => `${p.instId}=${p.pos}`).join(", ")}`);
  } catch (e) {
    notes.push(`flat check failed: ${(e as Error).message}`);
  }

  const complete = dusted ? fundingFlatAtVenue !== false : !longResidue && verifiedFlat !== false;
  const proceeds = protectiveClose.avgPxBtc != null ? premiumUsd(protectiveClose.avgPxBtc, protectiveClose.closedContracts, target.ctValBtc, opts.spotUsd) : 0;
  const cost = fundingClose.avgPxBtc != null ? premiumUsd(fundingClose.avgPxBtc, fundingClose.closedContracts, target.ctValBtc, opts.spotUsd) : 0;
  const feesUsd = +((fundingClose.feeBtc + protectiveClose.feeBtc) * opts.spotUsd).toFixed(2);
  const unwindValueUsdc = +(proceeds - cost - feesUsd).toFixed(2);

  if (longResidue) notes.push(`LONG RESIDUE: ${protectiveQty - protectiveClose.closedContracts} protective contracts still open (bounded risk — complete manually)`);

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
