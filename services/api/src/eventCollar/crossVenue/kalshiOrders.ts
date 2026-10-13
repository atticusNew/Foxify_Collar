/**
 * Kalshi order client — the portfolio endpoints the live hedge needs: place
 * one limit order, read it back, cancel what rests, and one balance read for
 * the operator's pre-flight.
 *
 * Wire facts (Kalshi Trade API v2, portfolio tag):
 *   POST   /portfolio/orders            {ticker, client_order_id, side, action, type, count | count_fp,
 *                                        no_price, time_in_force}          -> {order}
 *   GET    /portfolio/orders/{order_id}                                     -> {order}
 *   DELETE /portfolio/orders/{order_id}                                     -> {order, reduced_by}
 *   GET    /portfolio/balance                                               -> {balance (cents), ...}
 * Auth: the same KALSHI-ACCESS-* headers as the RFQ client (kalshiRfq.ts).
 *
 * The order: buy No, limit at the walked worst price (cents, rounded up from
 * milli), immediate-or-cancel. If the venue leaves it resting anyway the client
 * waits briefly, then cancels the remainder, so the order never outlives this
 * call. Fill numbers are read from the venue, fees included; when the venue
 * omits fees the exact taker formula fills the gap (never under-counted).
 *
 * Whole-contract sizes go as the integer `count`; fractional sizes as
 * fixed-point `count_fp`, rounded up. VERIFY ON KALSHI'S DEMO API BEFORE LIVE
 * USE, like the RFQ client: the field names are from the public reference and
 * the demo environment is where a rename shows up for free.
 */

import { kalshiBase } from "../kalshiPublic";
import type { HedgeIntent } from "./hedgeExecutor";
import { kalshiTakerFeeCents } from "./kalshiLadder";
import { contractsFp, fpToMilli, kalshiAuthHeaders, type KalshiRfqCredentials } from "./kalshiRfq";
import type { LiveOrderHook, LiveOrderResult } from "./liveHedge";
import { decimalToMilli } from "./polymarketPublic";

export interface KalshiRawOrder {
  order_id: string;
  client_order_id?: string;
  ticker?: string;
  status?: string;
  side?: string;
  action?: string;
  no_price?: number;
  yes_price?: number;
  taker_fill_count?: number;
  taker_fill_count_fp?: string;
  maker_fill_count?: number;
  maker_fill_count_fp?: string;
  fill_count?: number;
  fill_count_fp?: string;
  /** cents */
  taker_fill_cost?: number;
  taker_fill_cost_dollars?: string;
  maker_fill_cost?: number;
  maker_fill_cost_dollars?: string;
  /** cents */
  taker_fees?: number;
  taker_fees_dollars?: string;
  maker_fees?: number;
  maker_fees_dollars?: string;
  remaining_count?: number;
  remaining_count_fp?: string;
}

/** The venue's states that mean "this order is done moving". */
const FINAL_STATUSES = new Set(["executed", "canceled", "cancelled"]);

/** dollars string -> cents, rounded up (against the writer); -1 when absent. */
function dollarsToCents(v: string | undefined): number {
  const milli = decimalToMilli(v, true);
  return milli < 0 ? -1 : Math.ceil(milli / 10);
}

/** What the venue says filled, in milli units and all-in cents. Fixed-point fields win over integers. */
export function fillOfOrder(order: KalshiRawOrder, capPriceCents: number): { unitsMilli: number; costCents: number; feesCents: number } {
  const takerMilli = order.taker_fill_count_fp !== undefined ? fpToMilli(order.taker_fill_count_fp) : (order.taker_fill_count ?? 0) * 1000;
  const makerMilli = order.maker_fill_count_fp !== undefined ? fpToMilli(order.maker_fill_count_fp) : (order.maker_fill_count ?? 0) * 1000;
  let unitsMilli = takerMilli + makerMilli;
  if (unitsMilli === 0) {
    unitsMilli = order.fill_count_fp !== undefined ? fpToMilli(order.fill_count_fp) : (order.fill_count ?? 0) * 1000;
  }
  const takerCost = order.taker_fill_cost_dollars !== undefined ? dollarsToCents(order.taker_fill_cost_dollars) : (order.taker_fill_cost ?? -1);
  const makerCost = order.maker_fill_cost_dollars !== undefined ? dollarsToCents(order.maker_fill_cost_dollars) : (order.maker_fill_cost ?? 0);
  // a venue that reports no cost on a fill is read at the cap, never under
  const notional = takerCost >= 0 ? takerCost + Math.max(0, makerCost) : Math.ceil((unitsMilli * capPriceCents) / 1000);
  const takerFees = order.taker_fees_dollars !== undefined ? dollarsToCents(order.taker_fees_dollars) : (order.taker_fees ?? -1);
  const makerFees = order.maker_fees_dollars !== undefined ? dollarsToCents(order.maker_fees_dollars) : (order.maker_fees ?? 0);
  const avgCents = unitsMilli > 0 ? Math.min(99, Math.max(1, Math.ceil((notional * 1000) / unitsMilli))) : capPriceCents;
  const feesCents = takerFees >= 0 ? takerFees + Math.max(0, makerFees) : kalshiTakerFeeCents(unitsMilli, avgCents);
  return { unitsMilli, costCents: notional + feesCents, feesCents };
}

export interface KalshiOrderClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  /** how long to give a resting order before the remainder is cancelled */
  restWaitMs?: number;
  restPollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class KalshiOrderClient {
  readonly venue = "kalshi" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly restWaitMs: number;
  private readonly restPollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    private readonly creds: KalshiRfqCredentials,
    opts: KalshiOrderClientOptions = {},
  ) {
    this.base = (opts.base ?? process.env.KALSHI_TRADE_BASE ?? kalshiBase()).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.restWaitMs = opts.restWaitMs ?? 2_000;
    this.restPollMs = opts.restPollMs ?? 250;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000);
  }

  /** The hook the live executor calls. */
  hook(): LiveOrderHook {
    return (intent, clientOrderId) => this.placeNo(intent, clientOrderId);
  }

  /** The order body for an intent: what dry run describes and live sends. Exported for the receipt and the tests. */
  static orderBody(intent: HedgeIntent, clientOrderId: string): Record<string, unknown> {
    if (intent.venue !== "kalshi") throw new Error(`kalshi orders: intent is for ${intent.venue}`);
    const capCents = Math.min(99, Math.max(1, Math.ceil(intent.book.worstPriceMilli / 10)));
    const whole = intent.unitsMilli % 1000 === 0;
    return {
      ticker: intent.instrument,
      client_order_id: clientOrderId,
      side: "no",
      action: "buy",
      type: "limit",
      ...(whole ? { count: intent.unitsMilli / 1000 } : { count_fp: contractsFp(intent.unitsMilli) }),
      no_price: capCents,
      time_in_force: "immediate_or_cancel",
    };
  }

  async placeNo(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    const body = KalshiOrderClient.orderBody(intent, clientOrderId);
    const capCents = body.no_price as number;
    const created = (await this.call("POST", "/portfolio/orders", body)) as { order?: KalshiRawOrder } | null;
    let order = created?.order;
    if (!order?.order_id) throw new Error("kalshi orders: create returned no order id");

    // IOC should settle this at once; if the venue rests it anyway, wait briefly and cancel the rest
    const deadline = this.now() + this.restWaitMs;
    while (!FINAL_STATUSES.has((order.status ?? "").toLowerCase()) && this.now() < deadline) {
      await this.sleep(this.restPollMs);
      const read = (await this.call("GET", `/portfolio/orders/${encodeURIComponent(order.order_id)}`)) as { order?: KalshiRawOrder } | null;
      if (read?.order) order = { ...order, ...read.order };
    }
    if (!FINAL_STATUSES.has((order.status ?? "").toLowerCase())) {
      const cancelled = (await this.call("DELETE", `/portfolio/orders/${encodeURIComponent(order.order_id)}`)) as { order?: KalshiRawOrder } | null;
      if (cancelled?.order) order = { ...order, ...cancelled.order };
      else order = { ...order, status: "canceled" };
    }

    const fill = fillOfOrder(order, capCents);
    if (fill.unitsMilli <= 0) {
      throw new Error(`kalshi orders: order ${order.order_id} ${order.status ?? "done"} with nothing filled at or under ${capCents}c`);
    }
    return {
      orderId: order.order_id,
      unitsMilli: fill.unitsMilli,
      avgPriceMilli: Math.ceil((fill.costCents * 10_000) / fill.unitsMilli),
      costCents: fill.costCents,
      feesCents: fill.feesCents,
      status: (order.status ?? "executed").toLowerCase(),
    };
  }

  /** Operator pre-flight: the credentials sign, the venue answers, and this is the cash available. */
  async balanceCents(): Promise<number> {
    const data = (await this.call("GET", "/portfolio/balance")) as { balance?: number; balance_dollars?: string } | null;
    if (data?.balance_dollars !== undefined) return Math.max(0, dollarsToCents(data.balance_dollars));
    if (typeof data?.balance === "number") return data.balance;
    throw new Error("kalshi orders: balance response had no balance");
  }

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const url = `${this.base}${endpoint}`;
    const path = new URL(url).pathname;
    const ts = this.now();
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "atticus-event-hedge",
      ...kalshiAuthHeaders(this.creds, ts, method, path),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`kalshi orders: HTTP ${res.status} ${method} ${endpoint}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
