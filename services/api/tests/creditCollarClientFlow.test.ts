import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFlowCountForDay, clientFlowOpenParams } from "../src/singleSide/twoSided/creditCollar/forwardShadow";

const CF = { minPerDay: 1, maxPerDay: 6, minNotionalUsdc: 1_000, maxNotionalUsdc: 50_000 };

test("client flow: daily count is deterministic, within [min,max], and varies across days", () => {
  const days = Array.from({ length: 60 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, "0")}#w${Math.floor(i / 28)}`);
  const counts = days.map((d) => clientFlowCountForDay(d, CF));
  for (const c of counts) assert.ok(c >= 1 && c <= 6, `count ${c} in range`);
  assert.equal(clientFlowCountForDay("2026-08-11", CF), clientFlowCountForDay("2026-08-11", CF), "same day ⟹ same count (stable across cycles/restarts)");
  assert.ok(new Set(counts).size > 1, "different days roll different counts");
});

test("client flow: per-open params are deterministic per salt, sides mix, notionals bounded and $500-snapped", () => {
  const params = Array.from({ length: 200 }, (_, i) => clientFlowOpenParams(`1786400000000#${i}`, CF));
  const longs = params.filter((p) => p.side === "long").length;
  assert.ok(longs > 50 && longs < 150, `sides mix (${longs}/200 long)`);
  for (const p of params) {
    assert.ok(p.notionalUsdc >= 1_000 && p.notionalUsdc <= 50_000, "notional in bounds");
    assert.equal(p.notionalUsdc % 500, 0, "snapped to $500 tickets");
  }
  assert.ok(new Set(params.map((p) => p.notionalUsdc)).size > 10, "ticket sizes vary");
  assert.deepEqual(clientFlowOpenParams("x#3", CF), clientFlowOpenParams("x#3", CF), "same salt ⟹ same params");
});

test("client flow: degenerate bounds behave (min==max, tiny range)", () => {
  const fixed = { minPerDay: 2, maxPerDay: 2, minNotionalUsdc: 5_000, maxNotionalUsdc: 5_000 };
  assert.equal(clientFlowCountForDay("2026-08-11", fixed), 2);
  const p = clientFlowOpenParams("s#0", fixed);
  assert.equal(p.notionalUsdc, 5_000);
});
