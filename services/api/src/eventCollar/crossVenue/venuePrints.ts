/**
 * REFERENCE PRINTS: a regulated US exchange that publishes no live book but does publish, once a
 * day, every trade it matched the day before, in the CFTC's public reporting format. The file is
 * read as a THIRD kind of reference beside the two hedge routes and the reference books: not a
 * price a hedge could have been filled at (the prints are a day old by the time they are public),
 * but the last price the opposing outcome actually traded at there, with how much traded and when.
 *
 * Why it is kept apart from the reference books: a book is read at the same second as the quote
 * and priced like a hedge route; a print is yesterday's tape. Pricing the default tier on a day-old
 * print would put a number on the record that nothing could have been filled at. So the print is
 * recorded as what it is (price, time, size, age) beside the price the live hedge actually paid,
 * and the comparison page says the gap is a sign, not a quote.
 *
 * The file: `${host}/reporting/trade_data_YYYY-MM-DD.json.gz`, a gzipped JSON array of
 * { ticker_name, report_ticker, date, create_ts, contracts_traded, price } with price in cents and
 * contracts as (fractional) $1-face contracts. Winner markets carry tickers of the shape
 * `<prefix><LEAGUE>GAMEWIN_<AWAY><HOME><YY><MON><DD><HHMM>_<TEAM>`; the team codes are the ones the
 * league templates already know (checked against every code the venue listed). Parlays are
 * `<prefix>COMBO-<id>` and are left out: a parlay print says nothing about one game's price.
 *
 * Credentials: none. REFERENCE_PRINTS_HOST alone turns it on; unset, nothing is read and the
 * record carries no print. A day whose file is not yet published is tried back three days; a game
 * with no print on the report day is recorded as not printed, never guessed. One file is read per
 * day and its winner markets kept in memory; a failed read is retried after a short hold so a scan
 * never hammers it. The file is tens of megabytes inflated and mostly parlays, so it is streamed
 * (gunzip, then one row at a time) rather than parsed whole: the service runs in half a gigabyte.
 *
 * Nothing here names the venue in anything the record publishes: the id is the kind of source,
 * the public words are "reference prints C".
 */

import { once } from "node:events";
import { createGunzip } from "node:zlib";
import type { MatchedPair } from "./types";
import { codesFor, pairClubs } from "./venueBooks";

/** Stable ledger key. The kind of source, not the venue. */
export const REFERENCE_PRINT_IDS = ["public_prints"] as const;
export type ReferencePrintId = (typeof REFERENCE_PRINT_IDS)[number];

/** What the public page and the operator report call it. Never the venue. */
export const REFERENCE_PRINT_WORDS: Record<ReferencePrintId, string> = {
  public_prints: "reference prints C",
};

/** One ticker's day on the venue's tape. */
export interface PrintSummary {
  ticker: string;
  /** the day the venue reported, YYYY-MM-DD in its own calendar */
  reportDate: string;
  /** the last print of the day, cents per $1-face contract */
  lastPriceCents: number;
  lastPrintAtIso: string;
  /** the day's volume-weighted average, cents */
  vwapCents: number;
  /** contracts traded that day ($1 face, fractional on this venue) */
  dayContracts: number;
  /** number of prints that day */
  prints: number;
}

/** The venue's day for the opposing outcome of one pair, or why there is none. */
export type ReferencePrint =
  | { id: ReferencePrintId; print: PrintSummary; reason?: undefined }
  | { id: ReferencePrintId; print: null; reason: string };

export interface ReferencePrintSource {
  id: ReferencePrintId;
  read(pair: MatchedPair, now: Date): Promise<ReferencePrint>;
}

interface RawTrade {
  ticker_name?: unknown;
  report_ticker?: unknown;
  date?: unknown;
  create_ts?: unknown;
  contracts_traded?: unknown;
  price?: unknown;
}

/** One report day, indexed: the winner markets' summaries by ticker, and their tickers by league. */
export interface DayIndex {
  reportDate: string;
  byTicker: Map<string, PrintSummary>;
  winnersByLeague: Map<string, string[]>;
}

const DAY_MS = 86_400_000;
const START_WINDOW_MS = 1.5 * DAY_MS;
/** how far back a missing day's file is looked for before the venue counts as not having published */
const DAYS_BACK = 3;
/** a failed or missing day is not asked for again before this */
const HOLD_MS = 10 * 60_000;

/** the leagues the templates cover, as the venue writes them in a ticker */
const LEAGUES = ["NFL", "NBA", "MLB"] as const;

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// ---------------------------------------------------------------------------
// ticker shape
// ---------------------------------------------------------------------------

export interface WinnerTicker {
  league: string;
  /** the two clubs' codes run together as the venue writes them, e.g. "HOUJAX" */
  teams: string;
  /** the game's start as the ticker carries it, taken as UTC (the window absorbs the zone) */
  startMs: number;
  /** the outcome: the club code this contract pays on */
  code: string;
}

const WINNER_REST_RE = /^([A-Z]+)(\d{2})([A-Z]{3})(\d{2})(\d{4})_([A-Z]+)$/;
/** leagues the venue lists whose codes end in one of ours; "WNBA" must not read as "NBA" */
const LOOKALIKE_LEAGUES = ["WNBA"];

/**
 * Parse a winner-market ticker: a letters-only venue prefix, one of the leagues we know, the
 * literal GAMEWIN_, then teams, start and outcome code. Null for anything else (parlays,
 * spreads, totals, props, first-half markets, leagues we do not cover).
 */
export function parseWinnerTicker(ticker: string, leagues: readonly string[] = LEAGUES): WinnerTicker | null {
  for (const league of leagues) {
    const marker = `${league}GAMEWIN_`;
    const at = ticker.indexOf(marker);
    if (at <= 0 || !/^[A-Z]+$/.test(ticker.slice(0, at))) continue;
    const head = ticker.slice(0, at + league.length);
    if (LOOKALIKE_LEAGUES.some((l) => l !== league && head.endsWith(l))) continue;
    const r = WINNER_REST_RE.exec(ticker.slice(at + marker.length));
    if (!r) continue;
    const startMs = tickerStart(r[2], r[3], r[4], r[5]);
    if (startMs === null) continue;
    return { league, teams: r[1], startMs, code: r[6] };
  }
  return null;
}

function tickerStart(yy: string, mon: string, dd: string, hhmm: string): number | null {
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const ms = Date.UTC(2000 + Number(yy), month, Number(dd), Number(hhmm.slice(0, 2)), Number(hhmm.slice(2)));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The ticker in a day's index that pays on the opposing club of this pair's game: the league's
 * winner markets, the two clubs' codes run together either way round, the start within the
 * window of ours, the outcome code the opposing club's. Null when there is none.
 */
export function opposingTickerFor(index: DayIndex, pair: MatchedPair): string | null {
  const clubs = pairClubs(pair);
  if (!clubs) return null;
  const league = clubs.template.league.toUpperCase();
  const ours = [...codesFor(clubs.template, clubs.ours)];
  const opp = codesFor(clubs.template, clubs.opposing);
  const pairings = new Set<string>();
  for (const a of ours) {
    for (const b of opp) {
      pairings.add(a + b);
      pairings.add(b + a);
    }
  }
  const gameStart = Date.parse(pair.gameStartTime);
  for (const ticker of index.winnersByLeague.get(league) ?? []) {
    const w = parseWinnerTicker(ticker, [league]);
    if (!w || !pairings.has(w.teams) || !opp.has(w.code)) continue;
    if (Number.isFinite(gameStart) && Math.abs(w.startMs - gameStart) > START_WINDOW_MS) continue;
    return ticker;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the day's file
// ---------------------------------------------------------------------------

/** Inflate when the bytes carry the gzip magic; pass through otherwise (a proxy may have inflated the file already). */
async function* inflated(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  const head = first.value;
  const rest = async function* () {
    yield head;
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
  };
  if (!(head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b)) {
    yield* rest();
    return;
  }
  const gunzip = createGunzip();
  const feed = (async () => {
    for await (const c of rest()) {
      if (!gunzip.write(c)) await once(gunzip, "drain");
    }
    gunzip.end();
  })();
  for await (const out of gunzip) yield out as Uint8Array;
  await feed;
}

/**
 * The objects of a JSON array of flat objects, one at a time, from a byte stream: braces are
 * counted outside strings, and each closed object is parsed on its own. Nothing larger than one
 * row is ever held as text. Rows that are not valid JSON are skipped.
 */
export async function* jsonArrayRows(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for await (const chunk of inflated(chunks)) {
    // the carried prefix was scanned already; pick up where the last chunk ended
    const from = pending.length;
    const text = pending + decoder.decode(chunk, { stream: true });
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            yield JSON.parse(text.slice(start, i + 1)) as unknown;
          } catch {
            // one unreadable row is skipped; the day is still read
          }
          start = -1;
        }
      }
    }
    // only an open row carries over to the next chunk
    if (depth === 0) {
      pending = "";
    } else {
      pending = text.slice(start);
      start = 0;
    }
  }
}

/**
 * Build a day's index from its trade rows: only the winner markets of the covered leagues are
 * kept (parlays, spreads, totals and props are passed over). Rows that do not parse are skipped,
 * never guessed at.
 */
export function indexTrades(reportDate: string, rows: Iterable<unknown>, leagues: readonly string[] = LEAGUES): DayIndex {
  const acc = new Map<string, { last: PrintSummary; notional: number }>();
  const fold = indexFolder(reportDate, acc, leagues);
  for (const row of rows) fold(row);
  return finishIndex(reportDate, acc, leagues);
}

function indexFolder(reportDate: string, acc: Map<string, { last: PrintSummary; notional: number }>, leagues: readonly string[]): (row: unknown) => void {
  return (row) => {
    if (!row || typeof row !== "object") return;
    const t = row as RawTrade;
    const ticker = typeof t.ticker_name === "string" ? t.ticker_name : null;
    if (!ticker || !parseWinnerTicker(ticker, leagues)) return;
    const price = typeof t.price === "number" ? t.price : Number(t.price);
    const qty = typeof t.contracts_traded === "number" ? t.contracts_traded : Number(t.contracts_traded);
    const ts = typeof t.create_ts === "string" ? Date.parse(t.create_ts) : NaN;
    if (!Number.isFinite(price) || price <= 0 || price >= 100 || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(ts)) return;
    const cur = acc.get(ticker);
    if (!cur) {
      acc.set(ticker, {
        last: { ticker, reportDate, lastPriceCents: price, lastPrintAtIso: new Date(ts).toISOString(), vwapCents: price, dayContracts: qty, prints: 1 },
        notional: price * qty,
      });
      return;
    }
    cur.notional += price * qty;
    cur.last.dayContracts += qty;
    cur.last.prints += 1;
    if (ts >= Date.parse(cur.last.lastPrintAtIso)) {
      cur.last.lastPriceCents = price;
      cur.last.lastPrintAtIso = new Date(ts).toISOString();
    }
  };
}

function finishIndex(reportDate: string, acc: Map<string, { last: PrintSummary; notional: number }>, leagues: readonly string[]): DayIndex {
  const byTicker = new Map<string, PrintSummary>();
  const winnersByLeague = new Map<string, string[]>();
  for (const [ticker, { last, notional }] of acc) {
    last.vwapCents = Math.round((notional / last.dayContracts) * 100) / 100;
    last.dayContracts = Math.round(last.dayContracts * 100) / 100;
    byTicker.set(ticker, last);
    const w = parseWinnerTicker(ticker, leagues);
    if (w) {
      const list = winnersByLeague.get(w.league) ?? [];
      list.push(ticker);
      winnersByLeague.set(w.league, list);
    }
  }
  return { reportDate, byTicker, winnersByLeague };
}

export class PrintsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
  ) {
    super(`prints ${path}: HTTP ${status}`);
  }
}

export interface PublicPrintsClientConfig {
  host: string;
  fetchImpl?: typeof fetch;
  /** the day's file is given this long before it counts as unreachable */
  timeoutMs?: number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Reads one report day per calendar day and keeps it; the venue's file is tens of megabytes. */
export class PublicPrintsClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private latest: DayIndex | null = null;
  /** days asked for and not had, with when they may be asked for again */
  private readonly holds = new Map<string, number>();

  constructor(cfg: PublicPrintsClientConfig) {
    this.host = cfg.host.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 20_000;
  }

  pathFor(reportDate: string): string {
    return `/reporting/trade_data_${reportDate}.json.gz`;
  }

  /**
   * The most recent published day at or before yesterday (today's file does not exist until the
   * day is over). The newest day already held is reused; a newer one is fetched once it exists.
   * Null when none of the last few days has been published, or none could be reached.
   */
  async latestDay(now: Date): Promise<{ index: DayIndex | null; error: string | null }> {
    let error: string | null = null;
    for (let back = 1; back <= DAYS_BACK; back += 1) {
      const day = utcDay(now.getTime() - back * DAY_MS);
      if (this.latest && this.latest.reportDate >= day) return { index: this.latest, error: null };
      const hold = this.holds.get(day);
      if (hold !== undefined && hold > now.getTime()) continue;
      try {
        const index = await this.fetchDay(day);
        this.latest = index;
        return { index, error: null };
      } catch (err) {
        this.holds.set(day, now.getTime() + HOLD_MS);
        if (err instanceof PrintsApiError && (err.status === 404 || err.status === 403)) continue;
        error = String(err instanceof Error ? err.message : err).slice(0, 80);
        break;
      }
    }
    return { index: this.latest, error };
  }

  async fetchDay(reportDate: string): Promise<DayIndex> {
    const path = this.pathFor(reportDate);
    const res = await this.fetchImpl(`${this.host}${path}`, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new PrintsApiError(res.status, path);
    if (!res.body) throw new Error(`prints ${path}: empty body`);
    const acc = new Map<string, { last: PrintSummary; notional: number }>();
    const fold = indexFolder(reportDate, acc, LEAGUES);
    for await (const row of jsonArrayRows(res.body as unknown as AsyncIterable<Uint8Array>)) fold(row);
    return finishIndex(reportDate, acc, LEAGUES);
  }
}

// ---------------------------------------------------------------------------
// the source, configuration, and the read that never throws
// ---------------------------------------------------------------------------

export function publicPrintsSource(client: PublicPrintsClient): ReferencePrintSource {
  return {
    id: "public_prints",
    async read(pair, now) {
      if (!pairClubs(pair)) return { id: "public_prints", print: null, reason: "league_not_covered" };
      const { index, error } = await client.latestDay(now);
      if (!index) return { id: "public_prints", print: null, reason: error ? `unreachable: ${error}` : "report_not_published" };
      const ticker = opposingTickerFor(index, pair);
      if (!ticker) return { id: "public_prints", print: null, reason: "not_printed" };
      const print = index.byTicker.get(ticker);
      return print ? { id: "public_prints", print } : { id: "public_prints", print: null, reason: "not_printed" };
    },
  };
}

export interface ReferencePrintSourcesOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The host set, one source; unset, none. Nothing else is needed: the file is public. */
export function referencePrintSourcesFromEnv(env: NodeJS.ProcessEnv = process.env, opts: ReferencePrintSourcesOptions = {}): { sources: ReferencePrintSource[]; notes: string[] } {
  const host = env.REFERENCE_PRINTS_HOST?.trim();
  if (!host) return { sources: [], notes: [] };
  if (!/^https?:\/\//.test(host)) return { sources: [], notes: ["reference prints C: REFERENCE_PRINTS_HOST must be an http(s) origin; off"] };
  return { sources: [publicPrintsSource(new PublicPrintsClient({ host, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs }))], notes: [] };
}

/** Every configured print source for one pair. One that throws is recorded as unreachable; the quote never waits on, or fails for, a print. */
export async function readReferencePrints(sources: ReferencePrintSource[], pair: MatchedPair, now: Date): Promise<ReferencePrint[]> {
  if (sources.length === 0) return [];
  const settled = await Promise.allSettled(sources.map((s) => s.read(pair, now)));
  return settled.map((r, i) =>
    r.status === "fulfilled" ? r.value : { id: sources[i].id, print: null, reason: `unreachable: ${String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 80)}` },
  );
}
