/**
 * The demo's figures: a venue's own positions page, with one Lock in button on each row.
 *
 * A position is a count of $1 shares of one outcome of a game, held on one of the three
 * venues (its home). It is simulated: the pick, the size and the price it was bought at come
 * from the game's id, never from how the game prices. What is real is what it is worth now.
 * Two amounts are worked out for the whole position, from the books as they were read:
 *
 *   VALUE   what the home venue's bids pay for all of it now, level by level, its fee out.
 *   LOCK    the payout ($1 a share) less what the same count of every other outcome costs
 *           today, each share from whichever venue asks least with its fee in. That is paid
 *           when the game settles, whichever outcome it settles on.
 *
 * The button is on offer when the lock is at least $1 above the value. Otherwise the row has
 * the button greyed, and no reason is given.
 *
 * Which games: on two of the three venues or more, and a whole set (fullSet.ts): a game whose
 * outcomes are not every way it can end has no lock, so it is no position here. Which rows: at
 * most ten a venue, better known leagues first and the soonest game first, no more than four
 * from one league. The order never looks at a price.
 *
 * What goes out is the row and these amounts. No book, no level, what the other side cost,
 * how many venues were read, or any venue but the home one.
 *
 * Money is whole cents: a value is rounded down and a cost is rounded up.
 */

import { allInAskCents, allInBidCents } from "./fees";
import { notAFullSet } from "./fullSet";
import { VENUES, VENUE_SHORT, type GameRow, type OutcomeBook, type OutcomeRow, type Snapshot, type Venue } from "./types";

/** the sizes a position can have, in $1 shares, largest first */
export const DEMO_SIZES = [2_000, 1_000, 500, 200, 100, 50] as const;
/** the size a position's id names: one of these, by its hash. A thinner home book steps it down DEMO_SIZES. */
export const DEMO_WANTED = [500, 1_000, 2_000, 1_000, 500, 200] as const;
/** the most positions shown for one home venue */
export const DEMO_MAX_POSITIONS = 10;
/** and the most of them from one league */
export const DEMO_MAX_PER_LEAGUE = 4;
/** the button is on offer when the lock is at least this far above the value */
export const DEMO_MIN_GAIN_CENTS = 100;
/** a position is one whose pick is priced inside these, in cents: a 1¢ or 99¢ pick is not a position anyone locks */
export const DEMO_PRICE_MIN_CENTS = 10;
export const DEMO_PRICE_MAX_CENTS = 90;

export interface DemoPosition {
  id: string;
  /** the outcome held */
  pick: string;
  /** the game: "Knicks vs Celtics" */
  game: string;
  competition: string;
  startsAt: string;
  shares: number;
  /** what a share was bought at, whole cents. Simulated. */
  entryCents: number;
  /** the home venue's price of the pick now, cents: the middle of its best bid and ask, or the bid alone */
  nowCents: number;
  /** shares × the entry price */
  stakeCents: number;
  /** shares × $1: what the position pays when its outcome wins */
  payoutCents: number;
  /** what closing the whole position on the home venue pays now, its fee out */
  valueCents: number;
  /** what the lock pays when the game settles; null when the button is not on offer */
  lockCents: number | null;
  /** the lock less the value; null with it */
  moreCents: number | null;
}

export interface DemoHome {
  venue: Venue;
  name: string;
  positions: DemoPosition[];
}

export interface DemoPayload {
  /** when the books were read; null before the first read */
  at: string | null;
  homes: DemoHome[];
}

/** What a position was given when it was first seen, so its size and entry price do not move with the market. */
export interface DemoHeld {
  eventId: string;
  shares: number;
  entryCents: number;
}
export type DemoMemo = Map<string, DemoHeld>;

const EPS = 1e-9;

/** FNV-1a: a small number from a string, the same every time */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const crossed = (b: OutcomeBook): boolean => Boolean(b.bids[0] && b.asks[0] && b.bids[0].price >= b.asks[0].price);
const bookOn = (o: OutcomeRow, venue: Venue): OutcomeBook | null => o.quotes.find((q) => q.venue === venue)?.book ?? null;
const isDraw = (o: OutcomeRow): boolean => o.side === "DRAW" || /^(draw|tie)$/i.test(o.name.trim());

/** What the home bids pay for `shares`, best level first, the fee out of each level. */
export function closeAtHome(book: OutcomeBook | null, venue: Venue, shares: number): { filled: number; cents: number } {
  if (!book || crossed(book)) return { filled: 0, cents: 0 };
  let left = shares;
  let cents = 0;
  for (const l of book.bids) {
    if (left <= EPS) break;
    const take = Math.min(left, l.size);
    cents += take * allInBidCents(venue, l.price);
    left -= take;
  }
  return { filled: shares - left, cents };
}

/** What `shares` of one outcome cost, each share from whichever venue asks least with its fee in; null when that many are not on offer. */
export function cheapestAcross(outcome: OutcomeRow, shares: number): number | null {
  const offers: { allIn: number; size: number }[] = [];
  for (const q of outcome.quotes) {
    if (!q.book || crossed(q.book)) continue;
    for (const l of q.book.asks) offers.push({ allIn: allInAskCents(q.venue, l.price), size: l.size });
  }
  offers.sort((a, b) => a.allIn - b.allIn);
  let left = shares;
  let cents = 0;
  for (const o of offers) {
    if (left <= EPS) break;
    const take = Math.min(left, o.size);
    cents += take * o.allIn;
    left -= take;
  }
  return left > EPS ? null : cents;
}

export interface DemoQuote {
  /** what closing all of it at home pays, fee out; null when the home book does not take all of it */
  valueCents: number | null;
  /** the payout less what the other outcomes cost; null when they are not all on offer, or cost the payout or more */
  lockCents: number | null;
}

/** The two amounts for `shares` of one outcome held on `home`. The game is taken to be a whole set: the caller checks. */
export function quoteOf(game: GameRow, pickIndex: number, home: Venue, shares: number): DemoQuote {
  const close = closeAtHome(bookOn(game.outcomes[pickIndex], home), home, shares);
  const valueCents = close.filled >= shares - EPS ? Math.floor(close.cents + EPS) : null;
  let cover: number | null = 0;
  for (const [j, other] of game.outcomes.entries()) {
    if (j === pickIndex) continue;
    const leg = cheapestAcross(other, shares);
    if (leg === null) {
      cover = null;
      break;
    }
    cover += leg;
  }
  const payoutCents = shares * 100;
  const coverCents = cover === null ? null : Math.ceil(cover - EPS);
  return { valueCents, lockCents: coverCents === null || coverCents >= payoutCents ? null : payoutCents - coverCents };
}

function gameName(game: GameRow): string {
  const teams = game.outcomes.filter((o) => !isDraw(o)).map((o) => o.name);
  return teams.length === 2 ? `${teams[0]} vs ${teams[1]}` : game.name;
}

/** The price a share was bought at: a few cents from where the pick stands when the position is first seen, four in five below it. */
function entryOf(h: number, nowCents: number): number {
  const step = 2 + ((h >>> 16) % 9);
  const above = (h >>> 12) % 5 === 0;
  const entry = Math.round(above ? nowCents + 1 + (step % 5) : nowCents - step);
  return Math.min(97, Math.max(3, entry));
}

function positionOf(game: GameRow, home: Venue, memo?: DemoMemo): DemoPosition | null {
  const venues = VENUES.filter((v) => game.outcomes.some((o) => bookOn(o, v)));
  if (venues.length < 2 || !venues.includes(home) || notAFullSet(game) !== null) return null;
  // the outcomes this venue would show as a position with a price: a bid, and a book that is not crossed
  const held = game.outcomes.map((o, i) => ({ i, book: bookOn(o, home) })).filter((x): x is { i: number; book: OutcomeBook } => x.book !== null && x.book.bids.length > 0 && !crossed(x.book));
  if (!held.length) return null;
  const h = hash(`${game.eventId}|${home}`);
  const pick = held[h % held.length];
  const bid = pick.book.bids[0].price;
  const ask = pick.book.asks[0]?.price;
  const nowCents = Math.round((ask === undefined ? bid : (bid + ask) / 2) * 1000) / 10;
  if (nowCents < DEMO_PRICE_MIN_CENTS || nowCents > DEMO_PRICE_MAX_CENTS) return null;

  // the size it was given when first seen, while the home book still closes all of it; else the
  // largest size at or under the one its id names that the home book closes
  const id = `${home}:${game.eventId}:${pick.i}`;
  const was = memo?.get(id);
  const wanted = DEMO_WANTED[(h >>> 8) % DEMO_WANTED.length];
  const sizes = [...(was ? [was.shares] : []), ...DEMO_SIZES.filter((s) => s <= (was?.shares ?? wanted))];
  let shares = 0;
  let quote: DemoQuote | null = null;
  for (const s of sizes) {
    const q = quoteOf(game, pick.i, home, s);
    if (q.valueCents === null) continue;
    shares = s;
    quote = q;
    break;
  }
  if (!quote || quote.valueCents === null) return null;
  const entryCents = was?.entryCents ?? entryOf(h, nowCents);
  memo?.set(id, { eventId: game.eventId, shares, entryCents });

  const more = quote.lockCents === null ? null : quote.lockCents - quote.valueCents;
  const offered = more !== null && more >= DEMO_MIN_GAIN_CENTS;
  return {
    id,
    pick: game.outcomes[pick.i].name,
    game: gameName(game),
    competition: game.competition,
    startsAt: game.startsAt,
    shares,
    entryCents,
    nowCents,
    stakeCents: shares * entryCents,
    payoutCents: shares * 100,
    valueCents: quote.valueCents,
    lockCents: offered ? quote.lockCents : null,
    moreCents: offered ? more : null,
  };
}

/** Where a league stands in the list: the ones a reader knows first. Never a price. */
const LEAGUE_ORDER: RegExp[] = [
  /^(nba|nfl|nhl|mlb)$/i,
  /premier league|champions league|la liga|serie a|bundesliga|ligue 1|^mls$/i,
  /^(atp|wta)\b/i,
  /ncaa|college/i,
  /uefa|fifa|world cup|copa|euro/i,
];
const LOWER_TIER = /challenger|itf|futures|qualif/i;
export function leagueRank(competition: string): number {
  if (LOWER_TIER.test(competition)) return LEAGUE_ORDER.length + 1;
  const i = LEAGUE_ORDER.findIndex((r) => r.test(competition.trim()));
  return i < 0 ? LEAGUE_ORDER.length : i;
}

/** At most ten: in order, no more than four from one league; then, if there is room, the rest in order. */
function shown(positions: DemoPosition[]): DemoPosition[] {
  const taken: DemoPosition[] = [];
  const perLeague = new Map<string, number>();
  for (const p of positions) {
    if (taken.length >= DEMO_MAX_POSITIONS) break;
    const n = perLeague.get(p.competition) ?? 0;
    if (n >= DEMO_MAX_PER_LEAGUE) continue;
    perLeague.set(p.competition, n + 1);
    taken.push(p);
  }
  for (const p of positions) {
    if (taken.length >= DEMO_MAX_POSITIONS) break;
    if (!taken.includes(p)) taken.push(p);
  }
  return positions.filter((p) => taken.includes(p));
}

/**
 * `memo` is kept by the caller from one read to the next: a position keeps the size and the
 * entry price it was first given. Without it every read stands alone.
 */
export function buildDemo(s: Snapshot | null, memo?: DemoMemo): DemoPayload {
  const games = s ? [...s.games].sort((a, b) => leagueRank(a.competition) - leagueRank(b.competition) || a.startsAt.localeCompare(b.startsAt) || a.eventId.localeCompare(b.eventId)) : [];
  const homes: DemoHome[] = VENUES.map((venue) => {
    const all = games.map((g) => positionOf(g, venue, memo)).filter((p): p is DemoPosition => p !== null);
    return { venue, name: VENUE_SHORT[venue], positions: shown(all) };
  });
  if (memo && s) {
    const live = new Set(s.games.map((g) => g.eventId));
    for (const [id, held] of [...memo]) if (!live.has(held.eventId)) memo.delete(id);
  }
  return { at: s?.at ?? null, homes };
}
