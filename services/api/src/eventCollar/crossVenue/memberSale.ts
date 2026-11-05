/**
 * MEMBER SALE: the lock on the member-app venue, as arithmetic and as an order.
 *
 * A collar on a binary contract is a partial sale. Floor = what k contracts fetch into the bid now;
 * cap = that plus $1 on each of the N - k still riding. On a venue where the member's own account
 * is connected (memberApp.ts) the service does exactly that and nothing else: it walks the market's
 * own bids for the size, sends ONE limit sell at the walked worst price for the member, waits a
 * few seconds, cancels whatever did not fill, and writes what the venue confirmed. No counterparty
 * of ours, no hedge, no capital, no credit paid, no take. The cash is in the member's balance the
 * moment the fills print.
 *
 * Tiers are how much is sold: Max upside 40%, Balanced 60%, Max floor 80% of the position, whole
 * contracts (the venue refuses fractions), never more than the bids can take. The floor shown is
 * the walked fills floored to the cent: rounding never lands on the floor's side.
 *
 * Leave early is the mirror: the sold contracts bought back from the offers with one limit buy at
 * the walked worst price. Both are pure functions over the venue's book until `executeLimitOrder`,
 * which is the only thing here that sends anything, and it sends for the member, under the
 * member's own consent, inside the member's own account.
 *
 * A combination (parlay) ticket has no resting book. There the bid comes from the venue's
 * request-for-quote (`requestRfqBid`): one quote on the largest tier's size, read as a single
 * level, so the same tier arithmetic and the same record apply; the lock accepts the quote
 * (`acceptRfq`) and the fill posts as an order, read like any sale. Off unless the service turns
 * it on: the venue has not shipped the quote path, and its shape here is assumed.
 */

import type { ProtectionTier } from "./types";
import { PROTECTION_TIERS, roundContracts } from "./types";
import type { RawOutcomeMarket } from "./venueMarkets";
import { outcomeMaxPrice } from "./venueBooks";
import { LIVE_ORDER_STATUSES, MemberApiError, PENDING_RFQ_STATUSES, QUOTED_RFQ_STATUSES, type MemberClient, type PlaceOrderBody, type RawMemberFill, type RawMemberOrder, type RawMemberRfq, type RfqRequestBody } from "./memberApp";
import type { MemberBuyBackRecord, MemberSaleRecord } from "./shadowLedger";
import type { RuleCells, TailTerm } from "./hedgeRouting";

/** the share of the position each tier sells */
export const SALE_SHARE: Record<ProtectionTier, number> = { wide: 0.4, balanced: 0.6, tight: 0.8 };

/** one level of the venue's book as the member trades it: dollars per contract, contracts */
export interface VenueLevel {
  price: number;
  quantity: number;
}

const levelsOf = (raw: RawOutcomeMarket["bids"], maxPrice: number): VenueLevel[] => {
  const out: VenueLevel[] = [];
  for (const l of raw ?? []) {
    const price = Number(l?.price);
    const quantity = Number(l?.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || price >= maxPrice || quantity <= 0) continue;
    out.push({ price, quantity });
  }
  return out;
};

/** the market's bids, best (highest) first: what a sale walks */
export const bidLevels = (m: RawOutcomeMarket): VenueLevel[] => levelsOf(m.bids, outcomeMaxPrice(m)).sort((a, b) => b.price - a.price);
/** the market's offers, best (lowest) first: what a buy-back walks */
export const askLevels = (m: RawOutcomeMarket): VenueLevel[] => levelsOf(m.offers, outcomeMaxPrice(m)).sort((a, b) => a.price - b.price);

/** dollars to whole cents, down (what the member is told they get) or up (what they are told they pay) */
const centsDown = (dollars: number): number => Math.floor(dollars * 100 + 1e-6);
const centsUp = (dollars: number): number => Math.ceil(dollars * 100 - 1e-6);

export interface BookWalk {
  /** whole contracts the levels cover, up to what was wanted */
  contracts: number;
  /** the last level taken, dollars */
  worstPrice: number;
  /** cash across the fills, dollars */
  gross: number;
  /** fewer than wanted: the book ran out */
  depthLimited: boolean;
}

/** Walk `levels` (best first) for up to `want` whole contracts. Null when the book has none. */
export function walkLevels(levels: VenueLevel[], want: number): BookWalk | null {
  let left = Math.floor(want);
  let gross = 0;
  let worst = 0;
  let taken = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const q = Math.min(left, Math.floor(l.quantity));
    if (q <= 0) continue;
    gross += q * l.price;
    worst = l.price;
    taken += q;
    left -= q;
  }
  if (taken === 0) return null;
  return { contracts: taken, worstPrice: worst, gross, depthLimited: taken < Math.floor(want) };
}

export interface SaleTierQuote {
  tier: ProtectionTier;
  /** venue contracts sold and kept (the venue's own unit; ours when max_price is $1) */
  soldContracts: number;
  keptContracts: number;
  /** the walked worst price, as the limit the order goes in at, cents of a dollar */
  limitPriceCents: number;
  avgPriceCents: number;
  /** what the walked fills pay, cents, floored; the floor */
  cashNowCents: number;
  floorTotalCents: number;
  /** cash now plus max_price on every riding contract */
  capTotalCents: number;
  depthLimited: boolean;
}

export interface SaleQuoteInputs {
  /** the member's position, venue contracts (whole contracts are sold; a fraction stays) */
  positionContracts: number;
  maxPrice: number;
  bids: VenueLevel[];
}

/** The three shapes, each as the bids fund it now; a tier the book cannot fund at all is null. */
export function quoteSaleTiers(i: SaleQuoteInputs): Record<ProtectionTier, SaleTierQuote | null> {
  const N = Math.floor(i.positionContracts);
  const out = {} as Record<ProtectionTier, SaleTierQuote | null>;
  for (const tier of PROTECTION_TIERS) {
    const want = N >= 1 ? Math.max(1, Math.floor(N * SALE_SHARE[tier])) : 0;
    const walk = want > 0 ? walkLevels(i.bids, want) : null;
    if (!walk) {
      out[tier] = null;
      continue;
    }
    const cash = centsDown(walk.gross);
    const kept = N - walk.contracts;
    out[tier] = {
      tier,
      soldContracts: walk.contracts,
      keptContracts: kept,
      limitPriceCents: Math.floor(walk.worstPrice * 100 + 1e-6),
      avgPriceCents: Math.floor((walk.gross / walk.contracts) * 100 + 1e-6),
      cashNowCents: cash,
      floorTotalCents: cash,
      capTotalCents: cash + centsDown(kept * i.maxPrice),
      depthLimited: walk.depthLimited,
    };
  }
  return out;
}

export interface BuyBackQuote {
  /** venue contracts to buy back (the ones sold) and how many the offers can fill */
  wantContracts: number;
  contracts: number;
  limitPriceCents: number;
  avgPriceCents: number;
  /** what the walked fills cost, cents, rounded up */
  costCents: number;
  depthLimited: boolean;
}

/** The sold contracts bought back from the offers. Null when the offers are empty. */
export function quoteBuyBack(asks: VenueLevel[], want: number, maxPrice: number): BuyBackQuote | null {
  const walk = walkLevels(asks, want);
  if (!walk) return null;
  // the limit must stay strictly under max_price: a book priced at the ceiling is not bought
  const limitCents = Math.min(Math.ceil(walk.worstPrice * 100 - 1e-6), Math.round(maxPrice * 100) - 1);
  return {
    wantContracts: Math.floor(want),
    contracts: walk.contracts,
    limitPriceCents: limitCents,
    avgPriceCents: Math.ceil((walk.gross / walk.contracts) * 100 - 1e-6),
    costCents: centsUp(walk.gross),
    depthLimited: walk.depthLimited,
  };
}

/** The venue's price string: dollars to two places (the venue takes at most two). */
export const priceString = (cents: number): string => (cents / 100).toFixed(2);

/** How far under the mark the sale is, in bps of the whole position's value at the mark; the record's evCostBps for this route. */
export function saleEvCostBps(q: Pick<SaleTierQuote, "soldContracts" | "cashNowCents">, positionContracts: number, maxPrice: number, markCents: number): number {
  const value = positionContracts * maxPrice * markCents;
  if (!(value > 0)) return 0;
  return Math.round(((q.soldContracts * maxPrice * markCents - q.cashNowCents) * 10_000) / value);
}

// ---------------------------------------------------------------------------
// execution: one limit order, a short wait, a cancel, the fills
// ---------------------------------------------------------------------------

export interface OrderOutcome {
  order: RawMemberOrder | null;
  orderId: string | null;
  status: string;
  /** venue contracts filled */
  filled: number;
  avgPriceCents: number;
  /** the fills' money, cents: floored for a sell (the member's cash), rounded up for a buy (their cost) */
  grossCents: number;
  feeCents?: number;
  fills: RawMemberFill[];
  /** what happened, in words for the receipt */
  note: string;
}

export interface ExecuteOptions {
  /** how long the order may rest before the rest is cancelled, ms (default 3000) */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Place the order, wait for it (polling), cancel the remainder, read the fills. A placement whose
 * answer was lost is looked up by the client order id and never sent twice. The fills are the
 * truth: an order can still fill while the cancel is in flight.
 */
export async function executeLimitOrder(client: MemberClient, body: PlaceOrderBody, opts: ExecuteOptions = {}): Promise<OrderOutcome> {
  const waitMs = opts.waitMs ?? 3000;
  const pollMs = opts.pollMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let order: RawMemberOrder;
  try {
    order = await client.placeOrder(body);
  } catch (err) {
    if (err instanceof MemberApiError && err.status > 0 && err.status < 500) throw err;
    // the venue may have the order: find it by our id before anything else
    const found = await client.orderByClientId(body.client_order_id).catch(() => null);
    if (!found) throw err;
    order = found;
  }
  const want = Number(body.quantity);
  const started = now();
  let cur = order;
  while (LIVE_ORDER_STATUSES.has(cur.status) && Number(cur.filled ?? 0) < want && now() - started < waitMs) {
    await sleep(pollMs);
    try {
      cur = await client.order(order.id);
    } catch {
      // a read that fails leaves the last answer; the loop ends on time
    }
  }
  let cancelled: string | null = null;
  if (LIVE_ORDER_STATUSES.has(cur.status) && Number(cur.filled ?? 0) < want) {
    try {
      const c = await client.cancelOrder(order.id);
      cancelled = c.status ?? "cancelled";
    } catch (err) {
      cancelled = `cancel refused (${err instanceof MemberApiError ? err.code : "error"})`;
    }
    try {
      cur = await client.order(order.id);
    } catch {
      // the fills below are what count
    }
  }
  const o = await outcomeFromFills(client, order, cur, body.action === "sell", body.price);
  const status = o.status;
  const note =
    o.filled === 0
      ? `nothing filled at ${body.price} within ${Math.round(waitMs / 1000)}s; the order was ${cancelled ? "cancelled" : status}`
      : o.filled < want
        ? `${o.filled} of ${want} filled at ${body.price} or better; the rest ${cancelled ? "cancelled" : status}`
        : `${o.filled} filled at ${body.price} or better`;
  return { ...o, note };
}

/** The fills are the truth: read them for the order, the order's own figures standing in when the fills read is empty. */
async function outcomeFromFills(client: MemberClient, order: RawMemberOrder, cur: RawMemberOrder, sell: boolean, fallbackPrice: string): Promise<Omit<OrderOutcome, "note">> {
  let fills: RawMemberFill[] = [];
  try {
    fills = await client.fills([order.id]);
  } catch {
    fills = [];
  }
  let filled = 0;
  let gross = 0;
  let fee = 0;
  let feeKnown = false;
  for (const f of fills) {
    const q = Number(f.filled);
    const p = Number(f.price);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0) continue;
    filled += q;
    gross += q * p;
    if (f.trade_fee !== null && f.trade_fee !== undefined && Number.isFinite(Number(f.trade_fee))) {
      fee += Number(f.trade_fee);
      feeKnown = true;
    }
  }
  if (filled === 0 && Number(cur.filled ?? 0) > 0) {
    // the fills read came back empty but the order says it filled: the order's own figures stand in
    filled = Number(cur.filled);
    gross = filled * Number(cur.avg_price ?? fallbackPrice);
  }
  const avg = filled > 0 ? gross / filled : 0;
  return {
    order: cur,
    orderId: order.id,
    status: cur.status ?? order.status,
    filled,
    avgPriceCents: filled > 0 ? (sell ? Math.floor(avg * 100 + 1e-6) : Math.ceil(avg * 100 - 1e-6)) : 0,
    grossCents: sell ? centsDown(gross) : centsUp(gross),
    ...(feeKnown ? { feeCents: Math.round(fee * 100) } : {}),
    fills,
  };
}

// ---------------------------------------------------------------------------
// a combination ticket: the bid from the venue's request for quote
// ---------------------------------------------------------------------------

/** The venue's quote as the tier arithmetic reads it: one bid level, or none. */
export interface RfqBid {
  rfq: RawMemberRfq;
  /** per contract, dollars; the level the tiers walk */
  level: VenueLevel | null;
  /** why there is no level: the venue declined, the quote lapsed, or no price came in time */
  reason: "declined" | "expired" | "unpriced" | null;
  expiresAtIso: string | null;
}

/**
 * Ask for a bid on `body.quantity` contracts and wait (polling) for the venue to price it. The
 * quote is read as one bid level at the price and the size the makers will take, so the tiers
 * walk it like a book: a maker taking fewer than asked is a depth-limited tier, as on a thin book.
 */
export async function requestRfqBid(client: MemberClient, body: RfqRequestBody, maxPrice: number, opts: ExecuteOptions = {}): Promise<RfqBid> {
  const waitMs = opts.waitMs ?? 3000;
  const pollMs = opts.pollMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let cur = await client.requestRfq(body);
  const started = now();
  const priced = (q: RawMemberRfq) => q.price !== null && q.price !== undefined && Number.isFinite(Number(q.price)) && !PENDING_RFQ_STATUSES.has(q.status);
  while (!priced(cur) && PENDING_RFQ_STATUSES.has(cur.status) && now() - started < waitMs) {
    await sleep(pollMs);
    try {
      cur = await client.rfq(cur.id);
    } catch {
      // a read that fails leaves the last answer; the loop ends on time
    }
  }
  const expiresAtIso = cur.expires_at ? new Date(cur.expires_at).toISOString() : null;
  const status = (cur.status ?? "").toLowerCase();
  if (/declin|reject|refus/.test(status)) return { rfq: cur, level: null, reason: "declined", expiresAtIso };
  if (/expir|lapse/.test(status) || (expiresAtIso && Date.parse(expiresAtIso) <= now())) return { rfq: cur, level: null, reason: "expired", expiresAtIso };
  if (!priced(cur) || !(QUOTED_RFQ_STATUSES.has(status) || !PENDING_RFQ_STATUSES.has(status))) return { rfq: cur, level: null, reason: "unpriced", expiresAtIso };
  const level = levelsOf([{ price: String(cur.price), quantity: String(cur.quantity ?? body.quantity) }], maxPrice)[0] ?? null;
  return { rfq: cur, level, reason: level ? null : "unpriced", expiresAtIso };
}

/**
 * Accept the quote for `quantity` at its price. The venue answers with the order the fill posted
 * as; the fills are read for it like any sale (the fill may be smaller than the quote: a partial).
 */
export async function acceptRfq(client: MemberClient, bid: RfqBid, quantity: number): Promise<OrderOutcome> {
  if (!bid.level) throw new MemberApiError(0, "rfq_unpriced", "the quote carries no price to accept");
  const price = bid.level.price.toFixed(2);
  const order = await client.acceptRfq(bid.rfq.id, { quantity: String(quantity), price });
  let cur = order;
  if (LIVE_ORDER_STATUSES.has(cur.status) && Number(cur.filled ?? 0) < quantity) {
    try {
      cur = await client.order(order.id);
    } catch {
      // the fills below are what count
    }
  }
  const o = await outcomeFromFills(client, order, cur, true, price);
  const note = o.filled === 0 ? `the quote at ${price} was accepted but nothing filled; the order was ${o.status}` : o.filled < quantity ? `${o.filled} of ${quantity} filled at ${price} on the quote` : `${o.filled} filled at ${price} on the quote`;
  return { ...o, note };
}

// ---------------------------------------------------------------------------
// the records
// ---------------------------------------------------------------------------

/** The sale as the ledger keeps it, from what the venue filled. Contracts in our $1 units. */
export function saleRecordOf(o: OrderOutcome, p: { marketId: string; positionContracts: number; maxPrice: number; limitPriceCents: number; clientOrderId: string; requested: number }): MemberSaleRecord {
  const sold = roundContracts(o.filled * p.maxPrice);
  const kept = roundContracts(p.positionContracts * p.maxPrice - sold);
  return {
    marketId: p.marketId,
    maxPriceCents: Math.round(p.maxPrice * 100),
    soldContracts: sold,
    keptContracts: kept,
    limitPriceCents: p.limitPriceCents,
    avgPriceCents: o.avgPriceCents,
    cashNowCents: o.grossCents,
    ...(o.feeCents !== undefined ? { feeCents: o.feeCents } : {}),
    floorTotalCents: o.grossCents,
    capTotalCents: o.grossCents + Math.floor(kept * 100 + 1e-6),
    orderId: o.orderId,
    clientOrderId: p.clientOrderId,
    status: o.status,
    requestedContracts: roundContracts(p.requested * p.maxPrice),
  };
}

export function buyBackRecordOf(o: OrderOutcome, p: { maxPrice: number; limitPriceCents: number; clientOrderId: string; requested: number }): MemberBuyBackRecord {
  return {
    requestedContracts: roundContracts(p.requested * p.maxPrice),
    boughtContracts: roundContracts(o.filled * p.maxPrice),
    limitPriceCents: p.limitPriceCents,
    avgPriceCents: o.avgPriceCents,
    costCents: o.grossCents,
    ...(o.feeCents !== undefined ? { feeCents: o.feeCents } : {}),
    orderId: o.orderId,
    clientOrderId: p.clientOrderId,
    status: o.status,
  };
}

/**
 * The tails in the member's own words. The sold contracts are sold whatever happens; the venue's
 * tail rules touch only the contracts still riding, and the member's own account pays them.
 */
export function memberTailTerms(venueName: string, rules: RuleCells, kept: number): TailTerm[] {
  const riding = `your ${kept} riding contract${kept === 1 ? "" : "s"}`;
  const sold = "The contracts you sold stay sold.";
  const settles = (t: RuleCells[keyof RuleCells]["treatment"], what: string): string => {
    switch (t) {
      case "half":
        return `${what}, ${venueName} settles ${riding} at half (50¢ each, before fees). ${sold}`;
      case "void":
        return `${what}, ${venueName} voids ${riding} and settles them back at what you paid, by its own rules. ${sold}`;
      case "fair":
        return `${what}, ${venueName} settles ${riding} at the fair price when the news broke. ${sold}`;
      case "hold":
        return `${what}, ${venueName} keeps the market open and ${riding} wait for the game. ${sold}`;
      case "stands":
        return `${what}, ${venueName} settles ${riding} on the result as first announced. ${sold}`;
      case "resettle":
        return `${what}, ${venueName} settles ${riding} again on the corrected result. ${sold}`;
    }
  };
  const p = rules.postponed;
  const postponedWhat = p.treatment === "hold" ? "If the game is postponed" : "If the game is postponed past the venue's window";
  return [
    { branch: "tie", text: settles(rules.tie.treatment, "If the game ends in a tie") },
    { branch: "postponed", text: settles(p.treatment, postponedWhat) },
    { branch: "abandoned", text: settles(rules.abandoned.treatment, "If the game is called off without an official result") },
    { branch: "corrected", text: settles(rules.corrected.treatment, "If the league later corrects the result") },
  ];
}
