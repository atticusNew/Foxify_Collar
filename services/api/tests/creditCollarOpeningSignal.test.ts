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

test("pair-atomic: releases only whole pairs — 2/day opens ONE PAIR per day, never a lone leg", () => {
  // Seed is a full pair.
  const seed = computeOpensThisCycle(null, 5000, 2, { pairSize: 2 });
  assert.equal(seed.nToOpen, 2, "seed opens a complete pair");
  // Then across a day of cycles: nothing at ~12h (only 1 accrued — held back), a full pair at ~24h.
  let state: OpeningState = seed.next;
  const opens: number[] = [];
  for (let i = 1; i <= 96; i++) {
    const r = computeOpensThisCycle(state, 5000 + i * CYCLE, 2, { pairSize: 2 });
    opens.push(r.nToOpen);
    state = r.next;
  }
  assert.ok(opens.every((n) => n % 2 === 0), "every release is a whole pair");
  assert.equal(opens.reduce((a, b) => a + b, 0), 2, "2/day ⟹ one pair over the day");
  const half = opens.slice(0, 48).reduce((a, b) => a + b, 0);
  assert.equal(half, 0, "the single accrued leg at ~12h is HELD, not released naked");
});

test("pair-atomic: backlog cap snaps to whole pairs", () => {
  const r = computeOpensThisCycle({ accumulator: 0, lastMs: 0 }, 10 * DAY, 2, { pairSize: 2, maxPerCycle: 5 });
  assert.equal(r.nToOpen, 4, "cap 5 snaps down to 4 (two whole pairs)");
});
