import assert from "node:assert/strict";
import test from "node:test";
import { DeribitExecutionClient, mapDeribitState, type DeribitFetcher } from "../src/singleSide/twoSided/creditCollar/execution/deribitExecutionClient";
import {
  parseDeribitOptionName,
  selectDeribitCollar,
  rankDeribitCollarCandidates,
  resolveDeribitCollarLegs
} from "../src/singleSide/twoSided/creditCollar/execution/deribitLegResolver";
import { executeCollarHedge, type CollarHedgeSpec } from "../src/singleSide/twoSided/creditCollar/execution/okxCollarExecutor";

const now = Date.UTC(2026, 5, 19, 0, 0, 0);

test("restBase follows mode and ignores shared DERIBIT_REST_BASE (production pricing-harness var)", () => {
  const prev = process.env.DERIBIT_REST_BASE;
  const prevExec = process.env.DERIBIT_EXEC_REST_BASE;
  process.env.DERIBIT_REST_BASE = "https://www.deribit.com/api/v2"; // production, set by harness
  delete process.env.DERIBIT_EXEC_REST_BASE;
  try {
    const testnet = new DeribitExecutionClient({ clientId: "id", clientSecret: "sec", mode: "testnet" });
    const live = new DeribitExecutionClient({ clientId: "id", clientSecret: "sec", mode: "live" });
    assert.equal(testnet.restBase, "https://test.deribit.com/api/v2"); // NOT redirected to production
    assert.equal(live.restBase, "https://www.deribit.com/api/v2");
    // Dedicated override is still honored.
    process.env.DERIBIT_EXEC_REST_BASE = "https://mirror.example/api/v2";
    assert.equal(new DeribitExecutionClient({ clientId: "id", clientSecret: "sec", mode: "testnet" }).restBase, "https://mirror.example/api/v2");
  } finally {
    if (prev === undefined) delete process.env.DERIBIT_REST_BASE; else process.env.DERIBIT_REST_BASE = prev;
    if (prevExec === undefined) delete process.env.DERIBIT_EXEC_REST_BASE; else process.env.DERIBIT_EXEC_REST_BASE = prevExec;
  }
});

test("parseDeribitOptionName handles BTC-DDMMMYY-STRIKE-C/P", () => {
  assert.deepEqual(parseDeribitOptionName("BTC-21JUN26-61000-C"), { strike: 61000, optType: "call", expiryMs: Date.UTC(2026, 5, 21, 8, 0, 0) });
  assert.deepEqual(parseDeribitOptionName("BTC-3JUL26-50000-P"), { strike: 50000, optType: "put", expiryMs: Date.UTC(2026, 6, 3, 8, 0, 0) });
  assert.equal(parseDeribitOptionName("ETH-21JUN26-3000-C"), null);
  assert.equal(parseDeribitOptionName("BTC-PERPETUAL"), null);
});

const names = ["BTC-20JUN26-60000-P", "BTC-20JUN26-61000-P", "BTC-20JUN26-66000-C", "BTC-20JUN26-67000-C", "BTC-26JUN26-61000-P", "BTC-26JUN26-66000-C", "BTC-PERPETUAL"];

test("selectDeribitCollar: nearest expiry + nearest strikes", () => {
  const sel = selectDeribitCollar(names, { nowMs: now, tenorDays: 1, putTarget: 60800, callTarget: 66400 });
  assert.ok(sel);
  assert.equal(sel!.putInstrument, "BTC-20JUN26-61000-P");
  assert.equal(sel!.callInstrument, "BTC-20JUN26-66000-C");
});

test("selectDeribitCollar: longer tenor picks far expiry; null when empty", () => {
  const sel = selectDeribitCollar(names, { nowMs: now, tenorDays: 7, putTarget: 61000, callTarget: 66000 });
  assert.equal(sel!.putInstrument, "BTC-26JUN26-61000-P");
  assert.equal(selectDeribitCollar(["BTC-PERPETUAL"], { nowMs: now, tenorDays: 1, putTarget: 1, callTarget: 1 }), null);
});

test("resolveDeribitCollarLegs: reads instrument list + best bid/ask", async () => {
  const list = async () => ({ ok: true, result: names.map((instrument_name) => ({ instrument_name, is_active: true })) });
  const readBook = async (n: string) => ({ ok: true, result: { best_bid_price: 0.0009, best_ask_price: 0.0011 } });
  const r = await resolveDeribitCollarLegs(list, readBook, { nowMs: now, tenorDays: 1, putTarget: 61000, callTarget: 66000 });
  assert.ok(r.ok && r.legs);
  assert.equal(r.legs!.putAskBtc, 0.0011);
  assert.equal(r.legs!.callBidBtc, 0.0009);
});

test("rankDeribitCollarCandidates: ranks both wings by closeness", () => {
  const c = rankDeribitCollarCandidates(names, { nowMs: now, tenorDays: 1, putTarget: 60800, callTarget: 66400 });
  assert.ok(c);
  assert.equal(c!.puts[0].strike, 61000); // 61000 closest to 60800, then 60000
  assert.equal(c!.puts[1].strike, 60000);
  assert.equal(c!.calls[0].strike, 66000); // 66000 closest to 66400, then 67000
  assert.equal(c!.calls[1].strike, 67000);
});

test("resolveDeribitCollarLegs: liquidity-aware — walks past a zero-bid call to the nearest that quotes", async () => {
  const list = async () => ({ ok: true, result: names.map((instrument_name) => ({ instrument_name, is_active: true })) });
  // Nearest call (66000) has NO bid; the next (67000) does. Put nearest (61000) quotes fine.
  const readBook = async (n: string) => {
    if (n === "BTC-20JUN26-66000-C") return { ok: true, result: { best_bid_price: 0, best_ask_price: 0.002 } };
    if (n === "BTC-20JUN26-67000-C") return { ok: true, result: { best_bid_price: 0.0005, best_ask_price: 0.0008 } };
    return { ok: true, result: { best_bid_price: 0.0009, best_ask_price: 0.0011 } };
  };
  const r = await resolveDeribitCollarLegs(list, readBook, { nowMs: now, tenorDays: 1, putTarget: 61000, callTarget: 66000 });
  assert.ok(r.ok && r.legs);
  assert.equal(r.legs!.callInstrument, "BTC-20JUN26-67000-C"); // walked to the strike with a real bid
  assert.equal(r.legs!.callBidBtc, 0.0005);
  assert.equal(r.legs!.putInstrument, "BTC-20JUN26-61000-P");
  assert.equal(r.legs!.putAskBtc, 0.0011);
});

test("resolveDeribitCollarLegs: empty list surfaces no_matching_instruments", async () => {
  const r = await resolveDeribitCollarLegs(async () => ({ ok: true, result: [] }), async () => ({ ok: true, result: null }), { nowMs: now, tenorDays: 1, putTarget: 1, callTarget: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_matching_instruments");
});

test("mapDeribitState maps to executor states", () => {
  assert.equal(mapDeribitState("filled"), "filled");
  assert.equal(mapDeribitState("cancelled"), "canceled");
  assert.equal(mapDeribitState("rejected"), "canceled");
  assert.equal(mapDeribitState("open"), "open");
});

// End-to-end: Deribit client adapter drives the shared executeCollarHedge (both legs fill).
test("DeribitExecutionClient.asExecClient: both legs fill via shared executor", async () => {
  const fetcher: DeribitFetcher = async (url) => {
    const j = (() => {
      if (url.includes("/public/auth")) return { result: { access_token: "tok", expires_in: 900 } };
      if (url.includes("/private/buy")) return { result: { order: { order_id: "P1", order_state: "open" } } };
      if (url.includes("/private/sell")) return { result: { order: { order_id: "C1", order_state: "open" } } };
      if (url.includes("/private/get_order_state")) {
        const id = new URL(url).searchParams.get("order_id");
        return { result: { order_id: id, order_state: "filled", average_price: id === "P1" ? 0.0011 : 0.0009, filled_amount: 0.1 } };
      }
      if (url.includes("/private/get_positions")) return { result: [{ instrument_name: "BTC-20JUN26-66000-C", size: -0.1, initial_margin: 0.02 }] };
      if (url.includes("/private/get_account_summary")) return { result: { equity: 10 } };
      return { result: null };
    })();
    return { status: 200, json: async () => j };
  };
  const client = new DeribitExecutionClient({ clientId: "id", clientSecret: "sec", mode: "testnet" }, fetcher);
  const auth = await client.authCheck();
  assert.equal(auth.ok, true);

  const spec: CollarHedgeSpec = {
    putInstId: "BTC-20JUN26-61000-P",
    callInstId: "BTC-20JUN26-66000-C",
    sizeContracts: "0.1",
    putLimitPx: "0.0015",
    callLimitPx: "0.0005",
    modeledPutAskUsd: 0.001,
    modeledCallBidUsd: 0.001
  };
  const report = await executeCollarHedge(client.asExecClient(), spec, { pollTries: 1, pollDelayMs: 0, sleep: async () => {} });
  assert.equal(report.outcome, "both_filled");
  assert.equal(report.safe, true);
  assert.equal(report.shortLegMarginUsd, 0.02); // initial_margin read from positions (BTC)
  // bought put at 0.0011 vs modeled 0.001 ⟹ +0.0001 slippage
  assert.equal(report.putSlippageUsd, 0.0001);
});
