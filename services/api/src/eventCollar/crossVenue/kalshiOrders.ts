/**
 * Kalshi order client — the portfolio endpoints the live hedge needs: place
 * one order, read it back if it did not finish at once, cancel what rests, and
 * one balance read for the operator's pre-flight.
 *
 * Wire facts (Kalshi Trade API, orders tag, V2 shape):
 *   POST   /portfolio/events/orders     {ticker, client_order_id, side: "bid"|"ask", count: "N.NN",
 *                                        price: "0.XXXX", time_in_force, self_trade_prevention_type}
 *                                      -> 201 {order_id, client_order_id, fill_count: "N.NN", remaining_count: "N.NN",
 *                                              average_fill_price?: "0.XXXXXX", average_fee_paid?: "0.XXXXXX", ts_ms}
 *   DELETE /portfolio/events/orders/{order_id}                               -> cancel (V2)
 *   GET    /portfolio/orders/{order_id}                                      -> {order}   (legacy read; still served)
 *   GET    /portfolio/balance                                                -> {balance (cents), ...}
 *   GET    /portfolio/fills?order_id=&min_ts=&max_ts=&subaccount=&limit=&cursor=
 *                                      -> {fills[{fill_id, order_id, ticker, outcome_side, book_side, count_fp,
 *                                                 yes_price_dollars, no_price_dollars, fee_cost, created_time, ts,
 *                                                 subaccount_number}], cursor}   (the daily check reads this; min_ts and
 *                                                 max_ts are unix seconds; no subaccount means every one the key sees)
 * Auth: the same KALSHI-ACCESS-* headers as the RFQ client (kalshiRfq.ts).
 * The legacy POST /portfolio/orders answers 410 deprecated_v1_order_endpoint since October 2026.
 *
 * V2 quotes everything from the Yes side of one book: `bid` buys Yes, `ask`
 * sells Yes, and selling Yes is buying No at 1 - price. The hedge buys No, so
 * the order is an `ask` priced at 1 - (walked worst No price), immediate-or-
 * cancel. Selling the hedge back (an early close) is the mirror: a `bid` for
 * Yes at 1 - (walked worst No bid), which sells our No at that bid or better.
 * The response is the final state of an IOC order, fills and fees in
 * dollars; our No cost per contract is 1 - average_fill_price (our No proceeds
 * on a sale, the same figure, rounded the other way). When the venue
 * omits the fee the exact taker formula fills the gap (never under-counted).
 * If the venue leaves contracts resting anyway the remainder is cancelled and
 * the fill is read back, so the order never outlives this call.
 *
 * Sizes go as fixed-point "N.NN", rounded up. Prices as four-decimal dollars.
 */

import { kalshiBase } from "../kalshiPublic";
import { actionOf, type HedgeIntent } from "./hedgeExecutor";
import { kalshiTakerFeeCents } from "./kalshiLadder";
import { contractsFp, fpToMilli, kalshiAuthHeaders, type KalshiRfqCredentials } from "./kalshiRfq";
import { orderNotReadError, type LiveOrderHook, type LiveOrderResult } from "./liveHedge";
import { decimalToMilli } from "./polymarketPublic";

/** The legacy order read (GET /portfolio/orders/{id}): integer cents or the newer dollar strings. */
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

/** The V2 create response: what the matching engine did with the order, dollars and fixed-point counts. */
export interface KalshiV2OrderResponse {
  order_id: string;
  client_order_id?: string;
  fill_count: string;
  remaining_count: string;
  /** Yes-side dollars; present only when fill_count > 0 */
  average_fill_price?: string;
  /** dollars per contract; present only when fill_count > 0 */
  average_fee_paid?: string;
  ts_ms?: number;
}

/** The venue's states that mean "this order is done moving". */
const FINAL_STATUSES = new Set(["executed", "canceled", "cancelled"]);

/** dollars string -> cents, rounded up (against the writer); -1 when absent. */
function dollarsToCents(v: string | undefined): number {
  const milli = decimalToMilli(v, true);
  return milli < 0 ? -1 : Math.ceil(milli / 10);
}

export interface OrderFill {
  unitsMilli: number;
  /** all in, fees included */
  costCents: number;
  feesCents: number;
}

/**
 * What the venue says filled, in milli units and all-in cents. Fixed-point fields win over
 * integers. On a sale (`sell`) the legacy cost fields are what we paid for the Yes we bought, so
 * our No proceeds are the contracts' dollar less that, less fees, rounded down.
 */
export function fillOfOrder(order: KalshiRawOrder, capPriceCents: number, sell = false): OrderFill {
  const takerMilli = order.taker_fill_count_fp !== undefined ? fpToMilli(order.taker_fill_count_fp) : (order.taker_fill_count ?? 0) * 1000;
  const makerMilli = order.maker_fill_count_fp !== undefined ? fpToMilli(order.maker_fill_count_fp) : (order.maker_fill_count ?? 0) * 1000;
  let unitsMilli = takerMilli + makerMilli;
  if (unitsMilli === 0) {
    unitsMilli = order.fill_count_fp !== undefined ? fpToMilli(order.fill_count_fp) : (order.fill_count ?? 0) * 1000;
  }
  const takerCost = order.taker_fill_cost_dollars !== undefined ? dollarsToCents(order.taker_fill_cost_dollars) : (order.taker_fill_cost ?? -1);
  const makerCost = order.maker_fill_cost_dollars !== undefined ? dollarsToCents(order.maker_fill_cost_dollars) : (order.maker_fill_cost ?? 0);
  // a venue that reports no cost on a fill is read at the cap, never under: on a buy our No cost at
  // the cap; on a sale the Yes we paid for at 1 - the floor (our No sold at the lowest bid we accepted)
  const notional = takerCost >= 0 ? takerCost + Math.max(0, makerCost) : Math.ceil((unitsMilli * (sell ? 100 - capPriceCents : capPriceCents)) / 1000);
  const takerFees = order.taker_fees_dollars !== undefined ? dollarsToCents(order.taker_fees_dollars) : (order.taker_fees ?? -1);
  const makerFees = order.maker_fees_dollars !== undefined ? dollarsToCents(order.maker_fees_dollars) : (order.maker_fees ?? 0);
  const avgCents = unitsMilli > 0 ? Math.min(99, Math.max(1, Math.ceil((notional * 1000) / unitsMilli))) : capPriceCents;
  const feesCents = takerFees >= 0 ? takerFees + Math.max(0, makerFees) : kalshiTakerFeeCents(unitsMilli, avgCents);
  if (sell) {
    const dollarCents = Math.floor(unitsMilli / 10); // every contract pays $1 when it wins; the Yes we bought cost `notional`
    return { unitsMilli, costCents: Math.max(0, dollarCents - notional - feesCents), feesCents };
  }
  return { unitsMilli, costCents: notional + feesCents, feesCents };
}

/** dollars string -> micro dollars (the six decimals V2 responses carry); -1 when absent or malformed. */
export function dollarsToMicro(v: string | undefined, roundUp: boolean): number {
  if (v === undefined || v === null) return -1;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return -1;
  const fracRaw = m[2] ?? "";
  let micro = Number(m[1]) * 1_000_000 + Number(fracRaw.padEnd(6, "0").slice(0, 6));
  if (roundUp && fracRaw.length > 6 && /[1-9]/.test(fracRaw.slice(6))) micro += 1;
  return micro;
}

/**
 * The fill of a V2 `ask` (we sold Yes, so we bought No): the venue's average
 * is a Yes price, ours is 1 - it. Both roundings go against the writer: the
 * Yes average is truncated so the No cost rounds up; the fee rounds up; cents
 * round up. A fill with no average is read at the cap; one with no fee at the
 * exact taker formula.
 */
export function fillOfV2Order(resp: KalshiV2OrderResponse, capPriceCents: number): OrderFill {
  const unitsMilli = fpToMilli(resp.fill_count);
  if (unitsMilli <= 0) return { unitsMilli: 0, costCents: 0, feesCents: 0 };
  const yesMicro = dollarsToMicro(resp.average_fill_price, false);
  const noMicro = yesMicro >= 0 && yesMicro <= 1_000_000 ? Math.min(999_999, Math.max(1, 1_000_000 - yesMicro)) : capPriceCents * 10_000;
  // units (milli) x price (micro dollars) -> cents: / 1000 / 1_000_000 x 100
  const notional = Math.ceil((unitsMilli * noMicro) / 10_000_000);
  const feeMicro = dollarsToMicro(resp.average_fee_paid, true);
  const feesCents = feeMicro >= 0 ? Math.ceil((unitsMilli * feeMicro) / 10_000_000) : kalshiTakerFeeCents(unitsMilli, Math.ceil(noMicro / 10_000));
  return { unitsMilli, costCents: notional + feesCents, feesCents };
}

/**
 * The fill of a V2 `bid` placed to sell our No (an early close): the venue's average is the Yes
 * price we paid, our No proceeds per contract are 1 - it. Roundings go against the writer the
 * other way round from a buy: the Yes average rounds up so the proceeds round down; fees round
 * up; cents round down. A fill with no average is read at the floor (the lowest bid we accepted).
 * `costCents` is the net proceeds, fees taken out.
 */
export function fillOfV2Sell(resp: KalshiV2OrderResponse, floorPriceCents: number): OrderFill {
  const unitsMilli = fpToMilli(resp.fill_count);
  if (unitsMilli <= 0) return { unitsMilli: 0, costCents: 0, feesCents: 0 };
  const yesMicro = dollarsToMicro(resp.average_fill_price, true);
  const noMicro = yesMicro >= 0 && yesMicro <= 1_000_000 ? Math.min(999_999, Math.max(1, 1_000_000 - yesMicro)) : floorPriceCents * 10_000;
  const gross = Math.floor((unitsMilli * noMicro) / 10_000_000);
  const feeMicro = dollarsToMicro(resp.average_fee_paid, true);
  const feesCents = feeMicro >= 0 ? Math.ceil((unitsMilli * feeMicro) / 10_000_000) : kalshiTakerFeeCents(unitsMilli, Math.ceil(noMicro / 10_000));
  return { unitsMilli, costCents: Math.max(0, gross - feesCents), feesCents };
}

/**
 * One fill as GET /portfolio/fills lists it (Kalshi Trade API, GetFillsResponse.Fill). Direction
 * is `outcome_side`: buying No and selling Yes both read "no"; buying Yes and selling No both
 * read "yes". `book_side` says the same in book words (ask = "no", bid = "yes"). The older `side`
 * and `action` are deprecated and read only when the newer two are absent.
 */
export interface KalshiFill {
  fill_id: string;
  order_id: string;
  ticker?: string;
  market_ticker?: string;
  outcome_side?: string;
  book_side?: string;
  side?: string;
  action?: string;
  /** contracts, fixed point "N.NN" */
  count_fp: string;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  is_taker?: boolean;
  /** dollars */
  fee_cost?: string;
  created_time?: string;
  /** unix seconds (legacy) */
  ts?: number;
  /** 0 for the primary account, 1 to 63 for a subaccount */
  subaccount_number?: number | null;
  exchange_index?: number;
}

/** Which way a listed fill moved our No: "no" took No on (the hedge bought), "yes" took it off (the hedge sold); null when the fill does not say. */
export function kalshiFillSide(f: Pick<KalshiFill, "outcome_side" | "book_side" | "side" | "action">): "no" | "yes" | null {
  const o = (f.outcome_side ?? "").toLowerCase();
  if (o === "no" || o === "yes") return o;
  const b = (f.book_side ?? "").toLowerCase();
  if (b === "ask") return "no";
  if (b === "bid") return "yes";
  const side = (f.side ?? "").toLowerCase();
  const action = (f.action ?? "").toLowerCase();
  if ((side === "no" || side === "yes") && (action === "buy" || action === "sell")) return (side === "no") === (action === "buy") ? "no" : "yes";
  return null;
}

/**
 * What one order's listed fills add up to, in the same units and with the same roundings as the
 * order's own answer (fillOfV2Order, fillOfV2Sell): on a buy the No notional rounds up and the
 * fee is added; on a sale (`sell`) the No proceeds round down and the fee is taken out. The fee
 * is the venue's own `fee_cost` on each fill, summed and rounded up; nothing is computed here.
 * A fill with no No price is read as 1 less its Yes price. Each fill is priced on its own, so
 * this can sit a cent either side of a figure built from the order's rounded average.
 */
export function fillOfKalshiFills(fills: Array<Pick<KalshiFill, "count_fp" | "yes_price_dollars" | "no_price_dollars" | "fee_cost">>, sell = false): OrderFill & { feeKnown: boolean } {
  let unitsMilli = 0;
  let notionalMicroMilli = 0;
  let feeMicro = 0;
  let feeKnown = fills.length > 0;
  for (const f of fills) {
    const units = fpToMilli(f.count_fp);
    if (units <= 0) continue;
    let noMicro = dollarsToMicro(f.no_price_dollars, !sell);
    if (noMicro < 0) {
      const yesMicro = dollarsToMicro(f.yes_price_dollars, sell);
      noMicro = yesMicro >= 0 && yesMicro <= 1_000_000 ? 1_000_000 - yesMicro : -1;
    }
    // a fill with no price at all cannot be costed: it is counted at the worst end for us
    if (noMicro < 0) noMicro = sell ? 0 : 1_000_000;
    unitsMilli += units;
    notionalMicroMilli += units * noMicro;
    const fee = dollarsToMicro(f.fee_cost, true);
    if (fee < 0) feeKnown = false;
    else feeMicro += fee;
  }
  if (unitsMilli <= 0) return { unitsMilli: 0, costCents: 0, feesCents: 0, feeKnown: false };
  const feesCents = Math.ceil(feeMicro / 10_000);
  if (sell) return { unitsMilli, costCents: Math.max(0, Math.floor(notionalMicroMilli / 10_000_000) - feesCents), feesCents, feeKnown };
  return { unitsMilli, costCents: Math.ceil(notionalMicroMilli / 10_000_000) + feesCents, feesCents, feeKnown };
}

export interface KalshiFillsQuery {
  orderId?: string;
  /** unix seconds, as the venue takes them */
  minTs?: number;
  maxTs?: number;
  /** 0 for the primary account, 1 to 63 for a subaccount; absent reads every subaccount the key can see */
  subaccount?: number;
  cursor?: string;
  /** 1 to 1000 */
  limit?: number;
}

export interface KalshiOrderClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class KalshiOrderClient {
  readonly venue = "kalshi" as const;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly creds: KalshiRfqCredentials,
    opts: KalshiOrderClientOptions = {},
  ) {
    this.base = (opts.base ?? process.env.KALSHI_TRADE_BASE ?? kalshiBase()).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000);
  }

  /** The hook the live executor calls: a buy of No, or a sale of it (intent.action). */
  hook(): LiveOrderHook {
    return (intent, clientOrderId) => this.place(intent, clientOrderId);
  }

  /**
   * The No price the order will not cross: on a buy the walked worst ask in whole cents, rounded
   * up (never pay over the walk); on a sale the walked worst bid, rounded up (never sell under it).
   */
  static capCents(intent: HedgeIntent): number {
    return Math.min(99, Math.max(1, Math.ceil(intent.book.worstPriceMilli / 10)));
  }

  /**
   * The V2 order body for an intent: what dry run describes and live sends. Exported for the
   * receipt and the tests. An `ask` at (1 - cap) is a buy of No at the cap or better; a `bid` at
   * (1 - floor) is a sale of No at the floor or better.
   */
  static orderBody(intent: HedgeIntent, clientOrderId: string): Record<string, unknown> {
    if (intent.venue !== "kalshi") throw new Error(`kalshi orders: intent is for ${intent.venue}`);
    const capCents = KalshiOrderClient.capCents(intent);
    return {
      ticker: intent.instrument,
      client_order_id: clientOrderId,
      side: actionOf(intent) === "sell" ? "bid" : "ask",
      count: contractsFp(intent.unitsMilli),
      price: ((100 - capCents) / 100).toFixed(4),
      // a lock's hedge is the whole size or nothing (CreateOrderV2Request.time_in_force takes fill_or_kill); everything else may fill in part
      time_in_force: intent.allOrNone ? "fill_or_kill" : "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
    };
  }

  /** Kept under its old name for callers that buy; `place` reads the intent's action. */
  placeNo(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    return this.place(intent, clientOrderId);
  }

  async place(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    const sell = actionOf(intent) === "sell";
    const body = KalshiOrderClient.orderBody(intent, clientOrderId);
    const capCents = KalshiOrderClient.capCents(intent);
    const created = (await this.call("POST", "/portfolio/events/orders", body)) as Partial<KalshiV2OrderResponse> | null;
    if (!created?.order_id) throw new Error("kalshi orders: create returned no order id");
    const orderId = created.order_id;

    const v2 = { fill_count: "0.00", remaining_count: "0.00", ...created, order_id: orderId };
    let fill = sell ? fillOfV2Sell(v2, capCents) : fillOfV2Order(v2, capCents);
    let status = fill.unitsMilli > 0 ? "executed" : "canceled";
    // IOC answers with its final state; if the venue rests anything anyway, cancel it and read back
    if (fpToMilli(created.remaining_count) > 0) {
      await this.call("DELETE", `/portfolio/events/orders/${encodeURIComponent(orderId)}`).catch(() => null);
      const read = (await this.call("GET", `/portfolio/orders/${encodeURIComponent(orderId)}`).catch(() => null)) as { order?: KalshiRawOrder } | null;
      // the venue rested part of the order: what filled is known only from the order read back in a final state
      const last = (read?.order?.status ?? "").toLowerCase();
      if (!read?.order) throw orderNotReadError("kalshi", orderId, "resting", "part of it rested and it could not be read back after the cancel");
      if (!FINAL_STATUSES.has(last)) throw orderNotReadError("kalshi", orderId, last || "resting", "part of it rested and the cancel was not confirmed");
      const legacy = fillOfOrder(read.order, capCents, sell);
      if (legacy.unitsMilli > 0) fill = legacy;
      status = last;
    }

    if (fill.unitsMilli <= 0) {
      throw new Error(`kalshi orders: order ${orderId} ${status} with nothing ${sell ? "sold at or over" : "filled at or under"} ${capCents}c`);
    }
    return {
      orderId,
      unitsMilli: fill.unitsMilli,
      // the average per unit: rounded up on a buy (never under-counted), down on a sale (never over-counted)
      avgPriceMilli: sell ? Math.floor((fill.costCents * 10_000) / fill.unitsMilli) : Math.ceil((fill.costCents * 10_000) / fill.unitsMilli),
      costCents: fill.costCents,
      feesCents: fill.feesCents,
      status,
    };
  }

  /** Operator pre-flight: the credentials sign, the venue answers, and this is the cash available. */
  async balanceCents(): Promise<number> {
    const data = (await this.call("GET", "/portfolio/balance")) as { balance?: number; balance_dollars?: string } | null;
    if (data?.balance_dollars !== undefined) return Math.max(0, dollarsToCents(data.balance_dollars));
    if (typeof data?.balance === "number") return data.balance;
    throw new Error("kalshi orders: balance response had no balance");
  }

  /**
   * One page of the account's own fills (GET /portfolio/fills). A read, never an order. The
   * venue moves fills older than its historical cutoff to another endpoint, which this does not
   * read. The cursor is null on the last page.
   */
  async fillsPage(q: KalshiFillsQuery = {}): Promise<{ fills: KalshiFill[]; cursor: string | null }> {
    const params = new URLSearchParams();
    if (q.orderId) params.set("order_id", q.orderId);
    if (q.minTs !== undefined) params.set("min_ts", String(Math.floor(q.minTs)));
    if (q.maxTs !== undefined) params.set("max_ts", String(Math.floor(q.maxTs)));
    if (q.subaccount !== undefined) params.set("subaccount", String(q.subaccount));
    params.set("limit", String(Math.min(1000, Math.max(1, q.limit ?? 1000))));
    if (q.cursor) params.set("cursor", q.cursor);
    const data = (await this.call("GET", `/portfolio/fills?${params.toString()}`)) as { fills?: unknown; cursor?: unknown } | null;
    const fills = (Array.isArray(data?.fills) ? data.fills : []).filter((f): f is KalshiFill => {
      const x = f as Partial<KalshiFill> | null;
      return Boolean(x && typeof x.order_id === "string" && x.order_id && typeof x.count_fp === "string");
    });
    return { fills, cursor: typeof data?.cursor === "string" && data.cursor ? data.cursor : null };
  }

  /** One order as the venue holds it (the legacy read): the only place its client order id is read back. Null when the venue has no such order. */
  async orderRead(orderId: string): Promise<KalshiRawOrder | null> {
    try {
      const read = (await this.call("GET", `/portfolio/orders/${encodeURIComponent(orderId)}`)) as { order?: KalshiRawOrder } | null;
      return read?.order ?? null;
    } catch (err) {
      if (err instanceof Error && /\bHTTP 404\b/.test(err.message)) return null;
      throw err;
    }
  }

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const url = `${this.base}${endpoint}`;
    // the signature covers the path alone; a query string is not part of it
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
      // the error names the endpoint without its query
      throw new Error(`kalshi orders: HTTP ${res.status} ${method} ${endpoint.split("?")[0]}${text ? ` ${text.slice(0, 200)}` : ""}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
