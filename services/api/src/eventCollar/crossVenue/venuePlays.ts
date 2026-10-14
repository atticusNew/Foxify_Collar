/**
 * VENUE PLAYS: the holder's open, matched plays on an exchange that speaks the partner "market
 * maker" API (session login with an access key and secret key, bearer token after that), matched
 * to the markets the engine can protect. Same output as venuePositions.ts (HolderPosition rows),
 * so the worker route and the client do not care which venue the holder is on.
 *
 * Credentials: VENUE_API_ACCESS_KEY + VENUE_API_SECRET_KEY, service env only, never in the client.
 * The venue issues these from its website (Settings, Token). They are account keys, not scoped
 * read keys: the same pair could place an order. This module only ever calls login, refresh and
 * four GET routes; nothing here submits or cancels. Keep the pair in the service env, use a
 * dedicated pair, revoke it when the recording is done.
 *
 * VENUE_API_HOST selects the environment, with the partner path included
 * (production https://cash.api.<venue>/partner, sandbox https://api.sandbox.<venue>/partner).
 *
 * Shape of the venue's objects (from its published OpenAPI):
 *   POST /auth/login {access_key, secret_key} -> data {access_token, access_expire_time, refresh_token, refresh_expire_time}
 *   POST /auth/refresh {refresh_token} -> same data
 *   GET  /v2/mm/get_wager_histories?status=open&limit=1000 -> data {wagers:[{wager_id, market_id, sport_event_id,
 *          outcome_id, line_id, line, odds, stake, matched_stake, unmatched_stake, profit, status, matching_status, winning_status}]}
 *   GET  /mm/get_tournaments -> data {tournaments:[{id, name}]}
 *   GET  /mm/get_sport_events?tournament_id= -> data {sport_events:[{event_id, name, display_name, scheduled, status,
 *          tournament_id, tournament_name, sport_name, competitors:[{id, name, display_name, abbreviation, side}]}]}
 *   GET  /v4/mm/get_markets?event_id= -> data {markets:[{id, name, type, status, selections:[[{outcome_id, competitor_id,
 *          name, display_name, display_price, price, strike_id}]]}]}
 *
 * Odds are American on this venue (+150, -300). stake 20 at -300 wins 6.67: payout 26.67, which in
 * our dollars-per-contract terms is 27 contracts at an entry of 75 cents. A decimal odds figure
 * (1.33) is accepted too, since American odds never fall between -99 and 99. Unmatched stake is a
 * resting order, not a position: a play is sized on its matched stake only, and a fully unmatched
 * play is left out. Nothing here names the venue in anything the record publishes.
 */

import { matchPosition, positionId, templateForLeague, type HolderPosition, type ProtectableMarket, type RawVenueEvent, type RawVenueMarket } from "./venuePositions";

export interface PlaysClientConfig {
  host: string;
  accessKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
  /** tournaments, events and markets are cached this long; the catalog barely moves pre-game */
  catalogTtlMs?: number;
  now?: () => number;
}

export function playsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; accessKey: string; secretKey: string } | null {
  const host = env.VENUE_API_HOST?.trim().replace(/\/+$/, "");
  const accessKey = env.VENUE_API_ACCESS_KEY?.trim();
  const secretKey = env.VENUE_API_SECRET_KEY?.trim();
  if (!host || !accessKey || !secretKey) return null;
  return { host, accessKey, secretKey };
}

export interface RawPlay {
  wager_id: string;
  market_id: number | string;
  sport_event_id: number | string;
  outcome_id: number | string;
  line_id?: string;
  line?: number;
  odds: number;
  stake: number;
  matched_stake?: number;
  unmatched_stake?: number;
  profit?: number;
  status: string;
  matching_status?: string;
  winning_status?: string;
}

export interface RawTournament {
  id: number | string;
  name: string;
}

export interface RawSportEvent {
  event_id: number | string;
  name?: string;
  display_name?: string;
  scheduled?: string;
  status?: string;
  tournament_id?: number | string;
  tournament_name?: string;
  sport_name?: string;
  competitors?: Array<{ id?: number | string; name?: string; display_name?: string; abbreviation?: string; side?: string }>;
}

export interface RawSelection {
  outcome_id: number | string;
  competitor_id?: number | string | null;
  name?: string;
  display_name?: string;
  display_price?: string;
  price?: number;
  strike_id?: string;
}

export interface RawMarket {
  id: number | string;
  name?: string;
  type: string;
  status?: string;
  selections?: RawSelection[][] | RawSelection[];
}

export class PlaysApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Session {
  accessToken: string;
  refreshToken: string;
  /** unix millis */
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/** the venue's expiry fields are unix seconds; accept millis too */
const expiryMs = (v: unknown, fallbackMs: number, now: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return now + fallbackMs;
  return n > 1e12 ? n : n * 1000;
};

export class PlaysClient {
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly now: () => number;
  private session: Session | null = null;
  private tournaments: { at: number; v: RawTournament[] } | null = null;
  private readonly eventsByTournament = new Map<string, { at: number; v: RawSportEvent[] }>();
  private readonly marketsByEvent = new Map<string, { at: number; v: RawMarket[] }>();

  constructor(private readonly cfg: PlaysClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.ttl = cfg.catalogTtlMs ?? 10 * 60_000;
    this.now = cfg.now ?? Date.now;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) headers.authorization = `Bearer ${await this.token()}`;
    const r = await this.fetchImpl(`${this.cfg.host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const b = (json ?? {}) as { error?: unknown; message?: string };
      const code = typeof b.error === "string" ? b.error : `http_${r.status}`;
      throw new PlaysApiError(r.status, code, b.message ?? `venue api ${r.status} on ${path}`);
    }
    return json as T;
  }

  private sessionFrom(data: Record<string, unknown> | undefined): Session {
    const now = this.now();
    if (!data || typeof data.access_token !== "string" || !data.access_token) throw new PlaysApiError(0, "login_shape", "login answered without an access token");
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "",
      accessExpiresAt: expiryMs(data.access_expire_time, 10 * 60_000, now),
      refreshExpiresAt: expiryMs(data.refresh_expire_time, 3 * 86_400_000, now),
    };
  }

  /** a live access token: the cached one, refreshed when within a minute of expiry, re-login when the refresh is gone too */
  private async token(): Promise<string> {
    const now = this.now();
    const s = this.session;
    if (s && s.accessExpiresAt - now > 60_000) return s.accessToken;
    if (s && s.refreshToken && s.refreshExpiresAt - now > 60_000) {
      try {
        const r = await this.call<{ data?: Record<string, unknown> }>("POST", "/auth/refresh", { refresh_token: s.refreshToken }, false);
        this.session = this.sessionFrom(r.data);
        return this.session.accessToken;
      } catch {
        this.session = null;
      }
    }
    const r = await this.call<{ data?: Record<string, unknown> }>("POST", "/auth/login", { access_key: this.cfg.accessKey, secret_key: this.cfg.secretKey }, false);
    this.session = this.sessionFrom(r.data);
    return this.session.accessToken;
  }

  /** Open plays. Every page; the venue caps a page at 1000. */
  async listOpenPlays(): Promise<RawPlay[]> {
    const out: RawPlay[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ status: "open", limit: "1000" });
      if (cursor) q.set("next_cursor", cursor);
      const r = await this.call<{ data?: { wagers?: unknown[]; next_cursor?: string } }>("GET", `/v2/mm/get_wager_histories?${q.toString()}`);
      const wagers = (r.data?.wagers ?? []).filter(isPlay);
      out.push(...wagers);
      cursor = r.data?.next_cursor || undefined;
      if (!cursor || wagers.length === 0) break;
    }
    return out;
  }

  async listTournaments(): Promise<RawTournament[]> {
    if (this.tournaments && this.now() - this.tournaments.at < this.ttl) return this.tournaments.v;
    const r = await this.call<{ data?: { tournaments?: RawTournament[] } }>("GET", "/mm/get_tournaments");
    const v = (r.data?.tournaments ?? []).filter((t) => t && t.id !== undefined && typeof t.name === "string");
    this.tournaments = { at: this.now(), v };
    return v;
  }

  async listEvents(tournamentId: string): Promise<RawSportEvent[]> {
    const hit = this.eventsByTournament.get(tournamentId);
    if (hit && this.now() - hit.at < this.ttl) return hit.v;
    const r = await this.call<{ data?: { sport_events?: RawSportEvent[] } }>("GET", `/mm/get_sport_events?tournament_id=${encodeURIComponent(tournamentId)}`);
    const v = (r.data?.sport_events ?? []).filter((e) => e && e.event_id !== undefined);
    this.eventsByTournament.set(tournamentId, { at: this.now(), v });
    return v;
  }

  async listMarkets(eventId: string): Promise<RawMarket[]> {
    const hit = this.marketsByEvent.get(eventId);
    if (hit && this.now() - hit.at < this.ttl) return hit.v;
    const r = await this.call<{ data?: { markets?: RawMarket[] } }>("GET", `/v4/mm/get_markets?event_id=${encodeURIComponent(eventId)}`);
    const v = (r.data?.markets ?? []).filter((m) => m && m.id !== undefined && typeof m.type === "string");
    this.marketsByEvent.set(eventId, { at: this.now(), v });
    return v;
  }

  /**
   * The event for an id, found through the tournaments whose league the engine covers (the API
   * lists events per tournament; there is no single-event read). Null when no covered tournament
   * has it, which the caller reports as league_not_covered.
   */
  async findEvent(eventId: string): Promise<RawSportEvent | null> {
    const tournaments = await this.listTournaments();
    const covered = tournaments.filter((t) => templateForLeague(t.name));
    for (const t of covered) {
      const events = await this.listEvents(String(t.id));
      const hit = events.find((e) => String(e.event_id) === eventId);
      if (hit) return { ...hit, tournament_name: hit.tournament_name ?? t.name };
    }
    return null;
  }
}

function isPlay(p: unknown): p is RawPlay {
  const x = p as Partial<RawPlay>;
  return Boolean(x && x.market_id !== undefined && x.sport_event_id !== undefined && x.outcome_id !== undefined && typeof x.odds === "number" && typeof x.stake === "number");
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

/**
 * payout per $1 staked at the venue's odds: American outside -99..99; a decimal figure between 1
 * and 20 (up to +1900) is accepted too. 20..99 is neither, so it is refused rather than guessed.
 */
export function payoutMultiple(odds: number): number | null {
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds >= 100) return 1 + odds / 100;
  if (odds <= -100) return 1 + 100 / -odds;
  if (odds > 1 && odds < 20) return odds;
  return null;
}

/** The matched part of a play in our dollars-per-contract terms. Null for an unmatched play or an unreadable one. */
export function playSize(play: Pick<RawPlay, "stake" | "matched_stake" | "odds" | "matching_status">): { contracts: number; entryCents: number; payoutCents: number; costCents: number } | null {
  const matched = play.matching_status === "unmatched" ? 0 : typeof play.matched_stake === "number" ? play.matched_stake : play.matching_status === undefined ? play.stake : 0;
  const k = payoutMultiple(play.odds);
  if (!k || !Number.isFinite(matched) || matched <= 0) return null;
  const payout = matched * k;
  // under a dollar of payout is not a contract's worth; refuse rather than round half a dollar up to one
  if (payout < 1) return null;
  const contracts = Math.round(payout);
  return {
    contracts,
    entryCents: Math.min(99, Math.max(1, Math.round((100 * matched) / payout))),
    payoutCents: Math.round(payout * 100),
    costCents: Math.round(matched * 100),
  };
}

// ---------------------------------------------------------------------------
// to the shared shapes, then the shared matcher
// ---------------------------------------------------------------------------

const selectionsOf = (m: RawMarket): RawSelection[] => {
  const s = m.selections ?? [];
  return (s as unknown[]).flat(2).filter((x): x is RawSelection => Boolean(x && typeof x === "object" && (x as RawSelection).outcome_id !== undefined));
};

export function asVenueMarket(m: RawMarket, event: RawSportEvent | null): RawVenueMarket {
  const startsTs = event?.scheduled ? Date.parse(event.scheduled) || 0 : 0;
  return {
    marketId: String(m.id),
    eventId: event ? String(event.event_id) : "",
    description: m.name ?? m.type,
    marketType: m.type,
    status: m.status ?? "",
    startsTs,
    outcomes: selectionsOf(m).map((s) => ({ outcomeId: String(s.outcome_id), name: s.display_name || s.name || "", status: "" })),
  };
}

export function asVenueEvent(e: RawSportEvent): RawVenueEvent {
  return {
    eventId: String(e.event_id),
    description: e.display_name || e.name || "",
    sport: e.sport_name ?? "",
    league: e.tournament_name ?? "",
    status: e.status ?? "",
    startsTs: e.scheduled ? Date.parse(e.scheduled) || 0 : 0,
  };
}

/** Read, size and match every open matched play. Lookups that fail leave the row with a reason, never drop it. */
export async function holderPlays(client: PlaysClient, protectable: ProtectableMarket[]): Promise<HolderPosition[]> {
  const plays = await client.listOpenPlays();
  const out: HolderPosition[] = [];
  for (const p of plays) {
    const size = playSize(p);
    if (!size) continue;
    const eventId = String(p.sport_event_id);
    const marketId = String(p.market_id);
    const outcomeId = String(p.outcome_id);
    const base = { id: positionId(marketId, outcomeId), ...size };
    let event: RawSportEvent | null = null;
    let market: RawMarket | null = null;
    try {
      event = await client.findEvent(eventId);
      // no covered tournament has the event: nothing to match, so no markets read either
      if (event) {
        const markets = await client.listMarkets(eventId);
        market = markets.find((m) => String(m.id) === marketId) ?? null;
      }
    } catch {
      market = null;
    }
    if (!market) {
      out.push({ ...base, ticker: null, reason: event ? "market_lookup_failed" : "league_not_covered", league: null, side: "", event: event ? asVenueEvent(event).description : "", startsIso: null, marketType: "" });
      continue;
    }
    const vm = asVenueMarket(market, event);
    const ve = event ? asVenueEvent(event) : null;
    const outcome = vm.outcomes.find((o) => o.outcomeId === outcomeId);
    const matched = matchPosition(vm, ve, outcomeId, protectable);
    out.push({
      ...base,
      ticker: matched.ticker,
      ...(matched.ticker ? {} : { reason: matched.reason }),
      league: ve?.league ? ve.league.toLowerCase() : null,
      side: outcome?.name ?? "",
      event: ve?.description || vm.description,
      startsIso: vm.startsTs ? new Date(vm.startsTs).toISOString() : null,
      marketType: vm.marketType,
    });
  }
  return out;
}
