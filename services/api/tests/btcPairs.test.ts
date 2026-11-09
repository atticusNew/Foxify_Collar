/**
 * BTC pairs: strike selection off spot, the cheapest way to own both sides after both fees,
 * the clean score, gap persistence, the bundle order, and the page.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bundleOf, cleanScore, gapHistoryKey, horizonSet, kalshiEventTicker, lockOf, persistenceOf, polyEventSlug, recordGaps, selectStrikes, gridStep, strikeLevels, type GapHistory, type PairsReport, type VenueUrls } from "../src/btcCurve/pairs";
import { renderPairsBody, renderPairsHtml } from "../src/btcCurve/pairsHtml";
import type { Ladder, VenueQuote } from "../src/btcCurve/types";

const SETTLE = "2026-11-09T22:00:00Z";
const NOW = Date.parse("2026-11-09T21:20:00Z");

const urls: VenueUrls = {
  kalshi: ({ eventTicker }) => `https://kalshi.com/markets/kxbtcd/x/${eventTicker.toLowerCase()}`,
  poly: ({ eventSlug }) => `https://polymarket.us/event/${eventSlug}`,
};

function q(venue: "kalshi" | "polymarket_us", strike: number, bid: number, ask: number, bidQty = 100, askQty = 100): VenueQuote {
  return {
    venue,
    bucketKey: `above:${strike}`,
    id: venue === "kalshi" ? `KXBTCD-26NOV0917-T${(strike - 0.01).toFixed(2)}` : `cpc-btc-above-day-2026-11-09-${strike}`,
    bidCents: bid,
    askCents: ask,
    bidQty,
    askQty,
    volume: 0,
    openInterest: 0,
    feeTheta: venue === "kalshi" ? 0.07 : 0.095,
  };
}

/** A $250 ladder from 74,000 to 75,500 on both venues; Yes gets cheaper as the strike rises. */
function ladder(overrides: Partial<Record<number, { k?: VenueQuote | null; p?: VenueQuote | null }>> = {}): Ladder {
  const strikes = [74000, 74250, 74500, 74750, 75000, 75250, 75500];
  const buckets = strikes.map((s) => ({ key: `above:${s}`, kind: "above" as const, level: s, settlesAt: SETTLE }));
  const quotes: VenueQuote[] = [];
  strikes.forEach((s, i) => {
    const yes = 90 - i * 12;
    const o = overrides[s] ?? {};
    const k = o.k === undefined ? q("kalshi", s, yes, yes + 1) : o.k;
    const p = o.p === undefined ? q("polymarket_us", s, yes - 1, yes + 1) : o.p;
    if (k) quotes.push(k);
    if (p) quotes.push(p);
  });
  return { id: "btc-hourly:KXBTCD-26NOV0917", title: "t", settlesAt: SETTLE, buckets, quotes, model: {} };
}

test("strikes: at the money is the listed strike nearest spot, the neighbours are the ladder's own next strikes, the edges clamp", () => {
  const levels = strikeLevels(ladder());
  assert.deepEqual(levels, [74000, 74250, 74500, 74750, 75000, 75250, 75500]);
  assert.equal(gridStep(levels), 250);
  assert.deepEqual(selectStrikes(levels, 74812), { below: 74500, atm: 74750, above: 75000 });
  assert.deepEqual(selectStrikes(levels, 74880), { below: 74750, atm: 75000, above: 75250 });
  assert.deepEqual(selectStrikes(levels, 60000), { below: 74000, atm: 74250, above: 74500 }, "spot below the ladder: the bottom three");
  assert.deepEqual(selectStrikes(levels, 99000), { below: 75000, atm: 75250, above: 75500 }, "spot above the ladder: the top three");
  assert.equal(selectStrikes([74000, 74250], 74100), null, "two strikes cannot give one each way");
  assert.equal(selectStrikes(levels, 0), null);
  // a venue skipping a strike reads as the next listed one, not a made-up level
  assert.deepEqual(selectStrikes([74000, 74500, 75000], 74600), { below: 74000, atm: 74500, above: 75000 });
});

test("both sides: Yes at one venue's ask plus No at 100 minus the other's bid, both fees, the cheaper direction; under 100 is a cross", () => {
  // Kalshi 60/61, Poly 59/62. Yes on Kalshi 61 + No on Poly (100 − 59 = 41) = 102 + fees 1.666 + 2.299; Yes on Poly 62 + No on Kalshi 40 = 102 + fees 2.239 + 1.68.
  // Poly's fee is the larger coefficient, so it is cheaper to take Poly at the leg nearer 50¢ and Kalshi at the other.
  const k = q("kalshi", 74750, 60, 61, 300, 200);
  const p = q("polymarket_us", 74750, 59, 62, 150, 400);
  const l = lockOf(k, p);
  assert.ok(l);
  assert.equal(l.yesOn, "polymarket_us");
  assert.equal(l.noOn, "kalshi");
  assert.equal(l.yesAtCents, 62);
  assert.equal(l.noAtCents, 40);
  assert.ok(Math.abs(l.feesCents - 3.92) < 0.02, `fees ${l.feesCents}`);
  assert.ok(Math.abs(l.costCents - 105.92) < 0.02);
  assert.ok(Math.abs(l.edgeCents + 5.92) < 0.02);
  assert.equal(l.qty, 300, "the thinner of Poly's offer (400) and Kalshi's bid (300)");

  // a cross: Poly offers Yes at 40 while Kalshi bids 45 → Yes on Poly 40 + No on Kalshi 55 = 95 + fees 2.28 + 1.733 = 99.01
  const cross = lockOf(q("kalshi", 75000, 45, 46, 500, 500), q("polymarket_us", 75000, 38, 40, 500, 500));
  assert.ok(cross);
  assert.equal(cross.yesOn, "polymarket_us");
  assert.ok(Math.abs(cross.edgeCents - 0.99) < 0.02, `edge ${cross.edgeCents}`);

  // one venue with offers only still prices one direction; no bid anywhere prices none
  const oneWay = lockOf(q("kalshi", 75000, 0, 46), q("polymarket_us", 75000, 44, 0));
  assert.ok(oneWay && oneWay.yesOn === "kalshi" && oneWay.noOn === "polymarket_us");
  assert.equal(lockOf(q("kalshi", 75000, 0, 46), q("polymarket_us", 75000, 0, 47)), null);
  assert.equal(lockOf(null, p), null);
});

test("clean score: tight, deep and in agreement scores high; wide, thin or apart scores low; one-sided is not scored", () => {
  assert.equal(cleanScore(2, 300, 0), 92);
  assert.equal(cleanScore(0, 200, 0), 100);
  assert.equal(cleanScore(10, 0, 5), 0);
  assert.ok((cleanScore(4, 100, 1) as number) > (cleanScore(4, 100, 3) as number), "closer mids score higher");
  assert.ok((cleanScore(2, 50, 1) as number) > (cleanScore(6, 50, 1) as number), "tighter books score higher");
  assert.ok((cleanScore(2, 200, 1) as number) > (cleanScore(2, 20, 1) as number), "deeper books score higher");
  assert.equal(cleanScore(null, 100, 0), null);
  assert.equal(cleanScore(2, 100, null), null);
});

test("horizon set: the three pairs carry both legs, the gap, the lock, the links and a reading; one-sided and unlisted strikes are said plainly", () => {
  const l = ladder({
    75000: { p: q("polymarket_us", 75000, 42, 0, 300, 0) }, // Poly bids only at the strike above
    75250: { p: null }, // Poly does not list this one
  });
  const s = horizonSet("hourly", l, "poly:btc-above-day-2026-11-09:range:2026-11-09", 74812, NOW, new Map(), urls);
  assert.ok(s);
  assert.equal(s.stepUsd, 250);
  assert.equal(s.minutesToClose, 40);
  assert.deepEqual(s.venues, { kalshi: true, poly: true });
  assert.equal(s.kalshiEvent, "KXBTCD-26NOV0917");
  assert.equal(s.polyEvent, "btc-above-day-2026-11-09");
  assert.deepEqual(s.pairs.map((p) => [p.place, p.strike]), [["below", 74500], ["atm", 74750], ["above", 75000]]);

  const atm = s.pairs[1];
  assert.equal(atm.kalshi?.url, "https://kalshi.com/markets/kxbtcd/x/kxbtcd-26nov0917");
  assert.equal(atm.poly?.url, "https://polymarket.us/event/btc-above-day-2026-11-09");
  assert.equal(atm.twoSided, true);
  // Kalshi 54/55 (mid 54.5), Poly 53/55 (mid 54): gap +0.5, spreads 1 + 2
  assert.equal(atm.gapCents, 0.5);
  assert.equal(atm.spreadCents, 3);
  assert.equal(atm.depth, 100);
  assert.ok(atm.score !== null && atm.score > 60, `score ${atm.score}`);
  assert.ok(atm.lock && atm.lock.costCents > 100, "no cross in a symmetric book");
  assert.match(atm.reading, /spreads add to 3¢ · 100 contracts at the thinnest level · mids agree/);

  const above = s.pairs[2];
  assert.equal(above.twoSided, false);
  assert.equal(above.score, null);
  assert.equal(above.reading, "Polymarket US has bids only");
  assert.ok(above.lock, "Yes on Kalshi against Poly's bid still prices");

  // the context strip is mids only, around the money
  assert.ok(s.context.length >= 5);
  assert.equal(s.context.find((r) => r.strike === 75250)?.polyMid, null);

  // a strike on the grid that neither venue quotes reads as such
  const thin = horizonSet("daily", ladder({ 74000: { k: null, p: null } }), null, 74000, NOW, new Map(), urls);
  assert.ok(thin);
  assert.equal(thin.pairs[0].strike, 74000);
  assert.equal(thin.pairs[0].reading, "neither venue lists this strike");
  assert.equal(thin.pairs[0].lock, null);
});

test("persistence: the window's readings, how often the gap kept this sign, its mean; the bundle ranks by score then locked edge", () => {
  const history: GapHistory = new Map();
  const l = ladder();
  const set = horizonSet("hourly", l, null, 74812, NOW, history, urls);
  assert.ok(set);
  assert.equal(JSON.stringify(set.pairs[1].persistence), "null", "nothing before the first reading");
  for (let i = 0; i < 5; i += 1) recordGaps(history, [set], NOW + i * 10_000, 60 * 60_000);
  const h = history.get(gapHistoryKey(SETTLE, "above:74750"));
  assert.equal(h?.length, 5);
  assert.equal(set.pairs[1].persistence?.n, 5, "recording refreshes the pair's own reading");
  assert.equal(set.pairs[1].persistence?.sameSign, 1);
  assert.equal(set.pairs[1].persistence?.meanGapCents, 0.5);
  // the window drops old readings
  recordGaps(history, [set], NOW + 2 * 60 * 60_000, 60 * 60_000);
  assert.equal(history.get(gapHistoryKey(SETTLE, "above:74750"))?.length, 1);

  const p = persistenceOf(
    [
      [1, 1.5],
      [2, -0.2],
      [3, 2],
      [4, 1],
    ],
    1.2,
  );
  assert.ok(p);
  assert.equal(p.sameSign, 0.75, "the −0.2 reading is neither this sign nor half a cent");
  assert.equal(p.meanGapCents, 1.08);
  assert.equal(persistenceOf([[1, 1]], 1), null);
  assert.equal(persistenceOf(undefined, 1), null);

  const wide = ladder({ 74750: { k: q("kalshi", 74750, 50, 56, 5, 5), p: q("polymarket_us", 74750, 49, 57, 5, 5) } });
  const other = horizonSet("daily", { ...wide, settlesAt: "2026-11-10T22:00:00Z" }, null, 74812, NOW, new Map(), urls);
  const bundle = bundleOf([set, other]);
  assert.equal(bundle.length, 6);
  assert.ok(bundle.every((x, i, a) => i === 0 || (a[i - 1].score as number) >= (x.score as number)), "best first");
  assert.equal(bundle[bundle.length - 1].strike, 74750);
  assert.equal(bundle[bundle.length - 1].horizon, "daily", "the wide, thin pair is last");
});

test("helpers: the Kalshi event ticker and the Polymarket US event slug come out of the ids", () => {
  assert.equal(kalshiEventTicker("KXBTCD-26NOV0917-T74499.99"), "KXBTCD-26NOV0917");
  assert.equal(kalshiEventTicker("KXBTCD"), "KXBTCD");
  assert.equal(polyEventSlug("poly:btc-above-hr-2026-11-09-2100z:range:2026-11-09"), "btc-above-hr-2026-11-09-2100z");
  assert.equal(polyEventSlug("btc-hourly:KXBTCD-26NOV0917"), null);
});

test("page: the bundle, both tables, the lock arithmetic, the links, the refresh script; no em dash; the 5 PM contract is named as such", () => {
  const history: GapHistory = new Map();
  const hourly = horizonSet("hourly", ladder(), "poly:btc-above-day-2026-11-09:range:2026-11-09", 74812, NOW, history, urls);
  const daily = horizonSet("daily", { ...ladder(), settlesAt: "2026-11-10T22:00:00Z" }, "poly:btc-above-day-2026-11-10:range:2026-11-10", 74812, NOW, history, urls);
  for (let i = 0; i < 3; i += 1) recordGaps(history, [hourly, daily], NOW + i * 10_000, 60 * 60_000);
  const d: PairsReport = {
    at: new Date(NOW).toISOString(),
    spotUsd: 74812,
    spotSource: "BRTI",
    intervalSec: 10,
    historyPoints: 3,
    collectingSince: new Date(NOW - 60_000).toISOString(),
    hourly,
    daily,
    bundle: bundleOf([hourly, daily]),
    health: { kalshi: { ok: true, ms: 40 }, polymarket_us: { ok: false, ms: 20000, detail: "no answer within 20s" } },
  };
  const html = renderPairsHtml(d, { token: "abc", base: "/pairs", launchUrl: "https://engine.example/btc" });
  for (const needle of [
    "BTC pairs <small>Kalshi and Polymarket US",
    "$74,812",
    `Cleanest now <b>$${d.bundle[0].strike.toLocaleString("en-US")}</b>`,
    "Next close, the 5 PM ET contract",
    "Daily, 5 PM ET",
    "$74,750</b><small>at the money",
    "cleanest</span>",
    'data-id="KXBTCD-26NOV0917-T74749.99"',
    'data-open="https://kalshi.com/markets/kxbtcd/x/kxbtcd-26nov0917|https://polymarket.us/event/btc-above-day-2026-11-09"',
    ">Launch</button>",
    "Yes P 55 + No K 46 + fees 4.09¢ · 100",
    "100% same sign · 3",
    "polymarket_us no answer within 20s",
    'value="https://engine.example/btc"',
    'var BASE="/pairs",Q="?k=abc&"',
    "fetch(BASE+'/fragment'+Q+'t='",
    "fetch(BASE+'/api/pair'+Q+'id='",
    "<code>GET /pairs/api/bundle</code>",
    "<code>GET /pairs/api/stream</code>",
    "nothing here places an order.",
  ]) {
    assert.ok(html.includes(needle), `page shows ${needle}`);
  }
  assert.ok(!html.includes("—"), "no em dash in the page");
  assert.ok(!/Hourly, next close<\/h2>/.test(html), "the 5 PM close is not called hourly");
  assert.ok(renderPairsBody(d).startsWith('<div class="strip">'), "the fragment is the body only");
  assert.equal((html.match(/>Launch<\/button>/g) ?? []).length, 6, "one Launch per pair");

  const bare = renderPairsHtml({ ...d, hourly: null, daily: null, bundle: [] });
  assert.ok(bare.includes("no strike two-sided on both"));
  assert.ok(bare.includes("No contract closes within 90 minutes on either venue."));
  assert.ok(bare.includes('var BASE="",Q="?"'), "no base and no token: root-relative fetches");
});
