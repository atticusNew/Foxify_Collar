import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { DeribitConnector } from "@foxify/connectors";
import type {
  DeribitQuotePolicy,
  DeribitStrikeSelectionMode,
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
  clientOrderId?: string;
};

type FalconxConfig = {
  baseUrl: string;
  apiKey: string;
  secret: string;
  passphrase: string;
};

const nowIso = (): string => new Date().toISOString();

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
  quoteTtlMs?: number;
  deribitQuotePolicy?: DeribitQuotePolicy;
  deribitStrikeSelectionMode?: DeribitStrikeSelectionMode;
  deribitMaxTenorDriftDays?: number;
}): PilotVenueAdapter => {
  const quoteTtlMs = Math.max(5_000, Number(params.quoteTtlMs || 30_000));
  if (params.mode === "falconx") return new FalconxAdapter(params.falconx);
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

