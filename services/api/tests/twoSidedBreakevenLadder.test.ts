/**
 * Phase 2 — breakeven-DVOL ladder. A long structure's net should improve as DVOL
 * (vol) rises; breakeven_dvol is the interpolated crossing to net>=0.
 * Offline: injected chain cache + GBM paths (dvols >= 40 avoid the calm bootstrap's
 * load5MinBars network call).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeBreakevenLadder } from "../src/singleSide/twoSided/breakevenLadder";
import type { LiquidChainCache } from "../src/singleSide/twoSided/liquidChainCache";

const chain = {
  getBidForSymbol: () => null,
  getBidForLeg: (o: { strike: number; optType: "put" | "call" }) => ({
    bidUsdcPerBtc: 600, askUsdcPerBtc: 700, midUsdcPerBtc: 650, spreadPct: 0.15,
    venue: "deribit" as const, instrumentName: `BTC-${o.strike}-${o.optType.toUpperCase()}`,
    tenorHours: 24, markIv: 0.4, pulledAtMs: Date.now()
  }),
  getCached: () => null
} as unknown as LiquidChainCache;

test("breakeven ladder: net improves as DVOL rises; ladder shape + cost are sane", async () => {
  const r = await computeBreakevenLadder({
    spot: 73000, notionalUsdcPerLeg: 25000, strikeMoneynessPct: -0.05, tenorDays: 1,
    structure: "strangle", triggerPct: 0.03, autoClosePnlPct: 0.30, autoCloseAbsoluteUsdc: 250,
    dvols: [40, 55, 70, 90], liquidChainCache: chain, nPaths: 300, seed: 7
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.ladder.length, 4, "one rung per DVOL");
  assert.ok(r.cost_per_pair_usdc > 0, "priced from chain");
  // OTM strangle (negative moneyness): put below spot, call above spot.
  assert.ok(r.put_strike < 73000 && r.call_strike > 73000, "OTM strikes straddle spot");
  // A LONG structure benefits from higher vol → net at top DVOL > net at bottom DVOL.
  assert.ok(r.ladder[3].net_usdc > r.ladder[0].net_usdc,
    `net should rise with vol: ${r.ladder[0].net_usdc} (40) -> ${r.ladder[3].net_usdc} (90)`);
  // sigma maps from dvol; rungs sorted ascending.
  assert.equal(r.ladder[0].dvol, 40);
  assert.ok(Math.abs(r.ladder[0].sigma - 0.40) < 1e-9);
  // breakeven (if present) sits within/at the ladder bounds.
  if (r.breakeven_dvol != null) {
    assert.ok(r.breakeven_dvol >= 40 && r.breakeven_dvol <= 90, `breakeven ${r.breakeven_dvol} in range`);
  }
});

test("breakeven ladder: chain_unavailable when no quotes", async () => {
  const empty = { getBidForSymbol: () => null, getBidForLeg: () => null, getCached: () => null } as unknown as LiquidChainCache;
  const r = await computeBreakevenLadder({
    spot: 73000, notionalUsdcPerLeg: 25000, strikeMoneynessPct: -0.05, tenorDays: 1,
    structure: "strangle", triggerPct: 0.03, autoClosePnlPct: 0.30, autoCloseAbsoluteUsdc: 250,
    dvols: [40, 60], liquidChainCache: empty, nPaths: 100
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "chain_unavailable");
});
