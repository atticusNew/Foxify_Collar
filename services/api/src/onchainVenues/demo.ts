/**
 * The demo's figures: a venue's positions list with one Lock in line under each row.
 *
 * A position here is a count of $1 shares of one outcome of a game, held on one of the three
 * venues (its home). Two things are worked out for it, for the whole position, from the books
 * as they were read:
 *
 *   CLOSE   what the home venue's bids pay for all of it now, level by level, its fee out.
 *   LOCK    what buying the same count of every other outcome costs today, each share from
 *           whichever venue asks least with its fee in. The position and that purchase
 *           together pay $1 a share whatever the result, so the position ends at the payout
 *           minus that cost.
 *
 * The line is offered when the lock ends above the close, or when the home book cannot take
 * the whole position and the lock can. Otherwise the row says so.
 *
 * Only games listed on two of the three venues or more are used, the pick and the size of each
 * position are fixed by the game's id (so they are not chosen for how they price), and the
 * payload carries amounts only: no book, no level and no venue but the home one.
 *
 * The list shows the positions with the line on offer first, and the counts beside it are of
 * every position, shown or not, so the order cannot make the line look more common than it is.
 *
 * Money is whole cents: a close is rounded down and a cost is rounded up.
 */

import { allInAskCents, allInBidCents } from "./fees";
import { VENUES, VENUE_SHORT, type GameRow, type OutcomeBook, type OutcomeRow, type Snapshot, type Venue } from "./types";

/** the position sizes the page can show, in $1 shares */
export const DEMO_SIZES = [100, 500, 1_000, 5_000] as const;
/** the most positions shown for one home venue: those with the line on offer first, then the soonest game first */
export const DEMO_MAX_POSITIONS = 40;

export type DemoState =
  /** the lock ends above closing now */
  | "lock"
  /** the home book does not take the whole position; the lock does */
  | "lock_only"
  /** closing at home pays the same or more */
  | "close_pays_more"
  /** the other outcomes are not all on offer for this size */
  | "no_lock";

export interface DemoQuote {
  shares: number;
  /** shares × $1: what the position pays when its outcome wins */
  payoutCents: number;
  /** shares the home book takes now */
  closeShares: number;
  /** what closing the whole position at home pays now, fee out; null when the home book does not take all of it */
  closeCents: number | null;
  /** what the other outcomes cost today for these shares, fees in; null when they are not all on offer */
  coverCents: number | null;
  /** payout minus that cost: where the position ends whatever the result */
  lockedCents: number | null;
  /** locked minus close; null when either is missing */
  moreCents: number | null;
  state: DemoState;
}

export interface DemoPosition {
  id: string;
  /** the outcome held */
  pick: string;
  /** the rest of the game in a few words: "vs Hawks", or "Belgium v Italy" for a draw */
  matchup: string;
  competition: string;
  sport: string;
  startsAt: string;
  /** the home venue's price of the pick now, cents: the middle of its best bid and ask, or the bid alone */
  priceCents: number;
  /** venues with a book on this game, the home one included */
  venues: number;
  /** the size the row opens at */
  shares: number;
  /** one for each of DEMO_SIZES */
  quotes: DemoQuote[];
}

export interface DemoHome {
  venue: Venue;
  name: string;
  positions: DemoPosition[];
  /** every position this venue has on a game another venue also lists, shown or not */
  total: number;
  /** of those, the ones whose opening size has the line on offer */
  offered: number;
}

export interface DemoPayload {
  /** when the books were read; null before the first read */
  at: string | null;
  sizes: number[];
  homes: DemoHome[];
}

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

export function quoteOf(game: GameRow, pickIndex: number, home: Venue, shares: number): DemoQuote {
  const payoutCents = shares * 100;
  const close = closeAtHome(bookOn(game.outcomes[pickIndex], home), home, shares);
  const whole = close.filled >= shares - EPS;
  const closeCents = whole ? Math.floor(close.cents + EPS) : null;

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
  const coverCents = cover === null ? null : Math.ceil(cover - EPS);
  // a cost at or over the payout locks nothing
  const lockedCents = coverCents === null || coverCents >= payoutCents ? null : payoutCents - coverCents;
  const moreCents = lockedCents !== null && closeCents !== null ? lockedCents - closeCents : null;
  const state: DemoState = lockedCents === null ? "no_lock" : closeCents === null ? "lock_only" : moreCents !== null && moreCents >= 1 ? "lock" : "close_pays_more";
  return { shares, payoutCents, closeShares: Math.floor(close.filled + EPS), closeCents, coverCents: lockedCents === null ? null : coverCents, lockedCents, moreCents, state };
}

function matchupOf(game: GameRow, pickIndex: number): string {
  const pick = game.outcomes[pickIndex];
  const teams = game.outcomes.filter((o) => !isDraw(o));
  if (isDraw(pick)) return teams.map((o) => o.name).join(" v ");
  const others = teams.filter((o) => o !== pick).map((o) => o.name);
  return others.length ? `vs ${others.join(", ")}` : game.name;
}

function positionOf(game: GameRow, home: Venue): DemoPosition | null {
  const venues = VENUES.filter((v) => game.outcomes.some((o) => bookOn(o, v)));
  if (venues.length < 2 || !venues.includes(home)) return null;
  // the outcomes this venue would show as a position with a price: a bid, and a book that is not crossed
  const held = game.outcomes.map((o, i) => ({ i, book: bookOn(o, home) })).filter((x): x is { i: number; book: OutcomeBook } => x.book !== null && x.book.bids.length > 0 && !crossed(x.book));
  if (!held.length) return null;
  const h = hash(`${game.eventId}|${home}`);
  const pick = held[h % held.length];
  const bid = pick.book.bids[0].price;
  const ask = pick.book.asks[0]?.price;
  const price = ask === undefined ? bid : (bid + ask) / 2;
  return {
    id: `${home}:${game.eventId}:${pick.i}`,
    pick: game.outcomes[pick.i].name,
    matchup: matchupOf(game, pick.i),
    competition: game.competition,
    sport: game.sport,
    startsAt: game.startsAt,
    priceCents: Math.round(price * 1000) / 10,
    venues: venues.length,
    shares: DEMO_SIZES[(h >>> 8) % 3],
    quotes: DEMO_SIZES.map((shares) => quoteOf(game, pick.i, home, shares)),
  };
}

/** the line is on offer at the size the row opens at */
function offeredAtOpen(p: DemoPosition): boolean {
  const q = p.quotes.find((x) => x.shares === p.shares);
  return q?.state === "lock" || q?.state === "lock_only";
}

export function buildDemo(s: Snapshot | null): DemoPayload {
  const games = s ? [...s.games].sort((a, b) => a.startsAt.localeCompare(b.startsAt)) : [];
  const homes: DemoHome[] = VENUES.map((venue) => {
    const all = games.map((g) => positionOf(g, venue)).filter((p): p is DemoPosition => p !== null);
    const on = all.filter(offeredAtOpen);
    const positions = [...on, ...all.filter((p) => !offeredAtOpen(p))].slice(0, DEMO_MAX_POSITIONS);
    return { venue, name: VENUE_SHORT[venue], positions, total: all.length, offered: on.length };
  });
  return { at: s?.at ?? null, sizes: [...DEMO_SIZES], homes };
}
