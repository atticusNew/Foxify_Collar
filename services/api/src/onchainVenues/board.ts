/**
 * The board: arithmetic over the books that were read. Nothing here is a model. Every number is
 * a venue's price, its published fee, or a difference of them.
 *
 * Two questions the page answers for each outcome a holder could be sitting on:
 *
 *   LEAVE AT HOME   what the holder's own venue pays to get out now: its best bid, fee out. On
 *                   SX Bet "getting out" is backing the other outcome against a resting offer,
 *                   which books.ts already reads as a bid.
 *
 *   COVER           what it costs to buy every other outcome of the game, each on whichever of
 *                   the three venues asks least with its fee in. Holding the position and the
 *                   cover pays $1 whoever wins, so the cover locks 100 minus its cost. When
 *                   that beats leaving at home, by more than nothing and on another venue, the
 *                   game is one where a cover on the best venue is worth more than the holder's
 *                   own exit. That is the count the summary gives.
 *
 * What the comparison leaves out, said on the page: a cover is held to the result, so the money
 * for it sits on the other venue (another chain) until then; the figures are at the best level
 * only, for the size resting there; and two venues have to settle a game the same way for a
 * cover across them to hold.
 */

import { restingUsd, walk } from "./books";
import { allInAskCents, allInBidCents } from "./fees";
import { VENUES, byVenue, type GameRow, type OutcomeBook, type Snapshot, type Venue, type VenueQuote } from "./types";

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

export interface Cell {
  venue: Venue;
  matchedBy: "feed" | "names";
  executable: boolean | null;
  /** why there is no book; absent when one was read */
  error?: string;
  bidCents: number | null;
  askCents: number | null;
  /** $1 shares at the best level */
  bidShares: number;
  askShares: number;
  allInBid: number | null;
  allInAsk: number | null;
  mid: number | null;
  /** best bid at or over best ask: a book that should not exist, so a sign the reading is wrong */
  crossed: boolean;
  /** dollars resting within 2¢ of the best bid */
  bidUsdNear: number;
  /** leaving a 1,000-share position: the shares the bids take and the average with the fee out */
  exit1000: { filled: number; allIn: number | null };
  ageMs: number | null;
}

export interface CoverLeg {
  outcome: string;
  venue: Venue;
  allInAsk: number;
  shares: number;
}
export interface Lock {
  home: Venue;
  /** the home venue's best bid with the fee out, cents */
  homeExit: number | null;
  cover: { cost: number; value: number; legs: CoverLeg[]; shares: number } | null;
  /** some leg of the cover is on a venue other than home */
  elsewhere: boolean;
  /** cover value minus home exit, cents; null when either is missing */
  betterBy: number | null;
}

export interface BoardOutcome {
  name: string;
  side: string | null;
  cells: Record<Venue, Cell | null>;
  /** widest difference between two venues' mids, cents */
  midGap: number | null;
  locks: Lock[];
}
export interface BoardGame extends Omit<GameRow, "outcomes"> {
  venues: Venue[];
  outcomes: BoardOutcome[];
}

export interface VenueSummary {
  venue: Venue;
  games: number;
  books: number;
  twoSided: number;
  noBook: number;
  crossed: number;
  medianSpread: number | null;
  medianBidUsdNear: number | null;
  /** over games whose every outcome is two-sided here: what the mids add to. 100 is a fair book. */
  medianMidSum: number | null;
  /** over outcomes two-sided here and on another venue: how far this venue's mid sits from the others' mean, cents */
  medianGapToOthers: number | null;
  /** books a 1,000-share position could leave in full */
  takes1000: number;
}
export interface CoverSummary {
  home: Venue;
  /** outcomes with a bid at home */
  withExit: number;
  /** of those, with every other outcome on offer somewhere */
  withCover: number;
  /** of those, a cover with a leg on another venue that beats leaving at home */
  elsewhereBetter: number;
  medianBetterBy: number | null;
  /** where the winning covers' legs were bought */
  legsOn: Record<Venue, number>;
}
export interface BestCover {
  game: string;
  startsAt: string;
  outcome: string;
  lock: Lock;
}

export interface Board {
  at: string;
  games: BoardGame[];
  /** games on two of the three venues or more */
  comparable: number;
  venues: VenueSummary[];
  cover: CoverSummary[];
  best: BestCover[];
}

function cellOf(q: VenueQuote): Cell {
  const book: OutcomeBook | null = q.book;
  const bid = book?.bids[0] ?? null;
  const ask = book?.asks[0] ?? null;
  const exit = book ? walk(book.bids, 1_000) : { filled: 0, avgPrice: null };
  return {
    venue: q.venue,
    matchedBy: q.matchedBy,
    executable: q.executable,
    ...(q.error ? { error: q.error } : {}),
    bidCents: bid ? r1(bid.price * 100) : null,
    askCents: ask ? r1(ask.price * 100) : null,
    bidShares: bid ? Math.floor(bid.size) : 0,
    askShares: ask ? Math.floor(ask.size) : 0,
    allInBid: bid ? r2(allInBidCents(q.venue, bid.price)) : null,
    allInAsk: ask ? r2(allInAskCents(q.venue, ask.price)) : null,
    mid: bid && ask ? r2(((bid.price + ask.price) / 2) * 100) : null,
    crossed: Boolean(bid && ask && bid.price >= ask.price),
    bidUsdNear: book ? Math.round(restingUsd(book.bids, 2)) : 0,
    exit1000: { filled: Math.floor(exit.filled), allIn: exit.avgPrice !== null ? r2(allInBidCents(q.venue, exit.avgPrice)) : null },
    ageMs: book?.ageMs ?? null,
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function locksOf(outcomes: { name: string; cells: Record<Venue, Cell | null> }[], i: number): Lock[] {
  const own = outcomes[i];
  const legs: CoverLeg[] = [];
  let whole = true;
  for (const [j, other] of outcomes.entries()) {
    if (j === i) continue;
    let best: CoverLeg | null = null;
    for (const v of VENUES) {
      const c = other.cells[v];
      if (!c || c.allInAsk === null || c.crossed || c.askShares <= 0) continue;
      if (!best || c.allInAsk < best.allInAsk) best = { outcome: other.name, venue: v, allInAsk: c.allInAsk, shares: c.askShares };
    }
    if (best) legs.push(best);
    else whole = false;
  }
  const cost = legs.reduce((s, l) => s + l.allInAsk, 0);
  const cover = whole && legs.length ? { cost: r2(cost), value: r2(100 - cost), legs, shares: Math.min(...legs.map((l) => l.shares)) } : null;
  const locks: Lock[] = [];
  for (const home of VENUES) {
    const c = own.cells[home];
    if (!c || c.error) continue;
    const homeExit = c.crossed ? null : c.allInBid;
    locks.push({
      home,
      homeExit,
      cover,
      elsewhere: Boolean(cover?.legs.some((l) => l.venue !== home)),
      betterBy: cover && homeExit !== null ? r2(cover.value - homeExit) : null,
    });
  }
  return locks;
}

export function buildBoard(s: Snapshot): Board {
  const games: BoardGame[] = s.games.map((g) => {
    const rows = g.outcomes.map((o) => {
      const cells = byVenue<Cell | null>((v) => {
        const q = o.quotes.find((x) => x.venue === v);
        return q ? cellOf(q) : null;
      });
      const mids = VENUES.map((v) => cells[v]?.mid).filter((m): m is number => typeof m === "number");
      return { name: o.name, side: o.side, cells, midGap: mids.length >= 2 ? r2(Math.max(...mids) - Math.min(...mids)) : null };
    });
    const { outcomes: _raw, ...meta } = g;
    return {
      ...meta,
      venues: VENUES.filter((v) => rows.some((r) => r.cells[v])),
      outcomes: rows.map((r, i) => ({ ...r, locks: locksOf(rows, i) })),
    };
  });

  const venues: VenueSummary[] = VENUES.map((venue) => {
    const cells = games.flatMap((g) => g.outcomes.map((o) => o.cells[venue])).filter((c): c is Cell => c !== null);
    const two = cells.filter((c) => c.mid !== null && !c.crossed);
    const midSums = games
      .filter((g) => g.outcomes.every((o) => o.cells[venue]?.mid != null && !o.cells[venue]?.crossed))
      .map((g) => g.outcomes.reduce((sum, o) => sum + (o.cells[venue]?.mid ?? 0), 0));
    const gaps = games.flatMap((g) =>
      g.outcomes.flatMap((o) => {
        const mine = o.cells[venue];
        if (!mine || mine.mid === null || mine.crossed) return [];
        const others = VENUES.filter((v) => v !== venue)
          .map((v) => o.cells[v])
          .filter((x): x is Cell => x !== null && x.mid !== null && !x.crossed)
          .map((x) => x.mid as number);
        return others.length ? [Math.abs(mine.mid - others.reduce((a, b) => a + b, 0) / others.length)] : [];
      }),
    );
    return {
      venue,
      games: games.filter((g) => g.venues.includes(venue)).length,
      books: cells.length,
      twoSided: two.length,
      noBook: cells.filter((c) => c.bidCents === null && c.askCents === null).length,
      crossed: cells.filter((c) => c.crossed).length,
      medianSpread: ((m) => (m === null ? null : r1(m)))(median(two.map((c) => (c.askCents as number) - (c.bidCents as number)))),
      medianBidUsdNear: median(cells.filter((c) => c.bidCents !== null).map((c) => c.bidUsdNear)),
      medianMidSum: ((m) => (m === null ? null : r1(m)))(median(midSums)),
      medianGapToOthers: ((m) => (m === null ? null : r1(m)))(median(gaps)),
      takes1000: cells.filter((c) => c.exit1000.filled >= 1_000).length,
    };
  });

  const all = games.flatMap((g) => g.outcomes.flatMap((o) => o.locks.map((lock) => ({ game: g.name, startsAt: g.startsAt, outcome: o.name, lock }))));
  const wins = (x: { lock: Lock }): boolean => x.lock.elsewhere && x.lock.betterBy !== null && x.lock.betterBy > 0;
  const cover: CoverSummary[] = VENUES.map((home) => {
    const mine = all.filter((x) => x.lock.home === home && x.lock.homeExit !== null);
    const won = mine.filter(wins);
    const legsOn = byVenue(() => 0);
    for (const w of won) for (const l of w.lock.cover?.legs ?? []) legsOn[l.venue] += 1;
    return {
      home,
      withExit: mine.length,
      withCover: mine.filter((x) => x.lock.cover).length,
      elsewhereBetter: won.length,
      medianBetterBy: ((m) => (m === null ? null : r2(m)))(median(won.map((w) => w.lock.betterBy as number))),
      legsOn,
    };
  });

  return {
    at: s.at,
    games,
    comparable: games.filter((g) => g.venues.length >= 2).length,
    venues,
    cover,
    best: all.filter(wins).sort((a, b) => (b.lock.betterBy as number) - (a.lock.betterBy as number)).slice(0, 40),
  };
}
