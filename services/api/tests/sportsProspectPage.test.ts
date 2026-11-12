/**
 * The page made for one reader: what the replay adds for it (tickets that were ahead, how long a
 * lock stayed possible, the real tickets told), a lock at a moment of a finished game, the page
 * itself, its calculator and its key.
 *
 * Run: npx tsx --test tests/sportsProspectPage.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIENCES, AUDIENCE_KEY_MIN, audienceOf, audienceState, keyMatches } from "../src/sportsVenues/audiences";
import { SportsCollector, sportsCollectorFromEnv } from "../src/sportsVenues/collector";
import { emptyState, holderReport } from "../src/sportsVenues/holder";
import { lockPast, pastMoments } from "../src/sportsVenues/lockNow";
import { BROKER_DEFAULTS, BROKER_OPTIONS, GUIDE_SCRIPT, bookCountOf, brokerBase, brokerRows, type BrokerBase } from "../src/sportsVenues/prospectHtml";
import { lockTallyOf, openTallyOf, parseCapsule, replayGame, sumReplays } from "../src/sportsVenues/tapeReplay";
import type { Side } from "../src/sportsVenues/types";

const FEE = { theta: 0, flat: 2 };
const S = Date.parse("2026-11-12T00:00:00Z");
const MIN = 60_000;
const EVENT = "NBA-00001-261111-M";
const KEY = "reader-key-0123456789";
const INTERNAL = "internal-key-0123456789";
const SYMBOLS: Record<Side, string> = { away: `NX.F.OPT.${EVENT}.O.1.1.20270731`, home: `NX.F.OPT.${EVENT}.O.1.2.20270731` };
let nextId = 0;
const trade = (side: "a" | "h", atMs: number, qty: string, price: string, buy: 0 | 1) => JSON.stringify(["t", side, atMs, qty, price, buy, String(1_794_000_000_000_000_000n + BigInt((nextId += 1)))]);
const book = (side: "a" | "h", atMs: number, bidCents: number, qty: number) => JSON.stringify(["b", side, atMs, bidCents, qty]);

/**
 * One game, the home side winning. Away: 100 at 48¢ an hour before the start ($50.00 with the
 * fee). Its bid in play: 60¢, 66¢ (the first that returns the stake from 80% or less), 67¢ a
 * minute later, 55¢ ten minutes after the 66¢, then 70¢. Home: 80 at 40¢ five minutes in
 * ($33.60), its bid 45¢ and then 60¢ on 30 contracts.
 */
const GAME_LINES = [
  JSON.stringify({ k: "g", v: 1, event: EVENT, league: "nba", key: "nba:WAS:IND:2026-11-11", awayName: "Washington Wizards", homeName: "Indiana Pacers", startMs: S, symbols: SYMBOLS }),
  trade("a", S - 60 * MIN, "100", "0.48", 1),
  trade("h", S + 5 * MIN, "80", "0.40", 1),
  trade("a", S + 150 * MIN, "4", "0.02", 0),
  trade("h", S + 151 * MIN, "2", "0.99", 1),
  book("a", S + 20 * MIN, 60, 500),
  book("a", S + 40 * MIN, 66, 500),
  book("a", S + 41 * MIN, 67, 500),
  book("a", S + 50 * MIN, 55, 500),
  book("a", S + 70 * MIN, 70, 500),
  book("h", S + 30 * MIN, 45, 500),
  book("h", S + 45 * MIN, 60, 30),
  JSON.stringify({ k: "r", atMs: S + 300 * MIN, winner: "home", why: "test" }),
];

test("the replay: a loser that was ahead is counted, a lock's chance is timed to the next lower bid, and the tickets told are real ones of an ordinary size", () => {
  const game = parseCapsule(GAME_LINES)!;
  const r = replayGame(game, FEE);
  assert.equal(r.v, 2);
  // the away ticket (50¢ with the fee) saw 58¢ after the fee and lost; the home one (42¢) saw 58¢ and won
  assert.deepEqual(
    [r.open.pre.small.aheadEver, r.open.pre.small.lostAheadEver, r.open.pre.small.lostAheadStake, r.open.live.small.aheadEver, r.open.live.small.lostAheadEver],
    [1, 1, 50_000_000, 1, 0],
  );
  // stake back on the away ticket: possible from the 66¢ bid 40 minutes in, gone at the 55¢ bid 10 minutes later
  const back = r.locks.live_back80.pre.small;
  assert.deepEqual({ n: back.n, sold: back.sold, cash: back.cash, minutes: back.minutesSum, held: back.heldMinutesSum, held10: back.held10, lost: back.lost }, { n: 1, sold: 7813, cash: 50_003_200, minutes: 40, held: 10, held10: 1, lost: 1 });
  // on the home ticket: from the 60¢ bid 45 minutes in, with no bid after it: no time
  const homeBack = r.locks.live_back80.live.small;
  assert.deepEqual({ n: homeBack.n, sold: homeBack.sold, held: homeBack.heldMinutesSum, held10: homeBack.held10, won: homeBack.won, covered: homeBack.covered }, { n: 1, sold: 5794, held: 0, held10: 0, won: 1, covered: 0 });
  assert.deepEqual(r.stories, [
    { side: "away", team: "Washington Wizards", qty: 10_000, price: 4800, openedMs: S - 60 * MIN, atMs: S + 40 * MIN, bid: 6600, bidQty: 50_000, fromBook: true, won: false },
    { side: "home", team: "Indiana Pacers", qty: 8000, price: 4000, openedMs: S + 5 * MIN, atMs: S + 45 * MIN, bid: 6000, bidQty: 3000, fromBook: true, won: true },
  ]);
  const report = sumReplays([r]);
  assert.deepEqual(report.stories.map((s) => [s.event, s.label, s.team, s.won]), [[EVENT, "Washington Wizards at Indiana Pacers", "Washington Wizards", false], [EVENT, "Washington Wizards at Indiana Pacers", "Indiana Pacers", true]]);
  // a ticket outside $20 to $100, or bought under 25¢ or over 75¢, is counted and not told
  const small = replayGame(parseCapsule(GAME_LINES.map((l) => l.replace('"100","0.48"', '"30","0.48"').replace('"80","0.40"', '"400","0.20"')))!, FEE);
  assert.equal(lockTallyOf(small, "live_back80").n, 2);
  assert.deepEqual(small.stories, []);
});

test("a lock at a moment of a finished game: the bid that was there then, the result beside it, and the moments offered are real bids five minutes apart", () => {
  const game = parseCapsule(GAME_LINES)!;
  const moments = pastMoments(game, "away", FEE);
  // the 66¢ and the 67¢ a minute later are one five-minute step: the later one stands for it
  assert.deepEqual(moments, [
    { atMs: S + 20 * MIN, bidCents: 60, fromBook: true, inPlay: true },
    { atMs: S + 41 * MIN, bidCents: 67, fromBook: true, inPlay: true },
    { atMs: S + 50 * MIN, bidCents: 55, fromBook: true, inPlay: true },
    { atMs: S + 70 * MIN, bidCents: 70, fromBook: true, inPlay: true },
  ]);
  // the ticket of the story, at its moment: the same sale the replay counted
  const q = lockPast(game, { side: "away", atMs: S + 40 * MIN, contracts: "100", paid: "48" }, FEE)!;
  assert.deepEqual(q.past, { event: EVENT, atMs: S + 40 * MIN, startMs: S, fromBook: true, won: false, winnerName: "Indiana Pacers" });
  assert.deepEqual({ bid: q.bidCents, qty: q.bidQty, stake: q.stakeCents, inPlay: q.inPlay, assumed: q.paidAssumed }, { bid: 66, qty: 500, stake: 5000, inPlay: true, assumed: false });
  assert.deepEqual(q.options.map((o) => o.id), ["back", "wide", "balanced", "tight"]);
  assert.deepEqual({ sold: q.options[0].sold, floor: q.options[0].floorCents, cap: q.options[0].capCents, covered: q.options[0].covered }, { sold: 78.13, floor: 5000, cap: 7187, covered: true });
  // a moment between two bids is the bid before it; before the first bid there is none, so the default stands
  assert.equal(lockPast(game, { side: "away", atMs: S + 45 * MIN, contracts: "100", paid: "48" }, FEE)!.bidCents, 67);
  // nothing said: 20 contracts at the last buy before the start, at the first bid in play that returns the stake from 80% or less
  const plain = lockPast(game, { side: "away" }, FEE)!;
  assert.deepEqual({ n: plain.contracts, paid: plain.paidCents, assumed: plain.paidAssumed, at: plain.past?.atMs, bid: plain.bidCents }, { n: 20, paid: 48, assumed: true, at: S + 40 * MIN, bid: 66 });
  assert.deepEqual(lockPast(game, { side: "away", atMs: S - 600 * MIN }, FEE)!.past?.atMs, S + 40 * MIN);
  // the home side: no buy before the start, so the first buy stands for the price; it won
  const home = lockPast(game, { side: "home", contracts: "80" }, FEE)!;
  assert.deepEqual({ paid: home.paidCents, at: home.past?.atMs, won: home.past?.won, sold: home.options[0].sold, covered: home.options[0].covered }, { paid: 40, at: S + 45 * MIN, won: true, sold: 57.94, covered: false });
  // a price no bid of the game returns: the first bid in play, and the three sizes
  const dear = lockPast(game, { side: "away", contracts: "10", paid: "90" }, FEE)!;
  assert.equal(dear.past?.atMs, S + 20 * MIN);
  assert.deepEqual(dear.options.map((o) => o.id), ["wide", "balanced", "tight"]);
  assert.equal(lockPast(game, { side: "neither" }, FEE), null);
});

test("a reader's key: the page is on only with a key of its own, long enough and not one that opens something else", () => {
  const a = AUDIENCES[0];
  assert.deepEqual(AUDIENCES.map((x) => [x.base, x.keyEnv, x.kind]), [["/prospect", "PROSPECT_PAGE_KEY", "broker"], ["/lockin", "LOCK_IN_INTERNAL_KEY", "internal"]]);
  assert.equal(audienceState(a, undefined, []).off, "its key is not set");
  assert.equal(audienceState(a, "  ", []).off, "its key is not set");
  assert.equal(audienceState(a, "x".repeat(AUDIENCE_KEY_MIN - 1), []).off, "its key is shorter than 16 characters");
  assert.equal(audienceState(a, KEY, ["other", KEY]).off, "its key is the same as another key of this service");
  const on = audienceState(a, ` ${KEY} `, ["other"]);
  assert.equal(on.key, KEY);
  assert.equal(keyMatches(KEY, KEY), true);
  for (const wrong of [null, "", KEY.slice(1), `${KEY}x`, KEY.toUpperCase()]) assert.equal(keyMatches(wrong, KEY), false);
  assert.deepEqual(audienceOf([on], "/prospect/detail/")?.sub, "/detail");
  assert.deepEqual(audienceOf([on], "/prospect")?.sub, "/");
  assert.equal(audienceOf([on], "/prospects"), null);
  // from the environment: the BTC key and the sports key are the ones it may not share
  const dir = mkdtempSync(join(tmpdir(), "sv-reader-"));
  const states = (env: Record<string, string>) => sportsCollectorFromEnv({ SPORTS_VENUES_DATA_DIR: dir, ...env }).health().audiencePages as string[];
  const state = (env: Record<string, string>) => states(env)[0];
  assert.equal(state({}), "off: its key is not set");
  assert.equal(state({ PROSPECT_PAGE_KEY: KEY }), "on");
  // the internal pages are off until they have a key, and a key the reader's page shares opens neither
  assert.deepEqual(states({ PROSPECT_PAGE_KEY: KEY }), ["on", "off: its key is not set"]);
  assert.deepEqual(states({ PROSPECT_PAGE_KEY: KEY, LOCK_IN_INTERNAL_KEY: INTERNAL }), ["on", "on"]);
  assert.deepEqual(states({ PROSPECT_PAGE_KEY: KEY, LOCK_IN_INTERNAL_KEY: KEY }), ["off: its key is the same as another key of this service", "off: its key is the same as another key of this service"]);
  assert.equal(states({ LOCK_IN_INTERNAL_KEY: INTERNAL, BTC_CURVE_TOKEN: INTERNAL })[1], "off: its key is the same as another key of this service");
  assert.equal(state({ PROSPECT_PAGE_KEY: KEY, BTC_CURVE_TOKEN: KEY }), "off: its key is the same as another key of this service");
  assert.equal(state({ PROSPECT_PAGE_KEY: KEY, SPORTS_VENUES_TOKEN: KEY }), "off: its key is the same as another key of this service");
  assert.equal(state({ PROSPECT_PAGE_KEY: "short" }), "off: its key is shorter than 16 characters");
});

test("the book count shown to a reader: one figure of the exchange's own rows, and nothing that names or measures another venue", () => {
  assert.deepEqual(bookCountOf(holderReport(emptyState())), { sinceMs: null, pre: null, live: null });
  const row = { venue: "cryptocom" as const, readings: 10, noBid: 0, saleCostCents: 1, meanSpreadCents: 1.1, depthShare: [1, 0.9, 0.5], choice: 10, elsewhereShare: 0.9, meanSavingCents: 1.3, cheapestMost: { venue: "kalshi" as const, share: 0.8 }, roomShare: 0.001, meanRoomCents: 0.3 };
  const other = { ...row, venue: "kalshi" as const, readings: 99 };
  const shown = bookCountOf({ sinceMs: 5, lastAtMs: 9, snapshots: 2, all: { pre: [other, row], live: [other] }, byLeague: {} });
  assert.deepEqual(shown, { sinceMs: 5, pre: { readings: 10, deepShare: 0.9 }, live: null });
});

interface Out {
  status: number;
  body: string;
  headers: Record<string, string>;
}

test("the reader's page: the story's ticket on the card, a moment picked, the calculator's sum the same in the browser, nothing that leads off the page, and nothing of how a lock is made", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sv-reader-"));
  const seedDir = join(dir, "seed");
  mkdirSync(seedDir);
  writeFileSync(join(seedDir, `${EVENT}.tape.jsonl`), `${GAME_LINES.join("\n")}\n`);
  const collector = new SportsCollector({ dataDir: join(dir, "data"), log: () => {}, readGames: async () => [], tape: { seedDir }, audienceKeys: { prospect: KEY, internal: INTERNAL }, hostKeys: ["host-key"] });
  await collector.load();
  const get = (path: string): Out | null => {
    const out: Out = { status: 0, body: "", headers: {} };
    const res = { writeHead: (status: number, headers: Record<string, string>) => ((out.status = status), (out.headers = headers), res), end: (body: string) => (out.body = body) } as unknown as ServerResponse;
    return collector.audience({} as IncomingMessage, res, new URL(path, "http://localhost")) ? out : null;
  };
  // not an address of a reader's page: left to the host
  assert.equal(get("/sports?k=host-key"), null);
  assert.equal(get("/"), null);
  for (const path of ["/prospect", "/prospect?k=host-key", `/prospect?k=${KEY}x`, `/prospect?k=${INTERNAL}`, `/prospect/more?k=${KEY}`, `/prospect/detail?k=${KEY}`, `/prospect/api?k=${KEY}`, `/lockin?k=${KEY}`, `/lockin/lock?k=${KEY}`, `/lockin/api?k=${KEY}`, "/lockin"]) assert.deepEqual([get(path)?.status, get(path)?.body], [404, "not found"], path);
  // the host's own routes never serve it
  const none = { writeHead: () => none, end: () => {} } as unknown as ServerResponse;
  assert.equal(collector.handle({} as IncomingMessage, none, "/prospect", new URL(`/prospect?k=${KEY}`, "http://localhost")), false);
  assert.equal(collector.handle({} as IncomingMessage, none, "/replay", new URL("/replay", "http://localhost"), { lockPages: false }), false);
  assert.equal(collector.handle({} as IncomingMessage, none, "/lock", new URL("/lock", "http://localhost"), { lockPages: false }), false);

  const page = get(`/prospect?k=${KEY}`)!;
  assert.equal(page.status, 200);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["cache-control"], "no-store");
  const html = page.body;
  assert.match(html, /Prepared for Prospect Markets by Atticus/);
  assert.ok(!html.includes("—") && !html.includes("http-equiv=\"refresh\""));
  assert.match(html, /Games counted <b>1<\/b>/);
  assert.match(html, /<span class="hl">1 of them, 50%, finished at \$0<\/span>/);
  assert.match(html, /<span class="hl">1 of those losing tickets \(100%\) were ahead at some point<\/span>/);
  // the two tickets told by what their holders had: what it cost, what came back, how it ended
  assert.match(html, /someone buys 100 contracts of Washington Wizards to win at 48¢\. That is <b>\$50\.00<\/b> with the exchange fee\./);
  assert.match(html, /40 min into the game the price is 66¢\. Lock in there: <b>\$50\.00<\/b> back in cash, the whole stake, and \$21\.87 still to win\./);
  assert.match(html, /<b>Washington Wizards lost\.<\/b> Held to the end as it was: <b class="bad">\$0\.00<\/b>\. With Lock in: <b class="ok">\$50\.00<\/b>\./);
  assert.match(html, /<b>Indiana Pacers won\.<\/b> Held to the end as it was: \$80\.00\. With Lock in: \$33\.60 in cash at that moment plus \$22\.06 at the end, <b>\$55\.66<\/b>\. The lock cost \$24\.34 of the win\./);
  // with nothing asked for, the card is the ticket that lost, at its moment, and says how it ended
  assert.match(html, /<option value="past:NBA-00001-261111-M\|away" selected>/);
  assert.match(html, new RegExp(`<option value="${S + 40 * MIN}" selected>40 min into the game · 66¢</option>`));
  assert.match(html, /name="n" type="number" min="0\.01" step="0\.01" value="100"/);
  assert.match(html, /Price then <b>66¢<\/b> <small>40 min into the game · [^<]* · the exchange's book, 500 contracts at that price<\/small>/);
  const backCard = /<div class="opt"><h3>Stake back<\/h3>.*?<\/div>\n?<p>.*?<\/div>/s.exec(html)![0];
  assert.match(backCard, /<small>Cash now<\/small><b>\$50\.00<\/b>.*<small>Total if they win<\/small><b>\$71\.87<\/b>.*<small>Stake returned<\/small><b>100%<\/b>/s);
  assert.match(html, /If Washington Wizards lose: <b>\$50\.00<\/b> instead of \$0\.00\. If they win: <b>\$71\.87<\/b> instead of \$100\.00\./);
  assert.match(html, /What happened: Washington Wizards lost\. Held to the end with no lock: \$0\.00\. With this lock: <b class="ok">\$50\.00<\/b>\./);
  assert.match(html, /Held to the end with no lock <b>\$0\.00<\/b>/);
  assert.deepEqual([...html.matchAll(/<div class="opt"><h3>([^<]+)<\/h3><p class="dim">/g)].map((m) => m[1]), ["Stake back", "Max upside", "Balanced", "Max floor"]);
  assert.match(html, /Cash figures are after the exchange's fee\./);
  // the story's own link opens the same card
  const link = /href="(\/prospect\?k=[^"]*game=past[^"]*away[^"]*)#lock"/.exec(html)![1].replace(/&amp;/g, "&");
  assert.ok(get(link)!.body.includes("<small>Total if they win</small><b>$71.87</b>"));
  // another side, another moment: the winner's ticket, what the lock cost it, and a price with too little behind it
  const home = get(`/prospect?k=${KEY}&game=${encodeURIComponent(`past:${EVENT}|home`)}&n=80`)!.body;
  assert.match(home, /Position <b>80 contracts at 40¢<\/b> <small>no price given: the last trade before the start · paid \$33\.60 with the fee<\/small>/);
  assert.match(home, /What happened: Indiana Pacers won\. Held to the end with no lock: \$80\.00\. With this lock: <b>\$55\.66<\/b>, \$24\.34 less\./);
  assert.match(home, /This position is larger than what was at that price: part of it would get less than shown\./);
  assert.ok(!html.includes("This position is larger"));
  const later = get(`/prospect?k=${KEY}&game=${encodeURIComponent(`past:${EVENT}|away`)}&at=${S + 70 * MIN}&n=100&paid=48`)!.body;
  assert.match(later, /Price then <b>70¢<\/b>/);
  assert.match(later, /<h3>Stake back<\/h3>.*?<small>Cash now<\/small><b>\$50\.00<\/b>.*?<small>Total if they win<\/small><b>\$76\.47<\/b>/s);
  // a price the stake does not come back at: where it opens, in a line
  const dear = get(`/prospect?k=${KEY}&game=${encodeURIComponent(`past:${EVENT}|away`)}&at=${S + 20 * MIN}&n=100&paid=58`)!.body;
  assert.match(dear, /Stake back is not available at this price\. On this position it opens at \d+¢\./);
  // a game that is not one of the closed ones is not read from the disk
  assert.match(get(`/prospect?k=${KEY}&game=${encodeURIComponent("past:../../etc/passwd|away")}`)!.body, /Pick a game and a side\./);
  // every link is to the page itself, its key in each, and no other page of the service is named
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length === 2 && hrefs.every((h) => h.startsWith(`/prospect?k=${KEY}&amp;game=past`)), hrefs.join(" "));
  assert.ok(!/Kalshi|Polymarket|Novig|ProphetX|\/sports|\/pairs|\/lockin|BTC|host-key|internal/i.test(html));
  // held back, on every view of the page: the order behind a lock, how it is sized, where the figures are read from
  for (const view of [html, home, later, dear]) {
    const held = /\bsell|\bsold\b|\bsale|\bbids?\b|taker|\bAPI\b|another exchange|other exchange|live_back|pre_wide|being recorded|once a minute|40%|80%/i.exec(view);
    assert.equal(held, null, held ? `the reader's page says "${held[0]}"` : "");
  }
  // the reader is named, never called by its licence or addressed as a category
  for (const view of [html, home, later, dear]) assert.equal(/\bbroker|\byou\b|\byour\b|commission/i.exec(view.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/id="c-commission[^"]*"/g, "")), null);
  assert.equal((html.match(/<aside class="why"><b>For Prospect<\/b>/g) ?? []).length, 5);
  assert.match(html, /<h2><span class="n">5<\/span>What it adds for Prospect<\/h2>/);
  assert.match(html, /Share of the exchange's retail tickets that are Prospect's, %/);
  assert.match(html, /Prospect stays what it is: the platform the customer trades on\. Nobody in this picture is the house: not Prospect, not Atticus\./);
  assert.match(html, /<title>Lock in on Crypto\.com's exchange · Prospect Markets<\/title>/);

  // the internal pages carry all of it, under their own key
  const full = get(`/lockin?k=${INTERNAL}`)!;
  assert.equal(full.status, 200);
  assert.match(full.body, /<h1>Lock in, replayed on real trades<\/h1>/);
  assert.match(full.body, /sells just enough to return the stake/);
  assert.ok(full.body.includes(`<a href="/lockin/lock?k=${INTERNAL}">Lock in now</a>`) && !/\/sports|\/prospect|host-key/.test(full.body) && !full.body.includes(KEY));
  assert.equal(get(`/lockin/lock?k=${INTERNAL}`)!.status, 200);
  assert.equal(JSON.parse(get(`/lockin/api?k=${INTERNAL}`)!.body).report.all.games, 1);
  assert.equal(get(`/lockin/more?k=${INTERNAL}`)!.status, 404);

  // the calculator: the table as rendered is brokerRows at the defaults, and the script's sum is brokerRows at any other
  const report = sumReplays([replayGame(parseCapsule(GAME_LINES)!, FEE)]);
  const base = JSON.parse(/data-base="([^"]+)"/.exec(html)![1].replace(/&quot;/g, '"')) as Record<string, BrokerBase>;
  assert.deepEqual(base.stake_back, brokerBase(lockTallyOf(report.all, "live_back80", "all", "small")));
  assert.deepEqual(base.stake_back, { orders: 2, contracts: 136, fees: 3, saved: 1, returned: 50 });
  assert.deepEqual(Object.keys(base), BROKER_OPTIONS.map((o) => o.key));
  assert.deepEqual([...html.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]), Object.keys(base));
  assert.equal(openTallyOf(report.all, "all", "small").n, 2);
  const big: BrokerBase = { orders: 13_789, contracts: 580_000, fees: 11_600, saved: 3141, returned: 81_970 };
  assert.deepEqual(brokerRows(big, 10, 100, 0), { orders: 1379, contracts: 58_000, fees: 1160, saved: 314, returned: 8197, commission: 0 });
  assert.deepEqual(brokerRows(big, 25, 40, 1.5), { orders: 1379, contracts: 58_000, fees: 1160, saved: 314, returned: 8197, commission: 870 });
  const cell = (id: string) => new RegExp(`id="c-${id}">([^<]*)<`).exec(html)![1];
  const first = brokerRows(base.stake_back, BROKER_DEFAULTS.adoption, BROKER_DEFAULTS.share, BROKER_DEFAULTS.commission);
  assert.deepEqual([cell("orders"), cell("contracts"), cell("fees"), cell("commission"), cell("saved"), cell("returned")], [String(first.orders), String(first.contracts), `$${first.fees}`, "$0", String(first.saved), `$${first.returned}`]);

  // the script, run against the page's own elements: the guide steps through the stops, and the sum follows the boxes
  const el = (id: string) => {
    const classes = new Set<string>();
    return { id, value: "", textContent: "", form: { at: { value: "x" }, paid: { value: "x" }, submit() {} }, onclick: null as null | (() => void), oninput: null as null | (() => void), onchange: null as null | (() => void), scrolled: 0, classList: { toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)), has: (c: string) => classes.has(c) }, scrollIntoView() { this.scrolled += 1; }, getAttribute: (name: string) => (name === "data-base" ? JSON.stringify({ stake_back: big, half_back: big, before_start: { ...big, orders: 100 } }) : name === "data-games" ? "31" : null) };
  };
  const ids = new Map<string, ReturnType<typeof el>>();
  const byId = (id: string) => ids.get(id) ?? (ids.set(id, el(id)), ids.get(id)!);
  const stops = (html.match(/<section data-stop/g) ?? []).map((_, i) => el(`stop${i}`));
  assert.equal(stops.length, 6);
  assert.equal((html.match(/<aside class="why">/g) ?? []).length, 6);
  const keys: Array<(e: { key: string; target: { tagName: string }; preventDefault(): void }) => void> = [];
  const body = el("body");
  Object.assign(byId("c-option"), { value: "stake_back" });
  Object.assign(byId("c-adoption"), { value: "25" });
  Object.assign(byId("c-share"), { value: "40" });
  Object.assign(byId("c-commission"), { value: "1.5" });
  vm.runInNewContext(GUIDE_SCRIPT, { document: { body, querySelectorAll: () => stops, getElementById: byId, addEventListener: (_: string, fn: (typeof keys)[number]) => keys.push(fn) }, JSON, Number, Math, isFinite });
  for (const id of ["g-start", "g-prev", "g-next", "g-close", "g-all", "lock-game", "calc", "c-option", "c-adoption", "c-share", "c-commission"]) assert.ok(html.includes(`id="${id}"`), `the page has #${id}`);
  const on = () => stops.map((s) => (s.classList.has("on") ? 1 : 0)).join("");
  assert.equal(on(), "000000");
  byId("g-start").onclick!();
  assert.deepEqual([on(), byId("g-count").textContent, body.classList.has("guiding"), stops[0].scrolled], ["100000", "1 of 6", true, 1]);
  byId("g-next").onclick!();
  byId("g-next").onclick!();
  assert.deepEqual([on(), byId("g-count").textContent], ["001000", "3 of 6"]);
  const press = (key: string, tagName = "BODY") => keys[0]({ key, target: { tagName }, preventDefault() {} });
  press("ArrowLeft");
  assert.equal(on(), "010000");
  // typing in a box does not move the guide
  press("ArrowRight", "INPUT");
  assert.equal(on(), "010000");
  for (let i = 0; i < 9; i += 1) press("ArrowRight");
  assert.deepEqual([on(), byId("g-count").textContent], ["000001", "6 of 6"]);
  press("Escape");
  assert.deepEqual([on(), body.classList.has("guiding")], ["000000", false]);
  byId("g-all").onclick!.call(byId("g-all"));
  assert.deepEqual([body.classList.has("notes"), byId("g-all").textContent], [true, "Hide the notes"]);
  byId("c-adoption").oninput!();
  const want = brokerRows(big, 25, 40, 1.5);
  const usd = (v: number) => `$${v.toLocaleString("en-US")}`;
  assert.deepEqual(
    ["orders", "contracts", "fees", "commission", "saved", "returned"].map((k) => byId(`c-${k}`).textContent),
    [want.orders.toLocaleString("en-US"), want.contracts.toLocaleString("en-US"), usd(want.fees), usd(want.commission), want.saved.toLocaleString("en-US"), usd(want.returned)],
  );
  assert.equal(byId("c-orders-g").textContent, String(Math.round((big.orders * 0.1) / 31)));
  Object.assign(byId("c-option"), { value: "before_start" });
  byId("c-option").onchange!();
  assert.equal(byId("c-orders").textContent, "10");
  // picking another game clears the moment and the price, which belong to the game before
  const game = byId("lock-game");
  game.onchange!.call(game);
  assert.deepEqual([game.form.at.value, game.form.paid.value], ["", ""]);
  collector.stop();
});
