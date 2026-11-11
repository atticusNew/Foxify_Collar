/**
 * The holder's view: someone holds one side of a game on one venue and wants out. What does that
 * venue's own book pay, how deep is it, and does any other venue's book do better?
 *
 * Counted per reading (one side of one game in one snapshot) for every venue as the holder's
 * venue, split before the start and in play, by league. Unlike the page's other window figures
 * this is a running count kept in a small file beside the day files, so it covers every snapshot
 * since it began and not only the hours held in memory. It is derived data: the snapshots on
 * disk are the record, and this can be rebuilt from them.
 *
 * Per reading, for a holder of side s on venue H (all prices cents per $1 contract, fees as
 * stored with the snapshot):
 *   sale cost   = consensus(s) − H's all-in bid on s: what selling on H's own book gives up
 *                 against the venues' agreed price (half the spread, the fee, and any lean).
 *   saving      = H's own all-in ask on the other side − the cheapest all-in ask on the other
 *                 side on any venue: what the best book elsewhere beats H's own by.
 *   room        = 100 − that cheapest all-in ask − H's bid on s − H's fee to buy at that bid:
 *                 what is left if someone takes the holder's contract at H's bid, pays H's fee
 *                 on it, and buys the other side on the cheapest venue. Above zero, a bid
 *                 better than H's book locks after every fee; the room is the most it can add.
 * A reading is counted only while the game is open: the consensus on the side between 5¢ and
 * 95¢. Outside that the result is all but known and an exit is not the question.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { buyFeeCents, sellFeeCents, type FeeTerms } from "./analytics";
import type { HistoryCell, HistoryPoint } from "./store";
import { SIDES, VENUES, byVenue, type Side, type Venue } from "./types";

export const HOLDER_OPEN_MIN_CENTS = 5;
export const HOLDER_OPEN_MAX_CENTS = 95;
/** Bid depth thresholds counted, $1 contracts at the best level. */
export const HOLDER_DEPTHS = [100, 1_000, 10_000] as const;

export interface HolderTally {
  /** sides the venue showed a bid on while the game was open */
  readings: number;
  /** sides the venue listed with no bid: the holder could not sell there */
  noBid: number;
  /** sum over readings of consensus − all-in bid */
  saleCostSum: number;
  /** readings with an ask as well, and the sum of ask − bid over them */
  spreadN: number;
  spreadSum: number;
  /** readings with at least HOLDER_DEPTHS[i] contracts at the bid */
  depthAtLeast: number[];
  /** readings where this venue and at least one other quoted the other side */
  choice: number;
  /** of those, readings where another venue's other side was cheaper all in, and the sum of the savings */
  elsewhere: number;
  savingSum: number;
  /** of those, which venue was cheapest (this one included) */
  cheapest: Record<Venue, number>;
  /** readings where a better bid than this venue's had room after every fee, and the sum of the room */
  roomN: number;
  roomSum: number;
}

export type Phase = "pre" | "live";
export const PHASES: readonly Phase[] = ["pre", "live"];

export interface HolderState {
  v: 1;
  sinceMs: number | null;
  lastAtMs: number;
  snapshots: number;
  /** venue → league → phase */
  tallies: Partial<Record<Venue, Record<string, Record<Phase, HolderTally>>>>;
}

export const emptyTally = (): HolderTally => ({
  readings: 0,
  noBid: 0,
  saleCostSum: 0,
  spreadN: 0,
  spreadSum: 0,
  depthAtLeast: HOLDER_DEPTHS.map(() => 0),
  choice: 0,
  elsewhere: 0,
  savingSum: 0,
  cheapest: byVenue(() => 0),
  roomN: 0,
  roomSum: 0,
});

export const emptyState = (): HolderState => ({ v: 1, sinceMs: null, lastAtMs: 0, snapshots: 0, tallies: {} });

const feeOf = (c: HistoryCell): FeeTerms => ({ theta: c[4], gain: c[9], flat: c[10] });
const bidOf = (c: HistoryCell, s: Side): number => (s === "away" ? c[0] : c[2]);
const askOf = (c: HistoryCell, s: Side): number => (s === "away" ? c[1] : c[3]);
const bidQtyOf = (c: HistoryCell, s: Side): number => (s === "away" ? c[5] : c[7]) ?? 0;
const quoted = (ask: number): boolean => ask > 0 && ask < 100;
const otherSide = (s: Side): Side => (s === "away" ? "home" : "away");

/** The venues' de-vigged mids for a side, averaged: null with fewer than two venues two-sided on both sides. */
export function consensusOf(row: Partial<Record<Venue, HistoryCell>>, side: Side): number | null {
  const vals: number[] = [];
  for (const v of VENUES) {
    const c = row[v];
    if (!c || !(c[0] > 0 && quoted(c[1]) && c[2] > 0 && quoted(c[3]))) continue;
    const away = (c[0] + c[1]) / 2;
    const home = (c[2] + c[3]) / 2;
    vals.push(((side === "away" ? away : home) / (away + home)) * 100);
  }
  return vals.length >= 2 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function tallyOf(state: HolderState, venue: Venue, league: string, phase: Phase): HolderTally {
  const byLeague = (state.tallies[venue] ??= {});
  const byPhase = (byLeague[league] ??= { pre: emptyTally(), live: emptyTally() });
  return byPhase[phase];
}

/**
 * Fold one snapshot into the running count. A snapshot at or before the last one counted is
 * passed over, so the same history can be offered again (a boot reloads the window from disk).
 * Returns whether it was counted.
 */
export function addPoint(state: HolderState, point: HistoryPoint): boolean {
  if (!Number.isFinite(point.atMs) || point.atMs <= state.lastAtMs) return false;
  state.lastAtMs = point.atMs;
  state.snapshots += 1;
  if (state.sinceMs === null) state.sinceMs = point.atMs;
  for (const [key, row] of Object.entries(point.games)) {
    const league = key.split(":")[0];
    const start = point.starts?.[key];
    const phase: Phase = start !== undefined && start <= point.atMs ? "live" : "pre";
    for (const side of SIDES) {
      const fair = consensusOf(row, side);
      if (fair === null || fair < HOLDER_OPEN_MIN_CENTS || fair > HOLDER_OPEN_MAX_CENTS) continue;
      const o = otherSide(side);
      const asks: Array<[Venue, number]> = [];
      for (const v of VENUES) {
        const c = row[v];
        if (c && quoted(askOf(c, o))) asks.push([v, askOf(c, o) + buyFeeCents(feeOf(c), askOf(c, o))]);
      }
      const best = asks.length ? asks.reduce((x, y) => (y[1] < x[1] ? y : x)) : null;
      for (const venue of VENUES) {
        const c = row[venue];
        if (!c) continue;
        const t = tallyOf(state, venue, league, phase);
        const bid = bidOf(c, side);
        if (!(bid > 0)) {
          t.noBid += 1;
          continue;
        }
        const fee = feeOf(c);
        t.readings += 1;
        t.saleCostSum += fair - (bid - sellFeeCents(fee, bid));
        if (quoted(askOf(c, side))) {
          t.spreadN += 1;
          t.spreadSum += askOf(c, side) - bid;
        }
        const depth = bidQtyOf(c, side);
        HOLDER_DEPTHS.forEach((min, i) => {
          if (depth >= min) t.depthAtLeast[i] += 1;
        });
        const own = asks.find((x) => x[0] === venue);
        if (own && best && asks.length >= 2) {
          t.choice += 1;
          t.cheapest[best[0]] += 1;
          if (best[0] !== venue && own[1] - best[1] > 0) {
            t.elsewhere += 1;
            t.savingSum += own[1] - best[1];
          }
        }
        if (best) {
          const room = 100 - best[1] - bid - buyFeeCents(fee, bid);
          if (room > 1e-9) {
            t.roomN += 1;
            t.roomSum += room;
          }
        }
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

export interface HolderRow {
  venue: Venue;
  readings: number;
  noBid: number;
  /** mean consensus − all-in bid, cents */
  saleCostCents: number | null;
  meanSpreadCents: number | null;
  /** share of readings with at least HOLDER_DEPTHS[i] contracts at the bid, 0 to 1 */
  depthShare: number[];
  choice: number;
  /** share of `choice` where another venue's other side was cheaper, and the mean saving then */
  elsewhereShare: number | null;
  meanSavingCents: number | null;
  /** the venue most often cheapest over `choice`, with its share */
  cheapestMost: { venue: Venue; share: number } | null;
  /** share of readings where a better bid had room after every fee, and the mean room then */
  roomShare: number | null;
  meanRoomCents: number | null;
}

export interface HolderReport {
  sinceMs: number | null;
  lastAtMs: number;
  snapshots: number;
  /** every league together, per phase, a row per venue */
  all: Record<Phase, HolderRow[]>;
  /** league → phase → rows */
  byLeague: Record<string, Record<Phase, HolderRow[]>>;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

function addInto(into: HolderTally, t: HolderTally): void {
  into.readings += t.readings;
  into.noBid += t.noBid;
  into.saleCostSum += t.saleCostSum;
  into.spreadN += t.spreadN;
  into.spreadSum += t.spreadSum;
  t.depthAtLeast.forEach((n, i) => {
    into.depthAtLeast[i] = (into.depthAtLeast[i] ?? 0) + n;
  });
  into.choice += t.choice;
  into.elsewhere += t.elsewhere;
  into.savingSum += t.savingSum;
  for (const v of VENUES) into.cheapest[v] += t.cheapest[v] ?? 0;
  into.roomN += t.roomN;
  into.roomSum += t.roomSum;
}

export function rowOf(venue: Venue, t: HolderTally): HolderRow {
  const top = VENUES.reduce((a, v) => (t.cheapest[v] > t.cheapest[a] ? v : a), VENUES[0]);
  return {
    venue,
    readings: t.readings,
    noBid: t.noBid,
    saleCostCents: t.readings ? r2(t.saleCostSum / t.readings) : null,
    meanSpreadCents: t.spreadN ? r2(t.spreadSum / t.spreadN) : null,
    depthShare: HOLDER_DEPTHS.map((_, i) => (t.readings ? (t.depthAtLeast[i] ?? 0) / t.readings : 0)),
    choice: t.choice,
    elsewhereShare: t.choice ? t.elsewhere / t.choice : null,
    meanSavingCents: t.elsewhere ? r2(t.savingSum / t.elsewhere) : null,
    cheapestMost: t.choice && t.cheapest[top] > 0 ? { venue: top, share: t.cheapest[top] / t.choice } : null,
    roomShare: t.readings ? t.roomN / t.readings : null,
    meanRoomCents: t.roomN ? r2(t.roomSum / t.roomN) : null,
  };
}

export function holderReport(state: HolderState): HolderReport {
  const leagues = [...new Set(VENUES.flatMap((v) => Object.keys(state.tallies[v] ?? {})))].sort();
  const rows = (pick: (league: string) => boolean, phase: Phase): HolderRow[] =>
    VENUES.map((v) => {
      const sum = emptyTally();
      for (const [league, byPhase] of Object.entries(state.tallies[v] ?? {})) if (pick(league)) addInto(sum, byPhase[phase]);
      return rowOf(v, sum);
    });
  return {
    sinceMs: state.sinceMs,
    lastAtMs: state.lastAtMs,
    snapshots: state.snapshots,
    all: { pre: rows(() => true, "pre"), live: rows(() => true, "live") },
    byLeague: Object.fromEntries(leagues.map((l) => [l, { pre: rows((x) => x === l, "pre"), live: rows((x) => x === l, "live") }])),
  };
}

// ---------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------

/** A tally read from disk made whole: a venue added since the file was written starts at 0 in every count. */
function mended(raw: Partial<HolderTally> | undefined): HolderTally {
  const t = emptyTally();
  if (!raw || typeof raw !== "object") return t;
  for (const k of ["readings", "noBid", "saleCostSum", "spreadN", "spreadSum", "choice", "elsewhere", "savingSum", "roomN", "roomSum"] as const) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) t[k] = n;
  }
  HOLDER_DEPTHS.forEach((_, i) => {
    const n = Number(raw.depthAtLeast?.[i]);
    if (Number.isFinite(n)) t.depthAtLeast[i] = n;
  });
  for (const v of VENUES) {
    const n = Number(raw.cheapest?.[v]);
    if (Number.isFinite(n)) t.cheapest[v] = n;
  }
  return t;
}

/** The state as stored, or null when the text is not one this code wrote. Exported for tests. */
export function parseState(text: string): HolderState | null {
  try {
    const raw = JSON.parse(text) as Partial<HolderState>;
    if (raw?.v !== 1 || !Number.isFinite(Number(raw.lastAtMs)) || typeof raw.tallies !== "object" || raw.tallies === null) return null;
    const state = emptyState();
    state.sinceMs = Number.isFinite(Number(raw.sinceMs)) && raw.sinceMs !== null ? Number(raw.sinceMs) : null;
    state.lastAtMs = Number(raw.lastAtMs);
    state.snapshots = Number.isFinite(Number(raw.snapshots)) ? Number(raw.snapshots) : 0;
    for (const v of VENUES) {
      for (const [league, byPhase] of Object.entries(raw.tallies[v] ?? {})) {
        (state.tallies[v] ??= {})[league] = { pre: mended(byPhase?.pre), live: mended(byPhase?.live) };
      }
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * The running count and its file. `guard` is the store's guarded write: a write that fails (a
 * full disk) is reported on /healthz and the count carries on in memory.
 */
export class HolderRecord {
  private state: HolderState = emptyState();
  /** in words, when the file on disk could not be used */
  note = "";

  constructor(
    private readonly path: string,
    private readonly guard: (what: string, write: () => void) => boolean = (_what, write) => {
      write();
      return true;
    },
  ) {
    try {
      if (!existsSync(path)) return;
      const read = parseState(readFileSync(path, "utf8"));
      if (read) this.state = read;
      else this.note = "the holder count on disk could not be read; it starts again from the snapshots in the window";
    } catch (err) {
      this.note = `the holder count on disk could not be read (${(err as Error).message.slice(0, 100)}); it starts again from the snapshots in the window`;
    }
  }

  /** Fold the points not yet counted, oldest first, and write the file if any were. Returns how many were counted. */
  add(points: HistoryPoint[]): number {
    let n = 0;
    for (const p of points) if (addPoint(this.state, p)) n += 1;
    if (n) this.save();
    return n;
  }

  private save(): boolean {
    return this.guard("holder-count.json", () => {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.path);
    });
  }

  report(): HolderReport {
    return holderReport(this.state);
  }

  /** For /healthz: how far the count reaches, and in words when its file could not be used. */
  summary(): { snapshots: number; since: string | null; last: string | null; note?: string } {
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
    return { snapshots: this.state.snapshots, since: iso(this.state.sinceMs), last: iso(this.state.lastAtMs), ...(this.note ? { note: this.note } : {}) };
  }
}
