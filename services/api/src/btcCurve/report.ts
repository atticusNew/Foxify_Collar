/**
 * The report payload: everything the page shows, computed from the latest snapshot, the
 * history window, the replay engine and the collar ladder. Pure assembly; no I/O.
 */

import { bucketRows, distributionRows, gapSeries, ladderImpliedVol, latencyTable, realizedVolPct, type BucketRow, type GapSeries, type LadderVol, type LatencyRow } from "./analytics";
import type { CollarLadder } from "./collarLadder";
import { buildSmiles, ivAt, nearestSmile } from "./model";
import type { ReplaySummary } from "./replay";
import type { HistoryPoint } from "./store";
import type { IndexCandle, Ladder, Snapshot } from "./types";

export interface LadderView {
  id: string;
  title: string;
  settlesAt: string;
  venues: string[];
  rows: BucketRow[];
  distribution: Array<{ label: string; kalshi: number | null; poly: number | null; model: number | null }>;
  modelExpiry: string | null;
  /** sum of mids across a mutually exclusive range ladder, cents (the venue's implied overround) */
  sumKalshi: number | null;
  sumPoly: number | null;
  sumModel: number | null;
  gaps: GapSeries[];
}

export interface ReportData {
  at: string;
  spotUsd: number;
  spotSource: string;
  collectingSince: string | null;
  historyPoints: number;
  intervalSec: number;
  yearEnd: LadderView[];
  hourly: LadderView | null;
  /** the vol each side is pricing the hour at: the venue's ladder, the listed smile at the money, the index realised */
  hourlyVol: { ladder: LadderVol | null; smilePct: number | null; smileExpiry: string | null; realized: { pct: number; n: number } | null; minutesToClose: number } | null;
  polyOnly: LadderView[];
  latency: LatencyRow[];
  latencyYearEnd: LatencyRow[];
  replay: ReplaySummary;
  collar: CollarLadder | null;
  health: Snapshot["health"];
  notes: { polyUsShortDated: string };
}

function sumMids(rows: BucketRow[], pick: (r: BucketRow) => number | null): number | null {
  const vals = rows.filter((r) => r.key.startsWith("range:") || r.key.startsWith("above:") || r.key.startsWith("below:")).map(pick);
  if (!vals.length || vals.some((v) => v === null)) return null;
  return Math.round(vals.reduce((a, b) => (a as number) + (b as number), 0) as number);
}

export function ladderView(l: Ladder, history: HistoryPoint[]): LadderView {
  const rows = bucketRows(l);
  const venues = [...new Set(l.quotes.map((q) => q.venue))];
  const isRangeFamily = l.buckets.some((b) => b.kind === "range");
  const mid = (q: BucketRow["kalshi"]) => (q && q.bidCents >= 0 && q.askCents > 0 && q.askCents <= 99 ? (q.bidCents + q.askCents) / 2 : null);
  return {
    id: l.id,
    title: l.title,
    settlesAt: l.settlesAt,
    venues,
    rows,
    distribution: isRangeFamily ? distributionRows(l) : [],
    modelExpiry: Object.values(l.model)[0]?.expiry ?? null,
    sumKalshi: isRangeFamily ? sumMids(rows, (r) => mid(r.kalshi)) : null,
    sumPoly: isRangeFamily ? sumMids(rows, (r) => mid(r.poly)) : null,
    sumModel: isRangeFamily ? sumMids(rows, (r) => r.modelCents) : null,
    gaps: gapSeries(history, l.id),
  };
}

export function buildReport(input: {
  snapshot: Snapshot;
  history: HistoryPoint[];
  candles: IndexCandle[];
  replay: ReplaySummary;
  collar: CollarLadder | null;
  intervalSec: number;
  collectingSince: string | null;
}): ReportData {
  const { snapshot: s, history } = input;
  const nowMs = Date.parse(s.at);
  const smiles = buildSmiles(s.options);
  const yearEnd = s.ladders.filter((l) => l.id.startsWith("btc-yearend-")).map((l) => ladderView(l, history));
  const hourlyLadder = s.ladders.find((l) => l.id.startsWith("btc-hourly:")) ?? null;
  const polyOnly = s.ladders.filter((l) => l.id.startsWith("poly:")).map((l) => ladderView(l, history));
  const yearEndSettle = yearEnd[0] ? Date.parse(yearEnd[0].settlesAt) : null;
  const hourlyView = hourlyLadder ? ladderView(hourlyLadder, history) : null;
  let hourlyVol: ReportData["hourlyVol"] = null;
  if (hourlyLadder && hourlyView) {
    const settleMs = Date.parse(hourlyLadder.settlesAt);
    const T = (settleMs - nowMs) / (365.25 * 86_400_000);
    const smile = nearestSmile(smiles, settleMs);
    hourlyVol = {
      ladder: ladderImpliedVol(hourlyView.rows, "kalshi", s.spotUsd, T),
      smilePct: smile ? Math.round(ivAt(smile, s.spotUsd) * 1000) / 10 : null,
      smileExpiry: smile?.expiry ?? null,
      realized: realizedVolPct(input.candles, 60),
      minutesToClose: Math.round((settleMs - nowMs) / 60_000),
    };
  }
  return {
    at: s.at,
    spotUsd: s.spotUsd,
    spotSource: s.spotSource,
    collectingSince: input.collectingSince,
    historyPoints: history.length,
    intervalSec: input.intervalSec,
    yearEnd,
    hourly: hourlyView,
    hourlyVol,
    polyOnly,
    latency: latencyTable(input.candles, smiles, hourlyLadder ? Date.parse(hourlyLadder.settlesAt) : null, nowMs),
    latencyYearEnd: latencyTable(input.candles, smiles, yearEndSettle, nowMs),
    replay: input.replay,
    collar: input.collar,
    health: s.health,
    notes: {
      polyUsShortDated:
        "Polymarket US has documented 15-minute and hourly Up/Down windows plus hourly, daily and weekly strike ladders on BTC; they are listed in its preprod environment and reach production on a date it announces in its changelog. This reader discovers them by series the cycle they appear.",
    },
  };
}
