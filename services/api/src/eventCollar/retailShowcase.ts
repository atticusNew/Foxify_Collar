/**
 * RETAIL SHOWCASE — what a non-operator caller of an event demo's /api/showcase is allowed to see.
 *
 * The card needs exactly the product: the event, the position, the floor, the cap, the credit, the
 * tiers, when protection locks, and a human sentence when something is refused. Everything else
 * that used to ride the same JSON — the hedge leg (venue, token, shares, average and worst price,
 * cost), gross credit and our take, the fee rule, venue fees, the cross-venue pairing (slug, the
 * other venue's price, bid/ask), which route funded the quote and which routes were examined,
 * candidate counts, raw refusal detail and environment-variable names — is operator information.
 * It stays behind the admin token (`/api/showcase?token=...`).
 *
 * This is an allow-list serializer, not a deny-list: a new internal field on the engine's quote
 * never reaches a retail response unless it is added here on purpose. The mirror of
 * `singleSide/twoSided/creditCollar/retailView.ts` on the perp side.
 *
 * Honesty is kept, not traded: the position is still labelled simulated by the page, refusals still
 * say what happened to the holder ("not enough depth to protect this size right now"); they just
 * do not say which venue, which book, or which rule.
 */

import type { CrossQuoteResult, HedgeRoute, ProtectionTier, RouteCheck } from "./crossVenue/types";
import type { WrapQuoteResult } from "./types";

/** One collar the holder can lock: the three numbers that define the payoff, nothing else. */
export interface RetailTerms {
  floorCents: number;
  capCents: number;
  creditCents: number;
}

export interface RetailQuote extends RetailTerms {
  ok: true;
  contracts: number;
  markCents: number;
  entryCents: number;
  tier: ProtectionTier;
  tiers: Partial<Record<ProtectionTier, RetailTerms>>;
  quotedAt: string;
}

/** A refusal the card can show: a retail code and a retail sentence; the engine's detail stays home. */
export interface RetailRefusal {
  ok: false;
  code: string;
  detail: string;
}

export type RetailQuoteResult = RetailQuote | RetailRefusal;

/**
 * The retail sentence for an engine refusal, keyed on the engine's code. Every code maps; an
 * unknown code collapses to the generic sentence so a new engine reason can never leak its text.
 */
export const RETAIL_REFUSAL_COPY: Readonly<Record<string, { code: string; detail: string }>> = {
  credit_nonpositive: { code: "no_credit", detail: "The market can't fund a credit on this position right now." },
  protection_too_rich: { code: "too_expensive", detail: "Protection is too expensive on this one right now." },
  credit_too_small: { code: "credit_too_small", detail: "The market can't fund a worthwhile credit on this one right now." },
  far_out_no_book: { code: "too_early", detail: "Protection opens closer to the start of this one." },
  mark_disagreement: { code: "price_unsettled", detail: "The price on this one has not settled yet. Check back closer to the start." },
  market_too_close_to_start: { code: "too_close", detail: "This one starts too soon to protect." },
  mark_out_of_range: { code: "odds_out_of_range", detail: "The odds are outside the range we protect." },
  pm_book_empty: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
  pm_book_too_thin: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
  kalshi_book_empty: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
  kalshi_book_too_thin: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
  no_matched_market: { code: "not_offered", detail: "Protection isn't offered on this event yet." },
  resolution_mismatch: { code: "not_offered", detail: "Protection isn't offered on this event yet." },
  // BTC (OKX-hedged) demo codes
  market_not_active: { code: "not_offered", detail: "This market isn't open for protection right now." },
  market_too_close_to_resolution: { code: "too_close", detail: "This one settles too soon to protect." },
  no_bracketing_strikes: { code: "not_offered", detail: "Protection isn't offered on this market yet." },
  no_matching_expiry: { code: "not_offered", detail: "Protection isn't offered on this market yet." },
  okx_book_empty: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
  okx_book_too_thin: { code: "no_depth", detail: "Not enough depth to protect this size right now." },
};

const GENERIC_REFUSAL = { code: "unavailable", detail: "Protection isn't available on this position right now." };

export const retailRefusal = (code: string | undefined): RetailRefusal => {
  const c = (code && RETAIL_REFUSAL_COPY[code]) || GENERIC_REFUSAL;
  return { ok: false, code: c.code, detail: c.detail };
};

/** Errors on the whole payload (no showcase at all) also get one sentence, venue- and env-free. */
export const retailPayloadError = (error: string | undefined): string | undefined => {
  if (!error) return undefined;
  if (/unreachable|blocked|relay|REST_BASE/i.test(error)) return "Live pricing is unavailable right now; retrying.";
  return "Nothing is quotable right now; the board refreshes on its own.";
};

const terms = (t: RetailTerms): RetailTerms => ({ floorCents: t.floorCents, capCents: t.capCents, creditCents: t.creditCents });

/** Cross-venue quote → retail quote. */
export const retailCrossQuote = (q: CrossQuoteResult | null | undefined): RetailQuoteResult | null => {
  if (!q) return null;
  if (!q.ok) return retailRefusal(q.code);
  const tiers: Partial<Record<ProtectionTier, RetailTerms>> = {};
  for (const [name, t] of Object.entries(q.tiers)) if (t) tiers[name as ProtectionTier] = terms(t);
  return {
    ok: true,
    contracts: q.contracts,
    markCents: q.markCents,
    entryCents: q.entryCents,
    floorCents: q.floorCents,
    capCents: q.capCents,
    creditCents: q.creditCents,
    tier: q.tier,
    tiers,
    quotedAt: q.quotedAt,
  };
};

/** BTC (OKX-hedged) demo quote → retail quote (one tier; the engine offers one collar). */
export const retailWrapQuote = (q: WrapQuoteResult | null | undefined): RetailQuoteResult | null => {
  if (!q) return null;
  if (!q.ok) return retailRefusal(q.code);
  const t = terms(q);
  return {
    ok: true,
    contracts: q.contracts,
    markCents: q.markCents,
    entryCents: q.entryCents,
    ...t,
    tier: "balanced",
    tiers: { balanced: t },
    quotedAt: q.quotedAt,
  };
};

/* ------------------------------------------------------------------------------------------ */
/* cross-venue payload                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Operator-side shapes, as the demo service builds them (structural, so this module owns no scan code). */
export interface OperatorBoardRow {
  kind: "sports" | "crypto";
  league: string;
  kalshiTicker: string;
  kalshiSide: string;
  sideName: string;
  eventTitle: string;
  eventTimeIso: string;
  markCents: number;
  contracts: number;
  entryCents: number;
  floorCents: number;
  capCents: number;
  creditCents: number;
  floorTotalCents: number;
  evCostBps: number;
  route: HedgeRoute;
  tier: ProtectionTier;
  tierCount: number;
}

export interface OperatorCrossPayload {
  ok: boolean;
  at: string;
  pair: {
    kind: "sports" | "crypto";
    league: string;
    kalshiTicker: string;
    kalshiTitle: string;
    kalshiSide: string;
    sideName: string;
    opponent: string | null;
    eventTitle: string;
    eventTimeIso: string;
    parityNote: string;
    yesBidCents: number;
    yesAskCents: number;
    markCents: number;
    pmEventSlug: string | null;
    pmYesPriceMilli: number;
  } | null;
  position: { contracts: number; entryCents: number; entrySource: string; entryTime: string | null } | null;
  quote: CrossQuoteResult | null;
  route: HedgeRoute | null;
  routesChecked: RouteCheck[];
  evCostBps: number | null;
  board: OperatorBoardRow[];
  error?: string;
}

/** A board row as the holder sees it: the event, the odds, what they keep, the cash. The route stays home. */
export type RetailBoardRow = Omit<OperatorBoardRow, "route">;

export interface RetailCrossPayload {
  ok: boolean;
  at: string;
  /** true on every retail response so the page never has to guess which shape it got */
  retail: true;
  pair: {
    kind: "sports" | "crypto";
    league: string;
    kalshiTicker: string;
    kalshiTitle: string;
    kalshiSide: string;
    sideName: string;
    opponent: string | null;
    eventTitle: string;
    eventTimeIso: string;
    markCents: number;
  } | null;
  position: { contracts: number; entryCents: number; entrySource: string; entryTime: string | null } | null;
  quote: RetailQuoteResult | null;
  board: RetailBoardRow[];
  error?: string;
}

export const retailCrossPayload = (p: OperatorCrossPayload): RetailCrossPayload => ({
  ok: p.ok,
  at: p.at,
  retail: true,
  pair: p.pair
    ? {
        kind: p.pair.kind,
        league: p.pair.league,
        kalshiTicker: p.pair.kalshiTicker,
        kalshiTitle: p.pair.kalshiTitle,
        kalshiSide: p.pair.kalshiSide,
        sideName: p.pair.sideName,
        opponent: p.pair.opponent,
        eventTitle: p.pair.eventTitle,
        eventTimeIso: p.pair.eventTimeIso,
        markCents: p.pair.markCents,
      }
    : null,
  position: p.position
    ? { contracts: p.position.contracts, entryCents: p.position.entryCents, entrySource: p.position.entrySource, entryTime: p.position.entryTime }
    : null,
  quote: retailCrossQuote(p.quote),
  board: p.board.map((r) => ({
    kind: r.kind,
    league: r.league,
    kalshiTicker: r.kalshiTicker,
    kalshiSide: r.kalshiSide,
    sideName: r.sideName,
    eventTitle: r.eventTitle,
    eventTimeIso: r.eventTimeIso,
    markCents: r.markCents,
    contracts: r.contracts,
    entryCents: r.entryCents,
    floorCents: r.floorCents,
    capCents: r.capCents,
    creditCents: r.creditCents,
    floorTotalCents: r.floorTotalCents,
    // derivable from the four terms above at the market's own odds; the page recomputes it anyway
    evCostBps: r.evCostBps,
    tier: r.tier,
    tierCount: r.tierCount,
  })),
  ...(p.error ? { error: retailPayloadError(p.error) } : {}),
});

/* ------------------------------------------------------------------------------------------ */
/* BTC (OKX-hedged) payload                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface OperatorBtcPayload {
  ok: boolean;
  at: string;
  spotUsd: number;
  market: {
    ticker: string;
    title: string;
    subtitle: string;
    strike: number;
    closeTime: string;
    yesBidCents: number;
    yesAskCents: number;
    markCents: number;
    volume: number;
  } | null;
  position: { contracts: number; entryCents: number; entrySource: string; entryTime: string | null } | null;
  quote: WrapQuoteResult | null;
  hedge: { expiry: string; expiryTime: string } | null;
  error?: string;
}

export interface RetailBtcPayload {
  ok: boolean;
  at: string;
  retail: true;
  spotUsd: number;
  market: { ticker: string; title: string; subtitle: string; strike: number; closeTime: string; markCents: number } | null;
  position: { contracts: number; entryCents: number; entrySource: string; entryTime: string | null } | null;
  quote: RetailQuoteResult | null;
  error?: string;
}

export const retailBtcPayload = (p: OperatorBtcPayload): RetailBtcPayload => ({
  ok: p.ok,
  at: p.at,
  retail: true,
  spotUsd: p.spotUsd,
  market: p.market
    ? {
        ticker: p.market.ticker,
        title: p.market.title,
        subtitle: p.market.subtitle,
        strike: p.market.strike,
        closeTime: p.market.closeTime,
        markCents: p.market.markCents,
      }
    : null,
  position: p.position
    ? { contracts: p.position.contracts, entryCents: p.position.entryCents, entrySource: p.position.entrySource, entryTime: p.position.entryTime }
    : null,
  quote: retailWrapQuote(p.quote),
  ...(p.error ? { error: retailPayloadError(p.error) } : {}),
});

/**
 * Keys that must never appear anywhere in a retail response. Used by tests as a deep-walk
 * tripwire, and exported so the shadow worker's public health body can be checked the same way.
 */
export const RETAIL_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "hedge",
  "legs",
  "instId",
  "tokenId",
  "sharesMilli",
  "contractsMilli",
  "avgPriceCents",
  "avgPriceMilli",
  "worstPriceCents",
  "worstPriceMilli",
  "costCents",
  "feesCents",
  "grossCreditCents",
  "takeCents",
  "takeShareCents",
  "takeMinimumCents",
  "takeRule",
  "takeWaived",
  "takeBps",
  "minTakeBpsOfStake",
  "candidatesConsidered",
  "route",
  "routesChecked",
  "parityNote",
  "pmEventSlug",
  "pmYesPriceMilli",
  "yesBidCents",
  "yesAskCents",
  "volume",
  "digitalPutMicro",
  "spreads",
  "verticalWidthUsd",
  "hedgeExpiry",
  "alignment",
  "bestShortfallCents",
  "path",
  "strategy",
  "rfqVenues",
  "notes",
  "receipts",
  "lastScanError",
  "lastSettleError",
]);

/** Every key found anywhere in `value` that is on the forbidden list (empty = clean). */
export const forbiddenKeysIn = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const v of value) forbiddenKeysIn(v, found);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RETAIL_FORBIDDEN_KEYS.has(k)) found.push(k);
      forbiddenKeysIn(v, found);
    }
  }
  return found;
};
