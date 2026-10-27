/**
 * Mark-gap guard: no cross-venue route priced off a mark the hedge venue does not believe. The
 * rule is pure (markGapGuard.ts); the demo service applies it last in the quote pipeline, after
 * the far-out guard, and the refusal has words in every retail map.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MARK_GAP_GUARD,
  impliedYesCents,
  markGapGuardFromEnv,
  markGapVerdict,
  type MarkGapGuardInputs,
} from "../src/eventCollar/crossVenue/markGapGuard";
import type { PmBook } from "../src/eventCollar/crossVenue/types";
import { RETAIL_REFUSAL_COPY } from "../src/eventCollar/retailShowcase";
import { PARLAY_REFUSAL_SHORT, PARLAY_REFUSAL_WORDS } from "../src/eventCollar/crossVenue/parlayRetail";
import { refusalWord } from "../src/eventCollar/crossVenue/shadowVenues";

// the demo module must not start its server or prewarm a scan when imported below
process.env.NODE_ENV = "test";
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

/** the second venue's No book with one best ask at `noAskCents` */
const noBook = (noAskCents: number): PmBook => ({
  tokenId: "t",
  asks: [{ priceMilli: noAskCents * 10, sizeMilli: 500_000 }, { priceMilli: noAskCents * 10 + 20, sizeMilli: 500_000 }],
  bids: [{ priceMilli: noAskCents * 10 - 20, sizeMilli: 500_000 }],
  minOrderSizeShares: 5,
  tickMilli: 10,
});

/** the far-out stub: a 49/51 straddle nobody traded, while the hedge venue prices the side at 77¢ (No ask 23¢) */
const stub = (): MarkGapGuardInputs => ({
  kind: "sports",
  route: "polymarket",
  markCents: 50,
  yesBidCents: 49,
  yesAskCents: 51,
  pmNoBook: noBook(23),
});

test("mark-gap guard: a tight stub far from the hedge venue's price is refused, with both prices and the gap in the words", () => {
  const v = markGapVerdict(stub());
  assert.ok(v.refuse);
  assert.equal(v.code, "mark_disagreement");
  assert.equal(v.impliedCents, 77);
  assert.equal(v.gapCents, 27);
  assert.equal(v.spreadCents, 2);
  assert.match(v.detail, /marks 50¢/);
  assert.match(v.detail, /implies 77¢/);
  assert.match(v.detail, /27¢ apart; the limit is 8¢/);
  assert.doesNotMatch(v.detail, /wide/, "the spread test did not fire on a 2¢ straddle");
});

test("mark-gap guard: a wide own side is refused even when its mid happens to agree with the hedge venue", () => {
  const v = markGapVerdict({ ...stub(), markCents: 50, yesBidCents: 1, yesAskCents: 99, pmNoBook: noBook(50) });
  assert.ok(v.refuse);
  assert.equal(v.spreadCents, 98);
  assert.equal(v.gapCents, 0);
  assert.match(v.detail, /1\/99 \(98¢ wide; the limit is 20¢\)/);
  assert.doesNotMatch(v.detail, /apart/, "the gap test did not fire");
  // exactly at the limit is inside it
  assert.deepEqual(markGapVerdict({ ...stub(), yesBidCents: 40, yesAskCents: 60, pmNoBook: noBook(50) }), { refuse: false });
});

test("mark-gap guard: both tests firing name both reasons", () => {
  const v = markGapVerdict({ ...stub(), yesBidCents: 20, yesAskCents: 80 });
  assert.ok(v.refuse);
  assert.match(v.detail, /60¢ wide/);
  assert.match(v.detail, /27¢ apart/);
});

test("mark-gap guard: a mark the hedge venue agrees with, inside a tight side, stands", () => {
  assert.deepEqual(markGapVerdict({ ...stub(), markCents: 75, yesBidCents: 74, yesAskCents: 76 }), { refuse: false }, "2¢ apart");
  assert.deepEqual(markGapVerdict({ ...stub(), markCents: 69, yesBidCents: 68, yesAskCents: 70 }), { refuse: false }, "exactly 8¢ apart is inside the limit");
  assert.equal(markGapVerdict({ ...stub(), markCents: 68, yesBidCents: 67, yesAskCents: 69 }).refuse, true, "9¢ apart is outside it");
});

test("mark-gap guard: only the cross-venue route on a game is held to it; no hedge book means no gap test", () => {
  assert.deepEqual(markGapVerdict({ ...stub(), route: "kalshi_self" }), { refuse: false }, "the own-No-side route is priced from a real book, not the mark");
  assert.deepEqual(markGapVerdict({ ...stub(), route: null }), { refuse: false }, "every route refused: nothing to refuse");
  assert.deepEqual(markGapVerdict({ ...stub(), kind: "crypto" }), { refuse: false });
  assert.deepEqual(markGapVerdict({ ...stub(), pmNoBook: undefined }), { refuse: false }, "no hedge book and a tight side: nothing to compare");
  assert.deepEqual(markGapVerdict({ ...stub(), pmNoBook: { ...noBook(23), asks: [] } }), { refuse: false }, "an empty ask side implies nothing");
  const wideNoBook = markGapVerdict({ ...stub(), yesBidCents: 1, yesAskCents: 99, pmNoBook: undefined });
  assert.equal(wideNoBook.refuse, true, "the spread test needs no hedge book");
  assert.equal(wideNoBook.refuse && wideNoBook.impliedCents, null);
});

test("mark-gap guard: the implied price is 100 minus the best No ask, in whole cents", () => {
  assert.equal(impliedYesCents(noBook(23)), 77);
  assert.equal(impliedYesCents({ ...noBook(23), asks: [{ priceMilli: 235, sizeMilli: 1 }] }), 77, "76.5 rounds to 77");
  assert.equal(impliedYesCents(undefined), null);
});

test("mark-gap guard: the env sets both limits; 0 turns a test off; both off turns the rule off; garbage keeps the default", () => {
  assert.deepEqual(markGapGuardFromEnv({}), DEFAULT_MARK_GAP_GUARD);
  assert.deepEqual(markGapGuardFromEnv({ EVENT_X_MARK_GAP_CENTS: "12", EVENT_X_MARK_SPREAD_CENTS: "30" }), { gapCents: 12, spreadCents: 30 });
  assert.deepEqual(markGapGuardFromEnv({ EVENT_X_MARK_GAP_CENTS: "junk", EVENT_X_MARK_SPREAD_CENTS: "-3" }), DEFAULT_MARK_GAP_GUARD);
  assert.deepEqual(markGapGuardFromEnv({ EVENT_X_MARK_GAP_CENTS: "150" }), DEFAULT_MARK_GAP_GUARD, "more than a dollar is not a limit");
  assert.deepEqual(markGapVerdict(stub(), { gapCents: 0, spreadCents: 0 }), { refuse: false }, "off");
  assert.deepEqual(markGapVerdict(stub(), { gapCents: 0, spreadCents: 20 }), { refuse: false }, "gap test off, 2¢ straddle passes the spread test");
  assert.equal(markGapVerdict(stub(), { gapCents: 30, spreadCents: 20 }).refuse, false, "a 30¢ limit lets 27¢ through");
  assert.equal(markGapVerdict({ ...stub(), yesBidCents: 1, yesAskCents: 99 }, { gapCents: 0, spreadCents: 20 }).refuse, true, "spread test alone still holds");
});

test("mark-gap guard: the refusal has retail words everywhere a code is shown; none of them names a venue", () => {
  assert.equal(RETAIL_REFUSAL_COPY.mark_disagreement.code, "price_unsettled");
  for (const words of [
    RETAIL_REFUSAL_COPY.mark_disagreement.detail,
    PARLAY_REFUSAL_WORDS.mark_disagreement,
    PARLAY_REFUSAL_SHORT.mark_disagreement,
    refusalWord("mark_disagreement"),
  ]) {
    assert.ok(words && words.length > 0);
    assert.doesNotMatch(words, /kalshi|polymarket|prophet|novig|parlayx|aggregator|hedge|stub/i);
  }
});

test("demo service: the guard runs after the far-out guard, on the scan's shape, and leaves the routes examined intact", async () => {
  const { applyMarkGapGuard, applyQuoteRules } = await import("../scripts/eventProtectXDemoService");
  const NOW = Date.parse("2026-10-24T22:00:00.000Z");
  const now = new Date(NOW);
  const startIn = (hours: number): string => new Date(NOW + hours * 3_600_000).toISOString();
  const ok = {
    ok: true as const,
    kalshiTicker: "KXNBAGAME-X",
    contracts: 150,
    floorCents: 34,
    capCents: 64,
    creditCents: 1_585,
    grossCreditCents: 1_700,
    takeCents: 115,
    takeRule: "share" as const,
    feesCents: 20,
    tier: "balanced" as const,
    tiers: {},
    hedge: { action: "buy" as const, venue: "polymarket" as const, outcome: "Nets", tokenId: "t", sharesMilli: 105_000, avgPriceMilli: 230, worstPriceMilli: 230, costCents: 2_415 },
    evCostBps: -2_095,
  };
  const base = {
    kind: "sports" as const,
    league: "nba",
    market: { ticker: "KXNBAGAME-X", yesBidCents: 49, yesAskCents: 51 } as never,
    pair: null,
    sideName: "Celtics",
    eventTitle: "Nets vs. Celtics",
    eventTimeIso: startIn(69),
    parityNote: "",
    fingerprint: "x",
    markCents: 50,
    position: { contracts: 150, entryCents: 50, entrySource: "entered_now" as const, entryTime: null },
    quote: ok as never,
    route: "polymarket" as const,
    evBps: -2_095,
    routesChecked: [
      { route: "polymarket" as const, ok: true, evCostBps: -2_095, creditCents: 1_585 },
      { route: "kalshi_self" as const, ok: false, evCostBps: null, creditCents: null, detail: "no credit" },
    ],
    books: { pmNoBook: noBook(23) },
    // the feed supplied the hedge book, so the far-out guard stands aside: this is the case it misses
    bookOrigins: { polymarket: "aggregator" as const, kalshi: "direct" as const },
  };
  const refused = applyMarkGapGuard(base as never);
  assert.equal(refused.quote.ok, false);
  assert.equal(!refused.quote.ok && refused.quote.code, "mark_disagreement");
  assert.equal(refused.route, null);
  assert.equal(refused.evBps, null);
  assert.deepEqual(refused.routesChecked, base.routesChecked, "what each route said is kept for the operator");

  // the whole pipeline (defaults) refuses the same row for the same reason, days out or hours out
  for (const hours of [69, 5]) {
    const piped = applyQuoteRules({ ...base, eventTimeIso: startIn(hours) } as never, now);
    assert.equal(!piped.quote.ok && piped.quote.code, "mark_disagreement", `${hours}h out`);
  }

  // the market's own side tightening around the hedge venue's price opens the row
  const agreeing = { ...base, markCents: 76, market: { ticker: "KXNBAGAME-X", yesBidCents: 75, yesAskCents: 77 } };
  assert.equal(applyMarkGapGuard(agreeing as never), agreeing as never, "returned as is");
  assert.equal(applyQuoteRules({ ...base, markCents: 76, market: { ticker: "KXNBAGAME-X", yesBidCents: 75, yesAskCents: 77 }, eventTimeIso: startIn(5) } as never, now).quote.ok, true);

  // the own-No-side route is not held to it
  const self = applyMarkGapGuard({ ...base, route: "kalshi_self" } as never);
  assert.equal(self.quote.ok, true);

  // a refusal already made is left alone
  const earlier = applyQuoteRules({ ...base, quote: { ok: false, code: "pm_book_empty", detail: "x" }, route: null, evBps: null } as never, now);
  assert.equal(!earlier.quote.ok && earlier.quote.code, "pm_book_empty");
});
