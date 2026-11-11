/**
 * Snapshots on disk, one JSONL file per UTC day; a rolling in-memory history of compact points
 * for the time-series sections. Same shape of store as the BTC page's, and the same keeping of
 * the files: every day kept unless a window is set, closed days gzipped, either form read on
 * boot (src/btcCurve/dayFiles.ts).
 */

import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { DayKeeper, listDayFiles, parseRetention, readLines, readablePath, type Budget, type DataHealth, type DayKeeperOptions, type MaintainReport, type Retention } from "../btcCurve/dayFiles";
import type { Snapshot, Venue } from "./types";

/** [awayBid, awayAsk, homeBid, homeAsk, feeTheta, awayBidQty, awayAskQty, homeBidQty, homeAskQty, feeGain (only when the venue charges on winnings)] */
export type HistoryCell = [number, number, number, number, number, number, number, number, number, number?];

export interface HistoryPoint {
  at: string;
  atMs: number;
  /** game key → venue → cell */
  games: Record<string, Partial<Record<Venue, HistoryCell>>>;
  /** game key → start instant, ms */
  starts: Record<string, number>;
}

export function toHistoryPoint(s: Snapshot): HistoryPoint {
  const games: HistoryPoint["games"] = {};
  const starts: HistoryPoint["starts"] = {};
  for (const g of s.games) {
    const row: Partial<Record<Venue, HistoryCell>> = {};
    for (const l of g.listings) {
      row[l.venue] = [l.away.bidCents, l.away.askCents, l.home.bidCents, l.home.askCents, l.feeTheta, l.away.bidQty, l.away.askQty, l.home.bidQty, l.home.askQty, ...(l.feeGain ? [l.feeGain] : [])] as HistoryCell;
    }
    games[g.key] = row;
    const ms = Date.parse(g.startsAt);
    if (g.startSource === "venue" && Number.isFinite(ms)) starts[g.key] = ms;
  }
  return { at: s.at, atMs: Date.parse(s.at), games, starts };
}

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
  private readonly keepMs: number;
  private readonly keeper: DayKeeper;
  private history: HistoryPoint[] = [];
  private latest: Snapshot | null = null;

  constructor(
    private readonly dir: string,
    opts: SnapshotStoreOptions = {},
  ) {
    this.keepMs = (opts.keepHours ?? 72) * 3_600_000;
    this.keeper = new DayKeeper({ dir, families: [FAMILY], retention: opts.retention ?? parseRetention(opts.retainDays, "retainDays"), budget: opts.budget, ...(opts.keeper ?? {}) });
    mkdirSync(dir, { recursive: true });
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
            const s = JSON.parse(line) as Snapshot;
            const atMs = Date.parse(s.at);
            if (!Number.isFinite(atMs) || nowMs - atMs > this.keepMs) continue;
            day.push(toHistoryPoint(s));
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
    if (last && (!this.latest || Date.parse(this.latest.at) < Date.parse(last.at))) this.latest = last;
    return points.length;
  }

  /**
   * Keep the snapshot in memory and append it to its day file. A write that fails (a full disk)
   * does not throw: the page keeps the snapshot, and `dataHealth()` says it is not on disk.
   */
  append(s: Snapshot): boolean {
    const atMs = Date.parse(s.at);
    const written = this.keeper.append(FAMILY, atMs, JSON.stringify(s));
    this.latest = s;
    this.history.push(toHistoryPoint(s));
    const cutoff = atMs - this.keepMs;
    while (this.history.length && this.history[0].atMs < cutoff) this.history.shift();
    return written;
  }

  getLatest(): Snapshot | null {
    return this.latest;
  }

  getHistory(): HistoryPoint[] {
    return this.history;
  }

  /** Delete day files outside the retention window; with no window, nothing. Returns how many were removed. */
  sweep(nowMs = Date.now()): number {
    return this.keeper.sweep(nowMs).length;
  }

  /** The hourly pass, off the cycle: the retention sweep and at most one closed day gzipped. */
  maintain(nowMs = Date.now()): Promise<MaintainReport> {
    return this.keeper.maintain(nowMs);
  }

  /** A write beside the day files (the since marker): a filesystem failure is recorded, not thrown. */
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
