/**
 * FalconX Options RFQ V2 client — the signed-request layer for LIVE execution. Extends what the
 * quote-only probe/RFQ tools validated (tokens · instruments · quote · close_rfq) with the one call
 * they deliberately left out: EXECUTE a firm quote within its validity window.
 *
 * Conventions (validated by the probe):
 *   - Auth: HMAC-SHA256 over `${ts}${METHOD}${path}${body}` with the BASE64-DECODED secret,
 *     headers FX-ACCESS-KEY / -SIGN / -TIMESTAMP / -PASSPHRASE (Coinbase-style).
 *   - Symbols: BTC-USDC-29AUG25-120000.0-C. Quantity is in BTC (no contract lots).
 *   - A collar is quoted as ONE structure (both legs, one net price) ⟹ execution is atomic at the
 *     venue: both legs or neither, by construction.
 *   - Structure prices are USDC PER UNIT (per 1 BTC): NEGATIVE ask = net premium credited to us.
 *   - Quotes are firm only for seconds (t_expiry − t_quote): quote → validate → execute immediately.
 *
 * Keys from env (FALCONX_API_KEY / FALCONX_SECRET / FALCONX_PASSPHRASE) — NEVER hardcode. There is no
 * demo environment: every EXECUTE is real money, so the executor gates it behind LIVE_ENABLED +
 * FALCONX_LIVE_CONFIRM. Deps-injected fetcher ⟹ unit-testable without the venue.
 */

import { createHmac, randomUUID } from "node:crypto";

export type FalconxCredentials = { apiKey: string; secret: string; passphrase: string; baseUrl?: string };

/** FalconX prehash = ts + METHOD + path + body; HMAC-SHA256 with the base64-decoded secret. Pure. */
export const signFalconx = (ts: string, method: string, path: string, body: string, secretB64: string): string =>
  createHmac("sha256", Buffer.from(secretB64, "base64")).update(`${ts}${method.toUpperCase()}${path}${body}`).digest("base64");

export type FxRawResponse = { status: number; text: () => Promise<string> };
export type FxFetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FxRawResponse>;

const defaultFetcher: FxFetcher = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(Number(process.env.FALCONX_TIMEOUT_MS ?? "15000")) });
  const raw = await res.text();
  return { status: res.status, text: async () => raw };
};

export type FxResult<T = Record<string, unknown>> = { ok: boolean; status: number; json: T; errorMessage: string | null };

export type FxInstrument = { strike: string; epoch_time_expiry: string; type: "call" | "put"; symbol: string };
export type FxStructureLeg = { side: "buy" | "sell"; symbol: string; weight: number };
export type FxPrice = { value?: string | number; quantity_currency?: string } | string | number | null | undefined;

export type FxQuoteResponse = {
  status?: string;
  rfq_id?: string;
  fx_quote_id?: string;
  bid_price?: FxPrice;
  ask_price?: FxPrice;
  mark_price?: FxPrice;
  incremental_im_for_trade?: { value?: string | number };
  t_quote?: string | number;
  t_expiry?: string | number;
  rfq_expiry?: string | number;
  legs?: Array<{ side?: string; symbol?: string; bid_price?: FxPrice; ask_price?: FxPrice; mark_price?: FxPrice }>;
  error?: { code?: string | number; message?: string };
};

export type FxExecuteResponse = {
  status?: string;
  fx_quote_id?: string;
  trade_id?: string;
  fx_trade_id?: string;
  error?: { code?: string | number; message?: string };
};

/** Numeric value out of FalconX's polymorphic price shapes ({value}, string, number). Pure. */
export const fxPriceValue = (p: FxPrice): number | null => {
  if (p == null) return null;
  const v = typeof p === "object" ? p.value : p;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class FalconxClient {
  private readonly base: string;
  constructor(private readonly creds: FalconxCredentials, private readonly fetcher: FxFetcher = defaultFetcher) {
    this.base = creds.baseUrl ?? process.env.FALCONX_BASE_URL ?? "https://api.falconx.io";
  }

  private async request<T>(path: string, method: "GET" | "POST", body: Record<string, unknown> | null): Promise<FxResult<T>> {
    const ts = String(Date.now() / 1000);
    const payload = body ? JSON.stringify(body) : "";
    const headers = {
      "Content-Type": "application/json",
      "FX-ACCESS-KEY": this.creds.apiKey.trim(),
      "FX-ACCESS-SIGN": signFalconx(ts, method, path, payload, this.creds.secret.trim()),
      "FX-ACCESS-TIMESTAMP": ts,
      "FX-ACCESS-PASSPHRASE": this.creds.passphrase.trim()
    };
    let raw: string;
    let status: number;
    try {
      const res = await this.fetcher(this.base + path, { method, headers, body: body ? payload : undefined });
      status = res.status;
      raw = await res.text();
    } catch (e) {
      return { ok: false, status: 0, json: {} as T, errorMessage: `network error: ${e instanceof Error ? e.message : String(e)}` };
    }
    let json: T;
    try {
      json = (raw.trim() === "" ? {} : JSON.parse(raw)) as T;
    } catch {
      return { ok: false, status, json: {} as T, errorMessage: `non-JSON response (HTTP ${status}): ${raw.replace(/\s+/g, " ").slice(0, 160)}` };
    }
    const err = (json as { error?: { code?: string | number; message?: string } }).error;
    const ok = status >= 200 && status < 300 && err == null;
    return { ok, status, json, errorMessage: ok ? null : err?.message != null ? `${err.code ?? ""} ${err.message}`.trim() : `HTTP ${status}` };
  }

  /** Auth check — tradable token pairs. Read-only. */
  getTokens(): Promise<FxResult<{ token_pairs?: unknown[] }>> {
    return this.request("/v3/derivatives/option/tokens", "GET", null);
  }

  /** The ACTUAL tradable symbol grid (strikes × expiries). Read-only. */
  getInstruments(base = "BTC", quote = "USDC"): Promise<FxResult<{ instruments?: FxInstrument[] }>> {
    return this.request("/v3/derivatives/option/instruments", "POST", { token_pair: { base_token: base, quote_token: quote } });
  }

  /**
   * Request a firm quote for a structure (a collar = both legs, ONE net price). `side` is the
   * direction of the structure AS DEFINED by its legs: "buy" ⟹ transact the legs exactly as listed
   * (executable ask), "two_way" ⟹ bid+ask (probe/monitoring). Opens an RFQ — close or execute it.
   */
  requestQuote(structure: FxStructureLeg[], quantityBtc: number, side: "buy" | "sell" | "two_way", clientOrderId = randomUUID(), base = "BTC", quote = "USDC"): Promise<FxResult<FxQuoteResponse>> {
    return this.request("/v3/derivatives/option/quote", "POST", {
      token_pair: { base_token: base, quote_token: quote },
      quantity: quantityBtc,
      side,
      structure,
      client_order_id: clientOrderId
    });
  }

  /**
   * EXECUTE a firm quote within its validity window — REAL MONEY. Gated by the caller.
   * Path mirrors the option RFQ family (/quote → /quote/execute); overridable via
   * FALCONX_EXECUTE_PATH if the desk points us at a different route during onboarding.
   */
  executeQuote(fxQuoteId: string, side: "buy" | "sell", clientOrderUuid = randomUUID()): Promise<FxResult<FxExecuteResponse>> {
    const path = process.env.FALCONX_EXECUTE_PATH ?? "/v3/derivatives/option/quote/execute";
    return this.request(path, "POST", { fx_quote_id: fxQuoteId, side, client_order_uuid: clientOrderUuid });
  }

  /** Close an open RFQ (there is a max-open-RFQ limit; leave nothing dangling). */
  closeRfq(rfqId: string): Promise<FxResult<Record<string, unknown>>> {
    return this.request("/v3/derivatives/option/quote/close_rfq", "POST", { rfq_id: rfqId });
  }

  // ── Reconciliation / readiness (read-only) ──────────────────────────────────

  /** All derivative option trades (status open/terminated/settled; Deribit 8am-UTC fixing). */
  getDerivatives(params: { trade_status?: string; product_type?: string } = {}): Promise<FxResult<FxDerivativeTrade[] | { error?: unknown }>> {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString();
    return this.request(`/v1/derivatives${qs ? `?${qs}` : ""}`, "GET", null);
  }

  /** Transactions for one trade — `expired`/`exercised` rows carry the settlement_price at the fixing. */
  getDerivativeTransactions(tradeId: string): Promise<FxResult<FxDerivativeTransaction[] | { error?: unknown }>> {
    return this.request(`/v1/derivatives/${encodeURIComponent(tradeId)}/transactions`, "GET", null);
  }

  /** Actual cash flows (Premium / Settlement / Termination …), signed from FALCONX's perspective. */
  getCashFlows(params: { start_settlement_date?: string; end_settlement_date?: string; status?: string } = {}): Promise<FxResult<FxCashFlow[] | { error?: unknown }>> {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString();
    return this.request(`/v1/derivatives/cash_flows${qs ? `?${qs}` : ""}`, "GET", null);
  }

  /** Open option positions (post-fill / flatness verification). */
  getOptionPositions(): Promise<FxResult<FxOptionPosition[] | { error?: unknown }>> {
    return this.request("/v1/derivatives/option/positions", "GET", null);
  }

  /** Total balances across platforms (funding check — the $5k deposit gate). */
  getTotalBalances(): Promise<FxResult<Array<{ token?: string; total_balance?: string | number }> | { error?: unknown }>> {
    return this.request("/v1/balances/total", "GET", null);
  }

  /** Current derivatives margin balances per token. */
  getMargins(): Promise<FxResult<Array<{ token?: string; initial_margin_held?: number; total_margin?: number }> | { error?: unknown }>> {
    return this.request("/v1/derivatives/margins", "GET", null);
  }
}

export type FxDerivativeTrade = {
  contract_name?: string;
  fixing_source?: string;
  maturity_date?: string;
  option_type?: string;
  position_id?: string;
  product?: string;
  quantity?: number;
  side?: string;
  status?: string;
  strike_price?: { value?: number | string };
  trade_date?: string;
  trade_id?: string;
  premium?: { value?: number | string; token?: string };
};

export type FxDerivativeTransaction = {
  premium_per_unit?: number | string;
  side?: string;
  signed_quantity?: number | string;
  trade_effect?: string;
  transaction_date?: string;
  transaction_id?: string;
  transaction_type?: string; // opened | partially_terminated | expired | exercised | terminated | settled
  settlement_price?: number | string | null;
};

export type FxCashFlow = {
  amount?: number | string;   // positive = FalconX RECEIVES (we pay); negative = FalconX pays (we receive)
  currency?: string;
  payment_type?: string;      // Premium | Settlement | Termination | …
  settlement_date?: string;
  status?: string;
  trade_id?: string | null;
  transaction_id?: string | null;
};

export type FxOptionPosition = {
  contract_name?: string;
  instrument_type?: string;
  maturity_date_time?: string;
  strike_price?: number | string;
  signed_quantity?: number | string;
  position_id?: string;
};
