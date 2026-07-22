import assert from "node:assert/strict";
import test from "node:test";
import { dayParticipationRoll } from "../src/singleSide/twoSided/creditCollar/forwardShadow";

test("day roll is deterministic and stable across calls (same day ⟹ same decision every cycle)", () => {
  const a = dayParticipationRoll("2026-07-22");
  const b = dayParticipationRoll("2026-07-22");
  assert.equal(a, b);
});

test("day roll stays in [0,1) and varies across days", () => {
  const days = Array.from({ length: 60 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, "0")}x${Math.floor(i / 28)}`);
  const rolls = days.map(dayParticipationRoll);
  for (const r of rolls) assert.ok(r >= 0 && r < 1, `roll out of range: ${r}`);
  assert.ok(new Set(rolls).size > 40, "rolls are well spread across days");
});

test("a ~1/3 participation admits roughly a third of days (deterministically)", () => {
  const days = Array.from({ length: 365 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return d.toISOString().slice(0, 10);
  });
  const taken = days.filter((d) => dayParticipationRoll(d) < 0.33).length;
  assert.ok(taken > 365 * 0.2 && taken < 365 * 0.5, `expected ~1/3 of days, got ${taken}/365`);
});
