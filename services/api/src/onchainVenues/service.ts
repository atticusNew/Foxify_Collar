/**
 * The cycle and the routes of the on-chain venues page.
 *
 * Discovery runs beside the book cycle, never inside it, so a slow catalog read does not hold
 * the prices back. The page is behind a key of its own. Nothing is written to disk: the page
 * shows the last read and keeps no history.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AggregatorClient, aggregatorConfigFromEnv, readSnapshots, signerFromSecret } from "../eventCollar/crossVenue/aggregatorMarkets";
import { buildBoard, type Board } from "./board";
import { OnchainFeed } from "./feed";
import { renderOnchainHtml, type PageData } from "./html";
import { readLimitlessPublicGames } from "./limitlessPublic";
import type { FeedHealth, Snapshot } from "./types";

/** a key shorter than this can be guessed: the page stays off */
export const PAGE_KEY_MIN = 16;

const same = (given: string, key: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * A generated key can hold a plus sign, and a plus sign in a link's query is read as a space.
 * So a key pasted into a link as it stands arrives with its plus signs turned to spaces: that
 * is taken as the same key. Nothing else is: a key holds no spaces of its own.
 */
export function keyMatches(given: string | null, key: string): boolean {
  if (given === null || !key) return false;
  const asGiven = same(given, key);
  const plusRestored = same(given.replace(/ /g, "+"), key);
  return asGiven || plusRestored;
}

export interface ServiceOptions {
  /** null when the feed key is not set: the page says so and reads nothing */
  feed: OnchainFeed | null;
  /** the page's key; empty or too short turns the page off */
  key: string;
  intervalSec?: number;
  discoverEveryMs?: number;
  horizonHours?: number;
  log?: (line: string) => void;
}

export class OnchainVenuesService {
  private readonly feed: OnchainFeed | null;
  private readonly key: string;
  private readonly keyOff: string | null;
  readonly intervalSec: number;
  private readonly discoverEveryMs: number;
  private readonly horizonHours: number;
  private readonly log: (line: string) => void;
  private last: { snapshot: Snapshot; board: Board } | null = null;
  private lastDiscoverStart = 0;
  private cycles = 0;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: ServiceOptions) {
    this.feed = opts.feed;
    const k = opts.key.trim();
    this.keyOff = !k ? "its key is not set" : k.length < PAGE_KEY_MIN ? `its key is shorter than ${PAGE_KEY_MIN} characters` : null;
    this.key = this.keyOff ? "" : k;
    this.intervalSec = Math.max(15, opts.intervalSec ?? 60);
    this.discoverEveryMs = Math.max(60_000, opts.discoverEveryMs ?? 10 * 60_000);
    this.horizonHours = opts.horizonHours ?? 48;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** One turn: start a catalog read when one is due, then read the books of what is known. */
  async cycle(nowMs = Date.now()): Promise<void> {
    if (!this.feed) return;
    // while games are still to read the passes run back to back; after that, on the clock
    if (!this.feed.busy && (nowMs - this.lastDiscoverStart >= this.discoverEveryMs || this.feed.pending > 0)) {
      this.lastDiscoverStart = nowMs;
      const first = this.feed.discoveredAt === null;
      const run = this.feed.discover(nowMs).catch((err) => this.log(`[onchain-venues] discovery failed: ${(err as Error).message}`));
      // the first board needs a catalog; after that the old one serves while the new one is read
      if (first) await run;
    }
    try {
      const snapshot = await this.feed.snapshot(nowMs);
      this.last = { snapshot, board: buildBoard(snapshot) };
      this.lastError = null;
    } catch (err) {
      this.lastError = String((err as Error).message).slice(0, 200);
    }
    this.cycles += 1;
  }

  start(): void {
    if (!this.feed) {
      this.log("[onchain-venues] the feed key is not set: nothing is read");
      return;
    }
    const turn = async (): Promise<void> => {
      if (this.stopped) return;
      const t0 = Date.now();
      await this.cycle().catch((err) => this.log(`[onchain-venues] cycle failed: ${(err as Error).message}`));
      if (this.stopped) return;
      this.timer = setTimeout(turn, Math.max(5_000, this.intervalSec * 1000 - (Date.now() - t0)));
    };
    void turn();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** For /healthz, which is open: counts and states, nothing a reader could use to open the page. */
  health(): Record<string, unknown> {
    const f = this.last?.snapshot.feed;
    const d = f?.diagnostics;
    return {
      page: this.keyOff ? `off: ${this.keyOff}` : "on",
      feedKey: this.feed ? "set" : "not set",
      cycles: this.cycles,
      lastReadAt: this.last?.snapshot.at ?? null,
      lastError: this.lastError,
      games: this.last?.board.games.length ?? 0,
      comparable: this.last?.board.comparable ?? 0,
      catalog: f ? { readAt: f.discoveredAt, seconds: f.discoveryMs === null ? null : Math.round(f.discoveryMs / 1000), competitions: f.competitions, gamesInWindow: f.eventsInHorizon, gamesRead: f.eventsRead, gamesStillToRead: f.eventsPending, boardLimit: f.boardCap ?? null, leftOffTheBoard: f.eventsOverCap, comparableLeftOff: f.comparableOverCap, notes: f.notes } : null,
      limitless: f ? withoutSample(f.limitless) : null,
      books: f?.books ?? null,
      // counts only: no game, market or team is named on the open check (the names are on /api/diagnostics, behind the key)
      diagnostics: d ? { games: d.games, gamesByVenue: d.gamesByVenue, gamesNamingTwo: d.gamesNamingTwo, winner: d.winner, gamesWithVenueOffWinner: d.gamesWithVenueOffWinner } : null,
    };
  }

  /** What the catalog looked like, with names: the feed's market titles, example games, Limitless markets left over. Behind the key. */
  diagnostics(): Record<string, unknown> {
    const f = this.last?.snapshot.feed;
    return { at: this.last?.snapshot.at ?? null, catalog: f?.diagnostics ?? null, limitless: f?.limitless ?? null, unmatchedLimitless: this.last?.snapshot.unmatchedLimitless ?? [], notes: f?.notes ?? [] };
  }

  private pageData(): PageData {
    const empty = { capabilities: [], discoveredAt: null, discoveryMs: null, notes: [], competitions: 0, eventsInHorizon: 0, eventsRead: 0, eventsPending: 0, eventsOverCap: 0, comparableOverCap: 0, limitless: { state: "not_read" as const, markets: 0, sports: 0, matched: 0 }, books: { asked: 0, read: 0, empty: 0, errors: {}, ms: null } };
    return {
      board: this.last?.board ?? null,
      coverage: this.last?.snapshot.coverage ?? [],
      unmatchedLimitless: this.last?.snapshot.unmatchedLimitless ?? [],
      feed: this.last?.snapshot.feed ?? empty,
      hasFeed: this.feed !== null,
      intervalSec: this.intervalSec,
      horizonHours: this.horizonHours,
    };
  }

  /** True when the request was answered. Without the key nothing is: the caller's 404 says the same for a wrong key and a wrong path. */
  handle(_req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (this.keyOff || !keyMatches(url.searchParams.get("k"), this.key)) return false;
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" });
      res.end(renderOnchainHtml(this.pageData(), { refreshSec: this.intervalSec }));
      return true;
    }
    if (path === "/api/diagnostics") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      res.end(JSON.stringify(this.diagnostics()));
      return true;
    }
    if (path === "/api/board") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      res.end(JSON.stringify({ board: this.last?.board ?? null, coverage: this.last?.snapshot.coverage ?? [], unmatchedLimitless: this.last?.snapshot.unmatchedLimitless ?? [], feed: this.last?.snapshot.feed ?? null }));
      return true;
    }
    return false;
  }
}

const withoutSample = (l: FeedHealth["limitless"]): Omit<FeedHealth["limitless"], "unmatchedSample"> => {
  const { unmatchedSample: _names, ...counts } = l;
  return counts;
};

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** a catalog request that hangs would hold discovery for good */
const REQUEST_TIMEOUT_MS = 20_000;

export function onchainServiceFromEnv(env: NodeJS.ProcessEnv = process.env): OnchainVenuesService {
  const cfg = aggregatorConfigFromEnv(env);
  const horizonHours = positive(env.ONCHAIN_VENUES_HORIZON_HOURS, 48);
  let feed: OnchainFeed | null = null;
  if (cfg) {
    const signer = signerFromSecret(cfg.keyId, cfg.secret);
    const client = new AggregatorClient({ host: cfg.host, signer, fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) });
    feed = new OnchainFeed({
      source: {
        whoami: () => client.whoami(),
        time: () => client.time(),
        listSports: () => client.listSports(),
        listCompetitions: () => client.listCompetitions(),
        listEvents: (id) => client.listEvents(id),
        listEventMarkets: (id) => client.listEventMarkets(id),
        listLimitlessMarkets: (pageToken) => client.listLimitlessMarkets(pageToken),
        listLimitlessPublic: () => readLimitlessPublicGames(env.LIMITLESS_PUBLIC_HOST ? { host: env.LIMITLESS_PUBLIC_HOST } : {}),
      },
      readBooks: (markets) => readSnapshots(signer, markets, { streamUrl: cfg.streamUrl, timeoutMs: 12_000 }),
      horizonMs: horizonHours * 3_600_000,
      maxEvents: positive(env.ONCHAIN_VENUES_MAX_GAMES, 240),
      maxReadsPerPass: positive(env.ONCHAIN_VENUES_READS_PER_PASS, 150),
      paceMs: positive(env.ONCHAIN_VENUES_PACE_MS, 400),
    });
  }
  return new OnchainVenuesService({
    feed,
    key: env.ONCHAIN_VENUES_KEY ?? "",
    intervalSec: positive(env.ONCHAIN_VENUES_INTERVAL_SEC, 60),
    discoverEveryMs: positive(env.ONCHAIN_VENUES_DISCOVER_MIN, 10) * 60_000,
    horizonHours,
  });
}
