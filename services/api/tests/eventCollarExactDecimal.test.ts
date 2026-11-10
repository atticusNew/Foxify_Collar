/**
 * exactDecimal.ts reads a venue's decimal string into integer units without passing through a
 * float, and divides in a named direction. The classic float traps are stated first as
 * JavaScript has them, then read exactly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { centsToDollarString, decimalUnits, divBig, divInt, mulDiv, readDecimal } from "../src/eventCollar/crossVenue/exactDecimal";


test("exact decimals: a venue string is read digit by digit into integer units; the classic float traps come out exact", () => {
  // the traps, as JavaScript's floats have them
  assert.notEqual(0.1 + 0.2, 0.3);
  assert.equal(Math.floor(0.29 * 100), 28);
  assert.equal(Math.round(1.005 * 100), 100);
  assert.equal(0.7 + 0.1, 0.7999999999999999);
  assert.equal(Math.floor(0.57 * 100), 56);
  assert.equal(Math.floor(1.15 * 100), 114);
  assert.equal(Math.floor(4.35 * 100), 434);
  assert.equal(Math.ceil(0.56 * 25 * 100), 1401);
  assert.equal(Math.ceil(0.07 * 100), 8);
  assert.equal((1.005).toFixed(2), "1.00");
  assert.equal((0.1055).toFixed(2), "0.11");

  // the same figures read exactly
  assert.equal((decimalUnits("0.1", 6, "down") as number) + (decimalUnits("0.2", 6, "down") as number), decimalUnits("0.3", 6, "down"));
  assert.deepEqual(["down", "up", "nearest"].map((r) => decimalUnits("0.29", 2, r as "down")), [29, 29, 29]);
  assert.deepEqual(["down", "up", "nearest"].map((r) => decimalUnits("1.005", 2, r as "down")), [100, 101, 101], "half a cent: down, up, and a tie going up");
  assert.deepEqual(["0.57", "1.15", "4.35", "19.99", "0.58", "0.14", "0.07"].map((s) => decimalUnits(s, 2, "down")), [57, 115, 435, 1999, 58, 14, 7]);
  assert.deepEqual(["0.57", "1.15", "4.35", "19.99", "0.58", "0.14", "0.07"].map((s) => decimalUnits(s, 2, "up")), [57, 115, 435, 1999, 58, 14, 7]);
  assert.equal(decimalUnits("0.1055", 6, "down"), 105_500);
  assert.deepEqual([decimalUnits("0.1055", 2, "down"), decimalUnits("0.1055", 2, "up"), decimalUnits("0.1055", 2, "nearest")], [10, 11, 11]);
  assert.deepEqual([decimalUnits("1.0000", 6, "down"), decimalUnits("2.00", 6, "down"), decimalUnits("50.00", 3, "down"), decimalUnits("9", 3, "down")], [1_000_000, 2_000_000, 50_000, 9000]);
  // a number is read through its shortest decimal form: what the venue's JSON carried
  assert.deepEqual([decimalUnits(0.29, 2, "down"), decimalUnits(1.005, 2, "up"), decimalUnits(0.1055, 6, "down"), decimalUnits(50, 3, "down"), decimalUnits(9.47, 2, "down")], [29, 101, 105_500, 50_000, 947]);
  // the float sum's stray digit is a digit like any other: it goes the way asked
  assert.deepEqual([decimalUnits(0.1 + 0.2, 6, "down"), decimalUnits(0.1 + 0.2, 6, "up")], [300_000, 300_001]);

  // signs, and which way each rounding goes on either side of zero
  assert.deepEqual([decimalUnits("-0.42", 6, "nearest"), decimalUnits("-0.9495", 6, "down"), decimalUnits("+0.5", 2, "down")], [-420_000, -949_500, 50]);
  assert.deepEqual([decimalUnits("-0.005", 2, "down"), decimalUnits("-0.005", 2, "up"), decimalUnits("-0.005", 2, "nearest"), decimalUnits("-0.015", 2, "nearest")].map((x) => x ?? null), [-1, 0, 0, -1].map((x) => x), "down is toward minus infinity, up toward plus, a tie goes up");
  assert.deepEqual([decimalUnits("0.015", 2, "nearest"), decimalUnits("0.025", 2, "nearest"), decimalUnits("0.0149", 2, "nearest")], [2, 3, 1]);

  // shapes
  assert.deepEqual([decimalUnits(" 0.54 ", 2, "down"), decimalUnits(".5", 2, "down"), decimalUnits("5.", 2, "down"), decimalUnits("007.10", 2, "down"), decimalUnits("0", 6, "down"), decimalUnits("0.000000", 6, "up")], [54, 50, 500, 710, 0, 0]);
  for (const bad of ["", " ", ".", "-", "abc", "1e-7", "1E3", "0x10", "1,000", "1.2.3", "--1", "1 000", "$1.00", "NaN", "Infinity", "1".repeat(41), null, undefined, NaN, Infinity, -Infinity, 1e-7, 1e21, true, {}, []]) {
    assert.equal(decimalUnits(bad, 6, "down"), null, `unreadable: ${String(bad)}`);
    assert.equal(readDecimal(bad), null);
  }
  assert.equal(decimalUnits("9007199254.740993", 6, "down"), null, "past a safe integer: refused, not rounded");
  assert.equal(decimalUnits("9007199254.740991", 6, "down"), Number.MAX_SAFE_INTEGER);

  // every whole cent, and every price on the four-decimal grid, reads back exactly
  for (let c = 0; c <= 20_000; c++) {
    const s = centsToDollarString(c);
    assert.equal(s, (c / 100).toFixed(2));
    if (decimalUnits(s, 2, "down") !== c || decimalUnits(s, 2, "up") !== c || decimalUnits(s, 6, "nearest") !== c * 10_000) assert.fail(`cents ${c} as ${s}`);
  }
  for (let k = 0; k <= 9999; k++) {
    const s = `0.${String(k).padStart(4, "0")}`;
    if (decimalUnits(s, 6, "down") !== k * 100 || decimalUnits(s, 6, "up") !== k * 100) assert.fail(`grid ${s}`);
    if (decimalUnits(s, 2, "down") !== Math.floor(k / 100) || decimalUnits(s, 2, "up") !== Math.ceil(k / 100)) assert.fail(`grid ${s} to cents`);
  }
  assert.deepEqual([centsToDollarString(53), centsToDollarString(5), centsToDollarString(0), centsToDollarString(100), centsToDollarString(108), centsToDollarString(12_345)], ["0.53", "0.05", "0.00", "1.00", "1.08", "123.45"]);
  for (const bad of [53.5, -1, NaN, Infinity]) assert.throws(() => centsToDollarString(bad), RangeError);
});

test("exact decimals: products and divisions stay whole past 2^53, name their direction, and refuse what is not an integer", () => {
  assert.deepEqual([divInt(7, 2, "down"), divInt(7, 2, "up"), divInt(7, 2, "nearest"), divInt(5, 2, "nearest"), divInt(-7, 2, "down"), divInt(-7, 2, "up"), divInt(-5, 2, "nearest"), divInt(6, 3, "up")], [3, 4, 4, 3, -4, -3, -2, 2]);
  assert.deepEqual([mulDiv(30, 535_000, 10_000, "down"), mulDiv(30, 105_500, 10_000, "down"), mulDiv(30, 105_500, 10_000, "up")], [1605, 316, 317]);
  // 9,007,199,254,740,991 x 1,000,000 is far past a float's integers; the quotient is still exact
  assert.equal(mulDiv(Number.MAX_SAFE_INTEGER, 1_000_000, 1_000_000, "down"), Number.MAX_SAFE_INTEGER);
  assert.equal(mulDiv(Number.MAX_SAFE_INTEGER, 999_999, 1_000_000, "down"), Number((BigInt(Number.MAX_SAFE_INTEGER) * 999_999n) / 1_000_000n));
  assert.equal(divBig(10n ** 30n + 1n, 10n ** 20n, "up"), 10 ** 10 + 1);
  assert.throws(() => mulDiv(Number.MAX_SAFE_INTEGER, 2, 1, "down"), RangeError, "a result past a safe integer is refused");
  assert.throws(() => mulDiv(1.5, 2, 1, "down"), RangeError);
  assert.throws(() => divInt(1, 0, "down"), RangeError);
  assert.throws(() => divInt(1, -1, "down"), RangeError);
});
