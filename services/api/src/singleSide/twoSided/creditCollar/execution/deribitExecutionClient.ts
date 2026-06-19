/**
 * Deribit execution client — TESTNET-FIRST, default-off. Authenticated Deribit API v2 (client_
 * credentials OAuth2) for placing/querying/cancelling the collar HEDGE legs (buy put, sell call) on
 * test.deribit.com — no KYC, no activation gating, datacenter-IP friendly (unlike OKX). Exposes an
 * `asExecClient()` adapter so the venue-agnostic executeCollarHedge orchestration (atomicity, orphan
 * compensation, slippage, margin) is reused unchanged.
 *
 * SAFETY: defaults to TESTNET (test.deribit.com). Real-money requires an explicit `mode: "live"` AND
 * is gated again at the CLI. Keys come from env (DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET).
 *
 * Deribit conventions: option prices + margins are in BTC; option `amount` is in contracts (1 = 1 BTC).
 */

import type { OkxLegOrder } from "./okxExecutionClient";
import type { ExecClient } from "./okxCollarExecutor";

export type DeribitMode = "testnet" | "live";

export type DeribitCredentials = {
  clientId: string;
  clientSecret: string;
  mode: DeribitMode;
  baseUrl?: string;
};

export type DeribitFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const defaultFetcher: DeribitFetcher = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, signal: AbortSignal.timeout(Number(process.env.DERIBIT_EXEC_TIMEOUT_MS ?? "10000")) });
  const raw = await res.text();
  return { status: res.status, json: async () => JSON.parse(raw) };
};

export type DeribitResponse<T = unknown> = { ok: boolean; code: string; msg: string; result: T | null };

const baseForMode = (mode: DeribitMode): string => (mode === "live" ? "https://www.deribit.com/api/v2" : "https://test.deribit.com/api/v2");

export class DeribitExecutionClient {
  private readonly base: string;
  private readonly creds: DeribitCredentials;
  private token: { value: string; expMs: number } | null = null;

  constructor(creds: DeribitCredentials, private readonly fetcher: DeribitFetcher = defaultFetcher) {
    this.creds = { ...creds, clientId: creds.clientId.trim(), clientSecret: creds.clientSecret.trim() };
    // Base MUST follow the explicit mode. We deliberately do NOT read the shared DERIBIT_REST_BASE
    // (it points at production for the public pricing-harness fetchers) — inheriting it would send
    // testnet keys to www.deribit.com and fail auth (13004). A dedicated override is allowed.
    this.base = this.creds.baseUrl ?? process.env.DERIBIT_EXEC_REST_BASE ?? baseForMode(this.creds.mode);
  }

  get mode(): "demo" | "live" {
    return this.creds.mode === "live" ? "live" : "demo";
  }

  /** The REST base actually in use (so callers can log testnet vs production unambiguously). */
  get restBase(): string {
    return this.base;
  }

  private q(params: Record<string, string | number | boolean | undefined>): string {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) u.set(k, String(v));
    return u.toString();
  }

  /** Public GET (no auth). */
  private async pub<T = unknown>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<DeribitResponse<T>> {
    return this.call<T>(path, params, false);
  }

  /** Private GET (bearer auth). */
  private async priv<T = unknown>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<DeribitResponse<T>> {
    return this.call<T>(path, params, true);
  }

  private async call<T = unknown>(path: string, params: Record<string, string | number | boolean | undefined>, auth: boolean): Promise<DeribitResponse<T>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) {
      const tok = await this.ensureToken();
      if (!tok.ok) return { ok: false, code: tok.code, msg: tok.msg, result: null };
      headers["Authorization"] = `Bearer ${tok.token}`;
    }
    const qs = this.q(params);
    const url = `${this.base}${path}${qs ? `?${qs}` : ""}`;
    let res: { status: number; json: () => Promise<unknown> };
    try {
      res = await this.fetcher(url, { method: "GET", headers });
    } catch (e) {
      return { ok: false, code: "ERR", msg: `network error: ${e instanceof Error ? e.message : String(e)}`, result: null };
    }
    let j: { result?: T; error?: { code?: number; message?: string } };
    try {
      j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    } catch {
      return { ok: false, code: `HTTP_${res.status}`, msg: `non-JSON response (status ${res.status})`, result: null };
    }
    if (j.error) return { ok: false, code: String(j.error.code ?? ""), msg: String(j.error.message ?? ""), result: null };
    return { ok: res.status === 200, code: "0", msg: "", result: (j.result ?? null) as T | null };
  }

  /** client_credentials OAuth2 → cached bearer token (refreshes ~60s before expiry). */
  private async ensureToken(): Promise<{ ok: boolean; token: string; code: string; msg: string }> {
    if (this.token && this.token.expMs - 60_000 > Date.now()) return { ok: true, token: this.token.value, code: "0", msg: "" };
    const r = await this.pub<{ access_token?: string; expires_in?: number }>("/public/auth", {
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret
    });
    if (!r.ok || !r.result?.access_token) return { ok: false, token: "", code: r.code || "AUTH", msg: r.msg || "no access_token" };
    this.token = { value: r.result.access_token, expMs: Date.now() + (r.result.expires_in ?? 900) * 1000 };
    return { ok: true, token: this.token.value, code: "0", msg: "" };
  }

  /** Auth preflight — a private GET to isolate credential problems. */
  async authCheck(): Promise<{ ok: boolean; message: string }> {
    const r = await this.getAccountSummary();
    return { ok: r.ok, message: r.ok ? "auth ok" : `${r.code}: ${r.msg}` };
  }

  getAccountSummary(currency = "BTC"): Promise<DeribitResponse<{ equity?: number; available_funds?: number; margin_balance?: number; portfolio_margining_enabled?: boolean; margin_model?: string; initial_margin?: number }>> {
    return this.priv("/private/get_account_summary", { currency, extended: true });
  }

  getInstruments(currency = "BTC", kind = "option"): Promise<DeribitResponse<Array<{ instrument_name?: string; is_active?: boolean }>>> {
    return this.pub("/public/get_instruments", { currency, kind, expired: false });
  }

  getOrderBook(instrumentName: string): Promise<DeribitResponse<{ best_bid_price?: number; best_ask_price?: number; bids?: number[][]; asks?: number[][] }>> {
    return this.pub("/public/get_order_book", { instrument_name: instrumentName, depth: 1 });
  }

  buy(p: { instrument_name: string; amount: number; type: "limit" | "market"; price?: number; label?: string; reduce_only?: boolean }): Promise<DeribitResponse<{ order?: DeribitOrder; trades?: unknown[] }>> {
    return this.priv("/private/buy", { instrument_name: p.instrument_name, amount: p.amount, type: p.type, price: p.price, label: p.label, reduce_only: p.reduce_only, time_in_force: "good_til_cancelled" });
  }

  sell(p: { instrument_name: string; amount: number; type: "limit" | "market"; price?: number; label?: string; reduce_only?: boolean }): Promise<DeribitResponse<{ order?: DeribitOrder; trades?: unknown[] }>> {
    return this.priv("/private/sell", { instrument_name: p.instrument_name, amount: p.amount, type: p.type, price: p.price, label: p.label, reduce_only: p.reduce_only, time_in_force: "good_til_cancelled" });
  }

  getOrderState(orderId: string): Promise<DeribitResponse<DeribitOrder>> {
    return this.priv("/private/get_order_state", { order_id: orderId });
  }

  /**
   * Margin for a HYPOTHETICAL order — computes buy/sell initial margin WITHOUT placing anything.
   * Lets us sweep the short-leg IM across size/strike/tenor with zero orders. Margins are in BTC.
   */
  getMargins(instrumentName: string, amount: number, price: number): Promise<DeribitResponse<{ buy?: number; sell?: number; max_price?: number; min_price?: number }>> {
    return this.priv("/private/get_margins", { instrument_name: instrumentName, amount, price });
  }

  /**
   * Portfolio-margin simulation — computes the PM initial margin for a set of HYPOTHETICAL positions
   * WITHOUT trading. Lets us measure the real cross-wing netting of a collar book (vs summed isolated
   * leg margins). `simulated_positions` is instrument→size (options in BTC; short = negative). Margins
   * in BTC. add_positions=false ⟹ margin of the simulated set alone. Rate-limited to ~1/s by Deribit.
   */
  simulatePortfolio(
    currency: string,
    simulatedPositions: Record<string, number>,
    addPositions = false
  ): Promise<DeribitResponse<{ projected_initial_margin?: number; projected_maintenance_margin?: number; available_funds?: number }>> {
    return this.priv("/private/simulate_portfolio", { currency, add_positions: addPositions, simulated_positions: JSON.stringify(simulatedPositions) });
  }

  cancel(orderId: string): Promise<DeribitResponse<DeribitOrder>> {
    return this.priv("/private/cancel", { order_id: orderId });
  }

  getPositions(currency = "BTC", kind = "option"): Promise<DeribitResponse<Array<{ instrument_name?: string; size?: number; initial_margin?: number; maintenance_margin?: number }>>> {
    return this.priv("/private/get_positions", { currency, kind });
  }

  /**
   * Adapter to the venue-agnostic ExecClient so executeCollarHedge runs unchanged. Maps Deribit
   * order states/fields → the OKX-shaped fields the executor expects. amount in contracts (BTC).
   */
  asExecClient(): ExecClient {
    const toLegResult = (r: DeribitResponse<{ order?: DeribitOrder }>) => ({
      ok: r.ok,
      code: r.code,
      msg: r.msg,
      data: [{ ordId: r.result?.order?.order_id, sCode: r.ok ? "0" : r.code, sMsg: r.msg }]
    });
    return {
      mode: this.mode,
      placeOrder: async (o: OkxLegOrder) => {
        const amount = Number(o.sz);
        const price = o.px != null ? Number(o.px) : undefined;
        const args = { instrument_name: o.instId, amount, type: o.ordType, price, reduce_only: o.reduceOnly };
        return toLegResult(o.side === "buy" ? await this.buy(args) : await this.sell(args));
      },
      getOrder: async (_instId: string, ordId: string) => {
        const r = await this.getOrderState(ordId);
        const st = mapDeribitState(r.result?.order_state);
        return { ok: r.ok, data: [{ state: st, avgPx: r.result?.average_price != null ? String(r.result.average_price) : undefined, accFillSz: r.result?.filled_amount != null ? String(r.result.filled_amount) : undefined }] };
      },
      cancelOrder: async (_instId: string, ordId: string) => {
        const r = await this.cancel(ordId);
        return { ok: r.ok, data: [] };
      },
      getPositions: async (_instType?: string) => {
        const r = await this.getPositions("BTC", "option");
        return { ok: r.ok, data: (r.result ?? []).map((p) => ({ instId: p.instrument_name, pos: p.size != null ? String(p.size) : undefined, imr: p.initial_margin != null ? String(p.initial_margin) : undefined, mmr: p.maintenance_margin != null ? String(p.maintenance_margin) : undefined })) };
      }
    };
  }
}

export type DeribitOrder = { order_id?: string; order_state?: string; average_price?: number; filled_amount?: number; amount?: number };

/** Map Deribit order_state → the executor's expected "filled" | "canceled" | other. Pure. */
export const mapDeribitState = (s: string | undefined): string => {
  if (s === "filled") return "filled";
  if (s === "cancelled" || s === "rejected") return "canceled";
  return s ?? "open";
};
