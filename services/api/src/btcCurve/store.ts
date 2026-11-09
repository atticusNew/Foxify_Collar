/**
 * Snapshot store: one JSONL file per UTC day on disk (append-only), a compact in-memory
 * history for the time-series views, and a retention sweep so a small disk lasts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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

/** What the time-series views need from one snapshot: mids per venue per bucket, spot, model. */
export interface HistoryPoint {
  at: string;
  atMs: number;
  spotUsd: number;
  /** ladderId → bucketKey → [kalshiBid, kalshiAsk, polyBid, polyAsk, modelP·100] (−1 when absent) */
  ladders: Record<string, Record<string, [number, number, number, number, number]>>;
  hourlyVol?: HourlyVolPoint;
}

export function toHistoryPoint(s: Snapshot): HistoryPoint {
  const ladders: HistoryPoint["ladders"] = {};
  for (const l of s.ladders) {
    const row: Record<string, [number, number, number, number, number]> = {};
    for (const b of l.buckets) {
      const k = l.quotes.find((q) => q.venue === "kalshi" && q.bucketKey === b.key);
      const p = l.quotes.find((q) => q.venue === "polymarket_us" && q.bucketKey === b.key);
      const m = l.model[b.key];
      row[b.key] = [k ? k.bidCents : -1, k ? k.askCents : -1, p ? p.bidCents : -1, p ? p.askCents : -1, m ? m.p * 100 : -1];
    }
    ladders[l.id] = row;
  }
  return { at: s.at, atMs: Date.parse(s.at), spotUsd: s.spotUsd, ladders, ...(s.hourlyVol ? { hourlyVol: s.hourlyVol } : {}) };
}

export class SnapshotStore {
  private readonly dir: string;
  private readonly keepMs: number;
  private readonly retainDays: number;
  private history: HistoryPoint[] = [];
  private latest: Snapshot | null = null;

  constructor(dir: string, opts: { keepHours?: number; retainDays?: number } = {}) {
    this.dir = dir;
    this.keepMs = (opts.keepHours ?? 72) * 3_600_000;
    this.retainDays = opts.retainDays ?? 21;
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(atMs: number): string {
    return join(this.dir, `snapshots-${new Date(atMs).toISOString().slice(0, 10)}.jsonl`);
  }

  /** Reload the in-memory history from the files that still fall inside the window. */
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
      const text = readFileSync(join(this.dir, f), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = fromDisk(line);
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
    if (last && !this.latest) this.latest = last;
    return points.length;
  }

  append(s: Snapshot): void {
    const atMs = Date.parse(s.at);
    appendFileSync(this.fileFor(atMs), `${toDisk(s)}\n`);
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

  /** Delete day files older than the retention window. Returns the names removed. */
  sweep(nowMs = Date.now()): string[] {
    if (!existsSync(this.dir)) return [];
    const removed: string[] = [];
    for (const f of readdirSync(this.dir)) {
      const m = /^snapshots-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const day = Date.parse(`${m[1]}T00:00:00Z`);
      if (nowMs - day > this.retainDays * 86_400_000) {
        unlinkSync(join(this.dir, f));
        removed.push(f);
      }
    }
    return removed;
  }
}
