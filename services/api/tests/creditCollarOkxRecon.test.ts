import assert from "node:assert/strict";
import test from "node:test";
import {
  hedgePayoffUsd,
  reconcileLiveSettlement,
  isSettlementBill,
  fetchOkxSettlementData
} from "../src/singleSide/twoSided/creditCollar/execution/okxSettlementRecon";
import type { SettlementOutcome } from "../src/singleSide/twoSided/creditCollar/forwardSettlement";

// A settled okx_live long-side collar: put 94k / call 102k, 0.5 BTC (50 × 0.01).
const settled = (over: Partial<SettlementOutcome> = {}): SettlementOutcome =>
  ({
    ref: "cc-live-1-long",
    side: "long",
    notionalUsdc: 50_000,
    spotAtEntry: 100_000,
    settlePriceUsd: 93_000,
    movePct: -0.07,
    putIntrinsicUsd: 500,
    callIntrinsicUsd: 0,
    payoutToFoxifyUsdc: 500,
    foxifyCreditUsdc: 70,
    netToFoxifyUsdc: 570,
    serviceFeeUsdc: 0,
    floorBreached: true,
    capBreached: false,
    oracleVerified: true,
    openedAtMs: 0,
    settledAtMs: 86_400_000,
    heldMs: 86_400_000,
    hedgeReceiptUsdc: 500,
    atticusOptionNetUsdc: 0,
    shortLegMarginUsdc: 0,
    capitalCostUsdc: 0,
    optionFeesUsdc: 3,
    atticusNetAfterCapitalUsdc: 0,
    atticusNetAfterFeesAndCapitalUsdc: 0,
    venue: "okx_live",
    liveMeta: {
      putInstId: "BTC-USD-260720-94000-P",
      callInstId: "BTC-USD-260720-102000-C",
      contracts: 50,
      ctValBtc: 0.01,
      mode: "live",
      protectiveFillPxBtc: 0.0013,
      fundingFillPxBtc: 0.0028,
      venueFeeUsdc: 3
    },
    ...over
  }) as SettlementOutcome;

test("hedgePayoffUsd: long = put − call intrinsics × contracts; short mirrors", () => {
  assert.equal(hedgePayoffUsd("long", 94_000, 102_000, 0.5, 93_000), 500);   // put ITM by 1000 × 0.5
  assert.equal(hedgePayoffUsd("long", 94_000, 102_000, 0.5, 104_000), -1000); // call ITM by 2000 × 0.5
  assert.equal(hedgePayoffUsd("short", 98_000, 106_000, 0.5, 108_000), 1000); // short side: call − put
});

test("recon: venue cash matches expected payoff at OKX's own delivery price ⟹ matched (basis informational)", () => {
  // OKX fixes at 93,050 (50 USD basis vs our 93,000). Expected hedge cash = (94k−93.05k)×0.5 = $475
  // = 475/93050 BTC ≈ 0.005105 on the put; call expires OTM.
  const okx = {
    deliveryPxByInstId: { "BTC-USD-260720-94000-P": 93_050, "BTC-USD-260720-102000-C": 93_050 },
    cashFlowBtcByInstId: { "BTC-USD-260720-94000-P": 475 / 93_050, "BTC-USD-260720-102000-C": 0 }
  };
  const rec = reconcileLiveSettlement(settled(), okx, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "matched");
  assert.equal(rec.okxDeliveryPriceUsd, 93_050);
  assert.equal(rec.priceDiffUsd, -50); // our oracle vs venue fixing — the measured basis
  assert.ok(Math.abs(rec.cashDiffUsdc ?? 99) <= 0.01);
});

test("recon: venue cash off by more than tolerance ⟹ mismatch", () => {
  const okx = {
    deliveryPxByInstId: { "BTC-USD-260720-94000-P": 93_050 },
    cashFlowBtcByInstId: { "BTC-USD-260720-94000-P": 400 / 93_050, "BTC-USD-260720-102000-C": 0 } // $75 short
  };
  const rec = reconcileLiveSettlement(settled(), okx, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "mismatch");
  assert.ok((rec.cashDiffUsdc ?? 0) < -5);
});

test("recon: no delivery price yet ⟹ pending_venue_data (retry later, no halt)", () => {
  const rec = reconcileLiveSettlement(settled(), { deliveryPxByInstId: {}, cashFlowBtcByInstId: {} }, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "pending_venue_data");
});

test("recon: both legs expired OTM with NO bills ⟹ legitimate $0, matched", () => {
  // Settle inside the collar: put OTM, call OTM ⟹ expected 0 and no bills is fine.
  const s = settled({ settlePriceUsd: 100_500, payoutToFoxifyUsdc: 0, floorBreached: false });
  const okx = { deliveryPxByInstId: { "BTC-USD-260720-94000-P": 100_480 }, cashFlowBtcByInstId: {} };
  const rec = reconcileLiveSettlement(s, okx, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "matched");
  assert.equal(rec.okxCashFlowUsdc, 0);
});

test("recon: expected non-zero payoff but bills missing ⟹ pending (bills lag), not mismatch", () => {
  const okx = { deliveryPxByInstId: { "BTC-USD-260720-94000-P": 93_050 }, cashFlowBtcByInstId: {} };
  const rec = reconcileLiveSettlement(settled(), okx, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "pending_venue_data");
});

test("recon: missing liveMeta ⟹ mismatch (cannot verify a live position without fill data)", () => {
  const rec = reconcileLiveSettlement(settled({ liveMeta: undefined }), { deliveryPxByInstId: {}, cashFlowBtcByInstId: {} }, { toleranceUsdc: 5, nowMs: 1 });
  assert.equal(rec.status, "mismatch");
});

test("isSettlementBill: delivery/exercise family only", () => {
  assert.ok(isSettlementBill({ type: "3" }));
  assert.ok(isSettlementBill({ subType: "170" }));
  assert.ok(isSettlementBill({ subType: "172" }));
  assert.ok(!isSettlementBill({ type: "2" }));           // trade
  assert.ok(!isSettlementBill({ type: "8", subType: "173" })); // funding fee
});

test("fetchOkxSettlementData: shapes delivery px + summed settlement bills for wanted instIds", async () => {
  const fetchers = {
    getDeliveryExerciseHistory: async () => ({
      ok: true,
      data: [{ ts: "1", details: [{ insId: "BTC-USD-260720-94000-P", px: "93050", type: "exercised" }, { insId: "OTHER", px: "1", type: "exercised" }] }]
    }),
    getBills: async () => ({
      ok: true,
      data: [
        { instId: "BTC-USD-260720-94000-P", type: "3", subType: "170", balChg: "0.003", ts: "1" },
        { instId: "BTC-USD-260720-94000-P", type: "3", subType: "170", balChg: "0.002", ts: "1" },
        { instId: "BTC-USD-260720-94000-P", type: "2", balChg: "9.9", ts: "1" }, // trade bill — ignored
        { instId: "OTHER", type: "3", balChg: "1", ts: "1" }                       // not wanted — ignored
      ]
    })
  };
  const data = await fetchOkxSettlementData(fetchers, ["BTC-USD-260720-94000-P", "BTC-USD-260720-102000-C"]);
  assert.equal(data.deliveryPxByInstId["BTC-USD-260720-94000-P"], 93_050);
  assert.equal(data.deliveryPxByInstId["OTHER"], undefined);
  assert.ok(Math.abs((data.cashFlowBtcByInstId["BTC-USD-260720-94000-P"] ?? 0) - 0.005) < 1e-12);
  assert.equal(data.cashFlowBtcByInstId["BTC-USD-260720-102000-C"], undefined);
});
