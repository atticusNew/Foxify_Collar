/**
 * Lock in, replayed on the real trades of one game.
 *
 * Crypto.com's exchange publishes every trade on a contract: time, size, price and whether the
 * taker bought or sold (tape.ts keeps them). A taker's buy on a club's winner contract is a real
 * position someone opened: that many contracts, at that price, at that moment. This file follows
 * each one to the result and works out what a lock would have been, at bids that were really
 * there. Nothing in it is a simulated position, and it is a pure function of the game's file.
 *
 * A BID THAT WAS REALLY THERE is one of two things, both on the position's own contract:
 *   - the best bid of the book as the collector read it that minute, with its size; or
 *   - a taker's sale on the tape: someone sold that many at that price at that moment.
 * Nothing is inferred from a buy. A lock is only ever priced at a bid between 5 and 95 cents:
 * outside that the result is all but known and a lock is not the question.
 *
 * THE POSITIONS. Every taker buy at a price between 5 and 95 cents, taken as held to the result.
 * The tape has no account on it, so one person's three buys are three positions, a buy that
 * closed a short is counted as a position, and a holder who sold by hand before the end is still
 * followed to the end.
 *
 * BEFORE THE START. A position opened before the scheduled start, locked at the last bid of the
 * hour before it. The three tiers the product offers: 40, 60 or 80 percent sold.
 *
 * IN PLAY. Every position, from the scheduled start or from when it was opened, whichever is
 * later. Each option is taken at the first bid that makes it possible:
 *   half back    Max upside (40% sold) once that sale returns half the stake or more;
 *   stake back   the fewest contracts whose sale returns the whole stake, once that is no more
 *                than 80, 60 or 40 percent of the position, so 20, 40 or 60 percent rides free.
 * "First" is the rule, not hindsight: a holder who waited may have done better or lost the chance.
 *
 * THE RESULT. Read from each side's last trade once the game is over (tape.ts decides when):
 * the side that last printed at 97 cents or more while the other's was 50 or less, or, the same
 * statement from the loser's contract, the side whose opponent last printed at 3 cents or less
 * while its own was 50 or more. On a thin game the winner's contract often has no trade after
 * the whistle and only the loser's prints the result. A game with no such result is not counted.
 *
 * Money is whole micro-dollars throughout (lockMath.ts).
 */

import type { FeeTerms } from "./analytics";
import { type Tier, buyFee, lockTerms, netBid, priceOf, priceOfDollars, quantityOf, stakeBackNet, stakeBackSold, stakeOf, tierBackNet, tierSold, MICRO_PER_DOLLAR } from "./lockMath";
import { SIDES, type Side } from "./types";

/** Raised whenever the arithmetic below changes: a stored summary of another version is worked out again from the game's file. */
export const REPLAY_VERSION = 1;

export const LOCK_MIN_BID = 500;
export const LOCK_MAX_BID = 9500;
/** how long before the scheduled start a bid still counts as the bid at the start */
export const PRE_LOCK_WINDOW_MS = 60 * 60_000;
/** a stake at or under this is "small": the size of a retail ticket */
export const SMALL_STAKE_MICRO = 500 * MICRO_PER_DOLLAR;
export const RESULT_WON_PRICE = 9700;
export const RESULT_GONE_PRICE = 300;
/** what the other side's last print must not contradict */
export const RESULT_HALF_PRICE = 5000;

export interface TapeTrade {
  t: number;
  /** hundredths of a contract */
  qty: number;
  /** hundredths of a cent */
  price: number;
  buy: boolean;
}
export interface BookPoint {
  t: number;
  /** hundredths of a cent; 0 when the book showed no bid */
  bid: number;
  /** hundredths of a contract at that bid */
  qty: number;
}
export interface GameMeta {
  event: string;
  league: string;
  key?: string;
  awayName: string;
  homeName: string;
  startMs: number;
  symbols?: Record<Side, string>;
}
export interface Capsule extends GameMeta {
  trades: Record<Side, TapeTrade[]>;
  book: Record<Side, BookPoint[]>;
  /** undefined while the game is not over; null when it ended with no result this file can read */
  winner?: Side | null;
  /** the venue's id of the newest trade kept on each side; "" with none */
  lastId: Record<Side, string>;
}

/** Is trade id `a` newer than `b`? The venue's ids are the match time in nanoseconds, as digits. "" is older than everything. */
export const newerId = (a: string, b: string): boolean => a.length !== b.length ? a.length > b.length : a > b;

// ---------------------------------------------------------------------------
// the game's file, a line at a time
// ---------------------------------------------------------------------------

export type TradeLine = ["t", "a" | "h", number, string, string, 0 | 1, string];
export type BookLine = ["b", "a" | "h", number, number, number];
export interface HeadLine extends GameMeta {
  k: "g";
  v: 1;
}
export interface ResultLine {
  k: "r";
  atMs: number;
  winner: Side | null;
  why: string;
}

const sideOf = (c: unknown): Side | null => (c === "a" ? "away" : c === "h" ? "home" : null);
export const sideCode = (s: Side): "a" | "h" => (s === "away" ? "a" : "h");

/** The game as its file's lines say it. A line that does not parse (a torn last line) is passed over; null with no header. */
export function parseCapsule(lines: Iterable<string>): Capsule | null {
  let meta: GameMeta | null = null;
  const trades: Record<Side, TapeTrade[]> = { away: [], home: [] };
  const book: Record<Side, BookPoint[]> = { away: [], home: [] };
  const seen = new Set<string>();
  const lastId: Record<Side, string> = { away: "", home: "" };
  let winner: Side | null | undefined;
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(row)) {
      const side = sideOf(row[1]);
      const t = Number(row[2]);
      if (!side || !Number.isFinite(t)) continue;
      if (row[0] === "t") {
        const id = String(row[6] ?? "");
        const qty = quantityOf(row[3] as string);
        const price = priceOfDollars(row[4] as string);
        if (!qty || !price || (id && seen.has(`${side}${id}`))) continue;
        if (id) seen.add(`${side}${id}`);
        if (newerId(id, lastId[side])) lastId[side] = id;
        trades[side].push({ t, qty, price, buy: row[5] === 1 });
      } else if (row[0] === "b") {
        const bid = priceOf(Number(row[3]));
        const qty = quantityOf(row[4] as number);
        if (Number.isFinite(bid) && bid >= 0) book[side].push({ t, bid, qty });
      }
      continue;
    }
    const o = row as (Partial<Omit<HeadLine, "k">> & Partial<Omit<ResultLine, "k">> & { k?: string }) | null;
    if (o?.k === "g" && typeof o.event === "string" && Number.isFinite(Number(o.startMs))) {
      // the last header wins: the venue can move a start
      meta = { event: o.event, league: String(o.league ?? ""), key: o.key, awayName: String(o.awayName ?? "away"), homeName: String(o.homeName ?? "home"), startMs: Number(o.startMs), symbols: o.symbols };
    } else if (o?.k === "r") {
      winner = o.winner === "away" || o.winner === "home" ? o.winner : null;
    }
  }
  if (!meta) return null;
  for (const s of SIDES) {
    trades[s].sort((a, b) => a.t - b.t);
    book[s].sort((a, b) => a.t - b.t);
  }
  return { ...meta, trades, book, lastId, ...(winner !== undefined ? { winner } : {}) };
}

/** The result as the tape's last prints say it: null while they do not. */
export function winnerFromLastPrices(last: Record<Side, number | null>): Side | null {
  const { away, home } = last;
  if (away === null || home === null) return null;
  const says = (won: number, lost: number): boolean => (won >= RESULT_WON_PRICE && lost <= RESULT_HALF_PRICE) || (lost <= RESULT_GONE_PRICE && won >= RESULT_HALF_PRICE);
  if (says(away, home)) return "away";
  if (says(home, away)) return "home";
  return null;
}

// ---------------------------------------------------------------------------
// the tallies
// ---------------------------------------------------------------------------

export type Opened = "pre" | "live";
export const OPENED: readonly Opened[] = ["pre", "live"];
export type Bucket = "small" | "large";
export const BUCKETS: readonly Bucket[] = ["small", "large"];

export type OptionId = "pre_wide" | "pre_balanced" | "pre_tight" | "live_half" | "live_back80" | "live_back60" | "live_back40";
export const PRE_OPTIONS: readonly OptionId[] = ["pre_wide", "pre_balanced", "pre_tight"];
export const LIVE_OPTIONS: readonly OptionId[] = ["live_half", "live_back80", "live_back60", "live_back40"];
export const OPTION_IDS: readonly OptionId[] = [...PRE_OPTIONS, ...LIVE_OPTIONS];
const PRE_TIER: Record<string, Tier> = { pre_wide: "wide", pre_balanced: "balanced", pre_tight: "tight" };
/** the most of the position a stake-back option sells, percent */
export const BACK_SHARE: Record<string, number> = { live_back80: 80, live_back60: 60, live_back40: 40 };
/** the share of the stake Max upside must return in play before it is taken, percent */
export const HALF_BACK_PERCENT = 50;

/** One side of the tape in one phase. */
export interface PhaseTape {
  buys: number;
  buyQty: number;
  sells: number;
  sellQty: number;
}
/** The positions opened in one phase, of one size. Money in micro-dollars, quantities in hundredths of a contract. */
export interface OpenTally {
  n: number;
  qty: number;
  stake: number;
  lost: number;
  lostStake: number;
  won: number;
  /** opened before the start with a bid to read in the hour before it, and of those the ones a sale of everything would have left in profit */
  atStart: number;
  aheadAtStart: number;
}
export interface LockTally {
  /** positions the option was open to */
  eligible: number;
  /** positions that locked */
  n: number;
  qty: number;
  stake: number;
  sold: number;
  /** the sales' cash after the fee: what the lockers held whatever happened */
  cash: number;
  fee: number;
  /** lockers whose side lost: what they had paid, and what the lock left them instead of nothing */
  lost: number;
  lostStake: number;
  lostCash: number;
  /** lockers whose side won, and what the lock cost them against riding: $1 on each contract sold, less the cash */
  won: number;
  wonGaveUp: number;
  /** locks priced at a book reading (the others at a taker's sale), and of those the ones whose bid held the whole sale */
  atBook: number;
  covered: number;
  /** sums over lockers, for means: cash over stake, the share sold, minutes from the scheduled start (0 before it) */
  backShareSum: number;
  soldShareSum: number;
  minutesSum: number;
}

const emptyPhaseTape = (): PhaseTape => ({ buys: 0, buyQty: 0, sells: 0, sellQty: 0 });
export const emptyOpen = (): OpenTally => ({ n: 0, qty: 0, stake: 0, lost: 0, lostStake: 0, won: 0, atStart: 0, aheadAtStart: 0 });
export const emptyLock = (): LockTally => ({ eligible: 0, n: 0, qty: 0, stake: 0, sold: 0, cash: 0, fee: 0, lost: 0, lostStake: 0, lostCash: 0, won: 0, wonGaveUp: 0, atBook: 0, covered: 0, backShareSum: 0, soldShareSum: 0, minutesSum: 0 });

const perOpened = <T>(make: () => T): Record<Opened, T> => ({ pre: make(), live: make() });
const perBucket = <T>(make: () => T): Record<Bucket, T> => ({ small: make(), large: make() });
const perOption = <T>(make: () => T): Record<OptionId, T> => Object.fromEntries(OPTION_IDS.map((o) => [o, make()])) as Record<OptionId, T>;

export interface ReplayCounts {
  tape: Record<Opened, PhaseTape>;
  /** taker buys outside 5 to 95 cents: on the tape, not counted as positions */
  outside: number;
  open: Record<Opened, Record<Bucket, OpenTally>>;
  locks: Record<OptionId, Record<Opened, Record<Bucket, LockTally>>>;
}
export const emptyCounts = (): ReplayCounts => ({
  tape: perOpened(emptyPhaseTape),
  outside: 0,
  open: perOpened(() => perBucket(emptyOpen)),
  locks: perOption(() => perOpened(() => perBucket(emptyLock))),
});

export interface GameReplay extends ReplayCounts {
  v: number;
  event: string;
  league: string;
  label: string;
  startMs: number;
  winner: Side | null;
  winnerName: string | null;
  trades: number;
  /** bids the locks could be priced at: the collector's book readings, and takers' sales on the tape */
  bookPoints: number;
  salePoints: number;
}

function addNumbers(into: object, from: object): void {
  const a = into as Record<string, number>;
  const b = from as Record<string, number>;
  for (const k of Object.keys(b)) if (typeof b[k] === "number" && Number.isFinite(b[k])) a[k] = (a[k] ?? 0) + b[k];
}

export function addCounts(into: ReplayCounts, from: ReplayCounts): void {
  into.outside += from.outside ?? 0;
  for (const o of OPENED) {
    addNumbers(into.tape[o], from.tape?.[o] ?? emptyPhaseTape());
    for (const b of BUCKETS) addNumbers(into.open[o][b], from.open?.[o]?.[b] ?? emptyOpen());
  }
  for (const id of OPTION_IDS) for (const o of OPENED) for (const b of BUCKETS) addNumbers(into.locks[id][o][b], from.locks?.[id]?.[o]?.[b] ?? emptyLock());
}

// ---------------------------------------------------------------------------
// the replay
// ---------------------------------------------------------------------------

/** The first index at or after `from` whose value is at least `min`, over a fixed list: blocks of 64 with their maxima. */
class FirstAtLeast {
  private readonly blockMax: number[] = [];
  constructor(private readonly values: number[]) {
    for (let i = 0; i < values.length; i += 64) {
      let m = -Infinity;
      for (let j = i; j < Math.min(values.length, i + 64); j += 1) if (values[j] > m) m = values[j];
      this.blockMax.push(m);
    }
  }
  find(from: number, min: number): number {
    const n = this.values.length;
    let i = Math.max(0, from);
    while (i < n) {
      const block = i >> 6;
      if (this.blockMax[block] < min) {
        i = (block + 1) << 6;
        continue;
      }
      const end = Math.min(n, (block + 1) << 6);
      for (; i < end; i += 1) if (this.values[i] >= min) return i;
    }
    return -1;
  }
}

interface Points {
  t: number[];
  bid: number[];
  qty: number[];
  net: number[];
  /** a book reading; false for a taker's sale */
  book: boolean[];
}

/** The bids of one side a lock could be priced at, oldest first: book readings and takers' sales, 5 to 95 cents. */
function lockPoints(book: BookPoint[], trades: TapeTrade[], fee: FeeTerms): { points: Points; book: number; sale: number } {
  const rows: Array<[number, number, number, boolean]> = [];
  let nBook = 0;
  let nSale = 0;
  for (const b of book) {
    if (b.bid < LOCK_MIN_BID || b.bid > LOCK_MAX_BID) continue;
    rows.push([b.t, b.bid, b.qty, true]);
    nBook += 1;
  }
  for (const tr of trades) {
    if (tr.buy || tr.price < LOCK_MIN_BID || tr.price > LOCK_MAX_BID) continue;
    rows.push([tr.t, tr.price, tr.qty, false]);
    nSale += 1;
  }
  rows.sort((a, b) => a[0] - b[0]);
  const points: Points = { t: [], bid: [], qty: [], net: [], book: [] };
  for (const [t, bid, qty, fromBook] of rows) {
    points.book.push(fromBook);
    points.t.push(t);
    points.bid.push(bid);
    points.qty.push(qty);
    points.net.push(netBid(fee, bid));
  }
  return { points, book: nBook, sale: nSale };
}

/** The first index of `ts` (ascending) strictly after `t`. */
function firstAfter(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function record(tally: LockTally, pos: { qty: number; price: number }, sold: number, points: Points, i: number, minutes: number, won: boolean, fee: FeeTerms): void {
  const terms = lockTerms(pos, sold, points.bid[i], fee);
  if (!terms) return;
  tally.n += 1;
  tally.qty += pos.qty;
  tally.stake += terms.stake;
  tally.sold += terms.sold;
  tally.cash += terms.cash;
  tally.fee += terms.fee;
  if (won) {
    tally.won += 1;
    tally.wonGaveUp += terms.fullWin - terms.cap;
  } else {
    tally.lost += 1;
    tally.lostStake += terms.stake;
    tally.lostCash += terms.cash;
  }
  if (points.book[i]) {
    tally.atBook += 1;
    if (points.qty[i] >= terms.sold) tally.covered += 1;
  }
  tally.backShareSum += terms.cash / terms.stake;
  tally.soldShareSum += terms.sold / pos.qty;
  tally.minutesSum += minutes;
}

/**
 * One game. With no result (`winner` not "away" or "home") only the tape is counted: who won
 * decides every figure after it.
 */
export function replayGame(game: Capsule, fee: FeeTerms): GameReplay {
  const counts = emptyCounts();
  const winner = game.winner === "away" || game.winner === "home" ? game.winner : null;
  let bookPoints = 0;
  let salePoints = 0;
  for (const side of SIDES) {
    const trades = game.trades[side];
    for (const tr of trades) {
      const phase = counts.tape[tr.t < game.startMs ? "pre" : "live"];
      if (tr.buy) {
        phase.buys += 1;
        phase.buyQty += tr.qty;
      } else {
        phase.sells += 1;
        phase.sellQty += tr.qty;
      }
    }
    if (!winner) continue;
    const won = winner === side;
    const { points, book, sale } = lockPoints(game.book[side], trades, fee);
    bookPoints += book;
    salePoints += sale;
    const liveFrom = firstAfter(points.t, game.startMs - 1);
    // the last bid of the hour before the start
    const preIdx = liveFrom > 0 && points.t[liveFrom - 1] >= game.startMs - PRE_LOCK_WINDOW_MS ? liveFrom - 1 : -1;
    const nets = new FirstAtLeast(points.net);
    for (const tr of trades) {
      if (!tr.buy) continue;
      if (tr.price < LOCK_MIN_BID || tr.price > LOCK_MAX_BID) {
        counts.outside += 1;
        continue;
      }
      const pos = { qty: tr.qty, price: tr.price };
      const stake = stakeOf(pos, fee);
      const opened: Opened = tr.t < game.startMs ? "pre" : "live";
      const bucket: Bucket = stake <= SMALL_STAKE_MICRO ? "small" : "large";
      const open = counts.open[opened][bucket];
      open.n += 1;
      open.qty += pos.qty;
      open.stake += stake;
      if (won) open.won += 1;
      else {
        open.lost += 1;
        open.lostStake += stake;
      }

      if (opened === "pre") {
        const readable = preIdx >= 0 && points.t[preIdx] > tr.t;
        if (readable) {
          open.atStart += 1;
          if (points.net[preIdx] >= pos.price + buyFee(fee, pos.price)) open.aheadAtStart += 1;
        }
        for (const id of PRE_OPTIONS) {
          const tally = counts.locks[id][opened][bucket];
          tally.eligible += 1;
          if (readable) record(tally, pos, tierSold(pos.qty, PRE_TIER[id]), points, preIdx, 0, won, fee);
        }
      }

      const from = Math.max(liveFrom, firstAfter(points.t, tr.t));
      for (const id of LIVE_OPTIONS) {
        const tally = counts.locks[id][opened][bucket];
        tally.eligible += 1;
        const least = id === "live_half" ? tierBackNet(pos, fee, "wide", HALF_BACK_PERCENT) : stakeBackNet(pos, fee, BACK_SHARE[id]);
        if (least === null) continue;
        const j = nets.find(from, least);
        if (j < 0) continue;
        const sold = id === "live_half" ? tierSold(pos.qty, "wide") : stakeBackSold(pos, points.net[j], fee);
        if (sold === null) continue;
        record(tally, pos, sold, points, j, (points.t[j] - game.startMs) / 60_000, won, fee);
      }
    }
  }
  return {
    v: REPLAY_VERSION,
    event: game.event,
    league: game.league,
    label: `${game.awayName} at ${game.homeName}`,
    startMs: game.startMs,
    winner,
    winnerName: winner ? (winner === "away" ? game.awayName : game.homeName) : null,
    trades: game.trades.away.length + game.trades.home.length,
    bookPoints,
    salePoints,
    ...counts,
  };
}

// ---------------------------------------------------------------------------
// what the page shows
// ---------------------------------------------------------------------------

export interface ReplayTotals extends ReplayCounts {
  /** games with a result, which is what every figure is over */
  games: number;
  /** of those, games whose bids include the collector's book readings (the others are priced at takers' sales only) */
  gamesWithBook: number;
  trades: number;
  firstStartMs: number | null;
  lastStartMs: number | null;
}
export interface ReplayGameRow {
  event: string;
  league: string;
  label: string;
  startMs: number;
  winnerName: string | null;
  trades: number;
  positions: number;
  bookPoints: number;
  salePoints: number;
}
export interface ReplayReport {
  v: number;
  all: ReplayTotals;
  byLeague: Record<string, ReplayTotals>;
  games: ReplayGameRow[];
  /** games that ended with no result the tape could give: listed, not counted */
  noResult: ReplayGameRow[];
}

const emptyTotals = (): ReplayTotals => ({ games: 0, gamesWithBook: 0, trades: 0, firstStartMs: null, lastStartMs: null, ...emptyCounts() });

const rowOf = (g: GameReplay): ReplayGameRow => ({
  event: g.event,
  league: g.league,
  label: g.label,
  startMs: g.startMs,
  winnerName: g.winnerName,
  trades: g.trades,
  positions: OPENED.reduce((a, o) => a + BUCKETS.reduce((x, b) => x + (g.open?.[o]?.[b]?.n ?? 0), 0), 0),
  bookPoints: g.bookPoints,
  salePoints: g.salePoints,
});

export function sumReplays(replays: Iterable<GameReplay>): ReplayReport {
  const all = emptyTotals();
  const byLeague: Record<string, ReplayTotals> = {};
  const games: ReplayGameRow[] = [];
  const noResult: ReplayGameRow[] = [];
  for (const g of replays) {
    if (!g.winner) {
      noResult.push(rowOf(g));
      continue;
    }
    games.push(rowOf(g));
    for (const t of [all, (byLeague[g.league] ??= emptyTotals())]) {
      t.games += 1;
      if (g.bookPoints > 0) t.gamesWithBook += 1;
      t.trades += g.trades;
      t.firstStartMs = t.firstStartMs === null ? g.startMs : Math.min(t.firstStartMs, g.startMs);
      t.lastStartMs = t.lastStartMs === null ? g.startMs : Math.max(t.lastStartMs, g.startMs);
      addCounts(t, g);
    }
  }
  const byStart = (a: ReplayGameRow, b: ReplayGameRow) => b.startMs - a.startMs || a.event.localeCompare(b.event);
  return { v: REPLAY_VERSION, all, byLeague: Object.fromEntries(Object.entries(byLeague).sort(([a], [b]) => a.localeCompare(b))), games: games.sort(byStart), noResult: noResult.sort(byStart) };
}

/** One option's tally over the positions asked for: opened before the start, in play or either; small stakes, large or either. */
export function lockTallyOf(counts: ReplayCounts, id: OptionId, opened: Opened | "all" = "all", bucket: Bucket | "all" = "all"): LockTally {
  const sum = emptyLock();
  for (const o of OPENED) if (opened === "all" || opened === o) for (const b of BUCKETS) if (bucket === "all" || bucket === b) addNumbers(sum, counts.locks[id][o][b]);
  return sum;
}
export function openTallyOf(counts: ReplayCounts, opened: Opened | "all" = "all", bucket: Bucket | "all" = "all"): OpenTally {
  const sum = emptyOpen();
  for (const o of OPENED) if (opened === "all" || opened === o) for (const b of BUCKETS) if (bucket === "all" || bucket === b) addNumbers(sum, counts.open[o][b]);
  return sum;
}

