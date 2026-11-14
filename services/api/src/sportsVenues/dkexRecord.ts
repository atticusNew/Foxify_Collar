/**
 * The replay of DKeX's finished games (dkex.ts), as one file that ships with the code:
 * dkexSeed/record.json. It is derived, not collected: scripts/sportsDkexBuild.ts reads the
 * exchange's public daily files and writes it, and running that again brings it up to the
 * latest day published. The service only reads it. The daily files are some 200 MB a day and a
 * day late, so nothing here is fetched while the service runs.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FeeTerms } from "./analytics";
import { capsuleOfGame, type DkexGame } from "./dkex";
import { REPLAY_VERSION, replayGame, sumReplays, type GameReplay, type ReplayReport, type StoryRow } from "./tapeReplay";

/**
 * What a DraftKings Predictions customer pays per contract, to buy and again to sell: 2 cents
 * at prices from 30 to 94 cents, less outside that (about 0.7 cents at 10, 1.4 to 1.8 at 20 to
 * 29, 1 at 95 and 96, under half a cent above). The flat 2 cents is counted at every price, so
 * outside 30 to 94 the fee here is more than the customer's. Read from DraftKings' fee
 * disclosure as others report it (Nov 11, 2026), not from the disclosure itself.
 */
export const DKEX_FEE: FeeTerms = { theta: 0, flat: 2 };
export const DKEX_FEE_WORDS = "2¢ a contract";

export const DKEX_RECORD_VERSION = 1;
export const DKEX_RECORD_PATH = fileURLToPath(new URL("./dkexSeed/record.json", import.meta.url));
/** how many stories the file keeps of each league: the latest games' */
export const DKEX_STORIES_KEPT = 8;

export interface DkexRecord {
  v: number;
  /** the replay's own version: a file of another is not read */
  replay: number;
  builtAt: string;
  /** the first and last day's file read, YYYY-MM-DD, and how many */
  firstDay: string;
  lastDay: string;
  days: number;
  fee: FeeTerms;
  /** every trade on the exchange in those days, and the part of it that is game-winner contracts and combos; contracts are whole */
  exchange: { prints: number; contracts: number; comboContracts: number; winnerPrints: number; winnerContracts: number };
  /** events seen with two winner contracts; the report counts the ones that finished with a result */
  listed: number;
  /** of those, settled with no result to count: a tie, a void, a game cut short */
  noResult: number;
  /** the totals and the latest stories; the per-game rows are not kept */
  report: ReplayReport;
}

const LEAGUE_NAME: Record<string, string> = {
  nfl: "NFL",
  cfb: "College football",
  nba: "NBA",
  nbapre: "NBA preseason",
  wnba: "WNBA",
  ncaab: "College basketball",
  nhl: "NHL",
  nhlpre: "NHL preseason",
  mlb: "MLB",
  kbo: "KBO",
  npb: "NPB",
};
export const dkexLeague = (l: string): string => LEAGUE_NAME[l] ?? l.toUpperCase();

/** One game replayed. The files do not say who is at home, so the label is "A v B". */
export function replayDkexGame(g: DkexGame, fee: FeeTerms = DKEX_FEE): GameReplay {
  return { ...replayGame(capsuleOfGame(g), fee), label: `${g.names.away} v ${g.names.home}` };
}

/** The record of a set of games: the totals, the latest stories of each league, and no per-game rows. */
export function dkexRecordOf(games: Iterable<DkexGame>, given: Omit<DkexRecord, "v" | "replay" | "fee" | "report" | "noResult">, fee: FeeTerms = DKEX_FEE): DkexRecord {
  function* replays(): Iterable<GameReplay> {
    for (const g of games) yield replayDkexGame(g, fee);
  }
  const report = sumReplays(replays());
  return {
    v: DKEX_RECORD_VERSION,
    replay: REPLAY_VERSION,
    ...given,
    noResult: report.noResult.length,
    fee,
    report: { ...report, stories: storiesKept(report.stories), games: [], noResult: [] },
  };
}

/** The latest stories of each league, so a page can tell one of the league it wants. */
function storiesKept(stories: StoryRow[]): StoryRow[] {
  const perLeague = new Map<string, number>();
  return stories.filter((s) => {
    const n = perLeague.get(s.league) ?? 0;
    perLeague.set(s.league, n + 1);
    return n < DKEX_STORIES_KEPT;
  });
}

/** The file, or null when there is none or it is of another version. */
export function loadDkexRecord(path: string = DKEX_RECORD_PATH): DkexRecord | null {
  try {
    if (!existsSync(path)) return null;
    const r = JSON.parse(readFileSync(path, "utf8")) as DkexRecord;
    return r && r.v === DKEX_RECORD_VERSION && r.replay === REPLAY_VERSION && r.report?.all ? r : null;
  } catch {
    return null;
  }
}
