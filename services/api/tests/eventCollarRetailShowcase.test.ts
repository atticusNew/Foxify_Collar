import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETAIL_FORBIDDEN_KEYS,
  RETAIL_REFUSAL_COPY,
  forbiddenKeysIn,
  retailBtcPayload,
  retailCrossPayload,
  retailCrossQuote,
  retailPayloadError,
  retailRefusal,
  retailWrapQuote,
  type OperatorBtcPayload,
  type OperatorCrossPayload,
} from "../src/eventCollar/retailShowcase";
import type { CrossQuote, CrossRefusalCode } from "../src/eventCollar/crossVenue/types";
import type { WrapQuote, WrapRefusalCode } from "../src/eventCollar/types";

const terms = (floor: number, cap: number, credit: number) => ({
  floorCents: floor,
  capCents: cap,
  creditCents: credit,
  grossCreditCents: credit + 40,
  takeCents: 40,
  takeShareCents: 40,
  takeMinimumCents: 25,
  takeRule: "share" as const,
  takeWaived: false,
  hedge: {
    action: "buy" as const,
    venue: "polymarket" as const,
    outcome: "Chicago Cubs",
    tokenId: "222",
    sharesMilli: 141_000,
    avgPriceMilli: 300,
    worstPriceMilli: 310,
    costCents: 4230,
  },
  feesCents: 0,
  evCostBps: -120,
});

const CROSS_QUOTE: CrossQuote = {
  ok: true,
  kalshiTicker: "KXMLBGAME-26SEP20CHCSTL-STL",
  pmEventSlug: "mlb-chc-stl-2026-09-20",
  contracts: 100,
  markCents: 62,
  entryCents: 55,
  takeBps: 1000,
  minTakeBpsOfStake: 25,
  tier: "balanced",
  tiers: { tight: terms(50, 80, 300), balanced: terms(40, 88, 420), wide: terms(30, 95, 510) },
  ...terms(40, 88, 420),
  candidatesConsidered: 37,
  parityNote: "both settle on the official final score",
  quotedAt: "2026-09-20T18:00:00.000Z",
};

const CROSS_PAYLOAD: OperatorCrossPayload = {
  ok: true,
  at: "2026-09-20T18:00:01.000Z",
  pair: {
    kind: "sports",
    league: "mlb",
    kalshiTicker: CROSS_QUOTE.kalshiTicker,
    kalshiTitle: "Cubs vs Cardinals",
    kalshiSide: "STL",
    sideName: "St. Louis Cardinals",
    opponent: "Chicago Cubs",
    eventTitle: "Cubs vs Cardinals",
    eventTimeIso: "2026-09-20T23:10:00.000Z",
    parityNote: "both settle on the official final score",
    yesBidCents: 61,
    yesAskCents: 63,
    markCents: 62,
    pmEventSlug: "mlb-chc-stl-2026-09-20",
    pmYesPriceMilli: 585,
  },
  position: { contracts: 100, entryCents: 55, entrySource: "real_print", entryTime: "2026-09-20T17:00:00.000Z" },
  quote: CROSS_QUOTE,
  route: "polymarket",
  routesChecked: [
    { route: "polymarket", ok: true, evCostBps: -120, creditCents: 420 },
    { route: "kalshi_self", ok: false, evCostBps: null, creditCents: null, detail: "kalshi_book_too_thin: 41 of 100 No contracts at ≤ 45c" },
  ],
  evCostBps: -120,
  board: [
    {
      kind: "sports",
      league: "mlb",
      kalshiTicker: CROSS_QUOTE.kalshiTicker,
      kalshiSide: "STL",
      sideName: "St. Louis Cardinals",
      eventTitle: "Cubs vs Cardinals",
      eventTimeIso: "2026-09-20T23:10:00.000Z",
      live: true,
      markCents: 62,
      contracts: 100,
      entryCents: 58,
      floorCents: 40,
      capCents: 88,
      creditCents: 420,
      floorTotalCents: 4420,
      evCostBps: -120,
      route: "polymarket",
      tier: "balanced",
      tierCount: 3,
    },
    {
      kind: "crypto",
      league: "btc",
      kalshiTicker: "KXBTCD-26SEP2017-T115000",
      kalshiSide: "above",
      sideName: "Bitcoin above $115,000",
      eventTitle: "BTC above $115,000 at 5pm",
      eventTimeIso: "2026-09-20T21:00:00.000Z",
      live: false,
      markCents: 48,
      contracts: 150,
      entryCents: 45,
      floorCents: 30,
      capCents: 90,
      creditCents: 150,
      floorTotalCents: 3150,
      evCostBps: 210,
      route: "kalshi_self",
      tier: "balanced",
      tierCount: 1,
    },
  ],
};

test("retail showcase: the cross-venue quote keeps the payoff and the tiers, drops the hedge, the take and the pairing", () => {
  const r = retailCrossQuote(CROSS_QUOTE);
  assert.ok(r && r.ok);
  assert.deepEqual(r, {
    ok: true,
    contracts: 100,
    markCents: 62,
    entryCents: 55,
    floorCents: 40,
    capCents: 88,
    creditCents: 420,
    tier: "balanced",
    tiers: {
      tight: { floorCents: 50, capCents: 80, creditCents: 300 },
      balanced: { floorCents: 40, capCents: 88, creditCents: 420 },
      wide: { floorCents: 30, capCents: 95, creditCents: 510 },
    },
    quotedAt: "2026-09-20T18:00:00.000Z",
  });
  assert.deepEqual(forbiddenKeysIn(r), []);
  assert.equal(retailCrossQuote(null), null);
});

test("retail showcase: every engine refusal code maps to a retail sentence with no venue, book or rule in it", () => {
  const crossCodes: CrossRefusalCode[] = [
    "no_matched_market",
    "resolution_mismatch",
    "market_too_close_to_start",
    "mark_out_of_range",
    "pm_book_empty",
    "pm_book_too_thin",
    "kalshi_book_empty",
    "kalshi_book_too_thin",
    "credit_nonpositive",
    "protection_too_rich",
    "credit_too_small",
  ];
  const wrapCodes: WrapRefusalCode[] = [
    "market_not_active",
    "market_too_close_to_resolution",
    "mark_out_of_range",
    "no_bracketing_strikes",
    "okx_book_empty",
    "okx_book_too_thin",
    "credit_nonpositive",
    "no_matching_expiry",
  ];
  for (const code of [...crossCodes, ...wrapCodes]) {
    assert.ok(RETAIL_REFUSAL_COPY[code], `${code} has retail copy`);
    const r = retailRefusal(code);
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.detail, /polymarket|kalshi|okx|book|bps|env|_/i, `${code}: "${r.detail}" names nothing internal`);
    assert.doesNotMatch(r.code, /pm_|kalshi|okx/, `${code}: retail code is venue-free (${r.code})`);
  }
  // an unknown engine code can never leak its text
  const unknown = retailRefusal("okx_auth_failed: key rejected");
  assert.equal(unknown.code, "unavailable");
  assert.doesNotMatch(unknown.detail, /okx|key/i);
  assert.equal(retailRefusal(undefined).code, "unavailable");

  const refused = retailCrossQuote({ ok: false, code: "pm_book_too_thin", detail: "41 of 100 shares at ≤ 45c on token 222", bestShortfallCents: 12 });
  assert.deepEqual(refused, { ok: false, code: "no_depth", detail: "Not enough depth to protect this size right now." });
  assert.deepEqual(retailCrossQuote({ ok: false, code: "protection_too_rich", detail: "the cheapest route costs 4.72% of expected value; the ceiling is 3.00%" }), {
    ok: false,
    code: "too_expensive",
    detail: "Protection is too expensive on this one right now.",
  });
});

test("retail showcase: payload errors lose venue names and env-var hints", () => {
  assert.equal(
    retailPayloadError("a venue is unreachable from this machine right now (Polymarket's book API is blocked on some networks; a relay via PM_CLOB_REST_BASE fixes it)"),
    "Live pricing is unavailable right now; retrying.",
  );
  assert.equal(retailPayloadError("the hedge venue is unreachable from this machine right now (OKX is blocked on some networks; a relay via OKX_REST_BASE fixes it)"), "Live pricing is unavailable right now; retrying.");
  assert.equal(retailPayloadError("no whitelisted event is quotable right now"), "Nothing is quotable right now; the board refreshes on its own.");
  assert.equal(retailPayloadError(undefined), undefined);
});

test("retail showcase: the cross-venue payload is an allow-list — pair, position, quote, board; nothing about routes, pairing or the other venue's price", () => {
  const r = retailCrossPayload(CROSS_PAYLOAD);
  assert.equal(r.retail, true);
  assert.deepEqual(Object.keys(r).sort(), ["at", "board", "ok", "pair", "position", "quote", "retail"]);
  assert.deepEqual(r.pair, {
    kind: "sports",
    league: "mlb",
    kalshiTicker: CROSS_QUOTE.kalshiTicker,
    kalshiTitle: "Cubs vs Cardinals",
    kalshiSide: "STL",
    sideName: "St. Louis Cardinals",
    opponent: "Chicago Cubs",
    eventTitle: "Cubs vs Cardinals",
    eventTimeIso: "2026-09-20T23:10:00.000Z",
    markCents: 62,
  });
  assert.deepEqual(r.position, CROSS_PAYLOAD.position);
  assert.equal(r.board.length, 2);
  assert.deepEqual(Object.keys(r.board[0]).sort(), [
    "capCents",
    "contracts",
    "creditCents",
    "entryCents",
    "eventTimeIso",
    "eventTitle",
    "evCostBps",
    "floorCents",
    "floorTotalCents",
    "kalshiSide",
    "kalshiTicker",
    "kind",
    "league",
    "live",
    "markCents",
    "sideName",
    "tier",
    "tierCount",
  ].sort());
  assert.deepEqual(r.board.map((row) => row.live), [true, false], "in play is a yes or no on every row, as the board set it");
  assert.deepEqual(forbiddenKeysIn(r), [], "no forbidden key anywhere in the retail payload");
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /polymarket|kalshi_self|pmEventSlug|585|4230|tokenId|REST_BASE|candidates/i);
  // and the operator payload trips the same tripwire, so the tripwire is real
  assert.ok(forbiddenKeysIn(CROSS_PAYLOAD).length > 10);
});

test("retail showcase: a payload with no showcase keeps its shape and gets one retail sentence", () => {
  const r = retailCrossPayload({
    ok: false,
    at: "2026-09-20T18:00:01.000Z",
    pair: null,
    position: null,
    quote: null,
    route: null,
    routesChecked: [],
    evCostBps: null,
    board: [],
    error: "a venue is unreachable from this machine right now (Polymarket's book API is blocked on some networks; a relay via PM_CLOB_REST_BASE fixes it)",
  });
  assert.deepEqual(r, { ok: false, at: "2026-09-20T18:00:01.000Z", retail: true, pair: null, position: null, quote: null, board: [], error: "Live pricing is unavailable right now; retrying." });
});

const WRAP_QUOTE: WrapQuote = {
  ok: true,
  marketTicker: "KXBTCD-26SEP2017-T115000",
  contracts: 100,
  markCents: 48,
  entryCents: 45,
  floorCents: 30,
  capCents: 90,
  creditCents: 150,
  grossCreditCents: 190,
  takeCents: 40,
  takeBps: 2000,
  takeWaived: false,
  digitalPutMicro: 520_000,
  spreads: 3,
  verticalWidthUsd: 500,
  hedgeExpiry: "260920",
  alignment: "expiry_aligned",
  legs: [
    { action: "buy", instId: "BTC-USD-260920-115000-P", contracts: 3, premiumCents: 24_100, avgPriceBtc: 0.0021 },
    { action: "sell", instId: "BTC-USD-260920-114500-P", contracts: 3, premiumCents: -19_500, avgPriceBtc: 0.0017 },
  ],
  feesCents: 12,
  quotedAt: "2026-09-20T18:00:00.000Z",
};

test("retail showcase: the BTC demo quote becomes one balanced tier with no legs, instruments, tenor or take", () => {
  const r = retailWrapQuote(WRAP_QUOTE);
  assert.deepEqual(r, {
    ok: true,
    contracts: 100,
    markCents: 48,
    entryCents: 45,
    floorCents: 30,
    capCents: 90,
    creditCents: 150,
    tier: "balanced",
    tiers: { balanced: { floorCents: 30, capCents: 90, creditCents: 150 } },
    quotedAt: "2026-09-20T18:00:00.000Z",
  });
  assert.deepEqual(retailWrapQuote({ ok: false, code: "okx_book_too_thin", detail: "2 of 3 verticals at ≤ 0.0021 BTC" }), {
    ok: false,
    code: "no_depth",
    detail: "Not enough depth to protect this size right now.",
  });

  const payload: OperatorBtcPayload = {
    ok: true,
    at: "2026-09-20T18:00:01.000Z",
    spotUsd: 114_800,
    market: {
      ticker: "KXBTCD-26SEP2017-T115000",
      title: "Bitcoin price at 5pm EDT?",
      subtitle: "Above $115,000",
      strike: 115_000,
      closeTime: "2026-09-20T21:00:00.000Z",
      yesBidCents: 47,
      yesAskCents: 49,
      markCents: 48,
      volume: 18_240,
    },
    position: { contracts: 100, entryCents: 45, entrySource: "real_print", entryTime: "2026-09-20T17:00:00.000Z" },
    quote: WRAP_QUOTE,
    hedge: { expiry: "260920", expiryTime: "2026-09-20T08:00:00.000Z" },
  };
  const rp = retailBtcPayload(payload);
  assert.deepEqual(Object.keys(rp).sort(), ["at", "market", "ok", "position", "quote", "retail", "spotUsd"]);
  assert.deepEqual(rp.market, { ticker: "KXBTCD-26SEP2017-T115000", title: "Bitcoin price at 5pm EDT?", subtitle: "Above $115,000", strike: 115_000, closeTime: "2026-09-20T21:00:00.000Z", markCents: 48 });
  assert.deepEqual(forbiddenKeysIn(rp), []);
  assert.doesNotMatch(JSON.stringify(rp), /OKX|BTC-USD-|260920|18240|vertical/i);
  assert.ok(forbiddenKeysIn(payload).length > 8, "the operator payload trips the tripwire");
});

test("retail showcase: the forbidden-key tripwire walks arrays and nesting", () => {
  assert.deepEqual(forbiddenKeysIn({ a: [{ b: { hedge: 1 } }, { legs: [] }], route: "x" }).sort(), ["hedge", "legs", "route"]);
  assert.deepEqual(forbiddenKeysIn(null), []);
  assert.deepEqual(forbiddenKeysIn("hedge"), []);
  assert.ok(RETAIL_FORBIDDEN_KEYS.has("path") && RETAIL_FORBIDDEN_KEYS.has("strategy"), "the shadow health body's operator keys are on the list too");
});
