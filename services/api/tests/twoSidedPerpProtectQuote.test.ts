/**
 * Perp Protect quote engine — entry-aware worst case (single capped vs spread band), both sides.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  liquidationOf, buildSingleOption, buildSpreadOption, buildPerpProtectQuote,
  type PerpPosition, type StrikeQuote
} from "../src/singleSide/twoSided/perpProtectQuote";

const longPos: PerpPosition = { spot: 60000, entryPrice: 60000, sizeBtc: 1, side: "long", leverage: 10, tenorDays: 7 };
const shortPos: PerpPosition = { ...longPos, side: "short" };

test("liquidationOf: long below entry, short above entry", () => {
  assert.deepEqual(liquidationOf(longPos), { price: 54000, movePct: 0.1 });
  assert.deepEqual(liquidationOf(shortPos), { price: 66000, movePct: 0.1 });
});

test("single (long put): worst case = (entry−K)·size + premium, capped", () => {
  const o = buildSingleOption(longPos, { strike: 57000, askUsdcPerBtc: 800 }, 1);
  assert.equal(o.structure, "put");
  assert.equal(o.premium_usdc, 800);
  assert.equal(o.worst_case_usdc, 3800); // (60000−57000)×1 + 800
  assert.equal(o.capped, true);
  assert.equal(o.cost_pct_margin, +(800 / 6000).toFixed(4));
  assert.equal(o.protect_move_pct, 0.05); // (60000−57000)/60000
});

test("single (short call): worst case = (K−entry)·size + premium", () => {
  const o = buildSingleOption(shortPos, { strike: 63000, askUsdcPerBtc: 700 }, 0);
  assert.equal(o.structure, "call");
  assert.equal(o.worst_case_usdc, 3700); // (63000−60000)×1 + 700
  assert.equal(o.capped, true);
});

test("spread (long): in-band loss + exposed-beyond flag; short strike must be deeper", () => {
  const sp = buildSpreadOption(longPos, { strike: 58000, askUsdcPerBtc: 600 }, { strike: 55000, askUsdcPerBtc: 0, bidUsdcPerBtc: 250 });
  assert.ok(sp);
  assert.equal(sp!.premium_usdc, 350);       // 600 − 250
  assert.equal(sp!.worst_case_usdc, 2350);   // (60000−58000)×1 + 350
  assert.equal(sp!.capped, false);
  assert.equal(sp!.exposed_beyond, 55000);
});

test("spread (long): invalid when short strike is not deeper (K2 ≥ K1)", () => {
  const sp = buildSpreadOption(longPos, { strike: 58000, askUsdcPerBtc: 600 }, { strike: 59000, askUsdcPerBtc: 0, bidUsdcPerBtc: 250 });
  assert.equal(sp, null);
});

test("spread (short): valid when short call strike is HIGHER (deeper OTM)", () => {
  const sp = buildSpreadOption(shortPos, { strike: 62000, askUsdcPerBtc: 600 }, { strike: 65000, askUsdcPerBtc: 0, bidUsdcPerBtc: 250 });
  assert.ok(sp);
  assert.equal(sp!.structure, "call_spread");
  assert.equal(sp!.worst_case_usdc, 2350);   // (62000−60000)×1 + 350
  assert.equal(sp!.exposed_beyond, 65000);
});

test("buildPerpProtectQuote: assembles position + options, default european, unrealized pnl", () => {
  const q = buildPerpProtectQuote(
    { ...longPos, spot: 61000 }, // mark moved up → +1000 unrealized on a long
    {
      singles: [{ strike: 58000, askUsdcPerBtc: 700 }, { strike: 56000, askUsdcPerBtc: 400 }],
      spread: { long: { strike: 58000, askUsdcPerBtc: 700 }, short: { strike: 55000, askUsdcPerBtc: 0, bidUsdcPerBtc: 300 } }
    }
  );
  assert.equal(q.settlement_style, "european");
  assert.equal(q.position.unrealized_pnl_usdc, 1000); // (61000−60000)×1
  assert.equal(q.position.liquidation_price, 54000);  // from entry 60000
  assert.equal(q.options.length, 3); // 2 singles + 1 spread
  assert.equal(q.options.filter((o) => o.capped).length, 2);
  assert.equal(q.options.filter((o) => !o.capped).length, 1);
});
