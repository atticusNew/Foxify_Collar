/**
 * The I/O beside pairsReplay.ts: reads the pairs cycle day files (plain or gzip) as a stream
 * and feeds the lines to one replay per rule, so several lags share one pass over the disk.
 * Also what the CLI and the /pairs/api/replay route share: reading a request into rules, the
 * caps, and the plain-text table.
 *
 * Read-only. A day that exists in both forms is read from the `.jsonl` (dayFiles.ts). The
 * read gives the event loop back every few hundred lines, so a replay inside the collector's
 * process does not hold up a cycle. A request over its caps is refused in plain words, never
 * trimmed to fit.
 */

import { basename } from "node:path";
import { listDayFiles, readLines, readablePath, utcDay } from "./dayFiles";
import type { Horizon } from "./pairs";
import { parseCycleLine } from "./pairsCycles";
import { ASSUMPTIONS, DEFAULT_RULE, createReplay, ruleProblem, type ReplayResult, type ReplayRule, type ReplaySummary } from "./pairsReplay";

/** The family name of the cycle files in the pairs data dir. */
export const CYCLE_FAMILY = "gaps";

/** A request the replay will not run, with the reason in plain words. */
export class ReplayRefused extends Error {}

export interface ReplayDaysOptions {
  dir: string;
  /** first and last UTC day to read, YYYY-MM-DD, inclusive; unset is open-ended */
  fromDay?: string;
  toDay?: string;
  rules: ReplayRule[];
  /** trades listed per rule */
  keepTrades?: number;
  /** lines between handing the event loop back */
  yieldEveryLines?: number;
  /** refuse once more lines than this have been read */
  maxLines?: number;
  /** refuse once the read has taken longer than this */
  maxMs?: number;
  /** test seam */
  clock?: () => number;
}

export interface ReplayFileRead {
  file: string;
  day: string;
  lines: number;
  /** set when the file could not be read to its end; what was read before the break is kept */
  error?: string;
}

export interface ReplayRun {
  fromDay: string | null;
  toDay: string | null;
  files: ReplayFileRead[];
  linesRead: number;
  ms: number;
  /** what the files could not give, in plain words */
  notes: string[];
  /** one result per rule, in the order given */
  results: ReplayResult[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s: string): boolean => DAY.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && utcDay(Date.parse(`${s}T00:00:00Z`)) === s;

export async function replayDays(opts: ReplayDaysOptions): Promise<ReplayRun> {
  for (const d of [opts.fromDay, opts.toDay]) if (d !== undefined && !isDay(d)) throw new ReplayRefused(`"${d}" is not a day. Write it as YYYY-MM-DD.`);
  if (opts.fromDay && opts.toDay && opts.fromDay > opts.toDay) throw new ReplayRefused(`The first day (${opts.fromDay}) is after the last day (${opts.toDay}).`);
  if (!opts.rules.length) throw new ReplayRefused("No rule was given.");
  for (const rule of opts.rules) {
    const problem = ruleProblem(rule);
    if (problem) throw new ReplayRefused(problem);
  }
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const every = Math.max(1, opts.yieldEveryLines ?? 250);
  const replays = opts.rules.map((rule) => createReplay(rule, { keepTrades: opts.keepTrades }));
  const files: ReplayFileRead[] = [];
  const notes: string[] = [];
  let linesRead = 0;

  const wanted = listDayFiles(opts.dir, [CYCLE_FAMILY]).filter((f) => (!opts.fromDay || f.day >= opts.fromDay) && (!opts.toDay || f.day <= opts.toDay));
  for (const f of wanted) {
    const path = readablePath(f);
    const read: ReplayFileRead = { file: basename(path), day: f.day, lines: 0 };
    files.push(read);
    try {
      for await (const line of readLines(path)) {
        linesRead += 1;
        read.lines += 1;
        if (opts.maxLines !== undefined && linesRead > opts.maxLines) {
          throw new ReplayRefused(`This range holds more than ${opts.maxLines} stored cycles, which is more than one request reads. Ask for fewer days, or run the command-line replay (scripts/btcPairsReplay.ts), which has no such limit.`);
        }
        const parsed = parseCycleLine(line);
        for (const r of replays) r.push(parsed, f.day);
        if (linesRead % every === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (opts.maxMs !== undefined && clock() - t0 > opts.maxMs) {
            throw new ReplayRefused(`This range took longer than ${Math.round(opts.maxMs / 1000)} seconds to read and was stopped. Ask for fewer days, or run the command-line replay (scripts/btcPairsReplay.ts).`);
          }
        }
      }
    } catch (err) {
      if (err instanceof ReplayRefused) throw err;
      read.error = (err as Error).message.slice(0, 160);
      notes.push(`${read.file} could not be read to its end (${read.error}). ${read.lines} lines were read before the break; the rest of that day is missing, and a trade waiting on it is unknown.`);
    }
  }
  if (!wanted.length) notes.push(`No cycle files (${CYCLE_FAMILY}-YYYY-MM-DD.jsonl or .jsonl.gz) for ${rangeWords(opts.fromDay, opts.toDay)} in the data dir.`);
  return { fromDay: opts.fromDay ?? wanted[0]?.day ?? null, toDay: opts.toDay ?? wanted[wanted.length - 1]?.day ?? null, files, linesRead, ms: clock() - t0, notes, results: replays.map((r) => r.result()) };
}

function rangeWords(from?: string, to?: string): string {
  if (from && to) return from === to ? from : `${from} to ${to}`;
  if (from) return `${from} onward`;
  if (to) return `days up to ${to}`;
  return "any day";
}

/* ---- a request, as the CLI flags and the route's query both give it ---- */

export interface ReplayCaps {
  maxLags: number;
  maxLagSec: number;
  /** the route only: the most days back one request reads */
  maxDays?: number;
}

export interface ReplayRequest {
  rules: ReplayRule[];
  /** days back from today, today included; null when the caller gave none */
  days: number | null;
}

const NUMBER = /^[0-9]+(\.[0-9]+)?$/;
const WHOLE = /^[0-9]+$/;
const TENORS: Record<string, Horizon> = { "15m": "fifteen", fifteen: "fifteen", "1h": "hourly", hourly: "hourly", "1d": "daily", daily: "daily" };

/**
 * Read `edge`, `size`, `trade`, `lag`, `age`, `horizons`, `tolerance` and `days` into one rule
 * per lag. A value that is there but cannot be read is refused, not replaced by the default;
 * a value over a cap is refused, not lowered to it.
 */
export function replayRequestFrom(get: (name: string) => string | null | undefined, caps: ReplayCaps): ReplayRequest {
  const text = (name: string): string | null => {
    const v = get(name);
    return v === null || v === undefined || v.trim() === "" ? null : v.trim();
  };
  const number = (name: string, what: string, fallback: number): number => {
    const v = text(name);
    if (v === null) return fallback;
    if (!NUMBER.test(v)) throw new ReplayRefused(`${what} (${name}) is "${v}", which is not a number.`);
    return Number(v);
  };
  const count = (name: string, what: string, fallback: number): number => {
    const v = text(name);
    if (v === null) return fallback;
    if (!WHOLE.test(v) || !Number.isSafeInteger(Number(v))) throw new ReplayRefused(`${what} (${name}) is "${v}", which is not a whole number.`);
    return Number(v);
  };

  const minEdgeCents = number("edge", "The minimum edge in cents", DEFAULT_RULE.minEdgeCents);
  const minSizeContracts = count("size", "The size in contracts", DEFAULT_RULE.minSizeContracts);
  const sizeContracts = count("trade", "The size traded in contracts", minSizeContracts);
  const maxReadAgeSec = number("age", "The maximum read age in seconds", DEFAULT_RULE.maxReadAgeSec);
  const gapToleranceSec = number("tolerance", "The gap tolerance in seconds", DEFAULT_RULE.gapToleranceSec);

  const lagText = text("lag");
  const lagSecs = lagText === null ? [DEFAULT_RULE.lagSec] : lagText.split(",").map((s) => {
    const l = s.trim();
    if (!NUMBER.test(l)) throw new ReplayRefused(`A lag (lag) is "${l}", which is not a number of seconds. Write lags as a list, for example 0,10,30.`);
    return Number(l);
  });
  if (lagSecs.length > caps.maxLags) throw new ReplayRefused(`${lagSecs.length} lags were asked for; one request takes at most ${caps.maxLags}.`);
  if (new Set(lagSecs).size !== lagSecs.length) throw new ReplayRefused("A lag is given twice.");
  for (const l of lagSecs) if (l > caps.maxLagSec) throw new ReplayRefused(`A lag of ${l} seconds is over the limit of ${caps.maxLagSec}.`);

  const tenorText = text("horizons");
  const horizons = tenorText === null ? [...DEFAULT_RULE.horizons] : tenorText.split(",").map((s) => {
    const h = TENORS[s.trim().toLowerCase()];
    if (!h) throw new ReplayRefused(`"${s.trim()}" is not a tenor. Use 15m, 1h or 1d.`);
    return h;
  });

  let days: number | null = null;
  if (text("days") !== null) {
    days = count("days", "The number of days", 1);
    if (days < 1) throw new ReplayRefused("The number of days (days) must be 1 or more.");
    if (caps.maxDays !== undefined && days > caps.maxDays) throw new ReplayRefused(`${days} days were asked for; one request reads at most ${caps.maxDays}. Run the command-line replay (scripts/btcPairsReplay.ts) for a longer range.`);
  }

  const rules = lagSecs.map((lagSec) => ({ minEdgeCents, minSizeContracts, sizeContracts, lagSec, maxReadAgeSec, horizons, gapToleranceSec }));
  for (const rule of rules) {
    const problem = ruleProblem(rule);
    if (problem) throw new ReplayRefused(problem);
  }
  return { rules, days };
}

/** The first of `days` UTC days ending today. */
export function firstDayOf(days: number, nowMs: number): string {
  return utcDay(nowMs - (days - 1) * 86_400_000);
}

/* ---- the plain-text table ---- */

/** Integer milli-cents as cents, exact: 1234567 is "1234.567". */
export function centsText(mc: number): string {
  const a = Math.abs(mc);
  return `${mc < 0 ? "-" : ""}${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, "0")}`;
}

/** Integer milli-cents as dollars, exact. */
export function dollarsText(mc: number): string {
  const a = Math.abs(mc);
  return `${mc < 0 ? "-" : ""}$${Math.floor(a / 100_000)}.${String(a % 100_000).padStart(5, "0")}`;
}

const TENOR_NAME: Record<Horizon, string> = { fifteen: "15m", hourly: "1h", daily: "1d" };

function table(head: string[], rows: string[][]): string[] {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i]))).join("  ").trimEnd();
  return [line(head), ...rows.map(line)];
}

const SUMMARY_HEAD = ["signals", "captured", "gone", "(edge/size)", "unknown", "captured c", "median edge c", "worst edge c", "sent anyway c", "survived"];

function summaryCells(s: ReplaySummary): string[] {
  return [
    String(s.signals),
    String(s.captured),
    String(s.gone.total),
    `(${s.gone.edge}/${s.gone.size})`,
    String(s.unknown.total),
    centsText(s.capturedMc),
    s.medianCapturedEdgeMc === null ? "none" : centsText(s.medianCapturedEdgeMc),
    s.worstCapturedEdgeMc === null ? "none" : centsText(s.worstCapturedEdgeMc),
    centsText(s.sentAnywayMc) + (s.sentAnywayNotPriced ? ` (+${s.sentAnywayNotPriced} not priced)` : ""),
    s.survivedShare === null ? "no known outcome" : `${(s.survivedShare * 100).toFixed(1)}%`,
  ];
}

/** The run as text a person can read in a terminal or paste. */
export function replayText(run: ReplayRun, opts: { dir?: string; trades?: boolean } = {}): string {
  const out: string[] = [];
  const first = run.results[0];
  out.push("BTC pairs replay. Paper only: no order was sent.");
  if (opts.dir) out.push(`Data dir: ${opts.dir}`);
  out.push(`Days: ${rangeWords(run.fromDay ?? undefined, run.toDay ?? undefined)}. Files read: ${run.files.length}. Lines read: ${run.linesRead}, in ${run.ms} ms.`);
  if (first) {
    const r = first.rule;
    out.push(
      `Rule: a lock of at least ${r.minEdgeCents} c per $1 pair after both venues' fees, at ${r.sizeContracts} contracts traded; at least ${Math.max(r.minSizeContracts, r.sizeContracts)} contracts at the top of both books; both reads fresh and no older than ${r.maxReadAgeSec} s; tenors ${r.horizons.map((h) => TENOR_NAME[h]).join(", ")}; fill cycle at most one interval plus ${r.gapToleranceSec} s late.`,
    );
    out.push(`Cycles replayed: ${first.cyclesRead}. Old form cycles (not replayed): ${first.cyclesOldFormat}. Lines skipped: ${first.linesSkipped}. Days covered: ${first.daysCovered}.${first.firstCycleAt ? ` From ${first.firstCycleAt} to ${first.lastCycleAt}.` : ""}`);
  }
  for (const n of run.notes) out.push(`Note: ${n}`);
  if (first) for (const n of first.notes) out.push(`Note: ${n}`);
  out.push("");
  out.push("Money is in cents (c), for the size traded. Edges are cents per $1 pair. Unknown is not captured, not gone and not zero.");
  out.push("");
  out.push("All tenors, by lag:");
  out.push(...table(["lag", ...SUMMARY_HEAD], run.results.map((r) => [`${r.rule.lagSec} s${r.rule.lagSec === 0 ? " *" : ""}`, ...summaryCells(r.total)])));
  if (run.results.some((r) => r.rule.lagSec === 0)) out.push("* lag 0 fills at the signal cycle itself: an upper bound nobody achieves.");
  for (const r of run.results) {
    out.push("");
    out.push(`Lag ${r.rule.lagSec} s. ${r.lagLabel}`);
    const u = r.total.unknown;
    if (u.total) out.push(`Unknown ${u.total}: no stored cycle in time ${u.noCycle}${r.signalsOpenAtEnd ? ` (${r.signalsOpenAtEnd} of them because the data ends first)` : ""}, fill read stale ${u.staleRead}, fill read too old ${u.oldRead}, fill read missing ${u.noRead}, fill read not taken after the signal ${u.sameRead}.`);
    if (r.total.fillDelaySec) out.push(`Signal to fill cycle: median ${r.total.fillDelaySec.median} s, longest ${r.total.fillDelaySec.max} s. Shown at the signal cycles: ${centsText(r.total.shownAtSignalMc)} c.`);
    out.push(...table(["tenor", ...SUMMARY_HEAD], r.rule.horizons.map((h) => [TENOR_NAME[h], ...summaryCells(r.byHorizon[h] as ReplaySummary)])));
    out.push("");
    out.push(...table(
      ["day", "cycles", "old form", "skipped", "signals", "captured", "gone", "unknown", "captured c", "sent anyway c"],
      r.days.map((d) => [d.day, String(d.cyclesRead), String(d.cyclesOldFormat), String(d.linesSkipped), String(d.signals), String(d.captured), String(d.gone), String(d.unknown), centsText(d.capturedMc), centsText(d.sentAnywayMc)]),
    ));
    for (const d of r.days) if (d.note) out.push(`  ${d.day}: ${d.note}`);
    if (opts.trades && r.trades.length) {
      out.push("");
      out.push(...table(
        ["signal at", "tenor", "strike", "Yes on", "signal edge c", "outcome", "why", "fill at", "fill edge c", "captured c"],
        r.trades.map((t) => [t.signalAt, TENOR_NAME[t.horizon], String(t.strike), t.yesOn === "kalshi" ? "Kalshi" : "Polymarket US", centsText(t.signalEdgeMc), t.outcome, t.why ?? "", t.fillAt ?? "none", t.fillEdgeMc === null ? "" : centsText(t.fillEdgeMc), centsText(t.capturedMc)]),
      ));
      if (r.tradesNotListed) out.push(`  ${r.tradesNotListed} more trades not listed.`);
    }
  }
  out.push("");
  out.push("What this does not model:");
  for (const a of ASSUMPTIONS) out.push(`- ${a}`);
  return out.join("\n") + "\n";
}
