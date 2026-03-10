import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { DeribitConnector } from "@foxify/connectors";
import type { PilotVenueMode } from "./config";
import type { VenueExecution, VenueQuote } from "./types";

export type QuoteRequest = {
  marketId: string;
  instrumentId: string;
  protectedNotional: number;
  quantity: number;
  side: "buy";
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

export interface PilotVenueAdapter {
  quote(req: QuoteRequest): Promise<VenueQuote>;
  execute(quote: VenueQuote): Promise<VenueExecution>;
}

class MockFalconxAdapter implements PilotVenueAdapter {
  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const premium = Number((req.protectedNotional * 0.01).toFixed(4));
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
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
}

class DeribitTestAdapter implements PilotVenueAdapter {
  constructor(private connector: DeribitConnector) {}

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const premium = Number((req.protectedNotional * 0.011).toFixed(4));
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + 10_000).toISOString();
    return {
      venue: "deribit_test",
      quoteId: randomUUID(),
      rfqId: null,
      instrumentId: req.instrumentId,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt,
      quoteTs,
      details: { source: "deribit_test_pricing_stub" }
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
    return {
      venue: "deribit_test",
      status,
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: quote.quantity,
      executionPrice: Number(order?.fillPrice ?? 0),
      premium: quote.premium,
      executedAt: nowIso(),
      externalOrderId: String(order?.id || `DERIBIT-ORD-${randomUUID()}`),
      externalExecutionId: String(order?.id || `DERIBIT-EXE-${randomUUID()}`),
      details: { raw: order }
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
}

export const createPilotVenueAdapter = (params: {
  mode: PilotVenueMode;
  falconx: FalconxConfig;
  deribit: DeribitConnector;
}): PilotVenueAdapter => {
  if (params.mode === "falconx") return new FalconxAdapter(params.falconx);
  if (params.mode === "deribit_test") return new DeribitTestAdapter(params.deribit);
  return new MockFalconxAdapter();
};

export const mapVenueFailureReason = (error: unknown): string => {
  const message = String((error as any)?.message || "venue_error");
  if (message.includes("QUOTE_EXPIRED")) return "quote_expired";
  if (message.includes("INVALID_QUOTE_ID")) return "invalid_quote_id";
  if (message.includes("COOLDOWN")) return "execution_cooldown";
  if (message.includes("INSUFFICIENT")) return "insufficient_balance";
  return "venue_error";
};

