/**
 * The pairs collector's routes under a mount, the launch payload, the Polymarket US ladder pick
 * and the venue merge. No network: the report is placed on the collector directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PairsCollector, isUpDown, launchPayload, merged, pairsCollectorFromEnv, polyLadderIn } from "../src/btcCurve/pairsCollector";
import { STALE_AFTER_SEC, bundleOf, fifteenSet, horizonSet, recordGaps, regimeOf, type GapHistory, type PairsReport, type VenueUrls } from "../src/btcCurve/pairs";
import { bucketFromPolyUs, laddersFromEvents } from "../src/btcCurve/polyUsLadders";
import { fifteenLadderFrom } from "../src/btcCurve/kalshiLadders";
import type { Ladder, VenueQuote } from "../src/btcCurve/types";

const SETTLE = "2026-11-09T22:00:00Z";
const NOW = Date.parse("2026-11-09T21:20:00Z");
const urls: VenueUrls = {
  kalshi: ({ eventTicker }) => `https://kalshi.com/markets/kxbtcd/x/${eventTicker.toLowerCase()}`,
  poly: ({ eventSlug }) => `https://polymarket.us/event/${eventSlug}`,
};

function q(venue: "kalshi" | "polymarket_us", strike: number, bid: number, ask: number): VenueQuote {
  return {
    venue,
    bucketKey: `above:${strike}`,
    id: venue === "kalshi" ? `KXBTCD-26NOV0917-T${(strike - 0.01).toFixed(2)}` : `cpc-btc-above-day-2026-11-09-${strike}`,
    bidCents: bid,
    askCents: ask,
    bidQty: 100,
    askQty: 100,
    volume: 0,
    openInterest: 0,
    feeTheta: venue === "kalshi" ? 0.07 : 0.095,
  };
}

function ladder(venues: Array<"kalshi" | "polymarket_us"> = ["kalshi", "polymarket_us"], settlesAt = SETTLE, kind: "above" | "range" = "above"): Ladder {
  const strikes = [74000, 74250, 74500, 74750, 75000, 75250, 75500];
  const buckets = strikes.map((s) => ({ key: `${kind}:${s}`, kind, level: s, settlesAt }));
  const quotes: VenueQuote[] = [];
  strikes.forEach((s, i) => {
    const yes = 90 - i * 12;
    if (venues.includes("kalshi")) quotes.push(q("kalshi", s, yes, yes + 1));
    if (venues.includes("polymarket_us")) quotes.push(q("polymarket_us", s, yes - 1, yes + 1));
  });
  return { id: venues.includes("kalshi") ? "btc-hourly:KXBTCD-26NOV0917" : "poly:btc-above-day-2026-11-09", title: "t", settlesAt, buckets, quotes, model: {} };
}

function fifteenLadder(): Ladder {
  const level = 74800.5;
  const settlesAt = "2026-11-09T21:30:00Z";
  const k: VenueQuote = { venue: "kalshi", bucketKey: `above:${level}`, id: "KXBTC15M-26NOV091630-15", bidCents: 51, askCents: 52, bidQty: 2000, askQty: 1600, volume: 0, openInterest: 0, feeTheta: 0.07 };
  const p: VenueQuote = { venue: "polymarket_us", bucketKey: `above:${level}`, id: "cpc-btc-updown-15m-2026-11-09-2115z", bidCents: 50, askCents: 53, bidQty: 1800, askQty: 9, volume: 0, openInterest: 0, feeTheta: 0.095 };
  return { id: "btc-15m:KXBTC15M-26NOV091630", title: "t", settlesAt, buckets: [{ key: `above:${level}`, kind: "above", level, settlesAt }], quotes: [k, p], model: {} };
}

function report(): PairsReport {
  const history: GapHistory = new Map();
  const spots: Array<[number, number]> = [];
  for (let i = 0; i <= 3600; i += 1) spots.push([NOW - 3_600_000 + i * 1000, 74800 + 60 * Math.sin(i / 50)]);
  const regime = regimeOf(spots, NOW);
  const volPct = regime.m60?.volPct ?? null;
  const fifteen = fifteenSet(fifteenLadder(), "poly:btc-updown-15m-2026-11-09-2115z:range:2026-11-09", 74812, NOW, history, urls, { volPct });
  const hourly = horizonSet("hourly", ladder(), "poly:btc-above-day-2026-11-09", 74812, NOW, history, urls, { volPct });
  const daily = horizonSet("daily", ladder(["kalshi", "polymarket_us"], "2026-11-10T22:00:00Z"), "poly:btc-above-day-2026-11-10", 74812, NOW, history, urls, { volPct });
  recordGaps(history, [fifteen, hourly, daily], NOW, 60 * 60_000);
  return {
    at: new Date(NOW).toISOString(),
    pricedAt: new Date(NOW).toISOString(),
    spotUsd: 74812,
    spotSource: "BRTI",
    intervalSec: 10,
    historyPoints: 1,
    collectingSince: new Date(NOW).toISOString(),
    fifteen,
    hourly,
    daily,
    regime,
    bundle: bundleOf([fifteen, hourly, daily]),
    staleAfterSec: STALE_AFTER_SEC,
    health: { kalshi: { ok: true, ms: 40 } },
    errors: [],
  };
}

class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  headersSent = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  write(s: string) {
    this.chunks.push(s);
    return true;
  }
  end(s?: string) {
    if (s) this.chunks.push(s);
    this.ended = true;
  }
  get body() {
    return this.chunks.join("");
  }
}

function call(c: PairsCollector, pathWithQuery: string, base = "/pairs", token?: string) {
  const url = new URL(`http://x${pathWithQuery}`);
  const sub = url.pathname.slice(base.length).replace(/\/$/, "") || "/";
  const req = new EventEmitter() as unknown as IncomingMessage;
  const res = new FakeRes();
  const handled = c.handle(req, res as unknown as ServerResponse, sub, url, { base, token });
  return { handled, res, req };
}

test("routes under /pairs: the report, the bundle as launch payloads, one pair by place or id, 404 for the rest, false off the mount", () => {
  const c = new PairsCollector({ dataDir: "/tmp/btc-pairs-test-none", log: () => {} });
  const d = report();
  c.latest = d;

  const all = call(c, "/pairs/api/pairs");
  assert.ok(all.handled);
  assert.equal(all.res.status, 200);
  assert.equal(all.res.headers["access-control-allow-origin"], "*");
  assert.equal(JSON.parse(all.res.body).spotUsd, 74812);

  const bundle = JSON.parse(call(c, "/pairs/api/bundle").res.body);
  assert.equal(bundle.index, "BRTI");
  assert.equal(bundle.bundle.length, 7, "six ladder strikes and the 15-minute window");
  assert.equal(bundle.bundle[0].type, "atticus.btc_pair");
  assert.equal(bundle.bundle[0].pair.score, d.bundle[0].score);

  const atm = JSON.parse(call(c, "/pairs/api/pair?horizon=daily&place=atm").res.body);
  assert.equal(atm.pair.horizon, "daily");
  assert.equal(atm.pair.place, "atm");
  assert.equal(atm.pair.strike, 74750);
  assert.equal(atm.set.horizon, "daily");
  assert.equal(atm.set.secondsToClose, 24 * 3600 + 40 * 60);
  assert.equal(atm.bands.length, 2);
  assert.equal(atm.regime.label, "steady");

  const fifteen = JSON.parse(call(c, "/pairs/api/pair?horizon=fifteen").res.body);
  assert.equal(fifteen.pair.horizon, "fifteen");
  assert.equal(fifteen.pair.kalshi.id, "KXBTC15M-26NOV091630-15");
  assert.deepEqual(fifteen.bands, []);
  assert.equal(fifteen.set.stepUsd, 0);

  const pick = JSON.parse(call(c, "/pairs/api/pair?horizon=hourly&place=pick").res.body);
  assert.equal(pick.pair.kalshi.id, d.hourly?.pick, "the tenor's default Launch target");

  const byId = call(c, "/pairs/api/pair?id=KXBTCD-26NOV0917-T74999.99");
  assert.equal(byId.res.status, 200);
  assert.equal(JSON.parse(byId.res.body).pair.kalshi.id, "KXBTCD-26NOV0917-T74999.99");
  const bySlug = JSON.parse(call(c, "/pairs/api/pair?id=cpc-btc-above-day-2026-11-09-74500").res.body);
  assert.equal(bySlug.pair.place, "below");

  const missing = call(c, "/pairs/api/pair?id=nope");
  assert.equal(missing.res.status, 404);
  assert.match(JSON.parse(missing.res.body).error, /horizon=fifteen\|hourly\|daily/);

  const page = call(c, "/pairs?k=t", "/pairs", "t");
  assert.equal(page.res.status, 200);
  assert.ok(page.res.body.includes('var BASE="/pairs",Q="?k=t&"'), "the page fetches under the mount with the token");

  assert.equal(call(c, "/pairs/api/other").handled, false, "an unknown path is left to the host");
});

test("warming up: 503 JSON before the first cycle; the stream sends retry and then the frame of each cycle", () => {
  const c = new PairsCollector({ dataDir: "/tmp/btc-pairs-test-none", log: () => {} });
  assert.equal(call(c, "/pairs/api/pairs").res.status, 503);
  assert.equal(call(c, "/pairs/api/pair?place=atm").res.status, 503);
  assert.equal(call(c, "/pairs").res.status, 503);

  const s = call(c, "/pairs/api/stream");
  assert.equal(s.res.headers["content-type"], "text/event-stream");
  assert.equal(s.res.body, "retry: 10000\n\n", "nothing to send yet");
  assert.equal(c.listenerCount, 1);
  (c as unknown as { broadcast(r: PairsReport): void }).broadcast(report());
  assert.ok(s.res.body.includes("event: pairs\ndata: {"), "the frame reaches the listener");
  (s.req as unknown as EventEmitter).emit("close");
  assert.equal(c.listenerCount, 0);
});

test("launch payload: typed, versioned, the pair with spot and index, its tenor, the bands and the regime; env builds the collector with the curve's data dir as the default", () => {
  const d = report();
  const p = launchPayload(d, d.bundle[0]);
  assert.deepEqual(Object.keys(p), ["type", "version", "at", "spotUsd", "index", "pair", "set", "bands", "regime"]);
  assert.equal(p.version, 1);
  assert.equal(p.pair, d.bundle[0]);
  assert.equal(p.set?.horizon, d.bundle[0].horizon);
  assert.equal(p.regime, d.regime);
  const hourlyPair = d.hourly?.pairs[0];
  assert.ok(hourlyPair);
  const hp = launchPayload(d, hourlyPair);
  assert.equal(hp.bands.length, 2);
  assert.equal(hp.bands[0].cost?.legs.length, 2);
  assert.equal(hp.set?.pick, d.hourly?.pick);

  const c = pairsCollectorFromEnv({ BTC_PAIRS_INTERVAL_SEC: "3", BTC_PAIRS_LAUNCH_URL: "https://e.example/x", BTC_PAIRS_LAUNCH_MODE: "open", BTC_PAIRS_KALSHI_URL: "https://k.example/{event}/{ticker}" }, { dataDir: "/var/data/btc-curve/pairs" });
  assert.equal(c.intervalSec, 5, "floor 5");
  assert.equal(c.launchUrl, "https://e.example/x");
  assert.equal(c.launchMode, "open");
  assert.equal(pairsCollectorFromEnv({}).launchMode, "send");
  assert.equal(pairsCollectorFromEnv({ BTC_PAIRS_LAUNCH_MODE: "nonsense" }).launchMode, "send");
  assert.equal(c.urls.kalshi({ ticker: "KXBTCD-26NOV0917-T74999.99", eventTicker: "KXBTCD-26NOV0917" }), "https://k.example/kxbtcd-26nov0917/kxbtcd-26nov0917-t74999.99");
  assert.equal((c as unknown as { dataDir: string }).dataDir, "/var/data/btc-curve/pairs");
});

test("Polymarket US pick: the above ladder closing soonest inside the window, ranges skipped; merge joins the venues only at the same close", () => {
  const soon = ladder(["polymarket_us"], new Date(NOW + 40 * 60_000).toISOString());
  const later = ladder(["polymarket_us"], new Date(NOW + 100 * 60_000).toISOString());
  const range = ladder(["polymarket_us"], new Date(NOW + 20 * 60_000).toISOString(), "range");
  const past = ladder(["polymarket_us"], new Date(NOW - 60_000).toISOString());
  assert.equal(polyLadderIn([later, range, soon, past], NOW, 2 * 60_000, 90 * 60_000), soon);
  assert.equal(polyLadderIn([later, range, soon], NOW, 90 * 60_000, 36 * 3_600_000), later);
  assert.equal(polyLadderIn([range], NOW, 0, 3_600_000), null);

  const k = ladder(["kalshi"]);
  const p = ladder(["polymarket_us"]);
  const both = merged(k, p);
  assert.ok(both);
  assert.equal(both.quotes.filter((x) => x.venue === "polymarket_us").length, 7, "the Polymarket US quotes ride the Kalshi spine");
  assert.equal(merged(k, ladder(["polymarket_us"], "2026-11-09T23:00:00Z")), k, "a different close is not merged");
  assert.equal(merged(null, p), p);
  assert.equal(merged(null, null), null);
});

test("15-minute readers: Kalshi KXBTC15M becomes a one-strike ladder at the price to beat; Polymarket US up/down only when asked, on the same key; up/down ladders are told apart by slug", () => {
  const now = Date.parse("2026-11-10T16:12:00Z");
  const raw = [
    { ticker: "KXBTC15M-26NOV101115-15", event_ticker: "KXBTC15M-26NOV101115", status: "open", close_time: "2026-11-10T16:15:00Z", strike_type: "greater_or_equal", floor_strike: 73158.07, yes_bid_dollars: "0.9050", yes_ask_dollars: "0.9100" },
    { ticker: "KXBTC15M-26NOV101130-15", event_ticker: "KXBTC15M-26NOV101130", status: "open", close_time: "2026-11-10T16:30:00Z", strike_type: "greater_or_equal", floor_strike: 73200, yes_bid_dollars: "0.5000", yes_ask_dollars: "0.5200" },
  ];
  const k = fifteenLadderFrom(raw, 0.07, now);
  assert.ok(k);
  assert.equal(k.id, "btc-15m:KXBTC15M-26NOV101115");
  assert.equal(k.settlesAt, "2026-11-10T16:15:00Z");
  assert.deepEqual(k.buckets.map((b) => [b.key, b.level]), [["above:73158.07", 73158.07]]);
  assert.equal(k.quotes[0].bidCents, 90.5);
  assert.equal(fifteenLadderFrom(raw, 0.07, Date.parse("2026-11-10T16:14:45Z"))?.id, "btc-15m:KXBTC15M-26NOV101130", "inside the last 30 seconds the next window stands");
  assert.equal(fifteenLadderFrom([], 0.07, now), null);

  const m = {
    slug: "cpc-btc-updown-15m-2026-11-10-1600z",
    question: "BTC Up or Down 15m",
    endDate: "2026-11-10T16:45:00Z",
    feeCoefficient: 0.095,
    bestBidQuote: { value: "0.8000" },
    bestAskQuote: { value: "0.8100" },
    assetPriceTerms: { marketType: "ASSET_PRICE_MARKET_TYPE_UP_DOWN", asset: { assetClass: "ASSET_CLASS_CRYPTO", symbol: "btc" }, indexSymbol: "BRTI", horizon: "15m", windowStart: "2026-11-10T16:00:00Z", windowEnd: "2026-11-10T16:15:00Z", priceToBeat: { value: "73158.07", currency: "USD" }, strike: null },
  };
  assert.equal(bucketFromPolyUs(m), null, "the curve report does not read up/down as a strike");
  const b = bucketFromPolyUs(m, { upDown: true });
  assert.deepEqual(b, { key: "above:73158.07", kind: "above", level: 73158.07, settlesAt: "2026-11-10T16:15:00Z" });
  const [pl] = laddersFromEvents([{ slug: "btc-updown-15m-2026-11-10-1600z", title: "BTC Up or Down 15m", markets: [m] }], { upDown: true });
  assert.equal(pl.id, "poly:btc-updown-15m-2026-11-10-1600z:range:2026-11-10");
  assert.equal(pl.settlesAt, "2026-11-10T16:15:00Z", "the window end, not the market's later end date");
  assert.equal(pl.quotes[0].askCents, 81);
  assert.ok(isUpDown(pl));
  assert.ok(!isUpDown(ladder(["polymarket_us"])));
  assert.equal(laddersFromEvents([{ slug: "x", markets: [m] }]).length, 0);

  // merged on the same close and key: Kalshi 90.5/91 against Poly 80/81 is a 10¢ gap and a cross
  const both = merged(k, pl);
  assert.ok(both);
  const s = fifteenSet(both, pl.id, 73214, now, new Map(), urls);
  assert.ok(s);
  assert.equal(s.pairs[0].gapCents, 10.25);
  assert.ok(s.pairs[0].lock && s.pairs[0].lock.yesOn === "polymarket_us" && s.pairs[0].lock.edgeCents > 6, `locks ${s.pairs[0].lock?.edgeCents}`);
});
