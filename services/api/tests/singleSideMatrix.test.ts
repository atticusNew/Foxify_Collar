import assert from "node:assert/strict";
import test from "node:test";

import {
  SINGLE_SIDE_MATRIX,
  findCellById,
  computeSingleSideTriggerPrice,
  computeSingleSideHedgeStrike,
  computeSingleSideHedgeSize
} from "../src/singleSide/matrix";

test("matrix: 5 cells with correct structure", () => {
  assert.equal(SINGLE_SIDE_MATRIX.length, 5);
  for (const c of SINGLE_SIDE_MATRIX) {
    assert.ok(c.cellId.startsWith("ss_"));
    assert.ok(c.hedgePct < c.triggerPct);
    assert.ok([3, 6].includes(c.hedgeTenorDays), `tenor must be 3 or 6, got ${c.hedgeTenorDays}`);
  }
});

test("matrix: 5% cells use 3d tenor; 7% cells use 6d tenor", () => {
  for (const c of SINGLE_SIDE_MATRIX) {
    if (Math.abs(c.triggerPct - 0.05) < 0.001) {
      assert.equal(c.hedgeTenorDays, 3, `${c.cellId} should use 3d`);
    }
    if (Math.abs(c.triggerPct - 0.07) < 0.001) {
      assert.equal(c.hedgeTenorDays, 6, `${c.cellId} should use 6d`);
    }
  }
});

test("matrix: pricing reflects live Bullish data (calm regime)", () => {
  // Spot-check the headline 200k/5% cell from the report
  const c = findCellById("ss_200k_5pct_10k")!;
  assert.equal(c.dailyPremiumUsdc, 600);
  assert.equal(c.notionalUsdc, 200_000);
  assert.equal(c.payoutUsdc, 10_000);
  assert.equal(c.triggerPct, 0.05);
  assert.equal(c.hedgePct, 0.03);
  assert.equal(c.hedgeTenorDays, 3);
});

test("trigger price: long cover triggers below entry, short above", () => {
  const cell = findCellById("ss_200k_5pct_10k")!;
  const long = computeSingleSideTriggerPrice({ cell, entryBtcPrice: 80_000, direction: "long" });
  const short = computeSingleSideTriggerPrice({ cell, entryBtcPrice: 80_000, direction: "short" });
  assert.equal(long, 76_000);
  assert.equal(short, 84_000);
});

test("hedge strike: short cover gets call, long cover gets put", () => {
  const cell = findCellById("ss_200k_5pct_10k")!;
  const longCover = computeSingleSideHedgeStrike({ cell, entryBtcPrice: 80_000, direction: "long" });
  const shortCover = computeSingleSideHedgeStrike({ cell, entryBtcPrice: 80_000, direction: "short" });
  assert.equal(longCover.optionKind, "put");
  assert.equal(longCover.strikeUsdc, 77_600);  // 3% below
  assert.equal(shortCover.optionKind, "call");
  assert.equal(shortCover.strikeUsdc, 82_400);  // 3% above
});

test("hedge size: 200k/5% needs 6.25 BTC base, rounds up to 6.3", () => {
  const cell = findCellById("ss_200k_5pct_10k")!;
  const sized = computeSingleSideHedgeSize({ cell, entryBtcPrice: 80_000 });
  // intrinsic_at_trigger = $80k × (5% - 3%) = $1,600/BTC
  // required = $10,000 / $1,600 = 6.25 → rounds up to 6.3
  assert.equal(sized.contractsBtc, 6.3);
  assert.equal(sized.intrinsicAtTriggerUsdc, 1_600);
});

test("hedge size: vol buffer multiplier scales correctly", () => {
  const cell = findCellById("ss_200k_5pct_10k")!;
  const calm = computeSingleSideHedgeSize({ cell, entryBtcPrice: 80_000, volBufferMultiplier: 1.0 });
  const stress = computeSingleSideHedgeSize({ cell, entryBtcPrice: 80_000, volBufferMultiplier: 1.15 });
  // 6.25 × 1.15 = 7.1875 → rounds to 7.2
  assert.equal(calm.contractsBtc, 6.3);
  assert.equal(stress.contractsBtc, 7.2);
});

test("hedge size: 50k/2% needs 1.25 BTC base", () => {
  const cell = findCellById("ss_50k_2pct_1k")!;
  const sized = computeSingleSideHedgeSize({ cell, entryBtcPrice: 80_000 });
  // intrinsic = $80k × (2% - 1%) = $800/BTC
  // required = $1,000 / $800 = 1.25 → rounds to 1.3
  assert.equal(sized.contractsBtc, 1.3);
  assert.equal(sized.intrinsicAtTriggerUsdc, 800);
});

test("hedge size: 200k/7% needs 8.75 BTC base", () => {
  const cell = findCellById("ss_200k_7pct_14k")!;
  const sized = computeSingleSideHedgeSize({ cell, entryBtcPrice: 80_000 });
  // intrinsic = $80k × (7% - 5%) = $1,600/BTC
  // required = $14,000 / $1,600 = 8.75 → rounds to 8.8
  assert.equal(sized.contractsBtc, 8.8);
});
