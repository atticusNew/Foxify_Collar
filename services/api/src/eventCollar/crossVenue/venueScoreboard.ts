/**
 * THE VENUE SCOREBOARD — the hedger's view of the venues, by week.
 *
 * Volume tables say where people trade. This says where the other side of a protected position
 * was cheapest to take, all in, on the same games in the same week: which venue's book won the
 * hedge and by how much, what the winning venue's fee schedule charged on it, how often each
 * venue priced at all when asked, how often no venue could fund a floor, and how much was routed.
 * It is computed from the record on every request (the
 * scan's ledger, the holders' lock ledgers, the refusals file, the parlay ledger), so it is as
 * live as the record. Written for an industry reader: venue names in the open, `n` on every
 * cell, and nothing of the writer's book (no take, no P&L, no holder deltas) — those stay on the
 * operator views. Simulated positions and real taps are counted apart (`taps`).
 *
 * Weeks are Monday to Sunday in New York time, as the industry's weekly tables are drawn.
 */

import { hedgeVenueOf, SETTLEMENT_VENUES, VENUE_NAMES, type SettlementVenue } from "./hedgeRouting";
import type { LastLegTicket } from "./lastLeg";
import { hedgeUnitsOf, type ShadowPosition } from "./shadowLedger";
import { REFUSAL_REASON_ORDER, refusalReason, type RefusalEntry, type RefusalMap, type RefusalReason } from "./shadowRefusals";

const NY = "America/New_York";
const DAY_MS = 86_400_000;

/** The New York civil date of an instant, as "YYYY-MM-DD". */
export function nyDate(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The Monday (New York) that starts the week holding this instant, as "YYYY-MM-DD". */
export function weekMondayOf(ms: number): string {
  const d = nyDate(ms);
  const noonUtc = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12);
  const dow = (new Date(noonUtc).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(noonUtc - dow * DAY_MS).toISOString().slice(0, 10);
}

const addDays = (ymd: string, n: number): string => new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), 12) + n * DAY_MS).toISOString().slice(0, 10);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Week of Oct 19 – 25" / "Week of Oct 26 – Nov 1", the industry's wording. */
export function weekLabel(monday: string): string {
  const sunday = addDays(monday, 6);
  const m1 = MONTHS[Number(monday.slice(5, 7)) - 1];
  const m2 = MONTHS[Number(sunday.slice(5, 7)) - 1];
  const d1 = Number(monday.slice(8, 10));
  const d2 = Number(sunday.slice(8, 10));
  return m1 === m2 ? `Week of ${m1} ${d1} to ${d2}` : `Week of ${m1} ${d1} to ${m2} ${d2}`;
}

export interface VenueShare {
  venue: string;
  /** positions whose other side was taken on this venue */
  n: number;
  contracts: number;
  /** share of the week's contracts, 0..100 */
  sharePct: number;
}

export interface VenueAvailability {
  venue: string;
  /** positions on which this venue's book was asked for a price */
  asked: number;
  /** of those, how many it priced (a book deep enough to fund the other side) */
  priced: number;
  pricedPct: number | null;
}

export interface VenueEdge {
  venue: string;
  /** positions this venue won against at least one other priced venue */
  n: number;
  /** on average, how much more this venue's book paid the holder than the runner-up, cents per contract */
  avgEdgeCentsPerContract: number | null;
  /** the same edge all in (price plus the tails of each venue's rules), bps of the position, where routing recorded it */
  avgEdgeAllInBps: number | null;
}

/**
 * The fee each venue charges on the other side, as the engine folds it into that venue's book
 * before the routes are compared (the schedules the pricer uses; as of the date given). The
 * scoreboard shows what that came to per contract on the hedges a venue won, so a reader can see
 * how much of a venue's edge is its fee schedule. Worded without "taker": the public table is
 * checked for writer-side words, and the industry reader knows which side pays.
 */
export const VENUE_FEE_RULES: Record<SettlementVenue, { rule: string; asOf: string }> = {
  kalshi: { rule: "0.07 × P × (1 − P) per contract, charged at match to the side crossing the book; at most 1.75¢ at P = 50¢", asOf: "2026-11-02" },
  polymarket: { rule: "the engine's configured rate on the hedge's cost, as recorded on each hedge (zero as configured today)", asOf: "2026-11-02" },
  prophetx: { rule: "2% of net gains at settlement, nothing at match; folded as 2 × (1 − P) cents per contract. NHL games: 0.035 × P × (1 − P) per contract at match, nothing at settlement", asOf: "2026-11-11" },
  novig: { rule: "none pre-game, either side; 0.06 × P × (1 − P) on the side crossing the book while the game is live (our hedges are pre-game)", asOf: "2026-11-02" },
  // a holder venue only: no hedge is ever bought there, so no fee row is ever folded for it
  stx: { rule: "a per-account fee schedule on the member's own fills; no hedge is bought on this venue", asOf: "2026-11-03" },
};

/**
 * The venue's fee on one $1 unit of the other side bought at P (cents, 0..100), cents, by its
 * schedule; null where the schedule is not a formula of the price (Polymarket: read off the record).
 */
export function venueFeeCentsPerUnit(venue: SettlementVenue, priceCents: number): number | null {
  const p = Math.min(0.99, Math.max(0.01, priceCents / 100));
  if (venue === "kalshi") return 7 * p * (1 - p);
  if (venue === "prophetx") return 2 * (1 - p);
  if (venue === "novig") return 0;
  return null;
}

interface HedgeForFee {
  contracts: number;
  /** $1 units of the other side bought */
  units: number;
  hedgeCostCents?: number;
  markCents: number;
  feesCents?: number;
}

/**
 * The winning venue's fee on a hedge, cents per contract of the position (so it reads against the
 * edge column): the schedule at the price the other side was bought at, times the units bought,
 * over the contracts protected. Polymarket's is the fee the record carries.
 */
export function venueFeeOnHedge(venue: SettlementVenue, h: HedgeForFee): number | null {
  if (!(h.contracts > 0)) return null;
  if (venue === "polymarket") return h.feesCents === undefined ? null : h.feesCents / h.contracts;
  const priceCents = h.hedgeCostCents !== undefined && h.units > 0 ? h.hedgeCostCents / h.units : 100 - h.markCents;
  const perUnit = venueFeeCentsPerUnit(venue, priceCents);
  if (perUnit === null) return null;
  const units = h.units > 0 ? h.units : h.contracts;
  return (perUnit * units) / h.contracts;
}

export interface VenueFee {
  venue: string;
  /** hedges this venue won that the fee could be worked out on */
  n: number;
  /** the venue's fee on the other side, cents per contract of the position, averaged over those hedges */
  avgFeeCentsPerContract: number | null;
}

export interface FeeRule {
  venue: string;
  rule: string;
  asOf: string;
}

export interface LeagueCut {
  league: string;
  n: number;
  contracts: number;
  otherSide: VenueShare[];
  availability: VenueAvailability[];
}

export interface ScoreboardWeek {
  /** the Monday the week starts on, New York, "YYYY-MM-DD" */
  from: string;
  /** the Sunday it ends on */
  to: string;
  label: string;
  /** every protected position opened this week (singles) plus parlay tickets priced at their last pick */
  n: number;
  /** of which, taps by real holders through the lock endpoint; the rest are the record's simulated positions */
  taps: number;
  contracts: number;
  /** cents of the other side bought across venues this week */
  notionalCents: number;
  singles: { n: number; contracts: number; otherSide: VenueShare[] };
  parlays: { n: number; contracts: number; otherSide: VenueShare[]; unrouted: number };
  /** which venue won, and by how much, when more than one venue priced the same position */
  edge: { n: number; byVenue: VenueEdge[] };
  /** what the winning venue's fee schedule charged on the other side, by venue, cents per contract of the position */
  fees: { n: number; byVenue: VenueFee[] };
  /** how often each venue priced when asked, positions with route verdicts on the record */
  availability: { n: number; byVenue: VenueAvailability[] };
  /** markets the engine priced this week and declined: no venue could fund a worthwhile floor, or the market is not one we protect */
  refusals: { refused: number; offered: number; priced: number; refusedPct: number | null; byReason: Array<{ reason: RefusalReason; count: number }> };
  byLeague: LeagueCut[];
}

export interface VenueScoreboard {
  ok: true;
  at: string;
  live: true;
  /** what the table is, and is not, in one paragraph */
  methodology: string;
  /** false when the venues are lettered (Venue A, B, ...) rather than named: the public view (letterScoreboardVenues) */
  venuesNamed: boolean;
  venues: string[];
  /** each venue's fee schedule on the other side, as the engine folds it into that venue's book before routes are compared */
  feeRules: FeeRule[];
  weeks: ScoreboardWeek[];
}

export const SCOREBOARD_METHODOLOGY =
  "One row per week (Monday to Sunday, New York). A position is a locked single on a game market, or a parlay ticket priced at its last pick, each hedged leg for leg: the engine asks every venue it works with for the other side and takes the cheapest all in, venue fees and each venue's settlement rules included. Other side: which venue won, weighted by contracts. Edge: how much more the winning book paid the holder than the runner-up, where more than one venue priced; it is after each venue's fees. Fees: what the winning venue's schedule charged on the other side, cents per contract of the position, worked from the price the other side was bought at (the schedules are listed under feeRules). Availability: how often a venue priced at all when asked. Refusals: markets priced and declined because no venue could fund a worthwhile floor, or the market is not one we lock in. Taps are real holders' locks; the rest are the record's simulated positions at live prices. Nothing of the writer's book is in this table.";

interface Tally {
  n: number;
  contracts: number;
}

/** the venues a hedge can be bought on: every settlement venue but the member-sale one */
const HEDGE_SIDE_VENUES: readonly SettlementVenue[] = SETTLEMENT_VENUES.filter((v) => v !== "stx");

const venueTally = (): Record<SettlementVenue, Tally> => ({ kalshi: { n: 0, contracts: 0 }, polymarket: { n: 0, contracts: 0 }, prophetx: { n: 0, contracts: 0 }, novig: { n: 0, contracts: 0 }, stx: { n: 0, contracts: 0 } });

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function shares(t: Record<SettlementVenue, Tally>): VenueShare[] {
  const total = SETTLEMENT_VENUES.reduce((s, v) => s + t[v].contracts, 0);
  return SETTLEMENT_VENUES.filter((v) => t[v].n > 0)
    .map((v) => ({ venue: VENUE_NAMES[v], n: t[v].n, contracts: round2(t[v].contracts), sharePct: total > 0 ? round1((100 * t[v].contracts) / total) : 0 }))
    .sort((a, b) => b.contracts - a.contracts);
}

interface AvailTally {
  asked: number;
  priced: number;
}
const availTally = (): Record<SettlementVenue, AvailTally> => ({ kalshi: { asked: 0, priced: 0 }, polymarket: { asked: 0, priced: 0 }, prophetx: { asked: 0, priced: 0 }, novig: { asked: 0, priced: 0 }, stx: { asked: 0, priced: 0 } });

function availability(t: Record<SettlementVenue, AvailTally>): VenueAvailability[] {
  return SETTLEMENT_VENUES.filter((v) => t[v].asked > 0)
    .map((v) => ({ venue: VENUE_NAMES[v], asked: t[v].asked, priced: t[v].priced, pricedPct: t[v].asked > 0 ? round1((100 * t[v].priced) / t[v].asked) : null }))
    .sort((a, b) => b.asked - a.asked);
}

interface EdgeTally {
  n: number;
  edgeCentsPerContract: number[];
  edgeAllInBps: number[];
}
const edgeTally = (): Record<SettlementVenue, EdgeTally> => ({
  kalshi: { n: 0, edgeCentsPerContract: [], edgeAllInBps: [] },
  polymarket: { n: 0, edgeCentsPerContract: [], edgeAllInBps: [] },
  prophetx: { n: 0, edgeCentsPerContract: [], edgeAllInBps: [] },
  novig: { n: 0, edgeCentsPerContract: [], edgeAllInBps: [] },
  stx: { n: 0, edgeCentsPerContract: [], edgeAllInBps: [] },
});
const mean = (xs: number[]): number | null => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function edges(t: Record<SettlementVenue, EdgeTally>): VenueEdge[] {
  return SETTLEMENT_VENUES.filter((v) => t[v].n > 0)
    .map((v) => ({ venue: VENUE_NAMES[v], n: t[v].n, avgEdgeCentsPerContract: mean(t[v].edgeCentsPerContract), avgEdgeAllInBps: t[v].edgeAllInBps.length ? Math.round(t[v].edgeAllInBps.reduce((a, b) => a + b, 0) / t[v].edgeAllInBps.length) : null }))
    .sort((a, b) => b.n - a.n);
}

type FeeTally = number[];
const feeTally = (): Record<SettlementVenue, FeeTally> => ({ kalshi: [], polymarket: [], prophetx: [], novig: [], stx: [] });

function fees(t: Record<SettlementVenue, FeeTally>): VenueFee[] {
  return SETTLEMENT_VENUES.filter((v) => t[v].length > 0)
    .map((v) => ({ venue: VENUE_NAMES[v], n: t[v].length, avgFeeCentsPerContract: mean(t[v]) }))
    .sort((a, b) => b.n - a.n);
}

interface WeekAcc {
  from: string;
  n: number;
  taps: number;
  contracts: number;
  notionalCents: number;
  singles: Record<SettlementVenue, Tally> & { all: Tally };
  parlays: Record<SettlementVenue, Tally> & { all: Tally; unrouted: number };
  edge: Record<SettlementVenue, EdgeTally> & { n: number };
  fees: Record<SettlementVenue, FeeTally> & { n: number };
  avail: Record<SettlementVenue, AvailTally> & { n: number };
  refusals: RefusalEntry[];
  offered: number;
  leagues: Map<string, { n: number; contracts: number; otherSide: Record<SettlementVenue, Tally>; avail: Record<SettlementVenue, AvailTally> }>;
}

const newWeek = (from: string): WeekAcc => ({
  from,
  n: 0,
  taps: 0,
  contracts: 0,
  notionalCents: 0,
  singles: { ...venueTally(), all: { n: 0, contracts: 0 } },
  parlays: { ...venueTally(), all: { n: 0, contracts: 0 }, unrouted: 0 },
  edge: { ...edgeTally(), n: 0 },
  fees: { ...feeTally(), n: 0 },
  avail: { ...availTally(), n: 0 },
  refusals: [],
  offered: 0,
  leagues: new Map(),
});

function leagueOf(acc: WeekAcc, league: string) {
  const key = (league || "other").toLowerCase();
  let l = acc.leagues.get(key);
  if (!l) {
    l = { n: 0, contracts: 0, otherSide: venueTally(), avail: availTally() };
    acc.leagues.set(key, l);
  }
  return l;
}

/** The routing verdicts on a position, folded into the week's edge and availability tallies. */
function foldRouting(acc: WeekAcc, league: ReturnType<typeof leagueOf>, p: ShadowPosition): void {
  const routes = p.routing?.routes;
  if (!routes || routes.length === 0) return;
  acc.avail.n += 1;
  for (const r of routes) {
    acc.avail[r.hedgeVenue].asked += 1;
    league.avail[r.hedgeVenue].asked += 1;
    if (r.ok) {
      acc.avail[r.hedgeVenue].priced += 1;
      league.avail[r.hedgeVenue].priced += 1;
    }
  }
  if (p.route === "member_sale") return;
  const winner = hedgeVenueOf(p.route);
  const won = routes.find((r) => r.hedgeVenue === winner && r.ok);
  const others = routes.filter((r) => r.hedgeVenue !== winner && r.ok);
  if (!won || others.length === 0 || p.contracts <= 0) return;
  acc.edge.n += 1;
  acc.edge[winner].n += 1;
  if (won.creditCents !== null) {
    const runnerUp = Math.max(...others.map((r) => r.creditCents ?? -Infinity));
    if (Number.isFinite(runnerUp)) acc.edge[winner].edgeCentsPerContract.push((won.creditCents - runnerUp) / p.contracts);
  }
  if (won.allInBps !== null) {
    const runnerUp = Math.min(...others.map((r) => r.allInBps ?? Infinity));
    if (Number.isFinite(runnerUp)) acc.edge[winner].edgeAllInBps.push(runnerUp - won.allInBps);
  }
}

/** The winning venue's fee on a hedge, folded into the week's fee tally where it can be worked out. */
function foldFee(acc: WeekAcc, venue: SettlementVenue, h: HedgeForFee): void {
  const fee = venueFeeOnHedge(venue, h);
  if (fee === null) return;
  acc.fees.n += 1;
  acc.fees[venue].push(fee);
}

export interface ScoreboardInputs {
  positions: readonly ShadowPosition[];
  refusals: RefusalMap;
  tickets: readonly LastLegTicket[];
  now?: Date;
  /** how many weeks back from the current one, 1..26; default 8 */
  weeks?: number;
}

export function venueScoreboard(inp: ScoreboardInputs): VenueScoreboard {
  const now = inp.now ?? new Date();
  const weeksBack = Math.min(26, Math.max(1, Math.floor(inp.weeks ?? 8)));
  const thisMonday = weekMondayOf(now.getTime());
  const firstMonday = addDays(thisMonday, -7 * (weeksBack - 1));
  const acc = new Map<string, WeekAcc>();
  for (let i = 0; i < weeksBack; i++) {
    const m = addDays(firstMonday, 7 * i);
    acc.set(m, newWeek(m));
  }
  const weekFor = (iso: string): WeekAcc | null => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return acc.get(weekMondayOf(ms)) ?? null;
  };

  // singles: every position the record opened this week, by the venue that took the other side
  const onBook = new Set<string>();
  for (const p of inp.positions) {
    onBook.add(p.ticker);
    const w = weekFor(p.at);
    if (!w) continue;
    // a member's own sale on their venue took no other side anywhere: nothing for a venue column
    if (p.route === "member_sale") continue;
    const venue = hedgeVenueOf(p.route);
    w.n += 1;
    w.offered += 1;
    if (p.source === "lock") w.taps += 1;
    w.contracts += p.contracts;
    w.notionalCents += p.hedgeCostCents ?? 0;
    w.singles.all.n += 1;
    w.singles.all.contracts += p.contracts;
    w.singles[venue].n += 1;
    w.singles[venue].contracts += p.contracts;
    const l = leagueOf(w, p.kind === "crypto" ? "crypto" : p.league);
    l.n += 1;
    l.contracts += p.contracts;
    l.otherSide[venue].n += 1;
    l.otherSide[venue].contracts += p.contracts;
    foldRouting(w, l, p);
    foldFee(w, venue, { contracts: p.contracts, units: hedgeUnitsOf(p) / 1000, hedgeCostCents: p.hedgeCostCents, markCents: p.markCents, feesCents: p.feesCents });
  }

  // parlays: tickets priced at their last pick, by the venue the router sent the other side to
  for (const t of inp.tickets) {
    const q = t.quote;
    if (!q || !q.ok) continue;
    const w = weekFor(q.at);
    if (!w) continue;
    w.n += 1;
    w.contracts += q.contracts;
    w.notionalCents += q.hedgeCostCents ?? 0;
    w.parlays.all.n += 1;
    w.parlays.all.contracts += q.contracts;
    if (!q.route) {
      w.parlays.unrouted += 1;
      continue;
    }
    const venue = hedgeVenueOf(q.route);
    w.parlays[venue].n += 1;
    w.parlays[venue].contracts += q.contracts;
    const last = t.legs[t.legs.length - 1];
    const l = leagueOf(w, last?.league ?? "other");
    l.n += 1;
    l.contracts += q.contracts;
    l.otherSide[venue].n += 1;
    l.otherSide[venue].contracts += q.contracts;
    foldFee(w, venue, { contracts: q.contracts, units: (q.hedgeSharesMilli ?? 0) / 1000, hedgeCostCents: q.hedgeCostCents, markCents: q.markCents, feesCents: q.feesCents });
  }

  // refusals: a market priced and declined, placed in the week it was first refused; one the record later quoted is not a refusal
  for (const r of Object.values(inp.refusals)) {
    if (onBook.has(r.ticker)) continue;
    const w = weekFor(r.firstAt);
    if (w) w.refusals.push(r);
  }

  const weeks: ScoreboardWeek[] = [...acc.values()]
    .sort((a, b) => b.from.localeCompare(a.from))
    .map((w) => {
      const byReason = new Map<RefusalReason, number>();
      for (const r of w.refusals) byReason.set(refusalReason(r.code), (byReason.get(refusalReason(r.code)) ?? 0) + 1);
      const refused = w.refusals.length;
      const priced = refused + w.offered;
      const { all: sAll, ...sVen } = w.singles;
      const { all: pAll, unrouted, ...pVen } = w.parlays;
      const { n: eN, ...eVen } = w.edge;
      const { n: fN, ...fVen } = w.fees;
      const { n: aN, ...aVen } = w.avail;
      return {
        from: w.from,
        to: addDays(w.from, 6),
        label: weekLabel(w.from),
        n: w.n,
        taps: w.taps,
        contracts: round2(w.contracts),
        notionalCents: w.notionalCents,
        singles: { n: sAll.n, contracts: round2(sAll.contracts), otherSide: shares(sVen) },
        parlays: { n: pAll.n, contracts: round2(pAll.contracts), otherSide: shares(pVen), unrouted },
        edge: { n: eN, byVenue: edges(eVen) },
        fees: { n: fN, byVenue: fees(fVen) },
        availability: { n: aN, byVenue: availability(aVen) },
        refusals: {
          refused,
          offered: w.offered,
          priced,
          refusedPct: priced > 0 ? round1((100 * refused) / priced) : null,
          byReason: REFUSAL_REASON_ORDER.filter((r) => (byReason.get(r) ?? 0) > 0).map((r) => ({ reason: r, count: byReason.get(r) ?? 0 })),
        },
        byLeague: [...w.leagues.entries()]
          .map(([league, l]) => ({ league, n: l.n, contracts: round2(l.contracts), otherSide: shares(l.otherSide), availability: availability(l.avail) }))
          .sort((a, b) => b.n - a.n),
      };
    });

  return {
    ok: true,
    at: now.toISOString(),
    live: true,
    methodology: SCOREBOARD_METHODOLOGY,
    venuesNamed: true,
    // the venues that take the other side; a holder-only venue (a member's own sale) has no column
    venues: HEDGE_SIDE_VENUES.map((v) => VENUE_NAMES[v]),
    feeRules: HEDGE_SIDE_VENUES.map((v) => ({ venue: VENUE_NAMES[v], ...VENUE_FEE_RULES[v] })),
    weeks,
  };
}

/**
 * THE PUBLIC VIEW: THE SAME TABLE WITH THE VENUES LETTERED.
 *
 * A public page does not name the venues the other side is bought on. The scoreboard is the
 * hedger's comparison of those venues, so its public view keeps every figure and swaps each
 * name for a letter (Venue A, B, C, D: the same letters the demo's venue view uses, fixed per
 * venue so a letter means the same venue every week). The fee schedules are left out, since a
 * schedule's formula says whose it is; the fee column stays. The operator, and a service set to
 * name the venues (EVENT_X_NAME_HEDGE_VENUES=1), gets the table as venueScoreboard built it.
 *
 * Anything this function does not know as a venue is lettered too, as "Venue ?": a name is never
 * passed through because it was not on the list.
 */
export const SCOREBOARD_METHODOLOGY_LETTERED = SCOREBOARD_METHODOLOGY.replace(
  "(the schedules are listed under feeRules)",
  "(the schedules are left out of this view, as the venues' names are: each venue has a letter, the same one every week)",
);

export function letterScoreboardVenues(sb: VenueScoreboard): VenueScoreboard {
  const letterByName = new Map<string, string>(HEDGE_SIDE_VENUES.map((v, i) => [VENUE_NAMES[v], `Venue ${String.fromCharCode(65 + i)}`]));
  const letter = (name: string): string => letterByName.get(name) ?? "Venue ?";
  const re = <T extends { venue: string }>(rows: readonly T[]): T[] => rows.map((r) => ({ ...r, venue: letter(r.venue) }));
  return {
    ...sb,
    methodology: SCOREBOARD_METHODOLOGY_LETTERED,
    venuesNamed: false,
    venues: sb.venues.map(letter),
    feeRules: [],
    weeks: sb.weeks.map((w) => ({
      ...w,
      singles: { ...w.singles, otherSide: re(w.singles.otherSide) },
      parlays: { ...w.parlays, otherSide: re(w.parlays.otherSide) },
      edge: { ...w.edge, byVenue: re(w.edge.byVenue) },
      fees: { ...w.fees, byVenue: re(w.fees.byVenue) },
      availability: { ...w.availability, byVenue: re(w.availability.byVenue) },
      byLeague: w.byLeague.map((l) => ({ ...l, otherSide: re(l.otherSide), availability: re(l.availability) })),
    })),
  };
}

/**
 * The same table as CSV: one row per week and venue (singles share, parlays share, edge,
 * availability) and one `all` row per week with the totals and the refusals.
 */
export function venueScoreboardCsv(sb: VenueScoreboard): string {
  const head = [
    "week_from", "week_to", "week", "venue",
    "positions", "taps", "contracts", "other_side_notional_cents",
    "singles_won", "singles_contracts", "singles_share_pct",
    "parlays_won", "parlays_contracts", "parlays_share_pct",
    "edge_n", "avg_edge_cents_per_contract", "avg_edge_all_in_bps",
    "fee_n", "avg_fee_cents_per_contract",
    "asked", "priced", "priced_pct",
    "refused", "markets_priced", "refused_pct",
  ];
  const q = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const cell = (v: number | string | null | undefined): string => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : q(v));
  const rows: string[] = [head.join(",")];
  for (const w of sb.weeks) {
    rows.push(
      [w.from, w.to, w.label, "all", w.n, w.taps, w.contracts, w.notionalCents, w.singles.n, w.singles.contracts, 100, w.parlays.n, w.parlays.contracts, 100, w.edge.n, null, null, w.fees.n, null, w.availability.n, null, null, w.refusals.refused, w.refusals.priced, w.refusals.refusedPct]
        .map(cell)
        .join(","),
    );
    for (const venue of sb.venues) {
      const s = w.singles.otherSide.find((x) => x.venue === venue);
      const p = w.parlays.otherSide.find((x) => x.venue === venue);
      const e = w.edge.byVenue.find((x) => x.venue === venue);
      const f = w.fees.byVenue.find((x) => x.venue === venue);
      const a = w.availability.byVenue.find((x) => x.venue === venue);
      if (!s && !p && !e && !f && !a) continue;
      rows.push(
        [w.from, w.to, w.label, venue, null, null, null, null, s?.n ?? 0, s?.contracts ?? 0, s?.sharePct ?? 0, p?.n ?? 0, p?.contracts ?? 0, p?.sharePct ?? 0, e?.n ?? 0, e?.avgEdgeCentsPerContract ?? null, e?.avgEdgeAllInBps ?? null, f?.n ?? 0, f?.avgFeeCentsPerContract ?? null, a?.asked ?? 0, a?.priced ?? 0, a?.pricedPct ?? null, null, null, null]
          .map(cell)
          .join(","),
      );
    }
  }
  return rows.join("\n") + "\n";
}
