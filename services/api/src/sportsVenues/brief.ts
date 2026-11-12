/**
 * The arithmetic of the internal meeting brief: the replay's retail figures as a rate (per 1,000
 * tickets, per game), a league's rate carried to a regular season, and a case for one platform
 * on the exchange (its share of the exchange's retail tickets, how many holders lock, how much
 * the exchange grows).
 *
 * Every figure starts from the replay's own tallies. What is added here is three assumptions
 * and a season's game count, each stated on the page beside the figure it produces. A league
 * with fewer than MIN_GAMES games is shown and left out of the season's total: one prime-time
 * game times a season is not a rate.
 *
 * Counts are of positions and contracts; money is micro-dollars as in the replay. A case scales
 * them by fractions, so its results are estimates and are rounded where they are shown.
 */

import type { FeeTerms } from "./analytics";
import { lockTallyOf, openTallyOf, type ReplayCounts, type ReplayReport } from "./tapeReplay";

/** Regular-season games, 2026-27: NBA 30 clubs x 82, NHL 32 x 84, NFL 32 x 17, each over two. Playoffs are not counted. */
export const SEASON_GAMES: Record<string, number> = { nba: 1230, nhl: 1344, nfl: 272 };
export const MIN_GAMES = 8;

/** Retail tickets ($500 or less) over a set of games, and the in-play stake-back lock on them. */
export interface BriefBase {
  games: number;
  tickets: number;
  /** hundredths of a contract bought */
  qty: number;
  stake: number;
  /** the exchange's fee on buying them; null when the fee is not a flat one per contract */
  openFee: number | null;
  lost: number;
  lostStake: number;
  lostAhead: number;
  /** tickets that could take the whole stake back in play */
  locks: number;
  /** hundredths of a contract traded in those locks, and the exchange's fee on them */
  sold: number;
  lockFee: number;
  /** of those, the ones whose side then lost: what they had paid and what the lock returns */
  saved: number;
  savedStake: number;
  savedCash: number;
  won: number;
  wonGaveUp: number;
}

export function baseOf(counts: ReplayCounts, games: number, fee: FeeTerms): BriefBase {
  const open = openTallyOf(counts, "all", "small");
  const back = lockTallyOf(counts, "live_back80", "all", "small");
  return {
    games,
    tickets: open.n,
    qty: open.qty,
    stake: open.stake,
    openFee: !fee.theta && !fee.gain && fee.flat ? open.qty * fee.flat * 100 : null,
    lost: open.lost,
    lostStake: open.lostStake,
    lostAhead: open.lostAheadEver,
    locks: back.n,
    sold: back.sold,
    lockFee: back.fee,
    saved: back.lost,
    savedStake: back.lostStake,
    savedCash: back.lostCash,
    won: back.won,
    wonGaveUp: back.wonGaveUp,
  };
}

const KEYS = ["games", "tickets", "qty", "stake", "lost", "lostStake", "lostAhead", "locks", "sold", "lockFee", "saved", "savedStake", "savedCash", "won", "wonGaveUp"] as const;

/** Every figure times `f`; nothing is rounded. */
export function scaled(b: BriefBase, f: number): BriefBase {
  const out = { ...b, openFee: b.openFee === null ? null : b.openFee * f };
  for (const k of KEYS) out[k] = b[k] * f;
  return out;
}

export function added(a: BriefBase, b: BriefBase): BriefBase {
  const out = { ...a, openFee: a.openFee === null || b.openFee === null ? null : a.openFee + b.openFee };
  for (const k of KEYS) out[k] = a[k] + b[k];
  return out;
}

const EMPTY: BriefBase = { games: 0, tickets: 0, qty: 0, stake: 0, openFee: 0, lost: 0, lostStake: 0, lostAhead: 0, locks: 0, sold: 0, lockFee: 0, saved: 0, savedStake: 0, savedCash: 0, won: 0, wonGaveUp: 0 };

/** The same figures for every 1,000 retail tickets. */
export const perThousand = (b: BriefBase): BriefBase => (b.tickets > 0 ? scaled(b, 1000 / b.tickets) : scaled(b, 0));

export interface LeagueSeason {
  league: string;
  /** what the replay counted */
  sample: BriefBase;
  seasonGames: number;
  /** too few games to carry to a season: shown, not counted */
  thin: boolean;
  /** the sample's rate over a regular season */
  season: BriefBase;
}
export interface SeasonView {
  leagues: LeagueSeason[];
  /** the leagues with enough games, added */
  total: BriefBase;
  counted: string[];
  thin: string[];
}

/** Each league's rate carried to its regular season; the total is over the leagues with MIN_GAMES games or more. */
export function seasonOf(report: ReplayReport, fee: FeeTerms): SeasonView {
  const leagues: LeagueSeason[] = [];
  for (const [league, seasonGames] of Object.entries(SEASON_GAMES)) {
    const totals = report.byLeague[league];
    if (!totals || !totals.games) continue;
    const sample = baseOf(totals, totals.games, fee);
    leagues.push({ league, sample, seasonGames, thin: totals.games < MIN_GAMES, season: scaled(sample, seasonGames / totals.games) });
  }
  const counted = leagues.filter((l) => !l.thin);
  return { leagues, total: counted.reduce((sum, l) => added(sum, l.season), EMPTY), counted: counted.map((l) => l.league), thin: leagues.filter((l) => l.thin).map((l) => l.league) };
}

/** Three assumptions. None of them is data. */
export interface CaseInput {
  /** the platform's share of the exchange's retail tickets, percent */
  sharePct: number;
  /** of 100 holders who could take the stake back, how many do */
  adoptionPct: number;
  /** the exchange's volume against today's, times */
  growth: number;
}
export const CASES: Record<"bear" | "base" | "bull", CaseInput> = {
  bear: { sharePct: 1, adoptionPct: 3, growth: 1 },
  base: { sharePct: 3, adoptionPct: 10, growth: 2 },
  bull: { sharePct: 10, adoptionPct: 25, growth: 4 },
};

export interface CaseResult {
  /** the platform's retail tickets in a season, what was paid for them, and the exchange's fee on buying them */
  tickets: number;
  stake: number;
  openFee: number | null;
  /** tickets that could take the stake back, and the locks taken */
  couldLock: number;
  locks: number;
  /** whole contracts traded in those locks, and the exchange's fee on them */
  contracts: number;
  lockFee: number;
  /** that fee against the fee on buying the tickets; null when the latter is not known */
  lockFeeShare: number | null;
  /** tickets that end with the stake back and not $0, and the cash those holders keep */
  saved: number;
  savedCash: number;
  /** what the winners who locked give up */
  wonGaveUp: number;
}

const clamp = (v: number, lo: number, hi: number, otherwise: number): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : otherwise);
/** A case as typed into the page: out-of-range or unreadable values fall back to `otherwise`. */
export function caseFrom(raw: { share?: string | null; adoption?: string | null; growth?: string | null }, otherwise: CaseInput = CASES.base): CaseInput {
  const read = (s: string | null | undefined): number => (s === null || s === undefined || s.trim() === "" ? Number.NaN : Number(s));
  return { sharePct: clamp(read(raw.share), 0, 100, otherwise.sharePct), adoptionPct: clamp(read(raw.adoption), 0, 100, otherwise.adoptionPct), growth: clamp(read(raw.growth), 0, 100, otherwise.growth) };
}

/** A season of the exchange (`seasonOf(...).total`) seen from one platform under a case. */
export function caseOf(season: BriefBase, c: CaseInput): CaseResult {
  const mine = (c.sharePct / 100) * c.growth;
  const taken = mine * (c.adoptionPct / 100);
  const openFee = season.openFee === null ? null : season.openFee * mine;
  const lockFee = season.lockFee * taken;
  return {
    tickets: season.tickets * mine,
    stake: season.stake * mine,
    openFee,
    couldLock: season.locks * mine,
    locks: season.locks * taken,
    contracts: (season.sold * taken) / 100,
    lockFee,
    lockFeeShare: openFee && openFee > 0 ? lockFee / openFee : null,
    saved: season.saved * taken,
    savedCash: season.savedCash * taken,
    wonGaveUp: season.wonGaveUp * taken,
  };
}
