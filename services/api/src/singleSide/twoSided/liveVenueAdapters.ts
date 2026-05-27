/**
 * Live venue adapters — wrap the existing Bullish + Deribit primitives in the
 * BullishLegClient / DeribitLegClient interfaces consumed by LiveStrangleExecutor
 * and LiveCloseExecutor.
 *
 * These adapters are NOT unit-tested with mocks — the LiveStrangleExecutor tests
 * use simpler in-test mock adapters. These are operational shims that thread
 * venue clients into the executor; their real validation comes via the live
 * shadow microtest sequence (PR A10).
 *
 * Both adapters return LegExecutionResult — a unified shape per executor.ts.
 */

import type { LegExecutionResult } from "./executor";
import type { BullishLegBuyRequest, BullishLegClient, BullishLegSellRequest, DeribitLegBuyRequest, DeribitLegClient, DeribitLegSellRequest } from "./liveStrangleExecutor";
import { executeBullishIocLimit, type BullishIocLimitClient } from "../../pilot/bullishIocLimit";

// ────────────────────────── Bullish adapter ──────────────────────────
//
// Wraps services/api/src/pilot/bullishIocLimit.ts::executeBullishIocLimit.
// The IOC primitive handles create + poll + cancel-if-pending internally.

export type BullishLegAdapterOpts = {
  tradingAccountId: string;
  pollIntervalMs?: number;
  pollMaxAttempts?: number; // default 16 → 8s ceiling at 500ms
  pricePrecision?: number;
  qtyPrecision?: number;
  /** Bullish tick is $10 USDC for BTC options — caller snaps before passing. */
};

const POLL_CEILING_MS = 8_000;
const DEFAULT_POLL_INTERVAL = 500;
const DEFAULT_POLL_ATTEMPTS = POLL_CEILING_MS / DEFAULT_POLL_INTERVAL; // 16

const snapPriceUpUsdc = (px: number, tick = 10): number => Math.ceil(px / tick) * tick;
const snapPriceDownUsdc = (px: number, tick = 10): number => Math.floor(px / tick) * tick;

export class BullishLegAdapter implements BullishLegClient {
  constructor(
    private readonly client: BullishIocLimitClient,
    private readonly opts: BullishLegAdapterOpts
  ) {}

  async buyLeg(req: BullishLegBuyRequest): Promise<LegExecutionResult> {
    // Bullish requires numeric clientOrderId; map UUID-ish to numeric via hash
    const numericClientOrderId = String(Math.abs(hashString(req.clientOrderId)) % 1_000_000_000_000);
    const limitPx = snapPriceUpUsdc(req.maxAcceptableAskUsdcPerBtc);
    const result = await executeBullishIocLimit({
      client: this.client,
      symbol: req.symbol,
      side: "BUY",
      priceUsdcPerBtc: limitPx,
      quantityBtc: req.contractsBtc,
      clientOrderId: numericClientOrderId,
      tradingAccountId: this.opts.tradingAccountId,
      pollIntervalMs: this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL,
      pollMaxAttempts: this.opts.pollMaxAttempts ?? DEFAULT_POLL_ATTEMPTS,
      pricePrecision: this.opts.pricePrecision,
      qtyPrecision: this.opts.qtyPrecision,
      logPrefix: `[bullishBuy ${req.symbol}]`
    });
    if (!result.filled || result.fillQtyBtc <= 0) {
      return { ok: false, reason: "venue_error", detail: `Bullish buy not filled: ${result.finalReason} (last=${result.lastObservedStatus})` };
    }
    return {
      ok: true,
      filledAskUsdcPerBtc: result.fillPriceUsdcPerBtc,
      filledAtIso: new Date().toISOString()
    };
  }

  async sellLeg(req: BullishLegSellRequest): Promise<LegExecutionResult> {
    const numericClientOrderId = String(Math.abs(hashString(req.clientOrderId)) % 1_000_000_000_000);
    // Snap floor UP so we never accept a fill below caller's slippage floor
    const limitPx = req.minAcceptableBidUsdcPerBtc > 0
      ? snapPriceUpUsdc(req.minAcceptableBidUsdcPerBtc)
      : 10; // best-effort reverse — accept any clearing price; floor at $10 (one tick)
    const result = await executeBullishIocLimit({
      client: this.client,
      symbol: req.symbol,
      side: "SELL",
      priceUsdcPerBtc: limitPx,
      quantityBtc: req.contractsBtc,
      clientOrderId: numericClientOrderId,
      tradingAccountId: this.opts.tradingAccountId,
      pollIntervalMs: this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL,
      pollMaxAttempts: this.opts.pollMaxAttempts ?? DEFAULT_POLL_ATTEMPTS,
      pricePrecision: this.opts.pricePrecision,
      qtyPrecision: this.opts.qtyPrecision,
      logPrefix: `[bullishSell ${req.symbol}]`
    });
    if (!result.filled || result.fillQtyBtc <= 0) {
      return { ok: false, reason: "venue_error", detail: `Bullish sell not filled: ${result.finalReason} (last=${result.lastObservedStatus})` };
    }
    return {
      ok: true,
      filledAskUsdcPerBtc: result.fillPriceUsdcPerBtc, // really fill price; same field name for both directions
      filledAtIso: new Date().toISOString()
    };
  }
}

// ────────────────────────── Deribit adapter ──────────────────────────
//
// Wraps services/connectors/src/deribitConnector.ts::DeribitConnector.placeOrder
// with our LegExecutionResult shape. Deribit places limit-IOC orders that fill-or-cancel.

export type DeribitClientLike = {
  placeOrder: (req: {
    instrument: string;
    amount: number;
    side: "buy" | "sell";
    type?: "limit" | "market";
    price?: number;
    timeInForce?: "immediate_or_cancel" | "fill_or_kill" | "good_til_cancelled" | "good_til_day";
  }) => Promise<unknown>;
};

export class DeribitLegAdapter implements DeribitLegClient {
  constructor(private readonly client: DeribitClientLike) {}

  async buyLeg(req: DeribitLegBuyRequest): Promise<LegExecutionResult> {
    // Deribit option prices are quoted in BTC per option. amount = contracts (BTC notional).
    // For buy: limit price = max acceptable per BTC, converted to BTC-quoted price by
    // dividing by Deribit's underlying. For simplicity in this adapter we pass USD price
    // and let DeribitConnector interpret it appropriately at the venue layer; production
    // wiring should pre-convert via the underlying price.
    // NOTE: For Phase 0 microtests, we trust the caller to have computed a Deribit-native
    // price already. The full bid/ask units handling is in PR C1 (smile model).
    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount: req.contractsBtc,
        side: "buy",
        type: "limit",
        price: req.maxAcceptableAskUsdcPerBtc,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };
      // Paper-mode response
      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return { ok: true, filledAskUsdcPerBtc: resp.fillPrice, filledAtIso: new Date().toISOString() };
      }
      // Live response shape: result.order.{order_state, average_price, filled_amount}
      const order = resp?.result?.order;
      if (!order) {
        return { ok: false, reason: "venue_error", detail: `Deribit response missing order field: ${JSON.stringify(resp).slice(0, 200)}` };
      }
      const state = order.order_state;
      if (state !== "filled" || !order.average_price || !order.filled_amount) {
        return { ok: false, reason: "venue_error", detail: `Deribit order not filled: state=${state}` };
      }
      return {
        ok: true,
        filledAskUsdcPerBtc: order.average_price,
        filledAtIso: new Date().toISOString()
      };
    } catch (e) {
      return { ok: false, reason: "venue_error", detail: `Deribit buy threw: ${(e as Error).message}` };
    }
  }

  async sellLeg(req: DeribitLegSellRequest): Promise<LegExecutionResult> {
    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount: req.contractsBtc,
        side: "sell",
        type: "limit",
        price: req.minAcceptableBidUsdcPerBtc > 0 ? req.minAcceptableBidUsdcPerBtc : 0.0001,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };
      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return { ok: true, filledAskUsdcPerBtc: resp.fillPrice, filledAtIso: new Date().toISOString() };
      }
      const order = resp?.result?.order;
      if (!order || order.order_state !== "filled" || !order.average_price || !order.filled_amount) {
        return { ok: false, reason: "venue_error", detail: `Deribit sell not filled: state=${order?.order_state}` };
      }
      return { ok: true, filledAskUsdcPerBtc: order.average_price, filledAtIso: new Date().toISOString() };
    } catch (e) {
      return { ok: false, reason: "venue_error", detail: `Deribit sell threw: ${(e as Error).message}` };
    }
  }
}

// ────────────────────────── Utilities ──────────────────────────

/** Deterministic non-crypto hash for converting UUID client order IDs into numeric IDs that Bullish accepts. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
