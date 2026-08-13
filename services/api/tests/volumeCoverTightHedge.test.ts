import assert from "node:assert/strict";
import test from "node:test";

import { MATRIX, findCellById } from "../src/volumeCover/matrix";
import {
  resolveHedgeVenue,
  computeHedgeContractSize,
  buildHedgeStructure,
  executeHedgeStructure,
  estimateOptionUnitCostUsdc,
  type HedgeExecutor
} from "../src/volumeCover/tightHedge";

/**
 * TIGHT hedge construction + execution tests.
 *
 * Validates:
 *   - Multi-venue routing per cell trigger pct
 *   - Contract sizing math (payout / intrinsic_at_trigger)
 *   - Hedge structure builder produces correct strikes + expiry
 *   - executeHedgeStructure happy path through executor
 *   - Fallback to secondary venue on primary failure
 *   - Rollback when both legs cannot fill
 */

test("resolveHedgeVenue defaults: ±2% routes Bullish primary, Deribit fallback", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const r = resolveHedgeVenue(cell);
  assert.equal(r.primary, "bullish");
  assert.equal(r.fallback, "deribit");
});

test("resolveHedgeVenue defaults: ±10% routes Deribit primary", () => {
  const cell = findCellById("50k_10pct_5k")!;
  const r = resolveHedgeVenue(cell);
  assert.equal(r.primary, "deribit");
});

test("resolveHedgeVenue honors VOLUME_COVER_VENUE_ROUTING_JSON env", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const original = process.env.VOLUME_COVER_VENUE_ROUTING_JSON;
  process.env.VOLUME_COVER_VENUE_ROUTING_JSON = JSON.stringify({
    "0.02": { primary: "deribit", fallback: "bullish" }
  });
  try {
    const r = resolveHedgeVenue(cell);
    assert.equal(r.primary, "deribit");
    assert.equal(r.fallback, "bullish");
  } finally {
    if (original === undefined) delete process.env.VOLUME_COVER_VENUE_ROUTING_JSON;
    else process.env.VOLUME_COVER_VENUE_ROUTING_JSON = original;
  }
});

test("computeHedgeContractSize: $50k/2%/$1k at $80k spot needs ~1.3 BTC", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const sized = computeHedgeContractSize({ cell, entryBtcPrice: 80_000 });
  // intrinsic at trigger = $80k × (0.02 - 0.01) = $800/BTC
  // required = $1000 / $800 = 1.25 → rounds up to 1.3 with 0.1 granularity
  assert.equal(sized.contractsBtc, 1.3);
  assert.equal(sized.intrinsicAtTriggerUsdc, 800);
});

test("computeHedgeContractSize: $200k/15%/$30k cell sized correctly", () => {
  const cell = findCellById("200k_15pct_30k")!;
  const sized = computeHedgeContractSize({ cell, entryBtcPrice: 80_000 });
  // intrinsic at trigger = $80k × (0.15 - 0.07) = $6,400/BTC
  // required = $30,000 / $6,400 = ~4.6875 → rounds up to 4.7
  assert.equal(sized.contractsBtc, 4.7);
  assert.equal(sized.intrinsicAtTriggerUsdc, 6_400);
});

test("buildHedgeStructure produces 2 legs (put + call) with INSIDE-trigger strikes", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "test-pos-1",
    cell,
    entryBtcPrice: 80_000
  });
  assert.equal(structure.legs.length, 2);
  const put = structure.legs.find((l) => l.optionKind === "put")!;
  const call = structure.legs.find((l) => l.optionKind === "call")!;
  assert.equal(put.strikeUsdc, 79_200);
  assert.equal(call.strikeUsdc, 80_800);
  // Put strike > trigger low (78,400) — TIGHT
  assert.ok(put.strikeUsdc > 78_400);
  // Call strike < trigger high (81,600) — TIGHT
  assert.ok(call.strikeUsdc < 81_600);
});

test("buildHedgeStructure default tenor is 14 days, snapped to 08:00 UTC", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "test-pos-2",
    cell,
    entryBtcPrice: 80_000
  });
  const expiry = new Date(structure.legs[0].expiryIso);
  assert.equal(expiry.getUTCHours(), 8);
  assert.equal(expiry.getUTCMinutes(), 0);
  // P1a: matched-tenor 14d default. Allow 13-15 days due to UTC snap.
  const daysOut = (expiry.getTime() - Date.now()) / 86_400_000;
  assert.ok(daysOut >= 13 && daysOut <= 15, `expected 13-15d expiry, got ${daysOut.toFixed(2)}d`);
});

test("buildHedgeStructure honors expiryHorizonDays override (1d for testing)", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "test-pos-3",
    cell,
    entryBtcPrice: 80_000,
    expiryHorizonDays: 1
  });
  const expiry = new Date(structure.legs[0].expiryIso);
  assert.equal(expiry.getUTCHours(), 8);
  const daysOut = (expiry.getTime() - Date.now()) / 86_400_000;
  // 1d horizon snapped to 08:00 UTC: between 0 and 2 days
  assert.ok(daysOut >= 0 && daysOut <= 2, `expected 0-2d expiry, got ${daysOut.toFixed(2)}d`);
});

test("estimateOptionUnitCostUsdc returns positive values for all matrix triggers", () => {
  for (const cell of MATRIX) {
    const cost = estimateOptionUnitCostUsdc(cell);
    assert.ok(cost > 0, `${cell.cellId}: unit cost ${cost} must be > 0`);
  }
});

const buildMockExecutor = (overrides: Partial<HedgeExecutor> = {}): HedgeExecutor => ({
  buyOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 100,
    totalCostUsdc: 100 * params.contractsBtc,
    orderId: `MOCK-${Date.now()}-${Math.random()}`
  }),
  sellOptionLeg: async (params) => ({
    venue: params.venue,
    fillPriceUsdcPerBtc: 95,
    totalProceedsUsdc: 95 * params.contractsBtc,
    orderId: `MOCK-SELL-${Date.now()}`
  }),
  ...overrides
});

test("executeHedgeStructure happy path fills both legs on primary venue", async () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "exec-test-1",
    cell,
    entryBtcPrice: 80_000
  });
  const result = await executeHedgeStructure({
    structure,
    cell,
    executor: buildMockExecutor()
  });
  assert.equal(result.legs.length, 2);
  assert.ok(result.totalCostUsdc > 0);
  assert.equal(result.legs[0].venue, "bullish"); // primary for ±2%
});

test("executeHedgeStructure falls back to secondary venue on primary failure", async () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "exec-test-2",
    cell,
    entryBtcPrice: 80_000
  });
  const executor = buildMockExecutor({
    buyOptionLeg: async (params) => {
      if (params.venue === "bullish") {
        throw new Error("primary_unavailable");
      }
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 100,
        totalCostUsdc: 100 * params.contractsBtc,
        orderId: "FALLBACK-ORD"
      };
    }
  });
  const result = await executeHedgeStructure({ structure, cell, executor });
  assert.equal(result.legs.length, 2);
  // Both legs should land on Deribit fallback
  assert.equal(result.legs[0].venue, "deribit");
  assert.equal(result.legs[1].venue, "deribit");
});

test("executeHedgeStructure rolls back filled legs if any leg fails on both venues", async () => {
  const cell = findCellById("50k_2pct_1k")!;
  const structure = buildHedgeStructure({
    positionId: "exec-test-3",
    cell,
    entryBtcPrice: 80_000
  });
  let putFilled = false;
  let putRolledBack = false;
  const executor: HedgeExecutor = {
    buyOptionLeg: async (params) => {
      if (params.optionKind === "put") {
        putFilled = true;
        return {
          venue: params.venue,
          fillPriceUsdcPerBtc: 100,
          totalCostUsdc: 100 * params.contractsBtc,
          orderId: "PUT-OK"
        };
      }
      // Call leg fails on every venue
      throw new Error("call_unfillable");
    },
    sellOptionLeg: async (params) => {
      if (params.optionKind === "put") putRolledBack = true;
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: 95,
        totalProceedsUsdc: 95 * params.contractsBtc,
        orderId: "ROLLBACK"
      };
    }
  };
  await assert.rejects(executeHedgeStructure({ structure, cell, executor }), /call.*leg/i);
  assert.ok(putFilled, "put leg should have filled before call failed");
  assert.ok(putRolledBack, "put leg should have been rolled back via sellOptionLeg");
});
