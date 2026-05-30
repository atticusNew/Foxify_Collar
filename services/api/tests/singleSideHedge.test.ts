import assert from "node:assert/strict";
import test from "node:test";

import { findCellById } from "../src/singleSide/matrix";
import { buildSingleSideHedge, executeSingleSideHedge } from "../src/singleSide/singleSideHedge";
import { __resetVenueStrikeGridForTests, setVenueOptionChainProvider } from "../src/volumeCover/venueStrikeGrid";
import type { HedgeExecutor } from "../src/volumeCover/tightHedge";

const buildSpyExecutor = () => {
  const buyCalls: any[] = [];
  const e: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      buyCalls.push(params);
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 310,
        totalCostUsdc: 310 * params.contractsBtc,
        orderId: `BUY-${buyCalls.length}`
      };
    },
    sellOptionLeg: async () => ({
      venue: "bullish" as const,
      fillPriceUsdcPerBtc: 0,
      totalProceedsUsdc: 0,
      orderId: "X"
    })
  };
  return { executor: e, buyCalls };
};

test("buildSingleSideHedge: SHORT cover gets call leg above entry", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-1",
    cell,
    direction: "short",
    entryBtcPrice: 80_000
  });
  assert.equal(s.legs.length, 1);
  assert.equal(s.legs[0].optionKind, "call");
  // 3% above entry = $82,400; snap to grid (Bullish $200) → 82,400 exact
  assert.equal(s.legs[0].strikeUsdc, 82_400);
  assert.equal(s.cellId, "ss_200k_5pct_10k");
  assert.equal(s.direction, "short");
});

test("buildSingleSideHedge: LONG cover gets put leg below entry", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-2",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  assert.equal(s.legs.length, 1);
  assert.equal(s.legs[0].optionKind, "put");
  // 3% below entry = $77,600
  assert.equal(s.legs[0].strikeUsdc, 77_600);
});

test("buildSingleSideHedge: 3-day expiry for 5% trigger cells", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-3",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  const daysOut = (new Date(s.legs[0].expiryIso).getTime() - Date.now()) / 86_400_000;
  assert.ok(daysOut >= 2.5 && daysOut <= 3.5, `expected ~3d, got ${daysOut.toFixed(2)}d`);
});

test("buildSingleSideHedge: 6-day expiry for 7% trigger cells", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_7pct_14k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-4",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  const daysOut = (new Date(s.legs[0].expiryIso).getTime() - Date.now()) / 86_400_000;
  assert.ok(daysOut >= 5.5 && daysOut <= 6.5, `expected ~6d, got ${daysOut.toFixed(2)}d`);
});

test("buildSingleSideHedge: vol-buffered sizing in elevated regime", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-5",
    cell,
    direction: "long",
    entryBtcPrice: 80_000,
    regime: "elevated"
  });
  // Base 6.25 BTC × 1.10 = 6.875 → round up to 6.9
  assert.equal(s.legs[0].contractsBtc, 6.9);
});

test("buildSingleSideHedge: live venue chain takes precedence when wired", async () => {
  __resetVenueStrikeGridForTests();
  setVenueOptionChainProvider(async () => [77_500, 77_600, 77_700, 77_800]);
  try {
    const cell = findCellById("ss_200k_5pct_10k")!;
    const s = await buildSingleSideHedge({
      positionId: "test-6",
      cell,
      direction: "long",
      entryBtcPrice: 80_000
    });
    // Ideal $77,600 — closest in-band strike is 77,600 (exact match)
    assert.equal(s.legs[0].strikeUsdc, 77_600);
  } finally {
    __resetVenueStrikeGridForTests();
  }
});

test("buildSingleSideHedge: 7% cell venue defaults to Deribit primary", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_7pct_14k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-7",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  assert.equal(s.venue, "deribit");
});

test("buildSingleSideHedge: 5% cell venue defaults to Bullish primary", async () => {
  __resetVenueStrikeGridForTests();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-8",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  assert.equal(s.venue, "bullish");
});

test("executeSingleSideHedge: happy path fills single leg", async () => {
  __resetVenueStrikeGridForTests();
  const { executor, buyCalls } = buildSpyExecutor();
  const cell = findCellById("ss_200k_5pct_10k")!;
  const s = await buildSingleSideHedge({
    positionId: "test-9",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  const result = await executeSingleSideHedge({ structure: s, cell, executor });
  assert.equal(buyCalls.length, 1);
  assert.equal(buyCalls[0].optionKind, "put");
  assert.equal(result.totalCostUsdc, 310 * s.legs[0].contractsBtc);
});

test("executeSingleSideHedge: falls back to secondary venue on primary failure", async () => {
  __resetVenueStrikeGridForTests();
  let callCount = 0;
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      callCount++;
      if (params.venue === "bullish") throw new Error("bullish_down");
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 310,
        totalCostUsdc: 310 * params.contractsBtc,
        orderId: "DERIBIT-OK"
      };
    },
    sellOptionLeg: async () => ({
      venue: "bullish",
      fillPriceUsdcPerBtc: 0,
      totalProceedsUsdc: 0,
      orderId: "X"
    })
  };
  const cell = findCellById("ss_200k_5pct_10k")!; // Bullish primary
  const s = await buildSingleSideHedge({
    positionId: "test-10",
    cell,
    direction: "long",
    entryBtcPrice: 80_000
  });
  const result = await executeSingleSideHedge({ structure: s, cell, executor });
  assert.equal(result.leg.venue, "deribit"); // fallback
  assert.equal(callCount, 2);
});
