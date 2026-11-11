/**
 * The three public reads, one per venue, each returning listings keyed by game. Kalshi is the
 * spine (its game tickers carry the league, the two team codes and the ET game date); the other
 * two are looked up for each Kalshi game by team codes and date, never by nickname.
 *
 * Kalshi:        KXNFLGAME / KXNBAGAME / KXNHLGAME, one market per team ("LAL wins"), Yes pays $1 on
 *                that team. Depth from the public orderbook. Fee 0.07·p·(1−p), taker, series multiplier.
 * Polymarket US: gateway.polymarket.us, event slug {league}-{away}-{home}-{date}, the market whose
 *                sportsMarketType ends in _full_game_winner; the long side is the away team (checked
 *                against the team abbreviation), the home side is 1 minus it. Fee: the market's
 *                feeCoefficient (0.095 at Tier 1).
 * Novig:         public catalog, MONEY markets per league, outcomes named by team code with the
 *                best bid and its size on each; a bid on one outcome is the ask on the other.
 *                Contracts pay 1¢, so size is qty/100 in $1 shares. Fee 0.06·p·(1−p), charged only
 *                once the game is live (the catalog says so on the market).
 */

import { fetchJsonWithRetry, kalshiBase } from "../eventCollar/kalshiPublic";
import { fetchFeeTheta, topDepthFromOrderbook, type RawMarket as KalshiRawMarket } from "../btcCurve/kalshiLadders";
import { moneyCents, polyUsBase } from "../btcCurve/polyUsLadders";
import { LEAGUE_TEMPLATES, type LeagueTemplate } from "../eventCollar/crossVenue/resolutionWhitelist";
import { parseGameTicker } from "../eventCollar/crossVenue/eventMatcher";
import { POLY_US_CODES, polyUsAliases, polyUsEventSlugs, polyUsWinnerMarket, type PolyUsEvent, type PolyUsMarket } from "../eventCollar/crossVenue/polymarketUs";
import { codesFor } from "../eventCollar/crossVenue/venueBooks";
import { signedFeeAppliesPreGame, signedFeeCoefficient } from "../eventCollar/crossVenue/venueBooks";
import { VenueClient, type RawVenueMarket } from "../eventCollar/crossVenue/venuePositions";
import type { Game, Side, SideQuote, VenueListing } from "./types";

export const LEAGUES = ["nfl", "nba", "nhl"] as const;
export type League = (typeof LEAGUES)[number];

const templateOf = (league: string): LeagueTemplate | null => LEAGUE_TEMPLATES.find((t) => t.league === league) ?? null;

/** Kalshi's sub-penny dollars to cents with two decimals. */
const dollarsToCents = (d: string | number | undefined): number => {
  const n = Number(d ?? 0);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 100 : 0;
};

/** The ET civil date of an instant, YYYY-MM-DD. */
export function etDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export const gameKey = (league: string, away: string, home: string, date: string): string => `${league}:${away}:${home}:${date}`;

// ---------------------------------------------------------------------------
// Kalshi
// ---------------------------------------------------------------------------

export interface KalshiGame {
  game: Game;
  /** the two tickers, by side */
  tickers: Record<Side, string>;
}

async function fetchOpenMarkets(series: string, fetchImpl: typeof fetch): Promise<KalshiRawMarket[]> {
  const out: KalshiRawMarket[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const url = `${kalshiBase()}/markets?series_ticker=${encodeURIComponent(series)}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as { markets?: KalshiRawMarket[]; cursor?: string };
    out.push(...(data.markets ?? []));
    cursor = data.cursor ?? "";
    if (!cursor || !(data.markets ?? []).length) break;
  }
  return out;
}

/**
 * Kalshi's open game markets for one league folded into games: a game is on the board when
 * both teams' markets are listed. The ET game date comes from the ticker; the start time is
 * not on the market (NBA and NFL tickers carry no time), so the game starts "date only" until
 * another venue says when. Exported for tests.
 */
export function kalshiGamesFrom(raw: KalshiRawMarket[], template: LeagueTemplate, theta: number): KalshiGame[] {
  const byGame = new Map<string, { away?: KalshiRawMarket; home?: KalshiRawMarket; parsed: ReturnType<typeof parseGameTicker> }>();
  for (const m of raw) {
    const p = parseGameTicker(m.ticker, template);
    if (!p) continue;
    const key = gameKey(template.league, p.awayCode, p.homeCode, p.dateIso);
    const g = byGame.get(key) ?? { parsed: p };
    if (p.sideCode === p.awayCode) g.away = m;
    else g.home = m;
    byGame.set(key, g);
  }
  const out: KalshiGame[] = [];
  for (const [key, g] of byGame) {
    if (!g.away || !g.home || !g.parsed) continue;
    const q = (m: KalshiRawMarket): SideQuote => ({ bidCents: dollarsToCents(m.yes_bid_dollars), askCents: dollarsToCents(m.yes_ask_dollars), bidQty: 0, askQty: 0 });
    const p = g.parsed;
    const listing: VenueListing = {
      venue: "kalshi",
      id: `${g.away.ticker}|${g.home.ticker}`,
      away: q(g.away),
      home: q(g.home),
      feeTheta: theta,
      awayName: g.away.yes_sub_title ?? p.awayCode,
      homeName: g.home.yes_sub_title ?? p.homeCode,
    };
    const startsAt = p.hhmm
      ? new Date(new Date(`${p.dateIso}T00:00:00Z`).getTime() + ((Number(p.hhmm.slice(0, 2)) + 5) * 60 + Number(p.hhmm.slice(2))) * 60_000).toISOString()
      : `${p.dateIso}T17:00:00.000Z`;
    out.push({
      game: {
        key,
        league: template.league,
        awayCode: p.awayCode,
        homeCode: p.homeCode,
        awayName: template.teamNames[p.awayCode] ?? p.awayCode,
        homeName: template.teamNames[p.homeCode] ?? p.homeCode,
        startsAt,
        startSource: p.hhmm ? "venue" : "date_only",
        listings: [listing],
      },
      tickers: { away: g.away.ticker, home: g.home.ticker },
    });
  }
  return out;
}

async function withKalshiDepth(games: KalshiGame[], fetchImpl: typeof fetch, concurrency = 8): Promise<void> {
  const jobs = games.flatMap((g) => (["away", "home"] as Side[]).map((side) => ({ g, side })));
  const worker = async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) {
      try {
        const data = (await fetchJsonWithRetry(`${kalshiBase()}/markets/${encodeURIComponent(j.g.tickers[j.side])}/orderbook`, fetchImpl)) as Parameters<typeof topDepthFromOrderbook>[0];
        const d = topDepthFromOrderbook(data);
        const q = j.g.game.listings[0][j.side];
        q.bidQty = d.bidQty;
        q.askQty = d.askQty;
      } catch {
        // depth is a nicety; top of book stands without it
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}

/** Every game on Kalshi's board for the covered leagues, with depth, within `horizonMs` of now (by ET date). */
export async function readKalshiGames(opts: { fetchImpl?: typeof fetch; nowMs?: number; horizonMs?: number } = {}): Promise<KalshiGame[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const horizonMs = opts.horizonMs ?? 3 * 86_400_000;
  const today = etDate(nowMs);
  const out: KalshiGame[] = [];
  await Promise.all(
    LEAGUES.map(async (league) => {
      const t = templateOf(league);
      if (!t) return;
      const [raw, theta] = await Promise.all([fetchOpenMarkets(t.kalshiSeries, fetchImpl), fetchFeeTheta(t.kalshiSeries, fetchImpl).catch(() => 0.07)]);
      for (const g of kalshiGamesFrom(raw, t, theta)) {
        const date = g.game.key.split(":")[3];
        const dateMs = Date.parse(`${date}T17:00:00Z`);
        if (date < today || dateMs - nowMs > horizonMs) continue;
        out.push(g);
      }
    }),
  );
  await withKalshiDepth(out, fetchImpl);
  return out.sort((a, b) => a.game.startsAt.localeCompare(b.game.startsAt) || a.game.key.localeCompare(b.game.key));
}

// ---------------------------------------------------------------------------
// Polymarket US
// ---------------------------------------------------------------------------

// the venue's catalog shapes and club spellings live with the event lane's reader of the same venue (public reads only here)
export { POLY_US_CODES, polyUsAliases, polyUsWinnerMarket, type PolyUsMarket };

/** Slug candidates for a game on Polymarket US: {league}-{away}-{home}-{date}, the venue's own spelling first. */
export function polyUsSlugs(game: Game, template: LeagueTemplate): string[] {
  return polyUsEventSlugs(game.league, game.awayCode, game.homeCode, game.key.split(":")[3], template);
}

/**
 * Polymarket US's listing for one game: the long side must be the away team (its abbreviation
 * one of the away aliases), the home side is 1 minus it, sizes carried across. Exported for tests.
 */
export function polyUsListingFrom(
  m: PolyUsMarket,
  book: { bidCents: number; askCents: number; bidQty: number; askQty: number },
  game: Game,
  template: LeagueTemplate,
): VenueListing | null {
  const longSide = (m.marketSides ?? []).find((s) => s.long);
  const shortSide = (m.marketSides ?? []).find((s) => s.long === false);
  const abbr = longSide?.team?.abbreviation?.toLowerCase();
  const aways = polyUsAliases(game.league, game.awayCode, template);
  const homes = polyUsAliases(game.league, game.homeCode, template);
  if (!abbr) return null;
  const longIsAway = aways.includes(abbr);
  const longIsHome = homes.includes(abbr);
  if (!longIsAway && !longIsHome) return null;
  const long: SideQuote = { bidCents: book.bidCents, askCents: book.askCents, bidQty: book.bidQty, askQty: book.askQty };
  const short: SideQuote = {
    bidCents: book.askCents > 0 ? Math.round((100 - book.askCents) * 100) / 100 : 0,
    askCents: book.bidCents > 0 ? Math.round((100 - book.bidCents) * 100) / 100 : 0,
    bidQty: book.askQty,
    askQty: book.bidQty,
  };
  return {
    venue: "polymarket_us",
    id: m.slug,
    away: longIsAway ? long : short,
    home: longIsAway ? short : long,
    feeTheta: typeof m.feeCoefficient === "number" ? m.feeCoefficient : 0.095,
    awayName: (longIsAway ? longSide?.description : shortSide?.description) ?? game.awayCode,
    homeName: (longIsAway ? shortSide?.description : longSide?.description) ?? game.homeCode,
    startsAt: m.gameStartTime,
  };
}

async function fetchPolyUsBook(slug: string, fetchImpl: typeof fetch): Promise<{ bidCents: number; askCents: number; bidQty: number; askQty: number }> {
  const data = (await fetchJsonWithRetry(`${polyUsBase()}/v1/markets/${encodeURIComponent(slug)}/book`, fetchImpl)) as {
    marketData?: { bids?: Array<{ px: { value?: string }; qty: string }>; offers?: Array<{ px: { value?: string }; qty: string }> };
  };
  const md = data.marketData;
  const bids = (md?.bids ?? []).map((l) => ({ px: moneyCents(l.px as never), qty: Number(l.qty) })).sort((a, b) => b.px - a.px);
  const offers = (md?.offers ?? []).map((l) => ({ px: moneyCents(l.px as never), qty: Number(l.qty) })).sort((a, b) => a.px - b.px);
  return { bidCents: bids[0]?.px ?? 0, askCents: offers[0]?.px ?? 0, bidQty: bids[0]?.qty ?? 0, askQty: offers[0]?.qty ?? 0 };
}

/** Polymarket US's listing for each game, by slug; a game it does not list gets none. Concurrency bounded. */
export async function readPolyUsListings(games: Game[], fetchImpl: typeof fetch = fetch, concurrency = 6): Promise<Map<string, VenueListing>> {
  const out = new Map<string, VenueListing>();
  const queue = [...games];
  const worker = async () => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const t = templateOf(g.league);
      if (!t) continue;
      for (const slug of polyUsSlugs(g, t)) {
        try {
          const data = (await fetchJsonWithRetry(`${polyUsBase()}/v1/events?slug=${encodeURIComponent(slug)}`, fetchImpl)) as { events?: PolyUsEvent[] };
          const ev = (data.events ?? [])[0];
          if (!ev) continue;
          const m = polyUsWinnerMarket(ev);
          if (!m) break;
          const book = await fetchPolyUsBook(m.slug, fetchImpl);
          const listing = polyUsListingFrom(m, book, g, t);
          if (listing) {
            if (!listing.startsAt && ev.startTime) listing.startsAt = ev.startTime;
            out.set(g.key, listing);
          }
          break;
        } catch {
          // not listed under this slug, or unreachable: the next alias, else no listing
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Novig
// ---------------------------------------------------------------------------

export const NOVIG_PUBLIC_HOST = "https://api.novig.com";

export function novigHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NOVIG_PUBLIC_HOST ?? env.REFERENCE_BOOK_SIGNED_HOST ?? env.VENUE_API_HOST ?? NOVIG_PUBLIC_HOST).trim().replace(/\/+$/, "");
}

export interface NovigOutcomeBid {
  outcomeId: string;
  name: string;
  bid?: { price?: string | number; qty?: number | string } | null;
}

/**
 * Novig's listing for one game from its catalog row: the two outcomes are the two clubs by code;
 * the best bid on each is on the row. Ask on a side = 100 − the best bid on the other, with that
 * bid's size. Fee charged only once live: `feeTheta` is 0 before the start and the live
 * coefficient after. Exported for tests.
 */
export function novigListingFrom(m: RawVenueMarket & { outcomes: NovigOutcomeBid[] }, game: Game, template: LeagueTemplate, nowMs: number): VenueListing | null {
  const awayCodes = codesFor(template, game.awayName);
  const homeCodes = codesFor(template, game.homeName);
  const find = (codes: Set<string>) => m.outcomes.find((o) => codes.has(o.name.toUpperCase()));
  const a = find(awayCodes);
  const h = find(homeCodes);
  if (!a || !h || a === h) return null;
  const bid = (o: NovigOutcomeBid) => {
    const p = Number(o.bid?.price ?? 0);
    const q = Number(o.bid?.qty ?? 0);
    return { cents: Number.isFinite(p) && p > 0 ? Math.round(p * 10_000) / 100 : 0, shares: Number.isFinite(q) && q > 0 ? Math.round(q) / 100 : 0 };
  };
  const ab = bid(a);
  const hb = bid(h);
  const side = (own: typeof ab, other: typeof hb): SideQuote => ({
    bidCents: own.cents,
    askCents: other.cents > 0 ? Math.round((100 - other.cents) * 100) / 100 : 0,
    bidQty: own.shares,
    askQty: other.shares,
  });
  const live = Number.isFinite(m.startsTs) && m.startsTs <= nowMs;
  const coefficient = signedFeeCoefficient(m.fee);
  const preGame = signedFeeAppliesPreGame(m.fee);
  return {
    venue: "novig",
    id: m.marketId,
    away: side(ab, hb),
    home: side(hb, ab),
    feeTheta: preGame || live ? coefficient : 0,
    ...(preGame ? {} : { feeThetaLive: coefficient }),
    awayName: a.name,
    homeName: h.name,
    startsAt: Number.isFinite(m.startsTs) ? new Date(m.startsTs).toISOString() : undefined,
  };
}

/** One catalog read per league; each game matched by both clubs' codes and the ET date of the venue's start. */
export async function readNovigListings(games: Game[], opts: { fetchImpl?: typeof fetch; nowMs?: number; host?: string } = {}): Promise<Map<string, VenueListing>> {
  const nowMs = opts.nowMs ?? Date.now();
  const client = new VenueClient({ host: opts.host ?? novigHost(), fetchImpl: opts.fetchImpl, catalogTtlMs: 1 });
  const out = new Map<string, VenueListing>();
  const leagues = [...new Set(games.map((g) => g.league))];
  await Promise.all(
    leagues.map(async (league) => {
      const t = templateOf(league);
      if (!t) return;
      const markets = (await client.listMoneyMarkets(league)) as Array<RawVenueMarket & { outcomes: NovigOutcomeBid[] }>;
      for (const g of games.filter((x) => x.league === league)) {
        const date = g.key.split(":")[3];
        for (const m of markets) {
          if (!/^(OPEN|LIVE|SUSPENDED|TRADING)$/i.test(m.status ?? "OPEN") && m.status) continue;
          if (Number.isFinite(m.startsTs) && etDate(m.startsTs) !== date) continue;
          const listing = novigListingFrom(m, g, t, nowMs);
          if (listing) {
            out.set(g.key, listing);
            break;
          }
        }
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// the board
// ---------------------------------------------------------------------------

/** Fold the other venues' listings onto the Kalshi games; take the start time from a venue that publishes one. */
export function assembleGames(kalshi: KalshiGame[], polyUs: Map<string, VenueListing>, novig: Map<string, VenueListing>): Game[] {
  return kalshi.map(({ game }) => {
    const listings = [...game.listings];
    const p = polyUs.get(game.key);
    const n = novig.get(game.key);
    if (p) listings.push(p);
    if (n) listings.push(n);
    const start = [p, n].find((l) => l?.startsAt && Number.isFinite(Date.parse(l.startsAt)))?.startsAt;
    return { ...game, listings, ...(start ? { startsAt: new Date(Date.parse(start)).toISOString(), startSource: "venue" as const } : {}) };
  });
}
