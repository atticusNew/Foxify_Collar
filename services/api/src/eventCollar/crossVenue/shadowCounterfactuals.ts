/**
 * Shadow counterfactuals — what each proposed rule would have done, recorded
 * at the moment the live quote was.
 *
 * The shadow run opens one simulated position per market at its live terms.
 * That is the baseline. To evaluate a change (a different tier, a different
 * fee rule, a bigger size) honestly, the same books at the same instant are
 * re-priced under the alternative and the result is written next to the
 * baseline in the same ledger record. No extra venue calls; the books the
 * scanner already fetched are reused. When the market settles, every
 * alternative is marked against the same official result, so the comparison
 * is between rules, not between market conditions.
 *
 * Pure: takes books and terms, returns numbers. Nothing here trades.
 */

import { computeTake, evCostBps } from "./collarSearch";
import { quoteCrossWrap } from "./crossVenuePricer";
import { quoteLadderWrap, type NoAskLevel } from "./kalshiLadder";
import type {
  CollarTerms,
  CrossQuoteResult,
  CrossSearchConfig,
  HedgeRoute,
  MatchedPair,
  PmBook,
  ProtectionTier,
  TakeRule,
} from "./types";
import { PROTECTION_TIERS } from "./types";
import type { ReferenceBook, ReferenceBookId, ReferenceListing } from "./venueBooks";
import type { ReferencePrint, ReferencePrintId } from "./venuePrints";

/** One alternative collar as it would have been written, or why it was not. */
export type ShadowAltTerms =
  | {
      ok: true;
      floorCents: number;
      capCents: number;
      creditCents: number;
      grossCreditCents: number;
      takeCents: number;
      takeRule: TakeRule;
      feesCents: number;
      /** venue fees included */
      hedgeCostCents: number;
      hedgeUnitsMilli: number;
      evCostBps: number;
    }
  | { ok: false; refused: string };

/** Fee rules the shadow compares. Labels are stable ledger keys. */
export const FEE_RULE_LABELS = ["share_only", "min_25bps"] as const;
export type FeeRuleLabel = (typeof FEE_RULE_LABELS)[number];
const FEE_RULES: Record<FeeRuleLabel, Partial<CrossSearchConfig>> = {
  share_only: { minTakeBpsOfStake: 0 },
  min_25bps: { minTakeBpsOfStake: 25 },
};

/** Size multiples probed for the capacity curve (1x is the live position itself). */
export const SIZE_LADDER_MULTS = [1, 5, 20] as const;

export interface ShadowSizeProbe {
  mult: number;
  contracts: number;
  terms: ShadowAltTerms;
}

/** The hedge routes the scan examines; the record writes the cheaper one. */
export const ROUTE_LABELS = ["kalshi_self", "polymarket"] as const satisfies readonly HedgeRoute[];

/**
 * REFERENCE. The default tier re-priced on another regulated exchange's book for the same game,
 * from the same instant, at the live size. Nothing is filled there; the number says what a hedge
 * there would have cost, which is the measurement that decides whether to onboard the venue.
 */
export interface ShadowReferenceQuote {
  id: ReferenceBookId;
  terms: ShadowAltTerms;
  /** the venue's best ask on the opposing outcome, fees folded, milli dollars; null when no book */
  bestAskMilli: number | null;
  /** every visible ask's size summed, milli shares (what the venue would fill at any price) */
  depthMilli: number;
  /** the venue's snapshot age when read, whole seconds; absent when the venue did not stamp it */
  ageSec?: number;
  /** the listing the book (or its absence) was read from: ids to quote back to the feed or the venue; absent when the read never reached one */
  listing?: ReferenceListing;
}

/**
 * REFERENCE PRINT. A regulated exchange that publishes only yesterday's tape: the opposing
 * outcome's last print there, with its size and age, beside the price the live hedge paid per $1
 * of payout. Not priced as a route: a day-old print is nothing a hedge could have been filled at,
 * so the gap is a sign of where that venue trades, never a quote.
 */
export type ShadowReferencePrint =
  | {
      id: ReferencePrintId;
      ok: true;
      reportDate: string;
      printedAtIso: string;
      /** hours from the last print to the quote, one decimal */
      ageHours: number;
      lastPriceCents: number;
      vwapCents: number;
      dayContracts: number;
      prints: number;
      /** what the live hedge paid per $1 of payout on the route written, cents (walked average, venue fees apart) */
      liveHedgeAvgCents: number;
      /** last print minus the live hedge's average price, cents: positive, the venue last traded richer */
      gapCents: number;
    }
  | { id: ReferencePrintId; ok: false; reason: string };

export interface ShadowCounterfactuals {
  /** every distinct tier the venues funded at open, keyed by tier name */
  alternatives: Partial<Record<ProtectionTier, ShadowAltTerms>>;
  /** the default tier re-priced under each fee rule */
  feeRules: Record<FeeRuleLabel, ShadowAltTerms>;
  /** the default tier re-priced at larger sizes on the same route and books */
  sizeLadder: ShadowSizeProbe[];
  /**
   * ROUTING. The default tier on EACH hedge route from the same books at the same instant: the
   * route the record wrote (its live terms) and the other one re-priced. Answers "what would
   * protection cost if the hedge had to run on the market's own No side" with the record's own
   * positions, before any routing policy changes. Absent on records opened before this existed.
   */
  routes?: Record<HedgeRoute, ShadowAltTerms>;
  /**
   * Other regulated exchanges' books for the same game, each priced like a hedge route and kept
   * beside the routes. One entry per venue the service was configured to read, listed or not.
   * Absent on records opened before a reference was configured.
   */
  references?: ShadowReferenceQuote[];
  /**
   * Exchanges that publish only yesterday's tape: the opposing outcome's last print there beside
   * the price the live hedge paid. One entry per print source configured, printed or not. Absent
   * on records opened before one was configured.
   */
  prints?: ShadowReferencePrint[];
}

export interface CounterfactualInputs {
  route: HedgeRoute;
  ticker: string;
  /** when protection locks: game start (sports) or market close (crypto), ISO */
  lockTimeIso: string;
  /** the verified cross-venue pair; required for the polymarket route, null for crypto */
  pair: MatchedPair | null;
  markCents: number;
  entryCents: number;
  contracts: number;
  now: Date;
  config: CrossSearchConfig;
  books: { pmNoBook?: PmBook; noAsks?: NoAskLevel[]; references?: ReferenceBook[]; prints?: ReferencePrint[] };
}

export function hedgeUnitsOfTerms(t: CollarTerms): number {
  return t.hedge.venue === "kalshi" ? t.hedge.contractsMilli : t.hedge.sharesMilli;
}

export function altFromTerms(t: CollarTerms): ShadowAltTerms {
  return {
    ok: true,
    floorCents: t.floorCents,
    capCents: t.capCents,
    creditCents: t.creditCents,
    grossCreditCents: t.grossCreditCents,
    takeCents: t.takeCents,
    takeRule: t.takeRule,
    feesCents: t.feesCents,
    hedgeCostCents: t.hedge.costCents + t.feesCents,
    hedgeUnitsMilli: hedgeUnitsOfTerms(t),
    evCostBps: t.evCostBps,
  };
}

function altFromQuote(q: CrossQuoteResult): ShadowAltTerms {
  return q.ok ? altFromTerms(q) : { ok: false, refused: q.code };
}

/** Re-quote on the recorded route with the given config and size. Null when that route's book was not kept. */
export function requote(inputs: CounterfactualInputs, config: CrossSearchConfig, contracts: number): CrossQuoteResult | null {
  const base = { markCents: inputs.markCents, entryCents: inputs.entryCents, contracts, now: inputs.now, config };
  if (inputs.route === "polymarket") {
    if (!inputs.books.pmNoBook || !inputs.pair) return null;
    return quoteCrossWrap({ ...base, pair: inputs.pair, noBook: inputs.books.pmNoBook });
  }
  if (!inputs.books.noAsks) return null;
  return quoteLadderWrap({
    ...base,
    pair: {
      kalshi: { ticker: inputs.ticker },
      gameStartTime: inputs.lockTimeIso,
      ...(inputs.pair ? { pm: { eventSlug: inputs.pair.pm.eventSlug } } : {}),
    },
    noAsks: inputs.books.noAsks,
  });
}

const UNAVAILABLE: ShadowAltTerms = { ok: false, refused: "book_not_retained" };

/**
 * Everything the report needs, from one live quote's books. `live` is the
 * quote actually recorded; its tiers are the alternatives (no re-pricing
 * needed for those, they came from the same search).
 */
export function counterfactualsFor(
  inputs: CounterfactualInputs,
  live: Extract<CrossQuoteResult, { ok: true }>,
): ShadowCounterfactuals {
  const alternatives: Partial<Record<ProtectionTier, ShadowAltTerms>> = {};
  for (const tier of PROTECTION_TIERS) {
    const t = live.tiers[tier];
    if (t) alternatives[tier] = altFromTerms(t);
  }

  // Fee rules are compared on the SAME collar: same floor, cap and hedge, only
  // the take recomputed. That isolates the fee's effect exactly; letting the
  // search re-pick a collar under the other rule would mix two changes.
  const feeRules = {} as Record<FeeRuleLabel, ShadowAltTerms>;
  for (const label of FEE_RULE_LABELS) {
    const cfg = { ...inputs.config, ...FEE_RULES[label] };
    const take = computeTake(live.grossCreditCents, inputs.contracts, cfg);
    const creditCents = live.grossCreditCents - take.takeCents;
    const same = altFromTerms(live) as Extract<ShadowAltTerms, { ok: true }>;
    feeRules[label] =
      creditCents > 0
        ? {
            ...same,
            creditCents,
            takeCents: take.takeCents,
            takeRule: take.takeRule,
            evCostBps: evCostBps(inputs.markCents, live.floorCents, live.capCents, creditCents, inputs.contracts),
          }
        : { ok: false, refused: "fee_exceeds_gross" };
  }

  const sizeLadder: ShadowSizeProbe[] = SIZE_LADDER_MULTS.map((mult) => {
    const contracts = inputs.contracts * mult;
    if (mult === 1) return { mult, contracts, terms: altFromTerms(live) };
    const q = requote(inputs, inputs.config, contracts);
    return { mult, contracts, terms: q ? altFromQuote(q) : UNAVAILABLE };
  });

  // Each route from the same books: the live route is the live terms; the other is re-priced at
  // the live size. A crypto strike has no verified pair, so the cross-venue route is not offered
  // there (different settlement feeds), which is a disclosure rather than a thin book.
  const routes = {} as Record<HedgeRoute, ShadowAltTerms>;
  for (const route of ROUTE_LABELS) {
    if (route === inputs.route) {
      routes[route] = altFromTerms(live);
    } else if (route === "polymarket" && !inputs.pair) {
      routes[route] = { ok: false, refused: "route_not_offered" };
    } else {
      const q = requote({ ...inputs, route }, inputs.config, inputs.contracts);
      routes[route] = q ? altFromQuote(q) : UNAVAILABLE;
    }
  }

  const references = referenceQuotesFor(inputs);
  const prints = referencePrintsFor(inputs, live);
  return { alternatives, feeRules, sizeLadder, routes, ...(references ? { references } : {}), ...(prints ? { prints } : {}) };
}

/**
 * PRE-LOCK RE-READ. Both routes and every reference priced again from fresh books a fixed time
 * before the lock, at the position's size and the mark of that moment. The open-time read is
 * days before tip for most games, when a venue that opens its books late is not listed yet and
 * the far-out books are thin; the pre-lock read is the moment a late tap's hedge would actually
 * be placed. It is stored beside the open-time read, never in its place: the terms written stay
 * the terms written.
 */
export type ShadowReread =
  | {
      at: string;
      /** hours from this read to the lock, one decimal */
      hoursToLock: number;
      /** the protected market's mid at this read, cents */
      markCents: number;
      /** the default tier on each hedge route from this read's books, at the position's size */
      routes: Record<HedgeRoute, ShadowAltTerms>;
      references?: ShadowReferenceQuote[];
      bookOrigins?: { polymarket?: "aggregator" | "direct"; kalshi?: "aggregator" | "direct" };
    }
  | {
      at: string;
      hoursToLock: number;
      /** the books could not be read for a reason that will not change before the lock (the market closed, the odds out of range) */
      unread: string;
    };

/**
 * BOOK-OPEN RE-READ. The same read, taken the moment a reference venue's book first showed
 * levels while the record held its subscription on the feed (aggregatorHeldBooks.ts), rather
 * than at a fixed time before the lock. `opened` says which venue, how long before the lock,
 * and whether the open was seen happen or was already there when the hold began.
 */
export interface ShadowBookOpened {
  venue: ReferenceBookId;
  /** "live": the first level arrived while held; "at_hold": the book had levels at the hold's first snapshot */
  caught: "live" | "at_hold";
  heldSinceIso: string;
  /** the opening book, as the feed showed it, before the full read */
  bestAskCents: number | null;
  bestBidCents: number | null;
  depthShares: number;
}
export type ShadowBookOpenReread = ShadowReread & { opened: ShadowBookOpened };

const UNREACHABLE: ShadowAltTerms = { ok: false, refused: "unreachable" };

/**
 * Each route and each reference from one fresh read of the books. Unlike counterfactualsFor there
 * is no live quote to copy: both routes are re-priced. A route whose book could not be read is
 * `unreachable`; the cross-venue route without a verified pair is `route_not_offered`.
 */
export function rereadQuotesFor(inputs: CounterfactualInputs): { routes: Record<HedgeRoute, ShadowAltTerms>; references?: ShadowReferenceQuote[] } {
  const routes = {} as Record<HedgeRoute, ShadowAltTerms>;
  for (const route of ROUTE_LABELS) {
    if (route === "polymarket" && !inputs.pair) {
      routes[route] = { ok: false, refused: "route_not_offered" };
      continue;
    }
    const q = requote({ ...inputs, route }, inputs.config, inputs.contracts);
    routes[route] = q ? altFromQuote(q) : UNREACHABLE;
  }
  const references = referenceQuotesFor(inputs);
  return { routes, ...(references ? { references } : {}) };
}

/**
 * Each print source's read beside the live hedge's own price per $1 of payout. Both the hedge
 * (the market's No side or the second book's opposing outcome) and the print (the opposing club's
 * contract) pay $1 when the holder's side loses, so the two prices compare directly. Undefined
 * when no print source was read; a source read but not printed keeps its reason.
 */
export function referencePrintsFor(inputs: CounterfactualInputs, live: Extract<CrossQuoteResult, { ok: true }>): ShadowReferencePrint[] | undefined {
  const prints = inputs.books.prints;
  if (!prints || prints.length === 0) return undefined;
  const liveHedgeAvgCents = live.hedge.venue === "kalshi" ? live.hedge.avgPriceCents : Math.round(live.hedge.avgPriceMilli) / 10;
  return prints.map((p) => {
    if (!p.print) return { id: p.id, ok: false, reason: p.reason };
    const printedMs = Date.parse(p.print.lastPrintAtIso);
    const ageHours = Number.isFinite(printedMs) ? Math.max(0, Math.round((inputs.now.getTime() - printedMs) / 360_000) / 10) : 0;
    return {
      id: p.id,
      ok: true,
      reportDate: p.print.reportDate,
      printedAtIso: p.print.lastPrintAtIso,
      ageHours,
      lastPriceCents: p.print.lastPriceCents,
      vwapCents: p.print.vwapCents,
      dayContracts: p.print.dayContracts,
      prints: p.print.prints,
      liveHedgeAvgCents,
      gapCents: Math.round((p.print.lastPriceCents - liveHedgeAvgCents) * 10) / 10,
    };
  });
}

/**
 * The default tier on each reference book, priced exactly as the cross-venue route is priced (same
 * grid, same fee rule, same size), with the venue's own fees already in the book's prices so the
 * config's hedge-fee knobs, which belong to the second book, do not apply twice. Undefined when no
 * reference was read; a reference read but unlisted keeps its reason.
 */
export function referenceQuotesFor(inputs: CounterfactualInputs): ShadowReferenceQuote[] | undefined {
  const refs = inputs.books.references;
  if (!refs || refs.length === 0) return undefined;
  const cfg: CrossSearchConfig = { ...inputs.config, hedgeFeeBps: 0, hedgeFeeFlatCents: 0 };
  return refs.map((ref) => {
    const listing = ref.listing ? { listing: ref.listing } : {};
    if (!ref.book) return { id: ref.id, terms: { ok: false, refused: ref.reason }, bestAskMilli: null, depthMilli: 0, ...listing };
    const depthMilli = ref.book.asks.reduce((s, l) => s + l.sizeMilli, 0);
    const bestAskMilli = ref.book.asks[0]?.priceMilli ?? null;
    const age = ref.ageSec === undefined ? {} : { ageSec: ref.ageSec };
    if (!inputs.pair) return { id: ref.id, terms: { ok: false, refused: "route_not_offered" }, bestAskMilli, depthMilli, ...age, ...listing };
    const q = quoteCrossWrap({
      pair: inputs.pair,
      markCents: inputs.markCents,
      entryCents: inputs.entryCents,
      contracts: inputs.contracts,
      now: inputs.now,
      noBook: ref.book,
      config: cfg,
    });
    const terms = altFromQuote(q);
    // the pricer's refusal codes are named for the second book; a reference is just a book
    const refused = !terms.ok ? terms.refused.replace(/^pm_book_/, "book_") : null;
    return { id: ref.id, terms: refused ? { ok: false, refused } : terms, bestAskMilli, depthMilli, ...age, ...listing };
  });
}
