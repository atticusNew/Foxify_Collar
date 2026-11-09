/**
 * The report payload: everything the page shows, computed from the latest snapshot, the
 * history window, the replay engine and the collar ladder. Pure assembly; no I/O.
 */

import { bucketRows, distributionRows, gapSeries, hourlyVolPoint, ladderStrikeVols, latencyTable, volPremiumByHorizon, yearEndStrikeVols, type BucketRow, type GapSeries, type LadderVolTable, type LatencyRow, type VolPremiumRow, type YearEndVolTable } from "./analytics";
import type { CollarLadder } from "./collarLadder";
import { buildSmiles, nearestSmile, type Smile } from "./model";
import type { ReplaySummary } from "./replay";
import type { HistoryPoint } from "./store";
import type { HourlyVolPoint, IndexCandle, Ladder, Snapshot } from "./types";

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
  hourlyVol: HourlyVolPoint | null;
  /** the same reading over the window, by time to close */
  volPremium: VolPremiumRow[];
  /** strike by strike: the vol band each venue's bid/ask implies against the listed vol, hourly and 5 PM ET daily, one table per venue with quotes */
  strikeVols: { hourly: LadderVolTable[]; daily: LadderVolTable[] };
  /** the year-end range ladder's bucket boundaries in vol, both venues against the listed smile */
  yearEndVols: YearEndVolTable | null;
  /** the term basis the year-end buckets are priced on: the listed option forward against the settlement index */
  basis: { expiry: string; forwardUsd: number; spotUsd: number; pct: number; annualisedPct: number; daysToExpiry: number } | null;
  polyOnly: LadderView[];
  latency: LatencyRow[];
  latencyYearEnd: LatencyRow[];
  replay: ReplaySummary;
  collar: CollarLadder | null;
  health: Snapshot["health"];
  notes: { polyUsShortDated: string };
}

/** One strike-by-strike table per venue that quotes the ladder two-sided. */
function strikeVolTables(ladder: Ladder | null, smiles: Smile[], spotUsd: number, nowMs: number): LadderVolTable[] {
  if (!ladder || !(spotUsd > 0)) return [];
  const out: LadderVolTable[] = [];
  for (const venue of ["kalshi", "polymarket_us"] as const) {
    if (!ladder.quotes.some((q) => q.venue === venue)) continue;
    const t = ladderStrikeVols(ladder, smiles, spotUsd, nowMs, venue);
    if (t) out.push(t);
  }
  return out;
}

function sumMids(rows: BucketRow[], pick: (r: BucketRow) => number | null): number | null {
  const vals = rows.filter((r) => r.key.startsWith("range:") || r.key.startsWith("above:") || r.key.startsWith("below:")).map(pick);
  if (!vals.length || vals.some((v) => v === null)) return null;
  return Math.round(vals.reduce((a, b) => (a as number) + (b as number), 0) as number);
}

/** Forward over spot for one listed expiry, simple and annualised (what a desk compares with the futures basis). */
export function termBasis(smile: Smile | null, spotUsd: number, nowMs: number): ReportData["basis"] {
  if (!smile || !(spotUsd > 0) || !(smile.forward > 0)) return null;
  const days = (smile.expiryMs - nowMs) / 86_400_000;
  if (!(days > 0.5)) return null;
  const pct = (smile.forward / spotUsd - 1) * 100;
  return {
    expiry: smile.expiry,
    forwardUsd: Math.round(smile.forward),
    spotUsd: Math.round(spotUsd),
    pct: Math.round(pct * 100) / 100,
    annualisedPct: Math.round(((pct / days) * 365.25) * 10) / 10,
    daysToExpiry: Math.round(days * 10) / 10,
  };
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
  const dailyLadder = s.ladders.find((l) => l.id.startsWith("btc-daily:")) ?? null;
  const rangeLadder = s.ladders.find((l) => l.id === "btc-yearend-2026-range") ?? null;
  const polyOnly = s.ladders.filter((l) => l.id.startsWith("poly:")).map((l) => ladderView(l, history));
  const yearEndSettle = yearEnd[0] ? Date.parse(yearEnd[0].settlesAt) : null;
  const hourlyView = hourlyLadder ? ladderView(hourlyLadder, history) : null;
  const hourlyVol: ReportData["hourlyVol"] = s.hourlyVol ?? (hourlyLadder ? hourlyVolPoint(hourlyLadder, smiles, s.spotUsd, input.candles, nowMs) : null);
  const basis = yearEndSettle ? termBasis(nearestSmile(smiles, yearEndSettle), s.spotUsd, nowMs) : null;
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
    volPremium: volPremiumByHorizon(history),
    strikeVols: {
      hourly: strikeVolTables(hourlyLadder, smiles, s.spotUsd, nowMs),
      daily: strikeVolTables(dailyLadder, smiles, s.spotUsd, nowMs),
    },
    yearEndVols: rangeLadder ? yearEndStrikeVols(rangeLadder, smiles, nowMs) : null,
    basis,
    polyOnly,
    latency: latencyTable(input.candles, smiles, hourlyLadder ? Date.parse(hourlyLadder.settlesAt) : null, nowMs),
    latencyYearEnd: latencyTable(input.candles, smiles, yearEndSettle, nowMs),
    replay: input.replay,
    collar: input.collar,
    health: s.health,
    notes: {
      polyUsShortDated:
        "Polymarket US documents 15-minute and hourly Up/Down windows and hourly, daily and weekly BTC strike ladders; listed in its preprod environment, production date per its changelog. Picked up here by series the cycle they appear.",
    },
  };
}
