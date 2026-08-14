/**
 * Listed-lot pass-through quote. Credit = call bid − put ask − OKX fees on the instruments we
 * would actually trade. If the 1.5% pin has no bid, walk to a neighboring listed OTM strike.
 */

import { computeCollarOpenFees } from "../bullishFees";
import type { PerpSide } from "../creditCollarPricer";
import { parseOkxChain, planLiveCollar, nextStandardDailyExpiryMs, type OkxChainInstrument } from "./okxLivePlanner";

const round2 = (x: number) => +x.toFixed(2);
const round6 = (x: number) => +x.toFixed(6);

export type BookTopPx = { bidPxBtc: number | null; askPxBtc: number | null };

export type ListedTouchQuote =
  | {
      ok: true;
      putStrike: number;
      callStrike: number;
      putInstId: string;
      callInstId: string;
      expiryMs: number;
      floorPct: number;
      capPct: number;
      putAskPxBtc: number;
      callBidPxBtc: number;
      putMidUsdc: number;
      callMidUsdc: number;
      creditUsdc: number;
      venueFeeUsdc: number;
    }
  | { ok: false; error: string; message: string };

export const touchCreditUsdc = (
  callBidPxBtc: number,
  putAskPxBtc: number,
  contracts: number,
  ctValBtc: number,
  spot: number
): number => round2((callBidPxBtc - putAskPxBtc) * contracts * ctValBtc * spot);

export const quoteFromListedBooks = (input: {
  side: PerpSide;
  spot: number;
  planPutStrike: number;
  planCallStrike: number;
  notionalUsdc: number;
  contractsBtc: number;
  nowMs: number;
  chain: OkxChainInstrument[];
  putBook: BookTopPx;
  callBook: BookTopPx;
}): ListedTouchQuote => {
  const planned = planLiveCollar(input.chain, {
    side: input.side,
    spot: input.spot,
    notionalUsdc: input.notionalUsdc,
    putStrike: input.planPutStrike,
    callStrike: input.planCallStrike,
    protectiveMidUsdc: 0,
    fundingMidUsdc: 0.16,
    modelContractsBtc: input.contractsBtc,
    nowMs: input.nowMs
  });
  if (!planned.ok) return { ok: false, error: planned.error, message: planned.message };

  const putLeg = planned.plan.protective.optType === "put" ? planned.plan.protective : planned.plan.funding;
  const callLeg = planned.plan.protective.optType === "call" ? planned.plan.protective : planned.plan.funding;
  // Long: buy put at ask, sell call at bid. Short: buy call at ask, sell put at bid.
  const buyAsk = input.side === "long" ? input.putBook.askPxBtc : input.callBook.askPxBtc;
  const sellBid = input.side === "long" ? input.callBook.bidPxBtc : input.putBook.bidPxBtc;
  const buyInst = input.side === "long" ? putLeg.instId : callLeg.instId;
  const sellInst = input.side === "long" ? callLeg.instId : putLeg.instId;
  if (!(buyAsk != null && buyAsk > 0) || !(sellBid != null && sellBid > 0)) {
    return {
      ok: false,
      error: "listed_book_empty",
      message:
        `listed OKX ${buyInst} ask ${buyAsk ?? "none"} / ${sellInst} bid ${sellBid ?? "none"} — ` +
        `no executable 1-lot credit on the book`
    };
  }

  const gross = touchCreditUsdc(sellBid, buyAsk, planned.plan.contracts, planned.plan.ctValBtc, input.spot);
  const putPrem = (input.side === "long" ? buyAsk : sellBid) * planned.plan.contracts * planned.plan.ctValBtc * input.spot;
  const callPrem = (input.side === "long" ? sellBid : buyAsk) * planned.plan.contracts * planned.plan.ctValBtc * input.spot;
  const fees = computeCollarOpenFees({
    notionalUsd: planned.plan.effectiveNotionalUsdc,
    protectivePremiumUsd: putPrem,
    fundingPremiumUsd: callPrem,
    mode: "clob_taker",
    venue: "okx"
  }).openFeeUsdc;
  const net = round2(gross - fees);
  if (!(net > 0)) {
    return {
      ok: false,
      error: "listed_credit_nonpositive",
      message:
        `listed OKX ${putLeg.instId} / ${callLeg.instId} touch credit $${gross} − OKX fee $${round2(fees)} ≤ 0`
    };
  }

  const putAskPx = input.putBook.askPxBtc ?? buyAsk;
  const callBidPx = input.callBook.bidPxBtc ?? sellBid;
  const putMidPx =
    input.putBook.bidPxBtc != null && input.putBook.bidPxBtc > 0 && putAskPx > 0
      ? (input.putBook.bidPxBtc + putAskPx) / 2
      : putAskPx;
  const callMidPx =
    input.callBook.askPxBtc != null && input.callBook.askPxBtc > 0 && callBidPx > 0
      ? (callBidPx + input.callBook.askPxBtc) / 2
      : callBidPx;
  const qty = planned.plan.contracts * planned.plan.ctValBtc;
  return {
    ok: true,
    putStrike: putLeg.listedStrike,
    callStrike: callLeg.listedStrike,
    putInstId: putLeg.instId,
    callInstId: callLeg.instId,
    expiryMs: planned.plan.expiryMs,
    floorPct: round6((input.spot - putLeg.listedStrike) / input.spot),
    capPct: round6((callLeg.listedStrike - input.spot) / input.spot),
    putAskPxBtc: putAskPx,
    callBidPxBtc: callBidPx,
    putMidUsdc: round2(putMidPx * qty * input.spot),
    callMidUsdc: round2(callMidPx * qty * input.spot),
    creditUsdc: net,
    venueFeeUsdc: round2(fees)
  };
};

type ChainRow = {
  instId?: string;
  optType?: string;
  stk?: string;
  expTime?: string;
  ctVal?: string;
  ctMult?: string;
  tickSz?: string;
  lotSz?: string;
  minSz?: string;
  state?: string;
};

/**
 * Listed OTM candidates nearest a target strike. Calls stay above spot (min/max OTM);
 * puts stay below. Empty-strike pins (e.g. 63750-C with no bid) can then walk to a neighbor.
 */
export const listedWingCandidates = (
  chain: OkxChainInstrument[],
  expiryMs: number,
  optType: "put" | "call",
  spot: number,
  targetStrike: number,
  band: { minOtmPct: number; maxOtmPct: number }
): OkxChainInstrument[] => {
  const lo = optType === "call" ? spot * (1 + band.minOtmPct) : spot * (1 - band.maxOtmPct);
  const hi = optType === "call" ? spot * (1 + band.maxOtmPct) : spot * (1 - band.minOtmPct);
  return chain
    .filter((c) => c.optType === optType && c.expiryMs === expiryMs && c.state === "live" && c.strike >= lo - 1e-6 && c.strike <= hi + 1e-6)
    .sort((a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike));
};

export const firstWingWithTouch = (
  candidates: OkxChainInstrument[],
  books: Record<string, BookTopPx>,
  need: "bid" | "ask"
): { inst: OkxChainInstrument; book: BookTopPx } | null => {
  for (const inst of candidates) {
    const book = books[inst.instId];
    if (!book) continue;
    const px = need === "bid" ? book.bidPxBtc : book.askPxBtc;
    if (px != null && px > 0) return { inst, book };
  }
  return null;
};

const parseBook = (raw: { data?: Array<{ bids?: string[][]; asks?: string[][] }> }): BookTopPx => ({
  bidPxBtc: raw.data?.[0]?.bids?.[0]?.[0] != null ? Number(raw.data[0].bids[0][0]) : null,
  askPxBtc: raw.data?.[0]?.asks?.[0]?.[0] != null ? Number(raw.data[0].asks[0][0]) : null
});

const CALL_BAND = { minOtmPct: 0.008, maxOtmPct: 0.04 };
const PUT_BAND = { minOtmPct: 0.02, maxOtmPct: 0.08 };
const MAX_BOOK_PROBES = 8;

/** Public (unsigned) listed-book quote. Does not place orders. */
export const fetchOkxListedTouchQuote = async (input: {
  side: PerpSide;
  spot: number;
  planPutStrike: number;
  planCallStrike: number;
  notionalUsdc: number;
  contractsBtc: number;
  nowMs: number;
  baseUrl?: string;
}): Promise<ListedTouchQuote> => {
  const base = input.baseUrl ?? process.env.OKX_REST_BASE ?? "https://www.okx.com";
  const getJson = async (path: string): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`OKX ${path} HTTP ${res.status}`);
    return res.json();
  };
  const readBook = async (instId: string): Promise<BookTopPx> =>
    parseBook((await getJson(`/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=1`)) as { data?: Array<{ bids?: string[][]; asks?: string[][] }> });

  try {
    const instr = (await getJson("/api/v5/public/instruments?instType=OPTION&uly=BTC-USD")) as { data?: ChainRow[] };
    const chain = parseOkxChain(instr.data ?? []);
    const planned = planLiveCollar(chain, {
      side: input.side,
      spot: input.spot,
      notionalUsdc: input.notionalUsdc,
      putStrike: input.planPutStrike,
      callStrike: input.planCallStrike,
      protectiveMidUsdc: 0,
      fundingMidUsdc: 0.16,
      modelContractsBtc: input.contractsBtc,
      nowMs: input.nowMs
    });
    const expiryMs = planned.ok ? planned.plan.expiryMs : nextStandardDailyExpiryMs(input.nowMs);
    const sellType = input.side === "long" ? "call" : "put";
    const buyType = input.side === "long" ? "put" : "call";
    const sellTarget = input.side === "long" ? input.planCallStrike : input.planPutStrike;
    const buyTarget = input.side === "long" ? input.planPutStrike : input.planCallStrike;
    const sellCands = listedWingCandidates(chain, expiryMs, sellType, input.spot, sellTarget, sellType === "call" ? CALL_BAND : PUT_BAND).slice(0, MAX_BOOK_PROBES);
    const buyCands = listedWingCandidates(chain, expiryMs, buyType, input.spot, buyTarget, buyType === "put" ? PUT_BAND : CALL_BAND).slice(0, MAX_BOOK_PROBES);
    if (sellCands.length === 0 || buyCands.length === 0) {
      return {
        ok: false,
        error: planned.ok ? "listed_book_empty" : planned.error,
        message: planned.ok ? "no listed OTM wing in band" : planned.message
      };
    }

    const books: Record<string, BookTopPx> = {};
    for (const c of [...buyCands, ...sellCands]) {
      if (!books[c.instId]) books[c.instId] = await readBook(c.instId);
    }
    const buyHit = firstWingWithTouch(buyCands, books, "ask");
    const sellHit = firstWingWithTouch(sellCands, books, "bid");
    if (!buyHit || !sellHit) {
      const buyInst = buyCands[0]?.instId ?? "?";
      const sellInst = sellCands[0]?.instId ?? "?";
      const buyAsk = buyHit?.book.askPxBtc ?? books[buyInst]?.askPxBtc ?? "none";
      const sellBid = sellHit?.book.bidPxBtc ?? books[sellInst]?.bidPxBtc ?? "none";
      return {
        ok: false,
        error: "listed_book_empty",
        message: `listed OKX ${buyInst} ask ${buyAsk} / ${sellInst} bid ${sellBid} — no executable 1-lot credit on the book`
      };
    }

    const putInst = input.side === "long" ? buyHit.inst : sellHit.inst;
    const callInst = input.side === "long" ? sellHit.inst : buyHit.inst;
    return quoteFromListedBooks({
      ...input,
      planPutStrike: putInst.strike,
      planCallStrike: callInst.strike,
      chain,
      putBook: books[putInst.instId],
      callBook: books[callInst.instId]
    });
  } catch (e) {
    return { ok: false, error: "listed_book_fetch_failed", message: (e as Error).message };
  }
};
