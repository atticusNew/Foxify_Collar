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
 * Credentials: REFERENCE_BOOK_SIGNED_HOST alone reads the first venue's PUBLIC catalog and books
 * (it publishes both unsigned, which is all a reference needs); add REFERENCE_BOOK_SIGNED_KEY_ID +
 * REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM and the reads are signed instead. REFERENCE_BOOK_BEARER_HOST +
 * REFERENCE_BOOK_BEARER_ACCESS_KEY + REFERENCE_BOOK_BEARER_SECRET_KEY for the second. Service env
 * only. Either venue alone is fine; neither set, no reference is read and the record carries none.
 * REFERENCE_BOOK_SIGNED_LEAGUES ("nba=NBA_REG,mlb=MLB") names the first venue's own league word
 * where it differs from ours; a league not named is asked under our code in upper case. A league
 * that answers nothing under its code is asked once more without the filter (one cached page of
 * every winner market) and matched by clubs and start time, so a code the venue spells
 * differently costs one extra catalog read per cache window, not the whole slate.
 * Outcome names on the first venue are team codes ("PHI", "KC"); the templates' code tables match
 * them, and every code the venue listed for the covered leagues was checked against them. A venue that does not list the game, cannot be reached, or
 * answers in a shape this module does not recognise is recorded as unlisted, never guessed.
 *
 * Nothing here names a venue in anything the record publishes: the ids are the dialects, the
 * public words are "reference book A" and "reference book B".
 */

import type { NovigHedgeOn } from "./crossVenuePricer";
import type { LeagueTemplate } from "./resolutionWhitelist";
import type { MatchedPair, PmBook, PmBookLevel } from "./types";
import { decimalToMilli } from "./polymarketPublic";
import { PlaysApiError, PlaysClient, payoutMultiple, type RawMarket, type RawSelection, type RawSportEvent } from "./venuePlays";
import { VenueApiError, VenueClient, clubMatches, signerFromPem, templateForLeague, type RawVenueBook, type RawVenueMarket } from "./venuePositions";

/** Stable ledger keys. The dialect, not the venue. */
export const REFERENCE_BOOK_IDS = ["signed_v3", "partner_mm", "aggregated_mm", "aggregated_other"] as const;
export type ReferenceBookId = (typeof REFERENCE_BOOK_IDS)[number];

/** What the public page and the operator report call each reference. Never the venue. */
export const REFERENCE_BOOK_WORDS: Record<ReferenceBookId, string> = {
  signed_v3: "reference book A",
  partner_mm: "reference book B",
  // the same second-dialect venue's book read through the aggregator's feed (aggregatorBooks.ts)
  aggregated_mm: "reference book B (via the aggregator)",
  // any further venue the aggregator aligns that this service has no direct read for
  aggregated_other: "reference book C (via the aggregator)",
};

/**
 * One venue's read for one pair: a book shaped like the cross-venue hedge book, or why there is
 * none. `ageSec` is how old the venue's snapshot was when read, when the venue stamps it: a
 * reference is a comparison, not a fill, so an old resting book is kept and dated rather than
 * dropped (the hedge routes keep their staleness bound).
 */
export type ReferenceBook =
  | { id: ReferenceBookId; book: PmBook; reason?: undefined; ageSec?: number; listing?: ReferenceListing }
  | { id: ReferenceBookId; book: null; reason: string; ageSec?: undefined; listing?: ReferenceListing };

/**
 * Which listing a reference was read from, kept on the record so a cell with no book can be asked
 * about by id ("mapped, no book yet" on market X, strike Y, at time T) instead of by game name.
 * Ids only, never a key or a name; absent when the read never reached a listing (not mapped, the
 * league not covered, the venue unreachable).
 */
export interface ReferenceListing {
  /** the market id on the side the read came through: the aggregator's for a feed read, the venue's for a direct read */
  marketId: string;
  /** the venue's own key for the listing when the dialect has one (a strike id; an event id) */
  key?: string;
  /** the venue's snapshot timestamp as read, ISO; absent when unstamped or when there was no book */
  snapshotAtIso?: string;
  /**
   * The two outcomes of the venue's market, ours (the holder's side) and the opposing one (what a
   * hedge there buys), and the fee rule the book was folded under: what a hedge ROUTE on this
   * venue needs to send an order (novigOrders.ts). Present on the signed dialect only.
   */
  outcomes?: ReferenceOutcomes;
}

export interface ReferenceOutcomes {
  ours: { outcomeId: string; name: string };
  opposing: { outcomeId: string; name: string };
  /** the fee coefficient and whether the book's levels carry it (pre-game, per the market's rule) */
  fee: { coefficient: number; folded: boolean };
  /** the market's status word as the catalog gave it, when it did */
  marketStatus?: string;
}

/** What one reference venue lists for a league, as it answers the catalog: the diagnostic behind a run of "not listed". */
export interface ReferenceCatalogProbe {
  id: ReferenceBookId;
  /** our league code */
  league: string;
  /** each query tried, as sent (no host, no key), with what came back */
  queries: ReferenceCatalogQuery[];
  /** how the reads went, when there is something to say (the signed catalog refused the key and the public one answered) */
  note?: string;
}
export interface ReferenceCatalogQuery {
  query: string;
  /** markets returned; null when the call failed */
  count: number | null;
  /** of them, winner markets not settled/closed */
  winners: number | null;
  /** of the winners, those whose outcomes name two clubs of our league's template */
  ourClubs: number | null;
  error?: string;
  /** the venue's own league/sport words on the markets returned, by count, when it puts one on a market */
  leaguesSeen: Record<string, number>;
  /** the first few markets, enough to recognise a league by its games */
  sample: ReferenceCatalogSample[];
}
export interface ReferenceCatalogSample {
  marketId: string;
  eventId?: string;
  description: string;
  marketType: string;
  status: string;
  startsIso: string | null;
  outcomes: string[];
  /** the venue's league/sport word on this market, when present */
  league?: string;
}

export interface ReferenceBookSource {
  id: ReferenceBookId;
  /** the opposing outcome's asks for this pair, fees folded; null with a reason when the venue has no such book */
  read(pair: MatchedPair, now: Date): Promise<ReferenceBook>;
  /** what the venue lists for one of our leagues, as its catalog answers; absent on dialects with no catalog to ask */
  catalog?(league: string): Promise<ReferenceCatalogProbe>;
}

const DAY_MS = 86_400_000;
/** a game is the same game when the venue's start is within this of ours (timezones, late tips) */
const START_WINDOW_MS = 1.5 * DAY_MS;

// ---------------------------------------------------------------------------
// team resolution
// ---------------------------------------------------------------------------

const clubsOf = (template: LeagueTemplate): string[] => [...new Set(Object.values(template.teamNames))];

/** Every code the template knows for a club: the Kalshi codes mapping to it and their slug aliases, uppercased. */
export function codesFor(template: LeagueTemplate, club: string): Set<string> {
  const codes = new Set<string>();
  for (const [code, full] of Object.entries(template.teamNames)) {
    if (full !== club) continue;
    codes.add(code.toUpperCase());
    for (const a of template.teamCodeAliases[code] ?? []) codes.add(a.toUpperCase());
  }
  return codes;
}

/**
 * Does a venue's outcome name this club? The full name, nickname or unshared city (clubMatches),
 * or a bare team code as some venues list outcomes ("PHI", "KC"), matched against the codes the
 * template knows for the club.
 */
export function clubNamed(template: LeagueTemplate, club: string, outcomeName: string): boolean {
  const name = outcomeName.trim();
  // a code is upper case; "Jets", "Heat" and "Cubs" are nicknames and go to the name match
  if (/^[A-Z]{2,4}$/.test(name) && codesFor(template, club).has(name)) return true;
  return clubMatches(template, club, name);
}

/** The template's club for a name as a venue (or the second book) writes it; null when no club matches. */
export function clubFor(template: LeagueTemplate, name: string): string | null {
  const hits = clubsOf(template).filter((club) => clubNamed(template, club, name));
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

/** The market's fee coefficient as the catalog gives it; the venue's published figure when it does not. */
export function signedFeeCoefficient(fee: RawVenueMarket["fee"]): number {
  const c = fee?.coefficient === undefined || fee.coefficient === null ? NaN : Number(fee.coefficient);
  return Number.isFinite(c) && c >= 0 ? c : SIGNED_DEFAULT_FEE_COEFFICIENT;
}

/** The taker fee on one of our $1 units at a milli price, milli, rounded up against the credit: c x P x (1 - P). */
export const signedFeeMilli = (coefficient: number, priceMilli: number): number => Math.ceil((coefficient * priceMilli * (1000 - priceMilli)) / 1000);

/**
 * The asks for the opposing outcome from the venue's bids on ours, in exact milli units. With the
 * fee applying, each level's price carries c x P x (1 - P) rounded up against the credit.
 */
export function signedAsksForOpposing(book: RawVenueBook, ourOutcomeId: string, fee: RawVenueMarket["fee"]): PmBookLevel[] {
  const bids = book.orders[ourOutcomeId] ?? [];
  const coefficient = signedFeeCoefficient(fee);
  const charged = signedFeeAppliesPreGame(fee);
  const levels: PmBookLevel[] = [];
  for (const o of bids) {
    const bidMilli = decimalToMilli(o.price, false);
    if (bidMilli <= 0 || bidMilli >= 1000 || !Number.isInteger(o.qty) || o.qty <= 0) continue;
    const p = 1000 - bidMilli;
    const feeMilli = charged ? signedFeeMilli(coefficient, p) : 0;
    levels.push({ priceMilli: p + feeMilli, sizeMilli: o.qty * 10 });
  }
  return levels;
}

/**
 * The bids for the opposing outcome: what the venue's resting bids on it would pay a hedge that
 * leaves (novigOrders.ts leaves by buying our outcome at 1 - the bid, so the proceeds are the bid
 * less the fee on it when the fee applies). Best first, the fee taken off each level rounded up.
 */
export function signedBidsForOpposing(book: RawVenueBook, opposingOutcomeId: string, fee: RawVenueMarket["fee"]): PmBookLevel[] {
  const bids = book.orders[opposingOutcomeId] ?? [];
  const coefficient = signedFeeCoefficient(fee);
  const charged = signedFeeAppliesPreGame(fee);
  const levels: PmBookLevel[] = [];
  for (const o of bids) {
    const b = decimalToMilli(o.price, false);
    if (b <= 0 || b >= 1000 || !Number.isInteger(o.qty) || o.qty <= 0) continue;
    const feeMilli = charged ? signedFeeMilli(coefficient, b) : 0;
    if (b - feeMilli <= 0) continue;
    levels.push({ priceMilli: b - feeMilli, sizeMilli: o.qty * 10 });
  }
  return levels.sort((a, b) => b.priceMilli - a.priceMilli);
}

/**
 * The Novig hedge route's inputs from the signed-dialect reference read: the opposing outcome's
 * asks (fee folded as the market's rule says) and the ids an order there needs. Null when the
 * venue was not read, did not list the game, or the read predates the ids being kept.
 */
export function novigRouteOf(references: ReferenceBook[] | undefined): { noBook: PmBook; hedgeOn: NovigHedgeOn; ref: ReferenceBook } | null {
  const ref = (references ?? []).find((r) => r.id === "signed_v3");
  if (!ref || !ref.book || !ref.listing?.outcomes) return null;
  const o = ref.listing.outcomes;
  return {
    noBook: ref.book,
    hedgeOn: { venue: "novig", marketId: ref.listing.marketId, outcomeId: o.opposing.outcomeId, offsetOutcomeId: o.ours.outcomeId, outcome: o.opposing.name },
    ref,
  };
}

/**
 * One market's book on the signed-dialect venue by its ids, shaped for the hedge route: the
 * opposing outcome's asks and bids with the fee folded as the market's rule says. What an early
 * close on the Novig route reads (the ids are on the record), no catalog search needed.
 */
export async function signedHedgeBook(client: VenueClient, marketId: string, ourOutcomeId: string, opposingOutcomeId: string): Promise<PmBook> {
  const [m, book] = await Promise.all([client.getMarket(marketId), client.getBook(marketId)]);
  const shaped = asksBook(signedAsksForOpposing(book, ourOutcomeId, m.fee), `signed_v3:${marketId}`);
  return { ...shaped, bids: signedBidsForOpposing(book, opposingOutcomeId, m.fee) };
}

/** The signed-dialect venue's host for the Novig route's own reads: the reference host, else the holder-positions host. Null when neither is set. */
export function signedHostFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = (env.REFERENCE_BOOK_SIGNED_HOST ?? env.VENUE_API_HOST ?? "").trim().replace(/\/+$/, "");
  return host || null;
}

const isWinnerMarket = (type: string) => /^(money|moneyline|money_line|winner|ml|match_winner|game_winner|h2h)$/i.test(type.replace(/[\s-]/g, "_"));

/** our league code (lower case) -> the venue's own league word, where it differs */
export type SignedLeagueCodes = Record<string, string>;

export interface SignedSourceOptions {
  leagueCodes?: SignedLeagueCodes;
  /** ask the whole winner catalog when the league's own query lists no such game (default on) */
  unfilteredFallback?: boolean;
}

/** The league word the venue's catalog filter takes for one of our leagues. */
export function signedLeagueCode(league: string, codes: SignedLeagueCodes = {}): string {
  return codes[league.toLowerCase()] ?? league.toUpperCase();
}

/**
 * REFERENCE_BOOK_SIGNED_LEAGUES as "nba=NBA_REG,mlb=MLB": entries without both sides, or naming a
 * league no template covers, are reported and dropped.
 */
export function parseSignedLeagueCodes(raw: string | undefined): { codes: SignedLeagueCodes; notes: string[] } {
  const codes: SignedLeagueCodes = {};
  const notes: string[] = [];
  for (const entry of (raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const league = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : "";
    const code = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (!league || !code) notes.push(`reference book A: league entry "${entry}" is not league=CODE; dropped`);
    else if (!templateForLeague(league)) notes.push(`reference book A: league "${league}" is not one we cover; dropped`);
    else codes[league] = code;
  }
  return { codes, notes };
}

const openWinner = (m: RawVenueMarket): boolean => isWinnerMarket(m.marketType ?? "") && !(m.status && /^(settled|closed|cancel|void|suspend)/i.test(m.status));

export function signedSource(client: VenueClient, opts: SignedSourceOptions = {}): ReferenceBookSource {
  const codes = opts.leagueCodes ?? {};
  const fallback = opts.unfilteredFallback ?? true;
  return {
    id: "signed_v3",
    async read(pair) {
      const clubs = pairClubs(pair);
      if (!clubs) return { id: "signed_v3", book: null, reason: "league_not_covered" };
      const isOurGame = (m: RawVenueMarket): boolean => {
        if (!openWinner(m)) return false;
        if (!sameGame(m.startsTs, pair.gameStartTime)) return false;
        const ours = m.outcomes.find((o) => clubNamed(clubs.template, clubs.ours, o.name));
        const opp = m.outcomes.find((o) => clubNamed(clubs.template, clubs.opposing, o.name));
        return Boolean(ours && opp && ours !== opp);
      };
      let hit = (await client.listMoneyMarkets(signedLeagueCode(clubs.template.league, codes))).find(isOurGame);
      // the venue may spell the league another way; its whole winner slate (one cached page) is
      // searched by clubs and start time before the game is called unlisted
      if (!hit && fallback) hit = (await client.listMarkets({ marketType: "MONEY", limit: "200" })).find(isOurGame);
      if (!hit) return { id: "signed_v3", book: null, reason: "not_listed" };
      const ourOutcome = hit.outcomes.find((o) => clubNamed(clubs.template, clubs.ours, o.name))!;
      const oppOutcome = hit.outcomes.find((o) => clubNamed(clubs.template, clubs.opposing, o.name))!;
      const book = await client.getBook(hit.marketId);
      const listing: ReferenceListing = {
        marketId: hit.marketId,
        ...(hit.eventId ? { key: hit.eventId } : {}),
        outcomes: {
          ours: { outcomeId: ourOutcome.outcomeId, name: ourOutcome.name },
          opposing: { outcomeId: oppOutcome.outcomeId, name: oppOutcome.name },
          fee: { coefficient: signedFeeCoefficient(hit.fee), folded: signedFeeAppliesPreGame(hit.fee) },
          ...(hit.status ? { marketStatus: hit.status } : {}),
        },
      };
      // asks for the hedge, and the bids a hedge there could leave against (earlyClose.ts)
      const shaped = asksBook(signedAsksForOpposing(book, ourOutcome.outcomeId, hit.fee), `signed_v3:${hit.marketId}`);
      return { id: "signed_v3", book: { ...shaped, bids: signedBidsForOpposing(book, oppOutcome.outcomeId, hit.fee) }, listing };
    },
    async catalog(league) {
      return signedCatalogProbe(client, league, codes);
    },
  };
}

/** The first few markets of a catalog answer, laid out for the operator. */
function sampleOf(m: RawVenueMarket): ReferenceCatalogSample {
  const leagueWord = [m.league, m.sport, m.competition].find((w): w is string => typeof w === "string" && w.trim() !== "");
  return {
    marketId: m.marketId,
    ...(m.eventId ? { eventId: m.eventId } : {}),
    description: m.description ?? "",
    marketType: m.marketType ?? "",
    status: m.status ?? "",
    startsIso: m.startsTs ? new Date(m.startsTs < 1e12 ? m.startsTs * 1000 : m.startsTs).toISOString() : null,
    outcomes: (m.outcomes ?? []).map((o) => o.name),
    ...(leagueWord ? { league: leagueWord } : {}),
  };
}

const SAMPLE_SIZE = 12;

/**
 * Ask the signed-dialect venue what it lists for one of our leagues, two ways: with the league
 * filter the reader sends, and without it (every winner market, tallied by whatever league word
 * the venue puts on each, and by whether the outcomes name two clubs of our template). A run of
 * "not listed" on one league is either a slate the venue has not posted or a league code the
 * venue spells differently; the two answers side by side tell which.
 */
export async function signedCatalogProbe(client: VenueClient, league: string, codes: SignedLeagueCodes = {}): Promise<ReferenceCatalogProbe> {
  const template = templateForLeague(league);
  const clubs = template ? clubsOf(template) : [];
  const namesTwoClubs = (m: RawVenueMarket): boolean => {
    if (!template) return false;
    const hit = new Set<string>();
    for (const o of m.outcomes ?? []) for (const club of clubs) if (clubNamed(template, club, o.name)) hit.add(club);
    return hit.size === 2;
  };
  const open = openWinner;
  const run = async (query: Record<string, string>): Promise<ReferenceCatalogQuery> => {
    const sent = Object.entries(query)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    try {
      const markets = await client.listMarkets(query);
      const winners = markets.filter(open);
      const ours = winners.filter(namesTwoClubs);
      const leaguesSeen: Record<string, number> = {};
      for (const m of markets) {
        const w = sampleOf(m).league;
        if (w) leaguesSeen[w] = (leaguesSeen[w] ?? 0) + 1;
      }
      // our clubs' games first, so a league listed under another code shows in the sample
      const ordered = [...ours, ...winners.filter((m) => !ours.includes(m)), ...markets.filter((m) => !winners.includes(m))];
      return { query: sent, count: markets.length, winners: winners.length, ourClubs: ours.length, leaguesSeen, sample: ordered.slice(0, SAMPLE_SIZE).map(sampleOf) };
    } catch (err) {
      const words = err instanceof VenueApiError ? `${err.status} ${err.code}: ${err.message}` : String(err instanceof Error ? err.message : err);
      return { query: sent, count: null, winners: null, ourClubs: null, error: words.slice(0, 160), leaguesSeen: {}, sample: [] };
    }
  };
  const queries = [await run({ league: signedLeagueCode(league, codes), marketType: "MONEY", limit: "200" }), await run({ marketType: "MONEY", limit: "200" })];
  const note = client.catalogFallbackNote;
  return { id: "signed_v3", league, queries, ...(note ? { note } : {}) };
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
    if (names.some((n) => clubNamed(template, club, n))) return c;
  }
  return null;
}

export function partnerAsksForOpposing(market: RawMarket, template: LeagueTemplate, opposing: string, opposingCompetitorId: string | null): PmBookLevel[] {
  const levels: PmBookLevel[] = [];
  for (const sel of flatSelections(market)) {
    const byId = opposingCompetitorId !== null && sel.competitor_id !== undefined && sel.competitor_id !== null && String(sel.competitor_id) === opposingCompetitorId;
    const byName = [sel.name, sel.display_name].some((n) => typeof n === "string" && clubNamed(template, opposing, n));
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
        return { id: "partner_mm", book: asksBook(partnerAsksForOpposing(market, clubs.template, clubs.opposing, oppId), `partner_mm:${market.id}`), listing: { marketId: String(market.id), key: String(event.event_id) } };
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
  let signedHost = env.REFERENCE_BOOK_SIGNED_HOST?.trim().replace(/\/+$/, "");
  const signedKeyId = env.REFERENCE_BOOK_SIGNED_KEY_ID?.trim();
  const signedPem = env.REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM?.trim();
  // the Novig hedge route prices from this read; offered without a reference host, the venue's
  // public catalog is read on the host the holder-position reader already uses
  if (!signedHost && !signedKeyId && !signedPem && novigRouteOffered(env) && env.VENUE_API_HOST?.trim()) {
    signedHost = env.VENUE_API_HOST.trim().replace(/\/+$/, "");
    notes.push("reference book A: no REFERENCE_BOOK_SIGNED_HOST; the hedge route on that venue reads its public catalog on VENUE_API_HOST");
  }
  if (signedHost || signedKeyId || signedPem) {
    const leagues = parseSignedLeagueCodes(env.REFERENCE_BOOK_SIGNED_LEAGUES);
    notes.push(...leagues.notes);
    const signedOpts: SignedSourceOptions = { leagueCodes: leagues.codes };
    if (signedHost && signedKeyId && signedPem) {
      try {
        sources.push(signedSource(new VenueClient({ host: signedHost, signer: signerFromPem(signedKeyId, signedPem), fetchImpl }), signedOpts));
      } catch (err) {
        notes.push(`reference book A: key unusable (${String(err instanceof Error ? err.message : err)})`);
      }
    } else if (signedHost && !signedKeyId && !signedPem) {
      // the venue publishes its catalog and books unsigned; a reference needs nothing more
      sources.push(signedSource(new VenueClient({ host: signedHost, fetchImpl }), signedOpts));
      notes.push("reference book A: reading the public catalog (no key set)");
    } else {
      notes.push("reference book A: set the host alone for public reads, or host, key id and private key together; off");
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

/** Is the signed-dialect venue named as a hedge venue (EVENT_HEDGE_VENUES; unset offers every route)? Mirrors hedgeRouting.hedgeVenuesFromEnv without importing it. */
export function novigRouteOffered(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.EVENT_HEDGE_VENUES ?? "").trim();
  if (!raw) return true;
  return raw.split(",").some((w) => w.trim().toLowerCase() === "novig");
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
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const err = r.reason;
    // the venue answered with a code (rate limit, bad key): keep the code; anything else is unreachable
    if ((err instanceof VenueApiError || err instanceof PlaysApiError) && err.status > 0) {
      return { id: sources[i].id, book: null, reason: `venue_${err.code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` };
    }
    return { id: sources[i].id, book: null, reason: `unreachable: ${String(err instanceof Error ? err.message : err).slice(0, 80)}` };
  });
}
