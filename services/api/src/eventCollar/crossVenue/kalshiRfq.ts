/**
 * Kalshi RFQ client — the "communications" endpoints, reduced to what the
 * hedge executor needs: ask makers for one price on the whole size, read the
 * best answer, take it, or withdraw.
 *
 * Wire facts (Kalshi Trade API v2, communications tag):
 *   POST   /communications/rfqs                                   {market_ticker, contracts_fp, rest_remainder}
 *   GET    /communications/quotes?rfq_id=...&status=open          -> quotes[] with yes_bid_dollars / no_bid_dollars
 *   PUT    /communications/rfqs/{rfq_id}/quotes/{quote_id}/accept {accepted_side}  (quoter must then confirm)
 *   DELETE /communications/rfqs/{rfq_id}
 * Auth: KALSHI-ACCESS-KEY / -SIGNATURE / -TIMESTAMP; the signature is RSA-PSS
 * SHA-256 over `${timestampMs}${METHOD}${path}` (path without query string).
 *
 * Side mapping. A quote is two-sided: the maker bids for YES at yes_bid and for
 * NO at no_bid. We buy NO, so the maker's YES bid is the leg we hit and our
 * price is $1 - yes_bid; the size that leg offers is yes_contracts_fp. The
 * accept call names the side the RFQ creator takes, so we send "no".
 * VERIFY ON KALSHI'S DEMO API BEFORE LIVE USE: the two sides are symmetric on
 * the wire and this mapping is the one place a reversal would hide.
 *
 * Money: dollars strings parsed EXACTLY to milli (1000 = $1), truncating the
 * maker's bid (which raises our No price); contract counts to milli, rounded
 * UP to the venue's 0.01 granularity so the hedge is never short.
 */

import { constants, createSign } from "node:crypto";
import { kalshiBase } from "../kalshiPublic";
import { decimalToMilli } from "./polymarketPublic";
import type { HedgeIntent, RfqClient, RfqQuoteView } from "./hedgeExecutor";

/** The side the RFQ creator takes when accepting: we are buying No. */
export const KALSHI_REQUESTER_SIDE = "no" as const;

export interface KalshiRfqCredentials {
  apiKeyId: string;
  /** PEM RSA private key; "\n" escapes accepted (env-friendly) */
  privateKeyPem: string;
}

export function kalshiRfqCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): KalshiRfqCredentials | null {
  const apiKeyId = env.KALSHI_API_KEY_ID?.trim();
  const pem = env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n").trim();
  if (!apiKeyId || !pem) return null;
  return { apiKeyId, privateKeyPem: pem };
}

/** RSA-PSS SHA-256 over timestamp + method + path, base64 — Kalshi's request signature. */
export function signKalshiRequest(creds: KalshiRfqCredentials, timestampMs: number, method: string, path: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestampMs}${method.toUpperCase()}${path}`);
  signer.end();
  return signer
    .sign({
      key: creds.privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

/** The three auth headers Kalshi reads, for one request. The key id is the only credential that travels. */
export function kalshiAuthHeaders(creds: KalshiRfqCredentials, timestampMs: number, method: string, path: string): Record<string, string> {
  return {
    "KALSHI-ACCESS-KEY": creds.apiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
    "KALSHI-ACCESS-SIGNATURE": signKalshiRequest(creds, timestampMs, method, path),
  };
}

/** 1000 = 1 contract -> fixed-point "N.NN", rounded UP to 0.01 (never under-hedged). */
export function contractsFp(unitsMilli: number): string {
  const hundredths = Math.ceil(unitsMilli / 10);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** fixed-point "N.NN" contracts -> milli, exact. */
export function fpToMilli(fp: string | undefined): number {
  const v = decimalToMilli(fp, false);
  return v < 0 ? 0 : v;
}

export interface KalshiRawQuote {
  id: string;
  rfq_id: string;
  status: string;
  yes_bid_dollars?: string;
  no_bid_dollars?: string;
  contracts_fp?: string;
  yes_contracts_fp?: string;
  no_contracts_fp?: string;
  rfq_creator_order_id?: string;
}

/** The maker's YES bid is the leg we hit when buying NO: our price is $1 - yes_bid, size is that leg's. */
export function noViewOfQuote(q: KalshiRawQuote): RfqQuoteView | null {
  const yesBidMilli = decimalToMilli(q.yes_bid_dollars, false);
  if (yesBidMilli <= 0 || yesBidMilli >= 1000) return null;
  const unitsMilli = fpToMilli(q.yes_contracts_fp ?? q.contracts_fp);
  if (unitsMilli <= 0) return null;
  return { quoteId: q.id, priceMilli: 1000 - yesBidMilli, unitsMilli, raw: q };
}

export interface KalshiRfqClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  /** how long to wait for the maker to confirm after we accept */
  confirmWaitMs?: number;
  confirmPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class KalshiRfqClient implements RfqClient {
  readonly venue = "kalshi" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly confirmWaitMs: number;
  private readonly confirmPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly creds: KalshiRfqCredentials | null,
    opts: KalshiRfqClientOptions = {},
  ) {
    this.base = (opts.base ?? process.env.KALSHI_TRADE_BASE ?? kalshiBase()).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.confirmWaitMs = opts.confirmWaitMs ?? 3_000;
    this.confirmPollMs = opts.confirmPollMs ?? 300;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  canExecute(): boolean {
    return this.creds !== null;
  }

  async request(intent: HedgeIntent): Promise<{ rfqId: string }> {
    const body = { market_ticker: intent.instrument, contracts_fp: contractsFp(intent.unitsMilli), rest_remainder: false };
    const data = (await this.call("POST", "/communications/rfqs", body)) as { rfq_id?: string; id?: string } | null;
    const rfqId = data?.rfq_id ?? data?.id;
    if (!rfqId) throw new Error("kalshi rfq: create returned no id");
    return { rfqId };
  }

  async bestQuote(rfqId: string, intent: HedgeIntent): Promise<RfqQuoteView | null> {
    const data = (await this.call("GET", `/communications/quotes?rfq_id=${encodeURIComponent(rfqId)}&status=open`)) as {
      quotes?: KalshiRawQuote[];
    } | null;
    let best: RfqQuoteView | null = null;
    for (const raw of data?.quotes ?? []) {
      if (raw.rfq_id && raw.rfq_id !== rfqId) continue;
      const v = noViewOfQuote(raw);
      if (!v) continue;
      // cheapest that covers the size wins; among partials, keep the largest so the reason is honest
      const covers = v.unitsMilli >= intent.unitsMilli;
      const bestCovers = best ? best.unitsMilli >= intent.unitsMilli : false;
      if (!best || (covers && !bestCovers) || (covers === bestCovers && (covers ? v.priceMilli < best.priceMilli : v.unitsMilli > best.unitsMilli))) {
        best = v;
      }
    }
    return best;
  }

  async accept(rfqId: string, quote: RfqQuoteView): Promise<{ orderId?: string }> {
    await this.call(
      "PUT",
      `/communications/rfqs/${encodeURIComponent(rfqId)}/quotes/${encodeURIComponent(quote.quoteId)}/accept`,
      { accepted_side: KALSHI_REQUESTER_SIDE },
    );
    // The maker confirms; execution follows. Wait for the quote to leave "accepted".
    const deadline = this.now() + this.confirmWaitMs;
    for (;;) {
      const data = (await this.call("GET", `/communications/quotes?rfq_id=${encodeURIComponent(rfqId)}`)) as {
        quotes?: KalshiRawQuote[];
      } | null;
      const q = (data?.quotes ?? []).find((x) => x.id === quote.quoteId);
      if (q?.status === "executed" || q?.status === "confirmed") {
        return q.rfq_creator_order_id ? { orderId: q.rfq_creator_order_id } : {};
      }
      if (q?.status === "cancelled") throw new Error(`kalshi rfq: quote ${quote.quoteId} cancelled before confirmation`);
      if (this.now() >= deadline) throw new Error(`kalshi rfq: maker did not confirm quote ${quote.quoteId} within ${this.confirmWaitMs}ms`);
      await this.sleep(this.confirmPollMs);
    }
  }

  async cancel(rfqId: string): Promise<void> {
    await this.call("DELETE", `/communications/rfqs/${encodeURIComponent(rfqId)}`);
  }

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    if (!this.creds) throw new Error("kalshi rfq: no credentials");
    const url = `${this.base}${endpoint}`;
    const path = new URL(url).pathname;
    const ts = this.now();
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "atticus-event-hedge",
      ...kalshiAuthHeaders(this.creds, ts, method, path),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000)) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`kalshi rfq: HTTP ${res.status} ${method} ${endpoint}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
