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

import type { ShadowAltTerms, ShadowReread } from "./shadowCounterfactuals";
import type { ShadowPosition } from "./shadowLedger";
import type { HedgeRoute } from "./types";
import type { ReferenceBookId } from "./venueBooks";

export type VenueColumnId = HedgeRoute | ReferenceBookId;

/** Column order and the operator's names. The aggregator maps its PROPHETX venue to aggregated_mm (aggregatorBooks.ts). */
export const VENUE_COLUMNS: ReadonlyArray<{ id: VenueColumnId; name: string; via: "direct" | "feed"; kind: "route" | "reference" }> = [
  { id: "kalshi_self", name: "Kalshi, own No side", via: "direct", kind: "route" },
  { id: "polymarket", name: "Polymarket", via: "direct", kind: "route" },
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
  refused: string | null;
  /** this venue's book was the one the record wrote from */
  written: boolean;
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
}

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
  totals: VenueTotals[];
  rows: VenueGameRow[];
}

function cellFromTerms(id: VenueColumnId, t: ShadowAltTerms | undefined, written: boolean, liveCredit: number | null, extra?: { bestAskMilli: number | null; depthMilli: number }): VenueCell {
  const bestAskCents = extra ? (extra.bestAskMilli === null ? null : Math.round(extra.bestAskMilli / 10)) : null;
  const depthShares = extra ? Math.floor(extra.depthMilli / 1000) : null;
  if (!t) return { id, read: false, listed: false, creditCents: null, deltaCents: null, evCostBps: null, bestAskCents, depthShares, refused: null, written: false };
  if (!t.ok) {
    // a route refused for thinness still had a book; "not offered" / "not listed" / "no book" had none
    const hadBook = extra ? extra.bestAskMilli !== null : /too_thin|credit|too_rich|fee_exceeds/.test(t.refused);
    return { id, read: true, listed: hadBook, creditCents: null, deltaCents: null, evCostBps: null, bestAskCents, depthShares, refused: refusalWord(t.refused), written };
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
    refused: null,
    written,
  };
}

/** Every column from one read's routes and references, deltas against `writtenCredit`. */
function cellsFrom(
  routes: Partial<Record<HedgeRoute, ShadowAltTerms>>,
  references: ReadonlyArray<{ id: ReferenceBookId; terms: ShadowAltTerms; bestAskMilli: number | null; depthMilli: number }>,
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
    return cellFromTerms(col.id, ref?.terms, false, writtenCredit, ref ? { bestAskMilli: ref.bestAskMilli, depthMilli: ref.depthMilli } : undefined);
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

/** One game's cells in column order; null when the position predates route counterfactuals or is not a game. */
export function venueRowFor(p: ShadowPosition): VenueGameRow | null {
  const cf = p.counterfactuals;
  if (p.kind !== "sports" || !cf?.routes) return null;
  const { cells, best } = cellsFrom(cf.routes, cf.references ?? [], p.route, p.creditCents);
  const prelock = p.prelock ? venuePrelockFor(p.prelock, p.route) : undefined;
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

  type Tally = VenueTotals & { deltaSum: number; prelock: VenuePrelockTotals & { deltaSum: number } };
  const totals = new Map<VenueColumnId, Tally>();
  for (const col of VENUE_COLUMNS) {
    totals.set(col.id, { ...col, read: 0, listed: 0, quoted: 0, written: 0, best: 0, avgDeltaCents: null, bothQuoted: 0, deltaSum: 0, prelock: { read: 0, listed: 0, quoted: 0, best: 0, avgDeltaCents: null, bothQuoted: 0, deltaSum: 0 } });
  }
  const origins = { feed: 0, direct: 0, unknown: 0 };
  const prelock = { read: 0, unread: 0 };
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
      for (const c of r.prelock.cells) {
        const t = totals.get(c.id)!.prelock;
        if (c.read) t.read += 1;
        if (c.listed) t.listed += 1;
        if (c.creditCents !== null) t.quoted += 1;
        if (r.prelock.best === c.id) t.best += 1;
        if (c.deltaCents !== null && !c.written) {
          t.bothQuoted += 1;
          t.deltaSum += c.deltaCents;
        }
      }
    }
    const o = r.bookOrigins;
    if (!o) origins.unknown += 1;
    else if (o.polymarket === "aggregator" || o.kalshi === "aggregator") origins.feed += 1;
    else origins.direct += 1;
  }
  const kept = new Set<VenueColumnId>();
  for (const t of totals.values()) if (t.read > 0 || t.prelock.read > 0) kept.add(t.id);
  // the two routes are always shown: they are what the record chooses between
  kept.add("kalshi_self");
  kept.add("polymarket");

  const open = rowsAll.filter((r) => r.status === "open").sort((a, b) => a.eventTimeIso.localeCompare(b.eventTimeIso));
  const done = rowsAll.filter((r) => r.status !== "open").sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const rows = [...open, ...done].slice(0, maxRows).map((r) => ({
    ...r,
    cells: r.cells.filter((c) => kept.has(c.id)),
    ...(r.prelock ? { prelock: { ...r.prelock, cells: r.prelock.cells.filter((c) => kept.has(c.id)) } } : {}),
  }));
  const since = rowsAll.reduce<string | null>((s, r) => (s === null || r.openedAt < s ? r.openedAt : s), null);

  return {
    atIso: now.toISOString(),
    positions: rowsAll.length,
    sinceIso: since,
    origins,
    prelock,
    totals: [...totals.values()]
      .filter((t) => kept.has(t.id))
      .map(({ deltaSum, prelock: pl, ...t }) => {
        const { deltaSum: plSum, ...plRest } = pl;
        return {
          ...t,
          avgDeltaCents: t.bothQuoted > 0 ? Math.round(deltaSum / t.bothQuoted) : null,
          prelock: { ...plRest, avgDeltaCents: pl.bothQuoted > 0 ? Math.round(plSum / pl.bothQuoted) : null },
        };
      }),
    rows,
  };
}
