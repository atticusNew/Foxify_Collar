/**
 * Whole cycles of the pairs collector against a fake of both venues' public endpoints (the
 * readers take an injectable fetch and the collector an injectable clock). No network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairsCollector, launchPayload, type PairsCollectorOptions } from "../src/btcCurve/pairsCollector";

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const POLY = "https://gateway.polymarket.us";
const T0 = Date.parse("2026-11-10T21:16:00Z");
const SPOT = 73_700;
const STRIKES = [73000, 73250, 73500, 73750, 74000, 74250, 74500];
const FIFTEEN_K = "KXBTC15M-26NOV101630-30";
const FIFTEEN_P = "cpc-btc-updown-15m-2026-11-10-2115z";
const kTicker = (strike: number) => `KXBTCD-26NOV1017-T${(strike - 0.01).toFixed(2)}`;
const pSlug = (strike: number) => `cpc-btc-above-day-2026-11-10-${strike}`;
const kBookUrl = (ticker: string) => `${KALSHI}/markets/${ticker}/orderbook`;
const pBookUrl = (slug: string) => `${POLY}/v1/markets/${slug}/book`;

type Answer = { status?: number; body?: unknown; headers?: Record<string, string>; hang?: boolean };

/** Yes price in whole cents for a strike: 50 at spot, 12 cents per $250. */
const fair = (strike: number) => Math.max(3, Math.min(97, Math.round(50 - ((strike - SPOT) / 250) * 12)));

interface Fake {
  fetchImpl: typeof fetch;
  calls: string[];
  /** override one URL's answer; cleared with undefined */
  set(url: string, a: Answer | undefined): void;
  now: number;
}

/**
 * Both venues at 21:16 UTC on 10 November 2026: the 21:15 to 21:30 window, the contract closing
 * at 22:00 (Kalshi KXBTCD and the Polymarket US daily share that close), index prints for the
 * hour. Kalshi quotes fair/fair+1, Polymarket US fair-1/fair+1, 100 contracts a side.
 */
function fake(): Fake {
  const overrides = new Map<string, Answer>();
  const calls: string[] = [];
  const state = { now: T0 };
  const money = (cents: number) => ({ value: (cents / 100).toFixed(4), currency: "USD" });
  const kMarket = (ticker: string, event: string, strikeType: string, floor: number, close: string, open: string, bid: number, ask: number) => ({
    ticker,
    event_ticker: event,
    status: "active",
    open_time: open,
    close_time: close,
    strike_type: strikeType,
    floor_strike: floor,
    yes_bid_dollars: (bid / 100).toFixed(4),
    yes_ask_dollars: (ask / 100).toFixed(4),
  });
  const answer = (url: string): Answer => {
    const o = overrides.get(url);
    if (o) return o;
    const u = new URL(url);
    if (url.startsWith(`${KALSHI}/series/`)) return { body: { series: { ticker: u.pathname.split("/").pop(), fee_type: "quadratic", fee_multiplier: 1 } } };
    if (url.startsWith(`${KALSHI}/markets?`)) {
      const series = u.searchParams.get("series_ticker");
      if (series === "KXBTC15M") return { body: { cursor: "", markets: [kMarket(FIFTEEN_K, "KXBTC15M-26NOV101630", "greater_or_equal", 73701.52, "2026-11-10T21:30:00Z", "2026-11-10T21:15:00Z", 40, 41)] } };
      // the cached list trails the book: it prints two cents under what the orderbook shows
      return { body: { cursor: "", markets: STRIKES.map((s) => kMarket(kTicker(s), "KXBTCD-26NOV1017", "greater", s - 0.01, "2026-11-10T22:00:00Z", "2026-11-09T21:00:00Z", fair(s) - 2, fair(s) - 1)) }, headers: { age: "12" } };
    }
    if (url.startsWith(`${KALSHI}/markets/`) && url.endsWith("/orderbook")) {
      const ticker = decodeURIComponent(u.pathname.split("/")[4]);
      const yes = ticker === FIFTEEN_K ? 50 : fair(Number(ticker.split("-T")[1]) + 0.01);
      return { body: { orderbook_fp: { yes_dollars: [[((yes - 1) / 100).toFixed(4), "40.00"], [(yes / 100).toFixed(4), "100.00"]], no_dollars: [[((100 - yes - 1) / 100).toFixed(4), "100.00"]] } } };
    }
    if (url.startsWith(`${POLY}/v1/series?`)) return { body: { series: [{ id: "375", slug: "btc-updown-15m" }, { id: "377", slug: "btc-strike-hourly" }, { id: "379", slug: "btc-strike-daily" }] } };
    if (url.startsWith(`${POLY}/v1/events?`)) {
      const id = u.searchParams.get("seriesId");
      if (id === "375") {
        return {
          body: {
            events: [
              {
                slug: "btc-updown-15m-2026-11-10-2115z",
                title: "BTC Up or Down 15m",
                markets: [
                  {
                    slug: FIFTEEN_P,
                    active: true,
                    closed: false,
                    endDate: "2026-11-10T22:00:00Z",
                    startDate: "2026-11-10T09:00:15Z",
                    gameStartTime: "2026-11-10T21:15:00Z",
                    feeCoefficient: 0.095,
                    bestBidQuote: money(47),
                    bestAskQuote: money(48),
                    assetPriceTerms: { marketType: "ASSET_PRICE_MARKET_TYPE_UP_DOWN", asset: { symbol: "btc" }, horizon: "15m", windowStart: "2026-11-10T21:15:00Z", windowEnd: "2026-11-10T21:30:00Z", priceToBeat: { value: "73701.52", currency: "USD" }, strike: null },
                  },
                ],
              },
            ],
          },
        };
      }
      if (id === "379") {
        return {
          body: {
            events: [
              {
                slug: "btc-above-day-2026-11-10",
                title: "BTC above, 5 PM ET",
                markets: STRIKES.map((s) => ({
                  slug: pSlug(s),
                  active: true,
                  closed: false,
                  endDate: "2026-11-10T22:30:00Z",
                  startDate: "2026-11-09T21:03:36Z",
                  gameStartTime: "2026-11-09T21:00:07Z",
                  feeCoefficient: 0.095,
                  bestBidQuote: money(fair(s) - 3),
                  bestAskQuote: money(fair(s) + 3),
                  assetPriceTerms: { marketType: "ASSET_PRICE_MARKET_TYPE_ABOVE_BELOW", asset: { symbol: "btc" }, horizon: "daily", windowStart: null, windowEnd: "2026-11-10T22:00:00Z", strike: { value: String(s), currency: "USD" } },
                })),
              },
            ],
          },
        };
      }
      return { body: { events: [] } };
    }
    if (url.startsWith(`${POLY}/v1/markets/`) && url.endsWith("/book")) {
      const slug = decodeURIComponent(u.pathname.split("/")[3]);
      const yes = slug === FIFTEEN_P ? 50 : fair(Number(slug.split("-").pop()));
      return {
        body: { marketData: { marketSlug: slug, bids: [{ px: money(yes - 1), qty: "100.0000" }], offers: [{ px: money(yes + 1), qty: "100.0000" }], state: "MARKET_STATE_OPEN", transactTime: new Date(state.now - 5_400).toISOString() } },
        headers: { age: "4", "cache-control": "public, max-age=30" },
      };
    }
    if (url.startsWith(`${POLY}/v1/asset-prices/history`)) {
      const to = Number(u.searchParams.get("to"));
      const from = Math.max(Number(u.searchParams.get("from")), to - 3700);
      const candles = [];
      for (let t = Math.ceil(from / 10) * 10; t <= to; t += 10) {
        const v = SPOT + 40 * Math.sin(t / 300);
        candles.push({ timestamp: t, open: String(v), high: String(v), low: String(v), close: t >= to - 10 ? String(SPOT) : String(v) });
      }
      return { body: { series: [{ candles }] } };
    }
    return { status: 404, body: { error: `no fake for ${url}` } };
  };
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const a = answer(url);
    if (a.hang) return new Promise<Response>(() => {});
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json", ...(a.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    set(url, a) {
      if (a) overrides.set(url, a);
      else overrides.delete(url);
    },
    get now() {
      return state.now;
    },
    set now(v: number) {
      state.now = v;
    },
  };
}

function collectorOn(f: Fake, opts: PairsCollectorOptions = {}): { c: PairsCollector; logs: string[] } {
  const logs: string[] = [];
  const c = new PairsCollector({ dataDir: mkdtempSync(join(tmpdir(), "btc-pairs-cycle-")), fetchImpl: f.fetchImpl, clock: () => f.now, log: (line) => logs.push(line), ...opts });
  return { c, logs };
}

function page(c: PairsCollector): string {
  let body = "";
  const res = { writeHead: () => res, end: (s?: string) => void (body += s ?? ""), write: () => true };
  c.handle({} as never, res as never, "/", new URL("http://x/pairs"), { base: "/pairs" });
  return body;
}

test("a cycle prices each row off the two order books: Kalshi's top comes from its orderbook, not the cached list; an empty side in a book is an empty side", async () => {
  const f = fake();
  const { c, logs } = collectorOn(f);
  const d = await c.collectOnce();
  assert.deepEqual(d.errors, []);
  assert.ok(Object.values(d.health).every((h) => h.ok), JSON.stringify(d.health));
  assert.equal(d.spotUsd, SPOT);
  assert.ok(d.fifteen && d.hourly);
  assert.equal(d.daily, null, "nothing closes beyond 90 minutes in the fake");
  assert.deepEqual(d.hourly.pairs.map((p) => p.strike), [73500, 73750, 74000]);

  const atm = d.hourly.pairs[1];
  // the list printed 46 / 47 for this strike; the orderbook says 48 bid, 49 offered (100 minus the 51 No bid)
  assert.deepEqual([atm.kalshi?.bidCents, atm.kalshi?.askCents, atm.kalshi?.bidQty, atm.kalshi?.askQty], [48, 49, 100, 100]);
  assert.deepEqual([atm.poly?.bidCents, atm.poly?.askCents, atm.poly?.bidQty, atm.poly?.askQty], [47, 49, 100, 100], "the book, not the listing's 45 / 51");
  assert.deepEqual(atm.errors, []);
  assert.ok(atm.score !== null && atm.lock);

  // Polymarket US's book has no offers left while its listing still shows one: the row has no Poly ask and no lock that buys Yes there
  f.set(pBookUrl(pSlug(73750)), { body: { marketData: { bids: [{ px: { value: "0.4700" }, qty: "100" }], offers: [], state: "MARKET_STATE_OPEN" } } });
  const d2 = await c.collectOnce();
  const atm2 = d2.hourly?.pairs[1];
  assert.ok(atm2?.poly);
  assert.deepEqual([atm2.poly.bidCents, atm2.poly.askCents, atm2.poly.askQty], [47, 0, 0]);
  assert.equal(atm2.twoSided, false);
  assert.equal(atm2.lock?.yesOn, "kalshi", "Yes can only be bought where it is offered");
  assert.equal(logs.length, 0);
});

test("a book that answers 404 just after its window opened is that row's problem: plain words, no URL on the page, the URL in the JSON and the log, one attempt, the other tenor untouched", async () => {
  const f = fake();
  const { c, logs } = collectorOn(f);
  f.set(pBookUrl(FIFTEEN_P), { status: 404, body: { code: 5, message: "not found" }, headers: { age: "225" } });
  const d = await c.collectOnce();

  assert.equal(f.calls.filter((u) => u === pBookUrl(FIFTEEN_P)).length, 1, "the next cycle is the retry");
  const row = d.fifteen?.pairs[0];
  assert.ok(row);
  assert.equal(row.poly, null, "the listing's price is not a leg");
  assert.ok(row.kalshi && row.kalshi.bidQty === 100, "the other venue's book stands");
  assert.deepEqual([row.gapCents, row.lock, row.score, row.twoSided], [null, null, null, false]);
  assert.equal(row.errors.length, 1);
  const e = row.errors[0];
  assert.equal(e.venue, "polymarket_us");
  assert.equal(e.id, FIFTEEN_P);
  assert.equal(e.kind, "not_served_yet");
  assert.equal(e.status, 404);
  assert.equal(e.reason, "Poly has listed this contract but is not serving its book yet (usual for a few minutes after it opens)");
  assert.equal(e.url, pBookUrl(FIFTEEN_P));
  assert.equal(e.cacheAgeSec, 225);
  assert.deepEqual(e.listing, { bidCents: 47, askCents: 48 });
  assert.equal(row.reading, e.reason);
  assert.equal(d.fifteen?.pick, null, "nothing for Launch to send from this tenor");
  assert.deepEqual(d.errors.map((x) => [x.horizon, x.strike, x.id]), [["fifteen", 73701.52, FIFTEEN_P]]);
  assert.deepEqual(d.health["fifteen books"].ok, false);
  assert.equal(d.health["fifteen books"].detail, "1 of 2 did not answer");
  assert.ok(!d.bundle.some((p) => p.horizon === "fifteen"));

  // the hourly is priced as if nothing had happened
  assert.equal(d.health["hourly books"].ok, true);
  assert.ok(d.hourly?.pairs.every((p) => p.errors.length === 0 && p.lock && p.score !== null));
  assert.ok(d.hourly?.pick);

  const html = page(c);
  assert.ok(html.includes('<td class="dim nobook">Poly has listed this contract but is not serving its book yet (usual for a few minutes after it opens)<small>listing price 47 / 48, no size</small></td>'), "the Poly cells say why and mark the listing price");
  assert.ok(html.includes(`data-id="${FIFTEEN_K}" data-label="$73,701.52 price to beat" data-nolaunch>`));
  assert.ok(html.includes('<button type="button" class="go" data-horizon="fifteen" disabled>Launch</button><span class="picklabel">a book is not answering</span>'));
  assert.ok(html.includes("fifteen books 1 of 2 did not answer"));
  assert.ok(!html.includes("gateway.polymarket.us/v1/markets"), "no raw URL on the page");
  assert.ok(!html.includes("HTTP 404 for"), "nor the reader's raw error");
  assert.ok(!html.includes("—"));

  assert.deepEqual(logs, [`[btc-pairs] book not answering: polymarket_us ${FIFTEEN_P} HTTP 404 (held in the venue's cache 225s) ${pBookUrl(FIFTEEN_P)}`]);
  // the pair is still found by the failed market's id, and its payload says why
  assert.equal(c.findPair(new URLSearchParams({ id: FIFTEEN_P })), row);
  const payload = launchPayload(d, row);
  assert.equal(payload.pair.poly, null);
  assert.equal(payload.pair.errors[0].url, pBookUrl(FIFTEEN_P));

  // still failing: said once in the log; then the book arrives and the row is whole again
  f.now += 10_000;
  await c.collectOnce();
  assert.equal(logs.length, 1);
  f.set(pBookUrl(FIFTEEN_P), undefined);
  f.now += 10_000;
  const d3 = await c.collectOnce();
  assert.deepEqual(d3.errors, []);
  assert.ok(d3.fifteen?.pairs[0].poly && d3.fifteen.pairs[0].lock && d3.fifteen.pick === FIFTEEN_K);
  assert.equal(logs[1], `[btc-pairs] book answering again: polymarket_us ${FIFTEEN_P} after 2 cycles (HTTP 404)`);
});

test("other failures are said as what happened: a 404 long after the open, a 500, a timeout, a Kalshi book; one failed strike leaves its neighbours and the bands on the other venue", async () => {
  const f = fake();
  const { c } = collectorOn(f, { bookTimeoutMs: 30 });
  f.set(pBookUrl(pSlug(73750)), { status: 404 });
  f.set(pBookUrl(pSlug(74000)), { status: 500 });
  f.set(pBookUrl(FIFTEEN_P), { hang: true });
  f.set(kBookUrl(kTicker(73500)), { status: 503 });
  const d = await c.collectOnce();
  const [below, atm, above] = d.hourly?.pairs ?? [];
  assert.equal(atm.errors[0].reason, "Poly book did not answer (HTTP 404)", "listed a day ago: not the opening gap");
  assert.equal(atm.errors[0].kind, "http");
  assert.equal(above.errors[0].reason, "Poly book did not answer (HTTP 500)");
  assert.equal(d.fifteen?.pairs[0].errors[0].reason, "Poly book did not answer (timed out)");
  assert.equal(d.fifteen?.pairs[0].errors[0].kind, "timeout");
  assert.equal(below.errors[0].reason, "Kalshi book did not answer (HTTP 503)");
  assert.equal(below.kalshi, null);
  assert.ok(below.poly, "Poly's book on that strike stands");
  assert.deepEqual(below.errors[0].listing, { bidCents: 58, askCents: 59 }, "Kalshi's list price, marked as a listing price");
  assert.equal(d.health["hourly books"].detail, "3 of 6 did not answer");
  assert.equal(d.hourly?.pick, null);
  assert.equal(d.bundle.length, 0);
  // the band between 73,500 and 73,750 can still be owned on the legs whose books answered: Yes on Poly below, No on Kalshi above
  const band = d.hourly?.bands[0];
  assert.deepEqual(band?.cost?.legs.map((l) => [l.venue, l.side, l.strike]), [["polymarket_us", "yes", 73500], ["kalshi", "no", 73750]]);
  assert.equal(d.hourly?.bands[1].cost?.legs.every((l) => l.venue === "kalshi"), true, "no Poly leg where Poly's books did not answer");

  const html = page(c);
  for (const needle of ["Poly book did not answer (HTTP 404)", "Poly book did not answer (HTTP 500)", "Poly book did not answer (timed out)", "Kalshi book did not answer (HTTP 503)<small>listing price 58 / 59, no size</small>", "not scored without both books"]) {
    assert.ok(html.includes(needle), `page shows ${needle}`);
  }
  assert.equal((html.match(/class="use"/g) ?? []).length, 0, "no use button on a row whose book did not answer");
  assert.ok(!html.includes("https://gateway.polymarket.us/v1/markets") && !html.includes("/orderbook"));
});
