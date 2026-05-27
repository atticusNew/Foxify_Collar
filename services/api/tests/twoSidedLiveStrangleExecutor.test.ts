/**
 * PR A4 tests — LiveStrangleExecutor with mocked Bullish + Deribit clients.
 *
 * Covers OD-2 partial-fill recovery:
 *   - Both legs ok → 201
 *   - Put fails, call fills → call leg reversed, return 503 put_failed
 *   - Call fails, put fills → put leg reversed, return 503 call_failed
 *   - Both fail → 503 both_failed (no reverse needed)
 *   - Reverse itself fails → recorded in detail
 *   - Adapter throws → wrapped as venue_error
 *   - Concurrent execution: both legs run via Promise.all
 *   - clientOrderId per leg is unique
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiveStrangleExecutor, type BullishLegClient, type DeribitLegClient } from "../src/singleSide/twoSided/liveStrangleExecutor";
import type { LegExecutionResult, StrangleOrder } from "../src/singleSide/twoSided/executor";

// ─── Mock client builders ───

type LegCall = { method: "buyLeg" | "sellLeg"; req: { symbol?: string; instrument?: string; clientOrderId: string; contractsBtc: number; maxAcceptableAskUsdcPerBtc?: number; minAcceptableBidUsdcPerBtc?: number } };

const makeBullish = (
  behavior: {
    buyResult?: LegExecutionResult;
    sellResult?: LegExecutionResult;
    buyThrows?: Error;
  } = {},
  calls?: LegCall[]
): BullishLegClient => ({
  buyLeg: async (req) => {
    if (calls) calls.push({ method: "buyLeg", req });
    if (behavior.buyThrows) throw behavior.buyThrows;
    return behavior.buyResult ?? { ok: true, filledAskUsdcPerBtc: 1_150, filledAtIso: new Date().toISOString() };
  },
  sellLeg: async (req) => {
    if (calls) calls.push({ method: "sellLeg", req });
    return behavior.sellResult ?? { ok: true, filledAskUsdcPerBtc: 1_140, filledAtIso: new Date().toISOString() };
  }
});

const makeDeribit = (
  behavior: {
    buyResult?: LegExecutionResult;
    sellResult?: LegExecutionResult;
    buyThrows?: Error;
  } = {},
  calls?: LegCall[]
): DeribitLegClient => ({
  buyLeg: async (req) => {
    if (calls) calls.push({ method: "buyLeg", req });
    if (behavior.buyThrows) throw behavior.buyThrows;
    return behavior.buyResult ?? { ok: true, filledAskUsdcPerBtc: 1_162.86, filledAtIso: new Date().toISOString() };
  },
  sellLeg: async (req) => {
    if (calls) calls.push({ method: "sellLeg", req });
    return behavior.sellResult ?? { ok: true, filledAskUsdcPerBtc: 1_150, filledAtIso: new Date().toISOString() };
  }
});

const sampleOrder = (): StrangleOrder => ({
  pairId: "pair-1",
  putLeg: {
    venue: "bullish",
    symbol: "BTC-USDC-20260530-77000-P",
    strikeUsdc: 77_000,
    contractsBtc: 1.4,
    maxAcceptableAskUsdcPerBtc: 1_150,
    legRole: "long_put"
  },
  callLeg: {
    venue: "deribit",
    symbol: "BTC-31MAY26-75000-C",
    strikeUsdc: 75_000,
    contractsBtc: 1.4,
    maxAcceptableAskUsdcPerBtc: 1_162.86,
    legRole: "long_call"
  }
});

// ─── Tests ───

test("happy path: both legs fill", async () => {
  const exec = new LiveStrangleExecutor(makeBullish(), makeDeribit(), { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.putLeg.filledAskUsdcPerBtc, 1_150);
    assert.equal(r.callLeg.filledAskUsdcPerBtc, 1_162.86);
  }
});

test("put fails: call leg reversed, return 503 put_failed", async () => {
  const bullish = makeBullish({
    buyResult: { ok: false, reason: "venue_error", detail: "Bullish 500" }
  });
  const deribitCalls: LegCall[] = [];
  const deribit = makeDeribit({}, deribitCalls);
  const exec = new LiveStrangleExecutor(bullish, deribit, { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "put_failed");
    // Call leg should have been bought then sold (reverse)
    assert.equal(deribitCalls.length, 2);
    assert.equal(deribitCalls[0].method, "buyLeg");
    assert.equal(deribitCalls[1].method, "sellLeg");
    assert.match((r.callLegResult as { detail: string }).detail, /reversed/);
  }
});

test("call fails: put leg reversed, return 503 call_failed", async () => {
  const bullishCalls: LegCall[] = [];
  const bullish = makeBullish({}, bullishCalls);
  const deribit = makeDeribit({
    buyResult: { ok: false, reason: "venue_error", detail: "Deribit timeout" }
  });
  const exec = new LiveStrangleExecutor(bullish, deribit, { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "call_failed");
    assert.equal(bullishCalls.length, 2);
    assert.equal(bullishCalls[0].method, "buyLeg");
    assert.equal(bullishCalls[1].method, "sellLeg");
    assert.match((r.putLegResult as { detail: string }).detail, /reversed/);
  }
});

test("both fail: return 503 both_failed (no reverse attempted)", async () => {
  const bullishCalls: LegCall[] = [];
  const deribitCalls: LegCall[] = [];
  const bullish = makeBullish({ buyResult: { ok: false, reason: "venue_error", detail: "x" } }, bullishCalls);
  const deribit = makeDeribit({ buyResult: { ok: false, reason: "venue_error", detail: "y" } }, deribitCalls);
  const exec = new LiveStrangleExecutor(bullish, deribit, { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "both_failed");
    // No sellLeg calls (no successful fill to reverse)
    assert.equal(bullishCalls.filter((c) => c.method === "sellLeg").length, 0);
    assert.equal(deribitCalls.filter((c) => c.method === "sellLeg").length, 0);
  }
});

test("reverse itself fails: REVERSE_FAILED recorded in detail", async () => {
  const bullish = makeBullish({ buyResult: { ok: false, reason: "venue_error", detail: "buy failed" } });
  const deribit = makeDeribit({
    sellResult: { ok: false, reason: "venue_error", detail: "Deribit sell rejected" }
  });
  const exec = new LiveStrangleExecutor(bullish, deribit, { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  if (!r.ok) {
    assert.match((r.callLegResult as { detail: string }).detail, /REVERSE_FAILED/);
  }
});

test("adapter throws: wrapped as venue_error", async () => {
  const bullish = makeBullish({ buyThrows: new Error("connection refused") });
  const exec = new LiveStrangleExecutor(bullish, makeDeribit(), { log: () => {} });
  const r = await exec.executeStrangle(sampleOrder());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "put_failed");
    assert.match((r.putLegResult as { detail: string }).detail, /threw.*connection refused/);
  }
});

test("clientOrderId per leg is unique", async () => {
  const bullishCalls: LegCall[] = [];
  const deribitCalls: LegCall[] = [];
  const exec = new LiveStrangleExecutor(makeBullish({}, bullishCalls), makeDeribit({}, deribitCalls), { log: () => {} });
  await exec.executeStrangle(sampleOrder());
  const putId = bullishCalls[0].req.clientOrderId;
  const callId = deribitCalls[0].req.clientOrderId;
  assert.notEqual(putId, callId);
  assert.match(putId, /pair-1-put-/);
  assert.match(callId, /pair-1-call-/);
});

test("concurrent execution: both legs run in parallel (timing test)", async () => {
  const slow = async (): Promise<LegExecutionResult> => {
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, filledAskUsdcPerBtc: 1_150, filledAtIso: new Date().toISOString() };
  };
  const bullish: BullishLegClient = { buyLeg: slow, sellLeg: slow };
  const deribit: DeribitLegClient = { buyLeg: slow, sellLeg: slow };
  const exec = new LiveStrangleExecutor(bullish, deribit, { log: () => {} });
  const t0 = Date.now();
  await exec.executeStrangle(sampleOrder());
  const elapsed = Date.now() - t0;
  // Parallel = ~50ms; serial would be ~100ms
  assert.ok(elapsed < 90, `parallel exec expected < 90ms, got ${elapsed}ms`);
});

test("ITM guts both venues routed correctly (bullish put + deribit call)", async () => {
  const bullishCalls: LegCall[] = [];
  const deribitCalls: LegCall[] = [];
  const exec = new LiveStrangleExecutor(
    makeBullish({}, bullishCalls),
    makeDeribit({}, deribitCalls),
    { log: () => {} }
  );
  await exec.executeStrangle(sampleOrder());
  // Bullish should see only the put (1 buy call), Deribit only the call (1 buy call)
  assert.equal(bullishCalls.length, 1);
  assert.equal(deribitCalls.length, 1);
  assert.equal(bullishCalls[0].req.symbol, "BTC-USDC-20260530-77000-P");
  assert.equal(deribitCalls[0].req.instrument, "BTC-31MAY26-75000-C");
});

test("both legs on same venue (e.g., both Bullish): adapter dispatched twice", async () => {
  const bullishCalls: LegCall[] = [];
  const order = sampleOrder();
  order.callLeg.venue = "bullish";
  order.callLeg.symbol = "BTC-USDC-20260530-75000-C";
  const exec = new LiveStrangleExecutor(makeBullish({}, bullishCalls), makeDeribit(), { log: () => {} });
  await exec.executeStrangle(order);
  assert.equal(bullishCalls.length, 2);
});
