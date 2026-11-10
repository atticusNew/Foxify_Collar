/**
 * The long/short-dialect US exchange as a reference book (crossVenue/polymarketUs.ts): the key and
 * its signature, the book shaped for the club a hedge buys (long or short side) with the fee in the
 * price, the same game never guessed, the pace and the age of the public read, the live stream
 * (a scripted socket, then the real socket client against a local server), the env that turns the
 * read on, and the operator's key check through the shadow worker. The venue is a fake fetch built
 * from payloads recorded off its public gateway on Nov 10, 2026; nothing touches the venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POLY_US_DEFAULT_COEFFICIENT,
  PolyUsClient,
  polyUsAsksForOpposing,
  polyUsBidsForOpposing,
  polyUsCoefficient,
  polyUsEventSlugs,
  polyUsFeeMilli,
  polyUsFromEnv,
  polyUsLevels,
  polyUsPreflight,
  polyUsSidesFor,
  polyUsSignerFromSecret,
  polyUsSigningMessage,
  polyUsSource,
  PolyUsApiError,
  PolyUsBookStream,
  type PolyUsMarket,
  type PolyUsRawBook,
  type PolyUsSocketLike,
} from "../src/eventCollar/crossVenue/polymarketUs";
import { LEAGUE_TEMPLATES } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import type { MatchedPair } from "../src/eventCollar/crossVenue/types";
import { REFERENCE_BOOK_IDS, REFERENCE_BOOK_WORDS, readReferenceBooks, referenceSourcesFromEnv } from "../src/eventCollar/crossVenue/venueBooks";
import { VENUE_COLUMNS } from "../src/eventCollar/crossVenue/shadowVenues";
import { forbiddenKeysIn } from "../src/eventCollar/retailShowcase";

const NBA = LEAGUE_TEMPLATES.find((t) => t.league === "nba")!;
const START = "2026-11-11T02:00:00Z";
const NOW = new Date("2026-11-10T21:40:00Z");

/** Clippers at Suns as the venue listed it: the long side is the away club, the venue spells Phoenix "pho". */
const MARKET: PolyUsMarket & Record<string, unknown> = {
  slug: "aec-nba-lac-pho-2026-11-10",
  sportsMarketType: "basketball_team_full_game_winner",
  feeCoefficient: 0.095,
  gameStartTime: START,
  active: true,
  closed: false,
  marketSides: [
    { description: "Clippers", long: true, team: { abbreviation: "lac", ordering: "away", name: "Los Angeles Clippers" } },
    { description: "Suns", long: false, team: { abbreviation: "pho", ordering: "home", name: "Phoenix Suns" } },
  ],
};
const px = (value: string) => ({ value, currency: "USD" });
const BOOK: PolyUsRawBook = {
  marketSlug: MARKET.slug,
  bids: [
    { px: px("0.3800"), qty: "337628.6000" },
    { px: px("0.3700"), qty: "223375.2100" },
    { px: px("0.3600"), qty: "4144.9900" },
  ],
  offers: [
    { px: px("0.3900"), qty: "191380.9600" },
    { px: px("0.4000"), qty: "207331.8700" },
    { px: px("0.4100"), qty: "76319.5500" },
  ],
  state: "MARKET_STATE_OPEN",
  transactTime: "2026-11-10T21:34:07.807872975Z",
};

/** A pair as the matcher builds it, as far as this reader looks: the league, the Kalshi ticker and the start. */
function pairFor(sideCode: "LAC" | "PHX", start = START): MatchedPair {
  return {
    league: "nba",
    kalshi: { ticker: `KXNBAGAME-26NOV10LACPHX-${sideCode}`, eventTicker: "KXNBAGAME-26NOV10LACPHX", seriesTicker: "KXNBAGAME", title: "Clippers vs Suns", subtitle: sideCode, status: "open", closeTime: start, yesBidCents: 38, yesAskCents: 39, lastPriceCents: 38, volume: 1, openInterest: 1, rulesPrimary: "" },
    pm: { eventSlug: "nba-lac-phx-2026-11-10", eventTitle: "Clippers vs. Suns", question: "Clippers vs. Suns", conditionId: "0x1", outcomes: ["Clippers", "Suns"], tokenIds: ["1", "2"], outcomePricesMilli: [385, 615], gameStartTime: start, endDate: start, sportsMarketType: "moneyline", active: true, closed: false, acceptingOrders: true, negRisk: false, orderMinSizeShares: 5, liquidityUsd: 1, volumeUsd: 1 },
    pmYesOutcomeIndex: sideCode === "LAC" ? 0 : 1,
    pmNoOutcomeIndex: sideCode === "LAC" ? 1 : 0,
    gameStartTime: start,
    parityNote: "",
    fingerprint: "nba:LAC:PHX:2026-11-10",
  } as MatchedPair;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The venue's gateway and API, answering from the fixtures; every request is noted with its headers. */
function fakeVenue(over: { market?: PolyUsMarket | null; book?: PolyUsRawBook | Response; balances?: Response; eventMarkets?: PolyUsMarket[] } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const market = over.market === undefined ? MARKET : over.market;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: `${url.host}${url.pathname}${url.search}`, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    if (url.host === "api.polymarket.us") {
      if (url.pathname === "/v1/account/balances") return over.balances ?? json({ balances: [{ currency: "USD", currentBalance: 250.5, buyingPower: 240.25, openOrders: 10.25, lastUpdated: "2026-11-10T20:00:00Z" }] });
      return json({ message: "no such route" }, 404);
    }
    const bySlug = /^\/v1\/market\/slug\/(.+)$/.exec(url.pathname);
    if (bySlug) return market && decodeURIComponent(bySlug[1]) === market.slug ? json({ market }) : json({ code: 5, message: "The server was unable to process your request.", details: [] }, 404);
    if (url.pathname === "/v1/events") {
      const slug = url.searchParams.get("slug");
      return over.eventMarkets && slug === "nba-lac-pho-2026-11-10" ? json({ events: [{ slug, startTime: START, markets: over.eventMarkets }] }) : json({ events: [] });
    }
    if (/\/book$/.test(url.pathname)) return over.book instanceof Response ? over.book : json({ marketData: over.book ?? BOOK });
    return json({ message: "no such route" }, 404);
  };
  return { fetchImpl, calls, urls: () => calls.map((c) => c.url) };
}

/** A socket the test drives by hand: what was sent is kept, and the venue's side speaks through `emit`. */
function fakeSocket() {
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const sent: Array<Record<string, any>> = [];
  let closed = 0;
  const socket: PolyUsSocketLike = {
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => void (closed += 1),
    on: (event: string, fn: (arg?: any) => void) => void handlers.set(event, [...(handlers.get(event) ?? []), fn]),
  };
  return Object.assign(socket, {
    sent,
    closes: () => closed,
    emit: (event: "open" | "close" | "ping" | "error" | "message", arg?: unknown) => (handlers.get(event) ?? []).forEach((fn) => fn(event === "message" ? JSON.stringify(arg) : arg)),
  });
}
/** let the stream's connect (an awaited factory) run */
const tick = () => new Promise<void>((r) => setImmediate(r));

test("the key: a secret from the portal signs timestamp + method + path with Ed25519; a secret that is not a key is refused without being repeated", () => {
  // a real Ed25519 key, laid out as the portal hands it over: base64 of the 32-byte seed followed by the public key
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const secret = Buffer.concat([seed, pub]).toString("base64");
  const signer = polyUsSignerFromSecret(" key-123 ", secret);
  assert.equal(signer.keyId, "key-123");
  const h = signer.headers("get", "/v1/account/balances", 1_762_810_000_123);
  assert.deepEqual(Object.keys(h).sort(), ["X-PM-Access-Key", "X-PM-Signature", "X-PM-Timestamp"]);
  assert.equal(h["X-PM-Access-Key"], "key-123");
  assert.equal(h["X-PM-Timestamp"], "1762810000123");
  assert.equal(polyUsSigningMessage("1762810000123", "get", "/v1/account/balances"), "1762810000123GET/v1/account/balances");
  const ok = verify(null, Buffer.from("1762810000123GET/v1/account/balances", "utf8"), publicKey, Buffer.from(h["X-PM-Signature"], "base64"));
  assert.equal(ok, true, "the venue's check: the public half verifies the signature over the message");
  // the bare 32-byte seed is a key too
  const bare = polyUsSignerFromSecret("key-123", seed.toString("base64"));
  assert.equal(bare.headers("GET", "/v1/account/balances", 1_762_810_000_123)["X-PM-Signature"], h["X-PM-Signature"], "only the first 32 bytes are the key");

  const refused = (bad: string): string => {
    try {
      polyUsSignerFromSecret("key-123", bad);
    } catch (err) {
      return String((err as Error).message);
    }
    return "";
  };
  assert.match(refused("not base64 !!"), /not base64/);
  assert.match(refused(Buffer.alloc(16, 7).toString("base64")), /16 bytes; 32 or more/);
  assert.ok(!refused("c2VjcmV0LXdvcmRz").includes("c2VjcmV0"), "the refusal never repeats the secret");
  assert.throws(() => polyUsSignerFromSecret("  ", secret), /key id is empty/);
});

test("the book for the club a hedge buys: offers when it is long, 1 minus the bids when it is short; the fee is in the price, rounded up", () => {
  assert.deepEqual(polyUsLevels(BOOK.offers), [
    { priceMilli: 390, sizeMilli: 191_380_960 },
    { priceMilli: 400, sizeMilli: 207_331_870 },
    { priceMilli: 410, sizeMilli: 76_319_550 },
  ]);
  assert.deepEqual(polyUsLevels([{ px: px("0"), qty: "5" }, { px: px("1.0000"), qty: "5" }, { px: px("0.5"), qty: "0" }, { px: px("abc"), qty: "5" }, { px: null, qty: "5" }, { px: px("0.5100"), qty: "0.0149" }]), [{ priceMilli: 510, sizeMilli: 14 }], "not a price or not a size: dropped; a part share is kept down to the thousandth");

  // theta x p x (1 - p) a share: 0.095 x 0.39 x 0.61 = 2.26 cents, rounded up to the tenth of a cent
  assert.equal(polyUsFeeMilli(0.095, 390), 23);
  assert.equal(polyUsFeeMilli(0.095, 620), 23, "symmetric in p");
  assert.equal(polyUsFeeMilli(0.095, 500), 24);
  assert.equal(polyUsFeeMilli(0.1, 500), 25, "an exact fee is not bumped by float dust");
  assert.equal(polyUsFeeMilli(0, 500), 0);
  assert.equal(polyUsCoefficient({ feeCoefficient: 0.0695 }), 0.0695);
  assert.equal(polyUsCoefficient({}), POLY_US_DEFAULT_COEFFICIENT);
  assert.equal(polyUsCoefficient({ feeCoefficient: 7 }), 0.095, "a coefficient that is not a fraction is not believed");

  // the hedge buys the LONG club (the Clippers): the offers as they stand, plus the fee
  assert.deepEqual(polyUsAsksForOpposing(BOOK, true, 0.095), [
    { priceMilli: 413, sizeMilli: 191_380_960 },
    { priceMilli: 423, sizeMilli: 207_331_870 },
    { priceMilli: 433, sizeMilli: 76_319_550 },
  ]);
  // the hedge buys the SHORT club (the Suns): a long bid of 38 is a short offer at 62, with the bid's size
  assert.deepEqual(polyUsAsksForOpposing(BOOK, false, 0.095), [
    { priceMilli: 620 + 23, sizeMilli: 337_628_600 },
    { priceMilli: 630 + 23, sizeMilli: 223_375_210 },
    { priceMilli: 640 + 22, sizeMilli: 4_144_990 },
  ]);
  // leaving a hedge: the long club is sold into the bids, the short club into 1 minus the offers, less the fee
  assert.deepEqual(polyUsBidsForOpposing(BOOK, true, 0.095).map((l) => l.priceMilli), [380 - 23, 370 - 23, 360 - 22]);
  assert.deepEqual(polyUsBidsForOpposing(BOOK, false, 0.095).map((l) => l.priceMilli), [610 - 23, 600 - 23, 590 - 23]);
  // both sides of one share cost more than $1 after the fee: the book cannot be crossed against itself
  const longAsk = polyUsAsksForOpposing(BOOK, true, 0.095)[0].priceMilli;
  const shortAsk = polyUsAsksForOpposing(BOOK, false, 0.095)[0].priceMilli;
  assert.ok(longAsk + shortAsk > 1000);
  assert.deepEqual(polyUsAsksForOpposing({ bids: [], offers: null }, true, 0.095), []);
});

test("the same game, never guessed: both sides must name our two clubs, one each, by the venue's own spelling", () => {
  assert.deepEqual(polyUsEventSlugs("nba", "LAC", "PHX", "2026-11-10", NBA), ["nba-lac-pho-2026-11-10", "nba-lac-phx-2026-11-10"], "the venue's spelling first");
  assert.deepEqual(polyUsSidesFor(MARKET, "nba", "PHX", "LAC", NBA), { oursIsLong: false, oursName: "Phoenix Suns", opposingName: "Los Angeles Clippers" });
  assert.deepEqual(polyUsSidesFor(MARKET, "nba", "LAC", "PHX", NBA), { oursIsLong: true, oursName: "Los Angeles Clippers", opposingName: "Phoenix Suns" });
  assert.equal(polyUsSidesFor(MARKET, "nba", "LAC", "BOS", NBA), null, "the short side is not our other club");
  assert.equal(polyUsSidesFor(MARKET, "nba", "BOS", "PHX", NBA), null);
  assert.equal(polyUsSidesFor({ ...MARKET, marketSides: [MARKET.marketSides![0]] }, "nba", "LAC", "PHX", NBA), null, "one side only");
  assert.equal(polyUsSidesFor({ ...MARKET, marketSides: [{ long: true }, { long: false }] }, "nba", "LAC", "PHX", NBA), null, "sides that name no team");
  assert.equal(polyUsSidesFor({ ...MARKET, marketSides: [MARKET.marketSides![0], { ...MARKET.marketSides![1], team: { abbreviation: "lac" } }] }, "nba", "LAC", "PHX", NBA), null, "both sides the same club");
});

test("the source: the opposing club's book with the fee folded, the listing an order would need; listed, closed, suspended and not-ours are told apart", async () => {
  // our side is the Suns (short): the hedge buys the Clippers, the long side
  const venue = fakeVenue();
  const client = new PolyUsClient({ minIntervalMs: 0, fetchImpl: venue.fetchImpl, now: () => NOW.getTime() });
  const suns = await polyUsSource(client).read(pairFor("PHX"), NOW);
  assert.ok(suns.book, JSON.stringify(suns));
  assert.equal(suns.id, "long_short_v1");
  assert.deepEqual(suns.book.asks[0], { priceMilli: 413, sizeMilli: 191_380_960 });
  assert.deepEqual(suns.book.bids[0], { priceMilli: 357, sizeMilli: 337_628_600 });
  assert.equal(suns.book.tokenId, "long_short_v1:aec-nba-lac-pho-2026-11-10");
  assert.deepEqual(suns.listing, {
    marketId: "aec-nba-lac-pho-2026-11-10",
    key: "nba-lac-pho-2026-11-10",
    snapshotAtIso: "2026-11-10T21:34:07.807872975Z",
    outcomes: {
      ours: { outcomeId: "aec-nba-lac-pho-2026-11-10:short", name: "Phoenix Suns" },
      opposing: { outcomeId: "aec-nba-lac-pho-2026-11-10:long", name: "Los Angeles Clippers" },
      fee: { coefficient: 0.095, folded: true },
      marketStatus: "open",
    },
  });
  assert.deepEqual(venue.urls(), ["gateway.polymarket.us/v1/market/slug/aec-nba-lac-pho-2026-11-10", "gateway.polymarket.us/v1/markets/aec-nba-lac-pho-2026-11-10/book"], "the winner market by its own slug, then its book: no key, no megabyte event");
  assert.ok(venue.calls.every((c) => !Object.keys(c.headers).some((h) => /^x-pm-/i.test(h))), "public reads carry no key");

  // the other side of the same game: the market is remembered, the book is read again
  const clippers = await polyUsSource(client).read(pairFor("LAC"), NOW);
  assert.ok(clippers.book);
  assert.deepEqual(clippers.book.asks[0], { priceMilli: 643, sizeMilli: 337_628_600 }, "the hedge buys the Suns, the short side: 1 minus the long bid");
  assert.equal(clippers.listing?.outcomes?.opposing.outcomeId, "aec-nba-lac-pho-2026-11-10:short");
  assert.deepEqual(venue.urls().slice(2), ["gateway.polymarket.us/v1/markets/aec-nba-lac-pho-2026-11-10/book"]);

  // not listed: every spelling is asked by market and by event, and the miss is remembered
  const none = fakeVenue({ market: null });
  const noneClient = new PolyUsClient({ minIntervalMs: 0, fetchImpl: none.fetchImpl, now: () => NOW.getTime() });
  assert.deepEqual(await polyUsSource(noneClient).read(pairFor("PHX"), NOW), { id: "long_short_v1", book: null, reason: "not_listed" });
  assert.deepEqual(none.urls(), [
    "gateway.polymarket.us/v1/market/slug/aec-nba-lac-pho-2026-11-10",
    "gateway.polymarket.us/v1/events?slug=nba-lac-pho-2026-11-10",
    "gateway.polymarket.us/v1/market/slug/aec-nba-lac-phx-2026-11-10",
    "gateway.polymarket.us/v1/events?slug=nba-lac-phx-2026-11-10",
  ]);
  await polyUsSource(noneClient).read(pairFor("LAC"), NOW);
  assert.equal(none.calls.length, 4, "a miss is not asked again inside its window");

  // a winner market filed under another slug is found on the event
  const viaEvent = fakeVenue({ market: null, eventMarkets: [{ slug: "x-spread", sportsMarketType: "basketball_team_full_game_spread" }, { ...MARKET, slug: "other-nba-lac-pho", gameStartTime: undefined }] });
  const found = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: viaEvent.fetchImpl })).read(pairFor("PHX"), NOW);
  assert.equal(found.listing?.marketId, "other-nba-lac-pho");
  assert.ok(found.book);

  // another game between the same clubs on the same date (the starts are hours apart)
  const later = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl })).read(pairFor("PHX", "2026-11-10T21:00:00Z"), NOW);
  assert.deepEqual(later, { id: "long_short_v1", book: null, reason: "start_mismatch" });
  // the slug fits but a side names another club
  const wrong = fakeVenue({ market: { ...MARKET, marketSides: [MARKET.marketSides![0], { long: false, team: { abbreviation: "sac" } }] } });
  assert.deepEqual(await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: wrong.fetchImpl })).read(pairFor("PHX"), NOW), { id: "long_short_v1", book: null, reason: "sides_unverified" });
  // suspended: the state, not a price
  const halted = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ book: { ...BOOK, state: "MARKET_STATE_SUSPENDED" } }).fetchImpl })).read(pairFor("PHX"), NOW);
  assert.equal(halted.book, null);
  assert.equal(halted.reason, "market_suspended");
  assert.equal(halted.listing?.outcomes?.marketStatus, "suspended");
  const expired = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ book: { ...BOOK, state: "MARKET_STATE_EXPIRED" } }).fetchImpl })).read(pairFor("PHX"), NOW);
  assert.equal(expired.reason, "market_closed");
  // closed on the catalog: the book is not even asked for
  const closed = fakeVenue({ market: { ...MARKET, closed: true } });
  const closedRead = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: closed.fetchImpl })).read(pairFor("PHX"), NOW);
  assert.equal(closedRead.reason, "market_closed");
  assert.equal(closed.calls.length, 1);
  // an open book with nothing on the side the hedge buys is a book with no asks, not a guess
  const empty = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ book: { ...BOOK, offers: [] } }).fetchImpl })).read(pairFor("PHX"), NOW);
  assert.deepEqual(empty.book?.asks, []);
  // a league the reader has no template for
  assert.deepEqual(await polyUsSource(client).read({ ...pairFor("PHX"), league: "cricket" }, NOW), { id: "long_short_v1", book: null, reason: "league_not_covered" });

  // through the read that never throws: the venue's code is kept, an outage is unreachable
  const limited = fakeVenue({ book: json({ status: 429, message: "Too Many Requests" }, 429) });
  assert.deepEqual(await readReferenceBooks([polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: limited.fetchImpl }))], pairFor("PHX"), NOW), [{ id: "long_short_v1", book: null, reason: "venue_rate_limited" }]);
  const down: typeof fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const out = await readReferenceBooks([polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: down }))], pairFor("PHX"), NOW);
  assert.match(out[0].reason ?? "", /^unreachable: connect ECONNREFUSED/);
});

test("the public read keeps under the venue's limit: reads are spaced, a long queue is refused here, a 429 stands the reads down for as long as the venue asked", async () => {
  let clock = NOW.getTime();
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    clock += ms;
  };
  const venue = fakeVenue();
  const client = new PolyUsClient({ fetchImpl: venue.fetchImpl, now: () => clock, sleep });
  // four reads one after another, as the scan asks: the first goes now, each of the others 1.25 seconds after the one before
  for (const slug of ["a", "b", "c", "d"]) await client.book(slug);
  assert.deepEqual(slept, [1250, 1250, 1250], "each waits its turn behind the one before");
  assert.equal(clock - NOW.getTime(), 3750, "eight reads in ten seconds, under the ten the gateway allows one address");
  assert.equal(venue.calls.length, 4);

  // a burst: one read may wait its turn; the rest would wait longer than a quote should and are refused here, without asking the venue
  let frozen = NOW.getTime();
  const burst = fakeVenue();
  const busy = new PolyUsClient({ fetchImpl: burst.fetchImpl, now: () => frozen, sleep: async () => undefined });
  const results = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => busy.book(`m${i}`)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "the read in hand and the one behind it");
  const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as PolyUsApiError);
  assert.equal(refused.length, 12);
  assert.ok(refused.every((e) => e instanceof PolyUsApiError && e.code === "RATE_LIMITED" && /too many reads queued/.test(e.message)));
  assert.equal(burst.calls.length, 2, "a refused read never reached the venue");
  frozen += 10_000;
  await busy.book("later");
  assert.equal(burst.calls.length, 3, "the queue drains with time");

  // the venue says "too many": every read stands down until its Retry-After has passed, then reads again.
  // A book already held is handed back meanwhile with its true age, for up to two minutes; a book never read is not invented.
  let at = NOW.getTime();
  let limited = false;
  let asked = 0;
  const fetchImpl: typeof fetch = async () => {
    asked += 1;
    return limited
      ? new Response(JSON.stringify({ message: "Too Many Requests" }), { status: 429, headers: { "retry-after": "4" } })
      : new Response(JSON.stringify({ marketData: BOOK }), { status: 200, headers: { "cache-control": "public, max-age=30", age: "5" } });
  };
  const cooled = new PolyUsClient({ minIntervalMs: 0, fetchImpl, now: () => at });
  assert.equal((await cooled.book("a")).ageSec, 5);
  assert.equal(cooled.coolingUntilIso, null);
  limited = true;
  at += 26_000;
  assert.equal((await cooled.book("a")).ageSec, 31, "refused by the venue: the copy held, 26 seconds on");
  assert.equal(asked, 2);
  assert.equal(cooled.coolingUntilIso, new Date(at + 4000).toISOString());
  await assert.rejects(cooled.book("b"), (e: PolyUsApiError) => e.code === "RATE_LIMITED" && /standing down after the venue's rate limit/.test(e.message));
  await assert.rejects(cooled.winnerMarket("nba-lac-pho-2026-11-10"), /standing down/);
  limited = false;
  at += 3900;
  assert.equal((await cooled.book("a")).ageSec, 35);
  assert.equal(asked, 2, "nothing is sent while standing down");
  at += 200;
  assert.equal(cooled.coolingUntilIso, null);
  assert.equal((await cooled.book("a")).ageSec, 5, "read again once the venue's wait is over");
  assert.equal(asked, 3);
  limited = true;
  at += 121_000;
  await assert.rejects(cooled.book("a"), (e: PolyUsApiError) => e.code === "RATE_LIMITED" && e.status === 429, "a copy over two minutes old is not handed back");
});

test("a REST book says how old it is: the venue's edge-cache age is on the read, the same copy is not asked for twice, and a miss costs one small request once the venue's naming is proven", async () => {
  let clock = NOW.getTime();
  let edgeAge = 12;
  let bookReads = 0;
  const venue = fakeVenue();
  const fetchImpl: typeof fetch = async (input, init) => {
    if (/\/book$/.test(new URL(String(input)).pathname)) {
      bookReads += 1;
      return new Response(JSON.stringify({ marketData: BOOK }), { status: 200, headers: { "cache-control": "public, max-age=30", age: String(edgeAge) } });
    }
    return venue.fetchImpl(input, init);
  };
  const client = new PolyUsClient({ minIntervalMs: 0, fetchImpl, now: () => clock });
  const source = polyUsSource(client);
  const first = await source.read(pairFor("PHX"), NOW);
  assert.equal(first.ageSec, 12, "the copy had sat 12 seconds at the venue's edge");
  // 10 seconds on, the edge would hand back the same copy: ours is reused and is 22 seconds old
  clock += 10_000;
  const again = await source.read(pairFor("LAC"), NOW);
  assert.equal(again.ageSec, 22);
  assert.equal(bookReads, 1);
  // past the edge's 30 seconds the venue has a newer copy: it is asked for
  clock += 8_000;
  edgeAge = 0;
  const fresh = await source.read(pairFor("PHX"), NOW);
  assert.equal(fresh.ageSec, 0);
  assert.equal(bookReads, 2);
  // a venue that stamps no age: none is claimed, and nothing is reused
  const bare = new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl, now: () => clock });
  const unstamped = await polyUsSource(bare).read(pairFor("PHX"), NOW);
  assert.ok(unstamped.book);
  assert.equal(unstamped.ageSec, undefined);

  // the winner market's own slug has answered once, so a game that is not listed costs one small request a spelling, never the megabyte event
  const seen = venue.calls.length;
  assert.equal(await client.winnerMarket("nba-bos-nyk-2026-11-12"), null);
  assert.deepEqual(venue.urls().slice(seen), ["gateway.polymarket.us/v1/market/slug/aec-nba-bos-nyk-2026-11-12"]);
});

test("the live stream: one signed connection, every game read subscribed on it, the pushed book priced at age 0; a dropped or silent stream prices nothing and REST takes over with its age", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  const signer = polyUsSignerFromSecret("kid", seed.toString("base64"));
  let clock = NOW.getTime();
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  const dials: Array<{ url: string; headers: Record<string, string> }> = [];
  const stream = new PolyUsBookStream(signer, {
    now: () => clock,
    socketFactory: (url, headers) => {
      dials.push({ url, headers });
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
  });
  const venue = fakeVenue();
  const client = new PolyUsClient({ minIntervalMs: 0, fetchImpl: venue.fetchImpl, signer, now: () => clock });
  const source = polyUsSource(client, stream, { firstBookWaitMs: 0 });
  assert.equal(stream.status().state, "idle");
  assert.equal(dials.length, 0, "nothing connects until a game is read");

  // the first read of a game: the stream is asked to hold it, and until it does the book is REST's
  const first = await source.read(pairFor("PHX"), NOW);
  assert.deepEqual(first.book?.asks[0], { priceMilli: 413, sizeMilli: 191_380_960 });
  await tick();
  assert.equal(dials.length, 1);
  assert.equal(dials[0].url, "wss://api.polymarket.us/v1/ws/markets");
  assert.equal(dials[0].headers["X-PM-Access-Key"], "kid");
  const ts = dials[0].headers["X-PM-Timestamp"];
  assert.equal(ts, String(clock));
  assert.ok(verify(null, Buffer.from(`${ts}GET/v1/ws/markets`, "utf8"), publicKey, Buffer.from(dials[0].headers["X-PM-Signature"], "base64")), "the handshake is signed as a GET of the stream's path");
  assert.equal(stream.status().state, "connecting");
  assert.equal(stream.book(MARKET.slug), null, "not open: nothing to vouch for");

  sockets[0].emit("open");
  assert.equal(sockets[0].sent.length, 1);
  assert.deepEqual(sockets[0].sent[0].subscribe.marketSlugs, [MARKET.slug]);
  assert.equal(sockets[0].sent[0].subscribe.subscriptionType, "SUBSCRIPTION_TYPE_MARKET_DATA");
  assert.equal(typeof sockets[0].sent[0].subscribe.requestId, "string");
  assert.equal(stream.book(MARKET.slug), null, "open, but this game's book has not arrived");

  // the venue pushes the book, moved a cent: it is what prices, at age 0, with no REST read
  const moved: PolyUsRawBook = { ...BOOK, offers: [{ px: px("0.4000"), qty: "500.0000" }], bids: [{ px: px("0.3900"), qty: "700.0000" }], transactTime: "2026-11-10T21:40:01Z" };
  sockets[0].emit("message", { requestId: "books-1-1", subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA", marketData: moved });
  const before = venue.calls.length;
  const live = await source.read(pairFor("PHX"), NOW);
  assert.equal(live.ageSec, 0);
  assert.deepEqual(live.book?.asks, [{ priceMilli: 400 + 23, sizeMilli: 500_000 }]);
  assert.equal(live.listing?.snapshotAtIso, "2026-11-10T21:40:01Z");
  assert.equal(venue.calls.length, before, "the live book costs no request");
  // a suspension pushed on the stream stops the price at once
  sockets[0].emit("message", { marketData: { ...moved, state: "MARKET_STATE_SUSPENDED" } });
  assert.equal((await source.read(pairFor("PHX"), NOW)).reason, "market_suspended");
  sockets[0].emit("message", { marketData: moved });

  // another game read while open is subscribed on the same connection, once
  stream.want("aec-nba-bos-nyk-2026-11-10");
  stream.want("aec-nba-bos-nyk-2026-11-10");
  assert.equal(sockets[0].sent.length, 2);
  assert.deepEqual(sockets[0].sent[1].subscribe.marketSlugs, ["aec-nba-bos-nyk-2026-11-10"]);
  assert.equal(dials.length, 1);

  // a game just subscribed: the read waits a moment for the venue's first push of its book instead of spending a REST read
  const other: PolyUsRawBook = { ...BOOK, marketSlug: "aec-nba-bos-nyk-2026-11-10" };
  const soon = stream.bookSoon("aec-nba-bos-nyk-2026-11-10", 5_000);
  sockets[0].emit("message", { marketData: other });
  assert.equal((await soon)?.book.marketSlug, "aec-nba-bos-nyk-2026-11-10");
  stream.want("aec-nba-den-lal-2026-11-10");
  assert.equal(await stream.bookSoon("aec-nba-den-lal-2026-11-10", 20), null, "it did not come in time");
  assert.equal(await stream.bookSoon("never-asked-for", 5_000), null, "a game not subscribed is not waited for");
  const waited = fakeVenue();
  const patient = polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: waited.fetchImpl, now: () => clock }), stream, { firstBookWaitMs: 5_000 });
  sockets[0].emit("message", { marketData: { ...moved, offers: [] } });
  const stillLive = await patient.read(pairFor("PHX"), NOW);
  assert.equal(stillLive.ageSec, 0);
  assert.deepEqual(waited.urls(), ["gateway.polymarket.us/v1/market/slug/aec-nba-lac-pho-2026-11-10"], "the catalog once; the book from the stream");
  sockets[0].emit("message", { marketData: moved });

  // heartbeats and pings keep it live; a failed subscription is noted, not fatal; noise is ignored
  clock += 60_000;
  sockets[0].emit("message", { heartbeat: {} });
  clock += 60_000;
  sockets[0].emit("ping");
  clock += 60_000;
  assert.ok(stream.book(MARKET.slug), "heard from inside the last 90 seconds");
  sockets[0].emit("message", { requestId: "books-1-2", error: "unknown market" });
  assert.match(stream.status().lastError ?? "", /subscription: unknown market/);
  (sockets[0] as unknown as { emit(e: string, a: unknown): void }).emit("message", "not json");
  assert.deepEqual({ state: stream.status().state, live: stream.status().live, markets: stream.status().markets, books: stream.status().books }, { state: "open", live: true, markets: 3, books: 2 });

  // silent for longer than the bound: the held books are dropped, the read falls back to REST and says its age
  clock += 91_000;
  const silent = await source.read(pairFor("PHX"), NOW);
  assert.deepEqual(silent.book?.asks[0], { priceMilli: 413, sizeMilli: 191_380_960 }, "REST's book, not the one the dead stream last held");
  assert.equal(silent.ageSec, undefined);
  assert.equal(stream.status().state, "waiting");
  assert.equal(stream.status().books, 0);
  assert.equal(sockets[0].closes(), 1);
  // anything the dropped socket still says is ignored
  sockets[0].emit("message", { marketData: moved });
  sockets[0].emit("close");
  assert.equal(stream.status().books, 0);
  assert.equal(dials.length, 1, "no reconnect before the wait is over");

  // the next read after the wait reconnects and subscribes everything again
  clock += 1_000;
  await source.read(pairFor("PHX"), NOW);
  await tick();
  assert.equal(dials.length, 2);
  sockets[1].emit("open");
  assert.deepEqual(sockets[1].sent[0].subscribe.marketSlugs, [MARKET.slug, "aec-nba-bos-nyk-2026-11-10", "aec-nba-den-lal-2026-11-10"]);

  // the venue closes it, twice running without a word in between: the wait doubles
  sockets[1].emit("close");
  assert.equal(stream.status().retryAtIso, new Date(clock + 2_000).toISOString());
  clock += 2_000;
  stream.want(MARKET.slug);
  await tick();
  sockets[2].emit("error", new Error("socket hang up"));
  assert.equal(stream.status().retryAtIso, new Date(clock + 4_000).toISOString());
  assert.equal(stream.status().lastError, "socket hang up");

  // a connection that cannot be made at all is a wait too, never a throw into the read
  const failing = new PolyUsBookStream(signer, {
    now: () => clock,
    socketFactory: () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });
  failing.want("x");
  await tick();
  assert.equal(failing.status().state, "waiting");
  assert.match(failing.status().lastError ?? "", /could not connect: getaddrinfo ENOTFOUND/);

  // more than a hundred games: subscribed a hundred at a time
  const many = fakeSocket();
  const wide = new PolyUsBookStream(signer, { now: () => clock, socketFactory: () => many });
  for (let i = 0; i < 230; i += 1) wide.want(`m${i}`);
  await tick();
  many.emit("open");
  assert.deepEqual(many.sent.map((m) => m.subscribe.marketSlugs.length), [100, 100, 30]);
  // a game nobody has read for hours is not subscribed again at the next connect
  clock += 7 * 3_600_000;
  wide.want("m0");
  many.emit("close");
  clock += 1_000;
  const again = fakeSocket();
  const rewired = new PolyUsBookStream(signer, { now: () => clock, socketFactory: () => again, idleMs: 3_600_000 });
  rewired.want("old");
  clock += 2 * 3_600_000;
  rewired.want("new");
  await tick();
  again.emit("open");
  assert.deepEqual(again.sent[0].subscribe.marketSlugs, ["new"]);

  // the venue refuses the key on the handshake: no more tries, and REST carries on
  const refusedSock = fakeSocket();
  let refusedDials = 0;
  const refused = new PolyUsBookStream(signer, {
    now: () => clock,
    socketFactory: () => {
      refusedDials += 1;
      return refusedSock;
    },
  });
  refused.want(MARKET.slug);
  await tick();
  refusedSock.emit("error", new Error("Unexpected server response: 401"));
  assert.equal(refused.status().state, "refused");
  clock += 600_000;
  refused.want(MARKET.slug);
  await tick();
  assert.equal(refusedDials, 1);
  const viaRest = await polyUsSource(client, refused).read(pairFor("PHX"), NOW);
  assert.ok(viaRest.book);
  const check = await polyUsPreflight(client, refused);
  assert.equal(check.books, "rest");
  assert.equal(check.stream?.state, "refused");

  // stopped for good
  stream.close();
  stream.want(MARKET.slug);
  await tick();
  assert.equal(stream.status().state, "idle");
  assert.equal(dials.length, 3);
});

test("the live stream over a real socket: the handshake carries the three signed headers, the subscription and the book cross the wire, a refused key stops it", async () => {
  type Server = { on(e: string, fn: (...a: any[]) => void): void; close(cb?: () => void): void; address(): AddressInfo; clients: Set<{ terminate(): void }> };
  const ws = (await import("ws" as string)) as { WebSocketServer: new (opts: Record<string, unknown>) => Server };
  const seed = Buffer.alloc(32, 9).toString("base64");
  const signer = polyUsSignerFromSecret("kid", seed);
  const seen: { path?: string; headers?: Record<string, string>; frames: Array<Record<string, any>> } = { frames: [] };
  let accept = true;
  const server = new ws.WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (_info: unknown, done: (ok: boolean, code?: number, message?: string) => void) => (accept ? done(true) : done(false, 401, "Unauthorized")),
  });
  await new Promise<void>((r) => server.on("listening", () => r()));
  server.on("connection", (socket: { on(e: string, fn: (d: Buffer) => void): void; send(d: string): void }, req: { url: string; headers: Record<string, string> }) => {
    seen.path = req.url;
    seen.headers = req.headers;
    socket.on("message", (d) => {
      const frame = JSON.parse(String(d)) as Record<string, any>;
      seen.frames.push(frame);
      socket.send(JSON.stringify({ heartbeat: {} }));
      for (const slug of frame.subscribe.marketSlugs as string[]) socket.send(JSON.stringify({ requestId: frame.subscribe.requestId, subscriptionType: frame.subscribe.subscriptionType, marketData: { ...BOOK, marketSlug: slug } }));
    });
  });
  const baseUrl = `ws://127.0.0.1:${server.address().port}`;
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(ok(), "timed out waiting on the socket");
  };
  try {
    const stream = new PolyUsBookStream(signer, { baseUrl });
    stream.want(MARKET.slug);
    await until(() => stream.book(MARKET.slug) !== null);
    assert.equal(seen.path, "/v1/ws/markets");
    assert.equal(seen.headers?.["x-pm-access-key"], "kid");
    assert.match(seen.headers?.["x-pm-timestamp"] ?? "", /^\d{13}$/);
    assert.ok((seen.headers?.["x-pm-signature"] ?? "").length > 80);
    assert.ok(!JSON.stringify(seen).includes(seed));
    assert.deepEqual(seen.frames.map((f) => f.subscribe.marketSlugs), [[MARKET.slug]]);
    assert.equal(stream.status().live, true);
    const read = await polyUsSource(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl }), stream).read(pairFor("PHX"), NOW);
    assert.equal(read.ageSec, 0);
    assert.deepEqual(read.book?.asks[0], { priceMilli: 413, sizeMilli: 191_380_960 });
    // the venue drops the connection: nothing is held, and the stream waits to reconnect
    for (const c of server.clients) c.terminate();
    await until(() => stream.status().state === "waiting");
    assert.equal(stream.book(MARKET.slug), null);
    stream.close();

    // a key the venue refuses on the handshake: refused, and not tried again
    accept = false;
    const refused = new PolyUsBookStream(signer, { baseUrl });
    refused.want(MARKET.slug);
    await until(() => refused.status().state === "refused");
    assert.match(refused.status().lastError ?? "", /401/);
    refused.want(MARKET.slug);
    assert.equal(refused.status().connects, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the env: a key turns the read on, REFERENCE_BOOK_POLY_US=public reads without one, =0 turns it off; half a key says so; nothing set reads nothing", () => {
  const seed = Buffer.alloc(32, 9).toString("base64");
  assert.deepEqual(polyUsFromEnv({}), { client: null, stream: null, note: null });
  assert.deepEqual(referenceSourcesFromEnv({}), { sources: [], notes: [] }, "nothing set, nothing read: the other references are untouched");

  const keyed = polyUsFromEnv({ POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: seed });
  assert.equal(keyed.client?.signed, true);
  assert.equal(keyed.note, null);
  assert.equal(keyed.stream?.status().state, "idle", "a key brings the live stream; it connects on the first game read, not before");
  const restOnly = polyUsFromEnv({ POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: seed, POLYMARKET_US_STREAM: "0" });
  assert.equal(restOnly.client?.signed, true);
  assert.equal(restOnly.stream, null);
  assert.match(restOnly.note ?? "", /live stream is turned off .* up to 30 seconds old/);
  assert.equal(polyUsFromEnv({ POLYMARKET_KEY_ID: "kid", POLYMARKET_SECRET_KEY: seed }).client?.signed, true, "the venue's own SDK names are read too");
  assert.deepEqual(referenceSourcesFromEnv({ POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: seed }).sources.map((s) => s.id), ["long_short_v1"]);

  const pub = polyUsFromEnv({ REFERENCE_BOOK_POLY_US: "public" });
  assert.equal(pub.client?.signed, false);
  assert.equal(pub.stream, null, "no key, no stream");
  assert.match(pub.note ?? "", /public books \(no key set\)/);
  const viaRefs = referenceSourcesFromEnv({ REFERENCE_BOOK_POLY_US: "public" });
  assert.deepEqual(viaRefs.sources.map((s) => s.id), ["long_short_v1"]);
  assert.deepEqual(viaRefs.notes, ["reference book E: reading the public books (no key set); a copy up to 30 seconds old"]);

  for (const off of ["0", "false", "no", "off", "OFF"]) {
    assert.deepEqual(polyUsFromEnv({ REFERENCE_BOOK_POLY_US: off, POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: seed }), { client: null, stream: null, note: null }, `"${off}" turns it off whatever else is set`);
  }

  const half = polyUsFromEnv({ POLYMARKET_US_KEY_ID: "kid" });
  assert.equal(half.client, null);
  assert.match(half.note ?? "", /key id and the secret must both be set; off/);
  const halfPublic = polyUsFromEnv({ POLYMARKET_US_SECRET_KEY: seed, REFERENCE_BOOK_POLY_US: "public" });
  assert.equal(halfPublic.client?.signed, false);
  assert.match(halfPublic.note ?? "", /reading the public books without a key/);

  const bad = polyUsFromEnv({ POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: "c2hvcnQtc2VjcmV0" });
  assert.equal(bad.client, null);
  assert.match(bad.note ?? "", /key unusable \(the secret decodes to 12 bytes/);
  assert.ok(!(bad.note ?? "").includes("c2hvcnQ"), "the note never repeats the secret");
  assert.equal(polyUsFromEnv({ POLYMARKET_US_KEY_ID: "kid", POLYMARKET_US_SECRET_KEY: "c2hvcnQtc2VjcmV0", REFERENCE_BOOK_POLY_US: "public" }).client?.signed, false, "a bad key still leaves the public read on when it was asked for");

  // the record's words for it never name the venue; the operator's column does
  assert.ok(REFERENCE_BOOK_IDS.includes("long_short_v1"));
  assert.equal(REFERENCE_BOOK_WORDS.long_short_v1, "reference book E");
  assert.ok(!/poly/i.test(JSON.stringify(REFERENCE_BOOK_WORDS)));
  assert.deepEqual(VENUE_COLUMNS.find((c) => c.id === "long_short_v1"), { id: "long_short_v1", name: "Polymarket US", via: "direct", kind: "reference" });
});

test("the key check: set, accepted and the cash in cents; refused; not set; not read. The signed request carries the three headers and nothing of the secret", async () => {
  const seed = Buffer.alloc(32, 9).toString("base64");
  const venue = fakeVenue();
  const client = new PolyUsClient({ minIntervalMs: 0, fetchImpl: venue.fetchImpl, signer: polyUsSignerFromSecret("kid", seed), now: () => 1_762_810_000_123 });
  assert.deepEqual(await polyUsPreflight(client), {
    reading: true,
    keySet: true,
    keyAccepted: true,
    balances: [{ currency: "USD", currentBalanceCents: 25_050, buyingPowerCents: 24_025, openOrdersCents: 1025, lastUpdatedIso: "2026-11-10T20:00:00Z" }],
    books: "rest",
    can: { readBooks: true, readAccount: true, sendOrders: false },
  });
  assert.equal(venue.calls.length, 1);
  assert.equal(venue.calls[0].url, "api.polymarket.us/v1/account/balances");
  assert.equal(venue.calls[0].headers["X-PM-Access-Key"], "kid");
  assert.equal(venue.calls[0].headers["X-PM-Timestamp"], "1762810000123");
  assert.ok(venue.calls[0].headers["X-PM-Signature"].length > 80);
  assert.ok(!JSON.stringify(venue.calls).includes(seed), "the secret never leaves the process");

  const refused = await polyUsPreflight(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ balances: json({ message: "invalid signature" }, 401) }).fetchImpl, signer: polyUsSignerFromSecret("kid", seed) }));
  assert.deepEqual(refused, { reading: true, keySet: true, keyAccepted: false, problem: "UNAUTHORIZED: invalid signature", books: "rest", can: { readBooks: true, readAccount: false, sendOrders: false } });
  const down = await polyUsPreflight(new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ balances: json({}, 503) }).fetchImpl, signer: polyUsSignerFromSecret("kid", seed) }));
  assert.equal(down.keyAccepted, null, "an outage is not a refusal");
  assert.equal(down.problem, "HTTP_503: the venue answered 503");
  assert.deepEqual(await polyUsPreflight(new PolyUsClient({ minIntervalMs: 0, fetchImpl: venue.fetchImpl })), { reading: true, keySet: false, keyAccepted: null, books: "rest", can: { readBooks: true, readAccount: false, sendOrders: false } });
  assert.deepEqual(await polyUsPreflight(null), { reading: false, keySet: false, keyAccepted: null, books: "none", can: { readBooks: false, readAccount: false, sendOrders: false } });
});

test("shadow worker: the key check answers only to the operator and says in plain words what to do next", async () => {
  const dir = mkdtempSync(join(tmpdir(), "poly-us-"));
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = join(dir, "ledger.jsonl");
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  delete process.env.POLYMARKET_US_KEY_ID;
  delete process.env.POLYMARKET_US_SECRET_KEY;
  delete process.env.POLYMARKET_KEY_ID;
  delete process.env.POLYMARKET_SECRET_KEY;
  delete process.env.REFERENCE_BOOK_POLY_US;
  const worker = await import("../scripts/eventShadowWorker");
  const engine = { quoteOne: async () => ({ ok: false as const, code: "engine_not_ready", detail: "" }), listGameMarkets: async () => [] };
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  type Check = { ok: boolean; reading: boolean; keySet: boolean; keyAccepted: boolean | null; say: string; balances?: Array<{ buyingPowerCents: number }>; can: { sendOrders: boolean } };
  const check = async (): Promise<Check> => (await (await fetch(`${base}/api/shadow/polymarket-us/preflight?token=op-secret`)).json()) as Check;
  try {
    assert.equal((await fetch(`${base}/api/shadow/polymarket-us/preflight`)).status, 403, "operator only");

    // nothing in the env: not read, and the answer says where the key goes
    const off = await check();
    assert.equal(off.reading, false);
    assert.match(off.say, /Add POLYMARKET_US_KEY_ID and POLYMARKET_US_SECRET_KEY to this service's environment, then redeploy/);

    // a key the venue accepts
    const seed = Buffer.alloc(32, 9).toString("base64");
    worker.wireLockEngine({ ...engine, polyUs: new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl, signer: polyUsSignerFromSecret("kid", seed) }) });
    const on = await check();
    assert.equal(on.keyAccepted, true);
    assert.equal(on.balances?.[0].buyingPowerCents, 24_025);
    assert.equal(on.can.sendOrders, false, "this service sends no order there");
    assert.match(on.say, /The key is accepted/);
    assert.ok(!JSON.stringify(on).includes(seed));
    assert.deepEqual(forbiddenKeysIn({ say: on.say }), []);

    // a key the venue refuses
    worker.wireLockEngine({ ...engine, polyUs: new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue({ balances: json({ message: "invalid signature" }, 401) }).fetchImpl, signer: polyUsSignerFromSecret("kid", seed) }) });
    const refused = await check();
    assert.equal(refused.keyAccepted, false);
    assert.match(refused.say, /The venue refused the key/);

    // books read without a key
    worker.wireLockEngine({ ...engine, polyUs: new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl }) });
    const pub = await check();
    assert.equal(pub.reading, true);
    assert.equal(pub.keySet, false);
    assert.match(pub.say, /^Books are the venue's public copy, up to 30 seconds old\. Add POLYMARKET_US_KEY_ID and POLYMARKET_US_SECRET_KEY for the live stream and the account\.$/);

    // a key with the live stream up: the answer says the books are live
    const sock = fakeSocket();
    const stream = new PolyUsBookStream(polyUsSignerFromSecret("kid", seed), { socketFactory: () => sock });
    stream.want(MARKET.slug);
    await tick();
    sock.emit("open");
    worker.wireLockEngine({ ...engine, polyUs: new PolyUsClient({ minIntervalMs: 0, fetchImpl: fakeVenue().fetchImpl, signer: polyUsSignerFromSecret("kid", seed) }), polyUsStream: stream });
    const live = (await check()) as Check & { books: string; stream: { state: string; markets: number } };
    assert.equal(live.books, "stream");
    assert.equal(live.stream.state, "open");
    assert.equal(live.stream.markets, 1);
    assert.match(live.say, /^The key is accepted and the account is read\. Books come off the live stream\. No order is sent to this venue from here\.$/);
    assert.deepEqual(forbiddenKeysIn({ say: live.say }), []);
    stream.close();
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
