/**
 * HEDGE FIRST: on a real-money lock the hedge is bought before anything is promised.
 *
 * The shadow writes the open record and then fills the hedge at the walked book, on paper; a
 * hedge that "fails" there costs nothing. With a real order the same sequence is a promise made
 * before the thing that backs it exists: a venue that rejects the order, or a book that moved
 * between the read and the send, leaves a floor written to the holder and nothing bought behind
 * it. In play that is the normal case, not the rare one. So when the order would really be sent,
 * the sequence is turned around:
 *
 *   0. ROOM      the exposure caps (exposureCaps.ts) are read from the ledgers at this moment: what
 *                is open on the game, resting on the hedge venue and open for the holder. A lock
 *                that would pass any cap is refused here with one `cap_refused` line on the trail;
 *                no pending line, no order. The check and the pending line below run with nothing
 *                awaited between them, so the next lock to arrive reads this one as already open.
 *   1. PENDING   one line on the pending trail (this module), before any order leaves: the ref,
 *                the terms quoted, the order as it will be sent. A process that dies after this
 *                line and before the next leaves a line with no resolution, which the service
 *                reports on boot and on its status page, with the id the venue order carries.
 *   2. SEND      the hedge order through the live executor: a limit at the walked worst price,
 *                immediate or cancel (Kalshi) or fill or kill (ProphetX, Novig). Never resting.
 *                A lock's own order is all or none where the venue takes that word (Kalshi's
 *                fill_or_kill, set by `allOrNone` on the intent), so a part fill is rare.
 *   3. JUDGE     (judgeHedge) the receipt says one of four things:
 *                  filled       the whole size, by a real order     -> the lock is written now
 *                  not filled   the venue read the order to its end
 *                               with nothing matched, or a rail
 *                               held it before it left              -> nothing is written; the
 *                                                                     holder is told and may tap again
 *                  partial      an immediate-or-cancel order
 *                               matched part of the size            -> nothing is written; the
 *                                                                     part bought is a STRAY hedge
 *                                                                     on the trail and the operator
 *                                                                     is paged to sell it
 *                  unconfirmed  the order went out and the answer
 *                               was an error                        -> nothing is written; the
 *                                                                     operator is paged to look for
 *                                                                     the order on the venue by its id
 *   4. RESOLVE   one line closing the pending one with what happened.
 *
 * WHEN IT APPLIES (lockMode). Only when the order would truly leave: live strategy, the send
 * flag on, the kill switch off, a live client for the hedge venue, the game armed. Everything
 * else is the shadow's paper path, unchanged: the record is written and the fill is simulated at
 * the walk, which is what the public record has always been.
 *
 * THE IDENTITY, per party, for each ending (N contracts, floor F, cap C, credit K, take T, hedge
 * of H units bought for X all in; the quote set K = (100 - C) x N - Xq - T at the walked cost Xq):
 *
 *   filled       holder: as quoted (F x N + K or C x N + K). Writer: (100 - C) x N - X - K in
 *                either outcome, which is T + (Xq - X): the take, plus or minus what the fill
 *                cost against the walk. X is capped by the limit price, so the writer's shortfall
 *                is at most (worst price - average price) x H; the realized book carries it.
 *                Venue: its fee on the order, inside X.
 *   not filled   holder: unchanged, still holds the position naked, owes and is owed nothing.
 *                Writer: zero. Venue: nothing.
 *   unconfirmed  holder: unchanged. Writer: zero if the venue took nothing; if it did, the
 *                partial line below with H' up to H. Until the operator looks, unknown, so paged.
 *   partial      holder: unchanged, as above; no lock exists. Writer: holds H' < H units of the
 *                other side bought for X', unhedged against nothing: a directional position worth
 *                at most X' to lose and 100 x H' - X' to gain, bounded by the per-order cap, until
 *                it is sold. This is the one ending that leaves risk, which is why it pages. A
 *                partial is not turned into a smaller lock: the record keeps one lock per market,
 *                and a position shown as locked while part of it rides would misstate it.
 *
 * Nothing here calls a venue or holds a credential. The pending trail is append-only JSONL beside
 * the ledgers; a torn line is skipped, never repaired.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { actionOf, type HedgeIntent, type HedgeReceipt, type HedgeVenue } from "./hedgeExecutor";
import { armKeyOf, tickerArmed, type LiveHedgeRails } from "./liveHedge";

/** The live rails as the service shows them (hedgeExecutorFromEnv.LiveHedgeView), the fields this decision reads. */
export type LiveRailsView = Pick<LiveHedgeRails, "killSwitch" | "dryRun" | "allowlist" | "anyTicker"> & { venues: HedgeVenue[] };

export type LockMode = { real: true } | { real: false; why: "not_live" | "kill_switch" | "dry_run" | "no_client" | "not_armed" };

/** Would this hedge really be sent? Only then is the lock a real-money lock and the hedge bought first. */
export function lockMode(live: LiveRailsView | null, intent: Pick<HedgeIntent, "venue" | "instrument" | "armKey">): LockMode {
  if (!live) return { real: false, why: "not_live" };
  if (live.killSwitch) return { real: false, why: "kill_switch" };
  if (live.dryRun) return { real: false, why: "dry_run" };
  if (!live.venues.includes(intent.venue)) return { real: false, why: "no_client" };
  if (!tickerArmed(live, armKeyOf(intent))) return { real: false, why: "not_armed" };
  return { real: true };
}

export type HedgeVerdict =
  | { kind: "filled"; unitsMilli: number; costCents: number; orderId: string | null }
  | { kind: "partial"; unitsMilli: number; wantedMilli: number; costCents: number; orderId: string | null }
  /** the venue read the order to its end and nothing matched, or a rail held it before it left: nothing was bought */
  | { kind: "not_filled"; code: "hedge_not_filled" | "hedge_held_by_rail"; detail: string }
  /** the order went out and the answer is an error: the venue may or may not hold a fill; the operator checks */
  | { kind: "unconfirmed"; detail: string };

/** The venue clients' own words for an order read to its final state with nothing matched (kalshiOrders, aggregatorOrders, prophetxOrders, novigOrders). */
const CLEAN_MISS = /\bwith nothing (filled|sold)\b/;

/**
 * What a hedge receipt means for a real-money lock. A real fill of the whole size is the only
 * thing that writes a lock; a simulated fill never counts here, whatever its numbers say. An
 * order that errored is "unconfirmed" unless the venue's final state was read and showed no fill:
 * an HTTP error after the venue took the order is still an order.
 */
export function judgeHedge(intent: Pick<HedgeIntent, "unitsMilli">, receipt: HedgeReceipt | null): HedgeVerdict {
  if (!receipt) return { kind: "unconfirmed", detail: "the executor threw before a receipt was written" };
  const fill = receipt.fill;
  if (receipt.outcome === "filled_live" && fill && !fill.simulated) {
    const orderId = fill.ids.orderId ?? null;
    if (fill.unitsMilli >= intent.unitsMilli) return { kind: "filled", unitsMilli: fill.unitsMilli, costCents: fill.costCents, orderId };
    if (fill.unitsMilli > 0) return { kind: "partial", unitsMilli: fill.unitsMilli, wantedMilli: intent.unitsMilli, costCents: fill.costCents, orderId };
  }
  const order = [...receipt.attempts].reverse().find((a) => a.strategy === "live" && a.step === "order");
  if (order) {
    if (!order.ok && CLEAN_MISS.test(order.detail)) return { kind: "not_filled", code: "hedge_not_filled", detail: order.detail };
    return { kind: "unconfirmed", detail: order.detail };
  }
  const rail = receipt.attempts.find((a) => a.strategy === "live" && a.step === "rails" && !a.ok);
  if (rail) return { kind: "not_filled", code: "hedge_held_by_rail", detail: rail.detail };
  // no order step and no rail refusal: the order was built and held (dry run) or the executor is not the live one
  return { kind: "not_filled", code: "hedge_held_by_rail", detail: receipt.fallbackReason ?? "no order was sent" };
}

/** What the holder is told when nothing was locked. No venue, no order detail: those are the operator's. */
export function refusalWords(v: Exclude<HedgeVerdict, { kind: "filled" }>): { code: string; message: string } {
  if (v.kind === "partial") {
    return { code: "hedge_partial", message: "Only part of the other side filled before the price moved. Nothing was locked. Try again." };
  }
  if (v.kind === "unconfirmed") {
    return { code: "hedge_unconfirmed", message: "The other side could not be confirmed. Nothing was locked. Try again in a moment." };
  }
  if (v.code === "hedge_held_by_rail") {
    return { code: "hedge_held", message: "This size cannot be locked right now. Nothing was locked." };
  }
  return { code: "hedge_not_filled", message: "The price moved before the other side filled. Nothing was locked. Try again." };
}

// ---------------------------------------------------------------------------
// the pending trail
// ---------------------------------------------------------------------------

export interface PendingTerms {
  contracts: number;
  tier: string;
  floorCents: number;
  capCents: number;
  creditCents: number;
}

/** How a lock attempt ended. "stray", "unconfirmed" and "ledger_failed" leave (or may leave) hedge on a venue with no lock behind it. */
export type PendingResolution = "locked" | "refused" | "stray" | "unconfirmed" | "ledger_failed";

export type PendingRecord =
  | {
      type: "pending";
      id: string;
      at: string;
      /** the hedge ref the receipt trail uses: ticker, or ticker@holder */
      ref: string;
      ticker: string;
      holder?: string;
      terms: PendingTerms;
      order: PendingOrder;
      /**
       * What the exposure gate set aside for this attempt (exposureCaps.ts): while the line has no
       * resolution it counts against the caps at these amounts, so a second lock arriving while this
       * one's order is out is measured against both. Absent on lines before 2026-11-10 (derived from
       * the terms and the order then).
       */
      reserve?: PendingReserve;
    }
  | {
      type: "resolved";
      id: string;
      at: string;
      outcome: PendingResolution;
      detail: string;
      /** what a real order bought, when one did: the whole hedge (locked, ledger_failed) or the part of it (stray) */
      fill?: { unitsMilli: number; costCents: number; orderId: string | null; receiptId: string };
      /** the receipt on the hedge trail, when one was written; its id is the venue order's client id after "atticus-" */
      receiptId?: string;
    }
  | {
      /** the operator's word that an open or stray line was looked at on the venue and dealt with; the line stays, the page stops */
      type: "cleared";
      id: string;
      at: string;
      note: string;
    }
  | {
      /**
       * An exposure cap had no room (exposureCaps.ts): a real-money lock, or the operator's resend of
       * a hedge, refused before any order was built. One line, complete in itself: nothing left, so
       * nothing to resolve or clear. `caps` names every cap the attempt would have passed and by how much.
       */
      type: "cap_refused";
      id: string;
      at: string;
      ref: string;
      ticker: string;
      holder?: string;
      source: "lock" | "resend";
      terms: PendingTerms;
      order: PendingOrder;
      caps: CapRefusalLine[];
      detail: string;
    };

export type PendingOrder = { venue: HedgeVenue; instrument: string; action: "buy" | "sell"; unitsMilli: number; limitMilli: number; maxCostCents: number };

/** The amounts an attempt holds against the exposure caps while it is in flight: the game it is on, and cents per game, per venue, per holder. */
export interface PendingReserve {
  game: string;
  gameCents: number;
  venueCents: number;
  holderCents: number;
}

/** One cap an attempt would have passed: which, for which game, venue or holder, and the sums in cents. */
export interface CapRefusalLine {
  cap: "game" | "venue" | "holder";
  key: string;
  openCents: number;
  addCents: number;
  capCents: number;
  overByCents: number;
}

export const pendingId = (ref: string, atIso: string): string => `${ref}#${atIso}`;

export function pendingRecordFor(ref: string, ticker: string, holder: string | null, atIso: string, terms: PendingTerms, intent: HedgeIntent): Extract<PendingRecord, { type: "pending" }> {
  return {
    type: "pending",
    id: pendingId(ref, atIso),
    at: atIso,
    ref,
    ticker,
    ...(holder ? { holder } : {}),
    terms,
    order: { venue: intent.venue, instrument: intent.instrument, action: actionOf(intent), unitsMilli: intent.unitsMilli, limitMilli: intent.book.worstPriceMilli, maxCostCents: intent.maxCostCents },
  };
}

export function appendPending(path: string, record: PendingRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function loadPending(path: string): PendingRecord[] {
  if (!existsSync(path)) return [];
  const out: PendingRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PendingRecord;
      if (r && (r.type === "pending" || r.type === "resolved" || r.type === "cleared" || r.type === "cap_refused") && typeof r.id === "string") out.push(r);
    } catch {
      // a torn line is skipped, never repaired
    }
  }
  return out;
}

export interface PendingSummary {
  /** pending lines with no resolution: an order may have left with nothing written after it */
  unresolved: Array<Extract<PendingRecord, { type: "pending" }>>;
  /** hedge bought (or possibly bought) with no lock behind it: the operator's to find and sell */
  strays: Array<{ pending: Extract<PendingRecord, { type: "pending" }>; resolved: Extract<PendingRecord, { type: "resolved" }> }>;
  counts: Record<PendingResolution, number>;
}

/** The trail read back: what is still open, what was bought and left over, how each lock attempt ended. */
export function summarizePending(records: PendingRecord[]): PendingSummary {
  const pendings = new Map<string, Extract<PendingRecord, { type: "pending" }>>();
  const resolved = new Map<string, Extract<PendingRecord, { type: "resolved" }>>();
  const cleared = new Set<string>();
  for (const r of records) {
    if (r.type === "pending") pendings.set(r.id, r);
    else if (r.type === "resolved") resolved.set(r.id, r);
    else if (r.type === "cleared") cleared.add(r.id);
  }
  const counts: Record<PendingResolution, number> = { locked: 0, refused: 0, stray: 0, unconfirmed: 0, ledger_failed: 0 };
  const unresolved: PendingSummary["unresolved"] = [];
  const strays: PendingSummary["strays"] = [];
  for (const [id, p] of pendings) {
    const r = resolved.get(id);
    if (!r) {
      if (!cleared.has(id)) unresolved.push(p);
      continue;
    }
    counts[r.outcome] += 1;
    if ((r.outcome === "stray" || r.outcome === "unconfirmed" || r.outcome === "ledger_failed") && !cleared.has(id)) strays.push({ pending: p, resolved: r });
  }
  return { unresolved, strays, counts };
}

/** Whether `id` names a line the operator may clear: unresolved, or ended with hedge possibly left on a venue. */
export function clearable(records: PendingRecord[], id: string): boolean {
  const s = summarizePending(records);
  return s.unresolved.some((p) => p.id === id) || s.strays.some((x) => x.pending.id === id);
}

/** The cap refusals on the trail: how many, and the latest. */
export function capRefusals(records: PendingRecord[]): { count: number; last: Extract<PendingRecord, { type: "cap_refused" }> | null } {
  const lines = records.filter((r): r is Extract<PendingRecord, { type: "cap_refused" }> => r.type === "cap_refused");
  return { count: lines.length, last: lines.at(-1) ?? null };
}
