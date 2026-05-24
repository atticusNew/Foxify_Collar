/**
 * Unit tests for the shared Bullish IOC limit-order primitive
 * (PR-B 2026-05-24).
 *
 * `executeBullishIocLimit` is the single hardened code path used by:
 *   - `bullishSpreadAdapter.submitIocLimitAndPoll` (4-leg open/close)
 *   - `BullishTestnetAdapter.sellOption`            (TP curve fallback)
 *
 * These tests exercise it in isolation against a fully-mocked client so
 * the contract — IOC TIF forced, terminal-status detection, expired-vs-
 * filled disambiguation, rate-limit early abort, poll-timeout cancel —
 * is locked down without a live Bullish session.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeBullishIocLimit,
  type BullishIocLimitClient,
  snapTickCeil,
  snapTickFloor,
  BTC_OPTION_TICK_USDC
} from "../src/pilot/bullishIocLimit";

type CreateCall = {
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
  clientOrderId?: string;
  timeInForce?: "IOC" | "DAY" | "GTC";
};

type StatusResponse = {
  status: string;
  fillPrice: number;
  fillQuantity: number;
  fees: { baseFee: string; quoteFee: string };
  raw: unknown;
};

const buildMockClient = (params: {
  createResponse?: { orderId: string } | Error;
  statusSequence?: Array<StatusResponse | Error>;
  cancelResponse?: unknown | Error;
}): {
  client: BullishIocLimitClient;
  createCalls: CreateCall[];
  statusCalls: number;
  cancelCalls: number;
} => {
  const createCalls: CreateCall[] = [];
  let statusCalls = 0;
  let cancelCalls = 0;
  const seq = [...(params.statusSequence ?? [])];
  const client: BullishIocLimitClient = {
    async createSpotLimitOrder(p: CreateCall): Promise<unknown> {
      createCalls.push(p);
      if (params.createResponse instanceof Error) throw params.createResponse;
      return params.createResponse ?? { orderId: "ORD-1" };
    },
    async getOrderStatus(_orderId, _opts) {
      const next = seq.shift();
      statusCalls++;
      if (next instanceof Error) throw next;
      return (
        next ?? {
          status: "PENDING_NEW",
          fillPrice: 0,
          fillQuantity: 0,
          fees: { baseFee: "0", quoteFee: "0" },
          raw: { status: "PENDING_NEW" }
        }
      );
    },
    async cancelOrder(_p) {
      cancelCalls++;
      if (params.cancelResponse instanceof Error) throw params.cancelResponse;
      return params.cancelResponse ?? { ok: true };
    }
  } as BullishIocLimitClient;
  // Counters are mutated through the client closures, so we need to
  // expose accessors. Wrap via a Proxy-like getter object.
  return {
    client,
    createCalls,
    get statusCalls() {
      return statusCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    }
  } as any;
};

const baseParams = (overrides: Partial<Parameters<typeof executeBullishIocLimit>[0]> = {}): Parameters<typeof executeBullishIocLimit>[0] => ({
  client: overrides.client!,
  symbol: "BTC-USDC-20260530-78000-C",
  side: "SELL",
  priceUsdcPerBtc: 200,
  quantityBtc: 1.0,
  clientOrderId: "1234567890",
  tradingAccountId: "tacct-1",
  pricePrecision: 4,
  qtyPrecision: 2,
  pollIntervalMs: 5,   // fast tests
  pollMaxAttempts: 4,  // 20ms total ceiling
  logPrefix: "[test]",
  ...overrides
});

// ─── Tick snapping (deterministic) ───────────────────────────────────

test("snapTickCeil snaps to the next $10 tick (or stays put if on tick)", () => {
  assert.equal(snapTickCeil(200), 200);
  assert.equal(snapTickCeil(201), 210);
  assert.equal(snapTickCeil(209.99), 210);
  assert.equal(snapTickCeil(0), 0);
  assert.equal(snapTickCeil(-5), 0);
});

test("snapTickFloor snaps to the previous $10 tick (clamped to 1 tick)", () => {
  assert.equal(snapTickFloor(200), 200);
  assert.equal(snapTickFloor(199.99), 190);
  assert.equal(snapTickFloor(15), 10);
  assert.equal(snapTickFloor(5), BTC_OPTION_TICK_USDC); // sub-tick clamps to 1 tick
});

// ─── executeBullishIocLimit happy + sad paths ────────────────────────

test("PR-B: happy path — terminal CLOSED + Executed → filled=true", async () => {
  const ctx = buildMockClient({
    createResponse: { orderId: "ORD-HAPPY" },
    statusSequence: [
      {
        status: "CLOSED",
        fillPrice: 215,
        fillQuantity: 1.0,
        fees: { baseFee: "0", quoteFee: "0" },
        raw: { status: "CLOSED", statusReason: "Executed", statusReasonCode: "6002" }
      }
    ]
  });
  const result = await executeBullishIocLimit(baseParams({ client: ctx.client }));
  assert.equal(result.filled, true);
  assert.equal(result.fillQtyBtc, 1.0);
  assert.equal(result.fillPriceUsdcPerBtc, 215);
  assert.equal(result.orderId, "ORD-HAPPY");
  assert.equal(result.lastObservedStatus, "CLOSED");
  assert.equal(result.finalReason, "Executed");
  // IOC TIF forced regardless of caller env
  assert.equal(ctx.createCalls[0].timeInForce, "IOC");
  // Price + qty formatted to caller-specified precision
  assert.equal(ctx.createCalls[0].price, "200.0000");
  assert.equal(ctx.createCalls[0].quantity, "1.00");
});

test("PR-B: floor not crossed — terminal CLOSED + Expired → filled=false (defer signal)", async () => {
  // Bullish IOC SELL at floor returns CLOSED with statusReasonCode=6004
  // when no resting bids are at-or-above the limit. This is the slippage-
  // floor "did not cross" outcome — the caller surfaces it as "unfilled".
  const ctx = buildMockClient({
    createResponse: { orderId: "ORD-EXPIRED" },
    statusSequence: [
      {
        status: "CLOSED",
        fillPrice: 0,
        fillQuantity: 0,
        fees: { baseFee: "0", quoteFee: "0" },
        raw: { status: "CLOSED", statusReason: "Expired", statusReasonCode: "6004" }
      }
    ]
  });
  const result = await executeBullishIocLimit(baseParams({ client: ctx.client }));
  assert.equal(result.filled, false);
  assert.equal(result.fillQtyBtc, 0);
  assert.equal(result.fillPriceUsdcPerBtc, 0);
  assert.equal(result.orderId, "ORD-EXPIRED");
  assert.equal(result.finalReason, "Expired");
});

test("PR-B: rate-limit (96100) during poll aborts the wait early", async () => {
  // Bullish has been observed to return errorCode 96100 RATE_LIMIT_EXCEEDED
  // when polling status too aggressively. Continuing to poll would extend
  // the rate-limit window — primitive aborts and surfaces the cause.
  const rateLimitErr = new Error("bullish_http_429:RATE_LIMIT_EXCEEDED 96100");
  const ctx = buildMockClient({
    createResponse: { orderId: "ORD-RATELIMIT" },
    statusSequence: [rateLimitErr]
  });
  const result = await executeBullishIocLimit(baseParams({ client: ctx.client }));
  assert.equal(result.filled, false);
  assert.equal(result.orderId, "ORD-RATELIMIT");
  assert.match(result.finalReason, /poll_rate_limit/);
  assert.equal(result.pollErrorCount, 1);
  assert.equal(ctx.cancelCalls, 0, "rate-limit must NOT trigger cancelOrder");
});

test("PR-B: no terminal within ceiling → poll_timeout + best-effort cancel", async () => {
  // Bullish status feed sometimes lags propagation: order may have
  // filled but GET /orders/:id still returns PENDING_NEW. Primitive
  // exhausts the ceiling, cancels, returns poll_timeout.
  const pending: StatusResponse = {
    status: "PENDING_NEW",
    fillPrice: 0,
    fillQuantity: 0,
    fees: { baseFee: "0", quoteFee: "0" },
    raw: { status: "PENDING_NEW" }
  };
  const ctx = buildMockClient({
    createResponse: { orderId: "ORD-TIMEOUT" },
    statusSequence: [pending, pending, pending, pending]
  });
  const result = await executeBullishIocLimit(
    baseParams({ client: ctx.client, pollMaxAttempts: 4 })
  );
  assert.equal(result.filled, false);
  assert.equal(result.orderId, "ORD-TIMEOUT");
  assert.match(result.finalReason, /poll_timeout/);
  assert.equal(result.lastObservedStatus, "PENDING_NEW");
  assert.equal(ctx.cancelCalls, 1, "poll_timeout MUST attempt best-effort cancel");
});

test("PR-B: createSpotLimitOrder throws → submit_error (no orderId, no poll, no cancel)", async () => {
  const submitErr = new Error("bullish_http_400:PRICE_MUST_BE_OF_TICK_SIZE 6018");
  const ctx = buildMockClient({
    createResponse: submitErr
  });
  const result = await executeBullishIocLimit(baseParams({ client: ctx.client }));
  assert.equal(result.filled, false);
  assert.equal(result.orderId, null);
  assert.match(result.finalReason, /submit_error/);
  assert.match(result.finalReason, /PRICE_MUST_BE_OF_TICK_SIZE/);
  assert.equal(ctx.statusCalls, 0);
  assert.equal(ctx.cancelCalls, 0);
});
