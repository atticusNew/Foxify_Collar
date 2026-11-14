/**
 * Crypto.com's game-winner books, read from the public market-data API of its US exchange
 * (North American Derivatives Exchange, trading as Crypto.com | Derivatives North America and
 * OG). No key, no account. Nothing here can place an order.
 *
 * This is the book a customer of any broker introducing to that exchange trades on, so it is
 * also the book such a holder would sell into.
 *
 * Wire facts (https://api.crypto.com/fcm/v1/public, read 11 November 2026). Every answer is
 * {code: 0, result: {data: [...], next_cursor?}}; a bad argument is HTTP 400 with {code, message}.
 *   GET /get-events?series_symbol=NHL2026&limit=1000[&cursor=]
 *       -> events: {symbol: "NHL-00002-261111-M", event_details: {metaData: {LEAGUE: "NHL",
 *          PREDICT_EVENT_TYPE: "Game" (season awards are "Future"), FEED_TYPE: "SINGLES",
 *          AWAY_PARTICIPANT, HOME_PARTICIPANT (full club names), EVENT_DATE (ISO start)}}}
 *       A league's games sit in the series named by league and year. The year after holds
 *       futures today; which year a January game lands in is not documented, so the year
 *       before, this year and the next are all asked and a series that does not exist is
 *       passed over.
 *   GET /get-instruments?event_symbol=<event>&limit=1000[&cursor=]
 *       -> every contract on the game (a few hundred with props), newest first. The winner
 *          pair is the two with PREDICT_CONTRACT_TYPE "Moneyline" and PREDICT_PERIOD_TYPE
 *          "Full-Game", one per club (PARTICIPANT), sharing a PREDICT_MARKET_ID. Each is its own
 *          $1 contract: "this club wins".
 *   GET /get-book?instrument_name=<contract>&depth=1
 *       -> {data: [{bids: [[price, qty]], asks: [[price, qty]], t}]}, prices in dollars to the
 *          cent, quantities in contracts to two decimals.
 *
 * Settlement: the official result; overtime and the shootout count in hockey, overtime in
 * basketball and football (the venue's Sports Event Trading page). A game postponed, cancelled
 * or not completed within 48 hours of its scheduled start settles at the prior week's average
 * price, which no other venue here does.
 *
 * Fees, from the exchange's fee schedule (effective 1 August 2026): on a $1 event contract the
 * customer of a broker pays $0.02 per contract to open and again to close before expiry, and
 * nothing at settlement. The schedule also allows, "based on the technology" of the broker, a
 * fee weighted by price, 0.07 x p x (1 - p), which is never more than the flat fee. Which one a
 * given broker's customers pay is not public, so the flat fee is the default and
 * SPORTS_VENUES_CRYPTOCOM_FEE=weighted switches. A broker's own commission on top is not public
 * either and is not counted.
 */

import { LEAGUE_TEMPLATES } from "../eventCollar/crossVenue/resolutionWhitelist";
import { etDate } from "./readers";
import type { Game, Side, SideQuote, VenueListing } from "./types";

export const CRYPTOCOM_PUBLIC_HOST = "https://api.crypto.com/fcm/v1/public";

export function cryptocomHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env.CRYPTOCOM_PUBLIC_HOST ?? CRYPTOCOM_PUBLIC_HOST).trim().replace(/\/+$/, "");
}

/** The venue's own name for each league: its series are that name and a year, and every event says it. */
export const CRYPTOCOM_LEAGUES: Record<string, string> = { nba: "NBA", nfl: "NFL", nhl: "NHL" };

/** The exchange fee on a $1 event contract, cents per contract per side. */
export const CRYPTOCOM_FLAT_FEE_CENTS = 2;
/** The schedule's price-weighted alternative: 0.07 x p x (1 - p) per contract. */
export const CRYPTOCOM_WEIGHTED_THETA = 0.07;

/** The exchange fee as it is counted on the page: a fixed number of cents, or the weighted coefficient. */
export interface CryptocomFee {
  theta: number;
  flatCents: number;
}

export function cryptocomFeeFromEnv(env: NodeJS.ProcessEnv = process.env): CryptocomFee {
  const raw = (env.SPORTS_VENUES_CRYPTOCOM_FEE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "flat") return { theta: 0, flatCents: CRYPTOCOM_FLAT_FEE_CENTS };
  if (raw === "weighted") return { theta: CRYPTOCOM_WEIGHTED_THETA, flatCents: 0 };
  throw new Error(`SPORTS_VENUES_CRYPTOCOM_FEE must be "flat" or "weighted", not "${raw.slice(0, 40)}"`);
}

type Meta = Record<string, string | undefined>;
export interface CryptocomEvent {
  symbol: string;
  event_details?: { metaData?: Meta };
}
export interface CryptocomInstrument {
  symbol: string;
  inst_type?: string;
  event_details?: { metaData?: Meta };
}
export type CryptocomLevel = [string | number, string | number];
export interface CryptocomBook {
  bids?: CryptocomLevel[];
  asks?: CryptocomLevel[];
}

const meta = (x: { event_details?: { metaData?: Meta } }): Meta => x.event_details?.metaData ?? {};
const plain = (s: string | undefined): string =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Is this event the game: a single game of the league whose two participants are the game's two
 * clubs by full name, starting on the game's ET date? The venue's order of the two is not relied
 * on; the contracts are matched to clubs by name. Exported for tests.
 */
export function cryptocomEventIs(ev: CryptocomEvent, game: Game, leagueName: string): boolean {
  const m = meta(ev);
  if (m.LEAGUE !== leagueName || m.PREDICT_EVENT_TYPE !== "Game" || (m.FEED_TYPE ?? "SINGLES") !== "SINGLES") return false;
  const startMs = Date.parse(m.EVENT_DATE ?? "");
  if (!Number.isFinite(startMs) || etDate(startMs) !== game.key.split(":")[3]) return false;
  const clubs = [plain(m.AWAY_PARTICIPANT), plain(m.HOME_PARTICIPANT)];
  const away = plain(game.awayName);
  const home = plain(game.homeName);
  return away !== home && clubs.includes(away) && clubs.includes(home);
}

/**
 * The game's two winner contracts among everything listed on its event: exactly two full-game
 * two-way moneylines, of one market, one naming each club. Anything else (one missing, a third,
 * a club named twice) is not a pair to read. Exported for tests.
 */
export function cryptocomWinnerPair(instruments: CryptocomInstrument[], game: Game): Record<Side, string> | null {
  const winners = instruments.filter((i) => {
    const m = meta(i);
    return (i.inst_type ?? "BINARY_OPTION") === "BINARY_OPTION" && m.PREDICT_CONTRACT_TYPE === "Moneyline" && m.PREDICT_PERIOD_TYPE === "Full-Game";
  });
  if (winners.length !== 2) return null;
  const [a, b] = winners;
  if ((meta(a).PREDICT_MARKET_ID ?? "") !== (meta(b).PREDICT_MARKET_ID ?? "")) return null;
  const of = (club: string) => winners.filter((i) => plain(meta(i).PARTICIPANT) === plain(club));
  const away = of(game.awayName);
  const home = of(game.homeName);
  if (away.length !== 1 || home.length !== 1 || away[0] === home[0]) return null;
  return { away: away[0].symbol, home: home[0].symbol };
}

/**
 * The best level of one side of a book: the highest bid or the lowest ask among levels holding
 * something, in cents, with the contracts resting at that price. Null when the side is empty.
 * The order the venue sends the levels in is not relied on. Exported for tests.
 */
export function cryptocomBestLevel(levels: CryptocomLevel[] | undefined, side: "bid" | "ask"): { cents: number; shares: number } | null {
  let best: { cents: number; shares: number } | null = null;
  for (const l of levels ?? []) {
    const price = Number(l?.[0]);
    const qty = Number(l?.[1]);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || price >= 1 || qty <= 0) continue;
    const cents = Math.round(price * 10_000) / 100;
    if (best && cents === best.cents) best.shares += qty;
    else if (!best || (side === "bid" ? cents > best.cents : cents < best.cents)) best = { cents, shares: qty };
  }
  return best ? { cents: best.cents, shares: Math.floor(best.shares * 100 + 1e-6) / 100 } : null;
}

/** Crypto.com's listing for one game from its event, the two clubs' books and the fee. Exported for tests. */
export function cryptocomListingFrom(ev: CryptocomEvent, books: Record<Side, CryptocomBook>, fee: CryptocomFee, game: Game): VenueListing {
  const quote = (b: CryptocomBook): SideQuote => {
    const bid = cryptocomBestLevel(b.bids, "bid");
    const ask = cryptocomBestLevel(b.asks, "ask");
    return { bidCents: bid?.cents ?? 0, askCents: ask?.cents ?? 0, bidQty: bid?.shares ?? 0, askQty: ask?.shares ?? 0 };
  };
  const m = meta(ev);
  const startMs = Date.parse(m.EVENT_DATE ?? "");
  const venueAwayIsOurs = plain(m.AWAY_PARTICIPANT) === plain(game.awayName);
  return {
    venue: "cryptocom",
    id: ev.symbol,
    away: quote(books.away),
    home: quote(books.home),
    feeTheta: fee.theta,
    ...(fee.flatCents > 0 ? { feeFlatCents: fee.flatCents } : {}),
    awayName: (venueAwayIsOurs ? m.AWAY_PARTICIPANT : m.HOME_PARTICIPANT) ?? game.awayName,
    homeName: (venueAwayIsOurs ? m.HOME_PARTICIPANT : m.AWAY_PARTICIPANT) ?? game.homeName,
    startsAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : undefined,
  };
}

// ---------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------

/** How long a league's list of events is reused: games are listed days ahead and do not move by the minute. */
export const CRYPTOCOM_EVENTS_TTL_MS = 5 * 60_000;
/** How long before a series the venue said does not exist, or a game whose winner pair was not there, is asked again. */
export const CRYPTOCOM_RETRY_MS = 15 * 60_000;

/**
 * What one collector keeps between cycles so a cycle costs two small book reads per game: each
 * series' events for a few minutes, and each game's two contract symbols for as long as the
 * process runs (a contract's symbol does not change once listed).
 */
export interface CryptocomCache {
  events: Map<string, { atMs: number; rows: CryptocomEvent[] }>;
  /** series the venue answered "invalid" for, or events with no winner pair yet: when last asked */
  askedAt: Map<string, number>;
  pairs: Map<string, Record<Side, string>>;
}
export const newCryptocomCache = (): CryptocomCache => ({ events: new Map(), askedAt: new Map(), pairs: new Map() });

/** The venue saying an argument names nothing (HTTP 400): a series, an event or a contract it does not know. */
export class BadArgument extends Error {}

/** One GET. A 400 is the venue saying the argument names nothing: not retried. Anything else is tried once more. */
export async function getResult(url: string, fetchImpl: typeof fetch): Promise<{ data: unknown[]; next: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "atticus-event-demo" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 400) throw new BadArgument(`HTTP 400 for ${url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const body = (await res.json()) as { code?: number; result?: { data?: unknown[]; next_cursor?: string | null } };
      if (body.code !== 0 || !Array.isArray(body.result?.data)) throw new Error(`Crypto.com answered code ${String(body.code)} for ${url}`);
      return { data: body.result.data, next: body.result.next_cursor ? String(body.result.next_cursor) : "" };
    } catch (err) {
      if (err instanceof BadArgument) throw err;
      last = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw last;
}

async function getAll<T>(url: string, fetchImpl: typeof fetch, maxPages = 8): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const { data, next } = await getResult(`${url}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, fetchImpl);
    out.push(...(data as T[]));
    cursor = next;
    if (!cursor || !data.length) break;
  }
  return out;
}

const isGameEvent = (e: CryptocomEvent): boolean => meta(e).PREDICT_EVENT_TYPE === "Game";
/** Only what matching reads is kept: a season's list is over a thousand events of a kilobyte each. */
const slim = (e: CryptocomEvent): CryptocomEvent => {
  const m = meta(e);
  return {
    symbol: e.symbol,
    event_details: { metaData: { LEAGUE: m.LEAGUE, PREDICT_EVENT_TYPE: m.PREDICT_EVENT_TYPE, FEED_TYPE: m.FEED_TYPE, EVENT_DATE: m.EVENT_DATE, AWAY_PARTICIPANT: m.AWAY_PARTICIPANT, HOME_PARTICIPANT: m.HOME_PARTICIPANT } },
  };
};

async function pooled<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

/**
 * Crypto.com's listing for each game: the league's events (reused for a few minutes), each game
 * matched by both clubs' names and the ET date of the venue's start, its two winner contracts
 * found once, then one book read per club each cycle. A game it does not list gets none.
 * `notes` receives, in words, anything left off the board for a reason other than "not listed".
 */
export async function readCryptocomListings(
  games: Game[],
  opts: { fetchImpl?: typeof fetch; host?: string; notes?: string[]; nowMs?: number; cache?: CryptocomCache; fee?: CryptocomFee } = {},
): Promise<Map<string, VenueListing>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = opts.host ?? cryptocomHost();
  const nowMs = opts.nowMs ?? Date.now();
  const cache = opts.cache ?? newCryptocomCache();
  const fee = opts.fee ?? cryptocomFeeFromEnv();
  const note = (line: string) => opts.notes?.push(line);
  const out = new Map<string, VenueListing>();

  const matched: Array<{ game: Game; ev: CryptocomEvent }> = [];
  const leagues = [...new Set(games.map((g) => g.league))].filter((l) => CRYPTOCOM_LEAGUES[l] && LEAGUE_TEMPLATES.some((t) => t.league === l));
  const year = Number(etDate(nowMs).slice(0, 4));
  await Promise.all(
    leagues.map(async (league) => {
      const name = CRYPTOCOM_LEAGUES[league];
      const events: CryptocomEvent[] = [];
      let answered = 0;
      let failure: unknown = null;
      await Promise.all(
        [year - 1, year, year + 1].map(async (y) => {
          const series = `${name}${y}`;
          const held = cache.events.get(series);
          if (held && nowMs - held.atMs < CRYPTOCOM_EVENTS_TTL_MS) {
            events.push(...held.rows);
            answered += 1;
            return;
          }
          const asked = cache.askedAt.get(`series:${series}`);
          if (asked !== undefined && nowMs - asked < CRYPTOCOM_RETRY_MS) return;
          try {
            const rows = (await getAll<CryptocomEvent>(`${host}/get-events?series_symbol=${encodeURIComponent(series)}&limit=1000`, fetchImpl)).filter(isGameEvent).map(slim);
            cache.events.set(series, { atMs: nowMs, rows });
            cache.askedAt.delete(`series:${series}`);
            events.push(...rows);
            answered += 1;
          } catch (err) {
            if (err instanceof BadArgument) {
              cache.askedAt.set(`series:${series}`, nowMs);
              cache.events.delete(series);
            } else if (held) {
              // the list a few minutes old is better than no games: the books below are still read fresh
              events.push(...held.rows);
              answered += 1;
            } else failure = err;
          }
        }),
      );
      // no series answered and one of them failed for a reason other than "no such series": the venue is not answering
      if (!answered && failure) throw failure;
      for (const g of games.filter((x) => x.league === league)) {
        const hits = events.filter((e) => cryptocomEventIs(e, g, name));
        if (hits.length === 1) matched.push({ game: g, ev: hits[0] });
        else if (hits.length > 1) note(`${g.key}: ${hits.length} events match on the venue; left off`);
      }
    }),
  );
  if (!matched.length) return out;

  let pairUnread = 0;
  await pooled(matched, 4, async ({ game, ev }) => {
    if (cache.pairs.has(ev.symbol)) return;
    const asked = cache.askedAt.get(`pair:${ev.symbol}`);
    if (asked !== undefined && nowMs - asked < CRYPTOCOM_RETRY_MS) return;
    try {
      const instruments = await getAll<CryptocomInstrument>(`${host}/get-instruments?event_symbol=${encodeURIComponent(ev.symbol)}&limit=1000`, fetchImpl);
      const pair = cryptocomWinnerPair(instruments, game);
      if (pair) cache.pairs.set(ev.symbol, pair);
      else cache.askedAt.set(`pair:${ev.symbol}`, nowMs);
    } catch {
      // asked again next cycle
      pairUnread += 1;
    }
  });
  const withPair = matched.filter((m) => cache.pairs.has(m.ev.symbol));
  if (pairUnread && !withPair.length) throw new Error(`Crypto.com: the contracts of ${pairUnread} game${pairUnread > 1 ? "s" : ""} could not be read`);
  if (pairUnread) note(`${pairUnread} game${pairUnread > 1 ? "s" : ""} left off this cycle: the venue's list of contracts was not read`);
  const noPair = matched.length - withPair.length - pairUnread;
  if (noPair > 0) note(`${noPair} game${noPair > 1 ? "s" : ""} listed without a two-way winner pair; left off`);

  let bookUnread = 0;
  const bookOf = async (symbol: string): Promise<CryptocomBook> => {
    const { data } = await getResult(`${host}/get-book?instrument_name=${encodeURIComponent(symbol)}&depth=1`, fetchImpl);
    return (data[0] ?? {}) as CryptocomBook;
  };
  await pooled(withPair, 8, async ({ game, ev }) => {
    const pair = cache.pairs.get(ev.symbol) as Record<Side, string>;
    try {
      const [away, home] = await Promise.all([bookOf(pair.away), bookOf(pair.home)]);
      out.set(game.key, cryptocomListingFrom(ev, { away, home }, fee, game));
    } catch (err) {
      bookUnread += 1;
      // a contract the venue no longer knows was replaced: its pair is looked up again
      if (err instanceof BadArgument) cache.pairs.delete(ev.symbol);
    }
  });
  if (bookUnread && bookUnread === withPair.length) throw new Error(`Crypto.com: no book could be read (${bookUnread} game${bookUnread > 1 ? "s" : ""})`);
  if (bookUnread) note(`${bookUnread} game${bookUnread > 1 ? "s" : ""} left off this cycle: the book was not read`);
  return out;
}
