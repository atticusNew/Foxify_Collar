import { test } from "node:test";
import assert from "node:assert/strict";
import {
  kalshiTakerFeeCents,
  parseNoAsks,
  quoteLadderWrap,
  walkNoAsks,
  type LadderPricerInputs,
  type NoAskLevel,
} from "../src/eventCollar/crossVenue/kalshiLadder";
import {
  DEFAULT_CROSS_CONFIG,
  type CrossSearchConfig,
  type MatchedPair,
} from "../src/eventCollar/crossVenue/types";
import type { KalshiMarket } from "../src/eventCollar/types";

// ── orderbook parsing: yes bids become No-side executable asks ──

test("parseNoAsks: fixed-point shape (dollar strings, fractional depth)", () => {
  const levels = parseNoAsks({
    orderbook_fp: {
      yes_dollars: [
        ["0.5900", "86245.13"],
        ["0.6100", "10"],
      ],
    },
  });
  // yes bid 61c fills a No buy at 39c (cheapest first), bid 59c at 41c
  assert.deepEqual(levels, [
    { priceCents: 39, qtyMilli: 10_000 },
    { priceCents: 41, qtyMilli: 86_245_130 },
  ]);
});

test("parseNoAsks: legacy integer-cents shape, garbage rejected", () => {
  const levels = parseNoAsks({
    orderbook: {
      yes: [
        [59, 100],
        [61, 50],
        [0, 999], // zero bid is not depth
        [100, 999], // degenerate price rejected
      ],
    },
  });
  assert.deepEqual(levels, [
    { priceCents: 39, qtyMilli: 50_000 },
    { priceCents: 41, qtyMilli: 100_000 },
  ]);
  assert.deepEqual(parseNoAsks({}), []);
});

// ── the venue's taker fee, exact ──

test("kalshiTakerFeeCents: 0.07 * C * p * (1-p), rounded up to the cent", () => {
  // 100 contracts at 50c: 0.07 * 100 * .5 * .5 = $1.75
  assert.equal(kalshiTakerFeeCents(100_000, 50), 175);
  // 141 contracts at 30c: 0.07 * 141 * .3 * .7 = $2.0727 -> 208c (rounded up)
  assert.equal(kalshiTakerFeeCents(141_000, 30), 208);
  // one contract at 30c: 0.07 * .3 * .7 = 1.47c -> rounds UP to 2c, never down
  assert.equal(kalshiTakerFeeCents(1000, 30), 2);
  assert.equal(kalshiTakerFeeCents(0, 50), 0);
  assert.equal(kalshiTakerFeeCents(1000, 0), 0);
});

// ── walking the ladder ──

test("walkNoAsks: exact milli-cent cost with per-fill fees, null on thin depth", () => {
  const levels: NoAskLevel[] = [
    { priceCents: 30, qtyMilli: 100_000 },
    { priceCents: 40, qtyMilli: 100_000 },
  ];
  const w = walkNoAsks(levels, 150_000);
  assert.ok(w);
  // 100 contracts @30c + 50 @40c = $50.00 exactly
  assert.equal(w.costCents, 5000);
  // fee(100 @30) = ceil(147) = 147; fee(50 @40) = ceil(84) = 84
  assert.equal(w.feeCents, 231);
  assert.equal(w.avgPriceCents, 34); // ceil(5,000,000 / 150,000)
  assert.equal(w.worstPriceCents, 40);
  assert.equal(walkNoAsks(levels, 200_001), null);
});

// ── pricer fixture (mirrors the cross-venue fixture, self-hedge route) ──

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

function baseInputs(overrides: Partial<LadderPricerInputs> = {}): LadderPricerInputs {
  return {
    pair: fixturePair(),
    markCents: 62,
    entryCents: 41,
    contracts: 150,
    now: NOW,
    noAsks: [
      { priceCents: 30, qtyMilli: 200_000 },
      { priceCents: 32, qtyMilli: 500_000 },
    ],
    config: { ...DEFAULT_CROSS_CONFIG } as CrossSearchConfig,
    ...overrides,
  };
}

test("quoteLadderWrap: exact integer credit math on the hand-computed fixture", () => {
  const result = quoteLadderWrap(baseInputs());
  assert.ok(result.ok, JSON.stringify(result));
  // Highest floor protecting entry wins: floor 59 (mark-3). Best cap there is
  // the lowest (credit falls as the cap rises when the No side is this cheap):
  //   c=65: digital D = 94c/contract -> 141 contracts (141,000 milli)
  //     cost = 141,000 * 30 = 4,230,000 milli-cents -> $42.30
  //     taker fee = ceil(0.07 * 141 * .3 * .7 * 100) = 208c
  //   funding = 35 * 150 = 5250c; gross = 5250 - 4230 - 208 = 812c
  //   take 10% = 81c; credit = 731c
  assert.equal(result.floorCents, 59);
  assert.equal(result.capCents, 65);
  assert.equal(result.hedge.venue, "kalshi");
  if (result.hedge.venue === "kalshi") {
    assert.equal(result.hedge.outcome, "No");
    assert.equal(result.hedge.ticker, "KXMLBGAME-26SEP131420PITCHC-PIT");
    assert.equal(result.hedge.contractsMilli, 141_000);
    assert.equal(result.hedge.avgPriceCents, 30);
    assert.equal(result.hedge.costCents, 4230);
  }
  assert.equal(result.feesCents, 208);
  assert.equal(result.grossCreditCents, 812);
  assert.equal(result.takeCents, 81);
  assert.equal(result.takeWaived, false);
  assert.equal(result.creditCents, 731);
  assert.ok(result.parityNote.includes("own No side"));
});

test("quoteLadderWrap: hedge is never under-sized (venue minimum clamp)", () => {
  // one contract: the 94c digital needs 940 milli, clamped to the 1-contract min
  const result = quoteLadderWrap(baseInputs({ contracts: 1 }));
  assert.ok(result.ok, JSON.stringify(result));
  if (result.hedge.venue === "kalshi") {
    assert.equal(result.hedge.contractsMilli, 1000);
  }
  // funding 35c, cost 30c, fee 2c -> gross 3c; take floor(0.3)=0 -> waived
  assert.equal(result.grossCreditCents, 3);
  assert.equal(result.takeWaived, true);
  assert.equal(result.creditCents, 3);
});

test("quoteLadderWrap: quotes without a cross-venue pairing (crypto strike markets)", () => {
  // The self-hedge route needs no Polymarket listing: a minimal pair shape
  // (ticker + lock time) must quote identically to the full MatchedPair.
  const result = quoteLadderWrap(
    baseInputs({
      pair: { kalshi: { ticker: "KXBTCD-26SEP1217-T86749.99" }, gameStartTime: GAME_START.toISOString() },
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.kalshiTicker, "KXBTCD-26SEP1217-T86749.99");
  assert.equal(result.pmEventSlug, "");
  assert.equal(result.creditCents, 731);
});

test("quoteLadderWrap: refusal codes", () => {
  const tooClose = quoteLadderWrap(
    baseInputs({ now: new Date(GAME_START.getTime() - 5 * 60_000) }),
  );
  assert.equal(tooClose.ok, false);
  if (!tooClose.ok) assert.equal(tooClose.code, "market_too_close_to_start");

  const lowMark = quoteLadderWrap(baseInputs({ markCents: 5 }));
  assert.equal(lowMark.ok, false);
  if (!lowMark.ok) assert.equal(lowMark.code, "mark_out_of_range");

  const empty = quoteLadderWrap(baseInputs({ noAsks: [] }));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "kalshi_book_empty");

  const thin = quoteLadderWrap(
    baseInputs({ noAsks: [{ priceCents: 30, qtyMilli: 1000 }] }),
  );
  assert.equal(thin.ok, false);
  if (!thin.ok) assert.equal(thin.code, "kalshi_book_too_thin");

  // No side priced above every cap slice: nothing funds a credit
  const rich = quoteLadderWrap(
    baseInputs({ noAsks: [{ priceCents: 70, qtyMilli: 900_000 }] }),
  );
  assert.equal(rich.ok, false);
  if (!rich.ok) {
    assert.equal(rich.code, "credit_nonpositive");
    assert.ok((rich.bestShortfallCents ?? 0) > 0);
  }
});
