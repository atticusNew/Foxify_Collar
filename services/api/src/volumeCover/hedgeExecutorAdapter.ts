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

/**
 * Parse strike from a venue option symbol. Supports both formats:
 *   Bullish: BTC-USDC-YYYYMMDD-STRIKE-{P|C}
 *   Deribit: BTC-DDMMMYY-STRIKE-{P|C}
 */
const parseStrikeFromSymbol = (symbol: string): number | null => {
  if (!symbol) return null;
  // Bullish: 4 dash-separated parts, strike is the 4th
  const bullishMatch = symbol.match(/^BTC-USDC-\d{8}-(\d+(?:\.\d+)?)-(P|C)$/i);
  if (bullishMatch) {
    const strike = Number(bullishMatch[1]);
    return Number.isFinite(strike) ? strike : null;
  }
  // Deribit: 3 dash-separated parts, strike is the 3rd
  const deribitMatch = symbol.match(/^BTC-\d{1,2}[A-Z]{3}\d{2}-(\d+)-(P|C)$/i);
  if (deribitMatch) {
    const strike = Number(deribitMatch[1]);
    return Number.isFinite(strike) ? strike : null;
  }
  return null;
};

/**
 * Parse expiry ISO from a venue option symbol.
 *   Bullish YYYYMMDD → ISO at 08:00 UTC
 *   Deribit DDMMMYY  → ISO at 08:00 UTC
 */
const parseExpiryFromSymbol = (symbol: string): string | null => {
  if (!symbol) return null;
  const bullishMatch = symbol.match(/^BTC-USDC-(\d{4})(\d{2})(\d{2})-/i);
  if (bullishMatch) {
    const [, y, m, d] = bullishMatch;
    return `${y}-${m}-${d}T08:00:00.000Z`;
  }
  const deribitMatch = symbol.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-/i);
  if (deribitMatch) {
    const [, d, monShort, y2] = deribitMatch;
    const monIdx =
      ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(
        monShort.toUpperCase()
      );
    if (monIdx < 0) return null;
    const year = 2000 + Number(y2);
    const day = Number(d);
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    return `${year}-${String(monIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T08:00:00.000Z`;
  }
  return null;
};

export const createHedgeExecutor = (opts: HedgeExecutorAdapterOptions): HedgeExecutor => {
  return {
    async buyOptionLeg(params): Promise<{
      venue: HedgeVenueChoice;
      fillPriceUsdcPerBtc: number;
      totalCostUsdc: number;
      orderId: string;
      /** Actual strike that the venue filled (may differ from target if fast-path snapped) */
      actualStrikeUsdc?: number;
      /** Actual expiry that the venue filled (may differ from target after expiry snap) */
      actualExpiryIso?: string;
      /** Actual venue symbol filled (for audit log) */
      actualSymbol?: string;
    }> {
      if (opts.mockFills) {
        // Mock fill: realistic price band per venue
        const unitCost = params.optionKind === "call" ? 90 : 95;
        return {
          venue: params.venue,
          fillPriceUsdcPerBtc: unitCost,
          totalCostUsdc: unitCost * params.contractsBtc,
          orderId: `MOCK-BUY-${randomUUID().slice(0, 8)}`,
          actualStrikeUsdc: params.strikeUsdc,
          actualExpiryIso: params.expiryIso,
          actualSymbol: `MOCK-${params.optionKind.toUpperCase()}-${params.strikeUsdc}`
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

      // 2026-05-18: extract the ACTUAL filled symbol from the venue's
      // quote/execution result. The venue may have snapped the
      // requested strike+expiry to nearest available (Bullish via
      // selectBullishOptionSymbol, Deribit via resolveQuoteInstrument
      // VC fast-path), so the actual fill can differ from params.
      // Stored in DB for accurate audit + dashboard display.
      //
      // Sources, in order of preference:
      //   1. quote.details.selectedInstrumentId (Bullish populates this)
      //   2. quote.instrumentId (Deribit/Bullish — may equal request OR snapped)
      //   3. execution.instrumentId (last resort)
      const quoteDetails = ((quote as any)?.details || {}) as Record<string, unknown>;
      const actualSymbol = String(
        (quoteDetails.selectedInstrumentId as string | undefined) ||
          (quote as any)?.instrumentId ||
          (execution as any)?.instrumentId ||
          ""
      ).trim();
      const actualStrikeUsdc =
        parseStrikeFromSymbol(actualSymbol) ?? params.strikeUsdc;
      const actualExpiryIso =
        parseExpiryFromSymbol(actualSymbol) ?? params.expiryIso;

      return {
        venue: params.venue,
        fillPriceUsdcPerBtc: unitCost,
        totalCostUsdc: totalCost,
        orderId: execution.externalOrderId ?? execution.quoteId,
        actualStrikeUsdc,
        actualExpiryIso,
        actualSymbol: actualSymbol || undefined
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
