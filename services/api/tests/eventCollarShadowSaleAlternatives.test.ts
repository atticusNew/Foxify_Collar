/**
 * Own sale and better bid on every record line (shadowSaleAlternatives.ts): the two alternatives
 * priced from the books the line was quoted on, what is written beside the collar, old ledger
 * lines replaying untouched, the record summed, and the worker writing the measurement on a scan
 * line without one more venue call.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteBetterBid } from "../src/eventCollar/crossVenue/betterBid";
import { walkKalshiBids } from "../src/eventCollar/crossVenue/earlyClose";
import { DEFAULT_TAIL_PROBABILITIES, chooseRoute, rulesFor, tableRules, tailProbabilities } from "../src/eventCollar/crossVenue/hedgeRouting";
import { quoteLadderWrap, type NoAskLevel } from "../src/eventCollar/crossVenue/kalshiLadder";
import { counterfactualsFor, type CounterfactualInputs, type ShadowCounterfactuals } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { appendShadowRecord, loadShadowPositions, settlePayouts, summarizeShadow, type ShadowOpenRecord } from "../src/eventCollar/crossVenue/shadowLedger";
import { saleAlternativesFor, summarizeSaleAlternatives, type ShadowBetterBidOn, type ShadowSaleAlternatives } from "../src/eventCollar/crossVenue/shadowSaleAlternatives";
import { DEFAULT_CROSS_CONFIG, capTotalCents, centsUpOf, floorTotalCents, type MatchedPair, type PmBook } from "../src/eventCollar/crossVenue/types";
import type { ReferenceBook } from "../src/eventCollar/crossVenue/venueBooks";
import type { CandidateResult, GameMarketRow, OneQuoteInputs, OneQuoteResult, ScanState } from "../scripts/eventProtectXDemoService";

const LOCK = "2026-09-20T17:00:00.000Z";
const NOW = new Date("2026-09-20T11:00:00.000Z");
const TICKER = "KXMLBGAME-26SEP20NYYBOS-NYY";
/** the market's No side as the scan reads it: 41c, 42c, 43c. The same resting orders are YES bids at 59c, 58c, 57c. */
const NO_ASKS: NoAskLevel[] = [
  { priceCents: 41, qtyMilli: 300_000 },
  { priceCents: 42, qtyMilli: 400_000 },
  { priceCents: 43, qtyMilli: 400_000 },
];
const CFG = { ...DEFAULT_CROSS_CONFIG, floorOffsetsCents: [3, 5, 8, 10, 12, 15, 20, 25, 30], capOffsetsCents: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25], defaultTier: "tight" as const, minimumCredit: { cents: 0, bpsOfStake: 0 } };

/** the record's collar on this line: floor 48c, cap 63c, hedged on the market's own No side */
function liveQuote(contracts = 150) {
  const q = quoteLadderWrap({ pair: { kalshi: { ticker: TICKER }, gameStartTime: LOCK }, markCents: 60, entryCents: 55, contracts, now: NOW, noAsks: NO_ASKS, config: CFG });
  assert.ok(q.ok, JSON.stringify(q));
  return q;
}

function pair(): MatchedPair {
  return {
    league: "mlb",
    kalshi: { ticker: TICKER, eventTicker: "KXMLBGAME-26SEP20NYYBOS", title: "Yankees win", subtitle: "Yankees", strike: 0, strikeType: "", status: "active", openTime: "", closeTime: LOCK, yesBidCents: 59, yesAskCents: 63, lastPriceCents: 60, volume: 1000, openInterest: 500, rulesPrimary: "" },
    pm: {
      eventSlug: "mlb-nyy-bos-2026-09-20",
      eventTitle: "New York Yankees vs. Boston Red Sox",
      question: "New York Yankees vs. Boston Red Sox",
      conditionId: "0xdef",
      outcomes: ["New York Yankees", "Boston Red Sox"],
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
    parityNote: "",
    fingerprint: "mlb:NYY:BOS:2026-09-20",
  };
}

/** the other side offered at one price on some other venue's book */
const otherBook = (priceMilli: number, sizeMilli = 1_000_000): PmBook => ({ tokenId: "other", asks: [{ priceMilli, sizeMilli }], bids: [], minOrderSizeShares: 5, tickMilli: 10 });

function inputs(o: Partial<CounterfactualInputs> = {}): CounterfactualInputs {
  return { route: "kalshi_self", ticker: TICKER, lockTimeIso: LOCK, pair: pair(), markCents: 60, entryCents: 55, contracts: 150, now: NOW, config: CFG, holderAskCents: 63, books: { noAsks: NO_ASKS }, ...o };
}

// ---------------------------------------------------------------------------
// the alternatives on one line
// ---------------------------------------------------------------------------

test("sale alternatives: the own sale is the collar's hedge size sold into the venue's own bids, read off the No side the scan already holds", () => {
  const live = liveQuote();
  assert.deepEqual([live.floorCents, live.capCents, live.creditCents], [48, 63, 68]);
  const s = saleAlternativesFor(inputs({ pair: null }), live);

  // as many contracts as the collar hedges: (48 + 100 - 63) x 150 / 100 = 127.5
  assert.equal(s.soldMilli, 127_500);
  assert.equal(s.soldMilli, centsUpOf(48 + 100 - 63, 150) * 10);
  assert.equal(live.hedge.venue === "kalshi" ? live.hedge.contractsMilli : 0, 127_500, "the collar's own hedge is the same number of contracts");
  assert.deepEqual([s.holderVenue, s.holderAskCents], ["kalshi", 63]);

  // 127.5 x 59c = $75.225, floored; Kalshi's taker fee ceil(0.07 x 127.5 x 0.59 x 0.41) = $2.16
  assert.ok(s.ownSale.ok);
  assert.deepEqual([s.ownSale.grossCents, s.ownSale.feeCents, s.ownSale.cashCents], [7522, 216, 7306]);
  // the 22.5 contracts kept pay $1 each if the side wins
  assert.equal(s.ownSale.capCents, 7306 + 2250);
  assert.deepEqual([s.ownSale.worstPriceMilli, s.ownSale.bookDepthMilli], [590, 1_100_000]);
  // the YES bids are the No asks flipped: the house walk on the flipped levels agrees
  const house = walkKalshiBids(NO_ASKS.map((l) => ({ priceCents: 100 - l.priceCents, qtyMilli: l.qtyMilli })), 127_500);
  assert.ok(house);
  assert.deepEqual([s.ownSale.grossCents, s.ownSale.feeCents], [house.proceedsCents, house.feeCents]);

  // the two results differ by the same sum under either shape, so the floors compare like for like
  const collarGap = capTotalCents({ capCents: 63, contracts: 150, creditCents: 68 }) - floorTotalCents({ floorCents: 48, contracts: 150, creditCents: 68 });
  assert.equal(s.ownSale.capCents - s.ownSale.cashCents, collarGap);
  // on this line the collar is hedged on the same bids: the own sale beats its floor by the take, give or take the fee's rounding
  assert.equal(s.ownSale.cashCents - floorTotalCents({ floorCents: 48, contracts: 150, creditCents: 68 }), 38);
  assert.equal(live.takeCents, 38);

  // a strike with no verified pair has no other venue to buy the other side on
  assert.deepEqual(s.betterBid, { ok: false, refused: "no_other_venue", venuesPriced: 0 });
  assert.deepEqual(s.books, []);
});

test("sale alternatives: the better bid is tried on every other book the scan holds and the best for the holder is kept", () => {
  const live = liveQuote();
  const references: ReferenceBook[] = [
    { id: "signed_v3", book: otherBook(345) },
    { id: "long_short_v1", book: otherBook(330) },
    { id: "outcome_v1", book: otherBook(300) },
    { id: "partner_mm", book: null, reason: "not_listed" },
    { id: "aggregated_mm", book: otherBook(360) },
  ];
  const i = inputs({ books: { noAsks: NO_ASKS, pmNoBook: otherBook(350), pxNoBook: otherBook(340), references } });
  const s = saleAlternativesFor(i, live);

  assert.deepEqual(s.books.map((b) => [b.book, b.ok ? "quoted" : b.refused]), [
    ["polymarket", "quoted"],
    ["prophetx", "quoted"],
    ["signed_v3", "quoted"],
    ["long_short_v1", "quoted"],
    // the venue whose fee is not on the market cannot be priced after fees, however cheap its book looks
    ["outcome_v1", "fee_unpriced"],
    ["aggregated_mm", "quoted"],
  ]);
  // four venues: two of the books are one venue read twice, and the unpriced one is not a comparison
  assert.equal(s.betterBid.venuesPriced, 4);

  // every book that can pay 62c pays the holder the same: 127.5 x 62c = $79.05 less ceil(0.07 x 127.5 x 0.62 x 0.38) = $2.11
  const at62 = s.books.filter((b): b is Extract<ShadowBetterBidOn, { ok: true }> => b.ok && b.bidMilli === 620);
  assert.deepEqual(at62.map((b) => b.book), ["polymarket", "prophetx", "signed_v3", "long_short_v1"]);
  for (const b of at62) assert.deepEqual([b.cashCents, b.improvementCents, b.boughtMilli], [7694, 7694 - 7306, 127_500]);
  // the dearest other side (36c) can only pay 61c
  const dear = s.books.find((b) => b.book === "aggregated_mm");
  assert.ok(dear?.ok && dear.bidMilli === 610 && dear.improvementCents < 388);

  // among books that pay the holder the same, the cheapest other side is kept: 33c
  assert.ok(s.betterBid.ok);
  assert.equal(s.betterBid.book, "long_short_v1");
  // us: $127.50 back, less $79.05 and the resting bid priced at the taker formula ($2.11), less 127.5 x 33c = $42.075 rounded up
  assert.equal(s.betterBid.lockedCents, 12_750 - 7905 - 211 - 4208);
  assert.equal(s.betterBid.ifSideWinsCents, s.betterBid.lockedCents);
  assert.equal(s.betterBid.lockedCents, s.betterBid.takeCents + s.betterBid.tailChargeCents + s.betterBid.residualCents);
  // the venue's 63c offer stopped the bid, not our take
  assert.equal(s.betterBid.bidLimitedBy, "venue_offer");
  // one leg: 127.5 bought at 62c ($79.05 + $2.11) sold back into the 59c bid ($75.22 - $2.16)
  assert.equal(s.betterBid.oneLegLossCents, 7905 + 211 - (7522 - 216));

  // ProphetX's own book, raw: the fee is taken only if its contract wins, and the line says what we are left with each way
  const px = s.books.find((b) => b.book === "prophetx");
  assert.ok(px?.ok);
  // 127.5 x 34c = $43.35 staked; 2% of the $84.15 it would gain = $1.69, rounded up
  assert.deepEqual([px.lockedCents, px.ifSideWinsCents], [12_750 - 7905 - 211 - 4335 - 169, 12_750 - 7905 - 211 - 4335]);

  // the same figures straight from the quote: the line stores what betterBid.ts priced, nothing else
  const direct = quoteBetterBid({
    positionMilli: 150_000,
    sellMilli: 127_500,
    holderVenue: { bids: NO_ASKS.map((l) => ({ priceMilli: (100 - l.priceCents) * 10, sizeMilli: l.qtyMilli })), bestAskMilli: 630, tickMilli: 10, fee: { kind: "kalshi" } },
    otherVenue: { asks: otherBook(350).asks, fee: { kind: "polymarket", feeBps: 0, flatCents: 0 }, minOrderMilli: 5000 },
    tail: { holderRules: rulesFor("kalshi", "mlb"), otherRules: rulesFor("polymarket", "mlb"), probabilities: tailProbabilities("mlb"), markCents: 60 },
    take: CFG,
  });
  const pm = s.books[0];
  assert.ok(direct.ok && pm.ok);
  assert.deepEqual([pm.bidMilli, pm.improvementCents, pm.lockedCents, pm.takeCents, pm.tailChargeCents, pm.residualCents], [direct.bidMilli, direct.holder.improvementCents, direct.us.lockedCents, direct.us.takeCents, direct.us.tailChargeCents, direct.us.residualCents]);

  // a venue whose rules were never read is charged at the worst reading of every tail: more than one whose rules were
  const unread = s.books.find((b) => b.book === "long_short_v1");
  assert.ok(unread?.ok && pm.ok && unread.tailChargeCents > pm.tailChargeCents);

  // the sensitivity: with our resting bid priced at no fee the same line leaves us the $2.11 more (the 63c offer still caps the bid)
  assert.deepEqual(s.ifRestingBidFree, { ok: true, book: "long_short_v1", improvementCents: 388, lockedCents: s.betterBid.lockedCents + 211 });

  // the holder's venue's offer comes from the scan's market snapshot; without it the pair's own copy is used
  const fromPair = saleAlternativesFor({ ...i, holderAskCents: undefined }, live);
  assert.equal(fromPair.holderAskCents, 63);
  // and where the venue shows no offer there is nothing for the bid to rest under
  const noOffer = saleAlternativesFor({ ...i, holderAskCents: 100 }, live);
  assert.equal(noOffer.holderAskCents, null);
  assert.ok(noOffer.betterBid.ok && noOffer.betterBid.bidMilli > 620 && noOffer.betterBid.bidLimitedBy === "our_take");
});

test("sale alternatives: every way there is no measurement is a plain refusal on the line", () => {
  const live = liveQuote();
  const withOther = { noAsks: NO_ASKS, pmNoBook: otherBook(350) };

  // venues with no sell at all: there is no own sale to measure
  for (const holderVenue of ["novig", "prophetx"] as const) {
    const s = saleAlternativesFor(inputs({ books: withOther, settlement: { holderVenue, holderRules: tableRules(holderVenue, "mlb"), probabilities: tailProbabilities("mlb") } }), live);
    assert.deepEqual([s.holderVenue, s.ownSale, s.betterBid, s.books], [holderVenue, { ok: false, refused: "holder_venue_cannot_sell" }, { ok: false, refused: "holder_venue_cannot_sell", venuesPriced: 0 }, []]);
  }
  // a holder whose venue's bids the scan does not read: said, not guessed from another venue's book
  const elsewhere = saleAlternativesFor(inputs({ books: withOther, settlement: { holderVenue: "polymarket", holderRules: tableRules("polymarket", "mlb"), probabilities: tailProbabilities("mlb") } }), live);
  assert.deepEqual([elsewhere.ownSale, elsewhere.betterBid.ok], [{ ok: false, refused: "holder_venue_bids_not_read" }, false]);

  // the market's own book was not kept
  const noBook = saleAlternativesFor(inputs({ books: { pmNoBook: otherBook(350) } }), live);
  assert.deepEqual([noBook.ownSale, noBook.betterBid], [{ ok: false, refused: "book_not_retained" }, { ok: false, refused: "book_not_retained", venuesPriced: 0 }]);

  // the venue's bids cannot take the sale: no own sale, so nothing to improve on
  const thin = saleAlternativesFor(inputs({ books: { noAsks: [{ priceCents: 41, qtyMilli: 50_000 }], pmNoBook: otherBook(350) } }), live);
  assert.deepEqual([thin.ownSale, thin.betterBid], [{ ok: false, refused: "book_too_thin" }, { ok: false, refused: "own_sale_unpriced", venuesPriced: 0 }]);

  // a game, and no other venue's book in hand
  const alone = saleAlternativesFor(inputs(), live);
  assert.ok(alone.ownSale.ok);
  assert.deepEqual([alone.betterBid, alone.books, alone.ifRestingBidFree], [{ ok: false, refused: "no_other_book_read", venuesPriced: 0 }, [], { ok: false, refused: "no_other_book_read" }]);
  // a reference read with no offers on it is not a venue compared
  const empty = saleAlternativesFor(inputs({ books: { noAsks: NO_ASKS, references: [{ id: "signed_v3", book: { ...otherBook(350), asks: [] } }] } }), live);
  assert.deepEqual([empty.betterBid, empty.books], [{ ok: false, refused: "no_other_book_read", venuesPriced: 0 }, [{ book: "signed_v3", ok: false, refused: "other_side_empty" }]]);

  // a book that is not a book: the line says the measurement failed, and nothing is thrown at the record
  const broken = saleAlternativesFor(inputs({ books: { noAsks: [null as unknown as NoAskLevel], pmNoBook: otherBook(350) }, settlement: { holderVenue: "kalshi", holderRules: rulesFor("kalshi", "mlb"), probabilities: tailProbabilities("mlb") } }), live);
  assert.deepEqual(broken, { holderVenue: "kalshi", holderAskCents: null, soldMilli: 0, ownSale: { ok: false, refused: "measurement_failed" }, betterBid: { ok: false, refused: "measurement_failed", venuesPriced: 0 }, books: [] });

  // other venues read, none cheap enough: 59c and 41c make $1 before a fee
  const rich = saleAlternativesFor(inputs({ books: { noAsks: NO_ASKS, pmNoBook: otherBook(410), pxNoBook: otherBook(400) } }), live);
  assert.deepEqual(rich.betterBid, { ok: false, refused: "no_venue_improves", venuesPriced: 2 });
  assert.deepEqual(rich.books, [
    { book: "polymarket", ok: false, refused: "no_improvement" },
    { book: "prophetx", ok: false, refused: "no_improvement" },
  ]);
  // the other side too thin for the size on one venue, fine on another: the line keeps both answers
  const mixed = saleAlternativesFor(inputs({ books: { noAsks: NO_ASKS, pmNoBook: otherBook(350, 50_000), pxNoBook: otherBook(340) } }), live);
  assert.deepEqual(mixed.books.map((b) => (b.ok ? "quoted" : b.refused)), ["other_side_too_thin", "quoted"]);
  assert.ok(mixed.betterBid.ok && mixed.betterBid.book === "prophetx" && mixed.betterBid.venuesPriced === 2);
});

test("sale alternatives: the tails are priced with the routing's own rules and probabilities for the line", () => {
  const live = liveQuote();
  const books = { noAsks: NO_ASKS, pxNoBook: otherBook(330) };
  // no routing on the line: the league's table rules and its usual tail odds
  const [table] = saleAlternativesFor(inputs({ books }), live).books;
  // the routing's own reading: a game that ties one time in five, where the user's venue pays half on a tie
  const [tieProne] = saleAlternativesFor(inputs({ books, settlement: { holderVenue: "kalshi", holderRules: rulesFor("kalshi", "nfl"), probabilities: { tie: 0.2, postponed: 0, abandoned: 0, corrected: 0 } } }), live).books;
  assert.ok(table.ok && tieProne.ok);
  // on a tie the user's venue pays 50c on the contract we bought and the other venue hands back the 33c paid:
  // 17c short of $1, one time in five, on 127.5 contracts = $4.335, rounded up. A dearer tail leaves less to bid with: 60c, not 62c
  assert.deepEqual([table.bidMilli, table.tailChargeCents, table.improvementCents], [620, 19, 388]);
  assert.deepEqual([tieProne.bidMilli, tieProne.tailChargeCents, tieProne.improvementCents], [600, 434, 129]);
  for (const b of [table, tieProne]) assert.equal(b.lockedCents, b.takeCents + b.tailChargeCents + b.residualCents);
});

// ---------------------------------------------------------------------------
// the record: what is written, and old lines replaying
// ---------------------------------------------------------------------------

function openRecord(ticker: string, at: string, cf: ShadowCounterfactuals | undefined, extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord {
  const q = liveQuote();
  return {
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
    floorCents: q.floorCents,
    capCents: q.capCents,
    creditCents: q.creditCents,
    evCostBps: q.evCostBps,
    route: "kalshi_self",
    feesCents: q.feesCents,
    takeCents: q.takeCents,
    ...(cf ? { counterfactuals: cf } : {}),
    ...extra,
  };
}

test("sale alternatives: written beside the other counterfactuals; a ledger of old lines replays exactly as before", () => {
  const live = liveQuote();
  const cf = counterfactualsFor(inputs({ books: { noAsks: NO_ASKS, pmNoBook: otherBook(350) } }), live);
  // the new field sits beside the old ones and none of them moved
  assert.ok(cf.sale && cf.sale.ownSale.ok && cf.sale.betterBid.ok);
  assert.deepEqual(cf.sale, saleAlternativesFor(inputs({ books: { noAsks: NO_ASKS, pmNoBook: otherBook(350) } }), live));
  const { sale: _sale, ...before } = cf;
  assert.deepEqual(Object.keys(before).sort(), ["alternatives", "feeRules", "routes", "sizeLadder"]);
  assert.ok(cf.routes?.kalshi_self.ok && cf.feeRules.min_25bps.ok && cf.sizeLadder.length === 3);
  // it survives the ledger's JSON untouched: integers and plain words only
  assert.deepEqual(JSON.parse(JSON.stringify(cf.sale)), cf.sale);
  for (const n of [cf.sale.soldMilli, cf.sale.ownSale.cashCents, cf.sale.betterBid.improvementCents, cf.sale.betterBid.lockedCents]) assert.ok(Number.isInteger(n));

  const dir = mkdtempSync(join(tmpdir(), "shadow-sale-replay-"));
  const oldOnly = join(dir, "old.jsonl");
  const mixed = join(dir, "mixed.jsonl");
  // three generations of line: before counterfactuals existed, with counterfactuals and no sale block, and today's
  const legacy = JSON.stringify(openRecord("LEGACY", "2026-09-19T10:00:00.000Z", undefined));
  const v2 = JSON.stringify(openRecord("V2", "2026-09-19T11:00:00.000Z", before as ShadowCounterfactuals));
  assert.ok(!legacy.includes("counterfactuals") && v2.includes("counterfactuals") && !v2.includes('"sale"'));
  for (const path of [oldOnly, mixed]) {
    appendFileSync(path, `${legacy}\n${v2}\n`);
    appendShadowRecord(path, { type: "settle", at: "2026-09-19T21:00:00.000Z", ticker: "LEGACY", result: "no" });
    appendShadowRecord(path, { type: "settle", at: "2026-09-19T21:00:00.000Z", ticker: "V2", result: "yes" });
  }
  appendShadowRecord(mixed, openRecord("TODAY", "2026-09-20T11:00:00.000Z", cf));
  appendShadowRecord(mixed, { type: "settle", at: "2026-09-20T21:00:00.000Z", ticker: "TODAY", result: "yes" });

  const old = loadShadowPositions(oldOnly);
  const all = loadShadowPositions(mixed);
  assert.deepEqual(old.map((p) => [p.ticker, p.status, p.result]), [["LEGACY", "settled", "no"], ["V2", "settled", "yes"]]);
  // the old lines are the same positions, to the field, with or without a new line after them
  assert.deepEqual(all.slice(0, 2), old);
  assert.deepEqual([old[0].protectedCents, old[0].nakedCents], [settlePayouts(old[0], "no").protectedCents, 0]);
  assert.equal(old[0].counterfactuals, undefined);
  assert.equal(old[1].counterfactuals?.sale, undefined);
  assert.deepEqual(all[2].counterfactuals?.sale, cf.sale);

  // the summary counts only lines that carry the measurement; old lines are not refusals
  const oldSummary = summarizeShadow(old);
  assert.deepEqual([oldSummary.settledCount, oldSummary.counterfactuals.positionsWithCounterfactuals, oldSummary.counterfactuals.sale.lines, oldSummary.counterfactuals.sale.recordedSince], [2, 1, 0, null]);
  assert.deepEqual(oldSummary.counterfactuals.sale.betterBid.refusals, {});
  const summary = summarizeShadow(all);
  assert.deepEqual([summary.settledCount, summary.counterfactuals.positionsWithCounterfactuals, summary.counterfactuals.sale.lines, summary.counterfactuals.sale.recordedSince], [3, 2, 1, "2026-09-20T11:00:00.000Z"]);
  // everything the old lines summed to is unchanged by the new line's block
  const { sale: _a, ...oldCf } = oldSummary.counterfactuals;
  const { sale: _b, ...againCf } = summarizeShadow(all.slice(0, 2)).counterfactuals;
  assert.deepEqual(againCf, oldCf);

});

// ---------------------------------------------------------------------------
// the record, summed
// ---------------------------------------------------------------------------

const quotedOn = (book: ShadowBetterBidOn["book"], o: { improvement: number; locked: number; wins?: number; take: number; tail: number; limited?: "venue_offer"; oneLeg: number | null }): Extract<ShadowBetterBidOn, { ok: true }> => ({
  book,
  ok: true,
  bidMilli: 620,
  boughtMilli: 50_000,
  cashCents: 0,
  improvementCents: o.improvement,
  lockedCents: o.locked,
  ifSideWinsCents: o.wins ?? o.locked,
  takeCents: o.take,
  tailChargeCents: o.tail,
  residualCents: o.locked - o.take - o.tail,
  bidLimitedBy: o.limited ?? "our_take",
  otherAvgPriceMilli: 350,
  oneLegLossCents: o.oneLeg,
});

/** a line of 100 contracts whose collar's floor, credit in, is $51.00 */
function line(ticker: string, sale: ShadowSaleAlternatives | undefined, extra: Partial<ShadowOpenRecord> = {}): ShadowOpenRecord {
  const cf = { alternatives: {}, feeRules: { share_only: { ok: false, refused: "x" }, min_25bps: { ok: false, refused: "x" } }, sizeLadder: [], ...(sale ? { sale } : {}) } as ShadowCounterfactuals;
  return { ...openRecord(ticker, `2026-09-2${ticker.slice(-1)}T11:00:00.000Z`, cf), contracts: 100, floorCents: 50, capCents: 65, creditCents: 100, ...extra };
}
const ownOk = (cashCents: number): ShadowSaleAlternatives["ownSale"] => ({ ok: true, grossCents: cashCents + 150, feeCents: 150, cashCents, capCents: cashCents + 1500, worstPriceMilli: 590, bookDepthMilli: 500_000 });
const SALE_BASE = { holderVenue: "kalshi" as const, holderAskCents: 63, soldMilli: 85_000 };

function summedLedger(): string {
  const path = join(mkdtempSync(join(tmpdir(), "shadow-sale-sum-")), "ledger.jsonl");
  const pmBid = quotedOn("polymarket", { improvement: 30, locked: 40, take: 10, tail: 5, oneLeg: 200 });
  const pxBid = quotedOn("prophetx", { improvement: 50, locked: 60, wins: 75, take: 20, tail: 10, limited: "venue_offer", oneLeg: null });
  // 1: the sale beats the collar's floor by $1.00; a better bid on the first of two venues; settles NO
  appendShadowRecord(path, line("L1", { ...SALE_BASE, ownSale: ownOk(5200), betterBid: { ...pmBid, venuesPriced: 2 }, books: [pmBid, { book: "signed_v3", ok: false, refused: "take_eats_it" }], ifRestingBidFree: { ok: true, book: "polymarket", improvementCents: 45, lockedCents: 60 } }));
  appendShadowRecord(path, { type: "settle", at: "2026-09-22T00:00:00.000Z", ticker: "L1", result: "no" });
  // 2: the sale falls $1.00 short; a better bid on a venue that charges only when its contract wins; settles YES
  appendShadowRecord(path, line("L2", { ...SALE_BASE, ownSale: ownOk(5000), betterBid: { ...pxBid, venuesPriced: 3 }, books: [{ book: "polymarket", ok: false, refused: "no_improvement" }, pxBid, { book: "long_short_v1", ok: false, refused: "tail_charge_eats_it" }], ifRestingBidFree: { ok: true, book: "prophetx", improvementCents: 70, lockedCents: 80 } }));
  appendShadowRecord(path, { type: "settle", at: "2026-09-22T00:00:00.000Z", ticker: "L2", result: "yes" });
  // 3: the sale matches the floor; another venue read, no better bid
  appendShadowRecord(path, line("L3", { ...SALE_BASE, ownSale: ownOk(5100), betterBid: { ok: false, refused: "no_venue_improves", venuesPriced: 1 }, books: [{ book: "polymarket", ok: false, refused: "no_improvement" }], ifRestingBidFree: { ok: false, refused: "no_venue_improves" } }));
  // 4: the venue's bids could not take the sale
  appendShadowRecord(path, line("L4", { ...SALE_BASE, ownSale: { ok: false, refused: "book_too_thin" }, betterBid: { ok: false, refused: "own_sale_unpriced", venuesPriced: 0 }, books: [] }));
  // 5: a crypto strike: own sale 50c ahead, no other venue; settles YES
  appendShadowRecord(path, line("L5", { ...SALE_BASE, ownSale: ownOk(5150), betterBid: { ok: false, refused: "no_other_venue", venuesPriced: 0 }, books: [] }, { kind: "crypto", league: "crypto" }));
  appendShadowRecord(path, { type: "settle", at: "2026-09-26T00:00:00.000Z", ticker: "L5", result: "yes" });
  // 6: voided, left out; 7: a line from before the measurement, left out
  appendShadowRecord(path, line("L6", { ...SALE_BASE, ownSale: ownOk(9000), betterBid: { ...pmBid, venuesPriced: 2 }, books: [pmBid] }));
  appendShadowRecord(path, { type: "void", at: "2026-09-22T00:00:00.000Z", ticker: "L6", reason: "no official result" });
  appendShadowRecord(path, line("L7", undefined));
  return path;
}

test("sale alternatives summary: counts, medians and totals in cents and in bps of stake; voided and old lines are left out", () => {
  const positions = loadShadowPositions(summedLedger());
  const m = summarizeSaleAlternatives(positions);
  assert.deepEqual([m.lines, m.recordedSince], [5, "2026-09-21T11:00:00.000Z"]);

  // own sale against the collar's floor ($51.00 on every line): +$1.00, -$1.00, 0, +50c
  const o = m.ownSale;
  assert.deepEqual([o.priced, o.unpriced, o.stakeCents], [4, 1, 40_000]);
  assert.deepEqual([o.vsCollarTotalCents, o.vsCollarTotalBpsOfStake], [50, 12]);
  // an even count: the two middle values 0 and 50c, their mean rounded down
  assert.deepEqual([o.vsCollarMedianCents, o.vsCollarMedianBpsOfStake], [25, 25]);
  assert.deepEqual([o.ahead, o.behind, o.level], [2, 1, 1]);
  // settled: line 1 lost (the sale's cash), lines 2 and 5 won (the cash plus $1 on the 15 kept); the collar and the untouched position beside them
  const [l1, l2, , , l5] = positions;
  assert.deepEqual([l1.ticker, l2.ticker, l5.ticker], ["L1", "L2", "L5"]);
  assert.deepEqual([l1.protectedCents, l2.protectedCents, l5.protectedCents], [5000 + 100, 6500 + 100, 6500 + 100]);
  assert.deepEqual(o.settled, { lines: 3, ownSaleCents: 5200 + (5000 + 1500) + (5150 + 1500), collarCents: 5100 + 6600 + 6600, untouchedCents: 20_000 });

  const b = m.betterBid;
  assert.deepEqual([b.compared, b.existed, b.mostVenues, b.stakeCents], [3, 2, 3, 20_000]);
  assert.deepEqual([b.improvementTotalCents, b.improvementMedianCents, b.improvementTotalBpsOfStake, b.improvementMedianBpsOfStake], [80, 40, 40, 40]);
  // our side: what we would be left with is the take, the tail charge and the named residual
  assert.deepEqual([b.lockedCents, b.takeCents, b.tailChargeCents, b.residualCents, b.limitedByVenueOffer], [100, 30, 15, 55, 1]);
  assert.equal(b.lockedCents, b.takeCents + b.tailChargeCents + b.residualCents);
  assert.deepEqual(b.refusals, { no_venue_improves: 1, own_sale_unpriced: 1, no_other_venue: 1 });
  assert.deepEqual(b.byBook, {
    polymarket: { tried: 3, quoted: 1, best: 1 },
    signed_v3: { tried: 1, quoted: 0, best: 0 },
    prophetx: { tried: 1, quoted: 1, best: 1 },
    long_short_v1: { tried: 1, quoted: 0, best: 0 },
  });
  assert.deepEqual(b.oneLeg, { priced: 1, unbounded: 1, totalCents: 200, worstCents: 200 });
  assert.deepEqual(b.ifRestingBidFree, { existed: 2, improvementTotalCents: 115 });
  // settled: line 1 lost (40c either way); line 2 won, so the other venue's contract lost and its fee was never taken (75c, not 60c)
  assert.deepEqual(b.settled, { lines: 2, usCents: 40 + 75 });

  // an odd count takes the middle value; nothing measured is null, not zero
  const three = summarizeSaleAlternatives(positions.filter((p) => ["L1", "L2", "L5"].includes(p.ticker)));
  assert.deepEqual([three.ownSale.vsCollarMedianCents, three.betterBid.improvementMedianCents], [50, 40]);
  const none = summarizeSaleAlternatives(positions.filter((p) => p.ticker === "L7"));
  assert.deepEqual([none.lines, none.ownSale.vsCollarMedianCents, none.betterBid.improvementMedianCents, none.betterBid.improvementTotalBpsOfStake], [0, null, null, null]);
});

// ---------------------------------------------------------------------------
// the worker: a scan line carries the measurement, from the books the scan handed over
// ---------------------------------------------------------------------------

test("shadow worker: a board line is written with its own sale and better bid from the scan's books; the public JSON names no venue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-sale-worker-"));
  const ledger = join(dir, "ledger.jsonl");
  process.env.NODE_ENV = "test";
  process.env.EVENT_SHADOW_LEDGER_PATH = ledger;
  process.env.EVENT_SHADOW_LOCK_LEDGER_PATH = join(dir, "lock-ledger.jsonl");
  process.env.EVENT_LASTLEG_LEDGER_PATH = join(dir, "lastleg.jsonl");
  process.env.EVENT_HEDGE_RECEIPTS_PATH = join(dir, "hedge-receipts.jsonl");
  process.env.EVENT_X_ADMIN_TOKEN = "op-secret";
  process.env.EVENT_SHADOW_LOCK_KEY = "lock-key-0123456789";
  delete process.env.EVENT_HEDGE_STRATEGY;
  delete process.env.KALSHI_API_KEY_ID;
  delete process.env.KALSHI_PRIVATE_KEY_PEM;
  const worker = await import("../scripts/eventShadowWorker");

  const start = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const p = { ...pair(), gameStartTime: start };
  // the pair's own copy of the market says 99c; the scan's market snapshot says 63c, and that is the one a bid rests under
  p.kalshi = { ...p.kalshi, closeTime: start, yesAskCents: 99 };
  const candidate = (contracts: number): CandidateResult => {
    const quote = quoteLadderWrap({ pair: { kalshi: { ticker: TICKER }, gameStartTime: start }, markCents: 60, entryCents: 55, contracts, now: new Date(), noAsks: NO_ASKS, config: DEFAULT_CROSS_CONFIG });
    assert.ok(quote.ok, JSON.stringify(quote));
    const routing = chooseRoute({
      holderVenue: "kalshi",
      league: "mlb",
      holderRules: tableRules("kalshi", "mlb"),
      markCents: 60,
      contracts,
      probabilities: DEFAULT_TAIL_PROBABILITIES.mlb,
      routes: [{ route: "kalshi_self", ok: true, evCostBps: quote.evCostBps, creditCents: quote.creditCents, hedge: { unitsMilli: quote.hedge.venue === "kalshi" ? quote.hedge.contractsMilli : 0, avgPriceCents: 41, floorCents: quote.floorCents, capCents: quote.capCents }, gates: { gameMatch: true, venueOpen: true, executable: true }, rules: tableRules("kalshi", "mlb") }],
    });
    return {
      kind: "sports",
      league: "mlb",
      market: { ...p.kalshi, yesAskCents: 63 },
      pair: p,
      sideName: "New York Yankees",
      eventTitle: "Yankees at Red Sox",
      eventTimeIso: start,
      parityNote: "",
      fingerprint: p.fingerprint,
      markCents: 60,
      position: { contracts, entryCents: 55, entrySource: "entered_now", entryTime: null },
      quote,
      route: "kalshi_self",
      evBps: quote.evCostBps,
      routesChecked: [],
      books: { noAsks: NO_ASKS, pmNoBook: otherBook(350), references: [{ id: "long_short_v1", book: otherBook(330) }] },
      routing,
    };
  };
  let scans = 0;
  let quotes = 0;
  const markets: GameMarketRow[] = [{ ticker: TICKER, league: "mlb", sideName: "New York Yankees", title: "Winner?", dateIso: "2026-09-20", closeTimeIso: start, markCents: 60, startIso: start, protectable: true, protectableUntilIso: start }];
  worker.wireLockEngine({
    listGameMarkets: async () => markets,
    quoteOne: async (i: OneQuoteInputs): Promise<OneQuoteResult> => {
      quotes += 1;
      return { ok: true, result: candidate(i.contracts) };
    },
    scan: async (): Promise<ScanState> => {
      scans += 1;
      const res = candidate(150);
      return { atIso: new Date().toISOString(), rows: [{ res, evBps: res.quote.ok ? res.quote.evCostBps : 0 }], fallback: null, fetchFailures: 0 };
    },
  });
  await new Promise<void>((r) => worker.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  try {
    await worker.scanTick();
    // one scan, nothing else asked of the engine: the measurement used the books that scan handed over
    assert.deepEqual([scans, quotes], [1, 0]);
    const line = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0]) as ShadowOpenRecord;
    const sale = line.counterfactuals?.sale;
    assert.ok(sale, "the open line carries the measurement");
    assert.deepEqual([sale.holderVenue, sale.holderAskCents], ["kalshi", 63]);
    assert.equal(sale.soldMilli, centsUpOf(line.floorCents + 100 - line.capCents, 150) * 10);
    assert.ok(sale.ownSale.ok && sale.betterBid.ok);
    assert.deepEqual([sale.betterBid.book, sale.betterBid.venuesPriced, sale.books.map((b) => b.book)], ["long_short_v1", 2, ["polymarket", "long_short_v1"]]);
    // the ledger keeps the book's key for the operator; the old fields of the line are where they were
    assert.ok(line.counterfactuals?.routes?.kalshi_self.ok && line.routing?.holderVenue === "kalshi");

    // the public JSON says the comparison exists and keeps the books with the operator, as before
    const api = (await (await fetch(`${base}/api/shadow`)).json()) as { summary: { counterfactuals: Record<string, unknown> }; open: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(api.summary.counterfactuals).sort(), ["positionsWithCounterfactuals", "recordedSince"]);
    assert.ok(!JSON.stringify(api).includes("long_short_v1") && !("counterfactuals" in api.open[0]));
    // the operator's report carries the whole summary, books named
    const report = (await (await fetch(`${base}/api/shadow/report?token=op-secret`)).json()) as { counterfactuals: { sale: { lines: number; betterBid: { existed: number; byBook: Record<string, { best: number }> } } } };
    assert.deepEqual([report.counterfactuals.sale.lines, report.counterfactuals.sale.betterBid.existed, report.counterfactuals.sale.betterBid.byBook.long_short_v1.best], [1, 1, 1]);
  } finally {
    await new Promise<void>((r) => worker.server.close(() => r()));
  }
});
