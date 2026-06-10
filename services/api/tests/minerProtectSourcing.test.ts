/**
 * Miner Protect — floor strike ladder + quote assembly (injected sourcing, offline).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { floorStrikeLadder, assembleMinerQuote, type SourcedPut } from "../src/minerProtect/minerProtectSourcing";
import type { MinerInputs } from "../src/minerProtect/minerProtectQuote";

// breakeven $48,000 (see minerProtectQuote tests): 100k TH/s @ 30 W/TH, $0.05/kWh, 7.5e-7 BTC/TH/day.
const miner: MinerInputs = {
  hashrateThs: 100_000, efficiencyWPerTh: 30, powerCostUsdPerKwh: 0.05,
  btcPerThPerDay: 0.00000075, btcPrice: 60_000, tenorDays: 30
};

test("floorStrikeLadder: cushions around breakeven, de-duped", () => {
  const strikes = floorStrikeLadder(48_000, [-0.05, 0, 0.05, 0.1]);
  assert.deepEqual(strikes, [45_600, 48_000, 50_400, 52_800]);
  assert.deepEqual(floorStrikeLadder(0), []);
});

test("assembleMinerQuote: sources each floor (injected) → breakeven + recommendation", async () => {
  // Mock sourcing: per-BTC ask scales with how close the strike is to spot (deeper = cheaper).
  const sourcePut = async (strike: number): Promise<SourcedPut> => ({
    strike, ask: Math.max(50, (strike - 40_000) / 10), venue: "deribit", spreadPct: 0.02
  });
  const q = await assembleMinerQuote(miner, { sourcePut, cushions: [0, 0.05, 0.1] });
  assert.equal(q.breakeven_price_usd, 48_000);
  assert.deepEqual(q.floor_strikes, [48_000, 50_400, 52_800]);
  assert.equal(q.options.length, 3);
  // exactly one recommended; it must be a cost-covering floor (strike above breakeven)
  const rec = q.options.find((o) => o.recommended);
  assert.ok(rec);
  assert.equal(q.options.filter((o) => o.recommended).length, 1);
  assert.equal(rec!.covers_cost, true);
});

test("assembleMinerQuote: drops venues that return no ask", async () => {
  const sourcePut = async (strike: number): Promise<SourcedPut | null> =>
    strike >= 48_000 ? { strike, ask: 800, venue: "okx", spreadPct: 0.01 } : null;
  const q = await assembleMinerQuote(miner, { sourcePut, cushions: [-0.05, 0, 0.05] });
  // −5% (45,600) sourced null → dropped; 48,000 and 50,400 remain.
  assert.equal(q.options.length, 2);
  assert.ok(q.options.every((o) => o.strike >= 48_000));
});
