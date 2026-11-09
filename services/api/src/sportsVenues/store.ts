/**
 * Snapshots on disk, one JSONL file per UTC day; a rolling in-memory history of compact points
 * for the time-series sections. Same shape of store as the BTC page's.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot, Venue } from "./types";

/** [awayBid, awayAsk, homeBid, homeAsk, feeTheta, awayBidQty, awayAskQty, homeBidQty, homeAskQty] */
export type HistoryCell = [number, number, number, number, number, number, number, number, number];

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
      row[l.venue] = [l.away.bidCents, l.away.askCents, l.home.bidCents, l.home.askCents, l.feeTheta, l.away.bidQty, l.away.askQty, l.home.bidQty, l.home.askQty];
    }
    games[g.key] = row;
    const ms = Date.parse(g.startsAt);
    if (g.startSource === "venue" && Number.isFinite(ms)) starts[g.key] = ms;
  }
  return { at: s.at, atMs: Date.parse(s.at), games, starts };
}

export class SnapshotStore {
  private readonly keepMs: number;
  private readonly retainDays: number;
  private history: HistoryPoint[] = [];
  private latest: Snapshot | null = null;

  constructor(
    private readonly dir: string,
    opts: { keepHours?: number; retainDays?: number } = {},
  ) {
    this.keepMs = (opts.keepHours ?? 72) * 3_600_000;
    this.retainDays = opts.retainDays ?? 21;
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(atMs: number): string {
    return join(this.dir, `snapshots-${new Date(atMs).toISOString().slice(0, 10)}.jsonl`);
  }

  load(nowMs = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    const files = readdirSync(this.dir)
      .filter((f) => /^snapshots-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    let last: Snapshot | null = null;
    const points: HistoryPoint[] = [];
    for (const f of files) {
      const day = Date.parse(`${f.slice(10, 20)}T00:00:00Z`);
      if (nowMs - day > this.keepMs + 86_400_000) continue;
      for (const line of readFileSync(join(this.dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as Snapshot;
          const atMs = Date.parse(s.at);
          if (!Number.isFinite(atMs) || nowMs - atMs > this.keepMs) continue;
          points.push(toHistoryPoint(s));
          last = s;
        } catch {
          // a torn last line after a crash is not worth failing the boot over
        }
      }
    }
    this.history = points;
    if (last) this.latest = last;
    return points.length;
  }

  append(s: Snapshot): void {
    const atMs = Date.parse(s.at);
    appendFileSync(this.fileFor(atMs), `${JSON.stringify(s)}\n`);
    this.latest = s;
    this.history.push(toHistoryPoint(s));
    const cutoff = atMs - this.keepMs;
    while (this.history.length && this.history[0].atMs < cutoff) this.history.shift();
  }

  getLatest(): Snapshot | null {
    return this.latest;
  }

  getHistory(): HistoryPoint[] {
    return this.history;
  }

  /** Delete day files older than the retention. */
  sweep(nowMs = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) {
      const m = /^snapshots-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      if (nowMs - Date.parse(`${m[1]}T00:00:00Z`) > this.retainDays * 86_400_000) {
        unlinkSync(join(this.dir, f));
        n += 1;
      }
    }
    return n;
  }
}
