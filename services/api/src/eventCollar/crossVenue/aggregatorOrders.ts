/**
 * AGGREGATOR ORDERS: the live hedge sent through the partner's execution pod instead of our own
 * key on the venue.
 *
 * The partner (aggregatorMarkets.ts) also runs execution: an organisation owns pods, a pod holds
 * the venue connection (on Kalshi, one numbered subaccount under the organisation's own Kalshi
 * account), and a trader on the pod signs orders with a TRADE key. The key never sees the venue
 * credential; the pod does the routing; the order, its fills and the position are on the
 * partner's books as well as the venue's, under the pod, attributed to the key. That second book
 * is the point: a hedge that a third party recorded.
 *
 * Wire facts (partner REST, Kalshi venue paths; signing as in aggregatorMarkets.ts):
 *   GET    /v1/whoami                      -> {keyId, credentialId, podId, scope, capabilities[]}
 *   GET    /v1/kalshi/balance              -> {available}  USD, the pod's cash across every Market Group,
 *                                             minus what its resting buys hold
 *   GET    /v1/kalshi/positions[?ticker=]  -> {positions[{ticker, contracts (signed, YES side), averageYesPrice,
 *                                             averageNoPrice, yesMark, noMark, valueUsd, unrealizedPnlUsd}]}
 *   POST   /v1/kalshi/orders  Idempotency-Key: <id>
 *          {ticker, side: "BID"|"ASK", count: "N.NN", price: "0.XXXX" (YES book), timeInForce: {type: "IOC"},
 *           selfTradePrevention: "TAKER_AT_CROSS", clientOrderId}
 *                                          -> 201 {orderId, status, filledCount, remainingCount, averagePrice (YES)}
 *   GET    /v1/kalshi/orders/{orderId}     -> the order: status, filledCount, averageYesPrice, averageNoPrice,
 *                                             feesCents, feesUsd, venueOrderId, clientOrderId, closedAt
 *   GET    /v1/kalshi/orders/{orderId}/fills -> {fills[{count, yesPrice, noPrice, feeCents, feeUsd, venueFillId, occurredAt}]}
 *   DELETE /v1/kalshi/orders/{orderId}     -> the order after the cancel; 409 when it already finished
 *
 * The hedge buys No: on Kalshi that is an ASK on the YES book at 1 - (our worst No price), so the
 * body is the same order kalshiOrders.ts sends, in the partner's spelling. Selling the hedge back
 * (an early close) is a BID at 1 - (our worst No bid), the same mirror. Immediate-or-cancel:
 * the venue answers with the final state; the partner may relay it a beat later, so the order is
 * read back until it stops moving, anything still resting is cancelled, and the fill is taken from
 * the read (it carries the fees; the submit answer does not). Roundings go against the writer.
 *
 * The idempotency key is the client order id: a retry after a timeout returns the same order
 * instead of placing a second one. The partner keeps client order ids unique across the whole
 * Kalshi account forever, which `atticus-<receipt id>` already is.
 *
 * The TRADE key is AGGREGATOR_TRADE_KEY_ID + AGGREGATOR_TRADE_PRIVATE_KEY_HEX in the service env:
 * a different key from the DATA key, bound to one pod, never in git, never in the client. Unset,
 * `aggregatorTradeConfigFromEnv` is null and no order can go this way.
 */

import { AggregatorApiError, DEFAULT_API_HOST, signedHeaders, signerFromSecret, type AggregatorSigner, type Whoami } from "./aggregatorMarkets";
import { actionOf, type HedgeIntent } from "./hedgeExecutor";
import { kalshiTakerFeeCents } from "./kalshiLadder";
import { contractsFp, fpToMilli } from "./kalshiRfq";
import { dollarsToMicro } from "./kalshiOrders";
import { orderNotReadError, type LiveOrderHook, type LiveOrderResult } from "./liveHedge";

export interface AggregatorTradeConfig {
  host: string;
  keyId: string;
  secret: string;
}

/** Null unless both halves of the TRADE key are set. The DATA key is never used for an order. */
export function aggregatorTradeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AggregatorTradeConfig | null {
  const keyId = env.AGGREGATOR_TRADE_KEY_ID?.trim();
  const secret = env.AGGREGATOR_TRADE_PRIVATE_KEY_HEX?.trim();
  if (!keyId || !secret) return null;
  return { host: (env.AGGREGATOR_API_HOST?.trim() || DEFAULT_API_HOST).replace(/\/+$/, ""), keyId, secret };
}

/** The partner's order states that mean "done moving". */
export const AGGREGATOR_FINAL = new Set(["FILLED", "CANCELLED", "REJECTED"]);

export interface AggregatorKalshiOrder {
  orderId: string;
  ticker: string;
  side: "BID" | "ASK";
  count: string;
  status: string;
  venueOrderId: string | null;
  filledCount: string | null;
  averageYesPrice: string | null;
  averageNoPrice: string | null;
  feesCents: number | null;
  feesUsd: string | null;
  clientOrderId: string | null;
  createdAt?: string;
  closedAt?: string | null;
}

export interface AggregatorKalshiFill {
  fillId: string;
  venueFillId: string;
  count: string;
  yesPrice: string;
  noPrice: string;
  feeCents: number;
  feeUsd: string | null;
  occurredAt: string;
}

export interface AggregatorKalshiPosition {
  ticker: string;
  /** signed, YES side: negative is long No */
  contracts: string;
  averageYesPrice: string | null;
  averageNoPrice: string | null;
  yesMark: string | null;
  noMark: string | null;
  valueUsd: string | null;
  unrealizedPnlUsd: string | null;
}

export interface AggregatorSubmitResponse {
  orderId: string;
  status: string;
  filledCount: string | null;
  remainingCount: string | null;
  averagePrice: string | null;
}

/** micro dollars x milli units -> cents, rounded up. */
const centsOf = (unitsMilli: number, priceMicro: number): number => Math.ceil((unitsMilli * priceMicro) / 10_000_000);

export interface OrderFill {
  unitsMilli: number;
  costCents: number;
  feesCents: number;
}

/**
 * What the order read says filled, in milli units and all-in cents. The No average is the partner's
 * own complement when given, else 1 - the Yes average, else the cap. Fees: the exact dollars when
 * given (rounded up), the venue's whole cents next, the taker formula last. On a sale (`sell`) the
 * No average is our proceeds per contract and every rounding goes the other way: the average down,
 * the gross down, the fees up; `costCents` is the net proceeds.
 */
export function fillOfAggregatorOrder(o: Pick<AggregatorKalshiOrder, "filledCount" | "averageYesPrice" | "averageNoPrice" | "feesCents" | "feesUsd">, capPriceCents: number, sell = false): OrderFill {
  const unitsMilli = fpToMilli(o.filledCount ?? undefined);
  if (unitsMilli <= 0) return { unitsMilli: 0, costCents: 0, feesCents: 0 };
  let noMicro = dollarsToMicro(o.averageNoPrice ?? undefined, !sell);
  if (noMicro < 0) {
    const yesMicro = dollarsToMicro(o.averageYesPrice ?? undefined, sell);
    noMicro = yesMicro >= 0 && yesMicro <= 1_000_000 ? 1_000_000 - yesMicro : capPriceCents * 10_000;
  }
  noMicro = Math.min(999_999, Math.max(1, noMicro));
  const notional = sell ? Math.floor((unitsMilli * noMicro) / 10_000_000) : centsOf(unitsMilli, noMicro);
  const feeMicro = dollarsToMicro(o.feesUsd ?? undefined, true);
  const feesCents =
    feeMicro >= 0 ? Math.ceil(feeMicro / 10_000) : typeof o.feesCents === "number" && o.feesCents >= 0 ? o.feesCents : kalshiTakerFeeCents(unitsMilli, Math.ceil(noMicro / 10_000));
  return { unitsMilli, costCents: sell ? Math.max(0, notional - feesCents) : notional + feesCents, feesCents };
}

/** The same from the submit answer alone (no fees on it): the taker formula fills the gap. */
export function fillOfSubmit(r: AggregatorSubmitResponse, capPriceCents: number, sell = false): OrderFill {
  return fillOfAggregatorOrder({ filledCount: r.filledCount, averageYesPrice: r.averagePrice, averageNoPrice: null, feesCents: null, feesUsd: null }, capPriceCents, sell);
}

/** The partner's client order id grammar: up to 64 of letters, digits and `- _ : / + =`. */
export function aggregatorClientOrderId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9\-_:/+=]/g, "-");
  return cleaned.slice(0, 64) || "atticus";
}

export interface AggregatorOrderClientOptions {
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
  timeoutMs?: number;
  /** share one signed surface (and its clock) with another venue client on the same pod */
  rest?: AggregatorPodRest;
  /** how long to wait between order reads while the partner relays the venue's answer */
  settleWaitMs?: number;
  /** how many reads before the order is treated as resting and cancelled */
  settleReads?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The pod's signed REST surface, shared by every venue the pod routes (Kalshi here, ProphetX in
 * prophetxOrders.ts): one TRADE key, one clock offset, one request shape.
 */
export class AggregatorPodRest {
  readonly signer: AggregatorSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly nowSec: () => number;
  private readonly timeoutMs: number;
  private offsetSec = 0;
  private clockSynced = false;

  constructor(
    readonly cfg: AggregatorTradeConfig,
    opts: Pick<AggregatorOrderClientOptions, "fetchImpl" | "nowSec" | "timeoutMs"> = {},
  ) {
    this.signer = signerFromSecret(cfg.keyId, cfg.secret);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000);
  }

  /** One GET /v1/time, so the signatures carry the partner's clock rather than ours. Failure is not fatal. */
  async syncClock(): Promise<void> {
    if (this.clockSynced) return;
    this.clockSynced = true;
    try {
      const { time } = await this.request<{ time: number }>("GET", "/v1/time");
      if (Number.isFinite(time)) this.offsetSec = Math.round(time - this.nowSec());
    } catch {
      this.offsetSec = 0;
    }
  }

  async request<T>(method: string, path: string, o: { query?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const query = o.query ?? "";
    const bodyText = o.body === undefined ? "" : JSON.stringify(o.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "atticus-event-hedge",
      ...signedHeaders(this.signer, { method, path, query, body: bodyText, idempotencyKey: o.idempotencyKey }, this.nowSec() + this.offsetSec),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (bodyText) {
      headers["content-type"] = "application/json";
      init.body = bodyText;
    }
    const res = await this.fetchImpl(`${this.cfg.host}${path}${query ? `?${query}` : ""}`, init);
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok) return json as T;
    const retryAfter = Number(res.headers.get("retry-after"));
    const err = (json ?? {}) as { error?: { code?: string; message?: string } };
    throw new AggregatorApiError(res.status, err.error?.code ?? `http_${res.status}`, err.error?.message ?? `aggregator ${res.status} on ${method} ${path}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
}

export class AggregatorOrderClient {
  readonly venue = "kalshi" as const;
  readonly via = "aggregator" as const;
  readonly rest: AggregatorPodRest;
  private readonly settleWaitMs: number;
  private readonly settleReads: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: AggregatorTradeConfig,
    opts: AggregatorOrderClientOptions = {},
  ) {
    this.rest = opts.rest ?? new AggregatorPodRest(cfg, opts);
    this.settleWaitMs = opts.settleWaitMs ?? 300;
    this.settleReads = opts.settleReads ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Safe to print: what the partner registered against the key id. */
  get publicKeyHex(): string {
    return this.rest.signer.publicKeyHex;
  }

  get keyId(): string {
    return this.cfg.keyId;
  }

  /** The hook the live executor calls: a buy of No, or a sale of it (intent.action). */
  hook(): LiveOrderHook {
    return (intent, clientOrderId) => this.place(intent, clientOrderId);
  }

  /** The No price the order will not cross: the walked worst level in whole cents, rounded up (never over the asks on a buy, never under the bids on a sale). */
  static capCents(intent: HedgeIntent): number {
    return Math.min(99, Math.max(1, Math.ceil(intent.book.worstPriceMilli / 10)));
  }

  /** The partner's body for an intent: an ASK on the YES book at 1 - cap (buy No), or a BID there (sell No), immediate or cancel. */
  static orderBody(intent: HedgeIntent, clientOrderId: string): Record<string, unknown> {
    if (intent.venue !== "kalshi") throw new Error(`aggregator orders: intent is for ${intent.venue}; the pod routes Kalshi only`);
    const capCents = AggregatorOrderClient.capCents(intent);
    return {
      ticker: intent.instrument,
      side: actionOf(intent) === "sell" ? "BID" : "ASK",
      count: contractsFp(intent.unitsMilli),
      price: ((100 - capCents) / 100).toFixed(4),
      timeInForce: { type: "IOC" },
      selfTradePrevention: "TAKER_AT_CROSS",
      clientOrderId: aggregatorClientOrderId(clientOrderId),
    };
  }

  /** Kept under its old name for callers that buy; `place` reads the intent's action. */
  placeNo(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    return this.place(intent, clientOrderId);
  }

  async place(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    const sell = actionOf(intent) === "sell";
    const body = AggregatorOrderClient.orderBody(intent, clientOrderId);
    const capCents = AggregatorOrderClient.capCents(intent);
    const idem = body.clientOrderId as string;
    await this.syncClock();
    const created = await this.request<AggregatorSubmitResponse>("POST", "/v1/kalshi/orders", { body, idempotencyKey: idem });
    if (!created?.orderId) throw new Error("aggregator orders: submit returned no order id");
    const orderId = created.orderId;

    // the venue's final word, relayed: PENDING and SUBMITTED mean "not at the venue yet", so read
    // again; OPEN means the venue acknowledged and it rests, which an IOC never should
    let order: AggregatorKalshiOrder | null = null;
    for (let i = 0; i < this.settleReads; i += 1) {
      order = await this.order(orderId).catch(() => null);
      if (order && (AGGREGATOR_FINAL.has(order.status) || order.status === "OPEN")) break;
      if (i + 1 < this.settleReads) await this.sleep(this.settleWaitMs);
    }
    let status = (order?.status ?? created.status ?? "").toUpperCase();
    // anything not final by now is cancelled and read back, so the order never outlives this call
    if (order && !AGGREGATOR_FINAL.has(status)) {
      const cancelled = await this.cancel(orderId).catch(() => null);
      order = cancelled ?? (await this.order(orderId).catch(() => order));
      status = (order?.status ?? status).toUpperCase() || "CANCELLED";
    }

    const fill = order ? fillOfAggregatorOrder(order, capCents, sell) : fillOfSubmit(created, capCents, sell);
    // a miss is said only of an order read in a final state that shows no fill (liveHedge.orderNotReadError)
    if (fill.unitsMilli <= 0) {
      if (!AGGREGATOR_FINAL.has(status)) throw orderNotReadError("aggregator", orderId, status, order ? "it did not reach a final state and the cancel was not confirmed" : "every read of it failed");
      if (status === "FILLED") throw orderNotReadError("aggregator", orderId, status, "it reads as filled with no fill on it");
      throw new Error(`aggregator orders: order ${orderId} ${status || "unknown"} with nothing ${sell ? "sold at or over" : "filled at or under"} ${capCents}c`);
    }
    return {
      orderId,
      venueOrderId: order?.venueOrderId ?? undefined,
      unitsMilli: fill.unitsMilli,
      avgPriceMilli: sell ? Math.floor((fill.costCents * 10_000) / fill.unitsMilli) : Math.ceil((fill.costCents * 10_000) / fill.unitsMilli),
      costCents: fill.costCents,
      feesCents: fill.feesCents,
      status: status.toLowerCase() === "filled" ? "executed" : status.toLowerCase() || "unknown",
      via: "aggregator",
    };
  }

  /** The identity behind the key; a key without "trade" in its capabilities cannot send. */
  async whoami(): Promise<Whoami> {
    await this.syncClock();
    return this.request<Whoami>("GET", "/v1/whoami");
  }

  /** The pod's Kalshi cash, every Market Group summed, minus what resting buys hold; cents, floored. */
  async availableCents(): Promise<number> {
    await this.syncClock();
    const b = await this.request<{ available?: number }>("GET", "/v1/kalshi/balance");
    const usd = Number(b?.available);
    if (!Number.isFinite(usd)) throw new Error("aggregator orders: balance had no available figure");
    return Math.floor(usd * 100 + 1e-6);
  }

  async positions(ticker?: string): Promise<AggregatorKalshiPosition[]> {
    await this.syncClock();
    const b = await this.request<{ positions?: AggregatorKalshiPosition[] }>("GET", "/v1/kalshi/positions", { query: ticker ? `ticker=${encodeURIComponent(ticker)}` : "" });
    return Array.isArray(b?.positions) ? b.positions : [];
  }

  async order(orderId: string): Promise<AggregatorKalshiOrder> {
    return this.request<AggregatorKalshiOrder>("GET", `/v1/kalshi/orders/${encodeURIComponent(orderId)}`);
  }

  async fills(orderId: string): Promise<AggregatorKalshiFill[]> {
    await this.syncClock();
    const b = await this.request<{ fills?: AggregatorKalshiFill[] }>("GET", `/v1/kalshi/orders/${encodeURIComponent(orderId)}/fills`);
    return Array.isArray(b?.fills) ? b.fills : [];
  }

  /** Cancel; the partner answers with the order after. A 409 means it had already finished: read it instead. */
  async cancel(orderId: string): Promise<AggregatorKalshiOrder> {
    try {
      return await this.request<AggregatorKalshiOrder>("DELETE", `/v1/kalshi/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      if (err instanceof AggregatorApiError && err.status === 409) return this.order(orderId);
      throw err;
    }
  }

  private syncClock(): Promise<void> {
    return this.rest.syncClock();
  }

  private request<T>(method: string, path: string, o: { query?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    return this.rest.request<T>(method, path, o);
  }
}