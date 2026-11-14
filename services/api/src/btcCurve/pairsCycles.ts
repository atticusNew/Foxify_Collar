/**
 * One line of the pairs cycle file (`gaps-YYYY-MM-DD.jsonl`): what it holds, how it is written
 * and how it is read back. No I/O here.
 *
 * The first form of a line was `{ at, rows }`: the cycle's start and, for each pair whose read
 * was not stale, `[settlesAt, key, gapCents]`. It was written to rebuild the persistence window
 * on a restart and holds nothing else: no prices, no sizes, no fees, no read ages. A cycle with
 * no such pair wrote no line at all.
 *
 * A line now also carries `v: 2`, `pricedAt`, `intervalSec`, `spotUsd` and `pairs`: every pair
 * the cycle priced, with both tops of book, the fee coefficients and how old each read was.
 * That is what a replay needs to price a trade on a later cycle. `at` and `rows` are written
 * exactly as before and mean what they meant, so the restart reload reads old and new lines
 * alike, and a line is written every cycle, pairs or not, so a missing line is a missed cycle.
 *
 * Fields are only ever added. A line that was written is never rewritten, and nothing is
 * filled in for an old line: a reader is told it is old and what it cannot say.
 */

import type { Horizon, HorizonSet, Place, StrikePair, PairLeg } from "./pairs";
import type { Venue } from "./types";

/** One venue's top of book as the cycle priced it. Prices in cents, sizes in contracts. */
export interface StoredLeg {
  /** the venue's own id (Kalshi ticker / Polymarket US market slug) */
  id: string;
  bidCents: number;
  askCents: number;
  bidQty: number;
  askQty: number;
  /** taker fee coefficient the venue published for this market */
  feeTheta: number;
  /** how old the copy that was priced was, seconds: fetchAgeSec plus cacheAgeSec. Null when the quote did not come from a book read. */
  ageSec: number | null;
  /** seconds from the venue's answer to the pricing, our clock */
  fetchAgeSec: number | null;
  /** seconds the venue's cache said it had held the answer; null when it did not say */
  cacheAgeSec: number | null;
  /** seconds from the venue's own stamp on the book to the pricing; null without a stamp */
  venueAgeSec: number | null;
}

export interface StoredPair {
  horizon: Horizon;
  place: Place;
  strike: number;
  key: string;
  settlesAt: string;
  /** the bound the collector judged this row's reads against, seconds */
  staleAfterSec: number;
  /** null when the venue lists no such contract or its book did not answer */
  kalshi: StoredLeg | null;
  poly: StoredLeg | null;
  /** books that did not answer this cycle; that venue's leg is null */
  errors?: Array<{ venue: Venue; kind: string }>;
}

export interface StoredCycle {
  /** the cycle's start, ms; the day file is the UTC day of this */
  at: number;
  /** `[settlesAt, key, gapCents]` for each pair with a gap on a read that was not stale */
  rows: Array<[string, string, number]>;
  v: 2;
  /** when the books were in and the pairs priced, ms; every read age is measured to this */
  pricedAt: number;
  /** the collector's cadence, seconds */
  intervalSec: number;
  /** the BRTI print the strikes were chosen around */
  spotUsd: number;
  pairs: StoredPair[];
}

function storedLegOf(leg: PairLeg | null): StoredLeg | null {
  if (!leg) return null;
  const r = leg.read;
  return {
    id: leg.id,
    bidCents: leg.bidCents,
    askCents: leg.askCents,
    bidQty: leg.bidQty,
    askQty: leg.askQty,
    feeTheta: leg.feeTheta,
    ageSec: r ? r.ageSec : null,
    fetchAgeSec: r ? r.fetchAgeSec : null,
    cacheAgeSec: r ? r.cacheAgeSec : null,
    venueAgeSec: r ? r.venueAgeSec : null,
  };
}

export function storedPairOf(p: StrikePair): StoredPair {
  const out: StoredPair = {
    horizon: p.horizon,
    place: p.place,
    strike: p.strike,
    key: p.key,
    settlesAt: p.settlesAt,
    staleAfterSec: p.staleAfterSec,
    kalshi: storedLegOf(p.kalshi),
    poly: storedLegOf(p.poly),
  };
  if (p.errors.length) out.errors = p.errors.map((e) => ({ venue: e.venue, kind: e.kind }));
  return out;
}

/** The line for one cycle. `rows` is what the persistence window keeps; `pairs` is every pair priced. */
export function storedCycleOf(sets: Array<HorizonSet | null>, at: { atMs: number; pricedAtMs: number; intervalSec: number; spotUsd: number }): StoredCycle {
  const pairs = sets.flatMap((s) => s?.pairs ?? []);
  return {
    at: at.atMs,
    // what recordGaps kept, so a restart reloads the same window: gaps on stale reads are not persistence
    rows: pairs.filter((p) => p.gapCents !== null && p.freshness !== "stale").map((p) => [p.settlesAt, p.key, p.gapCents as number]),
    v: 2,
    pricedAt: at.pricedAtMs,
    intervalSec: at.intervalSec,
    spotUsd: at.spotUsd,
    pairs: pairs.map(storedPairOf),
  };
}

/**
 * A line read back. `cycle` has everything a replay needs. `old` is a line of the first form:
 * it is a cycle that happened, and nothing more can be said from it. `unreadable` is anything
 * else (a torn line, a pair with a field missing); it is never repaired.
 */
export type ParsedCycleLine = { kind: "cycle"; cycle: StoredCycle } | { kind: "old"; atMs: number } | { kind: "unreadable"; why: string };

const HORIZONS: readonly string[] = ["fifteen", "hourly", "daily"];
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const numOrNull = (x: unknown): x is number | null => x === null || num(x);

function legProblem(x: unknown): string | null {
  if (x === null) return null;
  if (typeof x !== "object") return "a leg is not an object";
  const l = x as Record<string, unknown>;
  if (typeof l.id !== "string" || !l.id) return "a leg has no id";
  for (const f of ["bidCents", "askCents", "bidQty", "askQty", "feeTheta"]) if (!num(l[f]) || (l[f] as number) < 0) return `a leg's ${f} is not a number`;
  for (const f of ["ageSec", "fetchAgeSec", "cacheAgeSec", "venueAgeSec"]) if (!numOrNull(l[f])) return `a leg's ${f} is not a number or null`;
  return null;
}

function pairProblem(x: unknown): string | null {
  if (!x || typeof x !== "object") return "a pair is not an object";
  const p = x as Record<string, unknown>;
  if (typeof p.horizon !== "string" || !HORIZONS.includes(p.horizon)) return "a pair's horizon is not one of fifteen, hourly, daily";
  if (typeof p.key !== "string" || !p.key) return "a pair has no key";
  if (typeof p.settlesAt !== "string" || !Number.isFinite(Date.parse(p.settlesAt))) return "a pair's settlesAt is not a time";
  if (!num(p.strike)) return "a pair's strike is not a number";
  if (!num(p.staleAfterSec) || p.staleAfterSec <= 0) return "a pair's staleAfterSec is not a positive number";
  if (p.kalshi === undefined || p.poly === undefined) return "a pair is missing a leg field";
  if (p.errors !== undefined && !Array.isArray(p.errors)) return "a pair's errors is not a list";
  return legProblem(p.kalshi) ?? legProblem(p.poly);
}

export function parseCycleLine(line: string): ParsedCycleLine {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return { kind: "unreadable", why: "not JSON" };
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { kind: "unreadable", why: "not an object" };
  const r = rec as Record<string, unknown>;
  if (!num(r.at)) return { kind: "unreadable", why: "no cycle time" };
  if (r.pairs === undefined) return Array.isArray(r.rows) ? { kind: "old", atMs: r.at } : { kind: "unreadable", why: "neither rows nor pairs" };
  if (!Array.isArray(r.pairs)) return { kind: "unreadable", why: "pairs is not a list" };
  if (!num(r.pricedAt)) return { kind: "unreadable", why: "no pricedAt" };
  if (!num(r.intervalSec) || r.intervalSec <= 0) return { kind: "unreadable", why: "no intervalSec" };
  for (const p of r.pairs) {
    const why = pairProblem(p);
    if (why) return { kind: "unreadable", why };
  }
  return { kind: "cycle", cycle: rec as StoredCycle };
}
