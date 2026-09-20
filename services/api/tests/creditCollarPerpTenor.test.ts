/**
 * Perp tenor, cap guard and fee floor (B3): the pure pieces the demo service composes.
 *
 *   - applyTake with a notional minimum: which rule bound, never past the gross
 *   - the weekly tenor (the default): the nearest listed Friday 08:00 UTC ≥ 3 days out, and the
 *     planner / touch quote written to it
 *   - the cap guard: the widest paying strike is refused when it sits too close
 *     to price (a knock-out collar's cap must be far, not rich), and the band
 *     the search may reach follows the tenor
 *   - fetchOkxTopSnapshot: two public requests become one top-of-book snapshot
 *     across the daily and weekly expiries; the pinned-cap quote and the ATM
 *     reference the shadow's cap ladder and knock-out buyback read from it
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyTake, minTakeUsdcFor, parseCapsInputsFromEnv } from "../src/singleSide/twoSided/creditCollar/capsConfig";
import {
  nextListedWeeklyExpiryMs,
  nextStandardDailyExpiryMs,
  planLiveCollar,
  type OkxChainInstrument
} from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { fetchOkxListedTouchQuote, quoteFromListedBooks } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";
import { atmReference, fetchOkxTopSnapshot, fundingStrikeLadder, quoteCollarFromSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import { capGuardFor, otherTenor, parseTenor, tenorExpiry, tenorWord } from "../src/singleSide/twoSided/creditCollar/perpTenor";
import { expTimeFromMs } from "../src/singleSide/twoSided/creditCollar/capRule";

const SHAPE = { floorPct: 0.06, capPct: 0.015 };

// ── Fixtures: Saturday 2026-07-18 08:20 UTC; daily = Sun 07-19 08:00; weekly = Fri 07-24 08:00 ──
const now = Date.UTC(2026, 6, 18, 8, 20, 0);
const daily = Date.UTC(2026, 6, 19, 8, 0, 0);
const tuesday = Date.UTC(2026, 6, 21, 8, 0, 0);
const friday = Date.UTC(2026, 6, 24, 8, 0, 0);
const nextFriday = Date.UTC(2026, 6, 31, 8, 0, 0);

const code = (ms: number) => new Date(ms).toISOString().slice(2, 10).replace(/-/g, "");
const inst = (strike: number, optType: "put" | "call", expiryMs = daily, over: Partial<OkxChainInstrument> = {}): OkxChainInstrument => ({
  instId: `BTC-USD-${code(expiryMs)}-${strike}-${optType === "call" ? "C" : "P"}`,
  optType,
  strike,
  expiryMs,
  ctValBtc: 0.01,
  tickSz: 0.0001,
  lotSz: 1,
  minSz: 1,
  state: "live",
  ...over
});

const strikesFor = (expiryMs: number): OkxChainInstrument[] => [
  inst(92000, "put", expiryMs), inst(94000, "put", expiryMs), inst(97000, "put", expiryMs),
  inst(101000, "call", expiryMs), inst(101500, "call", expiryMs), inst(103000, "call", expiryMs), inst(105000, "call", expiryMs)
];
const chain: OkxChainInstrument[] = [...strikesFor(daily), ...strikesFor(tuesday), ...strikesFor(friday), ...strikesFor(nextFriday)];

// ── fee floor ─────────────────────────────────────────────────────────────────

test("applyTake: the share rules when it is the larger; the minimum binds when the share is thin", () => {
  const share = applyTake(10, 0.2, 0.05, false, 1.5);
  assert.equal(share.rule, "share");
  assert.equal(share.atticusTakeUsdc, 2);
  assert.equal(share.traderCreditUsdc, 8);
  const minimum = applyTake(10, 0.2, 0.05, false, 3);
  assert.equal(minimum.rule, "minimum");
  assert.equal(minimum.atticusTakeUsdc, 3);
  assert.equal(minimum.traderCreditUsdc, 7);
  assert.equal(minimum.appliedRatePct, 0.2, "the published rate still rides the record; the rule names what bound");
});

test("applyTake: a minimum never takes the credit negative; the caller refuses a $0 credit", () => {
  const eaten = applyTake(0.4, 0.2, 0.05, false, 3);
  assert.equal(eaten.rule, "minimum");
  assert.equal(eaten.atticusTakeUsdc, 0.4);
  assert.equal(eaten.traderCreditUsdc, 0);
});

test("applyTake: de minimis still waives when both share and minimum are under the line; no minimum = the product today", () => {
  const waived = applyTake(0.2, 0.2, 0.05, false, 0.03);
  assert.equal(waived.rule, "waived");
  assert.equal(waived.atticusTakeUsdc, 0);
  assert.equal(waived.traderCreditUsdc, 0.2);
  const legacy = applyTake(10, 0.2, 0.05);
  assert.equal(legacy.rule, "share");
  assert.equal(legacy.traderCreditUsdc, 8);
});

test("minTakeUsdcFor: bps of notional, two decimals; EP_MIN_TAKE_BPS defaults to 0 (share only)", () => {
  assert.equal(minTakeUsdcFor({ minTakeBps: 5 }, 2_400), 1.2);
  assert.equal(minTakeUsdcFor({ minTakeBps: 0 }, 2_400), 0);
  assert.equal(minTakeUsdcFor({ minTakeBps: 5 }, -1), 0);
  assert.equal(parseCapsInputsFromEnv({}).minTakeBps, 0);
  assert.equal(parseCapsInputsFromEnv({ EP_MIN_TAKE_BPS: "5" }).minTakeBps, 5);
});

// ── tenor ─────────────────────────────────────────────────────────────────────

test("nextListedWeeklyExpiryMs: the nearest listed Friday 08:00 UTC at least three days out", () => {
  assert.equal(nextListedWeeklyExpiryMs(chain, now), friday);
  // Sunday 08:20: Friday 08:00 is 4d 23h40m out — still this Friday (cycles run 3–10 days).
  assert.equal(nextListedWeeklyExpiryMs(chain, now + 86_400_000), friday);
  // Tuesday 08:20: Friday is 2d 23h40m out — under three days prices like a daily, so the next one.
  assert.equal(nextListedWeeklyExpiryMs(chain, now + 3 * 86_400_000), nextFriday);
  assert.equal(nextListedWeeklyExpiryMs(chain, now + 3 * 86_400_000, 5), nextFriday, "an explicit minimum is honoured");
  // A chain with no Friday listed (dailies only) has no weekly.
  assert.equal(nextListedWeeklyExpiryMs([...strikesFor(daily), ...strikesFor(tuesday)], now), null);
  // Expired / non-live rows never count.
  assert.equal(nextListedWeeklyExpiryMs(strikesFor(friday).map((c) => ({ ...c, state: "expired" })), now), null);
});

test("tenorExpiry / parseTenor / tenorWord: weekly by default, daily only when asked, and the copy follows", () => {
  assert.equal(parseTenor("weekly"), "weekly");
  assert.equal(parseTenor(undefined), "weekly", "unset = the weekly default");
  assert.equal(parseTenor(""), "weekly");
  assert.equal(parseTenor("daily"), "daily", "the exact word opts out");
  assert.equal(parseTenor("DAILY"), "weekly", "strict: junk keeps the default");
  assert.equal(otherTenor("weekly"), "daily");
  assert.equal(otherTenor("daily"), "weekly");
  assert.deepEqual(tenorExpiry("daily", chain, now), { expiryMs: daily, tenor: "daily" });
  assert.deepEqual(tenorExpiry("weekly", chain, now), { expiryMs: friday, tenor: "weekly" });
  assert.deepEqual(tenorExpiry("weekly", strikesFor(daily), now), { expiryMs: daily, tenor: "daily" }, "no weekly listed falls back and says so");
  assert.equal(tenorWord("weekly"), "this week's");
  assert.equal(tenorWord("daily"), "today's");
  assert.equal(nextStandardDailyExpiryMs(now), daily);
});

test("planLiveCollar: an explicit expiryMs pins the legs to that listing (the weekly tenor)", () => {
  const base = {
    side: "long" as const,
    spot: 100_000,
    notionalUsdc: 10_000,
    putStrike: 94_000,
    callStrike: 101_500,
    protectiveMidUsdc: 10,
    fundingMidUsdc: 20,
    modelContractsBtc: 0.1,
    nowMs: now
  };
  const d = planLiveCollar(chain, base);
  const w = planLiveCollar(chain, { ...base, expiryMs: friday });
  assert.ok(d.ok && w.ok);
  if (!d.ok || !w.ok) return;
  assert.equal(d.plan.expiryMs, daily);
  assert.equal(w.plan.expiryMs, friday);
  assert.ok(w.plan.protective.instId.includes(code(friday)));
  assert.ok(w.plan.funding.instId.includes(code(friday)));
  const missing = planLiveCollar(chain, { ...base, expiryMs: Date.UTC(2026, 7, 7, 8) });
  assert.equal(missing.ok, false, "an unlisted expiry fails closed, exactly like a missing daily");
});

test("quoteFromListedBooks: the tenor actually written rides the quote (daily by default, weekly when pinned)", () => {
  const books = { putBook: { bidPxBtc: 0.0005, askPxBtc: 0.001 }, callBook: { bidPxBtc: 0.003, askPxBtc: 0.004 } };
  const base = { side: "long" as const, spot: 100_000, planPutStrike: 94_000, planCallStrike: 101_500, notionalUsdc: 1_000, contractsBtc: 0.01, nowMs: now, chain, ...books };
  const d = quoteFromListedBooks(base);
  const w = quoteFromListedBooks({ ...base, expiryMs: friday });
  assert.ok(d.ok && w.ok, d.ok ? (w.ok ? "" : `${w.error}: ${w.message}`) : `${d.error}: ${d.message}`);
  if (!d.ok || !w.ok) return;
  assert.equal(d.tenor, "daily");
  assert.equal(d.expiryMs, daily);
  assert.equal(w.tenor, "weekly");
  assert.equal(w.expiryMs, friday);
  assert.equal(w.putInstId, `BTC-USD-${code(friday)}-94000-P`);
  assert.equal(w.callInstId, `BTC-USD-${code(friday)}-101500-C`);
});

// ── cap guard ─────────────────────────────────────────────────────────────────

test("capGuardFor: plain (default) never refuses on distance — widest paying cap, band 4% daily / 8% weekly; env may raise it", () => {
  assert.deepEqual(capGuardFor("daily", {}), { minCapPct: 0, maxCapPct: 0.04 });
  assert.deepEqual(capGuardFor("weekly", {}), { minCapPct: 0, maxCapPct: 0.08 });
  assert.deepEqual(capGuardFor("weekly", {}, "plain"), { minCapPct: 0, maxCapPct: 0.08 });
  assert.deepEqual(capGuardFor("weekly", { EP_MIN_CAP_PCT_WEEKLY: "0.03" }, "plain"), { minCapPct: 0.03, maxCapPct: 0.08 }, "a deliberate env line still applies");
  assert.deepEqual(capGuardFor("daily", { EP_CAP_MAX_PCT: "0.05" }), { minCapPct: 0, maxCapPct: 0.05 });
});

test("capGuardFor: knockout keeps the refusal — 2% / 4% daily, 4% / 8% weekly, env-overridable as fractions, junk ignored", () => {
  assert.deepEqual(capGuardFor("daily", {}, "knockout"), { minCapPct: 0.02, maxCapPct: 0.04 });
  assert.deepEqual(capGuardFor("weekly", {}, "knockout"), { minCapPct: 0.04, maxCapPct: 0.08 });
  assert.deepEqual(capGuardFor("daily", { EP_MIN_CAP_PCT: "0.015", EP_CAP_MAX_PCT: "0.05" }, "knockout"), { minCapPct: 0.015, maxCapPct: 0.05 });
  assert.deepEqual(capGuardFor("weekly", { EP_MIN_CAP_PCT_WEEKLY: "0.03" }, "knockout"), { minCapPct: 0.03, maxCapPct: 0.08 });
  assert.deepEqual(capGuardFor("daily", { EP_MIN_CAP_PCT: "nope", EP_CAP_MAX_PCT: "-1" }, "knockout"), { minCapPct: 0.02, maxCapPct: 0.04 });
});

/** The live touch-quote path against a fake OKX: instruments + one book per probed wing. */
const withOkx = async <T>(books: Record<string, { bid?: number; ask?: number }>, run: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/public/instruments")) return new Response(JSON.stringify({ data: chain.map(okxRow) }), { status: 200 });
    const m = /instId=([^&]+)/.exec(u);
    const b = m ? books[decodeURIComponent(m[1])] : undefined;
    const data = [{ bids: b?.bid != null ? [[String(b.bid), "5"]] : [], asks: b?.ask != null ? [[String(b.ask), "5"]] : [] }];
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
};

const dailyId = (strike: number, t: "C" | "P") => `BTC-USD-${code(daily)}-${strike}-${t}`;

test("fetchOkxListedTouchQuote: the widest paying cap under the guard is REFUSED as cap_too_close, never written", async () => {
  // Only the 1% call has a bid; the put at 6% has an ask. Widest that pays = 101000-C, 1% out.
  const books = { [dailyId(94000, "P")]: { ask: 0.0004 }, [dailyId(101000, "C")]: { bid: 0.003 } };
  const base = { side: "long" as const, spot: 100_000, planPutStrike: 94_000, planCallStrike: 101_500, notionalUsdc: 1_000, contractsBtc: 0.01, nowMs: now, baseUrl: "https://okx.test" };
  const guarded = await withOkx(books, () => fetchOkxListedTouchQuote({ ...base, capGuard: { minCapPct: 0.02, maxCapPct: 0.04 } }));
  assert.equal(guarded.ok, false);
  if (guarded.ok) return;
  assert.equal(guarded.error, "cap_too_close");
  assert.match(guarded.message, /101000-C sits 1\.00% from price, under the 2\.0% guard/);
  // Without a guard the same book writes the 1% cap (the product before B3).
  const unguarded = await withOkx(books, () => fetchOkxListedTouchQuote(base));
  assert.ok(unguarded.ok, unguarded.ok ? "" : unguarded.message);
  if (unguarded.ok) assert.equal(unguarded.callStrike, 101_000);
});

test("fetchOkxListedTouchQuote: a wider paying strike clears the guard and is the pick; the band reaches the guard's outer edge", async () => {
  const books = {
    [dailyId(94000, "P")]: { ask: 0.0004 },
    [dailyId(101000, "C")]: { bid: 0.003 },
    [dailyId(103000, "C")]: { bid: 0.0009 },
    [dailyId(105000, "C")]: { bid: 0.0006 }
  };
  const base = { side: "long" as const, spot: 100_000, planPutStrike: 94_000, planCallStrike: 101_500, notionalUsdc: 1_000, contractsBtc: 0.01, nowMs: now, baseUrl: "https://okx.test" };
  const daily4 = await withOkx(books, () => fetchOkxListedTouchQuote({ ...base, capGuard: { minCapPct: 0.02, maxCapPct: 0.04 } }));
  assert.ok(daily4.ok, daily4.ok ? "" : daily4.message);
  if (daily4.ok) assert.equal(daily4.callStrike, 103_000, "the 5% strike sits outside a 4% band; 3% is the widest that pays inside it");
  const wide8 = await withOkx(books, () => fetchOkxListedTouchQuote({ ...base, capGuard: { minCapPct: 0.02, maxCapPct: 0.08 } }));
  assert.ok(wide8.ok, wide8.ok ? "" : wide8.message);
  if (wide8.ok) assert.equal(wide8.callStrike, 105_000, "an 8% band reaches the 5% strike, and it pays");
});

// ── top-of-book snapshot ──────────────────────────────────────────────────────

const okxRow = (c: OkxChainInstrument) => ({
  instId: c.instId,
  optType: c.optType === "call" ? "C" : "P",
  stk: String(c.strike),
  expTime: String(c.expiryMs),
  ctVal: "1",
  ctMult: "0.01",
  tickSz: "0.0001",
  lotSz: "1",
  minSz: "1",
  state: c.state
});

test("fetchOkxTopSnapshot: instruments + tickers become one snapshot across the daily and weekly expiries", async () => {
  const calls: string[] = [];
  // Tickers: every strike quoted a one-level book, except the far 105000-C at the daily (missing).
  const tickers = chain
    .filter((c) => !(c.expiryMs === daily && c.strike === 105000))
    .map((c) => {
      const dist = Math.abs(c.strike - 100_000) / 100_000;
      const px = Math.max(0.0002, 0.02 - dist * 0.25) * (c.expiryMs === friday ? 2.5 : 1);
      return { instId: c.instId, bidPx: px.toFixed(4), askPx: (px * 1.1).toFixed(4), bidSz: "12", askSz: "9" };
    });
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/public/instruments")) return new Response(JSON.stringify({ data: chain.map(okxRow) }), { status: 200 });
    if (u.includes("/market/tickers")) return new Response(JSON.stringify({ data: tickers }), { status: 200 });
    if (u.includes("/public/opt-summary")) {
      // one request per expiry; the weekly's vols are readable, the daily's are not
      return u.includes(`expTime=${expTimeFromMs(friday)}`)
        ? new Response(JSON.stringify({ data: chain.filter((c) => c.expiryMs === friday).map((c) => ({ instId: c.instId, markVol: "0.45" })) }), { status: 200 })
        : new Response("{}", { status: 500 });
    }
    return new Response("{}", { status: 404 });
  };
  const snap = await fetchOkxTopSnapshot({ spot: 100_000, nowMs: now, baseUrl: "https://okx.test", fetchImpl });
  assert.equal(calls.filter((c) => !c.includes("opt-summary")).length, 2, "exactly two public requests for the books");
  assert.equal(calls.filter((c) => c.includes("opt-summary")).length, 2, "and one mark-vol request per expiry");
  assert.ok(snap.markVols && Object.keys(snap.markVols).length > 0 && Object.values(snap.markVols).every((v) => v === 0.45), "mark vols keyed by instId");
  assert.ok(chain.filter((c) => c.expiryMs === daily).every((c) => snap.markVols![c.instId] == null), "an unreadable expiry leaves its vols absent, never guessed");
  assert.equal(snap.expiryMs, daily);
  assert.equal(snap.weeklyExpiryMs, friday);
  // Only the daily and weekly in-band strikes are kept: Tuesday and the following Friday are not.
  const expiries = new Set(snap.chain.map((c) => c.expiryMs));
  assert.deepEqual([...expiries].sort(), [daily, friday]);
  assert.equal(snap.booksMissing, 1, "the daily 105000-C had no ticker");
  const dailyCall = snap.books[`BTC-USD-${code(daily)}-101500-C`];
  assert.ok(dailyCall);
  assert.equal(dailyCall.bids.length, 1);
  assert.equal(dailyCall.bids[0].contracts, 12);
  assert.equal(dailyCall.asks[0].contracts, 9);

  // The same snapshot prices the shape at either expiry.
  const d = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: SHAPE, expiryMs: daily }, snap);
  const w = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: SHAPE, expiryMs: friday }, snap);
  assert.ok(d.ok, d.ok ? "" : `${d.error}: ${d.message}`);
  assert.ok(w.ok, w.ok ? "" : `${w.error}: ${w.message}`);
  if (!d.ok || !w.ok) return;
  assert.equal(d.expiryMs, daily);
  assert.equal(w.expiryMs, friday);
  assert.ok(w.netCreditUsdc > d.netCreditUsdc, "the weekly book (richer premia in the fixture) funds more credit for the same shape");
  assert.equal(d.buyStrike, 94_000);

  // The cap ladder: every listed funding strike in the band, nearest first; a pinned cap prices that rung alone.
  const rungs = fundingStrikeLadder(snap, "long", 100_000, 0.04);
  assert.deepEqual(rungs.map((r) => r.strike), [101000, 101500, 103000], "calls above spot inside 4%; the 5% strike is outside the band");
  assert.deepEqual(fundingStrikeLadder(snap, "long", 100_000, 0.08).map((r) => r.strike), [101000, 101500, 103000, 105000]);
  assert.deepEqual(fundingStrikeLadder(snap, "short", 100_000, 0.04).map((r) => r.strike), [97000], "puts below spot for a short");
  const pinned = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: SHAPE, pinSellInstId: `BTC-USD-${code(daily)}-101000-C` }, snap);
  assert.ok(pinned.ok, pinned.ok ? "" : pinned.message);
  if (pinned.ok) {
    assert.equal(pinned.sellStrike, 101_000);
    assert.equal(pinned.buyStrike, d.buyStrike, "the floor is held; only the cap moved");
    assert.ok(pinned.netCreditUsdc > d.netCreditUsdc, "a closer cap pays more (and gets touched more; the shadow measures that)");
  }
  const unlisted = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: SHAPE, pinSellInstId: "BTC-USD-000000-1-C" }, snap);
  assert.ok(!unlisted.ok && unlisted.error === "listed_book_empty");

  // The ATM reference: the nearest-to-spot call and put asks at the expiry, and the time left.
  const atm = atmReference(snap, 100_000, daily, now);
  assert.equal(atm.callInstId, `BTC-USD-${code(daily)}-101000-C`);
  assert.equal(atm.putInstId, `BTC-USD-${code(daily)}-97000-P`);
  assert.ok(atm.callAskPxBtc! > 0 && atm.putAskPxBtc! > 0);
  assert.equal(atm.hoursToExpiry, 23.67);
});

test("fetchOkxTopSnapshot: an HTTP error names the call and nothing is cached by the caller", async () => {
  const fetchImpl: typeof fetch = async (url) =>
    String(url).includes("/public/instruments")
      ? new Response(JSON.stringify({ data: chain.map(okxRow) }), { status: 200 })
      : new Response("", { status: 503 });
  await assert.rejects(fetchOkxTopSnapshot({ spot: 100_000, nowMs: now, baseUrl: "https://okx.test", fetchImpl }), /HTTP 503/);
});
