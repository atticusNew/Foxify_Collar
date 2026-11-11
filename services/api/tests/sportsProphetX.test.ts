/**
 * SPORTS VENUES, PROPHETX: American odds read as the price of a $1 contract, the size a taker can
 * still put on read as contracts, the two clubs matched to the game by name and date, the fee
 * taken from the venue's own estimator (per contract on NHL, a share of winnings elsewhere), and
 * all of it carried through the all-in prices, the window tally and the page.
 *
 * The level shapes and figures are the venue's own, read on 11 November 2026.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import { allIn, buyFeeCents, crossesOf, readGame, readSlate, windowTally } from "../src/sportsVenues/analytics";
import { SportsCollector } from "../src/sportsVenues/collector";
import {
  americanToCents,
  prophetxBestLevel,
  prophetxFeeFrom,
  prophetxListingFrom,
  prophetxSides,
  readProphetXListings,
  type ProphetXEvent,
  type ProphetXLevel,
  type ProphetXMarket,
} from "../src/sportsVenues/prophetx";
import { assembleGames } from "../src/sportsVenues/readers";
import { buildReport } from "../src/sportsVenues/report";
import { renderReportHtml } from "../src/sportsVenues/reportHtml";
import { toHistoryPoint } from "../src/sportsVenues/store";
import { VENUES, byVenue, type Game, type Snapshot, type VenueListing } from "../src/sportsVenues/types";

const NFL = LEAGUE_TEMPLATES.find((t) => t.league === "nfl")!;
const NHL = LEAGUE_TEMPLATES.find((t) => t.league === "nhl")!;

const LIONS = 1700004959;
const PATRIOTS = 1700004955;
const level = (competitorId: number, odds: number, value: number, stake = 0): ProphetXLevel => ({ competitorId, odds, value, stake });
/** New England at Detroit, as the venue returned it: the home club is first. */
const EVENT: ProphetXEvent = {
  id: 1700008804,
  scheduled: "2026-11-15T14:30:00Z",
  status: "not_started",
  tournament: { id: 31, name: "NFL" },
  competitors: [
    { id: LIONS, name: "Detroit Lions", abbreviation: "DET", seq: 0 },
    { id: PATRIOTS, name: "New England Patriots", abbreviation: "NE", seq: 1 },
  ],
};
const MARKET: ProphetXMarket = {
  id: 219,
  type: "moneyline",
  subType: "moneyline",
  selections: [
    [level(LIONS, -144, 417.6, 291.92), level(LIONS, -146, 1460, 1003.38), level(LIONS, -148, 47.64, 44.98)],
    [level(PATRIOTS, 138, 1693.75, 2360.76), level(PATRIOTS, 136, 911.87, 1240.14)],
  ],
};
const GAME: Game = {
  key: "nfl:NE:DET:2026-11-15",
  league: "nfl",
  awayCode: "NE",
  homeCode: "DET",
  awayName: "New England Patriots",
  homeName: "Detroit Lions",
  startsAt: "2026-11-15T17:00:00.000Z",
  startSource: "date_only",
  listings: [],
};
const COMMISSION = { theta: 0, gain: 0.02 };

test("odds: American odds are the price of a $1 contract, to the hundredth of a cent", () => {
  assert.equal(americanToCents(168), 37.31);
  assert.equal(americanToCents(-180), 64.29);
  assert.equal(americanToCents(100), 50);
  assert.equal(americanToCents(-100), 50);
  assert.equal(americanToCents(-970), 90.65);
  assert.equal(americanToCents(890), 10.1);
  // not odds: nothing between -100 and +100, and nothing that is not a number
  for (const bad of [0, 99, -99, Number.NaN, undefined]) assert.equal(americanToCents(bad), null);
});

test("best level: the lowest price holding at least $1, sized by what a taker can still put on, never by the resting stake", () => {
  // -144 is 59.02¢; $417.60 there buys 417.6 / (144/244) = 707.6 contracts
  assert.deepEqual(prophetxBestLevel(MARKET.selections![0]), { cents: 59.02, shares: 707.6 });
  // +138 is 42.02¢; $1,693.75 buys 1693.75 x 2.38 = 4031.12 contracts
  assert.deepEqual(prophetxBestLevel(MARKET.selections![1]), { cents: 42.02, shares: 4031.12 });
  // a level nearly taken: $0.58 left of a stake of $225.64. Under the venue's $1 order it is passed over
  const dust = [level(LIONS, -142, 0.58, 225.64), ...MARKET.selections![0]];
  assert.equal(prophetxBestLevel(dust)?.cents, 59.02);
  // $2.84 left is a real level, and its size is the $2.84, not the $225.64
  const thin = [level(LIONS, -142, 2.84, 225.64), ...MARKET.selections![0]];
  assert.deepEqual(prophetxBestLevel(thin), { cents: 58.68, shares: 4.83 });
  // the order the venue lists levels in does not matter, and two entries at the same odds are one level
  assert.deepEqual(prophetxBestLevel([level(LIONS, -148, 47.64), level(LIONS, -144, 200), level(LIONS, -144, 217.6)]), { cents: 59.02, shares: 707.6 });
  assert.equal(prophetxBestLevel([]), null);
  assert.equal(prophetxBestLevel(undefined), null);
  assert.equal(prophetxBestLevel([level(LIONS, 50, 100)]), null);
});

test("listing: each club's best odds are its ask, its bid is 1 minus the other club's ask, sizes cross over, and home and away come from the clubs, not the venue's order", () => {
  const l = prophetxListingFrom(EVENT, MARKET, COMMISSION, GAME, NFL)!;
  assert.equal(l.venue, "prophetx");
  assert.equal(l.id, "1700008804:219");
  assert.deepEqual(l.away, { bidCents: 40.98, askCents: 42.02, bidQty: 707.6, askQty: 4031.12 });
  assert.deepEqual(l.home, { bidCents: 57.98, askCents: 59.02, bidQty: 4031.12, askQty: 707.6 });
  assert.equal(l.feeTheta, 0);
  assert.equal(l.feeGain, 0.02);
  assert.equal(l.awayName, "New England Patriots");
  assert.equal(l.homeName, "Detroit Lions");
  assert.equal(l.startsAt, "2026-11-15T14:30:00.000Z");
  // the venue's two arrays the other way round give the same listing
  assert.deepEqual(prophetxListingFrom(EVENT, { ...MARKET, selections: [MARKET.selections![1], MARKET.selections![0]] }, COMMISSION, GAME, NFL), l);
  // nobody offering odds on one club: that club has no ask and the other has no bid
  const oneSided = prophetxListingFrom(EVENT, { ...MARKET, selections: [MARKET.selections![0], []] }, COMMISSION, GAME, NFL)!;
  assert.deepEqual(oneSided.away, { bidCents: 40.98, askCents: 0, bidQty: 707.6, askQty: 0 });
  assert.deepEqual(oneSided.home, { bidCents: 0, askCents: 59.02, bidQty: 0, askQty: 707.6 });
});

test("listing: a market that is not the two-way winner, or that names anyone but the two clubs, is not read", () => {
  // the regulation-only hockey market and the period markets come under other subtypes
  assert.equal(prophetxListingFrom(EVENT, { ...MARKET, subType: "moneyline_3_way" }, COMMISSION, GAME, NFL), null);
  assert.equal(prophetxListingFrom(EVENT, { ...MARKET, type: "spread" }, COMMISSION, GAME, NFL), null);
  assert.equal(prophetxListingFrom(EVENT, { ...MARKET, selections: [MARKET.selections![0]] }, COMMISSION, GAME, NFL), null);
  // a level for a third competitor (a draw line) or both arrays for one club
  assert.equal(prophetxListingFrom(EVENT, { ...MARKET, selections: [MARKET.selections![0], [level(999, 250, 100)]] }, COMMISSION, GAME, NFL), null);
  assert.equal(prophetxListingFrom(EVENT, { ...MARKET, selections: [MARKET.selections![0], MARKET.selections![0]] }, COMMISSION, GAME, NFL), null);
  // another game's event
  assert.equal(prophetxListingFrom(EVENT, MARKET, COMMISSION, { ...GAME, awayName: "New York Jets", awayCode: "NYJ" }, NFL), null);
});

test("clubs: matched by the full name, or by the venue's code where the name is written differently", () => {
  assert.ok(prophetxSides(EVENT, GAME, NFL));
  // the venue writes WSH and TBL where Kalshi writes WAS and TB
  const nhl: ProphetXEvent = { id: 1, competitors: [{ id: 1, name: "Buffalo Sabres", abbreviation: "BUF" }, { id: 2, name: "Tampa Bay Bolts", abbreviation: "TBL" }] };
  const game: Game = { ...GAME, key: "nhl:TB:BUF:2026-11-11", league: "nhl", awayCode: "TB", homeCode: "BUF", awayName: "Tampa Bay Lightning", homeName: "Buffalo Sabres" };
  const sides = prophetxSides(nhl, game, NHL)!;
  assert.equal(sides.away.id, 2);
  assert.equal(sides.home.id, 1);
  // accents and punctuation in a name do not matter
  const stl: ProphetXEvent = { id: 2, competitors: [{ id: 3, name: "St Louis Blues" }, { id: 4, name: "Montréal Canadiens" }] };
  assert.ok(prophetxSides(stl, { ...game, awayName: "St. Louis Blues", homeName: "Montreal Canadiens" }, NHL));
  // one club of the two is not a match, and neither is an event with a third competitor
  assert.equal(prophetxSides(nhl, { ...game, awayName: "Florida Panthers" }, NHL), null);
  assert.equal(prophetxSides({ ...nhl, competitors: [...nhl.competitors!, { id: 9, name: "Draw" }] }, game, NHL), null);
});

test("fee: read from the venue's estimator at two prices; per contract on a maker/taker game, a share of winnings on the others, nothing guessed", () => {
  // NHL, taker, $100 cost: $1.75 at 50¢ and $2.625 at 25¢, both 0.035 x (1 - p) per dollar
  assert.deepEqual(prophetxFeeFrom({ model: "FEE_MODEL_MAKER_TAKER", fee: 1.75, rate: 0.0175 }, { model: "FEE_MODEL_MAKER_TAKER", fee: 2.625, rate: 0.026250000000000002 }, 2), { theta: 0.035, gain: 0 });
  // the two prices disagree: the schedule's shape has changed and the fee is not understood
  assert.equal(prophetxFeeFrom({ model: "FEE_MODEL_MAKER_TAKER", rate: 0.0175 }, { model: "FEE_MODEL_MAKER_TAKER", rate: 0.0175 }, 2), null);
  // NBA and NFL: nothing at the trade, the listed share of net winnings at settlement
  const none = { model: "FEE_MODEL_COMMISSION", fee: 0, rate: 0 };
  assert.deepEqual(prophetxFeeFrom(none, none, 2), { theta: 0, gain: 0.02 });
  assert.deepEqual(prophetxFeeFrom(none, none, 3.5), { theta: 0, gain: 0.035 });
  // no rate listed: the 2% in the venue's fee schedule
  assert.deepEqual(prophetxFeeFrom(none, none, undefined), { theta: 0, gain: 0.02 });
  // a commission game that charges at the trade, a model not seen before, a missing answer
  assert.equal(prophetxFeeFrom({ ...none, fee: 0.4 }, none, 2), null);
  assert.equal(prophetxFeeFrom({ model: "FEE_MODEL_NEW" }, { model: "FEE_MODEL_NEW" }, 2), null);
  assert.equal(prophetxFeeFrom(none, undefined, 2), null);
  assert.equal(prophetxFeeFrom(none, { model: "FEE_MODEL_MAKER_TAKER", rate: 0.02 }, 2), null);
});

test("all-in: a share of winnings is counted in full on the buy, as if the contract wins, and the per-contract fee as on Kalshi", () => {
  const nfl = prophetxListingFrom(EVENT, MARKET, COMMISSION, GAME, NFL)!;
  // away ask 42.02 + 2% of the 57.98 it can win = 43.18; bid 40.98 less 2% of it = 40.16
  const away = allIn(nfl, "away");
  assert.equal(away.allInAsk, 43.18);
  assert.equal(away.allInBid, 40.16);
  assert.equal(away.feeGain, 0.02);
  assert.equal(allIn(nfl, "home").allInAsk, 59.84);
  // an NHL game: 0.035 x p x (1 - p), 0.85¢ at 59.02
  const nhl = allIn({ ...nfl, feeTheta: 0.035, feeGain: undefined }, "home");
  assert.equal(nhl.allInAsk, 59.87);
  assert.equal(nhl.feeGain, undefined);
  assert.ok(Math.abs(buyFeeCents({ theta: 0.035 }, 50) - 0.875) < 1e-9);
  assert.ok(Math.abs(buyFeeCents({ theta: 0, gain: 0.02 }, 40) - 1.2) < 1e-9);
});

test("the board: ProphetX sits beside the other venues, a cross against it is net of its fee, and the window tally charges the fee that applied", () => {
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: { bidCents: 38, askCents: 39, bidQty: 500, askQty: 500 }, home: { bidCents: 60, askCents: 61, bidQty: 500, askQty: 500 }, feeTheta: 0.07, awayName: "NE", homeName: "DET" };
  const px = prophetxListingFrom(EVENT, MARKET, COMMISSION, GAME, NFL)!;
  const games = assembleGames([{ game: { ...GAME, listings: [kalshi] }, tickers: { away: "a", home: "h" } }], new Map(), new Map(), new Map([[GAME.key, px]]));
  assert.deepEqual(games[0].listings.map((l) => l.venue), ["kalshi", "prophetx"]);
  // the venue's start replaces the date-only one
  assert.equal(games[0].startsAt, "2026-11-15T14:30:00.000Z");
  const read = readGame(games[0], Date.parse("2026-11-14T00:00:00Z"));
  assert.deepEqual(read.listed, ["kalshi", "prophetx"]);
  // Kalshi away 39 + 1.67 = 40.67; ProphetX home 59.02 + 0.82 = 59.84; together 100.51: no cross
  assert.equal(read.crosses.length, 0);
  // holder of the home side buys away: Kalshi 40.67, ProphetX 43.18
  assert.equal(read.sides.home.hedge.cheapest, "kalshi");
  assert.equal(read.sides.home.hedge.costs.prophetx, 43.18);
  // holder of the away side buys home: Kalshi 61 + 1.67 = 62.67, ProphetX 59.84
  assert.equal(read.sides.away.hedge.cheapest, "prophetx");
  assert.equal(read.sides.away.hedge.savingCents, 2.83);
  assert.equal(read.sides.away.hedge.cheapestQty, 707.6);
  // ProphetX's home ask one tick lower still does not lock; without the winnings fee it would
  const cheaper = { ...px, home: { ...px.home, askCents: 58.68 } };
  const by = byVenue<{ away: ReturnType<typeof allIn>; home: ReturnType<typeof allIn> } | null>(() => null);
  by.kalshi = { away: allIn(kalshi, "away"), home: allIn(kalshi, "home") };
  by.prophetx = { away: allIn(cheaper, "away"), home: allIn(cheaper, "home") };
  assert.equal(crossesOf(by).length, 0);
  by.prophetx = { away: allIn({ ...cheaper, feeGain: undefined }, "away"), home: allIn({ ...cheaper, feeGain: undefined }, "home") };
  assert.equal(crossesOf(by)[0]?.edgeCents, 0.65);
  // the slate counts it as a venue like the others
  const slate = readSlate([read]);
  assert.deepEqual(slate.venues.map((v) => v.venue), [...VENUES]);
  assert.equal(slate.venues.find((v) => v.venue === "prophetx")!.hedgeCheapest, 1);
  assert.equal(slate.withAll, 0);
  // history: the winnings fee rides in the cell only where a venue charges it, and the tally uses it
  const snapshot: Snapshot = { at: "2026-11-14T00:00:00Z", games, health: {} };
  const point = toHistoryPoint(snapshot);
  assert.equal(point.games[GAME.key].prophetx!.length, 10);
  assert.equal(point.games[GAME.key].prophetx![9], 0.02);
  assert.equal(point.games[GAME.key].kalshi!.length, 9);
  const w = windowTally([point]);
  assert.equal(w.readings, 2);
  assert.equal(w.cheapest.prophetx, 1);
  assert.equal(w.cheapest.kalshi, 1);
  assert.equal(w.snapshotsWithCross, 0);
  assert.equal(w.meanSavingRoutedCents, 2.83);
});

/** A venue that answers the four reads from fixed bodies and records what was asked. */
function fakeVenue(over: { events?: Record<string, unknown>; estimate?: (items: Array<{ event_id: number; price: number }>) => unknown; commissions?: unknown } = {}) {
  const asked: string[] = [];
  const hockey: ProphetXEvent = {
    id: 1704712460,
    scheduled: "2026-11-12T00:00:00Z",
    status: "not_started",
    tournament: { id: 234, name: "NHL" },
    competitors: [{ id: 11, name: "Buffalo Sabres", abbreviation: "BUF", seq: 0 }, { id: 12, name: "Tampa Bay Lightning", abbreviation: "TBL", seq: 1 }],
  };
  const events: Record<string, unknown> = {
    // the NFL list comes in two pages; the game wanted is on the second
    "31:": { next: "c2", data: [{ ...EVENT, id: 5, scheduled: "2026-11-13T01:15:00Z", competitors: [{ id: 1, name: "New York Giants" }, { id: 2, name: "Washington Commanders" }] }] },
    "31:c2": { data: [EVENT, { ...EVENT, id: 6, status: "ended", scheduled: "2026-11-15T14:30:00Z" }] },
    "234:": { data: [hockey, { ...hockey, id: 7, scheduled: "2026-11-13T00:00:00Z" }] },
    ...(over.events ?? {}),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const tour = /\/tournaments\/(\d+)\/events$/.exec(url.pathname);
    if (tour) return json(events[`${tour[1]}:${url.searchParams.get("next") ?? ""}`] ?? { data: [] });
    if (url.pathname.endsWith("/get_multiple_markets")) {
      const ids = (url.searchParams.get("event_ids") ?? "").split(",").map(Number);
      return json({
        data: ids.map((id) =>
          id === EVENT.id
            ? { eventId: id, markets: [MARKET] }
            : { eventId: id, markets: [{ id: 406, type: "moneyline", subType: "moneyline", selections: [[level(11, 119, 56.81)], [level(12, -123, 72.35)]] }, { id: 1325, type: "moneyline", subType: "moneyline_3_way", selections: [[level(11, 200, 50)], []] }] },
        ),
      });
    }
    if (url.pathname.endsWith("/fees/estimate")) {
      const items = (JSON.parse(String(init?.body)) as { items: Array<{ event_id: number; price: number }> }).items;
      if (over.estimate) return json(over.estimate(items));
      return json({ items: items.map((it) => (it.event_id === EVENT.id ? { model: "FEE_MODEL_COMMISSION", fee: 0, rate: 0 } : { model: "FEE_MODEL_MAKER_TAKER", fee: 3.5 * (1 - it.price / 100), rate: 0.035 * (1 - it.price / 100) })) });
    }
    if (url.pathname.endsWith("/commissions")) return over.commissions === undefined ? json({ commissions: [{ eventId: EVENT.id, subType: "moneyline", commission: 2 }] }) : json(over.commissions, over.commissions === null ? 500 : 200);
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, asked };
}
const HOCKEY_GAME: Game = { ...GAME, key: "nhl:TB:BUF:2026-11-11", league: "nhl", awayCode: "TB", homeCode: "BUF", awayName: "Tampa Bay Lightning", homeName: "Buffalo Sabres" };

test("the read: one events list per league, each game matched by both clubs and the ET date, one books read and one fee read for the games matched", async () => {
  const venue = fakeVenue();
  const notes: string[] = [];
  const other: Game = { ...GAME, key: "nfl:KC:ATL:2026-11-15", awayCode: "KC", homeCode: "ATL", awayName: "Kansas City Chiefs", homeName: "Atlanta Falcons" };
  const out = await readProphetXListings([GAME, HOCKEY_GAME, other], { fetchImpl: venue.fetchImpl, host: "https://px.test", notes });
  assert.deepEqual([...out.keys()].sort(), [GAME.key, HOCKEY_GAME.key].sort());
  assert.deepEqual(notes, []);
  // NFL: commission, 2% of winnings, nothing per contract
  const nfl = out.get(GAME.key)!;
  assert.equal(nfl.feeTheta, 0);
  assert.equal(nfl.feeGain, 0.02);
  assert.equal(nfl.away.askCents, 42.02);
  // NHL: 0.035 per contract, no winnings fee; the regulation-only market beside the winner is not read; 00:00 UTC is the evening before in ET
  const nhl = out.get(HOCKEY_GAME.key)!;
  assert.equal(nhl.feeTheta, 0.035);
  assert.equal(nhl.feeGain, undefined);
  assert.equal(nhl.id, "1704712460:406");
  // Sabres +119 is 45.66¢, Lightning -123 is 55.16¢; the Lightning are away
  assert.equal(nhl.away.askCents, 55.16);
  assert.equal(nhl.home.askCents, 45.66);
  assert.equal(nhl.away.bidCents, 54.34);
  // what was asked: the two lists (NFL's second page too), then one read each of books, fees and commissions for the two games
  assert.equal(venue.asked.filter((a) => a.includes("/tournaments/31/events")).length, 2);
  assert.ok(venue.asked.some((a) => a.includes("/tournaments/31/events") && a.includes("next=c2")));
  assert.equal(venue.asked.filter((a) => a.includes("/tournaments/234/events")).length, 1);
  const books = venue.asked.filter((a) => a.includes("get_multiple_markets"));
  assert.equal(books.length, 1);
  assert.ok(books[0].includes("market_types=moneyline"));
  assert.ok(books[0].includes(String(EVENT.id)) && books[0].includes("1704712460") && !books[0].includes("event_ids=5"));
  assert.equal(venue.asked.filter((a) => a.startsWith("POST") && a.includes("/fre/v1/fees/estimate")).length, 1);
  assert.equal(venue.asked.filter((a) => a.includes("/commission/public/commissions") && a.includes("sub_types=moneyline")).length, 1);
});

test("the read: a game on another day, a finished event and a league list under another name are left off, with the reason where there is one", async () => {
  // the same clubs a day later are another game
  const venue = fakeVenue();
  const nextDay: Game = { ...HOCKEY_GAME, key: "nhl:TB:BUF:2026-11-13" };
  assert.equal((await readProphetXListings([nextDay], { fetchImpl: venue.fetchImpl, host: "https://px.test" })).size, 0);
  // nothing matched: the books and the fees are not asked for
  assert.ok(!venue.asked.some((a) => a.includes("get_multiple_markets") || a.includes("fees/estimate")));
  // the id now lists another competition
  const renamed = fakeVenue({ events: { "234:": { data: [{ id: 1704712460, scheduled: "2026-11-12T00:00:00Z", tournament: { id: 234, name: "AHL" }, competitors: [{ id: 11, name: "Buffalo Sabres" }, { id: 12, name: "Tampa Bay Lightning" }] }] } } });
  const notes: string[] = [];
  assert.equal((await readProphetXListings([HOCKEY_GAME], { fetchImpl: renamed.fetchImpl, host: "https://px.test", notes })).size, 0);
  assert.match(notes[0], /no longer named NHL/);
  // two events for one game on one day: neither is taken
  const twice = fakeVenue({ events: { "234:": { data: [1, 2].map((id) => ({ id, scheduled: "2026-11-12T00:00:00Z", tournament: { id: 234, name: "NHL" }, competitors: [{ id: 11, name: "Buffalo Sabres" }, { id: 12, name: "Tampa Bay Lightning" }] })) } } });
  const twiceNotes: string[] = [];
  assert.equal((await readProphetXListings([HOCKEY_GAME], { fetchImpl: twice.fetchImpl, host: "https://px.test", notes: twiceNotes })).size, 0);
  assert.match(twiceNotes[0], /2 events match/);
});

test("the read: a fee that is not understood leaves the game off; when that is every game the venue reads as down; a commission list that fails falls back to 2% and says so", async () => {
  // hockey's estimator answers in a shape not seen before: football stays, hockey goes, and the note says why
  const part = fakeVenue({ estimate: (items) => ({ items: items.map((it) => (it.event_id === EVENT.id ? { model: "FEE_MODEL_COMMISSION", fee: 0, rate: 0 } : { model: "FEE_MODEL_TIERED", fee: 1, rate: 0.01 })) }) });
  const notes: string[] = [];
  const out = await readProphetXListings([GAME, HOCKEY_GAME], { fetchImpl: part.fetchImpl, host: "https://px.test", notes });
  assert.deepEqual([...out.keys()], [GAME.key]);
  assert.match(notes.join(" "), /1 game left off: the venue's fee for them was not understood/);
  // every game
  const all = fakeVenue({ estimate: (items) => ({ items: items.map(() => ({ model: "FEE_MODEL_TIERED" })) }) });
  await assert.rejects(readProphetXListings([GAME, HOCKEY_GAME], { fetchImpl: all.fetchImpl, host: "https://px.test" }), /2 games left off: the venue's fee for them was not understood/);
  // fewer answers than questions cannot be paired with their games
  const short = fakeVenue({ estimate: () => ({ items: [{ model: "FEE_MODEL_COMMISSION", fee: 0, rate: 0 }] }) });
  await assert.rejects(readProphetXListings([GAME], { fetchImpl: short.fetchImpl, host: "https://px.test" }), /answered 1 of 2 items/);
  // the commission list fails: the published 2%, and a note
  const noRates = fakeVenue({ commissions: null });
  const rateNotes: string[] = [];
  const got = await readProphetXListings([GAME], { fetchImpl: noRates.fetchImpl, host: "https://px.test", notes: rateNotes });
  assert.equal(got.get(GAME.key)!.feeGain, 0.02);
  assert.match(rateNotes[0], /commission rates not read; the venue's published 2% of net winnings assumed/);
});

test("page and health: a ProphetX column on the board, its fee in its own words, and /healthz counting the games each venue is on", async () => {
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: { bidCents: 38, askCents: 39, bidQty: 500, askQty: 500 }, home: { bidCents: 60, askCents: 61, bidQty: 500, askQty: 500 }, feeTheta: 0.07, awayName: "NE", homeName: "DET" };
  const px = prophetxListingFrom(EVENT, MARKET, COMMISSION, GAME, NFL)!;
  const games: Game[] = [{ ...GAME, startsAt: px.startsAt!, startSource: "venue", listings: [kalshi, px] }];
  const snapshot: Snapshot = { at: "2026-11-14T00:00:00Z", games, health: { kalshi: { ok: true, ms: 200 }, prophetx: { ok: true, ms: 150, detail: "1 game left off: the venue's fee for them was not understood" } } };
  const html = renderReportHtml(buildReport({ snapshot, history: [toHistoryPoint(snapshot)], intervalSec: 60, collectingSince: snapshot.at }), { refreshSec: 60 });
  for (const needle of [
    "<title>Sports on the event venues: Kalshi, Polymarket US, Novig, ProphetX, Crypto.com</title>",
    "<th>ProphetX<br><small>bid / ask · depth</small></th>",
    "<th>ProphetX<br><small>− consensus</small></th>",
    'colspan="13"',
    "<b>40.98</b> / <b>42.02</b>",
    "fee 2% of winnings",
    "ProphetX</b> 59.84¢ all in",
    "saves 2.83¢",
    "0 on all five",
    "ProphetX public web endpoints",
    "prophetx 150ms (1 game left off: the venue&#39;s fee for them was not understood)",
  ]) {
    assert.ok(html.includes(needle), `page lacks: ${needle}`);
  }
  assert.ok(!/—/.test(html), "no em dash in the page");
  // an NHL listing says its fee per contract
  const nhl = renderReportHtml(buildReport({ snapshot: { ...snapshot, games: [{ ...games[0], listings: [kalshi, { ...px, feeTheta: 0.035, feeGain: undefined }] }] }, history: [], intervalSec: 60, collectingSince: null }));
  assert.ok(nhl.includes("fee 3.5%"));
  assert.ok(!nhl.includes("of winnings</small>"));

  const collector = new SportsCollector({ dataDir: mkdtempSync(join(tmpdir(), "sv-px-")), log: () => {}, readGames: async (_now, health) => {
    Object.assign(health, snapshot.health);
    return games;
  } });
  await collector.collectOnce(new Date(snapshot.at));
  const h = collector.health() as { listed: Record<string, number>; venueNotes: string[]; venuesNotAnswering: string[] };
  assert.deepEqual(h.listed, { kalshi: 1, polymarket_us: 0, novig: 0, prophetx: 1, cryptocom: 0 });
  assert.deepEqual(h.venueNotes, ["prophetx: 1 game left off: the venue's fee for them was not understood"]);
  assert.deepEqual(h.venuesNotAnswering, []);
  collector.stop();
});
