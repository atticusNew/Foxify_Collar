/**
 * The on-chain venues page: the book shapes, the fees, which market of a game is read, how a
 * Limitless market is tied to a game, the board's arithmetic, and the page's key.
 *
 * Nothing here reaches the network: the partner's catalog and stream are stood in for.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AggregatorApiError, streamKey, type LimitlessMarket, type Market, type MarketStream, type SportEvent, type StreamResult } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import { buildBoard } from "../src/onchainVenues/board";
import { restingUsd, shareBook, sxOutcomeBook, walk } from "../src/onchainVenues/books";
import { allInAskCents, allInBidCents } from "../src/onchainVenues/fees";
import { OnchainFeed, eventShape, isLimitlessSports, joinWinner, pairOutcomes, limitlessGame, parseLimitlessTitle, sameTeam, teamsOf, winnerMarket, type FeedSource } from "../src/onchainVenues/feed";
import { groupToMarkets, readLimitlessPublicGames } from "../src/onchainVenues/limitlessPublic";
import { renderOnchainHtml } from "../src/onchainVenues/html";
import { OnchainVenuesService, PAGE_KEY_MIN, keyMatches } from "../src/onchainVenues/service";
import type { Snapshot } from "../src/onchainVenues/types";

const near = (a: number | null | undefined, b: number, eps = 1e-9): void => assert.ok(typeof a === "number" && Math.abs(a - b) < eps, `${a} is not ${b}`);

// ── books ─────────────────────────────────────────────────────────────────────

test("onchain books: a share book is kept as it is, best first, and a level that cannot be a price or a size is dropped", () => {
  const b = shareBook({ bids: [{ price: 0.41, size: 10 }, { price: 0.43, size: 820 }, { price: 0, size: 5 }], asks: [{ price: 0.505, size: 2000 }, { price: 0.493, size: 10 }, { price: 1, size: 9 }, { price: 0.6, size: 0 }], serverTimestamp: 1_000_500, venueTimestamp: 1_000_000 });
  assert.deepEqual(b.bids, [{ price: 0.43, size: 820 }, { price: 0.41, size: 10 }]);
  assert.deepEqual(b.asks, [{ price: 0.493, size: 10 }, { price: 0.505, size: 2000 }]);
  assert.equal(b.ageMs, 500);
  assert.equal(shareBook({ bids: [], asks: [], serverTimestamp: 5, venueTimestamp: 0 }).ageMs, null, "a venue stamp of 0 means the venue gave no time");
});

test("onchain books: an SX Bet offer backing one outcome is a bid on it and an ask on the other, in $1 shares", () => {
  // A maker backs outcome one at an implied 0.60 with 60 USDC. SX's own taker capacity for that
  // offer is stake × (1 − p) / p = 40 USDC, at a taker price of 0.40, and the pot is 100.
  const raw = { bids: [{ price: 0.6, size: 60 }], asks: [{ price: 0.35, size: 70 }] };
  const makerStake = 60;
  const takerCapacity = (makerStake * (1 - 0.6)) / 0.6;
  near(takerCapacity, 40);

  const two = sxOutcomeBook(raw, "OUTCOME_TWO");
  near(two.asks[0].price, 0.4);
  near(two.asks[0].size, 100);
  near(two.asks[0].price * two.asks[0].size, takerCapacity, 1e-9);
  // the maker backing outcome two at 0.35 with 70 USDC is a bid on outcome two: 200 shares at 0.35
  near(two.bids[0].price, 0.35);
  near(two.bids[0].size, 200);

  const one = sxOutcomeBook(raw, "OUTCOME_ONE");
  near(one.bids[0].price, 0.6);
  near(one.bids[0].size, 100);
  near(one.asks[0].price, 0.65);
  near(one.asks[0].size, 200);
  // one book seen from both sides: a bid on one outcome and the ask it makes on the other add to 1
  near(one.bids[0].price + two.asks[0].price, 1);
  near(one.asks[0].price + two.bids[0].price, 1);
});

test("onchain books: walking a side and the dollars resting near the best price", () => {
  const bids = [{ price: 0.5, size: 400 }, { price: 0.49, size: 400 }, { price: 0.4, size: 1000 }];
  const w = walk(bids, 1000);
  assert.equal(w.filled, 1000);
  near(w.avgPrice, (400 * 0.5 + 400 * 0.49 + 200 * 0.4) / 1000);
  assert.equal(w.worstPrice, 0.4);
  assert.equal(walk(bids, 5000).filled, 1800, "no more than the book holds");
  assert.equal(walk([], 10).avgPrice, null);
  near(restingUsd(bids, 2), 400 * 0.5 + 400 * 0.49);
  assert.equal(restingUsd([], 2), 0);
});

// ── fees ──────────────────────────────────────────────────────────────────────

test("onchain fees: the curve fee on the two share venues, the fee on winnings on SX Bet counted as if the bet wins", () => {
  near(allInAskCents("polymarket", 0.5), 51.25);
  near(allInBidCents("polymarket", 0.5), 48.75);
  near(allInAskCents("limitless", 0.2), 20 + 0.05 * 0.2 * 0.8 * 100);
  // SX Bet: buying at 40 risks 40 to win 60, and 1% of that 60 is 0.6
  near(allInAskCents("sx_bet", 0.4), 40.6);
  // leaving at 60 is a bet on the other outcome at 40, whose profit is 60
  near(allInBidCents("sx_bet", 0.6), 59.4);
});

// ── which market of a game ────────────────────────────────────────────────────

const pm = (tokenId: string) => ({ venue: "POLYMARKET" as const, tokenId, executable: true });
const sx = (marketHash: string, outcome: "OUTCOME_ONE" | "OUTCOME_TWO", executable = true) => ({ venue: "SX_BET" as const, marketHash, outcome, executable });
const kalshi = (ticker: string) => ({ venue: "KALSHI" as const, ticker, side: "YES" as const, bookSide: "BID" as const, executable: true });

test("onchain winner market: the full-game moneyline, never a period, a spread or a prop; the feed's type first, the title when it has none", () => {
  const moneyline: Market = { id: "m1", title: "Moneyline", type: "MONEYLINE", period: null, main: true, outcomes: [{ name: "Royals", side: "AWAY", listings: [pm("1")] }, { name: "Tigers", side: "HOME", listings: [pm("2")] }] };
  const firstHalf: Market = { ...moneyline, id: "m2", period: { unit: "HALF", from: 1, to: 1 } };
  const spread: Market = { ...moneyline, id: "m3", type: "SPREAD", line: "-1.5" };
  const prop: Market = { id: "m4", title: "Anytime scorer", type: "PLAYER_PROP", outcomes: [{ name: "Yes", listings: [] }, { name: "No", listings: [] }] };
  assert.equal(winnerMarket([prop, spread, firstHalf, moneyline])?.id, "m1");
  assert.equal(winnerMarket([prop, spread, firstHalf]), null);

  const three: Market = { id: "m5", title: "Match result", type: "MONEYLINE", outcomes: [{ name: "Belgium", side: "HOME", listings: [] }, { name: "Draw", side: "DRAW", listings: [] }, { name: "Italy", side: "AWAY", listings: [] }] };
  assert.equal(winnerMarket([three])?.id, "m5", "a three-way result is a winner market");
  assert.equal(winnerMarket([{ ...three, outcomes: [...three.outcomes, { name: "Other", listings: [] }] }]), null);

  const untyped: Market = { id: "m6", title: "Royals vs Tigers Moneyline", outcomes: moneyline.outcomes };
  assert.equal(winnerMarket([untyped])?.id, "m6");
  assert.equal(winnerMarket([{ ...untyped, title: "1H Moneyline" }]), null);

  // two that qualify: the one on more of these venues
  const onTwo: Market = { ...moneyline, id: "m7", main: false, outcomes: [{ name: "Royals", listings: [pm("1"), sx("0xAB", "OUTCOME_ONE")] }, { name: "Tigers", listings: [pm("2"), sx("0xAB", "OUTCOME_TWO")] }] };
  assert.equal(winnerMarket([moneyline, onTwo])?.id, "m7");
});

// ── Limitless, tied by its words ──────────────────────────────────────────────

test("onchain Limitless: the title shapes its own list showed, and nothing else", () => {
  assert.deepEqual(parseLimitlessTitle("UEFA NL, Belgium vs Italy: Belgium"), { teams: ["Belgium", "Italy"], pick: "Belgium" });
  assert.deepEqual(parseLimitlessTitle("UEFA NL, Belgium vs Italy: Draw"), { teams: ["Belgium", "Italy"], pick: "Draw" });
  assert.deepEqual(parseLimitlessTitle("FA CUP, Swindon Supermarine vs Winslow United: Swindon Supermarine")?.pick, "Swindon Supermarine");
  assert.equal(parseLimitlessTitle("UEFA NL, Belgium vs Italy: Over 2.5"), null, "a pick that is neither side nor the draw");
  assert.equal(parseLimitlessTitle("Will BTC close above $100k?"), null);
  assert.equal(parseLimitlessTitle("Belgium vs Italy"), null, "no pick: which side Yes pays on is not said");
  assert.deepEqual(limitlessGame("LoL, T1 vs Gen.G"), ["T1", "Gen.G"]);
  assert.equal(limitlessGame("UEFA NL, Belgium vs Italy: Belgium"), null);

  assert.deepEqual(teamsOf("Royals @ Tigers"), ["Royals", "Tigers"]);
  assert.deepEqual(teamsOf("Arsenal FC v Chelsea FC"), ["Arsenal FC", "Chelsea FC"]);
  assert.equal(teamsOf("NBA Champion 2027"), null);

  assert.ok(sameTeam("Detroit Tigers", "Tigers"));
  assert.ok(sameTeam("Arsenal FC", "Arsenal"));
  assert.ok(sameTeam("Atlético Madrid", "Atletico Madrid"));
  assert.ok(!sameTeam("Manchester United", "Manchester City"));
  assert.ok(!sameTeam("FC", "AFC"), "nothing but filler words is no team");
  assert.ok(!sameTeam("T1", "T1 Academy"), "a two-letter word alone ties nothing");

  assert.ok(isLimitlessSports({ marketSlug: "a", title: "x", categories: ["Sports"], outcomes: [] }));
  assert.ok(isLimitlessSports({ marketSlug: "a", title: "x", categories: ["Football Matches"], outcomes: [] }));
  assert.ok(!isLimitlessSports({ marketSlug: "a", title: "x", categories: ["Crypto"], outcomes: [] }));
});

// ── the feed, end to end over a stand-in ──────────────────────────────────────

const NOW = Date.parse("2026-11-13T12:00:00Z");
const at = (hours: number): string => new Date(NOW + hours * 3_600_000).toISOString();

const EVENTS: Record<string, SportEvent[]> = {
  mlb: [
    { id: "e1", name: "Royals @ Tigers", competitionId: "mlb", startTime: at(6), status: "SCHEDULED" },
    { id: "e9", name: "Cubs @ Mets", competitionId: "mlb", startTime: at(90), status: "SCHEDULED" },
  ],
  unl: [{ id: "e2", name: "Belgium vs Italy", competitionId: "unl", startTime: at(8), status: "SCHEDULED" }],
  quiet: [],
};
const MARKETS: Record<string, Market[]> = {
  e1: [
    { id: "m1", title: "Moneyline", type: "MONEYLINE", period: null, outcomes: [{ name: "Royals", side: "AWAY", listings: [pm("R"), sx("0xABCDEF", "OUTCOME_ONE"), kalshi("KXMLB-R")] }, { name: "Tigers", side: "HOME", listings: [pm("T"), sx("0xABCDEF", "OUTCOME_TWO")] }] },
    { id: "m1s", title: "Run line", type: "SPREAD", line: "-1.5", outcomes: [{ name: "Royals", listings: [pm("RS")] }, { name: "Tigers", listings: [pm("TS")] }] },
  ],
  e2: [{ id: "m2", title: "Match result", type: "MONEYLINE", outcomes: [{ name: "Belgium", side: "HOME", listings: [pm("B")] }, { name: "Draw", side: "DRAW", listings: [pm("D")] }, { name: "Italy", side: "AWAY", listings: [pm("I")] }] }],
};
const LIMITLESS: LimitlessMarket[] = [
  { marketSlug: "bel-ita-bel", title: "UEFA NL, Belgium vs Italy: Belgium", categories: ["Sports"], expiresAt: at(8), outcomes: [{ name: "Yes", tokenId: "LB" }, { name: "No", tokenId: "LBn" }] },
  { marketSlug: "bel-ita-draw", title: "UEFA NL, Belgium vs Italy: Draw", categories: ["Sports"], expiresAt: at(8), outcomes: [{ name: "Yes", tokenId: "LD" }, { name: "No", tokenId: "LDn" }] },
  { marketSlug: "bel-ita-ita", title: "UEFA NL, Belgium vs Italy: Italy", categories: ["Sports"], expiresAt: at(8), outcomes: [{ name: "Yes", tokenId: "LI" }, { name: "No", tokenId: "LIn" }] },
  // the same two teams a week later: not this game
  { marketSlug: "bel-ita-later", title: "UEFA NL, Belgium vs Italy: Italy", categories: ["Sports"], expiresAt: at(170), outcomes: [{ name: "Yes", tokenId: "LX" }, { name: "No", tokenId: "LXn" }] },
  { marketSlug: "kc-det", title: "MLB, Royals vs Tigers", categories: ["Sports"], expiresAt: at(6), outcomes: [{ name: "Royals", tokenId: "LR" }, { name: "Tigers", tokenId: "LT" }] },
  { marketSlug: "btc", title: "BTC above $100k on Friday?", categories: ["Crypto"], expiresAt: at(8), outcomes: [{ name: "Yes", tokenId: "c1" }, { name: "No", tokenId: "c2" }] },
];

function standIn(over: Partial<FeedSource> = {}): { source: FeedSource; calls: string[] } {
  const calls: string[] = [];
  const source: FeedSource = {
    whoami: async () => ({ keyId: "k", credentialId: "c", podId: "p", scope: "DATA", capabilities: ["DISCOVERY", "STREAM"] }),
    time: async () => Math.floor(NOW / 1000),
    listSports: async () => [{ id: "baseball", name: "Baseball" }, { id: "soccer", name: "Soccer" }],
    listCompetitions: async () => [{ id: "mlb", name: "MLB", sportId: "baseball" }, { id: "unl", name: "UEFA Nations League", sportId: "soccer" }, { id: "quiet", name: "Off season", sportId: "soccer" }],
    listEvents: async (id) => (calls.push(`events:${id}`), EVENTS[id] ?? []),
    listEventMarkets: async (id) => (calls.push(`markets:${id}`), MARKETS[id] ?? []),
    listLimitlessMarkets: async (token) => (calls.push(`limitless:${token ?? ""}`), token ? { markets: LIMITLESS.slice(3), nextPageToken: null } : { markets: LIMITLESS.slice(0, 3), nextPageToken: "p2" }),
    ...over,
  };
  return { source, calls };
}

const BOOKS: Record<string, { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }> = {
  "POLYMARKET:R": { bids: [{ price: 0.44, size: 500 }], asks: [{ price: 0.46, size: 300 }] },
  "POLYMARKET:T": { bids: [{ price: 0.54, size: 800 }], asks: [{ price: 0.56, size: 900 }] },
  // makers backing the Royals at 0.47 (stake 470) and the Tigers at 0.50 (stake 500)
  "SX_BET:0xabcdef": { bids: [{ price: 0.47, size: 470 }], asks: [{ price: 0.5, size: 500 }] },
  "LIMITLESS:kc-det:LR": { bids: [{ price: 0.4, size: 20 }], asks: [{ price: 0.5, size: 20 }] },
  "LIMITLESS:kc-det:LT": { bids: [], asks: [] },
  "POLYMARKET:B": { bids: [{ price: 0.43, size: 2000 }], asks: [{ price: 0.45, size: 2000 }] },
  "POLYMARKET:D": { bids: [{ price: 0.26, size: 2000 }], asks: [{ price: 0.28, size: 2000 }] },
  "POLYMARKET:I": { bids: [{ price: 0.27, size: 2000 }], asks: [{ price: 0.29, size: 2000 }] },
  "LIMITLESS:bel-ita-bel:LB": { bids: [{ price: 0.43, size: 820 }], asks: [{ price: 0.493, size: 10 }, { price: 0.505, size: 2000 }] },
  "LIMITLESS:bel-ita-ita:LI": { bids: [{ price: 0.2, size: 50 }], asks: [{ price: 0.24, size: 400 }] },
};
function reader(seen: MarketStream[][] = []): (markets: MarketStream[]) => Promise<StreamResult[]> {
  return async (markets) => {
    seen.push(markets);
    return markets.map((market): StreamResult => {
      const b = BOOKS[streamKey(market)];
      return b ? { market, book: { ...b, seq: 1, serverTimestamp: NOW, venueTimestamp: NOW - 2_000 } } : { market, book: null, error: { code: "MARKET_NOT_YET_OPEN", message: "books open two days before the start" } };
    });
  };
}

const feedOf = (source: FeedSource, readBooks = reader(), extra: Partial<ConstructorParameters<typeof OnchainFeed>[0]> = {}): OnchainFeed => new OnchainFeed({ source, readBooks, paceMs: 0, sleep: async () => {}, ...extra });

async function snapshotOf(): Promise<Snapshot> {
  const feed = feedOf(standIn().source);
  await feed.discover(NOW);
  return feed.snapshot(NOW);
}

test("onchain feed: the games inside the window, each one's winner market, the three venues' listings and their books", async () => {
  const { source, calls } = standIn();
  const seen: MarketStream[][] = [];
  const feed = feedOf(source, reader(seen));
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);

  assert.deepEqual(s.games.map((g) => g.name), ["Royals @ Tigers", "Belgium vs Italy"], "soonest first; the game 90 hours out is outside the window");
  assert.ok(!calls.includes("markets:e9"), "the markets of a game outside the window are never asked for");
  assert.deepEqual(calls.filter((c) => c.startsWith("limitless")), ["limitless:", "limitless:p2"], "the Limitless list is read page by page");

  const kc = s.games[0];
  assert.equal(kc.marketTitle, "Moneyline");
  assert.equal(kc.sport, "Baseball");
  const royals = kc.outcomes[0];
  assert.deepEqual(royals.quotes.map((q) => [q.venue, q.matchedBy]), [["polymarket", "feed"], ["sx_bet", "feed"], ["limitless", "names"]], "a Kalshi listing is not this lane's");
  // one SX book, read once, serves both outcomes; the hash goes to the stream in lower case
  const asked = seen.flat().map(streamKey);
  assert.equal(asked.filter((k) => k.startsWith("SX_BET")).length, 1);
  assert.ok(asked.includes("SX_BET:0xabcdef"));
  assert.equal(new Set(asked).size, asked.length, "no market is asked for twice");

  const sxRoyals = royals.quotes[1].book!;
  near(sxRoyals.bids[0].price, 0.47);
  near(sxRoyals.bids[0].size, 1000);
  near(sxRoyals.asks[0].price, 0.5);
  near(sxRoyals.asks[0].size, 1000);
  const sxTigers = kc.outcomes[1].quotes[1].book!;
  near(sxTigers.bids[0].price, 0.5);
  near(sxTigers.asks[0].price, 0.53);

  // Limitless: the group's three children on the three outcomes; the later game and the crypto market are not tied
  const bel = s.games[1];
  assert.deepEqual(bel.outcomes.map((o) => o.quotes.filter((q) => q.venue === "limitless").length), [1, 1, 1]);
  assert.equal(bel.outcomes[1].quotes[1].book, null, "the draw has no Limitless book in this stand-in");
  assert.match(bel.outcomes[1].quotes[1].error ?? "", /MARKET_NOT_YET_OPEN/);
  assert.deepEqual(s.unmatchedLimitless, ["UEFA NL, Belgium vs Italy: Italy"], "same teams, a week later: left off and listed");
  assert.deepEqual(s.feed.limitless, { state: "listed", source: "partner", markets: 6, sports: 5, matched: 5 });
  assert.deepEqual(s.feed.books.byVenue?.polymarket, { asked: 5, read: 5, empty: 0, errors: {} });
  assert.deepEqual(s.feed.books.byVenue?.sx_bet, { asked: 1, read: 1, empty: 0, errors: {} });
  assert.deepEqual(s.feed.books.byVenue?.limitless, { asked: 5, read: 4, empty: 1, errors: { MARKET_NOT_YET_OPEN: 1 } });

  assert.equal(s.feed.books.asked, asked.length);
  assert.equal(s.feed.books.read, 10);
  assert.equal(s.feed.books.empty, 1);
  assert.deepEqual(s.feed.books.errors, { MARKET_NOT_YET_OPEN: 1 });
  assert.deepEqual(s.feed.capabilities, ["DISCOVERY", "STREAM"]);
  assert.deepEqual(s.feed.notes, []);

  const mlb = s.coverage.find((c) => c.competitionId === "mlb")!;
  assert.deepEqual([mlb.events, mlb.withWinner, mlb.on.polymarket, mlb.on.sx_bet, mlb.on.limitless, mlb.onTwo, mlb.onThree], [1, 1, 1, 1, 1, 1, 1]);
  const unl = s.coverage.find((c) => c.competitionId === "unl")!;
  assert.deepEqual([unl.on.polymarket, unl.on.sx_bet, unl.on.limitless, unl.onTwo, unl.onThree], [1, 0, 1, 1, 0]);
});

test("onchain feed: a second pass reuses what it knows; a competition with nothing in the window is left alone for an hour, a game's markets for two", async () => {
  const { source, calls } = standIn();
  const feed = feedOf(source);
  await feed.discover(NOW);
  calls.length = 0;
  await feed.discover(NOW + 10 * 60_000);
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")), [], "an event's markets are kept");
  assert.ok(!calls.includes("events:quiet"));
  assert.ok(calls.includes("events:mlb"));
  calls.length = 0;
  await feed.discover(NOW + 71 * 60_000);
  assert.ok(calls.includes("events:quiet"));
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")), []);
  calls.length = 0;
  await feed.discover(NOW + 121 * 60_000);
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")).sort(), ["markets:e1", "markets:e2"]);
});

test("onchain feed: the cap keeps the soonest games and says how many were left off; books go out in chunks no larger than the stream allows", async () => {
  const seen: MarketStream[][] = [];
  const feed = feedOf(standIn().source, reader(seen), { maxEvents: 1, maxPerConnection: 2 });
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  assert.deepEqual(s.games.map((g) => g.name), ["Royals @ Tigers"]);
  assert.equal(s.feed.eventsInHorizon, 2);
  assert.equal(s.feed.eventsOverCap, 1);
  assert.ok(seen.length >= 2 && seen.every((chunk) => chunk.length <= 2));
});

test("onchain feed: a pass reads a bounded part of the catalog and the next one carries on; a game none of the three lists is remembered longer and kept off the board", async () => {
  const bare: Market[] = [{ id: "mk", title: "Moneyline", type: "MONEYLINE", outcomes: [{ name: "Cubs", listings: [kalshi("KXMLB-C")] }, { name: "Mets", listings: [] }] }];
  const { source, calls } = standIn({
    listEvents: async (id) => (id === "mlb" ? [{ id: "e0", name: "Cubs @ Mets", competitionId: "mlb", startTime: at(2), status: "SCHEDULED" }, ...EVENTS.mlb] : EVENTS[id] ?? []),
  });
  const withBare: FeedSource = { ...source, listEventMarkets: async (id) => (calls.push(`markets:${id}`), id === "e0" ? bare : MARKETS[id] ?? []) };
  const feed = feedOf(withBare, reader(), { maxReadsPerPass: 2 });

  await feed.discover(NOW);
  let s = await feed.snapshot(NOW);
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")), ["markets:e0", "markets:e1"], "soonest first, two a pass");
  assert.deepEqual([s.feed.eventsInHorizon, s.feed.eventsRead, s.feed.eventsPending], [3, 2, 1]);
  assert.deepEqual(s.games.map((g) => g.name), ["Royals @ Tigers"], "the game only Kalshi lists is read and counted, and is not on this board");
  assert.equal(s.coverage.find((c) => c.competitionId === "mlb")?.events, 2);

  calls.length = 0;
  await feed.discover(NOW + 10 * 60_000);
  s = await feed.snapshot(NOW + 10 * 60_000);
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")), ["markets:e2"]);
  assert.deepEqual([s.feed.eventsRead, s.feed.eventsPending], [3, 0]);
  assert.deepEqual(s.games.map((g) => g.name), ["Royals @ Tigers", "Belgium vs Italy"]);

  assert.equal(feed.pending, 0);

  // two hours on: the two games these venues list are asked again, the bare one is not
  calls.length = 0;
  await feed.discover(NOW + 131 * 60_000);
  assert.deepEqual(calls.filter((c) => c.startsWith("markets")), ["markets:e1", "markets:e2"]);
});

test("onchain service: while games are still to read the catalog passes run back to back, then on the clock", async () => {
  const { source, calls } = standIn();
  const service = new OnchainVenuesService({ feed: feedOf(source, reader(), { maxReadsPerPass: 1 }), key: KEY, discoverEveryMs: 10 * 60_000, log: () => {} });
  const passes = (): number => calls.filter((c) => c === "events:mlb").length;
  const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 20));
  await service.cycle(NOW);
  assert.equal(passes(), 1);
  assert.equal((service.health().catalog as { gamesStillToRead: number }).gamesStillToRead, 1);
  // a minute later, well inside the ten: one game is still to read, so the next pass starts now
  await service.cycle(NOW + 60_000);
  await settle();
  assert.equal(passes(), 2);
  await service.cycle(NOW + 120_000);
  assert.equal((service.health().catalog as { gamesStillToRead: number }).gamesStillToRead, 0);
  assert.equal(service.health().games, 2);
  // nothing left to read: no pass until the ten minutes are up
  await service.cycle(NOW + 180_000);
  await settle();
  assert.equal(passes(), 2);
  await service.cycle(NOW + 11 * 60_000 + 60_000);
  await settle();
  assert.equal(passes(), 3);
});

test("onchain feed: a venue the feed carries in a winner market of its own is brought into the game's main one, only when it is plainly the same bet", async () => {
  // the shape read on the live feed on 13 November 2026: Polymarket in the game's main moneyline, SX Bet in a second one under the same game
  const nhl: Market[] = [
    { id: "a", title: "Capitals vs. Devils", type: "MONEYLINE", period: null, outcomes: [{ name: "Capitals", side: "AWAY", listings: [pm("R"), kalshi("KX")] }, { name: "Devils", side: "HOME", listings: [pm("T")] }] },
    { id: "b", title: "New Jersey Devils vs Washington Capitals: Winner including overtime (New Jersey Devils / Washington Capitals)", type: "MONEYLINE", period: null, outcomes: [{ name: "New Jersey Devils", listings: [sx("0xABCDEF", "OUTCOME_ONE")] }, { name: "Washington Capitals", listings: [sx("0xABCDEF", "OUTCOME_TWO")] }] },
    { id: "c", title: "Spread: Capitals (-1.5)", type: "SPREAD", line: "-1.5", outcomes: [{ name: "Capitals", listings: [pm("CS")] }, { name: "Devils", listings: [pm("DS")] }] },
    { id: "d", title: "1st period", type: "MONEYLINE", period: { unit: "PERIOD", from: 1, to: 1 }, outcomes: [{ name: "Capitals", listings: [sx("0xCD", "OUTCOME_ONE")] }, { name: "Devils", listings: [] }] },
  ];
  assert.deepEqual(pairOutcomes(nhl[0].outcomes, nhl[1].outcomes), [1, 0], "each to the team of the same name, whatever the order");
  const j = joinWinner(nhl);
  assert.deepEqual([j.joined, j.apart], [["sx_bet"], []]);
  assert.deepEqual(j.winner?.outcomes.map((o) => [o.name, o.listings.map((l) => [l.venue, (l as { outcome?: string }).outcome ?? null, (l as { joinedByNames?: boolean }).joinedByNames ?? false])]), [
    ["Capitals", [["POLYMARKET", null, false], ["KALSHI", null, false], ["SX_BET", "OUTCOME_TWO", true]]],
    ["Devils", [["POLYMARKET", null, false], ["SX_BET", "OUTCOME_ONE", true]]],
  ]);
  assert.equal(nhl[0].outcomes[0].listings.length, 2, "what the feed gave is left as it was");

  // not the same bet, or not plainly: left apart
  const two = (a: string, b: string, extra: Partial<Market> = {}): Market => ({ id: "x", title: `${a} vs ${b}`, type: "MONEYLINE", period: null, outcomes: [{ name: a, listings: [sx("0xEE", "OUTCOME_ONE")] }, { name: b, listings: [sx("0xEE", "OUTCOME_TWO")] }], ...extra });
  const apart = (other: Market): [string[], string[]] => {
    const r = joinWinner([nhl[0], other]);
    return [r.joined, r.apart];
  };
  assert.deepEqual(apart(two("New Jersey Devils", "Washington Wizards")), [[], ["sx_bet"]], "a name that pairs with neither side");
  assert.deepEqual(apart(two("Capitals", "Washington Capitals")), [[], ["sx_bet"]], "two names for one side");
  assert.deepEqual(apart(two("New Jersey Devils", "Washington Capitals", { type: undefined, title: "Devils vs Capitals" })), [[], ["sx_bet"]], "a market the feed gives no type, read by its title");
  assert.deepEqual(apart({ ...two("New Jersey Devils", "Washington Capitals"), outcomes: [...two("New Jersey Devils", "Washington Capitals").outcomes, { name: "Draw", side: "DRAW", listings: [] }] }), [[], ["sx_bet"]], "a three-way market against a two-way one");
  // one side only (read on the live feed for NBA games): not a winner market of its own, so nothing is brought in, and it is counted
  const oneSide: Market = { id: "y", title: "Washington Wizards vs Detroit Pistons: Winner including overtime", type: "MONEYLINE", period: null, outcomes: [{ name: "New Jersey Devils", listings: [sx("0xFF", "OUTCOME_ONE")] }] };
  assert.deepEqual(apart(oneSide), [[], []]);
  assert.deepEqual(eventShape([nhl[0], oneSide]).others.map((m) => [m.outcomes, m.names, m.venues]), [[1, ["New Jersey Devils"], ["SX_BET"]]]);

  // three ways: the draw to the draw
  const soccer: Market[] = [
    { id: "s1", title: "Will Belgium win?", type: "MONEYLINE", period: null, outcomes: [{ name: "Belgium", side: "HOME", listings: [pm("B")] }, { name: "Draw", side: "DRAW", listings: [pm("X")] }, { name: "Italy", side: "AWAY", listings: [pm("I")] }] },
    { id: "s2", title: "Belgium vs Italy: 1X2", type: "MONEYLINE", period: null, outcomes: [{ name: "Italy", listings: [sx("0x03", "OUTCOME_ONE")] }, { name: "Tie", listings: [sx("0x02", "OUTCOME_ONE")] }, { name: "Belgium", listings: [sx("0x01", "OUTCOME_ONE")] }] },
  ];
  assert.deepEqual(joinWinner(soccer).winner?.outcomes.map((o) => o.listings.map((l) => (l as { marketHash?: string }).marketHash ?? "pm")), [["pm", "0x01"], ["pm", "0x02"], ["pm", "0x03"]]);

  // in the feed: the game compares, its SX Bet rows are tagged, and the counts say what was done
  const feed = feedOf(standIn({ listEvents: async (id) => (id === "mlb" ? [{ ...EVENTS.mlb[0], name: "WSH @ NJD" }] : EVENTS[id] ?? []), listEventMarkets: async (id) => (id === "e1" ? nhl : MARKETS[id] ?? []) }).source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  const game = s.games.find((g) => g.name === "WSH @ NJD")!;
  assert.deepEqual(game.outcomes.map((o) => o.quotes.map((q) => [q.venue, q.matchedBy, q.book !== null])), [[["polymarket", "feed", true], ["sx_bet", "names", true]], [["polymarket", "feed", true], ["sx_bet", "names", true]]]);
  const board = buildBoard(s);
  assert.equal(board.games.find((g) => g.name === "WSH @ NJD")?.venues.length, 2);
  assert.match(renderOnchainHtml({ board, coverage: s.coverage, unmatchedLimitless: s.unmatchedLimitless, feed: s.feed, hasFeed: true, intervalSec: 60, horizonHours: 48 }), /brought in from a winner market of its own under the same game/);
  const d = s.feed.diagnostics!;
  assert.deepEqual(d.winner, { none: 0, one: 1, several: 1, split: 1, joined: 1, apart: 0 });
  assert.deepEqual(d.examples.map((e) => [e.kind, e.game]), [["joined", "WSH @ NJD"]]);
  assert.deepEqual(d.examples[0].markets.map((m) => [m.sides, m.names, m.venues]), [[["AWAY", "HOME"], ["Capitals", "Devils"], ["POLYMARKET"]], [[null, null], ["New Jersey Devils", "Washington Capitals"], ["SX_BET"]]]);
});

test("onchain feed: the catalog in counts, for checking the reading against the real feed, and nothing in it about a venue that is not one of the three", async () => {
  const split: Market[] = [
    { id: "a", title: "Moneyline", type: "MONEYLINE", period: null, outcomes: [{ name: "Royals", side: "AWAY", listings: [pm("R")] }, { name: "Tigers", side: "HOME", listings: [pm("T")] }] },
    // a second winner market whose names do not pair with the first: left apart
    { id: "b", title: "Game winner", type: "MONEYLINE", period: null, outcomes: [{ name: "KC", listings: [sx("0xAB", "OUTCOME_ONE")] }, { name: "DET", listings: [sx("0xAB", "OUTCOME_TWO")] }] },
    { id: "c", title: "Run line", type: "SPREAD", line: "-1.5", outcomes: [{ name: "Royals", listings: [pm("RS"), kalshi("KX")] }, { name: "Tigers", listings: [pm("TS")] }] },
    { id: "d", title: "First inning", type: "MONEYLINE", period: { unit: "INNING", from: 1, to: 1 }, outcomes: [{ name: "Royals", listings: [sx("0xCD", "OUTCOME_ONE")] }, { name: "Tigers", listings: [] }] },
    // a market of another venue that reads as a winner market by its title: not shown
    { id: "e", title: "Some Player To Record a Double Double", outcomes: [{ name: "Yes", side: "YES", listings: [kalshi("KY")] }, { name: "No", side: "NO", listings: [kalshi("KN")] }] },
  ];
  const shape = eventShape(split);
  assert.deepEqual([shape.split, shape.joined, shape.apart], [true, false, true]);
  assert.deepEqual(shape.listings, { POLYMARKET: 4, SX_BET: 3 });
  assert.deepEqual(Object.keys(shape.keys).sort(), ["POLYMARKET", "SX_BET"]);
  assert.deepEqual(shape.keys.SX_BET, ["executable", "marketHash", "outcome", "venue"]);
  assert.deepEqual(shape.byType.SX_BET, { "MONEYLINE/2": 1, "MONEYLINE+INNING/2": 1 });
  assert.deepEqual(shape.others, [], "both venues are on a winner market: nothing sits off it");
  assert.deepEqual(shape.candidates.map((c) => [c.title, c.venues]), [["Moneyline", ["POLYMARKET"]], ["Game winner", ["SX_BET"]]]);
  assert.equal(eventShape(MARKETS.e1).split, false, "one market carries both: nothing is split");

  const feed = feedOf(standIn({ listEventMarkets: async (id) => (id === "e1" ? split : MARKETS[id] ?? []) }).source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  const d = s.feed.diagnostics!;
  assert.equal(d.games, 2);
  assert.deepEqual(d.gamesByVenue, { POLYMARKET: 2, SX_BET: 1 });
  assert.equal(d.gamesNamingTwo, 1);
  assert.deepEqual(d.winner, { none: 0, one: 1, several: 1, split: 1, joined: 0, apart: 1 });
  assert.deepEqual(d.examples.map((e) => [e.kind, e.game]), [["apart", "Royals @ Tigers"]]);
  assert.deepEqual(d.examples[0].markets.map((m) => m.names), [["Royals", "Tigers"], ["KC", "DET"]]);
  assert.deepEqual(d.sampleTitles.SX_BET, { "MONEYLINE/2": ["Game winner"], "MONEYLINE+INNING/2": ["First inning"] });
  assert.equal(d.gamesWithVenueOffWinner, 0);
  assert.ok(!/KALSHI|Double Double/.test(JSON.stringify(d)), "no other venue of the feed is named");
  assert.ok(s.games.find((g) => g.name === "Royals @ Tigers")!.outcomes.every((o) => o.quotes.every((q) => q.venue !== "sx_bet")), "and the venue left apart is not on the game");

  // a venue named only on a market this does not read as the winner market: the market is shown, with the part of the game the feed gives it
  const off: Market[] = [split[0], { id: "g", title: "Winner", type: "MONEYLINE", period: { unit: "GAME", from: 1, to: 1 }, outcomes: [{ name: "Royals", side: "AWAY", listings: [sx("0xEF", "OUTCOME_ONE")] }, { name: "Tigers", side: "HOME", listings: [sx("0xEF", "OUTCOME_TWO")] }] }, split[2]];
  const offShape = eventShape(off);
  assert.equal(offShape.split, false);
  assert.deepEqual(offShape.others.map((m) => [m.title, m.period, m.venues]), [["Winner", "GAME 1-1", ["SX_BET"]]]);
  const offFeed = feedOf(standIn({ listEventMarkets: async (id) => (id === "e1" ? off : MARKETS[id] ?? []) }).source);
  await offFeed.discover(NOW);
  const od = (await offFeed.snapshot(NOW)).feed.diagnostics!;
  assert.equal(od.gamesWithVenueOffWinner, 1);
  assert.deepEqual(od.examples.map((e) => [e.kind, e.others.map((m) => m.period)]), [["off", ["GAME 1-1"]]]);
  // and it is on the health check
  const service = new OnchainVenuesService({ feed, key: KEY, log: () => {} });
  await service.cycle(NOW);
  assert.equal((service.health().diagnostics as { winner: { apart: number } }).winner.apart, 1);
});

test("onchain Limitless: the venue's own public list, when the partner refuses its copy; a group becomes one market a pick, closing a day after the start", async () => {
  // the shape its public list had on 13 November 2026
  const group = {
    title: "UEFA NL, Belgium vs Italy",
    categories: ["Football Matches"],
    markets: [
      { title: "Belgium", slug: "belgium-1794301201905", tokens: { yes: "LB", no: "LBn" }, expirationTimestamp: NOW + 32 * 3_600_000, expired: false, metadata: { startMatchTimestampInUTC: (NOW + 8 * 3_600_000) / 1000 } },
      // one with no start named: placed by its close, a day after the start
      { title: "Italy", slug: "italy-1794301201906", tokens: { yes: "LI", no: "LIn" }, expirationTimestamp: NOW + 32 * 3_600_000, expired: false },
      // one that closes two months on: placed by the start it names
      { title: "Draw", slug: "draw-1794301201907", tokens: { yes: "LD", no: "LDn" }, expirationTimestamp: NOW + 1464 * 3_600_000, expired: false, metadata: { startMatchTimestampInUTC: (NOW + 8 * 3_600_000) / 1000 } },
      { title: "Old", slug: "old", tokens: { yes: "x", no: "y" }, expirationTimestamp: NOW, expired: true },
      { title: "No tokens", slug: "nt" },
    ],
  };
  const markets = groupToMarkets(group);
  assert.deepEqual(markets.map((m) => [m.marketSlug, m.title]), [["belgium-1794301201905", "UEFA NL, Belgium vs Italy: Belgium"], ["italy-1794301201906", "UEFA NL, Belgium vs Italy: Italy"], ["draw-1794301201907", "UEFA NL, Belgium vs Italy: Draw"]]);
  assert.deepEqual(markets[0].outcomes, [{ name: "Yes", tokenId: "LB" }, { name: "No", tokenId: "LBn" }]);
  assert.equal(markets[0].expiresAt, at(32));
  assert.deepEqual(markets.map((m) => m.startsAt), [at(8), undefined, at(8)]);
  assert.ok(isLimitlessSports(markets[0]));
  assert.deepEqual(groupToMarkets({ title: "x" }), []);

  // paged 25 at a time until the count it names is reached
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return new Response(JSON.stringify({ data: page <= 2 ? Array.from({ length: page === 1 ? 25 : 3 }, () => group) : [], totalMarketsCount: 28 }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await readLimitlessPublicGames({ fetchImpl, pauseMs: 0 })).length, 28 * 3);
  assert.deepEqual(asked.map((u) => new URL(u).search), ["?tradeType=group&automationType=sports&page=1&limit=25", "?tradeType=group&automationType=sports&page=2&limit=25"]);
  await assert.rejects(readLimitlessPublicGames({ fetchImpl: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch, pauseMs: 0 }), /Limitless public list 503/);

  // in the feed: the partner refuses, the venue's list is read, and a close 24 hours after the start is the same game (Belgium vs Italy starts 8 hours out)
  const { source } = standIn({ listLimitlessMarkets: async () => Promise.reject(new AggregatorApiError(403, "FORBIDDEN", "not permitted")), listLimitlessPublic: async () => markets });
  const feed = feedOf(source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  assert.deepEqual(s.feed.limitless, { state: "listed", source: "venue", markets: 3, sports: 3, matched: 3 });
  assert.match(s.feed.notes.join(" "), /not allowed to read the partner's Limitless list \(403\); its game markets were read from Limitless's own public list instead/);
  assert.deepEqual(s.games[1].outcomes.map((o) => o.quotes.find((q) => q.venue === "limitless")?.matchedBy), ["names", "names", "names"]);
  assert.match(renderOnchainHtml({ board: buildBoard(s), coverage: s.coverage, unmatchedLimitless: s.unmatchedLimitless, feed: s.feed, hasFeed: true, intervalSec: 60, horizonHours: 48 }), /read from Limitless's own public list of game markets, because the partner's list is refused to this key/);
});

test("onchain Limitless: a game the feed names by short codes is found by its two outcomes; a market left over is shown with the games that start when it does", async () => {
  const { source } = standIn({
    // the feed's own name for the game is codes, as it is for US leagues ("WSH @ NJD")
    listEvents: async (id) => (id === "unl" ? [{ ...EVENTS.unl[0], name: "BEL v ITA" }] : EVENTS[id] ?? []),
    listLimitlessMarkets: async () => Promise.reject(new AggregatorApiError(403, "FORBIDDEN", "not permitted")),
    listLimitlessPublic: async () => [
      { marketSlug: "bel", title: "UEFA NL, Belgium vs Italy: Belgium", categories: ["Sports"], expiresAt: at(32), startsAt: at(8), outcomes: [{ name: "Yes", tokenId: "LB" }, { name: "No", tokenId: "LBn" }] },
      { marketSlug: "lat", title: "UEFA NL, Latvia vs Armenia: Latvia", categories: ["Sports"], expiresAt: at(31), startsAt: at(7), outcomes: [{ name: "Yes", tokenId: "LL" }, { name: "No", tokenId: "LLn" }] },
      { marketSlug: "lat-d", title: "UEFA NL, Latvia vs Armenia: Draw", categories: ["Sports"], expiresAt: at(31), startsAt: at(7), outcomes: [{ name: "Yes", tokenId: "LLd" }, { name: "No", tokenId: "LLdn" }] },
    ],
  });
  const feed = feedOf(source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  assert.equal(s.feed.limitless.matched, 1);
  assert.equal(s.games.find((g) => g.name === "BEL v ITA")?.outcomes[0].quotes.find((q) => q.venue === "limitless")?.matchedBy, "names");
  assert.deepEqual(s.feed.limitless.unmatchedSample, [{ game: "Latvia vs Armenia", startsAt: at(7), gamesStartingThen: 2, sample: ["Royals @ Tigers [Royals / Tigers]", "BEL v ITA [Belgium / Draw / Italy]"] }]);
});

test("onchain Limitless: a market that could be either of two games is tied to neither", async () => {
  // the same two teams on consecutive days, and one market that closes inside both games' windows
  const { source } = standIn({
    listEvents: async (id) => (id === "mlb" ? [EVENTS.mlb[0], { id: "e1b", name: "Royals @ Tigers", competitionId: "mlb", startTime: at(30), status: "SCHEDULED" }] : EVENTS[id] ?? []),
    listEventMarkets: async (id) => MARKETS[id === "e1b" ? "e1" : id] ?? [],
    listLimitlessMarkets: async () => ({ markets: [{ marketSlug: "kc-det", title: "MLB, Royals vs Tigers", categories: ["Sports"], expiresAt: at(30), outcomes: [{ name: "Royals", tokenId: "LR" }, { name: "Tigers", tokenId: "LT" }] }], nextPageToken: null }),
  });
  const feed = feedOf(source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  assert.equal(s.games.filter((g) => g.name === "Royals @ Tigers").length, 2);
  assert.ok(s.games.every((g) => g.outcomes.every((o) => o.quotes.every((q) => q.venue !== "limitless"))));
  assert.deepEqual(s.unmatchedLimitless, ["MLB, Royals vs Tigers"]);
  assert.equal(s.feed.limitless.matched, 0);
});

test("onchain feed: a key that may not read the Limitless list is said in words and the other two venues are still read", async () => {
  const { source } = standIn({ listLimitlessMarkets: async () => Promise.reject(new AggregatorApiError(403, "FORBIDDEN", "venue paths need a trade key")) });
  const feed = feedOf(source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  assert.equal(s.feed.limitless.state, "refused");
  assert.match(s.feed.notes.join(" "), /not allowed to read the partner's Limitless list \(403\), and Limitless's own public list was not read either \(no other list to read\)/);
  assert.equal(s.games.length, 2);
  assert.ok(s.games.every((g) => g.outcomes.every((o) => o.quotes.every((q) => q.venue !== "limitless"))));
  assert.ok(s.games[0].outcomes[0].quotes[0].book);
});

test("onchain feed: the partner's own Limitless listing is used when it gives one, ahead of the names", async () => {
  const mapped: Market[] = [{ ...MARKETS.e2[0], outcomes: MARKETS.e2[0].outcomes.map((o) => (o.name === "Belgium" ? { ...o, listings: [...o.listings, { venue: "LIMITLESS", marketSlug: "bel-ita-bel", tokenId: "LB", executable: true }] } : o)) }];
  const { source } = standIn({ listEventMarkets: async (id) => (id === "e2" ? mapped : MARKETS[id] ?? []) });
  const feed = feedOf(source);
  await feed.discover(NOW);
  const s = await feed.snapshot(NOW);
  const q = s.games[1].outcomes[0].quotes.filter((x) => x.venue === "limitless");
  assert.equal(q.length, 1);
  assert.equal(q[0].matchedBy, "feed");
  assert.equal(q[0].executable, true);
  near(q[0].book?.bids[0].price, 0.43);
  assert.equal(s.games[1].outcomes[2].quotes.find((x) => x.venue === "limitless")?.matchedBy, "names");
});

test("onchain feed: a refused key and a dead stream are words on the page, never a throw", async () => {
  const refused = feedOf(standIn({ listSports: async () => Promise.reject(new AggregatorApiError(401, "UNAUTHORIZED", "bad signature")) }).source);
  await refused.discover(NOW);
  const none = await refused.snapshot(NOW);
  assert.equal(none.games.length, 0);
  assert.match(none.feed.notes.join(" "), /refused the key \(401 UNAUTHORIZED\)/);

  const dead = feedOf(standIn().source, async () => Promise.reject(new Error("aggregator stream closed before any frame (1006)")));
  await dead.discover(NOW);
  const s = await dead.snapshot(NOW);
  assert.equal(s.games.length, 2);
  assert.equal(s.feed.books.read, 0);
  assert.ok((s.feed.books.errors.STREAM ?? 0) > 0);
  assert.match(s.games[0].outcomes[0].quotes[0].error ?? "", /STREAM: aggregator stream closed/);
});

// ── the board ─────────────────────────────────────────────────────────────────

test("onchain board: leaving at home against a cover bought on the best venue, with each venue's fee in", async () => {
  const b = buildBoard(await snapshotOf());
  assert.equal(b.games.length, 2);
  assert.equal(b.comparable, 2);

  const royals = b.games[0].outcomes[0];
  const pmCell = royals.cells.polymarket!;
  assert.deepEqual([pmCell.bidCents, pmCell.askCents, pmCell.bidShares, pmCell.askShares], [44, 46, 500, 300]);
  near(pmCell.allInBid, 44 - 0.05 * 0.44 * 0.56 * 100, 0.006);
  assert.equal(pmCell.ageMs, 2000);
  const sxCell = royals.cells.sx_bet!;
  assert.deepEqual([sxCell.bidCents, sxCell.askCents, sxCell.bidShares, sxCell.askShares], [47, 50, 1000, 1000]);
  near(sxCell.allInBid, 47 - 0.47, 0.006);
  assert.equal(royals.cells.limitless!.matchedBy, "names");
  near(royals.midGap, 48.5 - 45, 1e-6);

  // a Royals holder's cover is the Tigers: Polymarket asks 56 (57.23 with its fee), SX Bet asks 53 (53.47 with its fee)
  const lockPm = royals.locks.find((k) => k.home === "polymarket")!;
  assert.equal(lockPm.cover?.legs.length, 1);
  assert.equal(lockPm.cover?.legs[0].venue, "sx_bet");
  near(lockPm.cover?.legs[0].allInAsk, 53 + 0.47, 0.006);
  near(lockPm.cover?.value, 100 - 53.47, 0.006);
  near(lockPm.homeExit, 42.77, 0.006);
  near(lockPm.betterBy, 46.53 - 42.77, 0.011);
  assert.equal(lockPm.elsewhere, true);
  // for a holder already on SX Bet the same cover is at home: it is not counted as a cover elsewhere
  const lockSx = royals.locks.find((k) => k.home === "sx_bet")!;
  assert.equal(lockSx.elsewhere, false);
  near(lockSx.betterBy, 46.53 - 46.53, 0.011);

  // three-way: a Belgium holder's cover is the draw and Italy, each where it is cheapest
  const belgium = b.games[1].outcomes[0];
  const k = belgium.locks.find((x) => x.home === "polymarket")!;
  assert.deepEqual(k.cover?.legs.map((l) => [l.outcome, l.venue]), [["Draw", "polymarket"], ["Italy", "limitless"]]);
  near(k.cover?.cost, 28 + 0.05 * 0.28 * 0.72 * 100 + 24 + 0.05 * 0.24 * 0.76 * 100, 0.011);
  assert.equal(k.cover?.shares, 400, "the cover holds for the smaller of its legs");
  // a draw holder has no full cover on Limitless alone, and none is invented: Belgium and Italy are both on offer somewhere
  assert.ok(b.games[1].outcomes[1].locks[0].cover);

  const pmSum = b.venues.find((v) => v.venue === "polymarket")!;
  assert.equal(pmSum.games, 2);
  assert.equal(pmSum.books, 5);
  assert.equal(pmSum.crossed, 0);
  near(pmSum.medianMidSum, 99.5, 0.06);
  // SX Bet's Royals mid is 48.5 against Polymarket's 45 and Limitless's 45; its Tigers mid is 51.5 against Polymarket's 55
  near(b.venues.find((v) => v.venue === "sx_bet")!.medianGapToOthers, 3.5, 0.06);
  const limSum = b.venues.find((v) => v.venue === "limitless")!;
  assert.equal(limSum.noBook, 2, "an empty book and a book that was not read");

  const coverPm = b.cover.find((s) => s.home === "polymarket")!;
  assert.equal(coverPm.withExit, 5);
  assert.ok(coverPm.elsewhereBetter >= 1);
  assert.ok(b.best.length > 0 && b.best.every((x) => x.lock.elsewhere && (x.lock.betterBy ?? 0) > 0));
  assert.ok(b.best.every((x, i) => i === 0 || (b.best[i - 1].lock.betterBy ?? 0) >= (x.lock.betterBy ?? 0)), "largest gain first");
});

test("onchain board: a crossed book is counted and never used for an exit or a cover", () => {
  const snap: Snapshot = {
    at: at(0),
    games: [
      {
        eventId: "e", name: "A @ B", competitionId: "c", competition: "C", sport: "S", startsAt: at(1), status: "SCHEDULED", marketTitle: "Moneyline",
        outcomes: [
          { name: "A", side: "AWAY", quotes: [{ venue: "polymarket", id: "a", executable: true, matchedBy: "feed", book: { bids: [{ price: 0.6, size: 10 }], asks: [{ price: 0.55, size: 10 }], ageMs: null } }] },
          { name: "B", side: "HOME", quotes: [{ venue: "polymarket", id: "b", executable: true, matchedBy: "feed", book: { bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.42, size: 10 }], ageMs: null } }] },
        ],
      },
    ],
    coverage: [],
    unmatchedLimitless: [],
    feed: { capabilities: [], discoveredAt: at(0), discoveryMs: 1, notes: [], competitions: 1, eventsInHorizon: 1, eventsRead: 1, eventsPending: 0, eventsOverCap: 0, limitless: { state: "not_read", markets: 0, sports: 0, matched: 0 }, books: { asked: 2, read: 2, empty: 0, errors: {}, ms: 1 } },
  };
  const b = buildBoard(snap);
  assert.equal(b.venues[0].crossed, 1);
  assert.equal(b.games[0].outcomes[0].locks[0].homeExit, null);
  assert.equal(b.games[0].outcomes[1].locks[0].cover, null, "the crossed ask is not a price anyone can take on trust");
  assert.equal(b.best.length, 0);
});

// ── the page and its key ──────────────────────────────────────────────────────

const KEY = "a-key-of-twenty-chars";

function ask(service: OnchainVenuesService, path: string): { handled: boolean; status: number; type: string; body: string } {
  const out = { handled: false, status: 0, type: "", body: "" };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      out.status = status;
      out.type = headers["content-type"] ?? "";
    },
    end: (body: string) => {
      out.body = body;
    },
  } as unknown as ServerResponse;
  out.handled = service.handle({} as IncomingMessage, res, new URL(path, "http://localhost"));
  return out;
}

test("onchain page: nothing is served without the key, and the open health check gives nothing away", async () => {
  const service = new OnchainVenuesService({ feed: feedOf(standIn().source), key: KEY, log: () => {} });
  await service.cycle(NOW);

  assert.equal(ask(service, "/").handled, false);
  assert.equal(ask(service, "/?k=wrong").handled, false);
  assert.equal(ask(service, `/?k=${KEY}x`).handled, false);
  assert.equal(ask(service, "/api/board").handled, false);
  assert.equal(ask(service, `/elsewhere?k=${KEY}`).handled, false);

  const page = ask(service, `/?k=${KEY}`);
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Royals @ Tigers/);
  const json = JSON.parse(ask(service, `/api/board?k=${KEY}`).body) as { board: { games: unknown[] } };
  assert.equal(json.board.games.length, 2);

  const health = JSON.stringify(service.health());
  assert.ok(!health.includes(KEY));
  assert.match(health, /"page":"on"/);
  assert.match(health, /"feedKey":"set"/);
  assert.match(health, /"games":2/);

  assert.ok(keyMatches(KEY, KEY));
  assert.ok(!keyMatches(null, KEY));
  assert.ok(!keyMatches("", ""), "an empty key opens nothing");
  // a generated key with a plus sign, pasted into the link as it stands: the plus arrives as a space
  const PLUS = "jPUTYbm+ndtAQht2gTg/x+y=";
  const viaLink = (k: string): string | null => new URL(`http://x/?k=${k}`).searchParams.get("k");
  assert.equal(viaLink(PLUS), "jPUTYbm ndtAQht2gTg/x y=");
  assert.ok(keyMatches(viaLink(PLUS), PLUS), "pasted as it stands");
  assert.ok(keyMatches(viaLink(encodeURIComponent(PLUS)), PLUS), "and written out in full");
  assert.ok(!keyMatches(viaLink("jPUTYbm+ndtAQht2gTg/x+z="), PLUS));
  assert.ok(!keyMatches(viaLink("jPUTYbmndtAQht2gTg/xy="), PLUS), "the plus signs cannot be dropped");
  const plusService = new OnchainVenuesService({ feed: null, key: PLUS, log: () => {} });
  const answered = { status: 0 };
  const res = { writeHead: (s: number) => { answered.status = s; }, end: () => {} } as unknown as import("node:http").ServerResponse;
  assert.ok(plusService.handle({} as import("node:http").IncomingMessage, res, new URL(`http://x/?k=${PLUS}`)));
  assert.equal(answered.status, 200);
});

test("onchain page: a key that is unset or short turns the page off; no feed key reads nothing and says so", async () => {
  for (const key of ["", "short", "x".repeat(PAGE_KEY_MIN - 1)]) {
    const off = new OnchainVenuesService({ feed: null, key, log: () => {} });
    assert.equal(ask(off, `/?k=${key}`).handled, false);
    assert.match(String(off.health().page), /^off: its key is /);
  }
  const noFeed = new OnchainVenuesService({ feed: null, key: KEY, log: () => {} });
  await noFeed.cycle(NOW);
  assert.equal(noFeed.health().feedKey, "not set");
  assert.match(ask(noFeed, `/?k=${KEY}`).body, /The feed key is not set on this service/);
});

test("onchain page: the rendered page carries the board, the cover table and the feed's state, in the house wording", async () => {
  const s = await snapshotOf();
  const html = renderOnchainHtml({ board: buildBoard(s), coverage: s.coverage, unmatchedLimitless: s.unmatchedLimitless, feed: s.feed, hasFeed: true, intervalSec: 60, horizonHours: 48 }, { refreshSec: 60 });
  for (const text of ["Polymarket International", "SX Bet", "Limitless", "Royals @ Tigers", "Belgium vs Italy", "by names", "Tigers on SX Bet at 53.47¢", "Leave at home", "UEFA Nations League", "can: DISCOVERY, STREAM", "docs.sx.bet/developers/fees"]) {
    assert.ok(html.includes(text), `the page says "${text}"`);
  }
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<meta http-equiv="refresh" content="60">/);
  // the wording rules the other pages are held to: no long dashes, and none of the words kept off them
  const words = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
  assert.ok(!/[\u2013\u2014]/.test(words), "no en or em dash");
  for (const banned of [/\bwallets?\b/i, /\bsell(s|ing|er|ers)?\b/i, /\bsold\b/i, /\bsales?\b/i, /\bguarantee/i, /\bprotect/i]) {
    assert.ok(!banned.test(words), `the page does not say ${banned}`);
  }
  assert.ok(!html.includes("undefined") && !html.includes("NaN"));

  const waiting = renderOnchainHtml({ board: null, coverage: [], unmatchedLimitless: [], feed: { ...s.feed, discoveredAt: null, limitless: { state: "not_read", markets: 0, sports: 0, matched: 0 } }, hasFeed: true, intervalSec: 60, horizonHours: 48 });
  assert.match(waiting, /The first read is under way/);
});
