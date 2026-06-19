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

export type OkxFetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultFetcher: OkxFetcher = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(Number(process.env.OKX_EXEC_TIMEOUT_MS ?? "10000")) });
  return { status: res.status, json: () => res.json() };
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
    const res = await this.fetcher(this.base + path, { method, headers, body: body || undefined });
    const j = (await res.json()) as { code?: string; msg?: string; data?: T[] };
    return { ok: res.status === 200 && (j.code === "0" || j.code == null), code: String(j.code ?? ""), msg: String(j.msg ?? ""), data: (j.data ?? []) as T[] };
  }

  placeOrder(o: OkxLegOrder): Promise<OkxResponse<{ ordId?: string; clOrdId?: string; sCode?: string; sMsg?: string }>> {
    return this.request("POST", "/api/v5/trade/order", buildOrderBody(o));
  }

  getOrder(instId: string, ordId: string): Promise<OkxResponse<{ ordId?: string; state?: string; avgPx?: string; accFillSz?: string; sz?: string; fee?: string }>> {
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

  /**
   * Activate options trading for the ACCOUNT — the API equivalent of "click any symbol on the
   * options chain to activate trading" (clears error 51198). Idempotent; safe to call on startup.
   */
  activateOption(): Promise<OkxResponse<{ ts?: string }>> {
    return this.request("POST", "/api/v5/account/activate-option", "");
  }
}
