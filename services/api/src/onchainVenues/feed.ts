/**
 * What is read, and how often.
 *
 * DISCOVERY (every ten minutes, paced, off the book cycle): the partner's catalog, sport by
 * competition by event, kept to the games that are live or start inside the horizon. For each,
 * the event's markets, of which one is kept: the full-game winner market. The partner's mapping
 * says which outcome is which on Polymarket International and on SX Bet.
 *
 * Which venues list a game is only known once its markets are read, one request a game, and an
 * event lists a thousand markets and more. So a pass reads a bounded number of games, soonest
 * first, and remembers the answer: two hours for a game one of these venues lists, six hours
 * for a game none does. While games are still to read the passes run back to back, so the
 * catalog fills in over the first few and the page says how many games are left. The board is
 * the games at least one of the three lists, soonest first, up to a cap.
 *
 * LIMITLESS is not in that mapping (the partner's own page says so: "Not mapped. Find its
 * markets with List Markets"). When a listing for it does appear on an outcome it is used as it
 * is. Until then its sports markets are read from a list and tied to a game here, by the two
 * team names and the start time, and the page marks every such row. The list is the partner's;
 * when the partner refuses it to this key (it did, on 13 November 2026), it is the venue's own
 * public list of game markets instead, and the page says which. A title this cannot read, and a
 * market that could be either of two games, is left off and counted, never guessed.
 *
 * BOOKS (every cycle): one snapshot per market over the partner's stream, at most 200 markets a
 * connection (their cap), a few connections side by side. A snapshot is the book as the venue
 * last published it; the stream stamps how old that is.
 *
 * The request budget is shared with every other service that holds a key of the same
 * organisation (10 a second, their figure), so discovery is paced well under it.
 */

import {
  AggregatorApiError,
  streamKey,
  type Competition,
  type LimitlessMarket,
  type Outcome,
  type Listing,
  type Market,
  type MarketStream,
  type Sport,
  type SportEvent,
  type StreamResult,
  type Whoami,
} from "../eventCollar/crossVenue/aggregatorMarkets";
import { shareBook, sxOutcomeBook, type SxOutcome } from "./books";
import { VENUES, byVenue, type Coverage, type FeedDiagnostics, type FeedHealth, type GameRow, type OutcomeBook, type Snapshot, type Venue, type VenueBooks, type VenueQuote, type WinnerShape } from "./types";

export interface FeedSource {
  whoami(): Promise<Whoami>;
  time(): Promise<number>;
  listSports(): Promise<Sport[]>;
  listCompetitions(): Promise<Competition[]>;
  listEvents(competitionId: string): Promise<SportEvent[]>;
  listEventMarkets(eventId: string): Promise<Market[]>;
  listLimitlessMarkets(pageToken?: string): Promise<{ markets: LimitlessMarket[]; nextPageToken: string | null }>;
  /** the venue's own public list of game markets, in the same shape; asked only when the partner's list is refused or fails */
  listLimitlessPublic?(): Promise<LimitlessGameMarket[]>;
}
export type BookReader = (markets: MarketStream[]) => Promise<StreamResult[]>;

export interface FeedOptions {
  source: FeedSource;
  readBooks: BookReader;
  /** games that start within this are on the board; live games always are */
  horizonMs?: number;
  /** the most games on the board, soonest first; only games at least one of the three venues lists count */
  maxEvents?: number;
  /** the most games whose markets one pass asks for */
  maxReadsPerPass?: number;
  /** how long the answer is kept for a game none of the three lists */
  bareTtlMs?: number;
  /** the wait between two catalog requests */
  paceMs?: number;
  marketsTtlMs?: number;
  /** a competition with no game inside the horizon is asked again only after this */
  quietCompetitionTtlMs?: number;
  maxPerConnection?: number;
  parallelConnections?: number;
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// the winner market of an event
// ---------------------------------------------------------------------------

const PARTIAL = /\b(1H|2H|1Q|2Q|3Q|4Q|OT|first|second|third|fourth|half|quarter|period|inning|set|map)\b/i;
/** A market the feed has not classified, read from its title the way the partner check script does. */
const winnerByTitle = (m: Market): boolean =>
  !PARTIAL.test(m.title) && !m.line && (/\b(moneyline|money line|match winner|to win|match result)\b/i.test(m.title) || (m.outcomes.length === 2 && !m.title.includes(":") && !/\?/.test(m.title)));

const venueOf = (l: Listing): Venue | null => (l.venue === "POLYMARKET" ? "polymarket" : l.venue === "SX_BET" ? "sx_bet" : l.venue === "LIMITLESS" ? "limitless" : null);
const venuesListed = (m: Market): Set<Venue> => new Set(m.outcomes.flatMap((o) => o.listings.map(venueOf)).filter((v): v is Venue => v !== null));

/** Every market of an event that reads as its full-game winner market: two outcomes, or three with a draw. */
export const winnerCandidates = (markets: Market[]): Market[] => markets.filter((m) => !m.period && m.outcomes.length >= 2 && m.outcomes.length <= 3 && (m.type ? m.type === "MONEYLINE" : winnerByTitle(m)));

/** The full-game winner market of an event. The one on the most of these venues when several qualify. */
export function winnerMarket(markets: Market[]): Market | null {
  const full = winnerCandidates(markets);
  if (!full.length) return null;
  return [...full].sort((a, b) => venuesListed(b).size - venuesListed(a).size || Number(b.main === true) - Number(a.main === true))[0];
}

const isDraw = (o: Outcome): boolean => o.side === "DRAW" || /^(draw|tie|x)$/i.test(o.name.trim());

/**
 * For each outcome of `b`, the one outcome of `a` it is: the draw to the draw, a team to the
 * team of the same name. Null unless every outcome of `b` finds exactly one of `a` and no two
 * find the same one.
 */
export function pairOutcomes(a: Outcome[], b: Outcome[]): number[] | null {
  if (a.length !== b.length) return null;
  const taken = new Set<number>();
  const out: number[] = [];
  for (const o of b) {
    const hits = a.map((x, i) => i).filter((i) => (isDraw(o) ? isDraw(a[i]) : !isDraw(a[i]) && sameTeam(a[i].name, o.name)));
    if (hits.length !== 1 || taken.has(hits[0])) return null;
    taken.add(hits[0]);
    out.push(hits[0]);
  }
  return out;
}

export interface JoinedWinner {
  winner: Market | null;
  /** venues whose listings were brought in from another winner market of the same game */
  joined: Venue[];
  /** venues that sit in another winner market and could not be brought in */
  apart: Venue[];
}

/**
 * The feed can carry one game's winner market more than once: read on 13 November 2026, an NHL
 * game had Polymarket in its main moneyline market and SX Bet in a second one of its own
 * ("Winner including overtime"), under the same game. This brings such a venue into the chosen
 * market, and only when it is plainly the same bet: both markets typed MONEYLINE by the feed,
 * for the whole game, with the same number of outcomes, and every outcome of one finding exactly
 * one of the other by team name (pairOutcomes). Otherwise the venue is left apart and counted.
 * A listing brought in this way is marked, and the page tags its row "by names".
 */
export function joinWinner(markets: Market[]): JoinedWinner {
  const chosen = winnerMarket(markets);
  if (!chosen) return { winner: null, joined: [], apart: [] };
  const have = venuesListed(chosen);
  const outcomes = chosen.outcomes.map((o) => ({ ...o, listings: [...o.listings] }));
  const joined: Venue[] = [];
  const apart = new Set<Venue>();
  for (const other of winnerCandidates(markets)) {
    if (other === chosen) continue;
    const wanted = [...venuesListed(other)].filter((v) => !have.has(v));
    if (!wanted.length) continue;
    const pairs = chosen.type === "MONEYLINE" && other.type === "MONEYLINE" && !chosen.line && !other.line ? pairOutcomes(chosen.outcomes, other.outcomes) : null;
    if (!pairs) {
      for (const v of wanted) apart.add(v);
      continue;
    }
    other.outcomes.forEach((o, i) => {
      for (const l of o.listings) {
        const v = venueOf(l);
        if (v && wanted.includes(v)) outcomes[pairs[i]].listings.push({ ...l, joinedByNames: true });
      }
    });
    for (const v of wanted) {
      have.add(v);
      joined.push(v);
      apart.delete(v);
    }
  }
  return { winner: joined.length ? { ...chosen, outcomes } : chosen, joined, apart: [...apart].filter((v) => !have.has(v)) };
}

// ---------------------------------------------------------------------------
// what an event's markets looked like, in counts
// ---------------------------------------------------------------------------

export interface EventShape {
  listings: Record<string, number>;
  keys: Record<string, string[]>;
  byType: Record<string, Record<string, number>>;
  titles: Record<string, Record<string, string[]>>;
  candidates: WinnerShape[];
  /** markets not read as the winner market (no line, three outcomes at most) that carry one of the three venues the chosen one lacks */
  others: WinnerShape[];
  /** the three venues' listings sit in different winner markets */
  split: boolean;
  /** of the split ones: a venue was brought into the chosen market, outcome by outcome */
  joined: boolean;
  /** of the split ones: a venue could not be brought in and is left apart */
  apart: boolean;
}

/** The feed's names of this page's three venues. Nothing is kept or shown about any other venue the feed carries. */
const OURS = new Set(["POLYMARKET", "SX_BET", "LIMITLESS"]);

const shapeOf = (m: Market): WinnerShape => ({
  title: m.title.slice(0, 80),
  type: m.type ?? null,
  key: typeof (m as { marketKey?: unknown }).marketKey === "string" ? ((m as { marketKey?: string }).marketKey as string) : null,
  period: m.period ? `${m.period.unit} ${m.period.from}-${m.period.to}` : null,
  outcomes: m.outcomes.length,
  sides: m.outcomes.slice(0, 3).map((o) => o.side ?? null),
  names: m.outcomes.slice(0, 3).map((o) => o.name.slice(0, 32)),
  venues: [...new Set(m.outcomes.flatMap((o) => o.listings.map((l) => String(l.venue))))].filter((v) => OURS.has(v)).sort(),
});

const bump = (o: Record<string, number>, k: string, by = 1): void => {
  o[k] = (o[k] ?? 0) + by;
};

/** Counts over one event's markets, kept instead of the markets themselves: which venues the feed names, under which types, with which fields. */
export function eventShape(markets: Market[]): EventShape {
  const shape: EventShape = { listings: {}, keys: {}, byType: {}, titles: {}, candidates: [], others: [], split: false, joined: false, apart: false };
  for (const m of markets) {
    // the type, the part of the game when it is not the whole of it, and how many outcomes
    const type = `${m.type ?? "none"}${m.period ? `+${m.period.unit}` : ""}/${m.outcomes.length > 3 ? "4+" : m.outcomes.length}`;
    const seen = new Set<string>();
    for (const o of m.outcomes) {
      for (const l of o.listings) {
        const v = String(l.venue);
        if (!OURS.has(v)) continue;
        bump(shape.listings, v);
        shape.keys[v] ??= Object.keys(l).sort();
        seen.add(v);
      }
    }
    for (const v of seen) {
      bump((shape.byType[v] ??= {}), type);
      const titles = ((shape.titles[v] ??= {})[type] ??= []);
      if (titles.length < 2) titles.push(m.title.slice(0, 80));
    }
  }
  const candidates = winnerCandidates(markets);
  const chosen = winnerMarket(markets);
  // the chosen one first, then the others that carry one of the three
  shape.candidates = [...(chosen ? [chosen] : []), ...candidates.filter((m) => m !== chosen && venuesListed(m).size > 0)].slice(0, 4).map(shapeOf);
  const join = joinWinner(markets);
  shape.joined = join.joined.length > 0;
  shape.apart = join.apart.length > 0;
  const have = chosen ? venuesListed(chosen) : new Set<Venue>();
  const across = new Set(candidates.flatMap((m) => [...venuesListed(m)]));
  shape.split = chosen !== null && across.size > have.size;
  shape.others = markets
    .filter((m) => !candidates.includes(m) && !m.line && m.outcomes.length <= 3 && [...venuesListed(m)].some((v) => !have.has(v) && !across.has(v)))
    .slice(0, 3)
    .map(shapeOf);
  return shape;
}

// ---------------------------------------------------------------------------
// tying a Limitless market to a game by its words
// ---------------------------------------------------------------------------

const STOP = new Set(["fc", "cf", "sc", "afc", "ac", "cd", "club", "the", "and", "de", "team"]);
const words = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));

/** Two spellings of one team: the same words, or the shorter one's words all inside the longer (a nickname inside a full name). */
export function sameTeam(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w)) && short.some((w) => w.length >= 4);
}

const VERSUS = /\s+(?:@|vs\.?|v\.?|at)\s+/i;
/** The two sides of a game from its name ("Royals @ Tigers", "Belgium vs Italy"); null when it is not two sides. */
export function teamsOf(name: string): [string, string] | null {
  const parts = name.split(VERSUS).map((p) => p.trim());
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

export interface LimitlessTitle {
  teams: [string, string];
  /** the side this market pays on: a team's name, or "Draw" */
  pick: string;
}

/**
 * A child of a grouped game market is titled with its group: "UEFA NL, Belgium vs Italy: Belgium",
 * and its Yes token is that pick. The one other shape read is a single market on a game whose two
 * outcomes are named for the two teams (limitlessSides). A market on a map, a half or a prop, and
 * a single market whose Yes side is not named, are left alone.
 */
export function parseLimitlessTitle(title: string): LimitlessTitle | null {
  const colon = title.lastIndexOf(":");
  if (colon < 0) return null;
  const pick = title.slice(colon + 1).trim();
  const head = title.slice(0, colon).trim();
  const game = head.includes(",") ? head.slice(head.indexOf(",") + 1).trim() : head;
  const teams = teamsOf(game);
  if (!teams || !pick) return null;
  if (!/^draw$/i.test(pick) && !sameTeam(pick, teams[0]) && !sameTeam(pick, teams[1])) return null;
  return { teams, pick };
}

/** The game of a title with no pick after it: "LoL, T1 vs Gen.G" or "T1 vs Gen.G". */
export function limitlessGame(title: string): [string, string] | null {
  if (title.includes(":")) return null;
  return teamsOf(title.includes(",") ? title.slice(title.indexOf(",") + 1).trim() : title.trim());
}

const SPORTS_CATEGORY = /sport|football|soccer|basketball|hockey|baseball|tennis|cricket|rugby|mma|boxing|golf|\bnfl\b|\bnba\b|\bnhl\b|\bmlb\b/i;
export const isLimitlessSports = (m: LimitlessMarket): boolean => m.categories.some((c) => SPORTS_CATEGORY.test(c));

/**
 * Which game a Limitless market is on, beyond the two team names.
 *
 * Its own public list names the match's start, and that is used when it is there: the same game
 * starts within three hours of the feed's start for it.
 *
 * The partner's list names only the close. Limitless's football markets close a day after
 * kick-off (read from its public list on 13 November 2026: 138 of 141 closed exactly 24 hours
 * after the start they name, the other three two months after), so the window on the close runs
 * from half a day before the start to a day and a half after it.
 *
 * Either way, a market that fits two games on the board is tied to neither.
 */
const START_APART_MS = 3 * 3_600_000;
const CLOSE_BEFORE_MS = 12 * 3_600_000;
const CLOSE_AFTER_MS = 36 * 3_600_000;

/** A Limitless market with the match's start, when the list it came from names one. */
export type LimitlessGameMarket = LimitlessMarket & { startsAt?: string };

// ---------------------------------------------------------------------------
// what discovery keeps
// ---------------------------------------------------------------------------

interface FoundListing {
  venue: Venue;
  id: string;
  executable: boolean | null;
  matchedBy: "feed" | "names";
  stream: MarketStream;
  sxOutcome?: SxOutcome;
}
interface FoundOutcome {
  name: string;
  side: string | null;
  listings: FoundListing[];
}
interface FoundGame {
  event: SportEvent;
  competitionId: string;
  competition: string;
  sport: string;
  marketTitle: string;
  outcomes: FoundOutcome[];
}

/** The two sides of a game by its outcomes, the draw aside; null when that is not two. */
const sidesOf = (g: FoundGame): [string, string] | null => {
  const teams = g.outcomes.filter((o) => o.side !== "DRAW" && !/^(draw|tie|x)$/i.test(o.name.trim()));
  return teams.length === 2 ? [teams[0].name, teams[1].name] : null;
};

const tail = (s: string, n = 8): string => (s.length > n ? `…${s.slice(-n)}` : s);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function foundListing(l: Listing): FoundListing | null {
  const found = listingAsFound(l);
  // brought in from another winner market of the same game (joinWinner): the row says so
  return found && (l as { joinedByNames?: unknown }).joinedByNames === true ? { ...found, matchedBy: "names" } : found;
}

function listingAsFound(l: Listing): FoundListing | null {
  const executable = typeof l.executable === "boolean" ? l.executable : null;
  if (l.venue === "POLYMARKET") {
    const tokenId = str((l as { tokenId?: unknown }).tokenId);
    return tokenId ? { venue: "polymarket", id: `token ${tail(tokenId)}`, executable, matchedBy: "feed", stream: { venue: "POLYMARKET", tokenId } } : null;
  }
  if (l.venue === "SX_BET") {
    const hash = str((l as { marketHash?: unknown }).marketHash);
    const outcome = (l as { outcome?: unknown }).outcome;
    if (!hash || (outcome !== "OUTCOME_ONE" && outcome !== "OUTCOME_TWO")) return null;
    return { venue: "sx_bet", id: `${hash.slice(0, 10)}… ${outcome === "OUTCOME_ONE" ? "one" : "two"}`, executable, matchedBy: "feed", stream: { venue: "SX_BET", marketHash: hash.toLowerCase() }, sxOutcome: outcome };
  }
  if (l.venue === "LIMITLESS") {
    // the partner's mapping does not carry this venue today; when it does, the listing is taken as it comes
    const x = l as Record<string, unknown>;
    const marketId = str(x.marketSlug) ?? str(x.marketId) ?? str(x.slug);
    const outcomeId = str(x.tokenId) ?? str(x.outcomeId);
    return marketId && outcomeId ? { venue: "limitless", id: `${marketId} ${tail(outcomeId)}`, executable, matchedBy: "feed", stream: { venue: "LIMITLESS", kind: "CLOB", marketId, outcomeId } } : null;
  }
  return null;
}

const emptyHealth = (): FeedHealth => ({
  capabilities: [],
  discoveredAt: null,
  discoveryMs: null,
  notes: [],
  competitions: 0,
  eventsInHorizon: 0,
  eventsRead: 0,
  eventsPending: 0,
  eventsOverCap: 0,
  limitless: { state: "not_read", markets: 0, sports: 0, matched: 0 },
  books: { asked: 0, read: 0, empty: 0, errors: {}, ms: null },
});

const words160 = (err: unknown): string => String(err instanceof Error ? err.message : err).slice(0, 160);

export class OnchainFeed {
  private readonly source: FeedSource;
  private readonly readBooks: BookReader;
  private readonly horizonMs: number;
  private readonly maxEvents: number;
  private readonly paceMs: number;
  private readonly marketsTtlMs: number;
  private readonly maxPerConnection: number;
  private readonly parallel: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly quietTtlMs: number;
  private readonly maxReadsPerPass: number;
  private readonly bareTtlMs: number;
  private readonly marketsCache = new Map<string, { at: number; winner: Market | null; listed: boolean; name: string; competition: string; shape: EventShape }>();
  private readonly quietCompetitions = new Map<string, number>();
  private found: FoundGame[] = [];
  private coverage: Coverage[] = [];
  private unmatched: string[] = [];
  private health: FeedHealth = emptyHealth();
  private discovering = false;

  constructor(opts: FeedOptions) {
    this.source = opts.source;
    this.readBooks = opts.readBooks;
    this.horizonMs = opts.horizonMs ?? 48 * 3_600_000;
    this.maxEvents = Math.max(1, opts.maxEvents ?? 120);
    this.paceMs = opts.paceMs ?? 350;
    this.marketsTtlMs = opts.marketsTtlMs ?? 2 * 3_600_000;
    this.maxReadsPerPass = Math.max(1, opts.maxReadsPerPass ?? 150);
    this.bareTtlMs = opts.bareTtlMs ?? 6 * 3_600_000;
    this.quietTtlMs = opts.quietCompetitionTtlMs ?? 60 * 60_000;
    this.maxPerConnection = Math.max(1, Math.min(200, opts.maxPerConnection ?? 200));
    this.parallel = Math.max(1, opts.parallelConnections ?? 3);
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  get discoveredAt(): string | null {
    return this.health.discoveredAt;
  }

  get busy(): boolean {
    return this.discovering;
  }

  /** games inside the window whose markets the last pass had no room to read */
  get pending(): number {
    return this.health.eventsPending;
  }

  /** One pass over the catalog. It never throws: what could not be read is kept in words for the page. */
  async discover(nowMs = Date.now()): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    const t0 = Date.now();
    const notes: string[] = [];
    const health = emptyHealth();
    try {
      try {
        await this.source.time();
        health.capabilities = (await this.source.whoami()).capabilities ?? [];
      } catch (err) {
        notes.push(`the key check did not pass: ${words160(err)}`);
      }
      const sports = new Map((await this.source.listSports()).map((s) => [s.id, s.name]));
      await this.sleep(this.paceMs);
      const competitions = await this.source.listCompetitions();
      health.competitions = competitions.length;

      // every game inside the horizon, with its competition
      const inHorizon: { event: SportEvent; competition: Competition }[] = [];
      let failedCompetitions = 0;
      for (const c of competitions) {
        const quietAt = this.quietCompetitions.get(c.id);
        if (quietAt !== undefined && nowMs - quietAt < this.quietTtlMs) continue;
        await this.sleep(this.paceMs);
        try {
          const before = inHorizon.length;
          for (const e of await this.source.listEvents(c.id)) {
            const start = Date.parse(e.startTime ?? "");
            if (!Number.isFinite(start)) continue;
            // a game the feed still calls scheduled a few hours after its start is kept: the status can lag
            if (e.status === "LIVE" || (start <= nowMs + this.horizonMs && start >= nowMs - 4 * 3_600_000)) inHorizon.push({ event: e, competition: c });
          }
          if (inHorizon.length === before) this.quietCompetitions.set(c.id, nowMs);
          else this.quietCompetitions.delete(c.id);
        } catch (err) {
          failedCompetitions += 1;
          if (err instanceof AggregatorApiError && (err.status === 401 || err.status === 403)) throw err;
        }
      }
      if (failedCompetitions) notes.push(`${failedCompetitions} of ${competitions.length} competitions did not answer`);
      inHorizon.sort((a, b) => Date.parse(a.event.startTime ?? "") - Date.parse(b.event.startTime ?? ""));
      health.eventsInHorizon = inHorizon.length;

      // the winner market of each, from what is remembered when that is fresh; a bounded number of new reads a pass
      const found: FoundGame[] = [];
      const coverage = new Map<string, Coverage>();
      let failedEvents = 0;
      let reads = 0;
      for (const { event, competition } of inHorizon) {
        let entry = this.marketsCache.get(event.id);
        const fresh = entry !== undefined && nowMs - entry.at < (entry.listed ? this.marketsTtlMs : this.bareTtlMs);
        if (!fresh && reads < this.maxReadsPerPass) {
          reads += 1;
          await this.sleep(this.paceMs);
          try {
            const markets = await this.source.listEventMarkets(event.id);
            const winner = joinWinner(markets).winner;
            entry = { at: nowMs, winner, listed: winner !== null && venuesListed(winner).size > 0, name: event.name, competition: competition.name, shape: eventShape(markets) };
            this.marketsCache.set(event.id, entry);
          } catch (err) {
            failedEvents += 1;
            if (err instanceof AggregatorApiError && (err.status === 401 || err.status === 403)) throw err;
          }
        }
        // never read, and this pass had no room for it: the next pass starts where this one stopped
        if (!entry) {
          health.eventsPending += 1;
          continue;
        }
        health.eventsRead += 1;
        const sport = sports.get(competition.sportId ?? "") ?? "";
        const cov = coverage.get(competition.id) ?? { competitionId: competition.id, competition: competition.name, sport, events: 0, withWinner: 0, on: byVenue(() => 0), onTwo: 0, onThree: 0 };
        coverage.set(competition.id, cov);
        cov.events += 1;
        const winner = entry.winner;
        if (!winner) continue;
        cov.withWinner += 1;
        found.push({
          event,
          competitionId: competition.id,
          competition: competition.name,
          sport,
          marketTitle: winner.title,
          outcomes: winner.outcomes.map((o) => ({ name: o.name, side: o.side ?? null, listings: o.listings.map(foundListing).filter((l): l is FoundListing => l !== null) })),
        });
      }
      if (failedEvents) notes.push(`the markets of ${failedEvents} games did not answer`);
      const keep = new Set(inHorizon.map((c) => c.event.id));
      for (const id of [...this.marketsCache.keys()]) if (!keep.has(id)) this.marketsCache.delete(id);
      health.diagnostics = this.diagnostics();

      const unmatched = await this.addLimitless(found, health, notes);

      for (const g of found) {
        const cov = coverage.get(g.competitionId);
        if (!cov) continue;
        const on = VENUES.filter((v) => g.outcomes.some((o) => o.listings.some((l) => l.venue === v)));
        for (const v of on) cov.on[v] += 1;
        if (on.length >= 2) cov.onTwo += 1;
        if (on.length >= 3) cov.onThree += 1;
      }

      // the board: the games at least one of the three lists, soonest first, up to the cap
      const listed = found.filter((g) => g.outcomes.some((o) => o.listings.length > 0));
      health.eventsOverCap = Math.max(0, listed.length - this.maxEvents);
      this.found = listed.slice(0, this.maxEvents);
      this.coverage = [...coverage.values()].sort((a, b) => b.onTwo - a.onTwo || b.events - a.events || a.competition.localeCompare(b.competition));
      this.unmatched = unmatched;
    } catch (err) {
      const refused = err instanceof AggregatorApiError && (err.status === 401 || err.status === 403);
      notes.push(refused ? `the partner refused the key (${(err as AggregatorApiError).status} ${(err as AggregatorApiError).code}): nothing was read` : `discovery stopped: ${words160(err)}`);
    } finally {
      health.discoveredAt = new Date(nowMs).toISOString();
      health.discoveryMs = Date.now() - t0;
      health.notes = notes;
      health.books = this.health.books;
      this.health = health;
      this.discovering = false;
    }
  }

  /** Limitless's own list, its sports markets tied to the games found. Returns the titles it could not tie. */
  private async addLimitless(found: FoundGame[], health: FeedHealth, notes: string[]): Promise<string[]> {
    const mapped = found.some((g) => g.outcomes.some((o) => o.listings.some((l) => l.venue === "limitless")));
    const all: LimitlessGameMarket[] = [];
    let source: "partner" | "venue" = "partner";
    try {
      let pageToken: string | undefined;
      for (let page = 0; page < 40; page += 1) {
        await this.sleep(this.paceMs);
        const r = await this.source.listLimitlessMarkets(pageToken);
        all.push(...r.markets);
        if (!r.nextPageToken) break;
        pageToken = r.nextPageToken;
      }
    } catch (err) {
      const refused = err instanceof AggregatorApiError && err.status === 403;
      const why = refused ? "the key is not allowed to read the partner's Limitless list (403)" : `the partner's Limitless list did not answer: ${words160(err)}`;
      all.length = 0;
      try {
        if (!this.source.listLimitlessPublic) throw new Error("no other list to read");
        await this.sleep(this.paceMs);
        all.push(...(await this.source.listLimitlessPublic()));
        source = "venue";
        notes.push(`${why}; its game markets were read from Limitless's own public list instead`);
      } catch (inner) {
        health.limitless = { state: refused ? "refused" : "failed", markets: 0, sports: 0, matched: 0, detail: words160(err) };
        notes.push(`${why}, and Limitless's own public list was not read either (${words160(inner)}): ask the partner to allow List Markets for the key`);
        return [];
      }
    }
    const sportsMarkets = all.filter(isLimitlessSports);
    const unmatched: string[] = [];
    const near: NonNullable<FeedHealth["limitless"]["unmatchedSample"]> = [];
    let matched = 0;
    const gameOf = (teams: [string, string], m: LimitlessGameMarket): FoundGame | undefined => {
      const starts = Date.parse(m.startsAt ?? "");
      const closes = Date.parse(m.expiresAt ?? "");
      const fits = found.filter((g) => {
        const gameStart = Date.parse(g.event.startTime ?? "");
        if (!Number.isFinite(gameStart)) return false;
        // the game's two sides by its name, or, when the name is short codes ("WSH @ NJD"), by its two outcomes
        const sameTwo = [teamsOf(g.event.name), sidesOf(g)].some((mine) => mine !== null && ((sameTeam(mine[0], teams[0]) && sameTeam(mine[1], teams[1])) || (sameTeam(mine[0], teams[1]) && sameTeam(mine[1], teams[0]))));
        if (!sameTwo) return false;
        if (Number.isFinite(starts)) return Math.abs(starts - gameStart) <= START_APART_MS;
        const after = closes - gameStart;
        return Number.isFinite(closes) && after >= -CLOSE_BEFORE_MS && after <= CLOSE_AFTER_MS;
      });
      // two games it could be (the same two teams on consecutive days): neither
      return fits.length === 1 ? fits[0] : undefined;
    };
    const tie = (outcome: FoundOutcome, m: LimitlessMarket, tokenId: string): void => {
      // the partner's own listing wins when it has one
      if (outcome.listings.some((l) => l.venue === "limitless")) return;
      outcome.listings.push({ venue: "limitless", id: `${m.marketSlug} ${tail(tokenId)}`, executable: null, matchedBy: "names", stream: { venue: "LIMITLESS", kind: "CLOB", marketId: m.marketSlug, outcomeId: tokenId } });
      matched += 1;
    };
    for (const m of sportsMarkets) {
      const yes = m.outcomes.find((o) => /^yes$/i.test(o.name));
      const title = parseLimitlessTitle(m.title);
      if (title && yes) {
        const game = gameOf(title.teams, m);
        const outcome = game?.outcomes.find((o) => (/^draw$/i.test(title.pick) ? o.side === "DRAW" || /^(draw|tie)$/i.test(o.name) : sameTeam(o.name, title.pick)));
        if (outcome) {
          tie(outcome, m, yes.tokenId);
          continue;
        }
      }
      // a single market on the game, its two outcomes named for the two teams
      const sides = limitlessGame(m.title);
      const game = sides && m.outcomes.length === 2 ? gameOf(sides, m) : undefined;
      const pairs = game ? m.outcomes.map((lo) => ({ lo, outcome: game.outcomes.find((o) => sameTeam(o.name, lo.name)) })) : [];
      if (game && game.outcomes.length === 2 && pairs.length === 2 && pairs[0].outcome && pairs[1].outcome && pairs[0].outcome !== pairs[1].outcome) {
        for (const p of pairs) tie(p.outcome as FoundOutcome, m, p.lo.tokenId);
        continue;
      }
      unmatched.push(m.title);
      // for checking the pairing: a few markets left over, each with the games here that start when it does
      const starts = Date.parse(m.startsAt ?? "");
      const named = (title ? title.teams : sides)?.join(" vs ");
      if (named && Number.isFinite(starts) && near.length < 5 && !near.some((n) => n.game === named)) {
        const sameStart = found.filter((g) => Math.abs(Date.parse(g.event.startTime ?? "") - starts) <= START_APART_MS);
        near.push({ game: named, startsAt: m.startsAt as string, gamesStartingThen: sameStart.length, sample: sameStart.slice(0, 4).map((g) => `${g.event.name} [${g.outcomes.map((o) => o.name).join(" / ")}]`.slice(0, 90)) });
      }
    }
    health.limitless = { state: "listed", source, markets: all.length, sports: sportsMarkets.length, matched, ...(mapped ? { detail: "the partner's mapping carries Limitless listings; those are used first" } : {}), ...(near.length ? { unmatchedSample: near } : {}) };
    return unmatched.sort();
  }

  /** The catalog as it was read, in counts, over every game remembered. */
  private diagnostics(): FeedDiagnostics {
    const d: FeedDiagnostics = { games: 0, gamesByVenue: {}, gamesNamingTwo: 0, listingsByVenue: {}, listingKeys: {}, marketsByVenueAndType: {}, sampleTitles: {}, winner: { none: 0, one: 0, several: 0, split: 0, joined: 0, apart: 0 }, gamesWithVenueOffWinner: 0, examples: [] };
    const examples: FeedDiagnostics["examples"] = [];
    for (const e of this.marketsCache.values()) {
      d.games += 1;
      for (const [v, n] of Object.entries(e.shape.listings)) {
        bump(d.listingsByVenue, v, n);
        bump(d.gamesByVenue, v);
      }
      for (const [v, keys] of Object.entries(e.shape.keys)) d.listingKeys[v] ??= keys;
      for (const [v, types] of Object.entries(e.shape.byType)) for (const [t, n] of Object.entries(types)) bump((d.marketsByVenueAndType[v] ??= {}), t, n);
      for (const [v, types] of Object.entries(e.shape.titles)) {
        for (const [t, titles] of Object.entries(types)) {
          const kept = ((d.sampleTitles[v] ??= {})[t] ??= []);
          for (const title of titles) if (kept.length < 2 && !kept.includes(title)) kept.push(title);
        }
      }
      const n = e.shape.candidates.length;
      if (n === 0) d.winner.none += 1;
      else if (n === 1) d.winner.one += 1;
      else d.winner.several += 1;
      if (e.shape.split) d.winner.split += 1;
      if (e.shape.joined) d.winner.joined += 1;
      if (e.shape.apart) d.winner.apart += 1;
      if (e.shape.others.length) d.gamesWithVenueOffWinner += 1;
      const named = VENUES.filter((v) => (e.shape.listings[v === "polymarket" ? "POLYMARKET" : v === "sx_bet" ? "SX_BET" : "LIMITLESS"] ?? 0) > 0).length;
      if (named > 1) d.gamesNamingTwo += 1;
      const kind = e.shape.apart ? "apart" : e.shape.others.length ? "off" : e.shape.joined ? "joined" : null;
      if (kind) examples.push({ kind, game: e.name, competition: e.competition, markets: e.shape.candidates, others: e.shape.others });
    }
    // each kind gets room: games left apart, games with a venue off the winner market, games joined
    const of = (kind: string, n: number): typeof examples => examples.filter((x) => x.kind === kind).slice(0, n);
    d.examples = [...of("apart", 3), ...of("off", 2), ...of("joined", 2)];
    return d;
  }

  /** One snapshot of every book of every game found. It never throws. */
  async snapshot(nowMs = Date.now()): Promise<Snapshot> {
    const t0 = Date.now();
    const streams = new Map<string, MarketStream>();
    for (const g of this.found) for (const o of g.outcomes) for (const l of o.listings) streams.set(streamKey(l.stream), l.stream);
    const asked = [...streams.values()];
    const results = new Map<string, StreamResult>();
    const errors: Record<string, number> = {};
    const chunks: MarketStream[][] = [];
    for (let i = 0; i < asked.length; i += this.maxPerConnection) chunks.push(asked.slice(i, i + this.maxPerConnection));
    for (let i = 0; i < chunks.length; i += this.parallel) {
      await Promise.all(
        chunks.slice(i, i + this.parallel).map(async (chunk) => {
          try {
            for (const r of await this.readBooks(chunk)) results.set(streamKey(r.market), r);
          } catch (err) {
            // a connection that never opened: every market on it is without a book, for the same reason
            for (const m of chunk) results.set(streamKey(m), { market: m, book: null, error: { code: "STREAM", message: words160(err) } });
          }
        }),
      );
    }
    let read = 0;
    let empty = 0;
    const perVenue = byVenue<VenueBooks>(() => ({ asked: 0, read: 0, empty: 0, errors: {} }));
    const venueOfStream = (m: MarketStream): Venue | null => (m.venue === "POLYMARKET" ? "polymarket" : m.venue === "SX_BET" ? "sx_bet" : m.venue === "LIMITLESS" ? "limitless" : null);
    const quote = (l: FoundListing): VenueQuote => {
      const r = results.get(streamKey(l.stream));
      const base = { venue: l.venue, id: l.id, executable: l.executable, matchedBy: l.matchedBy };
      if (!r || !r.book) return { ...base, book: null, error: r?.error ? `${r.error.code}${r.error.message ? `: ${r.error.message}` : ""}`.slice(0, 120) : "no answer" };
      const book: OutcomeBook = l.venue === "sx_bet" && l.sxOutcome ? sxOutcomeBook(r.book, l.sxOutcome) : shareBook(r.book);
      return { ...base, book };
    };
    for (const r of results.values()) {
      const v = venueOfStream(r.market);
      const mine = v ? perVenue[v] : null;
      if (mine) mine.asked += 1;
      if (r.book) {
        read += 1;
        if (mine) mine.read += 1;
        if (!r.book.bids.length && !r.book.asks.length) {
          empty += 1;
          if (mine) mine.empty += 1;
        }
      } else {
        const code = r.error?.code ?? "UNKNOWN";
        bump(errors, code);
        if (mine) bump(mine.errors, code);
      }
    }
    const games: GameRow[] = this.found.map((g) => ({
      eventId: g.event.id,
      name: g.event.name,
      competitionId: g.competitionId,
      competition: g.competition,
      sport: g.sport,
      startsAt: g.event.startTime ?? "",
      status: g.event.status ?? "",
      marketTitle: g.marketTitle,
      outcomes: g.outcomes.map((o) => ({ name: o.name, side: o.side, quotes: o.listings.map(quote) })),
    }));
    this.health = { ...this.health, books: { asked: asked.length, read, empty, errors, ms: Date.now() - t0, byVenue: perVenue } };
    return { at: new Date(nowMs).toISOString(), games, coverage: this.coverage, unmatchedLimitless: this.unmatched, feed: this.health };
  }
}
