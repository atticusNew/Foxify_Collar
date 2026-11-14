/**
 * THE KEPT DAILY CHECK: one line per run of the reconciliation (realizedRecon.ts), appended to
 * `realized-recon.jsonl` beside the lock ledgers. Append only. A day may be checked again (the
 * operator asks, after a venue that was down comes back); the later line stands for the day and
 * the earlier one stays on the file.
 *
 * The daily run checks the UTC day that ended last, once: it waits a while past midnight so the
 * venues' lists have the day's last fills, it does not run again for a day that already has a
 * line, and a run that fails is kept as could not be checked and not tried again by the timer.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { VERDICT_WORDS, isUtcDay, previousUtcDay, type DayRecon, type VenueDayRecon } from "./realizedRecon";
import type { VenueFillReadersView } from "./venueFillReaders";

export interface ReconRunRecord {
  type: "recon_run";
  /** the UTC day checked */
  day: string;
  /** when the check ran */
  at: string;
  /** the timer's once-a-day run, or the operator's own */
  trigger: "daily" | "operator";
  verdict: DayRecon["verdict"];
  summary: string;
  venues: VenueDayRecon[];
  /** which key read what on this run, in words; no key material */
  readers: VenueFillReadersView;
}

export function reconRunOf(recon: DayRecon, at: string, trigger: ReconRunRecord["trigger"], readers: VenueFillReadersView): ReconRunRecord {
  return { type: "recon_run", day: recon.day, at, trigger, verdict: recon.verdict, summary: recon.summary, venues: recon.venues, readers };
}

export function appendReconRun(path: string, record: ReconRunRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function loadReconRuns(path: string): ReconRunRecord[] {
  if (!existsSync(path)) return [];
  const out: ReconRunRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReconRunRecord;
      if (r && r.type === "recon_run" && typeof r.day === "string" && isUtcDay(r.day) && typeof r.at === "string" && Array.isArray(r.venues)) out.push(r);
    } catch {
      // a torn line is skipped, never repaired
    }
  }
  return out;
}

/** The line that stands for each day (the last one written), newest day first. */
export function latestRunPerDay(runs: ReconRunRecord[]): ReconRunRecord[] {
  const byDay = new Map<string, ReconRunRecord>();
  for (const r of runs) byDay.set(r.day, r);
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/**
 * The day the timer should check now, or null. The day that ended last, once `afterMs` of the new
 * day has passed, when no line is kept for it and this process has not already tried it.
 */
export function dailyCheckDue(now: Date, afterMs: number, keptDays: ReadonlySet<string>, triedDays: ReadonlySet<string>): string | null {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (now.getTime() - startOfToday < afterMs) return null;
  const day = previousUtcDay(now);
  return keptDays.has(day) || triedDays.has(day) ? null : day;
}

export interface ReconRunView {
  day: string;
  at: string;
  trigger: ReconRunRecord["trigger"];
  verdict: string;
  summary: string;
  venues: Array<{ venue: string; verdict: string; reason: string; matched: number; differing: number; inLedgerNotAtVenue: number; atVenueNotInLedger: number; couldNotBeRead: number }>;
}

/** A run in a few lines, for the health body and the list of days: the verdicts in words, the counts, no order detail. */
export function reconRunView(r: ReconRunRecord): ReconRunView {
  return {
    day: r.day,
    at: r.at,
    trigger: r.trigger,
    verdict: VERDICT_WORDS[r.verdict],
    summary: r.summary,
    venues: r.venues.map((v) => ({
      venue: v.venue,
      verdict: VERDICT_WORDS[v.verdict],
      reason: v.reason,
      matched: v.matched.length,
      differing: v.differing.length,
      inLedgerNotAtVenue: v.inLedgerNotAtVenue.length,
      atVenueNotInLedger: v.atVenueNotInLedger.length,
      couldNotBeRead: v.unread.length,
    })),
  };
}

/** The alert's words for a day on which a venue differs: each such venue with its counts, and where to read the detail. */
export function differsAlertText(r: ReconRunRecord): string | null {
  const bad = r.venues.filter((v) => v.verdict === "differs");
  if (bad.length === 0) return null;
  const parts = bad.map((v) => {
    const bits = [
      v.differing.length ? `${v.differing.length} order(s) with a different quantity, cost or fee` : "",
      v.inLedgerNotAtVenue.length ? `${v.inLedgerNotAtVenue.length} on our ledger and not at the venue` : "",
      v.atVenueNotInLedger.length ? `${v.atVenueNotInLedger.length} at the venue and not on our ledger` : "",
    ].filter(Boolean);
    return `${v.venue}: ${bits.join(", ")}`;
  });
  return `our ledger and the venue's own fills differ for ${r.day} (UTC). ${parts.join("; ")}. Detail: /api/shadow/realized?day=${r.day}`;
}
