/**
 * Far-out guard: no cross-venue route on a game nobody has a real book for yet. The rule is pure
 * (farOutGuard.ts); the demo service applies it last in the quote pipeline, to the scan and the
 * lock alike, and the refusal has words in every retail map.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FAR_OUT_GUARD, farOutGuardFromEnv, farOutVerdict, type FarOutGuardInputs } from "../src/eventCollar/crossVenue/farOutGuard";
import { RETAIL_REFUSAL_COPY } from "../src/eventCollar/retailShowcase";
import { PARLAY_REFUSAL_SHORT, PARLAY_REFUSAL_WORDS } from "../src/eventCollar/crossVenue/parlayRetail";
import { refusalWord } from "../src/eventCollar/crossVenue/shadowVenues";

// the demo module must not start its server or prewarm a scan when imported below
process.env.NODE_ENV = "test";
process.env.EVENT_X_ADMIN_TOKEN = "t0ken";

const NOW = Date.parse("2026-10-24T22:00:00.000Z");
const startIn = (hours: number): string => new Date(NOW + hours * 3_600_000).toISOString();

/** the far-out placeholder: cross-venue route, Kalshi's side could not fund it, the feed had nothing */
const placeholder = (hours: number): FarOutGuardInputs => ({
  kind: "sports",
  route: "polymarket",
  eventTimeIso: startIn(hours),
  nowMs: NOW,
  kalshiRouteOk: false,
  feedSuppliedPmBook: false,
});

test("far-out guard: a cross-venue quote days out with no real book anywhere is deferred, with the hours and the window in the words", () => {
  const v = farOutVerdict(placeholder(70));
  assert.ok(v.defer);
  assert.equal(v.code, "far_out_no_book");
  assert.equal(v.hoursToStart, 70);
  assert.match(v.detail, /70h to start/);
  assert.match(v.detail, /opens inside 24h/);
});

test("far-out guard: inside the window it stands aside, whatever the books look like", () => {
  assert.deepEqual(farOutVerdict(placeholder(24)), { defer: false }, "exactly at the window is inside it");
  assert.deepEqual(farOutVerdict(placeholder(2)), { defer: false });
  assert.deepEqual(farOutVerdict(placeholder(-1)), { defer: false }, "a game already started is the pricer's refusal, not this one");
});

test("far-out guard: one real book is enough: Kalshi's own side funding it, or the feed carrying the second venue", () => {
  assert.deepEqual(farOutVerdict({ ...placeholder(70), kalshiRouteOk: true }), { defer: false });
  assert.deepEqual(farOutVerdict({ ...placeholder(70), feedSuppliedPmBook: true }), { defer: false });
});

test("far-out guard: only the cross-venue route on a game is held to it", () => {
  assert.deepEqual(farOutVerdict({ ...placeholder(70), route: "kalshi_self" }), { defer: false }, "the own-No-side route is the real book");
  assert.deepEqual(farOutVerdict({ ...placeholder(70), route: null }), { defer: false }, "every route refused: nothing to defer");
  assert.deepEqual(farOutVerdict({ ...placeholder(70), kind: "crypto" }), { defer: false });
  assert.deepEqual(farOutVerdict({ ...placeholder(70), eventTimeIso: "not a date" }), { defer: false });
});

test("far-out guard: the env sets the window; 0 turns the rule off; garbage keeps the default", () => {
  assert.deepEqual(farOutGuardFromEnv({}), DEFAULT_FAR_OUT_GUARD);
  assert.deepEqual(farOutGuardFromEnv({ EVENT_X_FAR_OUT_HOURS: "48" }), { hours: 48 });
  assert.deepEqual(farOutGuardFromEnv({ EVENT_X_FAR_OUT_HOURS: "junk" }), { hours: 24 });
  assert.deepEqual(farOutGuardFromEnv({ EVENT_X_FAR_OUT_HOURS: "-3" }), { hours: 24 });
  assert.deepEqual(farOutVerdict(placeholder(70), { hours: 0 }), { defer: false }, "off");
  assert.equal(farOutVerdict(placeholder(70), { hours: 48 }).defer, true);
  assert.equal(farOutVerdict(placeholder(40), { hours: 48 }).defer, false);
});

test("far-out guard: the refusal has retail words everywhere a code is shown; none of them names a venue", () => {
  assert.equal(RETAIL_REFUSAL_COPY.far_out_no_book.code, "too_early");
  for (const words of [RETAIL_REFUSAL_COPY.far_out_no_book.detail, PARLAY_REFUSAL_WORDS.far_out_no_book, PARLAY_REFUSAL_SHORT.far_out_no_book, refusalWord("far_out_no_book")]) {
    assert.ok(words && words.length > 0);
    assert.doesNotMatch(words, /kalshi|polymarket|prophet|novig|parlayx|aggregator|hedge/i);
  }
});

test("demo service: the guard runs last in the pipeline, on the scan's shape, and leaves the routes examined intact", async () => {
  const { applyFarOutGuard, applyQuoteRules } = await import("../scripts/eventProtectXDemoService");
  const now = new Date(NOW);
  const ok = {
    ok: true as const,
    kalshiTicker: "KXNBAGAME-X",
    floorCents: 34,
    capCents: 64,
    creditCents: 1_585,
    grossCreditCents: 1_700,
    takeCents: 115,
    takeRule: "share" as const,
    feesCents: 20,
    tier: "balanced" as const,
    tiers: {},
    hedge: { action: "buy" as const, venue: "polymarket" as const, outcome: "Nets", tokenId: "t", sharesMilli: 105_000, avgPriceMilli: 100, worstPriceMilli: 100, costCents: 1_050 },
    evCostBps: -2_095,
  };
  const base = {
    kind: "sports" as const,
    league: "nba",
    market: { ticker: "KXNBAGAME-X" } as never,
    pair: null,
    sideName: "Celtics",
    eventTitle: "Nets vs. Celtics",
    eventTimeIso: startIn(69),
    parityNote: "",
    fingerprint: "x",
    markCents: 49,
    position: { contracts: 150, entryCents: 49, entrySource: "entered_now" as const, entryTime: null },
    quote: ok as never,
    route: "polymarket" as const,
    evBps: -2_095,
    routesChecked: [
      { route: "polymarket" as const, ok: true, evCostBps: -2_095, creditCents: 1_585 },
      { route: "kalshi_self" as const, ok: false, evCostBps: null, creditCents: null, detail: "no credit" },
    ],
    books: {},
    bookOrigins: { polymarket: "direct" as const, kalshi: "direct" as const },
  };
  const deferred = applyFarOutGuard(base as never, now, { hours: 24 });
  assert.equal(deferred.quote.ok, false);
  assert.equal(!deferred.quote.ok && deferred.quote.code, "far_out_no_book");
  assert.equal(deferred.route, null);
  assert.equal(deferred.evBps, null);
  assert.deepEqual(deferred.routesChecked, base.routesChecked, "what each route said is kept for the operator");

  // the feed carrying the second venue's book is a real book: no deferral
  const fed = applyFarOutGuard({ ...base, bookOrigins: { polymarket: "aggregator", kalshi: "direct" } } as never, now, { hours: 24 });
  assert.equal(fed, fed, "returned as is");
  assert.equal(fed.quote.ok, true);
  // no feed configured at all (older deploys, the venues read directly): the rule still holds on Kalshi's empty side
  const unfed = applyFarOutGuard({ ...base, bookOrigins: undefined } as never, now, { hours: 24 });
  assert.equal(unfed.quote.ok, false);
  // inside the window the same books open
  const soon = applyFarOutGuard({ ...base, eventTimeIso: startIn(5) } as never, now, { hours: 24 });
  assert.equal(soon.quote.ok, true);

  // through the whole pipeline (defaults: 24h), a refusal already made is left alone
  const refused = applyQuoteRules({ ...base, quote: { ok: false, code: "pm_book_empty", detail: "x" }, route: null, evBps: null } as never, now);
  assert.equal(!refused.quote.ok && refused.quote.code, "pm_book_empty");
});
