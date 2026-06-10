/**
 * Miner Protect — free on-chain difficulty hashprice provider (pure formula + mocked fetcher).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  btcPerThPerDayFromDifficulty, difficultyHashpriceProvider, DEFAULT_BLOCK_SUBSIDY_BTC, DIFFICULTY_URL
} from "../src/minerProtect/networkHashprice";

test("btcPerThPerDayFromDifficulty: blocks/TH/day × (subsidy+fees); guards bad input", () => {
  // difficulty 1.1e14, subsidy 3.125 → ~5.7e-7 BTC/TH/day.
  const v = btcPerThPerDayFromDifficulty(1.1e14, 3.125)!;
  assert.ok(v > 5.6e-7 && v < 5.8e-7, `got ${v}`);
  assert.equal(btcPerThPerDayFromDifficulty(0, 3.125), null);
  assert.equal(btcPerThPerDayFromDifficulty(1e14, 0), null);
  assert.equal(DEFAULT_BLOCK_SUBSIDY_BTC, 3.125);
});

test("difficultyHashpriceProvider: parses difficulty number from the public endpoint", async () => {
  let seen = "";
  const fetcher = async (url: string) => { seen = url; return "110000000000000"; }; // 1.1e14
  const p = difficultyHashpriceProvider({ fetcher });
  const v = (await p.getBtcPerThPerDay())!;
  assert.ok(v > 5.6e-7 && v < 5.8e-7, `got ${v}`);
  assert.equal(seen, DIFFICULTY_URL);
});

test("difficultyHashpriceProvider: custom subsidy+fees; null on fetch error", async () => {
  const p = difficultyHashpriceProvider({ subsidyPlusFeesBtc: 3.225, fetcher: async () => "110000000000000" });
  const withFees = (await p.getBtcPerThPerDay())!;
  const base = btcPerThPerDayFromDifficulty(1.1e14, 3.125)!;
  assert.ok(withFees > base); // fees raise productivity
  const boom = difficultyHashpriceProvider({ fetcher: async () => { throw new Error("net"); } });
  assert.equal(await boom.getBtcPerThPerDay(), null);
});
