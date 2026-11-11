/**
 * SPORTS VENUES, THE HOLDER'S VIEW: for a holder of one side on each venue, what that venue's own
 * book pays against the consensus, how deep its bid is, how often another venue's book is
 * cheaper for the other side, and how often a better bid would still lock after every fee.
 * Counted over every snapshot since the count began, kept in a small file so a restart and the
 * window rolling on do not lose it, and never counted twice.
 *
 * The expected figures were worked out by hand from the books in each case.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SportsCollector } from "../src/sportsVenues/collector";
import { HolderRecord, addPoint, consensusOf, emptyState, holderReport, parseState, type HolderRow } from "../src/sportsVenues/holder";
import { renderReportHtml } from "../src/sportsVenues/reportHtml";
import type { HistoryCell, HistoryPoint } from "../src/sportsVenues/store";
import type { Game, Venue, VenueListing } from "../src/sportsVenues/types";

const KEY = "nhl:TB:BUF:2026-11-11";
const T0 = Date.parse("2026-11-11T16:00:00Z");
const START = Date.parse("2026-11-12T00:00:00Z");
// away 54/56, home 44/46, fee 0.07·p·(1−p), 500 at every level
const KALSHI: HistoryCell = [54, 56, 44, 46, 0.07, 500, 500, 500, 500];
// away 54/55, home 44/45, a fixed 2¢ a contract
const CDC: HistoryCell = [54, 55, 44, 45, 0, 91337, 26607.68, 99539.96, 23976.17, 0, 2];
// every order a bid, no fee before the start: away 55.5/56, home 44/44.5
const NOVIG: HistoryCell = [55.5, 56, 44, 44.5, 0, 300, 300, 300, 300];
const point = (atMs: number, row: Partial<Record<Venue, HistoryCell>>, key = KEY, start = START): HistoryPoint => ({ at: new Date(atMs).toISOString(), atMs, games: { [key]: row }, starts: { [key]: start } });
const rowFor = (rows: HolderRow[], venue: Venue): HolderRow => rows.find((r) => r.venue === venue)!;

test("consensus: each venue's two mids scaled to 100 and averaged; one venue alone is not a consensus", () => {
  // Kalshi 55 of 100, Crypto.com 54.5 of 99
  assert.equal(Math.round(consensusOf({ kalshi: KALSHI, cryptocom: CDC }, "away")! * 1e5) / 1e5, 55.02525);
  assert.equal(Math.round(consensusOf({ kalshi: KALSHI, cryptocom: CDC }, "home")! * 1e5) / 1e5, 44.97475);
  assert.equal(consensusOf({ kalshi: KALSHI }, "away"), null);
  // a venue with one side of its book empty does not vote
  assert.equal(consensusOf({ kalshi: KALSHI, cryptocom: [54, 55, 0, 45, 0, 1, 1, 0, 1, 0, 2] }, "away"), null);
});

test("a reading: the sale on the holder's own book against the consensus, its spread and depth, and whether another book is cheaper for the other side", () => {
  const state = emptyState();
  assert.equal(addPoint(state, point(T0, { kalshi: KALSHI, cryptocom: CDC })), true);
  const pre = holderReport(state).all.pre;
  const cdc = rowFor(pre, "cryptocom");
  // two sides. Away: 55.02525 − (54 − 2) = 3.02525; home: 44.97475 − (44 − 2) = 2.97475; mean 3.00
  assert.equal(cdc.readings, 2);
  assert.equal(cdc.noBid, 0);
  assert.equal(cdc.saleCostCents, 3);
  assert.equal(cdc.meanSpreadCents, 1);
  // 91,337 and 99,539.96 at the bid: past every threshold
  assert.deepEqual(cdc.depthShare, [1, 1, 1]);
  // the other side all in: Crypto.com 45 + 2 = 47 against Kalshi 46 + 1.7388; its own book is the cheapest both times
  assert.equal(cdc.choice, 2);
  assert.equal(cdc.elsewhereShare, 0);
  assert.equal(cdc.meanSavingCents, null);
  assert.deepEqual(cdc.cheapestMost, { venue: "cryptocom", share: 1 });
  // a better bid: 100 − 47 − 54 − 2 is under zero
  assert.equal(cdc.roomShare, 0);
  assert.equal(cdc.meanRoomCents, null);

  const kalshi = rowFor(pre, "kalshi");
  // away 55.02525 − (54 − 1.7388) and home 44.97475 − (44 − 1.7248): 5.4636 over two
  assert.equal(kalshi.saleCostCents, 2.73);
  assert.equal(kalshi.meanSpreadCents, 2);
  // 500 at the bid: past 100, short of 1,000
  assert.deepEqual(kalshi.depthShare, [1, 0, 0]);
  // Crypto.com's other side beats Kalshi's own by 0.7388 and 0.7248
  assert.equal(kalshi.elsewhereShare, 1);
  assert.equal(kalshi.meanSavingCents, 0.73);
  // nothing in play, nothing for a venue not on the game
  assert.equal(rowFor(holderReport(state).all.live, "cryptocom").readings, 0);
  assert.equal(rowFor(pre, "novig").readings, 0);
});

test("room for a better bid: what is left after the holder's venue's fee on the contract and the cheapest other side anywhere", () => {
  // Novig's home ask at 43.5: a Crypto.com away holder's contract at its 54 bid plus 2 fee plus 43.5 is 99.5
  const cheap: HistoryCell = [56.5, 57, 43, 43.5, 0, 300, 300, 300, 300];
  const state = emptyState();
  addPoint(state, point(T0, { kalshi: KALSHI, novig: cheap, cryptocom: CDC }));
  const pre = holderReport(state).all.pre;
  const cdc = rowFor(pre, "cryptocom");
  assert.equal(cdc.roomShare, 0.5);
  assert.equal(cdc.meanRoomCents, 0.5);
  // away holder: Novig's 43.5 beats its own 47 by 3.5. Home holder: Novig's 57 ties its own 57, which is not a saving
  assert.equal(cdc.elsewhereShare, 0.5);
  assert.equal(cdc.meanSavingCents, 3.5);
  assert.deepEqual(cdc.cheapestMost, { venue: "novig", share: 1 });
  // on Kalshi the fee on the contract is 1.7388, so the room is 100 − 43.5 − 54 − 1.7388
  assert.equal(rowFor(pre, "kalshi").meanRoomCents, 0.76);
  // a book whose bid on one side is its ask on the other leaves no room on itself
  assert.equal(rowFor(pre, "novig").roomShare, 0);
});

test("what is and is not a reading: no bid is counted apart, a decided game is passed over, and the start splits before from in play, by league", () => {
  const state = emptyState();
  // Crypto.com shows no bid on the home side: one reading and one side the holder could not sell
  const noHomeBid: HistoryCell = [54, 55, 0, 45, 0, 91337, 26607.68, 0, 23976.17, 0, 2];
  addPoint(state, point(T0, { kalshi: KALSHI, novig: NOVIG, cryptocom: noHomeBid }));
  let cdc = rowFor(holderReport(state).all.pre, "cryptocom");
  assert.equal(cdc.readings, 1);
  assert.equal(cdc.noBid, 1);
  // consensus on the away side 55.375 (Kalshi and Novig; Crypto.com one-sided does not vote), less 52
  assert.equal(cdc.saleCostCents, 3.38);
  assert.equal(cdc.elsewhereShare, 1);
  assert.equal(cdc.meanSavingCents, 2.5);

  // a game at 97.5 and 2.5: the result is all but known
  const decided: HistoryCell = [97, 98, 2, 3, 0.07, 5, 5, 5, 5];
  addPoint(state, point(T0 + 60_000, { kalshi: decided, cryptocom: [97, 98, 2, 3, 0, 5, 5, 5, 5, 0, 2] }, "nba:BOS:TOR:2026-11-11"));
  assert.equal(holderReport(state).byLeague.nba, undefined);

  // after the start the same books count as in play, and a football game beside it counts under its league
  addPoint(state, {
    at: new Date(START + 60_000).toISOString(),
    atMs: START + 60_000,
    games: { [KEY]: { kalshi: KALSHI, cryptocom: CDC }, "nfl:NE:DET:2026-11-15": { kalshi: KALSHI, cryptocom: CDC } },
    starts: { [KEY]: START, "nfl:NE:DET:2026-11-15": START + 86_400_000 },
  });
  const r = holderReport(state);
  assert.equal(r.snapshots, 3);
  assert.equal(r.sinceMs, T0);
  assert.equal(rowFor(r.all.live, "cryptocom").readings, 2);
  assert.equal(rowFor(r.all.pre, "cryptocom").readings, 3);
  assert.deepEqual(Object.keys(r.byLeague), ["nfl", "nhl"]);
  assert.equal(rowFor(r.byLeague.nhl.live, "cryptocom").readings, 2);
  assert.equal(rowFor(r.byLeague.nhl.pre, "cryptocom").readings, 1);
  assert.equal(rowFor(r.byLeague.nfl.pre, "cryptocom").readings, 2);
  assert.equal(rowFor(r.byLeague.nfl.live, "cryptocom").readings, 0);
  // a start that is only a date is not evidence the game is on: no start, no in-play reading
  const undated = emptyState();
  addPoint(undated, { at: "", atMs: START + 120_000, games: { [KEY]: { kalshi: KALSHI, cryptocom: CDC } }, starts: {} });
  assert.equal(rowFor(holderReport(undated).all.pre, "cryptocom").readings, 2);
  cdc = rowFor(r.all.pre, "cryptocom");
  assert.equal(cdc.noBid, 1);
});

test("never twice: a snapshot at or before the last one counted is passed over", () => {
  const state = emptyState();
  const p = point(T0, { kalshi: KALSHI, cryptocom: CDC });
  assert.equal(addPoint(state, p), true);
  assert.equal(addPoint(state, p), false);
  assert.equal(addPoint(state, point(T0 - 60_000, { kalshi: KALSHI, cryptocom: CDC })), false);
  assert.equal(addPoint(state, { ...p, atMs: Number.NaN }), false);
  assert.equal(holderReport(state).snapshots, 1);
  assert.equal(rowFor(holderReport(state).all.pre, "cryptocom").readings, 2);
});

test("the file: written after each snapshot, read back on a restart, and a file that cannot be read starts again and says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-holder-"));
  const path = join(dir, "holder-count.json");
  const first = new HolderRecord(path);
  assert.equal(first.add([point(T0, { kalshi: KALSHI, cryptocom: CDC })]), 1);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(`${path}.tmp`));
  // a restart: the count is there, the same snapshots offered again add nothing, a new one adds
  const second = new HolderRecord(path);
  assert.equal(second.report().snapshots, 1);
  assert.equal(second.add([point(T0, { kalshi: KALSHI, cryptocom: CDC }), point(T0 + 60_000, { kalshi: KALSHI, cryptocom: CDC })]), 1);
  assert.equal(rowFor(new HolderRecord(path).report().all.pre, "cryptocom").readings, 4);
  assert.deepEqual(second.summary(), { snapshots: 2, since: new Date(T0).toISOString(), last: new Date(T0 + 60_000).toISOString() });

  // a file written before a venue was on the page: that venue starts at 0 in every count
  const old = JSON.parse(readFileSync(path, "utf8"));
  delete old.tallies.cryptocom;
  for (const byPhase of Object.values(old.tallies.kalshi) as Array<Record<string, { cheapest: Record<string, number> }>>) for (const t of Object.values(byPhase)) delete t.cheapest.cryptocom;
  const mended = parseState(JSON.stringify(old))!;
  assert.equal(mended.tallies.cryptocom, undefined);
  assert.equal(mended.tallies.kalshi!.nhl.pre.cheapest.cryptocom, 0);
  assert.equal(mended.tallies.kalshi!.nhl.pre.readings, 4);

  // not ours, or torn
  assert.equal(parseState("{"), null);
  assert.equal(parseState(JSON.stringify({ v: 2, lastAtMs: 1, tallies: {} })), null);
  writeFileSync(path, '{"v":1,"lastAtMs":');
  const broken = new HolderRecord(path);
  assert.match(broken.note, /could not be read; it starts again from the snapshots in the window/);
  assert.equal(broken.report().snapshots, 0);
  // a write that fails is the guard's to report; the count carries on in memory
  const failing = new HolderRecord(join(dir, "other.json"), () => false);
  assert.equal(failing.add([point(T0, { kalshi: KALSHI, cryptocom: CDC })]), 1);
  assert.equal(failing.report().snapshots, 1);
  assert.ok(!existsSync(join(dir, "other.json")));
});

test("the collector: every snapshot is counted once, the count outlives a restart and the window, and the page shows it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-holder-"));
  const q = (bid: number, ask: number, qty: number) => ({ bidCents: bid, askCents: ask, bidQty: qty, askQty: qty });
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: q(54, 56, 500), home: q(44, 46, 500), feeTheta: 0.07, awayName: "TB", homeName: "BUF" };
  const cdc: VenueListing = { venue: "cryptocom", id: "NHL-00002-261111-M", away: q(54, 55, 91337), home: q(44, 45, 99539.96), feeTheta: 0, feeFlatCents: 2, awayName: "Tampa Bay Lightning", homeName: "Buffalo Sabres" };
  const games: Game[] = [{ key: KEY, league: "nhl", awayCode: "TB", homeCode: "BUF", awayName: "Tampa Bay Lightning", homeName: "Buffalo Sabres", startsAt: new Date(START).toISOString(), startSource: "venue", listings: [kalshi, cdc] }];
  const make = () => new SportsCollector({ dataDir: dir, windowHours: 1, log: () => {}, readGames: async () => games });

  const first = make();
  await first.collectOnce(new Date(T0));
  await first.collectOnce(new Date(T0 + 60_000));
  assert.deepEqual((first.health() as { holderCount: unknown }).holderCount, { snapshots: 2, since: new Date(T0).toISOString(), last: new Date(T0 + 60_000).toISOString() });
  first.stop();

  // a restart three hours later: the one-hour window holds none of those snapshots, the count holds both
  const second = make();
  assert.equal(await second.load(T0 + 3 * 3_600_000), 0);
  await second.collectOnce(new Date(T0 + 3 * 3_600_000));
  const data = second.reportData()!;
  assert.equal(data.historyPoints, 1);
  assert.equal(data.holder!.snapshots, 3);
  assert.equal(rowFor(data.holder!.all.pre, "cryptocom").readings, 6);
  second.stop();

  // the count's file lost: the next boot counts what the window still holds, once, and carries on
  writeFileSync(join(dir, "holder-count.json"), "not json");
  const third = make();
  assert.equal(await third.load(T0 + 3 * 3_600_000 + 60_000), 1);
  assert.equal(third.reportData()!.holder!.snapshots, 1);
  assert.match((third.health() as { holderCount: { note: string } }).holderCount.note, /starts again/);
  await third.collectOnce(new Date(T0 + 3 * 3_600_000 + 120_000));
  assert.equal(third.reportData()!.holder!.snapshots, 2);
  third.stop();

  const html = renderReportHtml(data, { refreshSec: 60 });
  for (const needle of [
    "<h2>5 · A holder on each venue",
    "3 snapshots since Nov 11, 11:00 AM ET",
    "<h3>Before the start</h3>",
    "<h3>In play</h3>",
    // Crypto.com: 6 readings, 3.00¢ to sell, 1.00¢ wide, every bid past 1,000, its own book cheapest, no room
    '<td class="lbl">Crypto.com</td><td>6<small>a bid every time</small></td><td><b>3.00¢</b></td><td>1.00¢</td><td>100%<small>100 or more 100% · 10,000 or more 100%</small></td><td><b>0%</b><small>no saving · most often cheapest Crypto.com 100%</small></td><td><b>0%</b><small>never</small></td>',
    // Kalshi: 2.73¢ to sell, 2.00¢ wide, 500 at the bid, Crypto.com's other side 0.73¢ cheaper every time
    '<td class="lbl">Kalshi</td><td>6<small>a bid every time</small></td><td><b>2.73¢</b></td><td>2.00¢</td><td>0%<small>100 or more 100% · 10,000 or more 0%</small></td><td><b>100%</b><small>mean saving 0.73¢ · most often cheapest Crypto.com 100%</small></td>',
    "<summary>By league</summary>",
    "<h3>NHL · before the start</h3>",
    "No readings yet.",
  ]) {
    assert.ok(html.includes(needle), `page lacks: ${needle}`);
  }
  assert.ok(!/—/.test(html), "no em dash in the page");
  // a report built without a count says the section is filling
  assert.ok(renderReportHtml({ ...data, holder: undefined }).includes("<h2>5 · A holder on each venue"));
});
