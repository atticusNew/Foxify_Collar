/**
 * SPORTS VENUES, CRYPTO.COM: a game found among the league's events by both clubs' names and the
 * ET date, its two full-game winner contracts picked out of everything listed on it, each
 * club's own book read as its bid and ask, the exchange's fixed fee per contract carried through
 * the all-in prices, the window tally and the page, and what is kept between cycles so a cycle
 * costs two book reads a game.
 *
 * The event, contract and book shapes and the figures are the venue's own, read on 11 November 2026.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allIn, buyFeeCents, readGame, sellFeeCents, windowTally } from "../src/sportsVenues/analytics";
import { SportsCollector, sportsCollectorFromEnv } from "../src/sportsVenues/collector";
import {
  CRYPTOCOM_EVENTS_TTL_MS,
  CRYPTOCOM_RETRY_MS,
  cryptocomBestLevel,
  cryptocomEventIs,
  cryptocomFeeFromEnv,
  cryptocomListingFrom,
  cryptocomWinnerPair,
  newCryptocomCache,
  readCryptocomListings,
  type CryptocomBook,
  type CryptocomEvent,
  type CryptocomInstrument,
} from "../src/sportsVenues/cryptocom";
import { assembleGames } from "../src/sportsVenues/readers";
import { buildReport } from "../src/sportsVenues/report";
import { renderReportHtml } from "../src/sportsVenues/reportHtml";
import { toHistoryCell, toHistoryPoint } from "../src/sportsVenues/store";
import type { Game, Snapshot, VenueListing } from "../src/sportsVenues/types";

const FLAT = { theta: 0, flatCents: 2 };
const HOST = "https://cdc.test";
const NOW = Date.parse("2026-11-11T16:00:00Z");

/** Tampa Bay at Buffalo, 7pm ET on 11 November: 00:00 UTC on the 12th. */
const EVENT: CryptocomEvent = {
  symbol: "NHL-00002-261111-M",
  event_details: {
    metaData: {
      NAME: "Tampa Bay Lightning @ Buffalo Sabres",
      LEAGUE: "NHL",
      FEED_TYPE: "SINGLES",
      EVENT_DATE: "2026-11-12T00:00:00+00:00",
      AWAY_PARTICIPANT: "Tampa Bay Lightning",
      HOME_PARTICIPANT: "Buffalo Sabres",
      PREDICT_EVENT_TYPE: "Game",
    },
  },
};
const GAME: Game = {
  key: "nhl:TB:BUF:2026-11-11",
  league: "nhl",
  awayCode: "TB",
  homeCode: "BUF",
  awayName: "Tampa Bay Lightning",
  homeName: "Buffalo Sabres",
  startsAt: "2026-11-11T17:00:00.000Z",
  startSource: "date_only",
  listings: [],
};
const SABRES = "NX.F.OPT.NHL-00002-261111-M.O.1.2.20270731";
const LIGHTNING = "NX.F.OPT.NHL-00002-261111-M.O.1.1.20270731";
const contract = (symbol: string, type: string, period: string, participant: string, market = "m1"): CryptocomInstrument => ({
  symbol,
  inst_type: "BINARY_OPTION",
  event_details: { metaData: { PREDICT_CONTRACT_TYPE: type, PREDICT_PERIOD_TYPE: period, PARTICIPANT: participant, PREDICT_MARKET_ID: market } },
});
/** The game's contracts as listed, newest first: props and period lines, the winner pair last. */
const INSTRUMENTS: CryptocomInstrument[] = [
  contract("NX.F.OPT.NHL-00002-261111-M.O.1.307.20270731", "Total Assists", "Full-Game", "Rasmus Dahlin", "m9"),
  contract("NX.F.OPT.NHL-00002-261111-M.O.1.40.20270731", "Moneyline (3-Way)", "1st Period", "Buffalo Sabres", "m4"),
  contract("NX.F.OPT.NHL-00002-261111-M.O.1.12.20270731", "Puck Line", "Full-Game", "Buffalo Sabres", "m2"),
  contract(SABRES, "Moneyline", "Full-Game", "Buffalo Sabres"),
  contract(LIGHTNING, "Moneyline", "Full-Game", "Tampa Bay Lightning"),
];
const BOOKS: Record<string, CryptocomBook> = {
  [SABRES]: { bids: [["0.44", "99539.96"], ["0.43", "588.00"]], asks: [["0.45", "23976.17"], ["0.46", "29114.91"]] },
  [LIGHTNING]: { bids: [["0.54", "91337.00"]], asks: [["0.55", "26607.68"]] },
};

function fakeVenue(over: { events?: Record<string, CryptocomEvent[] | number>; instruments?: Record<string, CryptocomInstrument[] | number>; books?: Record<string, CryptocomBook | number> } = {}) {
  const asked: string[] = [];
  const events: Record<string, CryptocomEvent[] | number> = { NHL2026: [EVENT], NHL2027: [], ...(over.events ?? {}) };
  const instruments: Record<string, CryptocomInstrument[] | number> = { [EVENT.symbol]: INSTRUMENTS, ...(over.instruments ?? {}) };
  const books: Record<string, CryptocomBook | number> = { ...BOOKS, ...(over.books ?? {}) };
  const answer = (rows: unknown): Response => {
    if (typeof rows === "number") return new Response(JSON.stringify({ code: 50000, message: "down" }), { status: rows });
    if (rows === undefined) return new Response(JSON.stringify({ code: 40004, message: "Invalid argument" }), { status: 400 });
    return new Response(JSON.stringify({ id: -1, code: 0, result: { data: rows } }), { status: 200 });
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    const q = url.searchParams;
    if (url.pathname.endsWith("/get-events")) return answer(events[q.get("series_symbol") ?? ""]);
    if (url.pathname.endsWith("/get-instruments")) return answer(instruments[q.get("event_symbol") ?? ""]);
    if (url.pathname.endsWith("/get-book")) {
      const b = books[q.get("instrument_name") ?? ""];
      return answer(typeof b === "number" || b === undefined ? b : [b]);
    }
    return answer(404);
  }) as typeof fetch;
  return { asked, fetchImpl };
}

test("the game: a single game of the league, the same two clubs by full name in either order, on the game's ET date", () => {
  assert.equal(cryptocomEventIs(EVENT, GAME, "NHL"), true);
  // 00:00 UTC is the evening before in ET: the same clubs a day later are another game
  assert.equal(cryptocomEventIs(EVENT, { ...GAME, key: "nhl:TB:BUF:2026-11-12" }, "NHL"), false);
  // the venue's home and away the other way round is still the game
  const swapped: CryptocomEvent = { symbol: "x", event_details: { metaData: { ...EVENT.event_details!.metaData, AWAY_PARTICIPANT: "Buffalo Sabres", HOME_PARTICIPANT: "Tampa Bay Lightning" } } };
  assert.equal(cryptocomEventIs(swapped, GAME, "NHL"), true);
  // a season award, another league, another club, a combo feed
  const withMeta = (m: Record<string, string>): CryptocomEvent => ({ symbol: "x", event_details: { metaData: { ...EVENT.event_details!.metaData, ...m } } });
  assert.equal(cryptocomEventIs(withMeta({ PREDICT_EVENT_TYPE: "Future" }), GAME, "NHL"), false);
  assert.equal(cryptocomEventIs(withMeta({ LEAGUE: "AHL" }), GAME, "NHL"), false);
  assert.equal(cryptocomEventIs(withMeta({ HOME_PARTICIPANT: "Boston Bruins" }), GAME, "NHL"), false);
  assert.equal(cryptocomEventIs(withMeta({ FEED_TYPE: "COMBOS" }), GAME, "NHL"), false);
  assert.equal(cryptocomEventIs(withMeta({ EVENT_DATE: "soon" }), GAME, "NHL"), false);
  assert.equal(cryptocomEventIs({ symbol: "x" }, GAME, "NHL"), false);
});

test("the winner pair: the two full-game two-way moneylines of one market, one per club; period lines, puck lines and props are passed over", () => {
  assert.deepEqual(cryptocomWinnerPair(INSTRUMENTS, GAME), { away: LIGHTNING, home: SABRES });
  // only one listed so far, a third, the same club twice, or two markets: not a pair
  assert.equal(cryptocomWinnerPair(INSTRUMENTS.slice(0, 4), GAME), null);
  assert.equal(cryptocomWinnerPair([...INSTRUMENTS, contract("x", "Moneyline", "Full-Game", "Buffalo Sabres")], GAME), null);
  assert.equal(cryptocomWinnerPair([contract(SABRES, "Moneyline", "Full-Game", "Buffalo Sabres"), contract("x", "Moneyline", "Full-Game", "Buffalo Sabres")], GAME), null);
  assert.equal(cryptocomWinnerPair([contract(SABRES, "Moneyline", "Full-Game", "Buffalo Sabres", "m1"), contract(LIGHTNING, "Moneyline", "Full-Game", "Tampa Bay Lightning", "m2")], GAME), null);
  // a combo that happens to carry the same words is not a single contract
  assert.equal(cryptocomWinnerPair([{ ...contract(SABRES, "Moneyline", "Full-Game", "Buffalo Sabres"), inst_type: "EVENT_COMBO" }, contract(LIGHTNING, "Moneyline", "Full-Game", "Tampa Bay Lightning")], GAME), null);
});

test("best level: the highest bid and the lowest ask whatever order the levels come in, sizes at one price added, empty and impossible levels passed over", () => {
  assert.deepEqual(cryptocomBestLevel([["0.43", "588.00"], ["0.44", "99539.96"]], "bid"), { cents: 44, shares: 99539.96 });
  assert.deepEqual(cryptocomBestLevel([["0.46", "29114.91"], ["0.45", "23976.17"], ["0.45", "10.5"]], "ask"), { cents: 45, shares: 23986.67 });
  assert.deepEqual(cryptocomBestLevel([["0.45", "0"], ["1.00", "5"], ["0", "5"], ["x", "5"], ["0.47", "2.119"]], "ask"), { cents: 47, shares: 2.11 });
  assert.equal(cryptocomBestLevel([], "bid"), null);
  assert.equal(cryptocomBestLevel(undefined, "ask"), null);
});

test("listing: each club's own book is its bid and ask, home and away follow the game, and the fee is the exchange's fixed cents per contract", () => {
  const l = cryptocomListingFrom(EVENT, { away: BOOKS[LIGHTNING], home: BOOKS[SABRES] }, FLAT, GAME);
  assert.equal(l.venue, "cryptocom");
  assert.equal(l.id, "NHL-00002-261111-M");
  assert.deepEqual(l.away, { bidCents: 54, askCents: 55, bidQty: 91337, askQty: 26607.68 });
  assert.deepEqual(l.home, { bidCents: 44, askCents: 45, bidQty: 99539.96, askQty: 23976.17 });
  assert.equal(l.feeTheta, 0);
  assert.equal(l.feeFlatCents, 2);
  assert.equal(l.awayName, "Tampa Bay Lightning");
  assert.equal(l.startsAt, "2026-11-12T00:00:00.000Z");
  // an empty book is a listing with no quote, not a missing game
  const empty = cryptocomListingFrom(EVENT, { away: {}, home: { bids: [["0.44", "5"]] } }, FLAT, GAME);
  assert.deepEqual(empty.away, { bidCents: 0, askCents: 0, bidQty: 0, askQty: 0 });
  assert.equal(empty.home.askCents, 0);
  // the weighted schedule rides in the coefficient and carries no fixed fee
  const weighted = cryptocomListingFrom(EVENT, { away: BOOKS[LIGHTNING], home: BOOKS[SABRES] }, { theta: 0.07, flatCents: 0 }, GAME);
  assert.equal(weighted.feeTheta, 0.07);
  assert.equal(weighted.feeFlatCents, undefined);
});

test("fee setting: the flat fee unless the weighted schedule is asked for; anything else is refused", () => {
  assert.deepEqual(cryptocomFeeFromEnv({}), { theta: 0, flatCents: 2 });
  assert.deepEqual(cryptocomFeeFromEnv({ SPORTS_VENUES_CRYPTOCOM_FEE: " Flat " }), { theta: 0, flatCents: 2 });
  assert.deepEqual(cryptocomFeeFromEnv({ SPORTS_VENUES_CRYPTOCOM_FEE: "weighted" }), { theta: 0.07, flatCents: 0 });
  assert.throws(() => cryptocomFeeFromEnv({ SPORTS_VENUES_CRYPTOCOM_FEE: "2" }), /must be "flat" or "weighted"/);
  assert.throws(() => sportsCollectorFromEnv({ SPORTS_VENUES_DATA_DIR: mkdtempSync(join(tmpdir(), "sv-cdc-")), SPORTS_VENUES_CRYPTOCOM_FEE: "free" }), /must be "flat" or "weighted"/);
});

test("all-in: the fixed fee is added to a buy and taken off a sale whatever the price, and the stored cell carries it", () => {
  assert.equal(buyFeeCents({ theta: 0, flat: 2 }, 45), 2);
  assert.equal(sellFeeCents({ theta: 0, flat: 2 }, 5), 2);
  const l = cryptocomListingFrom(EVENT, { away: BOOKS[LIGHTNING], home: BOOKS[SABRES] }, FLAT, GAME);
  const home = allIn(l, "home");
  assert.equal(home.allInAsk, 47);
  assert.equal(home.allInBid, 42);
  assert.equal(home.feeFlatCents, 2);
  // the cell: a 0 holds the winnings slot so the fixed fee is always the eleventh
  assert.deepEqual(toHistoryCell(l), [54, 55, 44, 45, 0, 91337, 26607.68, 99539.96, 23976.17, 0, 2]);
  // cells written before this venue are unchanged
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: { bidCents: 54, askCents: 55, bidQty: 1, askQty: 1 }, home: { bidCents: 44, askCents: 46, bidQty: 1, askQty: 1 }, feeTheta: 0.07, awayName: "TB", homeName: "BUF" };
  assert.equal(toHistoryCell(kalshi).length, 9);
  assert.equal(toHistoryCell({ ...kalshi, venue: "prophetx", feeTheta: 0, feeGain: 0.02 }).length, 10);
});

test("the board: Crypto.com sits beside Kalshi, the other side is costed with its fixed fee, and the window tally charges the fee stored with the snapshot", () => {
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: { bidCents: 54, askCents: 56, bidQty: 500, askQty: 500 }, home: { bidCents: 44, askCents: 46, bidQty: 500, askQty: 500 }, feeTheta: 0.07, awayName: "TB", homeName: "BUF" };
  const cdc = cryptocomListingFrom(EVENT, { away: BOOKS[LIGHTNING], home: BOOKS[SABRES] }, FLAT, GAME);
  const games = assembleGames([{ game: { ...GAME, listings: [kalshi] }, tickers: { away: "a", home: "h" } }], new Map(), new Map(), new Map(), new Map([[GAME.key, cdc]]));
  assert.deepEqual(games[0].listings.map((l) => l.venue), ["kalshi", "cryptocom"]);
  // the venue's start replaces the date-only one
  assert.equal(games[0].startsAt, "2026-11-12T00:00:00.000Z");
  const read = readGame(games[0], NOW);
  // holder of the away side buys home: Kalshi 46 + 0.07 x 0.46 x 0.54 x 100 = 47.74, Crypto.com 45 + 2 = 47
  assert.equal(read.sides.away.hedge.costs.kalshi, 47.74);
  assert.equal(read.sides.away.hedge.costs.cryptocom, 47);
  assert.equal(read.sides.away.hedge.cheapest, "cryptocom");
  assert.equal(read.sides.away.hedge.savingCents, 0.74);
  // both sides on Crypto.com: 55 + 45 + 2 + 2 = 104, 4 over
  assert.equal(read.overround.cryptocom, 4);
  // Kalshi away 57.72 + Crypto.com home 47 is over 100: no cross
  assert.equal(read.crosses.length, 0);
  const snapshot: Snapshot = { at: new Date(NOW).toISOString(), games, health: {} };
  const tally = windowTally([toHistoryPoint(snapshot)]);
  assert.equal(tally.readings, 2);
  // away other side: Kalshi 57.72 against Crypto.com 57; home other side: 47.74 against 47
  assert.equal(tally.cheapest.cryptocom, 2);
  assert.equal(tally.meanSavingRoutedCents, 0.73);
  // the same books at no fixed fee would not be the same tally: the stored fee is what is charged
  const noFee = toHistoryPoint(snapshot);
  noFee.games[GAME.key].cryptocom = noFee.games[GAME.key].cryptocom!.slice(0, 9) as never;
  assert.equal(windowTally([noFee]).meanSavingRoutedCents, 2.73);
});

test("the read: the league's series for last year, this year and next, the game's contracts once, then two book reads a cycle", async () => {
  const venue = fakeVenue();
  const cache = newCryptocomCache();
  const notes: string[] = [];
  const other: Game = { ...GAME, key: "nhl:NYR:CGY:2026-11-11", awayCode: "NYR", homeCode: "CGY", awayName: "New York Rangers", homeName: "Calgary Flames" };
  const football: Game = { ...GAME, key: "mlb:NYY:BOS:2026-11-11", league: "mlb" };
  const out = await readCryptocomListings([GAME, other, football], { fetchImpl: venue.fetchImpl, host: HOST, notes, nowMs: NOW, cache, fee: FLAT });
  assert.deepEqual([...out.keys()], [GAME.key]);
  assert.deepEqual(notes, []);
  assert.deepEqual(out.get(GAME.key)!.home, { bidCents: 44, askCents: 45, bidQty: 99539.96, askQty: 23976.17 });
  assert.deepEqual(
    venue.asked.filter((a) => a.includes("/get-events")).sort(),
    ["/get-events?series_symbol=NHL2025&limit=1000", "/get-events?series_symbol=NHL2026&limit=1000", "/get-events?series_symbol=NHL2027&limit=1000"],
  );
  assert.deepEqual(venue.asked.filter((a) => a.includes("/get-instruments")), [`/get-instruments?event_symbol=${EVENT.symbol}&limit=1000`]);
  assert.equal(venue.asked.filter((a) => a.includes("/get-book") && a.endsWith("&depth=1")).length, 2);

  // a minute later: the events and the contracts are remembered, the series that does not exist is not asked again
  venue.asked.length = 0;
  const again = await readCryptocomListings([GAME], { fetchImpl: venue.fetchImpl, host: HOST, nowMs: NOW + 60_000, cache, fee: FLAT });
  assert.equal(again.size, 1);
  assert.deepEqual(venue.asked.map((a) => a.split("?")[0]), ["/get-book", "/get-book"]);
  // past the list's life the series that answered are read again, and the missing one after its own wait
  venue.asked.length = 0;
  await readCryptocomListings([GAME], { fetchImpl: venue.fetchImpl, host: HOST, nowMs: NOW + 60_000 + CRYPTOCOM_EVENTS_TTL_MS, cache, fee: FLAT });
  assert.deepEqual(venue.asked.filter((a) => a.includes("/get-events")).map((a) => a.match(/NHL\d+/)![0]).sort(), ["NHL2026", "NHL2027"]);
  venue.asked.length = 0;
  await readCryptocomListings([GAME], { fetchImpl: venue.fetchImpl, host: HOST, nowMs: NOW + CRYPTOCOM_RETRY_MS, cache, fee: FLAT });
  assert.ok(venue.asked.some((a) => a.includes("NHL2025")));
  assert.ok(!venue.asked.some((a) => a.includes("/get-instruments")));
});

test("the read: a long list is paged by the venue's cursor", async () => {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    const q = url.searchParams;
    const ok = (data: unknown, next?: string) => new Response(JSON.stringify({ code: 0, result: { data, next_cursor: next ?? null } }), { status: 200 });
    if (url.pathname.endsWith("/get-events")) return q.get("series_symbol") === "NHL2026" ? ok([EVENT]) : new Response("{}", { status: 400 });
    if (url.pathname.endsWith("/get-instruments")) return q.get("cursor") === "p 2" ? ok(INSTRUMENTS.slice(3)) : ok(INSTRUMENTS.slice(0, 3), "p 2");
    return ok([BOOKS[q.get("instrument_name") ?? ""]]);
  }) as typeof fetch;
  const out = await readCryptocomListings([GAME], { fetchImpl, host: HOST, nowMs: NOW, fee: FLAT });
  assert.equal(out.size, 1);
  assert.deepEqual(asked.filter((a) => a.includes("/get-instruments")), [`/get-instruments?event_symbol=${EVENT.symbol}&limit=1000`, `/get-instruments?event_symbol=${EVENT.symbol}&limit=1000&cursor=p%202`]);
});

test("the read: what is left off and why; a venue that answers nothing reads as down", async () => {
  // two events for one game: neither is taken
  const twice = fakeVenue({ events: { NHL2026: [EVENT, { ...EVENT, symbol: "NHL-00099-261111-M" }] } });
  const twiceNotes: string[] = [];
  assert.equal((await readCryptocomListings([GAME], { fetchImpl: twice.fetchImpl, host: HOST, notes: twiceNotes, nowMs: NOW, fee: FLAT })).size, 0);
  assert.match(twiceNotes[0], /2 events match/);
  assert.ok(!twice.asked.some((a) => a.includes("/get-instruments") || a.includes("/get-book")));

  // listed, but its winner pair is not up yet: said, and not asked for again until the wait is over
  const early = fakeVenue({ instruments: { [EVENT.symbol]: INSTRUMENTS.slice(0, 3) } });
  const cache = newCryptocomCache();
  const earlyNotes: string[] = [];
  assert.equal((await readCryptocomListings([GAME], { fetchImpl: early.fetchImpl, host: HOST, notes: earlyNotes, nowMs: NOW, cache, fee: FLAT })).size, 0);
  assert.match(earlyNotes[0], /1 game listed without a two-way winner pair; left off/);
  early.asked.length = 0;
  await readCryptocomListings([GAME], { fetchImpl: early.fetchImpl, host: HOST, nowMs: NOW + 60_000, cache, fee: FLAT });
  assert.ok(!early.asked.some((a) => a.includes("/get-instruments")));
  await readCryptocomListings([GAME], { fetchImpl: early.fetchImpl, host: HOST, nowMs: NOW + CRYPTOCOM_RETRY_MS, cache, fee: FLAT });
  assert.ok(early.asked.some((a) => a.includes("/get-instruments")));

  // one game's book fails while another's is read: that game is left off with a note
  const second: CryptocomEvent = { symbol: "NHL-00001-261111-M", event_details: { metaData: { ...EVENT.event_details!.metaData, AWAY_PARTICIPANT: "New York Rangers", HOME_PARTICIPANT: "Calgary Flames" } } };
  const rangers: Game = { ...GAME, key: "nhl:NYR:CGY:2026-11-11", awayCode: "NYR", homeCode: "CGY", awayName: "New York Rangers", homeName: "Calgary Flames" };
  const part = fakeVenue({
    events: { NHL2026: [EVENT, second] },
    instruments: { [second.symbol]: [contract("R", "Moneyline", "Full-Game", "New York Rangers"), contract("F", "Moneyline", "Full-Game", "Calgary Flames")] },
    books: { R: 500, F: { bids: [["0.5", "1"]] } },
  });
  const partNotes: string[] = [];
  const got = await readCryptocomListings([GAME, rangers], { fetchImpl: part.fetchImpl, host: HOST, notes: partNotes, nowMs: NOW, fee: FLAT });
  assert.deepEqual([...got.keys()], [GAME.key]);
  assert.match(partNotes.join(" "), /1 game left off this cycle: the book was not read/);

  // every book fails, or the events cannot be read at all: the venue is down, not an empty column
  const noBooks = fakeVenue({ books: { [SABRES]: 503, [LIGHTNING]: 503 } });
  await assert.rejects(readCryptocomListings([GAME], { fetchImpl: noBooks.fetchImpl, host: HOST, nowMs: NOW, fee: FLAT }), /no book could be read/);
  const down = fakeVenue({ events: { NHL2026: 503, NHL2027: 503 } });
  await assert.rejects(readCryptocomListings([GAME], { fetchImpl: down.fetchImpl, host: HOST, nowMs: NOW, fee: FLAT }), /HTTP 503/);
  // a list that fails once it has been read is carried for the cycle: the books are still fresh
  const flaky = fakeVenue();
  const held = newCryptocomCache();
  await readCryptocomListings([GAME], { fetchImpl: flaky.fetchImpl, host: HOST, nowMs: NOW, cache: held, fee: FLAT });
  const later = fakeVenue({ events: { NHL2026: 503, NHL2027: 503 } });
  assert.equal((await readCryptocomListings([GAME], { fetchImpl: later.fetchImpl, host: HOST, nowMs: NOW + CRYPTOCOM_EVENTS_TTL_MS + 1, cache: held, fee: FLAT })).size, 1);
  // a contract the venue no longer knows is looked up again the next cycle
  const gone = fakeVenue();
  const goneCache = newCryptocomCache();
  goneCache.pairs.set(EVENT.symbol, { away: LIGHTNING, home: "NX.RETIRED" });
  goneCache.events.set("NHL2026", { atMs: NOW, rows: [EVENT] });
  await assert.rejects(readCryptocomListings([GAME], { fetchImpl: gone.fetchImpl, host: HOST, nowMs: NOW, cache: goneCache, fee: FLAT }), /no book could be read/);
  assert.equal(goneCache.pairs.has(EVENT.symbol), false);
  assert.equal((await readCryptocomListings([GAME], { fetchImpl: gone.fetchImpl, host: HOST, nowMs: NOW + 1, cache: goneCache, fee: FLAT })).size, 1);
});

test("page and health: a Crypto.com column on the board, its fee in its own words, and /healthz counting the games each venue is on", async () => {
  const kalshi: VenueListing = { venue: "kalshi", id: "k", away: { bidCents: 54, askCents: 56, bidQty: 500, askQty: 500 }, home: { bidCents: 44, askCents: 46, bidQty: 500, askQty: 500 }, feeTheta: 0.07, awayName: "TB", homeName: "BUF" };
  const cdc = cryptocomListingFrom(EVENT, { away: BOOKS[LIGHTNING], home: BOOKS[SABRES] }, FLAT, GAME);
  const games: Game[] = [{ ...GAME, startsAt: cdc.startsAt!, startSource: "venue", listings: [kalshi, cdc] }];
  const snapshot: Snapshot = { at: new Date(NOW).toISOString(), games, health: { kalshi: { ok: true, ms: 200 }, cryptocom: { ok: true, ms: 900, detail: "1 game listed without a two-way winner pair; left off" } } };
  const html = renderReportHtml(buildReport({ snapshot, history: [toHistoryPoint(snapshot)], intervalSec: 60, collectingSince: snapshot.at }), { refreshSec: 60 });
  for (const needle of [
    "<title>Sports on the event venues: Kalshi, Polymarket US, Novig, ProphetX, Crypto.com</title>",
    "on Kalshi, Polymarket US, Novig, ProphetX and Crypto.com, side by side",
    "<th>Crypto.com<br><small>bid / ask · depth</small></th>",
    "<th>Crypto.com<br><small>− consensus</small></th>",
    'colspan="13"',
    "<b>44</b> / <b>45</b>",
    "fee 2¢ a contract",
    "Crypto.com</b> 47.00¢ all in",
    "saves 0.74¢",
    "0 on all five",
    "Crypto.com public market-data API of its US exchange",
    "cryptocom 900ms (1 game listed without a two-way winner pair; left off)",
  ]) {
    assert.ok(html.includes(needle), `page lacks: ${needle}`);
  }
  assert.ok(!/—/.test(html), "no em dash in the page");

  const collector = new SportsCollector({ dataDir: mkdtempSync(join(tmpdir(), "sv-cdc-")), log: () => {}, readGames: async (_now, health) => {
    Object.assign(health, snapshot.health);
    return games;
  } });
  await collector.collectOnce(new Date(snapshot.at));
  const h = collector.health() as { listed: Record<string, number>; venueNotes: string[] };
  assert.deepEqual(h.listed, { kalshi: 1, polymarket_us: 0, novig: 0, prophetx: 0, cryptocom: 1 });
  assert.deepEqual(h.venueNotes, ["cryptocom: 1 game listed without a two-way winner pair; left off"]);
  collector.stop();
});
