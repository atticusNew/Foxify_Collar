/**
 * BTC pairs: strike selection off spot, the cheapest way to own both sides after both fees,
 * the clean score, gap persistence, the bands between strikes, the regime gauge, the 15-minute
 * window, the bundle order, and the page.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_NOT_SERVED_YET_MS, EPISODE_KEEP, EPISODE_LABEL, EPISODE_MIN_CYCLES, STALE_AFTER_SEC, bandOf, closeEpisodes, emptyEpisodeBook, episodeSummary, lockEpisodesReport, lockSightings, pruneEpisodes, stepEpisodes, unjudgedPairs, type EpisodeBook, type LockEpisode, type LockSighting, bookFailureOf, bundleOf, cleanScore, fifteenSet, gapHistoryKey, freshnessOf, horizonSet, kalshiEventTicker, legReadOf, lockOf, pairId, persistenceOf, polyEventSlug, recordGaps, regimeOf, selectStrikes, sigmaToClose, staleBoundsFrom, gridStep, strikeLevels, type GapHistory, type PairsReport, type StrikePair, type VenueUrls } from "../src/btcCurve/pairs";
import { pickLabel, readLine, renderPairsBody, renderPairsHtml } from "../src/btcCurve/pairsHtml";
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

test("read age: three clocks kept apart (our fetch, the venue's cache, the venue's stamp), measured to the pricing; the copy's age is fetch plus cache; the line says each for what it is", () => {
  const priced = Date.parse("2026-11-10T21:19:45.000Z");
  const poly = legReadOf({ fetchedAtMs: priced - 1_240, cacheAgeSec: 18, venueAtMs: Date.parse("2026-11-10T21:19:13.960Z"), state: "MARKET_STATE_OPEN" }, priced);
  assert.deepEqual(poly, {
    fetchedAt: "2026-11-10T21:19:43.760Z",
    fetchAgeSec: 1.2,
    cacheAgeSec: 18,
    venueAt: "2026-11-10T21:19:13.960Z",
    venueAgeSec: 31,
    ageSec: 19.2,
    state: "MARKET_STATE_OPEN",
  });
  assert.equal(readLine(poly), "read 1s ago · 18s in the venue's cache · venue stamp 31s old");

  const kalshi = legReadOf({ fetchedAtMs: priced - 2_960, cacheAgeSec: null, venueAtMs: null, state: null }, priced);
  assert.ok(kalshi);
  assert.deepEqual([kalshi.fetchAgeSec, kalshi.cacheAgeSec, kalshi.venueAt, kalshi.venueAgeSec, kalshi.ageSec], [3, null, null, null, 3]);
  assert.equal(readLine(kalshi), "read 3s ago · venue stamp not given", "no stamp is said, not invented");

  // a venue clock a little ahead of ours is an age of zero, not a negative one
  assert.equal(legReadOf({ fetchedAtMs: priced, cacheAgeSec: 0, venueAtMs: priced + 400, state: null }, priced)?.venueAgeSec, 0);
  assert.equal(legReadOf(undefined, priced), null);
  assert.equal(readLine(null), "");

  // a quote that never came from a book read (a fixture, a listing) carries no read
  const s = horizonSet("hourly", ladder(), null, 74812, NOW, new Map(), urls);
  assert.equal(s?.pairs[1].kalshi?.read, null);
  const stamped = ladder({ 74750: { k: { ...q("kalshi", 74750, 54, 55), read: { fetchedAtMs: NOW - 500, cacheAgeSec: null, venueAtMs: null, state: null } } } });
  const t = horizonSet("hourly", stamped, null, 74812, NOW, new Map(), urls, { pricedAtMs: NOW + 700 });
  assert.equal(t?.pairs[1].kalshi?.read?.fetchAgeSec, 1.2, "measured to the pricing moment, not the cycle's start");
  assert.equal(horizonSet("hourly", stamped, null, 74812, NOW, new Map(), urls)?.pairs[1].kalshi?.read?.fetchAgeSec, 0.5, "which defaults to the cycle's own time");
});

/** A quote as the collector leaves it after reading its book: fetched `fetchAgeSec` before NOW, from a copy the venue's cache had held `cacheAgeSec`. */
function readAt(quote: VenueQuote, fetchAgeSec: number, cacheAgeSec: number | null = null, stampAgeSec: number | null = null): VenueQuote {
  return { ...quote, read: { fetchedAtMs: NOW - fetchAgeSec * 1000, cacheAgeSec, venueAtMs: stampAgeSec === null ? null : NOW - stampAgeSec * 1000, state: null } };
}

/** The $250 ladder with every book read a second ago; `polyCache` is how long Polymarket US's cache had held each strike's copy. */
function readLadder(polyCache: Partial<Record<number, number>> = {}, cross: number | null = null): Ladder {
  const l = ladder();
  return {
    ...l,
    quotes: l.quotes.map((x) => {
      const strike = Number(x.bucketKey.split(":")[1]);
      if (x.venue === "kalshi") return readAt(strike === cross ? { ...x, bidCents: x.bidCents + 8, askCents: x.askCents + 8 } : x, 1);
      return readAt(x, 1, polyCache[strike] ?? 4, (polyCache[strike] ?? 4) + 1);
    }),
  };
}

test("stale bounds: 15 seconds on the 15-minute window, 30 on the hourly and daily, overridable per tenor; a read is stale when either copy is older than the bound", () => {
  assert.deepEqual(STALE_AFTER_SEC, { fifteen: 15, hourly: 30, daily: 30 });
  assert.deepEqual(staleBoundsFrom(undefined), { fifteen: 15, hourly: 30, daily: 30 });
  assert.deepEqual(staleBoundsFrom(""), { fifteen: 15, hourly: 30, daily: 30 });
  assert.deepEqual(staleBoundsFrom("15m=20,1h=45,1d=60"), { fifteen: 20, hourly: 45, daily: 60 });
  assert.deepEqual(staleBoundsFrom(" 1D = 90 , fifteen=12.5 "), { fifteen: 12.5, hourly: 30, daily: 90 }, "any subset, either spelling, spaces forgiven");
  assert.deepEqual(staleBoundsFrom("15m=0,1h=-5,1d=soon,2h=10,nonsense,15m="), { fifteen: 15, hourly: 30, daily: 30 }, "what does not read as a tenor and a positive number is ignored");
  assert.deepEqual(STALE_AFTER_SEC, { fifteen: 15, hourly: 30, daily: 30 }, "the defaults are not written through");

  assert.equal(freshnessOf(1, 14.9, 15), "fresh");
  assert.equal(freshnessOf(1, 15, 15), "fresh", "at the bound is not over it");
  assert.equal(freshnessOf(1, 15.1, 15), "stale");
  assert.equal(freshnessOf(16, 2, 15), "stale", "either side");
  assert.equal(freshnessOf(1, 29, 30), "fresh");
  assert.equal(freshnessOf(null, 2, 15), null, "one venue absent: nothing to judge");
  assert.equal(freshnessOf(2, undefined, 15), null);
});

test("a gap on a stale read is tagged, not counted: both books still show, the gap stays out of the window, the row is not the default pick and sorts after every row that can be judged", () => {
  // Polymarket US's copy of the at-the-money strike had been in its cache 31 seconds; Kalshi there sits 8 cents higher, which reads as a lock
  const history: GapHistory = new Map();
  const l = readLadder({ 74750: 31 }, 74750);
  const s = horizonSet("hourly", l, "poly:btc-above-day-2026-11-09:range:2026-11-09", 74812, NOW, history, urls, { volPct: 50 });
  assert.ok(s);
  assert.equal(s.staleAfterSec, 30);
  const [below, atm, above] = s.pairs;
  assert.equal(atm.poly?.read?.ageSec, 32, "one second since we read it plus 31 in the venue's cache");
  assert.equal(atm.freshness, "stale");
  assert.equal(atm.staleAfterSec, 30);
  assert.equal(below.freshness, "fresh");
  assert.equal(above.freshness, "fresh");
  // the row is whole: both books, the gap, the lock and the score are all there to read
  assert.ok(atm.kalshi && atm.poly && atm.twoSided);
  assert.equal(atm.gapCents, 8.5);
  assert.ok(atm.lock && atm.lock.edgeCents > 0, `the stale gap reads as a lock of ${atm.lock?.edgeCents}`);
  assert.ok(atm.score !== null);
  assert.match(atm.reading, /mids 8\.5¢ apart · stale read: Poly copy 32s old \(limit 30s\)$/);
  assert.ok(!atm.reading.includes("cross:"), "a lock on a stale read is not announced as a cross");
  // not the pick, though its lock is the only one in the tenor
  assert.ok(s.pick && s.pick !== pairId(atm));
  const bundle = bundleOf([s]);
  assert.equal(bundle.length, 3);
  assert.equal(bundle[2], atm, "after every pair whose read can be judged, whatever its score");

  // persistence: three cycles record three readings for the fresh rows and none for the stale one
  for (let i = 0; i < 3; i += 1) recordGaps(history, [s], NOW + i * 10_000, 60 * 60_000);
  assert.equal(history.get(gapHistoryKey(SETTLE, "above:74500"))?.length, 3);
  assert.equal(history.get(gapHistoryKey(SETTLE, "above:74750")), undefined);
  assert.equal(atm.persistence, null);

  // the same books a cycle later on a younger copy: fresh, announced, pickable
  const fresh = horizonSet("hourly", readLadder({ 74750: 12 }, 74750), null, 74812, NOW, new Map(), urls);
  assert.equal(fresh?.pairs[1].freshness, "fresh");
  assert.match(fresh?.pairs[1].reading ?? "", /cross: both sides for/);

  // the bound is the tenor's: the same 20-second copy is fresh on the hourly and stale on the 15-minute window
  assert.equal(horizonSet("hourly", readLadder({ 74750: 20 }), null, 74812, NOW, new Map(), urls)?.pairs[1].freshness, "fresh");
  const f15 = fifteenLadder();
  const stale15 = fifteenSet({ ...f15, quotes: f15.quotes.map((x) => readAt(x, 1, x.venue === "kalshi" ? null : 20, 21)) }, null, 73214, NOW, new Map(), urls);
  assert.equal(stale15?.staleAfterSec, 15);
  assert.equal(stale15?.pairs[0].freshness, "stale");
  assert.equal(stale15?.pick, null, "the one row is stale: nothing is sent by default");
  assert.equal(fifteenSet({ ...f15, quotes: f15.quotes.map((x) => readAt(x, 1, x.venue === "kalshi" ? null : 20, 21)) }, null, 73214, NOW, new Map(), urls, { staleAfterSec: 25 })?.pairs[0].freshness, "fresh", "an overridden bound");

  // a quiet book: the venue's stamp is 80 seconds old on a copy 4 seconds old. The copy is what was priced, so the read is fresh.
  const quiet = ladder();
  const quietSet = horizonSet("hourly", { ...quiet, quotes: quiet.quotes.map((x) => (x.venue === "kalshi" ? readAt(x, 1) : readAt(x, 1, 4, 80))) }, null, 74812, NOW, new Map(), urls);
  assert.equal(quietSet?.pairs[1].poly?.read?.venueAgeSec, 80);
  assert.equal(quietSet?.pairs[1].freshness, "fresh");
  // Kalshi's read alone can make a row stale (a slow cycle)
  const slow = ladder();
  assert.equal(horizonSet("hourly", { ...slow, quotes: slow.quotes.map((x) => (x.venue === "kalshi" ? readAt(x, 31) : readAt(x, 1, 4, 5))) }, null, 74812, NOW, new Map(), urls)?.pairs[1].reading.endsWith("stale read: Kalshi copy 31s old (limit 30s)"), true);
  // quotes that carry no read (fixtures, a venue standing alone) are not judged and lose nothing
  assert.equal(horizonSet("hourly", ladder(), null, 74812, NOW, new Map(), urls)?.pairs[1].freshness, null);
});

/** The 15-minute window as the collector prices it: both books read `fetchAgeSec` ago, Polymarket US's copy `polyCache` seconds in its cache. */
function fifteenAt(nowMs: number, polyCache: number, quotes: [number, number, number, number] = [51, 52, 73, 74]) {
  const l = fifteenLadder(...quotes);
  const read = (x: VenueQuote): VenueQuote => ({ ...x, read: { fetchedAtMs: nowMs - 1000, cacheAgeSec: x.venue === "kalshi" ? null : polyCache, venueAtMs: null, state: null } });
  return fifteenSet({ ...l, quotes: l.quotes.map(read) }, null, 73214, nowMs, new Map(), urls, { pricedAtMs: nowMs });
}

const sighting = (over: Partial<LockSighting> = {}): LockSighting => ({
  horizon: "fifteen",
  settlesAt: "2026-11-09T21:30:00Z",
  key: "above:73158.07",
  strike: 73158.07,
  kalshiId: "KXBTC15M-26NOV091630-15",
  polyId: "cpc-btc-updown-15m-2026-11-09-2115z",
  yesOn: "kalshi",
  noOn: "polymarket_us",
  lockCents: 2.4,
  qty: 300,
  ...over,
});

/** Run cycles ten seconds apart from `startMs`; each entry is that cycle's sightings. Returns the book and everything that finished. */
function runCycles(cycles: LockSighting[][], startMs = NOW, book: EpisodeBook = emptyEpisodeBook(), opts: { maxGapMs?: number; keep?: number } = {}) {
  const finished: LockEpisode[] = [];
  let at = startMs;
  for (const [i, sightings] of cycles.entries()) {
    at = startMs + i * 10_000;
    const step = stepEpisodes(book, sightings, at, opts);
    book = step.book;
    finished.push(...step.finished);
  }
  return { book, finished, at };
}

test("lock sightings: a lock after fees above zero on fresh reads counts, at the size the lock is quoted at; a stale read, an unjudged read, a missing book or no lock do not", () => {
  const fresh = fifteenAt(NOW, 4);
  assert.ok(fresh);
  const row = fresh.pairs[0];
  assert.equal(row.freshness, "fresh");
  assert.ok(row.lock && row.lock.edgeCents > 0);
  assert.deepEqual(lockSightings([fresh, null]), [
    { horizon: "fifteen", settlesAt: "2026-11-09T21:30:00Z", key: row.key, strike: 73158.07, kalshiId: "KXBTC15M-26NOV091630-15", polyId: "cpc-btc-updown-15m-2026-11-09-2115z", yesOn: "kalshi", noOn: "polymarket_us", lockCents: row.lock.edgeCents, qty: 1600 },
  ]);
  assert.equal(row.lock.qty, 1600, "the thinner of Kalshi's 1,600 offered and Polymarket US's 1,800 bid: the size the page already quotes the lock at");

  assert.deepEqual(lockSightings([fifteenAt(NOW, 22)]), [], "the same lock on a 23-second copy is not counted");
  const unjudged = fifteenSet(fifteenLadder(), null, 73214, NOW, new Map(), urls);
  assert.ok(unjudged?.pairs[0].lock && unjudged.pairs[0].lock.edgeCents > 0 && unjudged.pairs[0].freshness === null);
  assert.deepEqual(lockSightings([unjudged]), [], "a lock whose reads carry no age cannot be called fresh");
  const noLock = fifteenAt(NOW, 4, [51, 52, 51, 53]);
  assert.ok(noLock?.pairs[0].lock && noLock.pairs[0].lock.edgeCents <= 0);
  assert.deepEqual(lockSightings([noLock]), [], "both sides cost more than 100 after fees");
  const l = fifteenLadder();
  const failed = fifteenSet({ ...l, quotes: l.quotes.map((x) => (x.venue === "kalshi" ? readAt(x, 1) : { ...x, failure: { kind: "http" as const, status: 500, url: "https://x/book", detail: "HTTP 500", cacheAgeSec: null } })) }, null, 73214, NOW, new Map(), urls);
  assert.deepEqual(lockSightings([failed]), [], "no book, no lock");
});

test("lock episodes: a run opens on the first cycle, is an episode from the second, carries its smallest lock and size, and ends at the last cycle that showed it", () => {
  assert.equal(EPISODE_MIN_CYCLES, 2);
  const empty = emptyEpisodeBook();

  // opening: one cycle is a run, not yet an episode
  const one = stepEpisodes(empty, [sighting()], NOW);
  assert.deepEqual(empty, { open: [], finished: [] }, "the book passed in is not changed");
  assert.deepEqual(one.finished, []);
  assert.equal(one.book.open.length, 1);
  assert.equal(one.book.open[0].cycles, 1);
  assert.equal(episodeSummary(one.book, "fifteen", NOW).episodes, 0);

  // extending: the second cycle makes it an episode, still open
  const two = stepEpisodes(one.book, [sighting({ lockCents: 1.9, qty: 320 })], NOW + 10_000);
  assert.equal(one.book.open[0].cycles, 1, "not changed in place");
  assert.deepEqual(two.finished, []);
  const open = episodeSummary(two.book, "fifteen", NOW + 10_000);
  assert.equal(open.episodes, 1);
  assert.equal(open.open, 1);
  assert.equal(open.medianDurationSec, 10);
  assert.equal(open.longestDurationSec, 10);
  assert.equal(open.totalValueCents, 570, "1.9 cents on 300 contracts");
  assert.deepEqual(open.recent[0], {
    horizon: "fifteen",
    settlesAt: "2026-11-09T21:30:00Z",
    key: "above:73158.07",
    strike: 73158.07,
    kalshiId: "KXBTC15M-26NOV091630-15",
    polyId: "cpc-btc-updown-15m-2026-11-09-2115z",
    yesOn: "kalshi",
    noOn: "polymarket_us",
    startedAt: new Date(NOW).toISOString(),
    endedAt: new Date(NOW + 10_000).toISOString(),
    durationSec: 10,
    cycles: 2,
    minLockCents: 1.9,
    minQty: 300,
    valueCents: 570,
    open: true,
  });

  // a third cycle with a bigger lock on less size: the minimum of each is kept, not the pair that happened together
  const three = stepEpisodes(two.book, [sighting({ lockCents: 3.1, qty: 120 })], NOW + 20_000);
  assert.equal(three.book.open[0].minLockCents, 1.9);
  assert.equal(three.book.open[0].minQty, 120);

  // closing: the cycle without the lock ends it at the last cycle that had it
  const four = stepEpisodes(three.book, [], NOW + 30_000);
  assert.equal(four.book.open.length, 0);
  assert.equal(four.finished.length, 1);
  const e = four.finished[0];
  assert.equal(e.startedAt, new Date(NOW).toISOString());
  assert.equal(e.endedAt, new Date(NOW + 20_000).toISOString());
  assert.equal(e.durationSec, 20);
  assert.equal(e.cycles, 3);
  assert.equal(e.valueCents, 228, "1.9 cents times 120 contracts, in cents");
  assert.equal(e.open, undefined);
  assert.deepEqual(four.book.finished, [e]);
  const day = episodeSummary(four.book, "fifteen", NOW + 30_000);
  assert.deepEqual([day.episodes, day.open, day.medianDurationSec, day.longestDurationSec, day.totalValueCents], [1, 0, 20, 20, 228]);
  assert.equal(episodeSummary(four.book, "hourly", NOW + 30_000).episodes, 0, "each tenor counts its own");

  // a lock with no size on the book is still an episode, worth nothing
  const noSize = runCycles([[sighting({ qty: 0 })], [sighting({ qty: 0 })], []]);
  assert.equal(noSize.finished[0].valueCents, 0);

  // stopping the collector ends what is open
  const stopped = closeEpisodes(three.book, NOW + 25_000);
  assert.equal(stopped.finished.length, 1);
  assert.equal(stopped.finished[0].endedAt, new Date(NOW + 20_000).toISOString());
  assert.deepEqual(closeEpisodes(one.book, NOW + 5_000).finished, [], "a run of one cycle is dropped");
});

test("lock episodes: a one-cycle blip is not an episode; a stale cycle neither extends nor ends a run; a change of direction or of contract starts a new one; missed cycles do not extend", () => {
  // one cycle on, one off, one on, one off: nothing
  const blips = runCycles([[sighting()], [], [sighting()], []]);
  assert.deepEqual(blips.finished, []);
  assert.deepEqual(blips.book, { open: [], finished: [] });

  // the real path: the same crossed books on whole cycles, as the collector steps them
  const real = (cycles: Array<{ polyCache: number; quotes?: [number, number, number, number] }>, opts: { maxGapMs?: number } = {}) => {
    let book = emptyEpisodeBook();
    const finished: LockEpisode[] = [];
    for (const [i, c] of cycles.entries()) {
      const at = NOW + i * 10_000;
      const sets = [fifteenAt(at, c.polyCache, c.quotes)];
      const step = stepEpisodes(book, lockSightings(sets), at, { ...opts, unjudged: unjudgedPairs(sets) });
      book = step.book;
      finished.push(...step.finished);
    }
    return { book, finished };
  };
  // five cycles, the third on a copy too old to judge: one episode of 40 seconds still open, on the four cycles that showed the lock
  const through = real([3, 13, 23, 3, 13].map((polyCache) => ({ polyCache })));
  assert.deepEqual(through.finished, [], "the stale cycle did not close the run");
  assert.deepEqual([through.book.open.length, through.book.open[0].startedAtMs, through.book.open[0].lastAtMs, through.book.open[0].cycles], [1, NOW, NOW + 40_000, 4]);
  assert.equal(episodeSummary(through.book, "fifteen", NOW + 40_000).episodes, 1);
  // one lock standing for ten minutes behind a cache refreshed every 30 seconds (copies 1, 11 and 21 seconds old) is one episode, not twenty
  const standing = real(Array.from({ length: 60 }, (_, i) => ({ polyCache: (i * 10) % 30 })), { maxGapMs: 30_000 });
  assert.deepEqual([standing.finished.length, standing.book.open.length, episodeSummary(standing.book, "fifteen", NOW + 590_000).episodes], [0, 1, 1]);
  assert.deepEqual([standing.book.open[0].cycles, standing.book.open[0].startedAtMs, standing.book.open[0].lastAtMs], [40, NOW, NOW + 580_000]);
  // a stale stretch longer than the gap limit is not a gap: the cycles came, they could not be judged
  const longStale = real([3, 13, 23, 23, 23, 23, 23, 3].map((polyCache) => ({ polyCache })), { maxGapMs: 30_000 });
  assert.deepEqual([longStale.finished.length, longStale.book.open[0].cycles, longStale.book.open[0].startedAtMs], [0, 3, NOW]);
  // a fresh read with no lock ends it at the last cycle that showed it, stale cycles in between or not
  const noLock: [number, number, number, number] = [51, 52, 51, 53];
  const ended = real([{ polyCache: 3 }, { polyCache: 13 }, { polyCache: 23 }, { polyCache: 3, quotes: noLock }, { polyCache: 13 }]);
  assert.deepEqual(ended.finished.map((e) => [e.startedAt, e.endedAt, e.cycles]), [[new Date(NOW).toISOString(), new Date(NOW + 10_000).toISOString(), 2]]);
  assert.equal(ended.book.open[0].startedAtMs, NOW + 40_000, "and the lock after it is a new run");
  // a stale row priced as no lock says nothing either way
  assert.deepEqual(real([{ polyCache: 3 }, { polyCache: 13 }, { polyCache: 23, quotes: noLock }, { polyCache: 3 }]).finished, []);
  // without the unjudged rows a run is not carried: a pair that is not in the cycle at all has gone
  assert.equal(runCycles([[sighting()], [sighting()], [], [sighting()]]).finished.length, 1);
  // a carried run is matched on the venue ids: a stale row for another contract under the same key does not carry it
  const u = { horizon: "fifteen" as const, settlesAt: "2026-11-09T21:30:00Z", key: "above:73158.07", kalshiId: "KXBTC15M-26NOV091630-15", polyId: "cpc-btc-updown-15m-2026-11-09-2115z" };
  const two = runCycles([[sighting()], [sighting()]]).book;
  assert.equal(stepEpisodes(two, [], NOW + 20_000, { unjudged: [u] }).book.open.length, 1);
  assert.equal(stepEpisodes(two, [], NOW + 20_000, { unjudged: [{ ...u, polyId: null }] }).book.open.length, 1, "a book that did not answer names no id");
  assert.equal(stepEpisodes(two, [], NOW + 20_000, { unjudged: [{ ...u, polyId: "another-market" }] }).finished.length, 1);
  assert.equal(stepEpisodes(two, [], NOW + 20_000, { unjudged: [{ ...u, settlesAt: "2026-11-09T21:45:00Z" }] }).finished.length, 1);

  // direction: Yes on Kalshi for three cycles, then Yes on Polymarket US for two. Two runs.
  const flipped = sighting({ yesOn: "polymarket_us", noOn: "kalshi" });
  const dir = runCycles([[sighting()], [sighting()], [sighting()], [flipped], [flipped], []]);
  assert.deepEqual(dir.finished.map((e) => [e.yesOn, e.cycles, e.durationSec, e.startedAt]), [
    ["kalshi", 3, 20, new Date(NOW).toISOString()],
    ["polymarket_us", 2, 10, new Date(NOW + 30_000).toISOString()],
  ]);
  // a flip after one cycle: the first direction never became an episode
  assert.deepEqual(runCycles([[sighting()], [flipped], [flipped], []]).finished.map((e) => e.yesOn), ["polymarket_us"]);

  // the next 15-minute window is another contract: its lock does not extend the last window's run
  const next = sighting({ settlesAt: "2026-11-09T21:45:00Z", kalshiId: "KXBTC15M-26NOV091645-45", polyId: "cpc-btc-updown-15m-2026-11-09-2130z" });
  const rolled = runCycles([[sighting()], [sighting()], [next], [next], []]);
  assert.deepEqual(rolled.finished.map((e) => [e.kalshiId, e.cycles]), [["KXBTC15M-26NOV091630-15", 2], ["KXBTC15M-26NOV091645-45", 2]]);

  // two pairs locked at once are two runs, each with its own figures
  const hourly = sighting({ horizon: "hourly", key: "above:74750", strike: 74750, kalshiId: "KXBTCD-26NOV0917-T74749.99", polyId: "btc-above-74750", lockCents: 0.6, qty: 40 });
  const both = runCycles([[sighting(), hourly], [sighting(), hourly], [hourly], []]);
  assert.deepEqual(both.finished.map((e) => [e.horizon, e.cycles, e.valueCents]), [["fifteen", 2, 720], ["hourly", 3, 24]]);

  // the collector missed cycles (the gap is over the limit): the run is not known to be consecutive, so it ends and another begins
  const a = stepEpisodes(emptyEpisodeBook(), [sighting()], NOW, { maxGapMs: 30_000 });
  const b = stepEpisodes(a.book, [sighting()], NOW + 10_000, { maxGapMs: 30_000 });
  const late = stepEpisodes(b.book, [sighting()], NOW + 50_000, { maxGapMs: 30_000 });
  assert.equal(late.finished.length, 1);
  assert.equal(late.finished[0].durationSec, 10);
  assert.deepEqual([late.book.open.length, late.book.open[0].startedAtMs, late.book.open[0].cycles], [1, NOW + 50_000, 1]);
  const onTime = stepEpisodes(b.book, [sighting()], NOW + 40_000, { maxGapMs: 30_000 });
  assert.deepEqual([onTime.finished.length, onTime.book.open[0].cycles], [0, 3], "at the limit it still extends");
});

test("lock episodes: the day is the UTC day of the last cycle that showed the lock; today's are all kept, earlier days keep the last 50 a tenor; median, longest and total are over the day", () => {
  const day1 = Date.parse("2026-11-09T23:59:20Z");
  // one episode wholly before midnight (23:59:20 to 23:59:30), one across it (23:59:50 to 00:00:10)
  const r = runCycles([[sighting()], [sighting()], [], [sighting({ lockCents: 1, qty: 50 })], [sighting({ lockCents: 1, qty: 50 })], [sighting({ lockCents: 1, qty: 50 })], []], day1);
  assert.deepEqual(r.finished.map((e) => [e.startedAt, e.endedAt]), [
    ["2026-11-09T23:59:20.000Z", "2026-11-09T23:59:30.000Z"],
    ["2026-11-09T23:59:50.000Z", "2026-11-10T00:00:10.000Z"],
  ]);
  const before = episodeSummary({ open: [], finished: [r.finished[0]] }, "fifteen", Date.parse("2026-11-09T23:59:45Z"));
  assert.equal(before.episodes, 1);
  const after = episodeSummary(r.book, "fifteen", r.at);
  assert.equal(after.episodes, 1, "only the one that ended after midnight is today's");
  assert.equal(after.recent[0].endedAt, "2026-11-10T00:00:10.000Z");
  assert.equal(after.totalValueCents, 50);
  assert.equal(r.book.finished.length, 2, "yesterday's is still kept");
  const report = lockEpisodesReport(r.book, r.at);
  assert.equal(report.day, "2026-11-10");
  assert.equal(report.label, EPISODE_LABEL);
  assert.equal(report.label, "measured at the size on the book, after fees, no orders placed; a floor on what was there, not what a trader would have captured");
  assert.equal(report.minCycles, 2);
  assert.deepEqual([report.fifteen.episodes, report.hourly.episodes, report.daily.episodes], [1, 0, 0]);
  // a run open across midnight is today's while it runs
  const spanning = runCycles([[sighting()], [sighting()], [sighting()]], Date.parse("2026-11-09T23:59:50Z"));
  assert.deepEqual([episodeSummary(spanning.book, "fifteen", spanning.at).episodes, episodeSummary(spanning.book, "fifteen", spanning.at).open], [1, 1]);

  // the day's figures: durations 10, 20, 40 and 70 seconds
  const mk = (startMs: number, sec: number, valueCents: number, horizon: LockEpisode["horizon"] = "fifteen"): LockEpisode => {
    const { lockCents: _l, qty: _q, ...pair } = sighting({ horizon });
    return { ...pair, startedAt: new Date(startMs).toISOString(), endedAt: new Date(startMs + sec * 1000).toISOString(), durationSec: sec, cycles: sec / 10 + 1, minLockCents: 1, minQty: valueCents, valueCents };
  };
  const t = Date.parse("2026-11-10T12:00:00Z");
  const four: EpisodeBook = { open: [], finished: [mk(t, 10, 100.25), mk(t + 100_000, 40, 3), mk(t + 200_000, 20, 50.5), mk(t + 300_000, 70, 1000)] };
  const sum = episodeSummary(four, "fifteen", t + 400_000, 3);
  assert.deepEqual([sum.episodes, sum.medianDurationSec, sum.longestDurationSec, sum.totalValueCents], [4, 30, 70, 1153.75]);
  assert.deepEqual(sum.recent.map((e) => e.durationSec), [70, 20, 40], "the latest three, newest first");
  assert.equal(episodeSummary({ open: [], finished: four.finished.slice(0, 3) }, "fifteen", t + 400_000).medianDurationSec, 20);
  const none = episodeSummary(emptyEpisodeBook(), "daily", t);
  assert.deepEqual(none, { episodes: 0, open: 0, medianDurationSec: null, longestDurationSec: null, totalValueCents: 0, recent: [] });

  // keeping: 60 from yesterday and 70 from today on one tenor, 3 from yesterday on another
  assert.equal(EPISODE_KEEP, 50);
  const yesterday = Date.parse("2026-11-09T10:00:00Z");
  const many = [
    ...Array.from({ length: 60 }, (_, i) => mk(yesterday + i * 60_000, 10, 1)),
    ...Array.from({ length: 3 }, (_, i) => mk(yesterday + i * 60_000, 10, 1, "hourly")),
    ...Array.from({ length: 70 }, (_, i) => mk(t + i * 60_000, 10, 1)),
  ];
  const kept = pruneEpisodes([...many].reverse(), t + 80 * 60_000);
  assert.equal(kept.filter((e) => e.horizon === "fifteen" && e.endedAt.startsWith("2026-11-10")).length, 70, "all of today's, so the day's median and total are whole");
  const old = kept.filter((e) => e.horizon === "fifteen" && e.endedAt.startsWith("2026-11-09"));
  assert.equal(old.length, 50);
  assert.equal(old[0].startedAt, new Date(yesterday + 10 * 60_000).toISOString(), "the oldest ten went");
  assert.equal(kept.filter((e) => e.horizon === "hourly").length, 3, "the bound is per tenor");
  assert.deepEqual(kept.map((e) => Date.parse(e.endedAt)), kept.map((e) => Date.parse(e.endedAt)).sort((x, y) => x - y), "oldest first");
  assert.equal(pruneEpisodes(many, t, 5).filter((e) => e.endedAt.startsWith("2026-11-09") && e.horizon === "fifteen").length, 5);
  // the step prunes as it goes
  const stepped = stepEpisodes({ open: [], finished: many }, [], t + 80 * 60_000, { keep: 2 });
  assert.equal(stepped.book.finished.length, 70 + 2 + 2);
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
    pricedAt: new Date(NOW).toISOString(),
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
    staleAfterSec: STALE_AFTER_SEC,
    health: { kalshi: { ok: true, ms: 40 }, polymarket_us: { ok: false, ms: 20000, detail: "no answer within 20s" } },
    errors: [],
    lockEpisodes: lockEpisodesReport(emptyEpisodeBook(), NOW),
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
