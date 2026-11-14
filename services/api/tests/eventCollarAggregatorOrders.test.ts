/**
 * Aggregator orders — the live hedge through the partner's pod. The body is the same No buy the
 * direct path sends in the partner's spelling, the idempotency key is the client order id, the
 * request is signed with the TRADE key and verifies against its public half, the fill is taken
 * from the read-back (fees included) with every rounding against the writer, a resting order is
 * cancelled, nothing filled is an error, and the executor records via "aggregator" on the fill.
 * Driven by a fake fetch; nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  AGGREGATOR_FINAL,
  AggregatorOrderClient,
  aggregatorClientOrderId,
  aggregatorTradeConfigFromEnv,
  fillOfAggregatorOrder,
  fillOfSubmit,
} from "../src/eventCollar/crossVenue/aggregatorOrders";
import { canonicalString, sha256Hex } from "../src/eventCollar/crossVenue/aggregatorMarkets";
import { intentFromHedge } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv, liveViaFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { kalshiTakerFeeCents } from "../src/eventCollar/crossVenue/kalshiLadder";
import { LiveHedgeExecutor, type LiveHedgeRails } from "../src/eventCollar/crossVenue/liveHedge";
import type { KalshiSelfHedgeLeg } from "../src/eventCollar/crossVenue/types";

const keypair = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { seedHex: der.subarray(der.length - 32).toString("hex"), publicKey };
})();
const KEY_ID = "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const HOST = "https://api.example.test";
const cfg = { host: HOST, keyId: KEY_ID, secret: keypair.seedHex };

/** 20 No at 40c, 42c walked; the demo size. */
const KALSHI_LEG: KalshiSelfHedgeLeg = {
  action: "buy",
  venue: "kalshi",
  outcome: "No",
  ticker: "KXNBAGAME-26OCT14LALBOS-BOS",
  contractsMilli: 20_000,
  avgPriceCents: 41,
  worstPriceCents: 42,
  costCents: 826,
};
const intent = () => intentFromHedge(KALSHI_LEG, 400);

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake partner: answers by (method, path); records every request for the signing checks. */
function fakePartner(routes: Record<string, (seen: Seen, nth: number) => { status: number; body?: unknown }>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k, v]));
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: u.search.slice(1), headers, body: typeof init?.body === "string" ? init.body : "" };
    seen.push(s);
    const key = `${s.method} ${s.path}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const route = routes[key] ?? routes[`${s.method} *`];
    if (!route) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `no route ${key}` } }), { status: 404 });
    const r = route(s, nth);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

const TIME = { "GET /v1/time": () => ({ status: 200, body: { time: 1_760_000_000 } }) };
const noSleep = async () => {};

test("aggregator orders: the body is an ASK on the YES book at 1 - the walked worst No price, IOC, taker-at-cross, fixed-point size, with a conforming client order id", () => {
  const body = AggregatorOrderClient.orderBody(intent(), "atticus-abc123");
  assert.deepEqual(body, {
    ticker: "KXNBAGAME-26OCT14LALBOS-BOS",
    side: "ASK",
    count: "20.00",
    price: "0.5800",
    timeInForce: { type: "IOC" },
    selfTradePrevention: "TAKER_AT_CROSS",
    clientOrderId: "atticus-abc123",
  });
  assert.equal(AggregatorOrderClient.capCents(intent()), 42);
  assert.throws(() => AggregatorOrderClient.orderBody({ ...intent(), venue: "polymarket" }, "x"), /pod routes Kalshi only/);
  // the partner's grammar: 64 of letters, digits and - _ : / + =
  assert.equal(aggregatorClientOrderId("atticus-abc"), "atticus-abc");
  assert.equal(aggregatorClientOrderId("has space.and#hash"), "has-space-and-hash");
  assert.equal(aggregatorClientOrderId("x".repeat(80)).length, 64);
  assert.equal(aggregatorClientOrderId(""), "atticus");
});

test("aggregator orders: the fill is read against the writer — the No average rounds up, the exact fee rounds up, no fee falls to the taker formula, no average to the cap", () => {
  // 20 filled at a No average of 0.405 (Yes 0.595): 20 x 40.5c = 810c; fee exact 0.07 -> 7c
  const f = fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", feesCents: 7, feesUsd: "0.07" }, 42);
  assert.deepEqual(f, { unitsMilli: 20_000, costCents: 817, feesCents: 7 });
  // a fractional fee dollar rounds up; the venue's whole cents are used only when the exact figure is missing
  assert.equal(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", feesCents: 7, feesUsd: "0.0701" }, 42).feesCents, 8);
  assert.equal(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", feesCents: 9, feesUsd: null }, 42).feesCents, 9);
  // no fee at all: the exact taker formula at the No average
  const noFee = fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: null, feesCents: null, feesUsd: null }, 42);
  assert.equal(noFee.feesCents, kalshiTakerFeeCents(20_000, 41));
  assert.equal(noFee.costCents, 810 + noFee.feesCents);
  // no average: read at the cap, never under
  assert.equal(fillOfAggregatorOrder({ filledCount: "20.00", averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null }, 42).costCents, 840 + kalshiTakerFeeCents(20_000, 42));
  // a sub-cent No average: 7.5 x 0.4049 -> 303.675c rounds to 304c
  assert.equal(fillOfAggregatorOrder({ filledCount: "7.50", averageYesPrice: null, averageNoPrice: "0.4049", feesCents: 0, feesUsd: "0" }, 42).costCents, 304);
  // nothing filled is zero everywhere
  assert.deepEqual(fillOfAggregatorOrder({ filledCount: "0.00", averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null }, 42), { unitsMilli: 0, costCents: 0, feesCents: 0 });
  assert.deepEqual(fillOfAggregatorOrder({ filledCount: null, averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null }, 42), { unitsMilli: 0, costCents: 0, feesCents: 0 });
  // the submit answer alone carries a Yes average and no fee
  const s = fillOfSubmit({ orderId: "o", status: "FILLED", filledCount: "20.00", remainingCount: "0.00", averagePrice: "0.5950" }, 42);
  assert.equal(s.unitsMilli, 20_000);
  assert.equal(s.costCents, 810 + kalshiTakerFeeCents(20_000, 41));
  assert.deepEqual([...AGGREGATOR_FINAL].sort(), ["CANCELLED", "FILLED", "REJECTED"]);
});

test("aggregator orders: a filled IOC — submit signed with the TRADE key and the idempotency key, one read-back for the fees, the result says via aggregator with the venue's id", async () => {
  const partner = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-1", status: "FILLED", filledCount: "20.00", remainingCount: "0.00", averagePrice: "0.5950" } }),
    "GET /v1/kalshi/orders/px-1": () => ({
      status: 200,
      body: { orderId: "px-1", ticker: KALSHI_LEG.ticker, side: "ASK", type: "LIMIT", count: "20.00", status: "FILLED", venueOrderId: "k-77", filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", feesCents: 7, feesUsd: "0.07", clientOrderId: "atticus-r1", closedAt: "2026-10-27T12:00:01Z" },
    }),
  });
  const client = new AggregatorOrderClient(cfg, { fetchImpl: partner.fetch, nowSec: () => 1_759_999_990, sleep: noSleep });
  const r = await client.placeNo(intent(), "atticus-r1");
  assert.deepEqual(r, { orderId: "px-1", venueOrderId: "k-77", unitsMilli: 20_000, avgPriceMilli: 409, costCents: 817, feesCents: 7, status: "executed", via: "aggregator" });

  const submit = partner.seen.find((s) => s.method === "POST")!;
  assert.equal(submit.path, "/v1/kalshi/orders");
  assert.equal(submit.headers["Idempotency-Key"], "atticus-r1");
  assert.equal(submit.headers["PX-Key-Id"], KEY_ID);
  // the clock offset from GET /v1/time (+10s) is on the timestamp
  assert.equal(submit.headers["PX-Timestamp"], "1760000000");
  assert.equal(submit.headers["PX-Content-Sha256"], sha256Hex(submit.body));
  assert.deepEqual(JSON.parse(submit.body), AggregatorOrderClient.orderBody(intent(), "atticus-r1"));
  const canonical = canonicalString({ method: "POST", path: "/v1/kalshi/orders", query: "", timestamp: "1760000000", body: submit.body, idempotencyKey: "atticus-r1" });
  assert.ok(cryptoVerify(null, Buffer.from(canonical, "utf8"), keypair.publicKey, Buffer.from(submit.headers["PX-Signature"], "hex")), "the signature verifies against the TRADE key's public half");
  assert.ok(!submit.body.includes(keypair.seedHex) && !JSON.stringify(submit.headers).includes(keypair.seedHex), "the secret never travels");
  // one time read, one submit, one read-back; nothing cancelled
  assert.deepEqual(
    partner.seen.map((s) => `${s.method} ${s.path}`),
    ["GET /v1/time", "POST /v1/kalshi/orders", "GET /v1/kalshi/orders/px-1"],
  );
});

test("aggregator orders: PENDING then FILLED — the relay is read until it stops moving; a partial fill is a partial", async () => {
  const partner = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-2", status: "PENDING", filledCount: null, remainingCount: null, averagePrice: null } }),
    "GET /v1/kalshi/orders/px-2": (_s, nth) =>
      nth === 0
        ? { status: 200, body: { orderId: "px-2", status: "SUBMITTED", count: "20.00", filledCount: null, averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null, venueOrderId: null } }
        : { status: 200, body: { orderId: "px-2", status: "CANCELLED", count: "20.00", filledCount: "12.00", averageYesPrice: "0.58", averageNoPrice: "0.42", feesCents: 5, feesUsd: "0.05", venueOrderId: "k-78" } },
  });
  const slept: number[] = [];
  const client = new AggregatorOrderClient(cfg, { fetchImpl: partner.fetch, settleWaitMs: 250, sleep: async (ms) => void slept.push(ms) });
  const r = await client.placeNo(intent(), "atticus-r2");
  // 12 x 42c = 504c + 5c fee; the IOC cancelled the rest at the venue
  assert.deepEqual(r, { orderId: "px-2", venueOrderId: "k-78", unitsMilli: 12_000, avgPriceMilli: 425, costCents: 509, feesCents: 5, status: "cancelled", via: "aggregator" });
  assert.deepEqual(slept, [250]);
  assert.equal(partner.seen.filter((s) => s.method === "DELETE").length, 0);
});

test("aggregator orders: an order the relay shows resting is cancelled and the fill read from the cancel answer; a 409 on cancel means it finished first", async () => {
  const partner = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-3", status: "OPEN", filledCount: "5.00", remainingCount: "15.00", averagePrice: "0.5800" } }),
    "GET /v1/kalshi/orders/px-3": () => ({ status: 200, body: { orderId: "px-3", status: "OPEN", count: "20.00", filledCount: "5.00", averageYesPrice: "0.58", averageNoPrice: "0.42", feesCents: 2, feesUsd: "0.02", venueOrderId: "k-79" } }),
    "DELETE /v1/kalshi/orders/px-3": () => ({ status: 200, body: { orderId: "px-3", status: "CANCELLED", count: "20.00", filledCount: "5.00", averageYesPrice: "0.58", averageNoPrice: "0.42", feesCents: 2, feesUsd: "0.02", venueOrderId: "k-79" } }),
  });
  const client = new AggregatorOrderClient(cfg, { fetchImpl: partner.fetch, sleep: noSleep });
  const r = await client.placeNo(intent(), "atticus-r3");
  assert.equal(r.status, "cancelled");
  assert.equal(r.unitsMilli, 5_000);
  assert.equal(r.costCents, 210 + 2);
  assert.deepEqual(
    partner.seen.map((s) => `${s.method} ${s.path}`),
    ["GET /v1/time", "POST /v1/kalshi/orders", "GET /v1/kalshi/orders/px-3", "DELETE /v1/kalshi/orders/px-3"],
  );

  const raced = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-4", status: "OPEN", filledCount: "0.00", remainingCount: "20.00", averagePrice: null } }),
    "GET /v1/kalshi/orders/px-4": (_s, nth) => ({
      status: 200,
      body: nth === 0
        ? { orderId: "px-4", status: "OPEN", count: "20.00", filledCount: "0.00", averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null, venueOrderId: "k-80" }
        : { orderId: "px-4", status: "FILLED", count: "20.00", filledCount: "20.00", averageYesPrice: "0.59", averageNoPrice: "0.41", feesCents: 7, feesUsd: "0.07", venueOrderId: "k-80" },
    }),
    "DELETE /v1/kalshi/orders/px-4": () => ({ status: 409, body: { error: { code: "ORDER_NOT_CANCELLABLE", message: "already filled" } } }),
  });
  const r4 = await new AggregatorOrderClient(cfg, { fetchImpl: raced.fetch, sleep: noSleep }).placeNo(intent(), "atticus-r4");
  assert.equal(r4.status, "executed");
  assert.equal(r4.unitsMilli, 20_000);
  assert.equal(r4.costCents, 820 + 7);
});

test("aggregator orders: nothing filled is an error naming the order and the cap; a refused submit surfaces the partner's code; no order id is an error", async () => {
  const empty = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-5", status: "CANCELLED", filledCount: "0.00", remainingCount: "0.00", averagePrice: null } }),
    "GET /v1/kalshi/orders/px-5": () => ({ status: 200, body: { orderId: "px-5", status: "CANCELLED", count: "20.00", filledCount: "0.00", averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null, venueOrderId: "k-81" } }),
  });
  await assert.rejects(new AggregatorOrderClient(cfg, { fetchImpl: empty.fetch, sleep: noSleep }).placeNo(intent(), "r5"), /order px-5 CANCELLED with nothing filled at or under 42c/);

  // taken and not read to its end: never worded as a miss (liveHedge.orderNotReadError)
  const down = () => ({ status: 502, body: { error: { code: "BAD_GATEWAY", message: "upstream" } } });
  const pendingOrder = (id: string, status: string) => ({ orderId: id, status, count: "20.00", filledCount: null, averageYesPrice: null, averageNoPrice: null, feesCents: null, feesUsd: null, venueOrderId: null });
  const unread: Array<[string, Record<string, () => { status: number; body: unknown }>, RegExp]> = [
    ["px-7", { "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-7", status: "PENDING", filledCount: null, remainingCount: null, averagePrice: null } }), "GET /v1/kalshi/orders/px-7": down }, /order px-7 was sent and its end was not read \(every read of it failed; last seen PENDING\); it may have filled/],
    ["px-8", { "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-8", status: "PENDING", filledCount: null, remainingCount: null, averagePrice: null } }), "GET /v1/kalshi/orders/px-8": () => ({ status: 200, body: pendingOrder("px-8", "PENDING") }), "DELETE /v1/kalshi/orders/px-8": down }, /order px-8 was sent and its end was not read \(it did not reach a final state and the cancel was not confirmed; last seen PENDING\)/],
    ["px-9", { "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-9", status: "SUBMITTED", filledCount: null, remainingCount: null, averagePrice: null } }), "GET /v1/kalshi/orders/px-9": () => ({ status: 200, body: pendingOrder("px-9", "FILLED") }) }, /order px-9 was sent and its end was not read \(it reads as filled with no fill on it; last seen FILLED\)/],
  ];
  for (const [id, routes, words] of unread) {
    const err = await new AggregatorOrderClient(cfg, { fetchImpl: fakePartner({ ...TIME, ...routes }).fetch, sleep: noSleep }).placeNo(intent(), id).then(() => null, (e: Error) => e);
    assert.ok(err, `${id} is an error`);
    assert.match(err.message, words);
    assert.doesNotMatch(err.message, /with nothing (filled|sold)/, `${id} is not worded as a miss`);
  }
  // the submit itself answered CANCELLED with nothing filled and the reads then failed: the venue's word was read once, a miss
  const cancelledAtSubmit = fakePartner({ ...TIME, "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-10", status: "CANCELLED", filledCount: "0.00", remainingCount: "0.00", averagePrice: null } }), "GET /v1/kalshi/orders/px-10": down });
  await assert.rejects(new AggregatorOrderClient(cfg, { fetchImpl: cancelledAtSubmit.fetch, sleep: noSleep }).placeNo(intent(), "r10"), /order px-10 CANCELLED with nothing filled/);

  const refused = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 400, body: { error: { code: "INSUFFICIENT_BALANCE", message: "the order needs $8.40; the pod has $2.00 available in this market's group" } } }),
  });
  await assert.rejects(new AggregatorOrderClient(cfg, { fetchImpl: refused.fetch, sleep: noSleep }).placeNo(intent(), "r6"), (err: unknown) => {
    assert.match(String((err as Error).message), /needs \$8\.40/);
    assert.equal((err as { code?: string }).code, "INSUFFICIENT_BALANCE");
    assert.equal((err as { status?: number }).status, 400);
    return true;
  });

  const noId = fakePartner({ ...TIME, "POST /v1/kalshi/orders": () => ({ status: 201, body: { status: "PENDING" } }) });
  await assert.rejects(new AggregatorOrderClient(cfg, { fetchImpl: noId.fetch, sleep: noSleep }).placeNo(intent(), "r7"), /submit returned no order id/);
});

test("aggregator orders: the reads — whoami, the pod's cash floored to cents, positions by ticker; a failed time sync is not fatal", async () => {
  const partner = fakePartner({
    "GET /v1/time": () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "later" } } }),
    "GET /v1/whoami": () => ({ status: 200, body: { keyId: KEY_ID, credentialId: "cred-1", podId: "pod-9", scope: "pod", capabilities: ["trade"] } }),
    "GET /v1/kalshi/balance": () => ({ status: 200, body: { available: 123.456 } }),
    "GET /v1/kalshi/positions": (s) => ({ status: 200, body: { positions: s.query === `ticker=${encodeURIComponent(KALSHI_LEG.ticker)}` ? [{ ticker: KALSHI_LEG.ticker, contracts: "-20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", yesMark: "0.60", noMark: "0.40", valueUsd: "8.00", unrealizedPnlUsd: "-0.10" }] : [] } }),
  });
  const client = new AggregatorOrderClient(cfg, { fetchImpl: partner.fetch, sleep: noSleep });
  const who = await client.whoami();
  assert.equal(who.podId, "pod-9");
  assert.deepEqual(who.capabilities, ["trade"]);
  assert.equal(await client.availableCents(), 12345);
  assert.equal((await client.positions(KALSHI_LEG.ticker)).length, 1);
  assert.equal((await client.positions()).length, 0);
  assert.equal(client.publicKeyHex.length, 64);
  assert.equal(client.keyId, KEY_ID);
  // the time endpoint was asked once, then left alone
  assert.equal(partner.seen.filter((s) => s.path === "/v1/time").length, 1);
  assert.equal(partner.seen.find((s) => s.path === "/v1/time")!.headers["PX-Timestamp"], undefined);
});

const OPEN_RAILS: LiveHedgeRails = { killSwitch: false, dryRun: false, allowlist: [KALSHI_LEG.ticker], anyTicker: false, maxUnitsPerOrderMilli: 25_000, maxUnitsPerDayMilli: 100_000 };

test("live executor: a hook that answers via aggregator puts via and the venue id on the fill and names the path on the trail; the default stays direct", async () => {
  const viaPod = new LiveHedgeExecutor(
    { kalshi: async () => ({ orderId: "px-1", venueOrderId: "k-77", unitsMilli: 20_000, avgPriceMilli: 409, costCents: 817, feesCents: 7, status: "executed", via: "aggregator" }) },
    OPEN_RAILS,
    () => 0,
  );
  const r = await viaPod.execute(intent(), "ref");
  assert.equal(r.outcome, "filled_live");
  assert.equal(r.fill?.via, "aggregator");
  assert.deepEqual(r.fill?.ids, { orderId: "px-1", venueOrderId: "k-77" });
  const order = r.attempts.find((a) => a.strategy === "live" && a.step === "order")!;
  assert.match(order.detail, /order px-1 \(venue k-77\) executed via aggregator: 20 of 20 filled/);

  const direct = new LiveHedgeExecutor({ kalshi: async () => ({ orderId: "k-1", unitsMilli: 20_000, avgPriceMilli: 409, costCents: 817, feesCents: 7, status: "executed" }) }, OPEN_RAILS, () => 0);
  const d = await direct.execute(intent(), "ref");
  assert.equal(d.fill?.via, "direct");
  assert.deepEqual(d.fill?.ids, { orderId: "k-1" });
  assert.doesNotMatch(d.attempts.find((a) => a.strategy === "live" && a.step === "order")!.detail, /via aggregator|venue/);
});

test("hedgeExecutorFromEnv: EVENT_HEDGE_LIVE_VIA=aggregator wires the TRADE key's client under the same rails; the DATA key does not count; the view names the path and carries no secret", () => {
  assert.equal(liveViaFromEnv({}), "direct");
  assert.equal(liveViaFromEnv({ EVENT_HEDGE_LIVE_VIA: "Aggregator " }), "aggregator");
  assert.equal(liveViaFromEnv({ EVENT_HEDGE_LIVE_VIA: "pod" }), "direct");
  assert.equal(aggregatorTradeConfigFromEnv({ AGGREGATOR_KEY_ID: "data", AGGREGATOR_PRIVATE_KEY_HEX: keypair.seedHex }), null, "the DATA key is not a trade key");
  assert.deepEqual(aggregatorTradeConfigFromEnv({ AGGREGATOR_TRADE_KEY_ID: KEY_ID, AGGREGATOR_TRADE_PRIVATE_KEY_HEX: keypair.seedHex, AGGREGATOR_API_HOST: "https://h/" }), { host: "https://h", keyId: KEY_ID, secret: keypair.seedHex });

  const missing = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_LIVE_VIA: "aggregator" });
  assert.equal(missing.live?.via, "aggregator");
  assert.deepEqual(missing.live?.venues, []);
  assert.equal(missing.aggregatorOrders, null);
  assert.equal(missing.kalshiOrders, null);
  assert.match(missing.notes[0], /EVENT_HEDGE_LIVE_VIA=aggregator but no AGGREGATOR_TRADE_KEY_ID/);

  const armed = hedgeExecutorFromEnv({
    EVENT_HEDGE_STRATEGY: "live",
    EVENT_HEDGE_LIVE_VIA: "aggregator",
    EVENT_HEDGE_LIVE_TICKERS: KALSHI_LEG.ticker,
    AGGREGATOR_TRADE_KEY_ID: KEY_ID,
    AGGREGATOR_TRADE_PRIVATE_KEY_HEX: keypair.seedHex,
    KALSHI_API_KEY_ID: "k",
    KALSHI_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----",
  });
  assert.ok(armed.aggregatorOrders instanceof AggregatorOrderClient);
  assert.equal(armed.kalshiOrders, null, "the direct client sends nothing while via=aggregator");
  // the same TRADE key reaches the pod's ProphetX account: two live venues, one key
  assert.deepEqual(armed.live?.venues, ["kalshi", "prophetx"]);
  assert.ok(armed.prophetxOrders, "the ProphetX client shares the pod's REST and the key");
  assert.equal(armed.prophetxOrders?.rest, armed.aggregatorOrders?.rest);
  assert.equal(armed.live?.via, "aggregator");
  assert.equal(armed.live?.dryRun, true);
  assert.match(armed.notes.join(" | "), /live orders go through the aggregator's pod with the TRADE key/);
  assert.match(armed.notes.join(" | "), /prophetx: live orders go through the aggregator's pod with the TRADE key, fill or kill on the venue's ladder; 2% of net gains provided for at settlement/);
  assert.match(missing.notes.join(" | "), /prophetx: no TRADE key; live orders impossible/);
  assert.equal(missing.prophetxOrders, null);
  assert.match(armed.notes.join(" | "), /KALSHI_API_KEY_ID is set but sends nothing while via=aggregator/);
  const shown = JSON.stringify({ live: armed.live, notes: armed.notes });
  assert.ok(!shown.includes(keypair.seedHex) && !shown.includes(KEY_ID), "the view carries neither half of the key");

  const bad = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_LIVE_VIA: "aggregator", AGGREGATOR_TRADE_KEY_ID: KEY_ID, AGGREGATOR_TRADE_PRIVATE_KEY_HEX: "not-a-key" });
  assert.equal(bad.aggregatorOrders, null);
  assert.match(bad.notes[0], /AGGREGATOR_TRADE_PRIVATE_KEY_HEX unusable/);

  // direct is untouched
  const direct = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", AGGREGATOR_TRADE_KEY_ID: KEY_ID, AGGREGATOR_TRADE_PRIVATE_KEY_HEX: keypair.seedHex });
  assert.equal(direct.live?.via, "direct");
  assert.equal(direct.aggregatorOrders, null);
  assert.equal(direct.prophetxOrders, null, "ProphetX is reached through the pod only");
  assert.match(direct.notes[0], /no KALSHI_API_KEY_ID/);
  assert.match(direct.notes.join(" | "), /prophetx: live orders reach the venue only through the aggregator's pod/);
});

test("hedgeExecutorFromEnv: via aggregator end to end against the fake partner — dry run holds, EVENT_HEDGE_LIVE_SEND=yes sends through the pod and the receipt says so", async () => {
  const partner = fakePartner({
    ...TIME,
    "POST /v1/kalshi/orders": () => ({ status: 201, body: { orderId: "px-9", status: "FILLED", filledCount: "20.00", remainingCount: "0.00", averagePrice: "0.5950" } }),
    "GET /v1/kalshi/orders/px-9": () => ({ status: 200, body: { orderId: "px-9", status: "FILLED", count: "20.00", filledCount: "20.00", averageYesPrice: "0.595", averageNoPrice: "0.405", feesCents: 7, feesUsd: "0.07", venueOrderId: "k-99" } }),
  });
  const client = new AggregatorOrderClient(cfg, { fetchImpl: partner.fetch, sleep: noSleep });
  const env = { EVENT_HEDGE_STRATEGY: "live", EVENT_HEDGE_LIVE_VIA: "aggregator", EVENT_HEDGE_LIVE_TICKERS: KALSHI_LEG.ticker };
  const held = await hedgeExecutorFromEnv(env, null, { liveHooks: { kalshi: client.hook() } }).executor.execute(intent(), "ref");
  assert.equal(held.fallbackReason, "dry run");
  assert.equal(partner.seen.length, 0, "a dry run touches nothing");

  const sent = await hedgeExecutorFromEnv({ ...env, EVENT_HEDGE_LIVE_SEND: "yes" }, null, { liveHooks: { kalshi: client.hook() } }).executor.execute(intent(), "ref");
  assert.equal(sent.outcome, "filled_live");
  assert.equal(sent.fill?.via, "aggregator");
  assert.equal(sent.fill?.ids.venueOrderId, "k-99");
  assert.equal(sent.fill?.costCents, 817);
  assert.equal(sent.fill?.vsBookCents, 826 - 817);
  const submit = partner.seen.find((s) => s.method === "POST")!;
  assert.match(submit.headers["Idempotency-Key"], /^atticus-[0-9a-f]{16}$/);
});
