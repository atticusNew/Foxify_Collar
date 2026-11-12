/**
 * The sell rail: an early close sells the hedge back through the same executor that bought it.
 * The intent carries action "sell"; on Kalshi V2 that is a `bid` for Yes at 1 - the walked worst
 * No bid (immediate or cancel) and the fill is read as net proceeds with every rounding against
 * the writer the other way round from a buy; the aggregator pod sends a BID; the RFQ executor
 * skips the quote round; the live executor's receipt says sold and keeps the cents versus the
 * walk with the sign flipped. Driven by fakes; nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { AggregatorOrderClient, fillOfAggregatorOrder, fillOfSubmit } from "../src/eventCollar/crossVenue/aggregatorOrders";
import { quoteEarlyClose } from "../src/eventCollar/crossVenue/earlyClose";
import { BookHedgeExecutor, RfqHedgeExecutor, actionOf, bookWalkPenaltyCents, intentFromHedge, sellIntentForKalshi, type ExecutorClock } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { kalshiTakerFeeCents } from "../src/eventCollar/crossVenue/kalshiLadder";
import { KalshiOrderClient, fillOfOrder, fillOfV2Order, fillOfV2Sell } from "../src/eventCollar/crossVenue/kalshiOrders";
import { LiveHedgeExecutor, describeOrder, type LiveHedgeRails, type LiveOrderHook } from "../src/eventCollar/crossVenue/liveHedge";
import type { KalshiSelfHedgeLeg } from "../src/eventCollar/crossVenue/types";

const TICKER = "KXNBAGAME-26OCT14LALBOS-BOS";

/** The hedge as bought: 20 No at 41c average, 42c walked. */
const BOUGHT: KalshiSelfHedgeLeg = { action: "buy", venue: "kalshi", outcome: "No", ticker: TICKER, contractsMilli: 20_000, avgPriceCents: 41, worstPriceCents: 42, costCents: 826 };
/** The same 20 No sold back into bids of 38c (12) and 37c (8): 12 x 38 + 8 x 37 = 752c gross. */
const SALE = sellIntentForKalshi({ ticker: TICKER, unitsMilli: 20_000, bestPriceCents: 38, avgPriceCents: 38, worstPriceCents: 37, grossCents: 752 });

const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [TICKER], maxUnitsPerOrderMilli: 25_000, maxUnitsPerDayMilli: 100_000 };

function fakeClock(startMs = Date.parse("2026-10-14T12:00:00.000Z")): ExecutorClock {
  const c = { ms: startMs, now: () => new Date(c.ms), sleep: async (ms: number) => void (c.ms += ms) };
  return c;
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
function fixtureFetch(script: Array<(c: Call) => { status: number; body?: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(c);
    const step = script.shift();
    if (!step) throw new Error(`unexpected call ${c.method} ${c.url}`);
    const r = step(c);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const testCreds = () => ({ apiKeyId: "key-1", privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string });

test("sell intent: the walk read the other way; a buy intent stays a buy without saying so", () => {
  assert.equal(actionOf(SALE), "sell");
  assert.equal(actionOf(intentFromHedge(BOUGHT, 400)), "buy", "every intent before the sell rail is a buy");
  assert.deepEqual(SALE.book, { bestPriceMilli: 380, avgPriceMilli: 380, worstPriceMilli: 370, costCents: 752 });
  assert.equal(SALE.maxCostCents, 752);
  // the walk gave up 8 x 1c against a one-price sale at the top bid
  assert.equal(bookWalkPenaltyCents(SALE), 20 * 38 - 752);
  assert.equal(bookWalkPenaltyCents({ ...SALE, book: { ...SALE.book, costCents: 760 } }), 0, "the whole size at the best bid gives up nothing");
  assert.equal(describeOrder(SALE), "kalshi sell 20 No on KXNBAGAME-26OCT14LALBOS-BOS at or over 37c, immediate or cancel");
  assert.equal(describeOrder(intentFromHedge(BOUGHT, 400)), "kalshi buy 20 No on KXNBAGAME-26OCT14LALBOS-BOS at or under 42c, immediate or cancel");
});

test("early close quote: the Kalshi route hands the order its sale (top bid, average, worst level, gross); the Polymarket route has none", () => {
  const terms = { contracts: 20, floorCents: 40, capCents: 70, creditCents: 0, takeCents: 0, hedgeUnitsMilli: 14_000, route: "kalshi_self" as const };
  const books = { kalshi: { yesBids: [{ priceCents: 62, qtyMilli: 1_000_000 }], noBids: [{ priceCents: 38, qtyMilli: 10_000 }, { priceCents: 37, qtyMilli: 1_000_000 }] } };
  const q = quoteEarlyClose(terms, books);
  assert.ok(q.ok, JSON.stringify(q));
  assert.ok(q.hedgeSale);
  assert.equal(q.hedgeSale.venue, "kalshi");
  assert.equal(q.hedgeSale.bestPriceCents, 38);
  assert.equal(q.hedgeSale.worstPriceCents, 37, "14 No: 10 at 38c, 4 at 37c");
  assert.equal(q.hedgeSale.grossCents, 10 * 38 + 4 * 37);
  assert.equal(q.hedgeSale.grossCents, q.hedgeProceedsCents + q.hedgeFeesCents, "the quote's proceeds are net of the venue's fee; the order is told the gross");
  const intent = sellIntentForKalshi({ ticker: TICKER, unitsMilli: 14_000, ...q.hedgeSale });
  assert.equal(KalshiOrderClient.orderBody(intent, "x").price, "0.6300", "sold at the walked worst bid or better: a Yes bid at 1 - 37c");
  const pm = quoteEarlyClose({ ...terms, route: "polymarket" }, { ...books, pmNoBook: { bids: [{ priceMilli: 380, qtyMilli: 1_000_000 }], asks: [] } as never });
  assert.ok(pm.ok, JSON.stringify(pm));
  assert.equal(pm.hedgeSale, undefined, "no sell rail to Polymarket: recorded, not sent");
});

test("kalshi V2 sale: the body is a bid for Yes at 1 - the walked worst No bid; the fill is net proceeds, rounded against the writer", () => {
  assert.deepEqual(KalshiOrderClient.orderBody(SALE, "atticus-s1"), {
    ticker: TICKER,
    client_order_id: "atticus-s1",
    side: "bid",
    count: "20.00",
    price: "0.6300",
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  });
  assert.equal(KalshiOrderClient.capCents(SALE), 37);
  // 20 sold at a Yes average of 0.62 (our No at 38c): 760c gross; fee 0.0035 x 20 = 7c; 753c net
  assert.deepEqual(fillOfV2Sell({ order_id: "o", fill_count: "20.00", remaining_count: "0.00", average_fill_price: "0.620000", average_fee_paid: "0.003500" }, 37), { unitsMilli: 20_000, costCents: 753, feesCents: 7 });
  // the buy of the same numbers reads the Yes average the other way: a No cost of 38c, 767c all in
  assert.deepEqual(fillOfV2Order({ order_id: "o", fill_count: "20.00", remaining_count: "0.00", average_fill_price: "0.620000", average_fee_paid: "0.003500" }, 42), { unitsMilli: 20_000, costCents: 767, feesCents: 7 });
  // a seventh decimal on the Yes average rounds it up, so the No proceeds round down; the fee rounds up
  const seven = fillOfV2Sell({ order_id: "o", fill_count: "1.00", remaining_count: "0.00", average_fill_price: "0.6200001", average_fee_paid: "0.0100001" }, 37);
  assert.deepEqual(seven, { unitsMilli: 1_000, costCents: 37 - 2, feesCents: 2 });
  // no fee on the answer: the taker formula at the No price
  const noFee = fillOfV2Sell({ order_id: "o", fill_count: "20.00", remaining_count: "0.00", average_fill_price: "0.62" }, 37);
  assert.equal(noFee.feesCents, kalshiTakerFeeCents(20_000, 38));
  assert.equal(noFee.costCents, 760 - noFee.feesCents);
  // no average: read at the floor, the lowest bid we accepted, never over
  const noAvg = fillOfV2Sell({ order_id: "o", fill_count: "20.00", remaining_count: "0.00" }, 37);
  assert.equal(noAvg.costCents, 740 - noAvg.feesCents);
  assert.deepEqual(fillOfV2Sell({ order_id: "o", fill_count: "0.00", remaining_count: "0.00" }, 37), { unitsMilli: 0, costCents: 0, feesCents: 0 });
  // the legacy read after a cancel: the cost fields are the Yes we paid for; proceeds are the dollar less that, less fees
  assert.deepEqual(fillOfOrder({ order_id: "o", taker_fill_count: 12, taker_fill_cost: 744, taker_fees: 4 }, 37, true), { unitsMilli: 12_000, costCents: 1200 - 744 - 4, feesCents: 4 });
  // no cost on the read: the Yes at 1 - the floor, so the proceeds sit at the floor
  const noCost = fillOfOrder({ order_id: "o", taker_fill_count: 12 }, 37, true);
  assert.equal(noCost.costCents, 12 * 37 - noCost.feesCents);
});

test("kalshi orders client: a sale goes out as a bid and comes back as proceeds; a rested remainder is cancelled and read back as a sale; nothing sold throws in the sale's words", async () => {
  const creds = testCreds();
  const now = Date.parse("2026-10-14T12:00:00Z");
  const quick = fixtureFetch([
    (c) => {
      assert.equal(c.method, "POST");
      assert.equal(c.url, "https://api.test/trade-api/v2/portfolio/events/orders");
      assert.equal(c.body?.side, "bid");
      assert.equal(c.body?.price, "0.6300");
      assert.equal(c.body?.count, "20.00");
      return { status: 201, body: { order_id: "ord-s1", fill_count: "20.00", remaining_count: "0.00", average_fill_price: "0.620000", average_fee_paid: "0.003500", ts_ms: now } };
    },
  ]);
  const client = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: quick.fetchImpl, now: () => now });
  const r = await client.place(SALE, "atticus-s1");
  // 753c net on 20: 37.65c a contract, down to 376 milli (never over-counted on a sale)
  assert.deepEqual(r, { orderId: "ord-s1", unitsMilli: 20_000, avgPriceMilli: 376, costCents: 753, feesCents: 7, status: "executed" });
  assert.equal(quick.calls.length, 1);

  const rested = fixtureFetch([
    () => ({ status: 201, body: { order_id: "ord-s2", fill_count: "12.00", remaining_count: "8.00", average_fill_price: "0.620000", average_fee_paid: "0.003500", ts_ms: now } }),
    (c) => {
      assert.equal(c.method, "DELETE");
      return { status: 200, body: { order: { order_id: "ord-s2", status: "canceled" }, reduced_by: 8 } };
    },
    (c) => {
      assert.equal(c.method, "GET");
      return { status: 200, body: { order: { order_id: "ord-s2", status: "canceled", taker_fill_count: 12, taker_fill_cost: 744, taker_fees: 4, remaining_count: 0 } } };
    },
  ]);
  const c2 = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: rested.fetchImpl, now: () => now });
  const partial = await c2.place(SALE, "atticus-s2");
  assert.deepEqual(partial, { orderId: "ord-s2", unitsMilli: 12_000, avgPriceMilli: 376, costCents: 452, feesCents: 4, status: "canceled" });
  assert.equal(rested.calls.length, 3);

  const none = fixtureFetch([() => ({ status: 201, body: { order_id: "ord-s0", fill_count: "0.00", remaining_count: "0.00", ts_ms: now } })]);
  const c3 = new KalshiOrderClient(creds, { base: "https://api.test/trade-api/v2", fetchImpl: none.fetchImpl, now: () => now });
  await assert.rejects(c3.place(SALE, "x"), /order ord-s0 canceled with nothing sold at or over 37c/);
});

test("aggregator pod sale: a BID on the YES book at 1 - the walked worst bid; the fill's roundings flip, no average reads at the floor", async () => {
  const body = AggregatorOrderClient.orderBody(SALE, "atticus-s1");
  assert.equal(body.side, "BID");
  assert.equal(body.price, "0.6300");
  assert.equal(body.count, "20.00");
  assert.deepEqual(body.timeInForce, { type: "IOC" });
  // the partner's No average is our proceeds a contract: 0.3849 x 20 = 769.8 -> 769c (down), fee 0.0701 -> 8c (up): 761c net
  assert.deepEqual(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.6151", averageNoPrice: "0.3849", feesCents: 7, feesUsd: "0.0701" }, 37, true), { unitsMilli: 20_000, costCents: 761, feesCents: 8 });
  // the same read as a buy rounds the other way: 770c + 8c
  assert.deepEqual(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.6151", averageNoPrice: "0.3849", feesCents: 7, feesUsd: "0.0701" }, 42), { unitsMilli: 20_000, costCents: 778, feesCents: 8 });
  // only the Yes average, with a seventh decimal: it rounds up on a sale, so the No rounds down
  const fromYes = fillOfSubmit({ orderId: "o", status: "FILLED", filledCount: "20.00", remainingCount: "0.00", averagePrice: "0.6200001" }, 37, true);
  assert.equal(fromYes.costCents, Math.floor((20_000 * 379_999) / 10_000_000) - fromYes.feesCents);
  // no average at all: the floor
  assert.equal(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null }, 37, true).costCents, 740 - kalshiTakerFeeCents(20_000, 37));
});

test("executors on a sale: the book executor keeps the sign of cents versus the walk; the RFQ executor sells into the book without a quote round; the live executor's receipt says sold", async () => {
  const clock = fakeClock();
  const seenRfq: string[] = [];
  const rfq = new RfqHedgeExecutor(
    {
      kalshi: {
        venue: "kalshi",
        canExecute: () => true,
        request: async () => {
          seenRfq.push("asked");
          throw new Error("must not be asked");
        },
        bestQuote: async () => null,
        accept: async () => ({}),
        cancel: async () => {},
      },
    },
    null,
    undefined,
    clock,
  );
  const r = await rfq.execute(SALE, "ref");
  assert.equal(seenRfq.length, 0, "a sale is not put out for quotes");
  assert.equal(r.outcome, "filled_book");
  assert.equal(r.fallbackReason, "a close is not put out for quotes; it goes into the book");
  assert.equal(r.fill?.simulated, true);
  assert.equal(r.fill?.costCents, 752, "simulated at the walk's gross");

  // live: the hook sells 20 for 753c net; the receipt reads sold, and 1c kept against the 752c walk
  const seen: Array<[string, string]> = [];
  const hook: LiveOrderHook = async (intent, id) => {
    seen.push([actionOf(intent), id]);
    return { orderId: "ord-s1", unitsMilli: intent.unitsMilli, avgPriceMilli: 376, costCents: 753, feesCents: 7, status: "executed" };
  };
  const live = new LiveHedgeExecutor({ kalshi: hook }, RAILS, () => 0, clock);
  const sold = await live.execute(SALE, "ref");
  assert.deepEqual(seen, [["sell", `atticus-${sold.id}`]]);
  assert.equal(sold.outcome, "filled_live");
  assert.equal(sold.fill?.simulated, false);
  assert.equal(sold.fill?.costCents, 753);
  assert.equal(sold.fill?.vsBookCents, 1, "753 received against 752 walked");
  assert.match(sold.attempts.find((a) => a.step === "order")?.detail ?? "", /20 of 20 sold at 376 milli, 753c net proceeds$/);
  // a partial sale: 12 of 20 for 452c against 451c of the walk pro rata
  const partialHook: LiveOrderHook = async () => ({ orderId: "ord-s2", unitsMilli: 12_000, avgPriceMilli: 376, costCents: 452, feesCents: 4, status: "canceled" });
  const part = await new LiveHedgeExecutor({ kalshi: partialHook }, RAILS, () => 0, clock).execute(SALE, "ref");
  assert.equal(part.fill?.unitsMilli, 12_000);
  assert.equal(part.fill?.vsBookCents, 452 - Math.round((752 * 12_000) / 20_000));
  assert.match(part.attempts.find((a) => a.step === "order")?.detail ?? "", /\(partial\)$/);
  // dry run describes the sale and sends nothing
  const dry = await new LiveHedgeExecutor({ kalshi: hook }, { ...RAILS, dryRun: true }, () => 0, clock).execute(SALE, "ref");
  assert.equal(dry.fallbackReason, "dry run");
  assert.match(dry.attempts.find((a) => a.step === "dry_run")?.detail ?? "", /kalshi sell 20 No on .* at or over 37c, immediate or cancel; not sent/);
  // a direct book executor with a venue client selling for more than the walk keeps the gain
  const book = new BookHedgeExecutor(async () => ({ orderId: "b1", avgPriceMilli: 380, costCents: 760 }), clock);
  const direct = await book.execute(SALE, "ref");
  assert.equal(direct.fill?.simulated, false);
  assert.equal(direct.fill?.vsBookCents, 8);
});
