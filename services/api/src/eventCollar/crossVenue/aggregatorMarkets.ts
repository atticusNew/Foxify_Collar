/**
 * AGGREGATOR MARKETS: one outcome, aligned across every venue that lists it, and its live books.
 *
 * A partner runs an aggregation layer over the regulated US exchanges and the offshore books: one
 * signed API that lists sports, competitions, events and markets, and for each outcome gives the
 * venue-native id on every venue that lists it (a Kalshi ticker and side, a ProphetX strike, a
 * Polymarket token), with outcome sides normalised so "the same direction" reads the same on every
 * venue. The same key opens one WebSocket that streams every venue's book in one shape: price as
 * implied probability in [0, 1], size in shares, snapshot then deltas, never a gap.
 *
 * What the record gets from it: the position-to-market match stops being a guess from a nickname
 * and a game day (the mapping is the partner's, deterministic, reportable when wrong), and the
 * cross-venue quote can read every venue's book for the same outcome from one place.
 *
 * The key is a DATA key: discovery, the lookup and the stream. It cannot call anything under
 * /v1/{venue}/, so it reads no orders, no balances and no positions, ours or anyone's. The private
 * key is a 32-byte Ed25519 seed (64 hex chars); AGGREGATOR_KEY_ID + AGGREGATOR_PRIVATE_KEY_HEX in
 * the service env, never in git, never in the client. Unset, `aggregatorConfigFromEnv` is null and
 * nothing here runs. Nothing here names the partner or a venue in anything the record publishes.
 *
 * Signing (REST): headers PX-Key-Id, PX-Timestamp (unix seconds, ±30s), PX-Content-Sha256 (hex of
 * the body, or of the empty string), PX-Signature (Ed25519, hex) over five LF-joined lines: METHOD,
 * path, query sorted by key then value, timestamp, body hash; a sixth line carries the
 * Idempotency-Key when present. GET /v1/time signs an empty timestamp line and sends no
 * PX-Timestamp. The stream signs the same way with the literal `WS` as the method and the
 * credentials in the query string (keyId, timestamp, signature) because a browser cannot set
 * headers on an upgrade.
 */

import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const DEFAULT_API_HOST = "https://api.parlayx.com";
export const DEFAULT_STREAM_URL = "wss://wss.parlayx.com/v1/orderbook";
/** the server accepts a timestamp within this of its clock, either way */
export const TIMESTAMP_WINDOW_SEC = 30;

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

/** PKCS8 DER prefix for an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");

/** The query sorted by key then value, joined with `&`, no leading `?`. Pairs are kept as sent. */
export function sortedQuery(rawQuery: string): string {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  if (!q) return "";
  const pairs = q
    .split("&")
    .filter((p) => p !== "")
    .map((p): { k: string; v: string; bare: boolean } => {
      const eq = p.indexOf("=");
      return eq === -1 ? { k: p, v: "", bare: true } : { k: p.slice(0, eq), v: p.slice(eq + 1), bare: false };
    });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => cmp(a.k, b.k) || cmp(a.v, b.v));
  return pairs.map((p) => (p.bare ? p.k : `${p.k}=${p.v}`)).join("&");
}

export interface CanonicalInputs {
  /** HTTP method, or the literal `WS` for the stream handshake */
  method: string;
  /** the path exactly as it appears in the request line */
  path: string;
  /** the raw query without `?`; for the stream, without the credential params */
  query: string;
  /** unix seconds as a string; empty for GET /v1/time */
  timestamp: string;
  /** the exact bytes sent; empty for none */
  body: Buffer | string;
  /** signed as a sixth line when the request carries one */
  idempotencyKey?: string;
}

/** Five lines joined by LF, no trailing newline; six when an idempotency key rides along. */
export function canonicalString(i: CanonicalInputs): string {
  const bodyBytes = typeof i.body === "string" ? Buffer.from(i.body, "utf8") : i.body;
  const lines = [i.method.toUpperCase(), i.path, sortedQuery(i.query), i.timestamp, bodyBytes.length ? sha256Hex(bodyBytes) : EMPTY_SHA256];
  if (i.idempotencyKey !== undefined) lines.push(i.idempotencyKey.trim());
  return lines.join("\n");
}

export interface AggregatorSigner {
  keyId: string;
  /** Ed25519 over the canonical string, lowercase hex */
  sign(canonical: string): string;
}

/** The secret as the partner issues it (64 hex chars, the seed) or as a PKCS8 PEM; either builds the same signer. */
export function signerFromSecret(keyId: string, secret: string): AggregatorSigner {
  const s = secret.trim();
  let key: KeyObject;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(s, "hex")]), format: "der", type: "pkcs8" });
  } else if (s.includes("-----BEGIN")) {
    key = createPrivateKey(s.replace(/\\n/g, "\n"));
  } else {
    throw new Error("aggregator key: expected a 64-hex Ed25519 seed or a PKCS8 PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`aggregator key: expected Ed25519, got ${String(key.asymmetricKeyType)}`);
  return { keyId, sign: (c) => cryptoSign(null, Buffer.from(c, "utf8"), key).toString("hex") };
}

export interface SignedRequest {
  method: string;
  path: string;
  query?: string;
  body?: Buffer | string;
  idempotencyKey?: string;
}

/** The PX-* headers for one request. `GET /v1/time` carries no PX-Timestamp and signs an empty line. */
export function signedHeaders(signer: AggregatorSigner, r: SignedRequest, nowSec: number = Math.floor(Date.now() / 1000)): Record<string, string> {
  const body = r.body ?? "";
  const bodyBytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const isTime = r.method.toUpperCase() === "GET" && r.path === "/v1/time";
  const timestamp = isTime ? "" : String(Math.floor(nowSec));
  const headers: Record<string, string> = {
    "PX-Key-Id": signer.keyId,
    "PX-Content-Sha256": bodyBytes.length ? sha256Hex(bodyBytes) : EMPTY_SHA256,
    "PX-Signature": signer.sign(canonicalString({ method: r.method, path: r.path, query: r.query ?? "", timestamp, body: bodyBytes, idempotencyKey: r.idempotencyKey })),
  };
  if (!isTime) headers["PX-Timestamp"] = timestamp;
  if (r.idempotencyKey !== undefined) headers["Idempotency-Key"] = r.idempotencyKey.trim();
  return headers;
}

/** The stream URL with the signed handshake in its query. Valid for the timestamp window only. */
export function signedStreamUrl(signer: AggregatorSigner, streamUrl: string = DEFAULT_STREAM_URL, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const u = new URL(streamUrl);
  const timestamp = String(Math.floor(nowSec));
  const others = [...u.searchParams.entries()].filter(([k]) => !["keyId", "timestamp", "signature"].includes(k));
  const query = others.map(([k, v]) => `${k}=${v}`).join("&");
  const signature = signer.sign(canonicalString({ method: "WS", path: u.pathname, query, timestamp, body: "" }));
  u.searchParams.set("keyId", signer.keyId);
  u.searchParams.set("timestamp", timestamp);
  u.searchParams.set("signature", signature);
  return u.toString();
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export interface AggregatorConfig {
  host: string;
  streamUrl: string;
  keyId: string;
  secret: string;
}

/** Null unless both halves of the key are set: unset, nothing is read. */
export function aggregatorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AggregatorConfig | null {
  const keyId = env.AGGREGATOR_KEY_ID?.trim();
  const secret = env.AGGREGATOR_PRIVATE_KEY_HEX?.trim();
  if (!keyId || !secret) return null;
  return {
    host: (env.AGGREGATOR_API_HOST?.trim() || DEFAULT_API_HOST).replace(/\/+$/, ""),
    streamUrl: env.AGGREGATOR_STREAM_URL?.trim() || DEFAULT_STREAM_URL,
    keyId,
    secret,
  };
}

// ---------------------------------------------------------------------------
// REST: discovery and the lookup
// ---------------------------------------------------------------------------

export interface Whoami {
  keyId: string;
  credentialId: string;
  podId: string;
  scope: string;
  capabilities: string[];
}
export interface Sport {
  id: string;
  name: string;
}
export interface Competition {
  id: string;
  name: string;
  sportId?: string;
}
export interface SportEvent {
  id: string;
  name: string;
  competitionId?: string;
  startTime?: string;
  status?: "SCHEDULED" | "LIVE" | string;
}
export type Listing =
  | { venue: "POLYMARKET"; tokenId: string; executable: boolean }
  | { venue: "KALSHI"; ticker: string; side: "YES" | "NO"; bookSide: "BID" | "ASK"; executable: boolean }
  | { venue: "PROPHETX"; strikeId: string; executable: boolean }
  | { venue: string; executable?: boolean; [k: string]: unknown };
export interface Outcome {
  name: string;
  listings: Listing[];
}
export interface Market {
  id: string;
  title: string;
  line?: string;
  outcomes: Outcome[];
}

/** Exactly one venue identifier; a strike also needs its event. */
export type LookupBy = { ticker: string } | { tokenId: string } | { conditionId: string } | { slug: string } | { strikeId: string; eventId: string };

export class AggregatorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

export interface AggregatorClientConfig {
  host: string;
  signer: AggregatorSigner;
  fetchImpl?: typeof fetch;
  /** one more try after a 429 or a 503 that names a Retry-After, when it is at most this long */
  maxRetryAfterSec?: number;
  /** signing clock, injectable; the client adds the measured server offset on top */
  nowSec?: () => number;
}

export class AggregatorClient {
  private readonly fetchImpl: typeof fetch;
  private readonly nowSec: () => number;
  private readonly maxRetryAfterSec: number;
  /** server clock minus ours, from GET /v1/time; zero until measured */
  private offsetSec = 0;

  constructor(private readonly cfg: AggregatorClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.nowSec = cfg.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.maxRetryAfterSec = cfg.maxRetryAfterSec ?? 10;
  }

  get clockOffsetSec(): number {
    return this.offsetSec;
  }

  private async request<T>(method: string, path: string, query = "", retried = false): Promise<T> {
    const headers = { accept: "application/json", ...signedHeaders(this.cfg.signer, { method, path, query }, this.nowSec() + this.offsetSec) };
    const r = await this.fetchImpl(`${this.cfg.host}${path}${query ? `?${query}` : ""}`, { method, headers });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (r.ok) return json as T;
    const retryAfter = Number(r.headers.get("retry-after"));
    const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    const body = (json ?? {}) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? `http_${r.status}`;
    if ((r.status === 429 || r.status === 503) && !retried && retryAfterSec !== null && retryAfterSec <= this.maxRetryAfterSec) {
      await new Promise((res) => setTimeout(res, retryAfterSec * 1000));
      return this.request<T>(method, path, query, true);
    }
    throw new AggregatorApiError(r.status, code, body.error?.message ?? `aggregator ${r.status} on ${path}`, retryAfterSec);
  }

  /** The identity behind the key. The smallest signed call: if this works, the signing is right. */
  whoami(): Promise<Whoami> {
    return this.request<Whoami>("GET", "/v1/whoami");
  }

  /** Server time in unix seconds; the client remembers the offset and signs with it from then on. */
  async time(): Promise<number> {
    const { time } = await this.request<{ time: number }>("GET", "/v1/time");
    if (Number.isFinite(time)) this.offsetSec = Math.round(time - this.nowSec());
    return time;
  }

  async listSports(): Promise<Sport[]> {
    const b = await this.request<{ sports?: Sport[] }>("GET", "/v1/sports");
    return Array.isArray(b?.sports) ? b.sports : [];
  }

  async listCompetitions(sportId?: string): Promise<Competition[]> {
    const b = await this.request<{ competitions?: Competition[] }>("GET", "/v1/sports/competitions", sportId ? `sport=${encodeURIComponent(sportId)}` : "");
    return Array.isArray(b?.competitions) ? b.competitions : [];
  }

  async listEvents(competitionId: string): Promise<SportEvent[]> {
    const b = await this.request<{ events?: SportEvent[] }>("GET", "/v1/sports/events", `competitionId=${encodeURIComponent(competitionId)}`);
    return Array.isArray(b?.events) ? b.events : [];
  }

  async listEventMarkets(eventId: string): Promise<Market[]> {
    const b = await this.request<{ markets?: Market[] }>("GET", `/v1/sports/events/${encodeURIComponent(eventId)}/markets`);
    return Array.isArray(b?.markets) ? b.markets.filter(isMarket) : [];
  }

  /** The canonical market(s) a venue id resolves to, with the same outcome's id on every other venue. */
  async lookupMarket(by: LookupBy): Promise<Market[]> {
    const query = Object.entries(by)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const b = await this.request<{ markets?: Market[] }>("GET", "/v1/markets", query);
    return Array.isArray(b?.markets) ? b.markets.filter(isMarket) : [];
  }
}

const isMarket = (m: unknown): m is Market => {
  const x = m as Partial<Market>;
  return Boolean(x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.outcomes));
};

// ---------------------------------------------------------------------------
// the same outcome across venues
// ---------------------------------------------------------------------------

export interface AlignedOutcome {
  marketId: string;
  title: string;
  outcome: string;
  /** every venue's id for this outcome, the one asked about included */
  listings: Listing[];
}

/**
 * Given a Kalshi ticker we protect (its YES side is our market's winning side), the outcome on the
 * canonical market that IS that side, with every other venue's id for it. Null when the lookup
 * returns nothing or no outcome carries the ticker's YES listing.
 */
export function alignedByTicker(markets: Market[], ticker: string): AlignedOutcome | null {
  for (const m of markets) {
    for (const o of m.outcomes) {
      const hit = o.listings.find((l) => l.venue === "KALSHI" && (l as { ticker?: string }).ticker === ticker && (l as { side?: string }).side === "YES");
      if (hit) return { marketId: m.id, title: m.title, outcome: o.name, listings: o.listings };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// stream: one snapshot per market
// ---------------------------------------------------------------------------

export type MarketStream =
  | { venue: "KALSHI"; ticker: string }
  | { venue: "POLYMARKET"; tokenId: string }
  | { venue: "PROPHETX"; strikeId: string }
  | { venue: "LIMITLESS"; kind: "CLOB"; marketId: string; outcomeId: string };

/** The stream entry for a listing, when the stream carries that venue. */
export function streamFor(listing: Listing): MarketStream | null {
  if (listing.venue === "KALSHI" && typeof (listing as { ticker?: unknown }).ticker === "string") return { venue: "KALSHI", ticker: (listing as { ticker: string }).ticker };
  if (listing.venue === "POLYMARKET" && typeof (listing as { tokenId?: unknown }).tokenId === "string") return { venue: "POLYMARKET", tokenId: (listing as { tokenId: string }).tokenId };
  if (listing.venue === "PROPHETX" && typeof (listing as { strikeId?: unknown }).strikeId === "string") return { venue: "PROPHETX", strikeId: (listing as { strikeId: string }).strikeId };
  return null;
}

/** A stable key for one stream entry, to pair acks and frames with what was asked. */
export const streamKey = (m: MarketStream): string =>
  m.venue === "KALSHI" ? `KALSHI:${m.ticker}` : m.venue === "POLYMARKET" ? `POLYMARKET:${m.tokenId}` : m.venue === "PROPHETX" ? `PROPHETX:${m.strikeId}` : `LIMITLESS:${m.marketId}:${m.outcomeId}`;

export interface Level {
  price: number;
  size: number;
}
export interface BookSnapshot {
  bids: Level[];
  asks: Level[];
  seq: number;
  status?: string;
  serverTimestamp: number;
  venueTimestamp: number;
}
export type StreamResult = { market: MarketStream; book: BookSnapshot; error?: undefined } | { market: MarketStream; book: null; error: { code: string; message: string } };

/** The minimal WebSocket surface the reader needs; Node 22's global and `ws` both satisfy it. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
}
export type WsFactory = (url: string) => WsLike;

const defaultWsFactory: WsFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!Ctor) throw new Error("aggregator stream: no WebSocket implementation");
  return new Ctor(url);
};

export interface SnapshotOptions {
  streamUrl?: string;
  wsFactory?: WsFactory;
  /** give up on markets still pending after this; they come back as UNAVAILABLE */
  timeoutMs?: number;
  nowSec?: () => number;
}

/**
 * Open the stream, subscribe BOOK on every market, keep the first SNAPSHOT (or the ERROR) per
 * market, then close. For a reference read that is all that is needed; a live quote path would
 * hold the socket and apply deltas instead.
 */
export function readSnapshots(signer: AggregatorSigner, markets: MarketStream[], opt: SnapshotOptions = {}): Promise<StreamResult[]> {
  const timeoutMs = opt.timeoutMs ?? 8_000;
  const url = signedStreamUrl(signer, opt.streamUrl ?? DEFAULT_STREAM_URL, opt.nowSec?.() ?? Math.floor(Date.now() / 1000));
  const wanted = new Map(markets.map((m) => [streamKey(m), m]));
  const bySub = new Map<string, MarketStream>();
  const results = new Map<string, StreamResult>();
  if (!markets.length) return Promise.resolve([]);
  return new Promise<StreamResult[]>((resolve, reject) => {
    let done = false;
    let ws: WsLike;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const [k, m] of wanted) if (!results.has(k)) results.set(k, { market: m, book: null, error: { code: "UNAVAILABLE", message: "no snapshot before the read timed out" } });
      try {
        ws.close(1000, "done");
      } catch {
        /* closed already */
      }
      resolve(markets.map((m) => results.get(streamKey(m))!));
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = opt.wsFactory ? opt.wsFactory(url) : defaultWsFactory(url);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    const settle = (k: string, r: StreamResult) => {
      if (!results.has(k)) results.set(k, r);
      if (results.size >= wanted.size) finish();
    };
    ws.addEventListener("error", (ev) => {
      if (done) return;
      clearTimeout(timer);
      done = true;
      reject(new Error(`aggregator stream: ${String((ev as { message?: string }).message ?? "connection error")}`));
    });
    ws.addEventListener("close", (ev) => {
      if (done) return;
      if (!results.size) {
        clearTimeout(timer);
        done = true;
        reject(new Error(`aggregator stream closed before any frame (${ev.code ?? "?"} ${ev.reason ?? ""})`.trim()));
        return;
      }
      finish();
    });
    ws.addEventListener("message", (ev) => {
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = f.type;
      if (type === "WELCOME") {
        ws.send(JSON.stringify({ type: "SUBSCRIBE", markets, channels: ["BOOK"], requestId: "snapshots" }));
        return;
      }
      if (type === "SUBSCRIBED") {
        const m = f.market as MarketStream | undefined;
        if (m && typeof f.subscriptionId === "string") bySub.set(f.subscriptionId, m);
        return;
      }
      if (type === "SNAPSHOT") {
        const m = typeof f.subscriptionId === "string" ? bySub.get(f.subscriptionId) : undefined;
        if (!m) return;
        const book: BookSnapshot = {
          bids: levels(f.bids),
          asks: levels(f.asks),
          seq: Number(f.seq ?? 0),
          status: typeof f.status === "string" ? f.status : undefined,
          serverTimestamp: Number(f.serverTimestamp ?? 0),
          venueTimestamp: Number(f.venueTimestamp ?? 0),
        };
        settle(streamKey(m), { market: m, book });
        return;
      }
      if (type === "ERROR") {
        const code = String(f.code ?? "ERROR");
        const message = String(f.message ?? "");
        const m = (f.market as MarketStream | undefined) ?? (typeof f.subscriptionId === "string" ? bySub.get(f.subscriptionId) : undefined);
        if (m && wanted.has(streamKey(m))) settle(streamKey(m), { market: m, book: null, error: { code, message } });
        else if (!m && results.size === 0 && wanted.size > 0 && !bySub.size) {
          // a connection-level error before any ack: the whole batch was refused
          for (const [k, mk] of wanted) results.set(k, { market: mk, book: null, error: { code, message } });
          finish();
        }
      }
    });
  });
}

const levels = (v: unknown): Level[] =>
  Array.isArray(v)
    ? v
        .map((l) => ({ price: Number((l as Level).price), size: Number((l as Level).size) }))
        .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0)
    : [];

// ---------------------------------------------------------------------------
// book arithmetic
// ---------------------------------------------------------------------------

/** Best bid and ask of a book, in cents, or null for an empty side. */
export function bestOf(book: { bids: Level[]; asks: Level[] }): { bidCents: number | null; askCents: number | null; bidSize: number; askSize: number } {
  const bid = [...book.bids].sort((a, b) => b.price - a.price)[0];
  const ask = [...book.asks].sort((a, b) => a.price - b.price)[0];
  return {
    bidCents: bid ? Math.round(bid.price * 100) : null,
    askCents: ask ? Math.round(ask.price * 100) : null,
    bidSize: bid?.size ?? 0,
    askSize: ask?.size ?? 0,
  };
}

/**
 * A Kalshi book streams YES-priced only. The NO view is the same book read from the other end:
 * price becomes 1 - price, the sides swap, size carries across, and both sides are re-sorted
 * best first. Our hedge on a protected position buys the No side, so this is the book it hits.
 */
export function kalshiNoView(book: { bids: Level[]; asks: Level[] }): { bids: Level[]; asks: Level[] } {
  const flip = (l: Level): Level => ({ price: Math.round((1 - l.price) * 1e6) / 1e6, size: l.size });
  return {
    bids: book.asks.map(flip).sort((a, b) => b.price - a.price),
    asks: book.bids.map(flip).sort((a, b) => a.price - b.price),
  };
}
