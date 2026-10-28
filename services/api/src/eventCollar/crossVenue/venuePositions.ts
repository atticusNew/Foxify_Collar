/**
 * VENUE POSITIONS: the holder's open positions, read from the venue's own API and matched to the
 * markets the engine can protect.
 *
 * The Lock in client (browser extension, later a storefront) draws its button on the venue's
 * portfolio page. It could read the size off the page, but a page is a rendering, not a record.
 * With a read-only key for the holder's account the service confirms the position itself: the
 * contracts held, what they cost, the market and the game. The client then only has to point at a
 * row; every number on the panel and on the public record comes from here.
 *
 * Credentials: VENUE_API_KEY_ID + VENUE_API_PRIVATE_KEY_PEM (PKCS8; Ed25519 or P-256), service env
 * only, never in the client. The key should be the venue's read-only management scope: it can
 * list positions and read the catalog, cannot place an order, cannot move money. VENUE_API_HOST
 * selects the environment (paper or production); unset, the client is off and the route says so.
 *
 * Signing follows the venue's V3 scheme: three headers (key id, unix millis, base64 signature) over
 * a six-line canonical string (scheme, timestamp, method, path, canonical query, sha256 of the raw
 * body). `canonicalString` is pure so it can be checked against the venue's published vectors.
 *
 * Units: the venue's contract pays 1 cent; ours pays $1. qty 2000 at cost "11.40" is 20 of our
 * contracts at 57 cents. Nothing here names the venue in anything the record publishes.
 *
 * The same client also lists a league's winner markets and reads one market's book; venueBooks.ts
 * uses those two reads to price the venue as a reference beside the hedge routes.
 */

import { createHash, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { LEAGUE_TEMPLATES, type LeagueTemplate } from "./resolutionWhitelist";
import { outcomeNameMatches } from "./eventMatcher";
import { roundContracts } from "./types";

export const SCHEME = "NOVIG-V3";
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

/** `%XX` decodes (UTF-8 bytes); a bare `+` stays `+`. */
function decodeQueryPart(part: string): Buffer {
  const raw = Buffer.from(part, "utf8");
  const out: number[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === 0x25 && i + 2 < raw.length) {
      const hex = raw.subarray(i + 1, i + 3).toString("latin1");
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    out.push(raw[i]);
    i += 1;
  }
  return Buffer.from(out);
}

/** Keep ALPHA DIGIT - . _ ~; everything else `%XX` uppercase. */
function encodeQueryPart(bytes: Buffer): string {
  let s = "";
  for (const b of bytes) {
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isAlnum || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e) s += String.fromCharCode(b);
    else s += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return s;
}

/** The venue's canonical query: split, decode, re-encode, sort bytewise by name then value, join. */
export function canonicalQuery(rawQuery: string): string {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  if (!q) return "";
  const pairs: Array<[string, string]> = [];
  for (const pair of q.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    pairs.push([encodeQueryPart(decodeQueryPart(name)), encodeQueryPart(decodeQueryPart(value))]);
  }
  const cmp = (a: string, b: string) => {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    return Buffer.compare(ab, bb);
  };
  pairs.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export interface CanonicalInputs {
  timestampMs: number | string;
  method: string;
  /** the path only, verbatim, leading slash */
  path: string;
  /** the raw query string without `?`, or empty */
  query: string;
  /** the exact bytes sent; empty for none */
  body: Buffer | string;
}

/** The six lines joined by LF, no trailing newline. */
export function canonicalString(i: CanonicalInputs): string {
  const bodyBytes = typeof i.body === "string" ? Buffer.from(i.body, "utf8") : i.body;
  const hash = bodyBytes.length === 0 ? EMPTY_BODY_SHA256 : createHash("sha256").update(bodyBytes).digest("hex");
  return [SCHEME, String(i.timestampMs), i.method.toUpperCase(), i.path, canonicalQuery(i.query), hash].join("\n");
}

export type SigningAlgorithm = "Ed25519" | "P-256";

export interface VenueSigner {
  keyId: string;
  algorithm: SigningAlgorithm;
  sign(canonical: string): string;
}

/** Build a signer from a PKCS8 PEM. Ed25519 signs the string directly; P-256 is ECDSA/SHA-256, DER. */
export function signerFromPem(keyId: string, pem: string): VenueSigner {
  const key: KeyObject = createPrivateKey(pem.replace(/\\n/g, "\n").trim());
  const type = key.asymmetricKeyType;
  if (type === "ed25519") {
    return { keyId, algorithm: "Ed25519", sign: (c) => cryptoSign(null, Buffer.from(c, "utf8"), key).toString("base64") };
  }
  if (type === "ec") {
    const curve = (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
    if (curve && curve !== "prime256v1" && curve !== "P-256") throw new Error(`venue key: unsupported curve ${curve}`);
    return { keyId, algorithm: "P-256", sign: (c) => cryptoSign("sha256", Buffer.from(c, "utf8"), { key, dsaEncoding: "der" }).toString("base64") };
  }
  throw new Error(`venue key: unsupported key type ${String(type)}`);
}

export function signedHeaders(signer: VenueSigner, i: Omit<CanonicalInputs, "timestampMs">, nowMs: number = Date.now()): Record<string, string> {
  const ts = String(Math.floor(nowMs));
  const sig = signer.sign(canonicalString({ ...i, timestampMs: ts }));
  return { "Novig-Key-Id": signer.keyId, "Novig-Timestamp": ts, "Novig-Signature": sig };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface VenueClientConfig {
  host: string;
  /**
   * Absent, the client reads the venue's PUBLIC catalog and books (`/v3/public/...`, unsigned),
   * which is all a price reference needs; positions then cannot be read. Present, every read is
   * signed and goes to the account-scoped paths.
   */
  signer?: VenueSigner;
  fetchImpl?: typeof fetch;
  /** market and event lookups are cached this long; the catalog barely moves pre-game */
  catalogTtlMs?: number;
}

export function venueConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; keyId: string; pem: string } | null {
  const host = env.VENUE_API_HOST?.trim().replace(/\/+$/, "");
  const keyId = env.VENUE_API_KEY_ID?.trim();
  const pem = env.VENUE_API_PRIVATE_KEY_PEM?.trim();
  if (!host || !keyId || !pem) return null;
  return { host, keyId, pem };
}

/** A position as the venue reports it. Nothing derived. */
export interface RawVenuePosition {
  marketId: string;
  outcomeId: string;
  qty: number;
  cost: string;
}

export interface RawVenueMarket {
  marketId: string;
  eventId: string;
  description: string;
  marketType: string;
  status: string;
  startsTs: number;
  outcomes: Array<{ outcomeId: string; name: string; status: string }>;
  /** the venue's own league, sport or competition word on the market, when it puts one there (the catalog probe tallies these) */
  league?: string;
  sport?: string;
  competition?: string;
  /** the venue's fee rule for the market: c x P x (1 - P) per contract, charged always or only once live (numbers arrive as strings) */
  fee?: { coefficient?: number | string; makerCredit?: number | string; charged?: string };
}

/** One resting order as the venue's book shows it: every order is a bid on its outcome, best first. */
export interface RawVenueOrder {
  orderId?: string;
  /** decimal string probability, "0.665" */
  price: string;
  /** contracts paying 1 cent each */
  qty: number;
}

export interface RawVenueBook {
  marketId: string;
  seq?: number;
  orders: Record<string, RawVenueOrder[]>;
}

export interface RawVenueEvent {
  eventId: string;
  description: string;
  sport: string;
  league: string;
  status: string;
  startsTs: number;
}

export class VenueApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** the account-scoped catalog refusing the key: the public catalog has the same markets and books */
const CATALOG_FALLBACK_STATUSES = new Set([401, 403, 423]);

export class VenueClient {
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly markets = new Map<string, { at: number; v: RawVenueMarket }>();
  private readonly events = new Map<string, { at: number; v: RawVenueEvent }>();
  private readonly marketLists = new Map<string, { at: number; v: RawVenueMarket[] }>();
  private publicUntil = 0;
  private signedRefusal: string | null = null;

  constructor(private readonly cfg: VenueClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.ttl = cfg.catalogTtlMs ?? 10 * 60_000;
  }

  /** true when every read goes unsigned to the public catalog */
  get isPublic(): boolean {
    return !this.cfg.signer;
  }

  /**
   * Why catalog reads are going to the public path on a signed client: the account-scoped catalog
   * refused the key (locked account, bad key) and the reads fell back. Null when nothing fell back.
   */
  get catalogFallbackNote(): string | null {
    return this.publicUntil > Date.now() && this.signedRefusal ? `signed catalog refused the key (${this.signedRefusal}); reading the public catalog` : null;
  }

  /**
   * A catalog read: the account-scoped path when signed, the public one otherwise. A signed read the
   * venue refuses for the account (423 locked, 401/403 on the key) is retried on the public catalog,
   * which publishes the same markets and books, and catalog reads stay public for one cache window
   * so a locked account costs one refused call per window, not two calls per read. Positions are
   * never retried this way: they exist only on the signed path.
   */
  private async catalogGet<T>(path: string, query = ""): Promise<T> {
    if (!this.cfg.signer || Date.now() < this.publicUntil) return this.get<T>(`/v3/public/catalog${path}`, query, { unsigned: true });
    try {
      return await this.get<T>(`/v3/catalog${path}`, query);
    } catch (err) {
      if (!(err instanceof VenueApiError) || !CATALOG_FALLBACK_STATUSES.has(err.status)) throw err;
      this.publicUntil = Date.now() + this.ttl;
      this.signedRefusal = `${err.status} ${err.code}`;
      return this.get<T>(`/v3/public/catalog${path}`, query, { unsigned: true });
    }
  }

  private async get<T>(path: string, query = "", opts: { unsigned?: boolean } = {}): Promise<T> {
    const headers = {
      accept: "application/json",
      ...(this.cfg.signer && !opts.unsigned ? signedHeaders(this.cfg.signer, { method: "GET", path, query, body: "" }) : {}),
    };
    const r = await this.fetchImpl(`${this.cfg.host}${path}${query ? `?${query}` : ""}`, { method: "GET", headers });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const body = (json ?? {}) as { code?: string; message?: string };
      throw new VenueApiError(r.status, body.code ?? `http_${r.status}`, body.message ?? `venue api ${r.status} on ${path}`);
    }
    return json as T;
  }

  /** Every open position across every wallet the key can read (a management-scope key answers an object keyed by wallet). */
  async listPositions(): Promise<RawVenuePosition[]> {
    if (!this.cfg.signer) throw new VenueApiError(0, "unsigned", "positions need a signed key; this client reads the public catalog only");
    const body = await this.get<RawVenuePosition[] | Record<string, RawVenuePosition[]>>("/v3/portfolio/positions");
    if (Array.isArray(body)) return body.filter(isPosition);
    if (body && typeof body === "object") return Object.values(body).flat().filter(isPosition);
    return [];
  }

  async getMarket(marketId: string): Promise<RawVenueMarket> {
    const hit = this.markets.get(marketId);
    if (hit && Date.now() - hit.at < this.ttl) return hit.v;
    const v = await this.catalogGet<RawVenueMarket>(`/markets/${encodeURIComponent(marketId)}`);
    this.markets.set(marketId, { at: Date.now(), v });
    return v;
  }

  async getEvent(eventId: string): Promise<RawVenueEvent> {
    const hit = this.events.get(eventId);
    if (hit && Date.now() - hit.at < this.ttl) return hit.v;
    const v = await this.catalogGet<RawVenueEvent>(`/events/${encodeURIComponent(eventId)}`);
    this.events.set(eventId, { at: Date.now(), v });
    return v;
  }

  /**
   * The winner markets of one league as the catalog lists them (`{items, next}`; a bare array is
   * accepted too). One page of 200 covers a league's slate; a `next` beyond that is not followed.
   * Cached like the single reads.
   */
  async listMoneyMarkets(league: string): Promise<RawVenueMarket[]> {
    return this.listMarkets({ league: league.toUpperCase(), marketType: "MONEY", limit: "200" });
  }

  /**
   * One page of the catalog's markets under any filter the venue accepts (`league`, `marketType`,
   * `limit`; none at all for everything), cached by the query like the single reads. The reader
   * uses it through `listMoneyMarkets`; the catalog probe asks it directly.
   */
  async listMarkets(filter: Record<string, string>): Promise<RawVenueMarket[]> {
    const query = Object.entries(filter)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const key = `markets:${query}`;
    const hit = this.marketLists.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.v;
    const body = await this.catalogGet<RawVenueMarket[] | { items?: RawVenueMarket[]; markets?: RawVenueMarket[]; next?: string | null }>("/markets", query);
    const items = Array.isArray(body) ? body : (body?.items ?? body?.markets ?? []);
    const v = items.filter((m) => m && typeof m.marketId === "string" && Array.isArray(m.outcomes));
    this.marketLists.set(key, { at: Date.now(), v });
    for (const m of v) this.markets.set(m.marketId, { at: Date.now(), v: m });
    return v;
  }

  /** The live book of one market: resting bids per outcome, best first. Never cached. */
  async getBook(marketId: string): Promise<RawVenueBook> {
    const v = await this.catalogGet<RawVenueBook>(`/markets/${encodeURIComponent(marketId)}/book`);
    if (!v || typeof v !== "object" || !v.orders || typeof v.orders !== "object") {
      throw new VenueApiError(0, "book_shape", `venue book for ${marketId} has no orders`);
    }
    return v;
  }
}

function isPosition(p: unknown): p is RawVenuePosition {
  const x = p as Partial<RawVenuePosition>;
  return Boolean(x && typeof x.marketId === "string" && typeof x.outcomeId === "string" && Number.isInteger(x.qty) && typeof x.cost === "string");
}

// ---------------------------------------------------------------------------
// units and matching
// ---------------------------------------------------------------------------

/**
 * The venue's cents-per-contract position in our dollars-per-contract terms: qty cents of payout
 * is qty / 100 contracts, to the hundredth (1595 is 15.95 contracts, the venue's own fraction).
 * Under one contract there is no size to protect.
 */
export function positionSize(qty: number, cost: string): { contracts: number; entryCents: number; payoutCents: number; costCents: number } | null {
  const costNum = Number(cost);
  if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(costNum) || costNum < 0) return null;
  const contracts = roundContracts(qty / 100);
  if (contracts < 1) return null;
  const costCents = Math.round(costNum * 100);
  // average price as a fraction is cost / (qty * 0.01); in cents per $1 contract that is 10000 * cost / qty
  const entryCents = Math.min(99, Math.max(1, Math.round((10_000 * costNum) / qty)));
  return { contracts, entryCents, payoutCents: qty, costCents };
}

/** One of the engine's markets, the subset the matcher needs (listGameMarkets rows carry it). */
export interface ProtectableMarket {
  ticker: string;
  league: string;
  sideName: string;
  title: string;
  dateIso: string | null;
}

const DAY_MS = 86_400_000;

/** The template's league for the venue's league name ("NFL" → nfl). */
export function templateForLeague(league: string): LeagueTemplate | null {
  const l = league.trim().toLowerCase();
  return LEAGUE_TEMPLATES.find((t) => t.league === l) ?? null;
}

const codeOf = (ticker: string) => ticker.slice(ticker.lastIndexOf("-") + 1);

/** The team our market pays on, by canonical full name, when the venue's outcome names the same club. */
function sideMatches(template: LeagueTemplate, market: ProtectableMarket, outcomeName: string): boolean {
  const code = codeOf(market.ticker);
  const name = outcomeName.trim();
  // a bare team code ("HOU", "JAX") as the venue's outcome
  if (/^[A-Z]{2,4}$/.test(name)) {
    const aliases = (template.teamCodeAliases[code] ?? []).map((a) => a.toUpperCase());
    return name === code || aliases.includes(name);
  }
  const full = template.teamNames[code];
  if (!full) return outcomeNameMatches(market.sideName, name);
  return clubMatches(template, full, name);
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The nickname that tells one club from every other in the league: the last word of the full
 * name, or the last two when the last word is shared (Red Sox / White Sox).
 */
/** the league's clubs by full name, once each (the tables carry alias codes for the same club) */
const clubsOf = (template: LeagueTemplate): string[] => [...new Set(Object.values(template.teamNames).map(normalizeName))];

export function clubNickname(template: LeagueTemplate, full: string): string {
  const words = normalizeName(full).split(" ");
  const last = words[words.length - 1];
  const shared = clubsOf(template).filter((n) => n.split(" ").pop() === last).length > 1;
  return shared && words.length >= 2 ? words.slice(-2).join(" ") : last;
}

/**
 * Does the venue's outcome name this club? Exact full name, the city alone, the nickname alone,
 * or anything ending in the nickname ("HOU Texans", "Houston Texans"). "New York Jets" does not
 * match the Giants: only the distinguishing nickname counts, never a shared city word.
 */
export function clubMatches(template: LeagueTemplate, full: string, outcomeName: string): boolean {
  const k = normalizeName(full);
  const p = normalizeName(outcomeName);
  if (!k || !p) return false;
  if (p === k) return true;
  const nick = clubNickname(template, full);
  if (p === nick || p.endsWith(" " + nick)) return true;
  // the city alone, when no other club in the league shares it
  const city = k.slice(0, k.length - nick.length).trim();
  if (city && p === city) {
    return clubsOf(template).filter((n) => n.startsWith(city + " ")).length === 1;
  }
  return false;
}

/**
 * The engine's market for one venue position: same league, a winner market, the outcome names
 * our side's club, and the game is on the same day (ET, within a day either way to absorb
 * timezone and late-night tips). Null when any of that fails; the client then shows the row
 * as not covered rather than guessing.
 */
export function matchPosition(
  market: RawVenueMarket,
  event: RawVenueEvent | null,
  outcomeId: string,
  protectable: ProtectableMarket[],
): { ticker: string; reason?: undefined } | { ticker: null; reason: string } {
  const league = event?.league ?? "";
  const template = templateForLeague(league);
  if (!template) return { ticker: null, reason: "league_not_covered" };
  if (!/^(winner|moneyline|money_line|ml|match_winner|game_winner|h2h)$/i.test(market.marketType.replace(/[\s-]/g, "_"))) {
    return { ticker: null, reason: "market_not_covered" };
  }
  const outcome = market.outcomes.find((o) => o.outcomeId === outcomeId);
  if (!outcome) return { ticker: null, reason: "outcome_unknown" };
  const startMs = market.startsTs || event?.startsTs || 0;
  const hits = protectable.filter((m) => {
    if (m.league !== template.league) return false;
    if (!sideMatches(template, m, outcome.name)) return false;
    if (!m.dateIso || !startMs) return true;
    const gameDay = Date.parse(`${m.dateIso}T12:00:00-04:00`);
    return Math.abs(gameDay - startMs) <= 1.5 * DAY_MS;
  });
  if (hits.length === 1) return { ticker: hits[0].ticker };
  if (hits.length === 0) return { ticker: null, reason: "no_protectable_market" };
  // two games for one club inside the window (a doubleheader): pick the closest start
  const best = hits
    .map((m) => ({ m, d: m.dateIso ? Math.abs(Date.parse(`${m.dateIso}T12:00:00-04:00`) - startMs) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.d - b.d)[0];
  return { ticker: best.m.ticker };
}

/** What the client gets per position: the venue's ids are hashed, the venue is not named. */
export interface HolderPosition {
  /** stable id for the row: sha256 of market+outcome, short */
  id: string;
  ticker: string | null;
  reason?: string;
  league: string | null;
  /** the side the holder has, as the venue names it */
  side: string;
  /** the game, as the venue names it */
  event: string;
  startsIso: string | null;
  marketType: string;
  contracts: number;
  entryCents: number;
  payoutCents: number;
  costCents: number;
}

export function positionId(marketId: string, outcomeId: string): string {
  return createHash("sha256").update(`${marketId}:${outcomeId}`).digest("hex").slice(0, 16);
}

/** Read, size and match every open position. Lookups that fail leave the row with a reason, never drop it. */
export async function holderPositions(client: VenueClient, protectable: ProtectableMarket[]): Promise<HolderPosition[]> {
  const raw = await client.listPositions();
  const out: HolderPosition[] = [];
  for (const p of raw) {
    const size = positionSize(p.qty, p.cost);
    if (!size) continue;
    let market: RawVenueMarket | null = null;
    let event: RawVenueEvent | null = null;
    try {
      market = await client.getMarket(p.marketId);
      event = await client.getEvent(market.eventId).catch(() => null);
    } catch {
      market = null;
    }
    const base = { id: positionId(p.marketId, p.outcomeId), ...size };
    if (!market) {
      out.push({ ...base, ticker: null, reason: "market_lookup_failed", league: null, side: "", event: "", startsIso: null, marketType: "" });
      continue;
    }
    const outcome = market.outcomes.find((o) => o.outcomeId === p.outcomeId);
    const matched = matchPosition(market, event, p.outcomeId, protectable);
    out.push({
      ...base,
      ticker: matched.ticker,
      ...(matched.ticker ? {} : { reason: matched.reason }),
      league: event?.league?.toLowerCase() ?? null,
      side: outcome?.name ?? "",
      event: event?.description ?? market.description,
      startsIso: market.startsTs ? new Date(market.startsTs).toISOString() : event?.startsTs ? new Date(event.startsTs).toISOString() : null,
      marketType: market.marketType,
    });
  }
  return out;
}
