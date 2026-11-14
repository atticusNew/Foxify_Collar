/**
 * THE DAILY CHECK: our ledger's real fills for one UTC day against the venue's own fills.
 *
 * Our ledger has one line per order (realizedBook.RealFill). A venue has one or more fills per
 * order. So the venue's fills are first added up per order (`VenueOrderFill`), by the same cost
 * function that wrote our line, and the two are then compared order by order.
 *
 * WHAT A VENUE HANDS OVER, and where each shape comes from:
 *   Kalshi           GET /portfolio/fills, the venue's own list of the account's fills for a time
 *                    window (kalshiOrders.KalshiFill). No reader in this repo returned fills before
 *                    this check; the shape is Kalshi's published GetFillsResponse. It lists the
 *                    whole day, every subaccount the key can see, so a fill we never recorded shows.
 *                    It covers orders sent with our own key (matched on Kalshi's order id) and
 *                    orders the aggregator's pod sent into a subaccount of our account (matched on
 *                    the venue order id our line keeps).
 *   Kalshi, no key   the aggregator's own read of each order our ledger names
 *                    (aggregatorOrders.AggregatorKalshiOrder, the read the order was costed from).
 *                    Only the orders we name: a fill we never recorded would not show.
 *   ProphetX         the aggregator's fills of each order our ledger names
 *                    (prophetxOrders.ProphetXFill, the existing reader). Only the orders we name.
 *   Novig            GET /v3/portfolio/fills (novigOrders.NovigFill, the existing reader's shape):
 *                    the trading key's own fills for a time window, the whole day.
 *   Polymarket       no reader exists; a real fill there cannot be checked.
 *
 * HOW A LINE FINDS ITS ORDER, in this order:
 *   1. the order id on our line (`fill.ids.orderId`, `fill.ids.venueOrderId`) against every id
 *      the venue's order goes by. Every live fill carries one.
 *   2. the id our order carried to the venue (`atticus-<receipt id>`, in each venue's own
 *      spelling) against the client order id the venue kept, where the venue's read carries it.
 *   3. only for a line with no order id at all (an accepted quote whose answer named no order):
 *      the same instrument, the same direction and the same size on the day, one for one, the
 *      nearest in time first. Flagged `instrument_and_size`. Two orders of one size on one
 *      instrument on one day can pair crosswise this way; the totals still agree, the pairing
 *      may not, and a fill of ours could hide a stranger's of the same size.
 * A line WITH an order id that the venue does not show is never paired by size: that would hide
 * the very thing the check is for.
 *
 * WHAT IS COMPARED: quantity (milli units), cost (cents: all in on a buy, net proceeds on a sale),
 * the average price (milli dollars), the fee (cents, where both sides carry one) and the
 * direction. Whole numbers throughout. Where the venue's figure is the same read our line was
 * costed from (the aggregator's order, ProphetX fills, Novig fills) any difference at all counts.
 * Kalshi's list prices each fill on its own while our line was costed from the order's rounded
 * average, each rounded against us: there the cost may sit up to KALSHI_LIST_ROUNDING_CENTS away
 * and the fee one cent away before it counts, and the exact gap is still shown.
 *
 * THE VERDICT, one per venue per day:
 *   differs               a quantity, cost, price, fee or direction differs; or a fill is on our
 *                         ledger and not at the venue; or at the venue and not on our ledger
 *   could_not_be_checked  no key, no reader, the read failed, some order could not be read, or
 *                         an order our ledger could not confirm cannot be looked up there
 *   agrees                everything read, nothing differs. `scope` says how much that covers:
 *                         the whole day, or only the orders our ledger names.
 * A failed read is never "agrees".
 *
 * WHAT THIS DOES NOT CHECK: settlements. What a hedge paid at the game is not read from any
 * venue here; only fills are. Pure: nothing is read and no venue is called in this file.
 */

import { fillOfAggregatorOrder, type AggregatorKalshiOrder } from "./aggregatorOrders";
import type { HedgeVenue } from "./hedgeExecutor";
import { fillOfKalshiFills, kalshiFillSide, type KalshiFill } from "./kalshiOrders";
import { novigClientId, novigFillMoney, sumNovigFills, type NovigFill } from "./novigOrders";
import { prophetxFillMoney, sumProphetXFills, type ProphetXFeeSpec, type ProphetXFill } from "./prophetxOrders";
import type { NotCountedLine, RealFill } from "./realizedBook";

/** Cents a cost built from Kalshi's listed fills may sit from one built from the order's rounded average, by rounding alone. */
export const KALSHI_LIST_ROUNDING_CENTS = 2;

export type VenueFillSource = "kalshi_fills_list" | "aggregator_order" | "prophetx_order_fills" | "novig_fills_list";

/** One order as the venue's own fills add up to it, in our ledger's units. */
export interface VenueOrderFill {
  venue: HedgeVenue;
  /** every id the order goes by: the venue's own, and the aggregator pod's when it was read there */
  ids: string[];
  /** the client order id the venue kept, when its read carries one */
  clientOrderId: string | null;
  instrument: string | null;
  /** null when the venue's fills do not say which way the order went */
  action: "buy" | "sell" | null;
  /** the first fill's time, ISO; null when the read carries none */
  at: string | null;
  unitsMilli: number;
  avgPriceMilli: number;
  /** all in on a buy, net proceeds on a sale: the same meaning as our line's cents */
  costCents: number;
  feesCents: number | null;
  /** how many fills made the order up; null when the read is of the order, not its fills */
  fillCount: number | null;
  /** Kalshi: which subaccount the fills were in */
  subaccount: number | null;
  source: VenueFillSource;
  /** cents the cost may differ from our line by rounding alone (0: the same read our line was costed from) */
  roundingCents: number;
}

/** One venue's fills for a day, as a reader hands them over. */
export interface VenueDayRead {
  venue: HedgeVenue;
  status: "read" | "failed" | "no_key" | "no_reader";
  /** why, when not read */
  reason: string | null;
  /** whole_day: every fill of the day in the account the key sees; ledger_orders_only: only the orders our ledger names */
  scope: "whole_day" | "ledger_orders_only";
  /** what was read, in words, for the operator */
  how: string;
  orders: VenueOrderFill[];
  /** our lines whose order could not be read at the venue, each with why */
  unread: Array<{ receiptId: string; reason: string }>;
}

const isoOf = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const ms = typeof v === "number" ? (v > 100_000_000_000 ? v : v * 1000) : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const avgMilli = (costCents: number, unitsMilli: number, sell: boolean): number =>
  unitsMilli > 0 ? (sell ? Math.floor((costCents * 10_000) / unitsMilli) : Math.ceil((costCents * 10_000) / unitsMilli)) : 0;

/** The worst whole-cent No price an order would take, from the limit our line kept; the venue clients' own cap (kalshiOrders, aggregatorOrders `capCents`). */
export const capCentsOfLimit = (limitMilli: number): number => Math.min(99, Math.max(1, Math.ceil(limitMilli / 10)));

/** Kalshi's listed fills, added up per order. An order whose fills point both ways has no direction and is costed as a buy. */
export function kalshiOrdersFromFills(fills: KalshiFill[]): VenueOrderFill[] {
  const byOrder = new Map<string, KalshiFill[]>();
  for (const f of fills) byOrder.set(f.order_id, [...(byOrder.get(f.order_id) ?? []), f]);
  const out: VenueOrderFill[] = [];
  for (const [orderId, group] of byOrder) {
    const sides = new Set(group.map(kalshiFillSide));
    const side = sides.size === 1 ? [...sides][0] : null;
    const sell = side === "yes";
    const money = fillOfKalshiFills(group, sell);
    const times = group.map((f) => isoOf(f.created_time ?? f.ts)).filter((t): t is string => t !== null).sort();
    const sub = group.find((f) => typeof f.subaccount_number === "number")?.subaccount_number;
    out.push({
      venue: "kalshi",
      ids: [orderId],
      clientOrderId: null,
      instrument: group[0].ticker ?? group[0].market_ticker ?? null,
      action: side === null ? null : sell ? "sell" : "buy",
      at: times[0] ?? null,
      unitsMilli: money.unitsMilli,
      avgPriceMilli: avgMilli(money.costCents, money.unitsMilli, sell),
      costCents: money.costCents,
      feesCents: money.feeKnown ? money.feesCents : null,
      fillCount: group.length,
      subaccount: typeof sub === "number" ? sub : null,
      source: "kalshi_fills_list",
      roundingCents: KALSHI_LIST_ROUNDING_CENTS,
    });
  }
  return out;
}

/** The aggregator's read of one Kalshi order, costed by the function that costed our line. `capCents` only fills a missing average. */
export function aggregatorKalshiOrderFill(o: AggregatorKalshiOrder, capCents: number): VenueOrderFill {
  const sell = o.side === "BID";
  const f = fillOfAggregatorOrder(o, capCents, sell);
  return {
    venue: "kalshi",
    ids: [o.orderId, ...(o.venueOrderId ? [o.venueOrderId] : [])],
    clientOrderId: o.clientOrderId ?? null,
    instrument: o.ticker ?? null,
    action: sell ? "sell" : "buy",
    at: isoOf(o.closedAt ?? o.createdAt),
    unitsMilli: f.unitsMilli,
    avgPriceMilli: avgMilli(f.costCents, f.unitsMilli, sell),
    costCents: f.costCents,
    feesCents: f.feesCents,
    fillCount: null,
    subaccount: null,
    source: "aggregator_order",
    roundingCents: 0,
  };
}

/**
 * One ProphetX order from its fills. The venue's fills do not say whether a buy was the hedge or
 * the offset that unwinds it, nor the hedge's size, so both come from our line (`ctx`).
 */
export function prophetxOrderFill(
  orderId: string,
  fills: ProphetXFill[],
  ctx: { sell: boolean; wantedUnitsMilli: number; fee: ProphetXFeeSpec; venueOrderId?: string | null; instrument?: string | null },
): VenueOrderFill {
  const money = prophetxFillMoney(sumProphetXFills(fills), ctx.wantedUnitsMilli, ctx.sell, ctx.fee);
  const times = fills.map((f) => isoOf(f.occurredAt)).filter((t): t is string => t !== null).sort();
  return {
    venue: "prophetx",
    ids: [orderId, ...(ctx.venueOrderId ? [ctx.venueOrderId] : [])],
    clientOrderId: null,
    instrument: ctx.instrument ?? null,
    action: ctx.sell ? "sell" : "buy",
    at: times[0] ?? null,
    unitsMilli: money.unitsMilli,
    avgPriceMilli: money.avgPriceMilli,
    costCents: money.costCents,
    feesCents: money.feesCents,
    fillCount: fills.length,
    subaccount: null,
    source: "prophetx_order_fills",
    roundingCents: 0,
  };
}

/**
 * Novig's listed fills, added up per order. The venue takes only buys; an order of ours that was
 * the offset of a hedge is told from a hedge by our own line (`ctxOf`, by the venue's order id or
 * the client id it kept). An order our ledger does not know is costed as a buy.
 */
export function novigOrdersFromFills(fills: NovigFill[], ctxOf: (orderId: string, clientId: string | null) => { sell: boolean; wantedUnitsMilli: number } | null): VenueOrderFill[] {
  const byOrder = new Map<string, NovigFill[]>();
  for (const f of fills) byOrder.set(f.orderId, [...(byOrder.get(f.orderId) ?? []), f]);
  const out: VenueOrderFill[] = [];
  for (const [orderId, group] of byOrder) {
    const clientId = group.find((f) => typeof f.clientId === "string" && f.clientId)?.clientId ?? null;
    const ctx = ctxOf(orderId, clientId);
    const sum = sumNovigFills(group);
    const sell = ctx?.sell ?? false;
    const money = novigFillMoney(sum, ctx?.wantedUnitsMilli ?? sum.contracts * 10, sell);
    const times = group.map((f) => isoOf(f.ts)).filter((t): t is string => t !== null).sort();
    out.push({
      venue: "novig",
      ids: [orderId],
      clientOrderId: clientId,
      instrument: group[0].outcomeId ?? null,
      action: sell ? "sell" : "buy",
      at: times[0] ?? null,
      unitsMilli: money.unitsMilli,
      avgPriceMilli: money.avgPriceMilli,
      costCents: money.costCents,
      feesCents: money.feesCents,
      fillCount: group.length,
      subaccount: null,
      source: "novig_fills_list",
      roundingCents: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

export type ReconVerdict = "agrees" | "differs" | "could_not_be_checked";
export const VERDICT_WORDS: Record<ReconVerdict | "nothing_to_check", string> = {
  agrees: "agrees",
  differs: "differs",
  could_not_be_checked: "could not be checked",
  nothing_to_check: "nothing to check",
};

export type ReconField = "quantity" | "cost" | "price" | "fee" | "direction";

export interface ReconDifference {
  field: ReconField;
  /** milli units, cents, milli dollars, cents; a direction is "buy" or "sell" */
  ledger: number | string;
  venue: number | string;
  /** venue less ledger, in the field's unit; null for a direction */
  delta: number | null;
}

export type MatchedBy = "order_id" | "client_order_id" | "instrument_and_size";

export interface ReconPair {
  receiptId: string;
  /** the ids the venue's order goes by */
  venueIds: string[];
  matchedBy: MatchedBy;
  instrument: string;
  action: "buy" | "sell";
  ledger: { unitsMilli: number; avgPriceMilli: number; costCents: number; feesCents: number | null };
  venue: { unitsMilli: number; avgPriceMilli: number; costCents: number; feesCents: number | null };
  /** cents the cost was allowed to differ by rounding alone, and the gap that fell inside it (0 when none did) */
  roundingAllowedCents: number;
  withinRoundingCents: number;
  differences: ReconDifference[];
}

export interface ReconLedgerOnly {
  receiptId: string;
  at: string;
  orderId: string | null;
  venueOrderId: string | null;
  clientOrderId: string;
  instrument: string;
  action: "buy" | "sell";
  unitsMilli: number;
  costCents: number;
  why: string;
}

export interface ReconVenueOnly {
  venueIds: string[];
  clientOrderId: string | null;
  at: string | null;
  instrument: string | null;
  action: "buy" | "sell" | null;
  unitsMilli: number;
  costCents: number;
  feesCents: number | null;
  subaccount: number | null;
  /** what on our record this may be, when something points at it */
  hint: string | null;
}

export interface ReconTotals {
  orders: number;
  boughtUnitsMilli: number;
  paidCents: number;
  soldUnitsMilli: number;
  proceedsCents: number;
}

export interface VenueDayRecon {
  venue: HedgeVenue;
  day: string;
  verdict: ReconVerdict;
  /** the verdict's reason in plain words */
  reason: string;
  scope: "whole_day" | "ledger_orders_only" | null;
  how: string | null;
  ledgerTotals: ReconTotals;
  /** the venue's orders that fell in the day and were compared or found extra */
  venueTotals: ReconTotals;
  matched: ReconPair[];
  differing: ReconPair[];
  inLedgerNotAtVenue: ReconLedgerOnly[];
  atVenueNotInLedger: ReconVenueOnly[];
  /** our lines whose order could not be read */
  unread: Array<{ receiptId: string; reason: string }>;
  /** lines our ledger could not count as real fills that day: each may or may not be a fill at the venue */
  openQuestions: Array<{ id: string; code: NotCountedLine["code"]; clientOrderId: string | null; instrument: string; answer: string }>;
  /** the venue's orders left out: on our ledger under a neighbouring day, or outside the day's own hours */
  onLedgerOtherDay: number;
  outsideDay: number;
}

export interface DayRecon {
  day: string;
  verdict: ReconVerdict | "nothing_to_check";
  /** one line: each venue and its verdict */
  summary: string;
  venues: VenueDayRecon[];
}

export interface ReconInput {
  /** the UTC day, "YYYY-MM-DD" */
  day: string;
  /** every real fill on our ledger, any day (realizedBook.fills): the day's are compared, the rest tell a late fill from a stranger */
  fills: RealFill[];
  /** the lines our ledger listed and did not count (realizedBook.notCounted) */
  notCounted: NotCountedLine[];
  reads: VenueDayRead[];
}

const VENUE_ORDER: HedgeVenue[] = ["kalshi", "prophetx", "novig", "polymarket"];

/** The ids our order may have carried to a venue: as sent, and in the venue's own spelling where it has one. */
function clientIdsOf(clientOrderId: string): string[] {
  return [clientOrderId, novigClientId(clientOrderId)];
}

const totalsOf = (rows: Array<{ action: "buy" | "sell" | null; unitsMilli: number; costCents: number }>): ReconTotals => {
  const t: ReconTotals = { orders: rows.length, boughtUnitsMilli: 0, paidCents: 0, soldUnitsMilli: 0, proceedsCents: 0 };
  for (const r of rows) {
    if (r.action === "sell") {
      t.soldUnitsMilli += r.unitsMilli;
      t.proceedsCents += r.costCents;
    } else {
      t.boughtUnitsMilli += r.unitsMilli;
      t.paidCents += r.costCents;
    }
  }
  return t;
};

function compare(f: RealFill, v: VenueOrderFill): Pick<ReconPair, "differences" | "withinRoundingCents"> {
  const differences: ReconDifference[] = [];
  if (v.action !== null && v.action !== f.action) differences.push({ field: "direction", ledger: f.action, venue: v.action, delta: null });
  const sameUnits = v.unitsMilli === f.unitsMilli;
  if (!sameUnits) differences.push({ field: "quantity", ledger: f.unitsMilli, venue: v.unitsMilli, delta: v.unitsMilli - f.unitsMilli });
  const costGap = v.costCents - f.costCents;
  // rounding is only an excuse when the same quantity is being costed
  const allowed = sameUnits ? v.roundingCents : 0;
  const costDiffers = Math.abs(costGap) > allowed;
  if (costDiffers) differences.push({ field: "cost", ledger: f.costCents, venue: v.costCents, delta: costGap });
  // the average is the cost over the quantity on both sides: it is reported when either of those moved it
  if ((costDiffers || !sameUnits) && v.avgPriceMilli !== f.avgPriceMilli) {
    differences.push({ field: "price", ledger: f.avgPriceMilli, venue: v.avgPriceMilli, delta: v.avgPriceMilli - f.avgPriceMilli });
  }
  if (f.feesCents !== null && v.feesCents !== null) {
    const feeGap = v.feesCents - f.feesCents;
    if (Math.abs(feeGap) > Math.min(1, allowed)) differences.push({ field: "fee", ledger: f.feesCents, venue: v.feesCents, delta: feeGap });
  }
  return { differences, withinRoundingCents: !costDiffers ? costGap : 0 };
}

function reconcileVenue(venue: HedgeVenue, input: ReconInput, read: VenueDayRead | null): VenueDayRecon {
  const { day } = input;
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const ours = input.fills.filter((f) => f.venue === venue);
  const today = ours.filter((f) => f.day === day).sort((a, b) => a.at.localeCompare(b.at));
  const questions = input.notCounted.filter((n) => n.venue === venue && n.day === day);
  const base: VenueDayRecon = {
    venue,
    day,
    verdict: "could_not_be_checked",
    reason: "",
    scope: read?.scope ?? null,
    how: read?.how ?? null,
    ledgerTotals: totalsOf(today),
    venueTotals: totalsOf([]),
    matched: [],
    differing: [],
    inLedgerNotAtVenue: [],
    atVenueNotInLedger: [],
    unread: read?.unread ?? [],
    openQuestions: questions.map((n) => ({ id: n.id, code: n.code, clientOrderId: n.clientOrderId, instrument: n.instrument, answer: "not looked up" })),
    onLedgerOtherDay: 0,
    outsideDay: 0,
  };
  if (!read) return { ...base, reason: "no read of the venue was made" };
  if (read.status !== "read") return { ...base, reason: read.reason ?? (read.status === "no_key" ? `no key for ${venue}` : read.status === "no_reader" ? `no reader for ${venue}` : "the read failed") };

  const rows = read.orders.filter((o) => o.venue === venue);
  const used = new Set<VenueOrderFill>();
  const byId = new Map<string, VenueOrderFill[]>();
  const byClient = new Map<string, VenueOrderFill[]>();
  const push = (m: Map<string, VenueOrderFill[]>, k: string, v: VenueOrderFill): void => {
    m.set(k, [...(m.get(k) ?? []), v]);
  };
  for (const o of rows) {
    for (const id of o.ids) push(byId, id, o);
    if (o.clientOrderId) push(byClient, o.clientOrderId, o);
  }
  const firstFree = (list: VenueOrderFill[] | undefined): VenueOrderFill | null => list?.find((o) => !used.has(o)) ?? null;

  const unreadIds = new Set(read.unread.map((u) => u.receiptId));
  const pairs: ReconPair[] = [];
  const unmatched: RealFill[] = [];
  const pair = (f: RealFill, v: VenueOrderFill, matchedBy: MatchedBy): void => {
    used.add(v);
    if (v.unitsMilli <= 0) {
      base.inLedgerNotAtVenue.push(ledgerOnly(f, "the venue shows this order with nothing filled"));
      return;
    }
    pairs.push({
      receiptId: f.receiptId,
      venueIds: v.ids,
      matchedBy,
      instrument: f.orderInstrument,
      action: f.action,
      ledger: { unitsMilli: f.unitsMilli, avgPriceMilli: f.avgPriceMilli, costCents: f.costCents, feesCents: f.feesCents },
      venue: { unitsMilli: v.unitsMilli, avgPriceMilli: v.avgPriceMilli, costCents: v.costCents, feesCents: v.feesCents },
      roundingAllowedCents: v.roundingCents,
      ...compare(f, v),
    });
  };
  for (const f of today) {
    const byOrderId = firstFree(f.orderId ? byId.get(f.orderId) : undefined) ?? firstFree(f.venueOrderId ? byId.get(f.venueOrderId) : undefined);
    if (byOrderId) {
      pair(f, byOrderId, "order_id");
      continue;
    }
    const byClientId = clientIdsOf(f.clientOrderId)
      .map((id) => firstFree(byClient.get(id)))
      .find((o) => o !== null);
    if (byClientId) {
      pair(f, byClientId, "client_order_id");
      continue;
    }
    unmatched.push(f);
  }
  // a line with no order id at all: the same instrument, direction and size on the day, nearest in time
  for (const f of unmatched.splice(0)) {
    if (f.orderId !== null || f.venueOrderId !== null) {
      unmatched.push(f);
      continue;
    }
    const candidates = rows
      .filter((o) => !used.has(o) && o.unitsMilli === f.unitsMilli && o.instrument === f.orderInstrument && (o.action === null || o.action === f.action))
      .sort((a, b) => Math.abs(Date.parse(a.at ?? f.at) - Date.parse(f.at)) - Math.abs(Date.parse(b.at ?? f.at) - Date.parse(f.at)));
    if (candidates[0]) pair(f, candidates[0], "instrument_and_size");
    else unmatched.push(f);
  }
  for (const f of unmatched) {
    if (unreadIds.has(f.receiptId)) continue;
    base.inLedgerNotAtVenue.push(ledgerOnly(f, read.scope === "whole_day" ? "the venue's list for the day has no fill for this order" : "the venue has no fill for this order"));
  }

  // what the venue shows that no line of the day claimed
  const otherDays = ours.filter((f) => f.day !== day);
  const otherDayIds = new Set(otherDays.flatMap((f) => [f.orderId, f.venueOrderId].filter((x): x is string => x !== null)));
  const otherDayClients = new Set(otherDays.flatMap((f) => clientIdsOf(f.clientOrderId)));
  const extras: VenueOrderFill[] = [];
  for (const o of rows) {
    if (used.has(o) || o.unitsMilli <= 0) continue;
    if (o.ids.some((id) => otherDayIds.has(id)) || (o.clientOrderId !== null && otherDayClients.has(o.clientOrderId))) {
      base.onLedgerOtherDay += 1;
      continue;
    }
    if (o.at !== null && (o.at < dayStart || o.at >= dayEnd)) {
      base.outsideDay += 1;
      continue;
    }
    extras.push(o);
  }
  const answered = new Set<string>();
  for (const o of extras) {
    const byClientLine = o.clientOrderId === null ? undefined : questions.find((n) => n.clientOrderId !== null && clientIdsOf(n.clientOrderId).includes(o.clientOrderId as string));
    const byInstrument = byClientLine ?? questions.find((n) => !answered.has(n.id) && n.instrument === o.instrument && n.unitsMilli >= o.unitsMilli);
    const line = byClientLine ?? byInstrument;
    if (line) answered.add(line.id);
    base.atVenueNotInLedger.push({
      venueIds: o.ids,
      clientOrderId: o.clientOrderId,
      at: o.at,
      instrument: o.instrument,
      action: o.action,
      unitsMilli: o.unitsMilli,
      costCents: o.costCents,
      feesCents: o.feesCents,
      subaccount: o.subaccount,
      hint: byClientLine
        ? `our line ${byClientLine.id} sent this order and did not count it (${byClientLine.code})`
        : byInstrument
          ? `our line ${byInstrument.id} on the same instrument that day was not counted (${byInstrument.code}); this may be its fill`
          : null,
    });
  }
  base.openQuestions = questions.map((n) => ({
    id: n.id,
    code: n.code,
    clientOrderId: n.clientOrderId,
    instrument: n.instrument,
    answer: answered.has(n.id)
      ? "the venue shows a fill that may be this one; it is listed as at the venue and not on our ledger"
      : read.scope === "whole_day"
        ? "the venue's list for the day shows no fill that points at it"
        : "cannot be looked up: this venue is read order by order here, and this line names none",
  }));

  base.matched = pairs.filter((p) => p.differences.length === 0);
  base.differing = pairs.filter((p) => p.differences.length > 0);
  base.venueTotals = totalsOf([...pairs.map((p) => ({ action: p.action, unitsMilli: p.venue.unitsMilli, costCents: p.venue.costCents })), ...extras]);

  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (base.differing.length > 0) parts.push(`${n(base.differing.length, "order differs", "orders differ")} (${[...new Set(base.differing.flatMap((p) => p.differences.map((d) => d.field)))].join(", ")})`);
  if (base.inLedgerNotAtVenue.length > 0) parts.push(`${n(base.inLedgerNotAtVenue.length, "fill is", "fills are")} on our ledger and not at the venue`);
  if (base.atVenueNotInLedger.length > 0) parts.push(`${n(base.atVenueNotInLedger.length, "order is", "orders are")} at the venue and not on our ledger`);
  if (parts.length > 0) return { ...base, verdict: "differs", reason: parts.join("; ") };
  if (read.unread.length > 0) {
    return { ...base, verdict: "could_not_be_checked", reason: `${read.unread.length} of ${today.length} ${today.length === 1 ? "order" : "orders"} could not be read at the venue: ${read.unread[0].reason}` };
  }
  const unanswered = base.openQuestions.filter((q) => !answered.has(q.id));
  if (read.scope === "ledger_orders_only" && unanswered.length > 0) {
    return { ...base, verdict: "could_not_be_checked", reason: `${n(unanswered.length, "line", "lines")} our ledger could not count cannot be looked up at this venue, which is read order by order here` };
  }
  const rounded = base.matched.filter((p) => p.withinRoundingCents !== 0).length;
  const roundingWords = rounded > 0 ? `; ${n(rounded, "cost sits", "costs sit")} within ${KALSHI_LIST_ROUNDING_CENTS} cents of the venue's by rounding` : "";
  if (today.length === 0 && read.scope === "whole_day") return { ...base, verdict: "agrees", reason: "nothing on our ledger and nothing at the venue that day" };
  if (read.scope === "whole_day") {
    return { ...base, verdict: "agrees", reason: `${n(today.length, "fill", "fills")} on our ledger, each at the venue with the same quantity, cost and fee, and the venue shows no other fill that day${roundingWords}` };
  }
  return {
    ...base,
    verdict: "agrees",
    reason: `${n(today.length, "order", "orders")} on our ledger, each read back from the venue with the same quantity, cost and fee; only the orders our ledger names were read, so a fill we never recorded would not show${roundingWords}`,
  };
}

function ledgerOnly(f: RealFill, why: string): ReconLedgerOnly {
  return {
    receiptId: f.receiptId,
    at: f.at,
    orderId: f.orderId,
    venueOrderId: f.venueOrderId,
    clientOrderId: f.clientOrderId,
    instrument: f.orderInstrument,
    action: f.action,
    unitsMilli: f.unitsMilli,
    costCents: f.costCents,
    why,
  };
}

/**
 * Compare one UTC day. A venue gets a verdict when our ledger has a real fill there that day,
 * or a line it could not count, or a read of the venue was handed in. Pure.
 */
export function reconcileDay(input: ReconInput): DayRecon {
  const venues = new Set<HedgeVenue>();
  for (const f of input.fills) if (f.day === input.day) venues.add(f.venue);
  for (const n of input.notCounted) if (n.day === input.day) venues.add(n.venue);
  for (const r of input.reads) venues.add(r.venue);
  const rows = VENUE_ORDER.filter((v) => venues.has(v)).map((v) => reconcileVenue(v, input, input.reads.find((r) => r.venue === v) ?? null));
  const verdict: DayRecon["verdict"] =
    rows.length === 0 ? "nothing_to_check" : rows.some((r) => r.verdict === "differs") ? "differs" : rows.some((r) => r.verdict === "could_not_be_checked") ? "could_not_be_checked" : "agrees";
  return {
    day: input.day,
    verdict,
    summary: rows.length === 0 ? "no real fill on our ledger that day and no venue read" : rows.map((r) => `${r.venue} ${VERDICT_WORDS[r.verdict]}: ${r.reason}`).join(" | "),
    venues: rows,
  };
}

/** Is this a UTC day as the check takes it ("2026-11-03")? */
export function isUtcDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)) && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;
}

/** The UTC day before the one `now` falls in. */
export function previousUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000).toISOString().slice(0, 10);
}
