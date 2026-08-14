import assert from "node:assert/strict";
import test from "node:test";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { quoteFromListedBooks, touchCreditUsdc, listedWingCandidates, firstWingWithTouch, widestExecutableWing, CALL_BAND } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";

const now = Date.UTC(2026, 6, 19, 8, 20, 0);
const expiry = Date.UTC(2026, 6, 20, 8, 0, 0);

const inst = (strike: number, optType: "put" | "call"): OkxChainInstrument => ({
  instId: `BTC-USD-260720-${strike}-${optType === "call" ? "C" : "P"}`,
  optType,
  strike,
  expiryMs: expiry,
  ctValBtc: 0.01,
  tickSz: 0.0001,
  lotSz: 1,
  minSz: 1,
  state: "live"
});

const chain: OkxChainInstrument[] = [
  inst(94000, "put"),
  inst(102000, "call")
];

const base = {
  side: "long" as const,
  spot: 100_000,
  planPutStrike: 94_000,
  planCallStrike: 102_000,
  notionalUsdc: 1_000,
  contractsBtc: 0.01,
  nowMs: now,
  chain
};

test("touchCreditUsdc: 1-lot (call bid − put ask) × 0.01 × spot", () => {
  // (0.0003 − 0.0001) × 1 × 0.01 × 100000 = $0.20
  assert.equal(touchCreditUsdc(0.0003, 0.0001, 1, 0.01, 100_000), 0.2);
});

test("quoteFromListedBooks: 1-lot two-sided book with positive net credit succeeds", () => {
  const q = quoteFromListedBooks({
    ...base,
    putBook: { bidPxBtc: 0.00005, askPxBtc: 0.0001 },
    callBook: { bidPxBtc: 0.0003, askPxBtc: 0.0004 }
  });
  assert.equal(q.ok, true, q.ok ? "" : `${q.error}: ${q.message}`);
  if (!q.ok) return;
  assert.equal(q.putStrike, 94_000);
  assert.equal(q.callStrike, 102_000);
  assert.equal(q.expiryMs, expiry);
  assert.ok(q.creditUsdc > 0);
  assert.ok(q.creditUsdc <= 0.2);
});

test("quoteFromListedBooks: missing call bid is listed_book_empty, not a model infeasible", () => {
  const q = quoteFromListedBooks({
    ...base,
    putBook: { bidPxBtc: 0.00005, askPxBtc: 0.0001 },
    callBook: { bidPxBtc: null, askPxBtc: 0.0004 }
  });
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "listed_book_empty");
  assert.match(q.message, /bid none/);
});

test("quoteFromListedBooks: debit book (put ask > call bid) refuses with nonpositive credit", () => {
  const q = quoteFromListedBooks({
    ...base,
    putBook: { bidPxBtc: 0.0004, askPxBtc: 0.0005 },
    callBook: { bidPxBtc: 0.0001, askPxBtc: 0.0002 }
  });
  assert.equal(q.ok, false);
  if (q.ok) return;
  assert.equal(q.error, "listed_credit_nonpositive");
});

test("listedWingCandidates: OTM calls nearest 1.5% target, excluding ATM", () => {
  const wide = [inst(100500, "call"), inst(101000, "call"), inst(101500, "call"), inst(102000, "call"), inst(105000, "call")];
  const cands = listedWingCandidates(wide, expiry, "call", 100_000, 101_500, { minOtmPct: 0.008, maxOtmPct: 0.04 });
  assert.equal(cands[0].strike, 101_500);
  assert.ok(!cands.some((c) => c.strike === 100_500)); // 0.5% is inside min OTM
  assert.ok(cands.some((c) => c.strike === 101_000));
});

test("firstWingWithTouch: skips empty 63750-C and takes a neighbor with a bid", () => {
  const cands = [inst(101500, "call"), inst(102000, "call"), inst(101000, "call")];
  const books = {
    [cands[0].instId]: { bidPxBtc: null, askPxBtc: 0.0004 },
    [cands[1].instId]: { bidPxBtc: 0.0003, askPxBtc: 0.0004 },
    [cands[2].instId]: { bidPxBtc: 0.0002, askPxBtc: 0.0003 }
  };
  const hit = firstWingWithTouch(cands, books, "bid");
  assert.ok(hit);
  assert.equal(hit!.inst.strike, 102_000);
});

const SPOT = 62_882;
const SIZE = { contracts: 1, ctValBtc: 0.01 };
const NOTIONAL = 628.82;

test("widestExecutableWing: widest strike whose net credit clears wins, not the fattest bid", () => {
  // 63200 has the fattest bid but 63400 (wider) also clears — the client keeps more upside.
  const cands = [inst(63_400, "call"), inst(63_250, "call"), inst(63_200, "call")];
  const books = {
    [cands[0].instId]: { bidPxBtc: 0.0002, askPxBtc: 0.0003 },
    [cands[1].instId]: { bidPxBtc: 0.0003, askPxBtc: 0.0005 },
    [cands[2].instId]: { bidPxBtc: 0.0005, askPxBtc: 0.0006 }
  };
  const { pick } = widestExecutableWing(cands, books, 0.0001, SIZE, SPOT, NOTIONAL);
  assert.ok(pick);
  assert.equal(pick!.inst.strike, 63_400);
  assert.ok(pick!.netUsdc > 0);
});

test("widestExecutableWing: walks tighter only when nothing wider clears (tonight's book)", () => {
  // Live 22:45 UTC book: 63400 bid 1 tick = put ask (gross $0), 63500+ no bids, 63250 bid 3 ticks.
  const cands = [inst(63_750, "call"), inst(63_400, "call"), inst(63_250, "call")];
  const books = {
    [cands[0].instId]: { bidPxBtc: null, askPxBtc: 0.0001 },
    [cands[1].instId]: { bidPxBtc: 0.0001, askPxBtc: 0.0003 },
    [cands[2].instId]: { bidPxBtc: 0.0003, askPxBtc: 0.0005 }
  };
  const { pick } = widestExecutableWing(cands, books, 0.0001, SIZE, SPOT, NOTIONAL);
  assert.ok(pick);
  assert.equal(pick!.inst.strike, 63_250);
  assert.ok(pick!.netUsdc > 0, `net ${pick!.netUsdc}`);
});

test("widestExecutableWing: nothing clears ⟹ no pick, closest names the honest refuse", () => {
  const cands = [inst(63_400, "call"), inst(63_600, "call")];
  const books = {
    [cands[0].instId]: { bidPxBtc: 0.0001, askPxBtc: 0.0002 },
    [cands[1].instId]: { bidPxBtc: null, askPxBtc: 0.0002 }
  };
  const { pick, closest } = widestExecutableWing(cands, books, 0.0001, SIZE, SPOT, NOTIONAL);
  assert.equal(pick, null);
  assert.ok(closest);
  assert.equal(closest!.inst.strike, 63_400);
  assert.ok(closest!.netUsdc <= 0);
});

test("CALL_BAND: hard ATM guard is 0.5%, never past it", () => {
  assert.equal(CALL_BAND.minOtmPct, 0.005);
  const wide = [inst(63_100, "call"), inst(63_200, "call"), inst(63_400, "call")];
  const cands = listedWingCandidates(wide, expiry, "call", SPOT, SPOT * 1.015, CALL_BAND);
  assert.ok(cands.some((c) => c.strike === 63_200), "0.51% OTM is inside the guard");
  assert.ok(!cands.some((c) => c.strike === 63_100), "0.35% OTM is past the guard — excluded");
});

test("quoteFromListedBooks: touch anchors exported at 6dp (not cent-rounded)", () => {
  const q = quoteFromListedBooks({
    ...base,
    putBook: { bidPxBtc: 0.00005, askPxBtc: 0.0001 },
    callBook: { bidPxBtc: 0.0003, askPxBtc: 0.0004 }
  });
  assert.equal(q.ok, true, q.ok ? "" : `${q.error}: ${q.message}`);
  if (!q.ok) return;
  // buy put at ask 0.0001 × 0.01 BTC × 100k = $0.10 · sell call at bid 0.0003 ⟹ $0.30
  assert.equal(q.protectiveTouchUsdc, 0.1);
  assert.equal(q.fundingTouchUsdc, 0.3);
});

test("listedWingCandidates: 5bp slack includes listed 63400-C when 0.8% pin is 63404", () => {
  const spot = 62_900.9;
  const target = Math.round(spot * 1.015);
  const wide = [inst(63_250, "call"), inst(63_400, "call"), inst(63_500, "call"), inst(63_750, "call")];
  const cands = listedWingCandidates(wide, expiry, "call", spot, target, { minOtmPct: 0.008, maxOtmPct: 0.04 });
  assert.ok(cands.some((c) => c.strike === 63_400), "listed 63400 is 4 dollars inside 0.8% — still OTM");
  assert.ok(!cands.some((c) => c.strike === 63_250), "63250 is ~0.55% OTM, still ATM-adjacent");
});
