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

/**
 * DeribitLegAdapter — bridges USDC-per-option pricing (our internal model)
 * to BTC-per-option pricing (Deribit's native quote unit).
 *
 * Deribit option prices are quoted in BTC per option, NOT USDC.
 * Example: BTC-31MAY26-72000-P at "price 0.005" means 0.005 BTC per contract,
 * which at spot $73,500 = $367.50 per contract.
 *
 * Our internal cost model speaks USDC/BTC throughout (cell costs, EV, etc).
 * This adapter converts at the venue boundary:
 *   - Outbound: USDC limit → BTC limit (divide by spot)
 *   - Inbound:  BTC fill → USDC fill (multiply by spot)
 *
 * Spot is provided via callback so it's always current (not snapshotted at
 * adapter construction). Adapter calls getCurrentSpotUsd() at the moment
 * each order fires.
 *
 * Tick precision: Deribit option tick is 0.0001 BTC. We round limit UP for
 * buys (ensure crossable) and DOWN for sells.
 */
export type DeribitLegAdapterOpts = {
  /** Called at order time to get current BTC/USDC spot for USDC↔BTC conversion. */
  getCurrentSpotUsd: () => number | null;
  /** Deribit option price tick (default 0.0001 BTC). */
  priceTickBtc?: number;
};

const DEFAULT_DERIBIT_PRICE_TICK_BTC = 0.0001;

const snapUpToTick = (px: number, tick: number): number => Math.ceil(px / tick) * tick;
const snapDownToTick = (px: number, tick: number): number => Math.floor(px / tick) * tick;

export class DeribitLegAdapter implements DeribitLegClient {
  constructor(
    private readonly client: DeribitClientLike,
    private readonly opts: DeribitLegAdapterOpts
  ) {}

  async buyLeg(req: DeribitLegBuyRequest): Promise<LegExecutionResult> {
    const spot = this.opts.getCurrentSpotUsd();
    if (!spot || spot <= 0) {
      return { ok: false, reason: "venue_error", detail: `Deribit buy: spot unavailable for USDC→BTC conversion (got ${spot})` };
    }
    // Convert USDC-per-BTC limit price to BTC-per-option:
    //   priceBtc = (usdcPerBtcOption) / spot_usdc_per_btc
    // Round UP so we don't accidentally limit below ask
    const priceBtcRaw = req.maxAcceptableAskUsdcPerBtc / spot;
    const priceBtc = snapUpToTick(priceBtcRaw, this.opts.priceTickBtc ?? DEFAULT_DERIBIT_PRICE_TICK_BTC);

    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount: req.contractsBtc,
        side: "buy",
        type: "limit",
        price: priceBtc,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };

      // Paper-mode response: fillPrice is BTC-quoted (Deribit native)
      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return {
          ok: true,
          filledAskUsdcPerBtc: resp.fillPrice * spot,
          filledAtIso: new Date().toISOString()
        };
      }

      // Live response: result.order.{order_state, average_price (BTC), filled_amount}
      const order = resp?.result?.order;
      if (!order) {
        return { ok: false, reason: "venue_error", detail: `Deribit response missing order field: ${JSON.stringify(resp).slice(0, 200)}` };
      }
      const state = order.order_state;
      if (state !== "filled" || !order.average_price || !order.filled_amount) {
        return {
          ok: false,
          reason: "venue_error",
          detail: `Deribit order not filled: state=${state} avg_px=${order.average_price} filled_amt=${order.filled_amount}. ` +
                  `Limit was ${priceBtc.toFixed(4)} BTC (= \$${(priceBtc * spot).toFixed(2)} USDC/BTC at spot \$${spot.toFixed(0)})`
        };
      }
      return {
        ok: true,
        filledAskUsdcPerBtc: order.average_price * spot,
        filledAtIso: new Date().toISOString()
      };
    } catch (e) {
      return { ok: false, reason: "venue_error", detail: `Deribit buy threw: ${(e as Error).message}` };
    }
  }

  async sellLeg(req: DeribitLegSellRequest): Promise<LegExecutionResult> {
    const spot = this.opts.getCurrentSpotUsd();
    if (!spot || spot <= 0) {
      return { ok: false, reason: "venue_error", detail: `Deribit sell: spot unavailable for USDC→BTC conversion` };
    }
    // Convert USDC-per-BTC floor to BTC-per-option. Round DOWN so we don't
    // accidentally set floor above bid (would prevent fill). For best-effort
    // reverse (floor=0), use minimum 1 tick to satisfy Deribit's price > 0 requirement.
    const priceBtcRaw = req.minAcceptableBidUsdcPerBtc > 0
      ? req.minAcceptableBidUsdcPerBtc / spot
      : 0.0001; // 1 tick = best-effort sell at any tradable price
    const priceBtc = req.minAcceptableBidUsdcPerBtc > 0
      ? snapDownToTick(priceBtcRaw, this.opts.priceTickBtc ?? DEFAULT_DERIBIT_PRICE_TICK_BTC)
      : 0.0001;

    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount: req.contractsBtc,
        side: "sell",
        type: "limit",
        price: priceBtc,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };

      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return {
          ok: true,
          filledAskUsdcPerBtc: resp.fillPrice * spot,
          filledAtIso: new Date().toISOString()
        };
      }
      const order = resp?.result?.order;
      if (!order || order.order_state !== "filled" || !order.average_price || !order.filled_amount) {
        return {
          ok: false,
          reason: "venue_error",
          detail: `Deribit sell not filled: state=${order?.order_state}. ` +
                  `Limit was ${priceBtc.toFixed(4)} BTC (= \$${(priceBtc * spot).toFixed(2)} USDC/BTC at spot \$${spot.toFixed(0)})`
        };
      }
      return {
        ok: true,
        filledAskUsdcPerBtc: order.average_price * spot,
        filledAtIso: new Date().toISOString()
      };
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
