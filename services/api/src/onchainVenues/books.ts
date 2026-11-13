/**
 * One shape for every venue's book: bids and asks for "this outcome pays $1", best first.
 *
 * Polymarket and Limitless stream one book per outcome token, already priced and sized that way.
 *
 * SX Bet streams one book per market for both outcomes, as the venue holds it: `bids` are offers
 * backing outcome one and `asks` are offers backing outcome two, each priced at the maker's own
 * implied probability and sized in the maker's stake in USDC. A maker backing outcome one at
 * p with stake S is offering the other outcome: a taker puts up S·(1−p)/p at a price of 1−p, and
 * the pot is S/p. In $1 shares that one offer is S/p shares, and it reads two ways:
 *
 *   on outcome one   a BID at p        (a holder of outcome one leaves by backing outcome two against it)
 *   on outcome two   an ASK at 1 − p   (a buyer of outcome two fills it)
 *
 * and an offer backing outcome two at q with stake S is S/q shares: a bid on outcome two at q,
 * an ask on outcome one at 1 − q. Nothing is rounded here; the page rounds what it prints.
 */

import type { Level, OutcomeBook } from "./types";

export interface RawBook {
  bids: Level[];
  asks: Level[];
  serverTimestamp?: number;
  venueTimestamp?: number;
  status?: string;
}

const real = (l: Level): boolean => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0 && l.price > 0 && l.price < 1;
const bestFirst = (bids: Level[], asks: Level[]): { bids: Level[]; asks: Level[] } => ({
  bids: bids.filter(real).sort((a, b) => b.price - a.price),
  asks: asks.filter(real).sort((a, b) => a.price - b.price),
});

/** The stream's own stamp of the venue's last word against the time the frame was sent; null when the venue gave none. */
function ageOf(raw: RawBook): number | null {
  const venue = Number(raw.venueTimestamp ?? 0);
  const server = Number(raw.serverTimestamp ?? 0);
  return venue > 0 && server > 0 ? Math.max(0, server - venue) : null;
}

/** A book the venue already prices per outcome share (Polymarket, Limitless). */
export function shareBook(raw: RawBook): OutcomeBook {
  return { ...bestFirst(raw.bids, raw.asks), ageMs: ageOf(raw), ...(raw.status ? { status: raw.status } : {}) };
}

export type SxOutcome = "OUTCOME_ONE" | "OUTCOME_TWO";

/** One outcome's book out of an SX Bet market book (the header has the arithmetic). */
export function sxOutcomeBook(raw: RawBook, outcome: SxOutcome): OutcomeBook {
  const offers = (ls: Level[]): Level[] => ls.filter(real);
  const own = (l: Level): Level => ({ price: l.price, size: l.size / l.price });
  const across = (l: Level): Level => ({ price: 1 - l.price, size: l.size / l.price });
  const backingOne = offers(raw.bids);
  const backingTwo = offers(raw.asks);
  const book = outcome === "OUTCOME_ONE" ? bestFirst(backingOne.map(own), backingTwo.map(across)) : bestFirst(backingTwo.map(own), backingOne.map(across));
  return { ...book, ageMs: ageOf(raw), ...(raw.status ? { status: raw.status } : {}) };
}

export interface Walk {
  /** shares the book could take, up to what was asked */
  filled: number;
  /** the average price over what filled; null when nothing did */
  avgPrice: number | null;
  /** the last price touched */
  worstPrice: number | null;
}

/** Take `shares` from one side of a book, best level first. */
export function walk(levels: Level[], shares: number): Walk {
  let left = shares;
  let cost = 0;
  let worst: number | null = null;
  for (const l of levels) {
    if (left <= 0) break;
    const take = Math.min(left, l.size);
    cost += take * l.price;
    left -= take;
    worst = l.price;
  }
  const filled = shares - left;
  return { filled, avgPrice: filled > 0 ? cost / filled : null, worstPrice: worst };
}

/** Dollars resting on one side within `withinCents` of its best price. */
export function restingUsd(levels: Level[], withinCents: number): number {
  const best = levels[0];
  if (!best) return 0;
  let usd = 0;
  for (const l of levels) {
    if (Math.abs(l.price - best.price) * 100 > withinCents + 1e-9) break;
    usd += l.price * l.size;
  }
  return usd;
}
