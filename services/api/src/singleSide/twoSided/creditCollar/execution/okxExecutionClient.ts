/**
 * OKX execution client — Phase B (DEMO-FIRST, default-off). Authenticated OKX v5 REST for placing/
 * querying/cancelling the collar HEDGE legs (buy put, sell call) so Atticus can validate real fills +
 * short-leg margin. SAFETY: defaults to OKX DEMO (x-simulated-trading: 1). Real-money mode requires an
 * explicit `mode: "live"` AND is gated again at the executor/CLI. Pure signing + payload builders are
 * unit-tested; the network layer is thin.
 *
 * Keys come from env (OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE) — NEVER hardcode.
 */

import { createHmac } from "node:crypto";

export type OkxMode = "demo" | "live";

export type OkxCredentials = {
  apiKey: string;
  secret: string;
  passphrase: string;
  mode: OkxMode;
  baseUrl?: string;
};

/** OKX prehash = timestamp + METHOD + requestPath(+query) + body; signature = base64(HMAC-SHA256). Pure. */
export const signOkx = (timestamp: string, method: string, requestPath: string, body: string, secret: string): string =>
  createHmac("sha256", secret).update(timestamp + method.toUpperCase() + requestPath + body).digest("base64");

export const buildOkxHeaders = (
  creds: OkxCredentials,
  timestamp: string,
  method: string,
  requestPath: string,
  body: string
): Record<string, string> => {
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": creds.apiKey,
    "OK-ACCESS-SIGN": signOkx(timestamp, method, requestPath, body, creds.secret),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": creds.passphrase,
    "Content-Type": "application/json"
  };
  if (creds.mode === "demo") headers["x-simulated-trading"] = "1"; // OKX demo/simulated trading
  return headers;
};

/** Order payload for an option leg. `tdMode` cross for portfolio/cross margin; sz in contracts. Pure. */
export type OkxLegOrder = {
  instId: string;
  side: "buy" | "sell";
  ordType: "limit" | "market";
  sz: string;
  px?: string;
  tdMode?: "cross" | "isolated" | "cash";
  clOrdId?: string;
  reduceOnly?: boolean;
};

export const buildOrderBody = (o: OkxLegOrder): string =>
  JSON.stringify({
    instId: o.instId,
    tdMode: o.tdMode ?? "cross",
    side: o.side,
    ordType: o.ordType,
    sz: o.sz,
    ...(o.px != null ? { px: o.px } : {}),
    ...(o.clOrdId != null ? { clOrdId: o.clOrdId } : {}),
    ...(o.reduceOnly != null ? { reduceOnly: o.reduceOnly } : {})
  });

export type OkxRawResponse = { status: number; json: () => Promise<unknown>; text?: () => Promise<string> };
export type OkxFetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<OkxRawResponse>;

const defaultFetcher: OkxFetcher = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(Number(process.env.OKX_EXEC_TIMEOUT_MS ?? "10000")) });
  // Read as text once so a non-JSON body (HTML error page / WAF / 404) doesn't throw inside json().
  const raw = await res.text();
  return { status: res.status, text: async () => raw, json: async () => JSON.parse(raw) };
};

export type OkxResponse<T = unknown> = { ok: boolean; code: string; msg: string; data: T[] };

export class OkxExecutionClient {
  private readonly base: string;
  private readonly creds: OkxCredentials;
  constructor(creds: OkxCredentials, private readonly fetcher: OkxFetcher = defaultFetcher) {
    // Trim defensively — a trailing newline/space in an env value is a common cause of
    // "OK-ACCESS-PASSPHRASE incorrect" / signature failures.
    this.creds = { ...creds, apiKey: creds.apiKey.trim(), secret: creds.secret.trim(), passphrase: creds.passphrase.trim() };
    this.base = this.creds.baseUrl ?? process.env.OKX_REST_BASE ?? "https://www.okx.com";
  }

  /** Auth preflight — a private GET to isolate credential problems from order logic. */
  async authCheck(): Promise<{ ok: boolean; message: string }> {
    const r = await this.getBalance();
    return { ok: r.ok, message: r.ok ? "auth ok" : `${r.code}: ${r.msg}` };
  }

  get mode(): OkxMode {
    return this.creds.mode;
  }

  private async request<T = unknown>(method: "GET" | "POST", path: string, body = ""): Promise<OkxResponse<T>> {
    const timestamp = new Date().toISOString();
    const headers = buildOkxHeaders(this.creds, timestamp, method, path, body);
    let res: OkxRawResponse;
    try {
      res = await this.fetcher(this.base + path, { method, headers, body: body || undefined });
    } catch (e) {
      // Network/DNS/timeout — return a retryable sentinel instead of throwing (don't crash callers).
      return { ok: false, code: "ERR", msg: `network error: ${e instanceof Error ? e.message : String(e)}`, data: [] as T[] };
    }
    let j: { code?: string; msg?: string; data?: T[] };
    try {
      // Prefer the raw text (read once) so a non-JSON body fails gracefully with a useful snippet.
      const raw = res.text ? await res.text() : null;
      j = (raw != null ? (raw.trim() === "" ? {} : JSON.parse(raw)) : await res.json()) as { code?: string; msg?: string; data?: T[] };
    } catch {
      let snippet = "";
      try {
        snippet = ((res.text ? await res.text() : "") ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      } catch {
        /* ignore */
      }
      return { ok: false, code: `HTTP_${res.status}`, msg: `non-JSON response (status ${res.status})${snippet ? `: ${snippet}` : ""}`, data: [] as T[] };
    }
    return { ok: res.status === 200 && (j.code === "0" || j.code == null), code: String(j.code ?? ""), msg: String(j.msg ?? ""), data: (j.data ?? []) as T[] };
  }

  placeOrder(o: OkxLegOrder): Promise<OkxResponse<{ ordId?: string; clOrdId?: string; sCode?: string; sMsg?: string }>> {
    return this.request("POST", "/api/v5/trade/order", buildOrderBody(o));
  }

  getOrder(instId: string, ordId: string): Promise<OkxResponse<{ ordId?: string; state?: string; avgPx?: string; accFillSz?: string; sz?: string; fee?: string; feeCcy?: string; px?: string }>> {
    return this.request("GET", `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`);
  }

  cancelOrder(instId: string, ordId: string): Promise<OkxResponse<{ ordId?: string; sCode?: string }>> {
    return this.request("POST", "/api/v5/trade/cancel-order", JSON.stringify({ instId, ordId }));
  }

  getBalance(): Promise<OkxResponse<{ totalEq?: string; details?: unknown[] }>> {
    return this.request("GET", "/api/v5/account/balance");
  }

  /**
   * Instrument universe for the ACTIVE environment. In demo mode this carries x-simulated-trading
   * so we only ever see instIds that actually exist in demo (live + demo chains differ). Public
   * endpoint, but routed through the signed/header path so the mode header is applied consistently.
   */
  getInstruments(instType = "OPTION", uly = "BTC-USD"): Promise<OkxResponse<{ instId?: string; state?: string }>> {
    return this.request("GET", `/api/v5/public/instruments?instType=${instType}&uly=${encodeURIComponent(uly)}`);
  }

  /** Top-of-book for an instId in the ACTIVE environment (demo header applied in demo mode). */
  getBookTop(instId: string): Promise<OkxResponse<{ bids?: string[][]; asks?: string[][] }>> {
    return this.request("GET", `/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=1`);
  }

  /** Account positions (to read option position + maintenance margin after a fill). */
  getPositions(instType = "OPTION"): Promise<OkxResponse<{ instId?: string; pos?: string; mmr?: string; imr?: string; mgnRatio?: string }>> {
    return this.request("GET", `/api/v5/account/positions?instType=${instType}`);
  }

  /** Account config — acctLv (2 single-ccy, 3 multi-ccy, 4 portfolio), posMode, perms. Read-only. */
  getAccountConfig(): Promise<OkxResponse<{ acctLv?: string; posMode?: string; mgnIsoMode?: string; ctIsoMode?: string; perm?: string; opAuth?: string }>> {
    return this.request("GET", "/api/v5/account/config");
  }

  /** Your ACTUAL options maker/taker fee tier (VIP-adjusted). Read-only. Negative = rebate. */
  getTradeFee(instType = "OPTION", uly = "BTC-USD"): Promise<OkxResponse<{ instType?: string; maker?: string; taker?: string; makerU?: string; takerU?: string; level?: string }>> {
    return this.request("GET", `/api/v5/account/trade-fee?instType=${instType}&uly=${encodeURIComponent(uly)}`);
  }

  /** Public option chain (instId/strike/expiry/type/contract-value/ticks) for the ACTIVE environment. Read-only.
   *  NOTE: real contract size = ctVal × ctMult (OKX lists ctVal=1, ctMult=0.01 for BTC-USD options). */
  getOptionChain(uly = "BTC-USD"): Promise<OkxResponse<{ instId?: string; optType?: "C" | "P"; stk?: string; expTime?: string; ctVal?: string; ctMult?: string; tickSz?: string; lotSz?: string; minSz?: string; state?: string }>> {
    return this.request("GET", `/api/v5/public/instruments?instType=OPTION&uly=${encodeURIComponent(uly)}`);
  }

  /**
   * Public delivery/exercise history — OKX's ACTUAL settlement price per expired instrument
   * (type: exercised / counterparty_exercised / expired_otm). Read-only; used for settlement
   * reconciliation of okx_live positions against the venue's own fixing.
   */
  getDeliveryExerciseHistory(instType = "OPTION", uly = "BTC-USD"): Promise<OkxResponse<{ ts?: string; details?: Array<{ insId?: string; px?: string; type?: string }> }>> {
    return this.request("GET", `/api/v5/public/delivery-exercise-history?instType=${instType}&uly=${encodeURIComponent(uly)}`);
  }

  /**
   * Account bills (7-day window) — the REAL cash flows: option premium payments, fees, and
   * delivery/exercise settlement amounts (balance changes in BTC for coin-margined options).
   * Read-only; drives per-position settlement reconciliation to the cent.
   */
  getBills(instType = "OPTION", limit = 100): Promise<OkxResponse<{ billId?: string; instId?: string; type?: string; subType?: string; balChg?: string; px?: string; sz?: string; ccy?: string; ts?: string }>> {
    return this.request("GET", `/api/v5/account/bills?instType=${instType}&limit=${limit}`);
  }

  /** Public index price (e.g. BTC-USD) for picking strikes. Read-only. */
  getIndexPrice(instId = "BTC-USD"): Promise<OkxResponse<{ idxPx?: string }>> {
    return this.request("GET", `/api/v5/market/index-tickers?instId=${encodeURIComponent(instId)}`);
  }

  /** Public option mark price for an instId (used as the simulated entry price for Position Builder). Read-only. */
  getMarkPrice(instId: string): Promise<OkxResponse<{ markPx?: string }>> {
    return this.request("GET", `/api/v5/public/mark-price?instType=OPTION&instId=${encodeURIComponent(instId)}`);
  }

  /**
   * Portfolio-margin SIMULATOR (Position Builder). Read-only: computes margin for a hypothetical book —
   * places NO orders, moves NO capital. `simPos` = [{ instId, pos }] with pos = signed contract count
   * (positive long, negative short). inclRealPosAndEq=false isolates the simulated legs only.
   */
  positionBuilder(
    simPos: Array<{ instId: string; pos: string; avgPx: string }>,
    inclRealPosAndEq = false
  ): Promise<OkxResponse<Record<string, unknown>>> {
    return this.request("POST", "/api/v5/account/position-builder", JSON.stringify({ inclRealPosAndEq, simPos }));
  }

  // ── Block trading / RFQ (the institutional lane confirmed with the OKX BD) ──────────────────

  /** Makers available to quote this account's RFQs. Access requires the $10k block-trading tier. */
  getRfqCounterparties(): Promise<OkxResponse<{ traderCode?: string; traderName?: string }>> {
    return this.request("GET", "/api/v5/rfq/counterparties");
  }

  /** Create a multi-leg RFQ (the whole collar as ONE package — atomic by construction). */
  createRfq(body: { counterparties: string[]; anonymous: boolean; clRfqId?: string; allowPartialExecution: false; legs: Array<{ instId: string; sz: string; side: "buy" | "sell" }> }): Promise<OkxResponse<{ rfqId?: string; state?: string }>> {
    return this.request("POST", "/api/v5/rfq/create-rfq", JSON.stringify(body));
  }

  /** Maker quotes for an RFQ (auto-quoting LPs respond in seconds at pilot size, per the BD). */
  getRfqQuotes(rfqId: string): Promise<OkxResponse<{ quoteId?: string; rfqId?: string; state?: string; validUntil?: string; legs?: Array<{ instId?: string; px?: string; sz?: string; side?: string; fee?: string }> }>> {
    return this.request("GET", `/api/v5/rfq/quotes?rfqId=${encodeURIComponent(rfqId)}`);
  }

  /** Execute a maker quote — all legs fill as one block trade or none do. */
  executeRfqQuote(rfqId: string, quoteId: string): Promise<OkxResponse<{ blockTdId?: string; legs?: Array<{ instId?: string; px?: string; sz?: string; fee?: string }> }>> {
    return this.request("POST", "/api/v5/rfq/execute-quote", JSON.stringify({ rfqId, quoteId }));
  }

  /** Cancel an open RFQ (no acceptable quote / abandoning the window). */
  cancelRfq(rfqId: string): Promise<OkxResponse<{ rfqId?: string }>> {
    return this.request("POST", "/api/v5/rfq/cancel-rfq", JSON.stringify({ rfqId }));
  }

  /**
   * Activate options trading for the ACCOUNT — the API equivalent of "click any symbol on the
   * options chain to activate trading" (clears error 51198). Idempotent; safe to call on startup.
   */
  activateOption(): Promise<OkxResponse<{ ts?: string }>> {
    // Non-empty JSON body — OKX returns an HTML error page (not JSON) for empty-body POSTs.
    return this.request("POST", "/api/v5/account/activate-option", "{}");
  }

  /**
   * Activate options with retry — this endpoint is prone to transient gateway timeouts (HTTP 504)
   * and rate limits. Retries on 5xx / rate-limit / network errors with linear backoff. Idempotent.
   * 51199 (already activated) is treated as success.
   */
  async activateOptionWithRetry(opts: { tries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<OkxResponse<{ ts?: string }>> {
    const tries = opts.tries ?? 4;
    const baseDelayMs = opts.baseDelayMs ?? 1500;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last: OkxResponse<{ ts?: string }> = { ok: false, code: "NONE", msg: "no_attempt", data: [] };
    for (let i = 0; i < tries; i++) {
      const r = await this.activateOption();
      if (r.ok || r.code === "51199" || r.code === "50050") return r; // 51199/50050 = already activated
      last = r;
      const retryable = /^HTTP_5\d\d$/.test(r.code) || r.code === "50011" /* rate limit */ || r.code === "50013" /* busy */ || r.code === "ERR";
      if (!retryable) return r;
      if (i < tries - 1) await sleep(baseDelayMs * (i + 1));
    }
    return last;
  }

  /**
   * Switch account mode. acctLv: "2" single-ccy margin, "3" multi-ccy margin, "4" portfolio margin.
   * Options require acctLv ≥ 3; a collar's long leg needs portfolio margin (4) for offset.
   */
  setAccountLevel(acctLv: "2" | "3" | "4"): Promise<OkxResponse<{ acctLv?: string }>> {
    return this.request("POST", "/api/v5/account/set-account-level", JSON.stringify({ acctLv }));
  }
}
