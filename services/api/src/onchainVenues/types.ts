/**
 * The on-chain venues, side by side: the same game's winner market on Polymarket International,
 * SX Bet and Limitless, read through the aggregation partner's signed API and book stream.
 * Read only: discovery and books. Nothing here can place an order.
 *
 * This lane is kept apart from the regulated one: it imports the partner's client and the fee
 * arithmetic, and nothing else, and nothing in the regulated lane imports it.
 *
 * Units, the same for every venue once a book is read: an outcome "pays $1 when it wins", a
 * price is the cost of that $1 as a decimal in [0, 1], a size is a count of those $1 shares.
 * Polymarket and Limitless publish their books that way already. SX Bet does not: its book is
 * offers of stake at odds, one book for both outcomes (books.ts turns it into the same shape).
 */

export const VENUES = ["polymarket", "sx_bet", "limitless"] as const;
export type Venue = (typeof VENUES)[number];
export const VENUE_NAME: Record<Venue, string> = { polymarket: "Polymarket International", sx_bet: "SX Bet", limitless: "Limitless" };
export const VENUE_SHORT: Record<Venue, string> = { polymarket: "Polymarket", sx_bet: "SX Bet", limitless: "Limitless" };
/** the partner's name for each venue on a listing and on the stream */
export const FEED_VENUE: Record<Venue, string> = { polymarket: "POLYMARKET", sx_bet: "SX_BET", limitless: "LIMITLESS" };
export const byVenue = <T>(make: (v: Venue) => T): Record<Venue, T> => Object.fromEntries(VENUES.map((v) => [v, make(v)])) as Record<Venue, T>;

export interface Level {
  /** the cost of $1 paid when the outcome wins, in [0, 1] */
  price: number;
  /** $1 shares at that price */
  size: number;
}

/** One outcome's book on one venue, best level first on both sides. */
export interface OutcomeBook {
  bids: Level[];
  asks: Level[];
  /** how old the venue's own stamp was when the frame was sent, ms; null when the venue gave none */
  ageMs: number | null;
  status?: string;
}

export interface VenueQuote {
  venue: Venue;
  /** the venue's own id for this outcome: a token id, a market hash and outcome, a slug and token */
  id: string;
  /** the partner's word on whether an order can be sent on it today; null when it does not say */
  executable: boolean | null;
  /** how the listing was tied to the game: by the partner's mapping, or here by team names and start time */
  matchedBy: "feed" | "names";
  book: OutcomeBook | null;
  /** why there is no book, in the stream's words */
  error?: string;
}

export interface OutcomeRow {
  name: string;
  /** HOME, AWAY or DRAW when the feed says */
  side: string | null;
  quotes: VenueQuote[];
}

export interface GameRow {
  eventId: string;
  name: string;
  competitionId: string;
  competition: string;
  sport: string;
  startsAt: string;
  status: string;
  marketTitle: string;
  outcomes: OutcomeRow[];
}

export interface Coverage {
  competitionId: string;
  competition: string;
  sport: string;
  /** games inside the horizon whose markets have been read */
  events: number;
  /** of those, events whose winner market was found */
  withWinner: number;
  /** winner markets listed on each venue */
  on: Record<Venue, number>;
  /** listed on two of the three or more */
  onTwo: number;
  onThree: number;
}

export interface FeedHealth {
  /** the key's capabilities as the partner reports them */
  capabilities: string[];
  discoveredAt: string | null;
  discoveryMs: number | null;
  /** what the last discovery could not read, in words */
  notes: string[];
  competitions: number;
  eventsInHorizon: number;
  /** of those, games whose markets have been read */
  eventsRead: number;
  /** of those, games still to read: a pass reads a bounded number */
  eventsPending: number;
  /** games one of the three lists that were left off the board because its cap was reached */
  eventsOverCap: number;
  limitless: { state: "listed" | "refused" | "failed" | "not_read"; markets: number; sports: number; matched: number; detail?: string };
  books: { asked: number; read: number; empty: number; errors: Record<string, number>; ms: number | null };
}

export interface Snapshot {
  at: string;
  games: GameRow[];
  coverage: Coverage[];
  /** Limitless sports markets that were found and could not be tied to a game here */
  unmatchedLimitless: string[];
  feed: FeedHealth;
}
