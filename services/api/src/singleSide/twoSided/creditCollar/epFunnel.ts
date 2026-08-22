/**
 * EARN & PROTECT FUNNEL — top-of-funnel visibility, privacy-clean. The wallet registry only counts
 * wallets that successfully WRAPPED; this module counts wallets that LOOKED (viewed positions or
 * state) and simple daily page loads, so the operator can tell a reach problem ("nobody clicked")
 * from a conversion problem ("they looked and hesitated"). No IPs, no fingerprints, no third-party
 * analytics — just addresses the visitor already typed in, and counters.
 *
 * Pure module: the service owns persistence (EpStores) and flush cadence.
 */

export type LookerRow = { firstMs: number; lastMs: number; views: number };

export type FunnelState = {
  /** account (lowercase) → look history. Bounded by distinct visitors — tiny at any realistic scale. */
  lookers: Record<string, LookerRow>;
  /** UTC day "YYYY-MM-DD" → page → loads. Pruned beyond `PAGELOAD_RETENTION_DAYS`. */
  pageLoads: Record<string, Record<string, number>>;
};

export const emptyFunnel = (): FunnelState => ({ lookers: {}, pageLoads: {} });

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const PAGELOAD_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** Record an address viewing its positions/state. Mutates; returns true when state changed. */
export const recordLooker = (f: FunnelState, account: string, nowMs: number): boolean => {
  const key = account.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return false;
  const row = f.lookers[key];
  if (row) {
    row.lastMs = nowMs;
    row.views += 1;
  } else {
    f.lookers[key] = { firstMs: nowMs, lastMs: nowMs, views: 1 };
  }
  return true;
};

/** Record a page load (app/miniapp/public). Mutates; prunes days beyond retention. */
export const recordPageLoad = (f: FunnelState, page: "app" | "miniapp" | "public", nowMs: number): void => {
  const day = dayKey(nowMs);
  const bucket = (f.pageLoads[day] ??= {});
  bucket[page] = (bucket[page] ?? 0) + 1;
  const cutoff = dayKey(nowMs - PAGELOAD_RETENTION_DAYS * DAY_MS);
  for (const d of Object.keys(f.pageLoads)) if (d < cutoff) delete f.pageLoads[d];
};

export type FunnelSummary = {
  /** Headline counts EXCLUDE internal accounts (the operator's own test wallets). */
  distinctLookers: number;
  lookers24h: number;
  lookers7d: number;
  /** The conversion gap: looked at positions but never wrapped (external only). */
  lookedNeverWrapped: number;
  /** How many of the recorded lookers are the operator's own accounts. */
  internalLookers: number;
  /** Most recent lookers (≤20), newest first — internal rows flagged, not hidden. */
  recentLookers: Array<{ account: string; views: number; firstMs: number; lastMs: number; wrapped: boolean; internal: boolean }>;
  /** Last 7 UTC days of page loads, oldest first, with per-page counts. Page loads happen before
   *  an address is typed, so they CANNOT be attributed to a wallet — internal visits included. */
  pageLoads7d: Array<{ day: string; total: number; byPage: Record<string, number> }>;
};

/** Parse EP_INTERNAL_ACCOUNTS (comma-separated addresses) — the operator's own test wallets. */
export const parseInternalAccounts = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
  );

export const funnelSummary = (f: FunnelState, wrappedAccounts: Set<string>, nowMs: number, internalAccounts: Set<string> = new Set()): FunnelSummary => {
  const rows = Object.entries(f.lookers);
  const wrapped = new Set([...wrappedAccounts].map((a) => a.toLowerCase()));
  const internal = new Set([...internalAccounts].map((a) => a.toLowerCase()));
  const external = rows.filter(([a]) => !internal.has(a));
  const within = (row: LookerRow, ms: number) => nowMs - row.lastMs <= ms;
  const recent = rows
    .sort((a, b) => b[1].lastMs - a[1].lastMs)
    .slice(0, 20)
    .map(([account, r]) => ({ account, views: r.views, firstMs: r.firstMs, lastMs: r.lastMs, wrapped: wrapped.has(account), internal: internal.has(account) }));
  const days: Array<{ day: string; total: number; byPage: Record<string, number> }> = [];
  for (let i = 6; i >= 0; i--) {
    const day = dayKey(nowMs - i * DAY_MS);
    const byPage = f.pageLoads[day] ?? {};
    days.push({ day, total: Object.values(byPage).reduce((s, n) => s + n, 0), byPage });
  }
  return {
    distinctLookers: external.length,
    lookers24h: external.filter(([, r]) => within(r, DAY_MS)).length,
    lookers7d: external.filter(([, r]) => within(r, 7 * DAY_MS)).length,
    lookedNeverWrapped: external.filter(([a]) => !wrapped.has(a)).length,
    internalLookers: rows.length - external.length,
    recentLookers: recent,
    pageLoads7d: days
  };
};
