/**
 * THE FIFTH REFERENCE-BOOK DIALECT: one market per game, a long side and a short side.
 *
 * A regulated US exchange (a CFTC venue; not its international namesake, which is the `polymarket`
 * hedge route) that lists a game's winner as ONE market addressed by a slug. The event's slug is
 * `{league}-{away}-{home}-{date}` in the venue's own team spellings; the winner market is the one
 * whose `sportsMarketType` ends in `_full_game_winner`, and its own slug is the event's behind
 * `aec-`. The market has two sides: the LONG side is
 * one club, the SHORT side is the other, each naming its team by abbreviation. The book is the
 * long side's: `bids` and `offers` in dollars per $1 of payout, best first, sizes in shares (two
 * decimals of a share on some markets), with the market's `state` and the time of its last change.
 *
 *   - Buying the long side takes the offers as they stand.
 *   - Buying the short side is matched against the long side's BIDS: a bid of b for long is an
 *     offer of 1 - b for short, with the bid's size.
 *   So the asks for the club a hedge buys are the offers when that club is long, and 1 minus the
 *   bids when it is short. The bids it could later be sold into are the mirror image.
 *
 * Fee: theta x C x p x (1 - p) on the taker, symmetric in p, where theta is the account's taker
 * coefficient (0.095 at the first volume tier, lower above it). The market publishes the
 * first-tier coefficient; this module folds THAT into every level, rounded up per share, so the
 * book compares like for like with the others and never flatters this venue: an account on a
 * better tier pays less than the book says. The venue rounds the fee on a whole order to the
 * cent (half to even); folding per share and rounding up is never below that.
 *
 * What is read, and with what (measured against the venue on Nov 10, 2026):
 *   - WITHOUT a key: the catalog and the book over public REST (the gateway host). That book is
 *     served from the venue's edge cache for up to 30 seconds (`cache-control: max-age=30`, with
 *     an `age` header), and the gateway refuses one address above about ten requests in ten
 *     seconds (429, then nothing for ten seconds). So the keyless book is a recent copy at under
 *     one read a second: on a full slate each game's book is refreshed every minute or two.
 *     Enough to compare prices before a game on a short list, not enough to price or hedge one
 *     under way. Its age is on every read.
 *   - WITH a key: the venue's market stream (PolyUsBookStream), one signed connection that pushes
 *     each held game's whole book whenever it changes. That is the live book, at no cost against
 *     the rate limit; REST is then the catalog (a game's market, once every half hour) and the
 *     fallback when the stream is down. The account (cash, buying power) is read with a signed
 *     request on the API host.
 *   - A key is a key id and a secret; the secret is base64 and its first 32 bytes are an Ed25519
 *     seed. The signature is base64 Ed25519 over `timestamp_ms + METHOD + path`, sent as three
 *     X-PM-* headers, valid for 30 seconds. Service env only: POLYMARKET_US_KEY_ID and
 *     POLYMARKET_US_SECRET_KEY (the venue's own SDK names POLYMARKET_KEY_ID and
 *     POLYMARKET_SECRET_KEY are read as a fallback). Never logged, never echoed, never in git.
 *   - Nothing here sends an order. This module reads; a hedge ROUTE on this venue (its rule table,
 *     its order signer, a first verified fill) is a separate change.
 *   - Not verified against the venue: the stream itself (it needs a key this build never had).
 *     Its wire format is the venue's own SDK's; the tests drive it with a scripted socket.
 *
 * The same game, never guessed: the slug carries the date and both clubs; the two sides must name
 * exactly the two clubs of our pair by the venue's abbreviations; and when both starts are known
 * they must agree within 150 minutes (the doubleheader guard the matcher uses). Anything else is
 * recorded as not listed, with the reason.
 *
 * Nothing here names the venue in anything the record publishes: the id is the dialect
 * (`long_short_v1`) and the public words are "reference book E" (venueBooks.ts).
 */

import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { parseGameTicker } from "./eventMatcher";
import type { LeagueTemplate } from "./resolutionWhitelist";
import type { MatchedPair, PmBook, PmBookLevel } from "./types";
import { templateForLeague } from "./venuePositions";
import type { ReferenceBook, ReferenceBookSource, ReferenceListing } from "./venueBooks";

export const POLY_US_GATEWAY_HOST = "https://gateway.polymarket.us";
export const POLY_US_API_HOST = "https://api.polymarket.us";
/** the first volume tier's taker coefficient: what a market publishes and what a new account pays after its first week */
export const POLY_US_DEFAULT_COEFFICIENT = 0.095;
/** a game's winner market is the event's slug behind this prefix (read off the venue's NBA, NHL and NFL listings on Nov 10, 2026) */
export const POLY_US_WINNER_PREFIX = "aec-";
/** both starts known and further apart than this: another game between the same clubs on the same date */
const START_TOLERANCE_MS = 150 * 60_000;

export class PolyUsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// the venue's payloads, as far as this reader touches them
// ---------------------------------------------------------------------------

interface PolyUsMoney {
  value?: string;
  currency?: string;
}
export interface PolyUsRawLevel {
  px?: PolyUsMoney | null;
  qty?: string | number | null;
}
export interface PolyUsRawBook {
  marketSlug?: string;
  bids?: PolyUsRawLevel[] | null;
  offers?: PolyUsRawLevel[] | null;
  /** MARKET_STATE_OPEN while orders match; anything else is not a book a hedge could hit */
  state?: string | null;
  /** when the book last changed, ISO */
  transactTime?: string | null;
}
export interface PolyUsSide {
  description?: string;
  long?: boolean;
  team?: { abbreviation?: string; ordering?: string; name?: string };
}
export interface PolyUsMarket {
  slug: string;
  sportsMarketType?: string;
  feeCoefficient?: number;
  gameStartTime?: string;
  marketSides?: PolyUsSide[];
  active?: boolean;
  closed?: boolean;
}
export interface PolyUsEvent {
  slug: string;
  startTime?: string;
  markets?: PolyUsMarket[];
}
export interface PolyUsBalance {
  currency: string;
  /** cash, not counting positions */
  currentBalanceCents: number;
  /** what a new order could spend now */
  buyingPowerCents: number;
  openOrdersCents: number;
  lastUpdatedIso?: string;
}

/** The winner market of an event: the one whose type ends in _full_game_winner. */
export function polyUsWinnerMarket(ev: PolyUsEvent): PolyUsMarket | null {
  return (ev.markets ?? []).find((m) => /_full_game_winner$/.test(m.sportsMarketType ?? "")) ?? null;
}

/**
 * The venue spells a few clubs differently from the templates' slug aliases (read off its own
 * team objects on Nov 9, 2026): Kalshi code to its abbreviation. Clubs not listed use the template.
 */
export const POLY_US_CODES: Record<string, Record<string, string>> = {
  nba: { GSW: "gs", GS: "gs", NOP: "no", NO: "no", NYK: "ny", NY: "ny", PHX: "pho", PHO: "pho", SAS: "sa", SA: "sa" },
  nhl: { LA: "la", LAK: "la", NSH: "nas", SJ: "sj", SJS: "sj", UTAH: "uta", UTA: "uta", VGK: "veg", VEG: "veg", WSH: "was", WAS: "was", MTL: "mon", MON: "mon", CGY: "cgy", CAL: "cgy" },
  nfl: {},
};

/** Every abbreviation the venue might use for a Kalshi code: its own spelling first, then the template's aliases, then the code. */
export function polyUsAliases(league: string, code: string, template: LeagueTemplate): string[] {
  const own = POLY_US_CODES[league]?.[code];
  const aliases = (template.teamCodeAliases[code] ?? []).map((a) => a.toLowerCase());
  return [...new Set([...(own ? [own] : []), ...aliases, code.toLowerCase()])];
}

/** Slug candidates for one game: {league}-{away}-{home}-{date}, the venue's own spelling first. */
export function polyUsEventSlugs(league: string, awayCode: string, homeCode: string, dateIso: string, template: LeagueTemplate): string[] {
  const aways = polyUsAliases(league, awayCode, template);
  const homes = polyUsAliases(league, homeCode, template);
  return aways.flatMap((a) => homes.map((h) => `${template.league}-${a}-${h}-${dateIso}`));
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

export interface PolyUsSigner {
  keyId: string;
  /** the three headers for one request; `path` is the path as sent, beginning with a slash */
  headers(method: string, path: string, nowMs?: number): Record<string, string>;
}

/** PKCS8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410): the fixed prefix, then the seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The message the venue verifies: the millisecond timestamp, the upper-case method and the path, joined with nothing. */
export const polyUsSigningMessage = (timestampMs: string, method: string, path: string): string => `${timestampMs}${method.toUpperCase()}${path}`;

/**
 * A signer from the key id and the secret as the developer portal shows it: base64, whose first
 * 32 bytes are the Ed25519 seed. A secret that is not base64 or is too short is refused with
 * words that never repeat any part of it.
 */
export function polyUsSignerFromSecret(keyId: string, secretB64: string): PolyUsSigner {
  const id = keyId.trim();
  if (!id) throw new Error("the key id is empty");
  const cleaned = secretB64.trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) throw new Error("the secret is not base64");
  const raw = Buffer.from(cleaned.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length < 32) throw new Error(`the secret decodes to ${raw.length} bytes; 32 or more are needed`);
  const key: KeyObject = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  return {
    keyId: id,
    headers(method, path, nowMs = Date.now()) {
      const ts = String(Math.floor(nowMs));
      return {
        "X-PM-Access-Key": id,
        "X-PM-Timestamp": ts,
        "X-PM-Signature": cryptoSign(null, Buffer.from(polyUsSigningMessage(ts, method, path), "utf8"), key).toString("base64"),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface PolyUsClientConfig {
  /** the public host: catalog and books, no key */
  gatewayHost?: string;
  /** the authenticated host: the account */
  apiHost?: string;
  signer?: PolyUsSigner;
  fetchImpl?: typeof fetch;
  /** a game's winner market, once found, is kept this long (its sides and slug do not change) */
  eventTtlMs?: number;
  /** a slug that answered nothing is asked again after this long (the venue lists a game a few days out) */
  missTtlMs?: number;
  /** the least time between two public reads; the gateway refuses a caller above about one a second */
  minIntervalMs?: number;
  /** a read that would wait longer than this for its turn is refused here instead, as rate limited */
  maxQueueMs?: number;
  /** when a book cannot be read for want of a turn, the copy already held is handed back, with its true age, up to this old */
  maxHeldMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One book as read over REST, with how old the venue's copy already was when it was handed over. */
export interface PolyUsBookRead {
  book: PolyUsRawBook;
  /** seconds the answer had sat in the venue's edge cache, plus any time it sat in ours; null when the venue did not say */
  ageSec: number | null;
}

const centsOf = (dollars: unknown): number => {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export class PolyUsClient {
  private readonly gatewayHost: string;
  private readonly apiHost: string;
  private readonly signer?: PolyUsSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly eventTtlMs: number;
  private readonly missTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly maxQueueMs: number;
  private readonly maxHeldMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly winners = new Map<string, { atMs: number; market: PolyUsMarket | null }>();
  private readonly books = new Map<string, { book: PolyUsRawBook; fetchedAtMs: number; edgeAgeSec: number | null; freshUntilMs: number }>();
  /** the winner market's slug prefix has answered at least once: a miss by prefix is then a miss, and the megabyte event is not asked */
  private prefixSeen = false;
  private nextSlotMs = 0;
  private coolUntilMs = 0;

  constructor(cfg: PolyUsClientConfig = {}) {
    this.gatewayHost = (cfg.gatewayHost ?? POLY_US_GATEWAY_HOST).replace(/\/+$/, "");
    this.apiHost = (cfg.apiHost ?? POLY_US_API_HOST).replace(/\/+$/, "");
    this.signer = cfg.signer;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.eventTtlMs = cfg.eventTtlMs ?? 30 * 60_000;
    this.missTtlMs = cfg.missTtlMs ?? 30 * 60_000;
    this.minIntervalMs = cfg.minIntervalMs ?? 1250;
    // a quote waits for its reference reads, so the wait for a turn is kept to about one turn
    this.maxQueueMs = cfg.maxQueueMs ?? 1500;
    this.maxHeldMs = cfg.maxHeldMs ?? 120_000;
    this.now = cfg.now ?? Date.now;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** whether the account can be read: a key is set */
  get signed(): boolean {
    return Boolean(this.signer);
  }

  /** until when the public reads are standing down after the venue said "too many requests"; null when they are not */
  get coolingUntilIso(): string | null {
    return this.now() < this.coolUntilMs ? new Date(this.coolUntilMs).toISOString() : null;
  }

  /**
   * One public read's turn. Measured on Nov 10, 2026 from one address: the gateway takes about ten
   * requests in any ten seconds (five for one URL), then answers 429 with `Retry-After: 10` to
   * everything; one read every 1.25 seconds ran 100 in a row clean. So reads are spaced at that
   * pace, a read that would wait longer than a turn or so is refused here rather than stalling a
   * quote, and when the venue does refuse, every read stands down for as long as it asked.
   */
  private async turn(): Promise<void> {
    const nowMs = this.now();
    if (nowMs < this.coolUntilMs) throw new PolyUsApiError(429, "RATE_LIMITED", "standing down after the venue's rate limit");
    const slot = Math.max(nowMs, this.nextSlotMs);
    if (slot - nowMs > this.maxQueueMs) throw new PolyUsApiError(429, "RATE_LIMITED", "too many reads queued for this venue");
    this.nextSlotMs = slot + this.minIntervalMs;
    if (slot > nowMs) await this.sleep(slot - nowMs);
  }

  private async get(host: string, path: string, signed: boolean): Promise<{ data: unknown; headers: Headers }> {
    if (signed && !this.signer) throw new PolyUsApiError(0, "NO_KEY", "no key is set for the account read");
    if (!signed) await this.turn();
    // the signature covers the path without its query, as the venue's own example signs it
    const headers: Record<string, string> = { accept: "application/json", ...(signed && this.signer ? this.signer.headers("GET", path.split("?")[0], this.now()) : {}) };
    const res = await this.fetchImpl(`${host}${path}`, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 429 && !signed) {
        const retry = Number(res.headers.get("retry-after"));
        this.coolUntilMs = this.now() + Math.min(30, Number.isFinite(retry) && retry > 0 ? retry : 10) * 1000;
      }
      // the venue's words are kept short and never include what was sent
      let words = "";
      try {
        const body = (await res.json()) as { message?: unknown; error?: unknown };
        words = String(body?.message ?? body?.error ?? "").slice(0, 120);
      } catch {
        words = "";
      }
      const code = res.status === 401 || res.status === 403 ? "UNAUTHORIZED" : res.status === 404 ? "NOT_FOUND" : res.status === 429 ? "RATE_LIMITED" : `HTTP_${res.status}`;
      throw new PolyUsApiError(res.status, code, words || `the venue answered ${res.status}`);
    }
    return { data: await res.json(), headers: res.headers };
  }

  private async getJson(host: string, path: string, signed: boolean): Promise<unknown> {
    return (await this.get(host, path, signed)).data;
  }

  /**
   * The winner market of one game by its event slug; null when the venue lists no such game. Found
   * markets and misses are both remembered for a while.
   *
   * The winner market's own slug is the event's with the venue's `aec-` prefix, so it is asked for
   * directly first (a few KB). The event itself (every market of the game, megabytes when listed)
   * is read only while that prefix has never once answered in this process: it is the guard
   * against the venue changing the prefix, not the everyday read.
   */
  async winnerMarket(eventSlug: string): Promise<{ market: PolyUsMarket; eventSlug: string } | null> {
    const nowMs = this.now();
    const hit = this.winners.get(eventSlug);
    if (hit && nowMs - hit.atMs < (hit.market ? this.eventTtlMs : this.missTtlMs)) return hit.market ? { market: hit.market, eventSlug } : null;
    let market: PolyUsMarket | null = null;
    try {
      const data = (await this.getJson(this.gatewayHost, `/v1/market/slug/${encodeURIComponent(`${POLY_US_WINNER_PREFIX}${eventSlug}`)}`, false)) as { market?: PolyUsMarket };
      if (data?.market?.slug && polyUsWinnerMarket({ slug: eventSlug, markets: [data.market] })) market = data.market;
      if (market) this.prefixSeen = true;
    } catch (err) {
      // an unknown slug is "not listed", not an outage; anything else is the caller's to report
      if (!(err instanceof PolyUsApiError && err.status === 404)) throw err;
    }
    if (!market && !this.prefixSeen) {
      const data = (await this.getJson(this.gatewayHost, `/v1/events?slug=${encodeURIComponent(eventSlug)}`, false)) as { events?: PolyUsEvent[] };
      const event = (data.events ?? []).find((e) => e?.slug === eventSlug) ?? null;
      const found = event ? polyUsWinnerMarket(event) : null;
      // the event's start stands in when the market carries none
      market = found ? { ...found, ...(found.gameStartTime || !event?.startTime ? {} : { gameStartTime: event.startTime }) } : null;
    }
    this.winners.set(eventSlug, { atMs: nowMs, market });
    return market ? { market, eventSlug } : null;
  }

  /**
   * One market's book over REST, with its age. The venue serves this answer from an edge cache
   * for up to 30 seconds (`cache-control: max-age=30`, with an `age` header saying how long it has
   * sat there), so a REST book is a recent copy, not the live book: fine to compare prices before
   * a game, too old to price or hedge one that is under way. The age is reported, never hidden.
   * While the venue would hand back the same copy anyway, ours is reused instead of asking again;
   * and when there is no turn to ask in (the pace, or a stand-down), the copy held is handed back
   * with its true age for up to two minutes rather than nothing.
   */
  async book(marketSlug: string): Promise<PolyUsBookRead> {
    const nowMs = this.now();
    const held = this.books.get(marketSlug);
    const heldRead = (atMs: number): PolyUsBookRead | null =>
      held && held.edgeAgeSec !== null ? { book: held.book, ageSec: held.edgeAgeSec + Math.round((atMs - held.fetchedAtMs) / 1000) } : null;
    if (held && nowMs < held.freshUntilMs) return heldRead(nowMs)!;
    let answer: { data: unknown; headers: Headers };
    try {
      answer = await this.get(this.gatewayHost, `/v1/markets/${encodeURIComponent(marketSlug)}/book`, false);
    } catch (err) {
      const at = this.now();
      const old = err instanceof PolyUsApiError && err.code === "RATE_LIMITED" && held && at - held.fetchedAtMs <= this.maxHeldMs ? heldRead(at) : null;
      if (old) return old;
      throw err;
    }
    const { data, headers } = answer;
    const book = (data as { marketData?: PolyUsRawBook })?.marketData;
    if (!book) throw new PolyUsApiError(200, "NO_BOOK", "the venue answered without a book");
    const ageHeader = headers.get("age");
    const age = ageHeader === null || ageHeader.trim() === "" ? NaN : Number(ageHeader);
    const edgeAgeSec = Number.isFinite(age) && age >= 0 ? Math.round(age) : null;
    const maxAge = Number(/max-age=(\d+)/.exec(headers.get("cache-control") ?? "")?.[1]);
    const fetchedAtMs = this.now();
    // the venue's edge hands back this same copy until max-age runs out: asking again before then learns nothing
    const freshUntilMs = edgeAgeSec !== null && Number.isFinite(maxAge) ? fetchedAtMs + Math.max(0, maxAge - edgeAgeSec) * 1000 : fetchedAtMs;
    this.books.set(marketSlug, { book, fetchedAtMs, edgeAgeSec, freshUntilMs });
    return { book, ageSec: edgeAgeSec };
  }

  /** The account's cash by currency. Signed; the one read that proves a key is accepted. */
  async balances(): Promise<PolyUsBalance[]> {
    const data = (await this.getJson(this.apiHost, "/v1/account/balances", true)) as { balances?: Array<Record<string, unknown>> };
    return (data.balances ?? []).map((b) => ({
      currency: String(b.currency ?? "USD"),
      currentBalanceCents: centsOf(b.currentBalance),
      buyingPowerCents: centsOf(b.buyingPower),
      openOrdersCents: centsOf(b.openOrders),
      ...(typeof b.lastUpdated === "string" ? { lastUpdatedIso: b.lastUpdated } : {}),
    }));
  }
}

// ---------------------------------------------------------------------------
// the live stream
// ---------------------------------------------------------------------------

/** The part of a socket this module uses: the `ws` package's client, or a test's stand-in. */
export interface PolyUsSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "close" | "ping", fn: () => void): unknown;
  on(event: "message", fn: (data: unknown) => void): unknown;
  on(event: "error", fn: (err: unknown) => void): unknown;
}
export type PolyUsSocketFactory = (url: string, headers: Record<string, string>) => PolyUsSocketLike | Promise<PolyUsSocketLike>;

export const POLY_US_STREAM_PATH = "/v1/ws/markets";
/** the venue takes at most this many markets in one subscription */
const STREAM_BATCH = 100;

export interface PolyUsStreamStatus {
  /** idle: nothing asked for yet. waiting: closed, will reconnect at the next read after `retryAtIso`. refused: the venue would not take the key; no more tries. */
  state: "idle" | "connecting" | "open" | "waiting" | "refused";
  /** open and heard from recently: books served from here are the live book */
  live: boolean;
  markets: number;
  books: number;
  lastFrameAtIso: string | null;
  connects: number;
  retryAtIso: string | null;
  /** the last thing that went wrong, in short words; never a key */
  lastError: string | null;
}

export interface PolyUsStreamOptions {
  /** wss://api.polymarket.us unless the env points elsewhere */
  baseUrl?: string;
  socketFactory?: PolyUsSocketFactory;
  now?: () => number;
  /** open but silent this long (no book, no heartbeat): the connection is treated as dead and remade */
  staleMs?: number;
  /** a market nobody has read for this long is not subscribed again at the next connect */
  idleMs?: number;
}

/** The `ws` package's client with the three signed headers on the handshake (a browser-style socket cannot send them). */
const defaultSocketFactory: PolyUsSocketFactory = async (url, headers) => {
  // a non-literal specifier: the package ships no types, and its client is used only through PolyUsSocketLike
  type Ctor = new (url: string, opts: { headers: Record<string, string>; handshakeTimeout: number }) => PolyUsSocketLike;
  const mod = (await import("ws" as string)) as { default?: Ctor; WebSocket?: Ctor };
  const Socket = mod.default ?? mod.WebSocket ?? (mod as unknown as Ctor);
  return new Socket(url, { headers, handshakeTimeout: 10_000 });
};

/**
 * THE LIVE BOOK. One authenticated connection to the venue's market stream, opened on the first
 * read and kept open, with every game the service prices subscribed on it. The venue pushes the
 * book whenever it changes, so what is held here is the book as it stands, not the 30-second copy
 * REST hands out, and it costs no request against the rate limit. This is what a key buys.
 *
 * The wire, as the venue's own SDK speaks it: a signed handshake (the REST signature over
 * `GET /v1/ws/markets`); `{"subscribe":{"requestId","subscriptionType":"SUBSCRIPTION_TYPE_MARKET_DATA",
 * "marketSlugs":[...]}}` with at most 100 markets each; answers of `{"marketData":{marketSlug, bids,
 * offers, state, transactTime}}` carrying the whole book each time, `{"heartbeat":{}}`, and
 * `{"error":...}` for a subscription that failed.
 *
 * What is promised: a book is served from here only while the connection is open and has been
 * heard from recently. The moment it closes, errors or goes silent, every held book is dropped
 * and the reader falls back to REST with its age stated; a dead stream never prices anything.
 * Reconnects are made at the next read after a growing wait (1s doubling to 60s), never by a
 * background timer. A handshake the venue refuses for the key (401/403) is not retried.
 * No order, no account data: market books only.
 */
export class PolyUsBookStream {
  private readonly url: string;
  private readonly factory: PolyUsSocketFactory;
  private readonly now: () => number;
  private readonly staleMs: number;
  private readonly idleMs: number;
  private socket: PolyUsSocketLike | null = null;
  private state: PolyUsStreamStatus["state"] = "idle";
  /** bumps on every connect and every teardown: events from a socket that is no longer ours are ignored */
  private generation = 0;
  private readonly wanted = new Map<string, number>();
  private readonly subscribed = new Set<string>();
  private readonly held = new Map<string, { book: PolyUsRawBook; atMs: number }>();
  /** reads waiting a moment for a market's first book */
  private readonly waiters = new Map<string, Array<() => void>>();
  private lastFrameAtMs: number | null = null;
  private connects = 0;
  private backoffMs = 1000;
  private retryAtMs = 0;
  private lastError: string | null = null;
  private requestSeq = 0;
  private closed = false;

  constructor(
    private readonly signer: PolyUsSigner,
    opts: PolyUsStreamOptions = {},
  ) {
    this.url = `${(opts.baseUrl ?? "wss://api.polymarket.us").replace(/\/+$/, "")}${POLY_US_STREAM_PATH}`;
    this.factory = opts.socketFactory ?? defaultSocketFactory;
    this.now = opts.now ?? Date.now;
    this.staleMs = opts.staleMs ?? 90_000;
    this.idleMs = opts.idleMs ?? 6 * 3_600_000;
  }

  /** Ask for a market to be held. Opens the connection on the first call and after a wait when it has dropped. */
  want(marketSlug: string): void {
    if (this.closed) return;
    this.wanted.set(marketSlug, this.now());
    if (this.state === "open") {
      if (!this.subscribed.has(marketSlug)) this.subscribe([marketSlug]);
      return;
    }
    if (this.state === "idle" || (this.state === "waiting" && this.now() >= this.retryAtMs)) void this.connect();
  }

  /** The live book for a market, or null when there is none to vouch for: not open, gone silent, or not yet received. */
  book(marketSlug: string): { book: PolyUsRawBook; atMs: number } | null {
    if (this.state !== "open") return null;
    if (this.lastFrameAtMs !== null && this.now() - this.lastFrameAtMs > this.staleMs) {
      this.drop("the stream went silent");
      return null;
    }
    return this.held.get(marketSlug) ?? null;
  }

  /**
   * The live book for a market just asked for, waiting a moment for the venue's first push of it:
   * a new subscription is expected to be answered with the whole book straight away, so a short
   * wait here saves a REST read. Null when it did not come in time, or the connection is not one
   * that will bring it.
   */
  async bookSoon(marketSlug: string, waitMs: number): Promise<{ book: PolyUsRawBook; atMs: number } | null> {
    const have = this.book(marketSlug);
    if (have || waitMs <= 0 || (this.state !== "open" && this.state !== "connecting") || !this.wanted.has(marketSlug)) return have;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        const list = this.waiters.get(marketSlug);
        if (list) {
          const rest = list.filter((fn) => fn !== done);
          if (rest.length) this.waiters.set(marketSlug, rest);
          else this.waiters.delete(marketSlug);
        }
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.set(marketSlug, [...(this.waiters.get(marketSlug) ?? []), done]);
    });
    return this.book(marketSlug);
  }

  status(): PolyUsStreamStatus {
    const live = this.state === "open" && this.lastFrameAtMs !== null && this.now() - this.lastFrameAtMs <= this.staleMs;
    return {
      state: this.state,
      live,
      markets: this.wanted.size,
      books: this.held.size,
      lastFrameAtIso: this.lastFrameAtMs === null ? null : new Date(this.lastFrameAtMs).toISOString(),
      connects: this.connects,
      retryAtIso: this.state === "waiting" ? new Date(this.retryAtMs).toISOString() : null,
      lastError: this.lastError,
    };
  }

  /** Stop for good: the connection is closed and nothing reconnects. */
  close(): void {
    this.closed = true;
    this.generation += 1;
    const s = this.socket;
    this.socket = null;
    this.held.clear();
    this.subscribed.clear();
    this.state = "idle";
    this.wakeAll();
    try {
      s?.close(1000, "OK");
    } catch {
      // already gone
    }
  }

  private subscribe(slugs: string[]): void {
    for (let i = 0; i < slugs.length; i += STREAM_BATCH) {
      const batch = slugs.slice(i, i + STREAM_BATCH);
      this.requestSeq += 1;
      this.socket?.send(JSON.stringify({ subscribe: { requestId: `books-${this.connects}-${this.requestSeq}`, subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA", marketSlugs: batch } }));
      for (const s of batch) this.subscribed.add(s);
    }
  }

  /** The connection is no longer to be trusted: every book is dropped and the next read after the wait reconnects. */
  /** nothing more is coming on this connection: the reads waiting on it go on without it */
  private wakeAll(): void {
    for (const list of [...this.waiters.values()]) for (const wake of list) wake();
  }

  private drop(why: string, refused = false): void {
    this.generation += 1;
    const s = this.socket;
    this.socket = null;
    this.held.clear();
    this.subscribed.clear();
    this.wakeAll();
    this.lastError = why.slice(0, 120);
    if (refused) {
      this.state = "refused";
    } else {
      this.state = "waiting";
      this.retryAtMs = this.now() + this.backoffMs;
      this.backoffMs = Math.min(60_000, this.backoffMs * 2);
    }
    try {
      s?.close(1000, "OK");
    } catch {
      // already gone
    }
  }

  private async connect(): Promise<void> {
    this.generation += 1;
    const mine = this.generation;
    this.state = "connecting";
    this.connects += 1;
    let socket: PolyUsSocketLike;
    try {
      socket = await this.factory(this.url, this.signer.headers("GET", POLY_US_STREAM_PATH, this.now()));
    } catch (err) {
      if (mine === this.generation) this.drop(`could not connect: ${String(err instanceof Error ? err.message : err)}`);
      return;
    }
    if (mine !== this.generation || this.closed) {
      try {
        socket.close(1000, "OK");
      } catch {
        // already gone
      }
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (mine !== this.generation) return;
      this.state = "open";
      this.lastFrameAtMs = this.now();
      const cutoff = this.now() - this.idleMs;
      for (const [slug, at] of this.wanted) if (at < cutoff) this.wanted.delete(slug);
      this.subscribe([...this.wanted.keys()]);
    });
    socket.on("message", (data: unknown) => {
      if (mine !== this.generation) return;
      let msg: { heartbeat?: unknown; error?: unknown; marketData?: PolyUsRawBook };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      this.lastFrameAtMs = this.now();
      // heard from: the wait before the next reconnect starts over
      this.backoffMs = 1000;
      if (msg.error !== undefined) {
        this.lastError = `subscription: ${String(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error))}`.slice(0, 120);
        return;
      }
      const slug = msg.marketData?.marketSlug;
      if (msg.marketData && typeof slug === "string") {
        this.held.set(slug, { book: msg.marketData, atMs: this.lastFrameAtMs });
        for (const wake of this.waiters.get(slug) ?? []) wake();
      }
    });
    // a protocol-level ping from the venue is the connection speaking too
    socket.on("ping", () => {
      if (mine === this.generation && this.state === "open") this.lastFrameAtMs = this.now();
    });
    socket.on("error", (err: unknown) => {
      if (mine !== this.generation) return;
      const words = String(err instanceof Error ? err.message : err);
      this.drop(words, /\b(401|403)\b/.test(words));
    });
    socket.on("close", () => {
      if (mine !== this.generation) return;
      this.drop("the venue closed the stream");
    });
  }
}

// ---------------------------------------------------------------------------
// the book, shaped
// ---------------------------------------------------------------------------

/** Fee per share at a price, in milli-dollars, rounded up against us. */
export const polyUsFeeMilli = (coefficient: number, priceMilli: number): number => Math.max(0, Math.ceil((coefficient * priceMilli * (1000 - priceMilli)) / 1000 - 1e-9));

/** The market's own coefficient when it publishes a sane one, else the first tier's. */
export function polyUsCoefficient(m: Pick<PolyUsMarket, "feeCoefficient">): number {
  const c = m.feeCoefficient;
  return typeof c === "number" && Number.isFinite(c) && c >= 0 && c < 1 ? c : POLY_US_DEFAULT_COEFFICIENT;
}

/** The venue's levels in our units: milli-dollars per $1 of payout and milli-shares. Levels that are not a price or a size are dropped. */
export function polyUsLevels(raw: PolyUsRawLevel[] | null | undefined): PmBookLevel[] {
  const out: PmBookLevel[] = [];
  for (const l of raw ?? []) {
    const priceMilli = Math.round(Number(l?.px?.value) * 1000);
    const sizeMilli = Math.floor(Number(l?.qty) * 1000 + 1e-6);
    if (!Number.isFinite(priceMilli) || !Number.isFinite(sizeMilli) || priceMilli <= 0 || priceMilli >= 1000 || sizeMilli <= 0) continue;
    out.push({ priceMilli, sizeMilli });
  }
  return out;
}

/**
 * What a hedge would pay for the opposing club, fee in the price, cheapest first: the offers when
 * that club is the long side, 1 minus the bids when it is the short side.
 */
export function polyUsAsksForOpposing(book: Pick<PolyUsRawBook, "bids" | "offers">, opposingIsLong: boolean, coefficient: number): PmBookLevel[] {
  const raw = opposingIsLong ? polyUsLevels(book.offers) : polyUsLevels(book.bids).map((l) => ({ priceMilli: 1000 - l.priceMilli, sizeMilli: l.sizeMilli }));
  return raw
    .map((l) => ({ priceMilli: l.priceMilli + polyUsFeeMilli(coefficient, l.priceMilli), sizeMilli: l.sizeMilli }))
    .filter((l) => l.priceMilli > 0 && l.priceMilli < 1000)
    .sort((a, b) => a.priceMilli - b.priceMilli);
}

/**
 * What a hedge held on the opposing club could be sold for, fee off the price, dearest first: the
 * bids when that club is the long side, 1 minus the offers when it is the short side.
 */
export function polyUsBidsForOpposing(book: Pick<PolyUsRawBook, "bids" | "offers">, opposingIsLong: boolean, coefficient: number): PmBookLevel[] {
  const raw = opposingIsLong ? polyUsLevels(book.bids) : polyUsLevels(book.offers).map((l) => ({ priceMilli: 1000 - l.priceMilli, sizeMilli: l.sizeMilli }));
  return raw
    .map((l) => ({ priceMilli: l.priceMilli - polyUsFeeMilli(coefficient, l.priceMilli), sizeMilli: l.sizeMilli }))
    .filter((l) => l.priceMilli > 0 && l.priceMilli < 1000)
    .sort((a, b) => b.priceMilli - a.priceMilli);
}

export interface PolyUsSides {
  /** our club (the holder's side) is the market's long side */
  oursIsLong: boolean;
  oursName: string;
  opposingName: string;
}

/**
 * Which side of the market is ours: the long side and the short side must name exactly our two
 * clubs by the venue's abbreviations, one each. Null when either side is unnamed or names a club
 * that is not in the pair: the game is then not ours, however alike the slug.
 */
export function polyUsSidesFor(m: PolyUsMarket, league: string, oursCode: string, opposingCode: string, template: LeagueTemplate): PolyUsSides | null {
  const longSide = (m.marketSides ?? []).find((s) => s.long === true);
  const shortSide = (m.marketSides ?? []).find((s) => s.long === false);
  const longAbbr = longSide?.team?.abbreviation?.toLowerCase();
  const shortAbbr = shortSide?.team?.abbreviation?.toLowerCase();
  if (!longAbbr || !shortAbbr) return null;
  const ours = polyUsAliases(league, oursCode, template);
  const opp = polyUsAliases(league, opposingCode, template);
  const name = (s: PolyUsSide | undefined, fallback: string): string => s?.team?.name ?? s?.description ?? fallback;
  if (ours.includes(longAbbr) && opp.includes(shortAbbr) && !opp.includes(longAbbr)) return { oursIsLong: true, oursName: name(longSide, oursCode), opposingName: name(shortSide, opposingCode) };
  if (opp.includes(longAbbr) && ours.includes(shortAbbr) && !ours.includes(longAbbr)) return { oursIsLong: false, oursName: name(shortSide, oursCode), opposingName: name(longSide, opposingCode) };
  return null;
}

// ---------------------------------------------------------------------------
// the reference source
// ---------------------------------------------------------------------------

const ID = "long_short_v1" as const;

const startsAgree = (venueStartIso: string | undefined, pairStartIso: string): boolean => {
  const theirs = Date.parse(venueStartIso ?? "");
  const ours = Date.parse(pairStartIso);
  if (!Number.isFinite(theirs) || !Number.isFinite(ours)) return true; // unverifiable: the slug's date and the two clubs stand
  return Math.abs(theirs - ours) <= START_TOLERANCE_MS;
};

/**
 * The opposing club's book on this venue for one pair: asks to buy the hedge, bids to leave it,
 * the first-tier fee folded into both. Listed, closed, suspended and not-ours are told apart.
 * `ageSec` on the read says how old the book was: 0 from the live stream, the venue's own cache
 * age (up to 30 seconds) from REST.
 */
export function polyUsSource(client: PolyUsClient, stream?: PolyUsBookStream | null, opts: { firstBookWaitMs?: number } = {}): ReferenceBookSource {
  // a game just subscribed should be answered with its whole book straight away: waiting this long for it saves a paced REST read
  const firstBookWaitMs = opts.firstBookWaitMs ?? 1500;
  return {
    id: ID,
    async read(pair: MatchedPair): Promise<ReferenceBook> {
      const template = templateForLeague(pair.league);
      const parsed = template ? parseGameTicker(pair.kalshi.ticker, template) : null;
      if (!template || !parsed) return { id: ID, book: null, reason: "league_not_covered" };
      const oursCode = parsed.sideCode;
      const opposingCode = oursCode === parsed.awayCode ? parsed.homeCode : parsed.awayCode;
      let found: { market: PolyUsMarket; eventSlug: string } | null = null;
      for (const slug of polyUsEventSlugs(pair.league, parsed.awayCode, parsed.homeCode, parsed.dateIso, template)) {
        found = await client.winnerMarket(slug);
        if (found) break;
      }
      if (!found) return { id: ID, book: null, reason: "not_listed" };
      const market = found.market;
      if (!startsAgree(market.gameStartTime, pair.gameStartTime)) return { id: ID, book: null, reason: "start_mismatch" };
      const sides = polyUsSidesFor(market, pair.league, oursCode, opposingCode, template);
      if (!sides) return { id: ID, book: null, reason: "sides_unverified" };
      const coefficient = polyUsCoefficient(market);
      const opposingIsLong = !sides.oursIsLong;
      const base: ReferenceListing = {
        marketId: market.slug,
        key: found.eventSlug,
        outcomes: {
          ours: { outcomeId: `${market.slug}:${sides.oursIsLong ? "long" : "short"}`, name: sides.oursName },
          opposing: { outcomeId: `${market.slug}:${opposingIsLong ? "long" : "short"}`, name: sides.opposingName },
          fee: { coefficient, folded: true },
        },
      };
      if (market.closed === true || market.active === false) return { id: ID, book: null, reason: "market_closed", listing: { ...base, outcomes: { ...base.outcomes!, marketStatus: "closed" } } };
      // the live book when the stream holds one (a key is set and the connection is open); else the
      // venue's REST copy with its age. The first read of a game asks the stream to hold it from then on.
      stream?.want(market.slug);
      const live = stream ? await stream.bookSoon(market.slug, firstBookWaitMs) : null;
      const rest = live ? null : await client.book(market.slug);
      const raw = live ? live.book : rest!.book;
      const ageSec = live ? 0 : rest!.ageSec;
      const state = (raw.state ?? "").replace(/^MARKET_STATE_/, "").toLowerCase();
      const listing: ReferenceListing = {
        ...base,
        ...(raw.transactTime ? { snapshotAtIso: raw.transactTime } : {}),
        outcomes: { ...base.outcomes!, ...(state ? { marketStatus: state } : {}) },
      };
      // a market not matching orders has levels nobody can hit: recorded as the state, not as a price
      if (state && state !== "open") return { id: ID, book: null, reason: state === "suspended" || state === "halted" ? "market_suspended" : "market_closed", listing };
      const book: PmBook = {
        tokenId: `${ID}:${market.slug}`,
        asks: polyUsAsksForOpposing(raw, opposingIsLong, coefficient),
        bids: polyUsBidsForOpposing(raw, opposingIsLong, coefficient),
        minOrderSizeShares: 1,
        tickMilli: 1,
      };
      return { id: ID, book, listing, ...(ageSec === null ? {} : { ageSec }) };
    },
  };
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export interface PolyUsEnvConfig {
  /** null when the venue is not read at all */
  client: PolyUsClient | null;
  /** the live book stream; only with a key, and not when POLYMARKET_US_STREAM turns it off */
  stream: PolyUsBookStream | null;
  /** one line for the operator on how the venue is read, or why it is not; never a key */
  note: string | null;
}

const OFF = /^(0|false|no|off)$/i;

/**
 * How this service reads the venue, from its environment:
 *   - POLYMARKET_US_KEY_ID + POLYMARKET_US_SECRET_KEY (or the SDK's POLYMARKET_KEY_ID +
 *     POLYMARKET_SECRET_KEY): books are read LIVE off the venue's stream (REST with its age until
 *     the stream holds a game, and whenever it is down), and the account can be read.
 *     POLYMARKET_US_STREAM=0 keeps the key for the account and reads books over REST only.
 *   - REFERENCE_BOOK_POLY_US=public: books are read over REST with no key (a copy up to 30 seconds
 *     old, under one read a second); no stream, no account read.
 *   - REFERENCE_BOOK_POLY_US=0 (false, no, off): nothing is read, whatever else is set.
 *   - none of these: nothing is read.
 * One half of a key, or a secret that is not a key, reads nothing with a key and says so; the
 * public read still stands when it was asked for.
 */
export function polyUsFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetchImpl?: typeof fetch; socketFactory?: PolyUsSocketFactory } = {}): PolyUsEnvConfig {
  const word = (env.REFERENCE_BOOK_POLY_US ?? "").trim();
  if (OFF.test(word)) return { client: null, stream: null, note: null };
  const keyId = (env.POLYMARKET_US_KEY_ID ?? env.POLYMARKET_KEY_ID ?? "").trim();
  const secret = (env.POLYMARKET_US_SECRET_KEY ?? env.POLYMARKET_SECRET_KEY ?? "").trim();
  const wantsPublic = /^public$/i.test(word) || /^(1|true|yes|on)$/i.test(word);
  const hosts = {
    ...(env.POLYMARKET_US_GATEWAY_HOST?.trim() ? { gatewayHost: env.POLYMARKET_US_GATEWAY_HOST.trim() } : {}),
    ...(env.POLYMARKET_US_API_HOST?.trim() ? { apiHost: env.POLYMARKET_US_API_HOST.trim() } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const publicOnly = (note: string): PolyUsEnvConfig => ({ client: new PolyUsClient(hosts), stream: null, note });
  if (keyId && secret) {
    try {
      const signer = polyUsSignerFromSecret(keyId, secret);
      const streamOff = OFF.test((env.POLYMARKET_US_STREAM ?? "").trim());
      const stream = streamOff
        ? null
        : new PolyUsBookStream(signer, {
            ...(env.POLYMARKET_US_WS_HOST?.trim() ? { baseUrl: env.POLYMARKET_US_WS_HOST.trim() } : {}),
            ...(opts.socketFactory ? { socketFactory: opts.socketFactory } : {}),
          });
      return { client: new PolyUsClient({ ...hosts, signer }), stream, note: streamOff ? "reference book E: the live stream is turned off (POLYMARKET_US_STREAM); books are read over REST, up to 30 seconds old" : null };
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err);
      return wantsPublic ? publicOnly(`reference book E: key unusable (${why}); reading the public books without it`) : { client: null, stream: null, note: `reference book E: key unusable (${why}); off` };
    }
  }
  if (keyId || secret) {
    return wantsPublic
      ? publicOnly("reference book E: the key id and the secret must both be set; reading the public books without a key")
      : { client: null, stream: null, note: "reference book E: the key id and the secret must both be set; off" };
  }
  if (wantsPublic) return publicOnly("reference book E: reading the public books (no key set); a copy up to 30 seconds old");
  return { client: null, stream: null, note: null };
}

let forProcess: PolyUsEnvConfig | null = null;

/**
 * This process's one reader of the venue, built from its own environment the first time it is
 * asked for: the scanner's reference read and the operator's key check share one client and one
 * stream, so the check reports the connection that is actually pricing.
 */
export function polyUsForProcess(): PolyUsEnvConfig {
  if (!forProcess) {
    const timed: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(6000) });
    forProcess = polyUsFromEnv(process.env, { fetchImpl: timed });
  }
  return forProcess;
}

export interface PolyUsPreflight {
  /** books are being read (with or without a key) */
  reading: boolean;
  /** a key is set and well formed */
  keySet: boolean;
  /** the venue accepted the key on an account read; null when no key is set */
  keyAccepted: boolean | null;
  balances?: PolyUsBalance[];
  /** why the account read failed, in the venue's short words; never a key */
  problem?: string;
  /** how books reach this service: "stream" is the live book; "rest" is the venue's copy, up to 30 seconds old */
  books: "stream" | "rest" | "none";
  /** the live stream's state, when a key is set and the stream is not turned off */
  stream?: PolyUsStreamStatus;
  /** the public reads are standing down until then after the venue's rate limit */
  restCoolingUntilIso?: string;
  /** what this service can and cannot do on the venue today */
  can: { readBooks: boolean; readAccount: boolean; sendOrders: false };
}

/** The operator's check after adding the key: is it set, did the venue accept it, what cash is there, is the live stream up. Reads only. */
export async function polyUsPreflight(client: PolyUsClient | null, stream: PolyUsBookStream | null = null): Promise<PolyUsPreflight> {
  if (!client) return { reading: false, keySet: false, keyAccepted: null, books: "none", can: { readBooks: false, readAccount: false, sendOrders: false } };
  const status = stream?.status();
  const feed = {
    books: status?.live ? ("stream" as const) : ("rest" as const),
    ...(status ? { stream: status } : {}),
    ...(client.coolingUntilIso ? { restCoolingUntilIso: client.coolingUntilIso } : {}),
  };
  if (!client.signed) return { reading: true, keySet: false, keyAccepted: null, ...feed, can: { readBooks: true, readAccount: false, sendOrders: false } };
  try {
    const balances = await client.balances();
    return { reading: true, keySet: true, keyAccepted: true, balances, ...feed, can: { readBooks: true, readAccount: true, sendOrders: false } };
  } catch (err) {
    const problem = err instanceof PolyUsApiError ? `${err.code}: ${err.message}` : `unreachable: ${String(err instanceof Error ? err.message : err).slice(0, 80)}`;
    return { reading: true, keySet: true, keyAccepted: err instanceof PolyUsApiError && err.code === "UNAUTHORIZED" ? false : null, problem, ...feed, can: { readBooks: true, readAccount: false, sendOrders: false } };
  }
}
