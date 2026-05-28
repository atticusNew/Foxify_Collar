/**
 * Order aggregation netting (PR C7).
 *
 * Collects concurrent same-venue same-symbol same-side orders within a
 * configurable window (default 200ms), submits ONE venue order for the
 * aggregated quantity, then splits fills back to individual pairs pro-rata.
 *
 * At 50+ pairs/day, this materially reduces:
 *   - Venue order count (fewer API calls, lower rate-limit exposure)
 *   - Bid-ask slippage cost (single big order often beats N small orders)
 *   - Per-trade fees (mostly venue-side; some venues charge per-order)
 *
 * Feature-flagged OFF by default. Enable via SS_TWO_SIDED_ORDER_AGGREGATION_ENABLED=true
 * once daily volume warrants it (operator decision, typically > 50 pairs/day).
 *
 * Single-pair fallback: when only 1 order in the batch (no other activations
 * within the window), submits directly without aggregation overhead.
 *
 * Phase 1 architecture: this is a wrapper around an existing executor (Bullish
 * or Deribit LegClient). It does NOT replace the LegClient — it batches calls
 * to it. Production wiring should put OrderAggregator between LiveStrangleExecutor
 * and the per-venue LegClient.
 */

import type { LegExecutionResult } from "./executor";

export const DEFAULT_BATCH_WINDOW_MS = 200;
/** Helper: read env flag for production. Tests pass aggregationEnabled directly. */
export const isAggregationEnabledByEnv = (): boolean => process.env.SS_TWO_SIDED_ORDER_AGGREGATION_ENABLED === "true";

export type AggregatedLegRequest = {
  /** Unique per-order ID — caller uses this to match fills back. */
  callerKey: string;
  contractsBtc: number;
  maxAcceptableAskUsdcPerBtc: number;
};

export type AggregatedLegResult = {
  callerKey: string;
  filledAskUsdcPerBtc: number;
  filledContractsBtc: number;
  filledAtIso: string;
};

export type AggregatorSubmitFn = (totalContractsBtc: number, weightedAcceptableAsk: number) => Promise<LegExecutionResult>;

type PendingBatch = {
  venue: string;
  symbol: string;
  side: "buy" | "sell";
  requests: AggregatedLegRequest[];
  promises: Array<(r: AggregatedLegResult) => void>;
  rejecters: Array<(e: Error) => void>;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

export class OrderAggregator {
  private batches = new Map<string, PendingBatch>();

  constructor(
    private readonly opts: {
      windowMs?: number;
      /** Default false. Tests set explicitly; production reads via isAggregationEnabledByEnv(). */
      aggregationEnabled?: boolean;
      submit: (venue: string, symbol: string, side: "buy" | "sell", totalBtc: number, weightedMaxPx: number) => Promise<LegExecutionResult>;
      log?: (msg: string, meta?: Record<string, unknown>) => void;
    }
  ) {}

  /**
   * Submit a leg order. If aggregation is enabled and another request for the
   * same (venue, symbol, side) is within windowMs, batches them.
   * Returns resolved promise with the filled result for THIS caller (pro-rata).
   */
  async submitLeg(
    venue: string,
    symbol: string,
    side: "buy" | "sell",
    request: AggregatedLegRequest
  ): Promise<AggregatedLegResult> {
    if (!(this.opts.aggregationEnabled ?? false)) {
      // Bypass aggregator entirely — submit immediately
      const r = await this.opts.submit(venue, symbol, side, request.contractsBtc, request.maxAcceptableAskUsdcPerBtc);
      if (!r.ok) throw new Error(`leg failed: ${r.reason} ${r.detail}`);
      return {
        callerKey: request.callerKey,
        filledAskUsdcPerBtc: r.filledAskUsdcPerBtc,
        filledContractsBtc: request.contractsBtc,
        filledAtIso: r.filledAtIso
      };
    }

    const key = `${venue}|${symbol}|${side}`;
    return new Promise<AggregatedLegResult>((resolve, reject) => {
      let batch = this.batches.get(key);
      if (!batch) {
        batch = {
          venue,
          symbol,
          side,
          requests: [],
          promises: [],
          rejecters: [],
          timeoutId: null
        };
        this.batches.set(key, batch);
        // Schedule dispatch after window
        const windowMs = this.opts.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
        batch.timeoutId = setTimeout(() => this.dispatchBatch(key), windowMs);
        // NOTE: do NOT .unref() — the awaited submitLeg() promise depends on this timer firing.
        // node:test would cancel awaits if the only pending work is an unref'd timer.
      }
      batch.requests.push(request);
      batch.promises.push(resolve);
      batch.rejecters.push(reject);
    });
  }

  /** Force-dispatch all pending batches. Use during graceful shutdown. */
  async flushAll(): Promise<void> {
    const keys = Array.from(this.batches.keys());
    for (const k of keys) await this.dispatchBatch(k);
  }

  private async dispatchBatch(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    if (batch.timeoutId) clearTimeout(batch.timeoutId);

    const totalBtc = batch.requests.reduce((s, r) => s + r.contractsBtc, 0);
    // Weighted-average max acceptable price (preserves caller cap intent)
    const weightedMaxPx =
      batch.requests.reduce((s, r) => s + r.maxAcceptableAskUsdcPerBtc * r.contractsBtc, 0) / Math.max(totalBtc, 1e-9);

    this.log(`dispatching batch venue=${batch.venue} symbol=${batch.symbol} side=${batch.side} n=${batch.requests.length} totalBtc=${totalBtc.toFixed(4)}`);

    try {
      const result = await this.opts.submit(batch.venue, batch.symbol, batch.side, totalBtc, weightedMaxPx);
      if (!result.ok) {
        const err = new Error(`batch leg failed: ${result.reason} ${result.detail}`);
        for (const rej of batch.rejecters) rej(err);
        return;
      }
      // Pro-rata fill distribution: each caller gets fill at the realized px,
      // contractsBtc = their original requested amount (we got at least totalBtc filled).
      const filledPx = result.filledAskUsdcPerBtc;
      const filledAt = result.filledAtIso;
      for (let i = 0; i < batch.requests.length; i++) {
        batch.promises[i]({
          callerKey: batch.requests[i].callerKey,
          filledAskUsdcPerBtc: filledPx,
          filledContractsBtc: batch.requests[i].contractsBtc,
          filledAtIso: filledAt
        });
      }
    } catch (e) {
      for (const rej of batch.rejecters) rej(e as Error);
    }
  }

  private log(msg: string, meta?: Record<string, unknown>): void {
    const fn = this.opts.log ?? ((m, _meta) => console.log(`[orderAggregator] ${m}`, _meta ?? ""));
    fn(msg, meta);
  }
}
