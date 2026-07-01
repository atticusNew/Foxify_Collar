import assert from "node:assert/strict";
import test from "node:test";
import { computeOpensThisCycle, type OpeningState } from "../src/singleSide/twoSided/creditCollar/openingSignalStore";

const CYCLE = 900_000; // 15 min
const DAY = 86_400_000;

test("no rate ⟹ opens nothing", () => {
  const r = computeOpensThisCycle(null, 1000, 0);
  assert.equal(r.nToOpen, 0);
});

test("first cycle seeds one position and starts the clock", () => {
  const r = computeOpensThisCycle(null, 5000, 2);
  assert.equal(r.nToOpen, 1);
  assert.equal(r.next.lastMs, 5000);
  assert.equal(r.next.accumulator, 0);
});

test("2/day releases ~2 positions over a day of 15-min cycles, staggered", () => {
  let state: OpeningState = { accumulator: 0, lastMs: 0 };
  let total = 0;
  let firstOpenCycle = -1;
  for (let i = 1; i <= 96; i++) {
    const now = i * CYCLE;
    const r = computeOpensThisCycle(state, now, 2);
    if (r.nToOpen > 0 && firstOpenCycle < 0) firstOpenCycle = i;
    total += r.nToOpen;
    state = r.next;
  }
  assert.equal(total, 2, "2/day over 96 cycles ⟹ 2 opens");
  // Staggered, not dumped at once: the first open lands mid-day (~cycle 48 = 12h), not cycle 1.
  assert.ok(firstOpenCycle >= 40 && firstOpenCycle <= 56, `first open should be ~12h in, got cycle ${firstOpenCycle}`);
});

test("a delayed/backlogged cycle is capped (no dumping the whole backlog at once)", () => {
  const prev: OpeningState = { accumulator: 0, lastMs: 0 };
  const tenDaysLater = 10 * DAY;
  const r = computeOpensThisCycle(prev, tenDaysLater, 2, { maxPerCycle: 5 });
  assert.equal(r.nToOpen, 5, "20 due but capped at maxPerCycle");
  assert.ok(r.next.accumulator > 0, "the remainder carries forward, not lost");
});
