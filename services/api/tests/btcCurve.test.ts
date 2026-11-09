/**
 * BTC CURVE REPORT: the two venues' ladders line up bucket for bucket, the option-implied
 * column is sane, crosses are net of each venue's fee, the latency table and the hedge replay
 * compute what they say, and the page shows the holder's side without the writer's take.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { aboveKey, belowKey, keyLevel } from "../src/btcCurve/keys";
import { bucketFromKalshi, dollarsToCentsExact, hourlyLadderFrom, sortBuckets, topDepthFromOrderbook } from "../src/btcCurve/kalshiLadders";
import { bucketFromPolyUs, laddersFromEvents, moneyCents } from "../src/btcCurve/polyUsLadders";
import { expiryTagToMs, parseSummary, selectRows } from "../src/btcCurve/deribitChain";
import { black76Call, buildSmiles, digitalDelta, forwardFor, ivAt, modelBucket, normCdf, probAbove, probTouch, type Smile } from "../src/btcCurve/model";
import { bucketRows, findCross, gapSeries, ladderImpliedVol, latencyTable, mergeLadders, realizedVolPct, takerFeeCents } from "../src/btcCurve/analytics";
import { SnapshotStore, toHistoryPoint } from "../src/btcCurve/store";
import { ReplayEngine, bracketCalls } from "../src/btcCurve/replay";
import { buildReport, termBasis } from "../src/btcCurve/report";
import { renderReportHtml } from "../src/btcCurve/reportHtml";
import type { Ladder, OptionRow, Snapshot, VenueQuote } from "../src/btcCurve/types";

const SETTLE = "2027-01-01T05:00:00Z";

test("bucket keys: the same contract gets the same key on both venues, including the open tails and the touches", () => {
  // Kalshi words thresholds as "strictly above 149,999.99"; Polymarket US as "at or above 150,000".
  assert.equal(aboveKey(149999.99, false), "above:150000");
  assert.equal(aboveKey(150000, true), "above:150000");
  assert.equal(belowKey(20000, false), "below:19999.99");
  assert.equal(belowKey(19999.99, true), "below:19999.99");
  assert.equal(keyLevel("range:95000-99999.99"), 95000);

  const k = (m: Record<string, unknown>, fam: "range" | "touch_up" | "touch_down" | "above") =>
    bucketFromKalshi({ ticker: "t", event_ticker: "e", status: "open", close_time: SETTLE, ...m } as never, SETTLE, fam);
  const p = (slug: string, terms: Record<string, unknown>) => bucketFromPolyUs({ slug, endDate: SETTLE, assetPriceTerms: { asset: { symbol: "btc" }, windowEnd: SETTLE, ...terms } } as never);

  const money = (v: string) => ({ value: v, currency: "USD" });
  assert.equal(k({ strike_type: "between", floor_strike: 95000, cap_strike: 99999.99 }, "range")?.key, "range:95000-99999.99");
  assert.equal(p("cpc-btc-pricerange-yr-12-31-2026-97500", { marketType: "ASSET_PRICE_MARKET_TYPE_RANGE", rangeKind: "ASSET_PRICE_RANGE_KIND_INTERIOR", rangeLower: money("95000.00"), rangeUpper: money("99999.99") })?.key, "range:95000-99999.99");

  assert.equal(k({ strike_type: "greater", floor_strike: 149999.99 }, "range")?.key, "above:150000");
  assert.equal(p("…above-150k", { marketType: "ASSET_PRICE_MARKET_TYPE_RANGE", rangeKind: "ASSET_PRICE_RANGE_KIND_ABOVE", rangeLower: money("150000.00") })?.key, "above:150000");

  assert.equal(k({ strike_type: "less", cap_strike: 20000 }, "range")?.key, "below:19999.99");
  assert.equal(p("…below-20k", { marketType: "ASSET_PRICE_MARKET_TYPE_RANGE", rangeKind: "ASSET_PRICE_RANGE_KIND_BELOW", rangeUpper: money("19999.99") })?.key, "below:19999.99");

  assert.equal(k({ strike_type: "greater", floor_strike: 109999.99 }, "touch_up")?.key, "touch_up:110000");
  assert.equal(p("…hitprice-high-110k", { marketType: "ASSET_PRICE_MARKET_TYPE_ONE_TOUCH", strike: money("110000"), direction: "ASSET_PRICE_DIRECTION_UP" })?.key, "touch_up:110000");

  assert.equal(k({ strike_type: "less", cap_strike: 40000 }, "touch_down")?.key, "touch_down:40000");
  assert.equal(p("…hitprice-low-40k", { marketType: "ASSET_PRICE_MARKET_TYPE_ONE_TOUCH", strike: money("40000"), direction: "ASSET_PRICE_DIRECTION_DOWN" })?.key, "touch_down:40000");

  // hourly ladder: "$85,250 or above" is listed as strictly above 85,249.99
  assert.equal(k({ strike_type: "greater", floor_strike: 85249.99 }, "above")?.key, "above:85250");

  // the hourly pick: the series lists the current hour and tomorrow's 5 PM ET contract side by side
  const now = Date.UTC(2026, 10, 8, 23, 50, 0);
  const raw = (event_ticker: string, close_time: string) => ({
    ticker: `${event_ticker}-T74249.99`,
    event_ticker,
    status: "open",
    close_time,
    strike_type: "greater",
    floor_strike: 74249.99,
    yes_bid_dollars: "0.4500",
    yes_ask_dollars: "0.4600",
  });
  const thisHour = raw("KXBTCD-26NOV0819", "2026-11-09T00:00:00Z");
  const tomorrow5pm = raw("KXBTCD-26NOV0917", "2026-11-09T22:00:00Z");
  assert.equal(hourlyLadderFrom([tomorrow5pm, thisHour], 0.07, now)?.id, "btc-hourly:KXBTCD-26NOV0819", "ten minutes left still counts");
  assert.equal(hourlyLadderFrom([tomorrow5pm], 0.07, now), null, "a 22-hour contract is not the hourly ladder");
  assert.equal(hourlyLadderFrom([thisHour], 0.07, Date.UTC(2026, 10, 8, 23, 59, 0)), null, "inside the last two minutes nothing is picked");
  // not a BTC contract → not a bucket
  assert.equal(bucketFromPolyUs({ slug: "aec-nfl-x", assetPriceTerms: { asset: { symbol: "eth" } } } as never), null);
  assert.equal(bucketFromPolyUs({ slug: "aec-nfl-x" } as never), null);

  const sorted = sortBuckets([
    { key: "above:150000", kind: "above", level: 150000, settlesAt: SETTLE },
    { key: "below:19999.99", kind: "below", level: 19999.99, settlesAt: SETTLE },
    { key: "range:95000-99999.99", kind: "range", lower: 95000, upper: 99999.99, settlesAt: SETTLE },
  ]);
  assert.deepEqual(
    sorted.map((b) => b.key),
    ["below:19999.99", "range:95000-99999.99", "above:150000"],
  );
});

test("venue parsing: Kalshi sub-penny prices keep their fraction, depth reads the fp orderbook, Polymarket US money and grouping by settlement", () => {
  assert.equal(dollarsToCentsExact("0.0450"), 4.5);
  assert.equal(dollarsToCentsExact("0.0020"), 0.2);
  assert.equal(dollarsToCentsExact("0.9900"), 99);
  assert.equal(dollarsToCentsExact(undefined), 0);
  assert.deepEqual(
    topDepthFromOrderbook({ orderbook_fp: { yes_dollars: [["0.0100", "5"], ["0.1700", "998.71"]], no_dollars: [["0.5000", "1"], ["0.8300", "66.01"]] } }),
    { bidQty: 998.71, askQty: 66.01 },
  );
  assert.deepEqual(topDepthFromOrderbook({ orderbook: { yes: [[17, 10]], no: [[83, 7]] } }), { bidQty: 10, askQty: 7 });
  assert.deepEqual(topDepthFromOrderbook({}), { bidQty: 0, askQty: 0 });
  assert.equal(moneyCents({ value: "0.1450" }), 14.5);
  assert.equal(moneyCents({ value: "0.0100" }), 1);
  assert.equal(moneyCents(null), 0);

  const money = (v: string) => ({ value: v, currency: "USD" });
  const touch = (slug: string, strike: string, windowEnd: string) => ({
    slug,
    active: true,
    closed: false,
    feeCoefficient: 0.095,
    bestBidQuote: money("0.10"),
    bestAskQuote: money("0.11"),
    assetPriceTerms: { marketType: "ASSET_PRICE_MARKET_TYPE_ONE_TOUCH", asset: { symbol: "btc" }, windowEnd, strike: money(strike), direction: "ASSET_PRICE_DIRECTION_UP" },
  });
  const ladders = laddersFromEvents([
    {
      slug: "btc-100k",
      title: "When will Bitcoin cross $100k again?",
      markets: [touch("cpc-btc-100k-12-31-2026", "100000", SETTLE), touch("cpc-btc-100k-11-30-2026", "100000", "2026-12-01T05:00:00Z"), { ...touch("x", "100000", SETTLE), closed: true }],
    },
  ] as never);
  assert.equal(ladders.length, 2, "one ladder per settlement instant; the closed market is dropped");
  assert.deepEqual(
    ladders.map((l) => l.settlesAt).sort(),
    ["2026-12-01T05:00:00Z", SETTLE],
  );
  assert.equal(ladders[0].quotes[0].feeTheta, 0.095);
});

test("deribit chain: instrument names parse, the kept subset covers the nearest expiries and the one by each settlement", () => {
  const now = Date.UTC(2026, 10, 9, 20, 0, 0);
  assert.equal(expiryTagToMs("25DEC26"), Date.UTC(2026, 11, 25, 8, 0, 0));
  assert.ok(Number.isNaN(expiryTagToMs("bogus")));
  const row = parseSummary({ instrument_name: "BTC-25DEC26-104000-C", mark_price: 0.0016, mark_iv: 46.04, bid_price: 0.0015, ask_price: 0.0018, underlying_price: 74922, open_interest: 183 });
  assert.ok(row);
  assert.equal(row?.strike, 104000);
  assert.equal(row?.type, "C");
  assert.equal(row?.markIv, 0.4604);
  assert.equal(parseSummary({ instrument_name: "ETH-25DEC26-4000-C" }), null);
  assert.equal(parseSummary({ instrument_name: "BTC-PERPETUAL" }), null);

  const mk = (tag: string, strike: number, type: "C" | "P"): OptionRow => ({
    instrument: `BTC-${tag}-${strike}-${type}`,
    expiry: tag,
    expiryMs: expiryTagToMs(tag),
    strike,
    type,
    markIv: 0.5,
    markPrice: 0.01,
    bidPrice: 0.009,
    askPrice: 0.011,
    forward: 74000,
    openInterest: 1,
  });
  const rows = [mk("10NOV26", 74000, "C"), mk("11NOV26", 74000, "C"), mk("12NOV26", 74000, "C"), mk("25DEC26", 74000, "C"), mk("25DEC26", 200000, "C"), mk("26MAR27", 74000, "C")];
  const kept = selectRows(rows, [Date.parse(SETTLE)], now);
  assert.deepEqual(
    [...new Set(kept.map((r) => r.expiry))].sort(),
    ["10NOV26", "11NOV26", "25DEC26"],
  );
  assert.ok(!kept.some((r) => r.strike === 200000), "strikes far outside the band are dropped");
});

test("model: the normal CDF, a flat smile reproduces N(d2), a tiling ladder sums to one, touches dominate finishes", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-5);
  assert.ok(Math.abs(black76Call(100, 100, 0.2, 1) - 7.9656) < 1e-3, "ATM Black-76 call, F=K=100, σ=20%, T=1 is 7.9656");

  const flat: Smile = { expiry: "X", expiryMs: 0, forward: 74000, points: [60000, 70000, 80000, 90000].map((strike) => ({ strike, iv: 0.5 })) };
  const T = 0.15;
  const K = 80000;
  const s = 0.5 * Math.sqrt(T);
  const d2 = (Math.log(74000 / K) - 0.5 * s * s) / s;
  assert.ok(Math.abs(probAbove(flat, K, T) - normCdf(d2)) < 2e-3, "no skew → digital is N(d2)");
  assert.equal(ivAt(flat, 10), 0.5, "flat beyond the wings");

  // a skewed smile interpolates in log-moneyness
  const skew: Smile = { ...flat, points: [{ strike: 60000, iv: 0.7 }, { strike: 80000, iv: 0.5 }] };
  const mid = Math.exp((Math.log(60000) + Math.log(80000)) / 2);
  assert.ok(Math.abs(ivAt(skew, mid) - 0.6) < 1e-9);

  // the year-end ladder tiles the line: below 20k, 5k buckets to 150k, above 150k
  const buckets = [{ key: "below:19999.99", kind: "below" as const, level: 19999.99, settlesAt: SETTLE }];
  for (let lo = 20000; lo < 150000; lo += 5000) buckets.push({ key: `range:${lo}-${lo + 4999.99}`, kind: "range", lower: lo, upper: lo + 4999.99, settlesAt: SETTLE } as never);
  buckets.push({ key: "above:150000", kind: "above" as const, level: 150000, settlesAt: SETTLE } as never);
  const now = Date.UTC(2026, 10, 9);
  const smile: Smile = { expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), forward: 74900, points: [40000, 50000, 60000, 70000, 80000, 100000, 120000, 150000].map((strike) => ({ strike, iv: strike < 74900 ? 0.62 - (strike / 74900) * 0.1 : 0.5 + ((strike - 74900) / 74900) * 0.08 })) };
  const total = buckets.reduce((a, b) => a + (modelBucket([smile], b as never, now)?.p ?? 0), 0);
  assert.ok(Math.abs(total - 1) < 0.01, `range ladder mass sums to one (got ${total.toFixed(4)})`);

  const pFinish = probAbove(smile, 100000, 0.14);
  const pTouch = probTouch(74900, 100000, ivAt(smile, 100000), 0.14, true);
  assert.ok(pTouch > pFinish && pTouch < 3 * pFinish, "touching a barrier is more likely than finishing beyond it, in the order of twice as likely");
  assert.equal(probTouch(74900, 70000, 0.5, 0.14, true), 1, "a barrier already behind the spot is touched");
  assert.ok(probTouch(74900, 50000, 0.6, 0.14, false) > 0 && probTouch(74900, 50000, 0.6, 0.14, false) < 0.2);

  const smiles = buildSmiles([
    { instrument: "a", expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), strike: 70000, type: "P", markIv: 0.6, markPrice: 0.1, bidPrice: 0, askPrice: 0, forward: 74900, openInterest: 0 },
    { instrument: "b", expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), strike: 70000, type: "C", markIv: 0.9, markPrice: 0.1, bidPrice: 0, askPrice: 0, forward: 74900, openInterest: 0 },
    { instrument: "c", expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), strike: 80000, type: "C", markIv: 0.5, markPrice: 0.1, bidPrice: 0, askPrice: 0, forward: 74900, openInterest: 0 },
    { instrument: "d", expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), strike: 90000, type: "C", markIv: 0.55, markPrice: 0.1, bidPrice: 0, askPrice: 0, forward: 74900, openInterest: 0 },
  ]);
  assert.equal(smiles.length, 1);
  assert.equal(smiles[0].points[0].iv, 0.6, "below the forward the put's vol is the one kept");
  assert.ok(digitalDelta(smile, 74900, 0.01) > 0, "a digital gains value as spot rises");

  // minutes before a close the digital is nearly a step; the difference quotient must not smear it
  const fourMinutes = 4 / (365.25 * 24 * 60);
  const nearClose: Smile = { ...flat, forward: 74601, points: [73000, 74000, 75000, 76000].map((strike) => ({ strike, iv: 0.7 })) };
  const sN = 0.7 * Math.sqrt(fourMinutes);
  const exact = normCdf((Math.log(74601 / 74500) - 0.5 * sN * sN) / sN);
  assert.ok(exact > 0.7, `spot $101 over the strike with 4 minutes left at 70% vol is a ${(exact * 100).toFixed(0)}% digital`);
  assert.ok(Math.abs(probAbove(nearClose, 74500, fourMinutes) - exact) < 0.01, "the numerical digital matches N(d2) minutes before the close");

  // a bucket settling within the day is priced on the settlement index, not the listed forward read seconds apart
  const soon = new Date(now + 30 * 60_000).toISOString();
  const nearSmile: Smile = { ...nearClose, expiry: "9NOV26", expiryMs: now + 7 * 3_600_000, forward: 74650 };
  const atm = { key: "above:74600", kind: "above" as const, level: 74600, settlesAt: soon };
  const onSpot = modelBucket([nearSmile], atm as never, now, 74600)?.p ?? NaN;
  const onForward = modelBucket([nearSmile], atm as never, now)?.p ?? NaN;
  assert.ok(Math.abs(onSpot - 0.5) < 0.02, `at the money on BRTI the hourly digital is ~50% (got ${(onSpot * 100).toFixed(1)}%)`);
  assert.ok(onForward > onSpot + 0.03, "the $50-higher option forward would have read it several points richer");
  assert.equal(forwardFor(nearSmile, Date.parse(SETTLE), now, 74600), 74650, "far out, the expiry's own forward (term basis) is kept");

  const basis = termBasis({ ...smile, forward: 75694 }, 75115, now);
  assert.ok(basis && Math.abs(basis.pct - 0.77) < 0.01 && basis.daysToExpiry > 45 && basis.daysToExpiry < 47, `term basis +0.77% over ${basis?.daysToExpiry} days`);
  assert.ok(basis && Math.abs(basis.annualisedPct - (0.77 / basis.daysToExpiry) * 365.25) < 0.11, "annualised from the simple basis over the days to expiry");
  assert.equal(termBasis(null, 75115, now), null);
});

function q(venue: VenueQuote["venue"], key: string, bid: number, ask: number, theta: number, bidQty = 0, askQty = 0): VenueQuote {
  return { venue, bucketKey: key, id: `${venue}:${key}`, bidCents: bid, askCents: ask, bidQty, askQty, volume: 0, openInterest: 0, feeTheta: theta };
}

test("crosses and gaps: fees are the venue's Θ·p·(1−p); a cross needs the other venue's bid over this venue's offer after both fees; size is the thinner level", () => {
  assert.equal(takerFeeCents(0.095, 15), 1.212, "0.095 × 0.15 × 0.85 = 1.2113¢, rounded up at the thousandth");
  assert.equal(takerFeeCents(0, 15), 0, "a fee-free series");
  assert.equal(takerFeeCents(0.07, 100), 0);

  // Kalshi 16.9 / 17 (fee-free year-end series), Polymarket US 14 / 15 (Θ 0.095): buy Poly at 15, sell Kalshi at 16.9
  const cross = findCross(q("kalshi", "r", 16.9, 17, 0, 998.71, 66.01), q("polymarket_us", "r", 14, 15, 0.095, 62255, 13.8));
  assert.ok(cross);
  assert.equal(cross?.buyOn, "polymarket_us");
  assert.equal(cross?.sellOn, "kalshi");
  assert.equal(cross?.feesCents, 1.21);
  assert.equal(cross?.edgeCents, 0.69);
  assert.equal(cross?.qty, 13.8, "bounded by the 13.8 contracts offered on Polymarket US");
  // a 1¢ gap inside the fee band is not a cross
  assert.equal(findCross(q("kalshi", "r", 10, 11, 0.07), q("polymarket_us", "r", 9, 10, 0.095)), null);
  assert.equal(findCross(q("kalshi", "r", 10, 11, 0), null), null);
  // the other direction works too
  const rev = findCross(q("kalshi", "r", 9, 10, 0), q("polymarket_us", "r", 12, 13, 0.095));
  assert.equal(rev?.buyOn, "kalshi");
  assert.equal(rev?.sellOn, "polymarket_us");

  const spine: Ladder = {
    id: "btc-yearend-2026-range",
    title: "t",
    settlesAt: SETTLE,
    buckets: [{ key: "range:70000-74999.99", kind: "range", lower: 70000, upper: 74999.99, settlesAt: SETTLE }],
    quotes: [q("kalshi", "range:70000-74999.99", 16.9, 17, 0)],
    model: { "range:70000-74999.99": { p: 0.203, expiry: "25DEC26", iv: 0.55 } },
  };
  const poly: Ladder = {
    id: "poly:x:range:2027-01-01",
    title: "t",
    settlesAt: SETTLE,
    buckets: [
      { key: "range:70000-74999.99", kind: "range", lower: 70000, upper: 74999.99, settlesAt: SETTLE },
      { key: "range:75000-79999.99", kind: "range", lower: 75000, upper: 79999.99, settlesAt: SETTLE },
    ],
    quotes: [q("polymarket_us", "range:70000-74999.99", 14, 15, 0.095, 1, 1), q("polymarket_us", "range:70000-74999.99", 14, 15, 0.095, 50, 50), q("polymarket_us", "range:75000-79999.99", 21, 22, 0.095)],
    model: {},
  };
  const merged = mergeLadders(spine, [poly, { ...poly, id: "other", settlesAt: "2026-12-01T05:00:00Z" }]);
  assert.equal(merged.buckets.length, 2, "the mate on the same settlement adds its bucket; the one on another settlement is ignored");
  assert.equal(merged.quotes.filter((x) => x.venue === "polymarket_us" && x.bucketKey === "range:70000-74999.99").length, 1, "one quote per venue per bucket");
  assert.equal(merged.quotes.find((x) => x.venue === "polymarket_us" && x.bucketKey === "range:70000-74999.99")?.bidQty, 50, "the deeper listing is kept");
  const rows = bucketRows(merged);
  assert.equal(rows[0].venueGapCents, 2.45, "Kalshi mid 16.95 − Poly mid 14.5");
  assert.equal(rows[0].kalshiVsModelCents, -3.35);
  assert.equal(rows[0].modelCents, 20.3);
  assert.ok(rows[0].cross);
  assert.equal(rows[1].kalshi, null);
  assert.equal(rows[1].venueGapCents, null);
  assert.equal(rows[0].label, "$70,000 – $75,000");

  const snap = (at: string, kb: number, ka: number, pb: number, pa: number): Snapshot => ({
    at,
    spotUsd: 74000,
    spotSource: "brti",
    ladders: [{ ...merged, quotes: [q("kalshi", "range:70000-74999.99", kb, ka, 0), q("polymarket_us", "range:70000-74999.99", pb, pa, 0.095)] }],
    options: [],
    health: {},
  });
  const history = [snap("2026-11-09T20:00:00Z", 16, 17, 14, 15), snap("2026-11-09T20:01:00Z", 17, 18, 14, 15), snap("2026-11-09T20:02:00Z", 16, 17, 16, 17)].map(toHistoryPoint);
  const g = gapSeries(history, "btc-yearend-2026-range");
  const g70 = g.find((x) => x.key === "range:70000-74999.99");
  assert.ok(g70);
  assert.deepEqual(
    g70?.venue.map(([, v]) => v),
    [2, 3, 0],
  );
  assert.deepEqual(g70?.stats, { venueMeanAbs: 1.67, venueMax: 3, venueLast: 0, n: 3 });
});

test("latency: index moves over 1/5/15/60s from one-second prints, priced on an ATM digital of the given tenor", () => {
  const candles = [];
  let px = 74000;
  for (let t = 0; t < 600; t += 1) {
    px += t % 2 === 0 ? 7.4 : -7.4; // ±1 bp every second
    candles.push({ ts: 1_700_000_000 + t, open: px, high: px, low: px, close: px });
  }
  const smile: Smile = { expiry: "10NOV26", expiryMs: 0, forward: px, points: [70000, 74000, 78000].map((strike) => ({ strike, iv: 0.5 })) };
  const nowMs = 1_700_000_600_000;
  const rows = latencyTable(candles, [smile], nowMs + 45 * 60_000, nowMs);
  assert.deepEqual(
    rows.map((r) => r.horizonSec),
    [1, 5, 15, 60],
  );
  assert.ok(Math.abs(rows[0].p50Bps - 1) < 0.01, "the 1-second move is 1 bp by construction");
  assert.ok(Math.abs(rows[1].p50Bps - 1) < 0.01, "an alternating path nets to one step over odd horizons");
  assert.ok(rows[3].p50Bps < 0.01, "and to nothing over even ones");
  assert.ok((rows[0].atmCentsP50 ?? 0) > 0.5 && (rows[0].atmCentsP50 ?? 0) < 5, `1 bp on a 45-minute ATM digital is a few cents (got ${rows[0].atmCentsP50})`);
  const yearEnd = latencyTable(candles, [smile], nowMs + 50 * 86_400_000, nowMs);
  assert.ok((yearEnd[0].atmCentsP50 ?? 1) < (rows[0].atmCentsP50 ?? 0) / 10, "the same move is worth an order of magnitude less on a long tenor");
  assert.equal(latencyTable([], [smile], null, nowMs)[0].n, 0);
});

test("ladder vol: the forward and vol a venue's hourly ladder is priced at are recovered from its mids; realised vol from one-minute returns", () => {
  // a ladder quoted at 80% vol around $74,500 with 55 minutes to run, 1¢ wide
  const F = 74500;
  const T = 55 / (365.25 * 24 * 60);
  const s = 0.8 * Math.sqrt(T);
  const quotes: VenueQuote[] = [];
  const buckets = [];
  for (let K = 73500; K <= 75500; K += 100) {
    const p = normCdf((Math.log(F / K) - 0.5 * s * s) / s) * 100;
    buckets.push({ key: `above:${K}`, kind: "above" as const, level: K, settlesAt: SETTLE });
    quotes.push(q("kalshi", `above:${K}`, Math.round(p * 10) / 10 - 0.5, Math.round(p * 10) / 10 + 0.5, 0.07));
  }
  const ladder: Ladder = { id: "btc-hourly:t", title: "t", settlesAt: SETTLE, buckets, quotes, model: {} };
  // the index print is 40 dollars stale; the fit should not be fooled by it
  const fit = ladderImpliedVol(bucketRows(ladder), "kalshi", F - 40, T);
  assert.ok(fit, "enough two-sided strikes to fit");
  assert.ok(Math.abs((fit?.ladderPct ?? 0) - 80) < 2, `recovers 80% vol (got ${fit?.ladderPct}%)`);
  assert.ok(Math.abs((fit?.forwardUsd ?? 0) - F) < 15, `recovers the centre (got $${fit?.forwardUsd})`);
  assert.ok((fit?.rmsCents ?? 9) < 0.3, "and fits the mids to a fraction of a cent");
  assert.equal(ladderImpliedVol(bucketRows(ladder), "polymarket_us", F, T), null, "no Polymarket US mids → no fit");

  // realised vol: ±1 bp every second alternates, so one-minute returns net to zero…
  const flat = [];
  let px = 74000;
  for (let t = 0; t < 3600; t += 1) {
    px += t % 2 === 0 ? 7.4 : -7.4;
    flat.push({ ts: 1_700_000_000 + t, open: px, high: px, low: px, close: px });
  }
  assert.ok((realizedVolPct(flat, 60)?.pct ?? 1) < 1, "an alternating tick path has no one-minute variance");
  // …while a path that steps 10 bps every minute realises 10 bps · sqrt(525,960) ≈ 72.5%
  const trend = [];
  px = 74000;
  for (let t = 0; t < 3600; t += 1) {
    if (t % 60 === 0 && t > 0) px *= Math.floor(t / 60) % 2 === 0 ? 1.001 : 1 / 1.001;
    trend.push({ ts: 1_700_000_000 + t, open: px, high: px, low: px, close: px });
  }
  const rv = realizedVolPct(trend, 60);
  assert.ok(rv && Math.abs(rv.pct - 72.5) < 1.5, `10 bp per minute is 72.5% annualised (got ${rv?.pct}%)`);
});

test("replay: one ATM digital per hourly ladder is carried to settlement naked, with a static spread and with a dynamic delta; state survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "btc-replay-"));
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "replays.jsonl");
  const t0 = Date.UTC(2026, 10, 9, 21, 0, 0);
  const settleMs = t0 + 60 * 60_000;
  const expiryMs = settleMs + 10 * 3_600_000;
  const row = (strike: number, type: "C" | "P", iv = 0.5, bid = 0.01, ask = 0.012): OptionRow => ({
    instrument: `BTC-10NOV26-${strike}-${type}`,
    expiry: "10NOV26",
    expiryMs,
    strike,
    type,
    markIv: iv,
    markPrice: (bid + ask) / 2,
    bidPrice: bid,
    askPrice: ask,
    forward: 74000,
    openInterest: 1,
  });
  const chain = [72000, 73000, 74000, 75000, 76000].flatMap((k) => [row(k, "C"), row(k, "P")]);
  const hourly: Ladder = {
    id: "btc-hourly:KXBTCD-26NOV0917",
    title: "h",
    settlesAt: new Date(settleMs).toISOString(),
    buckets: [73750, 74000, 74250].map((level) => ({ key: `above:${level}`, kind: "above" as const, level, settlesAt: new Date(settleMs).toISOString() })),
    quotes: [q("kalshi", "above:73750", 60, 61, 0.07), q("kalshi", "above:74000", 49, 50, 0.07), q("kalshi", "above:74250", 38, 39, 0.07)],
    model: {},
  };
  const br = bracketCalls(chain, 74100, settleMs);
  assert.equal(br?.lo.strike, 74000);
  assert.equal(br?.hi.strike, 75000);

  const engine = new ReplayEngine(statePath, logPath, 2);
  engine.observe(hourly, 74010, chain, t0);
  assert.equal(engine.getOpen().length, 1);
  const ev = engine.getOpen()[0];
  assert.equal(ev.strike, 74000, "the strike nearest spot");
  assert.equal(ev.premiumCents, 49.5);
  assert.ok(ev.staticHedge, "a listed spread brackets the strike");
  assert.equal(ev.staticHedge?.widthUsd, 1000);
  assert.ok(ev.dynamicHedge.delta > 0);
  assert.equal(ev.steps, 1);

  // spot drifts up over the hour; the engine steps every snapshot and does not reopen the same ladder
  for (let i = 1; i <= 30; i += 1) engine.observe(hourly, 74010 + i * 10, chain, t0 + i * 60_000);
  assert.equal(engine.getOpen().length, 1);
  assert.equal(engine.getOpen()[0].steps, 31);
  assert.ok(engine.getOpen()[0].dynamicHedge.pnlUsd > 0, "long delta into a rally earns");

  // restart: state is reloaded from disk
  const again = new ReplayEngine(statePath, logPath, 2);
  assert.equal(again.getOpen()[0].steps, 31);
  assert.equal(again.dueForSettlement(settleMs + 30_000).length, 0, "the grace period lets the index print land");
  assert.equal(again.dueForSettlement(settleMs + 120_000).length, 1);

  const done = again.settle(hourly.id, 74320, 74320, chain, settleMs + 120_000);
  assert.ok(done?.done);
  assert.equal(done?.done?.payout, 1, "74,320 is at or above 74,000");
  assert.ok(Math.abs((done?.done?.nakedUsd ?? 0) - (0.495 - 1)) < 1e-9, "sold at 49.5¢, paid $1");
  assert.ok((done?.done?.dynamicUsd ?? -9) > (done?.done?.nakedUsd ?? 0), "the delta hedge recovered part of the payout");
  assert.ok(typeof done?.done?.staticUsd === "number");
  assert.equal(again.getOpen().length, 0);
  assert.equal(again.getDone().length, 1);
  assert.ok(existsSync(logPath));
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  const s = again.summary();
  assert.equal(s.n, 1);
  assert.equal(s.meanNaked, -0.505);
  assert.equal(s.recent[0].id, hourly.id);
  // seen before → not reopened
  again.observe(hourly, 74320, chain, settleMs + 180_000);
  assert.equal(again.getOpen().length, 0);

  // only hourly horizons enter the sample: tomorrow's 5 PM contract and a ladder in its last minutes are both skipped
  const farSettle = t0 + 22 * 3_600_000;
  const far: Ladder = { ...hourly, id: "btc-hourly:KXBTCD-26NOV1017", settlesAt: new Date(farSettle).toISOString() };
  again.observe(far, 74320, chain, t0);
  assert.equal(again.getOpen().length, 0, "a 22-hour contract is not an hourly replay");
  const late: Ladder = { ...hourly, id: "btc-hourly:KXBTCD-26NOV0918" };
  again.observe(late, 74320, chain, settleMs - 10 * 60_000);
  assert.equal(again.getOpen().length, 0, "ten minutes to the close is too late to open");
  again.observe(late, 74320, chain, settleMs - 25 * 60_000);
  assert.equal(again.getOpen().length, 1, "25 minutes to the close opens");

  // a legacy state file holding a multi-hour event is purged on load
  const legacy = JSON.parse(readFileSync(statePath, "utf8")) as { open: Array<{ settlesAtMs: number; openedAt: string }> };
  legacy.open.push({ ...legacy.open[0], settlesAtMs: farSettle, openedAt: new Date(t0).toISOString() });
  writeFileSync(statePath, JSON.stringify(legacy));
  const purged = new ReplayEngine(statePath, logPath, 2);
  assert.equal(purged.getOpen().length, 1);
  assert.equal(purged.getOpen()[0].settlesAtMs, settleMs);
});

test("store: snapshots append to a day file, reload into the history window, and old days are swept", () => {
  const dir = mkdtempSync(join(tmpdir(), "btc-store-"));
  const store = new SnapshotStore(dir, { keepHours: 1, retainDays: 2 });
  const snap = (at: string): Snapshot => ({ at, spotUsd: 74000, spotSource: "brti", ladders: [], options: [], health: {} });
  store.append(snap("2026-11-09T20:00:00Z"));
  store.append(snap("2026-11-09T20:01:00Z"));
  assert.ok(existsSync(join(dir, "snapshots-2026-11-09.jsonl")));
  assert.equal(store.getHistory().length, 2);
  assert.equal(store.getLatest()?.at, "2026-11-09T20:01:00Z");

  writeFileSync(join(dir, "snapshots-2026-11-01.jsonl"), `${JSON.stringify(snap("2026-11-01T00:00:00Z"))}\n{torn`);
  const fresh = new SnapshotStore(dir, { keepHours: 1, retainDays: 2 });
  assert.equal(fresh.load(Date.parse("2026-11-09T20:30:00Z")), 2, "only the points inside the window come back; the torn line is skipped");
  assert.equal(fresh.getLatest()?.at, "2026-11-09T20:01:00Z");
  assert.deepEqual(fresh.sweep(Date.parse("2026-11-09T20:30:00Z")), ["snapshots-2026-11-01.jsonl"]);
});

test("report page: the three sources, the gaps, the latency table and the replay render; the writer's take stays out unless asked", () => {
  const settle = SETTLE;
  const ladder: Ladder = {
    id: "btc-yearend-2026-range",
    title: "Bitcoin price at the end of 2026",
    settlesAt: settle,
    buckets: [
      { key: "range:70000-74999.99", kind: "range", lower: 70000, upper: 74999.99, settlesAt: settle },
      { key: "range:75000-79999.99", kind: "range", lower: 75000, upper: 79999.99, settlesAt: settle },
    ],
    quotes: [q("kalshi", "range:70000-74999.99", 16.9, 17, 0, 998, 66), q("polymarket_us", "range:70000-74999.99", 14, 15, 0.095, 62255, 13.8), q("kalshi", "range:75000-79999.99", 19.7, 19.8, 0), q("polymarket_us", "range:75000-79999.99", 21, 22, 0.095)],
    model: { "range:70000-74999.99": { p: 0.203, expiry: "25DEC26", iv: 0.55 }, "range:75000-79999.99": { p: 0.184, expiry: "25DEC26", iv: 0.5 } },
  };
  const snapshot: Snapshot = { at: "2026-11-09T20:02:00Z", spotUsd: 74222.14, spotSource: "brti", ladders: [ladder], options: [], health: { kalshi: { ok: true, ms: 300 }, polymarket_us: { ok: false, ms: 8000, detail: "HTTP 503" } } };
  const data = buildReport({
    snapshot,
    history: [toHistoryPoint(snapshot)],
    candles: [],
    replay: { n: 0, open: 1, meanNaked: null, meanStatic: null, meanDynamic: null, p90AbsNaked: null, p90AbsStatic: null, p90AbsDynamic: null, meanStaticEntryUsd: null, meanDynamicCostUsd: null, recent: [] },
    collar: {
      at: snapshot.at,
      ladderId: "btc-hourly:x",
      settlesAt: "2026-11-09T22:00:00Z",
      hedgeVenue: "okx",
      rows: [
        { bucketKey: "above:74000", label: "$74,000 or above", strike: 74000, markCents: 55, ok: true, floorCents: 40, capCents: 70, creditCents: 3, upsideGivenUpCents: 30, hedgeExpiry: "261110", alignment: "unwind_at_resolution", takeCents: 7, hedgeCostCents: 12 },
        { bucketKey: "above:77000", label: "$77,000 or above", strike: 77000, markCents: 8, ok: false, refusal: "mark 8c is outside the quotable 10c-92c band" },
      ],
    },
    intervalSec: 60,
    collectingSince: "2026-11-09T19:00:00Z",
  });
  assert.equal(data.yearEnd.length, 1);
  assert.equal(data.yearEnd[0].sumKalshi, 37, "16.95 + 19.75");
  assert.equal(data.yearEnd[0].sumPoly, 36);
  assert.equal(data.yearEnd[0].sumModel, 39);
  const html = renderReportHtml(data, { refreshSec: 60 });
  for (const needle of [
    "Bitcoin on the event venues",
    "$74,222.14",
    "Kalshi − Poly",
    "Option-implied",
    "$70,000 – $75,000",
    "buy Poly 15¢ → sell Kalshi 16.9¢",
    "+0.69¢",
    "13.8 ct",
    "Executable crosses right now",
    "Sum of mids",
    "Gaps over time",
    "What being late costs",
    "Static vs dynamic hedge",
    "1 in flight",
    "Lock in along the ladder",
    "40¢",
    "70¢",
    "refused · mark 8c is outside",
    "polymarket_us HTTP 503",
    "preprod environment",
    'http-equiv="refresh" content="60"',
    "noindex",
  ]) {
    assert.ok(html.includes(needle), `page shows ${needle}`);
  }
  assert.ok(html.includes("Upside given up"), "the holder's give-up side is a column");
  assert.ok(html.includes("30¢"));
  assert.ok(html.includes("take 7¢ · legs 12¢"), "the collar row carries writer economics only because the fixture set them (the service leaves them undefined unless BTC_CURVE_SHOW_TAKE=1)");
  assert.ok(!/takeBps|partner|host share/i.test(html), "no writer economics beyond what the fixture carried");
});

test("store: option rows travel to disk as tuples and come back whole", async () => {
  const { toDisk, fromDisk } = await import("../src/btcCurve/store");
  const row: OptionRow = { instrument: "BTC-25DEC26-104000-C", expiry: "25DEC26", expiryMs: expiryTagToMs("25DEC26"), strike: 104000, type: "C", markIv: 0.4604, markPrice: 0.001647, bidPrice: 0.0015, askPrice: 0.0018, forward: 74922.19, openInterest: 183.2 };
  const ladder: Ladder = {
    id: "btc-yearend-2026-range",
    title: "t",
    settlesAt: SETTLE,
    buckets: [{ key: "range:70000-74999.99", kind: "range", lower: 70000, upper: 74999.99, settlesAt: SETTLE }],
    quotes: [q("kalshi", "range:70000-74999.99", 16.9, 17, 0, 998.71, 66.01)],
    model: { "range:70000-74999.99": { p: 0.203, expiry: "25DEC26", iv: 0.55 } },
  };
  const snap: Snapshot = { at: "2026-11-09T20:00:00Z", spotUsd: 74000, spotSource: "brti", ladders: [ladder], options: [row], health: {} };
  const line = toDisk(snap);
  assert.ok(line.length < 600, `tuples keep the line short (${line.length} bytes)`);
  const back = fromDisk(line);
  assert.deepEqual(back.options[0], row);
  assert.deepEqual(back.ladders[0], ladder);
  assert.deepEqual(fromDisk(JSON.stringify(snap)).ladders[0], ladder, "older full-object lines still load");
});
