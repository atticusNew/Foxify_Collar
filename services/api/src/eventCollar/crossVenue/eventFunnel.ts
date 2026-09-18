/**
 * Event demo funnel: who LOOKED, who TAPPED, who PROTECTED.
 *
 * The event demo has no wallets, so the perp funnel's "distinct addresses"
 * axis does not exist here. Instead the page carries an anonymous random
 * session id (per tab, never persisted beyond it, no cookie, no IP, no
 * fingerprint) so we can tell "one visitor tapped Protect five times" from
 * "five visitors tapped once". Everything financial about a protect tap
 * (league, route, credit, contracts) is filled in by the SERVER from its own
 * live scan, never trusted from the browser.
 *
 * Pure functions over a plain state object; the service owns persistence.
 * Mirrors src/singleSide/twoSided/creditCollar/epFunnel.ts in shape so the
 * operator reads both funnels the same way.
 */

export const EVENT_PAGES = ["app", "receipts"] as const;
export type EventPage = (typeof EVENT_PAGES)[number];

export const EVENT_ACTIONS = ["row_tap", "protect_on", "protect_undo", "board_expand", "tier_pick"] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

export interface SessionRow {
  firstMs: number;
  lastMs: number;
  /** board rows tapped to showcase */
  taps: number;
  /** Protect toggled on */
  protects: number;
}

/** One Protect tap, enriched server-side from the live scan. Money in integer cents. */
export interface ProtectRecord {
  atMs: number;
  sid: string;
  ticker: string;
  league: string;
  kind: "sports" | "crypto" | "unknown";
  route: string | null;
  /** which protection tier was locked; null when unattributed */
  tier: string | null;
  creditCents: number | null;
  contracts: number | null;
  markCents: number | null;
  floorCents: number | null;
  capCents: number | null;
  evCostBps: number | null;
}

export interface EventFunnelState {
  /** UTC day "YYYY-MM-DD" -> page -> loads. Pruned beyond RETENTION_DAYS. */
  pageLoads: Record<string, Record<string, number>>;
  /** UTC day -> action -> count. Pruned beyond RETENTION_DAYS. */
  actions: Record<string, Record<string, number>>;
  /** anonymous session id -> activity. Bounded by MAX_SESSIONS (oldest evicted). */
  sessions: Record<string, SessionRow>;
  /** lifetime Protect taps by league / hedge route / protection tier. */
  protectsByLeague: Record<string, number>;
  protectsByRoute: Record<string, number>;
  protectsByTier: Record<string, number>;
  /** newest-last ring of Protect taps, capped at MAX_RECENT_PROTECTS. */
  recentProtects: ProtectRecord[];
}

export const RETENTION_DAYS = 30;
export const MAX_SESSIONS = 5_000;
export const MAX_RECENT_PROTECTS = 200;
const DAY_MS = 86_400_000;

export const emptyEventFunnel = (): EventFunnelState => ({
  pageLoads: {},
  actions: {},
  sessions: {},
  protectsByLeague: {},
  protectsByRoute: {},
  protectsByTier: {},
  recentProtects: [],
});

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const SID_RE = /^[a-z0-9]{8,32}$/;
export const isValidSid = (sid: unknown): sid is string => typeof sid === "string" && SID_RE.test(sid);

const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
export const isValidTicker = (t: unknown): t is string => typeof t === "string" && TICKER_RE.test(t);

export const isEventPage = (p: unknown): p is EventPage => typeof p === "string" && (EVENT_PAGES as readonly string[]).includes(p);
export const isEventAction = (a: unknown): a is EventAction =>
  typeof a === "string" && (EVENT_ACTIONS as readonly string[]).includes(a);

function pruneDays(bucket: Record<string, unknown>, nowMs: number): void {
  const cutoff = dayKey(nowMs - RETENTION_DAYS * DAY_MS);
  for (const d of Object.keys(bucket)) if (d < cutoff) delete bucket[d];
}

export const recordPageLoad = (f: EventFunnelState, page: EventPage, nowMs: number): void => {
  const day = dayKey(nowMs);
  const bucket = (f.pageLoads[day] ??= {});
  bucket[page] = (bucket[page] ?? 0) + 1;
  pruneDays(f.pageLoads, nowMs);
};

function touchSession(f: EventFunnelState, sid: string, nowMs: number): SessionRow {
  let row = f.sessions[sid];
  if (!row) {
    if (Object.keys(f.sessions).length >= MAX_SESSIONS) {
      // Evict the least-recently-seen session; distinct-visitor counts stay bounded.
      let oldest: string | null = null;
      let oldestMs = Infinity;
      for (const [k, r] of Object.entries(f.sessions)) {
        if (r.lastMs < oldestMs) {
          oldestMs = r.lastMs;
          oldest = k;
        }
      }
      if (oldest) delete f.sessions[oldest];
    }
    row = { firstMs: nowMs, lastMs: nowMs, taps: 0, protects: 0 };
    f.sessions[sid] = row;
  }
  row.lastMs = nowMs;
  return row;
}

/** What the server knows about the tapped row, from its own live scan. */
export interface ProtectContext {
  league: string;
  kind: "sports" | "crypto";
  route: string | null;
  /** the tier whose terms these are (the one the holder locked) */
  tier: string | null;
  creditCents: number;
  contracts: number;
  markCents: number;
  floorCents: number;
  capCents: number;
  evCostBps: number;
}

/**
 * Record one browser action. Returns false when the input is rejected (bad
 * sid or ticker); nothing is written in that case. `ctx` is the server's
 * own view of the tapped row and may be null when the row has already
 * rolled off the board — the tap still counts, unattributed.
 */
export const recordAction = (
  f: EventFunnelState,
  input: { sid: unknown; action: EventAction; ticker?: unknown },
  nowMs: number,
  ctx: ProtectContext | null = null,
): boolean => {
  if (!isValidSid(input.sid)) return false;
  const ticker = input.ticker === undefined || input.ticker === null || input.ticker === "" ? null : input.ticker;
  if (ticker !== null && !isValidTicker(ticker)) return false;

  const day = dayKey(nowMs);
  const bucket = (f.actions[day] ??= {});
  bucket[input.action] = (bucket[input.action] ?? 0) + 1;
  pruneDays(f.actions, nowMs);

  const session = touchSession(f, input.sid, nowMs);
  if (input.action === "row_tap") session.taps += 1;
  if (input.action === "protect_on") {
    session.protects += 1;
    const league = ctx?.league ?? "unknown";
    const route = ctx?.route ?? null;
    f.protectsByLeague[league] = (f.protectsByLeague[league] ?? 0) + 1;
    f.protectsByRoute[route ?? "unknown"] = (f.protectsByRoute[route ?? "unknown"] ?? 0) + 1;
    const tier = ctx?.tier ?? null;
    f.protectsByTier[tier ?? "unknown"] = (f.protectsByTier[tier ?? "unknown"] ?? 0) + 1;
    f.recentProtects.push({
      atMs: nowMs,
      sid: input.sid,
      ticker: ticker ?? "",
      league,
      kind: ctx?.kind ?? "unknown",
      route,
      tier,
      creditCents: ctx ? Math.round(ctx.creditCents) : null,
      contracts: ctx ? Math.round(ctx.contracts) : null,
      markCents: ctx ? Math.round(ctx.markCents) : null,
      floorCents: ctx ? Math.round(ctx.floorCents) : null,
      capCents: ctx ? Math.round(ctx.capCents) : null,
      evCostBps: ctx ? Math.round(ctx.evCostBps) : null,
    });
    if (f.recentProtects.length > MAX_RECENT_PROTECTS) {
      f.recentProtects.splice(0, f.recentProtects.length - MAX_RECENT_PROTECTS);
    }
  }
  return true;
};

export interface EventFunnelSummary {
  /** Anonymous sessions that loaded the board and did anything (tap, protect, expand, undo). */
  sessions: {
    distinct: number;
    active24h: number;
    active7d: number;
    /** sessions with at least one Protect tap */
    protected: number;
    /** sessions that tapped a board row but never protected: the conversion gap */
    tappedNeverProtected: number;
  };
  protects: {
    total: number;
    last24h: number;
    last7d: number;
    byLeague: Record<string, number>;
    byRoute: Record<string, number>;
    byTier: Record<string, number>;
    /** sum of credits paid on recorded Protect taps, integer cents (attributed rows only) */
    creditCentsTotal: number;
    /** sum of contracts protected on recorded Protect taps (attributed rows only) */
    contractsTotal: number;
  };
  /** newest first, at most 20 */
  recentProtects: ProtectRecord[];
  /** last 7 UTC days, oldest first */
  pageLoads7d: Array<{ day: string; total: number; byPage: Record<string, number> }>;
  actions7d: Array<{ day: string; total: number; byAction: Record<string, number> }>;
}

export const eventFunnelSummary = (f: EventFunnelState, nowMs: number): EventFunnelSummary => {
  const rows = Object.values(f.sessions);
  const within = (ms: number, span: number) => nowMs - ms <= span;
  const protects = f.recentProtects;
  const attributed = protects.filter((p) => p.creditCents !== null);
  const days = <T extends Record<string, Record<string, number>>>(src: T) => {
    const out: Array<{ day: string; total: number; by: Record<string, number> }> = [];
    for (let i = 6; i >= 0; i--) {
      const day = dayKey(nowMs - i * DAY_MS);
      const by = src[day] ?? {};
      out.push({ day, total: Object.values(by).reduce((s, n) => s + n, 0), by });
    }
    return out;
  };
  const totalProtects = Object.values(f.protectsByLeague).reduce((s, n) => s + n, 0);
  return {
    sessions: {
      distinct: rows.length,
      active24h: rows.filter((r) => within(r.lastMs, DAY_MS)).length,
      active7d: rows.filter((r) => within(r.lastMs, 7 * DAY_MS)).length,
      protected: rows.filter((r) => r.protects > 0).length,
      tappedNeverProtected: rows.filter((r) => r.taps > 0 && r.protects === 0).length,
    },
    protects: {
      total: totalProtects,
      last24h: protects.filter((p) => within(p.atMs, DAY_MS)).length,
      last7d: protects.filter((p) => within(p.atMs, 7 * DAY_MS)).length,
      byLeague: { ...f.protectsByLeague },
      byRoute: { ...f.protectsByRoute },
      byTier: { ...f.protectsByTier },
      creditCentsTotal: attributed.reduce((s, p) => s + (p.creditCents as number), 0),
      contractsTotal: attributed.reduce((s, p) => s + (p.contracts as number), 0),
    },
    recentProtects: [...protects].reverse().slice(0, 20),
    pageLoads7d: days(f.pageLoads).map((d) => ({ day: d.day, total: d.total, byPage: d.by })),
    actions7d: days(f.actions).map((d) => ({ day: d.day, total: d.total, byAction: d.by })),
  };
};

/** Coerce whatever was persisted into a well-formed state; tolerates older/partial files. */
export const coerceEventFunnel = (raw: unknown): EventFunnelState => {
  const f = emptyEventFunnel();
  if (!raw || typeof raw !== "object") return f;
  const r = raw as Partial<EventFunnelState>;
  if (r.pageLoads && typeof r.pageLoads === "object") f.pageLoads = r.pageLoads;
  if (r.actions && typeof r.actions === "object") f.actions = r.actions;
  if (r.sessions && typeof r.sessions === "object") f.sessions = r.sessions;
  if (r.protectsByLeague && typeof r.protectsByLeague === "object") f.protectsByLeague = r.protectsByLeague;
  if (r.protectsByRoute && typeof r.protectsByRoute === "object") f.protectsByRoute = r.protectsByRoute;
  if (r.protectsByTier && typeof r.protectsByTier === "object") f.protectsByTier = r.protectsByTier;
  if (Array.isArray(r.recentProtects)) f.recentProtects = r.recentProtects.slice(-MAX_RECENT_PROTECTS);
  return f;
};

/** Admin gate: EVENT_X_ADMIN_TOKEN, or explicit dev mode. Fail closed when neither is set. */
export interface AdminAuth {
  enabled: boolean;
  token: string | null;
}

export const parseAdminAuthFromEnv = (env: Record<string, string | undefined>): AdminAuth => {
  const token = env.EVENT_X_ADMIN_TOKEN?.trim() || null;
  if (token) return { enabled: true, token };
  return { enabled: String(env.EVENT_X_DEV_NO_ADMIN ?? "false").toLowerCase() === "true", token: null };
};

export const adminAuthorized = (
  auth: AdminAuth,
  headers: Record<string, string | string[] | undefined>,
  queryToken: string | null,
): boolean => {
  if (!auth.enabled) return false;
  if (auth.token == null) return true;
  const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const headerToken = String(headers["x-admin-token"] ?? "").trim();
  return bearer === auth.token || headerToken === auth.token || (queryToken ?? "") === auth.token;
};

/**
 * Per-key token bucket for the beacon endpoint: a page cannot produce more
 * than a handful of actions a minute, so anything past that is noise.
 */
export interface TokenBucketLimiter {
  allow: (key: string, nowMs: number) => boolean;
}

export const tokenBucketLimiter = (capacity: number, refillMs: number): TokenBucketLimiter => {
  const buckets = new Map<string, { tokens: number; lastMs: number }>();
  return {
    allow: (key, nowMs) => {
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: capacity, lastMs: nowMs };
        buckets.set(key, b);
      }
      const refill = ((nowMs - b.lastMs) / refillMs) * capacity;
      b.tokens = Math.min(capacity, b.tokens + Math.max(0, refill));
      b.lastMs = nowMs;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      // Keep the map from growing without bound under many distinct keys.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) {
          if (nowMs - v.lastMs > refillMs) buckets.delete(k);
          if (buckets.size <= 5_000) break;
        }
      }
      return true;
    },
  };
};
