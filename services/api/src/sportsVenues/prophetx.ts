/**
 * ProphetX's game-winner books, read from the public endpoints its own web page reads. No key,
 * no account: the same books anyone sees at prophetx.co without signing in. Nothing here can
 * place an order.
 *
 * Wire facts (https://www.prophetx.co, read 11 November 2026):
 *   GET  /trade/public/api/v1/tournaments/{id}/events?limit=100[&next=<cursor>]
 *        -> {next?, data:[{id, scheduled (ISO), status, tournament:{id,name}, competitors:[{id, name, abbreviation, seq}]}]}
 *        NBA is tournament 132, NFL 31, NHL 234. seq 0 is the home club.
 *   GET  /partner/v2/public/get_multiple_markets?event_ids=a,b,c&market_types=moneyline
 *        -> {data:[{eventId, markets:[{id, type:"moneyline", subType:"moneyline",
 *            selections:[[level, ...], [level, ...]]}]}]}
 *        one array of levels per club; a level is {competitorId, odds (American), value, stake}.
 *   POST /fre/v1/fees/estimate {items:[{event_id, tournament_id, fee_role:"FEE_ROLE_TAKER", price (cents), quantity (cost, $), sub_type}]}
 *        -> {items:[{model:"FEE_MODEL_MAKER_TAKER"|"FEE_MODEL_COMMISSION", fee, rate}]}
 *   GET  /commission/public/commissions?event_ids=a,b&sub_types=moneyline
 *        -> {commissions:[{eventId, subType, commission (percent of net winnings)}]}
 *
 * How a level reads. Every order on ProphetX backs a club at American odds; nobody "sells". The
 * levels under a club are the odds a taker can back that club at, best first. `value` is the
 * dollars a taker can still put on at those odds; `stake` is what the resting side put up, and
 * it is not reduced as the level is taken (a level seen at value 2.84 and stake 225.64 was gone
 * a few seconds later), so the size here comes from `value`. At implied price p a taker's dollar
 * buys 1/p contracts that pay $1, so the level holds value/p contracts. A level under $1 is
 * passed over: $1 is the venue's smallest order.
 *
 * So for a club: its ask is the best odds on it as a price, and its bid is 1 minus the other
 * club's ask with that level's size, because leaving a position means backing the other club.
 *
 * Fees, from the venue's fee schedule (prophetx.co/t-c/trading-fees) and read per game from its
 * own estimator so a change of model shows here without a code change:
 *   NHL games: maker/taker. A taker pays 0.035 x (1 - p) per dollar traded, which per contract
 *              is 0.035 x p x (1 - p): the same shape as Kalshi's fee, so it rides in feeTheta.
 *   Every other game: nothing at the trade, 2% of the market's net winnings at settlement
 *              (feeGain).
 * A game whose fee model cannot be read is left off the board rather than shown at a guessed fee.
 */

import { fetchJsonWithRetry } from "../eventCollar/kalshiPublic";
import { LEAGUE_TEMPLATES, type LeagueTemplate } from "../eventCollar/crossVenue/resolutionWhitelist";
import { codesFor } from "../eventCollar/crossVenue/venueBooks";
import { etDate } from "./readers";
import type { Game, SideQuote, VenueListing } from "./types";

export const PROPHETX_PUBLIC_HOST = "https://www.prophetx.co";

export function prophetxHost(env: NodeJS.ProcessEnv = process.env): string {
  return (env.PROPHETX_PUBLIC_HOST ?? PROPHETX_PUBLIC_HOST).trim().replace(/\/+$/, "");
}

/** The venue's own id and name for each league's games. The name is checked on every read. */
export const PROPHETX_TOURNAMENTS: Record<string, { id: number; name: string }> = {
  nba: { id: 132, name: "NBA" },
  nfl: { id: 31, name: "NFL" },
  nhl: { id: 234, name: "NHL" },
};

/** The venue's smallest order, dollars: a level holding less cannot be taken on its own. */
export const PROPHETX_MIN_ORDER_USD = 1;
/** The commission in the venue's fee schedule, percent of net winnings; used when a game's own rate is not listed. */
export const PROPHETX_DEFAULT_COMMISSION_PCT = 2;

export interface ProphetXCompetitor {
  id: number;
  name?: string;
  displayName?: string;
  abbreviation?: string;
  seq?: number;
}
export interface ProphetXEvent {
  id: number;
  scheduled?: string;
  status?: string;
  tournament?: { id?: number; name?: string };
  competitors?: ProphetXCompetitor[];
}
export interface ProphetXLevel {
  competitorId?: number;
  name?: string;
  odds?: number;
  value?: number;
  stake?: number;
}
export interface ProphetXMarket {
  id: number;
  type?: string;
  subType?: string;
  selections?: ProphetXLevel[][];
}
/** A game's fee as the venue charges a taker: per contract (theta·p·(1−p)) or on winnings (gain). */
export interface ProphetXFee {
  theta: number;
  gain: number;
}

const templateOf = (league: string): LeagueTemplate | null => LEAGUE_TEMPLATES.find((t) => t.league === league) ?? null;
const plain = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** American odds as the price of a $1 contract, cents with two decimals; null when not odds. */
export function americanToCents(odds: number | undefined): number | null {
  if (typeof odds !== "number" || !Number.isFinite(odds) || Math.abs(odds) < 100) return null;
  const p = odds > 0 ? 100 / (odds + 100) : -odds / (100 - odds);
  return Math.round(p * 10_000) / 100;
}

/**
 * The best level a taker can back a club at: the lowest price among levels holding at least the
 * venue's smallest order, with the $1 contracts that level holds (levels at the same odds are
 * added). Null when the club has no such level. Exported for tests.
 */
export function prophetxBestLevel(levels: ProphetXLevel[] | undefined): { cents: number; shares: number } | null {
  let best: { cents: number; odds: number; usd: number } | null = null;
  for (const l of levels ?? []) {
    const cents = americanToCents(l.odds);
    const usd = Number(l.value);
    if (cents === null || !Number.isFinite(usd) || usd < PROPHETX_MIN_ORDER_USD) continue;
    if (best && l.odds === best.odds) best.usd += usd;
    else if (!best || cents < best.cents) best = { cents, odds: l.odds as number, usd };
  }
  if (!best) return null;
  // the exact price, not the rounded cents, sets how many contracts the dollars buy
  const p = best.odds > 0 ? 100 / (best.odds + 100) : -best.odds / (100 - best.odds);
  return { cents: best.cents, shares: Math.floor((best.usd / p) * 100) / 100 };
}

/** Does this competitor name the club? Its full name as the venue writes it, or its code. */
function competitorIs(c: ProphetXCompetitor, club: string, template: LeagueTemplate): boolean {
  const want = plain(club);
  if ([c.name, c.displayName].some((n) => typeof n === "string" && plain(n) === want)) return true;
  const code = (c.abbreviation ?? "").toUpperCase();
  return code !== "" && codesFor(template, club).has(code);
}

/** The event's two competitors as the game's away and home clubs; null unless both are there and differ. */
export function prophetxSides(ev: ProphetXEvent, game: Game, template: LeagueTemplate): { away: ProphetXCompetitor; home: ProphetXCompetitor } | null {
  const cs = ev.competitors ?? [];
  if (cs.length !== 2) return null;
  const away = cs.find((c) => competitorIs(c, game.awayName, template));
  const home = cs.find((c) => competitorIs(c, game.homeName, template));
  if (!away || !home || away === home) return null;
  return { away, home };
}

/**
 * ProphetX's listing for one game from its event, its winner market and its fee. The market must
 * be the two-way winner (subType "moneyline": the regulation-only and period markets carry other
 * subtypes) with one array of levels per club. Exported for tests.
 */
export function prophetxListingFrom(ev: ProphetXEvent, market: ProphetXMarket, fee: ProphetXFee, game: Game, template: LeagueTemplate): VenueListing | null {
  const sides = prophetxSides(ev, game, template);
  if (!sides) return null;
  if (market.type !== "moneyline" || (market.subType ?? "moneyline") !== "moneyline") return null;
  const selections = market.selections ?? [];
  if (selections.length !== 2) return null;
  const levelsOf = (c: ProphetXCompetitor): ProphetXLevel[] | null => {
    const own = selections.filter((sel) => sel.length > 0 && sel.every((l) => l.competitorId === c.id));
    // an empty array is a club nobody is offering odds on right now; two arrays naming the same club is not this market
    return own.length === 1 ? own[0] : own.length === 0 ? [] : null;
  };
  const awayLevels = levelsOf(sides.away);
  const homeLevels = levelsOf(sides.home);
  if (!awayLevels || !homeLevels) return null;
  // every level in the market belongs to one of the two clubs
  if (selections.some((sel) => sel.some((l) => l.competitorId !== sides.away.id && l.competitorId !== sides.home.id))) return null;
  const a = prophetxBestLevel(awayLevels);
  const h = prophetxBestLevel(homeLevels);
  const side = (own: typeof a, other: typeof h): SideQuote => ({
    bidCents: other ? Math.round((100 - other.cents) * 100) / 100 : 0,
    askCents: own?.cents ?? 0,
    bidQty: other?.shares ?? 0,
    askQty: own?.shares ?? 0,
  });
  const startMs = Date.parse(ev.scheduled ?? "");
  return {
    venue: "prophetx",
    id: `${ev.id}:${market.id}`,
    away: side(a, h),
    home: side(h, a),
    feeTheta: fee.theta,
    ...(fee.gain > 0 ? { feeGain: fee.gain } : {}),
    awayName: sides.away.name ?? sides.away.abbreviation ?? game.awayCode,
    homeName: sides.home.name ?? sides.home.abbreviation ?? game.homeCode,
    startsAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : undefined,
  };
}

interface FeeEstimate {
  model?: string;
  fee?: number;
  rate?: number;
}

/**
 * A game's taker fee from the venue's own estimator, asked at two prices for a $100 cost.
 * Maker/taker: the schedule is rate = a x (1 - p) per dollar, so both answers must give the same
 * a; if they do not, the shape has changed and the fee is not understood (null). Commission:
 * nothing at the trade, `commissionPct` of net winnings at settlement. Exported for tests.
 */
export function prophetxFeeFrom(at50: FeeEstimate | undefined, at25: FeeEstimate | undefined, commissionPct: number | undefined): ProphetXFee | null {
  if (!at50 || !at25 || at50.model !== at25.model) return null;
  if (at50.model === "FEE_MODEL_COMMISSION") {
    if (Number(at50.fee) !== 0 || Number(at25.fee) !== 0) return null;
    const pct = typeof commissionPct === "number" && Number.isFinite(commissionPct) && commissionPct > 0 ? commissionPct : PROPHETX_DEFAULT_COMMISSION_PCT;
    return pct < 50 ? { theta: 0, gain: Math.round(pct * 100) / 10_000 } : null;
  }
  if (at50.model === "FEE_MODEL_MAKER_TAKER") {
    const a50 = Number(at50.rate) / 0.5;
    const a25 = Number(at25.rate) / 0.75;
    if (!Number.isFinite(a50) || !Number.isFinite(a25) || a50 < 0 || a50 > 0.5 || Math.abs(a50 - a25) > 1e-6) return null;
    return { theta: Math.round(a50 * 1e6) / 1e6, gain: 0 };
  }
  return null;
}

/** An event that is over or off: its market, if one is still returned, is not a book to read. */
const FINISHED = /^(ended|closed|complete|finished|settled|cancel|postponed|abandoned)/i;

async function fetchEvents(host: string, tournamentId: number, fetchImpl: typeof fetch): Promise<ProphetXEvent[]> {
  const out: ProphetXEvent[] = [];
  let next = "";
  for (let page = 0; page < 5; page += 1) {
    const url = `${host}/trade/public/api/v1/tournaments/${tournamentId}/events?limit=100${next ? `&next=${encodeURIComponent(next)}` : ""}`;
    const data = (await fetchJsonWithRetry(url, fetchImpl)) as { next?: string | number | null; data?: ProphetXEvent[] };
    const rows = Array.isArray(data.data) ? data.data : [];
    out.push(...rows);
    next = data.next === undefined || data.next === null ? "" : String(data.next);
    if (!next || !rows.length) break;
  }
  return out;
}

async function postJson(url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "atticus-event-demo" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * ProphetX's listing for each game: one events read per league, each game matched by both clubs
 * and the ET date of the venue's start, then one books read and one fee read for the games
 * matched. A game it does not list gets none. `notes` receives, in words, anything left off the
 * board for a reason other than "not listed".
 */
export async function readProphetXListings(
  games: Game[],
  opts: { fetchImpl?: typeof fetch; host?: string; notes?: string[] } = {},
): Promise<Map<string, VenueListing>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = opts.host ?? prophetxHost();
  const note = (line: string) => opts.notes?.push(line);
  const out = new Map<string, VenueListing>();
  const matched: Array<{ game: Game; ev: ProphetXEvent; template: LeagueTemplate; tournamentId: number }> = [];
  const leagues = [...new Set(games.map((g) => g.league))];
  await Promise.all(
    leagues.map(async (league) => {
      const t = templateOf(league);
      const tour = PROPHETX_TOURNAMENTS[league];
      if (!t || !tour) return;
      const events = (await fetchEvents(host, tour.id, fetchImpl)).filter((e) => !FINISHED.test(e.status ?? ""));
      const wrong = events.filter((e) => plain(e.tournament?.name ?? "") !== plain(tour.name));
      if (wrong.length) {
        // the id no longer means this league: nothing from it is shown
        note(`${league}: the venue's list ${tour.id} is no longer named ${tour.name}; its games are left off`);
        return;
      }
      for (const g of games.filter((x) => x.league === league)) {
        const date = g.key.split(":")[3];
        const hits = events.filter((e) => {
          const ms = Date.parse(e.scheduled ?? "");
          return Number.isFinite(ms) && etDate(ms) === date && prophetxSides(e, g, t) !== null;
        });
        if (hits.length === 1) matched.push({ game: g, ev: hits[0], template: t, tournamentId: tour.id });
        else if (hits.length > 1) note(`${g.key}: ${hits.length} events match on the venue; left off`);
      }
    }),
  );
  if (!matched.length) return out;

  const markets = new Map<number, ProphetXMarket[]>();
  const commission = new Map<number, number>();
  const estimates = new Map<number, [FeeEstimate | undefined, FeeEstimate | undefined]>();
  await Promise.all([
    ...chunks(matched, 50).map(async (part) => {
      const ids = part.map((m) => m.ev.id).join(",");
      const data = (await fetchJsonWithRetry(`${host}/partner/v2/public/get_multiple_markets?event_ids=${ids}&market_types=moneyline`, fetchImpl)) as {
        data?: Array<{ eventId: number; markets?: ProphetXMarket[] }>;
      };
      for (const row of data.data ?? []) markets.set(Number(row.eventId), row.markets ?? []);
    }),
    ...chunks(matched, 50).map(async (part) => {
      const items = part.flatMap((m) =>
        [50, 25].map((price) => ({ event_id: m.ev.id, tournament_id: m.tournamentId, fee_role: "FEE_ROLE_TAKER", price, quantity: 100, sub_type: "moneyline" })),
      );
      const data = (await postJson(`${host}/fre/v1/fees/estimate`, { items }, fetchImpl)) as { items?: FeeEstimate[] };
      const got = data.items ?? [];
      // the answers come back in the order asked; a different count means they cannot be paired
      if (got.length !== items.length) throw new Error(`ProphetX fee estimate answered ${got.length} of ${items.length} items`);
      part.forEach((m, i) => estimates.set(m.ev.id, [got[i * 2], got[i * 2 + 1]]));
    }),
    ...chunks(matched, 50).map(async (part) => {
      try {
        const ids = part.map((m) => m.ev.id).join(",");
        const data = (await fetchJsonWithRetry(`${host}/commission/public/commissions?event_ids=${ids}&sub_types=moneyline`, fetchImpl)) as {
          commissions?: Array<{ eventId: number; subType?: string; commission?: number }>;
        };
        for (const c of data.commissions ?? []) if ((c.subType ?? "moneyline") === "moneyline" && typeof c.commission === "number") commission.set(Number(c.eventId), c.commission);
      } catch {
        note(`commission rates not read; the venue's published ${PROPHETX_DEFAULT_COMMISSION_PCT}% of net winnings assumed`);
      }
    }),
  ]);

  let feeUnread = 0;
  for (const m of matched) {
    const market = (markets.get(m.ev.id) ?? []).filter((x) => x.type === "moneyline" && (x.subType ?? "moneyline") === "moneyline");
    if (market.length !== 1) continue;
    const est = estimates.get(m.ev.id);
    const fee = prophetxFeeFrom(est?.[0], est?.[1], commission.get(m.ev.id));
    if (!fee) {
      feeUnread += 1;
      continue;
    }
    const listing = prophetxListingFrom(m.ev, market[0], fee, m.game, m.template);
    if (listing) out.set(m.game.key, listing);
  }
  if (feeUnread) {
    const line = `${feeUnread} game${feeUnread > 1 ? "s" : ""} left off: the venue's fee for them was not understood`;
    // every game unreadable is the venue's fee schedule having changed: say it as the venue being down, not as an empty column
    if (feeUnread === matched.length) throw new Error(`ProphetX: ${line}`);
    note(line);
  }
  return out;
}
