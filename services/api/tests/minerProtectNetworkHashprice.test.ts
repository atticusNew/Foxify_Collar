/**
 * Miner Protect — free on-chain difficulty hashprice provider (pure formula + mocked fetcher).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  btcPerThPerDayFromDifficulty, difficultyHashpriceProvider, fetchAvgFeesPerBlockBtc,
  DEFAULT_BLOCK_SUBSIDY_BTC, DIFFICULTY_URL
} from "../src/minerProtect/networkHashprice";

const noFees = async () => ({ totalFee: 0 }); // inject 0 fees to keep tests offline + subsidy-only

test("btcPerThPerDayFromDifficulty: blocks/TH/day × (subsidy+fees); guards bad input", () => {
  // difficulty 1.1e14, subsidy 3.125 → ~5.7e-7 BTC/TH/day.
  const v = btcPerThPerDayFromDifficulty(1.1e14, 3.125)!;
  assert.ok(v > 5.6e-7 && v < 5.8e-7, `got ${v}`);
  assert.equal(btcPerThPerDayFromDifficulty(0, 3.125), null);
  assert.equal(btcPerThPerDayFromDifficulty(1e14, 0), null);
  assert.equal(DEFAULT_BLOCK_SUBSIDY_BTC, 3.125);
});

test("difficultyHashpriceProvider: parses difficulty; subsidy-only when fees=0", async () => {
  let seen = "";
  const fetcher = async (url: string) => { seen = url; return "110000000000000"; }; // 1.1e14
  const p = difficultyHashpriceProvider({ fetcher, feeFetcher: noFees });
  const v = (await p.getBtcPerThPerDay())!;
  assert.ok(v > 5.6e-7 && v < 5.8e-7, `got ${v}`);
  assert.equal(seen, DIFFICULTY_URL);
});

test("fetchAvgFeesPerBlockBtc: totalFee sats / 144 / 1e8", async () => {
  // 0.05 BTC/block avg over 144 blocks → totalFee = 144 × 0.05 × 1e8 sats.
  const fees = await fetchAvgFeesPerBlockBtc(async () => ({ totalFee: 144 * 0.05 * 1e8 }));
  assert.ok(Math.abs((fees as number) - 0.05) < 1e-9, `got ${fees}`);
  assert.equal(await fetchAvgFeesPerBlockBtc(async () => ({ totalFee: 0 })), null);
});

test("difficultyHashpriceProvider: fees raise productivity; null on difficulty fetch error", async () => {
  const withFees = (await difficultyHashpriceProvider({
    fetcher: async () => "110000000000000",
    feeFetcher: async () => ({ totalFee: 144 * 0.1 * 1e8 }) // 0.1 BTC/block
  }).getBtcPerThPerDay())!;
  const base = btcPerThPerDayFromDifficulty(1.1e14, 3.125)!;
  assert.ok(withFees > base, `fees should raise productivity: ${withFees} vs ${base}`);
  const boom = difficultyHashpriceProvider({ fetcher: async () => { throw new Error("net"); }, feeFetcher: noFees });
  assert.equal(await boom.getBtcPerThPerDay(), null);
});
