/**
 * NOVIG ORDERS: the hedge sent to Novig with the service's own trading key, on the venue's own
 * market. The holder's play and the hedge then sit on one exchange, one rulebook, one settlement.
 *
 * Wire facts (docs.novig.com, API v3; signing as in venuePositions.ts, the trading key):
 *   POST   /v3/orders  {clientId (uuid|null), outcomeId, price "0.665", qty, tif FOK}
 *                                         -> 201 {orderId, clientId}: QUEUED, not resting and not filled
 *   GET    /v3/orders/{orderId}           -> {orderId, marketId, outcomeId, price, qty, remaining, status, tif, createdTs}
 *                                            may answer 404 right after the 201; read again
 *   DELETE /v3/orders/{orderId}           -> the order at the moment of the cancel request
 *   GET    /v3/portfolio/fills?order=<id> -> {items[{fillId, orderId, marketId, outcomeId, qty, cost, fee?, taker, ts}]}
 *   GET    /v3/account/subaccounts/{keyId}/balance -> {balance "70.00000"}  the subaccount this key trades
 *   GET    /v3/catalog/markets/{id}       -> the market with its fee rule (venuePositions.VenueClient)
 *
 * Four things shape this file:
 *
 *   1. CONTRACTS PAY ONE CENT. The venue's contract pays 1 cent; ours pays $1. One of our units is
 *      100 of its contracts, so `qty` is unitsMilli / 10, rounded up (never under-hedged). `cost`
 *      on a fill is dollars with the venue's five places: qty x price x 1 cent.
 *   2. PRICES SIT ON A GRID. Three bands: 0.001-0.050 by 0.001, 0.055-0.945 by 0.005, 0.950-0.999
 *      by 0.001. The limit is the walked worst price snapped DOWN to the grid on a buy, so the
 *      order never pays over the walk. The grid is symmetric about 0.5, so 1 - a bid on the grid
 *      is on the grid too, which is what the book reader hands over.
 *   3. THE FEE IS THE TAKER'S, WHEN CHARGED. c x P x (1 - P) per contract, P the fill price; game
 *      markets charge only once the event is live (fee.charged WHEN_LIVE), futures always. The
 *      book reader folds the fee into every level only when it applies (venueBooks.ts), so the
 *      intent's prices are all in; this file takes the fee back out to find the venue's raw limit,
 *      reading the market's fee rule at order time so a game gone live is priced as live.
 *   4. NO SELL. Every order is a buy of an outcome. To leave a hedge the writer buys the OTHER
 *      outcome of the same market: the two then settle against each other at the game, 1 cent to
 *      one of them per contract. A SELL intent here is that offset buy; its proceeds are the
 *      payout less what the offset cost, realised at settlement, not today.
 *
 * Execution: FillOrKill. The routing gate already required depth for the whole size; the order
 * fills in full at or under the limit or is rejected (an FOK that fills nothing becomes REJECTED).
 * The order is read back until terminal; a 404 straight after the 201 is read again; anything left
 * resting against expectation is cancelled. Placement needs the key holder's device to have
 * reported a location in the last 3 days and the service's address to clear the venue's network
 * check (451 otherwise); the error's code is carried onto the receipt.
 */

import { createHash } from "node:crypto";
import { actionOf, type HedgeIntent } from "./hedgeExecutor";
import { dollarsToMicro } from "./kalshiOrders";
import type { LiveOrderHook, LiveOrderResult } from "./liveHedge";
import { decimal5ToCents } from "./novigAccount";
import { signedFeeCoefficient, signedFeeMilli } from "./venueBooks";
import { VenueApiError, VenueClient, signedHeaders, type RawVenueMarket, type VenueSigner } from "./venuePositions";

export const NOVIG_FINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED"]);

export interface NovigOrder {
  orderId: string;
  clientId?: string | null;
  marketId: string;
  outcomeId: string;
  price: string;
  qty: number;
  remaining: number;
  status: string;
  tif: string;
  createdTs?: number;
}

export interface NovigFill {
  fillId: string;
  orderId: string;
  /** the order's `clientId`, when it had one (the venue's list of fills carries it) */
  clientId?: string;
  marketId: string;
  outcomeId: string;
  qty: number;
  /** dollars, five places: qty x price x 1 cent */
  cost: string;
  /** dollars; absent on an uncharged fill */
  fee?: string;
  taker: boolean;
  ts: number;
}

/** The fee rule as it applies to an order placed now. */
export interface NovigFeeNow {
  coefficient: number;
  charged: boolean;
}

// ---------------------------------------------------------------------------
// the grid and the fee, pure
// ---------------------------------------------------------------------------

/** Is this milli price one the venue takes? */
export function onNovigGrid(milli: number): boolean {
  if (!Number.isInteger(milli) || milli < 1 || milli > 999) return false;
  if (milli <= 50 || milli >= 950) return true;
  return milli % 5 === 0 && milli >= 55;
}

/** The highest grid price at or under `milli`; null under the grid's floor. */
export function snapDownToGrid(milli: number): number | null {
  const m = Math.floor(milli);
  if (m < 1) return null;
  if (m > 999) return 999;
  if (m <= 50 || m >= 950) return m;
  if (m < 55) return 50;
  return m - (m % 5);
}

/** A grid price as the wire takes it: three places, no more. */
export const gridPriceString = (milli: number): string => (milli / 1000).toFixed(3);

/** The venue's raw ask behind a fee-folded ask: the highest p with p + fee(p) at or under the effective price. */
export function rawAskMilliOf(effectiveMilli: number, fee: NovigFeeNow): number {
  if (!fee.charged) return effectiveMilli;
  for (let p = Math.min(999, effectiveMilli); p >= 1; p -= 1) {
    if (p + signedFeeMilli(fee.coefficient, p) <= effectiveMilli) return p;
  }
  return 0;
}

/** The venue's raw bid behind a fee-folded bid: the lowest b with b - fee(b) at or over the effective price. */
export function rawBidMilliOf(effectiveMilli: number, fee: NovigFeeNow): number {
  if (!fee.charged) return effectiveMilli;
  for (let b = Math.max(1, effectiveMilli); b <= 999; b += 1) {
    if (b - signedFeeMilli(fee.coefficient, b) >= effectiveMilli) return b;
  }
  return 1000;
}

/** Does the market's rule charge an order placed now? ALWAYS does; WHEN_LIVE once the event is in game; NEVER does not. */
export function feeChargedNow(fee: RawVenueMarket["fee"], statusWords: Array<string | undefined>): boolean {
  const charged = fee?.charged?.toUpperCase();
  if (!charged) return true;
  if (charged === "NEVER") return false;
  if (charged === "WHEN_LIVE" || charged === "LIVE_ONLY") return statusWords.some((s) => /IN_?GAME|LIVE/i.test(s ?? ""));
  return true;
}

/** The venue's `clientId` is a UUID; the executor's receipt id is not. The same receipt id always maps to the same UUID. */
export function novigClientId(clientOrderId: string): string {
  const h = createHash("sha256").update(clientOrderId, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5 nibble: a name-derived id
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface NovigOrderPlan {
  body: { clientId: string; outcomeId: string; price: string; qty: number; tif: "FOK" };
  /** the limit as sent, milli */
  limitMilli: number;
  /** the walked ceiling the limit was snapped from, milli, raw (fee removed) */
  ceilingMilli: number;
  /** contracts (1 cent each) */
  qty: number;
}

/**
 * The order for an intent: a buy of the hedge outcome at the walked worst price (fee removed,
 * snapped down to the grid), or the offset buy of the holder's outcome at 1 - the walked worst bid
 * (fee removed, snapped down). Pure given the fee rule.
 */
export function planNovigOrder(intent: HedgeIntent, fee: NovigFeeNow, clientOrderId: string): NovigOrderPlan {
  if (intent.venue !== "novig") throw new Error(`novig orders: intent is for ${intent.venue}`);
  const sell = actionOf(intent) === "sell";
  let outcomeId: string;
  let ceilingMilli: number;
  if (sell) {
    if (!intent.offsetInstrument) throw new Error("novig orders: an unwind needs the holder's own outcome (offsetInstrument); none on the record");
    outcomeId = intent.offsetInstrument;
    ceilingMilli = 1000 - rawBidMilliOf(intent.book.worstPriceMilli, fee);
  } else {
    outcomeId = intent.instrument;
    ceilingMilli = rawAskMilliOf(intent.book.worstPriceMilli, fee);
  }
  const limitMilli = snapDownToGrid(ceilingMilli);
  if (limitMilli === null) throw new Error(`novig orders: no grid price at or under ${gridPriceString(Math.max(0, ceilingMilli))}`);
  const qty = Math.max(1, Math.ceil(intent.unitsMilli / 10));
  return { body: { clientId: novigClientId(clientOrderId), outcomeId, price: gridPriceString(limitMilli), qty, tif: "FOK" }, limitMilli, ceilingMilli, qty };
}

/** What the fills add up to: contracts, what they cost and what fee they carried (micro dollars, exact to the venue's places). */
export function sumNovigFills(fills: NovigFill[]): { contracts: number; costMicro: number; feeMicro: number } {
  let contracts = 0;
  let costMicro = 0;
  let feeMicro = 0;
  for (const f of fills) {
    if (!Number.isInteger(f.qty) || f.qty <= 0) continue;
    contracts += f.qty;
    costMicro += Math.max(0, dollarsToMicro(f.cost, true));
    if (f.fee !== undefined && f.fee !== null) feeMicro += Math.max(0, dollarsToMicro(f.fee, true));
  }
  return { contracts, costMicro, feeMicro };
}

/** One order's fills in the trail's units: what `place` hands the executor and what a later read of the same fills must give again. */
export interface NovigFillMoney {
  unitsMilli: number;
  avgPriceMilli: number;
  /** a buy: what the contracts cost, the fee in; the offset: the net proceeds the pair pays at the game */
  costCents: number;
  feesCents: number;
}

/**
 * The money of one order from its summed fills. A buy costs what the venue charged, fee in, cents
 * rounded up. The offset (`sell`) pairs each contract of the holder's outcome with one hedge
 * contract: the pair pays 1 cent at the game, so the proceeds are that less what was paid, on at
 * most the hedge's own size, cents rounded down.
 */
export function novigFillMoney(sum: ReturnType<typeof sumNovigFills>, intentUnitsMilli: number, sell: boolean): NovigFillMoney {
  const filledMilli = sum.contracts * 10;
  const paidMicro = sum.costMicro + sum.feeMicro;
  const feesCents = Math.ceil(sum.feeMicro / 10_000);
  if (!sell) {
    const costCents = Math.ceil(paidMicro / 10_000);
    return { unitsMilli: filledMilli, avgPriceMilli: filledMilli > 0 ? Math.ceil((costCents * 10_000) / filledMilli) : 0, costCents, feesCents };
  }
  const unitsMilli = Math.min(filledMilli, intentUnitsMilli);
  const paidForUnitsMicro = filledMilli > 0 ? Math.ceil((paidMicro * unitsMilli) / filledMilli) : 0;
  const netCents = Math.max(0, Math.floor(unitsMilli / 10 - paidForUnitsMicro / 10_000));
  return { unitsMilli, avgPriceMilli: unitsMilli > 0 ? Math.floor((netCents * 10_000) / unitsMilli) : 0, costCents: netCents, feesCents };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface NovigOrderClientConfig {
  host: string;
  /** the trading key: reaches exactly one subaccount, whose balance funds the orders */
  signer: VenueSigner;
  fetchImpl?: typeof fetch;
  settleWaitMs?: number;
  settleReads?: number;
  sleep?: (ms: number) => Promise<void>;
  /** test seam: the catalog reader (market fee rules); built on the same host and key when absent */
  catalog?: Pick<VenueClient, "getMarket" | "getEvent">;
}

export class NovigOrderClient {
  readonly venue = "novig" as const;
  readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly settleWaitMs: number;
  private readonly settleReads: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly catalog: Pick<VenueClient, "getMarket" | "getEvent">;

  constructor(private readonly cfg: NovigOrderClientConfig) {
    this.host = cfg.host.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.settleWaitMs = cfg.settleWaitMs ?? 300;
    this.settleReads = cfg.settleReads ?? 8;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.catalog = cfg.catalog ?? new VenueClient({ host: this.host, signer: cfg.signer, fetchImpl: this.fetchImpl });
  }

  get keyId(): string {
    return this.cfg.signer.keyId;
  }

  /** The hook the live executor calls: a buy of the opposing outcome, or the offset that unwinds it (intent.action). */
  hook(): LiveOrderHook {
    return (intent, clientOrderId) => this.place(intent, clientOrderId);
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, query = "", body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(raw ? { "content-type": "application/json" } : {}),
      ...signedHeaders(this.cfg.signer, { method, path, query, body: raw }),
    };
    const r = await this.fetchImpl(`${this.host}${path}${query ? `?${query}` : ""}`, { method, headers, ...(raw ? { body: raw } : {}) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const b = (json ?? {}) as { code?: string; message?: string };
      throw new VenueApiError(r.status, b.code ?? `http_${r.status}`, b.message ?? `venue api ${r.status} on ${path}`);
    }
    return json as T;
  }

  /** The market's fee rule as it applies to an order placed now; the venue's standing rule when the catalog cannot be read. */
  async feeNow(marketId: string): Promise<NovigFeeNow & { source: "catalog" | "default" }> {
    try {
      const m = await this.catalog.getMarket(marketId);
      const statuses: Array<string | undefined> = [m.status];
      if (m.eventId) {
        const ev = await this.catalog.getEvent(m.eventId).catch(() => null);
        if (ev) statuses.push(ev.status);
      }
      return { coefficient: signedFeeCoefficient(m.fee), charged: feeChargedNow(m.fee, statuses), source: "catalog" };
    } catch {
      // unknown rule: charged, at the published coefficient; the limit then errs low, never over the walk
      return { coefficient: signedFeeCoefficient(undefined), charged: true, source: "default" };
    }
  }

  async place(intent: HedgeIntent, clientOrderId: string): Promise<LiveOrderResult> {
    if (!intent.marketId) throw new Error("novig orders: the intent names no market; the fee rule cannot be read");
    const sell = actionOf(intent) === "sell";
    const fee = await this.feeNow(intent.marketId);
    const plan = planNovigOrder(intent, fee, clientOrderId);
    let created: { orderId?: string };
    try {
      created = await this.call<{ orderId?: string }>("POST", "/v3/orders", "", plan.body);
    } catch (err) {
      if (err instanceof VenueApiError) throw new Error(`novig orders: the venue refused the order (${err.status} ${err.code}: ${err.message})`);
      throw err;
    }
    if (!created?.orderId) throw new Error("novig orders: submit returned no order id");
    const orderId = created.orderId;

    // the venue's final word: PENDING is queued; OPEN rests, which a fill-or-kill never should; a
    // 404 straight after the 201 is the order not yet readable
    let order: NovigOrder | null = null;
    for (let i = 0; i < this.settleReads; i += 1) {
      order = await this.order(orderId).catch(() => null);
      if (order && (NOVIG_FINAL.has(order.status.toUpperCase()) || order.status.toUpperCase() === "OPEN")) break;
      if (i + 1 < this.settleReads) await this.sleep(this.settleWaitMs);
    }
    let status = (order?.status ?? "").toUpperCase();
    if (order && !NOVIG_FINAL.has(status)) {
      const cancelled = await this.cancel(orderId).catch(() => null);
      order = cancelled ?? (await this.order(orderId).catch(() => order));
      status = (order?.status ?? status).toUpperCase() || "CANCELED";
    }

    const fills = await this.fills(orderId).catch(() => [] as NovigFill[]);
    const sum = sumNovigFills(fills);
    if (sum.contracts <= 0) {
      throw new Error(`novig orders: order ${orderId} ${status || "unread"} with nothing filled at or under ${plan.body.price} (fill or kill)${fee.source === "default" ? "; fee rule unread, taken as charged" : ""}`);
    }
    const filledMilli = sum.contracts * 10;
    const money = novigFillMoney(sum, intent.unitsMilli, sell);
    const notes: string[] = [];
    if (fee.source === "default") notes.push("fee rule unread; the limit assumed the fee charged");
    if (!sell) {
      notes.push(`${sum.contracts} contracts at ${(sum.costMicro / sum.contracts / 10_000).toFixed(3)}${sum.feeMicro > 0 ? `, fee $${(sum.feeMicro / 1_000_000).toFixed(4)}` : fee.charged ? "" : ", no fee pre-game"}`);
    } else {
      // the offset: every contract of the holder's outcome bought settles against one hedge contract
      notes.push(`offset bought: ${sum.contracts} contracts of outcome ${plan.body.outcomeId} at ${(sum.costMicro / sum.contracts / 10_000).toFixed(3)}; the pair settles at the game and the proceeds land then, not today`);
      if (filledMilli > intent.unitsMilli) notes.push(`${(filledMilli - intent.unitsMilli) / 1000} units over the hedge, a windfall if the holder's side wins`);
    }
    return {
      orderId,
      ...money,
      status: status === "FILLED" ? "executed" : status.toLowerCase() || "unknown",
      note: notes.join("; "),
    };
  }

  /** The subaccount's cash available for orders; cents, exact to the venue's figure. */
  async availableCents(): Promise<number> {
    const r = await this.call<{ balance?: string }>("GET", `/v3/account/subaccounts/${encodeURIComponent(this.keyId)}/balance`);
    if (typeof r?.balance !== "string") throw new Error("novig orders: balance had no figure");
    return decimal5ToCents(r.balance);
  }

  async order(orderId: string): Promise<NovigOrder> {
    return this.call<NovigOrder>("GET", `/v3/orders/${encodeURIComponent(orderId)}`);
  }

  /** The fills of one order. A trading key answers its own wallet bare; a management key answers per key id; both are read. */
  async fills(orderId: string): Promise<NovigFill[]> {
    const b = await this.call<unknown>("GET", "/v3/portfolio/fills", `order=${encodeURIComponent(orderId)}`);
    return flattenFills(b).filter((f) => f.orderId === orderId);
  }

  /** Cancel; the venue answers with the order as it stood at the request. A finished order answers 404 or 409: read it instead. */
  async cancel(orderId: string): Promise<NovigOrder> {
    try {
      return await this.call<NovigOrder>("DELETE", `/v3/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      if (err instanceof VenueApiError && (err.status === 404 || err.status === 409)) return this.order(orderId);
      throw err;
    }
  }
}

function flattenFills(body: unknown): NovigFill[] {
  const isFill = (x: unknown): x is NovigFill => {
    const f = x as Partial<NovigFill>;
    return Boolean(f && typeof f.orderId === "string" && Number.isInteger(f.qty) && typeof f.cost === "string");
  };
  if (!body || typeof body !== "object") return [];
  const b = body as { items?: unknown };
  if (Array.isArray(b.items)) return b.items.filter(isFill);
  const out: NovigFill[] = [];
  for (const v of Object.values(body as Record<string, unknown>)) {
    const items = Array.isArray(v) ? v : Array.isArray((v as { items?: unknown })?.items) ? ((v as { items: unknown[] }).items) : [];
    for (const f of items) if (isFill(f)) out.push(f);
  }
  return out;
}

/** The trading key and host as the service env carries them (novigAccount.NOVIG_TRADE_ENV); null when not all set. */
export function novigTradeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; keyId: string; pem: string } | null {
  const host = env.VENUE_API_HOST?.trim().replace(/\/+$/, "");
  const keyId = env.NOVIG_TRADE_KEY_ID?.trim();
  const pem = env.NOVIG_TRADE_PRIVATE_KEY_PEM?.trim();
  if (!host || !keyId || !pem) return null;
  return { host, keyId, pem };
}
