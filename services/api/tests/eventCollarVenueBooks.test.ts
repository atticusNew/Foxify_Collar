/**
 * Reference books: other regulated exchanges' winner markets read as price references beside the
 * hedge routes. Fake venues answer the two API dialects; the shadow prices, folds and reports.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PARTNER_WINNINGS_FEE,
  REFERENCE_BOOK_WORDS,
  clubFor,
  pairClubs,
  parseSignedLeagueCodes,
  partnerAskLevel,
  partnerSource,
  readReferenceBooks,
  referenceSourcesFromEnv,
  signedAsksForOpposing,
  signedFeeAppliesPreGame,
  signedLeagueCode,
  signedSource,
  type ReferenceBookSource,
} from "../src/eventCollar/crossVenue/venueBooks";
import { VenueApiError, VenueClient, signerFromPem, templateForLeague } from "../src/eventCollar/crossVenue/venuePositions";
import { PlaysClient, payoutMultiple } from "../src/eventCollar/crossVenue/venuePlays";
import { counterfactualsFor, type CounterfactualInputs } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { DEFAULT_CROSS_CONFIG, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import { appendShadowRecord, loadShadowPositions, summarizeCounterfactuals, summarizeShadow, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { renderShadowReportHtml } from "../scripts/eventShadowHtml";

const LOCK = "2026-09-20T17:00:00.000Z";
const NOW = new Date("2026-09-20T11:00:00.000Z");
const CFG = { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" as const };

function pair(): MatchedPair {
  return {
    league: "mlb",
    kalshi: {
      ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
      eventTicker: "KXMLBGAME-26SEP20NYYBOS",
      seriesTicker: "KXMLBGAME",
      title: "Yankees vs Red Sox",
      subtitle: "New York",
      status: "open",
      closeTime: LOCK,
      yesBidCents: 59,
      yesAskCents: 61,
      lastPriceCents: 60,
      volume: 1000,
      openInterest: 500,
      rulesPrimary: "",
    },
    pm: {
      eventSlug: "mlb-nyy-bos-2026-09-20",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      question: "New York Yankees vs. Boston Red Sox",
      conditionId: "0xdef",
      outcomes: ["Yankees", "Red Sox"],
      tokenIds: ["111", "222"],
      outcomePricesMilli: [600, 400],
      gameStartTime: LOCK,
      endDate: "2026-09-27T17:00:00Z",
      sportsMarketType: "moneyline",
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderMinSizeShares: 5,
      liquidityUsd: 9000,
      volumeUsd: 100,
    },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    gameStartTime: LOCK,
    parityNote: "both venues settle on the official MLB final result for this game",
    fingerprint: "mlb:NYY:BOS:2026-09-20",
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------------------
// team resolution
// ---------------------------------------------------------------------------

test("reference books: the pair's two clubs resolve by canonical name from the ticker and the second book's outcome", () => {
  const mlb = templateForLeague("mlb")!;
  assert.equal(clubFor(mlb, "Red Sox"), "Boston Red Sox");
  assert.equal(clubFor(mlb, "Boston Red Sox"), "Boston Red Sox");
  assert.equal(clubFor(mlb, "White Sox"), "Chicago White Sox");
  assert.equal(clubFor(mlb, "Sox"), null, "a shared nickname word names no club");
  assert.equal(clubFor(mlb, "New York"), null, "a shared city names no club");
  // the venue lists outcomes by team code; the templates' code tables answer those
  assert.equal(clubFor(mlb, "NYY"), "New York Yankees");
  assert.equal(clubFor(mlb, "BOS"), "Boston Red Sox");
  assert.equal(clubFor(mlb, "CWS"), "Chicago White Sox");
  const nfl = templateForLeague("nfl")!;
  assert.equal(clubFor(nfl, "Jets"), "New York Jets", "a four-letter nickname is a name, not a code");
  assert.equal(clubFor(nfl, "NYJ"), "New York Jets");
  assert.equal(clubFor(nfl, "NE"), "New England Patriots");
  const nba = templateForLeague("nba")!;
  assert.equal(clubFor(nba, "Heat"), "Miami Heat");
  assert.equal(clubFor(nba, "GS"), "Golden State Warriors", "an alias code the template knows");
  assert.equal(clubFor(nba, "GSW"), "Golden State Warriors");
  assert.equal(clubFor(nba, "ZZZ"), null);
  const clubs = pairClubs(pair());
  assert.deepEqual(clubs && [clubs.ours, clubs.opposing], ["New York Yankees", "Boston Red Sox"]);
  assert.equal(pairClubs({ ...pair(), league: "cricket" }), null, "a league without a template is not read");
});

// ---------------------------------------------------------------------------
// signed_v3: bids on ours are the asks on the opposing side; the fee folds in only when it applies
// ---------------------------------------------------------------------------

test("reference books: signed dialect turns the venue's bids on our club into asks on the opposing one, in exact milli units", () => {
  const book = {
    marketId: "m1",
    orders: {
      ours: [
        { orderId: "a", price: "0.620", qty: 2000 },
        { orderId: "b", price: "0.600", qty: 500 },
        { orderId: "c", price: "0", qty: 100 },
      ],
      theirs: [{ orderId: "d", price: "0.350", qty: 9000 }],
    },
  };
  // charged only once live: pre-game the fee is zero
  const preGame = signedAsksForOpposing(book, "ours", { coefficient: 0.06, charged: "WHEN_LIVE" });
  assert.deepEqual(preGame, [
    { priceMilli: 380, sizeMilli: 20_000 },
    { priceMilli: 400, sizeMilli: 5_000 },
  ]);
  // charged always: c x P x (1 - P) per contract, rounded up against the credit
  const always = signedAsksForOpposing(book, "ours", { coefficient: 0.06, charged: "ALWAYS" });
  assert.equal(always[0].priceMilli, 380 + Math.ceil((0.06 * 380 * 620) / 1000)); // 380 + 15 = 395
  assert.equal(always[1].priceMilli, 400 + Math.ceil((0.06 * 400 * 600) / 1000)); // 400 + 15 = 415
  assert.deepEqual(
    always.map((l) => l.sizeMilli),
    preGame.map((l) => l.sizeMilli),
    "the fee moves price, never size",
  );
  // unknown rule: taken as charged, the safe error for a reference
  assert.equal(signedFeeAppliesPreGame(undefined), true);
  assert.equal(signedFeeAppliesPreGame({ charged: "WHEN_LIVE" }), false);
  assert.equal(signedFeeAppliesPreGame({ charged: "ALWAYS" }), true);
  assert.equal(signedAsksForOpposing(book, "ours", undefined)[0].priceMilli, 395, "no fee object: the published coefficient, charged");
  assert.deepEqual(signedAsksForOpposing(book, "nobody", undefined), [], "no bids on our side: nothing to buy on theirs");
});

/**
 * The venue as it answers today: signed reads on /v3/catalog, unsigned on /v3/public/catalog, the
 * list wrapped as {items, next}, fee numbers as strings, outcomes named by team code.
 */
function signedFakeVenue(markets: unknown[], book: unknown, opts: { signed?: boolean; rateLimitAfter?: number } = {}) {
  const calls: Array<{ path: string; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ path: url.pathname + url.search, headers });
    if (opts.rateLimitAfter !== undefined && calls.length > opts.rateLimitAfter) return json({ code: "RATE_LIMIT_EXCEEDED", message: "slow down" }, 429);
    const isPublic = url.pathname.startsWith("/v3/public/catalog/");
    if (!isPublic && !headers["Novig-Key-Id"]) return json({ code: "SIGNATURE_REJECTED", message: "novig-key-id header is required" }, 401);
    const rest = url.pathname.replace(/^\/v3\/(public\/)?catalog/, "");
    if (rest === "/markets") return json({ items: markets, next: null });
    if (/^\/markets\/[^/]+\/book$/.test(rest)) return json(book);
    return json({ code: "not_found" }, 404);
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const client = new VenueClient({ host: "https://venue-a.test", ...(opts.signed === false ? {} : { signer: signerFromPem("kid", pem) }), fetchImpl });
  return { client, calls };
}

const SIGNED_MARKETS = [
  {
    marketId: "m-nyy-bos",
    eventId: "e1",
    description: "Yankees @ Red Sox",
    marketType: "MONEY",
    status: "OPEN",
    startsTs: Date.parse(LOCK),
    fee: { coefficient: "0.06", makerCredit: "0.5", charged: "WHEN_LIVE" },
    outcomes: [
      { outcomeId: "o-nyy", name: "NYY", status: "TBD" },
      { outcomeId: "o-bos", name: "BOS", status: "TBD" },
    ],
  },
  {
    marketId: "m-other",
    eventId: "e2",
    description: "Dodgers @ Giants",
    marketType: "MONEY",
    status: "OPEN",
    startsTs: Date.parse(LOCK),
    outcomes: [
      { outcomeId: "o-lad", name: "LAD", status: "TBD" },
      { outcomeId: "o-sf", name: "SF", status: "TBD" },
    ],
  },
];
const SIGNED_BOOK = {
  marketId: "m-nyy-bos",
  seq: 7,
  orders: {
    "o-nyy": [
      { orderId: "1", price: "0.620", qty: 30_000 },
      { orderId: "2", price: "0.610", qty: 50_000 },
    ],
    "o-bos": [{ orderId: "3", price: "0.370", qty: 10_000 }],
  },
};

test("reference books: the signed source finds the game in the league's winner markets, signs every read, and answers not_listed when the game is not there", async () => {
  const { client, calls } = signedFakeVenue(SIGNED_MARKETS, SIGNED_BOOK);
  const src = signedSource(client);
  const ref = await src.read(pair(), NOW);
  assert.equal(ref.id, "signed_v3");
  assert.ok(ref.book, JSON.stringify(ref));
  assert.deepEqual(ref.book.asks, [
    { priceMilli: 380, sizeMilli: 300_000 },
    { priceMilli: 390, sizeMilli: 500_000 },
  ]);
  // the opposing outcome's own bids, what a hedge there could leave against: 0.370 x 10,000 contracts; a game market charges no fee pre-game
  assert.deepEqual(ref.book.bids, [{ priceMilli: 370, sizeMilli: 100_000 }]);
  assert.equal(ref.book.tokenId, "signed_v3:m-nyy-bos");
  assert.deepEqual(
    ref.listing,
    { marketId: "m-nyy-bos", key: "e1", outcomes: { ours: { outcomeId: "o-nyy", name: "NYY" }, opposing: { outcomeId: "o-bos", name: "BOS" }, fee: { coefficient: 0.06, folded: false }, marketStatus: "OPEN" } },
    "the venue's market and event ids ride on the reference, with the two outcomes and the fee rule a hedge route there needs",
  );
  assert.equal(calls.length, 2, "one catalog read, one book read");
  assert.equal(calls[0].path, "/v3/catalog/markets?league=MLB&marketType=MONEY&limit=200");
  assert.equal(calls[1].path, "/v3/catalog/markets/m-nyy-bos/book");
  for (const c of calls) {
    assert.equal(c.headers["Novig-Key-Id"], "kid");
    assert.ok(c.headers["Novig-Timestamp"] && c.headers["Novig-Signature"], "every read is signed");
  }
  // the catalog is cached; the book is not
  await src.read(pair(), NOW);
  assert.equal(calls.length, 3);

  // a game the venue does not list
  const other = { ...pair(), kalshi: { ...pair().kalshi, ticker: "KXMLBGAME-26SEP20HOUSEA-HOU" }, pm: { ...pair().pm, outcomes: ["Astros", "Mariners"] } };
  const miss = await src.read(other, NOW);
  assert.ok(!miss.book && miss.reason === "not_listed");

  // same clubs on a different day is a different game
  const lastWeek = { ...pair(), gameStartTime: "2026-09-10T17:00:00.000Z" };
  const stale = await src.read(lastWeek, NOW);
  assert.ok(!stale.book && stale.reason === "not_listed");
});

test("reference books: without a key the signed dialect reads the venue's public catalog unsigned and gets the same book", async () => {
  const { client, calls } = signedFakeVenue(SIGNED_MARKETS, SIGNED_BOOK, { signed: false });
  assert.equal(client.isPublic, true);
  const ref = await signedSource(client).read(pair(), NOW);
  assert.ok(ref.book, JSON.stringify(ref));
  assert.deepEqual(ref.book.asks, [
    { priceMilli: 380, sizeMilli: 300_000 },
    { priceMilli: 390, sizeMilli: 500_000 },
  ]);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v3/public/catalog/markets?league=MLB&marketType=MONEY&limit=200", "/v3/public/catalog/markets/m-nyy-bos/book"],
  );
  for (const c of calls) assert.equal(c.headers["Novig-Key-Id"], undefined, "nothing is signed");
  await assert.rejects(() => client.listPositions(), /signed key/, "positions are not readable on the public catalog");
  // a venue that lists the game under full names instead of codes is matched the same way
  const named = SIGNED_MARKETS.map((m) => ({ ...m, outcomes: m.outcomes.map((o) => ({ ...o, name: o.name === "NYY" ? "New York Yankees" : o.name === "BOS" ? "Boston Red Sox" : o.name })) }));
  const ref2 = await signedSource(signedFakeVenue(named, SIGNED_BOOK, { signed: false }).client).read(pair(), NOW);
  assert.ok(ref2.book && ref2.book.asks.length === 2);
});

test("reference books: a venue answering with a code (rate limit, bad key) keeps the code as the reason; a dropped connection is unreachable", async () => {
  const limited = signedFakeVenue(SIGNED_MARKETS, SIGNED_BOOK, { signed: false, rateLimitAfter: 1 });
  const refs = await readReferenceBooks([signedSource(limited.client)], pair(), NOW);
  assert.equal(refs[0].reason, "venue_rate_limit_exceeded");
});

// ---------------------------------------------------------------------------
// partner_mm: every selection is an offer; price 1/k with the winnings fee folded, size from `value`
// ---------------------------------------------------------------------------

test("reference books: partner dialect prices a selection per effective $1 of payout with the 2% winnings fee folded in", () => {
  // -300: k = 1.3333, p = 0.75; a winning share nets 1 - 0.02 x 0.25 = 0.995
  const k = payoutMultiple(-300)!;
  const p = 1 / k;
  const eff = 1 - PARTNER_WINNINGS_FEE * (1 - p);
  const lvl = partnerAskLevel({ price: -300, value: 100 });
  assert.ok(lvl);
  assert.equal(lvl.priceMilli, Math.ceil((1000 * p) / eff)); // 754
  assert.equal(lvl.priceMilli, 754);
  assert.equal(lvl.sizeMilli, Math.floor(100 * k * eff * 1000)); // 132,666
  assert.ok(lvl.priceMilli > 750, "the fee makes the share dearer than the raw odds say");
  // +150: k = 2.5, p = 0.4, eff = 0.988
  const dog = partnerAskLevel({ price: 150, value: 40 });
  assert.ok(dog);
  assert.equal(dog.priceMilli, Math.ceil(400 / 0.988)); // 405
  assert.equal(dog.sizeMilli, Math.floor(40 * 2.5 * 0.988 * 1000));
  // quantity is only a fallback for value, as liability / (k - 1)
  const legacy = partnerAskLevel({ price: 150, quantity: 60 });
  assert.ok(legacy);
  assert.equal(legacy.sizeMilli, dog.sizeMilli, "quantity 60 at +150 is value 40");
  assert.equal(partnerAskLevel({ price: 150 }), null, "no size, no level");
  assert.equal(partnerAskLevel({ price: 50, value: 10 }), null, "odds between -99 and 99 are neither American nor decimal");
  assert.equal(partnerAskLevel({ value: 10 }), null);
});

function partnerFakeVenue() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/partner/auth/login") return json({ data: { access_token: "tok", access_expire_time: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", refresh_expire_time: Math.floor(Date.now() / 1000) + 86400 } });
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer tok") return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/partner/mm/get_tournaments") return json({ data: { tournaments: [{ id: 1, name: "MLB" }, { id: 2, name: "NHL" }] } });
    if (url.pathname === "/partner/mm/get_sport_events") {
      if (url.searchParams.get("tournament_id") !== "1") return json({ data: { sport_events: [] } });
      return json({
        data: {
          sport_events: [
            {
              event_id: 501,
              display_name: "New York Yankees vs Boston Red Sox",
              scheduled: LOCK,
              status: "not_started",
              tournament_id: 1,
              tournament_name: "MLB",
              competitors: [
                { id: 11, name: "New York Yankees", abbreviation: "NYY", side: "away" },
                { id: 12, name: "Boston Red Sox", abbreviation: "BOS", side: "home" },
              ],
            },
            {
              event_id: 502,
              display_name: "Houston Astros vs Seattle Mariners",
              scheduled: LOCK,
              competitors: [
                { id: 13, name: "Houston Astros" },
                { id: 14, name: "Seattle Mariners" },
              ],
            },
          ],
        },
      });
    }
    if (url.pathname === "/partner/v4/mm/get_markets") {
      if (url.searchParams.get("event_id") !== "501") return json({ data: { markets: [] } });
      return json({
        data: {
          markets: [
            { id: 9001, name: "Run Line", type: "spread", status: "open", selections: [[{ outcome_id: 1, competitor_id: 11, name: "New York Yankees", price: -110, value: 500 }]] },
            {
              id: 9002,
              name: "Moneyline",
              type: "moneyline",
              status: "open",
              selections: [
                [
                  { outcome_id: 21, competitor_id: 11, name: "New York Yankees", price: -150, value: 300 },
                  { outcome_id: 22, competitor_id: 11, name: "New York Yankees", price: -160, value: 200 },
                ],
                [
                  { outcome_id: 23, competitor_id: 12, name: "Boston Red Sox", price: 140, value: 100 },
                  { outcome_id: 24, competitor_id: 12, name: "Boston Red Sox", price: 130, value: 250 },
                  { outcome_id: 25, competitor_id: 12, name: "Boston Red Sox", price: 125 },
                ],
              ],
            },
          ],
        },
      });
    }
    return json({ error: "not_found" }, 404);
  };
  const client = new PlaysClient({ host: "https://venue-b.test/partner", accessKey: "ak", secretKey: "sk", fetchImpl });
  return { client, calls };
}

test("reference books: the partner source finds the event through the covered tournament, takes only the opposing club's moneyline offers, and sorts them best first", async () => {
  const { client, calls } = partnerFakeVenue();
  const src = partnerSource(client);
  const ref = await src.read(pair(), NOW);
  assert.ok(ref.book, JSON.stringify(ref));
  // +140 pays more per dollar than +130, so its share is the cheaper one and sorts first
  const l140 = partnerAskLevel({ price: 140, value: 100 })!;
  const l130 = partnerAskLevel({ price: 130, value: 250 })!;
  assert.deepEqual(ref.book.asks, [l140, l130], "two offers on the Red Sox with a size; the sizeless one is left out; cheaper first");
  assert.ok(l140.priceMilli < l130.priceMilli);
  assert.equal(ref.book.tokenId, "partner_mm:9002");
  assert.deepEqual(
    calls,
    ["POST /partner/auth/login", "GET /partner/mm/get_tournaments", "GET /partner/mm/get_sport_events?tournament_id=1", "GET /partner/v4/mm/get_markets?event_id=501"],
    "one login, then the catalog walk; the NHL tournament is never read",
  );
  // the catalog is cached for the next pair in the same league
  const other = { ...pair(), kalshi: { ...pair().kalshi, ticker: "KXMLBGAME-26SEP20HOUSEA-HOU" }, pm: { ...pair().pm, outcomes: ["Astros", "Mariners"] } };
  const ref2 = await src.read(other, NOW);
  assert.ok(!ref2.book && ref2.reason === "winner_market_not_listed", JSON.stringify(ref2));
  assert.equal(calls.length, 5, "tournaments and events came from cache; only the markets of the new event were read");
  const nfl = { ...pair(), league: "nfl", kalshi: { ...pair().kalshi, ticker: "KXNFLGAME-26SEP20HOUJAX-HOU" }, pm: { ...pair().pm, outcomes: ["Texans", "Jaguars"] } };
  const none = await src.read(nfl, NOW);
  assert.ok(!none.book && none.reason === "league_not_listed");
});

// ---------------------------------------------------------------------------
// configuration: fail closed; a venue that throws is unreachable, never a failed quote
// ---------------------------------------------------------------------------

test("reference books: nothing configured reads nothing; a half-set venue is a note, not a guess; both set, both read", () => {
  assert.deepEqual(referenceSourcesFromEnv({}), { sources: [], notes: [] });
  // the first venue's catalog is public: the host alone is a working reference
  const hostOnly = referenceSourcesFromEnv({ REFERENCE_BOOK_SIGNED_HOST: "https://a.test/" });
  assert.deepEqual(hostOnly.sources.map((s) => s.id), ["signed_v3"]);
  assert.match(hostOnly.notes[0], /public catalog/);
  const keyIdOnly = referenceSourcesFromEnv({ REFERENCE_BOOK_SIGNED_HOST: "https://a.test", REFERENCE_BOOK_SIGNED_KEY_ID: "kid" });
  assert.equal(keyIdOnly.sources.length, 0, "half a key is neither public nor signed");
  assert.match(keyIdOnly.notes[0], /host alone for public reads/);
  const half = referenceSourcesFromEnv({ REFERENCE_BOOK_BEARER_HOST: "https://b.test/partner", REFERENCE_BOOK_BEARER_ACCESS_KEY: "ak" });
  assert.equal(half.sources.length, 0);
  assert.match(half.notes[0], /reference book B/);
  assert.doesNotMatch(half.notes[0], /ak/, "a note never carries a credential");
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const both = referenceSourcesFromEnv({
    REFERENCE_BOOK_SIGNED_HOST: "https://a.test/",
    REFERENCE_BOOK_SIGNED_KEY_ID: "kid",
    REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM: pem,
    REFERENCE_BOOK_BEARER_HOST: "https://b.test/partner",
    REFERENCE_BOOK_BEARER_ACCESS_KEY: "ak",
    REFERENCE_BOOK_BEARER_SECRET_KEY: "sk",
  });
  assert.deepEqual(both.sources.map((s) => s.id), ["signed_v3", "partner_mm"]);
  assert.deepEqual(both.notes, []);
  const badKey = referenceSourcesFromEnv({ REFERENCE_BOOK_SIGNED_HOST: "https://a.test", REFERENCE_BOOK_SIGNED_KEY_ID: "kid", REFERENCE_BOOK_SIGNED_PRIVATE_KEY_PEM: "not a key" });
  assert.equal(badKey.sources.length, 0);
  assert.match(badKey.notes[0], /key unusable/);
});

test("reference books: readReferenceBooks runs every source and turns a throw into an unreachable reason", async () => {
  const ok: ReferenceBookSource = { id: "signed_v3", read: async () => ({ id: "signed_v3", book: { tokenId: "x", asks: [{ priceMilli: 380, sizeMilli: 1000 }], bids: [], minOrderSizeShares: 1, tickMilli: 1 } }) };
  const down: ReferenceBookSource = {
    id: "partner_mm",
    read: async () => {
      throw new Error("ECONNRESET to venue");
    },
  };
  const refs = await readReferenceBooks([ok, down], pair(), NOW);
  assert.equal(refs.length, 2);
  assert.ok(refs[0].book);
  assert.ok(!refs[1].book && refs[1].reason.startsWith("unreachable: ECONNRESET"));
  assert.deepEqual(await readReferenceBooks([], pair(), NOW), []);
});

// ---------------------------------------------------------------------------
// the shadow: references priced like a route, folded into the routing comparison, named neutrally
// ---------------------------------------------------------------------------

const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
];
const PM_NO_BOOK: PmBook = { tokenId: "222", asks: [{ priceMilli: 380, sizeMilli: 300_000 }, { priceMilli: 390, sizeMilli: 500_000 }], bids: [], minOrderSizeShares: 5, tickMilli: 10 };
/** a reference book a touch cheaper than the second book */
const REF_A_BOOK: PmBook = { tokenId: "signed_v3:m", asks: [{ priceMilli: 370, sizeMilli: 300_000 }, { priceMilli: 385, sizeMilli: 500_000 }], bids: [], minOrderSizeShares: 1, tickMilli: 1 };
/** a reference book too thin for the live size */
const REF_B_THIN: PmBook = { tokenId: "partner_mm:m", asks: [{ priceMilli: 360, sizeMilli: 20_000 }], bids: [], minOrderSizeShares: 1, tickMilli: 1 };

function inputs(overrides: Partial<CounterfactualInputs> = {}): CounterfactualInputs {
  return {
    route: "polymarket",
    ticker: "KXMLBGAME-26SEP20NYYBOS-NYY",
    lockTimeIso: LOCK,
    pair: pair(),
    markCents: 60,
    entryCents: 55,
    contracts: 150,
    now: NOW,
    config: CFG,
    books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS },
    ...overrides,
  };
}

test("reference books: counterfactualsFor prices the default tier on each reference exactly as a hedge route, with the config's second-book fee knobs off", () => {
  const live = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const refs = [
    { id: "signed_v3" as const, book: REF_A_BOOK },
    { id: "partner_mm" as const, book: REF_B_THIN },
  ];
  const cf = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references: refs } }), live);
  assert.ok(cf.references && cf.references.length === 2);
  const [a, b] = cf.references;
  assert.equal(a.id, "signed_v3");
  assert.ok(a.terms.ok, JSON.stringify(a));
  assert.equal(a.bestAskMilli, 370);
  assert.equal(a.depthMilli, 800_000);
  const expectA = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: REF_A_BOOK, config: CFG });
  assert.ok(expectA.ok);
  assert.equal(a.terms.creditCents, expectA.creditCents, "the reference is the cross-venue pricer on the reference book");
  assert.ok(a.terms.creditCents > live.creditCents, "a cheaper book funds a bigger credit");
  assert.ok(a.terms.evCostBps < live.evCostBps);
  // the config's hedge fee belongs to the second book; a reference carries its own fee in its prices
  const feeCfg = { ...CFG, hedgeFeeFlatCents: 50 };
  const cfFee = counterfactualsFor(inputs({ config: feeCfg, books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references: refs } }), live);
  assert.equal(cfFee.references![0].terms.ok && cfFee.references![0].terms.creditCents, a.terms.creditCents, "second-book fee knobs do not touch the reference");
  assert.equal(b.id, "partner_mm");
  assert.ok(!b.terms.ok && b.terms.refused === "book_too_thin", JSON.stringify(b));
  assert.equal(b.bestAskMilli, 360, "a listed book keeps its best ask even when it cannot fund the size");

  // unlisted keeps the venue's reason; an empty book is a book
  const cf2 = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, references: [{ id: "signed_v3", book: null, reason: "not_listed" }, { id: "partner_mm", book: { ...REF_B_THIN, asks: [] } }] } }), live);
  assert.ok(!cf2.references![0].terms.ok && cf2.references![0].terms.refused === "not_listed");
  assert.equal(cf2.references![0].bestAskMilli, null);
  assert.ok(!cf2.references![1].terms.ok && cf2.references![1].terms.refused === "book_empty");
  // no references read: the field is absent, as on every record before this existed
  assert.equal(counterfactualsFor(inputs(), live).references, undefined);
  assert.equal(counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, references: [] } }), live).references, undefined);
});

test("reference books: the routing comparison carries one row per reference, counts unlisted apart from refused, and the page never names a venue", () => {
  const live = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, noBook: PM_NO_BOOK, config: CFG });
  assert.ok(live.ok);
  const ladder = quoteLadderWrap({ pair: { kalshi: { ticker: "KXMLBGAME-26SEP20NYYBOS-NYY" }, gameStartTime: LOCK }, markCents: 60, entryCents: 55, contracts: 150, now: NOW, noAsks: NO_ASKS, config: CFG });
  assert.ok(ladder.ok);
  const withRefs = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references: [{ id: "signed_v3", book: REF_A_BOOK }, { id: "partner_mm", book: REF_B_THIN }] } }), live);
  const unlisted = counterfactualsFor(inputs({ books: { pmNoBook: PM_NO_BOOK, noAsks: NO_ASKS, references: [{ id: "signed_v3", book: null, reason: "not_listed" }, { id: "partner_mm", book: null, reason: "unreachable: timeout" }] } }), live);
  const before = counterfactualsFor(inputs(), live);
  const a = withRefs.references![0].terms;
  assert.ok(a.ok);

  const dir = mkdtempSync(join(tmpdir(), "shadow-refs-"));
  const path = join(dir, "ledger.jsonl");
  const open = (ticker: string, at: string, cf: typeof withRefs, extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord => ({
    type: "open",
    at,
    ticker,
    kind: "sports",
    league: "mlb",
    sideName: "Yankees",
    eventTitle: "Yankees to win",
    eventTimeIso: LOCK,
    contracts: 150,
    markCents: 60,
    floorCents: live.floorCents,
    capCents: live.capCents,
    creditCents: live.creditCents,
    evCostBps: live.evCostBps,
    route: "polymarket",
    feesCents: live.feesCents,
    takeCents: live.takeCents,
    hedgeCostCents: live.hedge.costCents + live.feesCents,
    hedgeUnitsMilli: live.hedge.venue === "polymarket" ? live.hedge.sharesMilli : 0,
    tier: live.tier,
    takeRule: live.takeRule,
    takeShareCents: live.takeShareCents,
    takeMinimumCents: live.takeMinimumCents,
    counterfactuals: cf,
    ...extra,
  });
  appendShadowRecord(path, open("REF-SETTLED", "2026-09-20T11:00:00.000Z", withRefs));
  appendShadowRecord(path, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "REF-SETTLED", result: "no" });
  appendShadowRecord(path, open("REF-OPEN", "2026-09-20T11:01:00.000Z", withRefs));
  appendShadowRecord(path, open("REF-UNLISTED", "2026-09-20T11:02:00.000Z", unlisted));
  appendShadowRecord(path, open("BEFORE", "2026-09-20T10:00:00.000Z", before));
  appendShadowRecord(path, open("CRYPTO", "2026-09-20T11:03:00.000Z", withRefs, { kind: "crypto", league: "crypto", route: "kalshi_self" }));

  const positions = loadShadowPositions(path);
  const r = summarizeCounterfactuals(positions).routes;
  assert.equal(r.references.length, 2);
  const [bRow, aRow] = r.references; // sorted by id: partner_mm, signed_v3
  assert.equal(aRow.id, "signed_v3");
  assert.equal(aRow.positions, 3, "three sports opens read the reference; the record before it and the crypto strike are out");
  assert.equal(aRow.listed, 2);
  assert.equal(aRow.unlisted, 1);
  assert.equal(aRow.quoted, 2);
  assert.equal(aRow.refused, 0, "unlisted is coverage, never a refusal on price");
  assert.equal(aRow.settled, 1);
  assert.equal(aRow.creditsCents, 2 * a.creditCents);
  assert.equal(aRow.bothQuoted, 2);
  assert.equal(aRow.extraEvBps, Math.round(a.evCostBps - live.evCostBps));
  assert.ok((aRow.extraEvBps as number) < 0, "the cheaper reference quotes less EV cost");
  assert.equal(aRow.creditDeltaCents, 2 * (a.creditCents - live.creditCents));
  assert.ok(aRow.creditDeltaCents > 0, "users would have been paid more on that book");
  assert.equal(bRow.id, "partner_mm");
  assert.equal(bRow.listed, 2);
  assert.equal(bRow.unlisted, 1);
  assert.equal(bRow.quoted, 0);
  assert.equal(bRow.refused, 2, "listed but too thin for the size: that is a refusal on price");
  assert.equal(bRow.bothQuoted, 0);
  assert.equal(bRow.extraEvBps, null);

  const s = summarizeShadow(positions);
  const html = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: s });
  assert.ok(html.includes("<h2>Routing, measured</h2>"));
  assert.ok(html.includes(`${REFERENCE_BOOK_WORDS.signed_v3}<`) || html.includes(`${REFERENCE_BOOK_WORDS.signed_v3} <span`), "a row per reference under its neutral name");
  assert.ok(html.includes("listed 2 of 3, read only"));
  assert.ok(html.includes("reference book A listed 2 of the 3 games it was read for and funded 2"));
  assert.ok(html.includes("reference book B listed 2 of the 3 games it was read for and funded none of them at the live size."));
  assert.ok(html.includes("Reference books are other regulated US exchanges"));
  assert.doesNotMatch(html, /novig|prophet/i, "the page never names a reference venue");
  assert.doesNotMatch(html, /\u2014/, "no em dashes");
  // JSON the operator exports carries the dialect ids, not venue names; the hedge route's own code
  // ("prophetx", "novig": venues the record hedges on and names) are the words that are not a reference's
  assert.doesNotMatch(JSON.stringify(positions).replace(/"(prophetx|novig)":/g, '"":'), /novig|prophet/i);
  // a record with no references renders the card as before
  const plain = renderShadowReportHtml({ atIso: "2026-09-21T00:00:00.000Z", summary: summarizeShadow(loadShadowPositions(path).filter((p) => p.ticker === "BEFORE")) });
  assert.ok(!plain.includes("reference book"));
});

test("reference books: the signed source's catalog probe asks the league two ways and tallies what came back, so a run of not_listed can be told from a league code the venue spells differently", async () => {
  // the venue spells basketball "NBA_REG" and ignores an unknown league filter with an empty page
  const nbaMarkets = [
    {
      marketId: "m-bos-nyk",
      eventId: "e9",
      description: "Celtics @ Knicks",
      marketType: "MONEY",
      status: "OPEN",
      league: "NBA_REG",
      startsTs: Date.parse(LOCK),
      outcomes: [
        { outcomeId: "o-bos", name: "BOS", status: "TBD" },
        { outcomeId: "o-nyk", name: "NYK", status: "TBD" },
      ],
    },
    {
      marketId: "m-bos-nyk-spread",
      eventId: "e9",
      description: "Celtics @ Knicks spread",
      marketType: "SPREAD",
      status: "OPEN",
      league: "NBA_REG",
      startsTs: Date.parse(LOCK),
      outcomes: [
        { outcomeId: "o-bos-s", name: "BOS -3.5", status: "TBD" },
        { outcomeId: "o-nyk-s", name: "NYK +3.5", status: "TBD" },
      ],
    },
    {
      marketId: "m-settled",
      eventId: "e8",
      description: "Lakers @ Suns",
      marketType: "MONEY",
      status: "SETTLED",
      league: "NBA_REG",
      startsTs: Date.parse(LOCK) - 86_400_000,
      outcomes: [
        { outcomeId: "o-lal", name: "LAL", status: "WON" },
        { outcomeId: "o-phx", name: "PHX", status: "LOST" },
      ],
    },
  ];
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const league = url.searchParams.get("league");
    if (league === "NBA") return json({ items: [], next: null });
    const all = [...SIGNED_MARKETS.map((m) => ({ ...m, league: "MLB" })), ...nbaMarkets];
    return json({ items: all.filter((m) => !league || m.league === league), next: null });
  };
  const client = new VenueClient({ host: "https://venue-a.test", fetchImpl });
  const src = signedSource(client);
  assert.ok(src.catalog, "the signed dialect has a catalog to ask");
  const probe = await src.catalog("nba");
  assert.equal(probe.id, "signed_v3");
  assert.equal(probe.league, "nba");
  assert.equal(probe.queries.length, 2);
  const [filtered, all] = probe.queries;
  assert.equal(filtered.query, "league=NBA&marketType=MONEY&limit=200", "the reader's own query first");
  assert.deepEqual({ count: filtered.count, winners: filtered.winners, ourClubs: filtered.ourClubs }, { count: 0, winners: 0, ourClubs: 0 }, "the reader sees nothing under our code");
  assert.equal(all.query, "marketType=MONEY&limit=200");
  assert.equal(all.count, 5);
  assert.equal(all.winners, 3, "winner markets not settled: two MLB, one NBA; the spread and the settled game are not");
  assert.equal(all.ourClubs, 1, "one of them names two NBA clubs");
  assert.deepEqual(all.leaguesSeen, { MLB: 2, NBA_REG: 3 }, "the venue's own league words, by count: the code to try");
  assert.equal(all.sample[0].marketId, "m-bos-nyk", "our clubs' games first in the sample");
  assert.deepEqual(all.sample[0].outcomes, ["BOS", "NYK"]);
  assert.equal(all.sample[0].league, "NBA_REG");
  assert.equal(all.sample[0].startsIso, LOCK);
  assert.equal(all.sample[0].eventId, "e9");
  assert.equal(all.sample.length, 5);
  for (const c of calls) assert.ok(c.startsWith("/v3/public/catalog/markets?"), c);
  assert.ok(!JSON.stringify(probe).includes("venue-a.test"), "no host in the probe");

  // a venue that refuses the unfiltered query keeps the error on that query only
  const refusing: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.searchParams.get("league")) return json({ code: "LEAGUE_REQUIRED", message: "league is required" }, 400);
    return json({ items: nbaMarkets.filter((m) => m.marketType === "MONEY"), next: null });
  };
  const p2 = await signedSource(new VenueClient({ host: "https://venue-a.test", fetchImpl: refusing })).catalog!("nba");
  assert.equal(p2.queries[0].count, 2);
  assert.equal(p2.queries[0].winners, 1);
  assert.equal(p2.queries[1].count, null);
  assert.match(p2.queries[1].error ?? "", /400 LEAGUE_REQUIRED/);
  assert.deepEqual(p2.queries[1].sample, []);
});

// ---------------------------------------------------------------------------
// a league the venue spells differently: the alias from the env, else the unfiltered fallback
// ---------------------------------------------------------------------------

function nbaPair(): MatchedPair {
  const base = pair();
  return {
    ...base,
    league: "nba",
    kalshi: { ...base.kalshi, ticker: "KXNBAGAME-26SEP20BOSNYK-BOS", eventTicker: "KXNBAGAME-26SEP20BOSNYK", seriesTicker: "KXNBAGAME", title: "Celtics vs Knicks" },
    pm: { ...base.pm, eventSlug: "nba-bos-nyk-2026-09-20", eventTitle: "Boston Celtics vs. New York Knicks", question: "Boston Celtics vs. New York Knicks", outcomes: ["Celtics", "Knicks"] },
    parityNote: "both venues settle on the official NBA final result for this game",
    fingerprint: "nba:BOS:NYK:2026-09-20",
  };
}

const NBA_REG_MARKET = {
  marketId: "m-bos-nyk",
  eventId: "e9",
  description: "Celtics @ Knicks",
  marketType: "MONEY",
  status: "OPEN",
  league: "NBA_REG",
  startsTs: Date.parse(LOCK),
  outcomes: [
    { outcomeId: "o-bos", name: "BOS", status: "TBD" },
    { outcomeId: "o-nyk", name: "NYK", status: "TBD" },
  ],
};
const NBA_BOOK = { marketId: "m-bos-nyk", seq: 1, orders: { "o-bos": [{ orderId: "1", price: "0.550", qty: 20_000 }], "o-nyk": [] } };

/** a venue that files basketball under NBA_REG and answers an unknown league filter with an empty page */
function nbaRegVenue() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (/\/book$/.test(url.pathname)) return json(NBA_BOOK);
    const league = url.searchParams.get("league");
    const all = [...SIGNED_MARKETS.map((m) => ({ ...m, league: "MLB" })), NBA_REG_MARKET];
    return json({ items: all.filter((m) => !league || m.league === league), next: null });
  };
  return { client: new VenueClient({ host: "https://venue-a.test", fetchImpl }), calls, fetchImpl };
}

test("reference books: a league the venue spells differently is found on the unfiltered page before it is called unlisted; the env alias asks under the venue's word directly", async () => {
  // no alias: the league's own query is empty, the whole winner slate is searched once, the game is found
  const plain = nbaRegVenue();
  const ref = await signedSource(plain.client).read(nbaPair(), NOW);
  assert.ok(ref.book, JSON.stringify(ref));
  assert.deepEqual(ref.book.asks, [{ priceMilli: 450 + Math.ceil((0.06 * 450 * 550) / 1000), sizeMilli: 200_000 }]);
  assert.deepEqual(ref.listing, { marketId: "m-bos-nyk", key: "e9", outcomes: { ours: { outcomeId: "o-bos", name: "BOS" }, opposing: { outcomeId: "o-nyk", name: "NYK" }, fee: { coefficient: 0.06, folded: true }, marketStatus: "OPEN" } });
  assert.deepEqual(plain.calls, [
    "/v3/public/catalog/markets?league=NBA&marketType=MONEY&limit=200",
    "/v3/public/catalog/markets?marketType=MONEY&limit=200",
    "/v3/public/catalog/markets/m-bos-nyk/book",
  ]);
  // the unfiltered page is cached like the league's: a second game costs no new catalog read
  const other = { ...nbaPair(), kalshi: { ...nbaPair().kalshi, ticker: "KXNBAGAME-26SEP20LALPHX-LAL" }, pm: { ...nbaPair().pm, outcomes: ["Lakers", "Suns"] } };
  const miss = await signedSource(plain.client).read(other, NOW);
  assert.ok(!miss.book && miss.reason === "not_listed");
  assert.equal(plain.calls.length, 3, "both pages were cached");

  // the MLB game is still found under its own code with no second query
  const mlb = nbaRegVenue();
  const mref = await signedSource(mlb.client).read(pair(), NOW);
  assert.ok(mref.book);
  assert.equal(mlb.calls[0], "/v3/public/catalog/markets?league=MLB&marketType=MONEY&limit=200");
  assert.equal(mlb.calls.length, 2, "a league the venue spells our way never asks the unfiltered page");

  // the alias: the venue's own word in the first query, no fallback needed
  const aliased = nbaRegVenue();
  const aref = await signedSource(aliased.client, { leagueCodes: { nba: "NBA_REG" } }).read(nbaPair(), NOW);
  assert.ok(aref.book);
  assert.deepEqual(aliased.calls, ["/v3/public/catalog/markets?league=NBA_REG&marketType=MONEY&limit=200", "/v3/public/catalog/markets/m-bos-nyk/book"]);
  // and the catalog probe asks under the alias too
  const probe = await signedSource(aliased.client, { leagueCodes: { nba: "NBA_REG" } }).catalog!("nba");
  assert.equal(probe.queries[0].query, "league=NBA_REG&marketType=MONEY&limit=200");
  assert.equal(probe.queries[0].ourClubs, 1);

  // fallback off: the league's own answer is final
  const strict = nbaRegVenue();
  const sref = await signedSource(strict.client, { unfilteredFallback: false }).read(nbaPair(), NOW);
  assert.ok(!sref.book && sref.reason === "not_listed");
  assert.equal(strict.calls.length, 1);
});

test("reference books: REFERENCE_BOOK_SIGNED_LEAGUES is league=CODE pairs; a bad entry is a note, an unknown league is dropped, the rest reach the source", async () => {
  assert.equal(signedLeagueCode("nba"), "NBA");
  assert.equal(signedLeagueCode("NBA", { nba: "NBA_REG" }), "NBA_REG");
  const parsed = parseSignedLeagueCodes(" nba=NBA_REG, mlb=MLB wnba=HOOPS bogus cfb= ");
  assert.deepEqual(parsed.codes, { nba: "NBA_REG", mlb: "MLB" });
  assert.equal(parsed.notes.length, 3);
  assert.match(parsed.notes[0], /"wnba" is not one we cover/);
  assert.match(parsed.notes[1], /"bogus" is not league=CODE/);
  assert.match(parsed.notes[2], /"cfb=" is not league=CODE/);
  assert.deepEqual(parseSignedLeagueCodes(undefined), { codes: {}, notes: [] });

  const venue = nbaRegVenue();
  const fromEnv = referenceSourcesFromEnv({ REFERENCE_BOOK_SIGNED_HOST: "https://venue-a.test", REFERENCE_BOOK_SIGNED_LEAGUES: "nba=NBA_REG,xyz=1" }, { fetchImpl: venue.fetchImpl });
  assert.deepEqual(fromEnv.sources.map((s) => s.id), ["signed_v3"]);
  assert.ok(fromEnv.notes.some((n) => /"xyz" is not one we cover/.test(n)), fromEnv.notes.join(" | "));
  const probe = await fromEnv.sources[0].catalog!("nba");
  assert.equal(probe.queries[0].query, "league=NBA_REG&marketType=MONEY&limit=200", "the alias from the env reaches the probe");
  assert.ok(venue.calls.some((c) => c.includes("league=NBA_REG")));
});

test("reference books: a signed key the venue's catalog refuses (account locked) falls back to the public catalog for one cache window; positions do not", async () => {
  const calls: Array<{ path: string; signed: boolean }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path: url.pathname + url.search, signed: Boolean(headers["Novig-Key-Id"]) });
    if (url.pathname.startsWith("/v3/catalog/") || url.pathname.startsWith("/v3/portfolio/")) return json({ code: "ACCOUNT_LOCKED", message: "The account is locked out of trading." }, 423);
    const rest = url.pathname.replace(/^\/v3\/public\/catalog/, "");
    if (rest === "/markets") return json({ items: SIGNED_MARKETS, next: null });
    if (/\/book$/.test(rest)) return json(SIGNED_BOOK);
    return json({ code: "not_found" }, 404);
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const client = new VenueClient({ host: "https://venue-a.test", signer: signerFromPem("kid", pem), fetchImpl });
  assert.equal(client.isPublic, false);
  assert.equal(client.catalogFallbackNote, null);

  const src = signedSource(client);
  const ref = await src.read(pair(), NOW);
  assert.ok(ref.book, JSON.stringify(ref));
  assert.equal(ref.book.asks.length, 2, "the public catalog carries the same book");
  assert.deepEqual(
    calls.map((c) => `${c.signed ? "S " : "P "}${c.path}`),
    [
      "S /v3/catalog/markets?league=MLB&marketType=MONEY&limit=200",
      "P /v3/public/catalog/markets?league=MLB&marketType=MONEY&limit=200",
      "P /v3/public/catalog/markets/m-nyy-bos/book",
    ],
    "one refused signed read, then public reads, the book not retried on the signed path",
  );
  assert.match(client.catalogFallbackNote ?? "", /423 ACCOUNT_LOCKED.*public catalog/);

  // the probe says so, and its queries answer from the public catalog
  const probe = await src.catalog!("mlb");
  assert.equal(probe.queries[0].count, 2);
  assert.equal(probe.queries[0].error, undefined);
  assert.match(probe.note ?? "", /ACCOUNT_LOCKED/);
  assert.ok(!JSON.stringify(probe).includes("kid"), "the key id is not in the probe");

  // positions stay on the signed path and keep the venue's answer
  await assert.rejects(() => client.listPositions(), (err: unknown) => err instanceof VenueApiError && err.status === 423 && err.code === "ACCOUNT_LOCKED");

  // a plain 500 on the signed catalog is not a key problem and is not retried
  const flaky: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/v3/catalog/")) return json({ code: "INTERNAL", message: "oops" }, 500);
    return fetchImpl(input, init);
  };
  const c2 = new VenueClient({ host: "https://venue-a.test", signer: signerFromPem("kid", pem), fetchImpl: flaky });
  const r2 = await readReferenceBooks([signedSource(c2)], pair(), NOW);
  assert.equal(r2[0].reason, "venue_internal");
  assert.equal(c2.catalogFallbackNote, null);
});
