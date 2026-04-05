import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, randomUUID } from "node:crypto";
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

export type BullishMarketRecord = {
  symbol: string;
  marketId?: string;
  marketType?: string;
  optionType?: string;
  optionStrikePrice?: string;
  expiryDatetime?: string;
  underlyingBaseSymbol?: string;
  underlyingQuoteSymbol?: string;
  marketEnabled?: boolean;
  createOrderEnabled?: boolean;
};

type BullishWsMessage = Record<string, unknown>;

type BullishPemInspection = {
  present: boolean;
  normalized: string;
  beginLabel: string | null;
  endLabel: string | null;
  bodyLength: number;
  invalidBodyCharCount: number;
  invalidBodyCharSample: string[];
};

let bullishWsRequestCounter = BigInt(Date.now());

const nextBullishWsRequestId = (): string => {
  bullishWsRequestCounter += 1n;
  return bullishWsRequestCounter.toString();
};

const ensureLeadingSlash = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

const buildUrl = (baseUrl: string, requestPath: string): string =>
  new URL(ensureLeadingSlash(requestPath), baseUrl).toString();

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const normalizePem = (value: string): string => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const withoutWrappingQuotes =
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("\"") && normalized.endsWith("\""))
      ? normalized.slice(1, -1)
      : normalized;
  const withNewlines = withoutWrappingQuotes.replace(/\\n/g, "\n").trim();
  const beginMatch = withNewlines.match(/-----BEGIN ([A-Z ]+)-----/);
  const endMatch = withNewlines.match(/-----END ([A-Z ]+)-----/);
  if (!beginMatch || !endMatch) {
    return withNewlines;
  }
  const label = beginMatch[1].trim();
  const body = withNewlines
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g)?.join("\n") || body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
};

const inspectPem = (value: string): BullishPemInspection => {
  const normalized = normalizePem(value);
  if (!normalized) {
    return {
      present: false,
      normalized: "",
      beginLabel: null,
      endLabel: null,
      bodyLength: 0,
      invalidBodyCharCount: 0,
      invalidBodyCharSample: []
    };
  }
  const beginLabel = normalized.match(/-----BEGIN ([A-Z ]+)-----/)?.[1]?.trim() || null;
  const endLabel = normalized.match(/-----END ([A-Z ]+)-----/)?.[1]?.trim() || null;
  const body = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const invalidChars = Array.from(new Set(body.replace(/[A-Za-z0-9+/=]/g, "").split("").filter(Boolean)));
  return {
    present: true,
    normalized,
    beginLabel,
    endLabel,
    bodyLength: body.length,
    invalidBodyCharCount: invalidChars.length,
    invalidBodyCharSample: invalidChars.slice(0, 8)
  };
};

const parseBullishPrivateKey = (value: string) => {
  const inspection = inspectPem(value);
  if (!inspection.present) {
    throw new Error("bullish_ecdsa_private_key_missing");
  }
  if (!inspection.beginLabel || !inspection.endLabel || inspection.beginLabel !== inspection.endLabel) {
    throw new Error("bullish_ecdsa_private_key_invalid_pem_markers");
  }
  if (inspection.invalidBodyCharCount > 0) {
    throw new Error("bullish_ecdsa_private_key_invalid_base64_body");
  }
  const type =
    inspection.beginLabel === "PRIVATE KEY"
      ? "pkcs8"
      : inspection.beginLabel === "EC PRIVATE KEY"
        ? "sec1"
        : null;
  if (!type) {
    throw new Error(`bullish_ecdsa_private_key_unsupported_pem_type:${inspection.beginLabel}`);
  }
  try {
    return createPrivateKey({
      key: inspection.normalized,
      format: "pem",
      type
    });
  } catch {
    throw new Error(`bullish_ecdsa_private_key_parse_failed:${type}`);
  }
};

const parseBullishPublicKey = (value: string) => {
  const inspection = inspectPem(value);
  if (!inspection.present) {
    throw new Error("bullish_ecdsa_public_key_missing");
  }
  if (!inspection.beginLabel || !inspection.endLabel || inspection.beginLabel !== inspection.endLabel) {
    throw new Error("bullish_ecdsa_public_key_invalid_pem_markers");
  }
  if (inspection.invalidBodyCharCount > 0) {
    throw new Error("bullish_ecdsa_public_key_invalid_base64_body");
  }
  if (inspection.beginLabel !== "PUBLIC KEY") {
    throw new Error(`bullish_ecdsa_public_key_unsupported_pem_type:${inspection.beginLabel}`);
  }
  try {
    return createPublicKey({
      key: inspection.normalized,
      format: "pem",
      type: "spki"
    });
  } catch {
    throw new Error("bullish_ecdsa_public_key_parse_failed:spki");
  }
};

const decodeBullishMetadata = (encoded: string): { userId: string | null; raw: Record<string, unknown> | null } => {
  const normalized = String(encoded || "").trim();
  if (!normalized) return { userId: null, raw: null };
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const userId = String(parsed.userId || "").trim();
    return {
      userId: userId || null,
      raw: parsed
    };
  } catch {
    return { userId: null, raw: null };
  }
};

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
  if (
    /^[A-Z0-9]+-[A-Z0-9]+-PERP$/.test(instrument) ||
    /^[A-Z0-9]+-[A-Z0-9]+-\d{8}$/.test(instrument) ||
    /^[A-Z0-9]+-[A-Z0-9]+-\d{8}-\d+(?:\.\d+)?-(C|P)$/.test(instrument)
  ) {
    return instrument;
  }
  if (instrument.startsWith("BTC")) return config.symbolByMarketId["BTC-USD"] || config.defaultSymbol;
  return config.defaultSymbol;
};

export const inspectBullishEcdsaKeyMaterial = (params: {
  publicKey: string;
  privateKey: string;
  metadata: string;
}) => {
  const publicInspection = inspectPem(params.publicKey);
  const privateInspection = inspectPem(params.privateKey);
  const metadata = decodeBullishMetadata(params.metadata);
  let privateKeyParses = false;
  let publicKeyParses = false;
  let privateKeyParseError: string | null = null;
  let publicKeyParseError: string | null = null;
  try {
    parseBullishPrivateKey(params.privateKey);
    privateKeyParses = true;
  } catch (error) {
    privateKeyParseError = String((error as Error)?.message || error);
  }
  try {
    parseBullishPublicKey(params.publicKey);
    publicKeyParses = true;
  } catch (error) {
    publicKeyParseError = String((error as Error)?.message || error);
  }
  return {
    metadataUserIdPresent: Boolean(metadata.userId),
    publicKey: {
      present: publicInspection.present,
      beginLabel: publicInspection.beginLabel,
      endLabel: publicInspection.endLabel,
      bodyLength: publicInspection.bodyLength,
      invalidBodyCharCount: publicInspection.invalidBodyCharCount,
      invalidBodyCharSample: publicInspection.invalidBodyCharSample,
      parses: publicKeyParses,
      parseError: publicKeyParseError
    },
    privateKey: {
      present: privateInspection.present,
      beginLabel: privateInspection.beginLabel,
      endLabel: privateInspection.endLabel,
      bodyLength: privateInspection.bodyLength,
      invalidBodyCharCount: privateInspection.invalidBodyCharCount,
      invalidBodyCharSample: privateInspection.invalidBodyCharSample,
      parses: privateKeyParses,
      parseError: privateKeyParseError
    }
  };
};

export class BullishTradingClient {
  private jwtSession: BullishJwtSession | null = null;

  private nextNonceValue: bigint = BigInt(Date.now()) * 1000n;

  private marketsCache: { expiresAtMs: number; records: BullishMarketRecord[] } | null = null;

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

  private async loginWithHmac(): Promise<BullishJwtSession> {
    if (this.jwtSession && this.jwtSession.expiresAtMs > Date.now() + 60_000) {
      return this.jwtSession;
    }
    if (!this.config.hmacPublicKey || !this.config.hmacSecret) {
      throw new Error("bullish_credentials_missing");
    }
    const timestamp = Date.now().toString();
    // Bullish requires BX-NONCE to be an incrementing 64-bit integer within the
    // current daily nonce window; reuse the microsecond-range nonce helper here.
    const nonce = await this.getCommandNonce();
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

  private async loginWithEcdsa(): Promise<BullishJwtSession> {
    if (this.jwtSession && this.jwtSession.expiresAtMs > Date.now() + 60_000) {
      return this.jwtSession;
    }
    const publicKey = normalizePem(this.config.ecdsaPublicKey);
    const { userId } = decodeBullishMetadata(this.config.ecdsaMetadata);
    if (!publicKey || !this.config.ecdsaPrivateKey || !userId) {
      throw new Error("bullish_credentials_missing");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const loginPayload = {
      userId,
      nonce: nowSeconds,
      expirationTime: nowSeconds + 300,
      biometricsUsed: false,
      sessionKey: null
    };
    const loginPayloadJson = JSON.stringify(loginPayload);
    // Validate both PEMs eagerly so auth failures distinguish local key parsing
    // from remote Bullish API/login rejections.
    parseBullishPublicKey(publicKey);
    const signer = createSign("sha256");
    signer.update(loginPayloadJson);
    signer.end();
    const signature = signer.sign(parseBullishPrivateKey(this.config.ecdsaPrivateKey)).toString("base64");
    const payload = await this.requestJson<{ token?: string; authorizer?: string }>({
      path: ensureLeadingSlash(this.config.ecdsaLoginPath),
      method: "POST",
      timeoutMs: this.config.orderTimeoutMs,
      body: JSON.stringify({
        publicKey,
        signature,
        loginPayload
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
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

  private async getJwtSession(): Promise<BullishJwtSession> {
    if (this.jwtSession && this.jwtSession.expiresAtMs > Date.now() + 60_000) {
      return this.jwtSession;
    }
    if (this.config.authMode === "ecdsa") {
      return await this.loginWithEcdsa();
    }
    if (this.config.authMode === "hmac") {
      return await this.loginWithHmac();
    }
    throw new Error("bullish_auth_mode_not_supported");
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

  async getMarkets(params?: { forceRefresh?: boolean; cacheTtlMs?: number }): Promise<BullishMarketRecord[]> {
    const forceRefresh = params?.forceRefresh === true;
    const cacheTtlMs = Math.max(1000, Number(params?.cacheTtlMs || 0) || 30_000);
    if (!forceRefresh && this.marketsCache && this.marketsCache.expiresAtMs > Date.now()) {
      return this.marketsCache.records;
    }
    const payload = await this.requestJson<unknown>({
      path: "/trading-api/v1/markets",
      method: "GET",
      timeoutMs: this.config.orderTimeoutMs,
      headers: { Accept: "application/json" }
    });
    const records = Array.isArray(payload)
      ? (payload as Array<Record<string, unknown>>)
          .map((item) => {
            const symbol = String(item.symbol || "").trim().toUpperCase();
            if (!symbol) return null;
            return {
              symbol,
              marketId: item.marketId ? String(item.marketId) : undefined,
              marketType: item.marketType ? String(item.marketType) : undefined,
              optionType: item.optionType ? String(item.optionType) : undefined,
              optionStrikePrice: item.optionStrikePrice ? String(item.optionStrikePrice) : undefined,
              expiryDatetime: item.expiryDatetime ? String(item.expiryDatetime) : undefined,
              underlyingBaseSymbol: item.underlyingBaseSymbol ? String(item.underlyingBaseSymbol) : undefined,
              underlyingQuoteSymbol: item.underlyingQuoteSymbol ? String(item.underlyingQuoteSymbol) : undefined,
              marketEnabled: item.marketEnabled === true,
              createOrderEnabled: item.createOrderEnabled === true
            } satisfies BullishMarketRecord;
          })
          .filter((item): item is BullishMarketRecord => Boolean(item))
      : [];
    this.marketsCache = {
      expiresAtMs: Date.now() + cacheTtlMs,
      records
    };
    return records;
  }

  async submitCommand(command: Record<string, unknown>): Promise<unknown> {
    const session = await this.getJwtSession();
    const timestamp = Date.now().toString();
    const nonce = await this.getCommandNonce();

    if (this.config.authMode === "ecdsa" && this.config.ecdsaPrivateKey) {
      const requestPath = "/trading-api/v2/orders";
      const bodyString = JSON.stringify(command);
      const canonicalString = `${timestamp}${nonce}POST${requestPath}${bodyString}`;
      const signer = createSign("sha256");
      signer.update(canonicalString);
      signer.end();
      const signature = signer.sign(parseBullishPrivateKey(this.config.ecdsaPrivateKey)).toString("base64");

      return await this.requestJson({
        path: requestPath,
        method: "POST",
        timeoutMs: this.config.orderTimeoutMs,
        body: bodyString,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
          "BX-TIMESTAMP": timestamp,
          "BX-NONCE": nonce,
          "BX-SIGNATURE": signature
        }
      });
    }

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
    if (this.config.authMode === "ecdsa") {
      return await this.submitCommand({
        commandType: "V3CreateOrder",
        symbol: params.symbol,
        type: "LIMIT",
        side: params.side,
        price: params.price,
        quantity: params.quantity,
        timeInForce: this.config.orderTif,
        clientOrderId: params.clientOrderId || String(BigInt(Date.now()) * 1000n),
        tradingAccountId: this.config.tradingAccountId
      });
    }
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

  async waitForOrderFill(params: {
    clientOrderId: string;
    timeoutMs?: number;
    tradingAccountId?: string;
  }): Promise<BullishOrderFillResult> {
    const session = await this.getJwtSession();
    const url = new URL(this.config.privateWsUrl);
    const tradingAccountId = params.tradingAccountId || this.config.tradingAccountId;
    if (tradingAccountId) {
      url.searchParams.set("tradingAccountId", tradingAccountId);
    }
    const timeoutMs = Math.max(2000, Number(params.timeoutMs || 15_000));

    return await new Promise<BullishOrderFillResult>((resolve, reject) => {
      const ws = new WebSocket(url.toString(), {
        headers: {
          Authorization: `Bearer ${session.token}`,
          COOKIE: `JWT_COOKIE=${session.token}`
        }
      });
      const timeout = setTimeout(() => {
        ws.close();
        resolve({
          status: "timeout",
          orderId: null,
          fillPrice: null,
          fillQuantity: null,
          fees: null,
          orderStatus: null,
          raw: null
        });
      }, timeoutMs);

      ws.on("open", () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: { topic: "orders" },
          id: nextBullishWsRequestId()
        }));
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          type: "command",
          method: "subscribe",
          params: { topic: "trades" },
          id: nextBullishWsRequestId()
        }));
      });

      let matchedOrderId: string | null = null;

      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as BullishWsMessage;
          const dataType = String(parsed.dataType || "");
          const dataArray = Array.isArray(parsed.data) ? parsed.data as Array<Record<string, unknown>> : [];

          if (dataType === "V1TAOrder") {
            for (const order of dataArray) {
              const cid = String(order.clientOrderId || order.handle || "");
              if (cid === params.clientOrderId || String(order.orderId || "") === params.clientOrderId) {
                matchedOrderId = String(order.orderId || "");
                const status = String(order.status || "").toUpperCase();
                if (status === "CLOSED" || status === "CANCELLED" || status === "REJECTED") {
                  clearTimeout(timeout);
                  ws.close();
                  const filled = status === "CLOSED" && String(order.statusReason || "") === "Executed";
                  resolve({
                    status: filled ? "filled" : "rejected",
                    orderId: matchedOrderId,
                    fillPrice: order.averageFillPrice ? String(order.averageFillPrice) : null,
                    fillQuantity: order.quantityFilled ? String(order.quantityFilled) : null,
                    fees: {
                      baseFee: order.baseFee ? String(order.baseFee) : "0",
                      quoteFee: order.quoteFee ? String(order.quoteFee) : "0"
                    },
                    orderStatus: status,
                    raw: order
                  });
                }
              }
            }
          }

          if (dataType === "V1TATrade" && matchedOrderId) {
            for (const trade of dataArray) {
              if (String(trade.orderId || "") === matchedOrderId) {
                clearTimeout(timeout);
                ws.close();
                resolve({
                  status: "filled",
                  orderId: matchedOrderId,
                  fillPrice: trade.price ? String(trade.price) : null,
                  fillQuantity: trade.quantity ? String(trade.quantity) : null,
                  fees: {
                    baseFee: trade.baseFee ? String(trade.baseFee) : "0",
                    quoteFee: trade.quoteFee ? String(trade.quoteFee) : "0"
                  },
                  orderStatus: "CLOSED",
                  raw: trade
                });
              }
            }
          }
        } catch {
          // Ignore malformed WS messages
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        resolve({
          status: "error",
          orderId: null,
          fillPrice: null,
          fillQuantity: null,
          fees: null,
          orderStatus: null,
          raw: { error: String(error?.message || error) }
        });
      });

      ws.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  async getAssetBalances(params?: {
    tradingAccountId?: string;
    timeoutMs?: number;
  }): Promise<BullishAssetBalance[]> {
    const snapshot = await this.waitForPrivateTopicSnapshot({
      topic: "assetAccounts",
      timeoutMs: params?.timeoutMs || 10_000,
      tradingAccountId: params?.tradingAccountId
    });
    const data = Array.isArray(snapshot.data) ? snapshot.data as Array<Record<string, unknown>> : [];
    return data.map((item) => ({
      assetSymbol: String(item.assetSymbol || ""),
      availableQuantity: String(item.availableQuantity || "0"),
      lockedQuantity: String(item.lockedQuantity || "0"),
      borrowedQuantity: String(item.borrowedQuantity || "0")
    }));
  }
}

export type BullishOrderFillResult = {
  status: "filled" | "rejected" | "timeout" | "error";
  orderId: string | null;
  fillPrice: string | null;
  fillQuantity: string | null;
  fees: { baseFee: string; quoteFee: string } | null;
  orderStatus: string | null;
  raw: unknown;
};

export type BullishAssetBalance = {
  assetSymbol: string;
  availableQuantity: string;
  lockedQuantity: string;
  borrowedQuantity: string;
};
