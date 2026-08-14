import assert from "node:assert/strict";
import test from "node:test";
import type { OkxChainInstrument } from "../src/singleSide/twoSided/creditCollar/execution/okxLivePlanner";
import { quoteFromListedBooks, touchCreditUsdc } from "../src/singleSide/twoSided/creditCollar/execution/okxListedTouchQuote";

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
