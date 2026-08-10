import assert from "node:assert/strict";
import test from "node:test";
import { parseQuoteReply, decideQuote } from "../src/singleSide/twoSided/creditCollar/g20Telegram";

test("parses the agreed strict format", () => {
  const q = parseQuoteReply("RFQ-7 BID 78 ASK 96 VALID 60")!;
  assert.deepEqual(q, { ref: "RFQ-7", bidUsdc: 78, askUsdc: 96, validSec: 60 });
});

test("tolerates human variations: case, RFQ#, decimals, negatives, missing VALID", () => {
  assert.deepEqual(parseQuoteReply("rfq#12 bid 82.50 ask 101.25"), { ref: "RFQ-12", bidUsdc: 82.5, askUsdc: 101.25, validSec: 60 });
  assert.deepEqual(parseQuoteReply("RFQ 3 BID -5 ASK 12 VALID 30"), { ref: "RFQ-3", bidUsdc: -5, askUsdc: 12, validSec: 30 });
  const noAsk = parseQuoteReply("RFQ-9 BID 88")!;
  assert.equal(noAsk.bidUsdc, 88);
  assert.equal(noAsk.askUsdc, null);
});

test("refuses to guess: chatter and malformed quotes return null", () => {
  assert.equal(parseQuoteReply("gm — market looks heavy today"), null);
  assert.equal(parseQuoteReply("RFQ-7 we're 78 at 96"), null); // no BID keyword — ambiguous, human confirms
  assert.equal(parseQuoteReply("BID 78 ASK 96"), null); // no RFQ ref
});

test("decideQuote: accepts within tolerance, passes below the floor, better-than-model always accepted", () => {
  assert.equal(decideQuote(80, 80).action, "done"); // at model
  assert.equal(decideQuote(95, 80).action, "done"); // better than model
  assert.equal(decideQuote(61, 80).action, "done"); // 76% of model ≥ 75% floor
  assert.equal(decideQuote(59, 80).action, "pass"); // below the 25% tolerance floor
  assert.equal(decideQuote(59, 80, 0.5).action, "done"); // wider tolerance ⟹ accept
});

test("decideQuote without a model benchmark: positive nets accepted, non-positive passed", () => {
  assert.equal(decideQuote(50, 0).action, "done");
  assert.equal(decideQuote(-10, 0).action, "pass");
});
