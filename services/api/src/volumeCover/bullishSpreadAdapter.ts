/**
 * Bullish concrete implementation of `SpreadExecutorAdapter`.
 *
 * Wraps the existing `getSharedBullishClient` (the same client used by
 * the admin /bullish-test-buy and /bullish-test-sell endpoints that
 * E1/E2/E3/E5 microtests proved out) and presents the venue-agnostic
 * surface that `spreadExecutor.ts` consumes.
 *
 * Key responsibilities:
 *   - Orderbook reads via `getHybridOrderBook`
 *   - IOC limit submission via `createSpotLimitOrder` + status polling
 *     until terminal (CLOSED + Executed/Expired/Rejected)
 *   - Option symbol resolution for `BTC-USDC-YYYYMMDD-STRIKE-(P|C)`
 *
 * Verified-empirically Bullish quirks captured here:
 *   - Tick size is $10 USDC per BTC for BTC options ($5 rejects with
 *     PRICE_MUST_BE_OF_TICK_SIZE 6018)
 *   - Quantity is 0.01-precision contracts ("0.10" wire format)
 *   - IOC fully-filled → status="CLOSED" reasonCode=6002 (Executed)
 *   - IOC unfilled    → status="CLOSED" reasonCode=6004 (Expired)
 *   - clientOrderId MUST be numeric (string of digits)
 */

import type {
  SpreadExecutorAdapter,
  OrderbookTop,
  ExecutorOrderResult
} from "./spreadExecutor";
import type { SpreadLegSpec } from "./spreadHedge";
import { getSharedBullishClient } from "../pilot/bullishClient";
import { pilotConfig } from "../pilot/config";

// ─── Constants validated empirically 2026-05-23 ──────────────────────
const BTC_OPTION_TICK_USDC = 10;
// 2026-05-23 (post-mortem): live's first activation hit poll_timeout at
// 10s. Live Render region → Bullish has higher latency than shadow.
// Increased poll time to 30s and interval to 500ms (so 60 attempts at
// 500ms = 30s ceiling) to give Bullish time to settle the order. IOC
// orders STILL fill in <100ms in practice; this only matters when the
// status-feed propagation lags.
const ORDER_STATUS_POLL_INTERVAL_MS = 500;
const ORDER_STATUS_POLL_MAX_ATTEMPTS = 60; // 30s total ceiling
const ORDERBOOK_TIMEOUT_MS = 5000;

// ─── Tick snapping ───────────────────────────────────────────────────
const snapTickCeil = (px: number, tick = BTC_OPTION_TICK_USDC): number => {
  if (px <= 0) return 0;
  const n = px / tick;
  return (Number.isInteger(n) ? n : Math.floor(n) + 1) * tick;
};

const snapTickFloor = (px: number, tick = BTC_OPTION_TICK_USDC): number => {
  if (px <= 0) return 0;
  const n = px / tick;
  const r = Math.floor(n);
  return (r < 1 ? 1 : r) * tick;
};

// ─── Symbol resolution ───────────────────────────────────────────────
// Bullish option symbol format: BTC-USDC-YYYYMMDD-STRIKE-(P|C)
const formatExpiryYyyymmdd = (expiryIso: string): string => {
  const d = new Date(expiryIso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`bullishSpreadAdapter: invalid expiryIso ${expiryIso}`);
  }
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
};

const resolveBullishSymbol = (params: {
  leg: SpreadLegSpec;
  expiryIso: string;
}): string => {
  const yyyymmdd = formatExpiryYyyymmdd(params.expiryIso);
  const strikeInt = Math.round(params.leg.strikeActualUsdc);
  const optionKindChar = params.leg.optionKind === "put" ? "P" : "C";
  return `BTC-USDC-${yyyymmdd}-${strikeInt}-${optionKindChar}`;
};

// ─── Quantity + price formatting ─────────────────────────────────────
const formatQty = (contractsBtc: number): string => {
  // Bullish enforces 0.01 BTC precision on option contracts.
  const floored = Math.floor(contractsBtc * 100) / 100;
  return floored.toFixed(2);
};

const formatPrice = (priceUsdc: number): string => priceUsdc.toFixed(4);

// ─── Order submission + polling ──────────────────────────────────────
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const submitIocLimitAndPoll = async (params: {
  symbol: string;
  side: "BUY" | "SELL";
  priceUsdcPerBtc: number;
  quantityBtc: number;
  clientOrderId: string;
}): Promise<ExecutorOrderResult> => {
  const client = getSharedBullishClient(pilotConfig.bullish);
  const formattedPrice = formatPrice(params.priceUsdcPerBtc);
  const formattedQty = formatQty(params.quantityBtc);

  let createResp: unknown = null;
  let createErr: Error | null = null;
  try {
    createResp = await client.createSpotLimitOrder({
      symbol: params.symbol,
      side: params.side,
      price: formattedPrice,
      quantity: formattedQty,
      clientOrderId: params.clientOrderId,
      // 2026-05-23 (live-smoke-002 post-mortem): Force IOC regardless
      // of PILOT_BULLISH_ORDER_TIF env. Spread executor's atomicity
      // and rollback logic depend on IOC semantics — a DAY/GTC leg
      // sitting open on the book breaks rollback (we can't rollback
      // a "partial" position that's still trying to fill) and creates
      // phantom legs. Live had GTC set by accident, hence lastStatus=OPEN.
      timeInForce: "IOC"
    });
  } catch (err) {
    createErr = err as Error;
  }

  if (createErr) {
    return {
      filled: false,
      fillPriceUsdcPerBtc: 0,
      fillQtyBtc: 0,
      finalReason: `submit_error: ${createErr.message}`,
      orderId: null,
      raw: { error: createErr.message }
    };
  }

  const orderId =
    (createResp as Record<string, unknown> | null)?.orderId
      ?.toString() ?? null;
  if (!orderId) {
    return {
      filled: false,
      fillPriceUsdcPerBtc: 0,
      fillQtyBtc: 0,
      finalReason: "no_order_id_in_response",
      orderId: null,
      raw: createResp
    };
  }

  // Poll until terminal status. Pass tradingAccountId explicitly:
  // Bullish's GET /orders/:id is scoped per account. Without it,
  // Bullish 404s even for orders our auth context placed.
  const tradingAccountId = pilotConfig.bullish.tradingAccountId;
  let lastObservedStatus = "PENDING_NEW";
  let pollErrorCount = 0;

  for (let attempt = 0; attempt < ORDER_STATUS_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(ORDER_STATUS_POLL_INTERVAL_MS);
    try {
      const c = getSharedBullishClient(pilotConfig.bullish);
      const status = await c.getOrderStatus(orderId, { tradingAccountId });
      const statusUpper = String(status.status).toUpperCase();
      lastObservedStatus = statusUpper;
      const raw = status.raw as Record<string, unknown> | undefined;
      const statusReason = String(
        (raw?.statusReason ?? "") || ""
      ).toLowerCase();
      const statusReasonCode = String(raw?.statusReasonCode ?? "");
      const isTerminal =
        statusUpper === "CLOSED" ||
        statusUpper === "REJECTED" ||
        statusUpper === "CANCELLED" ||
        statusUpper === "FILLED";
      if (!isTerminal) {
        if (attempt % 10 === 0) {
          console.log(
            `[bullishSpreadAdapter] poll attempt=${attempt} orderId=${orderId} ` +
              `status=${statusUpper} (continuing)`
          );
        }
        continue;
      }
      const fillQty = Number(status.fillQuantity || 0);
      const fillPrice = Number(status.fillPrice || 0);
      const wasExpired =
        statusReason === "expired" || statusReasonCode === "6004";
      const wasRejected =
        statusReason === "rejected" || statusUpper === "REJECTED";
      console.log(
        `[bullishSpreadAdapter] terminal orderId=${orderId} status=${statusUpper} ` +
          `fillQty=${fillQty} fillPrice=${fillPrice} reason=${statusReason || "n/a"}`
      );
      return {
        filled: fillQty > 0 && !wasExpired && !wasRejected,
        fillPriceUsdcPerBtc: fillPrice,
        fillQtyBtc: fillQty,
        finalReason: (raw?.statusReason as string | undefined) ?? statusUpper,
        orderId,
        raw: status.raw
      };
    } catch (err) {
      pollErrorCount++;
      const errMsg = (err as Error).message;
      // Surface rate-limit errors immediately — they won't self-resolve
      // by polling more; back off the whole spread instead.
      if (errMsg.includes("96100") || errMsg.includes("RATE_LIMIT_EXCEEDED")) {
        console.warn(
          `[bullishSpreadAdapter] RATE_LIMIT polling orderId=${orderId} attempt=${attempt} — aborting poll early`
        );
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: `poll_rate_limit: ${errMsg}`,
          orderId,
          raw: { error: errMsg, attempt }
        };
      }
      if (attempt === ORDER_STATUS_POLL_MAX_ATTEMPTS - 1) {
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: `poll_error: ${errMsg}`,
          orderId,
          raw: { error: errMsg, pollErrorCount }
        };
      }
    }
  }

  // Timed out without ever seeing a terminal status. The order MIGHT
  // have filled and Bullish just hasn't propagated the status into
  // GET /orders/:id yet. Attempt best-effort cancel so the order
  // doesn't sit on the book past IOC — also surfaces any actual
  // fill state via the cancel response on some venues.
  console.warn(
    `[bullishSpreadAdapter] POLL_TIMEOUT orderId=${orderId} lastObservedStatus=${lastObservedStatus} ` +
      `pollErrorCount=${pollErrorCount}. Attempting best-effort cancel.`
  );
  try {
    const c = getSharedBullishClient(pilotConfig.bullish);
    await c.cancelOrder({ symbol: params.symbol, orderId });
  } catch (cancelErr) {
    console.warn(
      `[bullishSpreadAdapter] cancel after timeout failed orderId=${orderId}: ${(cancelErr as Error).message}`
    );
  }

  return {
    filled: false,
    fillPriceUsdcPerBtc: 0,
    fillQtyBtc: 0,
    finalReason: `poll_timeout (lastStatus=${lastObservedStatus})`,
    orderId,
    raw: { lastObservedStatus, pollErrorCount }
  };
};

// ─── Public adapter ──────────────────────────────────────────────────
export const createBullishSpreadAdapter = (): SpreadExecutorAdapter => {
  return {
    async getOrderbookTop(params): Promise<OrderbookTop> {
      const client = getSharedBullishClient(pilotConfig.bullish);
      try {
        const book = await client.getHybridOrderBook(params.symbol);
        const topBid = book.bids?.[0];
        const topAsk = book.asks?.[0];
        return {
          topBidUsdc: topBid ? Number(topBid.price) : null,
          topAskUsdc: topAsk ? Number(topAsk.price) : null,
          bidQtyBtc: topBid ? Number(topBid.quantity) : null,
          askQtyBtc: topAsk ? Number(topAsk.quantity) : null
        };
      } catch {
        return {
          topBidUsdc: null,
          topAskUsdc: null,
          bidQtyBtc: null,
          askQtyBtc: null
        };
      }
    },

    async submitIocLimit(params): Promise<ExecutorOrderResult> {
      // Snap price to tick grid. BUY → ceil (don't undershoot the
      // ask). SELL → floor (don't overshoot the bid).
      const snappedPrice =
        params.side === "BUY"
          ? snapTickCeil(params.priceUsdcPerBtc)
          : snapTickFloor(params.priceUsdcPerBtc);

      // Numeric client order ID (Bullish error 6104 on non-numeric).
      // Embed the spread group ID prefix in the metadata via clientOrderId
      // is not possible since it must be numeric; the spreadExecutor
      // already tracks spreadGroupId in its own state.
      const clientOrderId = String(
        BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999))
      );

      return await submitIocLimitAndPoll({
        symbol: params.symbol,
        side: params.side,
        priceUsdcPerBtc: snappedPrice,
        quantityBtc: params.quantityBtc,
        clientOrderId
      });
    },

    resolveSymbol: resolveBullishSymbol
  };
};

// Eager-allocated singleton so we don't re-construct on every spread.
let _adapter: SpreadExecutorAdapter | null = null;
export const getBullishSpreadAdapter = (): SpreadExecutorAdapter => {
  if (!_adapter) _adapter = createBullishSpreadAdapter();
  return _adapter;
};

// Re-export tick helpers for tests + callers.
export const __testHelpers = {
  snapTickCeil,
  snapTickFloor,
  formatQty,
  formatPrice,
  formatExpiryYyyymmdd,
  resolveBullishSymbol
};

void ORDERBOOK_TIMEOUT_MS;
