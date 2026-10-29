import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evCostBps,
  quoteCrossWrap,
  walkPmAsks,
  type CrossPricerInputs,
} from "../src/eventCollar/crossVenue/crossVenuePricer";
import {
  decimalToMilli,
  normalizeGammaTime,
  parsePmBook,
  parsePmMarket,
} from "../src/eventCollar/crossVenue/polymarketPublic";
import {
  candidateSlugs,
  gameDateAgrees,
  matchKalshiMarket,
  outcomeNameMatches,
  parseGameTicker,
  shiftIsoDate,
  sideNameVerified,
  splitTeamCodes,
  startTimesAgree,
} from "../src/eventCollar/crossVenue/eventMatcher";
import { LEAGUE_TEMPLATES, templateForSeries } from "../src/eventCollar/crossVenue/resolutionWhitelist";
import {
  DEFAULT_CROSS_CONFIG,
  type CrossSearchConfig,
  type MatchedPair,
  type PmBook,
} from "../src/eventCollar/crossVenue/types";
import type { KalshiMarket } from "../src/eventCollar/types";

// ── EV cost of protection (the scanner's honesty number) ──

test("evCostBps: hand-computed against the live SEA and BTC examples", () => {
  // Mariners quote: mark 60, floor 52 / cap 63, credit 69c on 150 contracts.
  // nakedEV = 900000 centi-cents; protectedEV = 9519*60 + 7869*40 = 885900
  // -> cost 14100/900000 = 156.7 bps (~1.6% of EV: cheap insurance)
  assert.equal(evCostBps(60, 52, 63, 69, 150), 157);

  // The founder's OKX screenshot: mark 42, floor 12 / cap 47, credit $3.81.
  // -> 3038 bps (~30.4% of EV: expensive insurance, honestly displayed)
  assert.equal(evCostBps(42, 12, 47, 381, 150), 3038);

  // Fat venue gap: a credit large enough that protection BEATS the naked hold.
  assert.equal(evCostBps(50, 48, 55, 500, 150), -967);

  // Degenerate mark never divides by zero.
  assert.equal(evCostBps(0, 10, 20, 5, 150), 0);
});

// ── exact decimal parsing ──

test("decimalToMilli: exact, directional, rejects garbage", () => {
  assert.equal(decimalToMilli("0.535", false), 535);
  assert.equal(decimalToMilli("0.5355", false), 535); // truncate against depth
  assert.equal(decimalToMilli("0.5355", true), 536); // round up against cost
  assert.equal(decimalToMilli("1025.01", false), 1025010);
  assert.equal(decimalToMilli("1", false), 1000);
  assert.equal(decimalToMilli("0.99", true), 990);
  assert.equal(decimalToMilli("abc", false), -1);
  assert.equal(decimalToMilli(undefined, false), -1);
});

test("normalizeGammaTime: gamma's space-separated form becomes ISO", () => {
  assert.equal(normalizeGammaTime("2026-09-13 18:20:00+00"), "2026-09-13T18:20:00.000Z");
  assert.equal(normalizeGammaTime("2026-09-13T18:20:00Z"), "2026-09-13T18:20:00.000Z");
  assert.equal(normalizeGammaTime("not a time"), null);
  assert.equal(normalizeGammaTime(undefined), null);
});

// ── book parsing: CLOB sends worst-first; we sort best-first ──

test("parsePmBook sorts asks ascending and bids descending", () => {
  const book = parsePmBook(
    {
      asks: [
        { price: "0.99", size: "1025.01" },
        { price: "0.55", size: "300" },
        { price: "0.60", size: "10" },
      ],
      bids: [
        { price: "0.01", size: "1032.19" },
        { price: "0.53", size: "200" },
        { price: "0.40", size: "50" },
      ],
      min_order_size: 5,
      tick_size: "0.01",
    },
    "tok",
  );
  assert.deepEqual(
    book.asks.map((l) => l.priceMilli),
    [550, 600, 990],
  );
  assert.deepEqual(
    book.bids.map((l) => l.priceMilli),
    [530, 400, 10],
  );
  assert.equal(book.asks[0].sizeMilli, 300_000);
  assert.equal(book.minOrderSizeShares, 5);
  assert.equal(book.tickMilli, 10);
});

test("parsePmMarket: JSON-string list fields and game start time", () => {
  const m = parsePmMarket(
    {
      question: "Pittsburgh Pirates vs. Chicago Cubs",
      conditionId: "0xabc",
      outcomes: '["Pittsburgh Pirates", "Chicago Cubs"]',
      clobTokenIds: '["111", "222"]',
      outcomePrices: '["0.465", "0.535"]',
      gameStartTime: "2026-09-13 18:20:00+00",
      endDate: "2026-09-20T18:20:00Z",
      sportsMarketType: "moneyline",
      active: true,
      closed: false,
      acceptingOrders: true,
      negRisk: false,
      orderMinSize: 5,
      liquidity: "9156.9685",
      volume: "33",
    },
    "mlb-pit-chc-2026-09-13",
    "Pittsburgh Pirates vs. Chicago Cubs",
  );
  assert.deepEqual(m.outcomes, ["Pittsburgh Pirates", "Chicago Cubs"]);
  assert.deepEqual(m.tokenIds, ["111", "222"]);
  assert.deepEqual(m.outcomePricesMilli, [465, 535]);
  assert.equal(m.gameStartTime, "2026-09-13T18:20:00.000Z");
  assert.equal(m.sportsMarketType, "moneyline");
});

// ── matcher: fingerprints, aliases, guards ──

test("parseGameTicker: MLB with start time, NFL without", () => {
  const mlb = templateForSeries("KXMLBGAME");
  assert.ok(mlb);
  const p1 = parseGameTicker("KXMLBGAME-26SEP131420PITCHC-PIT", mlb);
  assert.ok(p1);
  assert.equal(p1.dateIso, "2026-09-13");
  assert.equal(p1.hhmm, "1420");
  assert.equal(p1.awayCode, "PIT");
  assert.equal(p1.homeCode, "CHC");
  assert.equal(p1.sideCode, "PIT");

  const nfl = templateForSeries("KXNFLGAME");
  assert.ok(nfl);
  const p2 = parseGameTicker("KXNFLGAME-26SEP21NYGLAR-LAR", nfl);
  assert.ok(p2);
  assert.equal(p2.dateIso, "2026-09-21");
  assert.equal(p2.hhmm, null);
  assert.equal(p2.awayCode, "NYG");
  assert.equal(p2.homeCode, "LAR");

  assert.equal(parseGameTicker("KXBTCD-26SEP1117-T76999.99", mlb), null);
});

test("splitTeamCodes: unique split or refuse", () => {
  assert.deepEqual(splitTeamCodes("PITCHC", ["PIT", "CHC", "SEA"]), {
    away: "PIT",
    home: "CHC",
  });
  // ambiguous concatenation must refuse, not guess
  assert.equal(splitTeamCodes("ABB", ["A", "AB", "B", "BB"]), null);
});

test("candidateSlugs expands venue code aliases in order, on the ticker date then the next UTC date", () => {
  const mlb = templateForSeries("KXMLBGAME");
  assert.ok(mlb);
  const parsed = parseGameTicker("KXMLBGAME-26SEP131610TEXAZ-AZ", mlb);
  assert.ok(parsed);
  assert.deepEqual(candidateSlugs(parsed, mlb), [
    "mlb-tex-az-2026-09-13",
    "mlb-tex-ari-2026-09-13",
    "mlb-tex-az-2026-09-14",
    "mlb-tex-ari-2026-09-14",
  ]);
  assert.equal(shiftIsoDate("2026-09-30", 1), "2026-10-01");
  assert.equal(shiftIsoDate("2026-12-31", 1), "2027-01-01");
});

test("gameDateAgrees: the Polymarket game must fall on the ticker's ET date", () => {
  const nfl = templateForSeries("KXNFLGAME");
  assert.ok(nfl);
  // Sunday-night kickoff 8:20pm ET Sep 20 = 00:20Z Sep 21 (Polymarket slugs it 09-21)
  const snf = parseGameTicker("KXNFLGAME-26SEP20INDKC-KC", nfl);
  assert.ok(snf);
  assert.ok(gameDateAgrees(snf, "2026-09-21T00:20:00.000Z"));
  // 1pm ET same day
  assert.ok(gameDateAgrees(snf, "2026-09-20T17:00:00.000Z"));
  // the same matchup a day later must NOT pair through the two-date slug search
  assert.ok(!gameDateAgrees(snf, "2026-09-21T17:00:00.000Z"));
  assert.ok(!gameDateAgrees(snf, "2026-09-19T23:00:00.000Z"));
  assert.ok(!gameDateAgrees(snf, "not a date"));
});

test("outcomeNameMatches: prefix, token, and unverifiable-short cases", () => {
  assert.ok(outcomeNameMatches("Chicago C", "Chicago Cubs"));
  assert.ok(!outcomeNameMatches("Chicago C", "Chicago White Sox"));
  assert.ok(outcomeNameMatches("San Francisco", "San Francisco Giants"));
  assert.ok(outcomeNameMatches("Pittsburgh", "Pittsburgh Pirates"));
  // too short to verify (normalizes to "as"): defer to positional mapping
  assert.ok(outcomeNameMatches("A's", "Athletics"));
});

test("sideNameVerified: city-style Kalshi subtitles and nickname-style Polymarket outcomes both verify against the club name", () => {
  const mlb = templateForSeries("KXMLBGAME");
  const nfl = templateForSeries("KXNFLGAME");
  const nba = templateForSeries("KXNBAGAME");
  assert.ok(mlb && nfl && nba);
  // MLB: Polymarket uses full names (live 2026-09-20: "Milwaukee Brewers")
  assert.ok(sideNameVerified(mlb, "MIL", "Milwaukee", "Milwaukee Brewers"));
  assert.ok(sideNameVerified(mlb, "LAA", "Los Angeles A", "Los Angeles Angels"));
  assert.ok(sideNameVerified(mlb, "ATH", "A's", "Athletics"));
  assert.ok(!sideNameVerified(mlb, "CHC", "Chicago C", "Chicago White Sox"));
  // NFL: Polymarket uses nicknames (live 2026-09-29: "Eagles" / "Bears") - the
  // direct subtitle-vs-outcome comparison rejected every NFL pair
  assert.ok(!outcomeNameMatches("Philadelphia", "Eagles"));
  assert.ok(sideNameVerified(nfl, "PHI", "Philadelphia", "Eagles"));
  assert.ok(sideNameVerified(nfl, "LAR", "Los Angeles R", "Rams"));
  assert.ok(sideNameVerified(nfl, "SF", "San Francisco", "49ers"));
  assert.ok(sideNameVerified(nfl, "WAS", "Washington", "Commanders"));
  assert.ok(!sideNameVerified(nfl, "PHI", "Philadelphia", "Bears"));
  assert.ok(!sideNameVerified(nfl, "PHI", "Chicago", "Eagles"));
  // NBA: nicknames on Polymarket ("Thunder", "76ers", "Trail Blazers"), cities on Kalshi
  assert.ok(sideNameVerified(nba, "OKC", "Oklahoma City", "Thunder"));
  assert.ok(sideNameVerified(nba, "PHI", "Philadelphia", "76ers"));
  assert.ok(sideNameVerified(nba, "POR", "Portland", "Trail Blazers"));
  assert.ok(sideNameVerified(nba, "NYK", "New York", "Knicks"));
  assert.ok(sideNameVerified(nba, "LAC", "LA Clippers", "Clippers"));
  assert.ok(!sideNameVerified(nba, "LAL", "Los Angeles L", "Clippers"));
  // opponent side (no Kalshi subtitle available): outcome alone against the club name
  assert.ok(sideNameVerified(nba, "SAS", null, "Spurs"));
  assert.ok(!sideNameVerified(nba, "SAS", null, "Thunder"));
  // a template without names falls back to the direct comparison
  const bare = { ...mlb, teamNames: {} };
  assert.ok(sideNameVerified(bare, "PIT", "Pittsburgh", "Pittsburgh Pirates"));
  assert.ok(!sideNameVerified(bare, "PHI", "Philadelphia", "Eagles"));
});

test("NBA template: Kalshi opening-slate ticker parses; NFL WAS/JAC tickers parse", () => {
  const nba = templateForSeries("KXNBAGAME");
  assert.ok(nba);
  // live 2026-09-18: KXNBAGAME-26OCT20OKCSAS-SAS, subtitle "San Antonio", no start time
  const p = parseGameTicker("KXNBAGAME-26OCT20OKCSAS-SAS", nba);
  assert.ok(p);
  assert.equal(p.dateIso, "2026-10-20");
  assert.equal(p.hhmm, null);
  assert.equal(p.awayCode, "OKC");
  assert.equal(p.homeCode, "SAS");
  assert.equal(p.sideCode, "SAS");
  assert.deepEqual(candidateSlugs(p, nba), ["nba-okc-sas-2026-10-20", "nba-okc-sas-2026-10-21"]);
  // every club has a slug code and a canonical name
  for (const code of Object.keys(nba.teamCodeAliases)) {
    assert.ok(nba.teamCodeAliases[code].length > 0, code);
    assert.ok(nba.teamNames[code], code);
  }
  assert.equal(new Set(Object.values(nba.teamNames)).size, 30);

  const nfl = templateForSeries("KXNFLGAME");
  assert.ok(nfl);
  // live 2026-09-18: Kalshi writes WAS and JAC (the table previously only knew WSH/JAX)
  const was = parseGameTicker("KXNFLGAME-26SEP20WASDAL-WAS", nfl);
  assert.ok(was);
  assert.equal(was.awayCode, "WAS");
  assert.deepEqual(candidateSlugs(was, nfl).slice(0, 2), ["nfl-was-dal-2026-09-20", "nfl-wsh-dal-2026-09-20"]);
  const jac = parseGameTicker("KXNFLGAME-26SEP20JACDEN-JAC", nfl);
  assert.ok(jac);
  assert.equal(jac.awayCode, "JAC");
  assert.equal(candidateSlugs(jac, nfl)[0], "nfl-jax-den-2026-09-20");
});

test("every whitelist team table splits unambiguously for every ordered pair of codes", () => {
  for (const t of LEAGUE_TEMPLATES) {
    const codes = Object.keys(t.teamCodeAliases);
    for (const away of codes) {
      for (const home of codes) {
        if (away === home) continue;
        const split = splitTeamCodes(`${away}${home}`, codes);
        assert.deepEqual(split, { away, home }, `${t.league}: ${away}${home}`);
      }
    }
  }
});

test("matchKalshiMarket: NFL Sunday-night game pairs through the next-day slug with nickname outcomes", async () => {
  const nfl = templateForSeries("KXNFLGAME");
  assert.ok(nfl);
  const kalshi: KalshiMarket = {
    ticker: "KXNFLGAME-26SEP20INDKC-KC",
    eventTicker: "KXNFLGAME-26SEP20INDKC",
    title: "Kansas City wins",
    subtitle: "Kansas City",
    strike: 0,
    strikeType: "",
    status: "active",
    openTime: "2026-09-14T00:00:00Z",
    closeTime: "2026-09-23T00:20:00Z",
    yesBidCents: 60,
    yesAskCents: 62,
    lastPriceCents: 61,
    volume: 1000,
    openInterest: 500,
    rulesPrimary: "",
  };
  const gammaEvent = (slug: string, outcomes: string[], gameStartTime: string) => [
    {
      slug,
      title: `${outcomes[0]} vs. ${outcomes[1]}`,
      markets: [
        {
          question: `${outcomes[0]} vs. ${outcomes[1]}`,
          conditionId: "0xdef",
          outcomes: JSON.stringify(outcomes),
          clobTokenIds: '["111", "222"]',
          outcomePrices: '["0.40", "0.60"]',
          gameStartTime,
          sportsMarketType: "moneyline",
          active: true,
          closed: false,
          acceptingOrders: true,
          negRisk: false,
          orderMinSize: 5,
        },
      ],
    },
  ];
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const slug = new URL(url).searchParams.get("slug") ?? "";
    // Polymarket lists this 8:20pm ET Sep 20 game under the UTC date, Sep 21
    const body = slug === "nfl-ind-kc-2026-09-21" ? gammaEvent(slug, ["Colts", "Chiefs"], "2026-09-21 00:20:00+00") : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const pair = await matchKalshiMarket(kalshi, nfl, fakeFetch);
  assert.ok(pair, "the pair must be found via the next-day slug");
  assert.equal(pair.pm.eventSlug, "nfl-ind-kc-2026-09-21");
  assert.equal(pair.pmYesOutcomeIndex, 1); // KC is home ⇒ second outcome
  assert.equal(pair.pm.outcomes[pair.pmYesOutcomeIndex], "Chiefs");
  assert.equal(pair.pm.outcomes[pair.pmNoOutcomeIndex], "Colts");
  assert.equal(pair.fingerprint, "nfl:IND:KC:2026-09-20");
  assert.ok(requested.some((u) => u.includes("nfl-ind-kc-2026-09-20")), "the ticker date is tried first");

  // the same matchup listed for the NEXT ET day is a different game: refuse
  const wrongDay = (async () =>
    new Response(JSON.stringify(gammaEvent("nfl-ind-kc-2026-09-21", ["Colts", "Chiefs"], "2026-09-21 17:00:00+00")), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  assert.equal(await matchKalshiMarket(kalshi, nfl, wrongDay), null);

  // outcomes that are not these clubs (a mis-ordered or wrong listing) refuse
  const wrongClubs = (async () =>
    new Response(JSON.stringify(gammaEvent("nfl-ind-kc-2026-09-20", ["Chiefs", "Colts"], "2026-09-21 00:20:00+00")), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  assert.equal(await matchKalshiMarket(kalshi, nfl, wrongClubs), null);
});

test("startTimesAgree: the doubleheader guard", () => {
  const mlb = templateForSeries("KXMLBGAME");
  assert.ok(mlb);
  const parsed = parseGameTicker("KXMLBGAME-26SEP131420PITCHC-PIT", mlb);
  assert.ok(parsed);
  // 14:20 ET = 18:20 UTC in September
  assert.ok(startTimesAgree(parsed, "2026-09-13T18:20:00.000Z"));
  // game two of a doubleheader 4.5 hours later must NOT pair
  assert.ok(!startTimesAgree(parsed, "2026-09-13T22:50:00.000Z"));
  // no encoded time (NFL): nothing to check
  const nfl = templateForSeries("KXNFLGAME");
  assert.ok(nfl);
  const p2 = parseGameTicker("KXNFLGAME-26SEP21NYGLAR-LAR", nfl);
  assert.ok(p2);
  assert.ok(startTimesAgree(p2, "2026-09-22T00:15:00.000Z"));
});

// ── cross-venue pricer: hand-computed fixture ──

const NOW = new Date("2026-09-12T12:00:00Z");
const GAME_START = new Date("2026-09-13T18:20:00Z");

function fixturePair(): MatchedPair {
  const kalshi: KalshiMarket = {
    ticker: "KXMLBGAME-26SEP131420PITCHC-PIT",
    eventTicker: "KXMLBGAME-26SEP131420PITCHC",
    title: "Pittsburgh wins",
    subtitle: "Pittsburgh",
    strike: 0,
    strikeType: "",
    status: "active",
    openTime: "",
    closeTime: "2026-09-16T18:20:00Z",
    yesBidCents: 61,
    yesAskCents: 63,
    lastPriceCents: 62,
    volume: 1000,
    openInterest: 500,
    rulesPrimary: "",
  };
  return {
    league: "mlb",
    kalshi,
    pm: {
      eventSlug: "mlb-pit-chc-2026-09-13",
      eventTitle: "Pittsburgh Pirates vs. Chicago Cubs",
      question: "Pittsburgh Pirates vs. Chicago Cubs",
      conditionId: "0xabc",
      outcomes: ["Pittsburgh Pirates", "Chicago Cubs"],
      tokenIds: ["111", "222"],
      outcomePricesMilli: [620, 380],
      gameStartTime: GAME_START.toISOString(),
      endDate: "2026-09-20T18:20:00Z",
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
    gameStartTime: GAME_START.toISOString(),
    parityNote: "both venues settle on the official MLB final result for this game",
    fingerprint: "mlb:PIT:CHC:2026-09-13",
  };
}

function fixtureBook(overrides: Partial<PmBook> = {}): PmBook {
  return {
    tokenId: "222",
    asks: [
      { priceMilli: 300, sizeMilli: 200_000 },
      { priceMilli: 320, sizeMilli: 500_000 },
    ],
    bids: [{ priceMilli: 280, sizeMilli: 200_000 }],
    minOrderSizeShares: 5,
    tickMilli: 10,
    ...overrides,
  };
}

function baseInputs(overrides: Partial<CrossPricerInputs> = {}): CrossPricerInputs {
  return {
    pair: fixturePair(),
    markCents: 62,
    entryCents: 41,
    contracts: 150,
    now: NOW,
    noBook: fixtureBook(),
    // These fixtures hand-compute the highest-floor collar, which is the
    // `tight` tier; pin it as the default so the top-level terms are that collar.
    config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight" } as CrossSearchConfig,
    ...overrides,
  };
}

test("walkPmAsks: exact micro-dollar cost across levels, null on thin depth", () => {
  const asks = [
    { priceMilli: 300, sizeMilli: 100_000 },
    { priceMilli: 400, sizeMilli: 100_000 },
  ];
  const w = walkPmAsks(asks, 150_000);
  assert.ok(w);
  // 100 shares @ .300 + 50 shares @ .400 = $50.00 exactly
  assert.equal(w.costMicroUsd, 100_000 * 300 + 50_000 * 400);
  assert.equal(w.worstPriceMilli, 400);
  assert.equal(walkPmAsks(asks, 200_001), null);
});

test("quoteCrossWrap: exact integer credit math on the hand-computed fixture", () => {
  const result = quoteCrossWrap(baseInputs());
  assert.ok(result.ok, JSON.stringify(result));
  // Highest floor protecting entry wins: floor 59 (mark-3). Best cap there:
  //   c=65: digital D = 59+100-65 = 94c/contract -> shares 94*150/100 = 141
  //     (141000 milli), cost = 141000*300 = 42,300,000 micro = $42.30 -> 4230c
  //   funding = (100-65)*150 = 5250c; gross = 1020c; take 10% = 102; credit 918
  assert.equal(result.floorCents, 59);
  assert.equal(result.capCents, 65);
  assert.equal(result.hedge.sharesMilli, 141_000);
  assert.equal(result.hedge.costCents, 4230);
  assert.equal(result.grossCreditCents, 1020);
  assert.equal(result.takeCents, 102);
  assert.equal(result.takeWaived, false);
  assert.equal(result.creditCents, 918);
  assert.equal(result.feesCents, 0);
  assert.equal(result.hedge.outcome, "Chicago Cubs");
  assert.equal(result.hedge.tokenId, "222");
  assert.equal(result.hedge.action, "buy");
});

test("quoteCrossWrap: hedge is never under-sized (rounded up, min order clamped)", () => {
  const result = quoteCrossWrap(baseInputs());
  assert.ok(result.ok);
  const digitalCents = (result.floorCents + 100 - result.capCents) * result.contracts;
  assert.ok(result.hedge.sharesMilli >= digitalCents * 10);
  // tiny position: clamped to the venue's 5-share minimum (over-hedged, never under)
  const small = quoteCrossWrap(
    baseInputs({
      contracts: 2,
      noBook: fixtureBook({ asks: [{ priceMilli: 10, sizeMilli: 100_000 }] }),
      config: { ...DEFAULT_CROSS_CONFIG, defaultTier: "tight", deMinimisTakeCents: 10 },
    }),
  );
  assert.ok(small.ok, JSON.stringify(small));
  assert.equal(small.hedge.sharesMilli, 5000);
  // funding (100-65)*2=70c, cost 5000*10=50,000 micro -> 5c, gross 65,
  // take floor(6.5)=6 < 10 de minimis -> waived, credit 65
  assert.equal(small.grossCreditCents, 65);
  assert.equal(small.takeWaived, true);
  assert.equal(small.creditCents, 65);
});

test("quoteCrossWrap: hedgeOn prophetx prices the same walk on a ProphetX strike and emits a ProphetX leg with both strikes; its refusals are the venue's", () => {
  const hedgeOn = { venue: "prophetx" as const, strikeId: "strike-no-9", offsetStrikeId: "strike-yes-9", outcome: "Chicago Cubs" };
  const px = quoteCrossWrap(baseInputs({ hedgeOn }));
  const pm = quoteCrossWrap(baseInputs());
  assert.ok(px.ok && pm.ok, JSON.stringify(px));
  // the same book, the same collar and credit: only the leg's venue and ids differ
  assert.deepEqual([px.floorCents, px.capCents, px.creditCents, px.hedge.costCents], [pm.floorCents, pm.capCents, pm.creditCents, pm.hedge.costCents]);
  assert.equal(px.hedge.venue, "prophetx");
  if (px.hedge.venue === "prophetx") {
    assert.deepEqual([px.hedge.strikeId, px.hedge.offsetStrikeId, px.hedge.outcome, px.hedge.sharesMilli, px.hedge.action], ["strike-no-9", "strike-yes-9", "Chicago Cubs", 141_000, "buy"]);
    assert.equal(px.hedge.worstPriceMilli, 300);
  }
  const empty = quoteCrossWrap(baseInputs({ hedgeOn, noBook: fixtureBook({ asks: [] }) }));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "prophetx_book_empty");
  const thin = quoteCrossWrap(baseInputs({ hedgeOn, noBook: fixtureBook({ asks: [{ priceMilli: 300, sizeMilli: 1000 }] }) }));
  assert.equal(thin.ok, false);
  if (!thin.ok) {
    assert.equal(thin.code, "prophetx_book_too_thin");
    assert.match(thin.detail, /ProphetX/);
  }
});

test("quoteCrossWrap: refusal codes", () => {
  const tooClose = quoteCrossWrap(
    baseInputs({ now: new Date(GAME_START.getTime() - 5 * 60_000) }),
  );
  assert.equal(tooClose.ok, false);
  if (!tooClose.ok) assert.equal(tooClose.code, "market_too_close_to_start");

  const lowMark = quoteCrossWrap(baseInputs({ markCents: 5 }));
  assert.equal(lowMark.ok, false);
  if (!lowMark.ok) assert.equal(lowMark.code, "mark_out_of_range");

  const empty = quoteCrossWrap(baseInputs({ noBook: fixtureBook({ asks: [] }) }));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "pm_book_empty");

  const thin = quoteCrossWrap(
    baseInputs({ noBook: fixtureBook({ asks: [{ priceMilli: 300, sizeMilli: 1000 }] }) }),
  );
  assert.equal(thin.ok, false);
  if (!thin.ok) assert.equal(thin.code, "pm_book_too_thin");

  // expensive opposing book: no floor/cap can fund a credit
  const rich = quoteCrossWrap(
    baseInputs({ noBook: fixtureBook({ asks: [{ priceMilli: 700, sizeMilli: 900_000 }] }) }),
  );
  assert.equal(rich.ok, false);
  if (!rich.ok) {
    assert.equal(rich.code, "credit_nonpositive");
    assert.ok((rich.bestShortfallCents ?? 0) > 0);
  }
});
