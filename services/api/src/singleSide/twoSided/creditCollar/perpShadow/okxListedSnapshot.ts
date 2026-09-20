/**
 * One second of the OKX listed BTC options book, deep enough to price the
 * Earn & Protect collar at any geometry and any size from the SAME data.
 *
 * The live demo (`okxListedTouchQuote.fetchOkxListedTouchQuote`) reads the
 * top of book for the wings it needs and quotes one collar. The shadow needs
 * the alternatives too: other floor/cap geometries, other fee rules, larger
 * sizes walked down the depth. So the snapshot captures every live option at
 * the expiry within the widest band either side, with depth, once; every
 * pure pricing function below reads from it. Nothing here places orders.
 */

import { computeCollarOpenFees } from "../bullishFees";
import { exceedProb, expTimeFromMs, pickCap, YEAR_MS, type CapRule } from "../capRule";
import type { PerpSide } from "../creditCollarPricer";
import { demoPlanStrikes } from "../demoWrap";
import {
  FUNDING_BAND,
  PROTECTIVE_BAND,
  listedWingCandidates,
  touchCreditUsdc,
} from "../execution/okxListedTouchQuote";
import { nextListedWeeklyExpiryMs, nextStandardDailyExpiryMs, parseOkxChain, type OkxChainInstrument } from "../execution/okxLivePlanner";
import type { CollarGeometry } from "../perpTenor";

export { nextListedWeeklyExpiryMs };
export type { CollarGeometry };

const round2 = (x: number) => +x.toFixed(2);
const round6 = (x: number) => +x.toFixed(6);

/** [price in BTC, size in contracts], best first */
export type BookLevel = { pxBtc: number; contracts: number };
export interface BookDepth {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface OkxListedSnapshot {
  atMs: number;
  /** the live product's expiry: the next standard daily (08:00 UTC, ≥ 12h out) */
  expiryMs: number;
  /** the next weekly (Friday 08:00 UTC, ≥ 5 days out) that is listed; the tenor counterfactual */
  weeklyExpiryMs: number | null;
  /** live options at those expiries inside the union of both bands, either side */
  chain: OkxChainInstrument[];
  books: Record<string, BookDepth>;
  /** how many instruments had no readable book (fetch failures are recorded, never guessed) */
  booksMissing: number;
  /** OKX mark vol (annualized fraction) per instId at the snapshot's expiries, for the cap rule; absent when unreadable */
  markVols?: Record<string, number>;
}

export const parseDepth = (raw: { data?: Array<{ bids?: string[][]; asks?: string[][] }> }): BookDepth => {
  const lv = (rows: string[][] | undefined): BookLevel[] =>
    (rows ?? [])
      .map((r) => ({ pxBtc: Number(r[0]), contracts: Number(r[1]) }))
      .filter((l) => Number.isFinite(l.pxBtc) && l.pxBtc > 0 && Number.isFinite(l.contracts) && l.contracts > 0);
  return { bids: lv(raw.data?.[0]?.bids), asks: lv(raw.data?.[0]?.asks) };
};

export const topOf = (d: BookDepth | undefined): { bidPxBtc: number | null; askPxBtc: number | null } => ({
  bidPxBtc: d?.bids[0]?.pxBtc ?? null,
  askPxBtc: d?.asks[0]?.pxBtc ?? null,
});

/**
 * Average price for `contracts` walked down one side of the book, or null
 * when the visible depth does not cover the size. `levelsUsed` is how far
 * down the walk went (1 = filled at the top).
 */
export const walkBook = (
  levels: BookLevel[],
  contracts: number,
): { avgPxBtc: number; levelsUsed: number; topPxBtc: number } | null => {
  if (contracts <= 0 || levels.length === 0) return null;
  let left = contracts;
  let cost = 0;
  let used = 0;
  for (const l of levels) {
    const take = Math.min(left, l.contracts);
    cost += take * l.pxBtc;
    left -= take;
    used += 1;
    if (left <= 1e-9) return { avgPxBtc: cost / contracts, levelsUsed: used, topPxBtc: levels[0].pxBtc };
  }
  return null;
};

/** The union band either side of spot: everything a geometry in either role could touch. */
export const snapshotBand = (spot: number): { lo: number; hi: number } => {
  const maxOtm = Math.max(FUNDING_BAND.maxOtmPct, PROTECTIVE_BAND.maxOtmPct);
  return { lo: spot * (1 - maxOtm) * 0.999, hi: spot * (1 + maxOtm) * 1.001 };
};

export const instrumentsInBand = (chain: OkxChainInstrument[], expiryMs: number, spot: number): OkxChainInstrument[] => {
  const { lo, hi } = snapshotBand(spot);
  return chain.filter((c) => c.state === "live" && c.expiryMs === expiryMs && c.strike >= lo && c.strike <= hi);
};



/** Public (unsigned) snapshot: instruments + depth for every in-band option at the next daily expiry. */
export const fetchOkxListedSnapshot = async (input: {
  spot: number;
  nowMs: number;
  baseUrl?: string;
  depth?: number;
  fetchImpl?: typeof fetch;
}): Promise<OkxListedSnapshot> => {
  const base = input.baseUrl ?? process.env.OKX_REST_BASE ?? "https://www.okx.com";
  const f = input.fetchImpl ?? fetch;
  const getJson = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`OKX ${path} HTTP ${res.status}`);
    return res.json();
  };
  const instr = (await getJson("/api/v5/public/instruments?instType=OPTION&uly=BTC-USD")) as { data?: unknown[] };
  const chainAll = parseOkxChain((instr.data ?? []) as Parameters<typeof parseOkxChain>[0]);
  const expiryMs = nextStandardDailyExpiryMs(input.nowMs);
  const weeklyExpiryMs = nextListedWeeklyExpiryMs(chainAll, input.nowMs);
  const chain = [
    ...instrumentsInBand(chainAll, expiryMs, input.spot),
    ...(weeklyExpiryMs != null && weeklyExpiryMs !== expiryMs ? instrumentsInBand(chainAll, weeklyExpiryMs, input.spot) : []),
  ];
  const books: Record<string, BookDepth> = {};
  let booksMissing = 0;
  const sz = input.depth ?? 25;
  for (const c of chain) {
    try {
      books[c.instId] = parseDepth(
        (await getJson(`/api/v5/market/books?instId=${encodeURIComponent(c.instId)}&sz=${sz}`)) as Parameters<typeof parseDepth>[0],
      );
    } catch {
      booksMissing += 1;
    }
  }
  const markVols = await fetchMarkVolsForExpiries(getJson, [expiryMs, weeklyExpiryMs]);
  return { atMs: input.nowMs, expiryMs, weeklyExpiryMs, chain, books, booksMissing, ...(markVols ? { markVols } : {}) };
};

/**
 * Mark vols for the snapshot's expiries from OKX opt-summary (one request per expiry). A failure
 * leaves the field absent: the cap rule then falls back to `widest` rather than guess a vol.
 */
export const fetchMarkVolsForExpiries = async (
  getJson: (path: string) => Promise<unknown>,
  expiries: Array<number | null>,
): Promise<Record<string, number> | null> => {
  const out: Record<string, number> = {};
  let any = false;
  for (const e of new Set(expiries.filter((x): x is number => x != null))) {
    try {
      const j = (await getJson(`/api/v5/public/opt-summary?uly=BTC-USD&expTime=${expTimeFromMs(e)}`)) as { data?: Array<{ instId?: string; markVol?: string }> };
      for (const row of j.data ?? []) {
        const iv = Number(row.markVol);
        if (row.instId && Number.isFinite(iv) && iv > 0) {
          out[row.instId] = iv;
          any = true;
        }
      }
    } catch {
      /* recorded as absent */
    }
  }
  return any ? out : null;
};

/**
 * Top-of-book snapshot in two requests (instruments + the option tickers feed):
 * every in-band strike at the daily and weekly expiries priced at the same
 * instant. Depth is one level, so `mode: "walk"` is not meaningful on it; the
 * shadow's `fetchOkxListedSnapshot` keeps depth.
 */
export const fetchOkxTopSnapshot = async (input: {
  spot: number;
  nowMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<OkxListedSnapshot> => {
  const base = input.baseUrl ?? process.env.OKX_REST_BASE ?? "https://www.okx.com";
  const f = input.fetchImpl ?? fetch;
  const getJson = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`OKX ${path} HTTP ${res.status}`);
    return res.json();
  };
  const [instr, tickers] = await Promise.all([
    getJson("/api/v5/public/instruments?instType=OPTION&uly=BTC-USD") as Promise<{ data?: unknown[] }>,
    getJson("/api/v5/market/tickers?instType=OPTION&uly=BTC-USD") as Promise<{
      data?: Array<{ instId?: string; bidPx?: string; askPx?: string; bidSz?: string; askSz?: string }>;
    }>,
  ]);
  const chainAll = parseOkxChain((instr.data ?? []) as Parameters<typeof parseOkxChain>[0]);
  const expiryMs = nextStandardDailyExpiryMs(input.nowMs);
  const weeklyExpiryMs = nextListedWeeklyExpiryMs(chainAll, input.nowMs);
  const chain = [
    ...instrumentsInBand(chainAll, expiryMs, input.spot),
    ...(weeklyExpiryMs != null && weeklyExpiryMs !== expiryMs ? instrumentsInBand(chainAll, weeklyExpiryMs, input.spot) : []),
  ];
  const byId = new Map((tickers.data ?? []).map((t) => [t.instId ?? "", t]));
  const books: Record<string, BookDepth> = {};
  let booksMissing = 0;
  for (const c of chain) {
    const t = byId.get(c.instId);
    if (!t) {
      booksMissing += 1;
      continue;
    }
    const lvl = (px?: string, sz?: string): BookLevel[] => {
      const p = Number(px);
      const s = Number(sz);
      return Number.isFinite(p) && p > 0 ? [{ pxBtc: p, contracts: Number.isFinite(s) && s > 0 ? s : 1 }] : [];
    };
    books[c.instId] = { bids: lvl(t.bidPx, t.bidSz), asks: lvl(t.askPx, t.askSz) };
  }
  const markVols = await fetchMarkVolsForExpiries(getJson, [expiryMs, weeklyExpiryMs]);
  return { atMs: input.nowMs, expiryMs, weeklyExpiryMs, chain, books, booksMissing, ...(markVols ? { markVols } : {}) };
};

export type FillMode = "top" | "walk";

export type SnapshotQuote =
  | {
      ok: true;
      side: PerpSide;
      contracts: number;
      ctValBtc: number;
      notionalUsdc: number;
      expiryMs: number;
      buyInstId: string;
      sellInstId: string;
      buyStrike: number;
      sellStrike: number;
      /** realised geometry after snapping to listed strikes */
      floorPct: number;
      capPct: number;
      /** what we pay for the protective wing / receive for the funding wing, BTC per BTC, at the fill mode */
      buyPxBtc: number;
      sellPxBtc: number;
      /** top-of-book reference for the same wings (equals the fill at mode "top") */
      buyTopPxBtc: number;
      sellTopPxBtc: number;
      /** mid of each wing where both sides exist; null otherwise */
      buyMidPxBtc: number | null;
      sellMidPxBtc: number | null;
      grossCreditUsdc: number;
      venueFeeUsdc: number;
      /** gross minus fee: what the market funds before our take */
      netCreditUsdc: number;
      /** the same collar valued at venue mids (null when a mid is missing): the fair-value anchor */
      midCreditUsdc: number | null;
      levelsUsed: { buy: number; sell: number };
      /** market-implied chance the cycle settles beyond the cap, from the sold strike's mark vol; null when unreadable */
      capExceedProb: number | null;
      capRuleApplied: CapRule["kind"];
    }
  | { ok: false; error: string; message: string };

/**
 * Price one collar geometry at one size from the snapshot, the way the live
 * demo does: the protective wing is the nearest in-band listed strike with an
 * ask; the funding wing is the WIDEST in-band strike whose net credit after
 * venue fees is positive (walking tighter only when nothing wider clears).
 * `mode: "walk"` fills each wing down the depth for the whole size instead of
 * at the top; the difference is the cost of size.
 */
export const quoteCollarFromSnapshot = (
  input: {
    side: PerpSide;
    spot: number;
    contracts: number;
    geometry: CollarGeometry;
    mode?: FillMode;
    expiryMs?: number;
    /** the widest strike the cap search may reach, fraction from spot (default the 4% funding band) */
    maxCapPct?: number;
    /** price THIS funding strike instead of searching: the cap-distance ladder holds the floor and moves the cap */
    pinSellInstId?: string;
    /** which paying strike the cap sells (capRule.ts); default the widest that pays */
    capRule?: CapRule;
  },
  snap: OkxListedSnapshot,
): SnapshotQuote => {
  const mode: FillMode = input.mode ?? "top";
  const expiryMs = input.expiryMs ?? snap.expiryMs;
  const ctValBtc = snap.chain[0]?.ctValBtc ?? 0.01;
  if (!(input.contracts >= 1)) return { ok: false, error: "below_min_lot", message: "size rounds to zero listed lots" };
  const plan = demoPlanStrikes(input.spot, input.side, input.geometry.floorPct, input.geometry.capPct);
  const sellType: "put" | "call" = input.side === "long" ? "call" : "put";
  const buyType: "put" | "call" = input.side === "long" ? "put" : "call";
  const sellTarget = input.side === "long" ? plan.callStrike : plan.putStrike;
  const buyTarget = input.side === "long" ? plan.putStrike : plan.callStrike;
  const fundingBand = { minOtmPct: FUNDING_BAND.minOtmPct, maxOtmPct: Math.max(FUNDING_BAND.minOtmPct, input.maxCapPct ?? FUNDING_BAND.maxOtmPct) };
  const sellCands = input.pinSellInstId
    ? snap.chain.filter((c) => c.instId === input.pinSellInstId && c.optType === sellType && c.expiryMs === expiryMs)
    : listedWingCandidates(snap.chain, expiryMs, sellType, input.spot, sellTarget, fundingBand).slice(0, 10);
  const buyCands = listedWingCandidates(snap.chain, expiryMs, buyType, input.spot, buyTarget, PROTECTIVE_BAND).slice(0, 10);
  if (sellCands.length === 0 || buyCands.length === 0) {
    return { ok: false, error: "listed_book_empty", message: "no listed OTM wing in band at this expiry" };
  }

  const fillAt = (instId: string, need: "bid" | "ask") => {
    const d = snap.books[instId];
    if (!d) return null;
    const levels = need === "bid" ? d.bids : d.asks;
    if (mode === "top") {
      const top = levels[0]?.pxBtc;
      return top != null && top > 0 ? { avgPxBtc: top, levelsUsed: 1, topPxBtc: top } : null;
    }
    return walkBook(levels, input.contracts);
  };

  let buy: { inst: OkxChainInstrument; fill: NonNullable<ReturnType<typeof fillAt>> } | null = null;
  for (const inst of buyCands) {
    const fill = fillAt(inst.instId, "ask");
    if (fill) {
      buy = { inst, fill };
      break;
    }
  }
  if (!buy) {
    return {
      ok: false,
      error: mode === "walk" ? "depth_insufficient" : "listed_book_empty",
      message: `no protective ${buyType} in band with ${mode === "walk" ? `${input.contracts} contracts of ask depth` : "an ask"}`,
    };
  }
  const notionalUsdc = round2(input.contracts * ctValBtc * input.spot);
  type SellCand = { inst: OkxChainInstrument; fill: NonNullable<ReturnType<typeof fillAt>>; net: number; gross: number; fee: number; strike: number; netUsdc: number; exceedProb: number | null };
  const rule: CapRule = input.capRule ?? { kind: "widest" };
  const yearsToExpiry = Math.max(0, expiryMs - snap.atMs) / YEAR_MS;
  const exceedProbOf = (inst: OkxChainInstrument): number | null => {
    const iv = snap.markVols?.[inst.instId];
    return iv == null ? null : exceedProb({ side: input.side, spot: input.spot, strike: inst.strike, ivAnnual: iv, yearsToExpiry });
  };
  const cands: SellCand[] = [];
  let closest: SellCand | null = null;
  for (const inst of sellCands) {
    const fill = fillAt(inst.instId, "bid");
    if (!fill) continue;
    const gross = touchCreditUsdc(fill.avgPxBtc, buy.fill.avgPxBtc, input.contracts, ctValBtc, input.spot);
    const qty = input.contracts * ctValBtc;
    const fee = computeCollarOpenFees({
      notionalUsd: notionalUsdc,
      protectivePremiumUsd: buy.fill.avgPxBtc * qty * input.spot,
      fundingPremiumUsd: fill.avgPxBtc * qty * input.spot,
      mode: "clob_taker",
      venue: "okx",
    }).openFeeUsdc;
    const net = round2(gross - fee);
    const cand: SellCand = { inst, fill, net, gross, fee: round2(fee), strike: inst.strike, netUsdc: net, exceedProb: exceedProbOf(inst) };
    cands.push(cand);
    if (!closest || cand.net > closest.net) closest = cand;
  }
  const chosen = pickCap(cands, input.spot, rule);
  const pick = chosen?.pick ?? null;
  if (!pick) {
    return closest
      ? {
          ok: false,
          error: "listed_credit_nonpositive",
          message: `${buy.inst.instId} / ${closest.inst.instId}: credit $${closest.gross} − fee $${closest.fee} ≤ 0`,
        }
      : {
          ok: false,
          error: mode === "walk" ? "depth_insufficient" : "listed_book_empty",
          message: `no funding ${sellType} in band with ${mode === "walk" ? `${input.contracts} contracts of bid depth` : "a bid"}`,
        };
  }

  const mid = (instId: string): number | null => {
    const t = topOf(snap.books[instId]);
    return t.bidPxBtc != null && t.askPxBtc != null ? (t.bidPxBtc + t.askPxBtc) / 2 : null;
  };
  const buyMid = mid(buy.inst.instId);
  const sellMid = mid(pick.inst.instId);
  const qty = input.contracts * ctValBtc;
  return {
    ok: true,
    side: input.side,
    contracts: input.contracts,
    ctValBtc,
    notionalUsdc,
    expiryMs,
    buyInstId: buy.inst.instId,
    sellInstId: pick.inst.instId,
    buyStrike: buy.inst.strike,
    sellStrike: pick.inst.strike,
    floorPct: round6(Math.abs(buy.inst.strike - input.spot) / input.spot),
    capPct: round6(Math.abs(pick.inst.strike - input.spot) / input.spot),
    buyPxBtc: buy.fill.avgPxBtc,
    sellPxBtc: pick.fill.avgPxBtc,
    buyTopPxBtc: buy.fill.topPxBtc,
    sellTopPxBtc: pick.fill.topPxBtc,
    buyMidPxBtc: buyMid,
    sellMidPxBtc: sellMid,
    grossCreditUsdc: pick.gross,
    venueFeeUsdc: pick.fee,
    netCreditUsdc: pick.net,
    midCreditUsdc: buyMid != null && sellMid != null ? round2((sellMid - buyMid) * qty * input.spot) : null,
    levelsUsed: { buy: buy.fill.levelsUsed, sell: pick.fill.levelsUsed },
    capExceedProb: pick.exceedProb,
    capRuleApplied: chosen?.decidedBy ?? "widest",
  };
};

/**
 * Every listed funding strike in the band at the expiry, nearest first: the
 * rungs of the cap-distance ladder. Calls above spot for a long, puts below
 * for a short.
 */
export const fundingStrikeLadder = (
  snap: OkxListedSnapshot,
  side: PerpSide,
  spot: number,
  maxCapPct: number,
  expiryMs = snap.expiryMs,
): OkxChainInstrument[] => {
  const sellType: "put" | "call" = side === "long" ? "call" : "put";
  const band = { minOtmPct: FUNDING_BAND.minOtmPct, maxOtmPct: Math.max(FUNDING_BAND.minOtmPct, maxCapPct) };
  return listedWingCandidates(snap.chain, expiryMs, sellType, spot, spot, band).sort(
    (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
  );
};

export interface AtmReference {
  /** the nearest-to-spot listed call's / put's top ask at the expiry, BTC per BTC; null when no ask */
  callAskPxBtc: number | null;
  putAskPxBtc: number | null;
  callInstId: string | null;
  putInstId: string | null;
  hoursToExpiry: number;
}

/**
 * What an at-the-money option costs right now at the expiry: the reference a
 * knock-out buyback is estimated from. When price reaches the cap the short
 * funding leg is at the money; buying it back costs roughly the ATM ask at
 * the remaining time, so each scan records the ATM ask it saw.
 */
export const atmReference = (snap: OkxListedSnapshot, spot: number, expiryMs = snap.expiryMs, nowMs = snap.atMs): AtmReference => {
  const pick = (optType: "put" | "call") => {
    const live = snap.chain.filter((c) => c.optType === optType && c.expiryMs === expiryMs && c.state === "live");
    live.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    for (const c of live) {
      const ask = snap.books[c.instId]?.asks[0]?.pxBtc;
      if (ask != null && ask > 0) return { instId: c.instId, ask };
    }
    return null;
  };
  const call = pick("call");
  const put = pick("put");
  return {
    callAskPxBtc: call?.ask ?? null,
    putAskPxBtc: put?.ask ?? null,
    callInstId: call?.instId ?? null,
    putInstId: put?.instId ?? null,
    hoursToExpiry: +Math.max(0, (expiryMs - nowMs) / 3_600_000).toFixed(2),
  };
};
