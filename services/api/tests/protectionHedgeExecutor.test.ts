/**
 * Hedge executor — sim fills + multi-venue executor against mock leg clients (routing + P&L).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SimHedgeExecutor, MultiVenueHedgeExecutor, type HedgePlan } from "../src/singleSide/twoSided/protection/hedgeExecutor";
import type { DeribitLegClient, BullishLegClient } from "../src/singleSide/twoSided/liveStrangleExecutor";
import type { HedgeFill } from "../src/singleSide/twoSided/protection/protectionLifecycle";

const plan: HedgePlan = {
  side: "long", contractsBtc: 0.1,
  inner: { venue: "deribit", instrument: "BTC-13JUN26-98000-P", strike: 98000, askUsdcPerBtc: 1200, bidUsdcPerBtc: 1100 },
  outer: { venue: "bullish", instrument: "BTC-13JUN26-96000-P", strike: 96000, askUsdcPerBtc: 760, bidUsdcPerBtc: 700 }
};

test("SimHedgeExecutor: debit = (innerAsk − outerBid)×contracts; payout = width×contracts", async () => {
  const r = await new SimHedgeExecutor().openHedge(plan);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.debit_usdc, +((1200 - 700) * 0.1).toFixed(2)); // 50
  assert.equal(r.spread_width_usd, 2000);
  assert.equal(r.effective_payout_usdc, 200);
  assert.deepEqual(r.venues.sort(), ["bullish", "deribit"]);
});

test("MultiVenueHedgeExecutor: routes inner→deribit (buy), outer→bullish (sell)", async () => {
  const calls: string[] = [];
  const deribit: DeribitLegClient = {
    buyLeg: async (req) => { calls.push(`deribit.buy ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 1190, filledContractsBtc: 0.1, filledOrderId: "d-buy", filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`deribit.sell ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }; }
  };
  const bullish: BullishLegClient = {
    buyLeg: async (req) => { calls.push(`bullish.buy ${req.symbol}`); return { ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`bullish.sell ${req.symbol}`); return { ok: true, filledAskUsdcPerBtc: 710, filledContractsBtc: 0.1, filledOrderId: "b-sell", filledAtIso: "" }; }
  };
  const r = await new MultiVenueHedgeExecutor({ deribit, bullish }).openHedge(plan);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(calls, ["deribit.buy BTC-13JUN26-98000-P", "bullish.sell BTC-13JUN26-96000-P"]);
  assert.equal(r.debit_usdc, +((1190 - 710) * 0.1).toFixed(2)); // 48
});

test("MultiVenueHedgeExecutor: unwinds inner if outer sell fails", async () => {
  const calls: string[] = [];
  const deribit: DeribitLegClient = {
    buyLeg: async (req) => { calls.push(`deribit.buy ${req.clientOrderId}`); return { ok: true, filledAskUsdcPerBtc: 1190, filledContractsBtc: 0.1, filledAtIso: "" }; },
    sellLeg: async (req) => { calls.push(`deribit.sell ${req.clientOrderId}`); return { ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }; }
  };
  const bullish: BullishLegClient = {
    buyLeg: async () => ({ ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }),
    sellLeg: async () => ({ ok: false, reason: "venue_error", detail: "no fill" })
  };
  const r = await new MultiVenueHedgeExecutor({ deribit, bullish }).openHedge(plan);
  assert.equal(r.ok, false);
  // deribit.buy (inner), bullish.sell fails (not logged here), then deribit.sell (inner unwind)
  assert.ok(calls.some((c) => c.includes("unwind")));
});

test("MultiVenueHedgeExecutor.closeHedge: reverses each leg on its own venue", async () => {
  const calls: string[] = [];
  const deribit: DeribitLegClient = {
    buyLeg: async () => ({ ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" }),
    sellLeg: async (req) => { calls.push(`deribit.sell ${req.instrument}`); return { ok: true, filledAskUsdcPerBtc: 2000, filledContractsBtc: 0.1, filledAtIso: "" }; }
  };
  const bullish: BullishLegClient = {
    buyLeg: async (req) => { calls.push(`bullish.buy ${req.symbol}`); return { ok: true, filledAskUsdcPerBtc: 720, filledContractsBtc: 0.1, filledAtIso: "" }; },
    sellLeg: async () => ({ ok: true, filledAskUsdcPerBtc: 0, filledContractsBtc: 0.1, filledAtIso: "" })
  };
  const opened: HedgeFill[] = [
    { role: "inner", action: "buy", venue: "deribit", instrument: "BTC-13JUN26-98000-P", strike: 98000, contractsBtc: 0.1, fillUsdcPerBtc: 1190 },
    { role: "outer", action: "sell", venue: "bullish", instrument: "BTC-13JUN26-96000-P", strike: 96000, contractsBtc: 0.1, fillUsdcPerBtc: 710 }
  ];
  const r = await new MultiVenueHedgeExecutor({ deribit, bullish }).closeHedge(opened);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.proceeds_usdc, +(2000 * 0.1 - 720 * 0.1).toFixed(2)); // 128
  assert.deepEqual(calls.sort(), ["bullish.buy BTC-13JUN26-96000-P", "deribit.sell BTC-13JUN26-98000-P"]);
});
