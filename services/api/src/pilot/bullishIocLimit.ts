/**
 * Shared Bullish IOC limit-order primitive used by BOTH:
 *   - the spread executor (`bullishSpreadAdapter.submitIocLimitAndPoll`)
 *     during 4-leg spread open / close / partial-close lifecycle, AND
 *   - the volumeCover hedge manager TP curve
 *     (`BullishTestnetAdapter.sellOption` in `pilot/venue.ts`) when
 *     selling a retained leg with a slippage-floor or market-style
 *     fallback.
 *
 * Why extracted (PR-B 2026-05-24):
 *   The spread adapter already had a hardened IOC helper (rate-limit
 *   abort, poll-timeout cancel, terminal-status detection, IOC TIF
 *   forcing). The pilot Bullish `sellOption` did NOT — it issued a raw
 *   `createSpotLimitOrder` at best-bid with the env-default TIF
 *   (which has historically been mis-set to GTC, leaving phantom
 *   resting orders) and ignored `orderType: "limit_ioc"` /
 *   `floorPriceUsdcPerBtc`. That is a real-money-loss path because
 *   any retained leg on Bullish landed in the TP curve fallback,
 *   silently downgrading every sell to an unprotected market sell.
 *
 *   This module is the single hardened code path. Both call sites map
 *   their input shapes onto it and translate the result back to their
 *   respective return contracts.
 *
 * Behavior contract:
 *   - `timeInForce: "IOC"` is ALWAYS forced. The `PILOT_BULLISH_ORDER_TIF`
 *     env value is intentionally ignored here — IOC is a precondition
 *     of every caller (spread atomicity + slippage floor).
 *   - On terminal CLOSED + Executed → `filled=true` with
 *     `fillQtyBtc>0`.
 *   - On terminal CLOSED + Expired (Bullish `statusReasonCode 6004`)
 *     → `filled=false`, `fillQtyBtc=0`, `finalReason="Expired"`. This
 *     is the expected outcome when an IOC limit SELL is at-or-above
 *     the best resting bid (i.e., the slippage floor wasn't crossed).
 *   - Bullish RATE_LIMIT_EXCEEDED (errorCode `96100`) during polling
 *     aborts the wait early — backing off the spread/leg is cheaper
 *     than queueing more polls.
 *   - Poll-timeout (no terminal status within
 *     `pollMaxAttempts × pollIntervalMs`) attempts a best-effort
 *     `cancelOrder`, then returns `filled=false` with
 *     `finalReason="poll_timeout (lastStatus=...)"`.
 *
 * Tick / qty formatting:
 *   The caller is responsible for tick-snapping the price (BUY: snap
 *   up; SELL/floor: snap up; market-style SELL at best-bid: snap
 *   down). This module only formats to fixed decimals — pricePrecision
 *   default 4 (BTC option), qtyPrecision default 2 (Bullish enforces
 *   0.01 BTC contract precision).
 */

import type { BullishTradingClient } from "./bullish";

/** Minimal client surface required by this primitive. */
export type BullishIocLimitClient = Pick<
  BullishTradingClient,
  "createSpotLimitOrder" | "getOrderStatus" | "cancelOrder"
>;

export type BullishIocLimitResult = {
  /** True iff the order reached terminal=CLOSED with non-zero fill and not Expired/Rejected. */
  filled: boolean;
  /** Weighted average fill price (USDC per BTC) reported by Bullish. 0 when not filled. */
  fillPriceUsdcPerBtc: number;
  /** Quantity actually filled (BTC). 0 when not filled. */
  fillQtyBtc: number;
  /** Bullish statusReason / status string captured at terminal. */
  finalReason: string;
  /** Bullish orderId once the create call returned. May be null on submit_error. */
  orderId: string | null;
  /** Last observed status string (e.g., PENDING_NEW → CLOSED). Diagnostic only. */
  lastObservedStatus: string;
  /** How many GET /orders/:id calls threw (rate limit, network) during polling. */
  pollErrorCount: number;
  /** Raw payload from terminal status (or createSpotLimitOrder on submit_error path). */
  raw: unknown;
};

export type BullishIocLimitParams = {
  client: BullishIocLimitClient;
  symbol: string;
  side: "BUY" | "SELL";
  /**
   * Limit price in USDC per BTC. Caller must pre-snap to the venue
   * tick grid ($10 USDC for BTC options). For SELL with a slippage
   * floor, snap UP from the floor (we never accept a fill below the
   * floor); for SELL market-style at best-bid, snap DOWN; for BUY,
   * snap UP from the worst-acceptable price.
   */
  priceUsdcPerBtc: number;
  /** Quantity in BTC. Will be floored to qtyPrecision (default 2). */
  quantityBtc: number;
  /** Caller-generated numeric clientOrderId (Bullish 6104 on non-numeric). */
  clientOrderId: string;
  /**
   * tradingAccountId for `GET /orders/:id` polling. Bullish 404s
   * without this. Resolved from the runtime config by the caller.
   */
  tradingAccountId: string;
  /** Decimal places for price (default 4). */
  pricePrecision?: number;
  /** Decimal places for qty, floored (default 2). */
  qtyPrecision?: number;
  /** Poll cadence in ms (default 500). */
  pollIntervalMs?: number;
  /** Poll attempts ceiling (default 60 → 30s wall at 500ms). */
  pollMaxAttempts?: number;
  /** Tag prefix used in console logs to distinguish call sites. */
  logPrefix?: string;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_PRICE_PRECISION = 4;
const DEFAULT_QTY_PRECISION = 2;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_MAX_ATTEMPTS = 60; // 30s ceiling at 500ms

const formatPriceFixed = (priceUsdc: number, precision: number): string =>
  priceUsdc.toFixed(precision);

const formatQtyFloor = (qtyBtc: number, precision: number): string => {
  const factor = Math.pow(10, precision);
  const floored = Math.floor(qtyBtc * factor) / factor;
  return floored.toFixed(precision);
};

export const executeBullishIocLimit = async (
  params: BullishIocLimitParams
): Promise<BullishIocLimitResult> => {
  const tag = params.logPrefix ?? "[bullishIocLimit]";
  const pricePrecision = params.pricePrecision ?? DEFAULT_PRICE_PRECISION;
  const qtyPrecision = params.qtyPrecision ?? DEFAULT_QTY_PRECISION;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollMaxAttempts = params.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;

  const formattedPrice = formatPriceFixed(params.priceUsdcPerBtc, pricePrecision);
  const formattedQty = formatQtyFloor(params.quantityBtc, qtyPrecision);

  let createResp: unknown = null;
  let createErr: Error | null = null;
  try {
    createResp = await params.client.createSpotLimitOrder({
      symbol: params.symbol,
      side: params.side,
      price: formattedPrice,
      quantity: formattedQty,
      clientOrderId: params.clientOrderId,
      // Forced IOC. See module docstring — every caller of this
      // primitive needs IOC semantics regardless of env defaults.
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
      lastObservedStatus: "SUBMIT_ERROR",
      pollErrorCount: 0,
      raw: { error: createErr.message }
    };
  }

  const orderId =
    (createResp as Record<string, unknown> | null)?.orderId?.toString() ?? null;
  if (!orderId) {
    return {
      filled: false,
      fillPriceUsdcPerBtc: 0,
      fillQtyBtc: 0,
      finalReason: "no_order_id_in_response",
      orderId: null,
      lastObservedStatus: "NO_ORDER_ID",
      pollErrorCount: 0,
      raw: createResp
    };
  }

  let lastObservedStatus = "PENDING_NEW";
  let pollErrorCount = 0;

  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    await sleep(pollIntervalMs);
    try {
      const status = await params.client.getOrderStatus(orderId, {
        tradingAccountId: params.tradingAccountId
      });
      const statusUpper = String(status.status).toUpperCase();
      lastObservedStatus = statusUpper;
      const raw = status.raw as Record<string, unknown> | undefined;
      const statusReason = String(raw?.statusReason ?? "").toLowerCase();
      const statusReasonCode = String(raw?.statusReasonCode ?? "");
      const isTerminal =
        statusUpper === "CLOSED" ||
        statusUpper === "REJECTED" ||
        statusUpper === "CANCELLED" ||
        statusUpper === "FILLED";
      if (!isTerminal) {
        if (attempt % 10 === 0) {
          console.log(
            `${tag} poll attempt=${attempt} orderId=${orderId} status=${statusUpper} (continuing)`
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
        `${tag} terminal orderId=${orderId} status=${statusUpper} ` +
          `fillQty=${fillQty} fillPrice=${fillPrice} reason=${statusReason || "n/a"}`
      );
      return {
        filled: fillQty > 0 && !wasExpired && !wasRejected,
        fillPriceUsdcPerBtc: fillPrice,
        fillQtyBtc: fillQty,
        finalReason: (raw?.statusReason as string | undefined) ?? statusUpper,
        orderId,
        lastObservedStatus: statusUpper,
        pollErrorCount,
        raw: status.raw
      };
    } catch (err) {
      pollErrorCount++;
      const errMsg = (err as Error).message;
      // Surface rate-limit errors immediately — they won't self-resolve
      // by polling more; back off the whole spread/leg instead.
      if (errMsg.includes("96100") || errMsg.includes("RATE_LIMIT_EXCEEDED")) {
        console.warn(
          `${tag} RATE_LIMIT polling orderId=${orderId} attempt=${attempt} — aborting poll early`
        );
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: `poll_rate_limit: ${errMsg}`,
          orderId,
          lastObservedStatus,
          pollErrorCount,
          raw: { error: errMsg, attempt }
        };
      }
      if (attempt === pollMaxAttempts - 1) {
        return {
          filled: false,
          fillPriceUsdcPerBtc: 0,
          fillQtyBtc: 0,
          finalReason: `poll_error: ${errMsg}`,
          orderId,
          lastObservedStatus,
          pollErrorCount,
          raw: { error: errMsg, pollErrorCount }
        };
      }
    }
  }

  // Timed out without ever seeing a terminal status. The order MIGHT
  // have filled and Bullish just hasn't propagated the status into
  // GET /orders/:id yet. Attempt best-effort cancel so the order
  // doesn't sit on the book past its IOC intent — this also surfaces
  // any actual fill state via the cancel response on some venues.
  console.warn(
    `${tag} POLL_TIMEOUT orderId=${orderId} lastObservedStatus=${lastObservedStatus} ` +
      `pollErrorCount=${pollErrorCount}. Attempting best-effort cancel.`
  );
  try {
    await params.client.cancelOrder({ symbol: params.symbol, orderId });
  } catch (cancelErr) {
    console.warn(
      `${tag} cancel after timeout failed orderId=${orderId}: ${(cancelErr as Error).message}`
    );
  }

  return {
    filled: false,
    fillPriceUsdcPerBtc: 0,
    fillQtyBtc: 0,
    finalReason: `poll_timeout (lastStatus=${lastObservedStatus})`,
    orderId,
    lastObservedStatus,
    pollErrorCount,
    raw: { lastObservedStatus, pollErrorCount }
  };
};

/**
 * Bullish BTC option tick size ($10 USDC per BTC). Bullish rejects
 * non-tick prices with PRICE_MUST_BE_OF_TICK_SIZE 6018.
 */
export const BTC_OPTION_TICK_USDC = 10;

/** Snap a price up to the next tick (use for: BUY any, SELL with floor). */
export const snapTickCeil = (
  px: number,
  tick: number = BTC_OPTION_TICK_USDC
): number => {
  if (px <= 0) return 0;
  const n = px / tick;
  return (Number.isInteger(n) ? n : Math.floor(n) + 1) * tick;
};

/** Snap a price down to the previous tick (use for: market-style SELL at best-bid). */
export const snapTickFloor = (
  px: number,
  tick: number = BTC_OPTION_TICK_USDC
): number => {
  if (px <= 0) return 0;
  const n = px / tick;
  const r = Math.floor(n);
  return (r < 1 ? 1 : r) * tick;
};
