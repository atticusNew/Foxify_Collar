/**
 * BTC pairs: strike selection off spot, the cheapest way to own both sides after both fees,
 * the clean score, gap persistence, the bands between strikes, the regime gauge, the 15-minute
 * window, the bundle order, and the page.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_NOT_SERVED_YET_MS, bandOf, bookFailureOf, bundleOf, cleanScore, fifteenSet, gapHistoryKey, horizonSet, kalshiEventTicker, lockOf, pairId, persistenceOf, polyEventSlug, recordGaps, regimeOf, selectStrikes, sigmaToClose, gridStep, strikeLevels, type GapHistory, type PairsReport, type StrikePair, type VenueUrls } from "../src/btcCurve/pairs";
import { pickLabel, renderPairsBody, renderPairsHtml } from "../src/btcCurve/pairsHtml";
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

/** The 15-minute window: one strike (the price to beat) on both venues, at the same close. */
function fifteenLadder(kBid = 51, kAsk = 52, pBid = 73, pAsk = 74): Ladder {
  const level = 73158.07;
  const settlesAt = "2026-11-09T21:30:00Z";
  const k: VenueQuote = { venue: "kalshi", bucketKey: `above:${level}`, id: "KXBTC15M-26NOV091630-15", bidCents: kBid, askCents: kAsk, bidQty: 2000, askQty: 1600, volume: 0, openInterest: 0, feeTheta: 0.07 };
  const p: VenueQuote = { venue: "polymarket_us", bucketKey: `above:${level}`, id: "cpc-btc-updown-15m-2026-11-09-2115z", bidCents: pBid, askCents: pAsk, bidQty: 1800, askQty: 9, volume: 0, openInterest: 0, feeTheta: 0.095 };
  return { id: "btc-15m:KXBTC15M-26NOV091630", title: "t", settlesAt, buckets: [{ key: `above:${level}`, kind: "above", level, settlesAt }], quotes: [k, p], model: {} };
}

/** An hour of index prints, one a second: a quiet 45 minutes then a wide 15. */
function prints(quietUsd: number, loudUsd: number, start = NOW - 60 * 60_000): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= 3600; i += 1) {
    const t = start + i * 1000;
    const amp = i < 2700 ? quietUsd : loudUsd;
    out.push([t, 74800 + amp * Math.sin(i / 37) + (i % 2 ? 0.5 : -0.5)]);
  }
  return out;
}

test("sigma and regime: one sigma to the close from the trailing vol; the last 15 minutes against the hour say contained, steady or expanding", () => {
  assert.equal(sigmaToClose(75000, 50, 60), 401, "about $400 an hour at 50% on $75k");
  assert.equal(sigmaToClose(75000, 50, 15), 200);
  assert.equal(sigmaToClose(75000, null, 60), null);
  assert.equal(sigmaToClose(75000, 50, 0), null);

  const expanding = regimeOf(prints(20, 400), NOW);
  assert.ok(expanding.m15 && expanding.m60);
  assert.equal(expanding.m15.minutes, 15);
  assert.ok(expanding.m15.rangeUsd > 600 && expanding.m15.rangeUsd < 900, `15-minute range ${expanding.m15.rangeUsd}`);
  assert.ok((expanding.m15.volPct as number) > 1.4 * (expanding.m60.volPct as number), `${expanding.m15.volPct} vs ${expanding.m60.volPct}`);
  assert.equal(expanding.label, "expanding");
  assert.match(expanding.reading, /^expanding: last 15 min: range \$\d+, net [+−]\$\d+, realized \d+% · last hour: range \$\d+, realized \d+%$/);

  const quiet = regimeOf(prints(400, 400).map(([t, v], i) => [t, i >= 2700 ? 74800 + 3 * Math.sin(i / 37) : v]), NOW);
  assert.equal(quiet.label, "contained");

  const steady = regimeOf(prints(120, 120), NOW);
  assert.equal(steady.label, "steady");

  const few = regimeOf(prints(50, 50).slice(3590), NOW);
  assert.equal(few.m15?.volPct, null, "ten seconds of prints give no vol");
  assert.equal(few.label, null);
  assert.equal(regimeOf([], NOW).reading, "not enough index prints yet");
});

test("band: Yes just below plus No just above; the venues' mids imply it, the cheapest legs price it, the model and the sigmas size it", () => {
  const s = horizonSet("hourly", ladder(), null, 74812, NOW, new Map(), urls, { volPct: 50 });
  assert.ok(s);
  // 40 minutes at 50% on $74,812: sigma about $326
  assert.equal(s.sigmaUsd, 326);
  assert.equal(s.bands.length, 2);
  const b = s.bands[0];
  assert.equal(b.lower, 74500);
  assert.equal(b.upper, 74750);
  assert.equal(b.widthUsd, 250);
  // lower: K 66/67 (mid 66.5), P 65/67 (mid 66); upper: K 54/55 (54.5), P 53/55 (54): both venues imply 12
  assert.equal(b.impliedKalshiCents, 12);
  assert.equal(b.impliedPolyCents, 12);
  assert.equal(b.impliedCents, 12);
  // cheapest: Yes on Kalshi at 67 (fee 1.548) + No on Kalshi at 46 (fee 1.739) = 116.287, less the $1 one leg always pays
  assert.ok(b.cost);
  assert.deepEqual(b.cost.legs.map((l) => [l.venue, l.side, l.strike, l.priceCents]), [["kalshi", "yes", 74500, 67], ["kalshi", "no", 74750, 46]]);
  assert.ok(Math.abs(b.cost.costCents - 16.29) < 0.02, `cost ${b.cost.costCents}`);
  assert.ok(Math.abs(b.cost.feesCents - 3.29) < 0.02);
  assert.equal(b.cost.qty, 100);
  assert.ok(Math.abs((b.edgeCents as number) + 4.29) < 0.02, "the band costs 4.29¢ over what the venues' own mids say");
  assert.equal(b.sigmas, 0.77);
  // model: P(>= 74500) − P(>= 74750) under a $327 normal around 74,812
  assert.ok(b.modelCents !== null && b.modelCents > 25 && b.modelCents < 32, `model ${b.modelCents}`);
  assert.ok((s.pairs[1].modelCents as number) > 55 && (s.pairs[1].modelCents as number) < 60, "the money is a little above spot");

  // a cross: Poly offers Yes at the lower strike below Kalshi's bid at the upper
  const x = bandOf(
    { ...s.pairs[0], poly: { ...(s.pairs[0].poly as NonNullable<typeof s.pairs[0]["poly"]>), askCents: 50 } },
    { ...s.pairs[1], kalshi: { ...(s.pairs[1].kalshi as NonNullable<typeof s.pairs[1]["kalshi"]>), bidCents: 60 } },
    74812,
    null,
  );
  assert.ok(x.cost && x.cost.legs[0].venue === "polymarket_us" && x.cost.legs[1].venue === "kalshi");
  assert.ok(x.cost.costCents < 0 && (x.edgeCents as number) > 0, `a band bought below zero is a cross: ${x.cost.costCents}`);
  assert.equal(x.sigmas, null);
  assert.equal(x.modelCents, null);

  // no bid at the upper strike anywhere: the band cannot be bought, the mids may still imply it
  const none = bandOf(s.pairs[0], { ...s.pairs[1], kalshi: null, poly: null }, 74812, 326);
  assert.equal(none.cost, null);
  assert.equal(none.impliedCents, null);
  assert.equal(none.edgeCents, null);

  // without a vol there is no sigma, no model column, and the set still prices the bands
  const noVol = horizonSet("hourly", ladder(), null, 74812, NOW, new Map(), urls);
  assert.ok(noVol);
  assert.equal(noVol.sigmaUsd, null);
  assert.equal(noVol.pairs[1].modelCents, null);
  assert.equal(noVol.bands[0].cost?.costCents, b.cost.costCents);
  assert.equal(noVol.pick, pairId(noVol.pairs[0]), "three equal scores: the pick is the one with the smallest carry");
});

test("fifteen: one strike, the price to beat, on both venues; a wide gap locks; no bands; the pick is the one row", () => {
  const s = fifteenSet(fifteenLadder(), "poly:btc-updown-15m-2026-11-09-2115z:range:2026-11-09", 73214, Date.parse("2026-11-09T21:27:40Z"), new Map(), urls, { volPct: 48 });
  assert.ok(s);
  assert.equal(s.horizon, "fifteen");
  assert.equal(s.stepUsd, 0);
  assert.equal(s.secondsToClose, 140);
  assert.equal(s.minutesToClose, 2);
  assert.deepEqual(s.bands, []);
  assert.deepEqual(s.context, []);
  assert.equal(s.pairs.length, 1);
  const p = s.pairs[0];
  assert.equal(p.place, "atm");
  assert.equal(p.strike, 73158.07);
  assert.equal(pairId(p), "KXBTC15M-26NOV091630-15");
  assert.equal(s.pick, pairId(p));
  assert.equal(p.gapCents, -22, "Kalshi 51/52 against Poly 73/74");
  assert.ok(p.lock && p.lock.yesOn === "kalshi" && p.lock.noOn === "polymarket_us" && p.lock.edgeCents > 17, `Yes K 52 + No P 27 + fees locks ${p.lock?.edgeCents}`);
  assert.ok(p.score !== null && p.score < 60, "mids 22¢ apart score low on agreement");
  // 140 seconds at 48% on $73,214: sigma about $74; spot $56 above the price to beat
  assert.equal(s.sigmaUsd, 74);
  assert.ok((p.modelCents as number) > 70 && (p.modelCents as number) < 80, `model ${p.modelCents}`);
  assert.equal(pickLabel(p), "$73,158.07 price to beat");

  assert.equal(fifteenSet({ ...fifteenLadder(), buckets: [], quotes: [] }, null, 73214, NOW, new Map(), urls), null);
  // Polymarket US alone still makes the set
  const alone = fifteenSet({ ...fifteenLadder(), quotes: fifteenLadder().quotes.filter((q) => q.venue === "polymarket_us") }, null, 73214, NOW, new Map(), urls);
  assert.ok(alone && alone.pairs[0].kalshi === null && alone.pairs[0].poly);
  assert.equal(alone.pick, alone.pairs[0].poly?.id, "nothing scored: the money's own id");
});

test("a failed book in plain words: a 404 in the first minutes after the open is the venue not serving the book yet; anything else is what happened; the listing's price is kept apart", () => {
  const opened = Date.parse("2026-11-09T21:15:00Z");
  const failed = (over: Partial<VenueQuote> = {}, failure: Partial<NonNullable<VenueQuote["failure"]>> = {}): VenueQuote => ({
    ...q("polymarket_us", 74750, 47, 48, 0, 0),
    openedAt: new Date(opened).toISOString(),
    failure: { kind: "http", status: 404, url: "https://gateway.polymarket.us/v1/markets/x/book", detail: "HTTP 404", cacheAgeSec: 225, ...failure },
    ...over,
  });
  const early = bookFailureOf(failed(), opened + 97_000);
  assert.ok(early);
  assert.equal(early.kind, "not_served_yet");
  assert.equal(early.reason, "Poly has listed this contract but is not serving its book yet (usual for a few minutes after it opens)");
  assert.deepEqual(early.listing, { bidCents: 47, askCents: 48 });
  assert.equal(early.url, "https://gateway.polymarket.us/v1/markets/x/book");
  assert.equal(early.cacheAgeSec, 225);
  assert.ok(!early.reason.includes("http"), "the words carry no URL");

  assert.equal(bookFailureOf(failed(), opened + BOOK_NOT_SERVED_YET_MS)?.kind, "not_served_yet", "the bound is inclusive");
  const late = bookFailureOf(failed(), opened + BOOK_NOT_SERVED_YET_MS + 1);
  assert.equal(late?.kind, "http");
  assert.equal(late?.reason, "Poly book did not answer (HTTP 404)");
  assert.equal(bookFailureOf(failed({ openedAt: undefined }), opened + 5_000)?.reason, "Poly book did not answer (HTTP 404)", "no open time on the listing: no guess");
  assert.equal(bookFailureOf(failed(), opened - 1_000)?.kind, "http", "before the open is not the opening gap");
  assert.equal(bookFailureOf(failed({}, { status: 500 }), opened + 5_000)?.reason, "Poly book did not answer (HTTP 500)");
  assert.equal(bookFailureOf(failed({}, { kind: "timeout", status: null }), opened + 5_000)?.reason, "Poly book did not answer (timed out)");
  assert.equal(bookFailureOf(failed({}, { kind: "unreachable", status: null }), opened + 5_000)?.reason, "Poly book did not answer (no connection)");
  assert.equal(bookFailureOf(failed({ venue: "kalshi" }), opened + 5_000)?.reason, "Kalshi has listed this contract but is not serving its book yet (usual for a few minutes after it opens)");
  assert.equal(bookFailureOf(failed({ bidCents: 0, askCents: 100 }), opened + 5_000)?.listing, null, "a listing with no price shows none");
  assert.deepEqual(bookFailureOf(failed({ bidCents: 0, askCents: 48 }), opened + 5_000)?.listing, { bidCents: 0, askCents: 48 });
  assert.equal(bookFailureOf(q("kalshi", 74750, 50, 51), opened), null, "a quote that was read has no failure");

  // in a set: the failed venue's leg is absent, nothing on the row is priced, the row is never the pick, its neighbours are whole
  const l = ladder({ 74750: { p: failed() } });
  const s = horizonSet("hourly", l, "poly:btc-above-day-2026-11-09:range:2026-11-09", 74812, opened + 60_000, new Map(), urls, { volPct: 50 });
  assert.ok(s);
  const atm = s.pairs[1];
  assert.equal(atm.poly, null);
  assert.ok(atm.kalshi);
  assert.deepEqual([atm.gapCents, atm.spreadCents, atm.depth, atm.lock, atm.score, atm.persistence], [null, null, null, null, null, null]);
  assert.equal(atm.errors.length, 1);
  assert.equal(atm.reading, atm.errors[0].reason);
  assert.equal(pairId(atm), atm.kalshi.id);
  assert.ok(s.pick && s.pick !== pairId(atm));
  assert.deepEqual(s.pairs[0].errors, []);
  assert.ok(s.pairs[0].lock && s.pairs[2].lock);
  // the bands price off the books that answered: no Poly leg at the failed strike, and the venues' implied leaves Poly out there
  assert.equal(s.bands[0].impliedPolyCents, null);
  assert.ok(s.bands[0].cost && s.bands[0].cost.legs[1].venue === "kalshi");
  assert.ok(s.bands[1].cost && s.bands[1].cost.legs[0].venue === "kalshi");
  // the one row of a tenor failing leaves it with nothing to launch
  const only = fifteenSet({ ...fifteenLadder(), quotes: fifteenLadder().quotes.map((x) => (x.venue === "polymarket_us" ? { ...x, failure: failed().failure } : x)) }, null, 73214, opened + 60_000, new Map(), urls);
  assert.equal(only?.pick, null);
  assert.equal(only?.pairs[0].errors[0].reason, "Poly book did not answer (HTTP 404)");
});

test("helpers: the Kalshi event ticker and the Polymarket US event slug come out of the ids", () => {
  assert.equal(kalshiEventTicker("KXBTCD-26NOV0917-T74499.99"), "KXBTCD-26NOV0917");
  assert.equal(kalshiEventTicker("KXBTCD"), "KXBTCD");
  assert.equal(polyEventSlug("poly:btc-above-hr-2026-11-09-2100z:range:2026-11-09"), "btc-above-hr-2026-11-09-2100z");
  assert.equal(polyEventSlug("btc-hourly:KXBTCD-26NOV0917"), null);
});

test("page: the bundle, both tables, the lock arithmetic, the links, the refresh script; no em dash; the 5 PM contract is named as such", () => {
  const history: GapHistory = new Map();
  const hourly = horizonSet("hourly", ladder(), "poly:btc-above-day-2026-11-09:range:2026-11-09", 74812, NOW, history, urls, { volPct: 50 });
  const daily = horizonSet("daily", { ...ladder(), settlesAt: "2026-11-10T22:00:00Z" }, "poly:btc-above-day-2026-11-10:range:2026-11-10", 74812, NOW, history, urls, { volPct: 50 });
  for (let i = 0; i < 3; i += 1) recordGaps(history, [hourly, daily], NOW + i * 10_000, 60 * 60_000);
  const fifteen = fifteenSet(fifteenLadder(), "poly:btc-updown-15m-2026-11-09-2115z:range:2026-11-09", 74812, NOW, history, urls, { volPct: 48 });
  const regime = regimeOf(prints(20, 400), NOW);
  const d: PairsReport = {
    at: new Date(NOW).toISOString(),
    spotUsd: 74812,
    spotSource: "BRTI",
    intervalSec: 10,
    historyPoints: 3,
    collectingSince: new Date(NOW - 60_000).toISOString(),
    fifteen,
    hourly,
    daily,
    regime,
    bundle: bundleOf([fifteen, hourly, daily]),
    health: { kalshi: { ok: true, ms: 40 }, polymarket_us: { ok: false, ms: 20000, detail: "no answer within 20s" } },
  };
  const html = renderPairsHtml(d, { token: "abc", base: "/pairs", launchUrl: "https://engine.example/btc", launchMode: "open" });
  for (const needle of [
    "BTC pairs <small>Kalshi and Polymarket US",
    "$74,812",
    `Cleanest now <b>$${d.bundle[0].strike.toLocaleString("en-US")}</b>`,
    "Regime <b class=\"hot\">expanding</b>",
    "Next 15 minutes, up or down",
    "$73,158.07</b><small>BRTI +$1,654 above",
    "Next close, the 5 PM ET contract",
    "Daily, 5 PM ET",
    "$74,750</b><small>at the money",
    "cleanest</span>",
    `<section data-horizon="hourly" data-pick="${hourly?.pick}">`,
    '<tr class="atm" data-id="KXBTCD-26NOV0917-T74749.99" data-label="$74,750 at the money">',
    `<button type="button" class="go" data-horizon="hourly">Launch</button><span class="picklabel">${pickLabel(hourly?.pairs[0] as StrikePair)}</span><small class="status" data-status="hourly"></small>`,
    '<button type="button" class="use" data-id="KXBTCD-26NOV0917-T74999.99" data-horizon="hourly"',
    '<section data-horizon="fifteen" data-pick="KXBTC15M-26NOV091630-15">',
    '<span class="picklabel">$73,158.07 price to beat</span>',
    "Band $74,500 to $74,750</span>",
    "venues imply <b>12.0¢</b> <span class=\"dim\">(K 12.0 / P 12.0)</span> · model <b>",
    "own it for <b>16.3¢</b>: Yes K 67 + No K 46 + fees 3.3¢ · 100 · costs 4.3¢ over the mids",
    "Yes P 55 + No K 46 + fees 4.09¢ · 100",
    "100% same sign · 3",
    "polymarket_us no answer within 20s",
    'value="https://engine.example/btc"',
    '<input type="radio" name="mode" value="open" checked>',
    'var BASE="/pairs",Q="?k=abc&"',
    "fetch(BASE+'/fragment'+Q+'t='",
    "fetch(BASE+'/api/pair'+Q+'id='",
    "atticus:'btc_pair'",
    "<code>GET /pairs/api/bundle</code>",
    "<code>GET /pairs/api/stream</code>",
    "nothing here places an order.",
  ]) {
    assert.ok(html.includes(needle), `page shows ${needle}`);
  }
  assert.ok(!html.includes("—"), "no em dash in the page");
  assert.ok(!/Hourly, next close<\/h2>/.test(html), "the 5 PM close is not called hourly");
  assert.ok(renderPairsBody(d).startsWith('<div class="strip">'), "the fragment is the body only");
  assert.equal((html.match(/>Launch<\/button>/g) ?? []).length, 3, "one Launch per tenor");
  assert.equal((html.match(/class="use"/g) ?? []).length, 6, "a use button on each strike row of the ladders, none on the one-row window");
  assert.equal((html.match(/<tr class="band">/g) ?? []).length, 4, "two bands per ladder");
  assert.ok(!html.includes("data-open="), "no per-row venue buttons");

  const bare = renderPairsHtml({ ...d, fifteen: null, hourly: null, daily: null, regime: null, bundle: [] });
  assert.ok(bare.includes("no strike two-sided on both"));
  assert.ok(bare.includes("Regime <b>–</b>"));
  assert.ok(bare.includes("No 15-minute window open on either venue"));
  assert.ok(bare.includes("No contract closes within 90 minutes on either venue."));
  assert.ok(bare.includes('var BASE="",Q="?"'), "no base and no token: root-relative fetches");
  assert.ok(bare.includes('<input type="radio" name="mode" value="send" checked>'), "send is the default mode");
  assert.equal((bare.match(/>Launch<\/button>/g) ?? []).length, 0);
});
