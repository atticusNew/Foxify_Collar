/**
 * EXTENSION TELEMETRY: anonymous counts the browser extension posts once per page it draws on,
 * so what fails on a live venue can be seen without a screenshot. Nothing personal is accepted:
 * fixed vocabularies for the venue and the page, a version string, and small whole numbers. The
 * store is in memory (a ring of recent rows plus running totals per venue and version); it is
 * read on the operator's views and resets with the process.
 */

export const EXT_VENUES = ["prophetx", "kalshi", "novig", "stx", "preview"] as const;
export type ExtVenue = (typeof EXT_VENUES)[number];
export const EXT_PAGES = ["board", "game", "plays", "other"] as const;
export type ExtPage = (typeof EXT_PAGES)[number];
/** what the extension counts on a page */
export const EXT_COUNTS = ["markets", "protectable", "games", "marks", "slip", "slipMarked", "rows", "offers", "unread"] as const;
export type ExtCount = (typeof EXT_COUNTS)[number];

export interface ExtTelemetryRow {
  at: string;
  venue: ExtVenue;
  page: ExtPage;
  version: string;
  counts: Record<ExtCount, number>;
}

export interface ExtTelemetrySummary {
  rows: number;
  since: string | null;
  byVenue: Record<string, { loads: number; lastAt: string; versions: string[]; totals: Record<ExtCount, number>; boards: number; boardsWithMarks: number; slips: number; slipsMarked: number; plays: number; playsUnread: number }>;
  recent: ExtTelemetryRow[];
}

const VERSION_RE = /^\d{1,3}(\.\d{1,4}){1,3}$/;
const MAX_COUNT = 100_000;

/** Validate one posted body. Rejects anything outside the vocabularies; never keeps free text. */
export function parseExtTelemetry(body: unknown, at: string = new Date().toISOString()): { ok: true; row: ExtTelemetryRow } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "a JSON object is required" };
  const b = body as Record<string, unknown>;
  const venue = typeof b.venue === "string" ? b.venue.toLowerCase() : "";
  if (!(EXT_VENUES as readonly string[]).includes(venue)) return { ok: false, error: `venue must be one of ${EXT_VENUES.join(", ")}` };
  const page = typeof b.page === "string" ? b.page.toLowerCase() : "";
  if (!(EXT_PAGES as readonly string[]).includes(page)) return { ok: false, error: `page must be one of ${EXT_PAGES.join(", ")}` };
  const version = typeof b.version === "string" ? b.version.trim() : "";
  if (!VERSION_RE.test(version)) return { ok: false, error: "version must look like 0.7.0" };
  const rawCounts = b.counts && typeof b.counts === "object" ? (b.counts as Record<string, unknown>) : {};
  const counts = {} as Record<ExtCount, number>;
  for (const k of EXT_COUNTS) {
    const v = rawCounts[k] ?? 0;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return { ok: false, error: `counts.${k} must be a whole number from 0 to ${MAX_COUNT}` };
    counts[k] = v;
  }
  for (const k of Object.keys(rawCounts)) if (!(EXT_COUNTS as readonly string[]).includes(k)) return { ok: false, error: `counts.${k} is not a known count` };
  return { ok: true, row: { at, venue: venue as ExtVenue, page: page as ExtPage, version, counts } };
}

export class ExtTelemetryStore {
  private readonly ring: ExtTelemetryRow[] = [];
  private total = 0;
  private since: string | null = null;
  constructor(private readonly keep = 300) {}

  add(row: ExtTelemetryRow): void {
    this.total += 1;
    if (!this.since) this.since = row.at;
    this.ring.push(row);
    if (this.ring.length > this.keep) this.ring.splice(0, this.ring.length - this.keep);
  }

  /** Totals per venue over what the ring still holds, plus the most recent rows (newest first). */
  summary(recent = 40): ExtTelemetrySummary {
    const byVenue: ExtTelemetrySummary["byVenue"] = {};
    for (const r of this.ring) {
      const v = (byVenue[r.venue] ??= {
        loads: 0,
        lastAt: r.at,
        versions: [],
        totals: Object.fromEntries(EXT_COUNTS.map((k) => [k, 0])) as Record<ExtCount, number>,
        boards: 0,
        boardsWithMarks: 0,
        slips: 0,
        slipsMarked: 0,
        plays: 0,
        playsUnread: 0,
      });
      v.loads += 1;
      if (r.at > v.lastAt) v.lastAt = r.at;
      if (!v.versions.includes(r.version)) v.versions.push(r.version);
      for (const k of EXT_COUNTS) v.totals[k] += r.counts[k];
      if (r.page === "board" || r.page === "game") {
        v.boards += 1;
        if (r.counts.marks > 0) v.boardsWithMarks += 1;
      }
      if (r.counts.slip > 0) {
        v.slips += 1;
        if (r.counts.slipMarked > 0) v.slipsMarked += 1;
      }
      if (r.page === "plays") {
        v.plays += 1;
        if (r.counts.unread > 0) v.playsUnread += 1;
      }
    }
    for (const v of Object.values(byVenue)) v.versions.sort();
    return { rows: this.total, since: this.since, byVenue, recent: this.ring.slice(-recent).reverse() };
  }
}
