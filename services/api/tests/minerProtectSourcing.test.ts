/**
 * Miner Protect — floor strike ladder + quote assembly (injected sourcing, offline).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { floorStrikeLadder, assembleMinerQuote, type FloorSource } from "../src/minerProtect/minerProtectSourcing";
import type { MinerInputs } from "../src/minerProtect/minerProtectQuote";

// breakeven $48,000 (see minerProtectQuote tests): 100k TH/s @ 30 W/TH, $0.05/kWh, 7.5e-7 BTC/TH/day.
const miner: MinerInputs = {
  hashrateThs: 100_000, efficiencyWPerTh: 30, powerCostUsdPerKwh: 0.05,
  btcPerThPerDay: 0.00000075, btcPrice: 60_000, tenorDays: 30
};

test("floorStrikeLadder: OTM floors (≤ spot) — breakeven (when below spot) + drawdowns, de-duped", () => {
  // breakeven 48k < spot 60k → included; drawdowns 5/10/15/20% → 57k/54k/51k/48k (20% == breakeven, deduped).
  assert.deepEqual(floorStrikeLadder(48_000, 60_000), [57_000, 54_000, 51_000, 48_000]);
  // underwater miner: breakeven 79,575 > spot → excluded; only OTM drawdown floors remain.
  assert.deepEqual(floorStrikeLadder(79_575, 60_000, [0.05, 0.1]), [57_000, 54_000]);
  assert.deepEqual(floorStrikeLadder(48_000, 0), []); // no spot
});

test("assembleMinerQuote: OTM floors sourced → recommendation + venues_considered", async () => {
  // ask/BTC scales with strike (deeper = cheaper); breakeven 48k, spot 60k.
  const sourcePut = async (strike: number): Promise<FloorSource> => ({
    best: { strike, ask: Math.max(50, (strike - 40_000) / 10), venue: "deribit", spreadPct: 0.02 },
    considered: ["okx", "deribit"]
  });
  const q = await assembleMinerQuote(miner, { sourcePut, drawdowns: [0.05, 0.1] });
  assert.equal(q.breakeven_price_usd, 48_000);
  assert.deepEqual(q.floor_strikes, [57_000, 54_000, 48_000]); // 95%/90% of 60k + breakeven 48k
  assert.equal(q.options.length, 3);
  assert.deepEqual(q.venues_considered, ["okx", "deribit"]);
  assert.equal(q.options.filter((o) => o.recommended).length, 1);
  assert.equal(q.options.find((o) => o.recommended)!.covers_cost, true);
});

test("assembleMinerQuote: drops strikes with no best ask; still reports considered venues", async () => {
  const sourcePut = async (strike: number): Promise<FloorSource> =>
    strike >= 56_000
      ? { best: null, considered: ["deribit"] }                                  // quoted but no winning ask
      : { best: { strike, ask: 800, venue: "okx", spreadPct: 0.01 }, considered: ["okx"] };
  const q = await assembleMinerQuote(miner, { sourcePut, drawdowns: [0.05, 0.1, 0.2] });
  // strikes: 57k (dropped), 54k, 48k → 2 options remain.
  assert.equal(q.options.length, 2);
  assert.ok(q.options.every((o) => o.strike < 56_000));
  assert.deepEqual([...q.venues_considered].sort(), ["deribit", "okx"]);
});
