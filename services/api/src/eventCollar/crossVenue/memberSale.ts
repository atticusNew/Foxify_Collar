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
 *
 * THE NUMBERS ARE INTEGERS. The venue's decimal strings are read digit by digit (exactDecimal.ts),
 * never through a float: a price is micro-dollars per contract (1_000_000 = $1, so the venue's
 * four-decimal grid has two digits to spare), a size is milli-contracts (1000 = one contract),
 * money is whole cents. Every division that lands on cents goes against the member's figure:
 *   - cash from a sale (the floor), its average and its limit price: down;
 *   - the cap: the floor plus max_price on each riding contract, that product down, so at $1 a
 *     contract floor + riding x 100 cents = cap exactly;
 *   - the cost of a buy-back, its average and its limit price: up (the limit capped a cent under
 *     max_price); a venue fee: up.
 * A quote is an estimate from the book as it stood. The record is summed from the venue's own
 * fills, which ride on it as the venue wrote them.
 */

import type { ProtectionTier } from "./types";
import { PROTECTION_TIERS, contractHundredths } from "./types";
import type { RawOutcomeMarket } from "./venueMarkets";
import { MICRO_PER_CENT, MICRO_PER_DOLLAR, MILLI_PER_CONTRACT, centsToDollarString, decimalUnits, divBig, divInt, mulDiv, readDecimal, type Rounding } from "./exactDecimal";
import { LIVE_ORDER_STATUSES, MemberApiError, PENDING_RFQ_STATUSES, QUOTED_RFQ_STATUSES, maxPriceMicroOf, type MemberClient, type PlaceOrderBody, type RawMemberFill, type RawMemberOrder, type RawMemberRfq, type RfqRequestBody } from "./memberApp";
import type { MemberBuyBackRecord, MemberSaleRecord, MemberVenueFill } from "./shadowLedger";
import type { RuleCells, TailTerm } from "./hedgeRouting";

/** the share of the position each tier sells, whole percent */
export const SALE_SHARE_PERCENT: Record<ProtectionTier, number> = { wide: 40, balanced: 60, tight: 80 };

/** The whole contracts a tier sells of a position of `positionContracts` venue contracts: the share rounded down, at least one. */
export function tierSaleContracts(positionContracts: number, tier: ProtectionTier): number {
  const N = Math.floor(positionContracts);
  return N >= 1 ? Math.max(1, divInt(N * SALE_SHARE_PERCENT[tier], 100, "down")) : 0;
}

/** one level of the venue's book as the member trades it: micro-dollars per contract (1_000_000 = $1), milli-contracts (1000 = one contract) */
export interface VenueLevel {
  priceMicro: number;
  quantityMilli: number;
}

/**
 * One level from the venue's own strings. A digit finer than the unit goes against the member: a
 * bid's price down, an offer's up, a size down. Null when unreadable, empty, or priced outside
 * (0, max_price).
 */
export function venueLevelOf(price: unknown, quantity: unknown, maxPriceMicro: number, side: "bid" | "offer"): VenueLevel | null {
  const priceMicro = decimalUnits(price, 6, side === "bid" ? "down" : "up");
  const quantityMilli = decimalUnits(quantity, 3, "down");
  if (priceMicro === null || quantityMilli === null || priceMicro <= 0 || priceMicro >= maxPriceMicro || quantityMilli <= 0) return null;
  return { priceMicro, quantityMilli };
}

const levelsOf = (raw: RawOutcomeMarket["bids"], maxPriceMicro: number, side: "bid" | "offer"): VenueLevel[] => {
  const out: VenueLevel[] = [];
  for (const l of raw ?? []) {
    const level = venueLevelOf(l?.price, l?.quantity, maxPriceMicro, side);
    if (level) out.push(level);
  }
  return out;
};

/** the market's bids, best (highest) first: what a sale walks */
export const bidLevels = (m: RawOutcomeMarket): VenueLevel[] => levelsOf(m.bids, maxPriceMicroOf(m), "bid").sort((a, b) => b.priceMicro - a.priceMicro);
/** the market's offers, best (lowest) first: what a buy-back walks */
export const askLevels = (m: RawOutcomeMarket): VenueLevel[] => levelsOf(m.offers, maxPriceMicroOf(m), "offer").sort((a, b) => a.priceMicro - b.priceMicro);

/** A price on the market as whole cents per $1 of payout (price / max_price x 100), the remainder going the way `round` says. */
export function centsPerDollarOf(priceMicro: number, maxPriceMicro: number, round: Rounding): number {
  return mulDiv(priceMicro, 100, maxPriceMicro, round);
}

/** Venue contracts (milli) as our $1 contracts: quantity x max_price, to the hundredth of a contract, the remainder going the way `round` says. */
export function ownContracts(venueMilli: number, maxPriceMicro: number, round: Rounding): number {
  return mulDiv(venueMilli, maxPriceMicro, 10 * MICRO_PER_DOLLAR, round) / 100;
}

/** Our $1 contracts as the venue's whole contracts, down: a fraction of a venue contract is not sold. */
export function venueContractsOf(contracts: number, maxPriceMicro: number): number {
  return mulDiv(contractHundredths(contracts), MICRO_PER_CENT, maxPriceMicro, "down");
}

export interface BookWalk {
  /** whole contracts the levels cover, up to what was wanted */
  contracts: number;
  /** the last level taken, micro-dollars */
  worstPriceMicro: number;
  /** cash across the fills, micro-dollars: whole contracts x micro-dollar prices, exact */
  grossMicro: number;
  /** fewer than wanted: the book ran out */
  depthLimited: boolean;
}

/** Walk `levels` (best first) for up to `want` whole contracts. Null when the book has none. */
export function walkLevels(levels: VenueLevel[], want: number): BookWalk | null {
  const wanted = Number.isFinite(want) ? Math.floor(want) : 0;
  let left = wanted;
  let gross = 0n;
  let worst = 0;
  let taken = 0;
  for (const l of levels) {
    if (left <= 0) break;
    const q = Math.min(left, divInt(l.quantityMilli, MILLI_PER_CONTRACT, "down"));
    if (q <= 0) continue;
    gross += BigInt(q) * BigInt(l.priceMicro);
    worst = l.priceMicro;
    taken += q;
    left -= q;
  }
  if (taken === 0) return null;
  return { contracts: taken, worstPriceMicro: worst, grossMicro: divBig(gross, 1n, "down"), depthLimited: taken < wanted };
}

export interface SaleTierQuote {
  tier: ProtectionTier;
  /** venue contracts sold and kept (the venue's own unit; ours when max_price is $1) */
  soldContracts: number;
  keptContracts: number;
  /** the whole contracts the tier's share asks for; more than soldContracts when the bids ran out */
  wantContracts: number;
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
  /** what one contract pays, micro-dollars (maxPriceMicroOf) */
  maxPriceMicro: number;
  bids: VenueLevel[];
}

/** The three shapes, each as the bids fund it now; a tier the book cannot fund at all is null. */
export function quoteSaleTiers(i: SaleQuoteInputs): Record<ProtectionTier, SaleTierQuote | null> {
  const N = Math.floor(i.positionContracts);
  const out = {} as Record<ProtectionTier, SaleTierQuote | null>;
  for (const tier of PROTECTION_TIERS) {
    const want = tierSaleContracts(N, tier);
    const walk = want > 0 ? walkLevels(i.bids, want) : null;
    if (!walk) {
      out[tier] = null;
      continue;
    }
    const cash = divInt(walk.grossMicro, MICRO_PER_CENT, "down");
    const kept = N - walk.contracts;
    out[tier] = {
      tier,
      soldContracts: walk.contracts,
      keptContracts: kept,
      wantContracts: want,
      limitPriceCents: divInt(walk.worstPriceMicro, MICRO_PER_CENT, "down"),
      avgPriceCents: divInt(walk.grossMicro, walk.contracts * MICRO_PER_CENT, "down"),
      cashNowCents: cash,
      floorTotalCents: cash,
      capTotalCents: cash + mulDiv(kept, i.maxPriceMicro, MICRO_PER_CENT, "down"),
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
export function quoteBuyBack(asks: VenueLevel[], want: number, maxPriceMicro: number): BuyBackQuote | null {
  const walk = walkLevels(asks, want);
  if (!walk) return null;
  // the limit must stay strictly under max_price: a book priced at the ceiling is not bought
  const limitCents = Math.min(divInt(walk.worstPriceMicro, MICRO_PER_CENT, "up"), divInt(maxPriceMicro, MICRO_PER_CENT, "up") - 1);
  return {
    wantContracts: Math.floor(want),
    contracts: walk.contracts,
    limitPriceCents: limitCents,
    avgPriceCents: divInt(walk.grossMicro, walk.contracts * MICRO_PER_CENT, "up"),
    costCents: divInt(walk.grossMicro, MICRO_PER_CENT, "up"),
    depthLimited: walk.depthLimited,
  };
}

/** The venue's price string: dollars to two places (the venue takes at most two), from whole cents. */
export const priceString = (cents: number): string => centsToDollarString(cents);

/**
 * How far under the mark the sale is, in bps of the whole position's value at the mark; the
 * record's evCostBps for this route. `positionPayoutCents` is what the whole position pays on a
 * win (contracts x max_price). A measurement, not money: rounded to the nearest bp.
 */
export function saleEvCostBps(q: Pick<SaleTierQuote, "soldContracts" | "cashNowCents">, positionPayoutCents: number, maxPriceMicro: number, markCents: number): number {
  if (!(positionPayoutCents > 0) || !(markCents > 0)) return 0;
  const soldMilli = decimalUnits(q.soldContracts, 3, "nearest");
  if (soldMilli === null || ![positionPayoutCents, maxPriceMicro, markCents, q.cashNowCents].every(Number.isSafeInteger)) return 0;
  // sold value at the mark less the cash, over the position's value at the mark, each scaled by 10^9 so nothing divides before the end
  const num = BigInt(soldMilli) * BigInt(maxPriceMicro) * BigInt(markCents) - BigInt(q.cashNowCents) * 1_000_000_000n;
  const den = BigInt(positionPayoutCents) * BigInt(markCents) * 1000n;
  return divBig(num, den, "nearest");
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
  /** the same, milli-contracts, as summed from the venue's strings */
  filledMilli: number;
  avgPriceCents: number;
  /** the fills' money, cents: floored for a sell (the member's cash), rounded up for a buy (their cost) */
  grossCents: number;
  feeCents?: number;
  fills: RawMemberFill[];
  /** the fills the figures were summed from, as the venue wrote them */
  venueFills: MemberVenueFill[];
  /**
   * "fills": the figures are the venue's fills, summed. "order": the fills read came back empty
   * though the order says it filled, so the order's own size stands in, counted at the price the
   * order cannot have done worse than (orderPriceBoundMicro).
   */
  figuresFrom: "fills" | "order";
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

/** what the order says it has filled so far, milli-contracts; 0 when it does not say */
const orderFilledMilli = (o: RawMemberOrder): number => decimalUnits(o.filled, 3, "down") ?? 0;

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
  const sell = body.action === "sell";
  const wantMilli = decimalUnits(body.quantity, 3, "down");
  const limitMicro = decimalUnits(body.price, 6, sell ? "down" : "up");
  // nothing is sent on an order this service cannot itself read back
  if (wantMilli === null || wantMilli <= 0 || limitMicro === null || limitMicro <= 0) throw new MemberApiError(400, "bad_order", "the order's price or size is not a plain decimal; nothing was sent");
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
  const want = wantMilli / MILLI_PER_CONTRACT;
  const started = now();
  let cur = order;
  while (LIVE_ORDER_STATUSES.has(cur.status) && orderFilledMilli(cur) < wantMilli && now() - started < waitMs) {
    await sleep(pollMs);
    try {
      cur = await client.order(order.id);
    } catch {
      // a read that fails leaves the last answer; the loop ends on time
    }
  }
  let cancelled: string | null = null;
  if (LIVE_ORDER_STATUSES.has(cur.status) && orderFilledMilli(cur) < wantMilli) {
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
  const o = await outcomeFromFills(client, order, cur, sell, limitMicro);
  const status = o.status;
  const note =
    o.filled === 0
      ? `nothing filled at ${body.price} within ${Math.round(waitMs / 1000)}s; the order was ${cancelled ? "cancelled" : status}`
      : o.filledMilli < wantMilli
        ? `${o.filled} of ${want} filled at ${body.price} or better; the rest ${cancelled ? "cancelled" : status}`
        : `${o.filled} filled at ${body.price} or better`;
  return { ...o, note };
}

/**
 * The price a filled order is counted at when the venue's fills could not be read: the side of
 * the truth that cannot flatter the member. A limit sell never fills under its limit and a limit
 * buy never over it. The order's own average, when it carries one, can only tighten that, and it
 * is trusted to one unit of its last written digit and no further (how the venue rounds an
 * average is not ours to assume).
 */
export function orderPriceBoundMicro(avgPrice: unknown, limitMicro: number, sell: boolean): number {
  const avg = readDecimal(avgPrice);
  const avgMicro = avg && avg.digits > 0n ? decimalUnits(avgPrice, 6, sell ? "down" : "up") : null;
  if (!avg || avgMicro === null) return limitMicro;
  const lastDigit = avg.scale >= 6 ? 1 : 10 ** (6 - avg.scale);
  return sell ? Math.max(limitMicro, avgMicro - lastDigit) : Math.min(limitMicro, avgMicro + lastDigit);
}

/** The fills are the truth: read them for the order, the order's own figures standing in when the fills read is empty. */
async function outcomeFromFills(client: MemberClient, order: RawMemberOrder, cur: RawMemberOrder, sell: boolean, limitMicro: number): Promise<Omit<OrderOutcome, "note">> {
  let fills: RawMemberFill[] = [];
  try {
    fills = await client.fills([order.id]);
  } catch {
    fills = [];
  }
  let filledMilli = 0;
  // milli-contracts x micro-dollars: billionths of a dollar, whole until the one division to cents
  let grossNano = 0n;
  let feeMicro = 0;
  let feeKnown = false;
  const venueFills: MemberVenueFill[] = [];
  for (const f of fills) {
    const q = decimalUnits(f.filled, 3, "down");
    const p = decimalUnits(f.price, 6, sell ? "down" : "up");
    if (q === null || p === null || q <= 0) continue;
    filledMilli += q;
    grossNano += BigInt(q) * BigInt(p);
    const fee = f.trade_fee === null || f.trade_fee === undefined ? null : decimalUnits(f.trade_fee, 6, "up");
    if (fee !== null) {
      feeMicro += fee;
      feeKnown = true;
    }
    venueFills.push({ price: String(f.price), filled: String(f.filled), ...(fee !== null ? { tradeFee: String(f.trade_fee) } : {}) });
  }
  let figuresFrom: OrderOutcome["figuresFrom"] = "fills";
  if (filledMilli === 0 && orderFilledMilli(cur) > 0) {
    filledMilli = orderFilledMilli(cur);
    grossNano = BigInt(filledMilli) * BigInt(orderPriceBoundMicro(cur.avg_price, limitMicro, sell));
    figuresFrom = "order";
  }
  const round: Rounding = sell ? "down" : "up";
  return {
    order: cur,
    orderId: order.id,
    status: cur.status ?? order.status,
    filled: filledMilli / MILLI_PER_CONTRACT,
    filledMilli,
    avgPriceCents: filledMilli > 0 ? divBig(grossNano, BigInt(filledMilli) * BigInt(MICRO_PER_CENT), round) : 0,
    grossCents: divBig(grossNano, BigInt(MILLI_PER_CONTRACT) * BigInt(MICRO_PER_CENT), round),
    ...(feeKnown ? { feeCents: divInt(feeMicro, MICRO_PER_CENT, "up") } : {}),
    fills,
    venueFills,
    figuresFrom,
  };
}

// ---------------------------------------------------------------------------
// a combination ticket: the bid from the venue's request for quote
// ---------------------------------------------------------------------------

/** The venue's quote as the tier arithmetic reads it: one bid level, or none. */
export interface RfqBid {
  rfq: RawMemberRfq;
  /** per contract, micro-dollars, and the size the makers take; the level the tiers walk */
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
export async function requestRfqBid(client: MemberClient, body: RfqRequestBody, maxPriceMicro: number, opts: ExecuteOptions = {}): Promise<RfqBid> {
  const waitMs = opts.waitMs ?? 3000;
  const pollMs = opts.pollMs ?? 400;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let cur = await client.requestRfq(body);
  const started = now();
  const priced = (q: RawMemberRfq) => q.price !== null && q.price !== undefined && readDecimal(q.price) !== null && !PENDING_RFQ_STATUSES.has(q.status);
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
  const level = venueLevelOf(cur.price, cur.quantity ?? body.quantity, maxPriceMicro, "bid");
  return { rfq: cur, level, reason: level ? null : "unpriced", expiresAtIso };
}

/** The quote's price as the venue wrote it: what an accept sends back, digit for digit. */
export const quotedPriceOf = (rfq: RawMemberRfq): string => String(rfq.price ?? "").trim();

/**
 * Accept the quote for `quantity` at its price, sent back exactly as the venue quoted it (a quote
 * finer than a cent is not rounded into a different price). The venue answers with the order the
 * fill posted as; the fills are read for it like any sale (the fill may be smaller than the quote:
 * a partial).
 */
export async function acceptRfq(client: MemberClient, bid: RfqBid, quantity: number): Promise<OrderOutcome> {
  if (!bid.level) throw new MemberApiError(0, "rfq_unpriced", "the quote carries no price to accept");
  const price = quotedPriceOf(bid.rfq);
  const wantMilli = decimalUnits(quantity, 3, "down");
  if (wantMilli === null || wantMilli <= 0) throw new MemberApiError(400, "bad_order", "the size to accept is not a plain decimal; nothing was sent");
  const order = await client.acceptRfq(bid.rfq.id, { quantity: String(quantity), price });
  let cur = order;
  if (LIVE_ORDER_STATUSES.has(cur.status) && orderFilledMilli(cur) < wantMilli) {
    try {
      cur = await client.order(order.id);
    } catch {
      // the fills below are what count
    }
  }
  const o = await outcomeFromFills(client, order, cur, true, bid.level.priceMicro);
  const note = o.filled === 0 ? `the quote at ${price} was accepted but nothing filled; the order was ${o.status}` : o.filledMilli < wantMilli ? `${o.filled} of ${quantity} filled at ${price} on the quote` : `${o.filled} filled at ${price} on the quote`;
  return { ...o, note };
}

// ---------------------------------------------------------------------------
// the records
// ---------------------------------------------------------------------------

/**
 * The sale as the ledger keeps it, from what the venue filled. Contracts in our $1 units, to the
 * hundredth: the sold size rounds up and the riding size down, so the cap (cash plus 100 cents on
 * every riding contract) is never more than the venue will pay. Both are exact whenever the fills
 * are whole contracts and max_price is whole cents.
 */
export function saleRecordOf(o: OrderOutcome, p: { marketId: string; positionContracts: number; maxPriceMicro: number; limitPriceCents: number; clientOrderId: string; requested: number }): MemberSaleRecord {
  const milli = (venueContracts: number): number => decimalUnits(venueContracts, 3, "down") ?? 0;
  const soldHundredths = mulDiv(o.filledMilli, p.maxPriceMicro, 10 * MICRO_PER_DOLLAR, "up");
  const heldHundredths = mulDiv(milli(p.positionContracts), p.maxPriceMicro, 10 * MICRO_PER_DOLLAR, "down");
  const keptHundredths = Math.max(0, heldHundredths - soldHundredths);
  return {
    marketId: p.marketId,
    maxPriceCents: divInt(p.maxPriceMicro, MICRO_PER_CENT, "down"),
    soldContracts: soldHundredths / 100,
    keptContracts: keptHundredths / 100,
    limitPriceCents: p.limitPriceCents,
    avgPriceCents: o.avgPriceCents,
    cashNowCents: o.grossCents,
    ...(o.feeCents !== undefined ? { feeCents: o.feeCents } : {}),
    floorTotalCents: o.grossCents,
    capTotalCents: o.grossCents + keptHundredths,
    orderId: o.orderId,
    clientOrderId: p.clientOrderId,
    status: o.status,
    requestedContracts: ownContracts(milli(p.requested), p.maxPriceMicro, "up"),
    figuresFrom: o.figuresFrom,
    ...(o.venueFills.length > 0 ? { venueFills: o.venueFills } : {}),
  };
}

export function buyBackRecordOf(o: OrderOutcome, p: { maxPriceMicro: number; limitPriceCents: number; clientOrderId: string; requested: number }): MemberBuyBackRecord {
  return {
    requestedContracts: ownContracts(decimalUnits(p.requested, 3, "down") ?? 0, p.maxPriceMicro, "down"),
    boughtContracts: ownContracts(o.filledMilli, p.maxPriceMicro, "down"),
    limitPriceCents: p.limitPriceCents,
    avgPriceCents: o.avgPriceCents,
    costCents: o.grossCents,
    ...(o.feeCents !== undefined ? { feeCents: o.feeCents } : {}),
    orderId: o.orderId,
    clientOrderId: p.clientOrderId,
    status: o.status,
    figuresFrom: o.figuresFrom,
    ...(o.venueFills.length > 0 ? { venueFills: o.venueFills } : {}),
  };
}

/**
 * The tails in the member's own words. The sold contracts are sold whatever happens; the venue's
 * tail rules touch only the contracts still riding, and the member's own account pays them.
 */
export function memberTailTerms(venueName: string, rules: RuleCells, kept: number): TailTerm[] {
  const riding = `your ${kept} riding contract${kept === 1 ? "" : "s"}`;
  const sold = "The contracts you locked stay locked.";
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
