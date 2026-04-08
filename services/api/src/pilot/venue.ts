import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  DeribitConnector,
  IbkrConnector,
  type IbkrContractQuery,
  type IbkrQualifiedContract
} from "@foxify/connectors";
import type {
  BullishRuntimeConfig,
  DeribitQuotePolicy,
  DeribitStrikeSelectionMode,
  HedgeOptimizerRuntimeConfig,
  PilotHedgePolicy,
  PilotSelectorMode,
  PilotVenueMode
} from "./config";
import type { HedgeCandidate, VenueExecution, VenueQuote } from "./types";
import { toHedgeCandidate } from "./hedgeCandidates";
import { selectBestHedgeCandidate } from "./hedgeScoring";
import { resolveHedgeRegime } from "./regimePolicy";
import { BullishTradingClient, resolveBullishMarketSymbol } from "./bullish";
import {
  type HedgeOptimizationConfig,
  parseHedgeOptimizationConfig,
  resolveOptimalTenor,
  evaluateRollOpportunity,
  resolveDynamicStrikeRange,
  HedgeBatchManager
} from "./hedgeOptimizations";

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
  strictTenor?: boolean;
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
  qualifyCacheTtlMs?: number;
  qualifyCacheMaxKeys?: number;
  selectorMode?: PilotSelectorMode;
  hedgeOptimizer?: HedgeOptimizerRuntimeConfig;
};

const nowIso = (): string => new Date().toISOString();
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toFinitePositiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseBullishOptionSymbol = (
  symbol: string
): { expiry: string; strike: number; optionType: "CALL" | "PUT" } | null => {
  const match = String(symbol || "")
    .trim()
    .toUpperCase()
    .match(/^BTC-USDC-(\d{8})-(\d+(?:\.\d+)*)-(C|P)$/);
  if (!match) return null;
  const strike = Number(match[2]);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    expiry: match[1],
    strike,
    optionType: match[3] === "C" ? "CALL" : "PUT"
  };
};

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

const resolveContractMultiplier = (value: unknown, fallback = 0.1): number => {
  const raw = Number(value);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return fallback;
};

const deriveNoViableOptionReason = (counts: {
  nTotalCandidates: number;
  nNoTop: number;
  nNoAsk: number;
  nFailedProtection: number;
  nFailedEconomics: number;
  nFailedMinTradableNotional?: number;
}):
  | "no_economical_option"
  | "no_protection_compliant_option"
  | "min_tradable_notional_exceeded"
  | "no_top_of_book" => {
  const total = Math.max(0, Number(counts.nTotalCandidates || 0));
  if (total <= 0) return "no_top_of_book";
  const failedMinTradableNotional = Math.max(0, Number(counts.nFailedMinTradableNotional || 0));
  const failedEconomics = Math.max(0, Number(counts.nFailedEconomics || 0));
  const failedProtection = Math.max(0, Number(counts.nFailedProtection || 0));
  const failedLiquidity = Math.max(0, Number(counts.nNoTop || 0)) + Math.max(0, Number(counts.nNoAsk || 0));
  if (failedMinTradableNotional > 0 && failedProtection <= 0) {
    return "min_tradable_notional_exceeded";
  }
  // Prefer explicit economics/protection failure taxonomy over generic liquidity
  // when those constraints are actually what blocked candidate viability.
  if (failedEconomics > 0 && failedProtection <= 0) {
    return "no_economical_option";
  }
  if (failedProtection > 0 && failedEconomics <= 0) {
    return "no_protection_compliant_option";
  }
  if (failedEconomics > 0 && failedEconomics >= failedProtection && failedEconomics >= failedLiquidity) {
    return "no_economical_option";
  }
  if (failedProtection > 0 && failedProtection >= failedLiquidity) {
    return "no_protection_compliant_option";
  }
  return "no_top_of_book";
};

const isLikelyNoLiquidityWindow = (counts: {
  nTotalCandidates: number;
  nNoTop: number;
  nNoAsk: number;
  nFailedProtection: number;
  nFailedEconomics: number;
  nPassed: number;
  nTimedOut?: number;
}): boolean => {
  const total = Math.max(0, Number(counts.nTotalCandidates || 0));
  if (total <= 0) return false;
  const passed = Math.max(0, Number(counts.nPassed || 0));
  const noTop = Math.max(0, Number(counts.nNoTop || 0));
  const noAsk = Math.max(0, Number(counts.nNoAsk || 0));
  const failedProtection = Math.max(0, Number(counts.nFailedProtection || 0));
  const failedEconomics = Math.max(0, Number(counts.nFailedEconomics || 0));
  const timedOut = Math.max(0, Number(counts.nTimedOut || 0));
  const marketDataUnavailable =
    noTop + noAsk >= Math.max(1, Math.floor(total * 0.8)) ||
    timedOut >= Math.max(2, Math.floor(total * 0.5));
  return (
    passed <= 0 &&
    marketDataUnavailable &&
    failedProtection <= 0 &&
    failedEconomics <= 0
  );
};

const normalizeNoLiquidityWindowError = (
  message: string,
  counts: {
    nTotalCandidates: number;
    nNoTop: number;
    nNoAsk: number;
    nFailedProtection: number;
    nFailedEconomics: number;
    nPassed: number;
    nTimedOut?: number;
  },
  sawTenorEligibleContract: boolean
): string => {
  if (message.includes("no_liquidity_window")) return "ibkr_quote_unavailable:no_liquidity_window";
  if (message.includes("option_qualify_timeout")) return "ibkr_quote_unavailable:no_liquidity_window";
  if (!sawTenorEligibleContract) return message;
  if (message.includes("tenor_drift_exceeded") && isLikelyNoLiquidityWindow(counts)) {
    return "ibkr_quote_unavailable:no_liquidity_window";
  }
  return message;
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

export type SellOptionResult = {
  status: "sold" | "failed";
  instrumentId: string;
  quantity: number;
  fillPrice: number;
  totalProceeds: number;
  orderId: string | null;
  details: Record<string, unknown>;
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
  sellOption?(params: { instrumentId: string; quantity: number }): Promise<SellOptionResult>;
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

/**
 * @deprecated IBKR CME adapter -- retained for reference only.
 * All pilot execution now routes through BullishTestnetAdapter.
 * Do NOT delete: prior integration logic may inform future venue adapters.
 */
class IbkrCmeAdapter implements PilotVenueAdapter {
  private qualifyCache = new Map<string, { contracts: IbkrQualifiedContract[]; ts: number }>();
  private qualifyInFlight = new Map<string, Promise<IbkrQualifiedContract[]>>();
  private tenorLiquidityHints = new Map<string, { score: number; asOfMs: number }>();
  private selectorDiagnostics: {
    asOf: string;
    requestId: string;
    venueMode: "ibkr_cme_live" | "ibkr_cme_paper";
    timingsMs: {
      total: number;
      qualify: number;
      top: number;
      depth: number;
      score: number;
    };
    counters: {
      qualifyCalls: number;
      qualifyCacheHits: number;
      qualifyCacheMisses: number;
      topCalls: number;
      depthCalls: number;
      depthRetries: number;
      optionsFamiliesTried: number;
      optionsLegTimedOut: number;
    };
    optionCandidateFailureCounts: {
      nTotalCandidates: number;
      nNoTop: number;
      nNoAsk: number;
      nFailedProtection: number;
      nFailedEconomics: number;
      nFailedWideSpread: number;
      nFailedThinDepth: number;
      nFailedStaleTop: number;
      nTimedOut: number;
      nPassed: number;
    };
    selection?: {
      hedgeMode: "options_native" | "futures_synthetic";
      hedgeInstrumentFamily: "MBT" | "BFF";
      selectionReason: string;
      selectionAlgorithm: string;
      selectedScore: number | null;
      selectedTenorDays: number | null;
      selectedExpiry: string | null;
      selectedStrike: number | null;
      candidateCountEvaluated: number;
    };
    error?: string;
  } | null = null;

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
    private qualifyCacheTtlMs: number,
    private qualifyCacheMaxKeys: number,
    private marketDataRequestTimeoutMs: number,
    private quoteBudgetMs: number,
    private selectorMode: PilotSelectorMode,
    private hedgeOptimizer: HedgeOptimizerRuntimeConfig
  ) {}

  private resolveRight(protectionType?: "long" | "short"): "P" | "C" {
    return protectionType === "short" ? "C" : "P";
  }

  private async ensureRequiredLiveTransport(): Promise<void> {
    if (!this.requireLiveTransport) return;
    await this.connector.assertLiveTransportRequired();
  }

  getDiagnostics(): Record<string, unknown> | null {
    return this.selectorDiagnostics ? { ...this.selectorDiagnostics } : null;
  }

  private getCachedQualifiedContracts(key: string): IbkrQualifiedContract[] | null {
    const cached = this.qualifyCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.ts > Math.max(1000, this.qualifyCacheTtlMs)) {
      this.qualifyCache.delete(key);
      return null;
    }
    return cached.contracts;
  }

  private setCachedQualifiedContracts(key: string, contracts: IbkrQualifiedContract[]): void {
    this.qualifyCache.set(key, { contracts, ts: Date.now() });
    const maxKeys = Math.max(100, this.qualifyCacheMaxKeys);
    while (this.qualifyCache.size > maxKeys) {
      const firstKey = this.qualifyCache.keys().next().value;
      if (!firstKey) break;
      this.qualifyCache.delete(firstKey);
    }
  }

  private updateTenorLiquidityHint(tenorDays: number, result: {
    contractsFound: number;
    timedOut: boolean;
    hadTopLiquidity: boolean;
  }): void {
    const tenorKey = String(Math.max(1, Math.floor(Number(tenorDays) || 0)));
    const prev = this.tenorLiquidityHints.get(tenorKey);
    const baseScore = result.hadTopLiquidity ? 3 : result.contractsFound > 0 ? 1 : -2;
    const timeoutPenalty = result.timedOut ? -2 : 0;
    const nextScoreRaw = baseScore + timeoutPenalty;
    const nextScore = prev ? Math.max(-10, Math.min(10, prev.score * 0.55 + nextScoreRaw)) : nextScoreRaw;
    this.tenorLiquidityHints.set(tenorKey, {
      score: Number(nextScore.toFixed(4)),
      asOfMs: Date.now()
    });
  }

  private rankTenorCandidatesWithHints(tenorCandidates: number[], selectedTenorDaysIntended: number): number[] {
    const nowMs = Date.now();
    const staleAfterMs = Math.max(90_000, Math.min(900_000, this.qualifyCacheTtlMs * 4));
    return [...tenorCandidates].sort((a, b) => {
      const aHint = this.tenorLiquidityHints.get(String(a));
      const bHint = this.tenorLiquidityHints.get(String(b));
      const aFresh = Boolean(aHint && nowMs - aHint.asOfMs <= staleAfterMs);
      const bFresh = Boolean(bHint && nowMs - bHint.asOfMs <= staleAfterMs);
      if (aFresh && bFresh && aHint && bHint && aHint.score !== bHint.score) {
        return bHint.score - aHint.score;
      }
      if (aFresh !== bFresh) return aFresh ? -1 : 1;
      const aDrift = Math.abs(a - selectedTenorDaysIntended);
      const bDrift = Math.abs(b - selectedTenorDaysIntended);
      if (aDrift !== bDrift) return aDrift - bDrift;
      return a - b;
    });
  }

  private async qualifyContractsCached(
    query: IbkrContractQuery,
    counters: {
      qualifyCalls: number;
      qualifyCacheHits: number;
      qualifyCacheMisses: number;
    }
  ): Promise<IbkrQualifiedContract[]> {
    const key = JSON.stringify(query);
    counters.qualifyCalls += 1;
    const cached = this.getCachedQualifiedContracts(key);
    if (cached) {
      counters.qualifyCacheHits += 1;
      return cached;
    }
    counters.qualifyCacheMisses += 1;
    const inflight = this.qualifyInFlight.get(key);
    if (inflight) return inflight;
    const promise = this.connector
      .qualifyContracts(query)
      .then((contracts) => {
        const normalized = Array.isArray(contracts) ? contracts : [];
        this.setCachedQualifiedContracts(key, normalized);
        return normalized;
      })
      .finally(() => {
        this.qualifyInFlight.delete(key);
      });
    this.qualifyInFlight.set(key, promise);
    return promise;
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
    rankedAlternatives?: Array<{
      expiry: string | null;
      matchedTenorDays: number | null;
      ask: number | null;
      score: number | null;
      driftDays: number | null;
    }>;
    strike: number | null;
    hedgeInstrumentFamily: "MBT" | "BFF";
    candidateFailureCounts?: {
      nTotalCandidates: number;
      nNoTop: number;
      nNoAsk: number;
      nFailedProtection: number;
      nFailedEconomics: number;
      nFailedMinTradableNotional: number;
      nFailedWideSpread: number;
      nFailedThinDepth: number;
      nFailedStaleTop: number;
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
      nFailedMinTradableNotional: number;
      nFailedWideSpread: number;
      nFailedThinDepth: number;
      nFailedStaleTop: number;
      nTimedOut: number;
      nPassed: number;
    };

    const toSafeNumber = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const selectorStartedAt = Date.now();
    const timingsMs = { total: 0, qualify: 0, top: 0, depth: 0, score: 0 };
    const counters = {
      qualifyCalls: 0,
      qualifyCacheHits: 0,
      qualifyCacheMisses: 0,
      topCalls: 0,
      depthCalls: 0,
      depthRetries: 0,
      optionsFamiliesTried: 0,
      optionsLegTimedOut: 0
    };
    const requestedTenorDays = clampInt(req.requestedTenorDays, 1, 30, 7);
    const minTenorDays = clampInt(req.tenorMinDays, 1, 30, 1);
    const maxTenorDays = clampInt(req.tenorMaxDays, minTenorDays, 30, Math.max(minTenorDays, 7));
    const selectedTenorDays = Math.max(minTenorDays, Math.min(maxTenorDays, requestedTenorDays));
    const strictTenor = req.strictTenor === true;
    const trigger = toFinitePositive(req.triggerPrice);
    const adverseMovePctRaw = Number(req.drawdownFloorPct ?? 0);
    const adverseMovePct =
      Number.isFinite(adverseMovePctRaw) && adverseMovePctRaw > 0 ? Math.min(0.95, adverseMovePctRaw) : 0;
    const requestDetails = (req.details || {}) as Record<string, unknown>;
    const expectedTriggerCostUsdForSelection = toSafeNumber(requestDetails.expectedTriggerCostUsd) ?? 0;
    const premiumProfitabilityTargetUsdForSelection =
      toSafeNumber(requestDetails.premiumProfitabilityTargetUsd) ?? 0;
    const triggerPayoutCreditUsdForSelection = toSafeNumber(requestDetails.triggerPayoutCreditUsd) ?? 0;
    const roundedStrike = trigger ? Math.max(1000, Math.round(trigger / 500) * 500) : null;
    const right = this.resolveRight(req.protectionType);
    const hedgePolicy = req.hedgePolicy || "options_primary_futures_fallback";
    const optionStrikeCandidates = (baseStrike: number, optionRight: "P" | "C"): number[] => {
      const step = 500;
      const regimeSeed = resolveHedgeRegime({
        triggerHitRatePct: 5,
        subsidyUtilizationPct: this.selectorMode === "hybrid_treasury" ? 25 : 8,
        treasuryDrawdownPct: this.selectorMode === "hybrid_treasury" ? 18 : 5,
        iv30d: null,
        ivSkew: null
      });
      const policy = this.hedgeOptimizer.regimePolicy[regimeSeed.regime];
      const nearFirstCount = Math.max(1, Math.min(4, Math.round(policy.preferCloserStrikeBias * 4)));
      const nearFirstOffsetsPut = [0, 1, -1, 2, -2, 3, -3];
      const nearFirstOffsetsCall = [0, -1, 1, -2, 2, -3, 3];
      const farFirstOffsetsPut = [0, -1, 1, -2, 2, -3, 3];
      const farFirstOffsetsCall = [0, 1, -1, 2, -2, 3, -3];
      // Always retain full ladder coverage to avoid false futures fallback,
      // but flip closer/farther ordering by regime bias.
      const offsetSteps =
        nearFirstCount >= 3
          ? optionRight === "P"
            ? nearFirstOffsetsPut
            : nearFirstOffsetsCall
          : optionRight === "P"
            ? farFirstOffsetsPut
            : farFirstOffsetsCall;
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
      600,
      Math.min(12000, Math.floor(Number(this.marketDataRequestTimeoutMs || 0)))
    );
    const optionLiquiditySelectionEnabled = this.optionLiquiditySelectionEnabled !== false;
    const optionProbeParallelism = Math.max(1, Math.min(6, Math.floor(Number(this.optionProbeParallelism || 0)) || 3));
    const optionTenorWindowDays = Math.max(0, Math.min(30, Math.floor(Number(this.optionTenorWindowDays || 0)) || 3));
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
    const effectiveOptionTenorWindowDays = Math.max(
      optionTenorWindowDays,
      Number.isFinite(this.maxTenorDriftDays) && this.maxTenorDriftDays >= 0 ? this.maxTenorDriftDays : 0
    );
    const strikeDistanceFromRounded = (contract: IbkrQualifiedContract): number => {
      if (!roundedStrike) return Number.POSITIVE_INFINITY;
      const strike = parseIbkrStrikeFromLocalSymbol(contract);
      if (!strike) return Number.POSITIVE_INFINITY;
      return Math.abs(strike - roundedStrike);
    };
    const contractPassesOptionTenorWindow = (contract: IbkrQualifiedContract): boolean => {
      const meta = contractTenorMeta(contract);
      if (meta.selectedTenorDays === null) return false;
      const drift = Math.abs(meta.selectedTenorDays - selectedTenorDaysIntended);
      if (strictTenor) return drift <= 1.01;
      return drift <= effectiveOptionTenorWindowDays + 1e-9;
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
      opts?: { probeTimeoutMs?: number; depthAttempts?: number; legBudgetMs?: number; maxTopCalls?: number }
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
          rankedAlternatives: Array<{
            expiry: string | null;
            matchedTenorDays: number | null;
            ask: number | null;
            score: number | null;
            driftDays: number | null;
          }>;
          failureCounts: OptionFailureCounts;
        }
      | { failureCounts: OptionFailureCounts }
    > => {
      const eligible = [...contracts]
        .filter(contractPassesTenorPolicy)
        .filter(contractPassesOptionTenorWindow)
        .sort((a, b) => {
          const tenorCmp = rankByTenor(a, b);
          if (tenorCmp !== 0) return tenorCmp;
          const strikeCmp = strikeDistanceFromRounded(a) - strikeDistanceFromRounded(b);
          if (strikeCmp !== 0) return strikeCmp;
          return String(a.localSymbol || "").localeCompare(String(b.localSymbol || ""));
        });
      const shortlist = eligible.slice(
        0,
        hedgePolicy === "options_only_native" ? Math.min(12, eligible.length) : 18
      );
      const failureCounts: OptionFailureCounts = {
        nTotalCandidates: shortlist.length,
        nNoTop: 0,
        nNoAsk: 0,
        nFailedProtection: 0,
        nFailedEconomics: 0,
        nFailedMinTradableNotional: 0,
        nFailedWideSpread: 0,
        nFailedThinDepth: 0,
        nFailedStaleTop: 0,
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
      const maxTopCallsPerProbe =
        hedgePolicy === "options_only_native"
          ? Math.max(4, Math.min(8, Number(this.optionProbeParallelism || 1) * 6))
          : Number.POSITIVE_INFINITY;
      const maxTopCallsBudget = Number.isFinite(Number(opts?.maxTopCalls))
        ? Math.max(0, Math.floor(Number(opts?.maxTopCalls)))
        : Number.POSITIVE_INFINITY;
      const effectiveMaxTopCalls = Math.max(0, Math.min(maxTopCallsPerProbe, maxTopCallsBudget));
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
        triggerFeasibilityPenaltyUsd: number;
        expectedTriggerCostUsd: number;
        expectedTriggerCreditUsd: number;
        premiumProfitabilityTargetUsd: number;
        riskAdjustedPremiumRatio: number;
        score: number;
      };
      const passed: Scored[] = [];
      let topCallsInProbe = 0;
      let cursor = 0;
      if (effectiveMaxTopCalls <= 0) {
        return { failureCounts };
      }
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= shortlist.length) return;
          if (topCallsInProbe >= effectiveMaxTopCalls) return;
          const candidateBudgetHintMs =
            hedgePolicy === "options_only_native"
              ? Math.max(350, Math.min(900, probeTimeoutMs))
              : probeTimeoutMs + 150;
          ensureLegBudget(candidateBudgetHintMs);
          const contract = shortlist[idx];
          const tenorMeta = contractTenorMeta(contract);
          const matchedTenorDays = tenorMeta.selectedTenorDays;
          const driftDays = tenorMeta.tenorDriftDays ?? Number.POSITIVE_INFINITY;
          const belowTarget = matchedTenorDays !== null ? matchedTenorDays + 1e-9 < selectedTenorDaysIntended : false;
          let chosenTop:
            | { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string }
            | null = null;
          topCallsInProbe += 1;
          counters.topCalls += 1;
          const topStartedAt = Date.now();
          const topProbe = await withProbeTimeout(this.connector.getTopOfBook(contract.conId), probeTimeoutMs);
          timingsMs.top += Date.now() - topStartedAt;
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
              counters.depthCalls += 1;
              const depthStartedAt = Date.now();
              const depthProbeTimeoutMs =
                hedgePolicy === "options_only_native"
                  ? Math.max(1800, Math.min(10000, Math.floor(probeTimeoutMs * 1.1)))
                  : Math.min(12000, probeTimeoutMs * 2);
              const depthProbe = await withProbeTimeout(
                this.connector.getDepth(contract.conId),
                depthProbeTimeoutMs
              );
              timingsMs.depth += Date.now() - depthStartedAt;
              if (depthProbe.timedOut) {
                failureCounts.nTimedOut += 1;
              }
              const depthTop = depthProbe.value ? topFromDepthPayload(depthProbe.value) : null;
              if (depthTop && hasUsableTop(depthTop)) {
                chosenTop = depthTop;
                break;
              }
              if (attempt + 1 < depthAttempts) {
                counters.depthRetries += 1;
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
          const asOfMs = Date.parse(String(chosenTop.asOf || ""));
          const topAgeMs = Number.isFinite(asOfMs) ? Math.max(0, Date.now() - asOfMs) : null;
          const notional = Math.max(0, Number(req.protectedNotional || 0));
          const qty = Math.max(0, Number(req.quantity || 0));
          const contractMultiplier = resolveContractMultiplier(contract.multiplier, 0.1);
          const estimatedContracts = Math.max(1, Math.ceil(qty / contractMultiplier));
          const estimatedPremium = ask * estimatedContracts;
          const premiumRatio = notional > 0 ? estimatedPremium / notional : 0;
          const maxSpreadPctByProtection = notional >= 10000 ? 0.2 : notional >= 2000 ? 0.28 : 0.35;
          if (spreadPct !== null && spreadPct > maxSpreadPctByProtection) {
            failureCounts.nFailedEconomics += 1;
            failureCounts.nFailedWideSpread += 1;
            continue;
          }
          if (askSize !== null && askSize < 0.5) {
            failureCounts.nFailedEconomics += 1;
            failureCounts.nFailedThinDepth += 1;
            continue;
          }
          if (topAgeMs !== null && topAgeMs > 12_000) {
            failureCounts.nNoTop += 1;
            failureCounts.nFailedStaleTop += 1;
            continue;
          }
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
          if (minProtectionThreshold !== null && protectionCoveragePct === null) {
            failureCounts.nFailedProtection += 1;
            continue;
          }
          if (
            minProtectionThreshold !== null &&
            protectionCoveragePct !== null &&
            protectionCoveragePct + 1e-9 < minProtectionThreshold
          ) {
            failureCounts.nFailedProtection += 1;
            continue;
          }
          // Explicit granularity guard: if requested hedge quantity is smaller than
          // one contract's underlying multiplier, the quote economics are not tradable.
          if (qty > 0 && qty + 1e-9 < contractMultiplier) {
            failureCounts.nFailedEconomics += 1;
            failureCounts.nFailedMinTradableNotional += 1;
            continue;
          }
          if (
            Number.isFinite(this.maxOptionPremiumRatio) &&
            this.maxOptionPremiumRatio > 0 &&
            premiumRatio > this.maxOptionPremiumRatio
          ) {
            failureCounts.nFailedEconomics += 1;
            continue;
          }
          const spreadPenalty = Math.max(0, Math.min(0.45, spreadPct ?? 0.45)) * 100;
          const sizePenalty = askSize === null ? 10 : 1 / Math.max(0.2, askSize);
          const economicsPenalty = premiumRatio * 100;
          const tenorPenalty = Math.max(0, driftDays) * 20;
          const belowTargetPenalty = this.preferTenorAtOrAbove && belowTarget ? 7 : 0;
          const expectedTriggerCostUsd = expectedTriggerCostUsdForSelection;
          const premiumProfitabilityTargetUsd = premiumProfitabilityTargetUsdForSelection;
          const triggerPayoutCreditUsd = triggerPayoutCreditUsdForSelection;
          const notionalUsd = notional > 0 ? notional : 0;
          const premiumUsd = estimatedPremium;
          const premiumShortfallUsd = Math.max(0, premiumProfitabilityTargetUsd - premiumUsd);
          const triggerCoverageRatio =
            triggerPayoutCreditUsd > 0
              ? Math.max(0, Math.min(2, premiumUsd / Math.max(triggerPayoutCreditUsd, 1e-9)))
              : 1;
          const triggerFeasibilityPenalty =
            this.selectorMode === "hybrid_treasury"
              ? 0
              : triggerCoverageRatio >= 1
                ? 0
                : (1 - triggerCoverageRatio) * (notionalUsd > 0 ? 70 : 35);
          const expectedLossPenalty =
            this.selectorMode === "hybrid_treasury"
              ? 0
              : notionalUsd > 0
                ? (expectedTriggerCostUsd / notionalUsd) * 100 * 6
                : 0;
          const profitabilityPenalty =
            this.selectorMode === "hybrid_treasury"
              ? 0
              : notionalUsd > 0
                ? (premiumShortfallUsd / notionalUsd) * 100 * 12
                : 0;
          const score =
            tenorPenalty +
            belowTargetPenalty +
            spreadPenalty * 1.1 +
            sizePenalty * 6 +
            economicsPenalty * 14 +
            triggerFeasibilityPenalty +
            expectedLossPenalty +
            profitabilityPenalty;
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
            triggerFeasibilityPenaltyUsd: Number((triggerFeasibilityPenalty * 0.01 * notionalUsd).toFixed(8)),
            expectedTriggerCostUsd: Number(expectedTriggerCostUsd.toFixed(8)),
            expectedTriggerCreditUsd: Number(triggerPayoutCreditUsd.toFixed(8)),
            premiumProfitabilityTargetUsd: Number(premiumProfitabilityTargetUsd.toFixed(8)),
            riskAdjustedPremiumRatio:
              notionalUsd > 0
                ? Number(((premiumUsd + expectedTriggerCostUsd) / notionalUsd).toFixed(8))
                : premiumRatio,
            score
          });
          failureCounts.nPassed += 1;
        }
      };
      const effectiveProbeWorkers =
        hedgePolicy === "options_only_native"
          ? Math.max(2, Math.min(4, optionProbeParallelism))
          : optionProbeParallelism;
      const workers = Array.from({ length: Math.max(1, Math.min(shortlist.length, effectiveProbeWorkers)) }, () => worker());
      try {
        await Promise.all(workers);
      } catch (error) {
        const message = String((error as Error)?.message || "probe_candidates_failed");
        if (message.includes("venue_quote_timeout")) {
          failureCounts.nTimedOut += 1;
          return { failureCounts };
        }
        throw error;
      }
      if (!passed.length) {
        return { failureCounts };
      }
      passed.sort((a, b) => a.score - b.score);
      let best = passed[0];
      if (this.hedgeOptimizer.enabled) {
        const regimeDecision = resolveHedgeRegime({
          triggerHitRatePct: 5,
          subsidyUtilizationPct: this.selectorMode === "hybrid_treasury" ? 30 : 10,
          treasuryDrawdownPct: this.selectorMode === "hybrid_treasury" ? 20 : 8,
          iv30d: null,
          ivSkew: null
        });
        const optimizerCandidates: HedgeCandidate[] = passed.map((row, idx) =>
          toHedgeCandidate({
            candidateId: `option_${idx}_${row.contract.conId}`,
            hedgeMode: "options_native",
            hedgeInstrumentFamily: productFamily,
            strike: toFinitePositive(row.contract.strike),
            triggerPrice: trigger,
            tenorDays: row.matchedTenorDays,
            tenorDriftDays: row.driftDays,
            belowTargetTenor: row.belowTarget,
            ask: row.ask,
            bid: row.bid,
            askSize: row.askSize,
            spreadPct: row.spreadPct,
            premiumUsd: row.ask * Math.max(1, Math.ceil(Math.max(0, Number(req.quantity || 0)) / resolveContractMultiplier(row.contract.multiplier, 0.1))),
            premiumRatio: row.premiumRatio,
            expectedTriggerCostUsd: row.expectedTriggerCostUsd,
            expectedTriggerCreditUsd: row.expectedTriggerCreditUsd,
            premiumProfitabilityTargetUsd: row.premiumProfitabilityTargetUsd,
            expectedSubsidyUsd: Math.max(0, row.premiumProfitabilityTargetUsd - row.ask),
            liquidityPenalty: Math.max(0, (row.spreadPct ?? 0) * 100 + (row.askSize ? 1 / Math.max(row.askSize, 0.2) : 6)),
            carryPenalty: Math.max(0, row.premiumRatio * 100 * 0.3),
            basisPenalty: 0,
            fillRiskPenalty: Math.max(0, row.askSize ? 1 / Math.max(row.askSize, 0.3) : 5),
            tailProtectionScore: Math.max(0, 100 - Math.abs((toFinitePositive(row.contract.strike) ?? roundedStrike ?? 0) - (trigger ?? 0)) / Math.max(trigger ?? 1, 1) * 100)
          })
        );
        const decision = selectBestHedgeCandidate({
          candidates: optimizerCandidates,
          config: this.hedgeOptimizer,
          regime: regimeDecision.regime
        });
        if (decision) {
          const mapped = new Map(optimizerCandidates.map((candidate, idx) => [candidate.candidateId, idx]));
          const bestIdx = mapped.get(decision.selectedCandidateId);
          if (bestIdx !== undefined) {
            best = passed[bestIdx];
          }
        }
      }
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
        triggerFeasibilityPenaltyUsd: row.triggerFeasibilityPenaltyUsd,
        expectedTriggerCostUsd: row.expectedTriggerCostUsd,
        expectedTriggerCreditUsd: row.expectedTriggerCreditUsd,
        premiumProfitabilityTargetUsd: row.premiumProfitabilityTargetUsd,
        riskAdjustedPremiumRatio: row.riskAdjustedPremiumRatio,
        score: Number(row.score.toFixed(6))
      }));
      const rankedAlternatives = passed.slice(0, 3).map((row) => ({
        expiry: String(row.contract.expiry || "") || null,
        matchedTenorDays: row.matchedTenorDays,
        ask: row.ask,
        score: Number.isFinite(row.score) ? Number(row.score.toFixed(6)) : null,
        driftDays: Number.isFinite(row.driftDays) ? row.driftDays : null,
        triggerFeasibilityPenaltyUsd: row.triggerFeasibilityPenaltyUsd,
        expectedTriggerCostUsd: row.expectedTriggerCostUsd,
        expectedTriggerCreditUsd: row.expectedTriggerCreditUsd,
        premiumProfitabilityTargetUsd: row.premiumProfitabilityTargetUsd,
        riskAdjustedPremiumRatio: row.riskAdjustedPremiumRatio
      }));
      return {
        contract: best.contract,
        top: best.top,
        selectedScore: Number(best.score.toFixed(6)),
        selectedRank: 1,
        candidateCountEvaluated: shortlist.length,
        selectionTrace: trace,
        rankedAlternatives,
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
      nFailedMinTradableNotional: 0,
      nFailedWideSpread: 0,
      nFailedThinDepth: 0,
      nFailedStaleTop: 0,
      nTimedOut: 0,
      nPassed: 0
    };
    let optionLegFailureReason: string | null = null;
    let bestOptionRankedAlternatives: Array<{
      expiry: string | null;
      matchedTenorDays: number | null;
      ask: number | null;
      score: number | null;
      driftDays: number | null;
    }> = [];
    const accumulateOptionFailureCounts = (counts?: OptionFailureCounts): void => {
      if (!counts) return;
      optionFailureTotals.nTotalCandidates += Number(counts.nTotalCandidates || 0);
      optionFailureTotals.nNoTop += Number(counts.nNoTop || 0);
      optionFailureTotals.nNoAsk += Number(counts.nNoAsk || 0);
      optionFailureTotals.nFailedProtection += Number(counts.nFailedProtection || 0);
      optionFailureTotals.nFailedEconomics += Number(counts.nFailedEconomics || 0);
      optionFailureTotals.nFailedMinTradableNotional += Number(counts.nFailedMinTradableNotional || 0);
      optionFailureTotals.nFailedWideSpread += Number(counts.nFailedWideSpread || 0);
      optionFailureTotals.nFailedThinDepth += Number(counts.nFailedThinDepth || 0);
      optionFailureTotals.nFailedStaleTop += Number(counts.nFailedStaleTop || 0);
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
      const futQualifyStartedAt = Date.now();
      const futContracts = await this.qualifyContractsCached(futQuery, counters);
      timingsMs.qualify += Date.now() - futQualifyStartedAt;
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
    rankedAlternatives: Array<{
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
        nFailedMinTradableNotional: number;
        nFailedWideSpread: number;
        nFailedThinDepth: number;
        nFailedStaleTop: number;
        nTimedOut: number;
        nPassed: number;
      };
    } | null> => {
      counters.optionsFamiliesTried += 1;
      if (!roundedStrike) return null;
      const strikeCandidates = optionStrikeCandidates(roundedStrike, right);
      const strikeCandidatesForMode = this.optionLiquiditySelectionEnabled
        ? strikeCandidates
        : strikeCandidates.slice(0, 3);
      const optionSearchCeilingDays =
        hedgePolicy === "options_only_native" ? Math.min(maxTenorDays, 24) : maxTenorDays;
      const tenorCandidates = this.optionLiquiditySelectionEnabled
        ? (() => {
            const values: number[] = [];
            const pushIfNew = (v: number): void => {
              const day = clampInt(v, minTenorDays, optionSearchCeilingDays, selectedTenorDaysIntended);
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
      const orderedTenorCandidates =
        hedgePolicy === "options_only_native"
          ? this.rankTenorCandidatesWithHints(tenorCandidates, selectedTenorDaysIntended)
          : tenorCandidates;
      const dedupedContracts: IbkrQualifiedContract[] = [];
      const seenConIds = new Set<number>();
      const optionLegBudgetMs =
        hedgePolicy === "options_only_native"
          ? Math.max(16_000, Math.min(42_000, Math.floor(this.quoteBudgetMs * 0.9)))
          : this.optionLiquiditySelectionEnabled
            ? Math.max(10_000, Math.min(22_000, Math.floor(this.quoteBudgetMs * 0.38)))
            : Math.max(4_200, Math.min(11_000, Math.floor(this.quoteBudgetMs * 0.22)));
      const optionLegDeadlineMs = Date.now() + optionLegBudgetMs;
      const ensureOptionLegBudget = (minimumRemainingMs = 0): void => {
        ensureBudget(minimumRemainingMs);
        if (Date.now() + Math.max(0, minimumRemainingMs) >= optionLegDeadlineMs) {
          throw new Error("venue_quote_timeout");
        }
      };
      const qualifyRequestHintMs = Math.max(
        900,
        Math.min(12000, Math.floor(Number(this.marketDataRequestTimeoutMs || requestWindowHintMs)))
      );
      const qualifyTimeoutMs =
        hedgePolicy === "options_only_native"
          ? Math.max(2200, Math.min(7000, Math.floor(qualifyRequestHintMs * 0.7)))
          : this.optionLiquiditySelectionEnabled
            ? Math.max(2200, Math.min(9000, Math.floor(qualifyRequestHintMs * 0.8)))
            : Math.max(700, Math.min(2000, Math.floor(requestWindowHintMs * 0.55)));
      const qualifyParallelism =
        hedgePolicy === "options_only_native"
          ? 2
          : this.optionLiquiditySelectionEnabled
            ? Math.max(1, Math.min(4, optionProbeParallelism))
            : 1;
      const maxQualifyCallsPerOptionLeg =
        hedgePolicy === "options_only_native" ? 12 : Number.POSITIVE_INFINITY;
      let optionQualifyCalls = 0;
      const maxQualifiedContracts =
        hedgePolicy === "options_only_native"
          ? 72
          : this.optionLiquiditySelectionEnabled
            ? 48
            : 18;
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
      type QualifyTask = { tenor: number; strike?: number };
      let optionQualifyTimedOut = false;
      const runQualifyTasks = async (qualifyTasks: Array<QualifyTask>): Promise<void> => {
        if (!qualifyTasks.length) return;
        let qualifyCursor = 0;
        const runQualifyWorker = async (): Promise<void> => {
          while (true) {
            if (dedupedContracts.length >= maxQualifiedContracts) return;
            if (optionQualifyCalls >= maxQualifyCallsPerOptionLeg) return;
            const idx = qualifyCursor;
            qualifyCursor += 1;
            if (idx >= qualifyTasks.length) return;
            optionQualifyCalls += 1;
            ensureOptionLegBudget(Math.min(qualifyTimeoutMs + 150, 1200));
            const task = qualifyTasks[idx];
            const optionQueryBase: IbkrContractQuery = {
              kind: "mbt_option",
              symbol: "BTC",
              exchange: "CME",
              currency: "USD",
              tenorDays: task.tenor,
              right
            };
            if (Number.isFinite(Number(task.strike)) && Number(task.strike) > 0) {
              optionQueryBase.strike = Number(task.strike);
            }
            const optionQuery: IbkrContractQuery = queryWithProductFamily(optionQueryBase, productFamily);
            let optionContracts: IbkrQualifiedContract[] = [];
            try {
              const qualifyStartedAt = Date.now();
              const qualified = await withQualifyTimeout(
                this.qualifyContractsCached(optionQuery, counters),
                qualifyTimeoutMs
              );
              timingsMs.qualify += Date.now() - qualifyStartedAt;
              if (qualified.timedOut) {
                optionFailureTotals.nTimedOut += 1;
                optionLegFailureReason = "option_qualify_timeout";
                optionQualifyTimedOut = true;
              }
              optionContracts = qualified.contracts;
            } catch (error) {
              optionFailureTotals.nTimedOut += 1;
              const message = String((error as Error)?.message || "option_qualify_failed");
              optionLegFailureReason = message.includes("ib_contract_details_timeout")
                ? "option_qualify_timeout"
                : "option_qualify_failed";
              if (message.includes("ib_contract_details_timeout") || message.includes("timeout")) {
                optionQualifyTimedOut = true;
              }
              optionContracts = [];
            }
            sawTenorEligibleContract ||= optionContracts.some(contractPassesTenorPolicy);
            for (const contract of optionContracts) {
              if (seenConIds.has(contract.conId)) continue;
              seenConIds.add(contract.conId);
              dedupedContracts.push(contract);
              if (dedupedContracts.length >= maxQualifiedContracts) break;
            }
            if (dedupedContracts.length >= maxQualifiedContracts) return;
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
      // Phase 1.5: in live IBKR mode, prioritize strike-scoped option qualification
      // per tenor before broad tenor-only probing. This avoids contract-detail timeouts
      // observed on broad option-chain requests while preserving fallback behavior.
      const strikeScopedProbeWidth = hedgePolicy === "options_only_native" ? 2 : 3;
      const baseRingTasks: Array<Array<QualifyTask>> = orderedTenorCandidates.map((tenor) => {
        const strikeScoped = strikeCandidatesForMode
          .slice(0, Math.max(1, Math.min(strikeCandidatesForMode.length, strikeScopedProbeWidth)))
          .map((strike) => ({ tenor, strike }));
        if (hedgePolicy === "options_only_native") {
          // In options-only mode, qualify tenor-only first and only then strike-scoped.
          return strikeScoped.length > 0 ? [{ tenor }, ...strikeScoped] : [{ tenor }];
        }
        return strikeScoped.length > 0 ? strikeScoped : [{ tenor }];
      });
      const expandedRingTasks =
        hedgePolicy === "options_only_native"
          ? orderedTenorCandidates.map((tenor) => {
              const strikeScoped = strikeCandidatesForMode.map((strike) => ({ tenor, strike }));
              return strikeScoped.length > 0 ? [...strikeScoped, { tenor }] : [{ tenor }];
            })
          : [];
      const ringTasks: Array<Array<QualifyTask>> =
        hedgePolicy === "options_only_native" ? baseRingTasks : baseRingTasks;
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
          rankedAlternatives: Array<{
            expiry: string | null;
            matchedTenorDays: number | null;
            ask: number | null;
            score: number | null;
            driftDays: number | null;
          }>;
            failureCounts: OptionFailureCounts;
          }
        | null = null;
      const noMatchFailureTotals: OptionFailureCounts = {
        nTotalCandidates: 0,
        nNoTop: 0,
        nNoAsk: 0,
        nFailedProtection: 0,
        nFailedEconomics: 0,
        nFailedMinTradableNotional: 0,
        nFailedWideSpread: 0,
        nFailedThinDepth: 0,
        nFailedStaleTop: 0,
        nTimedOut: 0,
        nPassed: 0
      };
      const accumulateNoMatchFailureTotals = (counts: OptionFailureCounts): void => {
        noMatchFailureTotals.nTotalCandidates += Number(counts.nTotalCandidates || 0);
        noMatchFailureTotals.nNoTop += Number(counts.nNoTop || 0);
        noMatchFailureTotals.nNoAsk += Number(counts.nNoAsk || 0);
        noMatchFailureTotals.nFailedProtection += Number(counts.nFailedProtection || 0);
        noMatchFailureTotals.nFailedEconomics += Number(counts.nFailedEconomics || 0);
        noMatchFailureTotals.nFailedMinTradableNotional += Number(counts.nFailedMinTradableNotional || 0);
        noMatchFailureTotals.nFailedWideSpread += Number(counts.nFailedWideSpread || 0);
        noMatchFailureTotals.nFailedThinDepth += Number(counts.nFailedThinDepth || 0);
        noMatchFailureTotals.nFailedStaleTop += Number(counts.nFailedStaleTop || 0);
        noMatchFailureTotals.nTimedOut += Number(counts.nTimedOut || 0);
        noMatchFailureTotals.nPassed += Number(counts.nPassed || 0);
      };
      const minViableCandidatesBeforeStop = hedgePolicy === "options_only_native" ? 2 : 3;
      const maxRingPasses =
        hedgePolicy === "options_only_native"
          ? ringTasks.length
          : ringTasks.length;
      const maxTopCallsPerOptionLeg =
        hedgePolicy === "options_only_native" ? 24 : Number.POSITIVE_INFINITY;
      const topCallsAtLegStart = counters.topCalls;
      const shouldShortCircuitNoLiquidity = (counts: OptionFailureCounts): boolean => {
        if (hedgePolicy !== "options_only_native") return false;
        const passed = Math.max(0, Number(counts.nPassed || 0));
        if (passed > 0) return false;
        const total = Math.max(0, Number(counts.nTotalCandidates || 0));
        if (total < 8) return false;
        const noTop = Math.max(0, Number(counts.nNoTop || 0));
        const timedOut = Math.max(0, Number(counts.nTimedOut || 0));
        const stalledMarketData = noTop + timedOut >= Math.max(4, Math.floor(total * 0.6));
        return stalledMarketData || isLikelyNoLiquidityWindow(counts);
      };
      const valueSweepBudgetMs =
        hedgePolicy === "options_only_native" ? Math.max(1500, Math.min(2500, Math.floor(this.quoteBudgetMs * 0.15))) : 0;
      let valueSweepStartMs: number | null = null;
      let actionableMatchesSeen = 0;
      for (let ringIdx = 0; ringIdx < maxRingPasses; ringIdx += 1) {
        const topCallsUsed = Math.max(0, counters.topCalls - topCallsAtLegStart);
        const remainingTopCalls = maxTopCallsPerOptionLeg - topCallsUsed;
        if (remainingTopCalls <= 0) {
          break;
        }
        if (
          hedgePolicy === "options_only_native" &&
          bestOptionMatch &&
          valueSweepStartMs !== null &&
          Date.now() - valueSweepStartMs >= valueSweepBudgetMs
        ) {
          break;
        }
        const ringGroup = ringTasks[ringIdx];
        const ringTenor = ringGroup[0]?.tenor || selectedTenorDaysIntended;
        await runQualifyTasks(ringGroup);
        if (!dedupedContracts.length) {
          this.updateTenorLiquidityHint(ringTenor, {
            contractsFound: 0,
            timedOut: optionQualifyTimedOut,
            hadTopLiquidity: false
          });
          continue;
        }
        if (strictTenor && !dedupedContracts.some(contractPassesOptionTenorWindow)) {
          optionLegFailureReason = "tenor_drift_exceeded";
          this.updateTenorLiquidityHint(ringTenor, {
            contractsFound: dedupedContracts.length,
            timedOut: optionQualifyTimedOut,
            hadTopLiquidity: false
          });
          continue;
        }
        const optionProbeBudgetMs = Math.max(1200, optionLegDeadlineMs - Date.now() - 120);
        if (optionProbeBudgetMs < 1200) {
          break;
        }
        const scoreStartedAt = Date.now();
        const optionProbeTimeoutMs =
          hedgePolicy === "options_only_native"
            ? Math.max(2200, Math.min(10000, Math.floor(requestWindowHintMs * 1.2)))
            : Math.max(650, Math.min(1800, requestWindowHintMs));
        const optionProbeDepthAttempts = hedgePolicy === "options_only_native" ? 2 : 1;
        const optionProbeLegBudgetMs =
          hedgePolicy === "options_only_native"
            ? Math.max(5000, Math.min(30000, optionProbeBudgetMs))
            : Math.max(1200, Math.min(6000, optionProbeBudgetMs));
        const optionMatch = await probeOptionCandidates(dedupedContracts, minProtectionThreshold, {
          probeTimeoutMs: optionProbeTimeoutMs,
          depthAttempts: optionProbeDepthAttempts,
          legBudgetMs: optionProbeLegBudgetMs,
          maxTopCalls: remainingTopCalls
        });
        timingsMs.score += Date.now() - scoreStartedAt;
        if (!("contract" in optionMatch)) {
          accumulateNoMatchFailureTotals(optionMatch.failureCounts);
          this.updateTenorLiquidityHint(ringTenor, {
            contractsFound: Number(optionMatch.failureCounts.nTotalCandidates || 0),
            timedOut: Number(optionMatch.failureCounts.nTimedOut || 0) > 0,
            hadTopLiquidity:
              Number(optionMatch.failureCounts.nNoTop || 0) < Number(optionMatch.failureCounts.nTotalCandidates || 0)
          });
          if (
            hedgePolicy === "options_only_native" &&
            sawTenorEligibleContract &&
            shouldShortCircuitNoLiquidity(noMatchFailureTotals)
          ) {
            break;
          }
          continue;
        }
        const previousBestScore = bestOptionMatch?.selectedScore ?? null;
        if (!bestOptionMatch || optionMatch.selectedScore < bestOptionMatch.selectedScore) {
          bestOptionMatch = optionMatch;
          bestOptionRankedAlternatives = optionMatch.rankedAlternatives;
        }
        if (hedgePolicy === "options_only_native") {
          if (valueSweepStartMs === null) {
            valueSweepStartMs = Date.now();
          }
          actionableMatchesSeen += 1;
          // Fast best-of-two actionable: continue until at least two actionable matches
          // are observed or the bounded sweep budget is exhausted.
          const sweepElapsedMs = valueSweepStartMs === null ? 0 : Date.now() - valueSweepStartMs;
          const valueImproved =
            previousBestScore !== null &&
            Number.isFinite(previousBestScore) &&
            Number.isFinite(optionMatch.selectedScore) &&
            previousBestScore - optionMatch.selectedScore > 5;
          if (actionableMatchesSeen < minViableCandidatesBeforeStop && sweepElapsedMs < valueSweepBudgetMs) {
            continue;
          }
          if (sweepElapsedMs >= valueSweepBudgetMs || (actionableMatchesSeen >= minViableCandidatesBeforeStop && !valueImproved)) {
            break;
          }
          continue;
        }
        this.updateTenorLiquidityHint(ringTenor, {
          contractsFound: Number(optionMatch.failureCounts.nTotalCandidates || 0),
          timedOut: Number(optionMatch.failureCounts.nTimedOut || 0) > 0,
          hadTopLiquidity: Number(optionMatch.failureCounts.nPassed || 0) > 0
        });
        const viableCount = Number(optionMatch.failureCounts.nPassed || 0);
        if (viableCount >= minViableCandidatesBeforeStop) {
          break;
        }
        if (
          hedgePolicy === "options_only_native" &&
          sawTenorEligibleContract &&
          shouldShortCircuitNoLiquidity(noMatchFailureTotals)
        ) {
          break;
        }
      }
      if (!bestOptionMatch) {
        accumulateOptionFailureCounts(noMatchFailureTotals);
        if (optionQualifyTimedOut && optionFailureTotals.nTotalCandidates <= 0) {
          optionLegFailureReason = "option_qualify_timeout";
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
        selectionAlgorithm:
          this.selectorMode === "hybrid_treasury"
            ? "liquidity_tenor_hybrid_treasury_v1"
            : "liquidity_protection_profitability_v2",
        selectedScore: optionMatch.selectedScore,
        selectedRank: optionMatch.selectedRank,
        selectedIsBelowTarget: optionMatch.selectedIsBelowTarget,
        candidateCountEvaluated: optionMatch.candidateCountEvaluated,
        matchedTenorHoursEstimate:
          optionMeta.selectedTenorDays !== null ? Number((optionMeta.selectedTenorDays * 24).toFixed(4)) : null,
        matchedTenorDisplay: formatMatchedTenorDisplay(optionMeta.selectedTenorDays),
        selectionTrace: optionMatch.selectionTrace,
        rankedAlternatives: optionMatch.rankedAlternatives,
        strike: toFinitePositive(optionMatch.contract.strike) || roundedStrike,
        hedgeInstrumentFamily: productFamily,
        candidateFailureCounts: optionMatch.failureCounts
      };
    };
    if (hedgePolicy === "options_only_native") {
      try {
        const primaryOptions = await runOptionLeg(this.primaryProductFamily, "best_tenor_liquidity_option");
        if (primaryOptions) {
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            selection: {
              hedgeMode: primaryOptions.hedgeMode,
              hedgeInstrumentFamily: primaryOptions.hedgeInstrumentFamily,
              selectionReason: primaryOptions.selectionReason,
              selectionAlgorithm: primaryOptions.selectionAlgorithm,
              selectedScore: primaryOptions.selectedScore,
              selectedTenorDays: primaryOptions.selectedTenorDays,
              selectedExpiry: primaryOptions.selectedExpiry,
              selectedStrike: primaryOptions.strike,
              candidateCountEvaluated: primaryOptions.candidateCountEvaluated
            }
          };
          return primaryOptions;
        }
      } catch (error) {
        const rawMessage = String((error as Error)?.message || "ibkr_quote_unavailable:option_selection_failed");
        const message = normalizeNoLiquidityWindowError(rawMessage, optionFailureTotals, sawTenorEligibleContract);
        if (message.includes("venue_quote_timeout")) {
          counters.optionsLegTimedOut += 1;
        }
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: message
        };
        throw new Error(message);
      }
      if (optionLegFailureReason === "option_qualify_timeout") {
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: "ibkr_quote_unavailable:no_liquidity_window"
        };
        throw new Error("ibkr_quote_unavailable:no_liquidity_window");
      }
      if (!sawTenorEligibleContract) {
        timingsMs.total = Date.now() - selectorStartedAt;
        const mappedError =
          optionLegFailureReason === "option_qualify_timeout"
            ? "ibkr_quote_unavailable:no_liquidity_window"
            : optionLegFailureReason
              ? `ibkr_quote_unavailable:${optionLegFailureReason}`
              : "ibkr_quote_unavailable:tenor_drift_exceeded";
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: mappedError
        };
        if (optionLegFailureReason === "option_qualify_timeout") {
          throw new Error("ibkr_quote_unavailable:no_liquidity_window");
        }
        if (optionLegFailureReason) {
          throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
        }
        throw new Error("ibkr_quote_unavailable:tenor_drift_exceeded");
      }
      if (this.optionLiquiditySelectionEnabled && optionFailureTotals.nTotalCandidates > 0) {
        if (isLikelyNoLiquidityWindow(optionFailureTotals)) {
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            error: "ibkr_quote_unavailable:no_liquidity_window"
          };
          throw new Error("ibkr_quote_unavailable:no_liquidity_window");
        }
        const noViableReason = deriveNoViableOptionReason(optionFailureTotals);
        const rankedAlternatives = (bestOptionRankedAlternatives.length > 0
          ? bestOptionRankedAlternatives
          : null) as
          | Array<{
              expiry: string | null;
              matchedTenorDays: number | null;
              driftDays: number | null;
              ask: number | null;
              score: number | null;
            }>
          | null;
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: `ibkr_quote_unavailable:${noViableReason}:no_viable_option`
        };
        throw new Error(
          [
            `ibkr_quote_unavailable:${noViableReason}:no_viable_option:${JSON.stringify(optionFailureTotals)}`,
            rankedAlternatives ? `ranked_alternatives:${JSON.stringify(rankedAlternatives)}` : null
          ]
            .filter(Boolean)
            .join(":")
        );
      }
      timingsMs.total = Date.now() - selectorStartedAt;
      this.selectorDiagnostics = {
        asOf: nowIso(),
        requestId: randomUUID(),
        venueMode: this.mode,
        timingsMs,
        counters,
        optionCandidateFailureCounts: { ...optionFailureTotals },
        error: optionLegFailureReason
          ? `ibkr_quote_unavailable:${optionLegFailureReason}`
          : "ibkr_quote_unavailable:no_top_of_book"
      };
      if (optionLegFailureReason && optionFailureTotals.nTotalCandidates <= 0 && optionFailureTotals.nPassed <= 0) {
        throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
      }
      throw new Error("ibkr_quote_unavailable:no_top_of_book");
    }
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
          nFailedMinTradableNotional: number;
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
            counters.optionsLegTimedOut += 1;
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
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          selection: {
            hedgeMode: primaryOptions.hedgeMode,
            hedgeInstrumentFamily: primaryOptions.hedgeInstrumentFamily,
            selectionReason: primaryOptions.selectionReason,
            selectionAlgorithm: primaryOptions.selectionAlgorithm,
            selectedScore: primaryOptions.selectedScore,
            selectedTenorDays: primaryOptions.selectedTenorDays,
            selectedExpiry: primaryOptions.selectedExpiry,
            selectedStrike: primaryOptions.strike,
            candidateCountEvaluated: primaryOptions.candidateCountEvaluated
          }
        };
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
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            selection: {
              hedgeMode: secondaryOptions.hedgeMode,
              hedgeInstrumentFamily: secondaryOptions.hedgeInstrumentFamily,
              selectionReason: secondaryOptions.selectionReason,
              selectionAlgorithm: secondaryOptions.selectionAlgorithm,
              selectedScore: secondaryOptions.selectedScore,
              selectedTenorDays: secondaryOptions.selectedTenorDays,
              selectedExpiry: secondaryOptions.selectedExpiry,
              selectedStrike: secondaryOptions.strike,
              candidateCountEvaluated: secondaryOptions.candidateCountEvaluated
            }
          };
          return secondaryOptions;
        }
      }

      const primaryFallback = await runFallbackLeg(
        this.primaryProductFamily,
        "options_unavailable_futures_fallback"
      );
      if (primaryFallback) {
        if (this.requireOptionsNative) {
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            selection: {
              hedgeMode: primaryFallback.hedgeMode,
              hedgeInstrumentFamily: primaryFallback.hedgeInstrumentFamily,
              selectionReason: primaryFallback.selectionReason,
              selectionAlgorithm: primaryFallback.selectionAlgorithm,
              selectedScore: primaryFallback.selectedScore,
              selectedTenorDays: primaryFallback.selectedTenorDays,
              selectedExpiry: primaryFallback.selectedExpiry,
              selectedStrike: primaryFallback.strike,
              candidateCountEvaluated: primaryFallback.candidateCountEvaluated
            },
            error: "ibkr_quote_unavailable:options_required"
          };
          throw new Error("ibkr_quote_unavailable:options_required");
        }
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          selection: {
            hedgeMode: primaryFallback.hedgeMode,
            hedgeInstrumentFamily: primaryFallback.hedgeInstrumentFamily,
            selectionReason: primaryFallback.selectionReason,
            selectionAlgorithm: primaryFallback.selectionAlgorithm,
            selectedScore: primaryFallback.selectedScore,
            selectedTenorDays: primaryFallback.selectedTenorDays,
            selectedExpiry: primaryFallback.selectedExpiry,
            selectedStrike: primaryFallback.strike,
            candidateCountEvaluated: primaryFallback.candidateCountEvaluated
          }
        };
        if (
          optionLegFailureReason &&
          optionFailureTotals.nTotalCandidates <= 0 &&
          optionFailureTotals.nPassed <= 0
        ) {
          throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
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
            timingsMs.total = Date.now() - selectorStartedAt;
            this.selectorDiagnostics = {
              asOf: nowIso(),
              requestId: randomUUID(),
              venueMode: this.mode,
              timingsMs,
              counters,
              optionCandidateFailureCounts: { ...optionFailureTotals },
              selection: {
                hedgeMode: bffFallback.hedgeMode,
                hedgeInstrumentFamily: bffFallback.hedgeInstrumentFamily,
                selectionReason: bffFallback.selectionReason,
                selectionAlgorithm: bffFallback.selectionAlgorithm,
                selectedScore: bffFallback.selectedScore,
                selectedTenorDays: bffFallback.selectedTenorDays,
                selectedExpiry: bffFallback.selectedExpiry,
                selectedStrike: bffFallback.strike,
                candidateCountEvaluated: bffFallback.candidateCountEvaluated
              },
              error: "ibkr_quote_unavailable:options_required"
            };
            throw new Error("ibkr_quote_unavailable:options_required");
          }
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            selection: {
              hedgeMode: bffFallback.hedgeMode,
              hedgeInstrumentFamily: bffFallback.hedgeInstrumentFamily,
              selectionReason: bffFallback.selectionReason,
              selectionAlgorithm: bffFallback.selectionAlgorithm,
              selectedScore: bffFallback.selectedScore,
              selectedTenorDays: bffFallback.selectedTenorDays,
              selectedExpiry: bffFallback.selectedExpiry,
              selectedStrike: bffFallback.strike,
              candidateCountEvaluated: bffFallback.candidateCountEvaluated
            }
          };
          if (
            optionLegFailureReason &&
            optionFailureTotals.nTotalCandidates <= 0 &&
            optionFailureTotals.nPassed <= 0
          ) {
            throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
          }
          return bffFallback;
        }
      }
      if (!sawTenorEligibleContract) {
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: optionLegFailureReason ? `ibkr_quote_unavailable:${optionLegFailureReason}` : "ibkr_quote_unavailable:tenor_drift_exceeded"
        };
        if (optionLegFailureReason) {
          throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
        }
        throw new Error("ibkr_quote_unavailable:tenor_drift_exceeded");
      }
      if (sawFallbackContracts) {
        if (this.optionLiquiditySelectionEnabled && optionFailureTotals.nTotalCandidates > 0) {
          const noViableReason = deriveNoViableOptionReason(optionFailureTotals);
          const rankedAlternatives = (bestOptionRankedAlternatives.length > 0
            ? bestOptionRankedAlternatives
            : null) as
            | Array<{
                expiry: string | null;
                matchedTenorDays: number | null;
                driftDays: number | null;
                ask: number | null;
                score: number | null;
              }>
            | null;
          timingsMs.total = Date.now() - selectorStartedAt;
          this.selectorDiagnostics = {
            asOf: nowIso(),
            requestId: randomUUID(),
            venueMode: this.mode,
            timingsMs,
            counters,
            optionCandidateFailureCounts: { ...optionFailureTotals },
            error: `ibkr_quote_unavailable:${noViableReason}:no_viable_option`
          };
          throw new Error([
            `ibkr_quote_unavailable:${noViableReason}:no_viable_option:${JSON.stringify(optionFailureTotals)}`,
            rankedAlternatives
              ? `ranked_alternatives:${JSON.stringify(rankedAlternatives)}`
              : null
          ].filter(Boolean).join(":"));
        }
        timingsMs.total = Date.now() - selectorStartedAt;
        this.selectorDiagnostics = {
          asOf: nowIso(),
          requestId: randomUUID(),
          venueMode: this.mode,
          timingsMs,
          counters,
          optionCandidateFailureCounts: { ...optionFailureTotals },
          error: optionLegFailureReason ? `ibkr_quote_unavailable:${optionLegFailureReason}` : "ibkr_quote_unavailable:no_top_of_book"
        };
        if (optionLegFailureReason && optionFailureTotals.nTotalCandidates <= 0 && optionFailureTotals.nPassed <= 0) {
          throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
        }
        throw new Error("ibkr_quote_unavailable:no_top_of_book");
      }
      timingsMs.total = Date.now() - selectorStartedAt;
      this.selectorDiagnostics = {
        asOf: nowIso(),
        requestId: randomUUID(),
        venueMode: this.mode,
        timingsMs,
        counters,
        optionCandidateFailureCounts: { ...optionFailureTotals },
        error: optionLegFailureReason ? `ibkr_quote_unavailable:${optionLegFailureReason}` : "ibkr_quote_unavailable:tenor_drift_exceeded"
      };
      if (optionLegFailureReason && optionFailureTotals.nTotalCandidates <= 0 && optionFailureTotals.nPassed <= 0) {
        throw new Error(`ibkr_quote_unavailable:${optionLegFailureReason}`);
      }
      throw new Error("ibkr_quote_unavailable:tenor_drift_exceeded");
    }

    timingsMs.total = Date.now() - selectorStartedAt;
    this.selectorDiagnostics = {
      asOf: nowIso(),
      requestId: randomUUID(),
      venueMode: this.mode,
      timingsMs,
      counters,
      optionCandidateFailureCounts: {
        nTotalCandidates: 0,
        nNoTop: 0,
        nNoAsk: 0,
        nFailedProtection: 0,
        nFailedEconomics: 0,
        nFailedMinTradableNotional: 0,
        nFailedWideSpread: 0,
        nFailedThinDepth: 0,
        nFailedStaleTop: 0,
        nTimedOut: 0,
        nPassed: 0
      },
      error: "ibkr_quote_unavailable:no_contract"
    };
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
    const contractMultiplier = resolveContractMultiplier(resolved.contract.multiplier, 0.1);
    const estimatedContracts = Math.max(1, Math.ceil(referenceQty / contractMultiplier));
    const premium = Number((unitPrice * estimatedContracts).toFixed(4));
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
        rankedAlternatives: resolved.rankedAlternatives,
        askPrice: ask,
        bidPrice: bid,
        askSize: resolved.top.askSize,
        bidSize: resolved.top.bidSize,
        estimatedContracts,
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

class DeribitLiveAdapter extends DeribitTestAdapter {
  constructor(
    connector: DeribitConnector,
    quoteTtlMs: number,
    quotePolicy: DeribitQuotePolicy,
    strikeSelectionMode: DeribitStrikeSelectionMode,
    maxTenorDriftDays: number
  ) {
    super(connector, quoteTtlMs, quotePolicy, strikeSelectionMode, maxTenorDriftDays);
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    const result = await super.execute(quote);
    return { ...result, venue: "deribit_live" };
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const result = await super.quote(req);
    return { ...result, venue: "deribit_live" };
  }
}

class BullishTestnetAdapter implements PilotVenueAdapter {
  private readonly client: BullishTradingClient;
  private readonly hedgeConfig: HedgeOptimizationConfig;
  private readonly batchManager: HedgeBatchManager;

  constructor(
    private readonly config: BullishRuntimeConfig,
    private readonly quoteTtlMs: number
  ) {
    this.client = new BullishTradingClient(config);
    this.hedgeConfig = parseHedgeOptimizationConfig();
    this.batchManager = new HedgeBatchManager(this.hedgeConfig);
  }

  private async selectBullishOptionSymbol(req: QuoteRequest): Promise<{
    symbol: string;
    strike: number;
    hedgeCostPerUnit: number;
    hedgeCostTotal: number;
    availableQty: number;
    selectionReason: string;
  } | null> {
    const allMarkets = await this.client.getMarkets();
    const isShort = req.protectionType === "short";
    const requestedOptionType = isShort ? "CALL" : "PUT";
    const now = Date.now();
    const requestedTenorDays = Math.max(1, Math.floor(Number(req.requestedTenorDays || 1)));
    const targetExpiryMs = now + requestedTenorDays * 24 * 60 * 60 * 1000;
    const spotPrice = toFinitePositiveNumber(req.protectedNotional) && toFinitePositiveNumber(req.quantity)
      ? Number(req.protectedNotional) / Number(req.quantity)
      : null;
    const triggerPrice = toFinitePositiveNumber(req.triggerPrice) || null;
    const drawdownFloorPct = toFinitePositiveNumber(req.drawdownFloorPct) || 0.2;
    const btcQty = Number(req.quantity || 0);

    if (!spotPrice || btcQty <= 0) return null;

    const maxHedgeCostPer1k = Number(process.env.PILOT_BULLISH_MAX_HEDGE_COST_PER_1K || "0") || null;

    const strikeRange = resolveDynamicStrikeRange({
      config: this.hedgeConfig,
      recentVolatilityPct: null,
      isShort
    });

    const candidates = allMarkets
      .map((market) => {
        const symbol = String((market as Record<string, unknown>).symbol || "");
        const marketType = String((market as Record<string, unknown>).marketType || "").toUpperCase();
        if (marketType !== "OPTION") return null;
        const parsed = parseBullishOptionSymbol(symbol);
        if (!parsed || parsed.optionType !== requestedOptionType) return null;
        const expiryIso = String((market as Record<string, unknown>).expiryDatetime || "");
        const expiryMs = Date.parse(expiryIso);
        if (!Number.isFinite(expiryMs) || expiryMs <= now) return null;
        const tradable = (market as Record<string, unknown>).createOrderEnabled !== false;
        if (!tradable) return null;
        const tenorDriftDays = Math.abs(expiryMs - targetExpiryMs) / 86400000;
        const maxDrift = requestedTenorDays <= 1 ? 2.5 : Math.max(3, requestedTenorDays + 2);
        if (tenorDriftDays > maxDrift) return null;
        const tenorDays = (expiryMs - now) / 86400000;
        if (requestedTenorDays <= 1 && tenorDays < 0.3) return null;

        const moneyness = parsed.strike / spotPrice;
        if (isShort) {
          if (moneyness < strikeRange.targetMoneynessMin * 0.95 || moneyness > strikeRange.targetMoneynessMax * 1.2) return null;
        } else {
          if (moneyness > strikeRange.targetMoneynessMax * 1.1) return null;
          if (moneyness < strikeRange.targetMoneynessMin * 0.85) return null;
        }

        return { symbol, strike: parsed.strike, expiryMs, tenorDriftDays };
      })
      .filter(Boolean) as Array<{ symbol: string; strike: number; expiryMs: number; tenorDriftDays: number }>;

    candidates.sort((a, b) => a.tenorDriftDays - b.tenorDriftDays || a.strike - b.strike);

    type ScoredCandidate = {
      symbol: string;
      strike: number;
      askPrice: number;
      askQty: number;
      hedgeCostTotal: number;
      hedgeCostPer1k: number;
      score: number;
      selectionReason: string;
    };

    const scored: ScoredCandidate[] = [];
    const bestTenorDrift = candidates[0]?.tenorDriftDays ?? 0;
    const sameExpiryGroup = candidates.filter((c) => Math.abs(c.tenorDriftDays - bestTenorDrift) < 0.5);

    for (const candidate of sameExpiryGroup.slice(0, 5)) {
      try {
        const book = await this.client.getHybridOrderBook(candidate.symbol);
        const bestAsk = book.asks[0];
        const askPx = Number(bestAsk?.price ?? NaN);
        const askQty = Number(bestAsk?.quantity ?? NaN);
        if (!Number.isFinite(askPx) || askPx <= 0) continue;
        if (!Number.isFinite(askQty) || askQty <= 0) continue;

        const hedgeCostTotal = askPx * btcQty;
        const hedgeCostPer1k = (askPx / spotPrice) * 1000;
        if (maxHedgeCostPer1k && hedgeCostPer1k > maxHedgeCostPer1k) continue;

        const premium = Number(req.protectedNotional || 0) / 1000 * 11;
        const hasLiquidity = askQty >= btcQty;
        const spreadPositive = premium > hedgeCostTotal;
        const moneyness = candidate.strike / spotPrice;

        let score = 0;
        if (spreadPositive) score += 60;
        else score -= 20;
        if (hasLiquidity) score += 20;

        if (moneyness >= strikeRange.targetMoneynessMin && moneyness <= strikeRange.targetMoneynessMax) {
          score += 15;
        } else {
          const distFromRange = Math.min(
            Math.abs(moneyness - strikeRange.targetMoneynessMin),
            Math.abs(moneyness - strikeRange.targetMoneynessMax)
          );
          score += Math.max(0, 8 - distFromRange * 100);
        }

        if (triggerPrice) {
          const coverageOnBreach = Math.max(0, candidate.strike - triggerPrice) * btcQty;
          const maxPayout = Number(req.protectedNotional || 0) * drawdownFloorPct;
          const coverageRatio = maxPayout > 0 ? coverageOnBreach / maxPayout : 0;
          score += Math.min(20, coverageRatio * 20);
        }

        const reason = [
          spreadPositive ? "spread_positive" : "spread_negative",
          hasLiquidity ? "liquidity_ok" : "partial_fill",
          `moneyness_${(moneyness * 100).toFixed(0)}pct`,
          `cost_${hedgeCostPer1k.toFixed(1)}_per_1k`
        ].join("|");

        scored.push({
          symbol: candidate.symbol,
          strike: candidate.strike,
          askPrice: askPx,
          askQty: askQty,
          hedgeCostTotal,
          hedgeCostPer1k,
          score,
          selectionReason: reason
        });
      } catch {
        // Skip candidates with transient market data failures
      }
    }

    if (!scored.length) return null;

    scored.sort((a, b) => b.score - a.score || a.hedgeCostPer1k - b.hedgeCostPer1k);
    const best = scored[0];

    return {
      symbol: best.symbol,
      strike: best.strike,
      hedgeCostPerUnit: best.askPrice,
      hedgeCostTotal: best.hedgeCostTotal,
      availableQty: best.askQty,
      selectionReason: best.selectionReason
    };
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const selection = await this.selectBullishOptionSymbol(req);
    if (!selection) {
      throw new Error("bullish_quote_unavailable:no_suitable_option_found");
    }
    const symbol = selection.symbol;

    const book = await this.client.getHybridOrderBook(symbol);
    const bestAsk = book.asks[0];
    const bestBid = book.bids[0] || null;
    const askPx = selection ? selection.hedgeCostPerUnit : Number(bestAsk?.price ?? NaN);
    const askQty = Number(bestAsk?.quantity ?? NaN);
    if (!Number.isFinite(askPx) || askPx <= 0 || !Number.isFinite(askQty) || askQty <= 0) {
      throw new Error("bullish_quote_unavailable:no_top_of_book");
    }
    const premium = Number((askPx * Math.max(0, Number(req.quantity || 0))).toFixed(10));

    const batchDecision = this.hedgeConfig.batchHedgingEnabled
      ? this.batchManager.addToQueue({
          requestId: randomUUID(),
          protectionType: req.protectionType || "long",
          notionalUsd: req.protectedNotional,
          btcQty: Number(req.quantity || 0),
          drawdownFloorPct: req.drawdownFloorPct || 0.2,
          triggerPrice: req.triggerPrice || 0,
          premiumPer1k: 11,
          createdAt: Date.now()
        })
      : null;

    return {
      venue: "bullish_testnet",
      quoteId: randomUUID(),
      rfqId: null,
      instrumentId: selection.symbol,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt: new Date(Date.now() + this.quoteTtlMs).toISOString(),
      quoteTs: nowIso(),
      details: {
        venueMode: "bullish_testnet",
        bullishSymbol: symbol,
        bestAskPrice: bestAsk?.price ?? null,
        bestAskQuantity: bestAsk?.quantity ?? null,
        bestBidPrice: bestBid?.price ?? null,
        bestBidQuantity: bestBid?.quantity ?? null,
        sequenceNumber: book.sequenceNumber,
        orderbookTimestamp: book.timestamp,
        source: "bullish_hybrid_orderbook",
        selectedInstrumentId: selection.symbol,
        requestedInstrumentId: req.instrumentId,
        hedgeMode: "options_native",
        optimizations: {
          batchDecision: batchDecision ? {
            mode: batchDecision.mode,
            reason: batchDecision.reason,
            pendingCount: batchDecision.pendingCount,
            totalBtcQty: batchDecision.totalBtcQty
          } : null,
          dynamicStrike: this.hedgeConfig.dynamicStrikeEnabled ? "enabled" : "disabled",
          rollOptimization: this.hedgeConfig.rollOptimizationEnabled ? "enabled" : "disabled",
          autoRenewTenor: this.hedgeConfig.autoRenewTenorEnabled ? "enabled" : "disabled"
        },
        optionSelection: selection ? {
          strike: selection.strike,
          hedgeCostPerUnit: selection.hedgeCostPerUnit,
          hedgeCostTotal: selection.hedgeCostTotal,
          availableQty: selection.availableQty,
          selectionReason: selection.selectionReason
        } : null
      }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    if (!this.config.enableExecution) {
      return {
        venue: "bullish_testnet",
        status: "failure",
        quoteId: quote.quoteId,
        rfqId: quote.rfqId ?? null,
        instrumentId: quote.instrumentId,
        side: "buy",
        quantity: quote.quantity,
        executionPrice: 0,
        premium: quote.premium,
        executedAt: nowIso(),
        externalOrderId: "",
        externalExecutionId: "",
        details: {
          rejectionReason: "bullish_execution_disabled"
        }
      };
    }
    const quoteDetails = (quote.details || {}) as Record<string, unknown>;
    const optionSelection = quoteDetails.optionSelection as Record<string, unknown> | null | undefined;
    const selectedInstrumentId = String(quoteDetails.selectedInstrumentId || quote.instrumentId || "").trim();
    const symbol =
      selectedInstrumentId ||
      resolveBullishMarketSymbol(this.config, {
        marketId: quote.details?.marketId as string | undefined,
        instrumentId: quote.instrumentId
      });
    const quantity = Number(quote.quantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("bullish_execute_invalid_quantity");
    }
    const hedgeCostPerUnit = Number(optionSelection?.hedgeCostPerUnit ?? 0);

    const stalenessMaxPct = Math.max(0.5, Number(process.env.PILOT_BULLISH_PRICE_STALENESS_MAX_PCT || "5"));
    let freshAskPrice: number | null = null;
    try {
      const freshBook = await this.client.getHybridOrderBook(symbol);
      freshAskPrice = Number(freshBook.asks[0]?.price ?? NaN);
      if (!Number.isFinite(freshAskPrice) || freshAskPrice <= 0) freshAskPrice = null;
    } catch {
      // If fresh book check fails, proceed with stored price
    }

    const unitPrice = freshAskPrice || (hedgeCostPerUnit > 0 ? hedgeCostPerUnit : (quantity > 0 ? quote.premium / quantity : quote.premium));

    if (freshAskPrice && hedgeCostPerUnit > 0) {
      const driftPct = Math.abs(freshAskPrice - hedgeCostPerUnit) / hedgeCostPerUnit * 100;
      if (driftPct > stalenessMaxPct) {
        return {
          venue: "bullish_testnet",
          status: "failure",
          quoteId: quote.quoteId,
          rfqId: quote.rfqId ?? null,
          instrumentId: quote.instrumentId,
          side: "buy",
          quantity: quote.quantity,
          executionPrice: 0,
          premium: quote.premium,
          executedAt: nowIso(),
          externalOrderId: "",
          externalExecutionId: "",
          details: {
            rejectionReason: "price_staleness_exceeded",
            quotedPrice: hedgeCostPerUnit,
            currentAsk: freshAskPrice,
            driftPct: driftPct.toFixed(2),
            maxAllowedPct: stalenessMaxPct
          }
        };
      }
    }

    const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999)));
    const isIOC = this.config.orderTif === "IOC";
    const cancelTimeoutMs = Math.max(3000, Number(process.env.PILOT_BULLISH_UNFILLED_CANCEL_TIMEOUT_MS || "10000"));

    const isOption = /^[A-Z]+-[A-Z]+-\d{8}-\d+(?:\.\d+)?-(C|P)$/i.test(symbol);
    const pricePrecision = isOption ? 4 : 8;
    const qtyPrecision = isOption ? 2 : 8;
    const formattedPrice = unitPrice.toFixed(pricePrecision);
    const formattedQty = Math.floor(quantity * Math.pow(10, qtyPrecision)) / Math.pow(10, qtyPrecision);
    const formattedQtyStr = formattedQty.toFixed(qtyPrecision);

    console.log(`[BullishAdapter] Placing order: symbol=${symbol} side=BUY price=${formattedPrice} qty=${formattedQtyStr} tif=${this.config.orderTif} clientOrderId=${clientOrderId}`);
    const startMs = Date.now();

    let response: unknown;
    try {
      response = await this.client.createSpotLimitOrder({
        symbol,
        side: "BUY",
        price: formattedPrice,
        quantity: formattedQtyStr,
        clientOrderId
      });
      console.log(`[BullishAdapter] Order response (${Date.now() - startMs}ms):`, JSON.stringify(response).slice(0, 500));
    } catch (orderError: any) {
      console.error(`[BullishAdapter] Order FAILED (${Date.now() - startMs}ms):`, orderError?.message);
      throw new Error(`bullish_order_failed:${orderError?.message || "unknown"}`);
    }

    const responseRecord = response as Record<string, unknown>;
    const orderId =
      typeof responseRecord.orderId === "string"
        ? responseRecord.orderId
        : typeof (responseRecord.data as Record<string, unknown> | undefined)?.orderId === "string"
          ? String((responseRecord.data as Record<string, unknown>).orderId)
          : "";

    let restStatus = String(responseRecord.status || (responseRecord.data as Record<string, unknown> | undefined)?.status || "").toUpperCase();
    let restFillPrice = Number(responseRecord.averageFillPrice ?? (responseRecord.data as Record<string, unknown> | undefined)?.averageFillPrice ?? responseRecord.price ?? 0);
    let restFillQty = Number(responseRecord.quantityFilled ?? (responseRecord.data as Record<string, unknown> | undefined)?.quantityFilled ?? responseRecord.quantity ?? 0);

    if (orderId && isIOC && restFillPrice <= 0) {
      const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(attempt === 0 ? 300 : 500);
        try {
          const orderStatus = await this.client.getOrderStatus(orderId);
          console.log(`[BullishAdapter] Order status poll ${attempt + 1}: status=${orderStatus.status} fillPrice=${orderStatus.fillPrice} fillQty=${orderStatus.fillQuantity}`);
          restStatus = orderStatus.status;
          if (orderStatus.fillPrice > 0) restFillPrice = orderStatus.fillPrice;
          if (orderStatus.fillQuantity > 0) restFillQty = orderStatus.fillQuantity;
          if (restStatus === "CLOSED" || restStatus === "FILLED" || restStatus === "CANCELLED" || restStatus === "EXPIRED") break;
        } catch (pollErr: any) {
          console.warn(`[BullishAdapter] Order status poll ${attempt + 1} failed:`, pollErr?.message);
        }
      }
    }

    const isFilled = restStatus === "FILLED" || restStatus === "CLOSED"
      || (orderId && restFillPrice > 0 && restFillQty > 0);
    const isCancelled = restStatus === "CANCELLED" || restStatus === "EXPIRED";

    if (!orderId) {
      console.error(`[BullishAdapter] No orderId in response -- treating as failure`);
      return {
        venue: "bullish_testnet", status: "failure", quoteId: quote.quoteId,
        rfqId: quote.rfqId ?? null, instrumentId: quote.instrumentId, side: "buy",
        quantity: quote.quantity, executionPrice: 0, premium: quote.premium,
        executedAt: nowIso(), externalOrderId: "", externalExecutionId: "",
        details: { ...responseRecord, rejectionReason: "no_order_id_in_response" }
      };
    }

    if (isIOC && isCancelled) {
      console.warn(`[BullishAdapter] IOC order ${orderId} cancelled/expired (no fill)`);
      return {
        venue: "bullish_testnet", status: "failure", quoteId: quote.quoteId,
        rfqId: quote.rfqId ?? null, instrumentId: quote.instrumentId, side: "buy",
        quantity: quote.quantity, executionPrice: 0, premium: quote.premium,
        executedAt: nowIso(), externalOrderId: orderId, externalExecutionId: `bullish-${orderId}`,
        details: { ...responseRecord, fillStatus: "ioc_no_fill", rejectionReason: "ioc_cancelled" }
      };
    }

    if (!isIOC && !isFilled && orderId) {
      setTimeout(async () => {
        try {
          await this.client.cancelOrder({ symbol, orderId });
          console.log(`[BullishAdapter] Auto-cancelled unfilled GTC order ${orderId}`);
        } catch {}
      }, cancelTimeoutMs).unref?.();
    }

    const actualFillPrice = restFillPrice > 0 ? restFillPrice : unitPrice;
    const actualFillQty = restFillQty > 0 ? restFillQty : formattedQty;

    console.log(`[BullishAdapter] Order ${orderId} result: filled=${isFilled} price=${actualFillPrice} qty=${actualFillQty} latency=${Date.now() - startMs}ms`);

    const executionSuccess = orderId && (isFilled || (!isIOC && !isCancelled));

    return {
      venue: "bullish_testnet",
      status: executionSuccess ? "success" : "failure",
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: actualFillQty,
      executionPrice: actualFillPrice,
      premium: actualFillPrice * actualFillQty,
      executedAt: nowIso(),
      externalOrderId: orderId,
      externalExecutionId: orderId ? `bullish-${orderId}` : "",
      details: {
        ...responseRecord,
        fillConfirmation: {
          method: isIOC ? "rest_ioc_sync" : "rest_with_cancel_fallback",
          filled: isFilled,
          fillPrice: actualFillPrice,
          fillQuantity: actualFillQty,
          restStatus,
          latencyMs: Date.now() - startMs,
        },
        priceGuard: {
          stalenessMaxPct,
          orderTif: this.config.orderTif,
        }
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
    const symbol = resolveBullishMarketSymbol(this.config, {
      instrumentId: params.instrumentId
    });
    const book = await this.client.getHybridOrderBook(symbol);
    const bestAsk = Number(book.asks[0]?.price ?? NaN);
    if (!Number.isFinite(bestAsk) || bestAsk <= 0) {
      throw new Error("bullish_mark_unavailable");
    }
    const unitPrice = bestAsk;
    return {
      markPremium: Number((unitPrice * Math.max(0, Number(params.quantity || 0))).toFixed(10)),
      unitPrice,
      source: "bullish_hybrid_orderbook",
      asOf: book.datetime || nowIso(),
      details: {
        bullishSymbol: symbol,
        sequenceNumber: book.sequenceNumber
      }
    };
  }

  async sellOption(params: { instrumentId: string; quantity: number }): Promise<SellOptionResult> {
    if (!this.config.enableExecution) {
      return {
        status: "failed",
        instrumentId: params.instrumentId,
        quantity: params.quantity,
        fillPrice: 0,
        totalProceeds: 0,
        orderId: null,
        details: { reason: "execution_disabled" }
      };
    }

    const symbol = resolveBullishMarketSymbol(this.config, { instrumentId: params.instrumentId });
    const book = await this.client.getHybridOrderBook(symbol);
    const bestBid = Number(book.bids[0]?.price ?? NaN);
    if (!Number.isFinite(bestBid) || bestBid <= 0) {
      return {
        status: "failed",
        instrumentId: params.instrumentId,
        quantity: params.quantity,
        fillPrice: 0,
        totalProceeds: 0,
        orderId: null,
        details: { reason: "no_bid_available" }
      };
    }

    const isOption = /^[A-Z]+-[A-Z]+-\d{8}-\d+(?:\.\d+)?-(C|P)$/i.test(symbol);
    const pricePrecision = isOption ? 4 : 8;
    const qtyPrecision = isOption ? 2 : 8;
    const formattedPrice = bestBid.toFixed(pricePrecision);
    const formattedQty = (Math.floor(params.quantity * Math.pow(10, qtyPrecision)) / Math.pow(10, qtyPrecision)).toFixed(qtyPrecision);
    const clientOrderId = String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 999)));

    console.log(`[BullishAdapter] Selling option: symbol=${symbol} side=SELL price=${formattedPrice} qty=${formattedQty} clientOrderId=${clientOrderId}`);

    try {
      const response = await this.client.createSpotLimitOrder({
        symbol,
        side: "SELL",
        price: formattedPrice,
        quantity: formattedQty,
        clientOrderId
      });

      const responseRecord = response as Record<string, unknown>;
      const orderId = String(responseRecord.orderId ?? (responseRecord.data as Record<string, unknown> | undefined)?.orderId ?? "");
      const fillPrice = Number(responseRecord.averageFillPrice ?? bestBid);
      const fillQty = Number(responseRecord.quantityFilled ?? params.quantity);

      console.log(`[BullishAdapter] Sell option result: orderId=${orderId} fillPrice=${fillPrice} fillQty=${fillQty}`);

      return {
        status: "sold",
        instrumentId: params.instrumentId,
        quantity: fillQty,
        fillPrice,
        totalProceeds: fillPrice * fillQty,
        orderId: orderId || null,
        details: { symbol, bestBid, response: responseRecord }
      };
    } catch (err: any) {
      console.error(`[BullishAdapter] Sell option FAILED: ${err?.message}`);
      return {
        status: "failed",
        instrumentId: params.instrumentId,
        quantity: params.quantity,
        fillPrice: 0,
        totalProceeds: 0,
        orderId: null,
        details: { reason: err?.message || "sell_order_failed" }
      };
    }
  }
}

export const createPilotVenueAdapter = (params: {
  mode: PilotVenueMode;
  falconx: FalconxConfig;
  deribit: DeribitConnector;
  ibkr?: IbkrVenueConfig;
  bullish?: BullishRuntimeConfig;
  bullishEnabled?: boolean;
  ibkrQuoteBudgetMs?: number;
  quoteTtlMs?: number;
  deribitQuotePolicy?: DeribitQuotePolicy;
  deribitStrikeSelectionMode?: DeribitStrikeSelectionMode;
  deribitMaxTenorDriftDays?: number;
}): PilotVenueAdapter => {
  const quoteTtlMs = Math.max(5_000, Number(params.quoteTtlMs || 30_000));
  if (params.mode === "falconx") return new FalconxAdapter(params.falconx);
  if (params.mode === "bullish_testnet") {
    if (params.bullishEnabled !== true) {
      throw new Error("bullish_testnet_disabled");
    }
    if (!params.bullish) {
      throw new Error("bullish_config_missing");
    }
    return new BullishTestnetAdapter(params.bullish, quoteTtlMs);
  }
  if (params.mode === "deribit_live") {
    return new DeribitLiveAdapter(
      params.deribit,
      quoteTtlMs,
      params.deribitQuotePolicy || "ask_or_mark_fallback",
      params.deribitStrikeSelectionMode || "trigger_aligned",
      Number.isFinite(Number(params.deribitMaxTenorDriftDays))
        ? Number(params.deribitMaxTenorDriftDays)
        : 7
    );
  }
  // IBKR is deprecated for V7 pilot; skip initialization when venue is bullish_testnet (handled above)
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
        ? Math.max(0, Math.min(30, Math.floor(Number(params.ibkr.optionTenorWindowDays))))
        : 3,
      params.ibkr.requireOptionsNative === true,
      Number.isFinite(Number(params.ibkr.qualifyCacheTtlMs))
        ? Math.max(1000, Math.floor(Number(params.ibkr.qualifyCacheTtlMs)))
        : 120000,
      Number.isFinite(Number(params.ibkr.qualifyCacheMaxKeys))
        ? Math.max(100, Math.floor(Number(params.ibkr.qualifyCacheMaxKeys)))
        : 2000,
      connectorTimeoutMs,
      Number(params.ibkrQuoteBudgetMs || 0),
      params.ibkr.selectorMode || "strict_profitability",
      params.ibkr.hedgeOptimizer || {
        enabled: false,
        version: "optimizer_v1",
        normalization: {
          expectedSubsidyUsd: { min: 0, max: 5000 },
          cvar95Usd: { min: 0, max: 7000 },
          liquidityPenalty: { min: 0, max: 50 },
          fillRiskPenalty: { min: 0, max: 30 },
          basisPenalty: { min: 0, max: 20 },
          carryPenalty: { min: 0, max: 20 },
          pnlRewardUsd: { min: 0, max: 7000 },
          mtpdReward: { min: 0, max: 100 },
          tenorDriftDays: { min: 0, max: 14 },
          strikeDistancePct: { min: 0, max: 0.2 }
        },
        weights: {
          expectedSubsidy: 0.28,
          cvar95: 0.14,
          liquidityPenalty: 0.1,
          fillRiskPenalty: 0.08,
          basisPenalty: 0.05,
          carryPenalty: 0.05,
          pnlReward: 0.12,
          mtpdReward: 0.08,
          tenorDriftPenalty: 0.05,
          strikeDistancePenalty: 0.05
        },
        hardConstraints: {
          maxPremiumRatio: 0.2,
          maxSpreadPct: 0.35,
          minAskSize: 0.2,
          maxTenorDriftDays: 7,
          minTailProtectionScore: 1,
          maxExpectedSubsidyUsd: 10000
        },
        regimePolicy: {
          calm: { preferCloserStrikeBias: 1, maxStrikeDistancePct: 0.1, minTenorDays: 5, maxTenorDays: 21 },
          neutral: { preferCloserStrikeBias: 0.7, maxStrikeDistancePct: 0.12, minTenorDays: 3, maxTenorDays: 14 },
          stress: { preferCloserStrikeBias: 0.25, maxStrikeDistancePct: 0.2, minTenorDays: 1, maxTenorDays: 10 }
        }
      }
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
  if (message.includes("options_required")) return "quote_options_required";
  return "venue_error";
};

