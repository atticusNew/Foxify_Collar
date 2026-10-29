/**
 * The Novig hedge route: the price grid and the taker fee unfolded for the limit, the plan (a
 * fill-or-kill buy of the opposing outcome, contracts of one cent, a UUID client id), the fills
 * read into our units, the offset buy that unwinds a hedge (proceeds at the game), a kill that
 * filled nothing as an error, the venue's refusal codes carried, the live executor under the rails
 * with our own key, the route priced from the signed-dialect reference read and carried through the
 * counterfactuals and the early close. Driven by a fake fetch; nothing touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { quoteCrossWrap } from "../src/eventCollar/crossVenue/crossVenuePricer";
import { quoteEarlyClose } from "../src/eventCollar/crossVenue/earlyClose";
import { intentFromHedge, sellIntentForNovig, summarizeHedgeReceipts } from "../src/eventCollar/crossVenue/hedgeExecutor";
import { hedgeExecutorFromEnv } from "../src/eventCollar/crossVenue/hedgeExecutorFromEnv";
import { hedgeVenueOf, routeOfVenue, routeName } from "../src/eventCollar/crossVenue/hedgeRouting";
import { LiveHedgeExecutor, describeOrder } from "../src/eventCollar/crossVenue/liveHedge";
import {
  NovigOrderClient,
  feeChargedNow,
  gridPriceString,
  novigClientId,
  novigTradeConfigFromEnv,
  onNovigGrid,
  planNovigOrder,
  rawAskMilliOf,
  rawBidMilliOf,
  snapDownToGrid,
  sumNovigFills,
} from "../src/eventCollar/crossVenue/novigOrders";
import { ROUTE_LABELS, requote } from "../src/eventCollar/crossVenue/shadowCounterfactuals";
import { DEFAULT_CROSS_CONFIG, type MatchedPair, type NovigHedgeLeg, type PmBook } from "../src/eventCollar/crossVenue/types";
import { novigRouteOf, novigRouteOffered, signedBidsForOpposing, signedFeeMilli, signedHedgeBook, signedHostFromEnv, type ReferenceBook } from "../src/eventCollar/crossVenue/venueBooks";
import { VenueClient, canonicalString, signerFromPem } from "../src/eventCollar/crossVenue/venuePositions";

const trade = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { keyId: "5d1f8a2c-7b3e-4c9a-9e2d-1a4b6c8d0e2f", pem, publicKey };
})();
const HOST = "https://api.paper.example.test";
const MARKET = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OURS = "0b3f5f20-9c1b-4d6e-8f3a-5c2d1e7b4a90";
const OPP = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const TICKER = "KXNBAGAME-26OCT30NYKBOS-NYK";

interface Seen {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
}

function fakeVenue(routes: Record<string, (seen: Seen, n: number) => { status: number; body?: unknown }>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const s: Seen = { method: (init?.method ?? "GET").toUpperCase(), path: u.pathname, query: u.search.slice(1), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, rawBody, body: rawBody ? JSON.parse(rawBody) : undefined };
    seen.push(s);
    const key = `${s.method} ${s.path}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: "NOT_FOUND", message: `no route ${key}` }), { status: 404 });
    const r = route(s, n);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const client = (v: { fetchImpl: typeof fetch }) => new NovigOrderClient({ host: HOST, signer: signerFromPem(trade.keyId, trade.pem), fetchImpl: v.fetchImpl, settleWaitMs: 0, sleep: async () => {} });

/** The request's NOVIG-V3 signature verifies with the trading key over method, path, query and the exact body bytes. */
function assertSigned(s: Seen): void {
  assert.equal(s.headers["Novig-Key-Id"], trade.keyId);
  const ts = s.headers["Novig-Timestamp"];
  assert.match(ts, /^\d{13}$/);
  const canon = canonicalString({ timestampMs: ts, method: s.method, path: s.path, query: s.query, body: s.rawBody });
  assert.ok(cryptoVerify(null, Buffer.from(canon, "utf8"), trade.publicKey, Buffer.from(s.headers["Novig-Signature"], "base64")), `signature on ${s.method} ${s.path}`);
}

const GAME_MARKET = (status = "OPEN", charged = "WHEN_LIVE") => ({
  marketId: MARKET,
  eventId: "ev-1",
  description: "Knicks at Celtics",
  marketType: "MONEY",
  status,
  startsTs: 1_793_577_600_000,
  outcomes: [
    { outcomeId: OURS, name: "NYK", status: "TBD" },
    { outcomeId: OPP, name: "BOS", status: "TBD" },
  ],
  fee: { coefficient: "0.06", makerCredit: "0.25", charged },
});
const CATALOG = {
  [`GET /v3/catalog/markets/${MARKET}`]: () => ({ status: 200, body: GAME_MARKET() }),
  "GET /v3/catalog/events/ev-1": () => ({ status: 200, body: { eventId: "ev-1", description: "Knicks at Celtics", sport: "BASKETBALL", league: "NBA", status: "OPEN_PREGAME", startsTs: 1_793_577_600_000 } }),
};

/** 20 units (2,000 contracts) of the opposing outcome, walked to a worst of 0.400 with no fee pre-game. */
const NV_LEG: NovigHedgeLeg = {
  action: "buy",
  venue: "novig",
  outcome: "BOS",
  marketId: MARKET,
  outcomeId: OPP,
  offsetOutcomeId: OURS,
  sharesMilli: 20_000,
  avgPriceMilli: 395,
  worstPriceMilli: 400,
  costCents: 790,
};
const buyIntent = () => intentFromHedge(NV_LEG, 390, TICKER);

test("novig grid: three bands, symmetric about one half; snapping down never pays over the walk; the wire string has three places", () => {
  assert.ok(onNovigGrid(1) && onNovigGrid(50) && onNovigGrid(55) && onNovigGrid(500) && onNovigGrid(945) && onNovigGrid(950) && onNovigGrid(999));
  assert.ok(!onNovigGrid(51) && !onNovigGrid(52) && !onNovigGrid(503) && !onNovigGrid(947) && !onNovigGrid(0) && !onNovigGrid(1000));
  for (const p of [1, 37, 50, 55, 400, 945, 950, 999]) assert.ok(onNovigGrid(1000 - p), `1 - a grid price is on the grid (${p})`);
  assert.equal(snapDownToGrid(503), 500);
  assert.equal(snapDownToGrid(500), 500);
  assert.equal(snapDownToGrid(52), 50);
  assert.equal(snapDownToGrid(53), 50);
  assert.equal(snapDownToGrid(947), 945);
  assert.equal(snapDownToGrid(951), 951);
  assert.equal(snapDownToGrid(0), null);
  assert.equal(gridPriceString(400), "0.400");
  assert.equal(gridPriceString(55), "0.055");
  assert.equal(gridPriceString(999), "0.999");
});

test("novig fee: c x P x (1 - P) per unit, folded by the book reader when charged, unfolded exactly for the limit; a game market charges only in game", () => {
  assert.equal(signedFeeMilli(0.06, 500), 15, "1.5c on a dollar at even money");
  assert.equal(signedFeeMilli(0.06, 400), 15, "0.06 x 400 x 600 / 1000 = 14.4, rounded up against the credit");
  const fee = { coefficient: 0.06, charged: true };
  for (const p of [37, 55, 120, 400, 500, 735, 945, 960]) {
    const folded = p + signedFeeMilli(0.06, p);
    assert.equal(rawAskMilliOf(folded, fee), p, `the raw ask behind a folded ${folded} is ${p}`);
    const bidFolded = p - signedFeeMilli(0.06, p);
    assert.equal(rawBidMilliOf(bidFolded, fee), p, `the raw bid behind a folded ${bidFolded} is ${p}`);
  }
  assert.equal(rawAskMilliOf(400, { coefficient: 0.06, charged: false }), 400, "no fee, no unfold");
  assert.equal(feeChargedNow({ coefficient: "0.06", charged: "WHEN_LIVE" }, ["OPEN", "OPEN_PREGAME"]), false);
  assert.equal(feeChargedNow({ coefficient: "0.06", charged: "WHEN_LIVE" }, ["OPEN", "OPEN_INGAME"]), true);
  assert.equal(feeChargedNow({ coefficient: "0.06", charged: "ALWAYS" }, ["OPEN_PREGAME"]), true);
  assert.equal(feeChargedNow({ coefficient: "0.06", charged: "NEVER" }, ["OPEN_INGAME"]), false);
  assert.equal(feeChargedNow(undefined, ["OPEN_PREGAME"]), true, "an unknown rule is taken as charged");
});

test("novig plan: a FOK buy of the hedge outcome at the walked worst (fee removed, snapped down), qty in one-cent contracts, a UUID client id derived from the receipt id; an unwind buys the holder's outcome at 1 - the walked worst bid", () => {
  const plan = planNovigOrder(buyIntent(), { coefficient: 0.06, charged: false }, "atticus-receipt-1");
  assert.deepEqual(plan.body, { clientId: novigClientId("atticus-receipt-1"), outcomeId: OPP, price: "0.400", qty: 2000, tif: "FOK" });
  assert.equal(plan.limitMilli, 400);
  assert.match(plan.body.clientId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a version-5-shaped UUID");
  assert.equal(novigClientId("atticus-receipt-1"), plan.body.clientId, "the same receipt id always maps to the same client id");
  assert.notEqual(novigClientId("atticus-receipt-2"), plan.body.clientId);
  // the fee charged (in game): the folded 415 unfolds to 400 and sits on the grid
  const live = planNovigOrder({ ...buyIntent(), book: { ...buyIntent().book, worstPriceMilli: 415 } }, { coefficient: 0.06, charged: true }, "r");
  assert.equal(live.body.price, "0.400");
  // 15.95 units is 1,595 contracts; a fractional unit rounds up, never under
  assert.equal(planNovigOrder({ ...buyIntent(), unitsMilli: 15_950 }, { coefficient: 0.06, charged: false }, "r").body.qty, 1595);
  assert.equal(planNovigOrder({ ...buyIntent(), unitsMilli: 15_951 }, { coefficient: 0.06, charged: false }, "r").body.qty, 1596);
  // the offset: the hedge outcome's walked worst bid is 0.580 (no fee); the holder's outcome is bought at or under 0.420
  const sell = sellIntentForNovig({ marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, armKey: TICKER, unitsMilli: 20_000, bestPriceMilli: 600, avgPriceMilli: 590, worstPriceMilli: 580, grossCents: 1180 });
  const offset = planNovigOrder(sell, { coefficient: 0.06, charged: false }, "r");
  assert.deepEqual({ outcomeId: offset.body.outcomeId, price: offset.body.price, qty: offset.body.qty, tif: offset.body.tif }, { outcomeId: OURS, price: "0.420", qty: 2000, tif: "FOK" });
  assert.throws(() => planNovigOrder({ ...sell, offsetInstrument: undefined }, { coefficient: 0.06, charged: false }, "r"), /holder's own outcome/);
  assert.throws(() => planNovigOrder({ ...buyIntent(), venue: "prophetx" }, { coefficient: 0.06, charged: false }, "r"), /intent is for prophetx/);
  assert.match(describeOrder(buyIntent()), /novig buy 20 units \(2000 contracts\) of outcome .* at or under 40c, fill or kill/);
  assert.match(describeOrder(sell), /novig offset 20 units .* by buying outcome .* at or under 42c, fill or kill/);
});

test("novig fills: contracts summed, cost and fee in exact micro dollars, an absent fee is zero; a management-shaped answer is read too", () => {
  const sum = sumNovigFills([
    { fillId: "f1", orderId: "o", marketId: MARKET, outcomeId: OPP, qty: 1500, cost: "6.00000", taker: true, ts: 1 },
    { fillId: "f2", orderId: "o", marketId: MARKET, outcomeId: OPP, qty: 500, cost: "1.95000", fee: "0.00750", taker: true, ts: 2 },
  ]);
  assert.deepEqual(sum, { contracts: 2000, costMicro: 7_950_000, feeMicro: 7_500 });
});

test("novig place: a filled buy — the fee rule read from the catalog, the submit signed with the trading key, read back past a 404 to FILLED, the fills summed, direct (no via)", async () => {
  const v = fakeVenue({
    ...CATALOG,
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-1", clientId: novigClientId("atticus-r1") } }),
    "GET /v3/orders/ord-1": (_s, n) => (n === 1 ? { status: 404, body: { code: "ORDER_NOT_FOUND", message: "not yet" } } : { status: 200, body: { orderId: "ord-1", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [{ fillId: "f1", orderId: "ord-1", marketId: MARKET, outcomeId: OPP, qty: 2000, cost: "7.90000", taker: true, ts: 1 }], next: null } }),
  });
  const r = await client(v).place(buyIntent(), "atticus-r1");
  assert.equal(r.orderId, "ord-1");
  assert.equal(r.unitsMilli, 20_000);
  assert.equal(r.costCents, 790);
  assert.equal(r.feesCents, 0);
  assert.equal(r.avgPriceMilli, 395);
  assert.equal(r.status, "executed");
  assert.equal(r.via, undefined, "our own key on the venue: direct");
  assert.match(r.note ?? "", /2000 contracts at 0.395, no fee pre-game/);
  const post = v.seen.find((s) => s.method === "POST")!;
  assertSigned(post);
  assert.deepEqual(post.body, { clientId: novigClientId("atticus-r1"), outcomeId: OPP, price: "0.400", qty: 2000, tif: "FOK" });
  const fills = v.seen.find((s) => s.path === "/v3/portfolio/fills")!;
  assert.equal(fills.query, "order=ord-1");
  assertSigned(fills);
  assert.equal(v.seen.filter((s) => s.path === "/v3/orders/ord-1").length, 2, "the 404 straight after the 201 is read again");
});

test("novig place: in game the fee is charged; the folded limit unfolds to the venue's price and the fee on the fill is in the cost", async () => {
  const v = fakeVenue({
    [`GET /v3/catalog/markets/${MARKET}`]: () => ({ status: 200, body: GAME_MARKET("OPEN") }),
    "GET /v3/catalog/events/ev-1": () => ({ status: 200, body: { eventId: "ev-1", description: "", sport: "BASKETBALL", league: "NBA", status: "OPEN_INGAME", startsTs: 1 } }),
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-2" } }),
    "GET /v3/orders/ord-2": () => ({ status: 200, body: { orderId: "ord-2", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [{ fillId: "f1", orderId: "ord-2", marketId: MARKET, outcomeId: OPP, qty: 2000, cost: "8.00000", fee: "0.28800", taker: true, ts: 1 }] } }),
  });
  const intent = { ...buyIntent(), book: { ...buyIntent().book, worstPriceMilli: 415, costCents: 830 } };
  const r = await client(v).place(intent, "atticus-r2");
  const post = v.seen.find((s) => s.method === "POST")!;
  assert.equal((post.body as { price: string }).price, "0.400");
  assert.equal(r.costCents, 829, "$8.00 plus the $0.288 fee, cents up");
  assert.equal(r.feesCents, 29);
  assert.match(r.note ?? "", /fee \$0.2880/);
});

test("novig place: the offset that unwinds a hedge — a buy of the holder's outcome; proceeds are the cent per contract less the price paid, realised at the game", async () => {
  const v = fakeVenue({
    ...CATALOG,
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-3" } }),
    "GET /v3/orders/ord-3": () => ({ status: 200, body: { orderId: "ord-3", marketId: MARKET, outcomeId: OURS, price: "0.420", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [{ fillId: "f1", orderId: "ord-3", marketId: MARKET, outcomeId: OURS, qty: 2000, cost: "8.20000", taker: true, ts: 1 }] } }),
  });
  const sell = sellIntentForNovig({ marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, armKey: TICKER, unitsMilli: 20_000, bestPriceMilli: 600, avgPriceMilli: 590, worstPriceMilli: 580, grossCents: 1180 });
  const r = await client(v).place(sell, "atticus-r3");
  assert.equal((v.seen.find((s) => s.method === "POST")!.body as { outcomeId: string }).outcomeId, OURS);
  assert.equal(r.unitsMilli, 20_000);
  assert.equal(r.costCents, 2000 - 820, "20 units pay $20 at the game; $8.20 was paid for the offset");
  assert.equal(r.avgPriceMilli, 590);
  assert.match(r.note ?? "", /offset bought: 2000 contracts of outcome .* at 0.410; the pair settles at the game and the proceeds land then, not today/);
});

test("novig place: a kill that filled nothing is an error naming the order and the limit; a resting order is cancelled first; the venue's refusal code is carried", async () => {
  const killed = fakeVenue({
    ...CATALOG,
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-4" } }),
    "GET /v3/orders/ord-4": () => ({ status: 200, body: { orderId: "ord-4", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 2000, status: "REJECTED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [] } }),
  });
  await assert.rejects(client(killed).place(buyIntent(), "r"), /order ord-4 REJECTED with nothing filled at or under 0.400 \(fill or kill\)/);

  const resting = fakeVenue({
    ...CATALOG,
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-5" } }),
    "GET /v3/orders/ord-5": () => ({ status: 200, body: { orderId: "ord-5", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 2000, status: "OPEN", tif: "FOK", createdTs: 1 } }),
    "DELETE /v3/orders/ord-5": () => ({ status: 200, body: { orderId: "ord-5", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 2000, status: "CANCELED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [] } }),
  });
  await assert.rejects(client(resting).place(buyIntent(), "r"), /ord-5 CANCELED with nothing filled/);
  assert.ok(resting.seen.some((s) => s.method === "DELETE" && s.path === "/v3/orders/ord-5"), "a resting fill-or-kill is cancelled, never left");

  const refused = fakeVenue({ ...CATALOG, "POST /v3/orders": () => ({ status: 451, body: { code: "GEOLOCATION_REQUIRED", message: "No device geolocation in the last 3 days." } }) });
  await assert.rejects(client(refused).place(buyIntent(), "r"), /the venue refused the order \(451 GEOLOCATION_REQUIRED: No device geolocation in the last 3 days.\)/);

  const unread = fakeVenue({
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-6" } }),
    "GET /v3/orders/ord-6": () => ({ status: 200, body: { orderId: "ord-6", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [{ fillId: "f1", orderId: "ord-6", marketId: MARKET, outcomeId: OPP, qty: 2000, cost: "7.70000", taker: true, ts: 1 }] } }),
  });
  // the catalog unreadable: the fee is taken as charged, the limit errs low, the note says so
  const r = await client(unread).place(buyIntent(), "r");
  assert.equal((unread.seen.find((s) => s.method === "POST")!.body as { price: string }).price, "0.385", "400 folded unfolds to 385 under the standing rule");
  assert.match(r.note ?? "", /fee rule unread/);
  await assert.rejects(client(unread).place({ ...buyIntent(), marketId: undefined }, "r"), /names no market/);
});

test("novig reads: the subaccount's balance exact to the venue's figure; the env carries the trading key and host together or not at all", async () => {
  const v = fakeVenue({ [`GET /v3/account/subaccounts/${trade.keyId}/balance`]: () => ({ status: 200, body: { balance: "70.00000" } }) });
  const c = client(v);
  assert.equal(await c.availableCents(), 7000);
  assertSigned(v.seen[0]);
  assert.equal(c.keyId, trade.keyId);
  assert.equal(novigTradeConfigFromEnv({}), null);
  assert.equal(novigTradeConfigFromEnv({ NOVIG_TRADE_KEY_ID: "k", NOVIG_TRADE_PRIVATE_KEY_PEM: "p" }), null, "no host, no client");
  assert.deepEqual(novigTradeConfigFromEnv({ NOVIG_TRADE_KEY_ID: "k", NOVIG_TRADE_PRIVATE_KEY_PEM: "p", VENUE_API_HOST: "https://api.novig.com/" }), { host: "https://api.novig.com", keyId: "k", pem: "p" });
});

test("live executor: a Novig hook under the rails with our own key — the allowlist is checked against the game's Kalshi ticker, the fill records direct, a sale's trail says offset", async () => {
  const v = fakeVenue({
    ...CATALOG,
    "POST /v3/orders": () => ({ status: 201, body: { orderId: "ord-7" } }),
    "GET /v3/orders/ord-7": () => ({ status: 200, body: { orderId: "ord-7", marketId: MARKET, outcomeId: OPP, price: "0.400", qty: 2000, remaining: 0, status: "FILLED", tif: "FOK", createdTs: 1 } }),
    "GET /v3/portfolio/fills": () => ({ status: 200, body: { items: [{ fillId: "f1", orderId: "ord-7", marketId: MARKET, outcomeId: OPP, qty: 2000, cost: "7.90000", taker: true, ts: 1 }] } }),
  });
  const rails = { killSwitch: false, dryRun: false, allowlist: [TICKER], anyTicker: false, maxUnitsPerOrderMilli: 50_000, maxUnitsPerDayMilli: 200_000 };
  const exec = new LiveHedgeExecutor({ novig: client(v).hook() }, rails, () => 0);
  const sent = await exec.execute(buyIntent(), "ref");
  assert.equal(sent.outcome, "filled_live");
  assert.equal(sent.fill?.venue, "novig");
  assert.equal(sent.fill?.via, "direct");
  assert.equal(sent.fill?.ids.orderId, "ord-7");
  assert.equal(sent.fill?.costCents, 790);
  assert.equal(sent.fill?.vsBookCents, 0);
  assert.equal(summarizeHedgeReceipts([sent]).byVenue.novig, 1);
  const unarmed = await exec.execute({ ...buyIntent(), armKey: "KXNBAGAME-OTHER" }, "ref");
  assert.equal(unarmed.fill?.simulated, true);
  assert.match(unarmed.fallbackReason ?? "", /KXNBAGAME-OTHER is not on the live allowlist/);
  const dry = new LiveHedgeExecutor({ novig: client(v).hook() }, { ...rails, dryRun: true }, () => 0);
  const held = await dry.execute(buyIntent(), "ref");
  assert.equal(held.fallbackReason, "dry run");
  assert.match(held.attempts.map((a) => a.detail).join(" | "), /dry run: novig buy 20 units \(2000 contracts\)/);
});

test("hedgeExecutorFromEnv: the Novig trading key in live mode gives the venue a live client in either via mode; without it the note says so and the route prices on paper", () => {
  const env = { EVENT_HEDGE_STRATEGY: "live", NOVIG_TRADE_KEY_ID: trade.keyId, NOVIG_TRADE_PRIVATE_KEY_PEM: trade.pem, VENUE_API_HOST: HOST };
  const direct = hedgeExecutorFromEnv(env);
  assert.deepEqual(direct.live?.venues, ["novig"]);
  assert.equal(direct.novigOrders?.keyId, trade.keyId);
  assert.ok(direct.notes.some((n) => /novig: live orders go to the venue with the service's own trading key/.test(n)));
  const viaAgg = hedgeExecutorFromEnv({ ...env, EVENT_HEDGE_LIVE_VIA: "aggregator" });
  assert.ok(viaAgg.live?.venues.includes("novig"), "the aggregator path does not stand between the service and Novig");
  const none = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live" });
  assert.equal(none.novigOrders, null);
  assert.ok(none.notes.some((n) => /novig: no NOVIG_TRADE_KEY_ID/.test(n)));
  const partial = hedgeExecutorFromEnv({ EVENT_HEDGE_STRATEGY: "live", NOVIG_TRADE_KEY_ID: "k" });
  assert.ok(partial.notes.some((n) => /must all be set/.test(n)));
  assert.ok(!JSON.stringify(direct.live).includes(trade.pem.slice(30, 60)), "the view carries no key");
  const bad = hedgeExecutorFromEnv({ ...env, NOVIG_TRADE_PRIVATE_KEY_PEM: "not a pem" });
  assert.deepEqual(bad.live?.venues, []);
  assert.ok(bad.notes.some((n) => /NOVIG_TRADE_PRIVATE_KEY_PEM unusable/.test(n)));
});

// ---------------------------------------------------------------------------
// the route: priced from the reference read, carried through the record
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-30T12:00:00Z");
const pair = (): MatchedPair =>
  ({
    kalshi: { ticker: TICKER, title: "Knicks at Celtics", subtitle: "Knicks", status: "active", closeTime: "2026-10-30T23:30:00Z", rulesPrimary: "", rulesSecondary: "" },
    pm: { eventSlug: "nba-nyk-bos", eventTitle: "Knicks vs Celtics", description: "", outcomes: ["Knicks", "Celtics"], tokenIds: ["t-yes", "t-no"], active: true, acceptingOrders: true, closed: false },
    pmYesOutcomeIndex: 0,
    pmNoOutcomeIndex: 1,
    league: "nba",
    gameStartTime: "2026-10-30T23:30:00Z",
    parityNote: "verified",
    fingerprint: "fp",
  }) as unknown as MatchedPair;

/** The signed-dialect reference as the reader hands it over: asks for the opposing outcome, bids a hedge there could leave against, the ids. */
const nvReference = (): ReferenceBook => ({
  id: "signed_v3",
  book: {
    tokenId: `signed_v3:${MARKET}`,
    asks: [
      { priceMilli: 390, sizeMilli: 30_000 },
      { priceMilli: 400, sizeMilli: 50_000 },
    ],
    bids: [{ priceMilli: 580, sizeMilli: 40_000 }],
    minOrderSizeShares: 1,
    tickMilli: 1,
  },
  listing: { marketId: MARKET, key: "ev-1", outcomes: { ours: { outcomeId: OURS, name: "NYK" }, opposing: { outcomeId: OPP, name: "BOS" }, fee: { coefficient: 0.06, folded: false }, marketStatus: "OPEN" } },
});

test("novig route: the pricer walks the reference's asks into a Novig leg carrying the market and both outcomes; an empty or thin book refuses in the venue's words", () => {
  const nv = novigRouteOf([nvReference()]);
  assert.ok(nv);
  assert.deepEqual(nv.hedgeOn, { venue: "novig", marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, outcome: "BOS" });
  const q = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 58, contracts: 20, now: NOW, noBook: nv.noBook, config: DEFAULT_CROSS_CONFIG, hedgeOn: nv.hedgeOn });
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(q.hedge.venue, "novig");
  const leg = q.hedge as NovigHedgeLeg;
  assert.deepEqual({ marketId: leg.marketId, outcomeId: leg.outcomeId, offsetOutcomeId: leg.offsetOutcomeId, outcome: leg.outcome }, { marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, outcome: "BOS" });
  const intent = intentFromHedge(leg, 390, TICKER);
  assert.deepEqual({ venue: intent.venue, instrument: intent.instrument, offsetInstrument: intent.offsetInstrument, marketId: intent.marketId, armKey: intent.armKey }, { venue: "novig", instrument: OPP, offsetInstrument: OURS, marketId: MARKET, armKey: TICKER });

  const empty = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 58, contracts: 20, now: NOW, noBook: { ...nv.noBook, asks: [] }, config: DEFAULT_CROSS_CONFIG, hedgeOn: nv.hedgeOn });
  assert.ok(!empty.ok && empty.code === "novig_book_empty" && /on Novig/.test(empty.detail), JSON.stringify(empty));
  const thin = quoteCrossWrap({ pair: pair(), markCents: 60, entryCents: 58, contracts: 2000, now: NOW, noBook: nv.noBook, config: DEFAULT_CROSS_CONFIG, hedgeOn: nv.hedgeOn });
  assert.ok(!thin.ok && thin.code === "novig_book_too_thin", JSON.stringify(thin));

  assert.equal(novigRouteOf([{ id: "signed_v3", book: null, reason: "not_listed" }]), null);
  assert.equal(novigRouteOf([{ ...nvReference(), listing: { marketId: MARKET } }]), null, "a read from before the ids were kept prices no route");
  assert.equal(novigRouteOf(undefined), null);
});

test("novig route: the routing maps the route to the venue both ways, names it, and the counterfactual re-reads price it from the references kept on the record", () => {
  assert.equal(hedgeVenueOf("novig"), "novig");
  assert.equal(routeOfVenue("novig"), "novig");
  assert.equal(routeName("novig"), "Novig");
  assert.ok(ROUTE_LABELS.includes("novig"));
  const inputs = { route: "novig" as const, ticker: TICKER, lockTimeIso: "2026-10-30T23:30:00Z", pair: pair(), markCents: 60, entryCents: 58, contracts: 20, now: NOW, config: DEFAULT_CROSS_CONFIG, books: { references: [nvReference()] } };
  const q = requote(inputs, DEFAULT_CROSS_CONFIG, 20);
  assert.ok(q && q.ok && q.hedge.venue === "novig");
  assert.equal(requote({ ...inputs, books: {} }, DEFAULT_CROSS_CONFIG, 20), null, "no reference kept, no re-read");
  assert.equal(novigRouteOffered({}), true, "unset offers every route");
  assert.equal(novigRouteOffered({ EVENT_HEDGE_VENUES: "kalshi,prophetx" }), false);
  assert.equal(novigRouteOffered({ EVENT_HEDGE_VENUES: "kalshi, Novig" }), true);
  assert.equal(signedHostFromEnv({ VENUE_API_HOST: "https://api.novig.com/" }), "https://api.novig.com");
  assert.equal(signedHostFromEnv({ REFERENCE_BOOK_SIGNED_HOST: "https://ref.test", VENUE_API_HOST: "https://api.novig.com" }), "https://ref.test");
  assert.equal(signedHostFromEnv({}), null);
});

test("novig route: an early close walks the hedge outcome's bids and hands over the offset buy that settles at the game; without the ids on the record the leg is unlocatable", () => {
  const terms = { contracts: 20, floorCents: 50, capCents: 68, creditCents: 90, takeCents: 20, hedgeUnitsMilli: 20_000, route: "novig" as const, novig: { marketId: MARKET, hedgeOutcomeId: OPP, offsetOutcomeId: OURS } };
  const kalshi = { yesBids: [{ priceCents: 59, contracts: 100 }], noBids: [{ priceCents: 40, contracts: 100 }] };
  const q = quoteEarlyClose(terms, { kalshi, nvNoBook: nvReference().book! });
  assert.ok(q.ok, JSON.stringify(q));
  assert.equal(q.hedgeProceedsCents, 1160, "20 units into the 0.580 bid");
  assert.deepEqual(q.hedgeSale, { venue: "novig", marketId: MARKET, outcomeId: OPP, offsetOutcomeId: OURS, bestPriceMilli: 580, avgPriceMilli: 580, worstPriceMilli: 580, grossCents: 1160, settlesAtGame: true });
  const sell = sellIntentForNovig({ ...(q.hedgeSale as Extract<typeof q.hedgeSale, { venue: "novig" }>), armKey: TICKER, unitsMilli: 20_000 });
  assert.equal(planNovigOrder(sell, { coefficient: 0.06, charged: false }, "r").body.price, "0.420");
  const noIds = quoteEarlyClose({ ...terms, novig: undefined }, { kalshi, nvNoBook: nvReference().book! });
  assert.ok(!noIds.ok && noIds.code === "hedge_unlocatable" && /not on record/.test(noIds.detail));
  const noBook = quoteEarlyClose(terms, { kalshi });
  assert.ok(!noBook.ok && /could not be read on the venue/.test(noBook.detail));
  const empty = quoteEarlyClose(terms, { kalshi, nvNoBook: { ...nvReference().book!, bids: [] } });
  assert.ok(!empty.ok && empty.code === "book_empty");
});

test("novig route: the close's book is read by the ids on the record — the opposing outcome's bids with the fee off when it applies", async () => {
  const v = fakeVenue({
    [`GET /v3/public/catalog/markets/${MARKET}`]: () => ({ status: 200, body: GAME_MARKET("OPEN", "ALWAYS") }),
    [`GET /v3/public/catalog/markets/${MARKET}/book`]: () => ({ status: 200, body: { marketId: MARKET, orders: { [OURS]: [{ price: "0.600", qty: 1000 }], [OPP]: [{ price: "0.380", qty: 2500 }] } } }),
  });
  const book = await signedHedgeBook(new VenueClient({ host: HOST, fetchImpl: v.fetchImpl }), MARKET, OURS, OPP);
  assert.deepEqual(book.asks, [{ priceMilli: 400 + signedFeeMilli(0.06, 400), sizeMilli: 10_000 }], "a bid on ours at 0.600 is an ask on the opposing at 0.400, the fee on");
  assert.deepEqual(book.bids, [{ priceMilli: 380 - signedFeeMilli(0.06, 380), sizeMilli: 25_000 }], "a bid on the opposing at 0.380 is what the hedge leaves against, the fee off");
  assert.deepEqual(signedBidsForOpposing({ marketId: MARKET, orders: { [OPP]: [{ price: "0.380", qty: 10 }, { price: "0.390", qty: 20 }] } }, OPP, { coefficient: "0.06", charged: "WHEN_LIVE" }), [
    { priceMilli: 390, sizeMilli: 200 },
    { priceMilli: 380, sizeMilli: 100 },
  ], "best first, no fee pre-game");
  assert.ok(v.seen.every((s) => !s.headers["Novig-Key-Id"]), "the public catalog, unsigned");
});
