/**
 * Polymarket RFQ client — the CLOB v2 RFQ surface, reduced to what the hedge
 * executor needs.
 *
 * Wire facts (CLOB v2, L2 HMAC auth):
 *   POST   /rfq/request                 {assetIn, assetOut, amountIn, amountOut, userType}  -> {requestId}
 *   GET    /rfq/data/best-quote?requestId=...                                               -> the best open quote
 *   POST   /rfq/request/accept          {requestId, quoteId, owner, ...signed V1 order}
 *   DELETE /rfq/request                 {requestId}
 * L2 headers: POLY_ADDRESS, POLY_API_KEY, POLY_PASSPHRASE, POLY_TIMESTAMP (s),
 * POLY_SIGNATURE = base64url(HMAC-SHA256(base64url-decode(secret),
 *                  `${timestamp}${METHOD}${path}${body}`)).
 *
 * We BUY the opposing-outcome token: assetIn is that token, assetOut is USDC
 * ("0"). Amounts are 6-decimal integers; 1 share = 1_000_000, and because our
 * units are milli shares and milli dollars, unitsMilli x priceMilli is already
 * micro-USDC with no rounding.
 *
 * Quote view. A quote carries the MAKER's side, a price, sizeIn/sizeOut and a
 * matchType. For COMPLEMENTARY the requester trades the same token at the
 * quoted price; for MINT/MERGE the requester trades the complement at
 * 1 - price. Sizes are human decimal strings, parsed exactly to milli.
 *
 * Accepting needs an EIP-712-signed V1 order; the signer is injected. Without
 * one this client can request and read quotes (price discovery) but reports
 * canExecute() === false, and the executor fills at the book instead.
 */

import { createHmac } from "node:crypto";
import { clobBase, decimalToMilli } from "./polymarketPublic";
import type { HedgeIntent, RfqClient, RfqQuoteView } from "./hedgeExecutor";

export interface PolymarketRfqCredentials {
  apiKey: string;
  /** base64url-encoded HMAC secret as issued by the CLOB */
  secret: string;
  passphrase: string;
  /** the signing/funder address the API key belongs to */
  address: string;
  /** 0 EOA, 1 Polymarket proxy, 2 Gnosis safe */
  signatureType: 0 | 1 | 2;
}

export function polymarketRfqCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): PolymarketRfqCredentials | null {
  const apiKey = env.POLY_API_KEY?.trim();
  const secret = env.POLY_API_SECRET?.trim();
  const passphrase = env.POLY_API_PASSPHRASE?.trim();
  const address = env.POLY_ADDRESS?.trim();
  if (!apiKey || !secret || !passphrase || !address) return null;
  const st = Number(env.POLY_SIGNATURE_TYPE ?? 0);
  return { apiKey, secret, passphrase, address, signatureType: st === 1 || st === 2 ? st : 0 };
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function b64urlEncode(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** L2 HMAC signature over timestamp + method + path + body. */
export function signPolymarketL2(secret: string, timestampSec: number, method: string, path: string, body = ""): string {
  const h = createHmac("sha256", b64urlDecode(secret));
  h.update(`${timestampSec}${method.toUpperCase()}${path}${body}`);
  return b64urlEncode(h.digest());
}

/** A signed V1 CLOB order in the shape the RFQ accept call carries. */
export interface SignedV1Order {
  salt: number;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: number;
  nonce: string;
  feeRateBps: string;
  side: "BUY" | "SELL";
  signatureType: number;
  signature: string;
}

/** Builds and EIP-712-signs the order that accepts a quote. Wallet-backed; injected, never constructed here. */
export interface PolymarketOrderSigner {
  signBuy(args: { tokenId: string; priceMilli: number; unitsMilli: number; expirationSec: number }): Promise<SignedV1Order>;
}

export interface PolymarketRawQuote {
  quoteId?: string;
  id?: string;
  requestId?: string;
  price?: string | number;
  side?: "BUY" | "SELL";
  sizeIn?: string | number;
  sizeOut?: string | number;
  token?: string;
  complement?: string;
  matchType?: "COMPLEMENTARY" | "MINT" | "MERGE" | string;
  state?: string;
}

/**
 * The requester's view of a maker's quote when the request was a BUY:
 * the token we end up holding, what we pay per share, and how many.
 */
export function buyViewOfQuote(q: PolymarketRawQuote, intent: HedgeIntent): RfqQuoteView | null {
  const quoteId = q.quoteId ?? q.id;
  if (!quoteId) return null;
  const priceMilli = decimalToMilli(q.price, true);
  if (priceMilli <= 0 || priceMilli >= 1000) return null;
  const match = (q.matchType ?? "COMPLEMENTARY").toUpperCase();
  if (match === "COMPLEMENTARY") {
    if (q.token && q.token !== intent.instrument) return null;
    const units = decimalToMilli(q.sizeOut, false);
    return units > 0 ? { quoteId, priceMilli, unitsMilli: units, raw: q } : null;
  }
  if (match === "MINT" || match === "MERGE") {
    if (q.complement && q.complement !== intent.instrument) return null;
    const units = decimalToMilli(q.sizeIn, false);
    return units > 0 ? { quoteId, priceMilli: 1000 - priceMilli, unitsMilli: units, raw: q } : null;
  }
  return null;
}

export interface PolymarketRfqClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
  /** seconds a signed accept order stays valid; 0 = no expiration */
  orderTtlSec?: number;
}

export class PolymarketRfqClient implements RfqClient {
  readonly venue = "polymarket" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSec: () => number;
  private readonly orderTtlSec: number;

  constructor(
    private readonly creds: PolymarketRfqCredentials | null,
    private readonly signer: PolymarketOrderSigner | null = null,
    opts: PolymarketRfqClientOptions = {},
  ) {
    this.base = (opts.base ?? clobBase()).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.orderTtlSec = opts.orderTtlSec ?? 120;
  }

  canExecute(): boolean {
    return this.creds !== null && this.signer !== null;
  }

  /** Reading quotes needs credentials only; accepting needs the signer too. */
  canRequest(): boolean {
    return this.creds !== null;
  }

  async request(intent: HedgeIntent): Promise<{ rfqId: string }> {
    if (!this.creds) throw new Error("polymarket rfq: no credentials");
    const body = {
      assetIn: intent.instrument,
      assetOut: "0",
      amountIn: String(intent.unitsMilli * 1000),
      amountOut: String(intent.unitsMilli * intent.book.avgPriceMilli),
      userType: this.creds.signatureType,
    };
    const data = (await this.call("POST", "/rfq/request", body)) as { requestId?: string; request_id?: string; id?: string } | null;
    const rfqId = data?.requestId ?? data?.request_id ?? data?.id;
    if (!rfqId) throw new Error("polymarket rfq: create returned no id");
    return { rfqId };
  }

  async bestQuote(rfqId: string, intent: HedgeIntent): Promise<RfqQuoteView | null> {
    const data = (await this.call("GET", `/rfq/data/best-quote?requestId=${encodeURIComponent(rfqId)}`)) as
      | PolymarketRawQuote
      | { data?: PolymarketRawQuote | PolymarketRawQuote[] }
      | null;
    if (!data) return null;
    const inner = "data" in data && data.data !== undefined ? data.data : (data as PolymarketRawQuote);
    const raw = Array.isArray(inner) ? inner[0] : inner;
    if (!raw || (raw.state && raw.state !== "active")) return null;
    if (raw.requestId && raw.requestId !== rfqId) return null;
    return buyViewOfQuote(raw, intent);
  }

  async accept(rfqId: string, quote: RfqQuoteView, intent: HedgeIntent): Promise<{ orderId?: string }> {
    if (!this.creds) throw new Error("polymarket rfq: no credentials");
    if (!this.signer) throw new Error("polymarket rfq: no order signer");
    const order = await this.signer.signBuy({
      tokenId: intent.instrument,
      priceMilli: quote.priceMilli,
      unitsMilli: intent.unitsMilli,
      expirationSec: this.orderTtlSec > 0 ? this.nowSec() + this.orderTtlSec : 0,
    });
    const body = { requestId: rfqId, quoteId: quote.quoteId, owner: this.creds.apiKey, ...order };
    const data = (await this.call("POST", "/rfq/request/accept", body)) as { orderId?: string; orderID?: string; id?: string } | null;
    const orderId = data?.orderId ?? data?.orderID ?? data?.id;
    return orderId ? { orderId } : {};
  }

  async cancel(rfqId: string): Promise<void> {
    await this.call("DELETE", "/rfq/request", { requestId: rfqId });
  }

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    if (!this.creds) throw new Error("polymarket rfq: no credentials");
    const url = `${this.base}${endpoint}`;
    const path = new URL(url).pathname;
    const serialized = body === undefined ? "" : JSON.stringify(body);
    const ts = this.nowSec();
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "atticus-event-hedge",
      POLY_ADDRESS: this.creds.address,
      POLY_API_KEY: this.creds.apiKey,
      POLY_PASSPHRASE: this.creds.passphrase,
      POLY_TIMESTAMP: String(ts),
      POLY_SIGNATURE: signPolymarketL2(this.creds.secret, ts, method, path, serialized),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000)) };
    if (serialized) {
      headers["content-type"] = "application/json";
      init.body = serialized;
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`polymarket rfq: HTTP ${res.status} ${method} ${endpoint}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
