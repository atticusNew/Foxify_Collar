/**
 * DKeX from its public daily files: the rows read, a game assembled, which way a trade went read
 * from its price and how far that is off where the truth is published, the record that ships
 * with the code, and the page made for DraftKings with its key.
 *
 * Run: npx tsx --test tests/sportsDkex.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIENCES } from "../src/sportsVenues/audiences";
import { SportsCollector, sportsCollectorFromEnv } from "../src/sportsVenues/collector";
import { DKEX_MATURITY_AFTER_MS, DKEX_SALE_UNDER, DkexAssembler, capsuleOfGame, csvFields, dkexMinuteMs, maturityOf, printOf, settlementOf, sideOfPrints, winnerSymbol, type DkexGame } from "../src/sportsVenues/dkex";
import { DKEX_FEE, DKEX_STORIES_KEPT, dkexLeague, dkexRecordOf, loadDkexRecord, replayDkexGame } from "../src/sportsVenues/dkexRecord";
import { EXCHANGE_DEFAULTS, EXCHANGE_OPTIONS, EXCHANGE_SCRIPT, exchangeRows, storiesToTell } from "../src/sportsVenues/draftkingsHtml";
import { lockAtPrice } from "../src/sportsVenues/lockNow";
import type { BrokerBase } from "../src/sportsVenues/prospectHtml";
import { TAPE_SEED_DIR } from "../src/sportsVenues/tape";
import { REPLAY_VERSION, lockTallyOf, openTallyOf, parseCapsule, replayGame, sumReplays, type Capsule, type GameReplay, type StoryRow } from "../src/sportsVenues/tapeReplay";

const KEY = "draftkings-key-0123456789";
const READER = "reader-key-0123456789";
const INTERNAL = "internal-key-0123456789";
const MIN = 60_000;
/** Nov 12, 2026, 8:15 PM EST */
const START = Date.UTC(2026, 10, 13, 1, 15);

test("the rows: Eastern times with their zone, a price in dollars, a name with a comma, and a contract that is a team to win a game", () => {
  assert.equal(dkexMinuteMs("11/12/26 08:15 PM EST"), START);
  assert.equal(dkexMinuteMs("11/12/26 12:33:10.991 AM EST"), Date.UTC(2026, 10, 12, 5, 33));
  assert.equal(dkexMinuteMs("09/30/26 09:38 PM EDT"), Date.UTC(2026, 9, 1, 1, 38));
  assert.equal(dkexMinuteMs("11/12/26 12:00 PM EST"), Date.UTC(2026, 10, 12, 17, 0));
  // no zone on the row: Eastern as the calendar has it that day
  assert.equal(dkexMinuteMs("10/20/26 07:00 PM"), Date.UTC(2026, 9, 20, 23, 0));
  assert.equal(dkexMinuteMs("11/02/26 07:00 PM"), Date.UTC(2026, 10, 3, 0, 0));
  for (const bad of ["", "2026-11-12 20:15", "11/12/26 08:15"]) assert.equal(dkexMinuteMs(bad), null, bad);

  assert.deepEqual(winnerSymbol("NFL-WIN-FG-01OB1NMNVVN4INO-NYTS002"), { league: "NFL", event: "01OB1NMNVVN4INO", club: "NYTS002" });
  assert.deepEqual(winnerSymbol("NBAPRE-WIN-FG-00UC-AAA"), { league: "NBAPRE", event: "00UC", club: "AAA" });
  for (const other of ["COMBO-15912211007094360325", "NFL-MOVY-FG-01OB-NYTS002-GTE-P00035", "NHL-TGLS-FG-00CB-GTE-P00065", "ATP-WIN-MTH-0002-TOEK032"]) assert.equal(winnerSymbol(other), null, other);

  assert.deepEqual(csvFields('"Smith, Jr.",a,"say ""hi""",'), ["Smith, Jr.", "a", 'say "hi"', ""]);
  // the files end their rows with a carriage return
  assert.deepEqual(printOf("20261113,NFL-WIN-FG-01OB1NMNVVN4INO-NYTS002,11/12/26 08:52 PM EST,$0.48,100\r"), { symbol: "NFL-WIN-FG-01OB1NMNVVN4INO-NYTS002", minuteMs: START + 37 * MIN, price: 4800, qty: 10_000 });
  assert.equal(printOf("Business Date,Symbol,Transaction Date and Time,Last Price (USD),Last Quantity"), null);
  assert.equal(printOf("20261113,X,11/12/26 08:52 PM EST,$0.00,100"), null);
  assert.deepEqual(maturityOf("20261112,NFL-WIN-FG-E-NYG,Open,10,20,$0.55,$0.45,$0.50,12/12/26 08:15 PM EST"), { symbol: "NFL-WIN-FG-E-NYG", maturityMs: START + DKEX_MATURITY_AFTER_MS });
  assert.deepEqual(settlementOf('"NY Giants",NFL-WIN-FG-E-NYG,Settled Early,11/12/26 11:21:13.842 PM EST,$0.00'), { symbol: "NFL-WIN-FG-E-NYG", name: "NY Giants", settledMs: START + 186 * MIN, won: false });
  assert.equal(settlementOf("WAS Commanders,NFL-WIN-FG-E-WAS,Settled Early,11/12/26 11:21:13.842 PM EST,$1.00")?.won, true);
  assert.equal(settlementOf("A Tie,NFL-WIN-FG-T-AAA,Settled Early,11/12/26 11:21 PM EST,$0.50")?.won, null);
  assert.equal(dkexLeague("cfb"), "College football");
  assert.equal(dkexLeague("xfl"), "XFL");
});

test("which way a trade went, from its price: the higher of two prices a cent apart is a buy, the other contract says the rest, and the last move breaks a tie", () => {
  const p = (minute: number, side: "away" | "home", cents: number) => ({ t: START + minute * MIN, side, price: cents * 100 });
  // one minute, away at 54 and 55: buyers paid 55, sellers got 54
  assert.deepEqual(sideOfPrints([p(0, "away", 55), p(0, "away", 54), p(0, "away", 55)]), [true, false, true]);
  // away at one price only, home at 45 and 46: the pair adds to $1.01 to buy, so away's buy is 55 and its sale 54
  assert.deepEqual(sideOfPrints([p(1, "home", 46), p(1, "home", 45), p(1, "away", 55)]), [true, false, true]);
  assert.deepEqual(sideOfPrints([p(1, "home", 46), p(1, "home", 45), p(1, "away", 54)]), [true, false, false]);
  // one price each: adding to $1.01 both are buys, to 99 cents both are sales
  assert.deepEqual(sideOfPrints([p(2, "away", 55), p(2, "home", 46)]), [true, true]);
  assert.deepEqual(sideOfPrints([p(2, "away", 54), p(2, "home", 45)]), [false, false]);
  // a minute that moved (three prices): the other contract's last price, then the contract's own last move
  assert.deepEqual(sideOfPrints([p(3, "home", 50), p(4, "away", 48), p(4, "away", 51), p(4, "away", 53)]), [true, false, true, true]);
  assert.deepEqual(sideOfPrints([p(5, "away", 50), p(6, "away", 52), p(6, "away", 49), p(6, "away", 47), p(7, "away", 47)]), [true, true, false, false, false]);
  // nothing to read it from: a buy
  assert.deepEqual(sideOfPrints([p(8, "away", 50)]), [true]);
  assert.deepEqual(sideOfPrints([]), []);
});

/** One game as the three files give it: NYG and WAS, WAS winning, with a college game that tied and a contract with no partner. */
function threeFiles(): DkexAssembler {
  const a = new DkexAssembler();
  const market = (symbol: string, maturity: string) => a.market(`20261112,${symbol},Open,10,20,$0.55,$0.45,$0.50,${maturity}\r`);
  market("NFL-WIN-FG-E1-WAS", "12/12/26 08:15 PM EST");
  market("NFL-WIN-FG-E1-NYG", "12/12/26 08:15 PM EST");
  market("CFB-WIN-FG-E2-AAA", "12/12/26 12:00 PM EST");
  market("CFB-WIN-FG-E2-BBB", "12/12/26 12:00 PM EST");
  market("NBA-WIN-FG-E3-CCC", "12/12/26 07:10 PM EST");
  market("NFL-MOVY-FG-E1-WAS-GTE-P00035", "12/12/26 08:15 PM EST");
  a.settlement("WAS Commanders,NFL-WIN-FG-E1-WAS,Settled Early,11/12/26 11:21:13.842 PM EST,$1.00\r");
  a.settlement("NY Giants,NFL-WIN-FG-E1-NYG,Settled Early,11/12/26 11:21:13.842 PM EST,$0.00\r");
  a.settlement("AAA Aces,CFB-WIN-FG-E2-AAA,Settled Early,11/12/26 03:30 PM EST,$0.50\r");
  a.settlement("BBB Bees,CFB-WIN-FG-E2-BBB,Settled Early,11/12/26 03:30 PM EST,$0.50\r");
  const print = (symbol: string, time: string, price: string, qty: number) => a.print(`20261113,${symbol},11/12/26 ${time} EST,$${price},${qty}\r`);
  // an hour before the start: 100 of NYG at 48 cents, $50.00 with the fee; WAS at 53 beside it, so both are buys
  print("NFL-WIN-FG-E1-WAS", "07:15 PM", "0.53", 40);
  print("NFL-WIN-FG-E1-NYG", "07:15 PM", "0.48", 100);
  print("COMBO-1", "07:15 PM", "0.20", 5);
  // 40 minutes in: NYG at 67 and 66 in one minute, the 66 a sale
  print("NFL-WIN-FG-E1-NYG", "08:55 PM", "0.67", 10);
  print("NFL-WIN-FG-E1-NYG", "08:55 PM", "0.66", 30);
  print("NFL-WIN-FG-E1-NYG", "08:55 PM", "0.67", 10);
  // then it goes the other way: 4 cents and 97 add to $1.01, so both are read as buys
  print("NFL-WIN-FG-E1-NYG", "10:30 PM", "0.04", 10);
  print("NFL-WIN-FG-E1-WAS", "10:30 PM", "0.97", 10);
  print("CFB-WIN-FG-E2-AAA", "11:00 AM", "0.50", 10);
  return a;
}

test("a game out of the three files: two contracts, the start thirty days before maturity, the result from the settlement, the trades in the file's order", () => {
  const a = threeFiles();
  assert.equal(a.winnerPrints, 8);
  assert.equal(a.winnerQty, 22_000);
  const { games, listed } = a.games();
  // the NFL game and the college one; the lone NBA contract is not a game
  assert.equal(listed, 2);
  assert.deepEqual(games.map((g) => [g.league, g.event, g.winner, g.startMs]), [["CFB", "E2", null, Date.UTC(2026, 10, 12, 17, 0)], ["NFL", "E1", "home", START]]);
  const g = games[1];
  assert.deepEqual([g.symbols, g.names], [{ away: "NFL-WIN-FG-E1-NYG", home: "NFL-WIN-FG-E1-WAS" }, { away: "NY Giants", home: "WAS Commanders" }]);
  assert.deepEqual(g.prints.map((p) => [p.symbol.slice(-3), (p.minuteMs - START) / MIN, p.price / 100, p.qty / 100]), [["WAS", -60, 53, 40], ["NYG", -60, 48, 100], ["NYG", 40, 67, 10], ["NYG", 40, 66, 30], ["NYG", 40, 67, 10], ["NYG", 135, 4, 10], ["WAS", 135, 97, 10]]);

  // as the replay reads it: a trade read as a sale is kept a cent under its price, and a minute's trades keep their order
  const c = capsuleOfGame(g);
  assert.deepEqual([c.event, c.league, c.winner, c.book], ["NFL-E1", "nfl", "home", { away: [], home: [] }]);
  assert.deepEqual(c.trades.away.map((t) => [t.t - START, t.price, t.buy]), [[-60 * MIN + 1, 4800, true], [40 * MIN, 6700, true], [40 * MIN + 1, 6600 - DKEX_SALE_UNDER, false], [40 * MIN + 2, 6700, true], [135 * MIN, 400, true]]);
  assert.deepEqual(c.trades.home.map((t) => [t.t - START, t.price, t.buy]), [[-60 * MIN, 5300, true], [135 * MIN + 1, 9700, true]]);

  // the NYG ticket: $50.00 paid, the whole stake back 40 minutes in at 65 cents (a cent under the 66), and NYG lost
  const r = replayDkexGame(g);
  assert.equal(r.label, "NY Giants v WAS Commanders");
  const back = lockTallyOf(r, "live_back80", "pre", "small");
  assert.deepEqual({ n: back.n, lost: back.lost, lostStake: back.lostStake, lostCash: back.lostCash, minutes: Math.round(back.minutesSum) }, { n: 1, lost: 1, lostStake: 50_000_000, lostCash: 50_003_100, minutes: 40 });
  assert.deepEqual(r.stories, [{ side: "away", team: "NY Giants", qty: 10_000, price: 4800, openedMs: START - 60 * MIN + 1, atMs: START + 40 * MIN + 1, bid: 6500, bidQty: 3000, fromBook: false, won: false }]);

  // the record: the game with a result counted, the tie not, the per-game rows not kept
  const rec = dkexRecordOf(games, { builtAt: "2026-11-14T00:00:00.000Z", firstDay: "2026-11-12", lastDay: "2026-11-12", days: 1, exchange: { prints: 10, contracts: 225, comboContracts: 5, winnerPrints: a.winnerPrints, winnerContracts: 220 }, listed });
  assert.deepEqual([rec.v, rec.replay, rec.fee, rec.noResult, rec.report.all.games, rec.report.games, rec.report.noResult, Object.keys(rec.report.byLeague)], [1, REPLAY_VERSION, DKEX_FEE, 1, 1, [], [], ["nfl"]]);
  assert.equal(rec.report.stories.length, 1);
});

/** A game of a tape that publishes the side, as DKeX would publish it: the minute, the price and the size. */
function asDkexPublishes(c: Capsule): DkexGame {
  const rows = [...c.trades.away.map((t) => ({ ...t, symbol: "A" })), ...c.trades.home.map((t) => ({ ...t, symbol: "H" }))].sort((x, y) => x.t - y.t);
  return { league: c.league, event: c.event, symbols: { away: "A", home: "H" }, names: { away: c.awayName, home: c.homeName }, startMs: c.startMs, winner: c.winner ?? null, prints: rows.map((r) => ({ symbol: r.symbol, minuteMs: Math.floor(r.t / MIN) * MIN, price: r.price, qty: r.qty })) };
}

test("against the truth: on the tapes that publish the side, the replay read DKeX's way counts fewer tickets and no more locks than the replay read with the side", () => {
  const games = readdirSync(TAPE_SEED_DIR)
    .filter((f) => f.endsWith(".tape.jsonl"))
    .map((f) => parseCapsule(readFileSync(join(TAPE_SEED_DIR, f), "utf8").split("\n")))
    .filter((c): c is Capsule => c !== null && (c.winner === "away" || c.winner === "home"));
  assert.ok(games.length >= 31);

  // trade by trade, between 5 and 95 cents: a trade read as a buy is one nearly always; one read as a sale is one less than half the time
  let buys = 0;
  let buysRight = 0;
  let sales = 0;
  let salesRight = 0;
  for (const c of games) {
    const dk = capsuleOfGame(asDkexPublishes(c));
    for (const side of ["away", "home"] as const) {
      // the same trades in the same order: the tape's own within a minute
      const truth = [...c.trades[side]].sort((x, y) => x.t - y.t);
      assert.equal(dk.trades[side].length, truth.length);
      dk.trades[side].forEach((t, i) => {
        if (truth[i].price < 500 || truth[i].price > 9500) return;
        if (t.buy) {
          buys += 1;
          if (truth[i].buy) buysRight += 1;
        } else {
          sales += 1;
          if (!truth[i].buy) salesRight += 1;
        }
      });
    }
  }
  assert.ok(buysRight / buys > 0.96, `a trade read as a buy is a buy ${((buysRight / buys) * 100).toFixed(1)}% of the time`);
  assert.ok(salesRight / sales > 0.3 && salesRight / sales < 0.6, `a trade read as a sale is a sale ${((salesRight / sales) * 100).toFixed(1)}% of the time`);

  const figures = (replays: GameReplay[]) => {
    const t = sumReplays(replays).all;
    const retail = openTallyOf(t, "all", "small");
    const back = lockTallyOf(t, "live_back80", "all", "small");
    const half = lockTallyOf(t, "live_half", "all", "small");
    return { tickets: retail.n, lost: retail.lost / retail.n, ahead: retail.lostAheadEver / retail.lost, back: back.n / back.eligible, backLost: back.lost / retail.lost, returned: back.lostCash / retail.lostStake, half: half.n / half.eligible };
  };
  const truth = figures(games.map((c) => replayGame(c, DKEX_FEE)));
  const read = figures(games.map((c) => replayDkexGame(asDkexPublishes(c))));
  // fewer tickets: a buy read as a sale is not followed
  assert.ok(read.tickets < truth.tickets && read.tickets > truth.tickets * 0.85, `${read.tickets} of ${truth.tickets} tickets`);
  // the lock figures at or under the truth, and within four points of it
  for (const k of ["back", "backLost", "returned", "half"] as const) assert.ok(read[k] <= truth[k] + 0.005 && read[k] > truth[k] - 0.04, `${k}: ${read[k].toFixed(4)} read, ${truth[k].toFixed(4)} true`);
  assert.ok(Math.abs(read.lost - truth.lost) < 0.03, `lost: ${read.lost.toFixed(4)} read, ${truth.lost.toFixed(4)} true`);
  // "ahead at some point" is the one that reads high: a buy read as a sale is a price above the one a holder would get
  assert.ok(read.ahead > truth.ahead && read.ahead < truth.ahead + 0.05, `ahead: ${read.ahead.toFixed(4)} read, ${truth.ahead.toFixed(4)} true`);
});

test("the record that ships with the code: of this replay's version, whole, and its counts add up", () => {
  const rec = loadDkexRecord();
  assert.ok(rec, "src/sportsVenues/dkexSeed/record.json is there and of this version");
  assert.deepEqual([rec.v, rec.replay, rec.fee], [1, REPLAY_VERSION, DKEX_FEE]);
  assert.match(rec.firstDay, /^2026-\d\d-\d\d$/);
  assert.ok(rec.lastDay >= "2026-11-13" && rec.days >= 150);
  const t = rec.report.all;
  assert.ok(t.games >= 4000 && t.games + rec.noResult <= rec.listed);
  assert.equal(Object.values(rec.report.byLeague).reduce((n, l) => n + l.games, 0), t.games);
  const all = openTallyOf(t);
  const retail = openTallyOf(t, "all", "small");
  assert.equal(all.lost + all.won, all.n);
  assert.equal(Object.values(rec.report.byLeague).reduce((n, l) => n + openTallyOf(l).n, 0), all.n);
  assert.ok(retail.n > 4_000_000 && retail.n <= all.n && retail.lostAheadEver <= retail.lost);
  const back = lockTallyOf(t, "live_back80", "all", "small");
  assert.equal(back.lost + back.won, back.n);
  assert.ok(back.n <= back.eligible && back.eligible === retail.n);
  // stake back returns the stake, to within a contract's price on each ticket
  assert.ok(back.lostCash >= back.lostStake && back.lostCash < back.lostStake * 1.01);
  // every trade on a winner contract is one of the exchange's trades, and combos are not counted in them
  const x = rec.exchange;
  assert.ok(x.winnerPrints < x.prints && x.winnerContracts + x.comboContracts < x.contracts);
  // nothing priced at a book: the files carry none
  assert.equal(t.gamesWithBook, 0);
  assert.equal(back.atBook, 0);
  // a few stories of each league, and no per-game rows
  assert.deepEqual([rec.report.games, rec.report.noResult], [[], []]);
  const perLeague = new Map<string, number>();
  for (const s of rec.report.stories) perLeague.set(s.league, (perLeague.get(s.league) ?? 0) + 1);
  assert.ok([...perLeague.values()].every((n) => n <= DKEX_STORIES_KEPT) && (perLeague.get("nfl") ?? 0) >= 2);
  assert.equal(loadDkexRecord(join(tmpdir(), "no-such-record.json")), null);
  const other = join(mkdtempSync(join(tmpdir(), "dkex-rec-")), "record.json");
  writeFileSync(other, JSON.stringify({ ...rec, replay: REPLAY_VERSION + 1 }));
  assert.equal(loadDkexRecord(other), null);
});

test("the tickets told: one that lost and one that won from the same game, the NFL first", () => {
  const s = (league: string, event: string, won: boolean, startMs: number): StoryRow => ({ league, event, won, startMs, label: event, side: "away", team: "T", qty: 10_000, price: 4800, openedMs: startMs - 1, atMs: startMs + 1, bid: 6500, bidQty: 100, fromBook: false });
  const rows = [s("nba", "N3", false, 30), s("nba", "N3", true, 30), s("nfl", "F2", false, 20), s("nfl", "F1", false, 10), s("nfl", "F1", true, 10)];
  assert.deepEqual(storiesToTell(rows).map((x) => [x.event, x.won]), [["F1", false], ["F1", true]]);
  assert.deepEqual(storiesToTell(rows.filter((x) => x.league === "nba")).map((x) => [x.event, x.won]), [["N3", false], ["N3", true]]);
  // a league not on the list still tells its own, and with no game that has both, the latest of each
  assert.deepEqual(storiesToTell([s("kbo", "K1", false, 5), s("kbo", "K1", true, 5)]).map((x) => x.event), ["K1", "K1"]);
  assert.deepEqual(storiesToTell([s("nfl", "F2", false, 20), s("nba", "N9", true, 9)]).map((x) => x.event), ["F2", "N9"]);
  assert.deepEqual(storiesToTell([]), []);
});

test("a lock at a price someone names: the same choices as on a book's price, and words for what cannot be shown", () => {
  const q = lockAtPrice({ contracts: "100", paid: "48", price: "65" }, DKEX_FEE);
  assert.deepEqual({ n: q.contracts, paid: q.paidCents, price: q.bidCents, stake: q.stakeCents, full: q.fullWinCents }, { n: 100, paid: 48, price: 65, stake: 5000, full: 10_000 });
  assert.deepEqual(q.options.map((o) => [o.id, o.floorCents, o.capCents, o.backPercent, o.covered]), [["back", 5000, 7063, 100, true], ["wide", 2520, 8520, 50, true], ["balanced", 3780, 7780, 75, true], ["tight", 5040, 7040, 100, true]]);
  // 53 cents leaves 51 after the fee: the $50.00 comes back with two contracts still riding; at 50 cents it does not come back
  assert.deepEqual(lockAtPrice({ contracts: "100", paid: "48", price: "53" }, DKEX_FEE).options.map((o) => [o.id, o.sold]).slice(0, 1), [["back", 98.04]]);
  assert.deepEqual(lockAtPrice({ contracts: "100", paid: "48", price: "50" }, DKEX_FEE).options.map((o) => o.id), ["wide", "balanced", "tight"]);
  for (const ask of [{ paid: "", price: "65" }, { paid: "48", price: "" }, { paid: "48", price: "99" }, { paid: "148", price: "65" }, { paid: "48", price: "-3" }]) assert.deepEqual(lockAtPrice({ contracts: "100", ...ask }, DKEX_FEE).options, [], JSON.stringify(ask));
});

interface Out {
  status: number;
  body: string;
  headers: Record<string, string>;
}

test("the page made for DraftKings: under its own key and no other, the record's figures, the two tickets, the card, the calculator's sum the same in the browser, and nothing of how a lock is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-dk-"));
  const a = threeFiles();
  const { games, listed } = a.games();
  const rec = dkexRecordOf(games, { builtAt: "2026-11-14T00:00:00.000Z", firstDay: "2026-11-12", lastDay: "2026-11-12", days: 1, exchange: { prints: 10, contracts: 225, comboContracts: 5, winnerPrints: a.winnerPrints, winnerContracts: 220 }, listed });
  const recordPath = join(dir, "record.json");
  writeFileSync(recordPath, JSON.stringify(rec));
  const make = (dkexRecordPath: string | null) => new SportsCollector({ dataDir: join(dir, "data"), log: () => {}, readGames: async () => [], tape: { seedDir: null }, audienceKeys: { prospect: READER, internal: INTERNAL, draftkings: KEY }, hostKeys: ["host-key"], dkexRecordPath });
  const collector = make(recordPath);
  const getFrom = (c: SportsCollector, path: string): Out | null => {
    const out: Out = { status: 0, body: "", headers: {} };
    const res = { writeHead: (status: number, headers: Record<string, string>) => ((out.status = status), (out.headers = headers), res), end: (body: string) => (out.body = body) } as unknown as ServerResponse;
    return c.audience({} as IncomingMessage, res, new URL(path, "http://localhost")) ? out : null;
  };
  const get = (path: string) => getFrom(collector, path);

  // the key: its own and long enough, in the list after the two that were there
  assert.deepEqual(AUDIENCES.map((x) => [x.base, x.keyEnv, x.kind]).at(-1), ["/draftkings", "DRAFTKINGS_PAGE_KEY", "exchange"]);
  const states = (env: Record<string, string>) => sportsCollectorFromEnv({ SPORTS_VENUES_DATA_DIR: join(dir, "env"), ...env }).health().audiencePages as string[];
  assert.equal(states({}).at(-1), "off: its key is not set");
  assert.equal(states({ DRAFTKINGS_PAGE_KEY: KEY }).at(-1), "on");
  assert.equal(states({ DRAFTKINGS_PAGE_KEY: "short" }).at(-1), "off: its key is shorter than 16 characters");
  for (const shared of ["PROSPECT_PAGE_KEY", "LOCK_IN_INTERNAL_KEY", "BTC_CURVE_TOKEN", "SPORTS_VENUES_TOKEN"]) assert.equal(states({ DRAFTKINGS_PAGE_KEY: KEY, [shared]: KEY }).at(-1), "off: its key is the same as another key of this service", shared);
  // no other key opens it, it opens nothing else, and it is one address
  for (const path of ["/draftkings", "/draftkings?k=host-key", `/draftkings?k=${READER}`, `/draftkings?k=${INTERNAL}`, `/draftkings?k=${KEY}x`, `/draftkings/api?k=${KEY}`, `/draftkings/more?k=${KEY}`, `/prospect?k=${KEY}`, `/lockin?k=${KEY}`, `/lockin/brief?k=${KEY}`]) assert.deepEqual([get(path)?.status, get(path)?.body], [404, "not found"], path);
  const none = { writeHead: () => none, end: () => {} } as unknown as ServerResponse;
  assert.equal(collector.handle({} as IncomingMessage, none, "/draftkings", new URL(`/draftkings?k=${KEY}`, "http://localhost")), false);
  assert.equal(collector.health().dkexThrough, "2026-11-12");

  const page = get(`/draftkings?k=${KEY}`)!;
  assert.equal(page.status, 200);
  assert.deepEqual([page.headers["referrer-policy"], page.headers["cache-control"], page.headers["x-robots-tag"]], ["no-referrer", "no-store", "noindex, nofollow"]);
  const html = page.body;
  assert.match(html, /<title>Lock in on DraftKings Predictions · DraftKings<\/title>/);
  assert.match(html, /Prepared for DraftKings by Atticus/);
  assert.ok(!html.includes("—") && !html.includes('http-equiv="refresh"') && !/DraftKings(&#39;|')s/.test(html));
  assert.match(html, /Games counted <b>1<\/b> <small>1 leagues · files of Nov 12, 2026 to Nov 12, 2026<\/small>/);
  // four tickets: NYG's before the start and its two in play at 67 cents, which lost, and WAS's at 53 (its 97 is past 95 cents)
  assert.match(html, /<span class="hl">3 of them, 75%, finished at \$0<\/span>/);
  assert.match(html, /<span class="hl">1 of those losing tickets \(33%\) were ahead at some point<\/span>/);
  assert.match(html, /The files do not say which way a trade went; that is read from its price/);
  // the ticket told: what it cost, the trade it is taken at and the cent under it, how it ended
  assert.match(html, /someone buys 100 contracts of NY Giants to win at 48¢\. That is <b>\$50\.00<\/b> with the fee\./);
  assert.match(html, /40 min into the game the contract trades at 66¢\. Lock in there, counted a cent lower at 65¢: <b>\$50\.00<\/b> back in cash, the whole stake, and \$20\.63 still to win\./);
  assert.match(html, /<b>NY Giants lost\.<\/b> Held to the end as it was: <b class="bad">\$0\.00<\/b>\. With Lock in: <b class="ok">\$50\.00<\/b>\./);
  // with nothing asked for, the card is that ticket at that price
  assert.match(html, /name="n" type="number" min="0\.01" step="0\.01" value="100"/);
  assert.match(html, /name="paid" [^>]*value="48"/);
  assert.match(html, /name="price" [^>]*value="65"/);
  assert.match(html, /Position <b>100 contracts at 48¢<\/b> <small>paid \$50\.00 with the fee<\/small>/);
  assert.deepEqual([...html.matchAll(/<div class="opt"><h3>([^<]+)<\/h3><p class="dim">/g)].map((m) => m[1]), ["A ticket that lost", "Stake back", "Max upside", "Balanced", "Max floor"].slice(1));
  assert.match(html, /<h3>Stake back<\/h3>.*?<small>Cash now<\/small><b>\$50\.00<\/b>.*?<small>Total if they win<\/small><b>\$70\.63<\/b>.*?<small>Stake returned<\/small><b>100%<\/b>/s);
  // the story's link opens the same card, and the card follows the address
  const link = /href="(\/draftkings\?k=[^"]*)#lock"/.exec(html)![1].replace(/&amp;/g, "&");
  assert.equal(link, `/draftkings?k=${KEY}&n=100&paid=48&price=65`);
  assert.ok(get(link)!.body.includes("<small>Total if they win</small><b>$70.63</b>"));
  const dear = get(`/draftkings?k=${KEY}&n=10&paid=90&price=50`)!.body;
  assert.match(dear, /Position <b>10 contracts at 90¢<\/b>/);
  assert.match(dear, /Stake back is not available at this price\. On this position it opens at 95¢\./);
  assert.match(get(`/draftkings?k=${KEY}&n=10&paid=95&price=50`)!.body, /Stake back is not available on this position\./);
  const out = get(`/draftkings?k=${KEY}&n=10&paid=48&price=98`)!.body;
  assert.match(out, /The price is 98¢\. Outside 5¢ to 95¢ the result is all but known and no lock is shown\./);
  // every link is to the page itself, and no other page or venue is named
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length === 1 && hrefs.every((h) => h.startsWith(`/draftkings?k=${KEY}&amp;n=`)), hrefs.join(" "));
  const views = [html, dear, out];
  for (const view of views) {
    assert.equal(/Kalshi|Polymarket|Novig|ProphetX|Crypto\.com|Prospect|ParlayX|\/sports|\/pairs|\/lockin|\/prospect|BTC|host-key|internal/i.exec(view), null);
    // held back: the order behind a lock, how it is sized, where the check of the reading was made
    // ("Time & Sales" is the name of the exchange's file)
    const held = /\bsell|\bsold\b|\bsale|\bbids?\b|taker|\bAPI\b|another exchange|other exchange|live_back|pre_wide|40%|80%/i.exec(view.replace(/Time &amp; Sales/g, ""));
    assert.equal(held, null, held ? `the page says "${held[0]}"` : "");
    assert.equal(/\byou\b|\byour\b/i.exec(view.replace(/<script>[\s\S]*?<\/script>/g, "")), null);
  }
  // what the files cannot say is said
  for (const told of [/<b>Which way a trade went\.<\/b>/, /<b>Whose trades\.<\/b> Every member of the exchange\./, /Every lock is worked out one cent under a price that traded/, /Combos are 2% of the contracts and are not covered/, /1 of 2 listed/, /Under 30¢ and over 94¢ the fee is less than that; 2¢ is counted there too\./]) assert.match(html, told);
  assert.equal((html.match(/<aside class="why"><b>For DraftKings<\/b>/g) ?? []).length, 6);
  assert.match(html, /<h2><span class="n">7<\/span>What DraftKings&#39; own records would answer<\/h2>/);
  // two rows of the table open at the same price: the page says so where the record has them equal, and only then
  const sameTickets = lockTallyOf(rec.report.all, "live_half", "all", "small").n === lockTallyOf(rec.report.all, "live_back80", "all", "small").n;
  assert.equal(html.includes("they are two choices at one moment, not two groups of customers"), sameTickets);
  // how far the reading of a trade's side is off, as measured on the tapes that publish it
  assert.match(html, /Checked on 58 games of a public tape that does say: read this way, the tickets counted came out 12% under the true count, the share that could take the whole stake back 3 points under, the cash the lock returns to losing tickets 4 points under, and the share of losing tickets that had been ahead 2 points over\./);
  assert.ok(!/to close|closed at/.test(html));

  // the calculator: the table as rendered is exchangeRows at the defaults, and the script's sum is exchangeRows at any other
  const base = JSON.parse(/id="dk-calc" data-base="([^"]+)"/.exec(html)![1].replace(/&quot;/g, '"')) as Record<string, Record<string, BrokerBase> & { games: number }>;
  assert.deepEqual(Object.keys(base), ["all", "nfl"]);
  assert.deepEqual(Object.keys(base.all), ["games", ...EXCHANGE_OPTIONS.map((o) => o.key)]);
  assert.deepEqual(base.all.stake_back, base.nfl.stake_back);
  assert.equal(base.all.stake_back.orders, lockTallyOf(rec.report.all, "live_back80", "all", "small").n);
  const big: BrokerBase = { orders: 256_669, contracts: 12_705_788, fees: 254_116, saved: 89_691, returned: 2_341_759 };
  assert.deepEqual(exchangeRows(big, 10, 2), { orders: 25_667, contracts: 1_270_579, fees: 25_412, saved: 8969, returned: 234_176 });
  assert.deepEqual(exchangeRows(big, 25, 3.5).fees, 111_176);
  const cell = (id: string) => new RegExp(`id="d-${id}">([^<]*)<`).exec(html)![1];
  const first = exchangeRows(base.all.stake_back, EXCHANGE_DEFAULTS.adoption, EXCHANGE_DEFAULTS.feeCents);
  assert.deepEqual([cell("orders"), cell("contracts"), cell("fees"), cell("saved"), cell("returned")], [String(first.orders), String(first.contracts), `$${first.fees}`, String(first.saved), `$${first.returned}`]);
  const el = (id: string) => ({ id, value: "", textContent: "", oninput: null as null | (() => void), onchange: null as null | (() => void), getAttribute: (name: string) => (name === "data-base" ? JSON.stringify({ all: { games: 31, stake_back: big, half_back: big, before_start: big }, nfl: { games: 4, stake_back: { ...big, orders: 100 }, half_back: big, before_start: big } }) : null) });
  const ids = new Map<string, ReturnType<typeof el>>();
  const byId = (id: string) => ids.get(id) ?? (ids.set(id, el(id)), ids.get(id)!);
  Object.assign(byId("d-league"), { value: "all" });
  Object.assign(byId("d-option"), { value: "stake_back" });
  Object.assign(byId("d-adoption"), { value: "25" });
  Object.assign(byId("d-fee"), { value: "3.5" });
  vm.runInNewContext(EXCHANGE_SCRIPT, { document: { getElementById: byId }, JSON, Number, Math, isFinite });
  for (const id of ["g-start", "g-all", "dk-calc", "d-league", "d-option", "d-adoption", "d-fee", "d-games", "d-orders", "d-orders-g", "d-fees", "d-returned-g"]) assert.ok(html.includes(`id="${id}"`), `the page has #${id}`);
  byId("d-adoption").oninput!();
  const want = exchangeRows(big, 25, 3.5);
  const usd = (v: number) => `$${v.toLocaleString("en-US")}`;
  assert.deepEqual(["orders", "contracts", "fees", "saved", "returned"].map((k) => byId(`d-${k}`).textContent), [want.orders.toLocaleString("en-US"), want.contracts.toLocaleString("en-US"), usd(want.fees), want.saved.toLocaleString("en-US"), usd(want.returned)]);
  assert.deepEqual([byId("d-orders-g").textContent, byId("d-games").textContent], [Math.round((big.orders * 0.25) / 31).toLocaleString("en-US"), "31"]);
  Object.assign(byId("d-league"), { value: "nfl" });
  byId("d-league").onchange!();
  assert.deepEqual([byId("d-orders").textContent, byId("d-orders-g").textContent, byId("d-games").textContent], ["25", "6", "4"]);

  // with no record the page says so and shows no figure
  const bare = getFrom(make(null), `/draftkings?k=${KEY}`)!;
  assert.equal(bare.status, 200);
  assert.match(bare.body, /The record of DKeX's games is not on this service yet\./);
  assert.ok(!bare.body.includes('<div class="kpis'));
  collector.stop();
});
