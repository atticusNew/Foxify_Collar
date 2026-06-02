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
      filledAtIso: new Date().toISOString(),
      filledContractsBtc: result.fillQtyBtc
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
      filledAtIso: new Date().toISOString(),
      filledContractsBtc: result.fillQtyBtc
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
  /** Deribit option AMOUNT step in BTC (default 0.1 — BTC options trade in 0.1 increments). */
  amountStepBtc?: number;
  /** Deribit option MIN amount in BTC (default 0.1). Orders below this (after snapping) are rejected. */
  minAmountBtc?: number;
};

const DEFAULT_DERIBIT_PRICE_TICK_BTC = 0.0001;
// Deribit BTC options: contract size 1 BTC, AMOUNT must be a multiple of min_trade_amount
// = 0.1 BTC (verified live via public/get_instrument: min_trade_amount 0.1, contract_size 1).
// Sending a non-0.1-multiple (e.g. 0.35211 = notional/spot) returns -32602 "must be a
// multiple of the minimum order size". For a production-grade build, read min_trade_amount
// PER-INSTRUMENT from get_instrument (some venues/instruments vary); 0.1 is correct for BTC options today.
const DEFAULT_DERIBIT_AMOUNT_STEP_BTC = 0.1;
const DEFAULT_DERIBIT_MIN_AMOUNT_BTC = 0.1;

const snapUpToTick = (px: number, tick: number): number => +(Math.ceil(px / tick - 1e-9) * tick).toFixed(8);
const snapDownToTick = (px: number, tick: number): number => +(Math.floor(px / tick + 1e-9) * tick).toFixed(8);

/**
 * Deribit BTC-option PRICE tick is TIERED (per get_instrument tick_size_steps):
 *   price >= 0.005 BTC → 0.0005 tick   (ATM / expensive options)
 *   price <  0.005 BTC → 0.0001 tick   (cheap OTM options)
 * A fixed 0.0001 tick gets ATM orders REJECTED with "must conform to tick size"
 * (verified live 2026-06-02 on the ATM straddle; the cheap-OTM Jun-1 trade passed
 * only because its price was < 0.005). Caller may still override via opts.priceTickBtc.
 * Robustness follow-up: read tick_size + tick_size_steps PER-INSTRUMENT from get_instrument.
 */
const deribitPriceTickBtc = (priceBtc: number, override?: number): number => {
  if (override != null && override > 0) return override;
  return priceBtc >= 0.005 ? 0.0005 : 0.0001;
};

/**
 * Snap an option amount (BTC) DOWN to Deribit's contract step (0.1 BTC). Flooring (not
 * rounding) is deliberate: it guarantees the traded size never EXCEEDS the quoted /
 * budget-gated size, and it matches Bullish's per-venue behaviour (bullishIocLimit floors
 * qty to its 0.01 step). Returns 0 if the floored result is below the venue minimum
 * (caller rejects). Without this, a derived size like 0.35211 BTC (= notional/spot) is
 * rejected by Deribit ("amount must be a multiple of the minimum order size").
 *
 * Snapping is PER-VENUE at the boundary ON PURPOSE — NOT at quote time — because the two
 * legs can route to different venues with different steps (Deribit 0.1 vs Bullish 0.01);
 * a single quote-level snap would wrongly coarsen the finer-grained venue.
 */
const snapAmountToStep = (btc: number, step: number, min: number): number => {
  if (!Number.isFinite(btc) || btc <= 0) return 0;
  // +1e-9 absorbs float-division error (e.g. 0.3/0.1 = 2.9999996 in JS would floor to 2).
  const snapped = +(Math.floor(btc / step + 1e-9) * step).toFixed(8);
  return snapped < min ? 0 : snapped;
};

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
    const priceBtc = snapUpToTick(priceBtcRaw, deribitPriceTickBtc(priceBtcRaw, this.opts.priceTickBtc));

    // Snap amount to Deribit's 0.1 BTC contract step (reject if below the venue min).
    const amount = snapAmountToStep(
      req.contractsBtc,
      this.opts.amountStepBtc ?? DEFAULT_DERIBIT_AMOUNT_STEP_BTC,
      this.opts.minAmountBtc ?? DEFAULT_DERIBIT_MIN_AMOUNT_BTC
    );
    if (amount <= 0) {
      return { ok: false, reason: "venue_error", detail: `Deribit buy: contracts ${req.contractsBtc} BTC below venue min ${this.opts.minAmountBtc ?? DEFAULT_DERIBIT_MIN_AMOUNT_BTC} after snapping to ${this.opts.amountStepBtc ?? DEFAULT_DERIBIT_AMOUNT_STEP_BTC} BTC step` };
    }

    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount,
        side: "buy",
        type: "limit",
        price: priceBtc,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };

      // Paper-mode response: fillPrice is BTC-quoted (Deribit native). The traded
      // size is the snapped `amount` (0.1-step floored).
      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return {
          ok: true,
          filledAskUsdcPerBtc: resp.fillPrice * spot,
          filledAtIso: new Date().toISOString(),
          filledContractsBtc: amount
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
        filledAtIso: new Date().toISOString(),
        // The ACTUAL traded size from Deribit (reflects the 0.1-step floor / any partial).
        filledContractsBtc: order.filled_amount
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
      ? snapDownToTick(priceBtcRaw, deribitPriceTickBtc(priceBtcRaw, this.opts.priceTickBtc))
      : 0.0001;

    // Snap amount to Deribit's 0.1 BTC contract step (same as buy — must match the held size).
    const amount = snapAmountToStep(
      req.contractsBtc,
      this.opts.amountStepBtc ?? DEFAULT_DERIBIT_AMOUNT_STEP_BTC,
      this.opts.minAmountBtc ?? DEFAULT_DERIBIT_MIN_AMOUNT_BTC
    );
    if (amount <= 0) {
      return { ok: false, reason: "venue_error", detail: `Deribit sell: contracts ${req.contractsBtc} BTC below venue min after snapping to ${this.opts.amountStepBtc ?? DEFAULT_DERIBIT_AMOUNT_STEP_BTC} BTC step` };
    }

    try {
      const resp = (await this.client.placeOrder({
        instrument: req.instrument,
        amount,
        side: "sell",
        type: "limit",
        price: priceBtc,
        timeInForce: "immediate_or_cancel"
      })) as { result?: { order?: { order_state?: string; average_price?: number; filled_amount?: number } }; status?: string; fillPrice?: number };

      if (resp?.status === "paper_filled" && resp.fillPrice != null) {
        return {
          ok: true,
          filledAskUsdcPerBtc: resp.fillPrice * spot,
          filledAtIso: new Date().toISOString(),
          filledContractsBtc: amount
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
        filledAtIso: new Date().toISOString(),
        filledContractsBtc: order.filled_amount
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
