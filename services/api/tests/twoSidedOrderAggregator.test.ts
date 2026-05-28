/**
 * PR C7 tests — order aggregator (constructor-controlled enable flag).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { OrderAggregator } from "../src/singleSide/twoSided/orderAggregator";
import type { LegExecutionResult } from "../src/singleSide/twoSided/executor";

const okResult = (px: number): LegExecutionResult => ({ ok: true, filledAskUsdcPerBtc: px, filledAtIso: new Date().toISOString() });
const failResult = (): LegExecutionResult => ({ ok: false, reason: "venue_error", detail: "x" });

test("aggregator disabled: bypasses, submits each immediately", async () => {
  const submitted: Array<{ totalBtc: number }> = [];
  const agg = new OrderAggregator({
    // aggregationEnabled omitted → defaults false
    submit: async (_v, _s, _si, totalBtc) => {
      submitted.push({ totalBtc });
      return okResult(1_150);
    },
    log: () => {}
  });
  const r1 = await agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1-put", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  const r2 = await agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p2-put", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].totalBtc, 1.4);
  assert.equal(r1.callerKey, "p1-put");
  assert.equal(r2.callerKey, "p2-put");
});

test("aggregator enabled: batches 3 same-key requests into 1 venue submit", async () => {
  const submitted: Array<{ totalBtc: number; weightedMaxPx: number }> = [];
  const agg = new OrderAggregator({
    aggregationEnabled: true,
    windowMs: 20,
    submit: async (_v, _s, _si, totalBtc, weightedMaxPx) => {
      submitted.push({ totalBtc, weightedMaxPx });
      return okResult(1_148);
    },
    log: () => {}
  });
  const [r1, r2, r3] = await Promise.all([
    agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 }),
    agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p2", contractsBtc: 0.7, maxAcceptableAskUsdcPerBtc: 1_155 }),
    agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p3", contractsBtc: 2.1, maxAcceptableAskUsdcPerBtc: 1_148 })
  ]);
  assert.equal(submitted.length, 1);
  assert.ok(Math.abs(submitted[0].totalBtc - 4.2) < 1e-9);
  const expectedWeighted = (1150 * 1.4 + 1155 * 0.7 + 1148 * 2.1) / 4.2;
  assert.ok(Math.abs(submitted[0].weightedMaxPx - expectedWeighted) < 0.01);
  assert.equal(r1.filledAskUsdcPerBtc, 1_148);
  assert.equal(r2.filledAskUsdcPerBtc, 1_148);
  assert.equal(r3.filledAskUsdcPerBtc, 1_148);
  assert.equal(r1.filledContractsBtc, 1.4);
  assert.equal(r2.filledContractsBtc, 0.7);
  assert.equal(r3.filledContractsBtc, 2.1);
});

test("aggregator enabled: different symbols/venues batched separately", async () => {
  const submitted: Array<{ symbol: string; totalBtc: number }> = [];
  const agg = new OrderAggregator({
    aggregationEnabled: true,
    windowMs: 20,
    submit: async (_v, symbol, _si, totalBtc) => {
      submitted.push({ symbol, totalBtc });
      return okResult(1_150);
    },
    log: () => {}
  });
  await Promise.all([
    agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1-put", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 }),
    agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p2-put", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 }),
    agg.submitLeg("deribit", "BTC-X-C", "buy", { callerKey: "p1-call", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_162 }),
  ]);
  assert.equal(submitted.length, 2);
  const putBatch = submitted.find((s) => s.symbol === "BTC-X-P");
  const callBatch = submitted.find((s) => s.symbol === "BTC-X-C");
  assert.equal(putBatch!.totalBtc, 2.8);
  assert.equal(callBatch!.totalBtc, 1.4);
});

test("aggregator: batch failure rejects all callers", async () => {
  const agg = new OrderAggregator({
    aggregationEnabled: true,
    windowMs: 20,
    submit: async () => failResult(),
    log: () => {}
  });
  const p1 = agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  const p2 = agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p2", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  await assert.rejects(p1, /batch leg failed/);
  await assert.rejects(p2, /batch leg failed/);
});

test("aggregator: single-pair within window submits a 1-pair batch (not bypassed)", async () => {
  const submitted: Array<{ totalBtc: number }> = [];
  const agg = new OrderAggregator({
    aggregationEnabled: true,
    windowMs: 20,
    submit: async (_v, _s, _si, totalBtc) => {
      submitted.push({ totalBtc });
      return okResult(1_150);
    },
    log: () => {}
  });
  const r = await agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].totalBtc, 1.4);
  assert.equal(r.filledAskUsdcPerBtc, 1_150);
});

test("flushAll dispatches pending batches immediately", async () => {
  let dispatchCount = 0;
  const agg = new OrderAggregator({
    aggregationEnabled: true,
    windowMs: 10_000,
    submit: async () => {
      dispatchCount++;
      return okResult(1_150);
    },
    log: () => {}
  });
  const p = agg.submitLeg("bullish", "BTC-X-P", "buy", { callerKey: "p1", contractsBtc: 1.4, maxAcceptableAskUsdcPerBtc: 1_150 });
  await agg.flushAll();
  await p;
  assert.equal(dispatchCount, 1);
});
