/**
 * The pairs replay core on hand-made cycles. Every expected figure is worked by hand in the
 * comment above its assertion, in cents, then written as integer milli-cents (1000 = 1 cent).
 *
 * The books used throughout, size 10 traded, Kalshi coefficient 0.07, Polymarket US 0.095.
 * Per contract fees are what the repo's takerFeeCents returns (it rounds up to a thousandth of
 * a cent, and takes a float's last bit up with it: 1.68 exact comes back as 1.681):
 *
 *   Yes on Kalshi at 40, No on Polymarket US at 50 (its Yes bid is 50):
 *     Kalshi fee     1.681 a contract, 16.81 for ten, charged as 17
 *     Polymarket fee 2.375 a contract, 23.75 for ten, charged as 24
 *     net for ten    10 x (100 - 40 - 50) - 17 - 24 = 100 - 41 = 59 cents, 5.9 a pair
 *   Kalshi ask 44:   fee 1.725, 17.25 -> 18.   net 10 x 6 - 18 - 24 =  18 cents, 1.8 a pair
 *   Kalshi ask 47:   fee 1.744, 17.44 -> 18.   net 10 x 3 - 18 - 24 = -12 cents, -1.2 a pair
 *   Kalshi ask 49:   fee 1.750, 17.50 -> 18.   net 10 x 1 - 18 - 24 = -32 cents, -3.2 a pair
 *   Kalshi ask 52:   fee 1.748, 17.48 -> 18.   net 10 x -2 - 18 - 24 = -62 cents, -6.2 a pair
 *   Kalshi ask 38:   fee 1.650, 16.50 -> 17.   net 10 x 12 - 17 - 24 = 79 cents, 7.9 a pair
 */

import assert from "node:assert/strict";
import test from "node:test";
import { lockOf } from "../src/btcCurve/pairs";
import { parseCycleLine, type StoredCycle, type StoredLeg, type StoredPair } from "../src/btcCurve/pairsCycles";
import { ASSUMPTIONS, DEFAULT_RULE, createReplay, priceLock, replayPairs, ruleProblem, type ReplayRule } from "../src/btcCurve/pairsReplay";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const K_ID = "KXBTCD-26NOV1013-T73999.99";
const P_ID = "cpc-btc-above-hour-2026-11-10-74000";

const leg = (id: string, feeTheta: number, bid: number, ask: number, over: Partial<StoredLeg> = {}): StoredLeg => ({ id, bidCents: bid, askCents: ask, bidQty: 100, askQty: 100, feeTheta, ageSec: 2, fetchAgeSec: 1, cacheAgeSec: 1, venueAgeSec: null, ...over });
const kalshi = (bid: number, ask: number, over: Partial<StoredLeg> = {}) => leg(K_ID, 0.07, bid, ask, over);
const poly = (bid: number, ask: number, over: Partial<StoredLeg> = {}) => leg(P_ID, 0.095, bid, ask, over);
const pairOf = (k: StoredLeg | null, p: StoredLeg | null, over: Partial<StoredPair> = {}): StoredPair => ({ horizon: "hourly", place: "atm", strike: 74000, key: "above:74000", settlesAt: "2026-11-10T13:00:00.000Z", staleAfterSec: 30, kalshi: k, poly: p, ...over });
/** Yes on Kalshi at `kAsk`, No on Polymarket US at 100 - `pBid`; the other way round is never a lock on these books. */
const book = (kAsk: number, pBid = 50, over: Partial<StoredPair> = {}) => pairOf(kalshi(kAsk - 2, kAsk), poly(pBid, pBid + 2), over);
const cycleAt = (sec: number, pairs: StoredPair[], over: Partial<StoredCycle> = {}): StoredCycle => ({ at: T0 + sec * 1000, rows: [], v: 2, pricedAt: T0 + sec * 1000, intervalSec: 10, spotUsd: 73_700, pairs, ...over });
const rule = (over: Partial<ReplayRule> = {}): ReplayRule => ({ ...DEFAULT_RULE, lagSec: 0, ...over });
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** No lock, a lock of 5.9, then it shrinks to 1.8, goes to -1.2 and to -3.2. One cycle every 10 seconds. */
const FADING = [cycleAt(0, [book(52)]), cycleAt(10, [book(40)]), cycleAt(20, [book(44)]), cycleAt(30, [book(47)]), cycleAt(40, [book(49)])];

test("the lock at a size is priced in whole milli-cents with each leg's fee rounded up to the cent, and is never above the page's lock", () => {
  const k = { venue: "kalshi" as const, bidCents: 38, askCents: 40, bidQty: 100, askQty: 100, feeTheta: 0.07 };
  const p = { venue: "polymarket_us" as const, bidCents: 50, askCents: 52, bidQty: 80, askQty: 100, feeTheta: 0.095 };
  // ten: 10 x (100 - 40 - 50) = 100, fees 17 + 24 = 41, net 59 cents, 5.9 a pair
  assert.deepEqual(priceLock(k, p, 10), { yesOn: "kalshi", noOn: "polymarket_us", yesAtMc: 40_000, noAtMc: 50_000, feesMc: 41_000, netMc: 59_000, edgeMc: 5_900, qty: 80 });
  // one: fees 1.681 -> 2 and 2.375 -> 3, net 10 - 5 = 5 cents
  assert.deepEqual(priceLock(k, p, 1), { yesOn: "kalshi", noOn: "polymarket_us", yesAtMc: 40_000, noAtMc: 50_000, feesMc: 5_000, netMc: 5_000, edgeMc: 5_000, qty: 80 });
  // three: fees 5.043 -> 6 and 7.125 -> 8, net 30 - 14 = 16 cents; a pair is 16 / 3 = 5.333..., reported down as 5.333
  assert.deepEqual(priceLock(k, p, 3), { yesOn: "kalshi", noOn: "polymarket_us", yesAtMc: 40_000, noAtMc: 50_000, feesMc: 14_000, netMc: 16_000, edgeMc: 5_333, qty: 80 });
  // the other way round: Yes on Polymarket US at 52, No on Kalshi at 100 - 38 = 62: 10 x (100 - 52 - 62) = -140;
  // fees 2.372 x 10 = 23.72 -> 24 and 0.07 x .62 x .38 = 1.65 (1.650 a contract) x 10 = 16.5 -> 17; net -181 cents, -18.1 a pair
  assert.deepEqual(priceLock(p, k, 10), { yesOn: "polymarket_us", noOn: "kalshi", yesAtMc: 52_000, noAtMc: 62_000, feesMc: 41_000, netMc: -181_000, edgeMc: -18_100, qty: 100 });
  // a negative edge a pair is rounded down too, away from zero. Three at Kalshi 52 over Polymarket US 50:
  // 3 x (100 - 52 - 50) = -6; fees 1.748 x 3 = 5.244 -> 6 and 2.375 x 3 = 7.125 -> 8; net -20 cents; a pair is -6.666..., reported as -6.667
  assert.deepEqual(priceLock({ ...k, bidCents: 50, askCents: 52 }, p, 3), { yesOn: "kalshi", noOn: "polymarket_us", yesAtMc: 52_000, noAtMc: 50_000, feesMc: 14_000, netMc: -20_000, edgeMc: -6_667, qty: 80 });
  // an empty side has no price
  assert.equal(priceLock({ ...k, askCents: 0 }, p, 10), null);
  assert.equal(priceLock(k, { ...p, bidCents: 0 }, 10), null);

  // the page's lock for one contract carries the fees unrounded (1.681 + 2.375 = 4.056 -> 5.94 a pair); the replay's 5.9 is below it
  const page = lockOf({ ...k, bucketKey: "", id: "", volume: 0, openInterest: 0 }, { ...p, bucketKey: "", id: "", volume: 0, openInterest: 0 });
  assert.equal(page?.edgeCents, 5.94);
  assert.ok((priceLock(k, p, 10) as { edgeMc: number }).edgeMc <= Math.round((page?.edgeCents as number) * 1000));
});

test("lag 0: the signal is the first cycle whose own reads show the lock, and it is captured at that cycle's edge; this is the upper bound", () => {
  const r = replayPairs(FADING, rule({ lagSec: 0 }));
  assert.equal(r.total.signals, 1);
  assert.equal(r.total.captured, 1);
  assert.deepEqual(r.total.gone, { total: 0, edge: 0, size: 0 });
  assert.equal(r.total.unknown.total, 0);
  // 59 cents for ten, 5.9 a pair
  assert.equal(r.total.capturedMc, 59_000);
  assert.equal(r.total.medianCapturedEdgeMc, 5_900);
  assert.equal(r.total.worstCapturedEdgeMc, 5_900);
  assert.equal(r.total.sentAnywayMc, 59_000);
  assert.equal(r.total.shownAtSignalMc, 59_000);
  assert.equal(r.total.survivedShare, 1);
  assert.deepEqual(r.total.fillDelaySec, { median: 0, max: 0 });
  assert.match(r.lagLabel, /upper bound nobody achieves/);
  // the cycle before the lock (t = 0) is not the signal: nothing of the next cycle is seen from it
  assert.deepEqual(r.trades, [{ horizon: "hourly", settlesAt: "2026-11-10T13:00:00.000Z", key: "above:74000", strike: 74000, kalshiId: K_ID, polyId: P_ID, yesOn: "kalshi", signalAt: iso(10), signalEdgeMc: 5_900, outcome: "captured", why: null, fillAt: iso(10), fillEdgeMc: 5_900, capturedMc: 59_000 }]);
  assert.equal(r.cyclesRead, 5);
  assert.equal(r.daysCovered, 1);
  assert.deepEqual(r.rule, rule({ lagSec: 0 }));
  assert.equal(r.assumptions, ASSUMPTIONS);
});

test("lag 10: the trade fills one cycle later at that cycle's edge, which is smaller than the signal's", () => {
  const r = replayPairs(FADING, rule({ lagSec: 10 }));
  assert.equal(r.total.signals, 1);
  assert.equal(r.total.captured, 1);
  // the fill cycle (t = 20) shows 18 cents for ten, 1.8 a pair; the signal's 59 is not what is captured
  assert.equal(r.total.capturedMc, 18_000);
  assert.equal(r.total.medianCapturedEdgeMc, 1_800);
  assert.equal(r.total.worstCapturedEdgeMc, 1_800);
  assert.equal(r.total.sentAnywayMc, 18_000);
  assert.equal(r.total.shownAtSignalMc, 59_000);
  assert.deepEqual(r.total.fillDelaySec, { median: 10, max: 10 });
  assert.equal(r.trades[0].signalAt, iso(10));
  assert.equal(r.trades[0].signalEdgeMc, 5_900);
  assert.equal(r.trades[0].fillAt, iso(20));
  assert.equal(r.trades[0].fillEdgeMc, 1_800);
  assert.equal(r.trades[0].capturedMc, 18_000);
  assert.doesNotMatch(r.lagLabel, /upper bound/);
});

test("lag 20 and lag 30: the edge is below zero at the fill cycle, so the trade is gone and captures nothing; sent anyway carries the loss", () => {
  const at20 = replayPairs(FADING, rule({ lagSec: 20 }));
  assert.equal(at20.total.signals, 1);
  assert.equal(at20.total.captured, 0);
  assert.deepEqual(at20.total.gone, { total: 1, edge: 1, size: 0 });
  assert.equal(at20.total.unknown.total, 0);
  assert.equal(at20.total.capturedMc, 0);
  assert.equal(at20.total.medianCapturedEdgeMc, null);
  assert.equal(at20.total.worstCapturedEdgeMc, null);
  // the fill cycle (t = 30) shows -12 cents for ten
  assert.equal(at20.total.sentAnywayMc, -12_000);
  assert.equal(at20.total.sentAnywayNotPriced, 0);
  assert.equal(at20.total.survivedShare, 0);
  assert.deepEqual([at20.trades[0].outcome, at20.trades[0].why, at20.trades[0].fillAt, at20.trades[0].fillEdgeMc, at20.trades[0].capturedMc], ["gone", "edge", iso(30), -1_200, 0]);

  const at30 = replayPairs(FADING, rule({ lagSec: 30 }));
  assert.deepEqual(at30.total.gone, { total: 1, edge: 1, size: 0 });
  assert.equal(at30.total.capturedMc, 0);
  // the fill cycle (t = 40) shows -32 cents for ten
  assert.equal(at30.total.sentAnywayMc, -32_000);
  assert.deepEqual([at30.trades[0].outcome, at30.trades[0].why, at30.trades[0].fillAt, at30.trades[0].fillEdgeMc], ["gone", "edge", iso(40), -3_200]);
});

test("an edge of exactly zero at the fill is captured (the limit at break even fills); a tenth of a cent worse is gone", () => {
  // Kalshi ask 45.8: fee 1.738 a contract, 17.38 -> 18; 10 x (100 - 45.8 - 50) = 42; net 42 - 18 - 24 = 0
  const even = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(45.8)])], rule({ lagSec: 10 }));
  assert.equal(even.total.captured, 1);
  assert.equal(even.total.capturedMc, 0);
  assert.equal(even.total.medianCapturedEdgeMc, 0);
  assert.equal(even.total.gone.total, 0);
  // Kalshi ask 45.9: fee 1.739, 17.39 -> 18; 10 x 4.1 = 41; net 41 - 42 = -1 cent, -0.1 a pair
  const under = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(45.9)])], rule({ lagSec: 10 }));
  assert.equal(under.total.captured, 0);
  assert.deepEqual(under.total.gone, { total: 1, edge: 1, size: 0 });
  assert.equal(under.total.sentAnywayMc, -1_000);
  assert.equal(under.trades[0].fillEdgeMc, -100);
});

test("the minimum edge is net of both fees at the size traded, to the milli-cent", () => {
  const lock = [cycleAt(0, [book(40)])];
  // 5.9 a pair at ten
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 5.9 })).total.signals, 1);
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 5.901 })).total.signals, 0);
  // before fees the lock is 10 a pair: a rule of 6 is not met although 10 - 40 - 50 leaves 10
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 6 })).total.signals, 0);
  // one contract: fees 2 + 3, net 5 a pair; ten contracts: 5.9 a pair
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 5.5, minSizeContracts: 1, sizeContracts: 1 })).total.signals, 0);
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 5, minSizeContracts: 1, sizeContracts: 1 })).total.capturedMc, 5_000);
  // dropping either venue's fee would make these signals: with only Kalshi's 17 the net is 83 (8.3 a pair), with only Polymarket's 24 it is 76 (7.6)
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 7.6 })).total.signals, 0);
  assert.equal(replayPairs(lock, rule({ minEdgeCents: 8.3 })).total.signals, 0);
});

test("a data gap: with no stored cycle within one interval plus the tolerance after signal plus lag, the outcome is unknown, never captured and never zero", () => {
  // signal at t = 10, lag 10: the fill cycle must land in [20, 20 + 10 + 5 = 35]
  const gap = replayPairs([cycleAt(10, [book(40)]), cycleAt(46, [book(40)])], rule({ lagSec: 10 }));
  assert.equal(gap.total.signals, 1);
  assert.equal(gap.total.captured, 0);
  assert.equal(gap.total.gone.total, 0);
  assert.deepEqual(gap.total.unknown, { total: 1, noCycle: 1, noRead: 0, staleRead: 0, oldRead: 0 });
  assert.equal(gap.total.capturedMc, 0);
  assert.equal(gap.total.sentAnywayMc, 0);
  // no known outcome, so no share: unknown is not a zero in it
  assert.equal(gap.total.survivedShare, null);
  assert.equal(gap.total.fillDelaySec, null);
  assert.deepEqual([gap.trades[0].outcome, gap.trades[0].why, gap.trades[0].fillAt, gap.trades[0].fillEdgeMc], ["unknown", "noCycle", null, null]);
  assert.equal(gap.signalsOpenAtEnd, 0);

  // a cycle exactly at the last moment (t = 35) is the fill; a millisecond later is not
  const onTime = replayPairs([cycleAt(10, [book(40)]), cycleAt(35, [book(40)])], rule({ lagSec: 10 }));
  assert.equal(onTime.total.captured, 1);
  assert.equal(onTime.total.capturedMc, 59_000);
  assert.deepEqual(onTime.total.fillDelaySec, { median: 25, max: 25 });
  const late = replayPairs([cycleAt(10, [book(40)]), cycleAt(35.001, [book(40)])], rule({ lagSec: 10 }));
  assert.equal(late.total.unknown.noCycle, 1);
  assert.equal(late.total.captured, 0);
  // the tolerance is the rule's: with 20 seconds of it the cycle at t = 46 is the fill (20 + 10 + 20 = 50)
  assert.equal(replayPairs([cycleAt(10, [book(40)]), cycleAt(46, [book(40)])], rule({ lagSec: 10, gapToleranceSec: 20 })).total.captured, 1);
  // the interval is the one stored on the signal's line: at a 30-second cadence the cycle at t = 46 is in time (20 + 30 + 5 = 55)
  assert.equal(replayPairs([cycleAt(10, [book(40)], { intervalSec: 30 }), cycleAt(46, [book(40)])], rule({ lagSec: 10 })).total.captured, 1);

  // the data ends before the fill cycle: unknown, and said
  const ends = replayPairs([cycleAt(0, [book(52)]), cycleAt(10, [book(40)])], rule({ lagSec: 10 }));
  assert.equal(ends.total.signals, 1);
  assert.deepEqual(ends.total.unknown, { total: 1, noCycle: 1, noRead: 0, staleRead: 0, oldRead: 0 });
  assert.equal(ends.signalsOpenAtEnd, 1);
  assert.equal(ends.total.captured, 0);
  assert.equal(ends.days[0].unknown, 1);
});

test("the fill cycle is the first at or after signal time plus lag: a cycle just before it is not the fill", () => {
  // signal at t = 10, lag 10: t = 19.999 is before 20, so the fill is t = 30 (18 cents), not t = 19.999 (59 cents)
  const r = replayPairs([cycleAt(10, [book(40)]), cycleAt(19.999, [book(40)]), cycleAt(30, [book(44)])], rule({ lagSec: 10 }));
  assert.equal(r.total.captured, 1);
  assert.equal(r.total.capturedMc, 18_000);
  assert.equal(r.trades[0].fillAt, iso(30));
  // a cycle exactly at signal plus lag is the fill
  const exact = replayPairs([cycleAt(10, [book(40)]), cycleAt(20, [book(44)]), cycleAt(30, [book(40)])], rule({ lagSec: 10 }));
  assert.equal(exact.trades[0].fillAt, iso(20));
  assert.equal(exact.total.capturedMc, 18_000);
  // a lag of 5 falls between cycles and resolves to the next stored one
  const between = replayPairs([cycleAt(10, [book(40)]), cycleAt(20, [book(44)])], rule({ lagSec: 5 }));
  assert.equal(between.trades[0].fillAt, iso(20));
  assert.deepEqual(between.total.fillDelaySec, { median: 10, max: 10 });
});

test("a cycle's time is when its books were priced, not when the cycle started", () => {
  // the second cycle started at t = 19 but was priced at t = 21: with lag 10 from a signal priced at t = 10.5 the fill is due at 20.5
  const r = replayPairs([cycleAt(10, [book(40)], { pricedAt: T0 + 10_500 }), cycleAt(19, [book(44)], { pricedAt: T0 + 21_000 })], rule({ lagSec: 10 }));
  assert.equal(r.trades[0].signalAt, new Date(T0 + 10_500).toISOString());
  assert.equal(r.trades[0].fillAt, new Date(T0 + 21_000).toISOString());
  assert.equal(r.total.capturedMc, 18_000);
  assert.deepEqual(r.total.fillDelaySec, { median: 10.5, max: 10.5 });
});

test("a fill read that is stale, too old or missing is unknown: it is not gone and not captured, whatever the prices say", () => {
  const fillWith = (p: StoredPair[], over: Partial<ReplayRule> = {}) => replayPairs([cycleAt(10, [book(40)]), cycleAt(20, p)], rule({ lagSec: 10, ...over })).total;
  // Polymarket US copy 31 seconds old against the row's 30-second bound: stale, though the stored prices are still a lock
  const stale = fillWith([pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 31, cacheAgeSec: 30 }))]);
  assert.deepEqual(stale.unknown, { total: 1, noCycle: 0, noRead: 0, staleRead: 1, oldRead: 0 });
  assert.equal(stale.captured, 0);
  assert.equal(stale.gone.total, 0);
  assert.equal(stale.capturedMc, 0);
  assert.equal(stale.sentAnywayMc, 0);
  assert.equal(stale.survivedShare, null);
  // the Kalshi copy stale instead
  assert.equal(fillWith([pairOf(kalshi(38, 40, { ageSec: 30.1 }), poly(50, 52))]).unknown.staleRead, 1);
  // exactly at the bound is not stale
  assert.equal(fillWith([pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 30 }))]).captured, 1);
  // fresh for the tenor (30) but older than the rule allows (20): unknown, even with prices that would read as gone
  const old = fillWith([pairOf(kalshi(47, 49), poly(50, 52, { ageSec: 25 }))], { maxReadAgeSec: 20 });
  assert.deepEqual(old.unknown, { total: 1, noCycle: 0, noRead: 0, staleRead: 0, oldRead: 1 });
  assert.equal(old.gone.total, 0);
  assert.equal(old.sentAnywayMc, 0);
  // a book that did not answer, a pair no longer in the cycle, a read with no age stored, another market under the same key
  assert.equal(fillWith([pairOf(kalshi(38, 40), null, { errors: [{ venue: "polymarket_us", kind: "timeout" }] })]).unknown.noRead, 1);
  assert.equal(fillWith([]).unknown.noRead, 1);
  assert.equal(fillWith([pairOf(kalshi(38, 40), poly(50, 52, { ageSec: null }))]).unknown.noRead, 1);
  assert.equal(fillWith([pairOf(kalshi(38, 40), { ...poly(50, 52), id: "another-market" })]).unknown.noRead, 1);
  assert.equal(fillWith([book(40, 50, { horizon: "daily" })]).unknown.noRead, 1);
});

test("a signal needs both reads fresh and inside the rule's age, on that cycle", () => {
  const signals = (p: StoredPair, over: Partial<ReplayRule> = {}) => replayPairs([cycleAt(0, [p])], rule(over)).total.signals;
  assert.equal(signals(book(40)), 1);
  assert.equal(signals(pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 31 }))), 0);
  assert.equal(signals(pairOf(kalshi(38, 40, { ageSec: 31 }), poly(50, 52))), 0);
  assert.equal(signals(pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 25 })), { maxReadAgeSec: 20 }), 0);
  assert.equal(signals(pairOf(kalshi(38, 40, { ageSec: 25 }), poly(50, 52)), { maxReadAgeSec: 20 }), 0);
  assert.equal(signals(pairOf(kalshi(38, 40, { ageSec: 20 }), poly(50, 52, { ageSec: 20 })), { maxReadAgeSec: 20 }), 1);
  assert.equal(signals(pairOf(kalshi(38, 40), poly(50, 52, { ageSec: null }))), 0);
  assert.equal(signals(pairOf(kalshi(38, 40), null)), 0);
  assert.equal(signals(pairOf(kalshi(38, 40), poly(50, 52), { errors: [{ venue: "kalshi", kind: "http" }] })), 0);
  // the 15-minute row is judged against its own stored bound (15), not the rule's 30
  assert.equal(signals(pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 16 }), { horizon: "fifteen", staleAfterSec: 15 })), 0);
});

test("one trade per episode: no new signal while the conditions hold, a new one only after a stored cycle at which they did not", () => {
  // the lock stands for three cycles, goes for one, and comes back: two signals, not four
  const twice = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(40)]), cycleAt(20, [book(40)]), cycleAt(30, [book(52)]), cycleAt(40, [book(40)]), cycleAt(50, [book(40)])], rule({ lagSec: 0 }));
  assert.equal(twice.total.signals, 2);
  assert.deepEqual(twice.trades.map((t) => t.signalAt), [iso(0), iso(40)]);
  // 59 cents each
  assert.equal(twice.total.capturedMc, 118_000);

  // a lock that only shrinks below the rule's minimum has gone false: 1.8 a pair is under a 2 cent rule, so the next 5.9 is a new signal
  const dipped = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(44)]), cycleAt(20, [book(40)])], rule({ lagSec: 0, minEdgeCents: 2 }));
  assert.deepEqual(dipped.trades.map((t) => t.signalAt), [iso(0), iso(20)]);
  // under a 1 cent rule the same cycles are one episode
  assert.equal(replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(44)]), cycleAt(20, [book(40)])], rule({ lagSec: 0 })).total.signals, 1);

  // a stale cycle, a missing book and a cycle without the pair each end the episode
  for (const broken of [pairOf(kalshi(38, 40), poly(50, 52, { ageSec: 31 })), pairOf(kalshi(38, 40), null)]) {
    assert.equal(replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [broken]), cycleAt(20, [book(40)])], rule({ lagSec: 0 })).total.signals, 2);
  }
  assert.equal(replayPairs([cycleAt(0, [book(40)]), cycleAt(10, []), cycleAt(20, [book(40)])], rule({ lagSec: 0 })).total.signals, 2);

  // a stretch with no stored cycle does not re-arm: nothing was seen to be false
  assert.equal(replayPairs([cycleAt(0, [book(40)]), cycleAt(600, [book(40)])], rule({ lagSec: 0 })).total.signals, 1);

  // the same pair the other way round is a different trade (the repo's lock run identity): Yes on Polymarket US at 40, No on Kalshi at 50
  // fees: Polymarket 2.281 x 10 = 22.81 -> 23, Kalshi at 50 is 1.751 x 10 = 17.51 -> 18; net 100 - 41 = 59 cents
  const flipped = pairOf(kalshi(50, 52), poly(38, 40));
  const both = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [flipped])], rule({ lagSec: 0 }));
  assert.deepEqual(both.trades.map((t) => [t.signalAt, t.yesOn, t.capturedMc]), [[iso(0), "kalshi", 59_000], [iso(10), "polymarket_us", 59_000]]);
  // another contract is another episode
  const other = book(40, 50, { key: "above:74100", strike: 74100, kalshi: { ...kalshi(38, 40), id: "K2" }, poly: { ...poly(50, 52), id: "P2" } });
  assert.equal(replayPairs([cycleAt(0, [book(40), other]), cycleAt(10, [book(40), other])], rule({ lagSec: 0 })).total.signals, 2);
});

test("the fill is judged the way round it was signalled: a lock the other way at the fill cycle does not rescue the trade", () => {
  // signal: Yes on Kalshi at 40. At the fill cycle that way costs 52 + 62 (gone), while Yes on Polymarket US at 40 with No on Kalshi at 50 is a lock
  const r = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [pairOf(kalshi(50, 52), poly(38, 40))])], rule({ lagSec: 10 }));
  // the first trade: 10 x (100 - 52 - 62) = -140; fees Kalshi at 52 17.48 -> 18, Polymarket No at 62 2.239 x 10 = 22.39 -> 23; net -181 cents
  assert.deepEqual([r.trades[0].yesOn, r.trades[0].outcome, r.trades[0].why, r.trades[0].fillEdgeMc], ["kalshi", "gone", "edge", -18_100]);
  // the other way round is its own signal at t = 10, still waiting for its fill when the data ends
  assert.deepEqual([r.trades[1].yesOn, r.trades[1].signalAt, r.trades[1].outcome, r.trades[1].why], ["polymarket_us", iso(10), "unknown", "noCycle"]);
  assert.equal(r.total.captured, 0);
  assert.equal(r.total.sentAnywayMc, -181_000);
});

test("size: no signal unless the top of both books holds the size, and a fill without the size is gone and not priced", () => {
  const thin = (qty: number) => pairOf(kalshi(38, 40, { askQty: qty }), poly(50, 52));
  const thinNo = (qty: number) => pairOf(kalshi(38, 40), poly(50, 52, { bidQty: qty }));
  const signals = (p: StoredPair, over: Partial<ReplayRule> = {}) => replayPairs([cycleAt(0, [p])], rule(over)).total.signals;
  // ten wanted: nine on either leg is no signal, ten is
  assert.equal(signals(thin(9)), 0);
  assert.equal(signals(thinNo(9)), 0);
  assert.equal(signals(thin(10)), 1);
  // the sizes that count are the ones taken (the Yes ask and the other venue's Yes bid), not the other two
  assert.equal(signals(pairOf(kalshi(38, 40, { bidQty: 1 }), poly(50, 52, { askQty: 1 }))), 1);
  // a rule may want more showing than it trades: 50 showing, 10 traded
  assert.equal(signals(thin(49), { minSizeContracts: 50, sizeContracts: 10 }), 0);
  assert.equal(replayPairs([cycleAt(0, [thin(50)])], rule({ minSizeContracts: 50, sizeContracts: 10 })).total.capturedMc, 59_000);
  // and it never trades more than is showing: 5 wanted showing, 10 traded, 9 there
  assert.equal(signals(thin(9), { minSizeContracts: 5, sizeContracts: 10 }), 0);

  // at the fill the size has gone: gone, nothing captured, and no sent anyway figure because the depth below the top is not stored
  const r = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [thinNo(9)])], rule({ lagSec: 10 }));
  assert.deepEqual(r.total.gone, { total: 1, edge: 0, size: 1 });
  assert.equal(r.total.captured, 0);
  assert.equal(r.total.capturedMc, 0);
  assert.equal(r.total.sentAnywayMc, 0);
  assert.equal(r.total.sentAnywayNotPriced, 1);
  assert.deepEqual([r.trades[0].outcome, r.trades[0].why, r.trades[0].fillEdgeMc], ["gone", "size", null]);
  // an empty side at the fill is the same
  const empty = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [pairOf(kalshi(38, 0, { askQty: 0 }), poly(50, 52))])], rule({ lagSec: 10 }));
  assert.deepEqual(empty.total.gone, { total: 1, edge: 0, size: 1 });
});

test("a longer lag is not assumed to capture less: a lock that goes and comes back is gone at lag 10 and captured at lag 20", () => {
  // t = 0 lock of 5.9; t = 10 gone (-6.2); t = 20 and 30 a lock of 7.9; t = 40 gone
  const cycles = [cycleAt(0, [book(40)]), cycleAt(10, [book(52)]), cycleAt(20, [book(38)]), cycleAt(30, [book(38)]), cycleAt(40, [book(52)])];
  const at10 = replayPairs(cycles, rule({ lagSec: 10 }));
  const at20 = replayPairs(cycles, rule({ lagSec: 20 }));
  // both see the same two signals: t = 0, and t = 20 after the false cycle at t = 10
  assert.deepEqual(at10.trades.map((t) => t.signalAt), [iso(0), iso(20)]);
  assert.deepEqual(at20.trades.map((t) => t.signalAt), [iso(0), iso(20)]);
  // lag 10: the first fills at t = 10 (-62 cents: gone), the second at t = 30 (79 cents)
  assert.deepEqual(at10.trades.map((t) => [t.outcome, t.capturedMc]), [["gone", 0], ["captured", 79_000]]);
  assert.equal(at10.total.capturedMc, 79_000);
  assert.equal(at10.total.sentAnywayMc, 79_000 - 62_000);
  // lag 20: the first fills at t = 20 (79 cents: captured, more than lag 10 gave it), the second at t = 40 (-62: gone)
  assert.deepEqual(at20.trades.map((t) => [t.outcome, t.capturedMc]), [["captured", 79_000], ["gone", 0]]);
  assert.equal(at20.total.capturedMc, 79_000);
  assert.ok(at20.trades[0].capturedMc > at10.trades[0].capturedMc);
  // and a lag can capture more than the signal showed: 79 against the 59 shown at t = 0
  assert.ok(at20.trades[0].capturedMc > at20.trades[0].signalEdgeMc * 10);
});

test("old lines are counted and reported, not replayed and not guessed at", () => {
  const old = (sec: number) => parseCycleLine(JSON.stringify({ at: T0 + sec * 1000, rows: [["2026-11-10T13:00:00.000Z", "above:74000", 12.5]] }));
  assert.deepEqual(old(0), { kind: "old", atMs: T0 });
  // a 12.5 cent gap between the mids on every old line: a lock by any guess, and no signal here
  const onlyOld = replayPairs([old(0), old(10), old(20)], rule({ lagSec: 0 }));
  assert.equal(onlyOld.total.signals, 0);
  assert.equal(onlyOld.cyclesRead, 0);
  assert.equal(onlyOld.cyclesOldFormat, 3);
  assert.equal(onlyOld.daysCovered, 0);
  assert.deepEqual(onlyOld.days.map((d) => [d.day, d.cyclesRead, d.cyclesOldFormat, d.signals]), [["2026-11-10", 0, 3, 0]]);
  assert.match(onlyOld.days[0].note ?? "", /Old form only \(3 cycles of gaps, no books\): nothing can be replayed on this day\./);
  assert.match(onlyOld.notes.join(" "), /3 stored cycles are in the old form .* no prices, sizes, fees or read ages/);
  assert.match(onlyOld.notes.join(" "), /No cycle in the range could be replayed\./);

  // an old line cannot be a fill cycle: the signal at t = 10 with lag 10 finds only an old line at t = 20, and the next new one is too late
  const mixed = replayPairs([old(0), { kind: "cycle", cycle: cycleAt(10, [book(40)]) }, old(20), { kind: "cycle", cycle: cycleAt(40, [book(40)]) }], rule({ lagSec: 10 }));
  assert.equal(mixed.total.signals, 1);
  assert.deepEqual(mixed.total.unknown, { total: 1, noCycle: 1, noRead: 0, staleRead: 0, oldRead: 0 });
  assert.equal(mixed.cyclesRead, 2);
  assert.equal(mixed.cyclesOldFormat, 2);
  assert.match(mixed.days[0].note ?? "", /2 cycles in the old form \(gaps, no books\) are not replayed\./);
  // nor does an old line end an episode: the lock at t = 40 is the same one
  assert.deepEqual(mixed.trades.map((t) => t.signalAt), [iso(10)]);
});

test("lines that cannot be read are skipped and counted, never repaired", () => {
  const good = JSON.stringify(cycleAt(0, [book(40)]));
  assert.equal(parseCycleLine(good).kind, "cycle");
  assert.deepEqual(parseCycleLine(good.slice(0, 80)), { kind: "unreadable", why: "not JSON" });
  assert.equal(parseCycleLine("[]").kind, "unreadable");
  assert.equal(parseCycleLine(JSON.stringify({ rows: [] })).kind, "unreadable");
  assert.equal(parseCycleLine(JSON.stringify({ at: T0 })).kind, "unreadable");
  const broken = (change: (c: Record<string, any>) => void) => {
    const c = JSON.parse(good);
    change(c);
    return parseCycleLine(JSON.stringify(c));
  };
  assert.equal(broken((c) => delete c.pricedAt).kind, "unreadable");
  assert.equal(broken((c) => delete c.intervalSec).kind, "unreadable");
  assert.equal(broken((c) => (c.pairs = {})).kind, "unreadable");
  assert.equal(broken((c) => delete c.pairs[0].kalshi.askCents).kind, "unreadable");
  assert.equal(broken((c) => (c.pairs[0].kalshi.askCents = "40")).kind, "unreadable");
  assert.equal(broken((c) => delete c.pairs[0].poly.feeTheta).kind, "unreadable");
  assert.equal(broken((c) => delete c.pairs[0].poly.ageSec).kind, "unreadable");
  assert.equal(broken((c) => delete c.pairs[0].poly).kind, "unreadable");
  assert.equal(broken((c) => (c.pairs[0].horizon = "weekly")).kind, "unreadable");
  assert.equal(broken((c) => delete c.pairs[0].staleAfterSec).kind, "unreadable");
  // fields this code does not know are kept and do no harm
  assert.equal(broken((c) => ((c.v = 3), (c.later = { x: 1 }), (c.pairs[0].kalshi.depth = [[40, 100]]))).kind, "cycle");

  const r = createReplay(rule({ lagSec: 10 }));
  r.push(parseCycleLine(good), "2026-11-10");
  r.push(parseCycleLine(good.slice(0, 80)), "2026-11-10");
  // a line whose time does not move forward is skipped, not replayed twice
  r.push(parseCycleLine(good), "2026-11-10");
  r.push({ kind: "cycle", cycle: cycleAt(10, [book(44)]) }, "2026-11-10");
  const out = r.result();
  assert.equal(out.cyclesRead, 2);
  assert.equal(out.linesSkipped, 2);
  assert.equal(out.total.signals, 1);
  assert.equal(out.total.capturedMc, 18_000);
  assert.match(out.days[0].note ?? "", /2 lines skipped as unreadable\./);
  assert.match(out.notes.join(" "), /2 lines could not be read or ran backwards in time and were skipped/);
});

test("totals per tenor and per day: integer sums, the lower middle as the median, the smallest edge as the worst, unknown apart", () => {
  // four contracts at four closes; the edges at the fill cycle (t = 10): 5.9, 1.8, 7.9 and one gone at -1.2
  const c = (n: number, horizon: StoredPair["horizon"], kAsk: number): StoredPair => book(kAsk, 50, { horizon, key: `above:${n}`, strike: n, kalshi: { ...kalshi(kAsk - 2, kAsk), id: `K${n}` }, poly: { ...poly(50, 52), id: `P${n}` }, staleAfterSec: 30 });
  const signal = cycleAt(0, [c(1, "hourly", 40), c(2, "hourly", 40), c(3, "daily", 40), c(4, "daily", 40), c(5, "fifteen", 40)]);
  const fill = cycleAt(10, [c(1, "hourly", 40), c(2, "hourly", 44), c(3, "daily", 38), c(4, "daily", 47)]);
  const r = replayPairs([signal, fill], rule({ lagSec: 10 }));
  assert.equal(r.total.signals, 5);
  assert.equal(r.total.captured, 3);
  assert.deepEqual(r.total.gone, { total: 1, edge: 1, size: 0 });
  // the 15-minute pair is not in the fill cycle: unknown
  assert.deepEqual(r.total.unknown, { total: 1, noCycle: 0, noRead: 1, staleRead: 0, oldRead: 0 });
  // 59 + 18 + 79 = 156 cents
  assert.equal(r.total.capturedMc, 156_000);
  // sent anyway adds the -12: 144 cents
  assert.equal(r.total.sentAnywayMc, 144_000);
  // five signals at 59 cents each
  assert.equal(r.total.shownAtSignalMc, 295_000);
  // edges 1.8, 5.9, 7.9: the middle is 5.9, the worst 1.8
  assert.equal(r.total.medianCapturedEdgeMc, 5_900);
  assert.equal(r.total.worstCapturedEdgeMc, 1_800);
  // three of the four known outcomes: the unknown one is in neither part of the share
  assert.equal(r.total.survivedShare, 0.75);

  // hourly: 5.9 and 1.8, an even count: the lower middle, 1.8
  assert.equal(r.byHorizon.hourly?.captured, 2);
  assert.equal(r.byHorizon.hourly?.capturedMc, 77_000);
  assert.equal(r.byHorizon.hourly?.medianCapturedEdgeMc, 1_800);
  assert.equal(r.byHorizon.hourly?.worstCapturedEdgeMc, 1_800);
  assert.equal(r.byHorizon.daily?.captured, 1);
  assert.deepEqual(r.byHorizon.daily?.gone, { total: 1, edge: 1, size: 0 });
  assert.equal(r.byHorizon.daily?.capturedMc, 79_000);
  assert.equal(r.byHorizon.daily?.sentAnywayMc, 67_000);
  assert.equal(r.byHorizon.fifteen?.signals, 1);
  assert.equal(r.byHorizon.fifteen?.unknown.noRead, 1);
  assert.equal(r.byHorizon.fifteen?.survivedShare, null);
  for (const s of [r.total, ...Object.values(r.byHorizon)]) for (const v of [s.capturedMc, s.sentAnywayMc, s.shownAtSignalMc]) assert.ok(Number.isSafeInteger(v));

  // a rule that names one tenor sees only that tenor
  const hourly = replayPairs([signal, fill], rule({ lagSec: 10, horizons: ["hourly"] }));
  assert.equal(hourly.total.signals, 2);
  assert.deepEqual(Object.keys(hourly.byHorizon), ["hourly"]);
  assert.equal(hourly.total.capturedMc, 77_000);

  // a trade is counted on the day of its signal: signalled 5 seconds before midnight, filled 5 seconds after
  const late = (sec: number, p: StoredPair[]) => cycleAt(12 * 3600 - 5 + sec, p);
  const days = replayPairs([late(0, [book(40)]), late(10, [book(44)]), late(20, [book(52)])], rule({ lagSec: 10 }));
  assert.deepEqual(days.days, [
    { day: "2026-11-10", cyclesRead: 1, cyclesOldFormat: 0, linesSkipped: 0, signals: 1, captured: 1, gone: 0, unknown: 0, capturedMc: 18_000, sentAnywayMc: 18_000 },
    { day: "2026-11-11", cyclesRead: 2, cyclesOldFormat: 0, linesSkipped: 0, signals: 0, captured: 0, gone: 0, unknown: 0, capturedMc: 0, sentAnywayMc: 0 },
  ]);
  assert.equal(days.daysCovered, 2);
  assert.equal(days.firstCycleAt, "2026-11-10T23:59:55.000Z");
  assert.equal(days.lastCycleAt, "2026-11-11T00:00:15.000Z");
});

test("the result can be read while lines are still coming, and reading it changes nothing", () => {
  const r = createReplay(rule({ lagSec: 10 }));
  r.push({ kind: "cycle", cycle: cycleAt(0, [book(40)]) });
  const early = r.result();
  assert.equal(early.total.unknown.noCycle, 1);
  assert.equal(early.signalsOpenAtEnd, 1);
  assert.deepEqual(r.result(), early);
  r.push({ kind: "cycle", cycle: cycleAt(10, [book(44)]) });
  const done = r.result();
  assert.equal(done.total.unknown.total, 0);
  assert.equal(done.total.capturedMc, 18_000);
  assert.equal(done.signalsOpenAtEnd, 0);
  // only as many trades are listed as were asked for; the rest are counted
  const many = replayPairs([cycleAt(0, [book(40)]), cycleAt(10, [book(52)]), cycleAt(20, [book(40)])], rule({ lagSec: 0 }), { keepTrades: 1 });
  assert.equal(many.trades.length, 1);
  assert.equal(many.tradesNotListed, 1);
  assert.equal(many.total.signals, 2);
});

test("a rule that cannot be read is refused in words, not corrected", () => {
  assert.equal(ruleProblem(DEFAULT_RULE), null);
  assert.match(ruleProblem(rule({ minEdgeCents: -1 })) ?? "", /minimum edge must be zero or more/);
  assert.match(ruleProblem(rule({ minEdgeCents: 1.0005 })) ?? "", /at most three decimals/);
  assert.match(ruleProblem(rule({ minEdgeCents: Number.NaN })) ?? "", /minimum edge/);
  assert.match(ruleProblem(rule({ minSizeContracts: 0 })) ?? "", /minimum size must be a whole number/);
  assert.match(ruleProblem(rule({ sizeContracts: 2.5 })) ?? "", /size traded must be a whole number/);
  assert.match(ruleProblem(rule({ lagSec: -10 })) ?? "", /lag must be zero or more/);
  assert.match(ruleProblem(rule({ maxReadAgeSec: 0 })) ?? "", /maximum read age/);
  assert.match(ruleProblem(rule({ gapToleranceSec: -1 })) ?? "", /gap tolerance/);
  assert.match(ruleProblem(rule({ horizons: [] })) ?? "", /at least one tenor/);
  assert.match(ruleProblem(rule({ horizons: ["weekly" as never] })) ?? "", /"weekly" is not a tenor/);
  assert.match(ruleProblem(rule({ horizons: ["hourly", "hourly"] })) ?? "", /named twice/);
  assert.throws(() => createReplay(rule({ lagSec: -1 })), /lag must be zero or more/);
});

test("the assumptions say what is not modelled, in plain words", () => {
  const text = ASSUMPTIONS.join(" ");
  assert.match(text, /Paper only/);
  assert.match(text, /Both legs are assumed to fill together, at the fill cycle's prices/);
  assert.match(text, /about every 10 seconds .* only resolved to the next stored cycle/);
  assert.match(text, /Polymarket US public book is an edge-cached copy that can be up to about 30 seconds old/);
  assert.match(text, /read age is a rule input/);
  assert.match(text, /No queue position and no partial fills/);
  assert.match(text, /upper bound nobody achieves/);
  assert.doesNotMatch(text, /[\u2013\u2014]|guaranteed/i);
});
