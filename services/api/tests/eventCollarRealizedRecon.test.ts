/**
 * The daily check, pure: our ledger's real fills for a UTC day against the venue's own fills.
 * Our side is the realized book over receipts the real executors wrote. The venue's side is each
 * venue's own response shape (Kalshi's fills list, the aggregator's order read, ProphetX fills,
 * Novig's fills list) added up per order by the functions the readers use. Every outcome is here:
 * agrees, differs in each way, could not be checked for each reason. Nothing touches a venue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AggregatorKalshiOrder } from "../src/eventCollar/crossVenue/aggregatorOrders";
import { fillOfAggregatorOrder } from "../src/eventCollar/crossVenue/aggregatorOrders";
import {
  RfqHedgeExecutor,
  intentFromHedge,
  sellIntentForKalshi,
  sellIntentForNovig,
  type ExecutorClock,
  type HedgeIntent,
  type HedgeReceipt,
  type RfqClient,
} from "../src/eventCollar/crossVenue/hedgeExecutor";
import { fillOfV2Order, fillOfV2Sell, type KalshiFill } from "../src/eventCollar/crossVenue/kalshiOrders";
import { LiveHedgeExecutor, type LiveHedgeRails, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { novigClientId, novigFillMoney, sumNovigFills, type NovigFill } from "../src/eventCollar/crossVenue/novigOrders";
import { prophetxFillMoney, sumProphetXFills, type ProphetXFill } from "../src/eventCollar/crossVenue/prophetxOrders";
import { buildRealizedBook, type RealizedBook } from "../src/eventCollar/crossVenue/realizedBook";
import {
  KALSHI_LIST_ROUNDING_CENTS,
  aggregatorKalshiOrderFill,
  isUtcDay,
  kalshiOrdersFromFills,
  novigOrdersFromFills,
  previousUtcDay,
  prophetxOrderFill,
  reconcileDay,
  type DayRecon,
  type VenueDayRead,
  type VenueOrderFill,
} from "../src/eventCollar/crossVenue/realizedRecon";

const T = "KXNBAGAME-26NOV03BOSLAL-BOS";
const DAY = "2026-11-03";
const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 500_000, maxUnitsPerDayMilli: 5_000_000 };

const clockAt = (iso: string): ExecutorClock => {
  let ms = Date.parse(iso);
  return { now: () => new Date(ms), sleep: async (d) => void (ms += d) };
};

const kalshiBuy = (ticker = T, unitsMilli = 12_000): HedgeIntent =>
  intentFromHedge({ action: "buy", venue: "kalshi", outcome: "No", ticker, contractsMilli: unitsMilli, avgPriceCents: 25, worstPriceCents: 26, costCents: 306 }, 250);
const kalshiSell = (): HedgeIntent => sellIntentForKalshi({ ticker: T, unitsMilli: 12_000, bestPriceCents: 45, avgPriceCents: 44, worstPriceCents: 43, grossCents: 528 });

/** The venue's answer to one order, as its client hands it to the executor. */
const answer = (r: Partial<LiveOrderResult> & Pick<LiveOrderResult, "orderId" | "costCents" | "feesCents">): LiveOrderHook => async (intent) => {
  const unitsMilli = r.unitsMilli ?? intent.unitsMilli;
  return { unitsMilli, avgPriceMilli: intent.action === "sell" ? Math.floor((r.costCents * 10_000) / unitsMilli) : Math.ceil((r.costCents * 10_000) / unitsMilli), status: "executed", ...r };
};

/** One receipt through the real live executor. */
async function live(intent: HedgeIntent, at: string, hook: LiveOrderHook, ref = T): Promise<HedgeReceipt> {
  return new LiveHedgeExecutor({ kalshi: hook, prophetx: hook, novig: hook }, RAILS, () => 0, clockAt(at)).execute(intent, ref);
}
const bookOf = (receipts: HedgeReceipt[]): RealizedBook => buildRealizedBook({ receipts, pending: [], locks: [] });

const read = (venue: VenueDayRead["venue"], orders: VenueOrderFill[], over: Partial<VenueDayRead> = {}): VenueDayRead => ({
  venue,
  status: "read",
  reason: null,
  scope: "whole_day",
  how: "fixture",
  orders,
  unread: [],
  ...over,
});
const check = (book: RealizedBook, reads: VenueDayRead[], day = DAY): DayRecon => reconcileDay({ day, fills: book.fills, notCounted: book.notCounted, reads });

/** One fill as Kalshi's GET /portfolio/fills lists it. */
const kFill = (over: Partial<KalshiFill> & Pick<KalshiFill, "fill_id" | "order_id">): KalshiFill => ({
  ticker: T,
  market_ticker: T,
  outcome_side: "no",
  book_side: "ask",
  count_fp: "12.00",
  yes_price_dollars: "0.7500",
  no_price_dollars: "0.2500",
  is_taker: true,
  fee_cost: "0.0500",
  created_time: "2026-11-03T18:00:01.412Z",
  ts: Math.floor(Date.parse("2026-11-03T18:00:01.412Z") / 1000),
  subaccount_number: 0,
  exchange_index: 3,
  ...over,
});

/** The aggregator's read of one Kalshi order (GET /v1/kalshi/orders/{id}). */
const podOrder = (over: Partial<AggregatorKalshiOrder> = {}): AggregatorKalshiOrder => ({
  orderId: "pod-1",
  ticker: T,
  side: "ASK",
  count: "12.00",
  status: "FILLED",
  venueOrderId: "k-9",
  filledCount: "12.00",
  averageYesPrice: "0.75",
  averageNoPrice: "0.25",
  feesCents: 5,
  feesUsd: "0.05",
  clientOrderId: null,
  createdAt: "2026-11-03T18:00:01.000Z",
  closedAt: "2026-11-03T18:00:01.300Z",
  ...over,
});
/** Our line for that order, costed by the function the pod's client uses. */
const podLine = (o: AggregatorKalshiOrder, at = "2026-11-03T18:00:01.000Z"): Promise<HedgeReceipt> => {
  const f = fillOfAggregatorOrder(o, 26);
  return live(kalshiBuy(), at, answer({ orderId: o.orderId, venueOrderId: o.venueOrderId ?? undefined, via: "aggregator", unitsMilli: f.unitsMilli, costCents: f.costCents, feesCents: f.feesCents }));
};

function assertWholeMoney(v: unknown, path = "recon"): void {
  if (Array.isArray(v)) return v.forEach((x, i) => assertWholeMoney(x, `${path}[${i}]`));
  if (!v || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "number") assert.ok(Number.isInteger(x), `${path}.${k} = ${x} is not a whole number`);
    else assertWholeMoney(x, `${path}.${k}`);
  }
}

test("Kalshi's own list: a buy filled in two pieces and its sale agree; a cent of rounding between the order's average and the fills is shown, not flagged", async () => {
  // our lines, costed from the order's own answer: the average of 7 at 0.75 and 5 at 0.74 Yes, truncated by the venue to six places
  const bought = fillOfV2Order({ order_id: "k-1", fill_count: "12.00", remaining_count: "0.00", average_fill_price: "0.745833", average_fee_paid: "0.004167" }, 26);
  assert.deepEqual(bought, { unitsMilli: 12_000, costCents: 312, feesCents: 6 });
  const sold = fillOfV2Sell({ order_id: "k-2", fill_count: "12.00", remaining_count: "0.00", average_fill_price: "0.560000", average_fee_paid: "0.005000" }, 43);
  assert.deepEqual(sold, { unitsMilli: 12_000, costCents: 522, feesCents: 6 });
  const book = bookOf([
    await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", ...bought })),
    await live(kalshiSell(), "2026-11-03T20:00:01.000Z", answer({ orderId: "k-2", ...sold })),
  ]);

  // the venue's list: each fill priced on its own, the fee per fill, the sale read from the Yes side
  const venue = kalshiOrdersFromFills([
    kFill({ fill_id: "f1", order_id: "k-1", count_fp: "7.00", yes_price_dollars: "0.7500", no_price_dollars: "0.2500", fee_cost: "0.0300" }),
    kFill({ fill_id: "f2", order_id: "k-1", count_fp: "5.00", yes_price_dollars: "0.7400", no_price_dollars: "0.2600", fee_cost: "0.0200", created_time: "2026-11-03T18:00:01.480Z" }),
    kFill({ fill_id: "f3", order_id: "k-2", outcome_side: "yes", book_side: "bid", yes_price_dollars: "0.5600", no_price_dollars: "0.4400", fee_cost: "0.0600", created_time: "2026-11-03T20:00:01.300Z" }),
  ]);
  assert.deepEqual(
    venue.map((o) => [o.ids, o.action, o.unitsMilli, o.costCents, o.feesCents, o.avgPriceMilli, o.fillCount, o.at, o.roundingCents]),
    [
      // 7 x 25c + 5 x 26c = 305c and 5c of fees; 12 x 44c = 528c less 6c
      [["k-1"], "buy", 12_000, 310, 5, 259, 2, "2026-11-03T18:00:01.412Z", KALSHI_LIST_ROUNDING_CENTS],
      [["k-2"], "sell", 12_000, 522, 6, 435, 1, "2026-11-03T20:00:01.300Z", KALSHI_LIST_ROUNDING_CENTS],
    ],
  );

  const r = check(book, [read("kalshi", venue)]);
  assert.equal(r.verdict, "agrees");
  const k = r.venues[0];
  assert.deepEqual([k.venue, k.verdict, k.scope, k.matched.length, k.differing.length, k.inLedgerNotAtVenue.length, k.atVenueNotInLedger.length], ["kalshi", "agrees", "whole_day", 2, 0, 0, 0]);
  assert.deepEqual(k.matched.map((m) => [m.matchedBy, m.action, m.ledger.costCents, m.venue.costCents, m.withinRoundingCents, m.roundingAllowedCents]), [
    ["order_id", "buy", 312, 310, -2, 2],
    ["order_id", "sell", 522, 522, 0, 2],
  ]);
  assert.equal(k.reason, "2 fills on our ledger, each at the venue with the same quantity, cost and fee, and the venue shows no other fill that day; 1 cost sits within 2 cents of the venue's by rounding");
  assert.deepEqual(k.ledgerTotals, { orders: 2, boughtUnitsMilli: 12_000, paidCents: 312, soldUnitsMilli: 12_000, proceedsCents: 522 });
  assert.deepEqual(k.venueTotals, { orders: 2, boughtUnitsMilli: 12_000, paidCents: 310, soldUnitsMilli: 12_000, proceedsCents: 522 });
  assert.equal(r.summary, `kalshi agrees: ${k.reason}`);
  assertWholeMoney(r);

  // three cents is past rounding: the same list with one fill a cent a contract dearer
  const dearer = kalshiOrdersFromFills([
    kFill({ fill_id: "f1", order_id: "k-1", count_fp: "7.00", yes_price_dollars: "0.7400", no_price_dollars: "0.2600", fee_cost: "0.0300" }),
    kFill({ fill_id: "f2", order_id: "k-1", count_fp: "5.00", yes_price_dollars: "0.7400", no_price_dollars: "0.2600", fee_cost: "0.0200" }),
    kFill({ fill_id: "f3", order_id: "k-2", outcome_side: "yes", book_side: "bid", yes_price_dollars: "0.5600", no_price_dollars: "0.4400", fee_cost: "0.0600", created_time: "2026-11-03T20:00:01.300Z" }),
  ]);
  const d = check(book, [read("kalshi", dearer)]).venues[0];
  assert.equal(d.verdict, "differs");
  assert.deepEqual(d.differing[0].differences, [
    { field: "cost", ledger: 312, venue: 317, delta: 5 },
    { field: "price", ledger: 260, venue: 265, delta: 5 },
  ]);
  assert.equal(d.reason, "1 order differs (cost, price)");
});

test("each way a matched order can differ: quantity, cost, price, fee, direction; whole numbers, venue less ledger", async () => {
  const base = podOrder();
  const book = bookOf([await podLine(base)]);
  assert.deepEqual([book.fills[0].orderId, book.fills[0].venueOrderId, book.fills[0].via, book.fills[0].costCents, book.fills[0].feesCents], ["pod-1", "k-9", "aggregator", 305, 5]);
  const against = (o: AggregatorKalshiOrder) => check(book, [read("kalshi", [aggregatorKalshiOrderFill(o, 26)], { scope: "ledger_orders_only" })]).venues[0];

  // the same read our line was costed from: nothing differs, and no rounding is allowed
  const same = against(base);
  assert.deepEqual([same.verdict, same.matched[0].roundingAllowedCents, same.matched[0].withinRoundingCents], ["agrees", 0, 0]);
  assert.equal(same.reason, "1 order on our ledger, each read back from the venue with the same quantity, cost and fee; only the orders our ledger names were read, so a fill we never recorded would not show");

  // the venue filled 10 of the 12 our line says
  const qty = against(podOrder({ filledCount: "10.00" }));
  assert.equal(qty.verdict, "differs");
  assert.deepEqual(qty.differing[0].differences, [
    { field: "quantity", ledger: 12_000, venue: 10_000, delta: -2_000 },
    { field: "cost", ledger: 305, venue: 255, delta: -50 },
  ]);
  assert.equal(qty.reason, "1 order differs (quantity, cost)");

  // the venue charged 7c where our line says 5c: one cent is a difference when the read is the same one
  const fee = against(podOrder({ feesUsd: "0.07", feesCents: 7 }));
  assert.deepEqual(fee.differing[0].differences, [
    { field: "cost", ledger: 305, venue: 307, delta: 2 },
    { field: "price", ledger: 255, venue: 256, delta: 1 },
    { field: "fee", ledger: 5, venue: 7, delta: 2 },
  ]);
  const cent = against(podOrder({ feesUsd: "0.06", feesCents: 6 }));
  assert.deepEqual(cent.differing[0].differences.map((x) => [x.field, x.delta]), [["cost", 1], ["fee", 1]]);

  // the venue filled at a No average of 0.26
  const price = against(podOrder({ averageYesPrice: "0.74", averageNoPrice: "0.26" }));
  assert.deepEqual(price.differing[0].differences, [
    { field: "cost", ledger: 305, venue: 317, delta: 12 },
    { field: "price", ledger: 255, venue: 265, delta: 10 },
  ]);

  // the venue says the order sold where our line bought
  const way = against(podOrder({ side: "BID" }));
  assert.deepEqual(way.differing[0].differences, [
    { field: "direction", ledger: "buy", venue: "sell", delta: null },
    { field: "cost", ledger: 305, venue: 295, delta: -10 },
    { field: "price", ledger: 255, venue: 245, delta: -10 },
  ]);
  for (const v of [qty, fee, price, way]) assertWholeMoney(v);

  // the venue knows the order and shows nothing filled on it
  const empty = against(podOrder({ filledCount: "0.00", status: "CANCELLED" }));
  assert.deepEqual([empty.verdict, empty.inLedgerNotAtVenue.map((x) => [x.receiptId, x.why])], ["differs", [[book.fills[0].receiptId, "the venue shows this order with nothing filled"]]]);
});

test("on our ledger and not at the venue; at the venue and not on our ledger, with the line that may explain it", async () => {
  const ours = await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", costCents: 305, feesCents: 5 }));
  // an order sent and answered with an error: not counted on our side, and the venue filled it
  const lost = await live(kalshiBuy(T, 8_000), "2026-11-03T19:00:00.000Z", async () => {
    throw new Error("kalshi orders: HTTP 504 POST /portfolio/events/orders");
  });
  const book = bookOf([ours, lost]);
  assert.deepEqual([book.fills.length, book.notCounted.map((n) => n.code)], [1, ["order_unconfirmed"]]);

  // the venue's list: no k-1 at all; the lost order (its client order id read back) and a stranger nobody sent from here
  const venue = kalshiOrdersFromFills([
    kFill({ fill_id: "f8", order_id: "k-lost", count_fp: "8.00", fee_cost: "0.0400", created_time: "2026-11-03T19:00:00.350Z" }),
    kFill({ fill_id: "f9", order_id: "k-hand", ticker: "KXNBAGAME-26NOV03NYKMIA-NYK", count_fp: "3.00", outcome_side: "yes", book_side: "bid", fee_cost: "0.0100", created_time: "2026-11-03T21:00:00.000Z", subaccount_number: 2 }),
  ]);
  venue[0].clientOrderId = `atticus-${lost.id}`;
  const r = check(book, [read("kalshi", venue)]);
  const k = r.venues[0];
  assert.equal(r.verdict, "differs");
  assert.equal(k.reason, "1 fill is on our ledger and not at the venue; 2 orders are at the venue and not on our ledger");
  assert.deepEqual(k.inLedgerNotAtVenue, [
    {
      receiptId: ours.id,
      at: "2026-11-03T18:00:01.000Z",
      orderId: "k-1",
      venueOrderId: null,
      clientOrderId: `atticus-${ours.id}`,
      instrument: T,
      action: "buy",
      unitsMilli: 12_000,
      costCents: 305,
      why: "the venue's list for the day has no fill for this order",
    },
  ]);
  assert.deepEqual(
    k.atVenueNotInLedger.map((x) => [x.venueIds, x.action, x.unitsMilli, x.costCents, x.feesCents, x.subaccount, x.hint]),
    [
      [["k-lost"], "buy", 8_000, 204, 4, 0, `our line ${lost.id} sent this order and did not count it (order_unconfirmed)`],
      [["k-hand"], "sell", 3_000, 74, 1, 2, null],
    ],
  );
  assert.deepEqual(k.openQuestions.map((q) => [q.id, q.code, q.answer]), [[lost.id, "order_unconfirmed", "the venue shows a fill that may be this one; it is listed as at the venue and not on our ledger"]]);
  assertWholeMoney(r);

  // the same unconfirmed order on a day the venue's list shows nothing for it: answered, and the day agrees
  const quiet = check(bookOf([lost]), [read("kalshi", [])]).venues[0];
  assert.deepEqual([quiet.verdict, quiet.openQuestions[0].answer], ["agrees", "the venue's list for the day shows no fill that points at it"]);
});

test("could not be checked, for each reason; a failed read is never agrees", async () => {
  const kLine = await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", costCents: 305, feesCents: 5 }));
  const pxIntent: HedgeIntent = { venue: "prophetx", instrument: "strike-no", offsetInstrument: "strike-yes", armKey: T, outcome: "Los Angeles Lakers", unitsMilli: 12_000, book: { bestPriceMilli: 265, avgPriceMilli: 266, worstPriceMilli: 270, costCents: 320 }, maxCostCents: 320 };
  const pxFills: ProphetXFill[] = [{ fillId: "f1", orderId: "px-1", venueFillId: "v1", shares: "12.000000", price: "0.250000", stakeUsd: "3.00", feeUsd: "0", occurredAt: "2026-11-03T18:10:01.000Z" }];
  const pxMoney = prophetxFillMoney(sumProphetXFills(pxFills), 12_000, false, 200);
  const pxLine = await live(pxIntent, "2026-11-03T18:10:00.000Z", answer({ orderId: "px-1", venueOrderId: "v-1", via: "aggregator", ...pxMoney }));
  const pxLost = await live({ ...pxIntent, unitsMilli: 5_000 }, "2026-11-03T18:20:00.000Z", async () => {
    throw new Error("aggregator 502 on POST /v1/prophetx/orders");
  });
  // a real fill on Polymarket can only be an accepted quote; there is no reader for it
  const pmClient: RfqClient = {
    venue: "polymarket",
    canExecute: () => true,
    request: async () => ({ rfqId: "rfq-1" }),
    bestQuote: async () => ({ quoteId: "q-1", priceMilli: 240, unitsMilli: 12_000 }),
    accept: async () => ({ orderId: "pm-1" }),
    cancel: async () => undefined,
  };
  const pmLine = await new RfqHedgeExecutor({ polymarket: pmClient }, null, { waitMs: 1_000, pollMs: 500 }, clockAt("2026-11-03T18:30:00.000Z")).execute(
    { venue: "polymarket", instrument: "token-1", armKey: T, outcome: "Lakers", unitsMilli: 12_000, book: { bestPriceMilli: 250, avgPriceMilli: 255, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 },
    T,
  );
  const book = bookOf([kLine, pxLine, pxLost, pmLine]);
  const pxRow = prophetxOrderFill("px-1", pxFills, { sell: false, wantedUnitsMilli: 12_000, feeBps: 200, venueOrderId: "v-1", instrument: "strike-no" });

  const r = check(book, [
    read("kalshi", [], { status: "no_key", reason: "no key for kalshi", scope: "ledger_orders_only" }),
    // ProphetX is read order by order: the order that was read agrees, the one our ledger could not confirm cannot be looked up
    read("prophetx", [pxRow], { scope: "ledger_orders_only" }),
    read("polymarket", [], { status: "no_reader", reason: "no reader for polymarket", scope: "ledger_orders_only" }),
  ]);
  assert.equal(r.verdict, "could_not_be_checked");
  assert.deepEqual(
    r.venues.map((v) => [v.venue, v.verdict, v.reason]),
    [
      ["kalshi", "could_not_be_checked", "no key for kalshi"],
      ["prophetx", "could_not_be_checked", "1 line our ledger could not count cannot be looked up at this venue, which is read order by order here"],
      ["polymarket", "could_not_be_checked", "no reader for polymarket"],
    ],
  );
  assert.match(r.summary, /^kalshi could not be checked: no key for kalshi \| prophetx could not be checked: /);
  assert.deepEqual([r.venues[1].matched.length, r.venues[1].openQuestions[0].answer], [1, "cannot be looked up: this venue is read order by order here, and this line names none"]);

  // the read itself failed
  const failed = check(book, [read("kalshi", [], { status: "failed", reason: "the read failed: kalshi orders: HTTP 503 GET /portfolio/fills" })]).venues[0];
  assert.deepEqual([failed.verdict, failed.reason, failed.matched.length], ["could_not_be_checked", "the read failed: kalshi orders: HTTP 503 GET /portfolio/fills", 0]);

  // one order could not be read: nothing else differs, and the day is still not "agrees"
  const partial = check(bookOf([kLine]), [read("kalshi", [], { scope: "ledger_orders_only", unread: [{ receiptId: kLine.id, reason: "aggregator 500 on GET /v1/kalshi/orders/k-1" }] })]).venues[0];
  assert.deepEqual([partial.verdict, partial.reason, partial.inLedgerNotAtVenue.length], ["could_not_be_checked", "1 of 1 order could not be read at the venue: aggregator 500 on GET /v1/kalshi/orders/k-1", 0]);

  // a venue with a real fill and no read handed in at all
  const none = check(bookOf([kLine]), []).venues[0];
  assert.deepEqual([none.verdict, none.reason], ["could_not_be_checked", "no read of the venue was made"]);

  // a difference outranks everything: one venue differs, the day differs
  const mixed = check(book, [read("kalshi", []), read("prophetx", [pxRow], { scope: "ledger_orders_only" })]);
  assert.deepEqual([mixed.verdict, mixed.venues.map((v) => v.verdict)], ["differs", ["differs", "could_not_be_checked", "could_not_be_checked"]]);
});

test("how a line finds its order: the order id, then the client order id, then (only with no order id) the instrument and size", async () => {
  // an accepted quote whose answer named no order
  const client: RfqClient = {
    venue: "kalshi",
    canExecute: () => true,
    request: async () => ({ rfqId: "rfq-1" }),
    bestQuote: async () => ({ quoteId: "q-1", priceMilli: 240, unitsMilli: 12_000 }),
    accept: async () => ({}),
    cancel: async () => undefined,
  };
  const quoted = await new RfqHedgeExecutor({ kalshi: client }, null, { waitMs: 1_000, pollMs: 500 }, clockAt("2026-11-03T18:00:01.000Z")).execute(kalshiBuy(), T);
  const book = bookOf([quoted]);
  assert.deepEqual([book.fills[0].orderId, book.fills[0].basis, book.fills[0].costCents, book.fills[0].feesCents], [null, "accepted_quote", 288, null]);

  // two orders of that size on that instrument that day: the nearer in time is taken, and the pairing is flagged
  const venue = kalshiOrdersFromFills([
    kFill({ fill_id: "f1", order_id: "k-far", yes_price_dollars: "0.7600", no_price_dollars: "0.2400", fee_cost: "0.0000", created_time: "2026-11-03T09:00:00.000Z" }),
    kFill({ fill_id: "f2", order_id: "k-near", yes_price_dollars: "0.7600", no_price_dollars: "0.2400", fee_cost: "0.0000", created_time: "2026-11-03T18:00:02.000Z" }),
  ]);
  const bySize = check(book, [read("kalshi", venue)]).venues[0];
  assert.deepEqual(bySize.matched.map((m) => [m.matchedBy, m.venueIds, m.ledger.feesCents, m.venue.feesCents]), [["instrument_and_size", ["k-near"], null, 0]]);
  assert.deepEqual(bySize.atVenueNotInLedger.map((x) => x.venueIds), [["k-far"]], "the other one is nobody's on our ledger");

  // the venue kept our client order id: that wins over size
  venue[0].clientOrderId = `atticus-${quoted.id}`;
  assert.deepEqual(check(book, [read("kalshi", venue)]).venues[0].matched.map((m) => [m.matchedBy, m.venueIds]), [["client_order_id", ["k-far"]]]);

  // an accepted quote's line has no fee in it: the venue's fee shows as a cost difference, the fee itself is not compared
  const withFee = kalshiOrdersFromFills([kFill({ fill_id: "f3", order_id: "k-near", yes_price_dollars: "0.7600", no_price_dollars: "0.2400", fee_cost: "0.0400", created_time: "2026-11-03T18:00:02.000Z" })]);
  assert.deepEqual(check(book, [read("kalshi", withFee)]).venues[0].differing[0].differences, [
    { field: "cost", ledger: 288, venue: 292, delta: 4 },
    { field: "price", ledger: 240, venue: 244, delta: 4 },
  ]);

  // a line WITH an order id the venue does not show is never paired by size: both sides are reported
  const named = bookOf([await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", costCents: 288, feesCents: 0 }))]);
  const v = check(named, [read("kalshi", kalshiOrdersFromFills([kFill({ fill_id: "f2", order_id: "k-near", yes_price_dollars: "0.7600", no_price_dollars: "0.2400", fee_cost: "0.0000" })]))]).venues[0];
  assert.deepEqual([v.verdict, v.matched.length, v.inLedgerNotAtVenue.length, v.atVenueNotInLedger.length], ["differs", 0, 1, 1]);

  // the aggregator's pod sent the order into our own Kalshi account: our line keeps the venue's order id and the list matches on it
  const pod = podOrder();
  const podBook = bookOf([await podLine(pod)]);
  const listed = kalshiOrdersFromFills([kFill({ fill_id: "f5", order_id: "k-9", subaccount_number: 1 })]);
  const viaPod = check(podBook, [read("kalshi", listed)]).venues[0];
  assert.deepEqual([viaPod.verdict, viaPod.matched[0].matchedBy, viaPod.matched[0].venueIds, viaPod.matched[0].ledger.costCents, viaPod.matched[0].venue.costCents], ["agrees", "order_id", ["k-9"], 305, 305]);
});

test("the day's edges: an order sent in the last second is found past midnight, and is not a stranger the next day", async () => {
  const late = await live(kalshiBuy(), "2026-11-02T23:59:59.900Z", answer({ orderId: "k-late", costCents: 305, feesCents: 5 }));
  const book = bookOf([late]);
  assert.equal(book.fills[0].day, "2026-11-02", "the line's day is when our executor sent it");
  const lateFill = kFill({ fill_id: "f1", order_id: "k-late", created_time: "2026-11-03T00:00:00.100Z" });
  const nextDay = kFill({ fill_id: "f2", order_id: "k-next", created_time: "2026-11-03T00:04:00.000Z" });

  // the 2nd: the list reads a little past midnight, finds the late fill, and leaves the next day's order to the next day's check
  const second = check(book, [read("kalshi", kalshiOrdersFromFills([lateFill, nextDay]))], "2026-11-02").venues[0];
  assert.deepEqual([second.verdict, second.matched.length, second.outsideDay, second.atVenueNotInLedger.length], ["agrees", 1, 1, 0]);

  // the 3rd: the late fill is on the venue's day and on our ledger under the 2nd; the other is a stranger
  const third = check(book, [read("kalshi", kalshiOrdersFromFills([lateFill, nextDay]))], "2026-11-03").venues[0];
  assert.deepEqual([third.verdict, third.onLedgerOtherDay, third.atVenueNotInLedger.map((x) => x.venueIds)], ["differs", 1, [["k-next"]]]);
  const clean = check(book, [read("kalshi", kalshiOrdersFromFills([lateFill]))], "2026-11-03").venues[0];
  assert.deepEqual([clean.verdict, clean.reason, clean.onLedgerOtherDay], ["agrees", "nothing on our ledger and nothing at the venue that day", 1]);
});

test("ProphetX and Novig: the venue's fills cost to the same cents by the same function, the offset included", async () => {
  // ProphetX: only the orders our ledger names can be read
  const pxFills: ProphetXFill[] = [{ fillId: "f1", orderId: "px-1", venueFillId: "v1", shares: "12.000000", price: "0.250000", stakeUsd: "3.00", feeUsd: "0", occurredAt: "2026-11-03T18:10:01.000Z" }];
  const pxIntent: HedgeIntent = { venue: "prophetx", instrument: "strike-no", offsetInstrument: "strike-yes", armKey: T, outcome: "Los Angeles Lakers", unitsMilli: 12_000, book: { bestPriceMilli: 265, avgPriceMilli: 266, worstPriceMilli: 270, costCents: 320 }, maxCostCents: 320 };
  const pxBook = bookOf([await live(pxIntent, "2026-11-03T18:10:00.000Z", answer({ orderId: "px-1", venueOrderId: "v-1", via: "aggregator", ...prophetxFillMoney(sumProphetXFills(pxFills), 12_000, false, 200) }))]);
  const ctx = { sell: false, wantedUnitsMilli: 12_000, feeBps: 200, venueOrderId: "v-1", instrument: "strike-no" };
  const px = check(pxBook, [read("prophetx", [prophetxOrderFill("px-1", pxFills, ctx)], { scope: "ledger_orders_only" })]).venues[0];
  assert.deepEqual([px.verdict, px.scope, px.matched[0].ledger.costCents, px.matched[0].venue.costCents, px.matched[0].roundingAllowedCents], ["agrees", "ledger_orders_only", 318, 318, 0]);
  // the settlement fee is provided for at the rate in the service env: a changed rate shows as a cost difference, to the cent
  const rate = check(pxBook, [read("prophetx", [prophetxOrderFill("px-1", pxFills, { ...ctx, feeBps: 300 })], { scope: "ledger_orders_only" })]).venues[0];
  assert.deepEqual(rate.differing[0].differences.map((d) => [d.field, d.delta]), [["cost", 9], ["price", 8]]);

  // Novig: the venue's own list of the day. A hedge bought, then offset; the venue's fills say "buy" both times
  const M = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const OPP = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const OURS = "0b3f5f20-9c1b-4d6e-8f3a-5c2d1e7b4a90";
  const nvBuyIntent: HedgeIntent = { venue: "novig", instrument: OPP, offsetInstrument: OURS, marketId: M, armKey: T, outcome: "BOS", unitsMilli: 12_000, book: { bestPriceMilli: 255, avgPriceMilli: 255, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 };
  const nvSellIntent = sellIntentForNovig({ marketId: M, outcomeId: OPP, offsetOutcomeId: OURS, armKey: T, unitsMilli: 12_000, bestPriceMilli: 440, avgPriceMilli: 436, worstPriceMilli: 430, grossCents: 523 });
  const at = (iso: string): number => Date.parse(iso);
  const hedgeFills: NovigFill[] = [
    { fillId: "f1", orderId: "nv-1", marketId: M, outcomeId: OPP, qty: 700, cost: "1.75000", fee: "0.02100", taker: true, ts: at("2026-11-03T18:00:01.200Z") },
    { fillId: "f2", orderId: "nv-1", marketId: M, outcomeId: OPP, qty: 500, cost: "1.27500", taker: true, ts: at("2026-11-03T18:00:01.300Z") },
  ];
  const offsetFills: NovigFill[] = [{ fillId: "f3", orderId: "nv-2", marketId: M, outcomeId: OURS, qty: 1_200, cost: "6.72000", taker: true, ts: at("2026-11-03T20:00:01.200Z") }];
  const strangerFills: NovigFill[] = [{ fillId: "f4", orderId: "nv-3", marketId: M, outcomeId: OURS, qty: 300, cost: "1.50000", taker: true, ts: at("2026-11-03T21:00:00.000Z") }];
  const buyLine = await live(nvBuyIntent, "2026-11-03T18:00:01.000Z", answer({ orderId: "nv-1", ...novigFillMoney(sumNovigFills(hedgeFills), 12_000, false) }));
  const sellLine = await live(nvSellIntent, "2026-11-03T20:00:01.000Z", answer({ orderId: "nv-2", ...novigFillMoney(sumNovigFills(offsetFills), 12_000, true) }));
  const nvBook = bookOf([buyLine, sellLine]);
  assert.deepEqual(nvBook.fills.map((f) => [f.action, f.instrument, f.orderInstrument, f.costCents]), [
    ["buy", OPP, OPP, 305],
    // the offset is an order on the holder's own outcome; 1200 one-cent contracts pay $12 at the game, less the $6.72 paid
    ["sell", OPP, OURS, 528],
  ]);
  const ctxOf = (orderId: string): { sell: boolean; wantedUnitsMilli: number } | null => {
    const f = nvBook.fills.find((x) => x.orderId === orderId);
    return f ? { sell: f.action === "sell", wantedUnitsMilli: f.wantedUnitsMilli } : null;
  };
  const rows = novigOrdersFromFills([...hedgeFills, ...offsetFills], ctxOf);
  assert.deepEqual(rows.map((o) => [o.ids, o.action, o.instrument, o.unitsMilli, o.costCents, o.feesCents, o.fillCount]), [
    [["nv-1"], "buy", OPP, 12_000, 305, 3, 2],
    [["nv-2"], "sell", OURS, 12_000, 528, 0, 1],
  ]);
  const nv = check(nvBook, [read("novig", rows)]).venues[0];
  assert.deepEqual([nv.verdict, nv.scope, nv.matched.length], ["agrees", "whole_day", 2]);

  // an order the venue shows and our ledger does not is costed as the buy the venue says it is
  const extra = check(nvBook, [read("novig", novigOrdersFromFills([...hedgeFills, ...offsetFills, ...strangerFills], ctxOf))]).venues[0];
  assert.deepEqual([extra.verdict, extra.atVenueNotInLedger.map((x) => [x.venueIds, x.action, x.unitsMilli, x.costCents])], ["differs", [[["nv-3"], "buy", 3_000, 150]]]);

  // the venue's list carries the client id our order went under (a UUID made from the receipt id): a second way to the same line
  const renamed = novigOrdersFromFills(
    hedgeFills.map((f) => ({ ...f, orderId: "nv-renumbered", clientId: novigClientId(`atticus-${buyLine.id}`) })),
    () => ({ sell: false, wantedUnitsMilli: 12_000 }),
  );
  const byClient = check(bookOf([buyLine]), [read("novig", renamed)]).venues[0];
  assert.deepEqual([byClient.verdict, byClient.matched[0].matchedBy], ["agrees", "client_order_id"]);
});

test("a day with nothing real and nothing read has nothing to check; the day helpers are UTC", () => {
  const empty = reconcileDay({ day: DAY, fills: [], notCounted: [], reads: [] });
  assert.deepEqual([empty.verdict, empty.venues.length, empty.summary], ["nothing_to_check", 0, "no real fill on our ledger that day and no venue read"]);
  // a venue that lists its own day is checked even when our ledger is empty: that is how a fill we never recorded is found
  const listed = reconcileDay({ day: DAY, fills: [], notCounted: [], reads: [read("kalshi", [])] });
  assert.deepEqual([listed.verdict, listed.venues[0].reason], ["agrees", "nothing on our ledger and nothing at the venue that day"]);

  assert.deepEqual([isUtcDay("2026-11-03"), isUtcDay("2026-02-30"), isUtcDay("2026-11-3"), isUtcDay("yesterday"), isUtcDay("")], [true, false, false, false, false]);
  assert.equal(previousUtcDay(new Date("2026-11-04T00:30:00.000Z")), "2026-11-03");
  assert.equal(previousUtcDay(new Date("2026-03-01T12:00:00.000Z")), "2026-02-28");
  assert.equal(previousUtcDay(new Date("2027-01-01T00:00:00.000Z")), "2026-12-31");
});
