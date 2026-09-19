/**
 * Perp tiers, tenor and fee floor (B3): the pure pieces the demo service composes.
 *
 *   - applyTake with a notional minimum: which rule bound, never past the gross
 *   - the weekly tenor: the first listed Friday 08:00 UTC ≥ 5 days out, and the
 *     planner / touch quote written to it
 *   - fetchOkxTopSnapshot: two public requests become one top-of-book snapshot
 *     across the daily and weekly expiries (the demo's tier tiles)
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
import { quoteFromListedBooks } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";
import { fetchOkxTopSnapshot, quoteCollarFromSnapshot } from "../src/singleSide/twoSided/creditCollar/perpShadow/okxListedSnapshot";
import {
  PERP_TIERS,
  PERP_TIER_GEOMETRY,
  PERP_TIER_WORDS,
  parsePerpTier,
  parseTenor,
  tenorExpiry,
  tenorWord
} from "../src/singleSide/twoSided/creditCollar/perpTiers";

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

test("nextListedWeeklyExpiryMs: the first listed Friday 08:00 UTC at least five days out", () => {
  assert.equal(nextListedWeeklyExpiryMs(chain, now), friday);
  // A day later (Sunday 08:20) Friday 08:00 is 4d 23h40m out: under five days, so the next one.
  assert.equal(nextListedWeeklyExpiryMs(chain, now + 86_400_000), nextFriday);
  // A chain with no Friday listed (dailies only) has no weekly.
  assert.equal(nextListedWeeklyExpiryMs([...strikesFor(daily), ...strikesFor(tuesday)], now), null);
  // Expired / non-live rows never count.
  assert.equal(nextListedWeeklyExpiryMs(strikesFor(friday).map((c) => ({ ...c, state: "expired" })), now), null);
});

test("tenorExpiry / parseTenor / tenorWord: weekly when listed, daily otherwise, and the copy follows", () => {
  assert.equal(parseTenor("weekly"), "weekly");
  assert.equal(parseTenor("WEEKLY"), "daily", "strict: only the exact word flips the product");
  assert.equal(parseTenor(undefined), "daily");
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

// ── tiers ─────────────────────────────────────────────────────────────────────

test("perp tiers: three shapes inside the listed bands, balanced is the product, words are outcome-named", () => {
  assert.deepEqual([...PERP_TIERS], ["tight", "balanced", "wide"]);
  for (const t of PERP_TIERS) {
    const g = PERP_TIER_GEOMETRY[t];
    assert.ok(g.floorPct >= 0.02 && g.floorPct <= 0.08, `${t} floor inside the protective band`);
    assert.ok(g.capPct >= 0.005 && g.capPct <= 0.04, `${t} cap inside the funding band`);
  }
  assert.ok(PERP_TIER_GEOMETRY.tight.floorPct < PERP_TIER_GEOMETRY.balanced.floorPct);
  assert.ok(PERP_TIER_GEOMETRY.balanced.floorPct < PERP_TIER_GEOMETRY.wide.floorPct);
  assert.deepEqual(PERP_TIER_GEOMETRY.balanced, { floorPct: 0.06, capPct: 0.015 });
  assert.deepEqual(PERP_TIER_WORDS, { tight: "Safest", balanced: "Balanced", wide: "Most upside" });
  assert.equal(parsePerpTier("wide"), "wide");
  assert.equal(parsePerpTier("safest"), "balanced", "unknown words fall back to the product");
  assert.equal(parsePerpTier(null), "balanced");
  assert.equal(parsePerpTier(undefined, "tight"), "tight");
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
    return new Response("{}", { status: 404 });
  };
  const snap = await fetchOkxTopSnapshot({ spot: 100_000, nowMs: now, baseUrl: "https://okx.test", fetchImpl });
  assert.equal(calls.length, 2, "exactly two public requests");
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

  // The same snapshot prices a tier at either expiry — the tiles the demo shows.
  const d = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: PERP_TIER_GEOMETRY.balanced, expiryMs: daily }, snap);
  const w = quoteCollarFromSnapshot({ side: "long", spot: 100_000, contracts: 24, geometry: PERP_TIER_GEOMETRY.balanced, expiryMs: friday }, snap);
  assert.ok(d.ok, d.ok ? "" : `${d.error}: ${d.message}`);
  assert.ok(w.ok, w.ok ? "" : `${w.error}: ${w.message}`);
  if (!d.ok || !w.ok) return;
  assert.equal(d.expiryMs, daily);
  assert.equal(w.expiryMs, friday);
  assert.ok(w.netCreditUsdc > d.netCreditUsdc, "the weekly book (richer premia in the fixture) funds more credit for the same shape");
  assert.equal(d.buyStrike, 94_000);
});

test("fetchOkxTopSnapshot: an HTTP error names the call and nothing is cached by the caller", async () => {
  const fetchImpl: typeof fetch = async (url) =>
    String(url).includes("/public/instruments")
      ? new Response(JSON.stringify({ data: chain.map(okxRow) }), { status: 200 })
      : new Response("", { status: 503 });
  await assert.rejects(fetchOkxTopSnapshot({ spot: 100_000, nowMs: now, baseUrl: "https://okx.test", fetchImpl }), /HTTP 503/);
});
