import type { GreeksSnapshot, MarketLiquiditySnapshot } from "./types";

export type OptionsChainRow = {
  venue: "falconx" | "deribit_test" | "ibkr_cme_live" | "ibkr_cme_paper" | "mock_falconx";
  symbol: string;
  instrumentId: string;
  expiryIso: string;
  strike: number;
  right: "P" | "C";
  markPrice: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  asOfIso: string;
};

export type RfqQuoteRow = {
  venue: string;
  quoteId: string;
  rfqId: string | null;
  instrumentId: string;
  quantity: number;
  premium: number;
  expiresAtIso: string;
  quoteTsIso: string;
  details: Record<string, unknown>;
};

export type RfqFillRow = {
  venue: string;
  quoteId: string;
  rfqId: string | null;
  instrumentId: string;
  quantity: number;
  executionPrice: number;
  premium: number;
  executedAtIso: string;
  externalOrderId: string;
  externalExecutionId: string;
  details: Record<string, unknown>;
};

export interface PilotMarketDataAdapter {
  fetchOptionsChain(params: {
    symbol: string;
    fromIso: string;
    toIso: string;
    right?: "P" | "C";
  }): Promise<OptionsChainRow[]>;
  fetchLiquiditySnapshots(params: {
    instrumentIds: string[];
    asOfIso: string;
  }): Promise<Record<string, MarketLiquiditySnapshot>>;
  fetchGreeksSnapshots(params: {
    instrumentIds: string[];
    asOfIso: string;
  }): Promise<Record<string, GreeksSnapshot>>;
  fetchRfqQuotes(params: {
    fromIso: string;
    toIso: string;
  }): Promise<RfqQuoteRow[]>;
  fetchRfqFills(params: {
    fromIso: string;
    toIso: string;
  }): Promise<RfqFillRow[]>;
}

export class NullPilotMarketDataAdapter implements PilotMarketDataAdapter {
  async fetchOptionsChain(): Promise<OptionsChainRow[]> {
    return [];
  }

  async fetchLiquiditySnapshots(params: {
    instrumentIds: string[];
    asOfIso: string;
  }): Promise<Record<string, MarketLiquiditySnapshot>> {
    const out: Record<string, MarketLiquiditySnapshot> = {};
    for (const instrumentId of params.instrumentIds) {
      out[instrumentId] = {
        asOfIso: params.asOfIso,
        spreadPct: null,
        topAskSize: null,
        topBidSize: null,
        staleTopMs: null,
        depthScore: null
      };
    }
    return out;
  }

  async fetchGreeksSnapshots(params: {
    instrumentIds: string[];
    asOfIso: string;
  }): Promise<Record<string, GreeksSnapshot>> {
    const out: Record<string, GreeksSnapshot> = {};
    for (const instrumentId of params.instrumentIds) {
      out[instrumentId] = {
        asOfIso: params.asOfIso,
        delta: null,
        gamma: null,
        vega: null,
        theta: null,
        iv: null,
        skew: null
      };
    }
    return out;
  }

  async fetchRfqQuotes(): Promise<RfqQuoteRow[]> {
    return [];
  }

  async fetchRfqFills(): Promise<RfqFillRow[]> {
    return [];
  }
}

