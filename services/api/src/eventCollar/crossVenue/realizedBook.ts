/**
 * THE REALIZED BOOK: what our own venue accounts really did, replayed from the ledgers.
 *
 * The record is a simulated run with real fills inside it. A holder's lock on an armed game sends
 * a real order (liveHedge.ts, hedgeFirst.ts); everything else is filled on paper at the walked
 * book. This module separates the two and keeps the books on the real part only.
 *
 * WHAT COUNTS AS A REAL FILL. One line of the hedge trail (`hedge-receipts.jsonl`, written by
 * `appendHedgeReceipt`) whose `fill.simulated` is the boolean `false`, whose `outcome` is the
 * filled outcome of the fill's own strategy (`filled_live` for a live order, `filled_rfq` for an
 * accepted quote, `filled_book` for a book order placed through a hook), with whole positive
 * units and whole cents. `simulated: false` is the executors' own mark that an order reached a
 * venue and filled (HedgeFill.simulated); it is the same mark the lock path trusts before it
 * writes a real-money lock (hedgeFirst.judgeHedge). A live fill's money is the venue's own final
 * read of the order, fees in. An accepted quote's money is the quoted price times the size: real,
 * and flagged, because the accept answer carries no fee.
 *
 * WHAT IS NOT COUNTED, AND IS LISTED (`notCounted`), each with its reason:
 *   order_unconfirmed   an order was sent (or a quote accepted) and the answer was an error: the
 *                       fill on the line is the paper fallback, and the venue may hold a fill
 *   mark_missing        the line has a fill and no boolean `simulated` on it
 *   outcome_mismatch    the fill says real and the outcome says otherwise, or the reverse
 *   bad_numbers         units or cents that are not whole, or not positive
 *   pending_unresolved  the pending trail has an attempt with no ending: an order may have left
 *   receipt_missing     the pending trail says a real order bought something and the receipt
 *                       line is not on the hedge trail
 * A line that is plainly paper (simulated, no order sent) is neither counted nor listed.
 *
 * WHOSE FILL IT IS. A fill belongs to the lock its ref names (`ticker`, or `ticker@holder`): the
 * latest lock on that market written at or before the fill and not already ended. The pending
 * trail overrides that where it speaks: an attempt it resolved as a stray or as a lock that
 * could not be written is a real fill with no lock, and stays unattached. A fill with no lock on
 * the record (the lock was archived by a reset, or never written) is unattached too. Unattached
 * fills are real money and are in every venue and day total; they have no lock row.
 * A member's own sale (route "member_sale") is a real fill in the MEMBER's account, not ours:
 * counted beside the book, never in it.
 *
 * WHAT COUNTS AS REALIZED. A lock with a real fill is realized when it has ended on the record:
 *   settled   the market's official result is on the lock's ledger. Our side then is
 *               the hedge's payout   $1 on every unit held when the holder's side lost, nothing
 *                                    when it won; on ProphetX less the settlement fee provided for
 *             - the cash paid for the fills (fees in; a ProphetX provision is charged only on a win)
 *             - what the terms owe the holder (the credit, and the floor when their side lost)
 *             + what the terms owe us (the slice above the cap when their side won)
 *   closed    the holder left early AND a real sale of every unit bought is on the trail. Our
 *             side is the sale's net proceeds, less the cash paid, less the credit, less (or
 *             plus) the close leg between the parties.
 * Anything else is not realized: an open lock is cost at risk; a lock closed with no real sale
 * of the whole hedge, a voided lock, and a real sale with no real buy are "unresolved" (the
 * venue still holds something the record cannot value) and are listed with their cost.
 *
 * WHAT IS DERIVED, NOT READ. The payout at settlement is taken from the official result on the
 * lock's ledger; no venue's settlement statement is read here, and on a cross-venue hedge the
 * other venue settles on its own result. The daily reconciliation (realizedRecon.ts) checks
 * fills, not settlements. Money between us and the holder is counted as the terms owe it at the
 * ending; what the cash lines say was actually paid is carried beside it, never mixed in.
 *
 * Money is whole cents; units are milli (1000 = one contract paying $1). Days and months are
 * UTC, by the line's own time: a fill by the moment our executor sent it, an ending by the
 * settle or close line, a payment by its cash line. Pure: no file is read here and no venue is
 * called; the caller hands over the replayed ledgers.
 */

import { actionOf, type HedgeOutcome, type HedgeReceipt, type HedgeVenue, type HedgeVia } from "./hedgeExecutor";
import { judgeHedge, type PendingRecord } from "./hedgeFirst";
import { cashDue, hedgeUnitsOf, type CashLegDue, type ShadowPosition } from "./shadowLedger";

export const REAL_FILL_RULE =
  "a hedge-receipts line with fill.simulated false, a filled outcome matching the fill's strategy, whole positive units and whole cents";

const FILLED_OUTCOME: Record<string, HedgeOutcome> = { live: "filled_live", rfq: "filled_rfq", book: "filled_book" };

export type FillBasis = "venue_read" | "accepted_quote" | "order_hook";

/** One real fill: one order of ours that a venue filled, as our trail wrote it. */
export interface RealFill {
  receiptId: string;
  /** when our executor sent the order; its UTC day is the fill's day */
  at: string;
  day: string;
  ref: string;
  ticker: string;
  holder: string | null;
  venue: HedgeVenue;
  via: HedgeVia;
  action: "buy" | "sell";
  instrument: string;
  /** units the order asked for, and the worst price it would take, milli */
  wantedUnitsMilli: number;
  limitMilli: number;
  unitsMilli: number;
  avgPriceMilli: number;
  /** the cents on the line: all in on a buy, net proceeds on a sale */
  costCents: number;
  /** a buy: the cash that left at the fill (the line's cents less any settlement provision); a sale: 0 */
  cashPaidCents: number;
  /** the venue's fee as reported; null when the line carries none (lines before the fee was kept, accepted quotes) */
  feesCents: number | null;
  /** inside `costCents`, charged at settlement only on a win; null when the line does not say (0 where the venue has no such fee) */
  settlementProvisionCents: number | null;
  orderId: string | null;
  venueOrderId: string | null;
  /** the id our order carried to the venue */
  clientOrderId: string;
  basis: FillBasis;
  /** the lock it belongs to, or null with the reason it has none */
  lockKey: string | null;
  unattachedReason: string | null;
}

export type NotCountedCode = "order_unconfirmed" | "mark_missing" | "outcome_mismatch" | "bad_numbers" | "pending_unresolved" | "receipt_missing";

/** A line that might be a real fill and is not counted as one. */
export interface NotCountedLine {
  source: "hedge_trail" | "pending_trail";
  id: string;
  at: string;
  day: string;
  ref: string;
  venue: HedgeVenue;
  instrument: string;
  unitsMilli: number;
  /** the id the order carried to the venue, when one is known: what to look for there */
  clientOrderId: string | null;
  code: NotCountedCode;
  reason: string;
}

export type RealLockState = "open" | "settled" | "closed" | "unresolved";

export interface RealLock {
  /** `holder|ticker|generation`; operator views only */
  key: string;
  ticker: string;
  holder: string | null;
  generation: number;
  lockedAt: string;
  league: string;
  sideName: string;
  contracts: number;
  /** the lock's status on its own ledger */
  status: ShadowPosition["status"];
  state: RealLockState;
  unresolvedReason: string | null;
  /** where the first real buy was filled */
  venue: HedgeVenue;
  via: HedgeVia;
  fills: string[];
  /** units the lock was quoted to hold, bought for real, sold for real, and still held */
  hedgeUnitsMilli: number;
  boughtUnitsMilli: number;
  soldUnitsMilli: number;
  heldUnitsMilli: number;
  coverage: "exact" | "under" | "over";
  cashPaidCents: number;
  feesCents: number;
  /** every fill on the lock carries its fee */
  feesKnown: boolean;
  saleProceedsCents: number;
  /** when it ended (settle or close line), its UTC day, and the official result when settled */
  endedAt: string | null;
  endedDay: string | null;
  result: "yes" | "no" | null;
  /** settled: what the hedge paid, from the official result; 0 otherwise */
  payoutCents: number;
  /** between us and the holder: what the terms owe each way, and what the cash lines say moved */
  holderLegs: CashLegDue[];
  toHolderDueCents: number;
  toHolderPaidCents: number;
  fromHolderDueCents: number;
  fromHolderPaidCents: number;
  /** our result on the lock; null unless it is settled or closed with a full real sale */
  realizedCents: number | null;
  /** cash paid for units the venue still holds, when the lock is open or unresolved */
  costAtRiskCents: number;
  /** the figures are complete from the lines: venue-read money, fees known, no provision left to guess */
  exact: boolean;
  /** every leg between us and the holder is paid in full on the record */
  cashSettled: boolean;
  notes: string[];
}

/** One venue's real activity over a UTC day or month. */
export interface RealizedPeriodRow {
  period: string;
  venue: HedgeVenue;
  via: HedgeVia;
  fills: number;
  boughtUnitsMilli: number;
  cashPaidCents: number;
  feesCents: number;
  fillsWithoutFee: number;
  soldUnitsMilli: number;
  saleProceedsCents: number;
  /** locks that ended in the period, and what their hedges paid */
  locksEnded: number;
  payoutCents: number;
  /** cash lines dated in the period */
  paidToHolderCents: number;
  collectedFromHolderCents: number;
  /** our result on the locks that ended in the period (their whole life, cost included) */
  realizedCents: number;
  inexactLocks: number;
}

export interface RealizedTotals {
  realFills: number;
  realLocks: number;
  open: number;
  settled: number;
  closed: number;
  unresolved: number;
  unattachedFills: number;
  boughtUnitsMilli: number;
  cashPaidCents: number;
  feesCents: number;
  fillsWithoutFee: number;
  soldUnitsMilli: number;
  saleProceedsCents: number;
  payoutCents: number;
  paidToHolderCents: number;
  collectedFromHolderCents: number;
  toHolderOutstandingCents: number;
  fromHolderOutstandingCents: number;
  realizedCents: number;
  openCostCents: number;
  unresolvedCostCents: number;
  unattachedCostCents: number;
  /** every realized lock's figures are complete from the lines */
  exact: boolean;
  /** every realized lock's legs with the holder are paid in full on the record */
  cashSettled: boolean;
}

export interface RealizedBook {
  rule: string;
  fills: RealFill[];
  notCounted: NotCountedLine[];
  locks: RealLock[];
  unattached: RealFill[];
  byDay: RealizedPeriodRow[];
  byMonth: RealizedPeriodRow[];
  byVenue: RealizedPeriodRow[];
  totals: RealizedTotals;
  /** real fills in members' own accounts (route "member_sale"): beside the book, never in it */
  memberSales: { locks: number; open: number; settled: number; closed: number };
}

export interface RealizedBookInput {
  /** the hedge trail, as loadHedgeReceipts replays it */
  receipts: HedgeReceipt[];
  /** the pending trail, as loadPending replays it; empty on ledgers from before it existed */
  pending: PendingRecord[];
  /** every lock ledger's positions with whose ledger it is (null: the shared one), as loadShadowPositions replays them */
  locks: Array<{ p: ShadowPosition; holder: string | null }>;
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const dayOf = (iso: string): string => iso.slice(0, 10);
const monthOf = (iso: string): string => iso.slice(0, 7);

export const lockKeyOf = (ticker: string, holder: string | null, generation: number): string => `${holder ?? ""}|${ticker}|${generation}`;

/** The id a receipt's order carried to the venue (LiveHedgeExecutor: `atticus-<receipt id>`). */
export const clientOrderIdOf = (receiptId: string): string => `atticus-${receiptId}`;

type Classified = { kind: "real"; basis: FillBasis } | { kind: "paper" } | { kind: "not_counted"; code: NotCountedCode; reason: string };

/** Is this line of the hedge trail a real fill, a paper one, or one that cannot be told? */
export function classifyReceipt(r: HedgeReceipt): Classified {
  const f = r.fill;
  if (f && typeof f.simulated !== "boolean") {
    return { kind: "not_counted", code: "mark_missing", reason: "the fill has no boolean simulated mark; it cannot be told real from paper" };
  }
  if (f && f.simulated === false) {
    if (r.outcome !== FILLED_OUTCOME[f.strategy]) {
      return { kind: "not_counted", code: "outcome_mismatch", reason: `the fill says a ${f.strategy} order reached the venue and the outcome on the line is ${r.outcome}` };
    }
    if (!whole(f.unitsMilli) || f.unitsMilli <= 0 || !whole(f.costCents) || f.costCents < 0 || !whole(f.avgPriceMilli)) {
      return { kind: "not_counted", code: "bad_numbers", reason: "the fill's units or cents are not whole positive numbers" };
    }
    return { kind: "real", basis: f.strategy === "live" ? "venue_read" : f.strategy === "rfq" ? "accepted_quote" : "order_hook" };
  }
  // no real fill on the line: was an order sent whose answer never came back clean?
  const verdict = judgeHedge(r.intent, r);
  if (verdict.kind === "unconfirmed") {
    return { kind: "not_counted", code: "order_unconfirmed", reason: `an order was sent and not confirmed (${verdict.detail}); the venue may hold a fill` };
  }
  const accept = r.attempts.find((a) => a.strategy === "rfq" && a.step === "accept" && !a.ok);
  if (accept) {
    return { kind: "not_counted", code: "order_unconfirmed", reason: `a quote was accepted and the answer was an error (${accept.detail}); the venue may hold a fill` };
  }
  if (r.outcome === "filled_live") {
    return { kind: "not_counted", code: "outcome_mismatch", reason: "the outcome says a live order filled and the line carries no real fill" };
  }
  return { kind: "paper" };
}

function splitRef(ref: string): { ticker: string; holder: string | null } {
  const at = ref.indexOf("@");
  return at < 0 ? { ticker: ref, holder: null } : { ticker: ref.slice(0, at), holder: ref.slice(at + 1) || null };
}

function emptyRow(period: string, venue: HedgeVenue, via: HedgeVia): RealizedPeriodRow {
  return {
    period,
    venue,
    via,
    fills: 0,
    boughtUnitsMilli: 0,
    cashPaidCents: 0,
    feesCents: 0,
    fillsWithoutFee: 0,
    soldUnitsMilli: 0,
    saleProceedsCents: 0,
    locksEnded: 0,
    payoutCents: 0,
    paidToHolderCents: 0,
    collectedFromHolderCents: 0,
    realizedCents: 0,
    inexactLocks: 0,
  };
}

/** Roll fills, endings and payments up by venue under one period key (a day, a month, or all time). */
function rollUp(fills: RealFill[], locks: RealLock[], cashOf: Map<string, NonNullable<ShadowPosition["cash"]>>, periodOf: (iso: string) => string): RealizedPeriodRow[] {
  const rows = new Map<string, RealizedPeriodRow>();
  const row = (period: string, venue: HedgeVenue, via: HedgeVia): RealizedPeriodRow => {
    const k = `${period}|${venue}|${via}`;
    let r = rows.get(k);
    if (!r) {
      r = emptyRow(period, venue, via);
      rows.set(k, r);
    }
    return r;
  };
  for (const f of fills) {
    const r = row(periodOf(f.at), f.venue, f.via);
    r.fills += 1;
    if (f.feesCents === null) r.fillsWithoutFee += 1;
    else r.feesCents += f.feesCents;
    if (f.action === "buy") {
      r.boughtUnitsMilli += f.unitsMilli;
      r.cashPaidCents += f.cashPaidCents;
    } else {
      r.soldUnitsMilli += f.unitsMilli;
      r.saleProceedsCents += f.costCents;
    }
  }
  for (const l of locks) {
    if (l.realizedCents !== null && l.endedAt) {
      const r = row(periodOf(l.endedAt), l.venue, l.via);
      r.locksEnded += 1;
      r.payoutCents += l.payoutCents;
      r.realizedCents += l.realizedCents;
      if (!l.exact) r.inexactLocks += 1;
    }
    const toHolder = new Set(l.holderLegs.filter((leg) => leg.to === "holder").map((leg) => leg.leg));
    const toWriter = new Set(l.holderLegs.filter((leg) => leg.to === "writer").map((leg) => leg.leg));
    for (const c of cashOf.get(l.key) ?? []) {
      // a payment on a leg the lock's state does not owe (yet) is not placed on either side; the lock's notes carry it
      if (toHolder.has(c.leg)) row(periodOf(c.at), l.venue, l.via).paidToHolderCents += c.cents;
      else if (toWriter.has(c.leg)) row(periodOf(c.at), l.venue, l.via).collectedFromHolderCents += c.cents;
    }
  }
  return [...rows.values()].sort((a, b) => (a.period === b.period ? `${a.venue}${a.via}`.localeCompare(`${b.venue}${b.via}`) : a.period.localeCompare(b.period)));
}

/** Replay the ledgers into our realized book. Pure. */
export function buildRealizedBook(input: RealizedBookInput): RealizedBook {
  const notCounted: NotCountedLine[] = [];
  const fills: RealFill[] = [];

  // the pending trail's word on each receipt: how the lock attempt behind it ended
  const pendings = new Map<string, Extract<PendingRecord, { type: "pending" }>>();
  const resolvedBy = new Map<string, Extract<PendingRecord, { type: "resolved" }>>();
  const cleared = new Set<string>();
  for (const r of input.pending) {
    if (r.type === "pending") pendings.set(r.id, r);
    else if (r.type === "resolved") resolvedBy.set(r.id, r);
    else cleared.add(r.id);
  }
  const endingOfReceipt = new Map<string, Extract<PendingRecord, { type: "resolved" }>>();
  for (const r of resolvedBy.values()) {
    const rid = r.fill?.receiptId ?? r.receiptId;
    if (rid) endingOfReceipt.set(rid, r);
  }

  const receiptIds = new Set<string>();
  for (const r of input.receipts) {
    receiptIds.add(r.id);
    const c = classifyReceipt(r);
    if (c.kind === "paper") continue;
    const { ticker, holder } = splitRef(r.ref);
    if (c.kind === "not_counted") {
      notCounted.push({
        source: "hedge_trail",
        id: r.id,
        at: r.at,
        day: dayOf(r.at),
        ref: r.ref,
        venue: r.intent.venue,
        instrument: r.intent.instrument,
        unitsMilli: r.intent.unitsMilli,
        clientOrderId: clientOrderIdOf(r.id),
        code: c.code,
        reason: c.reason,
      });
      continue;
    }
    const f = r.fill!;
    const action = actionOf(r.intent);
    const provision = whole(f.settlementProvisionCents) && f.settlementProvisionCents >= 0 ? f.settlementProvisionCents : f.venue === "prophetx" && action === "buy" ? null : 0;
    fills.push({
      receiptId: r.id,
      at: r.at,
      day: dayOf(r.at),
      ref: r.ref,
      ticker,
      holder,
      venue: f.venue,
      via: f.via ?? "direct",
      action,
      instrument: f.instrument,
      wantedUnitsMilli: r.intent.unitsMilli,
      limitMilli: whole(r.intent.book?.worstPriceMilli) ? r.intent.book.worstPriceMilli : 0,
      unitsMilli: f.unitsMilli,
      avgPriceMilli: f.avgPriceMilli,
      costCents: f.costCents,
      cashPaidCents: action === "buy" ? Math.max(0, f.costCents - (provision ?? 0)) : 0,
      feesCents: whole(f.feesCents) && f.feesCents >= 0 ? f.feesCents : null,
      settlementProvisionCents: provision,
      orderId: f.ids?.orderId ?? null,
      venueOrderId: f.ids?.venueOrderId ?? null,
      clientOrderId: clientOrderIdOf(r.id),
      basis: c.basis,
      lockKey: null,
      unattachedReason: null,
    });
  }

  for (const [id, p] of pendings) {
    const r = resolvedBy.get(id);
    if (!r) {
      if (cleared.has(id)) continue;
      notCounted.push({
        source: "pending_trail",
        id,
        at: p.at,
        day: dayOf(p.at),
        ref: p.ref,
        venue: p.order.venue,
        instrument: p.order.instrument,
        unitsMilli: p.order.unitsMilli,
        clientOrderId: null,
        code: "pending_unresolved",
        reason: "a lock attempt was opened and never resolved; an order may have left with nothing written after it",
      });
    } else if (r.fill && !receiptIds.has(r.fill.receiptId)) {
      notCounted.push({
        source: "pending_trail",
        id,
        at: r.at,
        day: dayOf(r.at),
        ref: p.ref,
        venue: p.order.venue,
        instrument: p.order.instrument,
        unitsMilli: r.fill.unitsMilli,
        clientOrderId: r.fill.receiptId ? clientOrderIdOf(r.fill.receiptId) : null,
        code: "receipt_missing",
        reason: `the pending trail says a real order bought ${r.fill.unitsMilli / 1000} for ${r.fill.costCents}c (order ${r.fill.orderId ?? "?"}) and its receipt is not on the hedge trail`,
      });
    }
  }

  // our locks, by ref, oldest first; a member's own sale is not ours
  const memberSales = { locks: 0, open: 0, settled: 0, closed: 0 };
  const ours = new Map<string, Array<{ p: ShadowPosition; holder: string | null }>>();
  for (const l of input.locks) {
    if (l.p.route === "member_sale") {
      memberSales.locks += 1;
      if (l.p.status === "open") memberSales.open += 1;
      else if (l.p.status === "settled") memberSales.settled += 1;
      else if (l.p.status === "closed") memberSales.closed += 1;
      continue;
    }
    const k = `${l.holder ?? ""}|${l.p.ticker}`;
    const list = ours.get(k) ?? [];
    list.push(l);
    ours.set(k, list);
  }
  for (const list of ours.values()) list.sort((a, b) => a.p.at.localeCompare(b.p.at));

  const fillsOfLock = new Map<string, RealFill[]>();
  const lockOfKey = new Map<string, { p: ShadowPosition; holder: string | null }>();
  for (const f of [...fills].sort((a, b) => a.at.localeCompare(b.at))) {
    const ending = endingOfReceipt.get(f.receiptId);
    if (ending && ending.outcome !== "locked") {
      f.unattachedReason =
        ending.outcome === "stray"
          ? `no lock was written behind it (${ending.detail})`
          : ending.outcome === "ledger_failed"
            ? "the hedge filled and the lock record could not be written"
            : `the lock attempt ended ${ending.outcome} (${ending.detail})`;
      continue;
    }
    const candidates = ours.get(`${f.holder ?? ""}|${f.ticker}`) ?? [];
    const lock = [...candidates].reverse().find((l) => l.p.at <= f.at);
    if (!lock) {
      f.unattachedReason = "no lock on the record for it (never written, or taken off the record by a reset)";
      continue;
    }
    const endedAt = lock.p.status === "settled" ? lock.p.settledAt : lock.p.status === "closed" ? lock.p.closedAt : undefined;
    if (f.action === "buy" && endedAt && endedAt < f.at) {
      f.unattachedReason = `the lock on it had already ended (${lock.p.status} ${endedAt})`;
      continue;
    }
    const key = lockKeyOf(lock.p.ticker, lock.holder, lock.p.generation ?? 1);
    f.lockKey = key;
    lockOfKey.set(key, lock);
    fillsOfLock.set(key, [...(fillsOfLock.get(key) ?? []), f]);
  }

  const locks: RealLock[] = [];
  const cashOf = new Map<string, NonNullable<ShadowPosition["cash"]>>();
  for (const [key, own] of fillsOfLock) {
    const { p, holder } = lockOfKey.get(key)!;
    const buys = own.filter((f) => f.action === "buy");
    const sells = own.filter((f) => f.action === "sell");
    const first = buys[0] ?? own[0];
    const boughtUnitsMilli = buys.reduce((s, f) => s + f.unitsMilli, 0);
    const soldUnitsMilli = sells.reduce((s, f) => s + f.unitsMilli, 0);
    const heldUnitsMilli = Math.max(0, boughtUnitsMilli - soldUnitsMilli);
    const hedgeUnitsMilli = hedgeUnitsOf(p);
    const cashPaidCents = buys.reduce((s, f) => s + f.cashPaidCents, 0);
    const saleProceedsCents = sells.reduce((s, f) => s + f.costCents, 0);
    const feesKnown = own.every((f) => f.feesCents !== null);
    const notes: string[] = [];
    let exact = true;
    const inexact = (why: string): void => {
      exact = false;
      notes.push(why);
    };
    if (!feesKnown) notes.push("a fill on this lock was written before the venue's fee was kept on the line; its fee is inside the cash paid and not shown apart");
    if (own.some((f) => f.basis !== "venue_read")) inexact("a fill on this lock is costed at the accepted quote, not the venue's own read; the venue's fee is not in it");
    if (buys.length > 1) notes.push(`${buys.length} real buys on this lock (the hedge was sent more than once)`);
    if (new Set(own.map((f) => `${f.venue}|${f.via}`)).size > 1) notes.push("fills on more than one venue; the lock is carried under the first buy's venue");

    const holderLegs = cashDue(p);
    const sumLegs = (to: "holder" | "writer", field: "dueCents" | "paidCents"): number => holderLegs.filter((l) => l.to === to).reduce((s, l) => s + l[field], 0);
    const toHolderDueCents = sumLegs("holder", "dueCents");
    const fromHolderDueCents = sumLegs("writer", "dueCents");
    const owedLegs = new Set(holderLegs.map((l) => l.leg));
    const strayCash = (p.cash ?? []).filter((c) => !owedLegs.has(c.leg));
    if (strayCash.length > 0) notes.push(`${strayCash.length} payment(s) recorded on a leg this lock does not owe in its present state; not counted either way`);

    let state: RealLockState = "open";
    let unresolvedReason: string | null = null;
    let payoutCents = 0;
    let realizedCents: number | null = null;
    let endedAt: string | null = null;
    if (buys.length === 0) {
      state = "unresolved";
      unresolvedReason = "a real sale is on the trail with no real buy behind it";
    } else if (p.status === "settled" && p.result) {
      state = "settled";
      endedAt = p.settledAt ?? null;
      // a hedge pays $1 a unit when the holder's side lost; a part of a cent is never counted
      const gross = p.result === "no" ? Math.floor(heldUnitsMilli / 10) : 0;
      const knownProvision = buys.reduce((s, f) => s + (f.settlementProvisionCents ?? 0), 0);
      payoutCents = p.result === "no" ? Math.max(0, gross - knownProvision) : 0;
      if (buys.some((f) => f.settlementProvisionCents === null)) {
        if (p.result === "yes") inexact("the cash paid includes a provision for a settlement fee the venue charges only on a win; the line does not say how much, so the result is understated by it");
        else notes.push("the line does not split out the settlement fee provided for: the payout and the cash paid are both shown before it, and the result is right");
      }
      if (sells.length > 0) notes.push("a real sale is on the trail and the lock ran to settlement; the result counts the sale's proceeds and the payout on what was still held");
      if (first.venue !== "kalshi") notes.push("the hedge settles on its own venue's result, which is not read; the payout is taken from the official result on the lock");
      realizedCents = payoutCents + saleProceedsCents - cashPaidCents - toHolderDueCents + fromHolderDueCents;
    } else if (p.status === "closed") {
      endedAt = p.closedAt ?? null;
      if (sells.length > 0 && soldUnitsMilli >= boughtUnitsMilli) {
        state = "closed";
        // a provision on the buy stays a cost here: the pair still settles at the game and one side's gain is charged
        const provisions = buys.reduce((s, f) => s + (f.settlementProvisionCents ?? 0), 0);
        realizedCents = saleProceedsCents - cashPaidCents - provisions - toHolderDueCents + fromHolderDueCents;
        if (first.venue === "prophetx") inexact("the pair settles at the game: the settlement fee is provided for on both sides and charged on one, so the result is understated by the other");
        if (first.venue === "prophetx" || first.venue === "novig") notes.push("the sale is an offsetting buy; its proceeds land when the pair settles at the game, not at the close");
      } else {
        state = "unresolved";
        unresolvedReason =
          sells.length === 0
            ? "the holder left early and no real sale of the hedge is on the trail; the venue still holds it"
            : `the holder left early and ${(boughtUnitsMilli - soldUnitsMilli) / 1000} of ${boughtUnitsMilli / 1000} units were not sold for real; the venue still holds them`;
      }
    } else if (p.status === "void") {
      state = "unresolved";
      unresolvedReason = "the lock was voided with no official result; what the hedge paid at the venue is not on the record";
    } else if (sells.length > 0) {
      state = "unresolved";
      unresolvedReason = "a real sale is on the trail and the lock is still open on its ledger";
    }
    const coverage: RealLock["coverage"] = boughtUnitsMilli === hedgeUnitsMilli ? "exact" : boughtUnitsMilli < hedgeUnitsMilli ? "under" : "over";
    if (coverage === "under" && buys.length > 0) notes.push(`${boughtUnitsMilli / 1000} of the ${hedgeUnitsMilli / 1000} units quoted were bought for real`);

    const lock: RealLock = {
      key,
      ticker: p.ticker,
      holder,
      generation: p.generation ?? 1,
      lockedAt: p.at,
      league: p.league,
      sideName: p.sideName,
      contracts: p.contracts,
      status: p.status,
      state,
      unresolvedReason,
      venue: first.venue,
      via: first.via,
      fills: own.map((f) => f.receiptId),
      hedgeUnitsMilli,
      boughtUnitsMilli,
      soldUnitsMilli,
      heldUnitsMilli,
      coverage,
      cashPaidCents,
      feesCents: own.reduce((s, f) => s + (f.feesCents ?? 0), 0),
      feesKnown,
      saleProceedsCents,
      endedAt,
      endedDay: endedAt ? dayOf(endedAt) : null,
      result: p.result ?? null,
      payoutCents,
      holderLegs,
      toHolderDueCents,
      toHolderPaidCents: sumLegs("holder", "paidCents"),
      fromHolderDueCents,
      fromHolderPaidCents: sumLegs("writer", "paidCents"),
      realizedCents,
      costAtRiskCents: state === "open" || state === "unresolved" ? cashPaidCents : 0,
      exact,
      cashSettled: holderLegs.every((l) => l.outstandingCents === 0),
      notes,
    };
    locks.push(lock);
    cashOf.set(key, p.cash ?? []);
  }
  locks.sort((a, b) => a.lockedAt.localeCompare(b.lockedAt));

  const unattached = fills.filter((f) => f.lockKey === null);
  const realized = locks.filter((l) => l.realizedCents !== null);
  const buyFills = fills.filter((f) => f.action === "buy");
  const sellFills = fills.filter((f) => f.action === "sell");
  const byVenue = rollUp(fills, locks, cashOf, () => "all");
  const totals: RealizedTotals = {
    realFills: fills.length,
    realLocks: locks.length,
    open: locks.filter((l) => l.state === "open").length,
    settled: locks.filter((l) => l.state === "settled").length,
    closed: locks.filter((l) => l.state === "closed").length,
    unresolved: locks.filter((l) => l.state === "unresolved").length,
    unattachedFills: unattached.length,
    boughtUnitsMilli: buyFills.reduce((s, f) => s + f.unitsMilli, 0),
    cashPaidCents: buyFills.reduce((s, f) => s + f.cashPaidCents, 0),
    feesCents: fills.reduce((s, f) => s + (f.feesCents ?? 0), 0),
    fillsWithoutFee: fills.filter((f) => f.feesCents === null).length,
    soldUnitsMilli: sellFills.reduce((s, f) => s + f.unitsMilli, 0),
    saleProceedsCents: sellFills.reduce((s, f) => s + f.costCents, 0),
    payoutCents: realized.reduce((s, l) => s + l.payoutCents, 0),
    paidToHolderCents: byVenue.reduce((s, r) => s + r.paidToHolderCents, 0),
    collectedFromHolderCents: byVenue.reduce((s, r) => s + r.collectedFromHolderCents, 0),
    toHolderOutstandingCents: locks.reduce((s, l) => s + l.holderLegs.filter((x) => x.to === "holder").reduce((t, x) => t + x.outstandingCents, 0), 0),
    fromHolderOutstandingCents: locks.reduce((s, l) => s + l.holderLegs.filter((x) => x.to === "writer").reduce((t, x) => t + x.outstandingCents, 0), 0),
    realizedCents: realized.reduce((s, l) => s + (l.realizedCents ?? 0), 0),
    openCostCents: locks.filter((l) => l.state === "open").reduce((s, l) => s + l.costAtRiskCents, 0),
    unresolvedCostCents: locks.filter((l) => l.state === "unresolved").reduce((s, l) => s + l.costAtRiskCents, 0),
    unattachedCostCents: unattached.filter((f) => f.action === "buy").reduce((s, f) => s + f.cashPaidCents, 0),
    exact: realized.every((l) => l.exact),
    cashSettled: realized.every((l) => l.cashSettled),
  };

  return {
    rule: REAL_FILL_RULE,
    fills,
    notCounted,
    locks,
    unattached,
    byDay: rollUp(fills, locks, cashOf, dayOf),
    byMonth: rollUp(fills, locks, cashOf, monthOf),
    byVenue,
    totals,
    memberSales,
  };
}

/** Milli units as an exact decimal string ("12.500"), no float in between. */
export function unitsDecimal(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}

export const REALIZED_MONTHLY_CSV_COLUMNS = [
  "month",
  "venue",
  "via",
  "real_fills",
  "contracts_bought",
  "cash_paid_cents",
  "fees_cents",
  "fills_without_fee",
  "contracts_sold",
  "sale_proceeds_cents",
  "locks_ended",
  "payouts_cents",
  "paid_to_holders_cents",
  "collected_from_holders_cents",
  "realized_cents",
  "locks_not_exact",
] as const;

/**
 * The accounting export: one row per venue per UTC month, whole cents, contracts to the
 * thousandth. Fills are in the month they were sent; payouts and the realized result are in the
 * month the lock ended (the result is the lock's whole life, its cost included, so a month's
 * `realized_cents` is not that month's cash in less cash out); holder payments are in the month
 * of their cash line. `month` names one month ("2026-11") to cut the export to it.
 */
export function realizedMonthlyCsv(book: RealizedBook, month?: string): string {
  const rows = book.byMonth.filter((r) => !month || r.period === month);
  const lines = [REALIZED_MONTHLY_CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.period,
        r.venue,
        r.via,
        r.fills,
        unitsDecimal(r.boughtUnitsMilli),
        r.cashPaidCents,
        r.feesCents,
        r.fillsWithoutFee,
        unitsDecimal(r.soldUnitsMilli),
        r.saleProceedsCents,
        r.locksEnded,
        r.payoutCents,
        r.paidToHolderCents,
        r.collectedFromHolderCents,
        r.realizedCents,
        r.inexactLocks,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** What the public record page may say about the real part of the book. No venue, no holder, no ticker. */
export interface PublicRealSummary {
  realLocks: number;
  realFills: number;
  settled: number;
  leftEarly: number;
  open: number;
  /** locks whose hedge the record cannot value (left early with no real sale, voided) */
  unresolved: number;
  /** cash paid for real fills, fees in */
  paidForFillsCents: number;
  /** payments to and from holders that the cash lines record */
  paidToHoldersCents: number;
  collectedFromHoldersCents: number;
  /** our result on the settled and closed real locks; null while a figure in it is not complete on the record */
  realizedCents: number | null;
  /** why the result is not shown, when it is not */
  realizedWithheld: string | null;
}

/**
 * The public figures. The result is published only when it is complete on the record: at least
 * one real lock has ended, every figure in it is the venue's own read, and every payment between
 * us and the holders on those locks is recorded. Otherwise it stays on the operator's view.
 */
export function publicRealSummary(book: RealizedBook): PublicRealSummary | null {
  const t = book.totals;
  if (t.realFills === 0) return null;
  const ended = t.settled + t.closed;
  const withheld =
    ended === 0
      ? "no real lock has settled yet"
      : !t.exact
        ? "a figure in it is not yet the venue's own number"
        : !t.cashSettled
          ? "a payment on a settled lock is not yet on the record"
          : null;
  return {
    realLocks: t.realLocks,
    realFills: t.realFills,
    settled: t.settled,
    leftEarly: t.closed,
    open: t.open,
    unresolved: t.unresolved,
    paidForFillsCents: t.cashPaidCents,
    paidToHoldersCents: t.paidToHolderCents,
    collectedFromHoldersCents: t.collectedFromHolderCents,
    realizedCents: withheld ? null : t.realizedCents,
    realizedWithheld: withheld,
  };
}
