/**
 * PR A5 tests — LiveCloseExecutor + retry sequence + slippage floor.
 *
 *   - Happy path both legs fill on attempt 1
 *   - Put attempt 1 fails, attempt 2 fills (5% deeper)
 *   - All 3 put attempts fail → put_failed result
 *   - Both legs all-fail → both_failed
 *   - Adapter throws → wrapped as venue_error in result
 *   - Per-attempt clientOrderId unique
 *   - Slippage floor honored: minAcceptable=1000 means attempt 3 = 1000, not lower
 *   - Same-venue both legs dispatched correctly
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LiveCloseExecutor } from "../src/singleSide/twoSided/liveCloseExecutor";
import type { BullishLegClient, DeribitLegClient } from "../src/singleSide/twoSided/liveStrangleExecutor";
import type { LegExecutionResult } from "../src/singleSide/twoSided/executor";
import type { CloseStrangleRequest } from "../src/singleSide/twoSided/closeExecutor";

type Call = { method: "sellLeg"; price: number; clientOrderId: string };

const makeBullish = (responses: LegExecutionResult[], calls: Call[] = []): BullishLegClient => {
  let i = 0;
  return {
    buyLeg: async () => { throw new Error("not used"); },
    sellLeg: async (req) => {
      calls.push({ method: "sellLeg", price: req.minAcceptableBidUsdcPerBtc, clientOrderId: req.clientOrderId });
      return responses[Math.min(i++, responses.length - 1)];
    }
  };
};

const makeDeribit = (responses: LegExecutionResult[], calls: Call[] = []): DeribitLegClient => {
  let i = 0;
  return {
    buyLeg: async () => { throw new Error("not used"); },
    sellLeg: async (req) => {
      calls.push({ method: "sellLeg", price: req.minAcceptableBidUsdcPerBtc, clientOrderId: req.clientOrderId });
      return responses[Math.min(i++, responses.length - 1)];
    }
  };
};

const sampleReq = (): CloseStrangleRequest => ({
  pairId: "p1",
  putLeg: {
    legRole: "long_put",
    venue: "bullish",
    symbol: "BTC-USDC-20260530-77000-P",
    contractsBtc: 1.4,
    expectedSellPxUsdcPerBtc: 1_500,
    minAcceptablePxUsdcPerBtc: 1_000
  },
  callLeg: {
    legRole: "long_call",
    venue: "deribit",
    symbol: "BTC-31MAY26-75000-C",
    contractsBtc: 1.4,
    expectedSellPxUsdcPerBtc: 1_400,
    minAcceptablePxUsdcPerBtc: 900
  }
});

const ok = (px: number): LegExecutionResult => ({ ok: true, filledAskUsdcPerBtc: px, filledAtIso: new Date().toISOString() });
const fail = (): LegExecutionResult => ({ ok: false, reason: "venue_error", detail: "x" });

test("happy path: both legs fill attempt 1", async () => {
  const exec = new LiveCloseExecutor(makeBullish([ok(1_500)]), makeDeribit([ok(1_400)]), { log: () => {} });
  const r = await exec.closeStrangle(sampleReq());
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.putLeg.filledPxUsdcPerBtc, 1_500);
    assert.equal(r.callLeg.filledPxUsdcPerBtc, 1_400);
    // total proceeds = 1500 × 1.4 + 1400 × 1.4 = 2100 + 1960 = 4060
    assert.equal(r.totalProceedsUsdc, 4_060);
  }
});

test("retry: put fails attempt 1, fills attempt 2 (5% deeper)", async () => {
  const calls: Call[] = [];
  const exec = new LiveCloseExecutor(
    makeBullish([fail(), ok(1_425)], calls),
    makeDeribit([ok(1_400)]),
    { log: () => {} }
  );
  const r = await exec.closeStrangle(sampleReq());
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.putLeg.filledPxUsdcPerBtc, 1_425);
  // Attempt 1 = 1500, attempt 2 = 1500 × 0.95 = 1425
  assert.equal(calls.length, 2);
  assert.equal(calls[0].price, 1_500);
  assert.equal(calls[1].price, 1_425);
});

test("retry: all 3 put attempts fail → put_failed result", async () => {
  const calls: Call[] = [];
  const exec = new LiveCloseExecutor(
    makeBullish([fail(), fail(), fail()], calls),
    makeDeribit([ok(1_400)]),
    { log: () => {} }
  );
  const r = await exec.closeStrangle(sampleReq());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.reason, "put_failed");
    assert.match((r.putLegResult as { detail: string }).detail, /all 3 attempts failed/);
  }
  // Attempts: 1500, 1425, 1000 (floor)
  assert.equal(calls.length, 3);
  assert.equal(calls[2].price, 1_000);
});

test("both legs all-fail → both_failed", async () => {
  const exec = new LiveCloseExecutor(
    makeBullish([fail(), fail(), fail()]),
    makeDeribit([fail(), fail(), fail()]),
    { log: () => {} }
  );
  const r = await exec.closeStrangle(sampleReq());
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.reason, "both_failed");
});

test("adapter throws → wrapped as venue_error in result", async () => {
  const bullish: BullishLegClient = {
    buyLeg: async () => { throw new Error("nope"); },
    sellLeg: async () => { throw new Error("connection refused"); }
  };
  const exec = new LiveCloseExecutor(bullish, makeDeribit([ok(1_400)]), { log: () => {} });
  const r = await exec.closeStrangle(sampleReq());
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.match((r.putLegResult as { detail: string }).detail, /connection refused/);
  }
});

test("clientOrderId unique per attempt", async () => {
  const calls: Call[] = [];
  const exec = new LiveCloseExecutor(makeBullish([fail(), fail(), ok(1_000)], calls), makeDeribit([ok(1_400)]), { log: () => {} });
  await exec.closeStrangle(sampleReq());
  const ids = calls.map((c) => c.clientOrderId);
  assert.equal(new Set(ids).size, 3, "each attempt must have unique clientOrderId");
  for (const id of ids) assert.match(id, /p1-put-sell-a/);
});

test("slippage floor: attempt 3 uses floor price, not below", async () => {
  const calls: Call[] = [];
  // High floor = 1450 (close to expected). Attempt sequence: 1500, 1425 (below floor — skipped), 1450
  const req = sampleReq();
  req.putLeg.minAcceptablePxUsdcPerBtc = 1_450;
  const exec = new LiveCloseExecutor(makeBullish([fail(), fail()], calls), makeDeribit([ok(1_400)]), { log: () => {} });
  await exec.closeStrangle(req);
  // Expected attempt prices: 1500, then floor=1450 (1425 < 1450 skipped). Only 2 attempts total.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].price, 1_500);
  assert.equal(calls[1].price, 1_450);
});

test("same-venue both legs dispatched correctly", async () => {
  const calls: Call[] = [];
  const req = sampleReq();
  req.callLeg.venue = "bullish";
  req.callLeg.symbol = "BTC-USDC-20260530-75000-C";
  const exec = new LiveCloseExecutor(makeBullish([ok(1_500), ok(1_400)], calls), makeDeribit([]), { log: () => {} });
  const r = await exec.closeStrangle(req);
  assert.ok(r.ok);
  assert.equal(calls.length, 2);
});
