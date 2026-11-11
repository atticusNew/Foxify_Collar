/**
 * PROPHETX ORDERS: the hedge sent to ProphetX through the aggregator's execution pod, with the
 * same TRADE key that sends Kalshi orders (aggregatorOrders.ts). The pod holds the ProphetX
 * account; the key signs; the order, its fills and the position are on the partner's books under
 * the pod as well as on the venue.
 *
 * Wire facts (partner REST, ProphetX venue paths; signing as in aggregatorMarkets.ts):
 *   GET    /v1/prophetx/ladder               -> {prices: ["0.003984", ...] ascending, dollars per share, six
 *                                               decimals; source: "venue" | "fallback"}
 *   GET    /v1/prophetx/balance              -> {available}  USD the pod can place orders with
 *   GET    /v1/prophetx/positions[?strikeId=] -> {positions[{strikeId, size (shares, signed), averagePrice,
 *                                               mark, valueUsd, unrealizedPnlUsd}]}
 *   POST   /v1/prophetx/orders  Idempotency-Key: <id>
 *          {strikeId, price: "0.XXXXXX", quantity: <stake in dollars>, timeInForce: {FillOrKill: {}}, postOnly: false}
 *                                            -> {orderId, status, price, quantity, venueOrderId, ...}
 *   GET    /v1/prophetx/orders/{orderId}     -> the order: status PENDING|SUBMITTED|OPEN|FILLED|CANCELLED|REJECTED,
 *                                               filledQuantity (matched STAKE in dollars, not shares)
 *   GET    /v1/prophetx/orders/{orderId}/fills -> {fills[{fillId, venueFillId, shares, price, stakeUsd, feeUsd, occurredAt}]}
 *   DELETE /v1/prophetx/orders/{orderId}     -> the order after the cancel; a finished order comes back with its terminal status
 *
 * Three things differ from Kalshi and shape this file:
 *
 *   1. SIZE IS STAKE. The venue takes dollars, not shares: for h shares at a limit of p the stake
 *      is h x p (rounded up to the cent). A fill at a better price buys MORE shares for the same
 *      stake, never fewer, so the hedge is never short; the extra shares are a windfall the trail
 *      names. Shares come from the fills (`shares`), never from `filledQuantity`.
 *   2. PRICES SNAP TO A LADDER. The venue accepts only the prices on its ladder (American odds,
 *      rendered as dollars per share). The limit is the walked worst price snapped DOWN to the
 *      ladder on a buy, so the order never pays over the walk.
 *   3. NO SELL. A strike is one side of one market, and an order is always a buy of it. To leave
 *      a hedge the writer buys the OTHER strike of the same market: the two shares then settle
 *      against each other at the game, $1 to one of them. A SELL intent here is that offset buy;
 *      its proceeds are the $1 less what the offset cost, realised at settlement, not today. The
 *      early-close record carries that and the holder's receipt says so.
 *
 * Fees: the venue charges nothing at match (`feeUsd` 0) and 2% of net gains per market at
 * settlement (prophetx.co/t-c/trading-fees, CFTC self-certification of 2026-08-14). The pricer
 * folds that into every level before the walk (foldProphetXFee) and the fill is costed the same
 * way, so the all-in figures on both sides of the trail agree. EVENT_PROPHETX_FEE_BPS overrides
 * the rate when the venue's schedule moves.
 *
 * Execution: FillOrKill. The routing gate already required depth for the whole size; the order
 * either fills in full at or under the walk or nothing happens, which is what a hedge wants.
 * The order is read back until terminal (the partner relays the venue's answer a beat later);
 * anything the venue leaves resting against expectation is cancelled.
 */

import { AggregatorApiError } from "./aggregatorMarkets";
import { AggregatorPodRest, aggregatorClientOrderId, type AggregatorOrderClientOptions, type AggregatorTradeConfig } from "./aggregatorOrders";
import { actionOf, type HedgeIntent } from "./hedgeExecutor";
import { dollarsToMicro } from "./kalshiOrders";
import { orderNotReadError, type LiveOrderHook, type LiveOrderResult } from "./liveHedge";
import type { PmBook, PmBookLevel } from "./types";

/** The venue's published rate on net gains, bps. */
export const DEFAULT_PROPHETX_FEE_BPS = 200;

export function prophetxFeeBpsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.EVENT_PROPHETX_FEE_BPS ?? "").trim();
  if (!raw) return DEFAULT_PROPHETX_FEE_BPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 2000 ? n : DEFAULT_PROPHETX_FEE_BPS;
}

/**
 * A ProphetX book with the settlement fee folded into every level, in the pricer's milli units.
 * An ask at p costs p now and, if it wins, gives up fee x (1 - p) of the dollar: the level is
 * priced at p + that, rounded up. A bid at b (what an offset fetches, 1 - the other strike's ask)
 * gives up fee x b of its winnings: priced at b - that, rounded down. Sizes carry.
 */
export function foldProphetXFee(book: PmBook, feeBps: number): PmBook {
  const ask = (l: PmBookLevel): PmBookLevel => ({ priceMilli: Math.min(999, l.priceMilli + Math.ceil((feeBps * (1000 - l.priceMilli)) / 10_000)), sizeMilli: l.sizeMilli });
  const bid = (l: PmBookLevel): PmBookLevel => ({ priceMilli: Math.max(1, l.priceMilli - Math.ceil((feeBps * l.priceMilli) / 10_000)), sizeMilli: l.sizeMilli });
  return { ...book, asks: book.asks.map(ask), bids: book.bids.map(bid) };
}

/** The venue's raw price behind a fee-folded ask, micro dollars, floored: e = p + f(1 - p) so p = (e - f) / (1 - f). */
export function rawAskMicroOf(effectiveMilli: number, feeBps: number): number {
  const eMicro = effectiveMilli * 1000;
  return Math.max(0, Math.floor(((eMicro - feeBps * 100) * 10_000) / (10_000 - feeBps)));
}

/** The venue's raw bid behind a fee-folded bid, micro dollars, rounded up (so the offset's limit, 1 - it, rounds down): e = b(1 - f). */
export function rawBidMicroOf(effectiveMilli: number, feeBps: number): number {
  return Math.min(1_000_000, Math.ceil((effectiveMilli * 1000 * 10_000) / (10_000 - feeBps)));
}

/** The ladder as micro dollars, ascending, strictly inside (0, 1). */
export function ladderMicro(prices: string[]): number[] {
  const out: number[] = [];
  for (const p of prices) {
    const m = dollarsToMicro(p, false);
    if (m > 0 && m < 1_000_000) out.push(m);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The highest ladder price at or under `micro` plus a slack of one milli; null when the ladder has
 * nothing under it. The slack is the book's own rounding: the pricer holds levels in milli
 * (0.333333 reads as 333), so the rung the walk actually stood on can sit up to half a milli above
 * the figure handed back, and snapping strictly down would step off it onto the rung below.
 * Rungs on the venue's odds ladder sit further apart than that, so the slack never climbs a rung.
 */
export function snapDown(ladder: number[], micro: number, slackMicro = 1000): number | null {
  let best: number | null = null;
  for (const p of ladder) {
    if (p > micro + slackMicro) break;
    best = p;
  }
  return best;
}

export const PROPHETX_FINAL = new Set(["FILLED", "CANCELLED", "REJECTED"]);

export interface ProphetXOrder {
  orderId: string;
  strikeId: string;
  price: string;
  /** stake, dollars */
  quantity: number;
  postOnly: boolean;
  status: string;
  venueOrderId: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** matched stake, dollars; null before any fill */
  filledQuantity: number | null;
  timeInForce?: unknown;
  cancellationReason?: string;
}

export interface ProphetXFill {
  fillId: string;
  orderId: string;
  venueFillId: string;
  shares: string;
  price: string;
  stakeUsd: string;
  feeUsd: string;
  occurredAt: string;
}

export interface ProphetXPosition {
  strikeId: string;
  /** shares, negative when short */
  size: string;
  averagePrice: string;
  mark: string | null;
  valueUsd: string | null;
  unrealizedPnlUsd: string | null;
}

export interface ProphetXLadder {
  prices: string[];
  source: "venue" | "fallback";
}

/** micro-dollar string -> micro, rounding against the writer per `up`. */
const micro = (v: string | undefined, up: boolean): number => Math.max(0, dollarsToMicro(v, up));

/**
 * What the fills add up to: shares (milli, floored: the hedge is never overstated), stake and
 * match fees (cents, rounded up), and the share-weighted average price (micro, rounded up).
 */
export function sumProphetXFills(fills: ProphetXFill[]): { sharesMilli: number; stakeCents: number; feesCents: number; avgPriceMicro: number } {
  let sharesMicro = 0;
  let stakeMicro = 0;
  let feeMicro = 0;
  for (const f of fills) {
    sharesMicro += micro(f.shares, false);
    stakeMicro += micro(f.stakeUsd, true);
    feeMicro += micro(f.feeUsd, true);
  }
  const sharesMilli = Math.floor(sharesMicro / 1000);
  return {
    sharesMilli,
    stakeCents: Math.ceil(stakeMicro / 10_000),
    feesCents: Math.ceil(feeMicro / 10_000),
    avgPriceMicro: sharesMicro > 0 ? Math.ceil((stakeMicro * 1_000_000) / sharesMicro) : 0,
  };
}

/** The settlement fee a buy's shares owe if they win: fee x (shares - stake), cents rounded up. Nothing is charged when they lose. */
export function gainFeeCents(sum: { sharesMilli: number; stakeCents: number }, feeBps: number): number {
  const gainCents = Math.max(0, Math.floor(sum.sharesMilli / 10) - sum.stakeCents);
  return Math.ceil((gainCents * feeBps) / 10_000);
}

/**
 * The all-in cost of a buy as the pricer counts it: the stake, the match fee, and the settlement
 * fee on the gain the shares would make (fee x (shares - stake)), cents rounded up.
 */
export function buyCostCents(sum: { sharesMilli: number; stakeCents: number; feesCents: number }, feeBps: number): number {
  return sum.stakeCents + sum.feesCents + gainFeeCents(sum, feeBps);
}

/** One order's fills in the trail's units: what `place` hands the executor and what a later read of the same fills must give again. */
export interface ProphetXFillMoney {
  unitsMilli: number;
  avgPriceMilli: number;
  /** a buy: all in, the settlement fee provided for; the offset: the net proceeds the pair pays at the game */
  costCents: number;
  feesCents: number;
  /** a buy only: the part of `costCents` charged at settlement and only on a win */
  settlementProvisionCents?: number;
}

/**
 * The money of one order from its summed fills. A buy costs the stake, the match fee and the
 * settlement fee provided for. The offset (`sell`) pairs each share of the holder's strike with
 * one hedge share: its proceeds are the dollar less the price paid, less the fee on that gain,
 * realised at the game, on at most the hedge's own size.
 */
export function prophetxFillMoney(sum: ReturnType<typeof sumProphetXFills>, intentUnitsMilli: number, sell: boolean, feeBps: number): ProphetXFillMoney {
  if (!sell) {
    const costCents = buyCostCents(sum, feeBps);
    return {
      unitsMilli: sum.sharesMilli,
      avgPriceMilli: sum.sharesMilli > 0 ? Math.ceil((costCents * 10_000) / sum.sharesMilli) : 0,
      costCents,
      feesCents: sum.feesCents,
      settlementProvisionCents: gainFeeCents(sum, feeBps),
    };
  }
  const unitsMilli = Math.min(sum.sharesMilli, intentUnitsMilli);
  const perShareMicro = Math.max(0, 1_000_000 - sum.avgPriceMicro);
  const grossCents = Math.floor((unitsMilli * perShareMicro) / 10_000_000);
  const settlementFeeCents = Math.ceil((grossCents * feeBps) / 10_000);
  const netCents = Math.max(0, grossCents - sum.feesCents - settlementFeeCents);
  return {
    unitsMilli,
    avgPriceMilli: unitsMilli > 0 ? Math.floor((netCents * 10_000) / unitsMilli) : 0,
    costCents: netCents,
    feesCents: sum.feesCents + settlementFeeCents,
  };
}

export interface ProphetXOrderPlan {
  body: Record<string, unknown>;
  /** the limit as sent, micro dollars */
  limitMicro: number;
  /** the walked ceiling the limit was snapped from, micro dollars (raw, fee removed) */
  ceilingMicro: number;
  stakeCents: number;
  ladderSource: ProphetXLadder["source"];
}

export interface ProphetXOrderClientOptions extends AggregatorOrderClientOptions {
  feeBps?: number;
  /** how long one ladder read serves, ms */
  ladderTtlMs?: number;
}

export class ProphetXOrderClient {
  readonly venue = "prophetx" as const;
  readonly via = "aggregator" as const;
  readonly rest: AggregatorPodRest;
  readonly feeBps: number;
  private readonly settleWaitMs: number;
  private readonly settleReads: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ladderTtlMs: number;
  private readonly nowMs: () => number;
  private ladderCache: { at: number; ladder: ProphetXLadder; micro: number[] } | null = null;

  constructor(
    private readonly cfg: AggregatorTradeConfig,
    opts: ProphetXOrderClientOptions = {},
  ) {
    this.rest = opts.rest ?? new AggregatorPodRest(cfg, opts);
    this.feeBps = opts.feeBps ?? prophetxFeeBpsFromEnv();
    this.settleWaitMs = opts.settleWaitMs ?? 300;
    this.settleReads = opts.settleReads ?? 8;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ladderTtlMs = opts.ladderTtlMs ?? 5 * 60_000;
    this.nowMs = opts.nowSec ? () => opts.nowSec!() * 1000 : () => Date.now();
  }

  get publicKeyHex(): string {
    return this.rest.signer.publicKeyHex;
  }

  get keyId(): string {
    return this.cfg.keyId;
  }

  /** The hook the live executor calls: a buy of the opposing strike, or the offset that unwinds it (intent.action). */
  hook(): LiveOrderHook {
    return (intent, clientOrderId) => this.place(intent, clientOrderId);
  }

  /** The venue's ladder, read at most once per TTL. */
  async ladder(force = false): Promise<{ ladder: ProphetXLadder; micro: number[] }> {
    const now = this.nowMs();
    if (!force && this.ladderCache && now - this.ladderCache.at < this.ladderTtlMs) return this.ladderCache;
    await this.rest.syncClock();
    const l = await this.rest.request<ProphetXLadder>("GET", "/v1/prophetx/ladder");
    const prices = Array.isArray(l?.prices) ? l.prices : [];
    const m = ladderMicro(prices);
    if (m.length === 0) throw new Error("prophetx orders: the ladder came back empty");
    this.ladderCache = { at: now, ladder: { prices, source: l.source === "fallback" ? "fallback" : "venue" }, micro: m };
    return this.ladderCache;
  }

  /**
   * The order for an intent against a ladder: a buy of the hedge strike at the walked worst price
   * (fee removed, snapped down), or the offset buy of the holder's strike at 1 - the walked worst
   * bid (fee removed, snapped down). Stake is shares x limit, cents rounded up. Pure given the ladder.
   */
  static plan(intent: HedgeIntent, ladder: number[], feeBps: number, ladderSource: ProphetXLadder["source"] = "venue"): ProphetXOrderPlan {
    if (intent.venue !== "prophetx") throw new Error(`prophetx orders: intent is for ${intent.venue}`);
    const sell = actionOf(intent) === "sell";
    let strikeId: string;
    let ceilingMicro: number;
    if (sell) {
      if (!intent.offsetInstrument) throw new Error("prophetx orders: an unwind needs the holder's side's strike (offsetInstrument); none on the record");
      strikeId = intent.offsetInstrument;
      ceilingMicro = 1_000_000 - rawBidMicroOf(intent.book.worstPriceMilli, feeBps);
    } else {
      strikeId = intent.instrument;
      ceilingMicro = rawAskMicroOf(intent.book.worstPriceMilli, feeBps);
    }
    const limitMicro = snapDown(ladder, ceilingMicro);
    if (limitMicro === null) throw new Error(`prophetx orders: no ladder price at or under ${(ceilingMicro / 1_000_000).toFixed(6)}`);
    // shares (milli) x price (micro) = 1e9 per dollar; cents round up so the stake buys at least the shares
    const stakeCents = Math.max(1, Math.ceil((intent.unitsMilli * limitMicro) / 10_000_000));
    return {
      body: {
        strikeId,
        price: (limitMicro / 1_000_000).toFixed(6),
        quantity: stakeCents / 100,
        timeInForce: { FillOrKill: {} },
        postOnly: false,
      },
      limitMicro,
      ceilingMicro,
      stakeCents,
      ladderSource,
    };
  }

  async place(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    const sell = actionOf(intent) === "sell";
    const { ladder, micro: ladderMicros } = await this.ladder();
    const plan = ProphetXOrderClient.plan(intent, ladderMicros, this.feeBps, ladder.source);
    const idem = aggregatorClientOrderId(clientOrderId);
    const created = await this.rest.request<Partial<ProphetXOrder>>("POST", "/v1/prophetx/orders", { body: plan.body, idempotencyKey: idem });
    if (!created?.orderId) throw new Error("prophetx orders: submit returned no order id");
    const orderId = created.orderId;

    // the venue's final word, relayed: PENDING and SUBMITTED mean not settled yet; OPEN means it
    // rests, which a fill-or-kill never should
    let order: ProphetXOrder | null = null;
    for (let i = 0; i < this.settleReads; i += 1) {
      order = await this.order(orderId).catch(() => null);
      if (order && (PROPHETX_FINAL.has(order.status) || order.status === "OPEN")) break;
      if (i + 1 < this.settleReads) await this.sleep(this.settleWaitMs);
    }
    let status = (order?.status ?? created.status ?? "").toUpperCase();
    if (order && !PROPHETX_FINAL.has(status)) {
      const cancelled = await this.cancel(orderId).catch(() => null);
      order = cancelled ?? (await this.order(orderId).catch(() => order));
      status = (order?.status ?? status).toUpperCase() || "CANCELLED";
    }

    const fills = await this.fills(orderId).catch(() => null);
    const sum = sumProphetXFills(fills ?? []);
    // a miss is said only of an order read in a final state with nothing matched on it (liveHedge.orderNotReadError)
    if (sum.sharesMilli <= 0) {
      if (!order) throw orderNotReadError("prophetx", orderId, status, "every read of it failed");
      if (!PROPHETX_FINAL.has(status)) throw orderNotReadError("prophetx", orderId, status, "it did not reach a final state and the cancel was not confirmed");
      const matched = status === "FILLED" || (order.filledQuantity ?? 0) > 0;
      if (matched) throw orderNotReadError("prophetx", orderId, status, fills ? "the order shows a match and no fill was listed" : "the order shows a match and its fills could not be read");
      throw new Error(`prophetx orders: order ${orderId} ${status || "unknown"} with nothing filled at or under ${(plan.limitMicro / 1_000_000).toFixed(6)} (fill or kill)${plan.ladderSource === "fallback" ? "; ladder served from the partner's last known set" : ""}`);
    }
    const notes: string[] = [];
    if (plan.ladderSource === "fallback") notes.push("ladder served from the partner's last known set");
    const money = prophetxFillMoney(sum, intent.unitsMilli, sell, this.feeBps);
    if (!sell) {
      if (sum.sharesMilli > intent.unitsMilli) notes.push(`${((sum.sharesMilli - intent.unitsMilli) / 1000).toFixed(3)} shares over the size, bought by the same stake at a better price`);
      notes.push(`stake $${(sum.stakeCents / 100).toFixed(2)} at ${(sum.avgPriceMicro / 1_000_000).toFixed(6)}; ${this.feeBps / 100}% of the gain provided for at settlement`);
    } else {
      // the offset: every share of the holder's strike bought settles against one hedge share
      notes.push(`offset bought: ${(sum.sharesMilli / 1000).toFixed(3)} shares of strike ${plan.body.strikeId as string} at ${(sum.avgPriceMicro / 1_000_000).toFixed(6)}, stake $${(sum.stakeCents / 100).toFixed(2)}; the pair settles at the game and the proceeds land then, not today`);
      if (sum.sharesMilli > intent.unitsMilli) notes.push(`${((sum.sharesMilli - intent.unitsMilli) / 1000).toFixed(3)} shares over the hedge, a windfall if the holder's side wins`);
    }
    return {
      orderId,
      venueOrderId: order?.venueOrderId ?? created.venueOrderId ?? undefined,
      ...money,
      status: status === "FILLED" ? "executed" : status.toLowerCase() || "unknown",
      via: "aggregator",
      note: notes.join("; "),
    };
  }

  /** The pod's ProphetX cash available for orders; cents, floored. */
  async availableCents(): Promise<number> {
    await this.rest.syncClock();
    const b = await this.rest.request<{ available?: number }>("GET", "/v1/prophetx/balance");
    const usd = Number(b?.available);
    if (!Number.isFinite(usd)) throw new Error("prophetx orders: balance had no available figure");
    return Math.floor(usd * 100 + 1e-6);
  }

  async positions(strikeId?: string): Promise<ProphetXPosition[]> {
    await this.rest.syncClock();
    const b = await this.rest.request<{ positions?: ProphetXPosition[] }>("GET", "/v1/prophetx/positions", { query: strikeId ? `strikeId=${encodeURIComponent(strikeId)}` : "" });
    return Array.isArray(b?.positions) ? b.positions : [];
  }

  async order(orderId: string): Promise<ProphetXOrder> {
    return this.rest.request<ProphetXOrder>("GET", `/v1/prophetx/orders/${encodeURIComponent(orderId)}`);
  }

  async fills(orderId: string): Promise<ProphetXFill[]> {
    const b = await this.rest.request<{ fills?: ProphetXFill[] }>("GET", `/v1/prophetx/orders/${encodeURIComponent(orderId)}/fills`);
    return Array.isArray(b?.fills) ? b.fills : [];
  }

  /** Cancel; the partner answers with the order after, terminal status included when it had already finished. */
  async cancel(orderId: string): Promise<ProphetXOrder> {
    try {
      return await this.rest.request<ProphetXOrder>("DELETE", `/v1/prophetx/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      if (err instanceof AggregatorApiError && err.status === 409) return this.order(orderId);
      throw err;
    }
  }
}
