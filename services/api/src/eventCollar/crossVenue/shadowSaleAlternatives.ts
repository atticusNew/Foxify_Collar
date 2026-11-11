/**
 * OWN SALE AND BETTER BID, MEASURED ON EVERY RECORD LINE.
 *
 * The record writes a collar on each line. This module prices the same line two other ways, from
 * the books the scan already read at the same instant, and keeps the answer beside the collar:
 *
 *   own sale    the holder sells part of the position into their own venue's bids (betterBid.ts,
 *               quoteOwnSale), after that venue's taker fee, walked level by level;
 *   better bid  we bid for those contracts above their venue's bid and buy the other side on
 *               another venue (betterBid.ts, quoteBetterBid), tried on every other venue whose
 *               book for the other side was read, the best for the holder kept.
 *
 * HOW MUCH IS SOLD. As many contracts as the collar's hedge buys of the other side:
 * (floor + 100 - cap) x contracts / 100, rounded up to the hundredth. Then the holder's two
 * results differ by the same sum under either shape (the collar: (cap - floor) x contracts; the
 * sale: $1 on each contract kept), so the shapes are compared on one number, the floor: the
 * sale's cash against the collar's floor with its credit. The caps differ by the same amount, to
 * within the cent the rounding up of the size moves.
 *
 * NO EXTRA VENUE CALLS. The holder's venue's bid side is already in hand for a holder on Kalshi:
 * the scan reads the market's No side (kalshiLadder.getNoAsks, or the aggregator's copy of the
 * same book), and those No asks ARE the YES bids, price flipped and size carried. The venue's
 * best offer, which our bid has to rest under, is on the market snapshot the scan already holds.
 * The other side on each other venue is the book each hedge route and each reference was priced
 * from. A holder on another venue is refused, with the reason on the line: Novig and ProphetX
 * have no sell at all, so there is no own sale to measure; for a holder on Polymarket the scan
 * reads the other outcome's book only, and the holder's own outcome's bids would be one more
 * public book read per line, which this module does not make.
 *
 * Measured on the book at the moment of the quote. Simulated. Nothing is bought, sold or bid.
 */

import { quoteBetterBid, quoteOwnSale, type BetterBidInputs, type BetterBidQuote, type VenueFee } from "./betterBid";
import { polymarketTailCells, rulesFor, tableRules, tailProbabilities, TAIL_BRANCHES, type RuleCells, type SettlementVenue, type TailProbabilities } from "./hedgeRouting";
import { DEFAULT_PROPHETX_FEE_BPS } from "./prophetxOrders";
import type { CounterfactualInputs } from "./shadowCounterfactuals";
import type { ShadowPosition } from "./shadowLedger";
import { centsOf, centsUpOf, contractHundredths, floorTotalCents, type CrossQuoteResult, type PmBookLevel } from "./types";
import type { ReferenceBookId } from "./venueBooks";

/** The books the other side can be bought on: the two cross-venue hedge routes' own books, then each reference. Stable ledger keys. */
export type OtherBookKey = "polymarket" | "prophetx" | ReferenceBookId;

/** Which venue a book is, so two reads of one venue count once. Operator words; never printed on a public page. */
const VENUE_OF_BOOK: Record<OtherBookKey, string> = {
  polymarket: "polymarket",
  prophetx: "prophetx",
  partner_mm: "prophetx",
  aggregated_mm: "prophetx",
  signed_v3: "novig",
  aggregated_other: "aggregated_other",
  outcome_v1: "stx",
  long_short_v1: "polymarket_us",
};

export type ShadowOwnSale =
  | {
      ok: true;
      /** the walked proceeds, floored */
      grossCents: number;
      /** the venue's taker fee */
      feeCents: number;
      /** what reaches the holder now; also their result if the side loses */
      cashCents: number;
      /** their result if the side wins: the cash plus $1 on each contract kept */
      capCents: number;
      worstPriceMilli: number;
      /** everything the venue's bids held, milli-contracts */
      bookDepthMilli: number;
    }
  | { ok: false; refused: string };

/** The better bid against one other venue's book, or why there was none there. */
export type ShadowBetterBidOn =
  | {
      book: OtherBookKey;
      ok: true;
      bidMilli: number;
      /** what our bid buys, and what we buy of the other side, milli-contracts */
      boughtMilli: number;
      /** the holder's cash with our bid on the book, after their venue's fee */
      cashCents: number;
      /** that cash over the own sale's, same size, after fees on both */
      improvementCents: number;
      /** what we are left with if the holder's side loses, which is the figure the bid was set against */
      lockedCents: number;
      /** and if it wins: the same, except where the other venue takes its fee only when its contract wins */
      ifSideWinsCents: number;
      takeCents: number;
      tailChargeCents: number;
      residualCents: number;
      bidLimitedBy: "our_take" | "venue_offer";
      otherAvgPriceMilli: number;
      /** the loss if our bid is hit and the other side cannot be bought; null when the venue's bids under ours cannot take it back */
      oneLegLossCents: number | null;
    }
  | { book: OtherBookKey; ok: false; refused: string };

export interface ShadowSaleAlternatives {
  /** the venue the holder's position is on */
  holderVenue: SettlementVenue;
  /** that venue's best offer for the holder's side as the scan held it, cents; null when it showed none */
  holderAskCents: number | null;
  /** contracts sold, milli: as many as the line's collar hedges */
  soldMilli: number;
  ownSale: ShadowOwnSale;
  /** the best better bid for the holder across the other venues read, or why there is none */
  betterBid: (Extract<ShadowBetterBidOn, { ok: true }> | { ok: false; refused: string }) & {
    /** other venues whose book for the other side was read with offers on it */
    venuesPriced: number;
  };
  /** every other book tried, in the order tried */
  books: ShadowBetterBidOn[];
  /**
   * The same line with our resting bid on the holder's venue priced at no fee. The record prices
   * that bid at the venue's taker formula because the code has no maker schedule for it; this is
   * how much of the answer rides on that.
   */
  ifRestingBidFree?: { ok: true; book: OtherBookKey; improvementCents: number; lockedCents: number } | { ok: false; refused: string };
}

/** A venue no rule text has been read for: every cell unconfirmed, so the router prices each tail at its worst plausible reading. */
function unreadRules(league: string): RuleCells {
  const base = tableRules("polymarket", league);
  const out = {} as RuleCells;
  for (const b of TAIL_BRANCHES) out[b] = { ...base[b], confirmed: false, source: "", excerpt: "no rule text read for this venue" };
  return out;
}

interface OtherBook {
  key: OtherBookKey;
  asks: PmBookLevel[];
  fee: VenueFee;
  rules: RuleCells;
  minOrderMilli: number;
}

/** Every other venue's book for the other side that the scan already holds. */
function otherBooksOf(inputs: CounterfactualInputs, league: string): OtherBook[] {
  const out: OtherBook[] = [];
  const pm = inputs.books.pmNoBook;
  if (pm && inputs.pair) {
    out.push({
      key: "polymarket",
      asks: pm.asks,
      fee: { kind: "polymarket", feeBps: inputs.config.hedgeFeeBps, flatCents: inputs.config.hedgeFeeFlatCents },
      rules: rulesFor("polymarket", league, polymarketTailCells(inputs.pair.pm.description, `https://gamma-api.polymarket.com/events?slug=${inputs.pair.pm.eventSlug}`, inputs.now.toISOString())),
      minOrderMilli: Math.round(pm.minOrderSizeShares * 1000),
    });
  }
  const px = inputs.books.pxNoBook;
  if (px) {
    // raw venue prices: the fee on net gains is costed on the buy, as the hedge route costs it
    out.push({ key: "prophetx", asks: px.asks, fee: { kind: "prophetx", feeBps: inputs.prophetxFeeBps ?? DEFAULT_PROPHETX_FEE_BPS }, rules: rulesFor("prophetx", league), minOrderMilli: Math.round(px.minOrderSizeShares * 1000) });
  }
  for (const ref of inputs.books.references ?? []) {
    if (!ref.book) continue;
    const venue = VENUE_OF_BOOK[ref.id];
    out.push({
      key: ref.id,
      asks: ref.book.asks,
      // a reference's reader has the venue's fee inside every price; the one venue whose fee is not on the market cannot be priced
      fee: ref.id === "outcome_v1" ? { kind: "stx" } : { kind: "folded" },
      rules: venue === "novig" || venue === "prophetx" ? rulesFor(venue, league) : unreadRules(league),
      minOrderMilli: Math.round(ref.book.minOrderSizeShares * 1000),
    });
  }
  return out;
}

const bookedOn = (book: OtherBookKey, q: BetterBidQuote): Extract<ShadowBetterBidOn, { ok: true }> => ({
  book,
  ok: true,
  bidMilli: q.bidMilli,
  boughtMilli: q.us.boughtMilli,
  cashCents: q.holder.cashCents,
  improvementCents: q.holder.improvementCents,
  lockedCents: q.us.lockedCents,
  ifSideWinsCents: q.us.ifSideWinsCents,
  takeCents: q.us.takeCents,
  tailChargeCents: q.us.tailChargeCents,
  residualCents: q.us.residualCents,
  bidLimitedBy: q.us.bidLimitedBy,
  otherAvgPriceMilli: q.otherVenue.avgPriceMilli,
  oneLegLossCents: q.oneLeg.ok ? q.oneLeg.lossCents : null,
});

/**
 * The best for the holder: the most cash over the own sale. Where two books pay the holder the
 * same, the one that leaves us more (the cheaper other side); then the book tried first.
 */
function bestOf<T extends { ok: boolean }>(rows: T[], figures: (r: T) => { improvementCents: number; lockedCents: number }): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!r.ok) continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = figures(r);
    const b = figures(best);
    if (a.improvementCents > b.improvementCents || (a.improvementCents === b.improvementCents && a.lockedCents > b.lockedCents)) best = r;
  }
  return best;
}
const NO_FIGURES = { improvementCents: 0, lockedCents: 0 };

/**
 * The own sale and the better bid for one record line, from the books the line was quoted on.
 * `live` is the collar the record wrote; its floor and cap set how much is sold. Never throws: a
 * line whose books cannot be read as books says so (`measurement_failed`) and is counted as not
 * measured, so the record line and its other alternatives are written all the same.
 */
export function saleAlternativesFor(inputs: CounterfactualInputs, live: Extract<CrossQuoteResult, { ok: true }>): ShadowSaleAlternatives {
  try {
    return measure(inputs, live);
  } catch {
    const refused = "measurement_failed";
    return { holderVenue: inputs.settlement?.holderVenue ?? "kalshi", holderAskCents: null, soldMilli: 0, ownSale: { ok: false, refused }, betterBid: { ok: false, refused, venuesPriced: 0 }, books: [] };
  }
}

function measure(inputs: CounterfactualInputs, live: Extract<CrossQuoteResult, { ok: true }>): ShadowSaleAlternatives {
  const holderVenue: SettlementVenue = inputs.settlement?.holderVenue ?? "kalshi";
  const positionMilli = contractHundredths(inputs.contracts) * 10;
  const soldMilli = Math.min(positionMilli, centsUpOf(live.floorCents + 100 - live.capCents, inputs.contracts) * 10);
  const askCents = inputs.holderAskCents ?? inputs.pair?.kalshi.yesAskCents;
  const holderAskCents = typeof askCents === "number" && askCents > 0 && askCents < 100 ? askCents : null;
  const base = { holderVenue, holderAskCents, soldMilli };
  const neither = (refused: string): ShadowSaleAlternatives => ({ ...base, ownSale: { ok: false, refused }, betterBid: { ok: false, refused, venuesPriced: 0 }, books: [] });

  if (holderVenue === "novig" || holderVenue === "prophetx") return neither("holder_venue_cannot_sell");
  if (holderVenue !== "kalshi") return neither("holder_venue_bids_not_read");
  if (!inputs.books.noAsks) return neither("book_not_retained");

  // the market's No asks are its YES bids: a No bought at 100 - b is a YES sold at b, the same resting order
  const bids: PmBookLevel[] = inputs.books.noAsks.map((l) => ({ priceMilli: (100 - l.priceCents) * 10, sizeMilli: l.qtyMilli }));
  const holderFee: VenueFee = { kind: "kalshi" };
  const own = quoteOwnSale({ positionMilli, sellMilli: soldMilli, bids, fee: holderFee });
  const ownSale: ShadowOwnSale = own.ok
    ? { ok: true, grossCents: own.grossCents, feeCents: own.feeCents, cashCents: own.cashCents, capCents: own.capCents, worstPriceMilli: own.worstPriceMilli, bookDepthMilli: own.bookDepthMilli }
    : { ok: false, refused: own.code };
  if (!own.ok) return { ...base, ownSale, betterBid: { ok: false, refused: "own_sale_unpriced", venuesPriced: 0 }, books: [] };
  // a strike with no verified pair has no other venue: different settlement feeds, as the routes say
  if (!inputs.pair) return { ...base, ownSale, betterBid: { ok: false, refused: "no_other_venue", venuesPriced: 0 }, books: [] };

  const league = inputs.pair.league;
  const tail = {
    holderRules: inputs.settlement?.holderRules ?? rulesFor("kalshi", league),
    probabilities: (inputs.settlement?.probabilities ?? tailProbabilities(league)) as TailProbabilities,
    markCents: inputs.markCents,
  };
  const others = otherBooksOf(inputs, league);
  const quoteOn = (o: OtherBook, fee: VenueFee) => {
    const i: BetterBidInputs = {
      positionMilli,
      sellMilli: soldMilli,
      holderVenue: { bids, bestAskMilli: holderAskCents === null ? null : holderAskCents * 10, tickMilli: 10, fee },
      otherVenue: { asks: o.asks, fee: o.fee, minOrderMilli: o.minOrderMilli },
      tail: { ...tail, otherRules: o.rules },
      take: inputs.config,
    };
    return quoteBetterBid(i);
  };
  const quotes = others.map((o) => ({ o, q: quoteOn(o, holderFee) }));
  const books: ShadowBetterBidOn[] = quotes.map(({ o, q }) => (q.ok ? bookedOn(o.key, q) : { book: o.key, ok: false, refused: q.code }));
  const venuesPriced = new Set(quotes.filter(({ o, q }) => (q.ok || q.code !== "other_side_empty") && o.fee.kind !== "stx").map(({ o }) => VENUE_OF_BOOK[o.key])).size;
  const best = bestOf(books, (b) => (b.ok ? b : NO_FIGURES)) as Extract<ShadowBetterBidOn, { ok: true }> | null;

  const free = others.map((o) => ({ o, q: quoteOn(o, { kind: "kalshi", restingBid: "free" }) }));
  const bestFree = bestOf(free.map(({ o, q }) => ({ ok: q.ok, o, q })), (r) => (r.q.ok ? { improvementCents: r.q.holder.improvementCents, lockedCents: r.q.us.lockedCents } : NO_FIGURES));
  const ifRestingBidFree: ShadowSaleAlternatives["ifRestingBidFree"] =
    bestFree && bestFree.q.ok
      ? { ok: true, book: bestFree.o.key, improvementCents: bestFree.q.holder.improvementCents, lockedCents: bestFree.q.us.lockedCents }
      : { ok: false, refused: venuesPriced === 0 ? "no_other_book_read" : "no_venue_improves" };

  return {
    ...base,
    ownSale,
    betterBid: best ? { ...best, venuesPriced } : { ok: false, refused: venuesPriced === 0 ? "no_other_book_read" : "no_venue_improves", venuesPriced },
    books,
    ifRestingBidFree,
  };
}

// ---------------------------------------------------------------------------
// the record, summed
// ---------------------------------------------------------------------------

export interface ShadowSaleSummary {
  /** the first line that carries the measurement; null when none does yet */
  recordedSince: string | null;
  /** record lines that carry it (voided lines left out) */
  lines: number;
  ownSale: {
    priced: number;
    unpriced: number;
    /** 100c x contracts over the priced lines */
    stakeCents: number;
    /** the sale's cash less the collar's floor (credit in), summed over the priced lines; positive, the sale paid the holder more on either result */
    vsCollarTotalCents: number;
    vsCollarMedianCents: number | null;
    vsCollarTotalBpsOfStake: number | null;
    vsCollarMedianBpsOfStake: number | null;
    /** lines where the sale's cash beat the collar's floor, fell short of it, matched it */
    ahead: number;
    behind: number;
    level: number;
    /** settled lines marked at the official result: what the sale, the collar and holding untouched each paid the holder */
    settled: { lines: number; ownSaleCents: number; collarCents: number; untouchedCents: number };
  };
  betterBid: {
    /** lines where at least one other venue's book for the other side was read with offers on it */
    compared: number;
    /** lines where a better bid existed */
    existed: number;
    /** the most other venues compared on any one line */
    mostVenues: number;
    /** 100c x contracts over the lines where one existed */
    stakeCents: number;
    improvementTotalCents: number;
    improvementMedianCents: number | null;
    improvementTotalBpsOfStake: number | null;
    improvementMedianBpsOfStake: number | null;
    /** our side over those lines: what we would be left with, and what it is made of */
    lockedCents: number;
    takeCents: number;
    tailChargeCents: number;
    residualCents: number;
    /** lines where the bid stopped at the venue's own offer rather than at our take */
    limitedByVenueOffer: number;
    /** why there was none, where there was none */
    refusals: Record<string, number>;
    /** per book tried: how often it priced a better bid, how often it was the best. Operator only: the keys name routes */
    byBook: Record<string, { tried: number; quoted: number; best: number }>;
    /** the one-leg loss on the lines where one existed: how many could be sold back, the sum and the worst */
    oneLeg: { priced: number; unbounded: number; totalCents: number; worstCents: number };
    /** the same lines with our resting bid priced at no fee */
    ifRestingBidFree: { existed: number; improvementTotalCents: number };
    /** settled lines marked at the official result: what we would have been left with */
    settled: { lines: number; usCents: number };
  };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  // an even count: the mean of the two middle values, rounded down so a typical figure is never overstated
  return s.length % 2 === 1 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2);
};
const bpsOf = (cents: number, stakeCents: number): number | null => (stakeCents > 0 ? Math.floor((cents * 10_000) / stakeCents) : null);

/** Lines without the measurement (every line opened before it existed) are left out, not counted as refusals. */
export function summarizeSaleAlternatives(positions: readonly ShadowPosition[]): ShadowSaleSummary {
  const lines = positions.filter((p) => p.counterfactuals?.sale && p.status !== "void");
  const out: ShadowSaleSummary = {
    recordedSince: null,
    lines: lines.length,
    ownSale: { priced: 0, unpriced: 0, stakeCents: 0, vsCollarTotalCents: 0, vsCollarMedianCents: null, vsCollarTotalBpsOfStake: null, vsCollarMedianBpsOfStake: null, ahead: 0, behind: 0, level: 0, settled: { lines: 0, ownSaleCents: 0, collarCents: 0, untouchedCents: 0 } },
    betterBid: {
      compared: 0,
      existed: 0,
      mostVenues: 0,
      stakeCents: 0,
      improvementTotalCents: 0,
      improvementMedianCents: null,
      improvementTotalBpsOfStake: null,
      improvementMedianBpsOfStake: null,
      lockedCents: 0,
      takeCents: 0,
      tailChargeCents: 0,
      residualCents: 0,
      limitedByVenueOffer: 0,
      refusals: {},
      byBook: {},
      oneLeg: { priced: 0, unbounded: 0, totalCents: 0, worstCents: 0 },
      ifRestingBidFree: { existed: 0, improvementTotalCents: 0 },
      settled: { lines: 0, usCents: 0 },
    },
  };
  const vsCollar: number[] = [];
  const vsCollarBps: number[] = [];
  const improvements: number[] = [];
  const improvementBps: number[] = [];
  for (const p of lines) {
    const s = p.counterfactuals?.sale as ShadowSaleAlternatives;
    if (out.recordedSince === null || p.at < out.recordedSince) out.recordedSince = p.at;
    const stake = centsOf(100, p.contracts);
    const result = p.status === "settled" ? p.result : undefined;

    if (s.ownSale.ok) {
      const diff = s.ownSale.cashCents - floorTotalCents(p);
      out.ownSale.priced += 1;
      out.ownSale.stakeCents += stake;
      out.ownSale.vsCollarTotalCents += diff;
      vsCollar.push(diff);
      const bps = bpsOf(diff, stake);
      if (bps !== null) vsCollarBps.push(bps);
      if (diff > 0) out.ownSale.ahead += 1;
      else if (diff < 0) out.ownSale.behind += 1;
      else out.ownSale.level += 1;
      if (result) {
        out.ownSale.settled.lines += 1;
        out.ownSale.settled.ownSaleCents += result === "yes" ? s.ownSale.capCents : s.ownSale.cashCents;
        out.ownSale.settled.collarCents += p.protectedCents ?? 0;
        out.ownSale.settled.untouchedCents += p.nakedCents ?? 0;
      }
    } else {
      out.ownSale.unpriced += 1;
    }

    const b = s.betterBid;
    if (b.venuesPriced > 0) out.betterBid.compared += 1;
    out.betterBid.mostVenues = Math.max(out.betterBid.mostVenues, b.venuesPriced);
    for (const row of s.books) {
      const book = (out.betterBid.byBook[row.book] ??= { tried: 0, quoted: 0, best: 0 });
      book.tried += 1;
      if (row.ok) book.quoted += 1;
    }
    if (b.ok) {
      out.betterBid.existed += 1;
      out.betterBid.byBook[b.book].best += 1;
      out.betterBid.stakeCents += stake;
      out.betterBid.improvementTotalCents += b.improvementCents;
      improvements.push(b.improvementCents);
      const bps = bpsOf(b.improvementCents, stake);
      if (bps !== null) improvementBps.push(bps);
      out.betterBid.lockedCents += b.lockedCents;
      out.betterBid.takeCents += b.takeCents;
      out.betterBid.tailChargeCents += b.tailChargeCents;
      out.betterBid.residualCents += b.residualCents;
      if (b.bidLimitedBy === "venue_offer") out.betterBid.limitedByVenueOffer += 1;
      if (b.oneLegLossCents === null) out.betterBid.oneLeg.unbounded += 1;
      else {
        out.betterBid.oneLeg.priced += 1;
        out.betterBid.oneLeg.totalCents += b.oneLegLossCents;
        out.betterBid.oneLeg.worstCents = Math.max(out.betterBid.oneLeg.worstCents, b.oneLegLossCents);
      }
      if (result) {
        out.betterBid.settled.lines += 1;
        out.betterBid.settled.usCents += result === "yes" ? b.ifSideWinsCents : b.lockedCents;
      }
    } else {
      out.betterBid.refusals[b.refused] = (out.betterBid.refusals[b.refused] ?? 0) + 1;
    }
    if (s.ifRestingBidFree?.ok) {
      out.betterBid.ifRestingBidFree.existed += 1;
      out.betterBid.ifRestingBidFree.improvementTotalCents += s.ifRestingBidFree.improvementCents;
    }
  }
  out.ownSale.vsCollarMedianCents = median(vsCollar);
  out.ownSale.vsCollarMedianBpsOfStake = median(vsCollarBps);
  out.ownSale.vsCollarTotalBpsOfStake = bpsOf(out.ownSale.vsCollarTotalCents, out.ownSale.stakeCents);
  out.betterBid.improvementMedianCents = median(improvements);
  out.betterBid.improvementMedianBpsOfStake = median(improvementBps);
  out.betterBid.improvementTotalBpsOfStake = bpsOf(out.betterBid.improvementTotalCents, out.betterBid.stakeCents);
  return out;
}
