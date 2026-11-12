/**
 * SPORTS VENUES, THE TRADE TAPE AND THE REPLAY: Crypto.com's public trades kept per game while
 * the game is listed, each taker buy followed to the result as a real position, and what a lock
 * (the holder's own sale of part of it) would have been at bids that were really there. Also the
 * same arithmetic on a position someone names, from the bid now.
 *
 * Every expected figure was worked out by hand from the trades and bids in each case. Money is
 * micro-dollars, quantities hundredths of a contract, prices hundredths of a cent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SportsCollector } from "../src/sportsVenues/collector";
import { lockTerms, stakeBackNet, stakeBackSold, stakeOf, tierBackNet, tierSold, centsOf } from "../src/sportsVenues/lockMath";
import { lockChoices, lockNow } from "../src/sportsVenues/lockNow";
import type { HistoryCell, HistoryPoint } from "../src/sportsVenues/store";
import { TAPE_SEED_DIR, TapeRecord, tradeMs } from "../src/sportsVenues/tape";
import { BUCKETS, LIVE_OPTIONS, OPENED, OPTION_IDS, PRE_OPTIONS, lockTallyOf, openTallyOf, parseCapsule, replayGame, sumReplays, winnerFromLastPrices } from "../src/sportsVenues/tapeReplay";
import type { Game, Side, VenueListing } from "../src/sportsVenues/types";

const FEE = { theta: 0, flat: 2 };
const S = Date.parse("2026-11-12T00:00:00Z");
const MIN = 60_000;
const EVENT = "NBA-00001-261111-M";
const KEY = "nba:WAS:IND:2026-11-11";
const SYMBOLS: Record<Side, string> = { away: `NX.F.OPT.${EVENT}.O.1.1.20270731`, home: `NX.F.OPT.${EVENT}.O.1.2.20270731` };
const head = (startMs = S) => JSON.stringify({ k: "g", v: 1, event: EVENT, league: "nba", key: KEY, awayName: "Washington Wizards", homeName: "Indiana Pacers", startMs, symbols: SYMBOLS });
let nextId = 0;
const trade = (side: "a" | "h", atMs: number, qty: string, price: string, buy: 0 | 1) => JSON.stringify(["t", side, atMs, qty, price, buy, String(1_794_000_000_000_000_000n + BigInt((nextId += 1)))]);
const book = (side: "a" | "h", atMs: number, bidCents: number, qty: number) => JSON.stringify(["b", side, atMs, bidCents, qty]);
const result = (winner: Side | null) => JSON.stringify({ k: "r", atMs: S + 300 * MIN, winner, why: "test" });

/** One game: two positions on the away side (one before the start, one in play), one on the home side, which wins. */
const GAME_LINES = [
  head(),
  trade("a", S - 120 * MIN, "20", "0.40", 1),
  trade("a", S - 30 * MIN, "5", "0.41", 0),
  trade("a", S + 10 * MIN, "10", "0.50", 1),
  trade("a", S + 15 * MIN, "3", "0.97", 1),
  trade("a", S + 60 * MIN, "3", "0.70", 0),
  trade("a", S + 150 * MIN, "4", "0.02", 0),
  trade("h", S - 180 * MIN, "5", "0.60", 1),
  trade("h", S + 151 * MIN, "2", "0.99", 1),
  book("a", S + 20 * MIN, 54, 1000),
  book("a", S + 30 * MIN, 56, 5),
  book("a", S + 90 * MIN, 75, 2000),
  book("a", S + 100 * MIN, 97, 2000),
  book("h", S - 10 * MIN, 58, 50),
  result("home"),
];

test("the arithmetic of a lock: the sale's cash after the fee is the floor, the cap adds $1 on each contract kept", () => {
  // 20 contracts at 40¢ with 2¢ to open: $8.40
  const pos = { qty: 2000, price: 4000 };
  assert.equal(stakeOf(pos, FEE), 8_400_000);
  assert.equal(tierSold(2000, "wide"), 800);
  assert.equal(tierSold(2000, "balanced"), 1200);
  assert.equal(tierSold(2000, "tight"), 1600);
  // a hundredth of a contract is the least there is to sell, and it is sold
  assert.equal(tierSold(1, "wide"), 1);
  // Max upside at a 61¢ bid: 8 contracts at 59¢ after the fee
  const wide = lockTerms(pos, 800, 6100, FEE)!;
  assert.deepEqual({ cash: wide.cash, fee: wide.fee, cap: wide.cap, kept: wide.kept }, { cash: 4_720_000, fee: 160_000, cap: 16_720_000, kept: 1200 });
  // stake back at 61¢: 14.24 contracts is the fewest whose cash covers $8.40 (14.23 leaves $8.3957)
  assert.equal(stakeBackSold(pos, 5900, FEE), 1424);
  assert.equal(lockTerms(pos, 1424, 6100, FEE)!.cash, 8_401_600);
  // a bid that cannot return the stake even selling everything
  assert.equal(stakeBackSold(pos, 4100, FEE), null);
  // the lowest bid after the fee at which 80% or less returns the stake, and at which 40% returns half of it: the same price
  assert.equal(stakeBackNet(pos, FEE, 80), 5250);
  assert.equal(tierBackNet(pos, FEE, "wide", 50), 5250);
  // the fee eats the bid: nothing to sell
  assert.equal(lockTerms(pos, 800, 200, FEE), null);
  // the weighted fee, 0.07·p·(1−p): 1.68¢ to open at 40¢, 1.6653¢ to sell at 61¢, each up to a hundredth of a cent
  assert.equal(stakeOf(pos, { theta: 0.07 }), 2000 * (4000 + 168));
  assert.equal(lockTerms(pos, 800, 6100, { theta: 0.07 })!.net, 6100 - 167);
  // a holder's cash rounds down to the cent, a cost up
  assert.equal(centsOf(8_401_600, "down"), 840);
  assert.equal(centsOf(284_800, "up"), 29);
});

test("the replay of one game: each buy is a position, locked only at a bid that was there, and the result decides what the lock was worth", () => {
  const game = parseCapsule(GAME_LINES)!;
  assert.equal(game.winner, "home");
  const r = replayGame(game, FEE);
  assert.equal(r.trades, 8);
  assert.equal(r.winnerName, "Indiana Pacers");
  // the 97¢ bid and the 2¢ sale are outside 5 to 95 and price nothing
  assert.deepEqual({ book: r.bookPoints, sale: r.salePoints }, { book: 4, sale: 2 });
  assert.deepEqual(r.tape, { pre: { buys: 2, buyQty: 2500, sells: 1, sellQty: 500 }, live: { buys: 3, buyQty: 1500, sells: 2, sellQty: 700 } });
  // the 97¢ and 99¢ buys are on the tape and are not positions
  assert.equal(r.outside, 2);
  assert.deepEqual(r.open.pre.small, { n: 2, qty: 2500, stake: 11_500_000, lost: 1, lostStake: 8_400_000, won: 1, atStart: 2, aheadAtStart: 0 });
  assert.deepEqual(r.open.live.small, { n: 1, qty: 1000, stake: 5_200_000, lost: 1, lostStake: 5_200_000, won: 0, atStart: 0, aheadAtStart: 0 });
  assert.equal(r.open.pre.large.n + r.open.live.large.n, 0);

  // before the start: the away position at the 41¢ sale half an hour before, the home one at the 58¢ book bid
  const wide = r.locks.pre_wide.pre.small;
  assert.deepEqual(
    { eligible: wide.eligible, n: wide.n, sold: wide.sold, cash: wide.cash, fee: wide.fee, lost: wide.lost, lostStake: wide.lostStake, lostCash: wide.lostCash, won: wide.won, wonGaveUp: wide.wonGaveUp, atBook: wide.atBook, covered: wide.covered },
    { eligible: 2, n: 2, sold: 1000, cash: 3_120_000 + 1_120_000, fee: 200_000, lost: 1, lostStake: 8_400_000, lostCash: 3_120_000, won: 1, wonGaveUp: 880_000, atBook: 1, covered: 1 },
  );
  assert.equal(Math.round(wide.soldShareSum * 1e6), 800_000);
  assert.equal(Math.round(wide.backShareSum * 1e6), Math.round((3.12 / 8.4 + 1.12 / 3.1) * 1e6));
  assert.deepEqual([r.locks.pre_balanced.pre.small.lostCash, r.locks.pre_balanced.pre.small.wonGaveUp], [4_680_000, 1_320_000]);
  assert.deepEqual([r.locks.pre_tight.pre.small.lostCash, r.locks.pre_tight.pre.small.wonGaveUp], [6_240_000, 1_760_000]);

  // in play, the position opened before the start (20 at 40¢): the 54¢ bid is a cent short, the 56¢ bid is the first that does it
  const half = r.locks.live_half.pre.small;
  assert.deepEqual({ eligible: half.eligible, n: half.n, sold: half.sold, cash: half.cash, lost: half.lost, lostCash: half.lostCash, atBook: half.atBook, covered: half.covered, minutes: half.minutesSum }, { eligible: 2, n: 1, sold: 800, cash: 4_320_000, lost: 1, lostCash: 4_320_000, atBook: 1, covered: 0, minutes: 30 });
  const back80 = r.locks.live_back80.pre.small;
  assert.deepEqual({ n: back80.n, sold: back80.sold, cash: back80.cash, fee: back80.fee, lostStake: back80.lostStake, lostCash: back80.lostCash, covered: back80.covered }, { n: 1, sold: 1556, cash: 8_402_400, fee: 311_200, lostStake: 8_400_000, lostCash: 8_402_400, covered: 0 });
  // 60% or less needs 70¢ after the fee: not the 70¢ sale (68¢ after it), the 75¢ bid an hour and a half in
  const back60 = r.locks.live_back60.pre.small;
  assert.deepEqual({ n: back60.n, sold: back60.sold, cash: back60.cash, minutes: back60.minutesSum, covered: back60.covered }, { n: 1, sold: 1151, cash: 8_402_300, minutes: 90, covered: 1 });
  assert.equal(r.locks.live_back40.pre.small.n, 0);
  // the position opened in play (10 at 50¢): only bids after it count, and the 70¢ sale is the first that does it
  const halfLive = r.locks.live_half.live.small;
  assert.deepEqual({ eligible: halfLive.eligible, n: halfLive.n, sold: halfLive.sold, cash: halfLive.cash, atBook: halfLive.atBook, minutes: halfLive.minutesSum }, { eligible: 1, n: 1, sold: 400, cash: 2_720_000, atBook: 0, minutes: 60 });
  assert.deepEqual([r.locks.live_back80.live.small.sold, r.locks.live_back80.live.small.cash], [765, 5_202_000]);
  assert.equal(r.locks.live_back60.live.small.n, 0);
  // the home position had no bid in play to lock at
  assert.equal(lockTallyOf(r, "live_back80").won, 0);

  // a game with no result counts its tape and nothing after it
  const open = replayGame(parseCapsule(GAME_LINES.slice(0, -1).concat(result(null)))!, FEE);
  assert.equal(open.winner, null);
  assert.equal(open.tape.live.buys, 3);
  assert.equal(openTallyOf(open).n, 0);
  const summed = sumReplays([r, open]);
  assert.equal(summed.all.games, 1);
  assert.equal(summed.noResult.length, 1);
  assert.equal(summed.byLeague.nba.trades, 8);
  assert.equal(openTallyOf(summed.all).n, 3);
});

test("a game's file: the last header wins, a trade kept twice counts once, a torn line is passed over, and the result is read from the last prints", () => {
  const twice = GAME_LINES[1];
  const moved = parseCapsule([head(S), twice, twice, '["t","a",', head(S + 30 * MIN), "not json"])!;
  assert.equal(moved.startMs, S + 30 * MIN);
  assert.equal(moved.trades.away.length, 1);
  assert.equal(moved.winner, undefined);
  assert.equal(parseCapsule([twice]), null);
  assert.equal(winnerFromLastPrices({ away: 9900, home: 100 }), "away");
  assert.equal(winnerFromLastPrices({ away: 900, home: 9900 }), "home");
  // a thin game: nobody bought the winner after the whistle, the loser's contract printed the result
  assert.equal(winnerFromLastPrices({ away: 8500, home: 100 }), "away");
  assert.equal(winnerFromLastPrices({ away: 200, home: 9600 }), "home");
  assert.equal(winnerFromLastPrices({ away: 4900, home: 100 }), null);
  assert.equal(winnerFromLastPrices({ away: 8500, home: 400 }), null);
  // still open, both high (a late turn nobody traded after), or one side never traded: no result
  assert.equal(winnerFromLastPrices({ away: 9600, home: 400 }), null);
  assert.equal(winnerFromLastPrices({ away: 9900, home: 9900 }), null);
  assert.equal(winnerFromLastPrices({ away: 9900, home: null }), null);
  // the venue's `t` moves by a millisecond between calls; the id is the match time in nanoseconds
  assert.equal(tradeMs("1794497911724330584", 1794497911725), 1794497911724);
  assert.equal(tradeMs("abc", 1794497911725), 1794497911725);
});

// ---------------------------------------------------------------------------
// the tape against a venue that answers as Crypto.com's does
// ---------------------------------------------------------------------------

interface VenueTrade {
  d: string;
  t: number;
  q: string;
  p: string;
  s: "buy" | "sell";
}
function fakeVenue() {
  const tapes = new Map<string, VenueTrade[]>();
  const calls: string[] = [];
  let seq = 0;
  const add = (symbol: string, atMs: number, q: string, p: string, s: "buy" | "sell" = "buy") => {
    const d = String(BigInt(atMs) * 1_000_000n + BigInt((seq += 1)));
    // the venue's `t` is sometimes a millisecond after the id's
    (tapes.get(symbol) ?? tapes.set(symbol, []).get(symbol)!).push({ d, t: atMs + (seq % 2), q, p, s });
  };
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const symbol = url.searchParams.get("instrument_name") ?? "";
    const count = Number(url.searchParams.get("count"));
    const end = url.searchParams.get("end_ts");
    if (count > 150) return new Response(JSON.stringify({ code: 40004, message: "Invalid count" }), { status: 400 });
    if (!tapes.has(symbol)) return new Response(JSON.stringify({ code: 40004, message: "Invalid instrument_name" }), { status: 400 });
    // as the venue does: with no start_ts it looks back 24 hours from end_ts, or from the newest trade here
    const all = [...tapes.get(symbol)!].sort((a, b) => (a.d < b.d ? 1 : -1));
    const ms = (x: VenueTrade) => Number(BigInt(x.d) / 1_000_000n);
    const to = end === null ? (all.length ? ms(all[0]) : 0) : Number(end);
    const from = url.searchParams.has("start_ts") ? Number(url.searchParams.get("start_ts")) : to - 24 * 3_600_000;
    const rows = all.filter((x) => ms(x) <= to && ms(x) >= from);
    return new Response(JSON.stringify({ code: 0, result: { data: rows.slice(0, count) } }), { status: 200 });
  }) as typeof fetch;
  return { add, fetchImpl, calls, tapes };
}

const q = (bid: number, ask: number, qty = 1000) => ({ bidCents: bid, askCents: ask, bidQty: qty, askQty: qty });
const cdc = (away: [number, number], home: [number, number], startMs = S): VenueListing => ({ venue: "cryptocom", id: EVENT, away: q(...away), home: q(...home), feeTheta: 0, feeFlatCents: 2, awayName: "Washington Wizards", homeName: "Indiana Pacers", startsAt: new Date(startMs).toISOString() });
const kalshi: VenueListing = { venue: "kalshi", id: "k", away: q(40, 42), home: q(58, 60), feeTheta: 0.07, awayName: "WAS", homeName: "IND" };
const gameOf = (listing: VenueListing, startMs = S): Game => ({ key: KEY, league: "nba", awayCode: "WAS", homeCode: "IND", awayName: "Washington Wizards", homeName: "Indiana Pacers", startsAt: new Date(startMs).toISOString(), startSource: "venue", listings: [kalshi, listing] });
const PAIRS = new Map([[EVENT, SYMBOLS]]);
const tradeLines = (dir: string) => readFileSync(join(dir, `${EVENT}.tape.jsonl`), "utf8").split("\n").filter((l) => l.startsWith('["t"'));

test("the tape: read back page by page to the last trade kept, each trade once, a restart carries on, and a game far from its start is not asked every pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-tape-"));
  const venue = fakeVenue();
  const now = S - 10 * MIN;
  // two trades from two days before, with a quiet day between them and the rest: they are part of the tape
  venue.add(SYMBOLS.away, now - 50 * 60 * MIN, "9", "0.38");
  venue.add(SYMBOLS.away, now - 49 * 60 * MIN, "9", "0.39");
  for (let i = 0; i < 398; i += 1) venue.add(SYMBOLS.away, now - 398 * 1000 + i * 1000, "1.50", "0.40");
  for (let i = 0; i < 3; i += 1) venue.add(SYMBOLS.home, now - 3000 + i * 1000, "2", "0.59", "sell");
  const make = () => new TapeRecord({ dir, fee: FEE, fetchImpl: venue.fetchImpl, seedDir: null, host: "http://venue.test" });

  const tape = make();
  // nothing is tracked before the files on disk have been read
  tape.track([gameOf(cdc([40, 41], [58, 59]))], PAIRS, now);
  assert.equal(tape.health().recording, 0);
  await tape.boot(now);
  tape.track([gameOf(cdc([40, 41], [58, 59]))], PAIRS, now);
  await tape.pass(now);
  assert.equal(tradeLines(dir).length, 403);
  assert.equal(new Set(tradeLines(dir).map((l) => JSON.parse(l)[6])).size, 403);
  // 400 trades at 150 a page: three pages, the page boundary asked for again by its millisecond; the three on the other side in one
  assert.equal(venue.calls.filter((c) => c.includes("O.1.1")).length, 3);
  assert.equal(venue.calls.filter((c) => c.includes("O.1.2")).length, 1);
  assert.deepEqual({ recording: tape.health().recording, trades: tape.health().recordingTrades }, { recording: 1, trades: 403 });
  // oldest first, the time the id's, the venue's own strings kept
  assert.deepEqual(JSON.parse(tradeLines(dir)[0]).slice(0, 6), ["t", "a", now - 50 * 60 * MIN, "9", "0.38", 1]);
  assert.ok(venue.calls.every((c) => c.includes("start_ts=1")));

  // ten minutes from the start: asked again on the next pass, and only what is new is added
  for (let i = 0; i < 5; i += 1) venue.add(SYMBOLS.away, now + 1000 + i, "3", "0.41");
  await tape.pass(now + MIN);
  assert.equal(tradeLines(dir).length, 408);

  // a restart: the file says where it ended
  const again = make();
  await again.boot(now + 2 * MIN);
  assert.deepEqual({ recording: again.health().recording, trades: again.health().recordingTrades }, { recording: 1, trades: 408 });
  venue.add(SYMBOLS.home, now + 2 * MIN, "7", "0.60");
  again.track([gameOf(cdc([40, 41], [58, 59]))], PAIRS, now + 2 * MIN);
  await again.pass(now + 2 * MIN);
  assert.equal(tradeLines(dir).length, 409);
  assert.equal(new Set(tradeLines(dir).map((l) => JSON.parse(l)[6])).size, 409);
  // one header: the game was already on file
  assert.equal(readFileSync(join(dir, `${EVENT}.tape.jsonl`), "utf8").split("\n").filter((l) => l.startsWith('{"k":"g"')).length, 1);

  // a start the venue moves is written down, and a game an hour from its start is asked every twenty minutes, not every pass
  again.track([gameOf(cdc([40, 41], [58, 59], S + 60 * MIN), S + 60 * MIN)], PAIRS, now + 3 * MIN);
  assert.equal(parseCapsule(readFileSync(join(dir, `${EVENT}.tape.jsonl`), "utf8").split("\n").filter(Boolean))!.startMs, S + 60 * MIN);
  await again.pass(now + 3 * MIN);
  const asked = venue.calls.length;
  await again.pass(now + 4 * MIN);
  assert.equal(venue.calls.length, asked);
  await again.pass(now + 24 * MIN);
  assert.equal(venue.calls.length, asked + 2);
});

test("the tape: a game is closed once it is over and its result is on the tape, with the book's bids from the window, and counted once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-tape-"));
  const venue = fakeVenue();
  venue.add(SYMBOLS.away, S - 120 * MIN, "20", "0.40");
  venue.add(SYMBOLS.home, S - 180 * MIN, "5", "0.60");
  venue.add(SYMBOLS.away, S + 150 * MIN, "4", "0.02", "sell");
  venue.add(SYMBOLS.home, S + 151 * MIN, "2", "0.99");
  const cell = (awayBid: number, homeBid: number, qty: number): HistoryCell => [awayBid, awayBid + 1, homeBid, homeBid + 1, 0, qty, qty, qty, qty, 0, 2];
  const point = (atMs: number, c: HistoryCell): HistoryPoint => ({ at: new Date(atMs).toISOString(), atMs, games: { [KEY]: { cryptocom: c }, "nba:OTHER:GAME:2026-11-11": { cryptocom: cell(10, 88, 5) } }, starts: { [KEY]: S } });
  const history = [point(S - 10 * MIN, cell(41, 58, 50)), point(S + 30 * MIN, cell(56, 43, 5)), point(S + 90 * MIN, cell(75, 24, 2000))];
  let failing = false;
  const tape = new TapeRecord({ dir, fee: FEE, fetchImpl: venue.fetchImpl, seedDir: null, host: "http://venue.test", guard: (_what, write) => (failing ? false : (write(), true)) });
  await tape.boot(S);
  tape.track([gameOf(cdc([40, 41], [58, 59]))], PAIRS, S);

  // three hours in: the last prints give a result, the game is not yet four and a half hours old
  await tape.pass(S + 180 * MIN, history);
  assert.equal(tape.health().closed, 0);
  // four and a half hours in, with a trade ten minutes ago: not quiet yet
  venue.add(SYMBOLS.home, S + 262 * MIN, "1", "0.99");
  await tape.pass(S + 272 * MIN, history);
  assert.equal(tape.health().closed, 0);
  // the disk refuses the write: the game stays open and is closed on a later pass
  failing = true;
  await tape.pass(S + 300 * MIN, history);
  assert.equal(tape.health().closed, 0);
  failing = false;
  await tape.pass(S + 301 * MIN, history);
  assert.deepEqual({ recording: tape.health().recording, closed: tape.health().closed, withResult: tape.health().closedWithResult }, { recording: 0, closed: 1, withResult: 1 });

  const lines = readFileSync(join(dir, `${EVENT}.tape.jsonl`), "utf8").split("\n").filter(Boolean);
  // the window's readings of this game only, both sides, then the result last
  assert.equal(lines.filter((l) => l.startsWith('["b"')).length, 6);
  assert.deepEqual(JSON.parse(lines[lines.length - 1]).winner, "home");
  const report = tape.report();
  assert.equal(report.all.games, 1);
  assert.equal(report.all.gamesWithBook, 1);
  // 20 at 40¢ before the start, the 41¢ book bid ten minutes before it: Max upside leaves $3.12 of the $8.40; in play the 56¢ bid returns the stake
  assert.equal(lockTallyOf(report.all, "pre_wide").lostCash, 3_120_000 + 0);
  assert.equal(lockTallyOf(report.all, "live_back80").lostCash, 8_402_400);
  assert.equal(lockTallyOf(report.all, "live_back60").lostCash, 8_402_300);
  // a closed game is not tracked or asked for again
  const asked = venue.calls.length;
  tape.track([gameOf(cdc([1, 2], [98, 99]))], PAIRS, S + 302 * MIN);
  await tape.pass(S + 302 * MIN, history);
  assert.equal(venue.calls.length, asked);
  assert.equal(tape.health().recording, 0);

  // a restart reads the stored replay; the same file under another fee is worked out again
  assert.ok(existsSync(join(dir, "replay.json")));
  const same = new TapeRecord({ dir, fee: FEE, seedDir: null });
  await same.boot(S + 400 * MIN);
  assert.deepEqual(same.report().all, report.all);
  const weighted = new TapeRecord({ dir, fee: { theta: 0.07 }, seedDir: null });
  await weighted.boot(S + 400 * MIN);
  assert.equal(weighted.report().all.games, 1);
  assert.notEqual(lockTallyOf(weighted.report().all, "pre_wide").lostCash, 3_120_000);
  // a stored replay that cannot be read is worked out again and said
  writeFileSync(join(dir, "replay.json"), "{");
  const mended = new TapeRecord({ dir, fee: FEE, seedDir: null });
  await mended.boot(S + 400 * MIN);
  assert.deepEqual(mended.report().all, report.all);
  assert.match(String(mended.health().note), /worked out again from the games' files/);
});

test("the tape: a game with no result thirty hours after its start is closed and listed, not counted; a delisted contract is not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-tape-"));
  const venue = fakeVenue();
  venue.add(SYMBOLS.away, S - 60 * MIN, "20", "0.40");
  venue.add(SYMBOLS.home, S - 50 * MIN, "5", "0.60");
  const tape = new TapeRecord({ dir, fee: FEE, fetchImpl: venue.fetchImpl, seedDir: null, host: "http://venue.test" });
  await tape.boot(S);
  tape.track([gameOf(cdc([40, 41], [58, 59]))], PAIRS, S);
  await tape.pass(S + 6 * 60 * MIN);
  assert.equal(tape.health().closed, 0);
  // the venue stops publishing the contracts
  venue.tapes.clear();
  await tape.pass(S + 7 * 60 * MIN);
  assert.equal(tape.health().lastError, undefined);
  await tape.pass(S + 30 * 60 * MIN);
  assert.deepEqual({ closed: tape.health().closed, withResult: tape.health().closedWithResult }, { closed: 1, withResult: 0 });
  assert.equal(tape.report().all.games, 0);
  assert.equal(tape.report().noResult[0].trades, 2);
});

test("the games shipped with the code: copied in once, every one closed with a result, and the sums hold together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-tape-"));
  const shipped = readdirSync(TAPE_SEED_DIR).filter((f) => f.endsWith(".tape.jsonl"));
  assert.ok(shipped.length >= 16);
  const tape = new TapeRecord({ dir, fee: FEE });
  await tape.boot();
  assert.deepEqual({ closed: tape.health().closed, withResult: tape.health().closedWithResult, copied: tape.health().copiedFromCode, recording: tape.health().recording }, { closed: shipped.length, withResult: shipped.length, copied: shipped.length, recording: 0 });
  const again = new TapeRecord({ dir, fee: FEE });
  await again.boot();
  assert.deepEqual({ closed: again.health().closed, copied: again.health().copiedFromCode }, { closed: shipped.length, copied: 0 });

  const r = tape.report();
  assert.equal(r.games.length, shipped.length);
  const all = openTallyOf(r.all);
  assert.ok(all.n > 10_000);
  assert.equal(all.lost + all.won, all.n);
  const buys = r.all.tape.pre.buys + r.all.tape.live.buys;
  assert.equal(all.n + r.all.outside, buys);
  assert.equal(r.all.trades, buys + r.all.tape.pre.sells + r.all.tape.live.sells);
  for (const id of OPTION_IDS) {
    const t = lockTallyOf(r.all, id);
    assert.ok(t.n > 0 && t.n <= t.eligible, id);
    assert.equal(t.lost + t.won, t.n, id);
    assert.ok(t.sold <= t.qty && t.cash > 0 && t.fee === t.sold * 200, id);
    // a lock never leaves a loser with more than everyone paid plus a rounding step each, and never gives up more than $1 a contract sold
    assert.ok(t.lostCash <= t.lostStake + t.lost * 10_000 || PRE_OPTIONS.includes(id), id);
    assert.ok(t.wonGaveUp >= 0 && t.wonGaveUp <= t.sold * 10_000, id);
  }
  // stake back returns the stake, to within the smallest size sold
  const back = lockTallyOf(r.all, "live_back80");
  assert.ok(back.lostCash >= back.lostStake && back.lostCash - back.lostStake < back.lost * 10_000);
  // the three stake-back rows nest, and the positions before the start are the same positions under every tier
  assert.ok(lockTallyOf(r.all, "live_back40").n <= lockTallyOf(r.all, "live_back60").n && lockTallyOf(r.all, "live_back60").n <= back.n);
  assert.equal(lockTallyOf(r.all, "pre_wide").n, lockTallyOf(r.all, "pre_tight").n);
  for (const id of LIVE_OPTIONS) for (const o of OPENED) for (const b of BUCKETS) assert.equal(r.all.locks[id][o][b].eligible, r.all.open[o][b].n);
});

// ---------------------------------------------------------------------------
// Lock in now, and the pages
// ---------------------------------------------------------------------------

test("lock in now: the three sizes before the start, stake back first in play, and in words when there is nothing to sell into", () => {
  const before = S - 60 * MIN;
  const pre = lockNow([gameOf(cdc([40, 41], [58, 59]))], { game: `${KEY}|away`, contracts: "20" }, FEE, before)!;
  // no price given: the ask now, 41¢, so $8.60 with the fee
  assert.deepEqual({ paid: pre.paidCents, assumed: pre.paidAssumed, stake: pre.stakeCents, full: pre.fullWinCents, inPlay: pre.inPlay }, { paid: 41, assumed: true, stake: 860, full: 2000, inPlay: false });
  assert.deepEqual(pre.options.map((o) => o.id), ["wide", "balanced", "tight"]);
  // Max upside: 8 at 40¢ less 2¢ = $3.04, and $1 on the 12 kept
  assert.deepEqual({ sold: pre.options[0].sold, floor: pre.options[0].floorCents, fee: pre.options[0].feeCents, cap: pre.options[0].capCents, back: pre.options[0].backPercent, covered: pre.options[0].covered }, { sold: 8, floor: 304, fee: 16, cap: 1504, back: 35, covered: true });
  // stake back needs 80% or less to return $8.60: 53.75¢ after the fee, so a 56¢ bid
  assert.equal(pre.stakeBackOpensAtCents, 56);
  // and it is shown from the first bid that leaves anything riding: $8.60 from 19.99 contracts is 43.03¢ after the fee, a 46¢ bid
  assert.equal(pre.stakeBackFromCents, 46);

  const live = lockNow([gameOf(cdc([61, 62], [37, 38]))], { game: `${KEY}|away`, contracts: "20", paid: "40" }, FEE, S + 30 * MIN)!;
  assert.equal(live.inPlay, true);
  assert.deepEqual(live.options.map((o) => o.id), ["back", "wide", "balanced", "tight"]);
  // 14.24 contracts at 59¢ after the fee: $8.40 back, 5.76 riding
  assert.deepEqual({ sold: live.options[0].sold, kept: live.options[0].kept, floor: live.options[0].floorCents, cap: live.options[0].capCents, fee: live.options[0].feeCents, back: live.options[0].backPercent }, { sold: 14.24, kept: 5.76, floor: 840, cap: 1416, fee: 29, back: 100 });
  assert.deepEqual({ floor: live.options[1].floorCents, cap: live.options[1].capCents, back: live.options[1].backPercent }, { floor: 472, cap: 1672, back: 56 });
  assert.equal(live.stakeBackOpensAtCents, undefined);
  assert.equal(live.stakeBackFromCents, undefined);
  // shown, but selling more than the 80% the replay counts: 50 at 60¢ cost $31.00, a 72¢ bid returns it from 44.29 contracts (89%);
  // 80% or less needs 77.5¢ after the fee, an 80¢ bid
  const thin = lockNow([gameOf(cdc([72, 73], [27, 28]))], { game: `${KEY}|away`, contracts: "50", paid: "60" }, FEE, S + 30 * MIN)!;
  assert.deepEqual({ id: thin.options[0].id, sold: thin.options[0].sold, kept: thin.options[0].kept, floor: thin.options[0].floorCents }, { id: "back", sold: 44.29, kept: 5.71, floor: 3100 });
  assert.deepEqual({ counted: thin.stakeBackOpensAtCents, from: thin.stakeBackFromCents }, { counted: 80, from: undefined });
  // one cent on either side of it: an 80¢ bid returns the stake from 39.75 of the 50, a 79¢ bid needs 40.26
  assert.equal(lockNow([gameOf(cdc([80, 81], [19, 20]))], { game: `${KEY}|away`, contracts: "50", paid: "60" }, FEE, S)!.stakeBackOpensAtCents, undefined);
  assert.equal(lockNow([gameOf(cdc([79, 80], [20, 21]))], { game: `${KEY}|away`, contracts: "50", paid: "60" }, FEE, S)!.stakeBackOpensAtCents, 80);
  // a sale larger than the bid's size is said
  assert.equal(lockNow([gameOf({ ...cdc([61, 62], [37, 38]), away: q(61, 62, 10) })], { game: `${KEY}|away`, contracts: "20", paid: "40" }, FEE, S)!.options[0].covered, false);

  // a favourite at 90¢: no bid up to 95¢ returns the stake by selling 80% or less
  // (at 95¢ it appears, selling all but a hundredth of a contract)
  const favourite = lockNow([gameOf(cdc([8, 9], [90, 91]))], { game: `${KEY}|home`, contracts: "10", paid: "90" }, FEE, S)!;
  assert.deepEqual({ counted: favourite.stakeBackOpensAtCents, from: favourite.stakeBackFromCents }, { counted: null, from: 95 });
  // a hundredth of a contract has nothing to leave riding
  assert.deepEqual({ counted: lockNow([gameOf(cdc([40, 41], [58, 59]))], { game: `${KEY}|away`, contracts: "0.01", paid: "20" }, FEE, S)!.stakeBackOpensAtCents, from: lockNow([gameOf(cdc([40, 41], [58, 59]))], { game: `${KEY}|away`, contracts: "0.01", paid: "20" }, FEE, S)!.stakeBackFromCents }, { counted: null, from: null });
  assert.match(lockNow([gameOf(cdc([0, 2], [97, 98]))], { game: `${KEY}|away` }, FEE, S)!.note!, /no bid on this side/);
  assert.match(lockNow([gameOf(cdc([1, 2], [97, 98]))], { game: `${KEY}|home` }, FEE, S)!.note!, /Outside 5¢ to 95¢/);
  assert.equal(lockNow([gameOf(cdc([40, 41], [58, 59]))], { game: "nba:NO:GAME:2026-11-11|away" }, FEE, S), null);
  assert.equal(lockNow([{ ...gameOf(kalshi), listings: [kalshi] }], { game: `${KEY}|away` }, FEE, S), null);

  // the list: only sides with a bid, in play first
  const later: Game = { ...gameOf(cdc([0, 2], [97, 98], S + 60 * MIN), S + 60 * MIN), key: "nba:AAA:BBB:2026-11-11" };
  assert.deepEqual(lockChoices([later, gameOf(cdc([61, 62], [37, 38]))], S + 30 * MIN).map((c) => [c.value, c.inPlay]), [[`${KEY}|away`, true], [`${KEY}|home`, true], ["nba:AAA:BBB:2026-11-11|home", false]]);
});

test("the collector: the games shipped are replayed on start-up, and the replay and the lock are served as pages and as JSON under the host's key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-tape-"));
  const seedDir = join(dir, "seed");
  mkdirSync(seedDir);
  writeFileSync(join(seedDir, `${EVENT}.tape.jsonl`), `${GAME_LINES.join("\n")}\n`);
  const live: Game = { ...gameOf({ ...cdc([61, 62], [37, 38], Date.now() - 30 * MIN), id: "NBA-00002-261112-M" }, Date.now() - 30 * MIN), key: "nba:AAA:BBB:2026-11-12" };
  const collector = new SportsCollector({ dataDir: join(dir, "data"), log: () => {}, readGames: async () => [live], tape: { seedDir } });
  await collector.load();
  await collector.collectOnce();
  await collector.tapePass();
  const get = (path: string): { status: number; body: string } => {
    const out = { status: 0, body: "" };
    const res = { writeHead: (status: number) => ((out.status = status), res), end: (body: string) => (out.body = body) } as unknown as ServerResponse;
    assert.equal(collector.handle({} as IncomingMessage, res, path.split("?")[0], new URL(path, "http://localhost"), { links: [{ label: "BTC curve", href: "/?k=key1" }, { label: "Sports", href: "/sports?k=key1" }] }), true);
    return out;
  };
  assert.deepEqual({ closed: (collector.health().tape as { closed: number }).closed, copied: (collector.health().tape as { copiedFromCode: number }).copiedFromCode }, { closed: 1, copied: 1 });

  const replay = get("/replay");
  assert.equal(replay.status, 200);
  assert.match(replay.body, /<h1>Lock in, replayed on real trades<\/h1>/);
  assert.match(replay.body, /Games counted <b>1<\/b>/);
  assert.match(replay.body, /Positions opened <b>3<\/b>/);
  // the three pages link to each other with the host's key
  assert.match(replay.body, /href="\/sports\?k=key1"/);
  assert.match(replay.body, /href="\/sports\/lock\?k=key1"/);
  assert.ok(!replay.body.includes("—"));
  const json = JSON.parse(get("/api/replay").body);
  assert.equal(json.report.all.games, 1);
  assert.deepEqual(json.fee, { theta: 0, flat: 2 });

  const lock = get(`/lock?game=${encodeURIComponent("nba:AAA:BBB:2026-11-12|away")}&n=20&paid=40`);
  assert.equal(lock.status, 200);
  assert.match(lock.body, /Stake back: sells just enough to return what you paid/);
  assert.match(lock.body, /Sell 14\.24 of 20 contracts \(71%\) at 61¢/);
  assert.match(lock.body, /you keep <b>\$8\.40<\/b> instead of \$0\.00/);
  assert.match(lock.body, /name="k" value="key1"/);
  assert.match(lock.body, /action="\/sports\/lock"/);
  assert.ok(!lock.body.includes("—"));
  assert.ok(!lock.body.includes("The replay page counts stake back once"));
  // 20 at 52¢ cost $10.80: the 61¢ bid returns it from 18.31 contracts, more than the 80% the replay counts, and the card says so
  const thin = get(`/lock?game=${encodeURIComponent("nba:AAA:BBB:2026-11-12|away")}&n=20&paid=52`).body;
  assert.match(thin, /Sell 18\.31 of 20 contracts \(92%\) at 61¢/);
  assert.match(thin, /Only 1\.69 of 20 contracts are left riding\. The replay page counts stake back once it sells 80% or less: on this position, from a bid of 70¢\./);
  assert.ok(!thin.includes("Stake back is not available"));
  // no price given: paid the 62¢ ask, so the 61¢ bid cannot return it; where it appears and where the replay counts it
  assert.match(get("/lock").body, /Stake back is not available at this bid: returning what was paid would take the whole position or more\. It appears at 67¢, where it sells nearly all of the position\. From 82¢ it sells 80% or less and the rest rides at no cost, which is where the replay page counts it\./);
  // with nothing asked for the first position on the list is shown
  assert.match(get("/lock").body, /Position <b>20 contracts at 62¢<\/b>/);
  assert.equal(JSON.parse(get("/api/lock?n=5").body).quote.contracts, 5);
  // the board links to both
  assert.match(get("/").body, /href="\/sports\/replay\?k=key1"/);
  collector.stop();
});
