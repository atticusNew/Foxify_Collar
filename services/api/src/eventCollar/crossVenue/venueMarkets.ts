/**
 * THE THIRD REFERENCE-BOOK DIALECT: one market per outcome, read-only.
 *
 * A regulated US exchange whose API lists every outcome as its own market with its own order
 * book: a moneyline is two markets, `home_winner` and `away_winner`, sharing a `grouping_id` of
 * `{event_id}:moneyline:full`. Prices are dollar strings strictly below the market's own
 * `max_price` (per market, usually "1.0000"); `bids` and `offers` carry the top seven levels, both
 * sorted by price descending, so the best bid is first and the best offer is LAST. `participants`
 * names the fixture (away first, then home) and is the same on both sides; which side a market
 * settles on is read from `rules`, never from the titles.
 *
 * Two ways to be let in, both read-only here:
 *   - a signed API key: Ed25519 over `timestamp_ms + METHOD + path(with query)`, no separator,
 *     sent as three X-STX-ACCESS-* headers, valid for 30 seconds, body never signed;
 *   - an app token: client-credentials grant on `/oauth/token` with the client id and secret as
 *     HTTP Basic, scope `market_data`; a bearer that lasts an hour with no refresh token.
 * A `User-Agent` naming the software is required; a request without one is refused with 403.
 * Nothing else: no account, no orders, no positions. Reads only `GET /api/v1/markets`.
 *
 * Nothing here is public: this module is the service's read; what the record publishes is the
 * dialect id and the words "reference book D" (venueBooks.ts).
 */

import { createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";

export const MARKETS_USER_AGENT = "atticus-event-shadow/0.1 (reference-book reader)";

export class MarketsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** one price level as the REST snapshot gives it: dollar strings */
export interface RawMarketLevel {
  price: string;
  quantity: string;
}

export interface RawMarketParticipant {
  name?: string | null;
  role?: string | null;
  short_name?: string | null;
  abbreviation?: string | null;
}

/** the fields of one market this reader touches; everything else on the payload is ignored */
export interface RawOutcomeMarket {
  market_id: string;
  event_id?: string | null;
  grouping_id?: string | null;
  grouping_name?: string | null;
  rules?: string | null;
  specifier?: string | null;
  status?: string | null;
  trading?: boolean | null;
  event_status?: string | null;
  event_start?: string | null;
  event_title?: string | null;
  competition?: string | null;
  sport?: string | null;
  max_price?: string | null;
  price?: string | null;
  last_traded_price?: string | null;
  bids?: RawMarketLevel[] | null;
  offers?: RawMarketLevel[] | null;
  participants?: RawMarketParticipant[] | null;
  position?: string | null;
  group_title?: string | null;
  symbol?: string | null;
  timestamp?: string | null;
  in_play_delay_sec?: number | null;
  /** the market's question in words; on a combination it is the picks, comma-separated ("Broncos, Hawks, Texans, Falcons") */
  question?: string | null;
  /** the rules text; on a combination it names each leg with what it must do ("…every leg lands: Broncos Won, Hawks Won.") */
  description?: string | null;
  /** pending until settled, then the venue's word for the outcome */
  result?: string | null;
  /** the venue's event type; "combo" on a combination */
  event_type?: string | null;
  recent_trades?: Array<{ timestamp?: string | null; price?: string | null; quantity?: string | null }> | null;
}

interface MarketsPage {
  cursor?: string | null;
  markets?: RawOutcomeMarket[] | null;
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

export interface MarketsSigner {
  keyId: string;
  /** base64 Ed25519 over the UTF-8 bytes of the message */
  sign(message: string): string;
}

/** The message the venue verifies: the millisecond timestamp, the upper-case method and the path with its query, joined with nothing. */
export const marketsSigningMessage = (timestampMs: string, method: string, pathWithQuery: string): string => `${timestampMs}${method.toUpperCase()}${pathWithQuery}`;

/** An Ed25519 signer from a PKCS8 PEM ("\n" escapes accepted). Any other key type is refused: the venue verifies Ed25519 only. */
export function marketsSignerFromPem(keyId: string, pem: string): MarketsSigner {
  const key: KeyObject = createPrivateKey(pem.replace(/\\n/g, "\n").trim());
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`markets key: unsupported key type ${String(key.asymmetricKeyType)}; the venue takes Ed25519`);
  return { keyId, sign: (m) => cryptoSign(null, Buffer.from(m, "utf8"), key).toString("base64") };
}

export function marketsSignedHeaders(signer: MarketsSigner, method: string, pathWithQuery: string, nowMs: number = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs));
  return {
    "X-STX-ACCESS-KEY": signer.keyId,
    "X-STX-ACCESS-TIMESTAMP": ts,
    "X-STX-ACCESS-SIGNATURE": signer.sign(marketsSigningMessage(ts, method, pathWithQuery)),
  };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface MarketsClientConfig {
  host: string;
  /** a signed API key; with `app` unset this is how every read is authenticated */
  signer?: MarketsSigner;
  /** an app registered for market data: a client-credentials token is fetched and reused until it is about to expire */
  app?: { clientId: string; clientSecret: string };
  fetchImpl?: typeof fetch;
  /** a competition's market list is cached this long; the book levels on it are a snapshot, so the cache is short */
  catalogTtlMs?: number;
  /**
   * Pages of 200 followed per competition before the list is taken as complete. The venue lists
   * every prop, spread and total of a game beside its two winner markets (60+ per game), soonest
   * game first, so a full NFL week runs past 1,000 markets; a cap that stops short reads a far
   * game as not listed. Default 10 (2,000 markets).
   */
  maxPages?: number;
  now?: () => number;
}

/** how much of the token's hour is left unused, so a read never carries a token that expires in flight */
const TOKEN_SLACK_MS = 60_000;
export const DEFAULT_MAX_PAGES = 10;

/** REFERENCE_BOOK_OUTCOME_MAX_PAGES: a whole number of pages, 1 to 50; anything else is the default. */
export function outcomeMaxPagesFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_MAX_PAGES;
}

export class MarketsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly lists = new Map<string, { at: number; v: RawOutcomeMarket[]; truncated: boolean }>();
  private token: { value: string; until: number } | null = null;

  constructor(private readonly cfg: MarketsClientConfig) {
    if (!cfg.signer && !cfg.app) throw new Error("markets client: a signed key or an app client is needed; the venue publishes nothing unauthenticated");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.ttl = cfg.catalogTtlMs ?? 45_000;
    this.maxPages = cfg.maxPages ?? DEFAULT_MAX_PAGES;
    this.now = cfg.now ?? Date.now;
  }

  /** "signed key" or "app token": what the operator view says about how the venue is read; never a credential */
  get authWord(): string {
    return this.cfg.app ? "app token" : "signed key";
  }

  get pageCap(): number {
    return this.maxPages;
  }

  /** Did the last read of this competition stop at the page cap with a cursor still to follow? */
  lastListTruncated(competition: string): boolean {
    return this.lists.get(competition.toUpperCase())?.truncated ?? false;
  }

  /**
   * Every open or pre-open market of one competition (the venue's own code, e.g. "NBA"), all
   * pages, cached one window. Books on the markets are the top seven levels per side as of the
   * read.
   */
  async listCompetitionMarkets(competition: string): Promise<RawOutcomeMarket[]> {
    const key = competition.toUpperCase();
    const hit = this.lists.get(key);
    if (hit && this.now() - hit.at < this.ttl) return hit.v;
    const out: RawOutcomeMarket[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const query = `competitions=${encodeURIComponent(key)}&status=open,pre_open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res: MarketsPage = await this.get<MarketsPage>("/api/v1/markets", query);
      out.push(...(res.markets ?? []).filter((m): m is RawOutcomeMarket => Boolean(m && typeof m === "object" && typeof m.market_id === "string")));
      cursor = res.cursor ?? null;
      if (!cursor) break;
    }
    this.lists.set(key, { at: this.now(), v: out, truncated: cursor !== null });
    return out;
  }

  /** The named markets, fresh (the venue ignores every other parameter when market ids are given). */
  async getMarkets(marketIds: string[]): Promise<RawOutcomeMarket[]> {
    if (marketIds.length === 0) return [];
    const res = await this.get<MarketsPage>("/api/v1/markets", `market_ids=${encodeURIComponent(marketIds.join(","))}`);
    return (res.markets ?? []).filter((m): m is RawOutcomeMarket => Boolean(m && typeof m === "object" && typeof m.market_id === "string"));
  }

  private async get<T>(path: string, query: string): Promise<T> {
    const pathWithQuery = `${path}${query ? `?${query}` : ""}`;
    const run = async (): Promise<Response> => {
      const headers: Record<string, string> = { accept: "application/json", "user-agent": MARKETS_USER_AGENT };
      if (this.cfg.app) headers.authorization = `Bearer ${await this.appToken()}`;
      else if (this.cfg.signer) Object.assign(headers, marketsSignedHeaders(this.cfg.signer, "GET", pathWithQuery, this.now()));
      return this.fetchImpl(`${this.cfg.host}${pathWithQuery}`, { method: "GET", headers });
    };
    let r = await run();
    // an app token the venue no longer accepts (revoked, clock drift past its hour) is replaced once
    if (r.status === 401 && this.cfg.app && this.token) {
      this.token = null;
      r = await run();
    }
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const body = (json ?? {}) as { error?: string; scope?: string };
      const code = r.status === 401 ? "unauthorized" : r.status === 403 && body.scope ? "insufficient_scope" : r.status === 403 ? "forbidden" : r.status === 429 ? "rate_limit_exceeded" : `http_${r.status}`;
      throw new MarketsApiError(r.status, code, body.error ?? `markets api ${r.status} on ${path}`);
    }
    return json as T;
  }

  private async appToken(): Promise<string> {
    const app = this.cfg.app!;
    if (this.token && this.now() < this.token.until) return this.token.value;
    const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`, "utf8").toString("base64");
    const r = await this.fetchImpl(`${this.cfg.host}/oauth/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": MARKETS_USER_AGENT },
      body: "grant_type=client_credentials&scope=market_data",
    });
    const text = await r.text();
    let json: { access_token?: string; expires_in?: number; error?: string } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!r.ok || typeof json.access_token !== "string" || !json.access_token) {
      throw new MarketsApiError(r.status, json.error ?? (r.ok ? "token_missing" : `http_${r.status}`), `app token refused (${r.status})`);
    }
    const lifeMs = (typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600) * 1000;
    this.token = { value: json.access_token, until: this.now() + Math.max(lifeMs - TOKEN_SLACK_MS, 5_000) };
    return this.token.value;
  }
}
