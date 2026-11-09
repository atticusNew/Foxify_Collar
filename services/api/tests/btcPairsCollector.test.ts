/**
 * The pairs collector's routes under a mount, the launch payload, the Polymarket US ladder pick
 * and the venue merge. No network: the report is placed on the collector directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PairsCollector, launchPayload, merged, pairsCollectorFromEnv, polyLadderIn } from "../src/btcCurve/pairsCollector";
import { bundleOf, horizonSet, recordGaps, type GapHistory, type PairsReport, type VenueUrls } from "../src/btcCurve/pairs";
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

function report(): PairsReport {
  const history: GapHistory = new Map();
  const hourly = horizonSet("hourly", ladder(), "poly:btc-above-day-2026-11-09", 74812, NOW, history, urls);
  const daily = horizonSet("daily", ladder(["kalshi", "polymarket_us"], "2026-11-10T22:00:00Z"), "poly:btc-above-day-2026-11-10", 74812, NOW, history, urls);
  recordGaps(history, [hourly, daily], NOW, 60 * 60_000);
  return {
    at: new Date(NOW).toISOString(),
    spotUsd: 74812,
    spotSource: "BRTI",
    intervalSec: 10,
    historyPoints: 1,
    collectingSince: new Date(NOW).toISOString(),
    hourly,
    daily,
    bundle: bundleOf([hourly, daily]),
    health: { kalshi: { ok: true, ms: 40 } },
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
  assert.equal(bundle.bundle.length, 6);
  assert.equal(bundle.bundle[0].type, "atticus.btc_pair");
  assert.equal(bundle.bundle[0].pair.score, d.bundle[0].score);

  const atm = JSON.parse(call(c, "/pairs/api/pair?horizon=daily&place=atm").res.body);
  assert.equal(atm.pair.horizon, "daily");
  assert.equal(atm.pair.place, "atm");
  assert.equal(atm.pair.strike, 74750);

  const byId = call(c, "/pairs/api/pair?id=KXBTCD-26NOV0917-T74999.99");
  assert.equal(byId.res.status, 200);
  assert.equal(JSON.parse(byId.res.body).pair.kalshi.id, "KXBTCD-26NOV0917-T74999.99");
  const bySlug = JSON.parse(call(c, "/pairs/api/pair?id=cpc-btc-above-day-2026-11-09-74500").res.body);
  assert.equal(bySlug.pair.place, "below");

  const missing = call(c, "/pairs/api/pair?id=nope");
  assert.equal(missing.res.status, 404);
  assert.match(JSON.parse(missing.res.body).error, /horizon=hourly\|daily/);

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

test("launch payload: typed, versioned, the pair with spot and index; env builds the collector with the curve's data dir as the default", () => {
  const d = report();
  const p = launchPayload(d, d.bundle[0]);
  assert.deepEqual(Object.keys(p), ["type", "version", "at", "spotUsd", "index", "pair"]);
  assert.equal(p.version, 1);
  assert.equal(p.pair, d.bundle[0]);

  const c = pairsCollectorFromEnv({ BTC_PAIRS_INTERVAL_SEC: "3", BTC_PAIRS_LAUNCH_URL: "https://e.example/x", BTC_PAIRS_KALSHI_URL: "https://k.example/{event}/{ticker}" }, { dataDir: "/var/data/btc-curve/pairs" });
  assert.equal(c.intervalSec, 5, "floor 5");
  assert.equal(c.launchUrl, "https://e.example/x");
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
