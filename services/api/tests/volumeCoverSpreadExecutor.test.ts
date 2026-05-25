import assert from "node:assert/strict";
import test from "node:test";

import type { SpreadStructure, SpreadLegSpec } from "../src/volumeCover/spreadHedge";
import {
  openSpread,
  closeSpread,
  partialCloseSpreadOnTrigger,
  checkSpreadLiquidity,
  getConfiguredDepthGate,
  getConfiguredLongTriggerPolicy,
  getConfiguredRollbackHardening,
  __testHelpers,
  type SpreadExecutorAdapter,
  type ExecutorOrderResult,
  type OrderbookTop
} from "../src/volumeCover/spreadExecutor";

const clearEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VC_HEDGE_JITTER_") || key.startsWith("VC_FILL_OPTIMIZER_")) {
      delete process.env[key];
    }
  }
  // Disable jitter sleeps for fast tests
  process.env.VC_HEDGE_JITTER_OPEN_DELAY_ENABLED = "false";
  process.env.VC_HEDGE_JITTER_INTERLEG_ENABLED = "false";
};

const expiryIso = "2026-05-26T08:00:00Z";

const buildStructure = (): SpreadStructure => {
  const legs: SpreadLegSpec[] = [
    {
      legRole: "put_long",
      optionKind: "put",
      side: "long",
      strikeIdealUsdc: 75_000,
      strikeActualUsdc: 75_000,
      contractsBtc: 0.01,
      expiryIso
    },
    {
      legRole: "put_short",
      optionKind: "put",
      side: "short",
      strikeIdealUsdc: 74_000,
      strikeActualUsdc: 74_000,
      contractsBtc: 0.01,
      expiryIso
    },
    {
      legRole: "call_long",
      optionKind: "call",
      side: "long",
      strikeIdealUsdc: 77_000,
      strikeActualUsdc: 77_000,
      contractsBtc: 0.01,
      expiryIso
    },
    {
      legRole: "call_short",
      optionKind: "call",
      side: "short",
      strikeIdealUsdc: 78_000,
      strikeActualUsdc: 78_000,
      contractsBtc: 0.01,
      expiryIso
    }
  ];
  return {
    positionId: "pos-test-1",
    cellId: "50k_2pct_1k",
    spreadGroupId: "vc-spread-test",
    design: "DB",
    venue: "bullish",
    fallbackVenue: "deribit",
    legs,
    expectedNetDebitPerBtcUsdcIdeal: null,
    contractsBtcPerLeg: 0.01,
    spreadWidthUsdc: 1_000,
    triggerLowBtc: 74_480,
    triggerHighBtc: 77_520
  };
};

type Book = { topBid: number | null; topAsk: number | null };

const buildMockAdapter = (params: {
  books: Record<string, Book>;
  submitOverrides?: Partial<Record<string, (call: number) => ExecutorOrderResult>>;
}): {
  adapter: SpreadExecutorAdapter;
  calls: Array<{ symbol: string; side: string; intent: string; legRole: string; priceUsdcPerBtc: number }>;
} => {
  const calls: Array<{ symbol: string; side: string; intent: string; legRole: string; priceUsdcPerBtc: number }> = [];
  const callsPerSymbol = new Map<string, number>();
  const adapter: SpreadExecutorAdapter = {
    async getOrderbookTop({ symbol }): Promise<OrderbookTop> {
      const b = params.books[symbol];
      return {
        topBidUsdc: b?.topBid ?? null,
        topAskUsdc: b?.topAsk ?? null,
        bidQtyBtc: 1,
        askQtyBtc: 1
      };
    },
    async submitIocLimit(p): Promise<ExecutorOrderResult> {
      calls.push({
        symbol: p.symbol,
        side: p.side,
        intent: p.intent,
        legRole: p.legRole,
        priceUsdcPerBtc: p.priceUsdcPerBtc
      });
      const callIdx = (callsPerSymbol.get(p.symbol) ?? 0) + 1;
      callsPerSymbol.set(p.symbol, callIdx);

      // Symbol-specific override (e.g. always fail this symbol)
      const override = params.submitOverrides?.[p.symbol];
      if (override) return override(callIdx);

      // Default: fill at limit price
      return {
        filled: true,
        fillPriceUsdcPerBtc: p.priceUsdcPerBtc,
        fillQtyBtc: p.quantityBtc,
        finalReason: "Executed",
        orderId: `ORD-${callIdx}`
      };
    },
    resolveSymbol({ leg, expiryIso: e }) {
      const dt = e.slice(0, 10).replace(/-/g, "");
      const kind = leg.optionKind === "put" ? "P" : "C";
      return `BTC-USDC-${dt}-${leg.strikeActualUsdc}-${kind}`;
    }
  };
  return { adapter, calls };
};

const happyBooks = (): Record<string, Book> => ({
  "BTC-USDC-20260526-75000-P": { topBid: 600, topAsk: 700 },  // long put (BUY)
  "BTC-USDC-20260526-74000-P": { topBid: 300, topAsk: 350 },  // short put (SELL)
  "BTC-USDC-20260526-77000-C": { topBid: 200, topAsk: 250 },  // long call (BUY)
  "BTC-USDC-20260526-78000-C": { topBid: 80, topAsk: 100 }    // short call (SELL)
});

test("openSpread: happy path opens all 4 legs in correct order", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await openSpread({ structure, adapter });
  assert.equal(result.ok, true);
  assert.equal(result.legs.length, 4);
  assert.equal(result.failedAt, null);
  assert.equal(result.rollbackResults.length, 0);

  // Order: put_long, put_short, call_long, call_short
  const sequence = calls.map((c) => c.legRole);
  assert.deepEqual(sequence, ["put_long", "put_short", "call_long", "call_short"]);

  // Sides: longs BUY, shorts SELL
  assert.equal(calls[0].side, "BUY");
  assert.equal(calls[1].side, "SELL");
  assert.equal(calls[2].side, "BUY");
  assert.equal(calls[3].side, "SELL");

  // Net debit = sum BUYs - sum SELLs at fill prices
  // Fill prices come from fill optimizer (improved = mid-25%):
  //   put_long BUY at 700 - (700-600)*0.25 = 675
  //   put_short SELL at 300 + 50*0.25 = 312.5 (rounded 312.5)
  //   call_long BUY at 250 - 50*0.25 = 237.5
  //   call_short SELL at 80 + 20*0.25 = 85
  // net debit = (675 + 237.5 - 312.5 - 85) * 0.01 = 515 * 0.01 = 5.15
  assert.ok(result.netDebitUsdc > 0);
});

test("openSpread: fails on liquidity gate when short call has no resting bid", async () => {
  clearEnv();
  const structure = buildStructure();
  const books = happyBooks();
  books["BTC-USDC-20260526-78000-C"] = { topBid: null, topAsk: 30 }; // no resting bid
  const { adapter, calls } = buildMockAdapter({ books });
  const result = await openSpread({ structure, adapter });
  assert.equal(result.ok, false);
  assert.equal(result.errorReason, "liquidity_gate_failed");
  assert.equal(calls.length, 0); // never submitted anything
  assert.equal(result.legs.length, 0);

  // Liquidity check report identifies the bad leg
  const badLeg = result.liquidityCheck.legChecks.find((c) => c.legRole === "call_short");
  assert.equal(badLeg?.sufficient, false);
  assert.equal(badLeg?.reason, "no_resting_bid_for_sell");
});

test("openSpread: short_call open fails → rollback runs in reverse order", async () => {
  clearEnv();
  const structure = buildStructure();
  const books = happyBooks();
  const { adapter, calls } = buildMockAdapter({
    books,
    submitOverrides: {
      "BTC-USDC-20260526-78000-C": (callIdx) => {
        // First call (the open attempt): Expired → triggers retry at worst-case;
        // second call (worst-case attempt) also Expired → final failure;
        // any subsequent calls (rollback): not for this symbol since the symbol
        // wasn't opened. Rollback runs against the OTHER 3 symbols.
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: "Expired",
          orderId: `ORD-EXP-${callIdx}`
        };
      }
    }
  });
  const result = await openSpread({ structure, adapter, skipLiquidityGate: true });
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "call_short");
  assert.equal(result.legs.length, 3); // put_long, put_short, call_long opened
  assert.equal(result.rollbackResults.length, 3);

  // Verify rollback order: reverse of opening (call_long → put_short → put_long)
  const rbOrder = result.rollbackResults.map((r) => r.legRole);
  assert.deepEqual(rbOrder, ["call_long", "put_short", "put_long"]);

  // Verify each rollback uses the REVERSED side:
  //   call_long was BUY → rollback SELL
  //   put_short was SELL → rollback BUY
  //   put_long was BUY → rollback SELL
  assert.equal(result.rollbackResults[0].side, "SELL");
  assert.equal(result.rollbackResults[1].side, "BUY");
  assert.equal(result.rollbackResults[2].side, "SELL");
});

test("closeSpread: sequenced close in reverse direction (shorts first within wing)", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await closeSpread({ structure, adapter });
  assert.equal(result.ok, true);
  assert.equal(result.legs.length, 4);

  // Close order: call_short, call_long, put_short, put_long
  const order = result.legs.map((l) => l.legRole);
  assert.deepEqual(order, ["call_short", "call_long", "put_short", "put_long"]);

  // Close sides:
  //   call_short: was SELL on open → close = BUY back
  //   call_long: was BUY on open → close = SELL
  //   put_short: was SELL → close = BUY back
  //   put_long: was BUY → close = SELL
  assert.equal(result.legs[0].side, "BUY");
  assert.equal(result.legs[1].side, "SELL");
  assert.equal(result.legs[2].side, "BUY");
  assert.equal(result.legs[3].side, "SELL");
});

test("partialCloseSpreadOnTrigger: high trigger closes call_short then put_short, retains long legs (legacy mode)", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: false // legacy retain behavior
  });
  assert.equal(result.ok, true);
  assert.equal(result.shortLegsClosed.length, 2);
  // High trigger: close call_short FIRST (winning wing) then put_short (losing wing)
  assert.equal(result.shortLegsClosed[0].legRole, "call_short");
  assert.equal(result.shortLegsClosed[1].legRole, "put_short");
  // Both close-shorts are BUY-back
  assert.equal(result.shortLegsClosed[0].side, "BUY");
  assert.equal(result.shortLegsClosed[1].side, "BUY");
  // Long legs retained
  assert.equal(result.longLegsRetained.length, 2);
  const retainedRoles = result.longLegsRetained.map((l) => l.legRole).sort();
  assert.deepEqual(retainedRoles, ["call_long", "put_long"]);
});

test("partialCloseSpreadOnTrigger: low trigger closes put_short first then call_short", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "low",
    sellLongsAtTriggerOverride: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.shortLegsClosed[0].legRole, "put_short");
  assert.equal(result.shortLegsClosed[1].legRole, "call_short");
});

test("partialCloseSpreadOnTrigger: sell-longs-at-trigger ON (default) sells winner first then loser", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.shortLegsClosed.length, 2);
  assert.equal(result.longLegsSold.length, 2);
  assert.equal(result.longLegsRetained.length, 0);
  // Order check: shorts go first (call_short, put_short for high),
  // then longs in winner-first order (call_long, put_long for high).
  const submittedRoles = calls.map((c) => c.legRole);
  assert.deepEqual(submittedRoles, [
    "call_short",
    "put_short",
    "call_long",
    "put_long"
  ]);
  // Long sells are SELL direction; shorts are BUY (close).
  for (const c of calls) {
    if (c.legRole === "call_long" || c.legRole === "put_long") {
      assert.equal(c.side, "SELL");
    } else {
      assert.equal(c.side, "BUY");
    }
  }
  assert.ok(result.longLegProceedsUsdc > 0, "long proceeds should be positive");
});

test("partialCloseSpreadOnTrigger: sell-longs-at-trigger low direction sells put_long first", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "low",
    sellLongsAtTriggerOverride: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 2);
  const submittedRoles = calls.map((c) => c.legRole);
  assert.deepEqual(submittedRoles, [
    "put_short",
    "call_short",
    "put_long",
    "call_long"
  ]);
});

test("partialCloseSpreadOnTrigger: env flag VC_SPREAD_SELL_LONGS_AT_TRIGGER=false disables sell", async () => {
  clearEnv();
  process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER = "false";
  try {
    const structure = buildStructure();
    const { adapter } = buildMockAdapter({ books: happyBooks() });
    const result = await partialCloseSpreadOnTrigger({
      structure,
      adapter,
      triggerDirection: "high"
    });
    assert.equal(result.ok, true);
    assert.equal(result.longLegsSold.length, 0);
    assert.equal(result.longLegsRetained.length, 2);
  } finally {
    delete process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER;
  }
});

test("partialCloseSpreadOnTrigger: env unset defaults to 'winner_only' — sells winner, retains loser", async () => {
  // PR-Bundle-3-B (2026-05-25): default flipped from "both" to
  // "winner_only" so triggered positions retain the loser long for the
  // hedge manager's Rule 7 + ladder-netting eligibility.
  clearEnv();
  delete process.env.VC_SPREAD_LONG_TRIGGER_POLICY;
  delete process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER;
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high"
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 1, "winner sold");
  assert.equal(result.longLegsSold[0].legRole, "call_long", "high trigger → call_long is winner");
  assert.equal(result.longLegsRetained.length, 1, "loser retained");
  assert.equal(result.longLegsRetained[0].legRole, "put_long", "high trigger → put_long is loser");
});

// ─── 2026-05-24 PR-C: parallel long-leg sales after shorts close ──

test("PR-C parallel sells: completes in max(t1,t2), not sum (default ON)", async () => {
  clearEnv();
  delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });

  // Inject 100ms latency on each long sell submit. Parallel: ~100ms.
  // Sequential: ~200ms (winner first, then loser).
  const slowAdapter: SpreadExecutorAdapter = {
    ...adapter,
    async submitIocLimit(p) {
      if (p.legRole === "call_long" || p.legRole === "put_long") {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return adapter.submitIocLimit(p);
    }
  };

  const t0 = Date.now();
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter: slowAdapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: true
  });
  const elapsedMs = Date.now() - t0;

  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 2);
  // With parallel sells, total long-sell wall-clock should be ~100ms (one
  // leg's latency), not ~200ms (both summed). Allow generous slack for
  // CI timer jitter — the key signal is < 180ms (not 200+).
  assert.ok(
    elapsedMs < 180,
    `expected parallel execution < 180ms (got ${elapsedMs}ms — should be ~100ms with 100ms per-leg latency)`
  );
  // Result ordering must still be winner-first regardless of fill order.
  const soldRoles = result.longLegsSold.map((l) => l.legRole);
  assert.deepEqual(soldRoles, ["call_long", "put_long"]);
  // Both legs were submitted (independent of order on the wire).
  const longSubmits = calls.filter(
    (c) => c.legRole === "call_long" || c.legRole === "put_long"
  );
  assert.equal(longSubmits.length, 2);
});

test("PR-C sequential fallback: VC_SPREAD_PARALLEL_LONG_SELLS=false preserves legacy ordering", async () => {
  clearEnv();
  process.env.VC_SPREAD_PARALLEL_LONG_SELLS = "false";
  try {
    const structure = buildStructure();
    const { adapter, calls } = buildMockAdapter({ books: happyBooks() });

    const slowAdapter: SpreadExecutorAdapter = {
      ...adapter,
      async submitIocLimit(p) {
        if (p.legRole === "call_long" || p.legRole === "put_long") {
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return adapter.submitIocLimit(p);
      }
    };

    const t0 = Date.now();
    const result = await partialCloseSpreadOnTrigger({
      structure,
      adapter: slowAdapter,
      triggerDirection: "high",
      sellLongsAtTriggerOverride: true
    });
    const elapsedMs = Date.now() - t0;

    assert.equal(result.ok, true);
    assert.equal(result.longLegsSold.length, 2);
    // Sequential should be ~120ms (60ms × 2 legs). Parallel would be ~60ms.
    assert.ok(
      elapsedMs >= 110,
      `expected sequential execution >= 110ms (got ${elapsedMs}ms — should be ~120ms with 60ms per-leg latency)`
    );
    // Submit ordering should match winner-first sequence
    const longRoles = calls
      .filter((c) => c.legRole === "call_long" || c.legRole === "put_long")
      .map((c) => c.legRole);
    assert.deepEqual(longRoles, ["call_long", "put_long"]);
  } finally {
    delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  }
});

test("PR-C parallel sells: one leg fails → other still succeeds; failed leg falls back to retain", async () => {
  clearEnv();
  delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  const structure = buildStructure();
  const callLongSym = "BTC-USDC-20260526-77000-C";
  const { adapter } = buildMockAdapter({
    books: happyBooks(),
    submitOverrides: {
      [callLongSym]: () => ({
        filled: false,
        fillPriceUsdcPerBtc: 0,
        fillQtyBtc: 0,
        finalReason: "Expired",
        orderId: "ORD-FAIL"
      })
    }
  });

  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: true
  });

  // Whole partial-close still considered ok (shorts closed, long-sell
  // failure is non-fatal — falls back to retain).
  assert.equal(result.ok, true);
  assert.equal(result.shortLegsClosed.length, 2);
  assert.equal(result.longLegsSold.length, 1);
  assert.equal(result.longLegsRetained.length, 1);
  assert.equal(result.longLegsSold[0].legRole, "put_long");
  assert.equal(result.longLegsRetained[0].legRole, "call_long");
});

test("PR-C parallel sells: __testHelpers.shouldParallelizeLongSells respects env", () => {
  clearEnv();
  delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  assert.equal(__testHelpers.shouldParallelizeLongSells(), true, "default ON");

  process.env.VC_SPREAD_PARALLEL_LONG_SELLS = "false";
  try {
    assert.equal(
      __testHelpers.shouldParallelizeLongSells(),
      false,
      "explicit false disables"
    );
  } finally {
    delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  }

  process.env.VC_SPREAD_PARALLEL_LONG_SELLS = "true";
  try {
    assert.equal(
      __testHelpers.shouldParallelizeLongSells(),
      true,
      "explicit true enables"
    );
  } finally {
    delete process.env.VC_SPREAD_PARALLEL_LONG_SELLS;
  }
});

test("checkSpreadLiquidity: returns per-leg pass/fail breakdown", async () => {
  clearEnv();
  const structure = buildStructure();
  const books = happyBooks();
  books["BTC-USDC-20260526-78000-C"] = { topBid: null, topAsk: 30 };
  const { adapter } = buildMockAdapter({ books });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open"
  });
  assert.equal(check.passed, false);
  assert.equal(check.legChecks.length, 4);
  const callShortCheck = check.legChecks.find((c) => c.legRole === "call_short")!;
  assert.equal(callShortCheck.sufficient, false);
  const putLongCheck = check.legChecks.find((c) => c.legRole === "put_long")!;
  assert.equal(putLongCheck.sufficient, true);
});

test("__testHelpers.orderLegsForOpen / orderLegsForClose: invariant ordering", () => {
  const legs = buildStructure().legs;
  const openOrder = __testHelpers.orderLegsForOpen(legs).map((l) => l.legRole);
  assert.deepEqual(openOrder, ["put_long", "put_short", "call_long", "call_short"]);
  const closeOrder = __testHelpers.orderLegsForClose(legs).map((l) => l.legRole);
  assert.deepEqual(closeOrder, ["call_short", "call_long", "put_short", "put_long"]);
});

test("__testHelpers.sideForLeg: open vs close direction", () => {
  const legs = buildStructure().legs;
  const longPut = legs.find((l) => l.legRole === "put_long")!;
  const shortPut = legs.find((l) => l.legRole === "put_short")!;
  assert.equal(__testHelpers.sideForLeg(longPut, "open"), "BUY");
  assert.equal(__testHelpers.sideForLeg(longPut, "close"), "SELL");
  assert.equal(__testHelpers.sideForLeg(shortPut, "open"), "SELL");
  assert.equal(__testHelpers.sideForLeg(shortPut, "close"), "BUY");
});

// ─── 2026-05-24 Phase 0.2a: depth-aware liquidity gate ────────────

const buildThinDepthAdapter = (params: {
  thinSymbols: Record<string, { bidQtyBtc: number; askQtyBtc: number }>;
}): {
  adapter: SpreadExecutorAdapter;
} => {
  const books = happyBooks();
  const adapter: SpreadExecutorAdapter = {
    async getOrderbookTop({ symbol }): Promise<OrderbookTop> {
      const b = books[symbol];
      const thin = params.thinSymbols[symbol];
      return {
        topBidUsdc: b?.topBid ?? null,
        topAskUsdc: b?.topAsk ?? null,
        bidQtyBtc: thin?.bidQtyBtc ?? 1.0,
        askQtyBtc: thin?.askQtyBtc ?? 1.0
      };
    },
    async submitIocLimit(p): Promise<ExecutorOrderResult> {
      return {
        filled: true,
        fillPriceUsdcPerBtc: p.priceUsdcPerBtc,
        fillQtyBtc: p.quantityBtc,
        finalReason: "Executed",
        orderId: `ORD-1`
      };
    },
    resolveSymbol({ leg, expiryIso: e }) {
      const dt = e.slice(0, 10).replace(/-/g, "");
      const k = leg.optionKind === "put" ? "P" : "C";
      return `BTC-USDC-${dt}-${leg.strikeActualUsdc}-${k}`;
    }
  };
  return { adapter };
};

test("checkSpreadLiquidity: depth gate log-only mode (default) — warns but passes", async () => {
  clearEnv();
  const structure = buildStructure();
  // call_long needs to BUY → cross the ask. Make ask depth super thin.
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-77000-C": { bidQtyBtc: 1.0, askQtyBtc: 0.05 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0, enforced: false }
  });
  assert.equal(check.passed, true, "log-only should not fail the gate");
  assert.equal(check.depthGate.enforced, false);
  assert.equal(check.depthGate.effectiveMinDepthBtc, 0.3);
  const callLong = check.legChecks.find((c) => c.legRole === "call_long")!;
  assert.equal(callLong.depthSufficient, false);
  assert.equal(callLong.observedDepthBtc, 0.05);
  assert.equal(callLong.sufficient, true, "still passes existence check");
});

test("checkSpreadLiquidity: depth gate enforced — thin leg fails the gate", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-77000-C": { bidQtyBtc: 1.0, askQtyBtc: 0.05 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0, enforced: true }
  });
  assert.equal(check.passed, false, "enforced thin depth should fail");
  const callLong = check.legChecks.find((c) => c.legRole === "call_long")!;
  assert.equal(callLong.depthSufficient, false);
  assert.equal(callLong.sufficient, false);
  assert.ok(callLong.reason?.startsWith("thin_depth_on_ask"));
});

test("checkSpreadLiquidity: depth gate enforced — all legs deep, passes", async () => {
  clearEnv();
  const structure = buildStructure();
  const { adapter } = buildThinDepthAdapter({ thinSymbols: {} });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0, enforced: true }
  });
  assert.equal(check.passed, true);
  for (const c of check.legChecks) {
    assert.equal(c.depthSufficient, true, `${c.legRole} should be sufficient`);
    assert.equal(c.sufficient, true);
  }
});

test("checkSpreadLiquidity: action=close evaluates depth on close-side crossing", async () => {
  clearEnv();
  const structure = buildStructure();
  // On close: longs SELL (cross bid), shorts BUY (cross ask). Make put_long bid thin.
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-75000-P": { bidQtyBtc: 0.05, askQtyBtc: 1.0 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "close",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0, enforced: true }
  });
  const putLong = check.legChecks.find((c) => c.legRole === "put_long")!;
  assert.equal(putLong.crossesSide, "SELL");
  assert.equal(putLong.observedDepthBtc, 0.05);
  assert.equal(putLong.depthSufficient, false);
  assert.equal(putLong.sufficient, false);
});

test("getConfiguredDepthGate: env-driven config with defaults", () => {
  clearEnv();
  delete process.env.VC_SPREAD_MIN_DEPTH_BTC;
  delete process.env.VC_SPREAD_DEPTH_RATIO_REQUIRED;
  delete process.env.VC_SPREAD_DEPTH_GATE_ENFORCED;
  const d = getConfiguredDepthGate();
  assert.equal(d.minDepthBtcFloor, 0.3);
  assert.equal(d.depthRatio, 0.7);
  assert.equal(d.enforced, false);

  process.env.VC_SPREAD_MIN_DEPTH_BTC = "0.5";
  process.env.VC_SPREAD_DEPTH_RATIO_REQUIRED = "0.5";
  process.env.VC_SPREAD_DEPTH_GATE_ENFORCED = "true";
  const d2 = getConfiguredDepthGate();
  assert.equal(d2.minDepthBtcFloor, 0.5);
  assert.equal(d2.depthRatio, 0.5);
  assert.equal(d2.enforced, true);
  delete process.env.VC_SPREAD_MIN_DEPTH_BTC;
  delete process.env.VC_SPREAD_DEPTH_RATIO_REQUIRED;
  delete process.env.VC_SPREAD_DEPTH_GATE_ENFORCED;
});

// ─── 2026-05-24 PR-A: ratio-based depth gate ─────────────────────
//
// Production cells (50k_2pct_1k) size ~1.0–1.3 BTC per leg at current
// spot. The flat 0.3 BTC floor passes when depth is ~0.5 BTC even
// though ~1 BTC orders will partial-fill on that book — exactly the
// Foxify-001 failure mode. The ratio knob scales the threshold with
// contract size to catch this.

const buildLargeContractStructure = (contractsBtc: number): SpreadStructure => {
  const base = buildStructure();
  for (const leg of base.legs) leg.contractsBtc = contractsBtc;
  return { ...base, contractsBtcPerLeg: contractsBtc };
};

test("PR-A ratio gate: production-sized contracts (1.32 BTC) fail at 0.5 BTC depth", async () => {
  clearEnv();
  // 1.32 BTC contracts × 0.7 ratio = 0.924 BTC required depth.
  // 0.5 BTC observed → fails ratio check (and would have caught Foxify-001).
  const structure = buildLargeContractStructure(1.32);
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-77000-C": { bidQtyBtc: 1.0, askQtyBtc: 0.5 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0.7, enforced: true }
  });
  assert.equal(check.passed, false, "0.5 BTC depth on 1.32 BTC order must fail with ratio=0.7");
  // Effective threshold is the ratio component (0.924), not the floor (0.3).
  assert.equal(
    Math.round(check.depthGate.effectiveMinDepthBtc * 1000) / 1000,
    0.924
  );
  const callLong = check.legChecks.find((c) => c.legRole === "call_long")!;
  assert.equal(callLong.observedDepthBtc, 0.5);
  assert.equal(callLong.depthSufficient, false);
  assert.equal(callLong.sufficient, false);
});

test("PR-A ratio gate: production-sized contracts pass when depth ≥ ratio×contracts", async () => {
  clearEnv();
  // 1.32 BTC contracts × 0.7 ratio = 0.924 BTC required.
  // All legs default 1.0 BTC depth in buildThinDepthAdapter → passes.
  const structure = buildLargeContractStructure(1.32);
  const { adapter } = buildThinDepthAdapter({ thinSymbols: {} });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0.7, enforced: true }
  });
  assert.equal(check.passed, true);
  for (const c of check.legChecks) {
    assert.equal(c.depthSufficient, true, `${c.legRole} sufficient at 1.0 BTC depth`);
  }
});

test("PR-A ratio gate: floor protects when ratio×contracts is small", async () => {
  clearEnv();
  // Tiny contracts (0.01 BTC) × 0.7 = 0.007 — well below floor.
  // Floor (0.3 BTC) MUST still apply. Depth of 0.2 must fail.
  const structure = buildLargeContractStructure(0.01);
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-77000-C": { bidQtyBtc: 1.0, askQtyBtc: 0.2 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0.7, enforced: true }
  });
  assert.equal(check.passed, false);
  assert.equal(check.depthGate.effectiveMinDepthBtc, 0.3);
  const callLong = check.legChecks.find((c) => c.legRole === "call_long")!;
  assert.equal(callLong.observedDepthBtc, 0.2);
  assert.equal(callLong.depthSufficient, false);
});

test("PR-A ratio gate: log-only mode preserves passed=true even with ratio shortfall", async () => {
  clearEnv();
  // Same shortfall as the 1.32-BTC fail test, but enforced=false →
  // gate WARNS but does not flip `passed`. Existence-check still
  // succeeds, so the spread will attempt to open. This is the soak
  // posture before the ENFORCED env flip on Render.
  const structure = buildLargeContractStructure(1.32);
  const { adapter } = buildThinDepthAdapter({
    thinSymbols: {
      "BTC-USDC-20260526-77000-C": { bidQtyBtc: 1.0, askQtyBtc: 0.5 }
    }
  });
  const check = await checkSpreadLiquidity({
    structure,
    adapter,
    action: "open",
    depthGateOverride: { minDepthBtcFloor: 0.3, depthRatio: 0.7, enforced: false }
  });
  assert.equal(check.passed, true);
  const callLong = check.legChecks.find((c) => c.legRole === "call_long")!;
  assert.equal(callLong.depthSufficient, false);
  assert.equal(callLong.sufficient, true);
});

// ─── PR-G2 (2026-05-25): mid-IOC short-leg buyback ───────────────────
//
// Validates that the SHORT-leg buyback path uses an aggressive
// fill-optimizer fraction (default 0.5 = true mid) while the LONG-sell
// path keeps the standard 0.25 (the optimizer's normal default).
//
// Test strategy: the mock adapter's submitIocLimit fills at exactly the
// limit price submitted, so inspecting `calls[].priceUsdcPerBtc` tells
// us where each leg crossed the book.
//
// happyBooks() exposes:
//   short_put 74000-P:  bid 300 / ask 350  (spread 50)
//     mid (0.5):    350 − 0.5·50  = 325
//     legacy (0.25): 350 − 0.25·50 = 337.5
//   short_call 78000-C: bid 80  / ask 100  (spread 20)
//     mid (0.5):    100 − 0.5·20  = 90
//     legacy (0.25): 100 − 0.25·20 = 95
//   long_put 75000-P:   bid 600 / ask 700  (spread 100)
//     SELL legacy (0.25): 600 + 0.25·100 = 625
//   long_call 77000-C:  bid 200 / ask 250  (spread 50)
//     SELL legacy (0.25): 200 + 0.25·50  = 212.5

test("PR-G2: short-buyback uses mid (0.5) fraction by default; longs keep 0.25", async () => {
  clearEnv();
  delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: true
  });
  assert.equal(result.ok, true);

  const callShort = calls.find((c) => c.legRole === "call_short");
  const putShort = calls.find((c) => c.legRole === "put_short");
  const callLong = calls.find((c) => c.legRole === "call_long");
  const putLong = calls.find((c) => c.legRole === "put_long");

  // Shorts at MID
  assert.equal(callShort?.priceUsdcPerBtc, 90, "call_short should buyback at mid (90)");
  assert.equal(putShort?.priceUsdcPerBtc, 325, "put_short should buyback at mid (325)");
  // Longs keep legacy 0.25 — UNCHANGED behavior
  assert.equal(callLong?.priceUsdcPerBtc, 212.5, "call_long should sell at 0.25 fraction (212.5)");
  assert.equal(putLong?.priceUsdcPerBtc, 625, "put_long should sell at 0.25 fraction (625)");
});

test("PR-G2: VC_SPREAD_SHORT_BUYBACK_MID_FRACTION=0.25 reverts to legacy short-buyback price", async () => {
  clearEnv();
  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0.25";
  try {
    const structure = buildStructure();
    const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
    const result = await partialCloseSpreadOnTrigger({
      structure,
      adapter,
      triggerDirection: "high",
      sellLongsAtTriggerOverride: false
    });
    assert.equal(result.ok, true);

    const callShort = calls.find((c) => c.legRole === "call_short");
    const putShort = calls.find((c) => c.legRole === "put_short");
    // Legacy fraction → 0.25 inside the spread
    assert.equal(callShort?.priceUsdcPerBtc, 95, "call_short reverts to legacy (95)");
    assert.equal(putShort?.priceUsdcPerBtc, 337.5, "put_short reverts to legacy (337.5)");
  } finally {
    delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  }
});

test("PR-G2: VC_SPREAD_SHORT_BUYBACK_MID_FRACTION=0 crosses straight to ask on first attempt", async () => {
  clearEnv();
  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0";
  try {
    const structure = buildStructure();
    const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
    const result = await partialCloseSpreadOnTrigger({
      structure,
      adapter,
      triggerDirection: "low",
      sellLongsAtTriggerOverride: false
    });
    assert.equal(result.ok, true);

    const callShort = calls.find((c) => c.legRole === "call_short");
    const putShort = calls.find((c) => c.legRole === "put_short");
    // fraction=0 → improved attempt equals worst-case ask. The first
    // (improved) submission lands at ask, fills, no second submission.
    assert.equal(callShort?.priceUsdcPerBtc, 100, "call_short crosses to ask (100)");
    assert.equal(putShort?.priceUsdcPerBtc, 350, "put_short crosses to ask (350)");
  } finally {
    delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  }
});

test("PR-G2: short-buyback falls through to ask + deep-cross on Expired (parity with optimizer cascade)", async () => {
  clearEnv();
  // Confirm the cascade behavior: when MID expires, the optimizer falls
  // back to worst-case ask, and if THAT expires too AND deepCrossBps>0,
  // it walks to ask × (1 + bps/10000). With deepCrossBps unset (default 0),
  // we get only the two attempts (mid then ask).
  process.env.VC_FILL_OPTIMIZER_DEEP_CROSS_BPS = "500"; // 5% deep cross enabled
  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0.5";
  try {
    const structure = buildStructure();
    // Make the call_short symbol expire on attempts 1+2 then fill on attempt 3.
    const { adapter, calls } = buildMockAdapter({
      books: happyBooks(),
      submitOverrides: {
        "BTC-USDC-20260526-78000-C": (callIdx: number) => {
          if (callIdx <= 2) {
            return {
              filled: false,
              fillPriceUsdcPerBtc: 0,
              fillQtyBtc: 0,
              finalReason: "Expired",
              orderId: null
            };
          }
          return {
            filled: true,
            fillPriceUsdcPerBtc: 105, // deep cross fills at ask×1.05
            fillQtyBtc: 0.01,
            finalReason: "Executed",
            orderId: `ORD-deep-${callIdx}`
          };
        }
      }
    });
    const result = await partialCloseSpreadOnTrigger({
      structure,
      adapter,
      triggerDirection: "high",
      sellLongsAtTriggerOverride: false
    });
    assert.equal(result.ok, true);

    const callShortAttempts = calls.filter(
      (c) => c.legRole === "call_short"
    );
    assert.equal(callShortAttempts.length, 3, "should make 3 attempts (mid, ask, deep)");
    assert.equal(callShortAttempts[0].priceUsdcPerBtc, 90, "attempt 1 = mid");
    assert.equal(callShortAttempts[1].priceUsdcPerBtc, 100, "attempt 2 = worst-case ask");
    assert.equal(callShortAttempts[2].priceUsdcPerBtc, 105, "attempt 3 = ask × 1.05 (deep cross)");

    const closedShortCallShort = result.shortLegsClosed.find(
      (l) => l.legRole === "call_short"
    );
    assert.equal(
      closedShortCallShort?.fillPriceUsdcPerBtc,
      105,
      "fill records the deep-cross price"
    );
  } finally {
    delete process.env.VC_FILL_OPTIMIZER_DEEP_CROSS_BPS;
    delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  }
});

test("PR-G2: getShortBuybackMidFraction default is 0.5; env override honored; clamped to [0, 0.5]", () => {
  delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0.5, "default 0.5 when unset");

  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0.25";
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0.25, "honors 0.25");

  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0";
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0, "honors 0 (cross-ask immediately)");

  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "0.99"; // out of range
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0.5, "clamps above-bound to 0.5");

  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "-0.1"; // out of range
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0, "clamps below-bound to 0");

  process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION = "not-a-number";
  assert.equal(__testHelpers.getShortBuybackMidFraction(), 0.5, "falls back to default on garbage");

  delete process.env.VC_SPREAD_SHORT_BUYBACK_MID_FRACTION;
});

// ─── PR-Bundle-3-B (2026-05-25): long-trigger policy ─────────────────
//
// Validates the new 3-way `VC_SPREAD_LONG_TRIGGER_POLICY` env:
//   • winner_only (NEW DEFAULT): sell winner, retain loser
//   • both: legacy PR-C behavior
//   • none: legacy retain-all
// Plus the boolean back-compat shim (VC_SPREAD_SELL_LONGS_AT_TRIGGER).

const clearPolicyEnv = (): void => {
  delete process.env.VC_SPREAD_LONG_TRIGGER_POLICY;
  delete process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER;
};

test("PR-Bundle-3-B: getConfiguredLongTriggerPolicy default is 'winner_only' when both envs unset", () => {
  clearPolicyEnv();
  assert.equal(getConfiguredLongTriggerPolicy(), "winner_only");
});

test("PR-Bundle-3-B: VC_SPREAD_LONG_TRIGGER_POLICY env honored ('both' / 'winner_only' / 'none')", () => {
  clearPolicyEnv();
  try {
    process.env.VC_SPREAD_LONG_TRIGGER_POLICY = "both";
    assert.equal(getConfiguredLongTriggerPolicy(), "both");
    process.env.VC_SPREAD_LONG_TRIGGER_POLICY = "winner_only";
    assert.equal(getConfiguredLongTriggerPolicy(), "winner_only");
    process.env.VC_SPREAD_LONG_TRIGGER_POLICY = "none";
    assert.equal(getConfiguredLongTriggerPolicy(), "none");
  } finally {
    clearPolicyEnv();
  }
});

test("PR-Bundle-3-B: legacy VC_SPREAD_SELL_LONGS_AT_TRIGGER='false' maps to 'none' (back-compat)", () => {
  clearPolicyEnv();
  process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER = "false";
  try {
    assert.equal(getConfiguredLongTriggerPolicy(), "none");
  } finally {
    clearPolicyEnv();
  }
});

test("PR-Bundle-3-B: legacy VC_SPREAD_SELL_LONGS_AT_TRIGGER='true' maps to 'both' (back-compat)", () => {
  clearPolicyEnv();
  process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER = "true";
  try {
    assert.equal(getConfiguredLongTriggerPolicy(), "both");
  } finally {
    clearPolicyEnv();
  }
});

test("PR-Bundle-3-B: explicit policy env beats legacy boolean", () => {
  clearPolicyEnv();
  process.env.VC_SPREAD_LONG_TRIGGER_POLICY = "winner_only";
  process.env.VC_SPREAD_SELL_LONGS_AT_TRIGGER = "true"; // legacy says "both"
  try {
    assert.equal(
      getConfiguredLongTriggerPolicy(),
      "winner_only",
      "explicit policy env wins over legacy boolean"
    );
  } finally {
    clearPolicyEnv();
  }
});

test("PR-Bundle-3-B: garbage policy value silently falls back to default", () => {
  clearPolicyEnv();
  process.env.VC_SPREAD_LONG_TRIGGER_POLICY = "bananas";
  try {
    assert.equal(getConfiguredLongTriggerPolicy(), "winner_only");
  } finally {
    clearPolicyEnv();
  }
});

test("PR-Bundle-3-B partialClose: policy='winner_only' on HIGH trigger sells call_long, retains put_long", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    longTriggerPolicyOverride: "winner_only"
  });
  assert.equal(result.ok, true);
  assert.equal(result.shortLegsClosed.length, 2, "both shorts always close at trigger");
  assert.equal(result.longLegsSold.length, 1, "only winner sold");
  assert.equal(result.longLegsSold[0].legRole, "call_long");
  assert.equal(result.longLegsRetained.length, 1, "only loser retained");
  assert.equal(result.longLegsRetained[0].legRole, "put_long");

  // Sanity: only 3 venue submissions for the long-side at trigger
  // (2 short buybacks + 1 winner sell). put_long is NOT submitted.
  const winnerSells = calls.filter((c) => c.legRole === "call_long" && c.side === "SELL");
  const loserSells = calls.filter((c) => c.legRole === "put_long" && c.side === "SELL");
  assert.equal(winnerSells.length, 1, "exactly one call_long sell submitted");
  assert.equal(loserSells.length, 0, "no put_long sell submitted (loser retained)");

  // longLegProceedsUsdc should reflect ONLY the winner sale.
  const expectedWinnerProceeds =
    winnerSells[0].priceUsdcPerBtc * structure.contractsBtcPerLeg;
  assert.equal(
    result.longLegProceedsUsdc,
    Number(expectedWinnerProceeds.toFixed(4)),
    "long proceeds = winner only"
  );
});

test("PR-Bundle-3-B partialClose: policy='winner_only' on LOW trigger sells put_long, retains call_long", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "low",
    longTriggerPolicyOverride: "winner_only"
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 1);
  assert.equal(result.longLegsSold[0].legRole, "put_long");
  assert.equal(result.longLegsRetained.length, 1);
  assert.equal(result.longLegsRetained[0].legRole, "call_long");
});

test("PR-Bundle-3-B partialClose: policy='both' explicitly preserves PR-C parallel-sell behavior", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    longTriggerPolicyOverride: "both"
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 2);
  assert.equal(result.longLegsRetained.length, 0);
  const sortedRoles = result.longLegsSold.map((l) => l.legRole).sort();
  assert.deepEqual(sortedRoles, ["call_long", "put_long"]);
});

test("PR-Bundle-3-B partialClose: policy='none' retains both longs (legacy)", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter, calls } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    longTriggerPolicyOverride: "none"
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 0);
  assert.equal(result.longLegsRetained.length, 2);
  // No long sells submitted at all.
  const longSells = calls.filter(
    (c) => (c.legRole === "call_long" || c.legRole === "put_long") && c.side === "SELL"
  );
  assert.equal(longSells.length, 0);
});

test("PR-Bundle-3-B partialClose: legacy sellLongsAtTriggerOverride=false still maps to 'none'", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 0);
  assert.equal(result.longLegsRetained.length, 2);
});

test("PR-Bundle-3-B partialClose: explicit policyOverride beats legacy boolean override", async () => {
  clearEnv();
  clearPolicyEnv();
  const structure = buildStructure();
  const { adapter } = buildMockAdapter({ books: happyBooks() });
  const result = await partialCloseSpreadOnTrigger({
    structure,
    adapter,
    triggerDirection: "high",
    sellLongsAtTriggerOverride: true, // legacy says "both"
    longTriggerPolicyOverride: "winner_only" // explicit wins
  });
  assert.equal(result.ok, true);
  assert.equal(result.longLegsSold.length, 1);
  assert.equal(result.longLegsRetained.length, 1);
});

// ─── Bundle 4 (2026-05-25): rollback hardening + orphan detection ────

const clearRollbackEnv = (): void => {
  delete process.env.VC_ROLLBACK_DEEP_CROSS_BPS_MIN;
  delete process.env.VC_ROLLBACK_IMPROVEMENT_FRACTION;
};

test("Bundle 4: getConfiguredRollbackHardening returns floor defaults", () => {
  clearEnv();
  clearRollbackEnv();
  const cfg = getConfiguredRollbackHardening();
  assert.equal(cfg.improvementFraction, 0);
  assert.equal(cfg.deepCrossBpsFloor, 1000);
});

test("Bundle 4: getConfiguredRollbackHardening respects env overrides within hard caps", () => {
  clearEnv();
  clearRollbackEnv();
  process.env.VC_ROLLBACK_IMPROVEMENT_FRACTION = "0.25";
  process.env.VC_ROLLBACK_DEEP_CROSS_BPS_MIN = "500";
  try {
    const cfg = getConfiguredRollbackHardening();
    assert.equal(cfg.improvementFraction, 0.25);
    assert.equal(cfg.deepCrossBpsFloor, 500);
  } finally {
    clearRollbackEnv();
  }
});

test("Bundle 4: getConfiguredRollbackHardening clamps out-of-range env values", () => {
  clearEnv();
  clearRollbackEnv();
  process.env.VC_ROLLBACK_IMPROVEMENT_FRACTION = "0.9"; // > 0.5 cap
  process.env.VC_ROLLBACK_DEEP_CROSS_BPS_MIN = "5000"; // > 1000 cap
  try {
    const cfg = getConfiguredRollbackHardening();
    assert.equal(cfg.improvementFraction, 0.5);
    assert.equal(cfg.deepCrossBpsFloor, 1000);
  } finally {
    clearRollbackEnv();
  }
});

test("Bundle 4: rollback marks legs orphan when reverse IOCs all expire (typical Foxify-001 failure mode)", async () => {
  clearEnv();
  clearRollbackEnv();
  const structure = buildStructure();
  const books = happyBooks();
  // Set up an open path that fails on call_short, then ALL rollback IOCs
  // (across the 3 already-placed legs) expire — simulating thin-book
  // moments where neither worst-case nor deep-cross fills.
  const expiredOnAllRollbackCalls = (callIdx: number) => ({
    filled: false,
    fillPriceUsdcPerBtc: 0,
    fillQtyBtc: 0,
    finalReason: "Expired",
    orderId: `EXP-${callIdx}`
  });
  const { adapter, calls } = buildMockAdapter({
    books,
    submitOverrides: {
      // Open fails on call_short (any call returns Expired)
      "BTC-USDC-20260526-78000-C": expiredOnAllRollbackCalls,
      // Rollback fails on the 3 already-opened legs (all Expired)
      "BTC-USDC-20260526-77000-C": (callIdx) =>
        callIdx === 1
          ? // First call was the OPEN of call_long (must succeed for it to be
            // in `placed` and need rollback). Use defaults for the open.
            { filled: true, fillPriceUsdcPerBtc: 250, fillQtyBtc: 0.01, finalReason: "Executed", orderId: "OK-1" }
          : expiredOnAllRollbackCalls(callIdx),
      "BTC-USDC-20260526-75000-P": (callIdx) =>
        callIdx === 1
          ? { filled: true, fillPriceUsdcPerBtc: 700, fillQtyBtc: 0.01, finalReason: "Executed", orderId: "OK-2" }
          : expiredOnAllRollbackCalls(callIdx),
      "BTC-USDC-20260526-74000-P": (callIdx) =>
        callIdx === 1
          ? { filled: true, fillPriceUsdcPerBtc: 300, fillQtyBtc: 0.01, finalReason: "Executed", orderId: "OK-3" }
          : expiredOnAllRollbackCalls(callIdx)
    }
  });

  const result = await openSpread({ structure, adapter, skipLiquidityGate: true });

  assert.equal(result.ok, false);
  assert.equal(result.failedAt, "call_short");
  assert.equal(result.rollbackResults.length, 3);

  // Every rollback record should be marked orphan (all 3 legs failed
  // to unwind).
  for (const r of result.rollbackResults) {
    assert.equal(r.rollbackOrphan, true, `expected ${r.legRole} marked orphan`);
    assert.equal(r.isRollbackAttempt, true);
    assert.equal(r.fillQtyBtc, 0);
  }

  // Each rollback should have made >1 attempt at progressively worse
  // prices (worst-case + deep-cross at 10%). Verify the deep-cross
  // attempt happened by checking attemptedPrices.
  for (const r of result.rollbackResults) {
    assert.ok(
      r.attempts >= 2,
      `expected ${r.legRole} to have ≥2 attempts (worst-case + deep-cross), got ${r.attempts}`
    );
    assert.ok(
      r.attemptedPrices.length >= 2,
      `expected ${r.legRole} attemptedPrices to have ≥2 entries`
    );
  }

  // Deep-cross direction sanity:
  //   call_long was BUY → rollback SELL → deep cross should be BELOW worst-case bid
  const callLongRb = result.rollbackResults.find((r) => r.legRole === "call_long")!;
  const callLongPrices = callLongRb.attemptedPrices;
  assert.ok(
    callLongPrices[callLongPrices.length - 1] < callLongPrices[0],
    `expected deep-cross SELL price below worst-case bid; saw ${callLongPrices.join(",")}`
  );

  // put_short was SELL → rollback BUY → deep cross should be ABOVE worst-case ask
  const putShortRb = result.rollbackResults.find((r) => r.legRole === "put_short")!;
  const putShortPrices = putShortRb.attemptedPrices;
  assert.ok(
    putShortPrices[putShortPrices.length - 1] > putShortPrices[0],
    `expected deep-cross BUY price above worst-case ask; saw ${putShortPrices.join(",")}`
  );

  // Defensive sanity: there were rollback intent calls in the call log
  const rollbackCalls = calls.filter((c) => c.intent === "rollback");
  assert.ok(rollbackCalls.length >= 6, "expected ≥6 rollback IOCs (3 legs × ≥2 attempts each)");
});

test("Bundle 4: rollback succeeds → legs NOT marked orphan (negative case)", async () => {
  clearEnv();
  clearRollbackEnv();
  const structure = buildStructure();
  const books = happyBooks();
  // Open fails on call_short, but rollback IOCs for the 3 placed legs
  // succeed at worst-case price. Verify rollbackOrphan stays false.
  const { adapter } = buildMockAdapter({
    books,
    submitOverrides: {
      "BTC-USDC-20260526-78000-C": (callIdx) => ({
        filled: false,
        fillPriceUsdcPerBtc: 0,
        fillQtyBtc: 0,
        finalReason: "Expired",
        orderId: `EXP-CS-${callIdx}`
      })
    }
  });

  const result = await openSpread({ structure, adapter, skipLiquidityGate: true });

  assert.equal(result.ok, false);
  assert.equal(result.rollbackResults.length, 3);
  for (const r of result.rollbackResults) {
    // No orphan flag (legs successfully unwound at venue)
    assert.notEqual(r.rollbackOrphan, true);
    assert.equal(r.isRollbackAttempt, true);
    assert.ok(r.fillQtyBtc > 0, `expected ${r.legRole} to have non-zero fill`);
  }
});

test("Bundle 4: rollback marks orphan when book unavailable on a leg's symbol", async () => {
  clearEnv();
  clearRollbackEnv();
  const structure = buildStructure();
  const happy = happyBooks();
  const adapter: SpreadExecutorAdapter = {
    async getOrderbookTop({ symbol }): Promise<OrderbookTop> {
      // Open path: full books available
      // Rollback path: book disappears for call_long (first leg unwound)
      // We track call count via a closure since the mock doesn't pass call index.
      const tracker = (adapter as any)._rbCounter ?? new Map<string, number>();
      const n = (tracker.get(symbol) ?? 0) + 1;
      tracker.set(symbol, n);
      (adapter as any)._rbCounter = tracker;
      // First read of each symbol = open path → return book.
      // Subsequent reads (rollback) for call_long symbol → return null book.
      if (n > 1 && symbol === "BTC-USDC-20260526-77000-C") {
        return { topBidUsdc: null, topAskUsdc: null, bidQtyBtc: null, askQtyBtc: null };
      }
      const b = happy[symbol];
      return {
        topBidUsdc: b?.topBid ?? null,
        topAskUsdc: b?.topAsk ?? null,
        bidQtyBtc: 1,
        askQtyBtc: 1
      };
    },
    async submitIocLimit(p): Promise<ExecutorOrderResult> {
      // call_short open Expired → triggers rollback path
      if (p.symbol === "BTC-USDC-20260526-78000-C") {
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: "Expired",
          orderId: "EXP-CS"
        };
      }
      // All other submits succeed at limit (open + rollback alike)
      return {
        filled: true,
        fillPriceUsdcPerBtc: p.priceUsdcPerBtc,
        fillQtyBtc: p.quantityBtc,
        finalReason: "Executed",
        orderId: `OK-${p.symbol.slice(-5)}`
      };
    },
    resolveSymbol({ leg, expiryIso: e }) {
      const dt = e.slice(0, 10).replace(/-/g, "");
      const kind = leg.optionKind === "put" ? "P" : "C";
      return `BTC-USDC-${dt}-${leg.strikeActualUsdc}-${kind}`;
    }
  };

  const result = await openSpread({ structure, adapter, skipLiquidityGate: true });

  assert.equal(result.ok, false);
  // call_long rollback fails because its book disappeared → orphan
  const callLongRb = result.rollbackResults.find((r) => r.legRole === "call_long");
  assert.ok(callLongRb, "expected call_long in rollback results");
  assert.equal(callLongRb!.rollbackOrphan, true);
  assert.equal(callLongRb!.attempts, 0); // never tried (no book)

  // put_short and put_long should have rolled back successfully
  const putShortRb = result.rollbackResults.find((r) => r.legRole === "put_short")!;
  const putLongRb = result.rollbackResults.find((r) => r.legRole === "put_long")!;
  assert.notEqual(putShortRb.rollbackOrphan, true);
  assert.notEqual(putLongRb.rollbackOrphan, true);
});
