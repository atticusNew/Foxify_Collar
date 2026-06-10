/**
 * BTC ETF Protect engine — contract sizing, protective put / collar / put spread, recommendation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  contractSizing, buildProtectivePut, buildCollar, buildPutSpread, buildEtfProtectQuote, pickRecommendedEtf,
  CONTRACT_MULTIPLIER, type EtfPosition
} from "../src/etfProtect/etfProtectQuote";

// 250 IBIT @ $60, cost basis $60. → 2 contracts (200 sh), 50 residual.
const pos: EtfPosition = { symbol: "IBIT", shares: 250, price: 60, entryPrice: 60, tenorDays: 90 };

test("contractSizing: whole 100-share lots + residual", () => {
  assert.deepEqual(contractSizing(250), { contracts: 2, hedgedShares: 200, residualShares: 50 });
  assert.deepEqual(contractSizing(100), { contracts: 1, hedgedShares: 100, residualShares: 0 });
  assert.deepEqual(contractSizing(99), { contracts: 0, hedgedShares: 0, residualShares: 99 });
  assert.equal(CONTRACT_MULTIPLIER, 100);
});

test("protective put: worst case = (entry−K)·hedgedShares + premium (identity pricer)", () => {
  // 90% floor → strike 54. hedged 200 sh. put ask $2/sh → hedge $400.
  const o = buildProtectivePut(pos, { floorPct: 0.9, strike: 54, putAskPerShare: 2 }, 0);
  assert.equal(o.structure, "put");
  assert.equal(o.contracts, 2);
  assert.equal(o.hedged_shares, 200);
  assert.equal(o.residual_shares, 50);
  assert.equal(o.premium_usd, 400);                 // $2 × 200 (identity: no load)
  assert.equal(o.worst_case_usd, 1600);             // (60−54)×200 + 400
  assert.equal(o.capped, true);
  assert.equal(o.protect_floor_price, 54);
  assert.equal(o.label, "90% floor");
});

test("collar: floor + upside cap; net cost = putAsk − callBid; rejects cap ≤ floor", () => {
  const c = buildCollar(pos, { floorPct: 0.9, putStrike: 54, putAskPerShare: 2, callStrike: 66, callBidPerShare: 1.2 });
  assert.ok(c);
  assert.equal(c!.structure, "collar");
  assert.equal(c!.premium_usd, 160);                // (2 − 1.2) × 200
  assert.equal(c!.worst_case_usd, 1360);            // (60−54)×200 + 160
  assert.equal(c!.upside_cap_price, 66);
  assert.equal(c!.label, "90% floor + cap $66");
  // cap must be above floor
  assert.equal(buildCollar(pos, { floorPct: 0.9, putStrike: 54, putAskPerShare: 2, callStrike: 50, callBidPerShare: 1 }), null);
});

test("put spread: band-edge loss + exposed-beyond; short leg must be deeper", () => {
  const s = buildPutSpread(pos, { floorPct: 0.9, longStrike: 54, longAskPerShare: 2, shortStrike: 48, shortBidPerShare: 0.8 });
  assert.ok(s);
  assert.equal(s!.capped, false);
  assert.equal(s!.premium_usd, 240);                // (2 − 0.8) × 200
  assert.equal(s!.worst_case_usd, 1440);            // (60−54)×200 + 240
  assert.equal(s!.exposed_beyond, 48);
  // short leg not deeper → null
  assert.equal(buildPutSpread(pos, { floorPct: 0.9, longStrike: 54, longAskPerShare: 2, shortStrike: 56, shortBidPerShare: 0.8 }), null);
});

test("put strike above entry locks a gain → negative worst case", () => {
  const o = buildProtectivePut(pos, { floorPct: 1.05, strike: 63, putAskPerShare: 1 }, 0);
  assert.equal(o.worst_case_usd, -400); // (60−63)×200 + 200
});

test("recommendation: cheapest capped option within the worst-case bound; never a spread", () => {
  const q = buildEtfProtectQuote(pos, {
    puts: [
      { floorPct: 0.95, strike: 57, putAskPerShare: 3 },  // worst (60-57)*200+600=1200 (10% of 12000)
      { floorPct: 0.90, strike: 54, putAskPerShare: 2 },  // worst 1600 (13.3%)
      { floorPct: 0.80, strike: 48, putAskPerShare: 0.8 } // worst (60-48)*200+160=2560 (21.3% > 15% bound)
    ],
    putSpread: { floorPct: 0.9, longStrike: 54, longAskPerShare: 2, shortStrike: 48, shortBidPerShare: 0.8 }
  });
  const rec = q.options.find((o) => o.recommended);
  assert.ok(rec);
  assert.equal(rec!.capped, true);          // never the spread
  // acceptable (≤15% of $12,000 = $1,800): 95% (1200) and 90% (1600); cheapest premium = 90% ($400 vs $600)
  assert.equal(rec!.floor_pct, 0.9);
  assert.equal(q.position.hedged_value_usd, 12000);
  assert.equal(q.options.filter((o) => o.recommended).length, 1);
});

test("buildEtfProtectQuote: assembles, defaults american settlement, surfaces residual", () => {
  const q = buildEtfProtectQuote(pos, { puts: [{ floorPct: 0.9, strike: 54, putAskPerShare: 2 }] });
  assert.equal(q.settlement_style, "american");
  assert.equal(q.position.residual_shares, 50);
  assert.equal(q.position.contracts, 2);
  assert.equal(q.tenor_days, 90);
});

test("pickRecommendedEtf falls back to lowest worst case when none meet the bound", () => {
  const q = buildEtfProtectQuote(pos, {
    puts: [{ floorPct: 0.80, strike: 48, putAskPerShare: 0.8 }, { floorPct: 0.75, strike: 45, putAskPerShare: 0.4 }]
  });
  // tight bound 1% → none qualify → cheapest premium = 75% floor ($80)
  const rec = pickRecommendedEtf(q.options, q.position.hedged_value_usd, 0.01);
  assert.equal(q.options.find((o) => o.id === rec)?.floor_pct, 0.75);
});
