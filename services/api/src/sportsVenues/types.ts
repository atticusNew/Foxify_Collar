/**
 * Sports on the event venues: the same game's winner market on every regulated US venue that
 * publishes a book without a key, read side by side. Public market data only; nothing here can
 * place an order.
 *
 * Units: prices in cents of $1 with two decimals kept (Novig quotes half cents), depth in $1
 * shares at the best level. Every venue's own instrument is normalised to "side s pays $1 when
 * s wins": on Kalshi that is the team's own market's Yes; on Polymarket US the long side is the
 * away team and the home team is 1 minus it; on Novig a bid on one outcome is the ask on the other;
 * on ProphetX every order backs a team at American odds, so the best odds on a team are its ask
 * and its bid is 1 minus the other team's ask.
 */

export const VENUES = ["kalshi", "polymarket_us", "novig", "prophetx"] as const;
export type Venue = (typeof VENUES)[number];
export const VENUE_NAME: Record<Venue, string> = { kalshi: "Kalshi", polymarket_us: "Polymarket US", novig: "Novig", prophetx: "ProphetX" };
/** One value per venue: the only place the list of venues is spelled out for a record. */
export const byVenue = <T>(make: (v: Venue) => T): Record<Venue, T> => Object.fromEntries(VENUES.map((v) => [v, make(v)])) as Record<Venue, T>;

export type Side = "away" | "home";
export const SIDES: readonly Side[] = ["away", "home"];

export interface SideQuote {
  /** best bid and ask for "this side pays $1", cents; 0 when that side of the book is empty */
  bidCents: number;
  askCents: number;
  /** $1 shares resting at the best level (0 when the venue's book was not read) */
  bidQty: number;
  askQty: number;
}

export interface VenueListing {
  venue: Venue;
  /** the venue's own id for the market (a Kalshi ticker pair, a Polymarket US slug, a Novig market id, a ProphetX event and market) */
  id: string;
  away: SideQuote;
  home: SideQuote;
  /** taker fee coefficient c in c·p·(1−p) per $1 contract, as it applies RIGHT NOW (Novig's is 0 before tip-off) */
  feeTheta: number;
  /** the coefficient the venue charges once the game is live, when it differs from feeTheta */
  feeThetaLive?: number;
  /**
   * The share of a market's net winnings the venue takes at settlement, as a fraction (ProphetX
   * outside its maker/taker leagues: 0.02). Nothing is charged at the trade. Absent on a venue
   * that charges per contract.
   */
  feeGain?: number;
  /** venue's own words for the two sides, as listed */
  awayName: string;
  homeName: string;
  /** the venue's start time for the game when it publishes one, ISO */
  startsAt?: string;
}

export interface Game {
  /** league:AWAY:HOME:YYYY-MM-DD, team codes as Kalshi spells them, the ET game date */
  key: string;
  league: string;
  awayCode: string;
  homeCode: string;
  awayName: string;
  homeName: string;
  /** canonical start, ISO: a venue's published start when one has it, else the ET game date at noon */
  startsAt: string;
  startSource: "venue" | "date_only";
  listings: VenueListing[];
}

export interface Snapshot {
  at: string;
  games: Game[];
  health: Record<string, { ok: boolean; ms: number; detail?: string }>;
}
