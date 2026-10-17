/**
 * REFERENCE BOOKS: the same game's winner market on other regulated US exchanges, read as a price
 * reference beside the hedge routes the shadow already prices.
 *
 * The record hedges on two books today: the market's own No side (executable) and the second,
 * cross-venue book. Other US exchanges list the same games. Nothing can be filled on them from
 * here yet (no capital, no execution path, no terms), but their books can be read, so every open
 * also records what the default tier would have cost had the hedge run on each of them. That is
 * the measurement that decides whether onboarding a venue as a hedge is worth it, before any
 * money moves. Price reference only: these books never pick the route or touch the quote.
 *
 * Two API dialects are spoken, the same two the holder-position readers speak:
 *   - signed_v3: request signing with a key id and a private key (venuePositions.ts). The catalog
 *     lists winner markets per league; the book lists every resting order as a bid on its outcome,
 *     best first. On a two-outcome market a bid on one side IS the ask on the other, so the asks
 *     for the opposing team are 1 minus the bids on our team, with the bid's size. Contracts pay
 *     1 cent; ours pay $1, so qty 2000 is 20 of our shares (20,000 milli). The venue's fee is
 *     c x P x (1 - P) per contract, charged always or only once the game is live; it is folded
 *     into the price when it applies pre-game, so the book compares like for like with the others.
 *   - partner_mm: session login with an access key and secret key (venuePlays.ts). Markets carry
 *     selections grouped by side with American odds and `value`, the dollars that can be staked
 *     against the selection now. Every selection is an offer we could take: staking $S at payout
 *     multiple k buys S x k shares paying $1 each at 1/k per share. The venue takes 2% of net
 *     winnings at settlement, so a winning share pays 1 - 0.02 x (1 - p) rather than $1; the
 *     price per effective $1 of payout is p / (1 - 0.02 x (1 - p)) and the size shrinks by the
 *     same factor. Same ask-book shape out the other end.
 *
 * Credentials: REFERENCE_BOOK_SIGNED_HOST + REFERENCE_BOOK_SIGNED_KEY_ID + REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM
 * for the first; REFERENCE_BOOK_BEARER_HOST + REFERENCE_BOOK_BEARER_ACCESS_KEY + REFERENCE_BOOK_BEARER_SECRET_KEY
 * for the second. Service env only. Either set alone reads one venue; neither set, no reference is
 * read and the record carries none. A venue that does not list the game, cannot be reached, or
 * answers in a shape this module does not recognise is recorded as unlisted, never guessed.
 *
 * Nothing here names a venue in anything the record publishes: the ids are the dialects, the
 * public words are "reference book A" and "reference book B".
 */

import type { LeagueTemplate } from "./resolutionWhitelist";
import type { MatchedPair, PmBook, PmBookLevel } from "./types";
import { decimalToMilli } from "./polymarketPublic";
import { PlaysClient, payoutMultiple, type RawMarket, type RawSelection, type RawSportEvent } from "./venuePlays";
import { VenueClient, clubMatches, signerFromPem, templateForLeague, type RawVenueBook, type RawVenueMarket } from "./venuePositions";

/** Stable ledger keys. The dialect, not the venue. */
export const REFERENCE_BOOK_IDS = ["signed_v3", "partner_mm"] as const;
export type ReferenceBookId = (typeof REFERENCE_BOOK_IDS)[number];

/** What the public page and the operator report call each reference. Never the venue. */
export const REFERENCE_BOOK_WORDS: Record<ReferenceBookId, string> = {
  signed_v3: "reference book A",
  partner_mm: "reference book B",
};

/** One venue's read for one pair: a book shaped like the cross-venue hedge book, or why there is none. */
export type ReferenceBook =
  | { id: ReferenceBookId; book: PmBook; reason?: undefined }
  | { id: ReferenceBookId; book: null; reason: string };

export interface ReferenceBookSource {
  id: ReferenceBookId;
  /** the opposing outcome's asks for this pair, fees folded; null with a reason when the venue has no such book */
  read(pair: MatchedPair, now: Date): Promise<ReferenceBook>;
}

const DAY_MS = 86_400_000;
/** a game is the same game when the venue's start is within this of ours (timezones, late tips) */
const START_WINDOW_MS = 1.5 * DAY_MS;

// ---------------------------------------------------------------------------
// team resolution
// ---------------------------------------------------------------------------

const clubsOf = (template: LeagueTemplate): string[] => [...new Set(Object.values(template.teamNames))];

/** The template's club for a name as a venue (or the second book) writes it; null when no club matches. */
export function clubFor(template: LeagueTemplate, name: string): string | null {
  const hits = clubsOf(template).filter((club) => clubMatches(template, club, name));
  return hits.length === 1 ? hits[0] : null;
}

/** Both clubs of the pair by canonical name: ours (the Kalshi Yes side) and the opposing one (the hedge instrument). */
export function pairClubs(pair: MatchedPair): { template: LeagueTemplate; ours: string; opposing: string } | null {
  const template = templateForLeague(pair.league);
  if (!template) return null;
  const code = pair.kalshi.ticker.slice(pair.kalshi.ticker.lastIndexOf("-") + 1);
  const ours = template.teamNames[code] ?? clubFor(template, pair.pm.outcomes[pair.pmYesOutcomeIndex] ?? "");
  const opposing = clubFor(template, pair.pm.outcomes[pair.pmNoOutcomeIndex] ?? "");
  if (!ours || !opposing || ours === opposing) return null;
  return { template, ours, opposing };
}

const sameGame = (startMs: number, gameStartIso: string): boolean => {
  const ours = Date.parse(gameStartIso);
  if (!startMs || !Number.isFinite(ours)) return true; // unverifiable start: trust the two clubs
  return Math.abs(startMs - ours) <= START_WINDOW_MS;
};

const asksBook = (asks: PmBookLevel[], ref: string): PmBook => ({
  tokenId: ref,
  asks: asks.filter((l) => l.priceMilli > 0 && l.priceMilli < 1000 && l.sizeMilli > 0).sort((a, b) => a.priceMilli - b.priceMilli),
  bids: [],
  minOrderSizeShares: 1,
  tickMilli: 1,
});

// ---------------------------------------------------------------------------
// signed_v3
// ---------------------------------------------------------------------------

/** the fee rule's standing coefficient when the catalog does not say; the venue published 0.06 */
const SIGNED_DEFAULT_FEE_COEFFICIENT = 0.06;

/** Does this fee apply to a pre-game order? Unknown rules are taken as charged: a reference that overstates cost is the safe error. */
export function signedFeeAppliesPreGame(fee: RawVenueMarket["fee"]): boolean {
  const charged = fee?.charged?.toUpperCase();
  if (!charged) return true;
  return charged !== "WHEN_LIVE" && charged !== "LIVE_ONLY" && charged !== "NEVER";
}

/**
 * The asks for the opposing outcome from the venue's bids on ours, in exact milli units. With the
 * fee applying, each level's price carries c x P x (1 - P) rounded up against the credit.
 */
export function signedAsksForOpposing(book: RawVenueBook, ourOutcomeId: string, fee: RawVenueMarket["fee"]): PmBookLevel[] {
  const bids = book.orders[ourOutcomeId] ?? [];
  const coefficient = typeof fee?.coefficient === "number" && fee.coefficient >= 0 ? fee.coefficient : SIGNED_DEFAULT_FEE_COEFFICIENT;
  const charged = signedFeeAppliesPreGame(fee);
  const levels: PmBookLevel[] = [];
  for (const o of bids) {
    const bidMilli = decimalToMilli(o.price, false);
    if (bidMilli <= 0 || bidMilli >= 1000 || !Number.isInteger(o.qty) || o.qty <= 0) continue;
    const p = 1000 - bidMilli;
    const feeMilli = charged ? Math.ceil((coefficient * p * (1000 - p)) / 1000) : 0;
    levels.push({ priceMilli: p + feeMilli, sizeMilli: o.qty * 10 });
  }
  return levels;
}

const isWinnerMarket = (type: string) => /^(money|moneyline|money_line|winner|ml|match_winner|game_winner|h2h)$/i.test(type.replace(/[\s-]/g, "_"));

export function signedSource(client: VenueClient): ReferenceBookSource {
  return {
    id: "signed_v3",
    async read(pair) {
      const clubs = pairClubs(pair);
      if (!clubs) return { id: "signed_v3", book: null, reason: "league_not_covered" };
      const markets = await client.listMoneyMarkets(clubs.template.league);
      const hit = markets.find((m) => {
        if (!isWinnerMarket(m.marketType)) return false;
        if (m.status && /^(settled|closed|cancel|void|suspend)/i.test(m.status)) return false;
        if (!sameGame(m.startsTs, pair.gameStartTime)) return false;
        const ours = m.outcomes.find((o) => clubMatches(clubs.template, clubs.ours, o.name));
        const opp = m.outcomes.find((o) => clubMatches(clubs.template, clubs.opposing, o.name));
        return Boolean(ours && opp && ours !== opp);
      });
      if (!hit) return { id: "signed_v3", book: null, reason: "not_listed" };
      const ourOutcome = hit.outcomes.find((o) => clubMatches(clubs.template, clubs.ours, o.name))!;
      const book = await client.getBook(hit.marketId);
      return { id: "signed_v3", book: asksBook(signedAsksForOpposing(book, ourOutcome.outcomeId, hit.fee), `signed_v3:${hit.marketId}`) };
    },
  };
}

// ---------------------------------------------------------------------------
// partner_mm
// ---------------------------------------------------------------------------

/** 2% of net winnings at settlement, as the venue publishes it */
export const PARTNER_WINNINGS_FEE = 0.02;

/**
 * One selection as an ask level per effective $1 of payout: price 1/k with the settlement fee
 * folded in, size the stakeable dollars times k, shrunk by the same fee factor. Null when the odds
 * or the size cannot be read.
 */
export function partnerAskLevel(sel: Pick<RawSelection, "price" | "value" | "quantity">): PmBookLevel | null {
  const k = typeof sel.price === "number" ? payoutMultiple(sel.price) : null;
  if (!k || k <= 1) return null;
  const value =
    typeof sel.value === "number" && Number.isFinite(sel.value) && sel.value > 0
      ? sel.value
      : typeof sel.quantity === "number" && Number.isFinite(sel.quantity) && sel.quantity > 0
        ? sel.quantity / (k - 1)
        : 0;
  if (value <= 0) return null;
  const p = 1 / k;
  const eff = 1 - PARTNER_WINNINGS_FEE * (1 - p);
  const priceMilli = Math.ceil((1000 * p) / eff);
  const sizeMilli = Math.floor(value * k * eff * 1000);
  if (priceMilli <= 0 || priceMilli >= 1000 || sizeMilli <= 0) return null;
  return { priceMilli, sizeMilli };
}

const flatSelections = (m: RawMarket): RawSelection[] =>
  ((m.selections ?? []) as unknown[]).flat(2).filter((x): x is RawSelection => Boolean(x && typeof x === "object" && (x as RawSelection).outcome_id !== undefined));

/** The competitor of the event that is this club, by any of the names the venue gives it. */
function competitorFor(template: LeagueTemplate, event: RawSportEvent, club: string): NonNullable<RawSportEvent["competitors"]>[number] | null {
  for (const c of event.competitors ?? []) {
    const names = [c.name, c.display_name].filter((n): n is string => Boolean(n));
    if (names.some((n) => clubMatches(template, club, n))) return c;
  }
  return null;
}

export function partnerAsksForOpposing(market: RawMarket, template: LeagueTemplate, opposing: string, opposingCompetitorId: string | null): PmBookLevel[] {
  const levels: PmBookLevel[] = [];
  for (const sel of flatSelections(market)) {
    const byId = opposingCompetitorId !== null && sel.competitor_id !== undefined && sel.competitor_id !== null && String(sel.competitor_id) === opposingCompetitorId;
    const byName = [sel.name, sel.display_name].some((n) => typeof n === "string" && clubMatches(template, opposing, n));
    if (!byId && !byName) continue;
    const level = partnerAskLevel(sel);
    if (level) levels.push(level);
  }
  return levels;
}

export function partnerSource(client: PlaysClient): ReferenceBookSource {
  return {
    id: "partner_mm",
    async read(pair) {
      const clubs = pairClubs(pair);
      if (!clubs) return { id: "partner_mm", book: null, reason: "league_not_covered" };
      const tournaments = (await client.listTournaments()).filter((t) => templateForLeague(t.name)?.league === clubs.template.league);
      if (tournaments.length === 0) return { id: "partner_mm", book: null, reason: "league_not_listed" };
      for (const t of tournaments) {
        const events = await client.listEvents(String(t.id));
        const event = events.find((e) => {
          const startMs = e.scheduled ? Date.parse(e.scheduled) || 0 : 0;
          if (!sameGame(startMs, pair.gameStartTime)) return false;
          const a = competitorFor(clubs.template, e, clubs.ours);
          const b = competitorFor(clubs.template, e, clubs.opposing);
          return Boolean(a && b && a !== b);
        });
        if (!event) continue;
        const markets = await client.listMarkets(String(event.event_id));
        const market = markets.find((m) => isWinnerMarket(m.type) && (!m.status || !/^(settled|closed|cancel|void|suspend)/i.test(m.status)));
        if (!market) return { id: "partner_mm", book: null, reason: "winner_market_not_listed" };
        const opp = competitorFor(clubs.template, event, clubs.opposing);
        const oppId = opp?.id !== undefined && opp?.id !== null ? String(opp.id) : null;
        return { id: "partner_mm", book: asksBook(partnerAsksForOpposing(market, clubs.template, clubs.opposing, oppId), `partner_mm:${market.id}`) };
      }
      return { id: "partner_mm", book: null, reason: "not_listed" };
    },
  };
}

// ---------------------------------------------------------------------------
// configuration and the read that never throws
// ---------------------------------------------------------------------------

export interface ReferenceSourcesOptions {
  fetchImpl?: typeof fetch;
  /** one venue read (catalog or book) is given this long before it counts as unreachable */
  timeoutMs?: number;
}

/** The venues whose credentials are set, each behind its own client. Nothing set, nothing read. */
export function referenceSourcesFromEnv(env: NodeJS.ProcessEnv = process.env, opts: ReferenceSourcesOptions = {}): { sources: ReferenceBookSource[]; notes: string[] } {
  const sources: ReferenceBookSource[] = [];
  const notes: string[] = [];
  const fetchImpl = withTimeout(opts.fetchImpl ?? fetch, opts.timeoutMs ?? 6000);
  const signedHost = env.REFERENCE_BOOK_SIGNED_HOST?.trim().replace(/\/+$/, "");
  const signedKeyId = env.REFERENCE_BOOK_SIGNED_KEY_ID?.trim();
  const signedPem = env.REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM?.trim();
  if (signedHost || signedKeyId || signedPem) {
    if (signedHost && signedKeyId && signedPem) {
      try {
        sources.push(signedSource(new VenueClient({ host: signedHost, signer: signerFromPem(signedKeyId, signedPem), fetchImpl })));
      } catch (err) {
        notes.push(`reference book A: key unusable (${String(err instanceof Error ? err.message : err)})`);
      }
    } else {
      notes.push("reference book A: host, key id and private key must all be set; off");
    }
  }
  const bearerHost = env.REFERENCE_BOOK_BEARER_HOST?.trim().replace(/\/+$/, "");
  const bearerAccess = env.REFERENCE_BOOK_BEARER_ACCESS_KEY?.trim();
  const bearerSecret = env.REFERENCE_BOOK_BEARER_SECRET_KEY?.trim();
  if (bearerHost || bearerAccess || bearerSecret) {
    if (bearerHost && bearerAccess && bearerSecret) {
      sources.push(partnerSource(new PlaysClient({ host: bearerHost, accessKey: bearerAccess, secretKey: bearerSecret, fetchImpl })));
    } else {
      notes.push("reference book B: host, access key and secret key must all be set; off");
    }
  }
  return { sources, notes };
}

function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}

/**
 * Every configured reference for one pair, in parallel. A venue that throws is recorded as
 * unreachable with the error's first words; the caller's quote never waits on, or fails for, a
 * reference book.
 */
export async function readReferenceBooks(sources: ReferenceBookSource[], pair: MatchedPair, now: Date): Promise<ReferenceBook[]> {
  if (sources.length === 0) return [];
  const settled = await Promise.allSettled(sources.map((s) => s.read(pair, now)));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: sources[i].id, book: null, reason: `unreachable: ${String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 80)}` },
  );
}
