/**
 * The reads behind the daily check, driven by fake venues: the real clients, signed requests,
 * fixture answers in each venue's own shape. Kalshi's list of the day (pages, subaccounts, the
 * client order id of an order we do not know), the aggregator's read of each order when there is
 * no Kalshi key, ProphetX fills order by order, Novig's list of the day. Every request is a GET.
 * A venue with no key, a venue that fails and a venue that never answers are each reported and
 * not tried again. Nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { constants, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { AggregatorOrderClient, AggregatorPodRest, fillOfAggregatorOrder, type AggregatorKalshiOrder } from "../src/eventCollar/crossVenue/aggregatorOrders";
import { intentFromHedge, sellIntentForNovig, type HedgeIntent, type HedgeReceipt } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { KalshiOrderClient, type KalshiFill } from "../src/eventCollar/crossVenue/kalshiOrders";
import { LiveHedgeExecutor, type LiveHedgeRails, type LiveOrderHook, type LiveOrderResult } from "../src/eventCollar/crossVenue/liveHedge";
import { NovigOrderClient, novigClientId, novigFillMoney, sumNovigFills, type NovigFill } from "../src/eventCollar/crossVenue/novigOrders";
import { ProphetXOrderClient, prophetxFillMoney, sumProphetXFills, type ProphetXFill } from "../src/eventCollar/crossVenue/prophetxOrders";
import { buildRealizedBook, type RealizedBook } from "../src/eventCollar/crossVenue/realizedBook";
import { reconcileDay } from "../src/eventCollar/crossVenue/realizedRecon";
import { readVenueFills, venueFillReadersFromEnv, type VenueFillReaders } from "../src/eventCollar/crossVenue/venueFillReaders";
import { canonicalString, signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";

const T = "KXNBAGAME-26NOV03BOSLAL-BOS";
const DAY = "2026-11-03";
const DAY_START_S = Date.parse("2026-11-03T00:00:00.000Z") / 1000;
const RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [], anyTicker: true, maxUnitsPerOrderMilli: 500_000, maxUnitsPerDayMilli: 5_000_000 };

interface Seen {
  method: string;
  host: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}
type Answer = { status: number; body?: unknown } | Promise<never>;

/** A fake venue: answers by "METHOD /path"; records every request. */
function fakeVenue(routes: Record<string, (s: Seen, nth: number) => Answer>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), host: u.host, path: u.pathname, query: u.search.slice(1), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: typeof init?.body === "string" ? init.body : "" };
    seen.push(s);
    const key = `${s.method} ${s.path}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: "NOT_FOUND", message: `no route ${key}`, error: { code: "NOT_FOUND", message: `no route ${key}` } }), { status: 404 });
    const r = await route(s, nth);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const kalshiKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { creds: { apiKeyId: "key-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string }, publicKey };
})();
const podKey = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { host: "https://pod.example.test", keyId: "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d", secret: der.subarray(der.length - 32).toString("hex") };
})();
const novigKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { keyId: "5d1f8a2c-7b3e-4c9a-9e2d-1a4b6c8d0e2f", pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKey };
})();
const KALSHI_BASE = "https://kalshi.example.test/trade-api/v2";
const NOVIG_HOST = "https://novig.example.test";

const kalshiClient = (v: { fetchImpl: typeof fetch }) => new KalshiOrderClient(kalshiKey.creds, { base: KALSHI_BASE, fetchImpl: v.fetchImpl, now: () => 1_793_800_000_000 });
const podClients = (v: { fetchImpl: typeof fetch }) => {
  const rest = new AggregatorPodRest(podKey, { fetchImpl: v.fetchImpl, nowSec: () => 1_793_800_000 });
  return { aggregator: new AggregatorOrderClient(podKey, { rest }), prophetx: new ProphetXOrderClient(podKey, { rest, feeBps: 200 }) };
};
const novigClient = (v: { fetchImpl: typeof fetch }) => new NovigOrderClient({ host: NOVIG_HOST, signer: signerFromPem(novigKey.keyId, novigKey.pem), fetchImpl: v.fetchImpl });
const POD_TIME = { "GET /v1/time": () => ({ status: 200, body: { time: 1_793_800_000 } }) };

const kalshiBuy = (unitsMilli = 12_000): HedgeIntent =>
  intentFromHedge({ action: "buy", venue: "kalshi", outcome: "No", ticker: T, contractsMilli: unitsMilli, avgPriceCents: 25, worstPriceCents: 26, costCents: 306 }, 250);
const answer = (r: Partial<LiveOrderResult> & Pick<LiveOrderResult, "orderId" | "costCents" | "feesCents">): LiveOrderHook => async (intent) => {
  const unitsMilli = r.unitsMilli ?? intent.unitsMilli;
  return { unitsMilli, avgPriceMilli: intent.action === "sell" ? Math.floor((r.costCents * 10_000) / unitsMilli) : Math.ceil((r.costCents * 10_000) / unitsMilli), status: "executed", ...r };
};
async function live(intent: HedgeIntent, at: string, hook: LiveOrderHook): Promise<HedgeReceipt> {
  const ms = Date.parse(at);
  return new LiveHedgeExecutor({ kalshi: hook, prophetx: hook, novig: hook }, RAILS, () => 0, { now: () => new Date(ms), sleep: async () => undefined }).execute(intent, T);
}
const bookOf = (receipts: HedgeReceipt[]): RealizedBook => buildRealizedBook({ receipts, pending: [], locks: [] });
const check = async (book: RealizedBook, readers: VenueFillReaders, opts = {}) => {
  const reads = await readVenueFills(DAY, book.fills, book.notCounted, readers, opts);
  return { reads, recon: reconcileDay({ day: DAY, fills: book.fills, notCounted: book.notCounted, reads }) };
};

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
  subaccount_number: 0,
  exchange_index: 3,
  ...over,
});

test("Kalshi: the day's list is read to its last page with one signed GET a page; an order we do not know is read back for its client order id", async () => {
  const ours = await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", costCents: 305, feesCents: 5 }));
  const lost = await live(kalshiBuy(8_000), "2026-11-03T19:00:00.000Z", async () => {
    throw new Error("kalshi orders: HTTP 504 POST /portfolio/events/orders");
  });
  const book = bookOf([ours, lost]);
  const venue = fakeVenue({
    "GET /trade-api/v2/portfolio/fills": (s, nth) =>
      nth === 0
        ? { status: 200, body: { fills: [kFill({ fill_id: "f1", order_id: "k-1", count_fp: "7.00", fee_cost: "0.0300" })], cursor: "c1" } }
        : {
            status: 200,
            body: {
              // the list moved under the cursor: f1 comes back, and is counted once
              fills: [
                kFill({ fill_id: "f1", order_id: "k-1", count_fp: "7.00", fee_cost: "0.0300" }),
                kFill({ fill_id: "f2", order_id: "k-1", count_fp: "5.00", fee_cost: "0.0200" }),
                kFill({ fill_id: "f3", order_id: "k-lost", count_fp: "8.00", fee_cost: "0.0400", created_time: "2026-11-03T19:00:00.350Z" }),
                { fill_id: "bad", count_fp: "1.00" },
              ],
              cursor: "",
            },
          },
    "GET /trade-api/v2/portfolio/orders/k-lost": () => ({ status: 200, body: { order: { order_id: "k-lost", client_order_id: `atticus-${lost.id}`, ticker: T, status: "executed" } } }),
  });
  const { reads, recon } = await check(book, { kalshi: kalshiClient(venue) });

  assert.deepEqual(venue.seen.map((s) => `${s.method} ${s.path}`), ["GET /trade-api/v2/portfolio/fills", "GET /trade-api/v2/portfolio/fills", "GET /trade-api/v2/portfolio/orders/k-lost"]);
  const q0 = new URLSearchParams(venue.seen[0].query);
  // the UTC day in unix seconds, a second before its start to ten minutes past its end; no subaccount named means every one the key sees
  assert.deepEqual(Object.fromEntries(q0), { min_ts: String(DAY_START_S - 1), max_ts: String(DAY_START_S + 86_400 + 600), limit: "1000" });
  assert.equal(new URLSearchParams(venue.seen[1].query).get("cursor"), "c1");
  for (const s of venue.seen) {
    assert.equal(s.headers["KALSHI-ACCESS-KEY"], "key-1");
    // the signature covers the path alone, never the query
    const signed = `${s.headers["KALSHI-ACCESS-TIMESTAMP"]}GET${s.path}`;
    assert.ok(cryptoVerify("sha256", Buffer.from(signed), { key: kalshiKey.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(s.headers["KALSHI-ACCESS-SIGNATURE"], "base64")));
    assert.equal(s.body, "");
  }
  assert.deepEqual([reads[0].venue, reads[0].status, reads[0].scope, reads[0].how], ["kalshi", "read", "whole_day", "the venue's own list of fills for the day, every subaccount the key can see: 3 fills in 2 orders"]);

  const k = recon.venues[0];
  assert.equal(k.verdict, "differs");
  assert.deepEqual(k.matched.map((m) => [m.receiptId, m.venue.unitsMilli, m.venue.costCents, m.venue.feesCents]), [[ours.id, 12_000, 305, 5]]);
  assert.deepEqual(k.atVenueNotInLedger.map((x) => [x.venueIds, x.clientOrderId, x.unitsMilli, x.hint]), [[["k-lost"], `atticus-${lost.id}`, 8_000, `our line ${lost.id} sent this order and did not count it (order_unconfirmed)`]]);
});

test("Kalshi: named subaccounts are listed one by one; an order the pod sent is found under the venue's id, learned from the pod when our line did not keep it", async () => {
  const pod: AggregatorKalshiOrder = { orderId: "pod-1", ticker: T, side: "ASK", count: "12.00", status: "FILLED", venueOrderId: "k-9", filledCount: "12.00", averageYesPrice: "0.75", averageNoPrice: "0.25", feesCents: 5, feesUsd: "0.05", clientOrderId: "atticus-x", createdAt: "2026-11-03T18:00:01.000Z", closedAt: "2026-11-03T18:00:01.300Z" };
  const f = fillOfAggregatorOrder(pod, 26);
  // our line kept the pod's order id and not the venue's (the pod had not relayed it when the order was read)
  const line = await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "pod-1", via: "aggregator", unitsMilli: f.unitsMilli, costCents: f.costCents, feesCents: f.feesCents }));
  const book = bookOf([line]);
  assert.deepEqual([book.fills[0].orderId, book.fills[0].venueOrderId], ["pod-1", null]);

  const kalshi = fakeVenue({
    "GET /trade-api/v2/portfolio/fills": (s) => ({ status: 200, body: { fills: new URLSearchParams(s.query).get("subaccount") === "1" ? [kFill({ fill_id: "f1", order_id: "k-9", subaccount_number: 1 })] : [], cursor: "" } }),
  });
  const partner = fakeVenue({ ...POD_TIME, "GET /v1/kalshi/orders/pod-1": () => ({ status: 200, body: pod }) });
  const { reads, recon } = await check(book, { kalshi: kalshiClient(kalshi), kalshiSubaccounts: [0, 1], aggregator: podClients(partner).aggregator });
  assert.deepEqual(kalshi.seen.map((s) => new URLSearchParams(s.query).get("subaccount")), ["0", "1"]);
  assert.deepEqual(partner.seen.map((s) => `${s.method} ${s.path}`), ["GET /v1/time", "GET /v1/kalshi/orders/pod-1"]);
  assert.equal(kalshi.seen.length, 2, "an order our ledger names is not read back a second time");
  assert.match(reads[0].how, /subaccount 0, 1: 1 fills in 1 orders$/);
  const k = recon.venues[0];
  assert.deepEqual([k.verdict, k.scope, k.matched[0].matchedBy, k.matched[0].venueIds, k.matched[0].venue.costCents], ["agrees", "whole_day", "order_id", ["k-9", "pod-1"], 305]);
});

test("Kalshi with only the aggregator's key: each order our ledger names is read back; a 404 is not at the venue, an error is could not be read, our own key's orders cannot be read", async () => {
  const pod = (id: string, over: Partial<AggregatorKalshiOrder> = {}): AggregatorKalshiOrder => ({ orderId: id, ticker: T, side: "ASK", count: "12.00", status: "FILLED", venueOrderId: `k-${id}`, filledCount: "12.00", averageYesPrice: "0.75", averageNoPrice: "0.25", feesCents: 5, feesUsd: "0.05", clientOrderId: null, ...over });
  const lineFor = (id: string, at: string) => live(kalshiBuy(), at, answer({ orderId: id, venueOrderId: `k-${id}`, via: "aggregator", costCents: 305, feesCents: 5 }));
  const good = await lineFor("pod-1", "2026-11-03T18:00:01.000Z");
  const gone = await lineFor("pod-2", "2026-11-03T18:10:01.000Z");
  const down = await lineFor("pod-3", "2026-11-03T18:20:01.000Z");
  const direct = await live(kalshiBuy(), "2026-11-03T18:30:01.000Z", answer({ orderId: "k-7", costCents: 305, feesCents: 5 }));
  const partner = fakeVenue({
    ...POD_TIME,
    "GET /v1/kalshi/orders/pod-1": () => ({ status: 200, body: pod("pod-1") }),
    "GET /v1/kalshi/orders/pod-3": () => ({ status: 500, body: { error: { code: "INTERNAL", message: "upstream timeout" } } }),
  });
  const readers = { aggregator: podClients(partner).aggregator };

  const all = await check(bookOf([good, gone, down, direct]), readers);
  assert.deepEqual(all.reads[0].unread, [
    { receiptId: down.id, reason: "upstream timeout" },
    { receiptId: direct.id, reason: "no key for kalshi: the order was sent with our own key and only the aggregator's key is set" },
  ]);
  assert.deepEqual([all.reads[0].scope, all.reads[0].how], ["ledger_orders_only", "the aggregator's read of each order our ledger names: 1 of 4 read"]);
  const k = all.recon.venues[0];
  // the order the pod does not know is a difference; that outranks the two that could not be read
  assert.deepEqual([k.verdict, k.matched.map((m) => m.receiptId), k.inLedgerNotAtVenue.map((x) => [x.receiptId, x.why]), k.unread.length], ["differs", [good.id], [[gone.id, "the venue has no fill for this order"]], 2]);
  assert.equal(partner.seen.filter((s) => s.path === "/v1/kalshi/orders/pod-3").length, 1, "a failed read is not tried again");

  // without the missing order: nothing differs, and the day is still not agrees
  const partial = (await check(bookOf([good, down]), readers)).recon.venues[0];
  assert.deepEqual([partial.verdict, partial.reason], ["could_not_be_checked", "1 of 2 orders could not be read at the venue: upstream timeout"]);
  const clean = (await check(bookOf([good]), readers)).recon.venues[0];
  assert.deepEqual([clean.verdict, clean.scope], ["agrees", "ledger_orders_only"]);
  assert.ok(partner.seen.every((s) => s.method === "GET"));
});

test("ProphetX: the fills of each order our ledger names, costed with the fee rate in the service env; no list of the day", async () => {
  const fills: ProphetXFill[] = [{ fillId: "f1", orderId: "px-1", venueFillId: "v1", shares: "12.000000", price: "0.250000", stakeUsd: "3.00", feeUsd: "0", occurredAt: "2026-11-03T18:10:01.000Z" }];
  const intent: HedgeIntent = { venue: "prophetx", instrument: "strike-no", offsetInstrument: "strike-yes", armKey: T, outcome: "Los Angeles Lakers", unitsMilli: 12_000, book: { bestPriceMilli: 265, avgPriceMilli: 266, worstPriceMilli: 270, costCents: 320 }, maxCostCents: 320 };
  const line = await live(intent, "2026-11-03T18:10:00.000Z", answer({ orderId: "px-1", venueOrderId: "v-1", via: "aggregator", ...prophetxFillMoney(sumProphetXFills(fills), 12_000, false, 200) }));
  const partner = fakeVenue({ ...POD_TIME, "GET /v1/prophetx/orders/px-1/fills": () => ({ status: 200, body: { fills } }) });
  const { reads, recon } = await check(bookOf([line]), { prophetx: podClients(partner).prophetx });
  assert.deepEqual(partner.seen.map((s) => `${s.method} ${s.path}`), ["GET /v1/time", "GET /v1/prophetx/orders/px-1/fills"]);
  assert.deepEqual([reads[0].venue, reads[0].scope, reads[0].how], ["prophetx", "ledger_orders_only", "the aggregator's fills of each order our ledger names: 1 of 1 read, each costed at its game's fee (2% of net gains at settlement; on a maker/taker league the fee at the trade)"]);
  const p = recon.venues[0];
  assert.deepEqual([p.verdict, p.matched[0].ledger.costCents, p.matched[0].venue.costCents, p.matched[0].venueIds], ["agrees", 318, 318, ["px-1", "v-1"]]);
  assert.match(p.reason, /only the orders our ledger names were read, so a fill we never recorded would not show$/);

  // an NHL game: the lock costed the fill at the fee at the trade ($3.00 x 3.5% x 0.75 = 7.9c -> 8c), and the read back costs it the same way from the line's ticker
  const NHL_T = "KXNHLGAME-26NOV03TBBUF-TB";
  const nhlHook = answer({ orderId: "px-1", venueOrderId: "v-1", via: "aggregator", ...prophetxFillMoney(sumProphetXFills(fills), 12_000, false, { gainBps: 0, tradeBps: 350 }) });
  const nhlLine = await new LiveHedgeExecutor({ prophetx: nhlHook }, RAILS, () => 0, { now: () => new Date("2026-11-03T18:10:00.000Z"), sleep: async () => undefined }).execute({ ...intent, armKey: NHL_T }, NHL_T);
  const n = (await check(bookOf([nhlLine]), { prophetx: podClients(fakeVenue({ ...POD_TIME, "GET /v1/prophetx/orders/px-1/fills": () => ({ status: 200, body: { fills } }) })).prophetx })).recon.venues[0];
  assert.deepEqual([n.verdict, n.matched[0].ledger.costCents, n.matched[0].venue.costCents], ["agrees", 308, 308]);

  // the order is known and its fills are empty: on our ledger and not at the venue
  const empty = fakeVenue({ ...POD_TIME, "GET /v1/prophetx/orders/px-1/fills": () => ({ status: 200, body: { fills: [] } }) });
  const e = (await check(bookOf([line]), { prophetx: podClients(empty).prophetx })).recon.venues[0];
  assert.deepEqual([e.verdict, e.inLedgerNotAtVenue[0].why], ["differs", "the venue shows this order with nothing filled"]);
});

test("Novig: the trading key's own list of the day, every page, signed over the query; the offset is told from a hedge by our own line", async () => {
  const M = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const OPP = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const OURS = "0b3f5f20-9c1b-4d6e-8f3a-5c2d1e7b4a90";
  const ts = (iso: string): number => Date.parse(iso);
  const hedge: NovigFill[] = [
    { fillId: "f1", orderId: "nv-1", marketId: M, outcomeId: OPP, qty: 700, cost: "1.75000", fee: "0.02100", taker: true, ts: ts("2026-11-03T18:00:01.200Z") },
    { fillId: "f2", orderId: "nv-1", marketId: M, outcomeId: OPP, qty: 500, cost: "1.27500", taker: true, ts: ts("2026-11-03T18:00:01.300Z") },
  ];
  const offset: NovigFill[] = [{ fillId: "f3", orderId: "nv-2", marketId: M, outcomeId: OURS, qty: 1_200, cost: "6.72000", taker: true, ts: ts("2026-11-03T20:00:01.200Z") }];
  const buy: HedgeIntent = { venue: "novig", instrument: OPP, offsetInstrument: OURS, marketId: M, armKey: T, outcome: "BOS", unitsMilli: 12_000, book: { bestPriceMilli: 255, avgPriceMilli: 255, worstPriceMilli: 260, costCents: 306 }, maxCostCents: 306 };
  const sell = sellIntentForNovig({ marketId: M, outcomeId: OPP, offsetOutcomeId: OURS, armKey: T, unitsMilli: 12_000, bestPriceMilli: 440, avgPriceMilli: 436, worstPriceMilli: 430, grossCents: 523 });
  const buyLine = await live(buy, "2026-11-03T18:00:01.000Z", answer({ orderId: "nv-1", ...novigFillMoney(sumNovigFills(hedge), 12_000, false) }));
  const sellLine = await live(sell, "2026-11-03T20:00:01.000Z", answer({ orderId: "nv-2", ...novigFillMoney(sumNovigFills(offset), 12_000, true) }));
  const venue = fakeVenue({
    // newest first, as the venue lists; the client id rides on each fill
    "GET /v3/portfolio/fills": (_s, nth) =>
      nth === 0 ? { status: 200, body: { items: offset.map((f) => ({ ...f, clientId: novigClientId(`atticus-${sellLine.id}`) })), next: "p2" } } : { status: 200, body: { items: [...hedge].reverse() } },
  });
  const { reads, recon } = await check(bookOf([buyLine, sellLine]), { novig: novigClient(venue) });

  assert.deepEqual(venue.seen.map((s) => `${s.method} ${s.path}`), ["GET /v3/portfolio/fills", "GET /v3/portfolio/fills"]);
  const start = Date.parse("2026-11-03T00:00:00.000Z");
  // both bounds are excluded by the venue: a millisecond before the day to ten minutes past it
  assert.deepEqual(Object.fromEntries(new URLSearchParams(venue.seen[0].query)), { startsAfter: String(start - 1), startsBefore: String(start + 86_400_000 + 600_000), limit: "5000" });
  assert.equal(new URLSearchParams(venue.seen[1].query).get("after"), "p2");
  for (const s of venue.seen) {
    assert.equal(s.headers["Novig-Key-Id"], novigKey.keyId);
    const canon = canonicalString({ timestampMs: s.headers["Novig-Timestamp"], method: "GET", path: s.path, query: s.query, body: "" });
    assert.ok(cryptoVerify(null, Buffer.from(canon, "utf8"), novigKey.publicKey, Buffer.from(s.headers["Novig-Signature"], "base64")), "signed over the path and the query");
  }
  assert.deepEqual([reads[0].venue, reads[0].scope, reads[0].how], ["novig", "whole_day", "the venue's own list of fills for the day in the trading key's subaccount: 3 fills in 2 orders"]);
  const n = recon.venues[0];
  assert.deepEqual([n.verdict, n.matched.map((m) => [m.action, m.ledger.costCents, m.venue.costCents])], ["agrees", [["buy", 305, 305], ["sell", 528, 528]]]);

  // a list that never ends is a failed read, not a short list taken as whole
  const endless = fakeVenue({ "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [], next: "again" } }) });
  const failed = await check(bookOf([buyLine]), { novig: novigClient(endless) });
  assert.deepEqual([failed.reads[0].status, failed.reads[0].reason, failed.recon.venues[0].verdict], ["failed", "the read failed: novig orders: the fills list did not end within 20 pages", "could_not_be_checked"]);
});

test("no key, a venue that fails, a venue that never answers: each is could not be checked with its reason, asked once", async () => {
  const kLine = await live(kalshiBuy(), "2026-11-03T18:00:01.000Z", answer({ orderId: "k-1", costCents: 305, feesCents: 5 }));
  const book = bookOf([kLine]);

  // no key at all: nothing is called
  const none = await check(book, {});
  assert.deepEqual(none.reads, [{ venue: "kalshi", status: "no_key", reason: "no key for kalshi", scope: "ledger_orders_only", how: "not read", orders: [], unread: [] }]);
  assert.deepEqual([none.recon.verdict, none.recon.summary], ["could_not_be_checked", "kalshi could not be checked: no key for kalshi"]);
  // and a day with no real fill and no key asks nothing and says so
  assert.deepEqual((await check(bookOf([]), {})).recon.verdict, "nothing_to_check");

  // the venue answers 503: one call, no retry, and the venue's body is not carried past its first line
  const down = fakeVenue({ "GET /trade-api/v2/portfolio/fills": () => ({ status: 503, body: { error: "maintenance\nstack trace here" } }) });
  const failed = await check(book, { kalshi: kalshiClient(down) });
  assert.equal(down.seen.length, 1);
  assert.equal(failed.reads[0].status, "failed");
  assert.match(failed.reads[0].reason ?? "", /^the read failed: kalshi orders: HTTP 503 GET \/portfolio\/fills/);
  assert.deepEqual([failed.recon.venues[0].verdict, failed.recon.venues[0].matched.length], ["could_not_be_checked", 0]);

  // the venue never answers: the read gives up at its deadline
  const hung = fakeVenue({ "GET /trade-api/v2/portfolio/fills": () => new Promise<never>(() => undefined) });
  const late = await check(book, { kalshi: kalshiClient(hung) }, { timeoutMs: 1_000 });
  assert.deepEqual([late.reads[0].status, late.reads[0].reason, late.recon.verdict], ["failed", "the read failed: no answer within 1s", "could_not_be_checked"]);
  assert.equal(hung.seen.length, 1);

  // a list longer than the page cap is a failed read
  const endless = fakeVenue({ "GET /trade-api/v2/portfolio/fills": () => ({ status: 200, body: { fills: [], cursor: "more" } }) });
  const capped = await check(book, { kalshi: kalshiClient(endless) }, { maxPages: 3 });
  assert.deepEqual([endless.seen.length, capped.reads[0].reason], [3, "the read failed: the day's list did not end within 3 pages"]);
});

test("the readers from the service env: which key reads what, in words; no key material in the view; nothing is called to build them", () => {
  const empty = venueFillReadersFromEnv({});
  assert.deepEqual(empty.readers, {});
  assert.deepEqual(empty.view, { kalshi: "no key for kalshi", prophetx: "no key for prophetx", novig: "no key for novig", polymarket: "no reader for polymarket" });

  const env = {
    KALSHI_API_KEY_ID: kalshiKey.creds.apiKeyId,
    KALSHI_PRIVATE_KEY_PEM: kalshiKey.creds.privateKeyPem,
    AGGREGATOR_TRADE_KEY_ID: podKey.keyId,
    AGGREGATOR_TRADE_PRIVATE_KEY_HEX: podKey.secret,
    NOVIG_TRADE_KEY_ID: novigKey.keyId,
    NOVIG_TRADE_PRIVATE_KEY_PEM: novigKey.pem,
    VENUE_API_HOST: NOVIG_HOST,
    EVENT_RECON_KALSHI_SUBACCOUNTS: "1, 0, 1, x, 99",
  };
  const full = venueFillReadersFromEnv(env);
  assert.deepEqual(Object.keys(full.readers).sort(), ["aggregator", "kalshi", "kalshiSubaccounts", "novig", "prophetx"]);
  assert.deepEqual(full.readers.kalshiSubaccounts, [1, 0]);
  assert.deepEqual(full.view, {
    kalshi: "the venue's own list of the day's fills, subaccount 1, 0 (KALSHI_API_KEY_ID)",
    prophetx: "the aggregator's fills of each order our ledger names; no day list (AGGREGATOR_TRADE_KEY_ID)",
    novig: "the venue's own list of the day's fills in the trading key's subaccount (NOVIG_TRADE_KEY_ID)",
    polymarket: "no reader for polymarket",
  });
  const text = JSON.stringify(full.view);
  for (const secret of [kalshiKey.creds.privateKeyPem, podKey.secret, novigKey.pem, podKey.keyId, novigKey.keyId]) assert.ok(!text.includes(secret));

  // only the aggregator's key: Kalshi is read order by order through it
  const podOnly = venueFillReadersFromEnv({ AGGREGATOR_TRADE_KEY_ID: podKey.keyId, AGGREGATOR_TRADE_PRIVATE_KEY_HEX: podKey.secret });
  assert.deepEqual(Object.keys(podOnly.readers).sort(), ["aggregator", "prophetx"]);
  assert.equal(podOnly.view.kalshi, "the aggregator's read of each order our ledger names; no day list, and orders sent with our own key cannot be read (AGGREGATOR_TRADE_KEY_ID)");
  // a key that cannot be parsed is said, and its text is not echoed
  const bad = venueFillReadersFromEnv({ NOVIG_TRADE_KEY_ID: "k", NOVIG_TRADE_PRIVATE_KEY_PEM: "not a pem", VENUE_API_HOST: NOVIG_HOST });
  assert.equal(bad.readers.novig, undefined);
  assert.match(bad.view.novig, /^the trading key is unusable/);
  assert.ok(!bad.view.novig.includes("not a pem"));
});
