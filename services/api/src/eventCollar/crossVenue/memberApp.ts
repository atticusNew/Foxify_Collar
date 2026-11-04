/**
 * THE MEMBER APP: a member of the outcome-market exchange (venueMarkets.ts dialect; "STX" to its
 * members) connects their own account to the service, and the lock is their own sale inside it.
 *
 * On this venue nothing of ours is bought anywhere. A lock is a limit sell of part of the member's
 * position into the venue's own bid, placed with the member's consent through the venue's OAuth:
 * the cash lands in their balance, the rest of the position rides to the game. No counterparty,
 * no hedge, no capital, no fee of ours (memberSale.ts has the arithmetic).
 *
 * Consent: OAuth 2.0 authorization code with PKCE (S256), the only grant the venue offers a
 * member. The service is the Web app: it holds the client secret and the member's tokens; the
 * browser extension holds neither. Connect builds the authorize URL with a one-time `state` and a
 * verifier kept here; the venue redirects the member's browser to the service's callback; the
 * code is exchanged from the server with HTTP Basic (client_secret_basic) and the tokens are
 * written to the store, encrypted (AES-256-GCM under MEMBER_APP_TOKEN_KEY). Access tokens last
 * an hour; refresh tokens rotate on every use, and a retired one presented again revokes the
 * grant, so the store is written before the new token is used and never from two places.
 *
 * Scopes asked: portfolio.read (positions, settlements), orders.read (orders, fills),
 * orders.write (the sell and its cancel; the venue requires an IP allowlist for it), profile.read
 * (whose account this is: id, handle, avatar), balance.read (the balance the sale lands in, so
 * the page can show it move). No scope moves money off the venue.
 *
 * Env (service only): MEMBER_APP_HOST · MEMBER_APP_CLIENT_ID · MEMBER_APP_CLIENT_SECRET ·
 * MEMBER_APP_REDIRECT_URI (exactly as registered) · MEMBER_APP_TOKEN_KEY (32 bytes, hex or
 * base64) · MEMBER_APP_TOKENS_PATH · MEMBER_APP_SCOPES. Unset, nothing here is on.
 *
 * Logs and views never carry a token, a code, a verifier or a secret: fingerprints only.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { outcomeMaxPrice, outcomePriceMilli, parseOutcomeCompetitionCodes, type OutcomeCompetitionCodes } from "./venueBooks";
import type { RawOutcomeMarket } from "./venueMarkets";
import { clubMatches, positionId, templateForLeague, type HolderPosition, type ProtectableMarket } from "./venuePositions";
import { roundContracts } from "./types";
import type { LeagueTemplate } from "./resolutionWhitelist";

export const MEMBER_APP_USER_AGENT = "atticus-event-shadow/0.1 (member app)";
export const MEMBER_DEFAULT_SCOPES = "profile.read balance.read portfolio.read orders.read orders.write";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface MemberAppConfig {
  host: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  storePath: string;
  /** the 32-byte key the store encrypts under */
  key: Buffer;
  /** the venue's competition codes by league, as the reference reader has them (venueBooks.ts) */
  competitionCodes: OutcomeCompetitionCodes;
}

/** A 32-byte key as 64 hex chars or as base64 (standard or url-safe); anything else is null. */
export function tokenKeyFrom(raw: string | undefined): Buffer | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/**
 * The member app from the env. `defaults.redirectUri` is the service's own callback, used when
 * MEMBER_APP_REDIRECT_URI is unset; `defaults.storePath` is where the tokens live. Notes say what
 * is missing when the app is off, never the values.
 */
export function memberAppConfigFromEnv(env: NodeJS.ProcessEnv, defaults: { redirectUri: string; storePath: string }): { config: MemberAppConfig | null; notes: string[] } {
  const notes: string[] = [];
  const host = (env.MEMBER_APP_HOST ?? "").trim().replace(/\/+$/, "");
  const clientId = (env.MEMBER_APP_CLIENT_ID ?? "").trim();
  const clientSecret = (env.MEMBER_APP_CLIENT_SECRET ?? "").trim();
  if (!host && !clientId && !clientSecret) return { config: null, notes };
  if (!host || !clientId || !clientSecret) {
    notes.push(`member app: ${[!host && "MEMBER_APP_HOST", !clientId && "MEMBER_APP_CLIENT_ID", !clientSecret && "MEMBER_APP_CLIENT_SECRET"].filter(Boolean).join(", ")} unset; off`);
    return { config: null, notes };
  }
  if (!/^https?:\/\//.test(host)) {
    notes.push("member app: MEMBER_APP_HOST must start with https://; off");
    return { config: null, notes };
  }
  const key = tokenKeyFrom(env.MEMBER_APP_TOKEN_KEY);
  if (!key) {
    notes.push("member app: MEMBER_APP_TOKEN_KEY must be 32 bytes as 64 hex chars or base64; off (tokens are never stored in the clear)");
    return { config: null, notes };
  }
  const redirectUri = (env.MEMBER_APP_REDIRECT_URI ?? "").trim() || defaults.redirectUri;
  const scopes = ((env.MEMBER_APP_SCOPES ?? "").trim() || MEMBER_DEFAULT_SCOPES).split(/[\s,]+/).filter(Boolean).join(" ");
  const codes = parseOutcomeCompetitionCodes(env.REFERENCE_BOOK_OUTCOME_COMPETITIONS);
  notes.push(...codes.notes);
  return {
    config: { host, clientId, clientSecret, redirectUri, scopes, storePath: (env.MEMBER_APP_TOKENS_PATH ?? "").trim() || defaults.storePath, key, competitionCodes: codes.codes },
    notes,
  };
}

// ---------------------------------------------------------------------------
// PKCE and the authorize URL
// ---------------------------------------------------------------------------

const b64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh verifier (43 to 128 unreserved characters) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier, "ascii").digest()) };
}

export function authorizeUrl(cfg: Pick<MemberAppConfig, "host" | "clientId" | "redirectUri" | "scopes">, p: { state: string; challenge: string; prompt?: "none" }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...(p.prompt ? { prompt: p.prompt } : {}),
  });
  return `${cfg.host}/oauth/authorize?${q.toString()}`;
}

/** The first and last four characters of a token, for a log line; never the token. */
export const tokenFingerprint = (t: string | null | undefined): string | null => (t && t.length >= 12 ? `${t.slice(0, 10)}…${t.slice(-4)}` : t ? "(short)" : null);

// ---------------------------------------------------------------------------
// the token endpoint
// ---------------------------------------------------------------------------

export class MemberApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** the venue's `error_reason` on a refused grant (account_pending: the member is still being verified) */
    public readonly reason?: string,
    /** on 403 insufficient_scope: the scope that would cover the call; on terms_required: the venue's terms page */
    public readonly scope?: string,
    public readonly termsUrl?: string,
  ) {
    super(message);
  }
  /** the grant is gone for good: the member reconnects */
  get terminal(): boolean {
    return this.code === "invalid_grant" && this.reason !== "account_pending";
  }
}

export interface MemberGrant {
  accessToken: string;
  refreshToken: string | null;
  /** when the access token stops working, ms */
  expiresAtMs: number;
  scope: string;
  connectedAtIso: string;
  /** when the tokens were last rotated, ISO */
  refreshedAtIso?: string;
  /** whose account, by the venue's ids (profile.read); never a name */
  userId?: string | null;
  accountId?: string | null;
  /** the member's public handle and avatar path on the venue (profile.read), as the venue shows them on its own leaderboard */
  handle?: string | null;
  avatarUrl?: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  error_reason?: string;
}

/** The form-encoded POST to /oauth/token or /oauth/revoke with the client's Basic credentials. */
async function tokenPost(cfg: Pick<MemberAppConfig, "host" | "clientId" | "clientSecret">, fetchImpl: typeof fetch, path: string, form: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
  const r = await fetchImpl(`${cfg.host}${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": MEMBER_APP_USER_AGENT },
    body: new URLSearchParams(form).toString(),
  });
  const text = await r.text();
  let json: TokenResponse = {};
  try {
    json = text ? (JSON.parse(text) as TokenResponse) : {};
  } catch {
    json = {};
  }
  return { status: r.status, json };
}

function grantOf(json: TokenResponse, nowMs: number, prev?: Pick<MemberGrant, "connectedAtIso" | "userId" | "accountId" | "refreshToken" | "handle" | "avatarUrl">): MemberGrant {
  const life = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken: json.access_token as string,
    // a refresh that answers without a new refresh token keeps the one it was sent (the venue rotates; this is the fallback)
    refreshToken: json.refresh_token ?? prev?.refreshToken ?? null,
    expiresAtMs: nowMs + life * 1000,
    scope: json.scope ?? "",
    connectedAtIso: prev?.connectedAtIso ?? new Date(nowMs).toISOString(),
    ...(prev ? { refreshedAtIso: new Date(nowMs).toISOString() } : {}),
    userId: prev?.userId ?? null,
    accountId: prev?.accountId ?? null,
    handle: prev?.handle ?? null,
    avatarUrl: prev?.avatarUrl ?? null,
  };
}

const refused = (status: number, json: TokenResponse, what: string): MemberApiError =>
  new MemberApiError(status, json.error ?? (status === 503 ? "temporarily_unavailable" : `http_${status}`), json.error_description ?? `${what} refused (${status})`, json.error_reason);

/** Step 4: the code for the tokens. The venue checks the code, the redirect URI and the verifier. */
export async function exchangeCode(cfg: MemberAppConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<MemberGrant> {
  const { status, json } = await tokenPost(cfg, fetchImpl, "/oauth/token", { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier });
  if (status !== 200 || !json.access_token) throw refused(status, json, "code exchange");
  return grantOf(json, nowMs);
}

/** A rotated pair from the refresh token. invalid_grant without account_pending is terminal: the member reconnects. */
export async function refreshGrant(cfg: MemberAppConfig, prev: MemberGrant, fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<MemberGrant> {
  if (!prev.refreshToken) throw new MemberApiError(0, "invalid_grant", "no refresh token on the grant; the member reconnects");
  const { status, json } = await tokenPost(cfg, fetchImpl, "/oauth/token", { grant_type: "refresh_token", refresh_token: prev.refreshToken });
  if (status !== 200 || !json.access_token) throw refused(status, json, "refresh");
  return grantOf(json, nowMs, prev);
}

/** Revoke a token (the venue answers 200 whether it knew the token or not). Errors are swallowed: the store entry goes either way. */
export async function revokeGrant(cfg: MemberAppConfig, grant: MemberGrant, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const token of [grant.refreshToken, grant.accessToken]) {
    if (!token) continue;
    try {
      await tokenPost(cfg, fetchImpl, "/oauth/revoke", { token });
    } catch {
      // the venue unreachable: the entry is dropped here regardless; the grant expires unused in 14 days
    }
  }
}

// ---------------------------------------------------------------------------
// the token store
// ---------------------------------------------------------------------------

/**
 * One JSON file, each member's grant sealed on its own: AES-256-GCM, a fresh 12-byte nonce per
 * write, the member's key as additional data so an entry cannot be moved under another member.
 * Written whole through a rename so a crash never leaves half a file. Keyed by the holder alias
 * the lock key names (lockGate.ts); the shared key's member is "shared".
 */
interface SealedEntry {
  v: 1;
  nonce: string;
  tag: string;
  data: string;
}
interface StoreFile {
  v: 1;
  members: Record<string, SealedEntry>;
}

export const memberKeyOf = (holder: string | null): string => holder ?? "shared";

export class MemberTokenStore {
  private cache: Map<string, MemberGrant> | null = null;

  constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("member token store: the key must be 32 bytes");
  }

  private seal(member: string, grant: MemberGrant): SealedEntry {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(Buffer.from(member, "utf8"));
    const data = Buffer.concat([c.update(JSON.stringify(grant), "utf8"), c.final()]);
    return { v: 1, nonce: nonce.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private open(member: string, e: SealedEntry): MemberGrant | null {
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.nonce, "base64"));
      d.setAAD(Buffer.from(member, "utf8"));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      const text = Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8");
      return JSON.parse(text) as MemberGrant;
    } catch {
      // a wrong key or a tampered entry opens nothing: the member shows as not connected
      return null;
    }
  }

  private load(): Map<string, MemberGrant> {
    if (this.cache) return this.cache;
    const out = new Map<string, MemberGrant>();
    if (existsSync(this.path)) {
      try {
        const file = JSON.parse(readFileSync(this.path, "utf8")) as StoreFile;
        for (const [member, e] of Object.entries(file.members ?? {})) {
          const g = this.open(member, e);
          if (g) out.set(member, g);
        }
      } catch {
        // an unreadable file is an empty store; the next write replaces it
      }
    }
    this.cache = out;
    return out;
  }

  private save(): void {
    const members: Record<string, SealedEntry> = {};
    for (const [member, g] of this.load()) members[member] = this.seal(member, g);
    const file: StoreFile = { v: 1, members };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(member: string): MemberGrant | null {
    return this.load().get(member) ?? null;
  }

  set(member: string, grant: MemberGrant): void {
    this.load().set(member, grant);
    this.save();
  }

  delete(member: string): boolean {
    const had = this.load().delete(member);
    if (had) this.save();
    return had;
  }

  members(): string[] {
    return [...this.load().keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// the member's client: positions, markets, orders, fills, settlements
// ---------------------------------------------------------------------------

export interface RawMemberPosition {
  market_id: string;
  event_id?: string | null;
  position: string;
  average_open_premium?: string | null;
  premium?: string | null;
  open_risk?: string | null;
  max_potential_profit?: string | null;
}

export interface RawMemberOrder {
  id: string;
  status: string;
  action?: string;
  market_id?: string;
  order_type?: string;
  price?: string | null;
  quantity?: string;
  filled?: string | null;
  avg_price?: string | null;
  client_order_id?: string | null;
  rejection_reason?: string | null;
  cancellation_reason?: string | null;
}

export interface RawMemberFill {
  trade_id?: string;
  order_id?: string;
  action?: string;
  price?: string;
  filled?: string;
  trade_fee?: string | null;
  time?: string;
}

export interface RawMemberSettlement {
  id?: string;
  market_id?: string;
  type?: string;
  opening_price?: string;
  closing_price?: string | null;
  quantity?: string;
  fee?: string;
  gross_pnl?: string;
  realized_pnl?: string;
  time?: string;
}

export interface RawMemberMe {
  user_id?: string | null;
  account_id?: string | null;
  handle?: string | null;
  /** a path relative to the venue's host, `/avatars/{handle}.svg`; null without a handle */
  avatar_url?: string | null;
}

export interface RawMemberBalance {
  account_balance?: string | number | null;
  available_balance?: string | number | null;
}

export interface MemberBalance {
  accountCents: number | null;
  availableCents: number | null;
  atIso: string;
}

export interface PlaceOrderBody {
  action: "buy" | "sell";
  market_id: string;
  order_type: "limit";
  /** dollars, two decimals, strictly under the market's max_price */
  price: string;
  /** whole contracts */
  quantity: string;
  client_order_id: string;
}

/** The live statuses: the order is still working. Anything else is terminal. */
export const LIVE_ORDER_STATUSES = new Set(["created", "requested", "accepted", "delayed", "open"]);

export interface MemberClientConfig {
  host: string;
  /** a bearer for the member, fresh (the session refreshes it); null when the member is not connected */
  token: () => Promise<string>;
  /** the venue refused the bearer (401): the session refreshes once and the call is retried */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

/** The venue's /api/v1 for one member: every call carries their bearer and the app's User-Agent. */
export class MemberClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: MemberClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, retried = false): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": MEMBER_APP_USER_AGENT, authorization: `Bearer ${await this.cfg.token()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await this.fetchImpl(`${this.cfg.host}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (r.status === 401 && !retried && this.cfg.onUnauthorized && (await this.cfg.onUnauthorized())) {
      return this.call<T>(method, path, body, true);
    }
    if (!r.ok) {
      const b = (json ?? {}) as { error?: string; scope?: string; terms_url?: string };
      const code =
        r.status === 401 ? "unauthorized" : r.status === 403 && b.scope ? "insufficient_scope" : r.status === 403 && b.terms_url ? "terms_required" : r.status === 403 && /ip/i.test(b.error ?? "") ? "ip_not_allowed" : r.status === 403 ? "forbidden" : r.status === 404 ? "not_found" : r.status === 422 ? "refused" : r.status === 429 ? "rate_limit_exceeded" : `http_${r.status}`;
      throw new MemberApiError(r.status, code, b.error ?? `member api ${r.status} on ${path}`, undefined, b.scope, b.terms_url);
    }
    return json as T;
  }

  /** whose account the bearer is: the venue's ids, the public handle and avatar path (profile.read). The venue wraps it in `me`. */
  async me(): Promise<RawMemberMe> {
    const r = await this.call<{ me?: RawMemberMe } | RawMemberMe>("GET", "/api/v1/me");
    return ((r as { me?: RawMemberMe }).me ?? (r as RawMemberMe)) || {};
  }

  /** the account's balance (balance.read): what the sale lands in; cents of a dollar */
  async balance(): Promise<MemberBalance> {
    const r = await this.call<{ balance?: RawMemberBalance } | RawMemberBalance>("GET", "/api/v1/account/balance");
    const b = ((r as { balance?: RawMemberBalance }).balance ?? (r as RawMemberBalance)) || {};
    const cents = (v: string | number | null | undefined): number | null => {
      const n = Number(v);
      return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : Math.round(n * 100);
    };
    return { accountCents: cents(b.account_balance), availableCents: cents(b.available_balance), atIso: new Date().toISOString() };
  }

  /**
   * A competition's open and pre-open markets, every page (a member token reads the same
   * catalogue an app token does): how the hosted page lists the games a member could protect.
   */
  async listCompetitionMarkets(competition: string, maxPages = 8): Promise<RawOutcomeMarket[]> {
    const out: RawOutcomeMarket[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r: { cursor?: string | null; markets?: RawOutcomeMarket[] | null } = await this.call("GET", `/api/v1/markets?competitions=${encodeURIComponent(competition.toUpperCase())}&status=open,pre_open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...(r.markets ?? []).filter((m) => m && typeof m.market_id === "string"));
      cursor = r.cursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  async positions(): Promise<RawMemberPosition[]> {
    const r = await this.call<{ positions?: RawMemberPosition[] }>("GET", "/api/v1/positions");
    return (r.positions ?? []).filter((p) => p && typeof p.market_id === "string" && typeof p.position === "string");
  }

  /** the named markets, fresh, with their books (a member token reads the same catalogue the app token does) */
  async markets(marketIds: string[]): Promise<RawOutcomeMarket[]> {
    if (marketIds.length === 0) return [];
    const r = await this.call<{ markets?: RawOutcomeMarket[] }>("GET", `/api/v1/markets?market_ids=${encodeURIComponent(marketIds.join(","))}`);
    return (r.markets ?? []).filter((m) => m && typeof m.market_id === "string");
  }

  async placeOrder(body: PlaceOrderBody): Promise<RawMemberOrder> {
    const r = await this.call<{ order?: RawMemberOrder } | RawMemberOrder>("POST", "/api/v1/orders", body);
    const o = (r as { order?: RawMemberOrder }).order ?? (r as RawMemberOrder);
    if (!o || typeof o.id !== "string") throw new MemberApiError(0, "order_shape", "the venue answered the order without an id");
    return o;
  }

  async order(orderId: string): Promise<RawMemberOrder> {
    const r = await this.call<{ order?: RawMemberOrder } | RawMemberOrder>("GET", `/api/v1/orders/${encodeURIComponent(orderId)}`);
    return (r as { order?: RawMemberOrder }).order ?? (r as RawMemberOrder);
  }

  /** an order by the client id we sent, when a placement's answer was lost (never place it twice) */
  async orderByClientId(clientOrderId: string): Promise<RawMemberOrder | null> {
    const r = await this.call<{ orders?: RawMemberOrder[] }>("GET", `/api/v1/orders?client_order_ids=${encodeURIComponent(clientOrderId)}`);
    return (r.orders ?? [])[0] ?? null;
  }

  /** the order's status after the cancel, or the venue's reason it was not (an order can still fill while the cancel is in flight) */
  async cancelOrder(orderId: string): Promise<{ order_id?: string; status?: string }> {
    return this.call("DELETE", `/api/v1/orders/${encodeURIComponent(orderId)}`);
  }

  async fills(orderIds: string[]): Promise<RawMemberFill[]> {
    if (orderIds.length === 0) return [];
    const r = await this.call<{ fills?: RawMemberFill[] }>("GET", `/api/v1/fills?order_ids=${encodeURIComponent(orderIds.join(","))}`);
    return r.fills ?? [];
  }

  async settlements(marketIds: string[]): Promise<RawMemberSettlement[]> {
    if (marketIds.length === 0) return [];
    const r = await this.call<{ settlements?: RawMemberSettlement[] }>("GET", `/api/v1/portfolio/settlements?market_ids=${encodeURIComponent(marketIds.join(","))}`);
    return r.settlements ?? [];
  }
}

// ---------------------------------------------------------------------------
// the member session: a grant kept fresh, one client per member
// ---------------------------------------------------------------------------

/** how much of the access token's hour is left unused before it is rotated */
const TOKEN_SLACK_MS = 90_000;

export type MemberState =
  | { connected: false; reason: "not_connected" | "grant_revoked" | "account_pending" | "refresh_failed"; detail?: string }
  | { connected: true; since: string; scope: string; userId: string | null; accountId: string | null; handle: string | null; avatarUrl: string | null; expiresAtIso: string };

/**
 * The service's hold on every connected member: the store, the pending connects (state ->
 * verifier, ten minutes), the refresh (one in flight per member), and a client per member that
 * always carries a fresh bearer. `sessions.client(member)` is what the routes call.
 */
export class MemberSessions {
  readonly store: MemberTokenStore;
  private readonly pending = new Map<string, { member: string; verifier: string; atMs: number }>();
  private readonly refreshing = new Map<string, Promise<MemberGrant>>();
  private readonly lastFailure = new Map<string, { reason: "grant_revoked" | "account_pending" | "refresh_failed"; detail: string }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    readonly cfg: MemberAppConfig,
    opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.store = new MemberTokenStore(cfg.storePath, cfg.key);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Step 1 and 2: a state and verifier for this member, and the URL their browser opens. */
  beginConnect(member: string): { state: string; url: string } {
    const nowMs = this.now();
    for (const [s, p] of this.pending) if (nowMs - p.atMs > 10 * 60_000) this.pending.delete(s);
    const state = b64url(randomBytes(24));
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { member, verifier, atMs: nowMs });
    return { state, url: authorizeUrl(this.cfg, { state, challenge }) };
  }

  /** Step 3 and 4: the venue sent the browser back. Returns the member connected, or why not. */
  async finishConnect(q: { code?: string | null; state?: string | null; error?: string | null; error_description?: string | null }): Promise<{ ok: true; member: string } | { ok: false; code: string; message: string; member?: string }> {
    const state = (q.state ?? "").trim();
    const p = state ? this.pending.get(state) : undefined;
    if (!p) return { ok: false, code: "bad_state", message: "This connect link is not one the service issued, or it expired. Start again from the extension." };
    this.pending.delete(state);
    if (q.error) return { ok: false, code: q.error, message: q.error === "access_denied" ? "You did not allow the connection. Nothing was connected." : `The venue refused the connection (${q.error}${q.error_description ? `: ${q.error_description}` : ""}).`, member: p.member };
    const code = (q.code ?? "").trim();
    if (!code) return { ok: false, code: "no_code", message: "The venue sent no code back.", member: p.member };
    let grant: MemberGrant;
    try {
      grant = await exchangeCode(this.cfg, code, p.verifier, this.fetchImpl, this.now());
    } catch (err) {
      const e = err instanceof MemberApiError ? err : new MemberApiError(0, "exchange_failed", String(err instanceof Error ? err.message : err));
      if (e.reason === "account_pending") return { ok: false, code: "account_pending", message: "Your account on the venue is still being verified. Connect again once it is.", member: p.member };
      return { ok: false, code: e.code, message: `The venue would not exchange the code (${e.code}). Start again from the extension.`, member: p.member };
    }
    // whose account, by id: best effort, the grant stands without it
    try {
      const me = await new MemberClient({ host: this.cfg.host, token: async () => grant.accessToken, fetchImpl: this.fetchImpl }).me();
      grant = { ...grant, userId: me.user_id ?? null, accountId: me.account_id ?? null, handle: me.handle ?? null, avatarUrl: me.avatar_url ?? null };
    } catch {
      // profile.read not granted, or the venue busy: the ids stay null
    }
    this.store.set(p.member, grant);
    this.lastFailure.delete(p.member);
    return { ok: true, member: p.member };
  }

  /** Disconnect: the tokens revoked at the venue (best effort) and the entry dropped. */
  async disconnect(member: string): Promise<boolean> {
    const g = this.store.get(member);
    if (g) await revokeGrant(this.cfg, g, this.fetchImpl);
    this.lastFailure.delete(member);
    return this.store.delete(member);
  }

  state(member: string): MemberState {
    const g = this.store.get(member);
    if (!g) {
      const f = this.lastFailure.get(member);
      return f ? { connected: false, reason: f.reason, detail: f.detail } : { connected: false, reason: "not_connected" };
    }
    return { connected: true, since: g.connectedAtIso, scope: g.scope, userId: g.userId ?? null, accountId: g.accountId ?? null, handle: g.handle ?? null, avatarUrl: g.avatarUrl ? (g.avatarUrl.startsWith("http") ? g.avatarUrl : `${this.cfg.host}${g.avatarUrl}`) : null, expiresAtIso: new Date(g.expiresAtMs).toISOString() };
  }

  /** The profile re-read once (a handle set after the connect): the grant keeps what the venue says now. */
  async refreshProfile(member: string): Promise<void> {
    const g = this.store.get(member);
    if (!g) return;
    const me = await this.client(member).me();
    this.store.set(member, { ...(this.store.get(member) ?? g), userId: me.user_id ?? g.userId ?? null, accountId: me.account_id ?? g.accountId ?? null, handle: me.handle ?? null, avatarUrl: me.avatar_url ?? null });
  }

  /** A fresh bearer: the stored one while it has slack, else rotated once (one refresh in flight per member). */
  private async bearer(member: string, force = false): Promise<string> {
    const g = this.store.get(member);
    if (!g) throw new MemberApiError(0, "not_connected", "the member has not connected their account");
    if (!force && this.now() < g.expiresAtMs - TOKEN_SLACK_MS) return g.accessToken;
    let p = this.refreshing.get(member);
    if (!p) {
      p = refreshGrant(this.cfg, g, this.fetchImpl, this.now())
        .then((next) => {
          this.store.set(member, next);
          return next;
        })
        .catch((err: unknown) => {
          const e = err instanceof MemberApiError ? err : new MemberApiError(0, "refresh_failed", String(err instanceof Error ? err.message : err));
          if (e.terminal) {
            // the grant is gone (revoked, rotated elsewhere, expired unused): the member reconnects; no token stays behind
            this.store.delete(member);
            this.lastFailure.set(member, { reason: "grant_revoked", detail: e.message });
          } else if (e.reason === "account_pending") {
            this.lastFailure.set(member, { reason: "account_pending", detail: e.message });
          } else {
            this.lastFailure.set(member, { reason: "refresh_failed", detail: e.message });
          }
          throw e;
        })
        .finally(() => this.refreshing.delete(member));
      this.refreshing.set(member, p);
    }
    return (await p).accessToken;
  }

  client(member: string): MemberClient {
    return new MemberClient({
      host: this.cfg.host,
      token: () => this.bearer(member),
      onUnauthorized: async () => {
        try {
          await this.bearer(member, true);
          return true;
        } catch {
          return false;
        }
      },
      fetchImpl: this.fetchImpl,
    });
  }

  /** the operator's view: who is connected (aliases and venue ids), never a token */
  summary(): Array<{ member: string; since: string; scope: string; userId: string | null; accountId: string | null; accessTokenExpiresAtIso: string }> {
    return this.store.members().map((member) => {
      const g = this.store.get(member) as MemberGrant;
      return { member, since: g.connectedAtIso, scope: g.scope, userId: g.userId ?? null, accountId: g.accountId ?? null, accessTokenExpiresAtIso: new Date(g.expiresAtMs).toISOString() };
    });
  }
}

// ---------------------------------------------------------------------------
// the member's positions on our markets
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** full-game two-way winner markets only */
const WINNER_RULES: Record<string, "home" | "away"> = { home_winner: "home", away_winner: "away" };

/** the league our templates know for the venue's competition code (the configured map first, then the code as the league) */
export function leagueOfCompetition(competition: string | null | undefined, codes: OutcomeCompetitionCodes): string | null {
  const c = (competition ?? "").trim().toUpperCase();
  if (!c) return null;
  for (const [league, code] of Object.entries(codes)) if (code.toUpperCase() === c) return league;
  return templateForLeague(c) ? c.toLowerCase() : null;
}

/** the club the market pays on, by the participant whose role the rule names */
export function winnerClubOf(m: RawOutcomeMarket): { side: "home" | "away"; name: string; opponent: string } | null {
  const side = WINNER_RULES[(m.rules ?? "").toLowerCase()];
  if (!side) return null;
  let ours: string | null = null;
  let other: string | null = null;
  for (const p of m.participants ?? []) {
    const role = (p?.role ?? "").toLowerCase();
    const name = (p?.name ?? p?.short_name ?? "").trim();
    if (!name) continue;
    if (role === side) ours = name;
    else if (role === "home" || role === "away") other = name;
  }
  return ours ? { side, name: ours, opponent: other ?? "" } : null;
}

/**
 * A combination market (the venue's parlay: one market over two to five legs, agreed by request
 * for quote and traded on its own thin book afterwards). The venue marks it by its legs; the rule
 * word is read too in case a listing carries no legs.
 */
export function isComboMarket(m: RawOutcomeMarket & { legs?: unknown; combo?: unknown }): boolean {
  if (Array.isArray(m.legs) && m.legs.length >= 2) return true;
  if (m.combo && typeof m.combo === "object") return true;
  return /combo|combination|parlay|multi/i.test(`${m.rules ?? ""} ${m.specifier ?? ""}`);
}

/** The protectable market this venue market maps to: same league, our side's club, the game within a day and a half. */
export function matchMemberMarket(m: RawOutcomeMarket, league: string | null, protectable: ProtectableMarket[]): { ticker: string } | { ticker: null; reason: string } {
  if (isComboMarket(m)) return { ticker: null, reason: "parlay" };
  const template: LeagueTemplate | null = league ? templateForLeague(league) : null;
  if (!template) return { ticker: null, reason: "league_not_covered" };
  const club = winnerClubOf(m);
  if (!club) return { ticker: null, reason: "market_not_covered" };
  const startMs = m.event_start ? Date.parse(m.event_start) : NaN;
  const hits = protectable.filter((p) => {
    if (p.league !== template.league) return false;
    const code = p.ticker.slice(p.ticker.lastIndexOf("-") + 1);
    const full = template.teamNames[code];
    if (!full || !clubMatches(template, full, club.name)) return false;
    if (!p.dateIso || !Number.isFinite(startMs)) return true;
    return Math.abs(Date.parse(`${p.dateIso}T12:00:00-04:00`) - startMs) <= 1.5 * DAY_MS;
  });
  if (hits.length === 0) return { ticker: null, reason: "no_protectable_market" };
  if (hits.length === 1) return { ticker: hits[0].ticker };
  const best = hits.map((p) => ({ p, d: p.dateIso && Number.isFinite(startMs) ? Math.abs(Date.parse(`${p.dateIso}T12:00:00-04:00`) - startMs) : Number.MAX_SAFE_INTEGER })).sort((a, b) => a.d - b.d)[0];
  return { ticker: best.p.ticker };
}

/** A member position with the venue market it is on, as the sale route needs it. */
export interface MemberHolderPosition extends HolderPosition {
  marketId: string;
  /** the venue's market as read with the positions: its book is what the sale is priced from */
  market: RawOutcomeMarket | null;
  /** the venue's max_price for the market, dollars (usually 1) */
  maxPrice: number;
}

/**
 * The member's long positions on our markets. Each venue market pays max_price (usually $1) a
 * contract, like ours; the entry is the average open premium as cents of that. Shorts and closed
 * positions are left out: a lock sells part of a long.
 */
export async function memberHolderPositions(client: MemberClient, protectable: ProtectableMarket[], codes: OutcomeCompetitionCodes): Promise<MemberHolderPosition[]> {
  const raw = (await client.positions()).filter((p) => Number(p.position) > 0);
  const ids = [...new Set(raw.map((p) => p.market_id))];
  let markets = new Map<string, RawOutcomeMarket>();
  let lookupFailed = false;
  try {
    markets = new Map((await client.markets(ids)).map((m) => [m.market_id, m]));
  } catch {
    lookupFailed = true;
  }
  const out: MemberHolderPosition[] = [];
  for (const p of raw) {
    const m = markets.get(p.market_id) ?? null;
    const maxPrice = m ? outcomeMaxPrice(m) : 1;
    const qty = Number(p.position);
    // our contract pays $1; the venue's pays max_price, so a $2 contract is two of ours
    const contracts = roundContracts(qty * maxPrice);
    if (!(contracts >= 1)) continue;
    const premium = Number(p.average_open_premium);
    const entryMilli = Number.isFinite(premium) && premium > 0 ? outcomePriceMilli(premium, maxPrice, false) : -1;
    const entryCents = entryMilli > 0 ? Math.min(99, Math.max(1, Math.round(entryMilli / 10))) : 50;
    const costCents = Number.isFinite(premium) ? Math.round(premium * qty * 100) : Math.round(contracts * entryCents);
    const base = { id: positionId(p.market_id, "long"), marketId: p.market_id, market: m, maxPrice, contracts, entryCents, payoutCents: Math.round(contracts * 100), costCents };
    if (!m) {
      out.push({ ...base, ticker: null, reason: lookupFailed ? "market_lookup_failed" : "market_unknown", league: null, side: "", event: "", startsIso: null, marketType: "" });
      continue;
    }
    const league = leagueOfCompetition(m.competition, codes);
    const club = winnerClubOf(m);
    const matched = matchMemberMarket(m, league, protectable);
    const event = (m.event_title ?? "").trim() || (club ? [club.side === "away" ? club.name : club.opponent, club.side === "home" ? club.name : club.opponent].filter(Boolean).join(" at ") : "");
    out.push({
      ...base,
      ticker: matched.ticker,
      ...(matched.ticker === null ? { reason: matched.reason } : {}),
      league,
      side: club?.name ?? (m.group_title ?? "").trim(),
      event: event || (matched.ticker === null && matched.reason === "parlay" ? (m.symbol ?? "").trim() : ""),
      startsIso: m.event_start ? new Date(m.event_start).toISOString() : null,
      marketType: (m.rules ?? "").trim(),
    });
  }
  return out;
}

/** an id of ours on the venue's order, so a placement whose answer was lost can be found and never sent twice */
export const clientOrderIdFor = (kind: "lock" | "leave", ticker: string): string => `atticus-${kind}-${ticker.toLowerCase().slice(-24)}-${randomUUID().slice(0, 8)}`;
