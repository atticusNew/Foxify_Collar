/**
 * Early close at live prices: the user leaves a protected position before the
 * event locks. Terms were locked at the tap and the other side was bought in
 * the same second, so leaving is a NEW TRADE priced from the live books, never
 * a reversal:
 *
 *   - the user sells their N Yes contracts into the venue's yes bids;
 *   - we sell the hedge (H No units) into its venue's No bids;
 *   - the protection contract is settled at what those two sales fetched.
 *
 * Leg for leg, the writer's result on a close does not depend on the mark:
 * the writer keeps exactly the published take, and the user bears the cost of
 * crossing both books (the honest price of leaving early). The identity:
 *
 *   protectedAtClose = positionProceeds + hedgeProceeds - funding + credit
 *
 * which at a frictionless mark m collapses to the reshape the card shows,
 * kept x m + floor x N + credit, where kept = N (cap - floor) / 100. The gap
 * between that frictionless number and the walked one is the unwind friction,
 * recorded so the record can show what leaving cost against mids.
 *
 * Which positions the shadow closes early, and when, is decided by a hash of
 * the ticker so the schedule is replayable without state. Pure functions over
 * books the caller fetched; this module makes no venue calls except the one
 * read-only orderbook fetch exported for the worker.
 */

import { dollarsToCents, fetchJsonWithRetry, kalshiBase } from "../kalshiPublic";
import { kalshiTakerFeeCents } from "./kalshiLadder";
import { decimalToMilli } from "./polymarketPublic";
import type { HedgeRoute, PmBook, PmBookLevel } from "./types";
import { centsDownOf, centsOf, contractHundredths } from "./types";

/** One resting bid on a Kalshi side: what a sell fetches at this level. */
export interface KalshiBidLevel {
  priceCents: number;
  qtyMilli: number; // 1000 = 1 contract, truncated down (against the depth we trust)
}

/** Both sides of a Kalshi book as resting bids, best (highest) first. */
export interface KalshiBookSides {
  yesBids: KalshiBidLevel[];
  noBids: KalshiBidLevel[];
}

/**
 * Parse a raw orderbook response into yes bids and no bids. Supports the
 * fixed-point shape ({ orderbook_fp: { yes_dollars, no_dollars } }) and the
 * integer-cents shape ({ orderbook: { yes, no } }).
 */
export function parseKalshiBookSides(raw: Record<string, unknown>): KalshiBookSides {
  const fp = raw.orderbook_fp as Record<string, unknown> | undefined;
  const legacy = raw.orderbook as Record<string, unknown> | undefined;
  const side = (fpKey: string, legacyKey: string): KalshiBidLevel[] => {
    const out: KalshiBidLevel[] = [];
    if (fp && Array.isArray(fp[fpKey])) {
      for (const lvl of fp[fpKey] as Array<[string, string]>) {
        const priceCents = dollarsToCents(lvl?.[0]);
        const qtyMilli = decimalToMilli(lvl?.[1], false);
        if (priceCents > 0 && priceCents < 100 && qtyMilli > 0) out.push({ priceCents, qtyMilli });
      }
    } else if (legacy && Array.isArray(legacy[legacyKey])) {
      for (const lvl of legacy[legacyKey] as Array<[number, number]>) {
        const priceCents = Number(lvl?.[0]);
        const qty = Number(lvl?.[1]);
        if (Number.isInteger(priceCents) && priceCents > 0 && priceCents < 100 && qty > 0) {
          out.push({ priceCents, qtyMilli: Math.floor(qty * 1000) });
        }
      }
    }
    return out.sort((a, b) => b.priceCents - a.priceCents);
  };
  return { yesBids: side("yes_dollars", "yes"), noBids: side("no_dollars", "no") };
}

/** Live book, both sides, for one market. Read-only public endpoint. */
export async function getKalshiBookSides(ticker: string, fetchImpl: typeof fetch = fetch): Promise<KalshiBookSides> {
  const url = `${kalshiBase()}/markets/${encodeURIComponent(ticker)}/orderbook`;
  const data = (await fetchJsonWithRetry(url, fetchImpl)) as Record<string, unknown>;
  return parseKalshiBookSides(data);
}

/**
 * Sell qtyMilli into Kalshi bids, best first. Proceeds are exact milli cents
 * converted once to cents rounded DOWN (against the seller); the taker fee is
 * exact on each fill. Null when the visible depth cannot absorb the size.
 */
export function walkKalshiBids(
  levels: KalshiBidLevel[],
  qtyMilli: number,
): { proceedsCents: number; feeCents: number; avgPriceCents: number; worstPriceCents: number } | null {
  if (qtyMilli <= 0) return null;
  let remaining = qtyMilli;
  let proceedsMilliCents = 0;
  let feeCents = 0;
  let worst = 0;
  for (const lvl of levels) {
    if (lvl.priceCents <= 0 || lvl.qtyMilli <= 0) continue;
    const take = Math.min(remaining, lvl.qtyMilli);
    proceedsMilliCents += take * lvl.priceCents;
    feeCents += kalshiTakerFeeCents(take, lvl.priceCents);
    worst = lvl.priceCents;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null;
  return {
    proceedsCents: Math.floor(proceedsMilliCents / 1000),
    feeCents,
    avgPriceCents: Math.floor(proceedsMilliCents / qtyMilli),
    worstPriceCents: worst,
  };
}

/**
 * Sell sharesMilli into Polymarket bids, best first. Exact micro dollars,
 * converted once to cents rounded DOWN. Null when the book cannot absorb it.
 */
export function walkPmBids(
  bids: PmBookLevel[],
  sharesMilli: number,
): { proceedsCents: number; avgPriceMilli: number; worstPriceMilli: number } | null {
  if (sharesMilli <= 0) return null;
  let remaining = sharesMilli;
  let proceedsMicroUsd = 0;
  let worst = 0;
  for (const lvl of bids) {
    if (lvl.priceMilli <= 0 || lvl.sizeMilli <= 0) continue;
    const take = Math.min(remaining, lvl.sizeMilli);
    proceedsMicroUsd += take * lvl.priceMilli;
    worst = lvl.priceMilli;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return null;
  return {
    proceedsCents: Math.floor(proceedsMicroUsd / 10_000),
    avgPriceMilli: Math.floor(proceedsMicroUsd / sharesMilli),
    worstPriceMilli: worst,
  };
}

/** The locked terms an early close prices against. */
export interface EarlyCloseTerms {
  contracts: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  takeCents: number;
  /** NO units the hedge bought, milli (1000 = one $1-paying unit) */
  hedgeUnitsMilli: number;
  route: HedgeRoute;
  /** the ProphetX strike the hedge holds, when the route is ProphetX */
  hedgeStrikeId?: string;
}

export interface EarlyCloseBooks {
  /** the protected market, both sides */
  kalshi: KalshiBookSides;
  /** the hedge token's book when the route is cross-venue; absent when it could not be located */
  pmNoBook?: PmBook;
  /**
   * The hedge strike's book when the route is ProphetX, the settlement fee already folded in
   * (prophetxOrders.foldProphetXFee) as it was at the lock; absent when it could not be read.
   */
  pxNoBook?: PmBook;
}

export interface EarlyCloseQuote {
  ok: true;
  /** average fill selling the user's Yes contracts, cents */
  yesFillCents: number;
  /** the protected market's live mid, cents (null when one side is empty) */
  yesMidCents: number | null;
  /** the user's own sale: N Yes into the yes bids, after the venue's taker fee */
  positionProceedsCents: number;
  positionFeesCents: number;
  /** our sale: H No into the hedge venue's bids, after fees */
  hedgeProceedsCents: number;
  hedgeFeesCents: number;
  /** the cap slice the user sold at the tap, (100 - cap) x N */
  fundingCents: number;
  /** what the user walks away with, the credit paid at the tap included */
  protectedAtCloseCents: number;
  /** the same sale with no protection ever bought: N Yes into the bids, after fees */
  nakedAtCloseCents: number;
  /** the frictionless reference at the live mid: kept x mid + floor x N + credit (null without a mid) */
  protectedAtMidCents: number | null;
  /** protectedAtMid minus protectedAtClose: what crossing both books cost the user (null without a mid) */
  unwindFrictionCents: number | null;
  /** the writer's result on this position: the published take, by construction */
  writerCents: number;
  /**
   * The hedge sale as walked, for the order that sends it (hedgeExecutor's sell intent). On Kalshi:
   * the No bids' top, average and worst level taken, cents, gross before fees. On ProphetX: the
   * hedge strike's fee-folded bids in milli, and the strike id; the order that realises it is a BUY
   * of the holder's side's strike at 1 - the worst bid, which settles against the hedge at the game
   * (the proceeds land then, not today). Absent when the hedge is on Polymarket (recorded, not sent).
   */
  hedgeSale?: HedgeSale;
}

export type HedgeSale =
  | { venue: "kalshi"; bestPriceCents: number; avgPriceCents: number; worstPriceCents: number; grossCents: number }
  | { venue: "prophetx"; strikeId: string; bestPriceMilli: number; avgPriceMilli: number; worstPriceMilli: number; grossCents: number; settlesAtGame: true };

export type EarlyCloseLeg = "position" | "hedge";
export type EarlyCloseRefusalCode = "book_empty" | "book_too_thin" | "hedge_unlocatable";

export interface EarlyCloseRefusal {
  ok: false;
  leg: EarlyCloseLeg;
  code: EarlyCloseRefusalCode;
  detail: string;
}

export type EarlyCloseResult = EarlyCloseQuote | EarlyCloseRefusal;

/** Live yes mid from both sides: (best yes bid + (100 - best no bid)) / 2, in half cents x 2 for exactness. */
function yesMidTwiceCents(k: KalshiBookSides): number | null {
  const yb = k.yesBids[0]?.priceCents;
  const nb = k.noBids[0]?.priceCents;
  if (yb === undefined || nb === undefined) return null;
  return yb + (100 - nb);
}

/** Price the close from the books the caller fetched. */
export function quoteEarlyClose(terms: EarlyCloseTerms, books: EarlyCloseBooks): EarlyCloseResult {
  const n = terms.contracts;
  // the size in hundredths of a contract: 15.95 contracts is 1,595 hundredths, 15,950 milli
  const nH = contractHundredths(n);
  if (books.kalshi.yesBids.length === 0) {
    return { ok: false, leg: "position", code: "book_empty", detail: "no resting yes bids on the protected market" };
  }
  const pos = walkKalshiBids(books.kalshi.yesBids, nH * 10);
  if (!pos) {
    return { ok: false, leg: "position", code: "book_too_thin", detail: `the yes bids cannot absorb ${n} contracts right now` };
  }

  let hedgeProceedsCents: number;
  let hedgeFeesCents: number;
  let hedgeSale: EarlyCloseQuote["hedgeSale"];
  if (terms.route === "kalshi_self") {
    if (books.kalshi.noBids.length === 0) {
      return { ok: false, leg: "hedge", code: "book_empty", detail: "no resting No bids to sell the hedge into" };
    }
    const h = walkKalshiBids(books.kalshi.noBids, terms.hedgeUnitsMilli);
    if (!h) {
      return { ok: false, leg: "hedge", code: "book_too_thin", detail: "the No bids cannot absorb the hedge right now" };
    }
    hedgeProceedsCents = h.proceedsCents;
    hedgeFeesCents = h.feeCents;
    hedgeSale = { venue: "kalshi", bestPriceCents: books.kalshi.noBids[0].priceCents, avgPriceCents: h.avgPriceCents, worstPriceCents: h.worstPriceCents, grossCents: h.proceedsCents };
  } else if (terms.route === "prophetx") {
    // the bids carry the settlement fee already (folded at the read), so the walk is the net
    if (!books.pxNoBook || !terms.hedgeStrikeId) {
      return { ok: false, leg: "hedge", code: "hedge_unlocatable", detail: books.pxNoBook ? "the hedge strike for this position is not on record" : "the hedge strike's book could not be read through the aggregator" };
    }
    if (books.pxNoBook.bids.length === 0) {
      return { ok: false, leg: "hedge", code: "book_empty", detail: "no resting bids on the hedge strike" };
    }
    const h = walkPmBids(books.pxNoBook.bids, terms.hedgeUnitsMilli);
    if (!h) {
      return { ok: false, leg: "hedge", code: "book_too_thin", detail: "the hedge strike's bids cannot absorb the hedge right now" };
    }
    hedgeProceedsCents = h.proceedsCents;
    hedgeFeesCents = 0; // the venue's settlement fee is inside the folded bids
    hedgeSale = { venue: "prophetx", strikeId: terms.hedgeStrikeId, bestPriceMilli: books.pxNoBook.bids[0].priceMilli, avgPriceMilli: h.avgPriceMilli, worstPriceMilli: h.worstPriceMilli, grossCents: h.proceedsCents, settlesAtGame: true };
  } else {
    if (!books.pmNoBook) {
      return { ok: false, leg: "hedge", code: "hedge_unlocatable", detail: "the hedge token for this position is not on record" };
    }
    if (books.pmNoBook.bids.length === 0) {
      return { ok: false, leg: "hedge", code: "book_empty", detail: "no resting bids on the hedge token" };
    }
    const h = walkPmBids(books.pmNoBook.bids, terms.hedgeUnitsMilli);
    if (!h) {
      return { ok: false, leg: "hedge", code: "book_too_thin", detail: "the hedge token's bids cannot absorb the hedge right now" };
    }
    hedgeProceedsCents = h.proceedsCents;
    hedgeFeesCents = 0; // Polymarket taker fee is 0 today
  }

  // the same rounding the tap used (types.ts): funding down, the floor line half up
  const fundingCents = centsDownOf(100 - terms.capCents, n);
  const positionProceedsCents = pos.proceedsCents - pos.feeCents;
  const hedgeNetCents = hedgeProceedsCents - hedgeFeesCents;
  const protectedAtCloseCents = positionProceedsCents + hedgeNetCents - fundingCents + terms.creditCents;

  const midTwice = yesMidTwiceCents(books.kalshi);
  // kept x mid in cents: kept = N (cap - floor) / 100 contracts, mid = midTwice / 2 cents, N = nH / 100;
  // one rounding at the end, exact in integers before it
  const protectedAtMidCents =
    midTwice === null ? null : Math.round((nH * (terms.capCents - terms.floorCents) * midTwice) / 20_000) + centsOf(terms.floorCents, n) + terms.creditCents;

  return {
    ok: true,
    yesFillCents: pos.avgPriceCents,
    yesMidCents: midTwice === null ? null : Math.round(midTwice / 2),
    positionProceedsCents,
    positionFeesCents: pos.feeCents,
    hedgeProceedsCents: hedgeNetCents,
    hedgeFeesCents,
    fundingCents,
    protectedAtCloseCents,
    nakedAtCloseCents: positionProceedsCents,
    protectedAtMidCents,
    unwindFrictionCents: protectedAtMidCents === null ? null : protectedAtMidCents - protectedAtCloseCents,
    writerCents: terms.takeCents,
    ...(hedgeSale ? { hedgeSale } : {}),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* scheduling                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** FNV-1a 32-bit over the ticker: a stable per-position draw with no state to keep. */
export function tickerHash(ticker: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < ticker.length; i += 1) {
    h ^= ticker.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface EarlyCloseScheduleRule {
  /** share of positions that leave before the lock, percent of the book (0 disables) */
  sharePct: number;
  /** the close never lands inside this margin before the lock (the pricers refuse there anyway) */
  marginMs: number;
}

export const DEFAULT_EARLY_CLOSE_RULE: EarlyCloseScheduleRule = { sharePct: 20, marginMs: 15 * 60_000 };

export function earlyCloseRuleFromEnv(env: NodeJS.ProcessEnv): EarlyCloseScheduleRule {
  const share = Number(env.EVENT_SHADOW_EARLY_CLOSE_SHARE_PCT ?? DEFAULT_EARLY_CLOSE_RULE.sharePct);
  const margin = Number(env.EVENT_SHADOW_EARLY_CLOSE_MARGIN_MS ?? DEFAULT_EARLY_CLOSE_RULE.marginMs);
  return {
    sharePct: Number.isFinite(share) ? Math.min(100, Math.max(0, share)) : DEFAULT_EARLY_CLOSE_RULE.sharePct,
    marginMs: Number.isFinite(margin) && margin >= 0 ? margin : DEFAULT_EARLY_CLOSE_RULE.marginMs,
  };
}

/**
 * Whether this position leaves early, and when. Selected positions close at a
 * point between 15% and 85% of the way from the open to the lock margin; the
 * draw is the ticker hash so a restart replays the same schedule.
 */
export function earlyCloseSchedule(
  ticker: string,
  openedAtIso: string,
  lockIso: string,
  rule: EarlyCloseScheduleRule,
): { selected: boolean; closeAtMs: number | null } {
  if (rule.sharePct <= 0) return { selected: false, closeAtMs: null };
  const h = tickerHash(ticker);
  if (h % 100 >= rule.sharePct) return { selected: false, closeAtMs: null };
  const openMs = Date.parse(openedAtIso);
  const lastMs = Date.parse(lockIso) - rule.marginMs;
  if (!Number.isFinite(openMs) || !Number.isFinite(lastMs) || lastMs <= openMs) return { selected: false, closeAtMs: null };
  const u = ((h >>> 8) % 1000) / 1000; // 0 .. 0.999
  const frac = 0.15 + 0.7 * u;
  return { selected: true, closeAtMs: Math.round(openMs + frac * (lastMs - openMs)) };
}
