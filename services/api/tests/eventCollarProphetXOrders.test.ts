/**
 * ProphetX orders through the aggregator's pod: the settlement fee folded into the book and
 * unfolded for the limit, the limit snapped down the venue's ladder, the stake (not shares) on the
 * body, fill or kill, the fills read against the writer, the buy costed with the fee on the gain,
 * the offset buy that unwinds a hedge (proceeds at the game), a kill that filled nothing as an
 * error, and the live executor recording via aggregator. Driven by a fake fetch; nothing touches
 * the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { AggregatorPodRest } from "../src/eventCollar/crossVenue/aggregatorOrders";
import { intentFromHedge, sellIntentForProphetX } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { LiveHedgeExecutor } from "../src/eventCollar/crossVenue/liveHedge";
import {
  DEFAULT_PROPHETX_FEE_BPS,
  ProphetXOrderClient,
  buyCostCents,
  foldProphetXFee,
  ladderMicro,
  prophetxFeeBpsFromEnv,
  rawAskMicroOf,
  rawBidMicroOf,
  snapDown,
  sumProphetXFills,
} from "../src/eventCollar/crossVenue/prophetxOrders";
import type { PmBook, ProphetXHedgeLeg } from "../src/eventCollar/crossVenue/types";

const keypair = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return { seedHex: der.subarray(der.length - 32).toString("hex") };
})();
const KEY_ID = "7a1d2c3b-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const cfg = { host: "https://api.example.test", keyId: KEY_ID, secret: keypair.seedHex };

/** The venue's ladder as the partner serves it: American odds as dollars per share, six decimals. */
const LADDER = ["0.333333", "0.384615", "0.400000", "0.416667", "0.444444", "0.500000", "0.600000", "0.666667"];

/** 20 shares of the opposing strike, walked to a fee-folded worst of 412 milli (raw 0.400000). */
const PX_LEG: ProphetXHedgeLeg = {
  action: "buy",
  venue: "prophetx",
  outcome: "Lakers",
  strikeId: "strike-no-1",
  offsetStrikeId: "strike-yes-1",
  sharesMilli: 20_000,
  avgPriceMilli: 412,
  worstPriceMilli: 412,
  costCents: 824,
};
const buyIntent = () => intentFromHedge(PX_LEG, 412, "KXNBAGAME-26OCT14LALBOS-BOS");

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

function fakePartner(routes: Record<string, (seen: Seen, nth: number) => { status: number; body?: unknown }>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: u.search.slice(1), headers, body: typeof init?.body === "string" ? init.body : "" };
    seen.push(s);
    const key = `${s.method} ${s.path}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: `no route ${key}` } }), { status: 404 });
    const r = route(s, nth);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

const TIME = { "GET /v1/time": () => ({ status: 200, body: { time: 1_760_000_000 } }) };
const LADDER_ROUTE = { "GET /v1/prophetx/ladder": () => ({ status: 200, body: { prices: LADDER, source: "venue" } }) };
const noSleep = async () => {};
const client = (partner: { fetch: typeof fetch }) => new ProphetXOrderClient(cfg, { rest: new AggregatorPodRest(cfg, { fetchImpl: partner.fetch, nowSec: () => 1_759_999_990 }), feeBps: 200, sleep: noSleep });

test("prophetx fee: 2% of net gains is folded into every level before the walk and unfolded for the limit; the env overrides the rate", () => {
  assert.equal(DEFAULT_PROPHETX_FEE_BPS, 200);
  assert.equal(prophetxFeeBpsFromEnv({}), 200);
  assert.equal(prophetxFeeBpsFromEnv({ EVENT_PROPHETX_FEE_BPS: "150" }), 150);
  assert.equal(prophetxFeeBpsFromEnv({ EVENT_PROPHETX_FEE_BPS: "x" }), 200);
  assert.equal(prophetxFeeBpsFromEnv({ EVENT_PROPHETX_FEE_BPS: "0" }), 0, "an explicit zero is a zero");
  assert.equal(prophetxFeeBpsFromEnv({ EVENT_PROPHETX_FEE_BPS: " " }), 200, "blank is unset");
  const book: PmBook = { tokenId: "strike-no-1", asks: [{ priceMilli: 400, sizeMilli: 50_000 }, { priceMilli: 417, sizeMilli: 50_000 }], bids: [{ priceMilli: 400, sizeMilli: 50_000 }] };
  const folded = foldProphetXFee(book, 200);
  // an ask at 40c wins 60c; 2% of that is 1.2c, 12 milli
  assert.deepEqual(
    folded.asks.map((l) => [l.priceMilli, l.sizeMilli]),
    [
      [412, 50_000],
      [429, 50_000],
    ],
  );
  // a bid at 40c gives up 2% of its 40c: 8 milli
  assert.deepEqual(folded.bids.map((l) => l.priceMilli), [392]);
  assert.equal(folded.tokenId, "strike-no-1");
  // the fold reverses exactly on a rung and never above it on a rounded one
  assert.equal(rawAskMicroOf(412, 200), 400_000);
  assert.equal(rawBidMicroOf(392, 200), 400_000);
  assert.ok(rawAskMicroOf(429, 200) >= 416_667, "the raw price behind a rounded-up level sits at or over its rung");
  assert.equal(foldProphetXFee(book, 0).asks[0].priceMilli, 400, "no fee, no fold");
});

test("prophetx ladder: micro dollars ascending, strictly inside (0, 1); snapping down never pays over the walk and tolerates the pricer's milli rounding", () => {
  const l = ladderMicro(["0.500000", "0.333333", "0", "1", "junk", "0.400000"]);
  assert.deepEqual(l, [333_333, 400_000, 500_000]);
  assert.equal(snapDown(l, 400_000), 400_000, "on a rung, that rung");
  assert.equal(snapDown(l, 450_000), 400_000, "between rungs, the one below");
  assert.equal(snapDown(l, 333_000), 333_333, "a rung the pricer rounded down to milli is still that rung (one milli of slack)");
  assert.equal(snapDown(l, 331_000), null, "under the ladder, nothing");
  assert.equal(snapDown(l, 399_000, 0), 333_333, "without the slack the rung below");
});

test("prophetx plan: the body is a FillOrKill buy of the hedge strike at the raw limit snapped down the ladder, size as STAKE in dollars; an unwind is a buy of the holder's strike at 1 - the walked worst bid", () => {
  const ladder = ladderMicro(LADDER);
  const plan = ProphetXOrderClient.plan(buyIntent(), ladder, 200);
  assert.deepEqual(plan.body, { strikeId: "strike-no-1", price: "0.400000", quantity: 8, timeInForce: { FillOrKill: {} }, postOnly: false });
  assert.deepEqual([plan.limitMicro, plan.ceilingMicro, plan.stakeCents, plan.ladderSource], [400_000, 400_000, 800, "venue"]);
  // a walk to a worst of 429 (raw 0.417346) snaps to 0.416667; 20 shares x 0.416667 = $8.33334 -> $8.34
  const higher = ProphetXOrderClient.plan({ ...buyIntent(), book: { ...buyIntent().book, worstPriceMilli: 429 } }, ladder, 200);
  assert.deepEqual([higher.body.price, higher.body.quantity], ["0.416667", 8.34]);
  // the offset: the hedge strike's fee-folded bids walked to 392 (raw 0.40) -> the holder's strike at 1 - 0.40 = 0.600000, $12 of stake for 20 shares
  const sell = sellIntentForProphetX({ strikeId: "strike-no-1", offsetStrikeId: "strike-yes-1", unitsMilli: 20_000, bestPriceMilli: 392, avgPriceMilli: 392, worstPriceMilli: 392, grossCents: 784 });
  const offset = ProphetXOrderClient.plan(sell, ladder, 200);
  assert.deepEqual(offset.body, { strikeId: "strike-yes-1", price: "0.600000", quantity: 12, timeInForce: { FillOrKill: {} }, postOnly: false });
  assert.throws(() => ProphetXOrderClient.plan({ ...sell, offsetInstrument: undefined }, ladder, 200), /needs the holder's side's strike/);
  assert.throws(() => ProphetXOrderClient.plan({ ...buyIntent(), book: { ...buyIntent().book, worstPriceMilli: 320 } }, ladder, 200), /no ladder price at or under/);
  assert.throws(() => ProphetXOrderClient.plan({ ...buyIntent(), venue: "kalshi" }, ladder, 200), /intent is for kalshi/);
});

test("prophetx fills: shares floored, stake and fees rounded up, the average up; a buy is costed with the fee on its gain", () => {
  const sum = sumProphetXFills([
    { fillId: "f1", orderId: "o", venueFillId: "v1", shares: "12.000000", price: "0.400000", stakeUsd: "4.80", feeUsd: "0", occurredAt: "" },
    { fillId: "f2", orderId: "o", venueFillId: "v2", shares: "8.0004", price: "0.400000", stakeUsd: "3.20", feeUsd: "0.001", occurredAt: "" },
  ]);
  assert.deepEqual(sum, { sharesMilli: 20_000, stakeCents: 800, feesCents: 1, avgPriceMicro: 399_993 });
  // 20 shares pay $20 if they win against $8 of stake: a $12 gain, 2% is 24c
  assert.equal(buyCostCents({ sharesMilli: 20_000, stakeCents: 800, feesCents: 0 }, 200), 824);
  assert.equal(buyCostCents({ sharesMilli: 20_000, stakeCents: 800, feesCents: 0 }, 0), 800);
  assert.deepEqual(sumProphetXFills([]), { sharesMilli: 0, stakeCents: 0, feesCents: 0, avgPriceMicro: 0 });
});

test("prophetx place: a filled buy — ladder read once, the submit signed with the idempotency key, read back to FILLED, the fills summed, the fee on the gain provided for, via aggregator", async () => {
  const partner = fakePartner({
    ...TIME,
    ...LADDER_ROUTE,
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-1", status: "SUBMITTED", strikeId: "strike-no-1", price: "0.400000", quantity: 8, venueOrderId: null, filledQuantity: null } }),
    "GET /v1/prophetx/orders/px-1": (_s, nth) => ({ status: 200, body: nth === 0 ? { orderId: "px-1", status: "SUBMITTED", filledQuantity: null, venueOrderId: "pxv-9" } : { orderId: "px-1", status: "FILLED", filledQuantity: 8, venueOrderId: "pxv-9" } }),
    "GET /v1/prophetx/orders/px-1/fills": () => ({ status: 200, body: { fills: [{ fillId: "f1", orderId: "px-1", venueFillId: "vf1", shares: "20.000000", price: "0.400000", stakeUsd: "8.00", feeUsd: "0", occurredAt: "2026-10-28T00:00:01Z" }] } }),
  });
  const c = client(partner);
  const r = await c.place(buyIntent(), "atticus-r1");
  assert.equal(r.orderId, "px-1");
  assert.equal(r.venueOrderId, "pxv-9");
  assert.equal(r.unitsMilli, 20_000);
  assert.equal(r.costCents, 824, "stake plus 2% of the $12 gain");
  assert.equal(r.avgPriceMilli, 412);
  assert.equal(r.feesCents, 0);
  assert.equal(r.status, "executed");
  assert.equal(r.via, "aggregator");
  assert.match(r.note ?? "", /stake \$8\.00 at 0\.400000; 2% of the gain provided for at settlement/);
  const submit = partner.seen.find((s) => s.method === "POST")!;
  assert.equal(submit.headers["Idempotency-Key"], "atticus-r1");
  assert.equal(submit.headers["PX-Key-Id"], KEY_ID);
  assert.deepEqual(JSON.parse(submit.body), { strikeId: "strike-no-1", price: "0.400000", quantity: 8, timeInForce: { FillOrKill: {} }, postOnly: false });
  assert.ok(!submit.body.includes(keypair.seedHex) && !JSON.stringify(submit.headers).includes(keypair.seedHex), "the secret never travels");
  assert.deepEqual(
    partner.seen.map((s) => `${s.method} ${s.path}`),
    ["GET /v1/time", "GET /v1/prophetx/ladder", "POST /v1/prophetx/orders", "GET /v1/prophetx/orders/px-1", "GET /v1/prophetx/orders/px-1", "GET /v1/prophetx/orders/px-1/fills"],
  );
  // the ladder is cached: a second order reads no ladder
  await c.place(buyIntent(), "atticus-r2");
  assert.equal(partner.seen.filter((s) => s.path === "/v1/prophetx/ladder").length, 1);
});

test("prophetx place: a better fill buys more shares for the same stake, named as a windfall; a fallback ladder is named", async () => {
  const partner = fakePartner({
    ...TIME,
    "GET /v1/prophetx/ladder": () => ({ status: 200, body: { prices: LADDER, source: "fallback" } }),
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-2", status: "FILLED", venueOrderId: "pxv-2", filledQuantity: 8 } }),
    "GET /v1/prophetx/orders/px-2": () => ({ status: 200, body: { orderId: "px-2", status: "FILLED", filledQuantity: 8, venueOrderId: "pxv-2" } }),
    "GET /v1/prophetx/orders/px-2/fills": () => ({ status: 200, body: { fills: [{ fillId: "f", orderId: "px-2", venueFillId: "v", shares: "20.800000", price: "0.384615", stakeUsd: "8.00", feeUsd: "0", occurredAt: "" }] } }),
  });
  const r = await client(partner).place(buyIntent(), "atticus-r3");
  assert.equal(r.unitsMilli, 20_800, "the shares the stake bought, never the intent's count");
  // $8 of stake, $20.80 if they win: a $12.80 gain, 2% is 25.6c -> 26c
  assert.equal(r.costCents, 826);
  assert.match(r.note ?? "", /ladder served from the partner's last known set/);
  assert.match(r.note ?? "", /0\.800 shares over the size, bought by the same stake at a better price/);
});

test("prophetx place: the offset that unwinds a hedge — a buy of the holder's strike; proceeds are the dollar less the price, less the fee on that gain, realised at the game", async () => {
  const partner = fakePartner({
    ...TIME,
    ...LADDER_ROUTE,
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-3", status: "PENDING", venueOrderId: null, filledQuantity: null } }),
    "GET /v1/prophetx/orders/px-3": () => ({ status: 200, body: { orderId: "px-3", status: "FILLED", filledQuantity: 12, venueOrderId: "pxv-3" } }),
    "GET /v1/prophetx/orders/px-3/fills": () => ({ status: 200, body: { fills: [{ fillId: "f", orderId: "px-3", venueFillId: "v", shares: "20.000000", price: "0.600000", stakeUsd: "12.00", feeUsd: "0", occurredAt: "" }] } }),
  });
  const sell = sellIntentForProphetX({ strikeId: "strike-no-1", offsetStrikeId: "strike-yes-1", armKey: "KXNBAGAME-26OCT14LALBOS-BOS", unitsMilli: 20_000, bestPriceMilli: 392, avgPriceMilli: 392, worstPriceMilli: 392, grossCents: 784 });
  const r = await client(partner).place(sell, "atticus-s1");
  const submit = partner.seen.find((s) => s.method === "POST")!;
  assert.deepEqual(JSON.parse(submit.body), { strikeId: "strike-yes-1", price: "0.600000", quantity: 12, timeInForce: { FillOrKill: {} }, postOnly: false });
  // 20 pairs settle at $1 each: $20 against $12 paid is $8 gross, 2% of that is 16c
  assert.deepEqual([r.unitsMilli, r.costCents, r.feesCents, r.avgPriceMilli, r.status, r.via], [20_000, 784, 16, 392, "executed", "aggregator"]);
  assert.match(r.note ?? "", /offset bought: 20\.000 shares of strike strike-yes-1 at 0\.600000, stake \$12\.00; the pair settles at the game and the proceeds land then, not today/);
});

test("prophetx place: a kill that filled nothing is an error naming the order and the limit; a resting order is cancelled first; a 409 on cancel reads the order", async () => {
  const killed = fakePartner({
    ...TIME,
    ...LADDER_ROUTE,
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-4", status: "SUBMITTED" } }),
    "GET /v1/prophetx/orders/px-4": () => ({ status: 200, body: { orderId: "px-4", status: "CANCELLED", cancellationReason: "FOK", filledQuantity: 0 } }),
    "GET /v1/prophetx/orders/px-4/fills": () => ({ status: 200, body: { fills: [] } }),
  });
  await assert.rejects(client(killed).place(buyIntent(), "atticus-k1"), /order px-4 CANCELLED with nothing filled at or under 0\.400000 \(fill or kill\)/);

  // rests, the cancel answers "already final", and the order read after it says so: a miss, read to its end
  let cancelTried = false;
  const resting = fakePartner({
    ...TIME,
    ...LADDER_ROUTE,
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-5", status: "OPEN" } }),
    "GET /v1/prophetx/orders/px-5": () => ({ status: 200, body: { orderId: "px-5", status: cancelTried ? "CANCELLED" : "OPEN", filledQuantity: 0 } }),
    "DELETE /v1/prophetx/orders/px-5": () => {
      cancelTried = true;
      return { status: 409, body: { error: { code: "CONFLICT", message: "already final" } } };
    },
    "GET /v1/prophetx/orders/px-5/fills": () => ({ status: 200, body: { fills: [] } }),
  });
  await assert.rejects(client(resting).place(buyIntent(), "atticus-k2"), /px-5 CANCELLED with nothing filled/);
  assert.ok(resting.seen.some((s) => s.method === "DELETE" && s.path === "/v1/prophetx/orders/px-5"), "the resting order was cancelled");

  const noId = fakePartner({ ...TIME, ...LADDER_ROUTE, "POST /v1/prophetx/orders": () => ({ status: 201, body: { status: "SUBMITTED" } }) });
  await assert.rejects(client(noId).place(buyIntent(), "atticus-k3"), /submit returned no order id/);
  const empty = fakePartner({ ...TIME, "GET /v1/prophetx/ladder": () => ({ status: 200, body: { prices: [], source: "venue" } }) });
  await assert.rejects(client(empty).place(buyIntent(), "atticus-k4"), /ladder came back empty/);
});

test("prophetx place: an order that was taken and not read to its end is never called a miss", async () => {
  const miss = /with nothing (filled|sold)/;
  const submit = (id: string, status: string) => ({ "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: id, status } }) });
  const down = () => ({ status: 502, body: { error: { code: "BAD_GATEWAY", message: "upstream" } } });
  const cases: Array<[string, Record<string, () => { status: number; body: unknown }>, RegExp]> = [
    // every read of the order fails
    ["px-6", { ...submit("px-6", "PENDING"), "GET /v1/prophetx/orders/px-6": down, "GET /v1/prophetx/orders/px-6/fills": () => ({ status: 200, body: { fills: [] } }) }, /px-6 was sent and its end was not read \(every read of it failed; last seen PENDING\); it may have filled/],
    // still open after a cancel that failed
    ["px-7", { ...submit("px-7", "OPEN"), "GET /v1/prophetx/orders/px-7": () => ({ status: 200, body: { orderId: "px-7", status: "OPEN", filledQuantity: 0 } }), "DELETE /v1/prophetx/orders/px-7": down, "GET /v1/prophetx/orders/px-7/fills": () => ({ status: 200, body: { fills: [] } }) }, /px-7 was sent and its end was not read \(it did not reach a final state and the cancel was not confirmed; last seen OPEN\)/],
    // filled, and the fills cannot be read
    ["px-8", { ...submit("px-8", "SUBMITTED"), "GET /v1/prophetx/orders/px-8": () => ({ status: 200, body: { orderId: "px-8", status: "FILLED", filledQuantity: 8 } }), "GET /v1/prophetx/orders/px-8/fills": down }, /px-8 was sent and its end was not read \(the order shows a match and its fills could not be read; last seen FILLED\)/],
    // cancelled with a matched stake on it and no fill listed
    ["px-9", { ...submit("px-9", "SUBMITTED"), "GET /v1/prophetx/orders/px-9": () => ({ status: 200, body: { orderId: "px-9", status: "CANCELLED", filledQuantity: 3 } }), "GET /v1/prophetx/orders/px-9/fills": () => ({ status: 200, body: { fills: [] } }) }, /px-9 was sent and its end was not read \(the order shows a match and no fill was listed; last seen CANCELLED\)/],
  ];
  for (const [id, routes, words] of cases) {
    const err = await client(fakePartner({ ...TIME, ...LADDER_ROUTE, ...routes })).place(buyIntent(), `atticus-${id}`).then(() => null, (e: Error) => e);
    assert.ok(err, `${id} is an error`);
    assert.match(err.message, words);
    assert.doesNotMatch(err.message, miss, `${id} is not worded as a miss`);
  }
  // cancelled with nothing matched and the fills unreadable: the order's own count is the venue's word, a miss
  const killed = fakePartner({ ...TIME, ...LADDER_ROUTE, ...submit("px-10", "SUBMITTED"), "GET /v1/prophetx/orders/px-10": () => ({ status: 200, body: { orderId: "px-10", status: "CANCELLED", filledQuantity: 0 } }), "GET /v1/prophetx/orders/px-10/fills": down });
  await assert.rejects(client(killed).place(buyIntent(), "atticus-px-10"), /px-10 CANCELLED with nothing filled/);
});

test("prophetx reads: the pod's ProphetX cash floored to cents, positions by strike, the order and its fills", async () => {
  const partner = fakePartner({
    ...TIME,
    "GET /v1/prophetx/balance": () => ({ status: 200, body: { available: 123.456 } }),
    "GET /v1/prophetx/positions": (s) => ({ status: 200, body: { positions: s.query === "strikeId=strike-no-1" ? [{ strikeId: "strike-no-1", size: "20.000000", averagePrice: "0.400000", mark: "0.42", valueUsd: "8.40", unrealizedPnlUsd: "0.40" }] : [] } }),
    "GET /v1/prophetx/orders/px-1": () => ({ status: 200, body: { orderId: "px-1", status: "FILLED" } }),
    "GET /v1/prophetx/orders/px-1/fills": () => ({ status: 200, body: { fills: [{ fillId: "f1" }] } }),
  });
  const c = client(partner);
  assert.equal(await c.availableCents(), 12_345);
  assert.equal((await c.positions("strike-no-1"))[0].size, "20.000000");
  assert.deepEqual(await c.positions(), []);
  assert.equal((await c.order("px-1")).status, "FILLED");
  assert.equal((await c.fills("px-1")).length, 1);
  assert.equal(c.venue, "prophetx");
  assert.equal(c.keyId, KEY_ID);
});

test("live executor: a ProphetX hook under the rails — the allowlist is checked against the game's Kalshi ticker, the fill records via aggregator, and a sale's trail says offset", async () => {
  const partner = fakePartner({
    ...TIME,
    ...LADDER_ROUTE,
    "POST /v1/prophetx/orders": () => ({ status: 201, body: { orderId: "px-7", status: "FILLED", venueOrderId: "pxv-7" } }),
    "GET /v1/prophetx/orders/px-7": () => ({ status: 200, body: { orderId: "px-7", status: "FILLED", venueOrderId: "pxv-7" } }),
    "GET /v1/prophetx/orders/px-7/fills": () => ({ status: 200, body: { fills: [{ fillId: "f", orderId: "px-7", venueFillId: "v", shares: "20.000000", price: "0.400000", stakeUsd: "8.00", feeUsd: "0", occurredAt: "" }] } }),
  });
  const rails = { killSwitch: false, dryRun: false, allowlist: ["KXNBAGAME-26OCT14LALBOS-BOS"], maxUnitsPerOrderMilli: 50_000, maxUnitsPerDayMilli: 200_000 };
  const exec = new LiveHedgeExecutor({ prophetx: client(partner).hook() }, rails, () => 0);
  const sent = await exec.execute(buyIntent(), "ref");
  assert.equal(sent.outcome, "filled_live");
  assert.equal(sent.fill?.venue, "prophetx");
  assert.equal(sent.fill?.via, "aggregator");
  assert.equal(sent.fill?.ids.orderId, "px-7");
  assert.equal(sent.fill?.ids.venueOrderId, "pxv-7");
  assert.equal(sent.fill?.costCents, 824);
  assert.match(sent.attempts.map((a) => a.detail).join(" | "), /2% of the gain provided for at settlement/);
  // a strike id is not on the allowlist; the arm key (the game's Kalshi ticker) is what the rails read
  const unarmed = await exec.execute({ ...buyIntent(), armKey: "KXNBAGAME-OTHER" }, "ref");
  assert.equal(unarmed.fill?.simulated, true);
  assert.match(unarmed.fallbackReason ?? "", /KXNBAGAME-OTHER is not on the live allowlist/);
});
