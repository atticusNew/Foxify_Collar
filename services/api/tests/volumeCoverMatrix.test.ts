import assert from "node:assert/strict";
import test from "node:test";

import {
  MATRIX,
  findCellById,
  findCellByDimensions,
  computeTriggerPrices,
  computeHedgeStrikes
} from "../src/volumeCover/matrix";
import { selectCell } from "../src/volumeCover/cellSelector";
import { resolveDailyPremium } from "../src/volumeCover/pricing";

/**
 * Volume Cover matrix unit tests.
 *
 * Validates:
 *   - All 6 cells defined with TIGHT structure invariant (hedgePct < triggerPct)
 *   - Lookup helpers (by id, by dimensions)
 *   - Trigger boundary computation
 *   - TIGHT hedge strike computation (strikes inside trigger boundary)
 *   - Premium resolution (matrix base vs DB override)
 *   - Cell selector handles both lookup styles
 */

test("MATRIX has exactly 6 cells", () => {
  assert.equal(MATRIX.length, 6);
});

test("All cells satisfy TIGHT invariant: hedgePct < triggerPct", () => {
  for (const cell of MATRIX) {
    assert.ok(
      cell.hedgePct < cell.triggerPct,
      `${cell.cellId}: hedgePct ${cell.hedgePct} must be < triggerPct ${cell.triggerPct}`
    );
  }
});

test("All cells have positive USDC values", () => {
  for (const cell of MATRIX) {
    assert.ok(cell.notionalUsdc > 0);
    assert.ok(cell.payoutUsdc > 0);
    assert.ok(cell.dailyPremiumUsdc > 0);
    assert.ok(cell.defaultThrottleMaxPerDay > 0);
  }
});

test("findCellById returns expected cell", () => {
  const cell = findCellById("50k_2pct_1k");
  assert.ok(cell);
  assert.equal(cell!.notionalUsdc, 50_000);
  assert.equal(cell!.triggerPct, 0.02);
  assert.equal(cell!.payoutUsdc, 1_000);
});

test("findCellById returns null for unknown cell", () => {
  assert.equal(findCellById("nonexistent"), null);
});

test("findCellByDimensions matches on (notional, triggerPct)", () => {
  const cell = findCellByDimensions({ notionalUsdc: 200_000, triggerPct: 0.15 });
  assert.ok(cell);
  assert.equal(cell!.cellId, "200k_15pct_30k");
  assert.equal(cell!.payoutUsdc, 30_000);
});

test("findCellByDimensions returns null for unmatched dimensions", () => {
  // 50k notional, 8% trigger doesn't exist
  assert.equal(findCellByDimensions({ notionalUsdc: 50_000, triggerPct: 0.08 }), null);
});

test("computeTriggerPrices produces correct boundary", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const triggers = computeTriggerPrices({ cell, entryBtcPrice: 80_000 });
  assert.equal(triggers.triggerHighBtc, 81_600);
  assert.equal(triggers.triggerLowBtc, 78_400);
});

test("computeHedgeStrikes places strikes INSIDE trigger boundary (TIGHT)", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const triggers = computeTriggerPrices({ cell, entryBtcPrice: 80_000 });
  const strikes = computeHedgeStrikes({ cell, entryBtcPrice: 80_000 });

  // Put strike (79,200) is BETWEEN spot (80,000) and trigger low (78,400)
  assert.ok(strikes.putStrikeBtc < 80_000);
  assert.ok(strikes.putStrikeBtc > triggers.triggerLowBtc);

  // Call strike (80,800) is BETWEEN spot (80,000) and trigger high (81,600)
  assert.ok(strikes.callStrikeBtc > 80_000);
  assert.ok(strikes.callStrikeBtc < triggers.triggerHighBtc);
});

test("Hedge strike intrinsic at trigger covers payout magnitude", () => {
  // For $50k/2%/$1k cell at BTC $80k:
  //   Put strike = $79,200; trigger low = $78,400
  //   Intrinsic at trigger = $79,200 - $78,400 = $800/BTC
  //   Need at least 1.25 BTC of options to cover $1,000 payout
  const cell = findCellById("50k_2pct_1k")!;
  const triggers = computeTriggerPrices({ cell, entryBtcPrice: 80_000 });
  const strikes = computeHedgeStrikes({ cell, entryBtcPrice: 80_000 });
  const intrinsicPerBtc = strikes.putStrikeBtc - triggers.triggerLowBtc;
  const requiredBtc = cell.payoutUsdc / intrinsicPerBtc;
  assert.ok(requiredBtc <= 1.5, `requiredBtc=${requiredBtc} unrealistically high`);
  assert.ok(requiredBtc >= 1.0, `requiredBtc=${requiredBtc} unrealistically low`);
});

test("selectCell by cellId works", () => {
  const r = selectCell({ cellId: "200k_15pct_30k" });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cell.cellId, "200k_15pct_30k");
});

test("selectCell by dimensions works", () => {
  const r = selectCell({ notionalUsdc: 50_000, triggerPct: 0.05 });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.cell.cellId, "50k_5pct_2_5k");
});

test("selectCell returns ok=false on unknown", () => {
  const r = selectCell({ cellId: "bogus" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.reason, "cell_not_found");
});

test("resolveDailyPremium returns matrix base when no override", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const q = resolveDailyPremium({ cell });
  assert.equal(q.dailyPremiumUsdc, 350);
  assert.equal(q.source, "matrix_base");
});

test("resolveDailyPremium honors DB override when provided", () => {
  const cell = findCellById("50k_2pct_1k")!;
  const q = resolveDailyPremium({ cell, dbOverrideDailyPremiumUsdc: 425 });
  assert.equal(q.dailyPremiumUsdc, 425);
  assert.equal(q.source, "db_override");
});

test("resolveDailyPremium ignores invalid override (zero or negative)", () => {
  const cell = findCellById("50k_5pct_2_5k")!;
  const qZero = resolveDailyPremium({ cell, dbOverrideDailyPremiumUsdc: 0 });
  assert.equal(qZero.source, "matrix_base");
  const qNeg = resolveDailyPremium({ cell, dbOverrideDailyPremiumUsdc: -10 });
  assert.equal(qNeg.source, "matrix_base");
});
