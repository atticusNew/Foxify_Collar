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
  maxRepriceSteps: number;
  repriceStepTicks: number;
  maxSlippageBps: number;
  requireLiveTransport: boolean;
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

const buildIbkrInstrumentId = (contract: IbkrQualifiedContract): string => {
  const symbol = String(contract.localSymbol || "").replace(/\s+/g, "_");
  return `IBKR-${contract.secType}-${contract.conId}-${symbol}`;
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
  private transportVerified = false;

  constructor(
    private connector: IbkrConnector,
    private mode: "ibkr_cme_live" | "ibkr_cme_paper",
    private quoteTtlMs: number,
    private accountId: string,
    private enableExecution: boolean,
    private maxRepriceSteps: number,
    private repriceStepTicks: number,
    private maxSlippageBps: number,
    private requireLiveTransport: boolean
  ) {}

  private resolveRight(protectionType?: "long" | "short"): "P" | "C" {
    return protectionType === "short" ? "C" : "P";
  }

  private async ensureRequiredLiveTransport(): Promise<void> {
    if (!this.requireLiveTransport || this.transportVerified) return;
    await this.connector.assertLiveTransportRequired();
    this.transportVerified = true;
  }

  private async resolveContractAndBook(req: QuoteRequest): Promise<{
    contract: IbkrQualifiedContract;
    hedgeMode: "options_native" | "futures_synthetic";
    top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
    selectedTenorDays: number;
    strike: number | null;
  }> {
    const requestedTenorDays = clampInt(req.requestedTenorDays, 1, 30, 7);
    const minTenorDays = clampInt(req.tenorMinDays, 1, 30, 1);
    const maxTenorDays = clampInt(req.tenorMaxDays, minTenorDays, 30, Math.max(minTenorDays, 7));
    const selectedTenorDays = Math.max(minTenorDays, Math.min(maxTenorDays, requestedTenorDays));
    const trigger = toFinitePositive(req.triggerPrice);
    const roundedStrike = trigger ? Math.max(1000, Math.round(trigger / 500) * 500) : null;
    const right = this.resolveRight(req.protectionType);
    const hedgePolicy = req.hedgePolicy || "options_primary_futures_fallback";
    const hasUsableTop = (top: { ask: number | null; bid: number | null }): boolean =>
      toFinitePositive(top.ask) !== null || toFinitePositive(top.bid) !== null;
    const pickContractWithTop = async (
      contracts: IbkrQualifiedContract[]
    ): Promise<
      | {
          contract: IbkrQualifiedContract;
          top: { ask: number | null; bid: number | null; askSize: number | null; bidSize: number | null; asOf: string };
        }
      | null
    > => {
      const shortlisted = contracts.slice(0, 3);
      if (shortlisted.length === 0) return null;
      const settled = await Promise.all(
        shortlisted.map(async (contract) => {
          try {
            const top = await this.connector.getTopOfBook(contract.conId);
            return { contract, top };
          } catch {
            return null;
          }
        })
      );
      for (const item of settled) {
        if (!item) continue;
        if (!hasUsableTop(item.top)) continue;
        return item;
      }
      return null;
    };

    if (hedgePolicy === "options_primary_futures_fallback") {
      if (roundedStrike) {
        const optionQuery: IbkrContractQuery = {
          kind: "mbt_option",
          symbol: "BTC",
          exchange: "CME",
          currency: "USD",
          tenorDays: selectedTenorDays,
          right,
          strike: roundedStrike
        };
        const optionContracts = await this.connector.qualifyContracts(optionQuery);
        const optionMatch = await pickContractWithTop(optionContracts);
        if (optionMatch) {
          return {
            contract: optionMatch.contract,
            hedgeMode: "options_native",
            top: optionMatch.top,
            selectedTenorDays,
            strike: toFinitePositive(optionMatch.contract.strike) || roundedStrike
          };
        }
      }

      const futQuery: IbkrContractQuery = {
        kind: "mbt_future",
        symbol: "BTC",
        exchange: "CME",
        currency: "USD",
        tenorDays: selectedTenorDays
      };
      const futContracts = await this.connector.qualifyContracts(futQuery);
      const futMatch = await pickContractWithTop(futContracts);
      if (futMatch) {
        return {
          contract: futMatch.contract,
          hedgeMode: "futures_synthetic",
          top: futMatch.top,
          selectedTenorDays,
          strike: null
        };
      }
      if (futContracts.length > 0) {
        throw new Error("ibkr_quote_unavailable:no_top_of_book");
      }
    }

    throw new Error("ibkr_quote_unavailable:no_contract");
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    await this.ensureRequiredLiveTransport();
    const resolved = await this.resolveContractAndBook(req);
    const ask = toFinitePositive(resolved.top.ask);
    const bid = toFinitePositive(resolved.top.bid);
    const unitPrice = ask ?? bid;
    if (!unitPrice) {
      throw new Error("ibkr_quote_unavailable:no_top_of_book");
    }
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    const notional = Math.max(0, Number(req.protectedNotional || 0));
    const referenceQty = Math.max(0, Number(req.quantity || 0));
    const premium = Number((Math.max(unitPrice * referenceQty, notional * 0.001)).toFixed(4));
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
        pricing: "cme_mbt",
        hedgeMode: resolved.hedgeMode,
        selectedTenorDays: resolved.selectedTenorDays,
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
        minTick: resolved.contract.minTick ?? null
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
    for (let step = 0; step < maxSteps; step += 1) {
      const limitPrice = Math.min(maxLimit, baseLimit + step * stepTicks * minTick);
      const placed = await this.connector.placeOrder({
        accountId: this.accountId,
        conId,
        side: "BUY",
        quantity: requestedContracts,
        orderType: "LMT",
        limitPrice,
        tif: "IOC",
        clientOrderId: `pilot-${quote.quoteId}-${step}`
      });
      lastOrderId = placed.orderId;
      const statusDeadline = Date.now() + Math.max(800, Number(this.maxRepriceSteps || 1) * 400);
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
            repriceStep: step
          }
        };
      }
      await this.connector.cancelOrder(placed.orderId);
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
      details: { reason: "no_fill_after_reprice" }
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
    const ibkrConnector = new IbkrConnector({
      baseUrl: params.ibkr.bridgeBaseUrl,
      // Use the more permissive timeout so quote/market-data paths do not abort early
      // when IB request latency exceeds execution polling timeout.
      timeoutMs: Math.max(500, Number(params.ibkr.bridgeTimeoutMs || 0), Number(params.ibkr.orderTimeoutMs || 0)),
      auth: { token: params.ibkr.bridgeToken },
      accountId: params.ibkr.accountId
    });
    return new IbkrCmeAdapter(
      ibkrConnector,
      params.mode,
      quoteTtlMs,
      params.ibkr.accountId,
      params.ibkr.enableExecution,
      params.ibkr.maxRepriceSteps,
      params.ibkr.repriceStepTicks,
      params.ibkr.maxSlippageBps,
      params.ibkr.requireLiveTransport
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
  return "venue_error";
};

