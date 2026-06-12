/**
 * Hedge executor — sim fills + Deribit executor against a mock leg client (call shapes + P&L).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SimHedgeExecutor, DeribitHedgeExecutor, type HedgePlan } from "../src/singleSide/twoSided/protection/hedgeExecutor";
import type { DeribitLegClient } from "../src/singleSide/twoSided/liveStrangleExecutor";

const plan: HedgePlan = {
  side: "long", contractsBtc: 0.1,
  inner: { instrument: "BTC-13JUN26-98000-P", strike: 98000, askUsdcPerBtc: 1200, bidUsdcPerBtc: 1100 },
  outer: { instrument: "BTC-13JUN26-96000-P", strike: 96000, askUsdcPerBtc: 760, bidUsdcPerBtc: 700 }
};

test("SimHedgeExecutor: debit = (innerAsk − outerBid)×contracts; payout = width×contracts", async () => {
  const r = await new SimHedgeExecutor().openHedge(plan);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.debit_usdc, +((1200 - 700) * 0.1).toFixed(2)); // 50
  assert.equal(r.spread_width_usd, 2000);
  assert.equal(r.effective_payout_usdc, 200); // 2000 × 0.1
  assert.equal(r.legs[0].action, "buy");
  assert.equal(r.legs[1].action, "sell");
});

test("DeribitHedgeExecutor.openHedge: buys inner, sells outer; debit from fills", async () => {
  const calls: string[] = [];
  const mock: DeribitLegClient = {
    buyLeg: async (req) => { calls.push(`buy ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 1190, filledContractsBtc: 0.1, filledOrderId: "o-buy", filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`sell ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 710, filledContractsBtc: 0.1, filledOrderId: "o-sell", filledAtIso: "" }; }
  };
  const r = await new DeribitHedgeExecutor(mock).openHedge(plan);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(calls, ["buy BTC-13JUN26-98000-P", "sell BTC-13JUN26-96000-P"]);
  assert.equal(r.debit_usdc, +((1190 - 710) * 0.1).toFixed(2)); // 48
  assert.equal(r.mode, "live");
});

test("DeribitHedgeExecutor.openHedge: unwinds inner if outer sell fails", async () => {
  const calls: string[] = [];
  const mock: DeribitLegClient = {
    buyLeg: async (req) => { calls.push(`buy ${req.instrument} ${req.clientOrderId}`); return { ok: true, filledAskUsdcPerBtc: 1190, filledContractsBtc: 0.1, filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`sell ${req.instrument} ${req.clientOrderId}`); return req.clientOrderId.endsWith("-so") ? { ok: false, reason: "venue_error", detail: "no fill" } : { ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }; }
  };
  const r = await new DeribitHedgeExecutor(mock).openHedge(plan);
  assert.equal(r.ok, false);
  // should have attempted: buy inner, sell outer (fail), then sell inner (unwind)
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("unwind"));
});

test("DeribitHedgeExecutor.closeHedge: sells inner, buys outer back", async () => {
  const calls: string[] = [];
  const mock: DeribitLegClient = {
    buyLeg: async (req) => { calls.push(`buy ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 720, filledContractsBtc: 0.1, filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`sell ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 2000, filledContractsBtc: 0.1, filledAtIso: "" }; }
  };
  const opened = [
    { role: "inner" as const, action: "buy" as const, instrument: "BTC-13JUN26-98000-P", strike: 98000, contractsBtc: 0.1, fillUsdcPerBtc: 1190 },
    { role: "outer" as const, action: "sell" as const, instrument: "BTC-13JUN26-96000-P", strike: 96000, contractsBtc: 0.1, fillUsdcPerBtc: 710 }
  ];
  const r = await new DeribitHedgeExecutor(mock).closeHedge(opened);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // proceeds = innerSell(2000)×0.1 − outerBuy(720)×0.1 = 200 − 72 = 128
  assert.equal(r.proceeds_usdc, 128);
  assert.deepEqual(calls, ["sell BTC-13JUN26-98000-P", "buy BTC-13JUN26-96000-P"]);
});
