import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollTickHistory, loadTickHistory, saveTickHistory } from "../src/singleSide/twoSided/creditCollar/tickHistoryStore";
import { detectBarrier } from "../src/singleSide/twoSided/creditCollar/barrierLifecycle";
import type { OracleTick } from "../src/singleSide/twoSided/creditCollar/referenceOracle";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

test("rollTickHistory: appends and keeps chronological order", () => {
  const prev: OracleTick[] = [{ tsMs: NOW - 2 * MIN, priceUsd: 100_000 }];
  const out = rollTickHistory(prev, { tsMs: NOW, priceUsd: 99_500 }, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[1].priceUsd, 99_500);
  assert.ok(out[0].tsMs < out[1].tsMs);
});

test("rollTickHistory: drops ticks older than maxAgeMs", () => {
  const prev: OracleTick[] = [
    { tsMs: NOW - 50 * MIN, priceUsd: 100_000 }, // older than 30-min window
    { tsMs: NOW - 10 * MIN, priceUsd: 99_000 }
  ];
  const out = rollTickHistory(prev, { tsMs: NOW, priceUsd: 98_000 }, NOW, { maxAgeMs: 30 * MIN });
  assert.equal(out.length, 2, "the 50-min-old tick is dropped");
  assert.deepEqual(out.map((t) => t.priceUsd), [99_000, 98_000]);
});

test("rollTickHistory: caps to maxTicks (most recent kept)", () => {
  let hist: OracleTick[] = [];
  for (let i = 0; i < 10; i++) hist = rollTickHistory(hist, { tsMs: NOW - (10 - i) * MIN, priceUsd: 100_000 - i }, NOW, { maxTicks: 3 });
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((t) => t.priceUsd), [100_000 - 7, 100_000 - 8, 100_000 - 9]);
});

test("rollTickHistory: rejects bad prices and out-of-window timestamps (fail-safe)", () => {
  const prev: OracleTick[] = [{ tsMs: NOW - MIN, priceUsd: 100_000 }];
  assert.equal(rollTickHistory(prev, { tsMs: NOW, priceUsd: 0 }, NOW).length, 1, "zero price ignored");
  assert.equal(rollTickHistory(prev, { tsMs: NOW, priceUsd: NaN }, NOW).length, 1, "NaN price ignored");
  assert.equal(rollTickHistory(prev, { tsMs: NOW + MIN, priceUsd: 99_000 }, NOW).length, 1, "future tick ignored");
});

test("rollTickHistory: a sustained decline confirms a floor touch via detectBarrier", () => {
  // Simulate cycles where price slides below a 96k floor for 3 consecutive cycle-medians.
  const prices = [99_000, 97_000, 95_900, 95_500, 95_000];
  let hist: OracleTick[] = [];
  prices.forEach((p, i) => {
    hist = rollTickHistory(hist, { tsMs: NOW - (prices.length - i) * MIN, priceUsd: p }, NOW);
  });
  const touch = detectBarrier(hist, 96_000, 101_000, 3);
  assert.equal(touch.barrier, "floor");
  // A single wick (one cycle below, then back above) must NOT confirm at persist=3.
  let wick: OracleTick[] = [];
  [99_000, 95_000, 99_500].forEach((p, i) => {
    wick = rollTickHistory(wick, { tsMs: NOW - (3 - i) * MIN, priceUsd: p }, NOW);
  });
  assert.equal(detectBarrier(wick, 96_000, 101_000, 3).barrier, "none");
});

test("tickHistoryStore: round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "tick-hist-"));
  const path = join(dir, "ticks.json");
  try {
    const ticks: OracleTick[] = [
      { tsMs: NOW - MIN, priceUsd: 100_000 },
      { tsMs: NOW, priceUsd: 99_000 }
    ];
    saveTickHistory(ticks, path);
    assert.deepEqual(loadTickHistory(path), ticks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickHistoryStore: missing file ⟹ empty history", () => {
  assert.deepEqual(loadTickHistory(join(tmpdir(), "does-not-exist-xyz.json")), []);
});
