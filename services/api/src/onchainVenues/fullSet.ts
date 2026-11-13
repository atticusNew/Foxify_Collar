/**
 * Is one of each outcome of this game a sure payout?
 *
 * A cover is "buy every other outcome": it holds only when the outcomes read are every way the
 * game can end, and each venue's listing of an outcome is the same bet. Four checks, and a
 * game that fails any has no cover worked out for it anywhere (the board, the demo):
 *
 *   1. A venue lists a draw for the game apart from the market read (GameRow.drawApart).
 *   2. The game is association football and was read with no draw among its outcomes. Told by
 *      the feed's sport, or by the league's name when the feed gives no sport (it gave none on
 *      13 November 2026). This also leaves out a two-way football market that is a whole set
 *      (a knockout tie "to qualify"): which of the two a market is cannot be told from here.
 *   3. On one venue, the best asks of all the outcomes add to under 97¢, or its best bids add
 *      to over 103¢. A whole set on one book cannot stay priced like that; a set that reads
 *      so is missing an outcome or has one mispaired.
 *   4. One of each outcome, each from whichever venue asks least with its fee in, costs under
 *      97¢. The same reading across venues: a sure $1 for 97¢ does not rest on live books,
 *      so the listings are not the same bet, or a book is stale.
 *
 * Found on 13 November 2026: football games came through as two outcomes with the draw left
 * out, and the page read a team and its opponent, 67¢ to 90¢ together, as a locked $1.
 */

import { allInAskCents } from "./fees";
import { VENUES, VENUE_SHORT, type GameRow, type OutcomeBook, type Venue } from "./types";

/** a whole set priced under this, in cents, is taken as not whole */
export const FULL_SET_FLOOR_CENTS = 97;
/** and one whose bids on a single venue add to over this */
export const FULL_SET_BID_CEILING_CENTS = 103;

const FOOTBALL_SPORT = /soccer|association football/i;
const FOOTBALL_LEAGUE =
  /\b(uefa|fifa|premier league|epl|la ?liga|serie a|bundesliga|ligue 1|eredivisie|primeira liga|mls|liga mx|copa|libertadores|champions league|europa league|conference league|nations league|cup of nations|world cup|fa cup|efl|super lig|a-league|j1 league|k league)\b/i;
const isDraw = (name: string, side: string | null): boolean => side === "DRAW" || /^(draw|tie|x)$/i.test(name.trim());

const crossed = (b: OutcomeBook): boolean => Boolean(b.bids[0] && b.asks[0] && b.bids[0].price >= b.asks[0].price);
const usable = (game: GameRow, i: number, venue: Venue): OutcomeBook | null => {
  const b = game.outcomes[i].quotes.find((q) => q.venue === venue)?.book ?? null;
  return b && !crossed(b) ? b : null;
};

/** Why no cover is worked out for this game, in a few words; null when one of each outcome reads as a whole set. */
export function notAFullSet(game: GameRow): string | null {
  if (game.drawApart) return "a draw is listed apart from this market";
  if (game.outcomes.length < 2) return "one outcome only";
  if (!game.outcomes.some((o) => isDraw(o.name, o.side)) && (FOOTBALL_SPORT.test(game.sport) || FOOTBALL_LEAGUE.test(game.competition))) return "a football game read without its draw";

  for (const venue of VENUES) {
    const books = game.outcomes.map((_, i) => usable(game, i, venue));
    if (books.every((b) => b?.asks[0])) {
      const asks = books.reduce((s, b) => s + (b as OutcomeBook).asks[0].price * 100, 0);
      if (asks < FULL_SET_FLOOR_CENTS) return `${VENUE_SHORT[venue]}'s asks add to ${asks.toFixed(1)}¢`;
    }
    if (books.every((b) => b?.bids[0])) {
      const bids = books.reduce((s, b) => s + (b as OutcomeBook).bids[0].price * 100, 0);
      if (bids > FULL_SET_BID_CEILING_CENTS) return `${VENUE_SHORT[venue]}'s bids add to ${bids.toFixed(1)}¢`;
    }
  }

  let set = 0;
  for (const [i] of game.outcomes.entries()) {
    let best: number | null = null;
    for (const venue of VENUES) {
      const ask = usable(game, i, venue)?.asks[0];
      if (!ask) continue;
      const allIn = allInAskCents(venue, ask.price);
      if (best === null || allIn < best) best = allIn;
    }
    // an outcome nobody offers: nothing to add up, and no cover can be made of it either
    if (best === null) return null;
    set += best;
  }
  return set < FULL_SET_FLOOR_CENTS ? `one of each outcome costs ${set.toFixed(1)}¢ across the venues` : null;
}
