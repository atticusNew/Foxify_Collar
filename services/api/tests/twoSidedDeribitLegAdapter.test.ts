/**
 * DeribitLegAdapter pre-live audit tests.
 *
 * Focus: the amount-snapping fix (Deribit BTC options require amounts that are a multiple
 * of min_trade_amount = 0.1 BTC — verified live via public/get_instrument). Without snapping,
 * a full-precision size like 0.35211 BTC (= notional/spot) is rejected with -32602 "must be a
 * multiple of the minimum order size". Also covers USDC↔BTC price conversion + spot guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DeribitLegAdapter, type DeribitClientLike } from "../src/singleSide/twoSided/liveVenueAdapters";

type Captured = { order?: { instrument: string; amount: number; side: string; type?: string; price?: number; timeInForce?: string } };

const makeClient = (cap: Captured): DeribitClientLike => ({
  placeOrder: async (req) => {
    cap.order = req as Captured["order"];
    // Echo a filled live response: average_price in BTC = the limit; filled_amount = amount.
    return { result: { order: { order_state: "filled", average_price: req.price, filled_amount: req.amount } } };
  }
});

const adapter = (cap: Captured, spot: number | null) =>
  new DeribitLegAdapter(makeClient(cap), { getCurrentSpotUsd: () => spot });

test("buyLeg: snaps full-precision 0.35211 → 0.3 BTC (floors to 0.1 step, never exceeds quoted size) and converts USDC→BTC price", async () => {
  const cap: Captured = {};
  const r = await adapter(cap, 73_000).buyLeg({ instrument: "BTC-3JUN26-70000-P", contractsBtc: 0.35211, maxAcceptableAskUsdcPerBtc: 1_150, clientOrderId: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cap.order?.amount, 0.3, "amount floored to a valid 0.1 multiple");
  assert.equal(cap.order?.side, "buy");
  assert.equal(cap.order?.timeInForce, "immediate_or_cancel");
  // price: 1150/73000 = 0.01575 BTC → >= 0.005 so Deribit tick is 0.0005 → snap UP = 0.016
  assert.equal(cap.order?.price, 0.016);
  if (r.ok) assert.ok(Math.abs(r.filledAskUsdcPerBtc - 0.016 * 73_000) < 0.01, "fill converted BTC→USDC");
});

test("buyLeg: ATM option price (>= 0.005 BTC) snaps to the 0.0005 tick (fixes 'must conform to tick size')", async () => {
  const cap: Captured = {};
  // 930 USDC/BTC / 67000 = 0.013881 BTC → >= 0.005 → 0.0005 tick → ceil = 0.014 (a 0.0005 multiple).
  const r = await adapter(cap, 67_000).buyLeg({ instrument: "BTC-4JUN26-67500-P", contractsBtc: 0.3, maxAcceptableAskUsdcPerBtc: 930, clientOrderId: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cap.order?.price, 0.014);
  assert.equal(Math.round((cap.order?.price ?? 0) / 0.0005), 28, "price is a multiple of the 0.0005 tick");
});

test("buyLeg: cheap OTM option price (< 0.005 BTC) keeps the finer 0.0001 tick", async () => {
  const cap: Captured = {};
  // 40 USDC/BTC / 71000 = 0.000563 BTC → < 0.005 → 0.0001 tick → ceil = 0.0006 (the Jun-1 case that worked).
  const r = await adapter(cap, 71_000).buyLeg({ instrument: "BTC-3JUN26-68000-P", contractsBtc: 0.3, maxAcceptableAskUsdcPerBtc: 40, clientOrderId: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cap.order?.price, 0.0006);
});

test("buyLeg: a valid 0.1-multiple (0.3) passes through unchanged", async () => {
  const cap: Captured = {};
  const r = await adapter(cap, 73_000).buyLeg({ instrument: "i", contractsBtc: 0.3, maxAcceptableAskUsdcPerBtc: 1_000, clientOrderId: "x" });
  assert.equal(r.ok, true);
  assert.equal(cap.order?.amount, 0.3);
});

test("buyLeg: amount below venue min (0.04 → 0) is REJECTED before any order is placed", async () => {
  const cap: Captured = {};
  const r = await adapter(cap, 73_000).buyLeg({ instrument: "i", contractsBtc: 0.04, maxAcceptableAskUsdcPerBtc: 1_000, clientOrderId: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail ?? "", /below venue min/);
  assert.equal(cap.order, undefined, "no order placed for sub-min size");
});

test("sellLeg: floors amount to 0.1 step (0.35211 → 0.3) so close matches the held size", async () => {
  const cap: Captured = {};
  const r = await adapter(cap, 73_000).sellLeg({ instrument: "i", contractsBtc: 0.35211, minAcceptableBidUsdcPerBtc: 500, clientOrderId: "x" });
  assert.equal(r.ok, true);
  assert.equal(cap.order?.amount, 0.3);
  assert.equal(cap.order?.side, "sell");
});

test("buyLeg: spot unavailable → venue_error (no order placed)", async () => {
  const cap: Captured = {};
  const r = await adapter(cap, null).buyLeg({ instrument: "i", contractsBtc: 0.3, maxAcceptableAskUsdcPerBtc: 1_000, clientOrderId: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.detail ?? "", /spot unavailable/);
  assert.equal(cap.order, undefined);
});
