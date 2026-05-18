/**
 * Hedge executor adapter — wires Volume Cover's HedgeExecutor interface
 * to the existing pilot venue adapters (Bullish + Deribit live).
 *
 * For MVP launch we use a thin shim that places market IOC orders via
 * the underlying venue adapters. Failures bubble up as exceptions which
 * the executeHedgeStructure caller handles via fallback / rollback.
 *
 * In live ops, the actual venue.ts BullishTestnetAdapter and DeribitLive
 * adapters implement quote() + execute() + sellOption(). We map our
 * higher-level intent (option_kind + strike + expiry + contracts) into
 * a venue instrumentId per venue convention, then call quote → execute.
 */

import { randomUUID } from "node:crypto";
import type { HedgeExecutor, HedgeVenueChoice } from "./tightHedge";
import type { PilotVenueAdapter } from "../pilot/venue";

const buildBullishOptionInstrumentId = (params: {
  optionKind: "put" | "call";
  strikeUsdc: number;
  expiryIso: string;
}): string => {
  const exp = new Date(params.expiryIso);
  const yyyymmdd =
    exp.getUTCFullYear().toString() +
    String(exp.getUTCMonth() + 1).padStart(2, "0") +
    String(exp.getUTCDate()).padStart(2, "0");
  const strikeStr = params.strikeUsdc.toFixed(0);
  const kindLetter = params.optionKind === "call" ? "C" : "P";
  return `BTC-USDC-${yyyymmdd}-${strikeStr}-${kindLetter}`;
};

const buildDeribitOptionInstrumentId = (params: {
  optionKind: "put" | "call";
  strikeUsdc: number;
  expiryIso: string;
}): string => {
  const exp = new Date(params.expiryIso);
  const day = exp.getUTCDate();
  const monthShort = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
    exp.getUTCMonth()
  ];
  const yearShort = String(exp.getUTCFullYear()).slice(2);
  const kind = params.optionKind === "call" ? "C" : "P";
  return `BTC-${day}${monthShort}${yearShort}-${params.strikeUsdc.toFixed(0)}-${kind}`;
};

export type HedgeExecutorAdapterOptions = {
  bullish?: PilotVenueAdapter;
  deribit?: PilotVenueAdapter;
  /** If true, bypass venue calls and return mock fills (for local dev). */
  mockFills?: boolean;
};

export const createHedgeExecutor = (opts: HedgeExecutorAdapterOptions): HedgeExecutor => {
  return {
    async buyOptionLeg(params): Promise<{
      venue: HedgeVenueChoice;
      fillPriceUsdcPerBtc: number;
      totalCostUsdc: number;
      orderId: string;
    }> {
      if (opts.mockFills) {
        // Mock fill: realistic price band per venue
        const unitCost = params.optionKind === "call" ? 90 : 95;
        return {
          venue: params.venue,
          fillPriceUsdcPerBtc: unitCost,
          totalCostUsdc: unitCost * params.contractsBtc,
          orderId: `MOCK-BUY-${randomUUID().slice(0, 8)}`
        };
      }

      const adapter = params.venue === "bullish" ? opts.bullish : opts.deribit;
      if (!adapter) {
        throw new Error(`venue_adapter_unavailable:${params.venue}`);
      }
      const instrumentId =
        params.venue === "bullish"
          ? buildBullishOptionInstrumentId(params)
          : buildDeribitOptionInstrumentId(params);

      const quoteRequest = {
        marketId: "BTC-USD",
        instrumentId,
        protectedNotional: params.contractsBtc * params.strikeUsdc,
        quantity: params.contractsBtc,
        side: "buy" as const,
        protectionType: (params.optionKind === "put" ? "long" : "short") as "long" | "short",
        clientOrderId: `vc-${randomUUID().slice(0, 12)}`
      };

      const quote = await adapter.quote(quoteRequest);
      const execution = await adapter.execute(quote);

      // 2026-05-18: hard-fail if the venue adapter returned status
      // 'failure'. Previously we read execution.premium regardless of
      // status, which silently masked the case where the adapter
      // refused to execute (e.g., enableExecution=false flag, price
      // staleness rejection, account permission rejection). Symptom:
      // position was recorded as 'active' with synthetic premium but
      // no real order ever reached Bullish.
      if (execution.status === "failure") {
        const reason =
          (execution.details as any)?.rejectionReason ??
          (execution as any)?.message ??
          "unknown_reason";
        throw new Error(
          `venue_execute_failed:${params.venue}:${reason}`
        );
      }

      const totalCost = Number(execution.premium ?? 0);
      const unitCost = params.contractsBtc > 0 ? totalCost / params.contractsBtc : 0;

      // Defensive: if the venue claims success but premium is zero,
      // that's also wrong. Bail rather than write a $0 hedge leg.
      if (!Number.isFinite(totalCost) || totalCost <= 0) {
        throw new Error(
          `venue_execute_zero_premium:${params.venue}:status=${execution.status}`
        );
      }

      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: unitCost,
        totalCostUsdc: totalCost,
        orderId: execution.externalOrderId ?? execution.quoteId
      };
    },

    async sellOptionLeg(params): Promise<{
      venue: HedgeVenueChoice;
      fillPriceUsdcPerBtc: number;
      totalProceedsUsdc: number;
      orderId: string;
    }> {
      if (opts.mockFills) {
        // Mock sell: ~95% recovery of buy price
        const unitProceeds = (params.optionKind === "call" ? 90 : 95) * 0.95;
        return {
          venue: params.venue,
          fillPriceUsdcPerBtc: unitProceeds,
          totalProceedsUsdc: unitProceeds * params.contractsBtc,
          orderId: `MOCK-SELL-${randomUUID().slice(0, 8)}`
        };
      }

      const adapter = params.venue === "bullish" ? opts.bullish : opts.deribit;
      if (!adapter || !adapter.sellOption) {
        throw new Error(`sell_option_unavailable:${params.venue}`);
      }
      const instrumentId =
        params.venue === "bullish"
          ? buildBullishOptionInstrumentId(params)
          : buildDeribitOptionInstrumentId(params);
      const result = await adapter.sellOption({
        instrumentId,
        quantity: params.contractsBtc
      });
      if (result.status !== "sold") {
        throw new Error(
          `sell_option_failed:${params.venue}:${(result.details as any)?.reason ?? "unknown"}`
        );
      }
      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: result.fillPrice,
        totalProceedsUsdc: result.totalProceeds,
        orderId: result.orderId ?? `vc-sell-${randomUUID().slice(0, 8)}`
      };
    }
  };
};
