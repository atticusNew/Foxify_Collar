/**
 * Snapshot store: one JSONL file per UTC day on disk (append-only) and a compact in-memory
 * history for the time-series views. Every day is kept unless a retention window is set; a day
 * that has closed is gzipped in place (see dayFiles.ts), and the boot reload reads either form.
 *
 * The service runs in 512 MB. A day file is a few hundred megabytes, so the reload reads it as
 * a stream, a line at a time, and the history keeps numbers in typed arrays and lets go of a
 * ladder once it has settled. The files on disk are the record and keep everything.
 */

import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { DayKeeper, listDayFiles, parseRetention, readLines, readablePath, type Budget, type DataHealth, type DayKeeperOptions, type MaintainReport, type Retention } from "./dayFiles";
import { expiryTagToMs } from "./deribitChain";
import type { Ladder, ModelPoint, OptionRow, Snapshot, VenueQuote, HourlyVolPoint } from "./types";

/** Option rows on disk: one tuple per instrument, expiry / strike / type come back from the name. */
type OptionTuple = [string, number, number, number, number, number, number];

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export function compactOptions(rows: OptionRow[]): OptionTuple[] {
  return rows.map((r) => [r.instrument, r4(r.markIv), r6(r.markPrice), r6(r.bidPrice), r6(r.askPrice), Math.round(r.forward * 100) / 100, Math.round(r.openInterest * 10) / 10]);
}

export function expandOptions(tuples: OptionTuple[]): OptionRow[] {
  const out: OptionRow[] = [];
  for (const t of tuples) {
    const parts = t[0].split("-");
    if (parts.length !== 4) continue;
    const type = parts[3] === "C" || parts[3] === "P" ? parts[3] : null;
    if (!type) continue;
    out.push({ instrument: t[0], expiry: parts[1], expiryMs: expiryTagToMs(parts[1]), strike: Number(parts[2]), type, markIv: t[1], markPrice: t[2], bidPrice: t[3], askPrice: t[4], forward: t[5], openInterest: t[6] });
  }
  return out;
}

type QuoteTuple = [VenueQuote["venue"], string, string, number, number, number, number, number, number, number];
type ModelTuple = [number, string, number];
type DiskLadder = Omit<Ladder, "quotes" | "model"> & { q: QuoteTuple[]; m: Record<string, ModelTuple> };

function compactLadder(l: Ladder): DiskLadder {
  const { quotes, model, ...rest } = l;
  const m: Record<string, ModelTuple> = {};
  for (const [k, v] of Object.entries(model)) m[k] = [Math.round(v.p * 1_000_000) / 1_000_000, v.expiry, r4(v.iv)];
  return { ...rest, q: quotes.map((x) => [x.venue, x.bucketKey, x.id, x.bidCents, x.askCents, Math.round(x.bidQty * 100) / 100, Math.round(x.askQty * 100) / 100, Math.round(x.volume), Math.round(x.openInterest), x.feeTheta]), m };
}

function expandLadder(d: DiskLadder | Ladder): Ladder {
  if ("quotes" in d && Array.isArray(d.quotes)) return d as Ladder;
  const { q, m, ...rest } = d as DiskLadder;
  const model: Record<string, ModelPoint> = {};
  for (const [k, v] of Object.entries(m)) model[k] = { p: v[0], expiry: v[1], iv: v[2] };
  return {
    ...rest,
    quotes: q.map((t) => ({ venue: t[0], bucketKey: t[1], id: t[2], bidCents: t[3], askCents: t[4], bidQty: t[5], askQty: t[6], volume: t[7], openInterest: t[8], feeTheta: t[9] })),
    model,
  };
}

/** Disk form of a snapshot (options and quotes as tuples). Exported for tests. */
export function toDisk(s: Snapshot): string {
  return JSON.stringify({ ...s, ladders: s.ladders.map(compactLadder), options: compactOptions(s.options) });
}

export function fromDisk(line: string): Snapshot {
  const raw = JSON.parse(line) as Omit<Snapshot, "options" | "ladders"> & { options: OptionTuple[] | OptionRow[]; ladders: Array<DiskLadder | Ladder> };
  const options = raw.options.length && Array.isArray(raw.options[0]) ? expandOptions(raw.options as OptionTuple[]) : (raw.options as OptionRow[]);
  return { ...raw, ladders: raw.ladders.map(expandLadder), options };
}

/** The five numbers the history keeps for one bucket, in this order; −1 when absent. */
export const ROW_WIDTH = 5;

/**
 * One ladder at one moment. `keys[i]` names a bucket and its numbers sit at `v[5·i]` onward:
 * kalshiBid, kalshiAsk, polyBid, polyAsk, modelP·100. One block of numbers per ladder costs a
 * third of what an object per bucket did, and the same list of keys is shared between the
 * points that hold the same buckets.
 */
export interface LadderRows {
  keys: readonly string[];
  v: Float64Array;
}

/** What the time-series views need from one snapshot: mids per venue per bucket, spot, model. */
export interface HistoryPoint {
  at: string;
  atMs: number;
  spotUsd: number;
  /** ladderId → that ladder's buckets and their numbers */
  ladders: Record<string, LadderRows>;
  hourlyVol?: HourlyVolPoint;
}

export interface HistoryPointOptions {
  /** leave a ladder out (the store leaves out one that settled over an hour before) */
  skip?: (l: Ladder) => boolean;
  /** hand back a list of keys already held for this ladder when it is the same list */
  share?: (ladderId: string, keys: string[]) => readonly string[];
}

export function toHistoryPoint(s: Snapshot, opts: HistoryPointOptions = {}): HistoryPoint {
  const ladders: HistoryPoint["ladders"] = {};
  for (const l of s.ladders) {
    if (opts.skip?.(l)) continue;
    // the first quote a venue gives for a bucket is the one kept, as before
    const kalshi = new Map<string, VenueQuote>();
    const poly = new Map<string, VenueQuote>();
    for (const q of l.quotes) {
      const by = q.venue === "kalshi" ? kalshi : q.venue === "polymarket_us" ? poly : null;
      if (by && !by.has(q.bucketKey)) by.set(q.bucketKey, q);
    }
    const keys = [...new Set(l.buckets.map((b) => b.key))];
    const v = new Float64Array(keys.length * ROW_WIDTH);
    keys.forEach((key, i) => {
      const k = kalshi.get(key);
      const p = poly.get(key);
      const m = l.model[key];
      v.set([k ? k.bidCents : -1, k ? k.askCents : -1, p ? p.bidCents : -1, p ? p.askCents : -1, m ? m.p * 100 : -1], i * ROW_WIDTH);
    });
    ladders[l.id] = { keys: opts.share ? opts.share(l.id, keys) : keys, v };
  }
  return { at: s.at, atMs: Date.parse(s.at), spotUsd: s.spotUsd, ladders, ...(s.hourlyVol ? { hourlyVol: s.hourlyVol } : {}) };
}

/** A ladder's rows stay in memory this long after it settles; after that no view can ask for them. */
export const SETTLED_GRACE_MS = 3_600_000;

const FAMILY = "snapshots";

export interface SnapshotStoreOptions {
  keepHours?: number;
  /** the retention rule as the service read it from its setting; wins over `retainDays` */
  retention?: Retention;
  /** a window in whole days; absent or null keeps every day */
  retainDays?: number | null;
  budget?: Budget;
  /** test seams, passed to the keeper */
  keeper?: Pick<DayKeeperOptions, "appendImpl" | "graceMs" | "compress">;
}

export class SnapshotStore {
  private readonly dir: string;
  private readonly keepMs: number;
  private readonly keeper: DayKeeper;
  private history: HistoryPoint[] = [];
  private latest: Snapshot | null = null;
  /** ladder id → the list of bucket keys its points share */
  private readonly keysOf = new Map<string, readonly string[]>();
  /** ladder id → when it settles, for the ladders that still have rows in memory */
  private readonly settles = new Map<string, number>();

  constructor(dir: string, opts: SnapshotStoreOptions = {}) {
    this.dir = dir;
    this.keepMs = (opts.keepHours ?? 72) * 3_600_000;
    this.keeper = new DayKeeper({ dir, families: [FAMILY], retention: opts.retention ?? parseRetention(opts.retainDays, "retainDays"), budget: opts.budget, ...(opts.keeper ?? {}) });
    mkdirSync(dir, { recursive: true });
  }

  /** The compact point for a snapshot, without the ladders that settled over an hour before `nowMs`. */
  private pointOf(s: Snapshot, nowMs: number): HistoryPoint {
    return toHistoryPoint(s, {
      skip: (l) => {
        const settlesMs = Date.parse(l.settlesAt);
        if (!Number.isFinite(settlesMs)) return false;
        if (nowMs - settlesMs > SETTLED_GRACE_MS) return true;
        this.settles.set(l.id, settlesMs);
        return false;
      },
      share: (id, keys) => {
        const held = this.keysOf.get(id);
        if (held && held.length === keys.length && held.every((k, i) => k === keys[i])) return held;
        this.keysOf.set(id, keys);
        return keys;
      },
    });
  }

  /** Let go of the rows of every ladder that settled over an hour before `nowMs`. The day files still hold them. */
  private dropSettled(nowMs: number): void {
    const gone: string[] = [];
    for (const [id, settlesMs] of this.settles) if (nowMs - settlesMs > SETTLED_GRACE_MS) gone.push(id);
    if (!gone.length) return;
    for (const h of this.history) for (const id of gone) if (id in h.ladders) delete h.ladders[id];
    for (const id of gone) {
      this.settles.delete(id);
      this.keysOf.delete(id);
    }
  }

  /**
   * Reload the in-memory history from the day files, plain or gzip, that still fall inside the
   * window. Each file is read as a stream, a line at a time, so a day never sits in memory
   * whole and the service answers while it reloads. A snapshot taken meanwhile is kept, once.
   */
  async load(nowMs = Date.now()): Promise<number> {
    let last: Snapshot | null = null;
    const points: HistoryPoint[] = [];
    for (const f of listDayFiles(this.dir, [FAMILY])) {
      if (nowMs - f.dayMs > this.keepMs + 86_400_000) continue;
      const path = readablePath(f);
      // a day counts whole or not at all: one that breaks half way through adds nothing
      const day: HistoryPoint[] = [];
      let dayLast: Snapshot | null = null;
      try {
        for await (const line of readLines(path)) {
          try {
            const s = fromDisk(line);
            const atMs = Date.parse(s.at);
            if (!Number.isFinite(atMs) || nowMs - atMs > this.keepMs) continue;
            day.push(this.pointOf(s, nowMs));
            dayLast = s;
          } catch {
            // a torn last line after a crash is not worth failing the boot over
          }
        }
        for (const p of day) points.push(p);
        if (dayLast) last = dayLast;
        this.keeper.note(`load:${path}`, null);
      } catch (err) {
        // a day that cannot be read is left on disk and said on /healthz; the boot goes on with the others
        this.keeper.note(`load:${path}`, `${basename(path)} could not be read on start-up (${(err as Error).message.slice(0, 120)}); it is left on disk and is not in the window`);
      }
    }
    const read = new Set(points.map((p) => p.atMs));
    const meanwhile = this.history.filter((p) => !read.has(p.atMs) && nowMs - p.atMs <= this.keepMs);
    this.history = meanwhile.length ? [...points, ...meanwhile].sort((a, b) => a.atMs - b.atMs) : points;
    if (last && !this.latest) this.latest = last;
    return points.length;
  }

  /**
   * Keep the snapshot in memory and append it to its day file. A write that fails (a full disk)
   * does not throw: the page keeps the snapshot, and `dataHealth()` says it is not on disk.
   */
  append(s: Snapshot): boolean {
    const atMs = Date.parse(s.at);
    const written = this.keeper.append(FAMILY, atMs, toDisk(s));
    this.latest = s;
    this.history.push(this.pointOf(s, atMs));
    const cutoff = atMs - this.keepMs;
    while (this.history.length && this.history[0].atMs < cutoff) this.history.shift();
    this.dropSettled(atMs);
    return written;
  }

  getLatest(): Snapshot | null {
    return this.latest;
  }

  getHistory(): HistoryPoint[] {
    return this.history;
  }

  /** Delete day files outside the retention window; with no window, nothing. Returns the names removed. */
  sweep(nowMs = Date.now()): string[] {
    return this.keeper.sweep(nowMs);
  }

  /** The hourly pass, off the cycle: the retention sweep and at most one closed day gzipped. */
  maintain(nowMs = Date.now()): Promise<MaintainReport> {
    return this.keeper.maintain(nowMs);
  }

  /** A write beside the day files (the replay state, the since marker): a filesystem failure is recorded, not thrown. */
  guardWrite(what: string, write: () => void): boolean {
    return this.keeper.guard(what, write);
  }

  dataHealth(nowMs = Date.now()): DataHealth {
    return this.keeper.health(nowMs);
  }

  startupLine(nowMs = Date.now()): string {
    return this.keeper.startupLine(nowMs);
  }
}
