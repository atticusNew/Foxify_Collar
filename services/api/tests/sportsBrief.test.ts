/**
 * The internal meeting brief: its arithmetic (a rate per 1,000 tickets, a league's rate over a
 * season, a case for one platform), and the page: under the internal key only, in agreement
 * with the replay, and with a league of too few games shown and not counted.
 *
 * Run: npx tsx --test tests/sportsBrief.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CASES, MIN_GAMES, SEASON_GAMES, baseOf, caseFrom, caseOf, perThousand, seasonOf } from "../src/sportsVenues/brief";
import { SportsCollector } from "../src/sportsVenues/collector";
import { emptyCounts, type ReplayCounts, type ReplayReport, type ReplayTotals } from "../src/sportsVenues/tapeReplay";
import type { Side } from "../src/sportsVenues/types";

const FEE = { theta: 0, flat: 2 };
const near = (got: number | null, want: number, what: string) => assert.ok(got !== null && Math.abs(got - want) < 1e-6 * Math.max(1, Math.abs(want)), `${what}: ${got} is not ${want}`);

/** 1,000 retail tickets of 50 contracts at $25: 500 lose, 400 can take the stake back, 100 of those then lose. */
function counts(): ReplayCounts {
  const c = emptyCounts();
  Object.assign(c.open.pre.small, { n: 1000, qty: 5_000_000, stake: 25_000_000_000, lost: 500, lostStake: 12_000_000_000, won: 500, lostAheadEver: 200 });
  Object.assign(c.locks.live_back80.pre.small, { eligible: 1000, n: 400, sold: 1_600_000, fee: 320_000_000, lost: 100, lostStake: 2_500_000_000, lostCash: 2_500_000_000, won: 300, wonGaveUp: 3_000_000_000 });
  // a large ticket and another option: neither is retail stake back, so neither is counted
  Object.assign(c.open.pre.large, { n: 5, qty: 9_000_000, stake: 99_000_000_000, lost: 2, lostStake: 40_000_000_000 });
  Object.assign(c.locks.live_half.pre.small, { eligible: 1000, n: 900, sold: 9_000_000, fee: 999_000_000 });
  return c;
}
const totals = (games: number): ReplayTotals => ({ games, gamesWithBook: 0, trades: 0, firstStartMs: null, lastStartMs: null, ...counts() });

test("the brief's arithmetic: retail stake back only, a rate per 1,000 tickets, a season, and a case", () => {
  const base = baseOf(counts(), 10, FEE);
  assert.deepEqual(base, { games: 10, tickets: 1000, qty: 5_000_000, stake: 25_000_000_000, openFee: 1_000_000_000, lost: 500, lostStake: 12_000_000_000, lostAhead: 200, locks: 400, sold: 1_600_000, lockFee: 320_000_000, saved: 100, savedStake: 2_500_000_000, savedCash: 2_500_000_000, won: 300, wonGaveUp: 3_000_000_000 });
  // 50,000 contracts at 2 cents is $1,000; a fee that is not flat per contract has no such figure
  assert.equal(baseOf(counts(), 10, { theta: 0.07, flat: 0 }).openFee, null);
  assert.deepEqual(perThousand(base), { ...base, games: 10 });
  assert.equal(perThousand({ ...base, tickets: 2000 }).lost, 250);
  assert.equal(perThousand({ ...base, tickets: 0 }).lost, 0);

  assert.deepEqual(SEASON_GAMES, { nba: 1230, nhl: 1344, nfl: 272 });
  const report = { v: 2, all: totals(11), byLeague: { nba: totals(10), nfl: totals(MIN_GAMES - 1), mlb: totals(50) }, stories: [], games: [], noResult: [] } as ReplayReport;
  const season = seasonOf(report, FEE);
  assert.deepEqual([season.counted, season.thin, season.leagues.map((l) => [l.league, l.thin, l.seasonGames])], [["nba"], ["nfl"], [["nba", false, 1230], ["nfl", true, 272]]]);
  // only the league with enough games is in the total: 10 games carried to 1,230
  near(season.total.tickets, 123_000, "a season's tickets");
  near(season.total.locks, 49_200, "a season's locks");
  near(season.total.lockFee, 39_360_000_000, "a season's fees on locks");
  near(season.total.openFee, 123_000_000_000, "a season's fees on buying");
  near(season.leagues[1].season.tickets, (1000 * 272) / (MIN_GAMES - 1), "the thin league's own season");

  assert.deepEqual(CASES, { bear: { sharePct: 1, adoptionPct: 3, growth: 1 }, base: { sharePct: 3, adoptionPct: 10, growth: 2 }, bull: { sharePct: 10, adoptionPct: 25, growth: 4 } });
  const x = caseOf(season.total, CASES.base);
  near(x.tickets, 7380, "the platform's tickets");
  near(x.couldLock, 2952, "tickets that could lock");
  near(x.locks, 295.2, "locks taken");
  near(x.contracts, 11_808, "contracts in locks");
  near(x.lockFee, 236_160_000, "fees on locks");
  near(x.openFee, 7_380_000_000, "fees on buying");
  near(x.lockFeeShare, 0.032, "locks' fees against buying");
  near(x.saved, 73.8, "tickets with the stake back");
  near(x.savedCash, 1_845_000_000, "cash kept");
  // nobody locks: nothing but the tickets
  const none = caseOf(season.total, { sharePct: 5, adoptionPct: 0, growth: 1 });
  assert.deepEqual([none.locks, none.lockFee, none.saved, none.lockFeeShare], [0, 0, 0, 0]);
  near(none.tickets, 6150, "tickets at no adoption");

  assert.deepEqual(caseFrom({}), CASES.base);
  assert.deepEqual(caseFrom({ share: "5.5", adoption: "20", growth: "3" }), { sharePct: 5.5, adoptionPct: 20, growth: 3 });
  assert.deepEqual(caseFrom({ share: "250", adoption: "-4", growth: "x" }), { sharePct: 100, adoptionPct: 0, growth: 2 });
  assert.deepEqual(caseFrom({ share: "", adoption: " ", growth: null }), CASES.base);
});

const S = Date.parse("2026-11-12T00:00:00Z");
const MIN = 60_000;
const EVENT = "NBA-00001-261111-M";
const KEY = "reader-key-0123456789";
const INTERNAL = "internal-key-0123456789";
const SYMBOLS: Record<Side, string> = { away: `NX.F.OPT.${EVENT}.O.1.1.20270731`, home: `NX.F.OPT.${EVENT}.O.1.2.20270731` };
let nextId = 0;
const trade = (side: "a" | "h", atMs: number, qty: string, price: string, buy: 0 | 1) => JSON.stringify(["t", side, atMs, qty, price, buy, String(1_794_000_000_000_000_000n + BigInt((nextId += 1)))]);
const book = (side: "a" | "h", atMs: number, bidCents: number, qty: number) => JSON.stringify(["b", side, atMs, bidCents, qty]);
/** One game, the home side winning: an away ticket that reaches stake back at 66 cents and loses, a home ticket that wins. */
const GAME_LINES = [
  JSON.stringify({ k: "g", v: 1, event: EVENT, league: "nba", key: "nba:WAS:IND:2026-11-11", awayName: "Washington Wizards", homeName: "Indiana Pacers", startMs: S, symbols: SYMBOLS }),
  trade("a", S - 60 * MIN, "100", "0.48", 1),
  trade("h", S + 5 * MIN, "80", "0.40", 1),
  trade("a", S + 150 * MIN, "4", "0.02", 0),
  trade("h", S + 151 * MIN, "2", "0.99", 1),
  book("a", S + 20 * MIN, 60, 500),
  book("a", S + 40 * MIN, 66, 500),
  book("a", S + 50 * MIN, 55, 500),
  book("h", S + 30 * MIN, 45, 500),
  book("h", S + 45 * MIN, 60, 30),
  JSON.stringify({ k: "r", atMs: S + 300 * MIN, winner: "home", why: "test" }),
];

test("the brief page: under the internal key only, the replay's own figures, a thin league shown and not counted, a case typed in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-brief-"));
  const seedDir = join(dir, "seed");
  mkdirSync(seedDir);
  writeFileSync(join(seedDir, `${EVENT}.tape.jsonl`), `${GAME_LINES.join("\n")}\n`);
  const collector = new SportsCollector({ dataDir: join(dir, "data"), log: () => {}, readGames: async () => [], tape: { seedDir }, audienceKeys: { prospect: KEY, internal: INTERNAL }, hostKeys: ["host-key"] });
  await collector.load();
  const get = (path: string) => {
    const out = { status: 0, body: "", headers: {} as Record<string, string> };
    const res = { writeHead: (status: number, headers: Record<string, string>) => ((out.status = status), (out.headers = headers), res), end: (body: string) => (out.body = body) } as unknown as ServerResponse;
    return collector.audience({} as IncomingMessage, res, new URL(path, "http://localhost")) ? out : null;
  };
  for (const path of ["/lockin/brief", `/lockin/brief?k=${KEY}`, "/lockin/brief?k=host-key", `/prospect/brief?k=${KEY}`, `/prospect/brief?k=${INTERNAL}`]) assert.deepEqual([get(path)?.status, get(path)?.body], [404, "not found"], path);
  const none = { writeHead: () => none, end: () => {} } as unknown as ServerResponse;
  assert.equal(collector.handle({} as IncomingMessage, none, "/brief", new URL("/brief", "http://localhost")), false);

  const page = get(`/lockin/brief?k=${INTERNAL}`)!;
  assert.equal(page.status, 200);
  assert.deepEqual([page.headers["referrer-policy"], page.headers["cache-control"], page.headers["x-robots-tag"]], ["no-referrer", "no-store", "noindex, nofollow"]);
  const html = page.body;
  assert.match(html, /<h1>Prospect meeting brief<\/h1>/);
  assert.match(html, /Internal\. Not for sending\./);
  for (const bad of ["—", "NaN", "undefined", "Infinity", KEY, "host-key", "/sports"]) assert.ok(!html.includes(bad), `the brief says "${bad}"`);
  // it links to the internal pages and to nothing else
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3 && hrefs.every((h) => h.startsWith("/lockin") && h.includes(`k=${INTERNAL}`)), hrefs.join(" "));
  assert.ok(html.includes("<b>Meeting brief</b>"));
  assert.ok(get(`/lockin?k=${INTERNAL}`)!.body.includes(`<a href="/lockin/brief?k=${INTERNAL}">Meeting brief</a>`));
  assert.ok(!get(`/prospect?k=${KEY}`)!.body.includes("brief"));

  // the replay's own figures: two retail tickets, one lost after it could take its stake back
  assert.match(html, /Games counted <b>1<\/b>/);
  assert.match(html, /<b>50% of retail tickets finish at \$0<\/b>, and <b>100% of those were ahead<\/b>/);
  assert.match(html, /<td class="lbl">Of those, their team then lost<\/td><td><b>1<\/b><\/td>/);
  // the ticket the reader's page tells: hold, sell everything, lock in
  assert.match(html, /<td class="lbl">Hold<\/td><td class="r">\$0\.00<\/td><td class="r">\$0\.00<\/td><td class="r">\$100\.00<\/td>/);
  assert.match(html, /<td class="lbl">Sell everything<\/td><td class="r">\$64\.00<\/td><td class="r">\$64\.00<\/td><td class="r">\$64\.00<\/td>/);
  assert.match(html, /<td class="lbl">Lock in: stake back<\/td><td class="r">\$50\.00<\/td><td class="r">\$50\.00<\/td><td class="r">\$71\.87<\/td><td>yes, 21\.87 contracts, at no cost<\/td>/);
  assert.match(html, /Lock in sells 78\.13 of the 100 contracts at 66¢/);

  // one game is not a rate: the league is shown, left out of the total, and every case is empty
  assert.match(html, /<b>NBA: too few games to carry to a season\.<\/b> NBA rests on 1 game\./);
  assert.match(html, /<tr class="dimrow"><td class="lbl">NBA<\/td><td class="r">1<\/td><td class="r">2<\/td><td class="r">1,230<\/td><td class="r">2,460<\/td>/);
  assert.match(html, /<tr class="total"><td class="lbl">Total<\/td><td class="r"><\/td><td class="r"><\/td><td class="r"><\/td><td class="r">0<\/td><td class="r">0<\/td><td class="r">\$0<\/td>/);
  assert.match(html, /<td class="lbl">Locks taken<\/td><td class="r"><b>0<\/b><\/td><td class="r"><b>0<\/b><\/td><td class="r"><b>0<\/b><\/td><td class="r"><b>0<\/b><\/td>/);

  // the three cases as stated, and the one typed in
  assert.match(html, /<td class="r">1%<\/td><td class="r">3%<\/td><td class="r">10%<\/td><td class="r">3%<\/td>/);
  assert.match(html, /<td class="r">1×<\/td><td class="r">2×<\/td><td class="r">4×<\/td><td class="r">2×<\/td>/);
  const own = get(`/lockin/brief?k=${INTERNAL}&share=7.5&adoption=40&growth=999`)!.body;
  assert.match(own, /<td class="r">1%<\/td><td class="r">3%<\/td><td class="r">10%<\/td><td class="r">7\.5%<\/td>/);
  assert.match(own, /<td class="r">3<\/td><td class="r">10<\/td><td class="r">25<\/td><td class="r">40<\/td>/);
  assert.match(own, /<td class="r">1×<\/td><td class="r">2×<\/td><td class="r">4×<\/td><td class="r">100×<\/td>/);
  assert.match(own, /name="share" type="number" min="0" max="100" step="0\.1" value="7\.5"/);
});
