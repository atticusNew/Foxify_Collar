/**
 * One book read: a single attempt that returns when it was fetched, how long the venue's cache
 * had held it and the venue's own stamp, or a typed failure. No network: the fetch is injected.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BookReadError, fetchJsonOnce } from "../src/btcCurve/bookRead";
import { readTopOnce, topOfBookFromOrderbook } from "../src/btcCurve/kalshiLadders";
import { bookFromPolyUs, laddersFromEvents, polyOpenedAt, readBookOnce } from "../src/btcCurve/polyUsLadders";

function fetchOf(answer: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return answer(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

test("one attempt: the answer comes back with our fetch time and the cache age; a 404, a 500, a timeout and a dead line are each said once, with the URL kept for the operator", async () => {
  const ok = fetchOf(() => json({ a: 1 }, { headers: { age: "18" } }));
  const got = await fetchJsonOnce("https://venue.example/book", ok.fetchImpl, { clock: () => 1_000 });
  assert.deepEqual(got, { data: { a: 1 }, fetchedAtMs: 1_000, cacheAgeSec: 18 });
  assert.equal((await fetchJsonOnce("https://venue.example/book", fetchOf(() => json({})).fetchImpl)).cacheAgeSec, null, "no Age header is not an age of zero");

  const notFound = fetchOf(() => json({ error: "not found" }, { status: 404, headers: { age: "225" } }));
  await assert.rejects(fetchJsonOnce("https://venue.example/book", notFound.fetchImpl), (err: unknown) => {
    assert.ok(err instanceof BookReadError);
    assert.equal(err.kind, "http");
    assert.equal(err.status, 404);
    assert.equal(err.cacheAgeSec, 225, "a cached refusal says how long it has been held");
    assert.equal(err.url, "https://venue.example/book");
    assert.equal(err.message, "HTTP 404", "the message carries no URL");
    return true;
  });
  assert.equal(notFound.calls.length, 1, "no retry: the next cycle is the retry");

  await assert.rejects(fetchJsonOnce("https://venue.example/book", fetchOf(() => json({}, { status: 500 })).fetchImpl), (err: unknown) => err instanceof BookReadError && err.kind === "http" && err.status === 500);

  const hung = fetchOf(() => new Promise<Response>(() => {}));
  await assert.rejects(fetchJsonOnce("https://venue.example/book", hung.fetchImpl, { timeoutMs: 20 }), (err: unknown) => err instanceof BookReadError && err.kind === "timeout" && err.message === "timed out");
  assert.equal(hung.calls.length, 1);

  const dead = (async () => {
    throw new Error("getaddrinfo ENOTFOUND venue.example");
  }) as unknown as typeof fetch;
  await assert.rejects(fetchJsonOnce("https://venue.example/book", dead), (err: unknown) => err instanceof BookReadError && err.kind === "unreachable" && err.status === null);

  const html = fetchOf(() => new Response("<html>", { status: 200 }));
  await assert.rejects(fetchJsonOnce("https://venue.example/book", html.fetchImpl), (err: unknown) => err instanceof BookReadError && err.kind === "unreachable" && err.message === "answer was not JSON");
});

test("Polymarket US book: best level each side, the venue's stamp (the last change) and the state; the read adds our time and the cache age", async () => {
  const body = {
    marketData: {
      marketSlug: "cpc-btc-updown-15m-2026-11-10-2115z",
      bids: [
        { px: { value: "0.5700", currency: "USD" }, qty: "40.0000" },
        { px: { value: "0.5800", currency: "USD" }, qty: "904.8900" },
      ],
      offers: [
        { px: { value: "0.6000", currency: "USD" }, qty: "12.0000" },
        { px: { value: "0.5900", currency: "USD" }, qty: "85.0000" },
      ],
      state: "MARKET_STATE_OPEN",
      stats: { sharesTraded: "57993.2900", openInterest: "28080.3700" },
      transactTime: "2026-11-10T21:19:37.132709527Z",
    },
  };
  const b = bookFromPolyUs(body);
  assert.deepEqual([b.bidCents, b.bidQty, b.askCents, b.askQty], [58, 904.89, 59, 85]);
  assert.equal(b.venueAtMs, Date.parse("2026-11-10T21:19:37.132Z"), "nanoseconds read down to the millisecond");
  assert.equal(b.state, "MARKET_STATE_OPEN");
  assert.equal(b.openInterest, 28080.37);

  const empty = bookFromPolyUs({ marketData: { bids: [], offers: [] } });
  assert.deepEqual([empty.bidCents, empty.askCents, empty.bidQty, empty.askQty, empty.venueAtMs, empty.state], [0, 0, 0, 0, null, null]);
  assert.equal(bookFromPolyUs({}).venueAtMs, null);
  assert.equal(bookFromPolyUs({ marketData: { transactTime: "not a time" } }).venueAtMs, null);

  const f = fetchOf(() => json(body, { headers: { age: "6", "cache-control": "public, max-age=30" } }));
  const read = await readBookOnce("cpc-btc-updown-15m-2026-11-10-2115z", f.fetchImpl, { clock: () => Date.parse("2026-11-10T21:19:44.200Z") });
  assert.equal(f.calls[0], "https://gateway.polymarket.us/v1/markets/cpc-btc-updown-15m-2026-11-10-2115z/book");
  assert.equal(read.fetchedAtMs, Date.parse("2026-11-10T21:19:44.200Z"));
  assert.equal(read.cacheAgeSec, 6);
  assert.equal(read.venueAtMs, Date.parse("2026-11-10T21:19:37.132Z"));
  assert.equal(read.bidCents, 58);

  await assert.rejects(readBookOnce("cpc-btc-updown-15m-2026-11-10-2130z", fetchOf(() => json({}, { status: 404 })).fetchImpl), (err: unknown) => err instanceof BookReadError && err.status === 404 && err.url.endsWith("/v1/markets/cpc-btc-updown-15m-2026-11-10-2130z/book"));
});

test("Polymarket US listing: a contract opened at its window start (15-minute) or when it was listed (strike ladders), and the quote carries it", () => {
  const terms = { marketType: "ASSET_PRICE_MARKET_TYPE_UP_DOWN", asset: { symbol: "btc" }, windowStart: "2026-11-10T21:15:00Z", windowEnd: "2026-11-10T21:30:00Z", priceToBeat: { value: "73701.52" } };
  const fifteen = { slug: "cpc-btc-updown-15m-2026-11-10-2115z", startDate: "2026-11-10T09:00:15Z", gameStartTime: "2026-11-10T21:15:00Z", assetPriceTerms: terms };
  assert.equal(polyOpenedAt(fifteen), "2026-11-10T21:15:00.000Z", "created hours ahead, open with its window");
  const daily = { slug: "cpc-btc-above-day-2026-11-10-73750", startDate: "2026-11-09T21:03:36Z", gameStartTime: "2026-11-09T21:00:07Z", assetPriceTerms: { marketType: "ASSET_PRICE_MARKET_TYPE_ABOVE_BELOW", asset: { symbol: "btc" }, windowStart: null, windowEnd: "2026-11-10T22:00:00Z", strike: { value: "73750" } } };
  assert.equal(polyOpenedAt(daily), "2026-11-09T21:03:36.000Z", "no window start: open when listed");
  assert.equal(polyOpenedAt({ slug: "x" }), undefined);
  const [l] = laddersFromEvents([{ slug: "btc-updown-15m-2026-11-10-2115z", markets: [fifteen] }], { upDown: true });
  assert.equal(l.quotes[0].openedAt, "2026-11-10T21:15:00.000Z");
});

test("Kalshi orderbook: the top of book is the highest Yes bid and 100 minus the highest No bid, with their sizes; an empty side reads as the listing does; no venue stamp", async () => {
  const body = { orderbook_fp: { yes_dollars: [["0.5700", "40.00"], ["0.5900", "11633.17"], ["0.5800", "324.86"]], no_dollars: [["0.3800", "900.00"], ["0.4000", "4114.29"]] } };
  assert.deepEqual(topOfBookFromOrderbook(body), { bidCents: 59, askCents: 60, bidQty: 11633.17, askQty: 4114.29 });
  assert.deepEqual(topOfBookFromOrderbook({ orderbook_fp: { yes_dollars: [["0.9990", "644283.03"]], no_dollars: [] } }), { bidCents: 99.9, askCents: 100, bidQty: 644283.03, askQty: 0 }, "no offers: the ask is 100, as the market list prints 1.0000");
  assert.deepEqual(topOfBookFromOrderbook({ orderbook_fp: { yes_dollars: null, no_dollars: [["0.0140", "378.77"]] } }), { bidCents: 0, askCents: 98.6, bidQty: 0, askQty: 378.77 });
  assert.deepEqual(topOfBookFromOrderbook({ orderbook: { yes: [[41, 10], [42, 25]], no: [[55, 7]] } }), { bidCents: 42, askCents: 45, bidQty: 25, askQty: 7 }, "the older integer-cent shape");
  assert.deepEqual(topOfBookFromOrderbook({}), { bidCents: 0, askCents: 100, bidQty: 0, askQty: 0 });

  const f = fetchOf(() => json(body));
  const read = await readTopOnce("KXBTC15M-26NOV101630-30", f.fetchImpl, { clock: () => 5_000 });
  assert.equal(f.calls[0], "https://api.elections.kalshi.com/trade-api/v2/markets/KXBTC15M-26NOV101630-30/orderbook");
  assert.deepEqual([read.bidCents, read.askCents, read.fetchedAtMs, read.cacheAgeSec, read.venueAtMs, read.state], [59, 60, 5_000, null, null, null]);
  await assert.rejects(readTopOnce("KXBTC15M-26NOV101630-30", fetchOf(() => json({}, { status: 503 })).fetchImpl), (err: unknown) => err instanceof BookReadError && err.status === 503);
});
