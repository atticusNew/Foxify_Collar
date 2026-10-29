/**
 * VENUE BREAKDOWN — the operator's view of where each game's protection could have been hedged.
 *
 * Every sports open carries, from the same books at the same second, the default tier re-priced on
 * each hedge route and on every reference book the service read (shadowCounterfactuals). This
 * module lays those out per game and per venue, with the venues NAMED: this view answers only to
 * the operator token and is never published. The public record and the demo keep their neutral
 * words ("the market's own No side", "reference book B").
 *
 * Two reads per game when both exist: the open-time read (the books the record wrote from) and
 * the pre-lock read (the same routes and references priced again a fixed time before the lock,
 * when every venue that will list the game has). Each is laid out the same way; the pre-lock
 * read compares each venue to the route written as it priced at that same moment.
 *
 * Nothing here re-reads a venue; it is the ledger, arranged.
 */

import type { ShadowAltTerms, ShadowBookOpenReread, ShadowBookOpened, ShadowReread } from "./shadowCounterfactuals";
import type { ShadowPosition } from "./shadowLedger";
import type { HedgeRoute } from "./types";
import type { ReferenceBookId, ReferenceListing } from "./venueBooks";

export type VenueColumnId = HedgeRoute | ReferenceBookId;

/** Column order and the operator's names. The aggregator maps its PROPHETX venue to aggregated_mm (aggregatorBooks.ts). */
export const VENUE_COLUMNS: ReadonlyArray<{ id: VenueColumnId; name: string; via: "direct" | "feed"; kind: "route" | "reference" }> = [
  { id: "kalshi_self", name: "Kalshi, own No side", via: "direct", kind: "route" },
  { id: "polymarket", name: "Polymarket", via: "direct", kind: "route" },
  // the hedge route on ProphetX: the same strike the reference column reads, priced with the settlement fee folded in
  { id: "prophetx", name: "ProphetX, hedge route", via: "feed", kind: "route" },
  { id: "aggregated_mm", name: "ProphetX", via: "feed", kind: "reference" },
  { id: "partner_mm", name: "ProphetX", via: "direct", kind: "reference" },
  { id: "signed_v3", name: "Novig", via: "direct", kind: "reference" },
  { id: "aggregated_other", name: "another venue", via: "feed", kind: "reference" },
];

/** Short operator words for a refusal code or a reference's reason. */
export function refusalWord(code: string): string {
  if (code === "route_not_offered") return "not offered";
  if (code === "not_listed" || code === "winner_market_not_listed" || code === "league_not_listed" || code === "league_not_covered") return "not listed";
  if (code === "stale") return "stale book";
  if (/_book_empty$/.test(code) || code === "book_empty") return "no book";
  if (/_book_too_thin$/.test(code) || code === "book_too_thin") return "too thin";
  if (code === "credit_nonpositive" || code === "credit_too_small") return "no credit";
  if (code === "protection_too_rich") return "too rich";
  if (code === "far_out_no_book") return "too early";
  if (code === "route_gated") return "no route";
  if (code === "mark_disagreement") return "mark unsettled";
  if (code === "book_not_retained") return "not kept";
  if (code === "fee_exceeds_gross") return "fee > gross";
  // the feed's four mapping states (aggregatorBooks.ts header): which one tells the operator whether to wait or to ask
  if (code === "not_mapped") return "not mapped yet";
  if (code === "mapped_no_book") return "mapped, no book yet";
  if (code === "stream_market_not_yet_open") return "mapped, streams ~2d out";
  if (code.startsWith("stream_")) return `feed: ${code.slice(7).replace(/_/g, " ")}`;
  if (code.startsWith("venue_")) return `venue: ${code.slice(6).replace(/_/g, " ")}`;
  if (code.startsWith("unreachable")) return "unreachable";
  return code.replace(/_/g, " ");
}

export interface VenueCell {
  id: VenueColumnId;
  /** the venue was read for this game (a route is always read; a reference only when configured) */
  read: boolean;
  /** the venue had a book for the opposing outcome at all (routes: a quote or a book-level refusal; references: a best ask) */
  listed: boolean;
  /** credit the default tier would have paid from this venue's book, cents; null when refused */
  creditCents: number | null;
  /** credit here minus the credit written, cents; null when refused */
  deltaCents: number | null;
  evCostBps: number | null;
  /** best ask on the opposing outcome, cents per $1 (references only) */
  bestAskCents: number | null;
  /** visible depth, whole shares (references only) */
  depthShares: number | null;
  /** the venue's snapshot age at the read, seconds (references only; null when unstamped or no book) */
  ageSec: number | null;
  refused: string | null;
  /** this venue's book was the one the record wrote from */
  written: boolean;
  /** the listing the cell was read from (references only): ids to quote back to the feed or the venue; absent when the read never reached one */
  listing?: ReferenceListing;
}

export interface VenueGameRow {
  ticker: string;
  league: string;
  eventTitle: string;
  sideName: string;
  eventTimeIso: string;
  status: ShadowPosition["status"];
  openedAt: string;
  contracts: number;
  markCents: number;
  route: HedgeRoute;
  floorCents: number;
  capCents: number;
  creditCents: number;
  /** where the two route books came from at open: the aggregator's feed or the venue; absent on older records */
  bookOrigins?: { polymarket?: "aggregator" | "direct"; kalshi?: "aggregator" | "direct" };
  /**
   * the venue whose book made protection cheapest (lowest EV cost), among those that funded it:
   * the same measure the record chooses its route by. Credit alone can rank the other way when
   * floors and caps differ.
   */
  best: VenueColumnId | null;
  cells: VenueCell[];
  /** the pre-lock read, when one has happened; absent until then */
  prelock?: VenuePrelock;
  /** the read taken when a held reference book opened, when the record caught one */
  bookOpen?: VenueBookOpen;
}

/** The book-open read laid out like the pre-lock one, plus which venue opened and how it was caught. */
export type VenueBookOpen = VenuePrelock & { opened: ShadowBookOpened };

/** The pre-lock read laid out like the open-time one; `unread` when the books could not be read then. */
export interface VenuePrelock {
  at: string;
  hoursToLock: number;
  markCents: number | null;
  unread: string | null;
  /** the venue whose book made protection cheapest at the pre-lock read, of those that funded it */
  best: VenueColumnId | null;
  /** the route written, as it priced at the pre-lock read (what the deltas compare to); null when it refused then */
  writtenCreditCents: number | null;
  cells: VenueCell[];
}

/** Per-venue counts over the games that had a pre-lock read. */
export interface VenuePrelockTotals {
  read: number;
  listed: number;
  quoted: number;
  best: number;
  /** over games both this venue and the written route quoted at the pre-lock read: average credit here minus written, cents */
  avgDeltaCents: number | null;
  bothQuoted: number;
}

export interface VenueTotals {
  id: VenueColumnId;
  name: string;
  via: "direct" | "feed";
  kind: "route" | "reference";
  read: number;
  listed: number;
  quoted: number;
  /** games where this venue's book was the one written from */
  written: number;
  /** games where this venue's book made protection cheapest (lowest EV cost) of all that funded */
  best: number;
  /** over games both this venue and the written route quoted: average credit here minus written, cents */
  avgDeltaCents: number | null;
  bothQuoted: number;
  /** the same counts at the pre-lock read, over the games that had one */
  prelock: VenuePrelockTotals;
  /** the same counts at the book-open read, over the games whose held book opened */
  bookOpen: VenuePrelockTotals;
}

/** Over the window's games: how many held books opened, how, and how far before the lock. */
export interface VenueBookOpenTotals {
  /** games with a book-open read that priced */
  read: number;
  /** games whose open was caught but the books could not then be read for a reason that would not change */
  unread: number;
  /** opens seen happen while held */
  live: number;
  /** books that already had levels at the hold's first snapshot */
  atHold: number;
  /** over every book-open read: mean hours from the open to the lock, one decimal */
  avgHoursToLock: number | null;
  /** the same, over the opens seen live only */
  avgHoursToLockLive: number | null;
}

export interface VenueBreakdown {
  atIso: string;
  /** positions carrying route counterfactuals in the window (sports only) */
  positions: number;
  sinceIso: string | null;
  /** how many of the window's opens priced each route book from the feed, from the venue, or predate the field */
  origins: { feed: number; direct: number; unknown: number };
  /** games in the window with a pre-lock read: with books, and with none for a reason that would not change */
  prelock: { read: number; unread: number };
  /** games in the window whose held reference book opened, and when */
  bookOpen: VenueBookOpenTotals;
  totals: VenueTotals[];
  rows: VenueGameRow[];
}

function cellFromTerms(
  id: VenueColumnId,
  t: ShadowAltTerms | undefined,
  written: boolean,
  liveCredit: number | null,
  extra?: { bestAskMilli: number | null; depthMilli: number; ageSec?: number; listing?: ReferenceListing },
): VenueCell {
  const bestAskCents = extra ? (extra.bestAskMilli === null ? null : Math.round(extra.bestAskMilli / 10)) : null;
  const depthShares = extra ? Math.floor(extra.depthMilli / 1000) : null;
  const ageSec = extra?.ageSec ?? null;
  const listing = extra?.listing ? { listing: extra.listing } : {};
  if (!t) return { id, read: false, listed: false, creditCents: null, deltaCents: null, evCostBps: null, bestAskCents, depthShares, ageSec, refused: null, written: false, ...listing };
  if (!t.ok) {
    // a route refused for thinness still had a book; "not offered" / "not listed" / "no book" had none
    const hadBook = extra ? extra.bestAskMilli !== null : /too_thin|credit|too_rich|fee_exceeds/.test(t.refused);
    return { id, read: true, listed: hadBook, creditCents: null, deltaCents: null, evCostBps: null, bestAskCents, depthShares, ageSec, refused: refusalWord(t.refused), written, ...listing };
  }
  return {
    id,
    read: true,
    listed: true,
    creditCents: t.creditCents,
    deltaCents: liveCredit === null ? null : t.creditCents - liveCredit,
    evCostBps: t.evCostBps,
    bestAskCents,
    depthShares,
    ageSec,
    refused: null,
    written,
    ...listing,
  };
}

/** Every column from one read's routes and references, deltas against `writtenCredit`. */
function cellsFrom(
  routes: Partial<Record<HedgeRoute, ShadowAltTerms>>,
  references: ReadonlyArray<{ id: ReferenceBookId; terms: ShadowAltTerms; bestAskMilli: number | null; depthMilli: number; ageSec?: number; listing?: ReferenceListing }>,
  writtenRoute: HedgeRoute,
  writtenCredit: number | null,
): { cells: VenueCell[]; best: VenueColumnId | null } {
  const refs = new Map(references.map((r) => [r.id, r]));
  const cells: VenueCell[] = VENUE_COLUMNS.map((col) => {
    if (col.kind === "route") {
      const route = col.id as HedgeRoute;
      return cellFromTerms(col.id, routes[route], writtenRoute === route, writtenCredit);
    }
    const ref = refs.get(col.id as ReferenceBookId);
    return cellFromTerms(col.id, ref?.terms, false, writtenCredit, ref ? { bestAskMilli: ref.bestAskMilli, depthMilli: ref.depthMilli, ageSec: ref.ageSec, listing: ref.listing } : undefined);
  });
  const quoted = cells.filter((c) => c.evCostBps !== null);
  const best = quoted.length > 0 ? quoted.reduce((a, b) => (b.evCostBps! < a.evCostBps! ? b : a)).id : null;
  return { cells, best };
}

/** The pre-lock read laid out; each venue against the route written as it priced at that read. */
export function venuePrelockFor(reread: ShadowReread, writtenRoute: HedgeRoute): VenuePrelock {
  if ("unread" in reread) {
    const { cells } = cellsFrom({}, [], writtenRoute, null);
    return { at: reread.at, hoursToLock: reread.hoursToLock, markCents: null, unread: reread.unread, best: null, writtenCreditCents: null, cells };
  }
  const w = reread.routes[writtenRoute];
  const writtenCreditCents = w?.ok ? w.creditCents : null;
  const { cells, best } = cellsFrom(reread.routes, reread.references ?? [], writtenRoute, writtenCreditCents);
  return { at: reread.at, hoursToLock: reread.hoursToLock, markCents: reread.markCents, unread: null, best, writtenCreditCents, cells };
}

/** The book-open read laid out the same way, carrying which venue opened and how the open was caught. */
export function venueBookOpenFor(reread: ShadowBookOpenReread, writtenRoute: HedgeRoute): VenueBookOpen {
  return { ...venuePrelockFor(reread, writtenRoute), opened: reread.opened };
}

/** One game's cells in column order; null when the position predates route counterfactuals or is not a game. */
export function venueRowFor(p: ShadowPosition): VenueGameRow | null {
  const cf = p.counterfactuals;
  if (p.kind !== "sports" || !cf?.routes) return null;
  const { cells, best } = cellsFrom(cf.routes, cf.references ?? [], p.route, p.creditCents);
  const prelock = p.prelock ? venuePrelockFor(p.prelock, p.route) : undefined;
  const bookOpen = p.bookOpen ? venueBookOpenFor(p.bookOpen, p.route) : undefined;
  return {
    ticker: p.ticker,
    league: p.league,
    eventTitle: p.eventTitle,
    sideName: p.sideName,
    eventTimeIso: p.eventTimeIso,
    status: p.status,
    openedAt: p.at,
    contracts: p.contracts,
    markCents: p.markCents,
    route: p.route,
    floorCents: p.floorCents,
    capCents: p.capCents,
    creditCents: p.creditCents,
    ...(p.bookOrigins ? { bookOrigins: p.bookOrigins } : {}),
    best,
    cells,
    ...(prelock ? { prelock } : {}),
    ...(bookOpen ? { bookOpen } : {}),
  };
}

/**
 * The window's games, open first (next to lock first) then settled (most recent first), each
 * priced on every venue, with totals per venue. Columns no venue ever filled are dropped.
 */
export function venueBreakdown(positions: ShadowPosition[], now: Date, opts: { windowDays?: number; maxRows?: number } = {}): VenueBreakdown {
  const windowMs = (opts.windowDays ?? 7) * 86_400_000;
  const maxRows = opts.maxRows ?? 80;
  const nowMs = now.getTime();
  const inWindow = positions.filter((p) => p.kind === "sports" && p.counterfactuals?.routes && nowMs - Date.parse(p.at) <= windowMs);
  const rowsAll = inWindow.map(venueRowFor).filter((r): r is VenueGameRow => r !== null);

  type ReadTally = VenuePrelockTotals & { deltaSum: number };
  type Tally = VenueTotals & { deltaSum: number; prelock: ReadTally; bookOpen: ReadTally };
  const emptyRead = (): ReadTally => ({ read: 0, listed: 0, quoted: 0, best: 0, avgDeltaCents: null, bothQuoted: 0, deltaSum: 0 });
  const totals = new Map<VenueColumnId, Tally>();
  for (const col of VENUE_COLUMNS) {
    totals.set(col.id, { ...col, read: 0, listed: 0, quoted: 0, written: 0, best: 0, avgDeltaCents: null, bothQuoted: 0, deltaSum: 0, prelock: emptyRead(), bookOpen: emptyRead() });
  }
  const origins = { feed: 0, direct: 0, unknown: 0 };
  const prelock = { read: 0, unread: 0 };
  const bookOpen = { read: 0, unread: 0, live: 0, atHold: 0, hoursSum: 0, hoursN: 0, hoursSumLive: 0, hoursNLive: 0 };
  /** one later read's cells onto that read's per-venue tally */
  const tallyRead = (read: VenuePrelock, pick: (t: Tally) => ReadTally) => {
    for (const c of read.cells) {
      const t = pick(totals.get(c.id)!);
      if (c.read) t.read += 1;
      if (c.listed) t.listed += 1;
      if (c.creditCents !== null) t.quoted += 1;
      if (read.best === c.id) t.best += 1;
      if (c.deltaCents !== null && !c.written) {
        t.bothQuoted += 1;
        t.deltaSum += c.deltaCents;
      }
    }
  };
  for (const r of rowsAll) {
    for (const c of r.cells) {
      const t = totals.get(c.id)!;
      if (c.read) t.read += 1;
      if (c.listed) t.listed += 1;
      if (c.creditCents !== null) t.quoted += 1;
      if (c.written) t.written += 1;
      if (r.best === c.id) t.best += 1;
      if (c.deltaCents !== null && !c.written) {
        t.bothQuoted += 1;
        t.deltaSum += c.deltaCents;
      }
    }
    if (r.prelock) {
      if (r.prelock.unread !== null) prelock.unread += 1;
      else prelock.read += 1;
      tallyRead(r.prelock, (t) => t.prelock);
    }
    if (r.bookOpen) {
      if (r.bookOpen.unread !== null) bookOpen.unread += 1;
      else bookOpen.read += 1;
      if (r.bookOpen.opened.caught === "live") {
        bookOpen.live += 1;
        bookOpen.hoursSumLive += r.bookOpen.hoursToLock;
        bookOpen.hoursNLive += 1;
      } else bookOpen.atHold += 1;
      bookOpen.hoursSum += r.bookOpen.hoursToLock;
      bookOpen.hoursN += 1;
      tallyRead(r.bookOpen, (t) => t.bookOpen);
    }
    const o = r.bookOrigins;
    if (!o) origins.unknown += 1;
    else if (o.polymarket === "aggregator" || o.kalshi === "aggregator") origins.feed += 1;
    else origins.direct += 1;
  }
  const kept = new Set<VenueColumnId>();
  for (const t of totals.values()) if (t.read > 0 || t.prelock.read > 0 || t.bookOpen.read > 0) kept.add(t.id);
  // the two original routes are always shown: they are what the record chose between from the
  // start; the ProphetX route joins once a read has priced it
  kept.add("kalshi_self");
  kept.add("polymarket");

  const open = rowsAll.filter((r) => r.status === "open").sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
  const done = rowsAll.filter((r) => r.status !== "open").sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const rows = [...open, ...done].slice(0, maxRows).map((r) => ({
    ...r,
    cells: r.cells.filter((c) => kept.has(c.id)),
    ...(r.prelock ? { prelock: { ...r.prelock, cells: r.prelock.cells.filter((c) => kept.has(c.id)) } } : {}),
    ...(r.bookOpen ? { bookOpen: { ...r.bookOpen, cells: r.bookOpen.cells.filter((c) => kept.has(c.id)) } } : {}),
  }));
  const since = rowsAll.reduce<string | null>((s, r) => (s === null || r.openedAt < s ? r.openedAt : s), null);
  const finishRead = ({ deltaSum, ...t }: ReadTally): VenuePrelockTotals => ({ ...t, avgDeltaCents: t.bothQuoted > 0 ? Math.round(deltaSum / t.bothQuoted) : null });
  const tenth = (sum: number, n: number) => (n > 0 ? Math.round((sum / n) * 10) / 10 : null);

  return {
    atIso: now.toISOString(),
    positions: rowsAll.length,
    sinceIso: since,
    origins,
    prelock,
    bookOpen: {
      read: bookOpen.read,
      unread: bookOpen.unread,
      live: bookOpen.live,
      atHold: bookOpen.atHold,
      avgHoursToLock: tenth(bookOpen.hoursSum, bookOpen.hoursN),
      avgHoursToLockLive: tenth(bookOpen.hoursSumLive, bookOpen.hoursNLive),
    },
    totals: [...totals.values()]
      .filter((t) => kept.has(t.id))
      .map(({ deltaSum, prelock: pl, bookOpen: bo, ...t }) => ({
        ...t,
        avgDeltaCents: t.bothQuoted > 0 ? Math.round(deltaSum / t.bothQuoted) : null,
        prelock: finishRead(pl),
        bookOpen: finishRead(bo),
      })),
    rows,
  };
}

// ---------------------------------------------------------------------------
// CSV: one line per game, per read, per venue, with the listing ids
// ---------------------------------------------------------------------------

export const VENUE_CSV_HEADER = [
  "ticker",
  "league",
  "event",
  "side",
  "event_time",
  "status",
  "read",
  "read_at",
  "hours_to_lock",
  "venue",
  "venue_id",
  "via",
  "state",
  "credit_c",
  "delta_c",
  "ev_cost_bps",
  "best_ask_c",
  "depth_shares",
  "age_sec",
  "market_id",
  "listing_key",
  "snapshot_at",
  "written",
] as const;

function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The cell's one-word state: quoted, or the refusal word, or unlisted/unread. */
export function venueCellState(c: VenueCell): string {
  if (!c.read) return "unread";
  if (c.creditCents !== null) return "quoted";
  return c.refused ?? (c.listed ? "refused" : "unlisted");
}

/**
 * The window laid out flat for a spreadsheet or a partner's ticket: every venue read of every
 * game, at open and at each later read, with the aggregator's market id, the venue's listing key
 * and the snapshot's own timestamp beside the state, so a "mapped, no book yet" can be asked
 * about by id. Operator only: venues are named, and nothing here is a key.
 */
export function venueBreakdownCsv(b: VenueBreakdown): string {
  const nameOf = new Map(b.totals.map((t) => [t.id, t]));
  const lines: string[] = [VENUE_CSV_HEADER.join(",")];
  const push = (r: VenueGameRow, read: string, readAt: string, hoursToLock: number | null, c: VenueCell) => {
    const col = nameOf.get(c.id);
    lines.push(
      [
        r.ticker,
        r.league,
        r.eventTitle,
        r.sideName,
        r.eventTimeIso,
        r.status,
        read,
        readAt,
        hoursToLock,
        col?.name ?? c.id,
        c.id,
        col?.via ?? "",
        venueCellState(c),
        c.creditCents,
        c.deltaCents,
        c.evCostBps,
        c.bestAskCents,
        c.depthShares,
        c.ageSec,
        c.listing?.marketId ?? null,
        c.listing?.key ?? null,
        c.listing?.snapshotAtIso ?? null,
        c.written,
      ]
        .map(csvCell)
        .join(","),
    );
  };
  for (const r of b.rows) {
    for (const c of r.cells) push(r, "open", r.openedAt, null, c);
    // later reads in time order: the book-open read, then the pre-lock read
    if (r.bookOpen) for (const c of r.bookOpen.cells) push(r, "book_open", r.bookOpen.at, r.bookOpen.hoursToLock, c);
    if (r.prelock) for (const c of r.prelock.cells) push(r, "prelock", r.prelock.at, r.prelock.hoursToLock, c);
  }
  return lines.join("\n") + "\n";
}
