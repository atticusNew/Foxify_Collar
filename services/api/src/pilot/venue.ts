import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  DeribitConnector,
  IbkrConnector,
  type IbkrContractQuery,
  type IbkrQualifiedContract
} from "@foxify/connectors";
import type {
  DeribitQuotePolicy,
  DeribitStrikeSelectionMode,
  PilotHedgePolicy,
  PilotVenueMode
} from "./config";
import type { VenueExecution, VenueQuote } from "./types";

export type QuoteRequest = {
  marketId: string;
  instrumentId: string;
  protectedNotional: number;
  quantity: number;
  side: "buy";
  protectionType?: "long" | "short";
  drawdownFloorPct?: number;
  triggerPrice?: number;
  requestedTenorDays?: number;
  tenorMinDays?: number;
  tenorMaxDays?: number;
  hedgePolicy?: PilotHedgePolicy;
  clientOrderId?: string;
};

type FalconxConfig = {
  baseUrl: string;
  apiKey: string;
  secret: string;
  passphrase: string;
};

type IbkrVenueConfig = {
  bridgeBaseUrl: string;
  bridgeTimeoutMs: number;
  bridgeToken: string;
  accountId: string;
  enableExecution: boolean;
  orderTimeoutMs: number;
  orderTif?: "IOC" | "DAY";
  maxRepriceSteps: number;
  repriceStepTicks: number;
  maxSlippageBps: number;
  requireLiveTransport: boolean;
  maxTenorDriftDays?: number;
  preferTenorAtOrAbove?: boolean;
  primaryProductFamily?: "MBT" | "BFF";
  enableBffFallback?: boolean;
  bffProductFamily?: "MBT" | "BFF";
  maxFuturesSyntheticPremiumRatio?: number;
  maxOptionPremiumRatio?: number;
  optionProtectionTolerancePct?: number;
  optionProbeParallelism?: number;
  optionLiquiditySelectionEnabled?: boolean;
  optionTenorWindowDays?: number;
  requireOptionsNative?: boolean;
};

const nowIso = (): string => new Date().toISOString();
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const timestampSeconds = (): string => (Date.now() / 1000).toFixed(3);

const signFalconx = (params: {
  secret: string;
  timestamp: string;
  method: string;
  requestPath: string;
  body: string;
}): string => {
  const decoded = Buffer.from(params.secret, "base64");
  const prehash = `${params.timestamp}${params.method.toUpperCase()}${params.requestPath}${params.body}`;
  return createHmac("sha256", decoded).update(prehash).digest("base64");
};

const falconxRequest = async (
  config: FalconxConfig,
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | null
): Promise<any> => {
  const payload = body ? JSON.stringify(body) : "";
  const ts = timestampSeconds();
  const signature = signFalconx({
    secret: config.secret,
    timestamp: ts,
    method,
    requestPath: path,
    body: payload
  });
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "FX-ACCESS-KEY": config.apiKey,
      "FX-ACCESS-SIGN": signature,
      "FX-ACCESS-TIMESTAMP": ts,
      "FX-ACCESS-PASSPHRASE": config.passphrase
    },
    body: body ? payload : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`falconx_http_${res.status}:${text}`);
  }
  return await res.json();
};

const DERIBIT_OPTION_REGEX = /^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+-(P|C)$/i;

const parseDeribitStrike = (instrumentId: string): number | null => {
  const parts = String(instrumentId || "").split("-");
  if (parts.length < 4) return null;
  const strike = Number(parts[2]);
  return Number.isFinite(strike) && strike > 0 ? strike : null;
};

const parseDeribitExpiry = (instrumentId: string): number | null => {
  const parts = String(instrumentId || "").split("-");
  if (parts.length < 4) return null;
  const rawDate = String(parts[1] || "").toUpperCase();
  if (!/^\d{1,2}[A-Z]{3}\d{2}$/.test(rawDate)) return null;
  const day = Number(rawDate.slice(0, rawDate.length - 5));
  const monthRaw = rawDate.slice(rawDate.length - 5, rawDate.length - 2);
  const year = 2000 + Number(rawDate.slice(-2));
  const monthMap: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11
  };
  const month = monthMap[monthRaw];
  if (!Number.isFinite(day) || !Number.isFinite(year) || month === undefined) return null;
  const expiry = Date.UTC(year, month, day, 8, 0, 0, 0);
  return Number.isFinite(expiry) ? expiry : null;
};

const extractTopOfBook = (orderBookPayload: any): {
  ask: number | null;
  askSize: number | null;
  bid: number | null;
} => {
  const orderBook = orderBookPayload?.result ?? orderBookPayload;
  const ask = Number(orderBook?.asks?.[0]?.[0] ?? orderBook?.best_ask_price ?? 0);
  const askSize = Number(orderBook?.asks?.[0]?.[1] ?? orderBook?.best_ask_amount ?? 0);
  const bid = Number(orderBook?.bids?.[0]?.[0] ?? orderBook?.best_bid_price ?? 0);
  return {
    ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    askSize: Number.isFinite(askSize) && askSize >= 0 ? askSize : null,
    bid: Number.isFinite(bid) && bid > 0 ? bid : null
  };
};

const extractMarkPrice = (orderBookPayload: any): number | null => {
  const orderBook = orderBookPayload?.result ?? orderBookPayload;
  const mark = Number(orderBook?.mark_price ?? 0);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
};

const resolveDeribitSpot = async (connector: DeribitConnector): Promise<number> => {
  const spot = await connector.getIndexPrice("btc_usd");
  const indexPrice = Number((spot as any)?.result?.index_price ?? 0);
  if (!Number.isFinite(indexPrice) || indexPrice <= 0) {
    throw new Error("deribit_spot_unavailable");
  }
  return indexPrice;
};

const toFinitePositive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return Math.max(min, Math.min(max, v));
};

const formatMatchedTenorDisplay = (tenorDays: number | null): string | null => {
  if (!Number.isFinite(Number(tenorDays)) || Number(tenorDays) < 0) return null;
  const totalMinutes = Math.round(Number(tenorDays) * 24 * 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes - days * 24 * 60) / 60);
  const minutes = totalMinutes % 60;
  if (days <= 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (hours <= 0) return `${days}d`;
  return `${days}d ${hours}h`;
};

const buildIbkrInstrumentId = (contract: IbkrQualifiedContract): string => {
  const symbol = String(contract.localSymbol || "").replace(/\s+/g, "_");
  return `IBKR-${contract.secType}-${contract.conId}-${symbol}`;
};

const parseIbkrStrikeFromLocalSymbol = (contract: IbkrQualifiedContract): number | null => {
  const direct = toFinitePositive(contract.strike);
  if (direct !== null) return direct;
  const raw = String(contract.localSymbol || "");
  const match = raw.match(/([PC])\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  return toFinitePositive(match[2]);
};

const parseIbkrConId = (instrumentId: string): number | null => {
  const match = String(instrumentId || "").match(/^IBKR-[^-]+-(\d+)-/);
  if (!match) return null;
  const conId = Number(match[1]);
  return Number.isFinite(conId) && conId > 0 ? conId : null;
};

export interface PilotVenueAdapter {
  quote(req: QuoteRequest): Promise<VenueQuote>;
  execute(quote: VenueQuote): Promise<VenueExecution>;
  getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }>;
}

class MockFalconxAdapter implements PilotVenueAdapter {
  constructor(private quoteTtlMs: number) {}

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const premium = Number((req.protectedNotional * 0.01).toFixed(4));
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    return {
      venue: "mock_falconx",
      quoteId: randomUUID(),
      rfqId: randomUUID(),
      instrumentId: req.instrumentId,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt,
      quoteTs,
      details: { mode: "mock" }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    return {
      venue: "mock_falconx",
      status: "success",
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: quote.quantity,
      executionPrice: quote.premium / Math.max(quote.quantity, 0.000001),
      premium: quote.premium,
      executedAt: nowIso(),
      externalOrderId: `MOCK-ORD-${randomUUID()}`,
      externalExecutionId: `MOCK-EXE-${randomUUID()}`,
      details: { mode: "mock" }
    };
  }

  async getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    const unitPrice = 1000;
    return {
      markPremium: Number((unitPrice * Math.max(params.quantity, 0)).toFixed(4)),
      unitPrice,
      source: "mock_static",
      asOf: nowIso(),
      details: { mode: "mock" }
    };
  }
}

class DeribitTestAdapter implements PilotVenueAdapter {
  constructor(
    private connector: DeribitConnector,
    private quoteTtlMs: number,
    private quotePolicy: DeribitQuotePolicy,
    private strikeSelectionMode: DeribitStrikeSelectionMode,
    private maxTenorDriftDays: number
  ) {}

  private resolveTargetOptionType(
    requestedInstrument: string,
    protectionType?: "long" | "short"
  ): "put" | "call" {
    if (protectionType === "short") return "call";
    if (protectionType === "long") return "put";
    const normalized = String(requestedInstrument || "").toUpperCase();
    if (normalized.endsWith("-C")) return "call";
    return "put";
  }

  private async resolveQuoteInstrument(params: {
    requestedInstrument: string;
    spot: number;
    targetTriggerPrice?: number;
    requestedTenorDays?: number;
    protectionType?: "long" | "short";
  }): Promise<{
    instrumentId: string;
    ask: number;
    askSize: number | null;
    optionType: "put" | "call";
    source: string;
    askSource: "ask" | "mark";
    strike: number;
    expiryTs: number | null;
  }> {
    const targetOptionType = this.resolveTargetOptionType(params.requestedInstrument, params.protectionType);
    const instruments = (await this.connector.listInstruments("BTC")) as any;
    const list: any[] = Array.isArray(instruments?.result) ? instruments.result : [];
    const now = Date.now();
    const requestedTenorDays =
      Number.isFinite(Number(params.requestedTenorDays)) && Number(params.requestedTenorDays) > 0
        ? Number(params.requestedTenorDays)
        : 7;
    const targetExpiry = now + requestedTenorDays * 86400000;
    const legacyTargetStrike = targetOptionType === "call" ? params.spot * 1.15 : params.spot * 0.85;
    const triggerTarget =
      Number.isFinite(Number(params.targetTriggerPrice)) && Number(params.targetTriggerPrice) > 0
        ? Number(params.targetTriggerPrice)
        : null;
    const targetStrike =
      this.strikeSelectionMode === "trigger_aligned" && triggerTarget ? triggerTarget : legacyTargetStrike;

    const requestedCandidate =
      DERIBIT_OPTION_REGEX.test(params.requestedInstrument) &&
      Number.isFinite(parseDeribitStrike(params.requestedInstrument))
        ? {
            instrumentId: params.requestedInstrument,
            strike: Number(parseDeribitStrike(params.requestedInstrument)),
            expiryTs: parseDeribitExpiry(params.requestedInstrument)
          }
        : null;

    let candidates = list
      .filter((item) => String(item?.option_type || "").toLowerCase() === targetOptionType)
      .filter((item) => Number(item?.expiration_timestamp || 0) > now + 60 * 60 * 1000)
      .map((item) => ({
        instrumentId: String(item.instrument_name || ""),
        strike: Number(item.strike || parseDeribitStrike(String(item.instrument_name || "")) || 0),
        expiryTs: Number(item.expiration_timestamp || parseDeribitExpiry(String(item.instrument_name || "")) || 0)
      }))
      .filter((item) => item.instrumentId && Number.isFinite(item.strike) && item.strike > 0)
      .filter((item) =>
        this.strikeSelectionMode === "trigger_aligned" && triggerTarget
          ? targetOptionType === "put"
            ? item.strike >= triggerTarget
            : item.strike <= triggerTarget
          : true
      );

    if (this.strikeSelectionMode === "trigger_aligned" && triggerTarget && candidates.length === 0) {
      throw new Error("deribit_quote_unavailable:trigger_strike_unavailable");
    }

    candidates = candidates
      .sort((a, b) => {
        const scoreA =
          Math.abs(a.expiryTs - targetExpiry) / 86400000 +
          Math.abs(a.strike - targetStrike) / Math.max(params.spot, 1);
        const scoreB =
          Math.abs(b.expiryTs - targetExpiry) / 86400000 +
          Math.abs(b.strike - targetStrike) / Math.max(params.spot, 1);
        return scoreA - scoreB;
      })
      .slice(0, 40);

    const orderedCandidates = requestedCandidate
      ? [requestedCandidate, ...candidates.filter((item) => item.instrumentId !== requestedCandidate.instrumentId)]
      : candidates;

    for (const candidate of orderedCandidates) {
      const book = await this.connector.getOrderBook(candidate.instrumentId);
      const top = extractTopOfBook(book);
      const mark = extractMarkPrice(book);
      const askFromAsk = top.ask && top.ask > 0 ? top.ask : null;
      const askFromMark =
        this.quotePolicy === "ask_or_mark_fallback" && mark && mark > 0 ? mark : null;
      const ask = askFromAsk ?? askFromMark;
      if (ask && ask > 0) {
        return {
          instrumentId: candidate.instrumentId,
          ask,
          askSize: top.askSize,
          optionType: targetOptionType,
          source:
            candidate.instrumentId === requestedCandidate?.instrumentId
              ? "requested_instrument_orderbook"
              : targetOptionType === "call"
                ? "auto_selected_deribit_call"
                : "auto_selected_deribit_put",
          askSource: askFromAsk ? "ask" : "mark",
          strike: candidate.strike,
          expiryTs: Number.isFinite(candidate.expiryTs) && candidate.expiryTs > 0 ? candidate.expiryTs : null
        };
      }
    }

    throw new Error("deribit_quote_unavailable");
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const now = Date.now();
    const spot = await resolveDeribitSpot(this.connector);
    const resolved = await this.resolveQuoteInstrument({
      requestedInstrument: req.instrumentId,
      spot,
      targetTriggerPrice: req.triggerPrice,
      requestedTenorDays: req.requestedTenorDays,
      protectionType: req.protectionType
    });
    const requestedTenorDays =
      Number.isFinite(Number(req.requestedTenorDays)) && Number(req.requestedTenorDays) > 0
        ? Number(req.requestedTenorDays)
        : 7;
    const selectedTenorDays = resolved.expiryTs ? (resolved.expiryTs - now) / 86400000 : null;
    const tenorDriftDays =
      selectedTenorDays !== null ? Math.abs(selectedTenorDays - requestedTenorDays) : null;
    if (
      tenorDriftDays !== null &&
      Number.isFinite(this.maxTenorDriftDays) &&
      this.maxTenorDriftDays >= 0 &&
      tenorDriftDays > this.maxTenorDriftDays
    ) {
      throw new Error("deribit_quote_unavailable:tenor_drift_exceeded");
    }
    const premium = Number((resolved.ask * spot * req.quantity).toFixed(4));
    if (!Number.isFinite(premium) || premium <= 0) {
      throw new Error("deribit_quote_unavailable");
    }
    const targetTriggerPrice =
      Number.isFinite(Number(req.triggerPrice)) && Number(req.triggerPrice) > 0
        ? Number(req.triggerPrice)
        : null;
    const strikeGapToTriggerUsd =
      targetTriggerPrice !== null ? resolved.strike - targetTriggerPrice : null;
    const strikeGapToTriggerPct =
      targetTriggerPrice && targetTriggerPrice > 0 && strikeGapToTriggerUsd !== null
        ? strikeGapToTriggerUsd / targetTriggerPrice
        : null;
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    return {
      venue: "deribit_test",
      quoteId: randomUUID(),
      rfqId: null,
      instrumentId: resolved.instrumentId,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt,
      quoteTs,
      details: {
        source: resolved.source,
        optionType: resolved.optionType,
        pricing: "live_orderbook",
        askPriceBtc: resolved.ask,
        askSource: resolved.askSource,
        askSize: resolved.askSize,
        spotPriceUsd: spot,
        selectedStrike: resolved.strike,
        targetTriggerPrice,
        strikeGapToTriggerUsd,
        strikeGapToTriggerPct,
        selectedTenorDays,
        tenorDriftDays,
        deribitQuotePolicy: this.quotePolicy,
        strikeSelectionMode: this.strikeSelectionMode
      }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    const order = (await this.connector.placeOrder({
      instrument: quote.instrumentId,
      amount: quote.quantity,
      side: "buy",
      type: "market"
    })) as any;
    const status =
      order?.status === "paper_filled" || order?.status === "filled" || order?.status === "ok"
        ? "success"
        : "failure";
    const requestedQuantity = Math.max(0, Number(quote.quantity || 0));
    const filledAmount = Number(order?.filledAmount);
    const reportedAmount = Number(order?.amount);
    const executedQuantityRaw = Number.isFinite(filledAmount)
      ? filledAmount
      : Number.isFinite(reportedAmount)
        ? reportedAmount
        : requestedQuantity;
    const executedQuantity = Math.max(0, executedQuantityRaw);
    const fillRatio =
      requestedQuantity > 0
        ? Math.min(1, Math.max(0, executedQuantity / requestedQuantity))
        : 0;
    const scaledPremium = Number((quote.premium * fillRatio).toFixed(10));
    const fillStatus = String(order?.status || "unknown");
    const rejectionReasonRaw =
      (typeof order?.rejectionReason === "string" && order.rejectionReason) ||
      (typeof order?.rejectReason === "string" && order.rejectReason) ||
      (typeof order?.reason === "string" && order.reason) ||
      null;
    return {
      venue: "deribit_test",
      status,
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: executedQuantity,
      executionPrice: Number(order?.fillPrice ?? 0),
      premium: scaledPremium,
      executedAt: nowIso(),
      externalOrderId: String(order?.id || `DERIBIT-ORD-${randomUUID()}`),
      externalExecutionId: String(order?.id || `DERIBIT-EXE-${randomUUID()}`),
      details: {
        raw: order,
        fillStatus,
        rejectionReason: rejectionReasonRaw,
        requestedQuantity,
        executedQuantity,
        fillRatio
      }
    };
  }

  async getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    const [orderBookPayload, spot] = await Promise.all([
      this.connector.getOrderBook(params.instrumentId),
      resolveDeribitSpot(this.connector)
    ]);
    const top = extractTopOfBook(orderBookPayload);
    const markBtc = extractMarkPrice(orderBookPayload);
    const unitPrice =
      markBtc
        ? markBtc * spot
        : top.ask && top.bid
          ? ((top.ask + top.bid) / 2) * spot
          : top.ask
            ? top.ask * spot
            : top.bid
              ? top.bid * spot
              : NaN;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error("mark_unavailable");
    }
    const quantity = Math.max(0, Number(params.quantity || 0));
    return {
      markPremium: Number((unitPrice * quantity).toFixed(4)),
      unitPrice: Number(unitPrice.toFixed(4)),
      source: markBtc ? "deribit_mark_price" : "deribit_top_of_book",
      asOf: nowIso(),
      details: {
        markPriceBtc: markBtc,
        askPriceBtc: top.ask,
        bidPriceBtc: top.bid,
        spotPriceUsd: spot
      }
    };
  }
}

class IbkrCmeAdapter implements PilotVenueAdapter {
  constructor(
    private connector: IbkrConnector,
    private mode: "ibkr_cme_live" | "ibkr_cme_paper",
    private quoteTtlMs: number,
    private accountId: string,
    private orderTimeoutMs: number,
    private enableExecution: boolean,
    private maxRepriceSteps: number,
    private repriceStepTicks: number,
    private maxSlippageBps: number,
    private requireLiveTransport: boolean,
    private orderTif: "IOC" | "DAY",
    private maxTenorDriftDays: number,
    private preferTenorAtOrAbove: boolean,
    private primaryProductFamily: "MBT" | "BFF",
    private enableBffFallback: boolean,
    private bffProductFamily: "MBT" | "BFF",
    private maxFuturesSyntheticPremiumRatio: number,
    private maxOptionPremiumRatio: number,
    private optionProtectionTolerancePct: number,
    private optionProbeParallelism: number,
    private optionLiquiditySelectionEnabled: boolean,
    private optionTenorWindowDays: number,
    private requireOptionsNative: boolean,
    private marketDataRequestTimeoutMs: number,
    private quoteBudgetMs: number
  ) {}

  private resolveRight(protectionType?: "long" | "short"): "P" | "C" {
    return protectionType === "short" ? "C" : "P";
  }

  private async ensureRequiredLiveTransport(): Promise<void> {
    if (!this.requireLiveTransport) return;
    await this.connector.assertLiveTransportRequired();
  }

  private async resolveContractAndBook(req: QuoteRequest): Promise<{
    contract: IbkrQualifiedContract;
    hedgeMode: "options_native" | "futures_synthetic";
    top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
    requestedTenorDays: number;
    selectedTenorDays: number | null;
    tenorDriftDays: number | null;
    selectedExpiry: string | null;
    selectionReason: string;
    selectionAlgorithm: string;
    selectedScore: number | null;
    selectedRank: number | null;
    selectedIsBelowTarget: boolean | null;
    candidateCountEvaluated: number;
    matchedTenorHoursEstimate: number | null;
    matchedTenorDisplay: string | null;
    selectionTrace: Array<{
      conId: number;
      expiry: string | null;
      matchedTenorDays: number | null;
      driftDays: number | null;
      ask: number | null;
      bid: number | null;
      askSize: number | null;
      spreadPct: number | null;
      belowTarget: boolean;
      score: number;
    }>;
    strike: number | null;
    hedgeInstrumentFamily: "MBT" | "BFF";
    candidateFailureCounts?: {
      nTotalCandidates: number;
      nNoTop: number;
      nNoAsk: number;
      nFailedProtection: number;
      nFailedEconomics: number;
      nTimedOut: number;
      nPassed: number;
    };
  }> {
    type OptionFailureCounts = {
      nTotalCandidates: number;
      nNoTop: number;
      nNoAsk: number;
      nFailedProtection: number;
      nFailedEconomics: number;
      nTimedOut: number;
      nPassed: number;
    };
    const requestedTenorDays = clampInt(req.requestedTenorDays, 1, 30, 7);
    const minTenorDays = clampInt(req.tenorMinDays, 1, 30, 1);
    const maxTenorDays = clampInt(req.tenorMaxDays, minTenorDays, 30, Math.max(minTenorDays, 7));
    const selectedTenorDays = Math.max(minTenorDays, Math.min(maxTenorDays, requestedTenorDays));
    const trigger = toFinitePositive(req.triggerPrice);
    const adverseMovePct = Number(req.protectionType === "short" ? 0 : req.drawdownFloorPct ?? 0);
    const roundedStrike = trigger ? Math.max(1000, Math.round(trigger / 500) * 500) : null;
    const right = this.resolveRight(req.protectionType);
    const hedgePolicy = req.hedgePolicy || "options_primary_futures_fallback";
    const optionStrikeCandidates = (baseStrike: number, optionRight: "P" | "C"): number[] => {
      const step = 500;
      // Prefer slightly more protective strikes first before widening symmetrically.
      const offsetSteps = optionRight === "P" ? [0, 1, -1, 2, -2, 3, -3] : [0, -1, 1, -2, 2, -3, 3];
      const seen = new Set<number>();
      const ladder: number[] = [];
      for (const offset of offsetSteps) {
        const strike = Math.max(1000, baseStrike + offset * step);
        if (seen.has(strike)) continue;
        seen.add(strike);
        ladder.push(strike);
      }
      return ladder;
    };
    // Buy-side quote reliability requires an executable ask. Bid-only books are treated
    // as non-actionable and should continue searching/fallback.
    const hasUsableTop = (top: { ask: number | null; bid: number | null }): boolean =>
      toFinitePositive(top.ask) !== null;
    const topFromDepthPayload = (depth: {
      bids?: Array<{ price?: unknown; size?: unknown }>;
      asks?: Array<{ price?: unknown; size?: unknown }>;
      asOf?: unknown;
    }): { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string } => {
      const bestBid = depth.bids?.[0];
      const bestAsk = depth.asks?.[0];
      return {
        bid: toFinitePositive(bestBid?.price),
        ask: toFinitePositive(bestAsk?.price),
        bidSize: toFinitePositive(bestBid?.size),
        askSize: toFinitePositive(bestAsk?.size),
        asOf: String(depth.asOf || nowIso())
      };
    };
    const quoteDeadlineMs =
      Number.isFinite(this.quoteBudgetMs) && this.quoteBudgetMs > 0
        ? Date.now() + this.quoteBudgetMs - 150
        : null;
    const ensureBudget = (minimumRemainingMs = 0): void => {
      if (quoteDeadlineMs === null) return;
      if (Date.now() + Math.max(0, minimumRemainingMs) >= quoteDeadlineMs) {
        throw new Error("venue_quote_timeout");
      }
    };
    const requestWindowHintMs = Math.max(
      400,
      Math.min(4000, Math.floor(Number(this.marketDataRequestTimeoutMs || 0)))
    );
    const optionLiquiditySelectionEnabled = this.optionLiquiditySelectionEnabled !== false;
    const optionProbeParallelism = Math.max(1, Math.min(6, Math.floor(Number(this.optionProbeParallelism || 0)) || 3));
    const optionTenorWindowDays = Math.max(0, Math.min(14, Math.floor(Number(this.optionTenorWindowDays || 0)) || 3));
    const calcTenorDaysFromExpiry = (expiryRaw?: string): number | null => {
      const expiry = String(expiryRaw || "").replace(/[^0-9]/g, "").slice(0, 8);
      if (expiry.length !== 8) return null;
      const y = Number(expiry.slice(0, 4));
      const m = Number(expiry.slice(4, 6));
      const d = Number(expiry.slice(6, 8));
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
      const expiryTs = Date.UTC(y, Math.max(0, m - 1), d, 8, 0, 0, 0);
      if (!Number.isFinite(expiryTs)) return null;
      const tenorDays = (expiryTs - Date.now()) / 86400000;
      return Number.isFinite(tenorDays) ? tenorDays : null;
    };
    const contractTenorMeta = (contract: IbkrQualifiedContract): {
      selectedTenorDays: number | null;
      tenorDriftDays: number | null;
    } => {
      const selectedTenorDays = calcTenorDaysFromExpiry(contract.expiry);
      const tenorDriftDays =
        selectedTenorDays !== null ? Math.abs(selectedTenorDays - selectedTenorDaysIntended) : null;
      return { selectedTenorDays, tenorDriftDays };
    };
    const selectedTenorDaysIntended = selectedTenorDays;
    const contractPassesTenorPolicy = (contract: IbkrQualifiedContract): boolean => {
      const meta = contractTenorMeta(contract);
      if (
        Number.isFinite(this.maxTenorDriftDays) &&
        this.maxTenorDriftDays >= 0 &&
        meta.tenorDriftDays !== null &&
        meta.tenorDriftDays - this.maxTenorDriftDays > 1e-9
      ) {
        return false;
      }
      return true;
    };
    const contractPassesOptionTenorWindow = (contract: IbkrQualifiedContract): boolean => {
      const meta = contractTenorMeta(contract);
      if (meta.selectedTenorDays === null) return false;
      const drift = Math.abs(meta.selectedTenorDays - selectedTenorDaysIntended);
      return drift <= optionTenorWindowDays + 1e-9;
    };
    const rankByTenor = (a: IbkrQualifiedContract, b: IbkrQualifiedContract): number => {
      const aMeta = contractTenorMeta(a);
      const bMeta = contractTenorMeta(b);
      const aTenor = aMeta.selectedTenorDays;
      const bTenor = bMeta.selectedTenorDays;
      const aDrift = aMeta.tenorDriftDays ?? Number.POSITIVE_INFINITY;
      const bDrift = bMeta.tenorDriftDays ?? Number.POSITIVE_INFINITY;
      const aPenalty = this.preferTenorAtOrAbove && aTenor !== null && aTenor < selectedTenorDaysIntended ? 1 : 0;
      const bPenalty = this.preferTenorAtOrAbove && bTenor !== null && bTenor < selectedTenorDaysIntended ? 1 : 0;
      if (aPenalty !== bPenalty) return aPenalty - bPenalty;
      if (aDrift !== bDrift) return aDrift - bDrift;
      return String(a.expiry || "").localeCompare(String(b.expiry || ""));
    };
    const pickContractWithTop = async (
      contracts: IbkrQualifiedContract[],
      opts?: {
        maxPreferred?: number;
        maxBelow?: number;
        depthAttempts?: number;
        probeTimeoutMs?: number;
        legBudgetMs?: number;
      }
    ): Promise<
      | {
          contract: IbkrQualifiedContract;
          top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
          eligibleCount: number;
          selectedScore: number;
          selectedRank: number;
          selectedIsBelowTarget: boolean;
          candidateCountEvaluated: number;
          selectionTrace: Array<{
            conId: number;
            expiry: string | null;
            matchedTenorDays: number | null;
            driftDays: number | null;
            ask: number | null;
            bid: number | null;
            askSize: number | null;
            spreadPct: number | null;
            belowTarget: boolean;
            score: number;
          }>;
        }
      | null
    > => {
      const eligible = [...contracts]
        .filter(contractPassesTenorPolicy)
        .sort(rankByTenor);
      // Keep shortlist compact and probe in-ranked order to reduce market-data fanout,
      // which is especially important when bridge latency is non-trivial (e.g. ngrok/private tunnel).
      const maxPreferred = Math.max(1, Math.floor(Number(opts?.maxPreferred ?? 3)));
      const maxBelow = Math.max(0, Math.floor(Number(opts?.maxBelow ?? 1)));
      const depthAttempts = Math.max(1, Math.min(3, Math.floor(Number(opts?.depthAttempts ?? 2))));
      const probeTimeoutMs = Math.max(
        350,
        Math.min(
          2500,
          Math.floor(Number(opts?.probeTimeoutMs ?? Math.max(450, Math.min(1800, requestWindowHintMs))))
        )
      );
      const legBudgetMs = Number.isFinite(Number(opts?.legBudgetMs))
        ? Math.max(probeTimeoutMs + 300, Math.floor(Number(opts?.legBudgetMs)))
        : null;
      const legDeadlineMs = legBudgetMs !== null ? Date.now() + legBudgetMs : null;
      const ensureLegBudget = (minimumRemainingMs = 0): void => {
        ensureBudget(minimumRemainingMs);
        if (legDeadlineMs === null) return;
        if (Date.now() + Math.max(0, minimumRemainingMs) >= legDeadlineMs) {
          throw new Error("venue_quote_timeout");
        }
      };
      const withProbeTimeout = async <T>(
        promise: Promise<T>,
        timeoutMs: number
      ): Promise<T | null> => {
        let timer: NodeJS.Timeout | null = null;
        try {
          return await Promise.race([
            promise,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), timeoutMs);
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const withDepthProbeBudget = async (
        promise: Promise<{
          bids?: Array<{ price?: unknown; size?: unknown }>;
          asks?: Array<{ price?: unknown; size?: unknown }>;
          asOf?: unknown;
        }>
      ): Promise<{
        bids?: Array<{ price?: unknown; size?: unknown }>;
        asks?: Array<{ price?: unknown; size?: unknown }>;
        asOf?: unknown;
      } | null> => {
        // Depth snapshots are often slower than top-of-book on IBKR; allow a bounded
        // extension for depth probes so futures fallback can succeed when top is null.
        const depthTimeoutMs = Math.max(
          probeTimeoutMs,
          Math.min(12000, Math.floor(probeTimeoutMs * 2))
        );
        return await withProbeTimeout(promise, depthTimeoutMs);
      };
      const preferred = this.preferTenorAtOrAbove
        ? eligible.filter((contract) => {
            const tenor = contractTenorMeta(contract).selectedTenorDays;
            return tenor !== null && tenor + 1e-9 >= selectedTenorDaysIntended;
          })
        : eligible;
      const belowTarget = this.preferTenorAtOrAbove
        ? eligible.filter((contract) => {
            const tenor = contractTenorMeta(contract).selectedTenorDays;
            return tenor !== null && tenor + 1e-9 < selectedTenorDaysIntended;
          })
        : [];
      const shortlisted = [
        ...preferred.slice(0, maxPreferred),
        ...belowTarget.slice(0, maxBelow)
      ].filter((contract, idx, arr) => arr.findIndex((x) => x.conId === contract.conId) === idx);
      if (shortlisted.length === 0) return null;

      const attempts: Array<{
        contract: IbkrQualifiedContract;
        top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string } | null;
        ask: number | null;
        bid: number | null;
        askSize: number | null;
        spreadPct: number | null;
        belowTarget: boolean;
        score: number;
        driftDays: number | null;
      }> = [];

      for (const contract of shortlisted) {
        ensureLegBudget(probeTimeoutMs + 250);
        const tenorMeta = contractTenorMeta(contract);
        const belowTargetCandidate =
          tenorMeta.selectedTenorDays !== null ? tenorMeta.selectedTenorDays + 1e-9 < selectedTenorDaysIntended : false;
        let chosenTop:
          | { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string }
          | null = null;

        try {
          const top = await withProbeTimeout(
            this.connector.getTopOfBook(contract.conId),
            probeTimeoutMs
          );
          if (top && hasUsableTop(top)) {
            chosenTop = top;
          }
        } catch {
          // Continue to depth fallback for this candidate.
        }

        if (!chosenTop) {
          // Retry depth once because snapshot/top and depth can arrive out-of-phase on IB.
          for (let depthAttempt = 0; depthAttempt < depthAttempts; depthAttempt += 1) {
            if (depthAttempt > 0) {
              await wait(220);
            }
            ensureLegBudget(Math.min(probeTimeoutMs + 200, 700));
            try {
              const depth = await withDepthProbeBudget(
                this.connector.getDepth(contract.conId)
              );
              const depthTop = depth ? topFromDepthPayload(depth) : null;
              if (depthTop && hasUsableTop(depthTop)) {
                chosenTop = depthTop;
                break;
              }
            } catch {
              // Probe next attempt/candidate.
            }
          }
        }

        const ask = toFinitePositive(chosenTop?.ask);
        const bid = toFinitePositive(chosenTop?.bid);
        const askSize = toFinitePositive(chosenTop?.askSize);
        const spreadPct =
          ask !== null && ask > 0 && bid !== null && bid > 0 && ask >= bid
            ? (ask - bid) / ask
            : null;
        const tenorPenalty = (tenorMeta.tenorDriftDays ?? 10) * 100;
        const belowTargetPenalty = this.preferTenorAtOrAbove && belowTargetCandidate ? 40 : 0;
        const spreadPenalty = Math.max(0, Math.min(0.25, spreadPct ?? 0.25)) * 100;
        const sizePenalty = askSize === null ? 8 : 0;
        const score = tenorPenalty + belowTargetPenalty + spreadPenalty + sizePenalty;

        attempts.push({
          contract,
          top: chosenTop,
          ask,
          bid,
          askSize,
          spreadPct,
          belowTarget: belowTargetCandidate,
          score,
          driftDays: tenorMeta.tenorDriftDays
        });

        if (ask !== null && chosenTop) {
          const trace = attempts.slice(0, 3).map((row) => {
            const meta = contractTenorMeta(row.contract);
            return {
              conId: row.contract.conId,
              expiry: String(row.contract.expiry || "") || null,
              matchedTenorDays: meta.selectedTenorDays,
              driftDays: meta.tenorDriftDays,
              ask: row.ask,
              bid: row.bid,
              askSize: row.askSize,
              spreadPct: row.spreadPct,
              belowTarget: row.belowTarget,
              score: Number(row.score.toFixed(6))
            };
          });
          return {
            contract,
            top: chosenTop,
            eligibleCount: eligible.length,
            selectedScore: Number(score.toFixed(6)),
            selectedRank: 1,
            selectedIsBelowTarget: belowTargetCandidate,
            candidateCountEvaluated: attempts.length,
            selectionTrace: trace
          };
        }
      }
      return null;
    };
    const probeOptionCandidates = async (
      contracts: IbkrQualifiedContract[],
      minProtectionThreshold: number | null,
      opts?: { probeTimeoutMs?: number; depthAttempts?: number; legBudgetMs?: number }
    ): Promise<
      | {
          contract: IbkrQualifiedContract;
          top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
          selectedScore: number;
          selectedRank: number;
          candidateCountEvaluated: number;
          selectionTrace: Array<{
            conId: number;
            expiry: string | null;
            matchedTenorDays: number | null;
            driftDays: number | null;
            ask: number | null;
            bid: number | null;
            askSize: number | null;
            spreadPct: number | null;
            belowTarget: boolean;
            score: number;
          }>;
          failureCounts: OptionFailureCounts;
        }
      | { failureCounts: OptionFailureCounts }
    > => {
      const eligible = [...contracts]
        .filter(contractPassesTenorPolicy)
        .filter(contractPassesOptionTenorWindow)
        .sort(rankByTenor);
      const shortlist = eligible.slice(0, 18);
      const failureCounts: OptionFailureCounts = {
        nTotalCandidates: shortlist.length,
        nNoTop: 0,
        nNoAsk: 0,
        nFailedProtection: 0,
        nFailedEconomics: 0,
        nTimedOut: 0,
        nPassed: 0
      };
      if (!shortlist.length) {
        return { failureCounts };
      }
      const probeTimeoutMs = Math.max(
        450,
        Math.min(3000, Math.floor(Number(opts?.probeTimeoutMs ?? Math.max(700, requestWindowHintMs))))
      );
      const depthAttempts = Math.max(1, Math.min(2, Math.floor(Number(opts?.depthAttempts ?? 1))));
      const legBudgetMs = Number.isFinite(Number(opts?.legBudgetMs))
        ? Math.max(2500, Math.floor(Number(opts?.legBudgetMs)))
        : Math.max(5000, Math.min(18000, Math.floor(this.quoteBudgetMs * 0.5)));
      const legDeadlineMs = Date.now() + legBudgetMs;
      const ensureLegBudget = (minimumRemainingMs = 0): void => {
        ensureBudget(minimumRemainingMs);
        if (Date.now() + Math.max(0, minimumRemainingMs) >= legDeadlineMs) {
          throw new Error("venue_quote_timeout");
        }
      };
      const withProbeTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<{ value: T | null; timedOut: boolean }> => {
        let timer: NodeJS.Timeout | null = null;
        let timedOut = false;
        try {
          const value = await Promise.race([
            promise,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve(null);
              }, timeoutMs);
            })
          ]);
          return { value: (value as T | null) ?? null, timedOut };
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      type Scored = {
        contract: IbkrQualifiedContract;
        top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
        ask: number;
        bid: number | null;
        askSize: number | null;
        spreadPct: number | null;
        driftDays: number;
        matchedTenorDays: number;
        belowTarget: boolean;
        protectionCoveragePct: number | null;
        premiumRatio: number;
        score: number;
      };
      const passed: Scored[] = [];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= shortlist.length) return;
          ensureLegBudget(probeTimeoutMs + 150);
          const contract = shortlist[idx];
          const tenorMeta = contractTenorMeta(contract);
          const matchedTenorDays = tenorMeta.selectedTenorDays;
          const driftDays = tenorMeta.tenorDriftDays ?? Number.POSITIVE_INFINITY;
          const belowTarget = matchedTenorDays !== null ? matchedTenorDays + 1e-9 < selectedTenorDaysIntended : false;
          let chosenTop:
            | { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string }
            | null = null;
          const topProbe = await withProbeTimeout(this.connector.getTopOfBook(contract.conId), probeTimeoutMs);
          if (topProbe.timedOut) {
            failureCounts.nTimedOut += 1;
          }
          if (topProbe.value && hasUsableTop(topProbe.value)) {
            chosenTop = topProbe.value;
          } else {
            if (!topProbe.value) {
              failureCounts.nNoTop += 1;
            }
            for (let attempt = 0; attempt < depthAttempts; attempt += 1) {
              ensureLegBudget(Math.min(probeTimeoutMs, 900));
              const depthProbe = await withProbeTimeout(this.connector.getDepth(contract.conId), Math.min(12000, probeTimeoutMs * 2));
              if (depthProbe.timedOut) {
                failureCounts.nTimedOut += 1;
              }
              const depthTop = depthProbe.value ? topFromDepthPayload(depthProbe.value) : null;
              if (depthTop && hasUsableTop(depthTop)) {
                chosenTop = depthTop;
                break;
              }
              if (attempt + 1 < depthAttempts) {
                await wait(200);
              }
            }
          }
          if (!chosenTop) {
            failureCounts.nNoTop += 1;
            continue;
          }
          const ask = toFinitePositive(chosenTop.ask);
          const bid = toFinitePositive(chosenTop.bid);
          const askSize = toFinitePositive(chosenTop.askSize);
          if (ask === null) {
            failureCounts.nNoAsk += 1;
            continue;
          }
          const spreadPct =
            bid !== null && bid > 0 && ask >= bid
              ? (ask - bid) / ask
              : null;
          const strike = parseIbkrStrikeFromLocalSymbol(contract);
          const inferredEntry =
            trigger &&
            Number.isFinite(adverseMovePct) &&
            adverseMovePct > 0 &&
            adverseMovePct < 1 &&
            trigger > 0
              ? req.protectionType === "short"
                ? trigger / (1 + adverseMovePct)
                : trigger / (1 - adverseMovePct)
              : null;
          const protectionCoveragePct =
            inferredEntry && strike && inferredEntry > 0
              ? right === "P"
                ? ((inferredEntry - strike) / inferredEntry) * 100
                : ((strike - inferredEntry) / inferredEntry) * 100
              : null;
          if (
            minProtectionThreshold !== null &&
            protectionCoveragePct !== null &&
            protectionCoveragePct + 1e-9 < minProtectionThreshold
          ) {
            failureCounts.nFailedProtection += 1;
            continue;
          }
          const notional = Math.max(0, Number(req.protectedNotional || 0));
          const qty = Math.max(0, Number(req.quantity || 0));
          const premiumRatio = notional > 0 ? (ask * qty) / notional : 0;
          if (
            Number.isFinite(this.maxOptionPremiumRatio) &&
            this.maxOptionPremiumRatio > 0 &&
            premiumRatio > this.maxOptionPremiumRatio
          ) {
            failureCounts.nFailedEconomics += 1;
            continue;
          }
          const spreadPenalty = Math.max(0, Math.min(0.3, spreadPct ?? 0.3)) * 100;
          const sizePenalty = askSize === null ? 20 : 1 / Math.max(0.1, askSize);
          const protectionPenalty =
            minProtectionThreshold !== null && protectionCoveragePct !== null
              ? Math.max(0, minProtectionThreshold - protectionCoveragePct) * 2
              : 0;
          const economicsPenalty = premiumRatio * 200;
          const tenorPenalty = Math.max(0, driftDays) * 0.4;
          const score = spreadPenalty * 5 + sizePenalty * 10 + protectionPenalty * 8 + economicsPenalty * 4 + tenorPenalty;
          passed.push({
            contract,
            top: chosenTop,
            ask,
            bid,
            askSize,
            spreadPct,
            driftDays: Number.isFinite(driftDays) ? driftDays : 999,
            matchedTenorDays: matchedTenorDays ?? selectedTenorDaysIntended,
            belowTarget,
            protectionCoveragePct,
            premiumRatio,
            score
          });
          failureCounts.nPassed += 1;
        }
      };
      const workers = Array.from({ length: optionProbeParallelism }, () => worker());
      await Promise.all(workers);
      if (!passed.length) {
        return { failureCounts };
      }
      passed.sort((a, b) => a.score - b.score);
      const best = passed[0];
      const trace = passed.slice(0, 5).map((row) => ({
        conId: row.contract.conId,
        expiry: String(row.contract.expiry || "") || null,
        matchedTenorDays: row.matchedTenorDays,
        driftDays: row.driftDays,
        ask: row.ask,
        bid: row.bid,
        askSize: row.askSize,
        spreadPct: row.spreadPct,
        belowTarget: row.belowTarget,
        score: Number(row.score.toFixed(6))
      }));
      return {
        contract: best.contract,
        top: best.top,
        selectedScore: Number(best.score.toFixed(6)),
        selectedRank: 1,
        candidateCountEvaluated: shortlist.length,
        selectionTrace: trace,
        failureCounts
      };
    };

    let sawTenorEligibleContract = false;
    let sawFallbackContracts = false;
    const optionFailureTotals: OptionFailureCounts = {
      nTotalCandidates: 0,
      nNoTop: 0,
      nNoAsk: 0,
      nFailedProtection: 0,
      nFailedEconomics: 0,
      nTimedOut: 0,
      nPassed: 0
    };
    const accumulateOptionFailureCounts = (counts?: OptionFailureCounts): void => {
      if (!counts) return;
      optionFailureTotals.nTotalCandidates += Number(counts.nTotalCandidates || 0);
      optionFailureTotals.nNoTop += Number(counts.nNoTop || 0);
      optionFailureTotals.nNoAsk += Number(counts.nNoAsk || 0);
      optionFailureTotals.nFailedProtection += Number(counts.nFailedProtection || 0);
      optionFailureTotals.nFailedEconomics += Number(counts.nFailedEconomics || 0);
      optionFailureTotals.nTimedOut += Number(counts.nTimedOut || 0);
      optionFailureTotals.nPassed += Number(counts.nPassed || 0);
    };
    const queryWithProductFamily = (
      query: IbkrContractQuery,
      productFamily: "MBT" | "BFF"
    ): IbkrContractQuery => ({
      ...query,
      productFamily
    });
    const runFallbackLeg = async (
      productFamily: "MBT" | "BFF",
      reason: "options_unavailable_futures_fallback" | "options_and_mbt_unavailable_bff_fallback"
    ): Promise<{
      contract: IbkrQualifiedContract;
      hedgeMode: "futures_synthetic";
      top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
      requestedTenorDays: number;
      selectedTenorDays: number | null;
      tenorDriftDays: number | null;
      selectedExpiry: string | null;
      selectionReason: string;
      selectionAlgorithm: string;
      selectedScore: number | null;
      selectedRank: number | null;
      selectedIsBelowTarget: boolean | null;
      candidateCountEvaluated: number;
      matchedTenorHoursEstimate: number | null;
      matchedTenorDisplay: string | null;
      selectionTrace: Array<{
        conId: number;
        expiry: string | null;
        matchedTenorDays: number | null;
        driftDays: number | null;
        ask: number | null;
        bid: number | null;
        askSize: number | null;
        spreadPct: number | null;
        belowTarget: boolean;
        score: number;
      }>;
      strike: null;
      hedgeInstrumentFamily: "MBT" | "BFF";
    } | null> => {
      ensureBudget(requestWindowHintMs);
      const futQuery: IbkrContractQuery = queryWithProductFamily(
        {
          kind: "mbt_future",
          symbol: "BTC",
          exchange: "CME",
          currency: "USD",
          tenorDays: selectedTenorDays
        },
        productFamily
      );
      const futContracts = await this.connector.qualifyContracts(futQuery);
      sawFallbackContracts ||= futContracts.length > 0;
      sawTenorEligibleContract ||= futContracts.some(contractPassesTenorPolicy);
      const futMatch = await pickContractWithTop(futContracts, {
        maxPreferred: 4,
        maxBelow: 2,
        depthAttempts: 2,
        probeTimeoutMs: Math.max(1200, Math.min(4500, requestWindowHintMs)),
        legBudgetMs: Math.max(6000, Math.min(30000, Math.floor(this.quoteBudgetMs * 0.8)))
      });
      if (!futMatch) return null;
      const futMeta = contractTenorMeta(futMatch.contract);
      return {
        contract: futMatch.contract,
        hedgeMode: "futures_synthetic",
        top: futMatch.top,
        requestedTenorDays: selectedTenorDaysIntended,
        selectedTenorDays: futMeta.selectedTenorDays,
        tenorDriftDays: futMeta.tenorDriftDays,
        selectedExpiry: String(futMatch.contract.expiry || "") || null,
        selectionReason: reason,
        selectionAlgorithm: "tenor_quality_v1",
        selectedScore: futMatch.selectedScore,
        selectedRank: futMatch.selectedRank,
        selectedIsBelowTarget: futMatch.selectedIsBelowTarget,
        candidateCountEvaluated: futMatch.candidateCountEvaluated,
        matchedTenorHoursEstimate:
          futMeta.selectedTenorDays !== null
            ? Number((futMeta.selectedTenorDays * 24).toFixed(4))
            : null,
        matchedTenorDisplay: formatMatchedTenorDisplay(futMeta.selectedTenorDays),
        selectionTrace: futMatch.selectionTrace,
        strike: null,
        hedgeInstrumentFamily: productFamily
      };
    };
    const runOptionLeg = async (
      productFamily: "MBT" | "BFF",
      reason: "best_tenor_liquidity_option" | "primary_options_unavailable_secondary_options_fallback"
    ): Promise<{
      contract: IbkrQualifiedContract;
      hedgeMode: "options_native";
      top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
      requestedTenorDays: number;
      selectedTenorDays: number | null;
      tenorDriftDays: number | null;
      selectedExpiry: string | null;
      selectionReason: string;
      selectionAlgorithm: string;
      selectedScore: number | null;
      selectedRank: number | null;
      selectedIsBelowTarget: boolean | null;
      candidateCountEvaluated: number;
      matchedTenorHoursEstimate: number | null;
      matchedTenorDisplay: string | null;
      selectionTrace: Array<{
        conId: number;
        expiry: string | null;
        matchedTenorDays: number | null;
        driftDays: number | null;
        ask: number | null;
        bid: number | null;
        askSize: number | null;
        spreadPct: number | null;
        belowTarget: boolean;
        score: number;
      }>;
      strike: number | null;
      hedgeInstrumentFamily: "MBT" | "BFF";
      candidateFailureCounts?: {
        nTotalCandidates: number;
        nNoTop: number;
        nNoAsk: number;
        nFailedProtection: number;
        nFailedEconomics: number;
        nTimedOut: number;
        nPassed: number;
      };
    } | null> => {
      if (!roundedStrike) return null;
      const strikeCandidates = optionStrikeCandidates(roundedStrike, right);
      const strikeCandidatesForMode = this.optionLiquiditySelectionEnabled
        ? strikeCandidates
        : strikeCandidates.slice(0, 3);
      const tenorCandidates = this.optionLiquiditySelectionEnabled
        ? (() => {
            const values: number[] = [];
            const pushIfNew = (v: number): void => {
              const day = clampInt(v, minTenorDays, maxTenorDays, selectedTenorDaysIntended);
              if (!values.includes(day)) values.push(day);
            };
            pushIfNew(selectedTenorDaysIntended);
            for (let offset = 1; offset <= optionTenorWindowDays; offset += 1) {
              if (this.preferTenorAtOrAbove) {
                pushIfNew(selectedTenorDaysIntended + offset);
                pushIfNew(selectedTenorDaysIntended - offset);
              } else {
                pushIfNew(selectedTenorDaysIntended - offset);
                pushIfNew(selectedTenorDaysIntended + offset);
              }
            }
            return values;
          })()
        : [selectedTenorDaysIntended];
      const dedupedContracts: IbkrQualifiedContract[] = [];
      const seenConIds = new Set<number>();
      const optionLegBudgetMs = this.optionLiquiditySelectionEnabled
        ? Math.max(10_000, Math.min(22_000, Math.floor(this.quoteBudgetMs * 0.38)))
        : Math.max(4_200, Math.min(11_000, Math.floor(this.quoteBudgetMs * 0.22)));
      const optionLegDeadlineMs = Date.now() + optionLegBudgetMs;
      const ensureOptionLegBudget = (minimumRemainingMs = 0): void => {
        ensureBudget(minimumRemainingMs);
        if (Date.now() + Math.max(0, minimumRemainingMs) >= optionLegDeadlineMs) {
          throw new Error("venue_quote_timeout");
        }
      };
      const qualifyTimeoutMs = this.optionLiquiditySelectionEnabled
        ? Math.max(1500, Math.min(3500, Math.floor(requestWindowHintMs * 0.9)))
        : Math.max(700, Math.min(1600, Math.floor(requestWindowHintMs * 0.55)));
      const qualifyParallelism = this.optionLiquiditySelectionEnabled ? Math.max(2, Math.min(4, optionProbeParallelism)) : 1;
      const withQualifyTimeout = async (
        promise: Promise<IbkrQualifiedContract[]>,
        timeoutMs: number
      ): Promise<{ contracts: IbkrQualifiedContract[]; timedOut: boolean }> => {
        let timer: NodeJS.Timeout | null = null;
        let timedOut = false;
        try {
          const value = await Promise.race([
            promise,
            new Promise<IbkrQualifiedContract[]>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                resolve([]);
              }, timeoutMs);
            })
          ]);
          return { contracts: Array.isArray(value) ? value : [], timedOut };
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const runQualifyTasks = async (qualifyTasks: Array<{ tenor: number; strike: number }>): Promise<void> => {
        if (!qualifyTasks.length) return;
        let qualifyCursor = 0;
        const runQualifyWorker = async (): Promise<void> => {
          while (true) {
            const idx = qualifyCursor;
            qualifyCursor += 1;
            if (idx >= qualifyTasks.length) return;
            ensureOptionLegBudget(Math.min(qualifyTimeoutMs + 150, 1200));
            const task = qualifyTasks[idx];
            const optionQuery: IbkrContractQuery = queryWithProductFamily(
              {
                kind: "mbt_option",
                symbol: "BTC",
                exchange: "CME",
                currency: "USD",
                tenorDays: task.tenor,
                right,
                strike: task.strike
              },
              productFamily
            );
            let optionContracts: IbkrQualifiedContract[] = [];
            try {
              const qualified = await withQualifyTimeout(this.connector.qualifyContracts(optionQuery), qualifyTimeoutMs);
              if (qualified.timedOut) {
                optionFailureTotals.nTimedOut += 1;
              }
              optionContracts = qualified.contracts;
            } catch {
              optionFailureTotals.nTimedOut += 1;
              optionContracts = [];
            }
            sawTenorEligibleContract ||= optionContracts.some(contractPassesTenorPolicy);
            for (const contract of optionContracts) {
              if (seenConIds.has(contract.conId)) continue;
              seenConIds.add(contract.conId);
              dedupedContracts.push(contract);
            }
          }
        };
        await Promise.all(Array.from({ length: qualifyParallelism }, () => runQualifyWorker()));
      };
      if (!this.optionLiquiditySelectionEnabled) {
        const qualifyTasks: Array<{ tenor: number; strike: number }> = [];
        for (const tenorCandidate of tenorCandidates) {
          for (const strikeCandidate of strikeCandidatesForMode) {
            qualifyTasks.push({ tenor: tenorCandidate, strike: strikeCandidate });
          }
        }
        await runQualifyTasks(qualifyTasks);
        const optionMatch = await pickContractWithTop(dedupedContracts, {
          // Keep option probing bounded so fallback legs still have remaining budget.
          maxPreferred: 3,
          maxBelow: 1,
          depthAttempts: 2,
          probeTimeoutMs: Math.max(450, Math.min(1100, Math.floor(requestWindowHintMs * 0.7))),
          legBudgetMs: Math.max(2200, Math.min(6800, Math.floor(this.quoteBudgetMs * 0.3)))
        });
        if (!optionMatch) return null;
        const optionMeta = contractTenorMeta(optionMatch.contract);
        return {
          contract: optionMatch.contract,
          hedgeMode: "options_native",
          top: optionMatch.top,
          requestedTenorDays: selectedTenorDaysIntended,
          selectedTenorDays: optionMeta.selectedTenorDays,
          tenorDriftDays: optionMeta.tenorDriftDays,
          selectedExpiry: String(optionMatch.contract.expiry || "") || null,
          selectionReason: reason,
          selectionAlgorithm: "tenor_quality_v1",
          selectedScore: optionMatch.selectedScore,
          selectedRank: optionMatch.selectedRank,
          selectedIsBelowTarget: optionMatch.selectedIsBelowTarget,
          candidateCountEvaluated: optionMatch.candidateCountEvaluated,
          matchedTenorHoursEstimate:
            optionMeta.selectedTenorDays !== null ? Number((optionMeta.selectedTenorDays * 24).toFixed(4)) : null,
          matchedTenorDisplay: formatMatchedTenorDisplay(optionMeta.selectedTenorDays),
          selectionTrace: optionMatch.selectionTrace,
          strike: toFinitePositive(optionMatch.contract.strike) || roundedStrike,
          hedgeInstrumentFamily: productFamily
        };
      }

      const minProtectionThreshold =
        Number.isFinite(adverseMovePct) && adverseMovePct > 0
          ? Math.max(0, adverseMovePct * 100 - this.optionProtectionTolerancePct)
          : null;
      // Progressive widening: search closest tenor/strike rings first, then expand.
      // This prioritizes finding executable liquidity quickly while still allowing
      // a wider search when early rings do not provide enough viable candidates.
      const ringTasks: Array<Array<{ tenor: number; strike: number }>> = [];
      const seenRingTaskKeys = new Set<string>();
      for (let ring = 0; ring < tenorCandidates.length; ring += 1) {
        const tenor = tenorCandidates[ring];
        const strikeDepth =
          ring === 0
            ? Math.min(3, strikeCandidatesForMode.length)
            : ring === 1
              ? Math.min(5, strikeCandidatesForMode.length)
              : strikeCandidatesForMode.length;
        const ringGroup: Array<{ tenor: number; strike: number }> = [];
        for (const strike of strikeCandidatesForMode.slice(0, strikeDepth)) {
          const key = `${tenor}:${strike}`;
          if (seenRingTaskKeys.has(key)) continue;
          seenRingTaskKeys.add(key);
          ringGroup.push({ tenor, strike });
        }
        if (ringGroup.length) {
          ringTasks.push(ringGroup);
        }
      }
      let bestOptionMatch:
        | {
            contract: IbkrQualifiedContract;
            top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
            selectedScore: number;
            selectedRank: number;
            candidateCountEvaluated: number;
            selectionTrace: Array<{
              conId: number;
              expiry: string | null;
              matchedTenorDays: number | null;
              driftDays: number | null;
              ask: number | null;
              bid: number | null;
              askSize: number | null;
              spreadPct: number | null;
              belowTarget: boolean;
              score: number;
            }>;
            failureCounts: OptionFailureCounts;
          }
        | null = null;
      let latestFailureCounts: OptionFailureCounts | null = null;
      const minViableCandidatesBeforeStop = 3;
      for (const ringGroup of ringTasks) {
        await runQualifyTasks(ringGroup);
        if (!dedupedContracts.length) {
          continue;
        }
        const optionProbeBudgetMs = Math.max(1200, optionLegDeadlineMs - Date.now() - 120);
        if (optionProbeBudgetMs < 1200) {
          break;
        }
        const optionMatch = await probeOptionCandidates(dedupedContracts, minProtectionThreshold, {
          probeTimeoutMs: Math.max(650, Math.min(1800, requestWindowHintMs)),
          depthAttempts: 1,
          legBudgetMs: Math.max(1200, Math.min(6000, optionProbeBudgetMs))
        });
        latestFailureCounts = optionMatch.failureCounts;
        if (!("contract" in optionMatch)) {
          continue;
        }
        if (!bestOptionMatch || optionMatch.selectedScore < bestOptionMatch.selectedScore) {
          bestOptionMatch = optionMatch;
        }
        const viableCount = Number(optionMatch.failureCounts.nPassed || 0);
        if (viableCount >= minViableCandidatesBeforeStop) {
          break;
        }
      }
      if (!bestOptionMatch) {
        if (latestFailureCounts) {
          accumulateOptionFailureCounts(latestFailureCounts);
        }
        return null;
      }
      accumulateOptionFailureCounts(bestOptionMatch.failureCounts);
      const optionMatch = bestOptionMatch;
      const optionMeta = contractTenorMeta(optionMatch.contract);
      return {
        contract: optionMatch.contract,
        hedgeMode: "options_native",
        top: optionMatch.top,
        requestedTenorDays: selectedTenorDaysIntended,
        selectedTenorDays: optionMeta.selectedTenorDays,
        tenorDriftDays: optionMeta.tenorDriftDays,
        selectedExpiry: String(optionMatch.contract.expiry || "") || null,
        selectionReason: reason,
        selectionAlgorithm: "liquidity_protection_first_v1",
        selectedScore: optionMatch.selectedScore,
        selectedRank: optionMatch.selectedRank,
        selectedIsBelowTarget: optionMatch.selectedIsBelowTarget,
        candidateCountEvaluated: optionMatch.candidateCountEvaluated,
        matchedTenorHoursEstimate:
          optionMeta.selectedTenorDays !== null ? Number((optionMeta.selectedTenorDays * 24).toFixed(4)) : null,
        matchedTenorDisplay: formatMatchedTenorDisplay(optionMeta.selectedTenorDays),
        selectionTrace: optionMatch.selectionTrace,
        strike: toFinitePositive(optionMatch.contract.strike) || roundedStrike,
        hedgeInstrumentFamily: productFamily,
        candidateFailureCounts: optionMatch.failureCounts
      };
    };
    if (hedgePolicy === "options_primary_futures_fallback") {
      const allowBffFallback = this.enableBffFallback && this.primaryProductFamily !== this.bffProductFamily;
      let optionLegTimedOut = false;
      const runOptionLegWithTimeoutFallback = async (
        productFamily: "MBT" | "BFF",
        reason: "best_tenor_liquidity_option" | "primary_options_unavailable_secondary_options_fallback"
      ): Promise<{
        contract: IbkrQualifiedContract;
        hedgeMode: "options_native";
        top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
        requestedTenorDays: number;
        selectedTenorDays: number | null;
        tenorDriftDays: number | null;
        selectedExpiry: string | null;
        selectionReason: string;
        selectionAlgorithm: string;
        selectedScore: number | null;
        selectedRank: number | null;
        selectedIsBelowTarget: boolean | null;
        candidateCountEvaluated: number;
        matchedTenorHoursEstimate: number | null;
        matchedTenorDisplay: string | null;
        selectionTrace: Array<{
          conId: number;
          expiry: string | null;
          matchedTenorDays: number | null;
          driftDays: number | null;
          ask: number | null;
          bid: number | null;
          askSize: number | null;
          spreadPct: number | null;
          belowTarget: boolean;
          score: number;
        }>;
        strike: number | null;
        hedgeInstrumentFamily: "MBT" | "BFF";
        candidateFailureCounts?: {
          nTotalCandidates: number;
          nNoTop: number;
          nNoAsk: number;
          nFailedProtection: number;
          nFailedEconomics: number;
          nTimedOut: number;
          nPassed: number;
        };
      } | null> => {
        try {
          return await runOptionLeg(productFamily, reason);
        } catch (error) {
          const message = String((error as Error)?.message || "");
          if (message.includes("venue_quote_timeout")) {
            optionLegTimedOut = true;
            return null;
          }
          throw error;
        }
      };
      const primaryOptions = await runOptionLegWithTimeoutFallback(
        this.primaryProductFamily,
        "best_tenor_liquidity_option"
      );
      if (primaryOptions) {
        return primaryOptions;
      }
      // If options probing already exhausted its leg budget, skip additional option-family probing
      // and route directly to futures fallback while quote budget is still available.
      if (allowBffFallback && !optionLegTimedOut) {
        const secondaryOptions = await runOptionLegWithTimeoutFallback(
          this.bffProductFamily,
          "primary_options_unavailable_secondary_options_fallback"
        );
        if (secondaryOptions) {
          return secondaryOptions;
        }
      }

      const primaryFallback = await runFallbackLeg(
        this.primaryProductFamily,
        "options_unavailable_futures_fallback"
      );
      if (primaryFallback) {
        if (this.requireOptionsNative) {
          throw new Error("ibkr_quote_unavailable:options_required");
        }
        return primaryFallback;
      }

      if (allowBffFallback) {
        const bffFallback = await runFallbackLeg(
          this.bffProductFamily,
          "options_and_mbt_unavailable_bff_fallback"
        );
        if (bffFallback) {
          if (this.requireOptionsNative) {
            throw new Error("ibkr_quote_unavailable:options_required");
          }
          return bffFallback;
        }
      }
      if (!sawTenorEligibleContract) {
        throw new Error("ibkr_quote_unavailable:tenor_drift_exceeded");
      }
      if (sawFallbackContracts) {
        if (this.optionLiquiditySelectionEnabled && optionFailureTotals.nTotalCandidates > 0) {
          throw new Error(
            `ibkr_quote_unavailable:no_top_of_book:no_viable_option:${JSON.stringify(optionFailureTotals)}`
          );
        }
        throw new Error("ibkr_quote_unavailable:no_top_of_book");
      }
      throw new Error("ibkr_quote_unavailable:tenor_drift_exceeded");
    }

    throw new Error("ibkr_quote_unavailable:no_contract");
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    await this.ensureRequiredLiveTransport();
    const resolved = await this.resolveContractAndBook(req);
    const ask = toFinitePositive(resolved.top.ask);
    const bid = toFinitePositive(resolved.top.bid);
    const unitPrice = ask;
    if (!unitPrice) {
      throw new Error("ibkr_quote_unavailable:no_top_of_book");
    }
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    const notional = Math.max(0, Number(req.protectedNotional || 0));
    const referenceQty = Math.max(0, Number(req.quantity || 0));
    const premium = Number((Math.max(unitPrice * referenceQty, notional * 0.001)).toFixed(4));
    const premiumRatio = notional > 0 ? premium / notional : 0;
    if (
      resolved.hedgeMode === "futures_synthetic" &&
      Number.isFinite(this.maxFuturesSyntheticPremiumRatio) &&
      this.maxFuturesSyntheticPremiumRatio > 0 &&
      premiumRatio > this.maxFuturesSyntheticPremiumRatio
    ) {
      throw new Error(
        `ibkr_quote_unavailable:premium_ratio_exceeded:${Number(premiumRatio.toFixed(8))}`
      );
    }
    const instrumentId = buildIbkrInstrumentId(resolved.contract);
    const trigger = toFinitePositive(req.triggerPrice);
    const strikeGapToTriggerUsd =
      trigger !== null && resolved.strike !== null ? resolved.strike - trigger : null;
    const strikeGapToTriggerPct =
      trigger && trigger > 0 && strikeGapToTriggerUsd !== null ? strikeGapToTriggerUsd / trigger : null;

    return {
      venue: this.mode,
      quoteId: randomUUID(),
      rfqId: null,
      instrumentId,
      side: "buy",
      quantity: referenceQty,
      premium,
      expiresAt,
      quoteTs,
      details: {
        source: "ibkr_top_of_book",
        pricing: resolved.hedgeInstrumentFamily === "BFF" ? "cme_bff" : "cme_mbt",
        hedgeMode: resolved.hedgeMode,
        hedgeInstrumentFamily: resolved.hedgeInstrumentFamily,
        premiumRatio,
        requestedTenorDays: resolved.requestedTenorDays,
        selectedTenorDays: resolved.selectedTenorDays,
        tenorDriftDays: resolved.tenorDriftDays,
        selectedExpiry: resolved.selectedExpiry,
        selectionReason: resolved.selectionReason,
        selectionAlgorithm: resolved.selectionAlgorithm,
        selectedScore: resolved.selectedScore,
        selectedRank: resolved.selectedRank,
        selectedIsBelowTarget: resolved.selectedIsBelowTarget,
        candidateCountEvaluated: resolved.candidateCountEvaluated,
        matchedTenorHoursEstimate: resolved.matchedTenorHoursEstimate,
        matchedTenorDisplay: resolved.matchedTenorDisplay,
        selectionTrace: resolved.selectionTrace,
        askPrice: ask,
        bidPrice: bid,
        askSize: resolved.top.askSize,
        bidSize: resolved.top.bidSize,
        selectedStrike: resolved.strike,
        targetTriggerPrice: trigger,
        strikeGapToTriggerUsd,
        strikeGapToTriggerPct,
        conId: resolved.contract.conId,
        secType: resolved.contract.secType,
        localSymbol: resolved.contract.localSymbol,
        expiry: resolved.contract.expiry,
        multiplier: resolved.contract.multiplier,
        minTick: resolved.contract.minTick ?? null,
        candidateFailureCounts: resolved.candidateFailureCounts ?? null
      }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    if (!this.enableExecution) {
      return {
        venue: this.mode,
        status: "failure",
        quoteId: quote.quoteId,
        rfqId: quote.rfqId ?? null,
        instrumentId: quote.instrumentId,
        side: "buy",
        quantity: 0,
        executionPrice: 0,
        premium: 0,
        executedAt: nowIso(),
        externalOrderId: `IBKR-DISABLED-${randomUUID()}`,
        externalExecutionId: `IBKR-DISABLED-${randomUUID()}`,
        details: { reason: "execution_disabled" }
      };
    }

    const details = (quote.details || {}) as Record<string, unknown>;
    const conId = toFinitePositive(details.conId) || parseIbkrConId(quote.instrumentId);
    if (!conId) {
      throw new Error("ibkr_execute_failed:missing_conid");
    }
    const minTick = toFinitePositive(details.minTick) || 5;
    const market = await this.connector.getTopOfBook(conId);
    const baseAsk = toFinitePositive(market.ask);
    const baseBid = toFinitePositive(market.bid);
    const baseLimit = baseAsk ?? baseBid;
    if (!baseLimit) {
      throw new Error("ibkr_execute_failed:no_market");
    }
    const stepTicks = Math.max(0.1, Number(this.repriceStepTicks || 0));
    const maxSteps = Math.max(1, Math.floor(this.maxRepriceSteps || 1));
    const maxSlipPct = Math.max(0, Number(this.maxSlippageBps || 0)) / 10_000;
    const maxLimit = baseLimit * (1 + maxSlipPct);
    const requestedQty = Math.max(0.00000001, Number(quote.quantity || 0));
    const contractMultiplier = Math.max(0.00000001, Number(details.multiplier ?? 0.1));
    const requestedContracts = Math.max(1, Math.ceil(requestedQty / contractMultiplier));

    let lastOrderId = "";
    let lastFailureDetail: Record<string, unknown> | null = null;
    const isTerminal = (status: string): boolean =>
      status === "filled" || status === "partially_filled" || status === "cancelled" || status === "rejected" || status === "inactive";
    for (let step = 0; step < maxSteps; step += 1) {
      const limitPrice = Math.min(maxLimit, baseLimit + step * stepTicks * minTick);
      const placed = await this.connector.placeOrder({
        accountId: this.accountId,
        conId,
        side: "BUY",
        quantity: requestedContracts,
        orderType: "LMT",
        limitPrice,
        tif: this.orderTif,
        clientOrderId: `pilot-${quote.quoteId}-${step}`
      });
      lastOrderId = placed.orderId;
      const statusDeadline = Date.now() + Math.max(800, Math.floor(Number(this.orderTimeoutMs || 0)));
      let state = await this.connector.getOrder(placed.orderId);
      while (
        Date.now() < statusDeadline &&
        state.status === "submitted" &&
        Math.max(0, Number(state.filledQuantity || 0)) === 0
      ) {
        await wait(200);
        state = await this.connector.getOrder(placed.orderId);
      }
      const filledQtyContracts = Math.max(0, Number(state.filledQuantity || 0));
      if (filledQtyContracts > 0 && (state.status === "filled" || state.status === "partially_filled")) {
        const executedQuantity = Number((filledQtyContracts * contractMultiplier).toFixed(8));
        const executionPrice = toFinitePositive(state.avgFillPrice) || limitPrice;
        const unitPrice = executionPrice * contractMultiplier;
        return {
          venue: this.mode,
          status: "success",
          quoteId: quote.quoteId,
          rfqId: quote.rfqId ?? null,
          instrumentId: quote.instrumentId,
          side: "buy",
          quantity: executedQuantity,
          executionPrice,
          premium: Number((unitPrice * filledQtyContracts).toFixed(6)),
          executedAt: nowIso(),
          externalOrderId: placed.orderId,
          externalExecutionId: placed.orderId,
          details: {
            hedgeMode: details.hedgeMode || "options_native",
            fillStatus: state.status,
            requestedContracts,
            filledContracts: filledQtyContracts,
            contractMultiplier,
            filledUnderlying: Number((filledQtyContracts * contractMultiplier).toFixed(8)),
            limitPrice,
            commissionUsd: toFinitePositive(state.commissionUsd) || 0,
            commissionCurrency: String(state.commissionCurrency || "USD"),
            realizedBrokerFeesUsd: toFinitePositive(state.commissionUsd) || 0,
            realizedBrokerFeesCurrency: String(state.commissionCurrency || "USD"),
            repriceStep: step
          }
        };
      }
      const terminalState = await this.connector.getOrder(placed.orderId);
      const terminalStatus = String(terminalState.status || "");
      const terminalFilledQty = Math.max(0, Number(terminalState.filledQuantity || 0));
      if (terminalFilledQty > 0 && (terminalStatus === "filled" || terminalStatus === "partially_filled")) {
        const executedQuantity = Number((terminalFilledQty * contractMultiplier).toFixed(8));
        const executionPrice = toFinitePositive(terminalState.avgFillPrice) || limitPrice;
        const unitPrice = executionPrice * contractMultiplier;
        return {
          venue: this.mode,
          status: "success",
          quoteId: quote.quoteId,
          rfqId: quote.rfqId ?? null,
          instrumentId: quote.instrumentId,
          side: "buy",
          quantity: executedQuantity,
          executionPrice,
          premium: Number((unitPrice * terminalFilledQty).toFixed(6)),
          executedAt: nowIso(),
          externalOrderId: placed.orderId,
          externalExecutionId: placed.orderId,
          details: {
            hedgeMode: details.hedgeMode || "options_native",
            fillStatus: terminalState.status,
            requestedContracts,
            filledContracts: terminalFilledQty,
            contractMultiplier,
            filledUnderlying: Number((terminalFilledQty * contractMultiplier).toFixed(8)),
            limitPrice,
            commissionUsd: toFinitePositive(terminalState.commissionUsd) || 0,
            commissionCurrency: String(terminalState.commissionCurrency || "USD"),
            realizedBrokerFeesUsd: toFinitePositive(terminalState.commissionUsd) || 0,
            realizedBrokerFeesCurrency: String(terminalState.commissionCurrency || "USD"),
            repriceStep: step
          }
        };
      }
      if (!isTerminal(terminalStatus)) {
        await this.connector.cancelOrder(placed.orderId);
      }
      lastFailureDetail = {
        reason: "no_fill_after_step",
        fillStatus: terminalState.status,
        rejectionReason: terminalState.rejectionReason || null,
        requestedContracts,
        filledContracts: terminalFilledQty,
        contractMultiplier,
        limitPrice,
        orderTif: this.orderTif,
        repriceStep: step
      };
    }

    return {
      venue: this.mode,
      status: "failure",
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: 0,
      executionPrice: 0,
      premium: 0,
      executedAt: nowIso(),
      externalOrderId: lastOrderId || `IBKR-NO-FILL-${randomUUID()}`,
      externalExecutionId: lastOrderId || `IBKR-NO-FILL-${randomUUID()}`,
      details: {
        reason: "no_fill_after_reprice",
        orderTif: this.orderTif,
        ...(lastFailureDetail || {})
      }
    };
  }

  async getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    const conId = parseIbkrConId(params.instrumentId);
    if (!conId) {
      throw new Error("mark_unavailable");
    }
    const top = await this.connector.getTopOfBook(conId);
    const bid = toFinitePositive(top.bid);
    const ask = toFinitePositive(top.ask);
    const unitPrice = bid && ask ? (bid + ask) / 2 : ask ?? bid;
    if (!unitPrice) {
      throw new Error("mark_unavailable");
    }
    const quantity = Math.max(0, Number(params.quantity || 0));
    return {
      markPremium: Number((unitPrice * quantity).toFixed(6)),
      unitPrice: Number(unitPrice.toFixed(6)),
      source: "ibkr_top_of_book_mid",
      asOf: nowIso(),
      details: {
        bid,
        ask,
        conId
      }
    };
  }
}

class FalconxAdapter implements PilotVenueAdapter {
  constructor(private cfg: FalconxConfig) {}

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const [baseToken, quoteTokenRaw] = req.marketId.split("-");
    const quoteToken = quoteTokenRaw === "USD" || !quoteTokenRaw ? "USDC" : quoteTokenRaw;
    const payload = {
      token_pair: {
        base_token: baseToken,
        quote_token: quoteToken
      },
      quantity: req.quantity,
      structure: [
        {
          side: req.side,
          symbol: req.instrumentId,
          weight: 1
        }
      ],
      client_order_id: req.clientOrderId || randomUUID()
    };
    const response = await falconxRequest(this.cfg, "/v3/derivatives/option/quote", "POST", payload);
    if (String(response?.status || "").toLowerCase() !== "success") {
      throw new Error(`falconx_quote_failed:${response?.error?.code || "unknown"}`);
    }
    return {
      venue: "falconx",
      quoteId: String(response.fx_quote_id),
      rfqId: response.rfq_id ? String(response.rfq_id) : null,
      instrumentId: req.instrumentId,
      side: "buy",
      quantity: Number(response.quantity ?? req.quantity),
      premium: Number(response.ask_price?.value ?? 0),
      expiresAt: String(response.t_expiry || nowIso()),
      quoteTs: String(response.t_quote || nowIso()),
      details: response
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    const response = await falconxRequest(
      this.cfg,
      "/v3/derivatives/option/quote/execute",
      "POST",
      { fx_quote_id: quote.quoteId }
    );
    if (String(response?.status || "").toLowerCase() !== "success") {
      throw new Error(`falconx_execute_failed:${response?.error?.code || "unknown"}`);
    }
    return {
      venue: "falconx",
      status: "success",
      quoteId: String(response.fx_quote_id || quote.quoteId),
      rfqId: response.rfq_id ? String(response.rfq_id) : quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: Number(response.quantity ?? quote.quantity),
      executionPrice: Number(response.executed_price ?? 0),
      premium: Number(response.executed_price ?? quote.premium),
      executedAt: String(response.t_execute || nowIso()),
      externalOrderId: String(response.fx_quote_id || quote.quoteId),
      externalExecutionId: String(response.rfq_id || quote.rfqId || randomUUID()),
      details: response
    };
  }

  async getMark(): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    throw new Error("mark_unavailable");
  }
}

export const createPilotVenueAdapter = (params: {
  mode: PilotVenueMode;
  falconx: FalconxConfig;
  deribit: DeribitConnector;
  ibkr?: IbkrVenueConfig;
  ibkrQuoteBudgetMs?: number;
  quoteTtlMs?: number;
  deribitQuotePolicy?: DeribitQuotePolicy;
  deribitStrikeSelectionMode?: DeribitStrikeSelectionMode;
  deribitMaxTenorDriftDays?: number;
}): PilotVenueAdapter => {
  const quoteTtlMs = Math.max(5_000, Number(params.quoteTtlMs || 30_000));
  if (params.mode === "falconx") return new FalconxAdapter(params.falconx);
  if (params.mode === "ibkr_cme_live" || params.mode === "ibkr_cme_paper") {
    if (!params.ibkr) {
      throw new Error("ibkr_config_missing");
    }
    const connectorTimeoutMs = Math.max(
      500,
      Number(params.ibkr.bridgeTimeoutMs || 0),
      Number(params.ibkr.orderTimeoutMs || 0)
    );
    const ibkrConnector = new IbkrConnector({
      baseUrl: params.ibkr.bridgeBaseUrl,
      // Use the more permissive timeout so quote/market-data paths do not abort early
      // when IB request latency exceeds execution polling timeout.
      timeoutMs: connectorTimeoutMs,
      auth: { token: params.ibkr.bridgeToken },
      accountId: params.ibkr.accountId
    });
    return new IbkrCmeAdapter(
      ibkrConnector,
      params.mode,
      quoteTtlMs,
      params.ibkr.accountId,
      params.ibkr.orderTimeoutMs,
      params.ibkr.enableExecution,
      params.ibkr.maxRepriceSteps,
      params.ibkr.repriceStepTicks,
      params.ibkr.maxSlippageBps,
      params.ibkr.requireLiveTransport,
      params.ibkr.orderTif || "IOC",
      Number.isFinite(Number(params.ibkr.maxTenorDriftDays)) ? Number(params.ibkr.maxTenorDriftDays) : 7,
      params.ibkr.preferTenorAtOrAbove !== false,
      params.ibkr.primaryProductFamily === "BFF" ? "BFF" : "MBT",
      params.ibkr.enableBffFallback === true,
      params.ibkr.bffProductFamily === "MBT" ? "MBT" : "BFF",
      Number.isFinite(Number(params.ibkr.maxFuturesSyntheticPremiumRatio))
        ? Number(params.ibkr.maxFuturesSyntheticPremiumRatio)
        : 0.05,
      Number.isFinite(Number(params.ibkr.maxOptionPremiumRatio))
        ? Number(params.ibkr.maxOptionPremiumRatio)
        : 0.15,
      Number.isFinite(Number(params.ibkr.optionProtectionTolerancePct))
        ? Math.max(0, Number(params.ibkr.optionProtectionTolerancePct))
        : 0.03,
      Number.isFinite(Number(params.ibkr.optionProbeParallelism))
        ? Math.max(1, Math.min(8, Math.floor(Number(params.ibkr.optionProbeParallelism))))
        : 3,
      params.ibkr.optionLiquiditySelectionEnabled === true,
      Number.isFinite(Number(params.ibkr.optionTenorWindowDays))
        ? Math.max(0, Math.min(14, Math.floor(Number(params.ibkr.optionTenorWindowDays))))
        : 3,
      params.ibkr.requireOptionsNative === true,
      connectorTimeoutMs,
      Number(params.ibkrQuoteBudgetMs || 0)
    );
  }
  if (params.mode === "deribit_test") {
    return new DeribitTestAdapter(
      params.deribit,
      quoteTtlMs,
      params.deribitQuotePolicy || "ask_or_mark_fallback",
      params.deribitStrikeSelectionMode || "trigger_aligned",
      Number.isFinite(Number(params.deribitMaxTenorDriftDays))
        ? Number(params.deribitMaxTenorDriftDays)
        : 1.5
    );
  }
  return new MockFalconxAdapter(quoteTtlMs);
};

export const mapVenueFailureReason = (error: unknown): string => {
  const message = String((error as any)?.message || "venue_error");
  if (message.includes("QUOTE_EXPIRED")) return "quote_expired";
  if (message.includes("INVALID_QUOTE_ID")) return "invalid_quote_id";
  if (message.includes("COOLDOWN")) return "execution_cooldown";
  if (message.includes("INSUFFICIENT")) return "insufficient_balance";
  if (message.includes("tenor_drift_exceeded")) return "tenor_drift_exceeded";
  return "venue_error";
};

