/** The report payload: everything the page shows, from the latest snapshot and the history. Pure assembly. */

import { gapSeries, readGame, readSlate, windowTally, type GameRead, type GapSeries, type SlateRead, type WindowTally } from "./analytics";
import type { HistoryPoint } from "./store";
import type { Snapshot } from "./types";

export interface ReportData {
  at: string;
  collectingSince: string | null;
  historyPoints: number;
  /** how far back the history reaches, in hours; absent when the caller did not say */
  windowHours?: number;
  intervalSec: number;
  games: GameRead[];
  slate: SlateRead;
  gaps: GapSeries[];
  window: WindowTally;
  health: Snapshot["health"];
}

export function buildReport(input: { snapshot: Snapshot; history: HistoryPoint[]; intervalSec: number; collectingSince: string | null; windowHours?: number }): ReportData {
  const nowMs = Date.parse(input.snapshot.at);
  const games = input.snapshot.games.map((g) => readGame(g, nowMs)).sort((a, b) => {
    // live first, then by start
    if (a.live !== b.live) return a.live ? -1 : 1;
    return a.startsAt.localeCompare(b.startsAt) || a.key.localeCompare(b.key);
  });
  return {
    at: input.snapshot.at,
    collectingSince: input.collectingSince,
    historyPoints: input.history.length,
    windowHours: input.windowHours,
    intervalSec: input.intervalSec,
    games,
    slate: readSlate(games),
    gaps: gapSeries(input.history, games),
    window: windowTally(input.history),
    health: input.snapshot.health,
  };
}
