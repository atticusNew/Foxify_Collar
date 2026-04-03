import { createHash, createHmac, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { BullishRuntimeConfig } from "./config";

type BullishJwtSession = {
  token: string;
  authorizer: string;
  expiresAtMs: number;
};

type BullishOrderbookLevel = {
  price: string;
  quantity: string;
};

export type BullishHybridOrderbook = {
  symbol: string;
  bids: BullishOrderbookLevel[];
  asks: BullishOrderbookLevel[];
  datetime: string | null;
  timestamp: string | null;
  sequenceNumber: string | null;
  raw: unknown;
};

type BullishWsMessage = Record<string, unknown>;

let bullishWsRequestCounter = BigInt(Date.now());

const nextBullishWsRequestId = (): string => {
  bullishWsRequestCounter += 1n;
  return bullishWsRequestCounter.toString();
};

const ensureLeadingSlash = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

const buildUrl = (baseUrl: string, requestPath: string): string =>
  new URL(ensureLeadingSlash(requestPath), baseUrl).toString();

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

// Bullish HMAC login signs the raw canonical string directly.
const signBullishHmacLogin = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(value).digest("hex");

// Bullish authenticated command submission signs the SHA-256 hexdigest of the canonical string.
const signBullishHmacCommand = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(sha256Hex(value)).digest("hex");

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const toFiniteString = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? raw : null;
};

const normalizeOrderbookSide = (value: unknown): BullishOrderbookLevel[] => {
  const levels = asArray<unknown>(value);
  if (!levels.length) return [];
  if (typeof levels[0] === "string" || typeof levels[0] === "number") {
    const flattened = levels.map((entry) => String(entry));
    const out: BullishOrderbookLevel[] = [];
    for (let idx = 0; idx + 1 < flattened.length; idx += 2) {
      const price = toFiniteString(flattened[idx]);
      const quantity = toFiniteString(flattened[idx + 1]);
      if (price && quantity) out.push({ price, quantity });
    }
    return out;
  }
  if (Array.isArray(levels[0])) {
    return levels
      .map((entry) => {
        const pair = asArray<unknown>(entry);
        const price = toFiniteString(pair[0]);
        const quantity = toFiniteString(pair[1]);
        return price && quantity ? { price, quantity } : null;
      })
      .filter((entry): entry is BullishOrderbookLevel => Boolean(entry));
  }
  return levels
    .map((entry) => {
      const record = entry as Record<string, unknown>;
      const price = toFiniteString(
        record.price ?? record.px ?? record.levelPrice ?? record.orderPrice ?? record[0]
      );
      const quantity = toFiniteString(
        record.quantity ??
          record.qty ??
          record.size ??
          record.amount ??
          record.absoluteQuantity ??
          record.priceLevelQuantity ??
          record[1]
      );
      return price && quantity ? { price, quantity } : null;
    })
    .filter((entry): entry is BullishOrderbookLevel => Boolean(entry));
};

const defaultPrivateTopicDataType = (topic: string): string | null => {
  const normalized = topic.trim();
  if (!normalized) return null;
  const map: Record<string, string> = {
    orders: "V1TAOrder",
    trades: "V1TATrade",
    assetAccounts: "V1TAAssetAccount",
    tradingAccounts: "V1TATradingAccount",
    heartbeat: "V1TAHeartbeat"
  };
  return map[normalized] || null;
};

export const resolveBullishMarketSymbol = (
  config: Pick<BullishRuntimeConfig, "defaultSymbol" | "symbolByMarketId">,
  params: { marketId?: string | null; instrumentId?: string | null }
): string => {
  const marketId = String(params.marketId || "").trim();
  if (marketId && config.symbolByMarketId[marketId]) return config.symbolByMarketId[marketId];
  const instrument = String(params.instrumentId || "").trim().toUpperCase();
  if (instrument.startsWith("BTC")) return config.symbolByMarketId["BTC-USD"] || config.defaultSymbol;
  return config.defaultSymbol;
};

export class BullishTradingClient {
  private jwtSession: BullishJwtSession | null = null;

  private nextNonceValue: bigint = BigInt(Date.now()) * 1000n;

  constructor(private readonly config: BullishRuntimeConfig) {}

  private async request(params: {
    path: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string | undefined;
    timeoutMs?: number;
  }): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = Math.max(500, Number(params.timeoutMs || 0) || 5000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(buildUrl(this.config.restBaseUrl, params.path), {
        method: params.method || "GET",
        headers: params.headers,
        body: params.body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson<T>(params: {
    path: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string | undefined;
    timeoutMs?: number;
  }): Promise<T> {
    const response = await this.request(params);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`bullish_http_${response.status}:${text}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  private async getCommandNonce(): Promise<string> {
    try {
      const payload = await this.requestJson<{ lowerBound?: string; upperBound?: string }>({
        path: this.config.noncePath,
        timeoutMs: this.config.orderTimeoutMs
      });
      const lower = payload.lowerBound ? BigInt(payload.lowerBound) : 0n;
      const current = BigInt(Date.now()) * 1000n;
      if (this.nextNonceValue < lower) {
        this.nextNonceValue = lower;
      }
      if (this.nextNonceValue < current) {
        this.nextNonceValue = current;
      }
    } catch {
      const current = BigInt(Date.now()) * 1000n;
      if (this.nextNonceValue < current) this.nextNonceValue = current;
    }
    this.nextNonceValue += 1n;
    return this.nextNonceValue.toString();
  }

  private async getJwtSession(): Promise<BullishJwtSession> {
    if (this.jwtSession && this.jwtSession.expiresAtMs > Date.now() + 60_000) {
      return this.jwtSession;
    }
    if (this.config.authMode !== "hmac") {
      throw new Error("bullish_auth_mode_not_supported");
    }
    if (!this.config.hmacPublicKey || !this.config.hmacSecret) {
      throw new Error("bullish_credentials_missing");
    }
    const timestamp = Date.now().toString();
    // Bullish HMAC login examples use a numeric, time-based nonce.
    const nonce = Math.floor(Date.now() / 1000).toString();
    const requestPath = ensureLeadingSlash(this.config.hmacLoginPath);
    const signaturePayload = `${timestamp}${nonce}GET${requestPath}`;
    const signature = signBullishHmacLogin(this.config.hmacSecret, signaturePayload);
    const payload = await this.requestJson<{ token?: string; authorizer?: string }>({
      path: requestPath,
      method: "GET",
      timeoutMs: this.config.orderTimeoutMs,
      headers: {
        Accept: "application/json",
        "BX-TIMESTAMP": timestamp,
        "BX-NONCE": nonce,
        "BX-PUBLIC-KEY": this.config.hmacPublicKey,
        "BX-SIGNATURE": signature
      }
    });
    if (!payload?.token || !payload?.authorizer) {
      throw new Error("bullish_login_invalid_response");
    }
    this.jwtSession = {
      token: payload.token,
      authorizer: payload.authorizer,
      expiresAtMs: Date.now() + 23 * 60 * 60 * 1000
    };
    return this.jwtSession;
  }

  private async buildJwtHeaders(): Promise<Record<string, string>> {
    const session = await this.getJwtSession();
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
      COOKIE: `JWT_COOKIE=${session.token}`
    };
  }

  getConfiguredTradingAccountId(): string {
    return String(this.config.tradingAccountId || "").trim();
  }

  async getTradingAccounts(): Promise<unknown> {
    const headers = await this.buildJwtHeaders();
    const payload = await this.requestJson<unknown>({
      path: this.config.tradingAccountsPath,
      method: "GET",
      timeoutMs: this.config.orderTimeoutMs,
      headers
    });
    const configuredTradingAccountId = this.getConfiguredTradingAccountId();
    const records = Array.isArray((payload as any)?.data) ? ((payload as any).data as Array<Record<string, unknown>>) : null;
    if (!configuredTradingAccountId || !records) {
      return payload;
    }
    return {
      ...(payload as Record<string, unknown>),
      data: records.filter((record) => String(record.tradingAccountId || "") === configuredTradingAccountId)
    };
  }

  async getHybridOrderBook(symbol: string): Promise<BullishHybridOrderbook> {
    const requestPath = this.config.orderbookPathTemplate.replace(":symbol", encodeURIComponent(symbol));
    const payload = await this.requestJson<{
      bids?: unknown;
      asks?: unknown;
      datetime?: string;
      timestamp?: string;
      sequenceNumber?: string | number;
    }>({
      path: requestPath,
      method: "GET",
      timeoutMs: this.config.orderTimeoutMs,
      headers: { Accept: "application/json" }
    });
    return {
      symbol,
      bids: normalizeOrderbookSide(payload?.bids),
      asks: normalizeOrderbookSide(payload?.asks),
      datetime: payload?.datetime || null,
      timestamp: payload?.timestamp || null,
      sequenceNumber:
        payload?.sequenceNumber === undefined || payload?.sequenceNumber === null
          ? null
          : String(payload.sequenceNumber),
      raw: payload
    };
  }

  async submitCommand(command: Record<string, unknown>): Promise<unknown> {
    const session = await this.getJwtSession();
    const timestamp = Date.now().toString();
    const nonce = await this.getCommandNonce();
    const requestPath = ensureLeadingSlash(this.config.commandPath);
    const payload = JSON.stringify({
      timestamp,
      nonce,
      authorizer: session.authorizer,
      command
    });
    const signature = signBullishHmacCommand(
      this.config.hmacSecret,
      `${timestamp}${nonce}POST${requestPath}${payload}`
    );
    return await this.requestJson({
      path: requestPath,
      method: "POST",
      timeoutMs: this.config.orderTimeoutMs,
      body: payload,
      headers: {
        ...(await this.buildJwtHeaders()),
        "BX-TIMESTAMP": timestamp,
        "BX-NONCE": nonce,
        "BX-PUBLIC-KEY": this.config.hmacPublicKey,
        "BX-SIGNATURE": signature
      }
    });
  }

  async createSpotLimitOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    price: string;
    quantity: string;
    clientOrderId?: string;
  }): Promise<unknown> {
    return await this.submitCommand({
      commandType: "V2CreateOrder",
      handle: null,
      clientOrderId: params.clientOrderId || null,
      symbol: params.symbol,
      type: "LMT",
      side: params.side,
      price: params.price,
      stopPrice: null,
      quantity: params.quantity,
      timeInForce: this.config.orderTif,
      allowMargin: this.config.allowMargin,
      tradingAccountId: this.config.tradingAccountId
    });
  }

  async cancelOrder(params: { symbol: string; orderId: string; clientOrderId?: string }): Promise<unknown> {
    return await this.submitCommand({
      commandType: "V2CancelOrder",
      orderId: params.orderId,
      handle: null,
      clientOrderId: params.clientOrderId || null,
      symbol: params.symbol,
      tradingAccountId: this.config.tradingAccountId
    });
  }

  private async waitForWebSocketMessage(params: {
    url: string;
    headers?: Record<string, string>;
    onOpenMessages?: Array<Record<string, unknown>>;
    timeoutMs: number;
    predicate: (message: BullishWsMessage) => boolean;
  }): Promise<BullishWsMessage> {
    return await new Promise<BullishWsMessage>((resolve, reject) => {
      const ws = new WebSocket(params.url, {
        headers: params.headers
      });
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("bullish_ws_timeout"));
      }, params.timeoutMs);
      ws.on("open", () => {
        for (const message of params.onOpenMessages || []) {
          ws.send(JSON.stringify(message));
        }
      });
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as BullishWsMessage;
          if (params.predicate(parsed)) {
            clearTimeout(timeout);
            ws.close();
            resolve(parsed);
          }
        } catch {
          // Ignore malformed messages; heartbeat and snapshots are JSON.
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      ws.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  async waitForPublicOrderbookSnapshot(params: {
    symbol: string;
    topic?: "l1Orderbook" | "l2Orderbook";
    timeoutMs?: number;
  }): Promise<BullishWsMessage> {
    const topic = params.topic || "l2Orderbook";
    return await this.waitForWebSocketMessage({
      url: this.config.publicWsUrl,
      timeoutMs: Math.max(1000, Number(params.timeoutMs || 10_000)),
      onOpenMessages: [
        {
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: {
            topic,
            symbol: params.symbol
          },
          id: nextBullishWsRequestId()
        },
        {
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: { topic: "heartbeat" },
          id: nextBullishWsRequestId()
        }
      ],
      predicate: (message) => {
        const data = (message.data || {}) as Record<string, unknown>;
        return (
          String(data.symbol || "") === params.symbol &&
          (message.type === "snapshot" || message.type === "update")
        );
      }
    });
  }

  async waitForPrivateTopicSnapshot(params: {
    topic: string;
    timeoutMs?: number;
    tradingAccountId?: string;
  }): Promise<BullishWsMessage> {
    const session = await this.getJwtSession();
    const url = new URL(this.config.privateWsUrl);
    const tradingAccountId = params.tradingAccountId || this.config.tradingAccountId;
    if (tradingAccountId) {
      url.searchParams.set("tradingAccountId", tradingAccountId);
    }
    const dataType = defaultPrivateTopicDataType(params.topic);
    return await this.waitForWebSocketMessage({
      url: url.toString(),
      timeoutMs: Math.max(1000, Number(params.timeoutMs || 10_000)),
      headers: {
        Authorization: `Bearer ${session.token}`,
        COOKIE: `JWT_COOKIE=${session.token}`
      },
      onOpenMessages: [
        {
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: {
            topic: params.topic
          },
          id: nextBullishWsRequestId()
        },
        {
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: { topic: "heartbeat" },
          id: nextBullishWsRequestId()
        }
      ],
      predicate: (message) => {
        if (params.topic === "heartbeat") {
          return String(message.dataType || "") === "V1TAHeartbeat";
        }
        return dataType ? String(message.dataType || "") === dataType : message.type === "snapshot";
      }
    });
  }
}
