/**
 * Whole cycles of the pairs collector against a fake of both venues' public endpoints (the
 * readers take an injectable fetch and the collector an injectable clock). No network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { PairsCollector, launchPayload, pairsCollectorFromEnv, type PairsCollectorOptions } from "../src/btcCurve/pairsCollector";
import type { LockEpisode } from "../src/btcCurve/pairs";

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
  /** our clock moves this far every time it is read, so the reads within a cycle have different times */
  tickMs: number;
}

/**
 * Both venues at 21:16 UTC on 10 November 2026: the 21:15 to 21:30 window, the contract closing
 * at 22:00 (Kalshi KXBTCD and the Polymarket US daily share that close), index prints for the
 * hour. Kalshi quotes fair/fair+1, Polymarket US fair-1/fair+1, 100 contracts a side.
 */
function fake(): Fake {
  const overrides = new Map<string, Answer>();
  const calls: string[] = [];
  const state = { now: T0, tickMs: 0 };
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
    get tickMs() {
      return state.tickMs;
    },
    set tickMs(v: number) {
      state.tickMs = v;
    },
  };
}

function collectorOn(f: Fake, opts: PairsCollectorOptions = {}): { c: PairsCollector; logs: string[]; dir: string } {
  const logs: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "btc-pairs-cycle-"));
  const c = new PairsCollector({ dataDir: dir, fetchImpl: f.fetchImpl, clock: () => (f.now += f.tickMs), log: (line) => logs.push(line), ...opts });
  return { c, logs, dir };
}

/** One Polymarket US book as its cache serves it: the copy held `cacheAgeSec`, last changed `stampAgeSec` before now. */
function polyBook(f: Fake, slug: string, bid: number, ask: number, cacheAgeSec: number, stampAgeSec = cacheAgeSec + 1): Answer {
  const money = (cents: number) => ({ value: (cents / 100).toFixed(4), currency: "USD" });
  return {
    body: { marketData: { marketSlug: slug, bids: [{ px: money(bid), qty: "100.0000" }], offers: [{ px: money(ask), qty: "100.0000" }], state: "MARKET_STATE_OPEN", transactTime: new Date(f.now - stampAgeSec * 1000).toISOString() } },
    headers: { age: String(cacheAgeSec), "cache-control": "public, max-age=30" },
  };
}

const kalshiBook = (yesBid: number): Answer => ({ body: { orderbook_fp: { yes_dollars: [[(yesBid / 100).toFixed(4), "100.00"]], no_dollars: [[((100 - yesBid - 1) / 100).toFixed(4), "100.00"]] } } });

function getJson<T = Record<string, unknown>>(c: PairsCollector, path: string): T {
  let body = "";
  const res = { writeHead: () => res, end: (s?: string) => void (body += s ?? ""), write: () => true };
  assert.equal(c.handle({} as never, res as never, path, new URL(`http://x/pairs${path}`), { base: "/pairs" }), true, `${path} is served`);
  return JSON.parse(body) as T;
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
  assert.ok(!html.includes("\u2014"), "no em dash on the page");

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

test("every book carries its read age: our fetch time, the venue's cache age and its own stamp, measured to the moment the pairs were priced; Kalshi's stamp is not given", async () => {
  const f = fake();
  const { c } = collectorOn(f);
  f.tickMs = 150;
  const d = await c.collectOnce();
  assert.equal(d.at, new Date(T0 + 150).toISOString(), "the cycle's start");
  assert.ok(Date.parse(d.pricedAt) > Date.parse(d.at), "priced after the books were read");
  const pricedMs = Date.parse(d.pricedAt);

  for (const p of [...(d.fifteen?.pairs ?? []), ...(d.hourly?.pairs ?? [])]) {
    const k = p.kalshi?.read;
    const y = p.poly?.read;
    assert.ok(k && y, `${p.horizon} ${p.strike} carries both reads`);
    // Kalshi: our fetch time only
    assert.equal(k.venueAt, null);
    assert.equal(k.venueAgeSec, null);
    assert.equal(k.cacheAgeSec, null);
    assert.equal(k.fetchAgeSec, Math.round((pricedMs - Date.parse(k.fetchedAt)) / 100) / 10);
    assert.equal(k.ageSec, k.fetchAgeSec);
    assert.ok(k.fetchAgeSec >= 0 && k.fetchAgeSec < 5);
    // Polymarket US: the copy had been in the venue's cache 4 seconds, and the book's stamp is older than the copy
    assert.equal(y.cacheAgeSec, 4);
    assert.equal(y.ageSec, Math.round((y.fetchAgeSec + 4) * 10) / 10);
    assert.ok(y.venueAt && y.venueAgeSec !== null && y.venueAgeSec > y.fetchAgeSec);
    assert.equal(y.venueAgeSec, Math.round((pricedMs - Date.parse(y.venueAt)) / 100) / 10);
    assert.equal(y.state, "MARKET_STATE_OPEN");
  }
  const reads = [...(d.fifteen?.pairs ?? []), ...(d.hourly?.pairs ?? [])].flatMap((p) => [p.kalshi?.read?.fetchedAt, p.poly?.read?.fetchedAt]);
  assert.ok(new Set(reads).size > 1, "each book has its own fetch time");

  const html = page(c);
  assert.match(html, /<small class="age">read \d+s ago · venue stamp not given<\/small>/, "Kalshi's cell");
  assert.match(html, /<small class="age">read \d+s ago · 4s in the venue&#39;s cache · venue stamp \d+s old<\/small>/, "Polymarket US's cell");
  assert.equal((html.match(/<small class="age">/g) ?? []).length, 8, "two books on each of the four rows");

  // the same fields ride the launch payload and the stream frame
  const payload = launchPayload(d, d.hourly?.pairs[1] as NonNullable<typeof d.hourly>["pairs"][number]);
  assert.equal(payload.pair.poly?.read?.cacheAgeSec, 4);
  assert.ok(JSON.stringify(d).includes('"pricedAt"'));
});

test("a stale read over whole cycles: the 15-minute row on a 22-second copy shows both books and its lock greyed and tagged, is not what Launch sends, and adds nothing to the window until the copy is young again", async () => {
  const f = fake();
  const { c, dir } = collectorOn(f);
  const gapLines = () => readdirSync(dir).filter((n) => n.startsWith("gaps-")).flatMap((n) => readFileSync(join(dir, n), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { rows: Array<[string, string, number]> }));
  // Kalshi has moved to 58/59; Polymarket US's cache still serves 49/51 from 22 seconds ago. On the page that reads as a lock.
  f.set(kBookUrl(FIFTEEN_K), kalshiBook(58));
  f.set(pBookUrl(FIFTEEN_P), polyBook(f, FIFTEEN_P, 49, 51, 22));
  const d = await c.collectOnce();
  assert.deepEqual(d.staleAfterSec, { fifteen: 15, hourly: 30, daily: 30 });
  const row = d.fifteen?.pairs[0];
  assert.ok(row && row.kalshi && row.poly, "both books are still shown");
  assert.equal(row.poly.read?.ageSec, 22);
  assert.equal(row.freshness, "stale");
  assert.equal(row.gapCents, 8.5);
  assert.ok(row.lock && row.lock.edgeCents > 0);
  assert.ok(row.score !== null, "the score is still the score");
  assert.equal(row.persistence, null, "nothing accrued");
  assert.equal(d.fifteen?.pick, null);
  assert.ok(d.hourly?.pairs.every((p) => p.freshness === "fresh"), "the hourly rows are on 4-second copies");
  assert.ok(d.bundle[0].freshness === "fresh" && d.bundle[d.bundle.length - 1] === row);
  assert.ok(gapLines().every((l) => l.rows.every((r) => r[1] !== row.key)), "the day file does not take the stale gap");

  const html = page(c);
  const section = html.slice(html.indexOf('<section data-horizon="fifteen"'), html.indexOf('<section data-horizon="hourly"'));
  assert.match(section, /data-pick=""/);
  assert.match(section, /a read older than 15s is stale/);
  assert.match(section, /<button type="button" class="go" data-horizon="fifteen" disabled>Launch<\/button><span class="picklabel">read too old to judge<\/span>/);
  assert.match(section, /<td class="stale">\+8\.5¢<span class="tag">stale read<\/span>/, "the gap: greyed and tagged, not coloured as an edge");
  assert.match(section, /<td class="stale"><b>locks [\d.]+¢<\/b><span class="tag">stale read<\/span>/, "the lock: no green");
  assert.ok(!section.includes('class="ok">locks'));
  assert.match(section, /stale read: Poly copy 22s old \(limit 15s\)/);
  assert.match(section, /22s in the venue&#39;s cache/);
  assert.match(section, /data-label="[^"]* price to beat · stale read"/);
  assert.match(section, /<button type="button" class="use" data-id="[^"]+" data-horizon="fifteen"/, "sending it anyway is the trader's call, by hand");
  assert.ok(!section.includes("cleanest"));
  const hourly = html.slice(html.indexOf('<section data-horizon="hourly"'));
  assert.ok(!hourly.includes("stale read</span>"), "no tag on a fresh tenor");
  assert.match(hourly, /a read older than 30s is stale/);

  // the engine reading the stream or one pair sees the same judgment
  assert.equal(launchPayload(d, row).pair.freshness, "stale");
  assert.equal(launchPayload(d, row).pair.staleAfterSec, 15);

  // ten seconds on, the cache has a new copy of the same books: the lock is now on a fresh read
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), polyBook(f, FIFTEEN_P, 49, 51, 3));
  const d2 = await c.collectOnce();
  const row2 = d2.fifteen?.pairs[0];
  assert.equal(row2?.freshness, "fresh");
  assert.equal(d2.fifteen?.pick, FIFTEEN_K);
  assert.equal(row2?.persistence, null, "the window starts with this reading; one reading is not yet a history");
  const section2 = page(c).slice(page(c).indexOf('<section data-horizon="fifteen"'), page(c).indexOf('<section data-horizon="hourly"'));
  assert.match(section2, /<b class="ok">locks/);
  assert.ok(!section2.includes("stale read</span>"));
  assert.ok(!section2.includes('class="use"'), "the one row is the pick again: no use button");
  assert.ok(gapLines().some((l) => l.rows.some((r) => r[1] === row.key)));

  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), polyBook(f, FIFTEEN_P, 49, 51, 13));
  assert.equal((await c.collectOnce()).fifteen?.pairs[0].persistence?.n, 2, "two fresh readings");

  // every scored pair stale: nothing is called cleanest
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), polyBook(f, FIFTEEN_P, 49, 51, 31));
  for (const s of STRIKES) f.set(pBookUrl(pSlug(s)), polyBook(f, pSlug(s), fair(s) - 1, fair(s) + 1, 31));
  const d3 = await c.collectOnce();
  assert.ok(d3.bundle.length > 0 && d3.bundle.every((p) => p.freshness === "stale"));
  assert.equal(d3.hourly?.pick, null);
  assert.match(page(c), /Cleanest now <b>–<\/b><small>every two-sided pair is on a stale read<\/small>/);
  assert.equal(d3.fifteen?.pairs[0].persistence?.n, 2, "still the two fresh readings: the stale one was not added");
});

test("the stale bounds come from BTC_PAIRS_STALE_SECONDS", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "btc-pairs-env-"));
  assert.deepEqual(pairsCollectorFromEnv({ BTC_PAIRS_DATA_DIR: dataDir }).staleAfterSec, { fifteen: 15, hourly: 30, daily: 30 });
  assert.deepEqual(pairsCollectorFromEnv({ BTC_PAIRS_DATA_DIR: dataDir, BTC_PAIRS_STALE_SECONDS: "15m=20,1h=45,1d=60" }).staleAfterSec, { fifteen: 20, hourly: 45, daily: 60 });
  assert.deepEqual(pairsCollectorFromEnv({ BTC_PAIRS_DATA_DIR: dataDir, BTC_PAIRS_STALE_SECONDS: "1h=40" }).staleAfterSec, { fifteen: 15, hourly: 40, daily: 30 });
});

test("lock episodes over whole cycles: counted from the second fresh cycle, ended by a stale one, written to the day file, reloaded by the next process, on the page with its label and in the JSON", async () => {
  const f = fake();
  const { c, dir } = collectorOn(f);
  const fifteenSection = () => page(c).slice(page(c).indexOf('<section data-horizon="fifteen"'), page(c).indexOf('<section data-horizon="hourly"'));
  const LABEL = "measured at the size on the book, after fees, no orders placed; a floor on what was there, not what a trader would have captured";
  // Kalshi 58 bid on 100; Polymarket US offers at 51 on 100, then 60, then 80 contracts
  f.set(kBookUrl(FIFTEEN_K), kalshiBook(58));
  const poly = (qty: number, cacheAgeSec: number): Answer => {
    const a = polyBook(f, FIFTEEN_P, 49, 51, cacheAgeSec);
    (a.body as { marketData: { offers: Array<{ qty: string }> } }).marketData.offers[0].qty = `${qty}.0000`;
    return a;
  };

  // cycle 1: a lock on a fresh read. A run, not yet an episode.
  f.set(pBookUrl(FIFTEEN_P), poly(100, 3));
  const d1 = await c.collectOnce();
  const lock = d1.fifteen?.pairs[0].lock;
  assert.ok(lock && lock.edgeCents > 0 && lock.yesOn === "polymarket_us" && lock.qty === 100);
  assert.equal(d1.lockEpisodes.label, LABEL);
  assert.equal(d1.lockEpisodes.day, "2026-11-10");
  assert.deepEqual([d1.lockEpisodes.fifteen.episodes, d1.lockEpisodes.hourly.episodes, d1.lockEpisodes.daily.episodes], [0, 0, 0]);
  assert.match(fifteenSection(), new RegExp(`<p class="epi">Lock episodes today \\(UTC\\): <b>none</b><small>${LABEL}\\.`));
  assert.match(page(c).slice(page(c).indexOf('<section data-horizon="daily"')), /No daily contract[^<]*<\/p><p class="epi">Lock episodes today \(UTC\): <b>none<\/b>/, "the line stands with no window open");

  // cycle 2, ten seconds on, less size: an episode, still open
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), poly(60, 13));
  const d2 = await c.collectOnce();
  const e2 = d2.lockEpisodes.fifteen;
  assert.deepEqual([e2.episodes, e2.open, e2.medianDurationSec, e2.longestDurationSec], [1, 1, 10, 10]);
  assert.equal(e2.recent[0].minQty, 60);
  assert.equal(e2.recent[0].minLockCents, lock.edgeCents);
  assert.equal(e2.totalValueCents, Math.round(lock.edgeCents * 60 * 100) / 100);
  assert.equal(e2.recent[0].kalshiId, FIFTEEN_K);
  assert.equal(e2.recent[0].polyId, FIFTEEN_P);
  assert.equal(e2.recent[0].startedAt, d1.pricedAt);
  assert.equal(e2.recent[0].endedAt, d2.pricedAt);
  assert.match(fifteenSection(), /<p class="epi">Lock episodes today \(UTC\): <b>1<\/b> \(1 still open\) · median 10s · longest 10s · total <b>\$[\d.]+<\/b> · latest began [\d:]+ [AP]M ET at \$73,701\.52: 10s, at least [\d.]+¢ on 60 contracts<small>measured at the size on the book/);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("episodes-")).length, 0, "nothing is written until it ends");

  // cycle 3: the same lock on a copy 22 seconds old. Not counted, and it ends the run at cycle 2.
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), poly(60, 22));
  const d3 = await c.collectOnce();
  assert.equal(d3.fifteen?.pairs[0].freshness, "stale");
  const e3 = d3.lockEpisodes.fifteen;
  assert.deepEqual([e3.episodes, e3.open], [1, 0]);
  assert.equal(e3.recent[0].endedAt, d2.pricedAt);
  assert.equal(e3.recent[0].open, undefined);
  const written = readFileSync(join(dir, "episodes-2026-11-10.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LockEpisode);
  assert.deepEqual(written, [e3.recent[0]]);
  assert.match(fifteenSection(), /<b>1<\/b> · median 10s · longest 10s · total <b>\$[\d.]+<\/b> · latest ended /);

  // cycles 4 and 5: fresh again, a second episode, open; a clean stop ends and writes it
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), poly(80, 2));
  await c.collectOnce();
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), poly(80, 12));
  const d5 = await c.collectOnce();
  assert.deepEqual([d5.lockEpisodes.fifteen.episodes, d5.lockEpisodes.fifteen.open], [2, 1]);
  const api = getJson<{ label: string; minCycles: number; keptPerTenorBeforeToday: number; open: LockEpisode[]; episodes: LockEpisode[] }>(c, "/api/episodes");
  assert.equal(api.label, LABEL);
  assert.deepEqual([api.minCycles, api.keptPerTenorBeforeToday, api.open.length, api.episodes.length], [2, 50, 1, 1]);
  assert.equal(api.open[0].open, true);
  assert.ok(JSON.stringify(d5).includes('"lockEpisodes"'), "the stream frame is the report, so it carries them");
  assert.deepEqual((c.health() as { lockEpisodesToday: unknown }).lockEpisodesToday, { fifteen: 2, hourly: 0, daily: 0 });
  c.stop();
  assert.equal(readFileSync(join(dir, "episodes-2026-11-10.jsonl"), "utf8").trim().split("\n").length, 2);

  // the next process on the same data dir starts with both
  const again = new PairsCollector({ dataDir: dir, fetchImpl: f.fetchImpl, clock: () => f.now, log: () => {} });
  assert.equal(again.loadEpisodes(), 2);
  f.now += 10_000;
  f.set(pBookUrl(FIFTEEN_P), poly(80, 22));
  const d6 = await again.collectOnce();
  assert.deepEqual([d6.lockEpisodes.fifteen.episodes, d6.lockEpisodes.fifteen.open, d6.lockEpisodes.fifteen.longestDurationSec], [2, 0, 10]);
  assert.equal(getJson<{ episodes: LockEpisode[] }>(again, "/api/episodes").episodes.length, 2);

  // a day file older than three days is deleted on load, a torn line is skipped
  const { writeFileSync, existsSync } = await import("node:fs");
  writeFileSync(join(dir, "episodes-2026-11-05.jsonl"), `${JSON.stringify(written[0])}\n`);
  writeFileSync(join(dir, "episodes-2026-11-09.jsonl"), `${JSON.stringify({ ...written[0], endedAt: "2026-11-09T12:00:10.000Z", startedAt: "2026-11-09T12:00:00.000Z" })}\n{"horizon":"fift`);
  const third = new PairsCollector({ dataDir: dir, fetchImpl: f.fetchImpl, clock: () => f.now, log: () => {} });
  assert.equal(third.loadEpisodes(), 3);
  assert.equal(existsSync(join(dir, "episodes-2026-11-05.jsonl")), false);
});
