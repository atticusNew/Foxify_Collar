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
import {
  executeBullishIocLimit,
  snapTickCeil,
  snapTickFloor
} from "../pilot/bullishIocLimit";

// 2026-05-23 (post-mortem): live's first activation hit poll_timeout at
// 10s. Live Render region → Bullish has higher latency than shadow.
// Increased poll time to 30s and interval to 500ms (so 60 attempts at
// 500ms = 30s ceiling) to give Bullish time to settle the order. IOC
// orders STILL fill in <100ms in practice; this only matters when the
// status-feed propagation lags.
//
// PR-B (2026-05-24): tick + IOC primitive moved to
// `pilot/bullishIocLimit.ts` so the same hardened code path is shared
// with `BullishTestnetAdapter.sellOption` (TP curve fallback). These
// constants stay here because the spread-side ceiling is a separate
// tunable from the per-leg sell-side ceiling.
const ORDER_STATUS_POLL_INTERVAL_MS = 500;
const ORDER_STATUS_POLL_MAX_ATTEMPTS = 60; // 30s total ceiling
const ORDERBOOK_TIMEOUT_MS = 5000;

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
//
// The hardened IOC primitive (create + poll + cancel-on-timeout +
// rate-limit abort + IOC TIF forcing) lives in `pilot/bullishIocLimit.ts`.
// This thin wrapper preserves the SpreadExecutorAdapter contract by
// translating the shared result shape into `ExecutorOrderResult`.
//
// PR-B (2026-05-24): pre-extraction this logic was duplicated inline;
// `BullishTestnetAdapter.sellOption` for the TP curve fallback now
// uses the SAME primitive, ensuring slippage-floor + IOC semantics
// are consistent across spread + per-leg sell paths.
const submitIocLimitAndPoll = async (params: {
  symbol: string;
  side: "BUY" | "SELL";
  priceUsdcPerBtc: number;
  quantityBtc: number;
  clientOrderId: string;
}): Promise<ExecutorOrderResult> => {
  const client = getSharedBullishClient(pilotConfig.bullish);
  const result = await executeBullishIocLimit({
    client,
    symbol: params.symbol,
    side: params.side,
    priceUsdcPerBtc: params.priceUsdcPerBtc,
    quantityBtc: params.quantityBtc,
    clientOrderId: params.clientOrderId,
    tradingAccountId: pilotConfig.bullish.tradingAccountId,
    pricePrecision: 4,
    qtyPrecision: 2,
    pollIntervalMs: ORDER_STATUS_POLL_INTERVAL_MS,
    pollMaxAttempts: ORDER_STATUS_POLL_MAX_ATTEMPTS,
    logPrefix: "[bullishSpreadAdapter]"
  });
  return {
    filled: result.filled,
    fillPriceUsdcPerBtc: result.fillPriceUsdcPerBtc,
    fillQtyBtc: result.fillQtyBtc,
    finalReason: result.finalReason,
    orderId: result.orderId,
    raw: result.raw
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
