/**
 * HEDGE EXECUTOR — how the writer's hedge leg gets filled, separated from how
 * it gets priced.
 *
 * The pricer walks the visible book and quotes the holder off that walk. That
 * is the right way to PRICE (it is what anyone can verify against the venue),
 * but it is the expensive way to FILL: every level walked past the best ask is
 * money the holder's credit paid for. An RFQ asks the venue's market makers for
 * one price for the whole size, off-book; when a maker answers at or inside
 * the walk, the hedge costs less than was quoted and the difference is kept.
 *
 * Three strategies behind one interface:
 *   book  — take the visible book at the walked terms (what the quote assumed)
 *   rfq   — request a quote for the whole size; accept only if the all-in cost
 *           is at or under the book walk; otherwise fall back to the book
 *   live  — place a real order on the venue, capped at the walked worst price,
 *           behind rails (liveHedge.ts); anything the rails or the venue refuse
 *           falls back to the simulated book so the shadow's record continues
 *
 * The RFQ path never makes the hedge worse than quoted: the book walk is the
 * ceiling, and a quote above it is declined. Every step, on every path, lands
 * in a receipt so the trail explains each fill.
 *
 * Units: prices in integer MILLI dollars (1000 = $1) on both venues so the
 * comparison is one integer compare; Kalshi cents are scaled x10 exactly.
 * Costs in integer cents, rounded up (against the writer, never under-funded).
 *
 * Nothing here holds credentials. Venue clients are injected; without one, the
 * only strategy that can run is the simulated book fill, which is what the
 * shadow records.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HedgeLeg } from "./types";

export type HedgeVenue = "kalshi" | "polymarket" | "prophetx" | "novig";
export type HedgeStrategy = "book" | "rfq" | "live";
export type HedgeAction = "buy" | "sell";
export const actionOf = (intent: Pick<HedgeIntent, "action">): HedgeAction => intent.action ?? "buy";

/**
 * What the hedge needs to buy, and the book walk it was quoted against. A SELL intent (an early
 * close selling the hedge back) is the same shape read the other way: `book` holds the bids walked
 * (best = the highest), `costCents` is the proceeds expected, and the order will not sell under
 * the walked worst bid. `action` absent means buy, as every intent was before the sell rail.
 */
export interface HedgeIntent {
  action?: HedgeAction;
  venue: HedgeVenue;
  /** Kalshi market ticker, Polymarket CLOB token id, ProphetX strike id, or Novig outcome id */
  instrument: string;
  /**
   * ProphetX and Novig: the holder's own side's strike (outcome) on the same market. Neither venue
   * takes a sell order; a SELL intent there buys this instead, which offsets the hedge share for
   * share and settles the pair at the game (prophetxOrders.ts, novigOrders.ts).
   */
  offsetInstrument?: string;
  /** Novig only: the market both outcomes belong to (the order names the outcome; the trail names the market) */
  marketId?: string;
  /**
   * The key the live allowlist (EVENT_HEDGE_LIVE_TICKERS) is checked against when the instrument
   * is not a Kalshi ticker: the game's Kalshi ticker, which is how the operator arms a game.
   */
  armKey?: string;
  /** display name of what is bought ("No", or the opposing outcome) */
  outcome: string;
  /** 1000 = 1 contract / 1 share */
  unitsMilli: number;
  /** the visible book at quote time, milli dollars */
  book: {
    bestPriceMilli: number;
    avgPriceMilli: number;
    worstPriceMilli: number;
    costCents: number;
  };
  /** an RFQ fill is accepted only when its all-in cost is at or under this; defaults to the book cost */
  maxCostCents: number;
}

/**
 * The intent that sells a Kalshi hedge back into its No bids (an early close). Prices in cents as
 * the bid walk gives them (earlyClose.walkKalshiBids); `costCents` is the gross proceeds expected.
 */
export function sellIntentForKalshi(args: { ticker: string; unitsMilli: number; bestPriceCents: number; avgPriceCents: number; worstPriceCents: number; grossCents: number }): HedgeIntent {
  return {
    action: "sell",
    venue: "kalshi",
    instrument: args.ticker,
    outcome: "No",
    unitsMilli: args.unitsMilli,
    book: { bestPriceMilli: args.bestPriceCents * 10, avgPriceMilli: args.avgPriceCents * 10, worstPriceMilli: args.worstPriceCents * 10, costCents: args.grossCents },
    maxCostCents: args.grossCents,
  };
}

/**
 * The intent that unwinds a ProphetX hedge (an early close): a buy of the holder's side's strike
 * at or under 1 - the walked worst bid on the hedge strike, which offsets the hedge share for
 * share. Prices in milli as the bid walk gives them (earlyClose.walkPmBids); `costCents` is the
 * gross proceeds-equivalent expected, realised at the game rather than today.
 */
export function sellIntentForProphetX(args: { strikeId: string; offsetStrikeId: string; armKey?: string; unitsMilli: number; bestPriceMilli: number; avgPriceMilli: number; worstPriceMilli: number; grossCents: number }): HedgeIntent {
  return {
    action: "sell",
    venue: "prophetx",
    instrument: args.strikeId,
    offsetInstrument: args.offsetStrikeId,
    ...(args.armKey ? { armKey: args.armKey } : {}),
    outcome: "the opposing strike",
    unitsMilli: args.unitsMilli,
    book: { bestPriceMilli: args.bestPriceMilli, avgPriceMilli: args.avgPriceMilli, worstPriceMilli: args.worstPriceMilli, costCents: args.grossCents },
    maxCostCents: args.grossCents,
  };
}

/**
 * The intent that unwinds a Novig hedge (an early close): a buy of the holder's own outcome at or
 * under 1 - the walked worst bid on the hedge outcome, which offsets the hedge share for share and
 * settles the pair at the game. Prices in milli as the bid walk gives them; `costCents` is the
 * gross proceeds-equivalent expected, realised at the game rather than today.
 */
export function sellIntentForNovig(args: { marketId: string; outcomeId: string; offsetOutcomeId: string; armKey?: string; unitsMilli: number; bestPriceMilli: number; avgPriceMilli: number; worstPriceMilli: number; grossCents: number }): HedgeIntent {
  return {
    action: "sell",
    venue: "novig",
    instrument: args.outcomeId,
    offsetInstrument: args.offsetOutcomeId,
    marketId: args.marketId,
    ...(args.armKey ? { armKey: args.armKey } : {}),
    outcome: "the holder's own outcome",
    unitsMilli: args.unitsMilli,
    book: { bestPriceMilli: args.bestPriceMilli, avgPriceMilli: args.avgPriceMilli, worstPriceMilli: args.worstPriceMilli, costCents: args.grossCents },
    maxCostCents: args.grossCents,
  };
}

/** Turn a priced hedge leg into an intent. `bestPriceMilli` is the top of the walked book. `armKey` is the game's Kalshi ticker for a leg on another venue. */
export function intentFromHedge(hedge: HedgeLeg, bestPriceMilli: number, armKey?: string): HedgeIntent {
  if (hedge.venue === "kalshi") {
    return {
      venue: "kalshi",
      instrument: hedge.ticker,
      outcome: hedge.outcome,
      unitsMilli: hedge.contractsMilli,
      book: {
        bestPriceMilli,
        avgPriceMilli: hedge.avgPriceCents * 10,
        worstPriceMilli: hedge.worstPriceCents * 10,
        costCents: hedge.costCents,
      },
      maxCostCents: hedge.costCents,
    };
  }
  if (hedge.venue === "prophetx") {
    return {
      venue: "prophetx",
      instrument: hedge.strikeId,
      ...(hedge.offsetStrikeId ? { offsetInstrument: hedge.offsetStrikeId } : {}),
      ...(armKey ? { armKey } : {}),
      outcome: hedge.outcome,
      unitsMilli: hedge.sharesMilli,
      book: {
        bestPriceMilli,
        avgPriceMilli: hedge.avgPriceMilli,
        worstPriceMilli: hedge.worstPriceMilli,
        costCents: hedge.costCents,
      },
      maxCostCents: hedge.costCents,
    };
  }
  if (hedge.venue === "novig") {
    return {
      venue: "novig",
      instrument: hedge.outcomeId,
      offsetInstrument: hedge.offsetOutcomeId,
      marketId: hedge.marketId,
      ...(armKey ? { armKey } : {}),
      outcome: hedge.outcome,
      unitsMilli: hedge.sharesMilli,
      book: {
        bestPriceMilli,
        avgPriceMilli: hedge.avgPriceMilli,
        worstPriceMilli: hedge.worstPriceMilli,
        costCents: hedge.costCents,
      },
      maxCostCents: hedge.costCents,
    };
  }
  return {
    venue: "polymarket",
    instrument: hedge.tokenId,
    ...(armKey ? { armKey } : {}),
    outcome: hedge.outcome,
    unitsMilli: hedge.sharesMilli,
    book: {
      bestPriceMilli,
      avgPriceMilli: hedge.avgPriceMilli,
      worstPriceMilli: hedge.worstPriceMilli,
      costCents: hedge.costCents,
    },
    maxCostCents: hedge.costCents,
  };
}

/** units (milli) x price (milli) = micro dollars; to cents rounded UP. */
export function costCentsAt(unitsMilli: number, priceMilli: number): number {
  const micro = unitsMilli * priceMilli;
  return Math.ceil(micro / 10_000);
}

/**
 * What walking the book cost over a one-price fill at the top: the money an
 * RFQ can win back. Zero when the whole size sat at the best level.
 */
export function bookWalkPenaltyCents(intent: HedgeIntent): number {
  // on a sale the walk gave up proceeds against a one-price fill at the top bid
  if (actionOf(intent) === "sell") return Math.max(0, costCentsAt(intent.unitsMilli, intent.book.bestPriceMilli) - intent.book.costCents);
  return Math.max(0, intent.book.costCents - costCentsAt(intent.unitsMilli, intent.book.bestPriceMilli));
}

export interface HedgeFill {
  strategy: HedgeStrategy;
  venue: HedgeVenue;
  instrument: string;
  unitsMilli: number;
  /** average all-in price paid (received, on a sale), milli dollars */
  avgPriceMilli: number;
  /** cents that moved: paid on a buy, net proceeds on a sale */
  costCents: number;
  /** cents kept versus the book walk the holder was quoted against; never negative on an accepted fill */
  vsBookCents: number;
  /** true when no order reached a venue (shadow, or a book fill with no order hook) */
  simulated: boolean;
  ids: { rfqId?: string; quoteId?: string; orderId?: string; venueOrderId?: string };
  /**
   * How the order reached the venue: our own key on the venue ("direct"), or the aggregator's
   * execution pod holding the venue account ("aggregator"). Absent on a simulated fill. On the
   * holder's receipt as the path the other side took; the operator's trail keeps the name.
   */
  via?: HedgeVia;
}

export type HedgeVia = "direct" | "aggregator";

export type HedgeAttempt =
  | {
      strategy: "rfq";
      step: "request" | "quote" | "accept" | "cancel";
      ok: boolean;
      at: string;
      detail: string;
      rfqId?: string;
      quoteId?: string;
      priceMilli?: number;
      costCents?: number;
    }
  | { strategy: "book"; step: "fill"; ok: boolean; at: string; detail: string; costCents?: number }
  | {
      strategy: "live";
      /** rails: the pre-trade checks; dry_run: the order built and held; order: the order sent to the venue */
      step: "rails" | "dry_run" | "order";
      ok: boolean;
      at: string;
      detail: string;
      /** which rail refused, when one did */
      rail?: string;
      orderId?: string;
      /** units the order asked for (sent), or filled (ok order) */
      unitsMilli?: number;
      costCents?: number;
    };

export type HedgeOutcome = "filled_rfq" | "filled_book" | "filled_live" | "unfilled";

/** The trail for one hedge: every step tried, in order, and what came of it. */
export interface HedgeReceipt {
  /** sha256 over (venue, instrument, units, at) — stable id for the trail */
  id: string;
  at: string;
  /** the shadow ticker or position this hedge belongs to */
  ref: string;
  intent: HedgeIntent;
  attempts: HedgeAttempt[];
  fill: HedgeFill | null;
  outcome: HedgeOutcome;
  /** why the RFQ path was not the fill, when it was tried */
  fallbackReason: string | null;
  /** what a one-price fill at the top of book would have saved over the walk */
  bookWalkPenaltyCents: number;
}

export interface HedgeExecutor {
  readonly strategy: HedgeStrategy;
  execute(intent: HedgeIntent, ref: string): Promise<HedgeReceipt>;
}

export interface ExecutorClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const REAL_CLOCK: ExecutorClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function receiptId(intent: HedgeIntent, at: string): string {
  return createHash("sha256")
    .update(`${intent.venue}|${intent.instrument}|${intent.unitsMilli}|${at}`)
    .digest("hex")
    .slice(0, 16);
}

/** Placing the walked order on the venue. Absent in the shadow; the fill is then simulated at the walk. */
export type BookOrderHook = (intent: HedgeIntent) => Promise<{ orderId: string; avgPriceMilli: number; costCents: number }>;

/**
 * Book strategy: fill at the walk the quote assumed. Without an order hook it
 * is a simulated fill at exactly the quoted terms, which is what the shadow
 * has always recorded; with one it places the order and records the venue's
 * numbers.
 */
export class BookHedgeExecutor implements HedgeExecutor {
  readonly strategy = "book" as const;
  constructor(
    private readonly place: BookOrderHook | null = null,
    private readonly clock: ExecutorClock = REAL_CLOCK,
  ) {}

  async execute(intent: HedgeIntent, ref: string): Promise<HedgeReceipt> {
    const at = this.clock.now().toISOString();
    const base = {
      id: receiptId(intent, at),
      at,
      ref,
      intent,
      bookWalkPenaltyCents: bookWalkPenaltyCents(intent),
    };
    const attempts: HedgeAttempt[] = [];
    const fill = await this.fillBook(intent, attempts);
    return {
      ...base,
      attempts,
      fill,
      outcome: fill ? "filled_book" : "unfilled",
      fallbackReason: null,
    };
  }

  /** Shared with the RFQ executor's fallback so both paths record the same shape. */
  async fillBook(intent: HedgeIntent, attempts: HedgeAttempt[]): Promise<HedgeFill | null> {
    const at = this.clock.now().toISOString();
    if (!this.place) {
      attempts.push({
        strategy: "book",
        step: "fill",
        ok: true,
        at,
        detail: "simulated at the walked book; no order placed",
        costCents: intent.book.costCents,
      });
      return {
        strategy: "book",
        venue: intent.venue,
        instrument: intent.instrument,
        unitsMilli: intent.unitsMilli,
        avgPriceMilli: intent.book.avgPriceMilli,
        costCents: intent.book.costCents,
        vsBookCents: 0,
        simulated: true,
        ids: {},
      };
    }
    try {
      const r = await this.place(intent);
      attempts.push({
        strategy: "book",
        step: "fill",
        ok: true,
        at,
        detail: `order ${r.orderId} filled`,
        costCents: r.costCents,
      });
      return {
        strategy: "book",
        venue: intent.venue,
        instrument: intent.instrument,
        unitsMilli: intent.unitsMilli,
        avgPriceMilli: r.avgPriceMilli,
        costCents: r.costCents,
        vsBookCents: actionOf(intent) === "sell" ? r.costCents - intent.book.costCents : intent.book.costCents - r.costCents,
        simulated: false,
        ids: { orderId: r.orderId },
        via: "direct",
      };
    } catch (err) {
      attempts.push({ strategy: "book", step: "fill", ok: false, at, detail: errText(err) });
      return null;
    }
  }
}

/** One maker's answer, normalized: the price WE pay per unit for the side we are buying, and how much they will do. */
export interface RfqQuoteView {
  quoteId: string;
  priceMilli: number;
  unitsMilli: number;
  raw?: unknown;
}

/**
 * A venue's RFQ surface, reduced to the four calls the executor needs.
 * Implementations own auth and wire shapes; they never decide whether to fill.
 */
export interface RfqClient {
  readonly venue: HedgeVenue;
  /** false when the client can read quotes but cannot accept them (no signer / no credentials) */
  canExecute(): boolean;
  request(intent: HedgeIntent): Promise<{ rfqId: string }>;
  /** the best open quote for the side we buy, or null when none has arrived */
  bestQuote(rfqId: string, intent: HedgeIntent): Promise<RfqQuoteView | null>;
  accept(rfqId: string, quote: RfqQuoteView, intent: HedgeIntent): Promise<{ orderId?: string }>;
  cancel(rfqId: string): Promise<void>;
}

export interface RfqExecutorOptions {
  /** how long to wait for makers before falling back */
  waitMs: number;
  pollMs: number;
}

export const DEFAULT_RFQ_OPTIONS: RfqExecutorOptions = { waitMs: 4_000, pollMs: 500 };

/**
 * RFQ strategy with a book fallback. Accepts a quote only when it covers the
 * whole size at an all-in cost at or under the book walk; anything else, and
 * any error or timeout, cancels the request and fills at the book.
 */
export class RfqHedgeExecutor implements HedgeExecutor {
  readonly strategy = "rfq" as const;
  private readonly book: BookHedgeExecutor;
  constructor(
    private readonly clients: Partial<Record<HedgeVenue, RfqClient>>,
    bookHook: BookOrderHook | null = null,
    private readonly opts: RfqExecutorOptions = DEFAULT_RFQ_OPTIONS,
    private readonly clock: ExecutorClock = REAL_CLOCK,
  ) {
    this.book = new BookHedgeExecutor(bookHook, clock);
  }

  async execute(intent: HedgeIntent, ref: string): Promise<HedgeReceipt> {
    const at = this.clock.now().toISOString();
    const attempts: HedgeAttempt[] = [];
    const base = {
      id: receiptId(intent, at),
      at,
      ref,
      intent,
      bookWalkPenaltyCents: bookWalkPenaltyCents(intent),
    };
    // the RFQ surface asks makers for the side we buy; a sale goes straight to the book
    const rfq = actionOf(intent) === "sell" ? { fill: null, reason: "a sale is not put out for quotes; sold into the book" } : await this.tryRfq(intent, attempts);
    if (rfq.fill) {
      return { ...base, attempts, fill: rfq.fill, outcome: "filled_rfq", fallbackReason: null };
    }
    const fill = await this.book.fillBook(intent, attempts);
    return {
      ...base,
      attempts,
      fill,
      outcome: fill ? "filled_book" : "unfilled",
      fallbackReason: rfq.reason,
    };
  }

  private async tryRfq(
    intent: HedgeIntent,
    attempts: HedgeAttempt[],
  ): Promise<{ fill: HedgeFill | null; reason: string }> {
    const client = this.clients[intent.venue];
    if (!client) return { fill: null, reason: `no RFQ client for ${intent.venue}` };
    if (!client.canExecute()) return { fill: null, reason: `${intent.venue} RFQ client cannot accept quotes (no signer)` };

    let rfqId: string;
    try {
      rfqId = (await client.request(intent)).rfqId;
      attempts.push({
        strategy: "rfq",
        step: "request",
        ok: true,
        at: this.clock.now().toISOString(),
        detail: `requested ${intent.unitsMilli / 1000} ${intent.outcome} on ${intent.venue}`,
        rfqId,
      });
    } catch (err) {
      attempts.push({ strategy: "rfq", step: "request", ok: false, at: this.clock.now().toISOString(), detail: errText(err) });
      return { fill: null, reason: `request failed: ${errText(err)}` };
    }

    const deadline = this.clock.now().getTime() + this.opts.waitMs;
    let best: RfqQuoteView | null = null;
    let lastReject: string | null = null;
    while (this.clock.now().getTime() <= deadline) {
      let q: RfqQuoteView | null;
      try {
        q = await client.bestQuote(rfqId, intent);
      } catch (err) {
        attempts.push({ strategy: "rfq", step: "quote", ok: false, at: this.clock.now().toISOString(), detail: errText(err), rfqId });
        await this.cancelQuiet(client, rfqId, attempts);
        return { fill: null, reason: `quote poll failed: ${errText(err)}` };
      }
      if (q) {
        const cost = costCentsAt(intent.unitsMilli, q.priceMilli);
        if (q.unitsMilli < intent.unitsMilli) {
          lastReject = `quote ${q.quoteId} covers ${q.unitsMilli / 1000} of ${intent.unitsMilli / 1000}`;
        } else if (cost > intent.maxCostCents) {
          lastReject = `quote ${q.quoteId} at ${q.priceMilli} milli costs ${cost}c, book walk ${intent.maxCostCents}c`;
        } else {
          best = q;
          attempts.push({
            strategy: "rfq",
            step: "quote",
            ok: true,
            at: this.clock.now().toISOString(),
            detail: `quote ${q.quoteId} for the full size at ${q.priceMilli} milli, ${cost}c vs ${intent.book.costCents}c walked`,
            rfqId,
            quoteId: q.quoteId,
            priceMilli: q.priceMilli,
            costCents: cost,
          });
          break;
        }
      }
      await this.clock.sleep(this.opts.pollMs);
    }
    if (!best) {
      const reason = lastReject ?? `no quote within ${this.opts.waitMs}ms`;
      attempts.push({ strategy: "rfq", step: "quote", ok: false, at: this.clock.now().toISOString(), detail: reason, rfqId });
      await this.cancelQuiet(client, rfqId, attempts);
      return { fill: null, reason };
    }

    try {
      const r = await client.accept(rfqId, best, intent);
      const cost = costCentsAt(intent.unitsMilli, best.priceMilli);
      attempts.push({
        strategy: "rfq",
        step: "accept",
        ok: true,
        at: this.clock.now().toISOString(),
        detail: r.orderId ? `accepted; order ${r.orderId}` : "accepted",
        rfqId,
        quoteId: best.quoteId,
        priceMilli: best.priceMilli,
        costCents: cost,
      });
      return {
        fill: {
          strategy: "rfq",
          venue: intent.venue,
          instrument: intent.instrument,
          unitsMilli: intent.unitsMilli,
          avgPriceMilli: best.priceMilli,
          costCents: cost,
          vsBookCents: intent.book.costCents - cost,
          simulated: false,
          ids: { rfqId, quoteId: best.quoteId, ...(r.orderId ? { orderId: r.orderId } : {}) },
          via: "direct",
        },
        reason: "",
      };
    } catch (err) {
      attempts.push({
        strategy: "rfq",
        step: "accept",
        ok: false,
        at: this.clock.now().toISOString(),
        detail: errText(err),
        rfqId,
        quoteId: best.quoteId,
      });
      await this.cancelQuiet(client, rfqId, attempts);
      return { fill: null, reason: `accept failed: ${errText(err)}` };
    }
  }

  private async cancelQuiet(client: RfqClient, rfqId: string, attempts: HedgeAttempt[]): Promise<void> {
    try {
      await client.cancel(rfqId);
      attempts.push({ strategy: "rfq", step: "cancel", ok: true, at: this.clock.now().toISOString(), detail: "request withdrawn", rfqId });
    } catch (err) {
      attempts.push({ strategy: "rfq", step: "cancel", ok: false, at: this.clock.now().toISOString(), detail: errText(err), rfqId });
    }
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Receipt trail: append-only JSONL, one line per hedge, same discipline as the
// shadow ledger. Never edited; summarized by replay.
// ---------------------------------------------------------------------------

export function appendHedgeReceipt(path: string, receipt: HedgeReceipt): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8");
}

export function loadHedgeReceipts(path: string): HedgeReceipt[] {
  if (!existsSync(path)) return [];
  const out: HedgeReceipt[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HedgeReceipt;
      if (r && typeof r.id === "string" && r.intent && Array.isArray(r.attempts)) out.push(r);
    } catch {
      // a torn line is skipped, never repaired
    }
  }
  return out;
}

export interface HedgeReceiptSummary {
  receipts: number;
  byOutcome: Record<HedgeOutcome, number>;
  byVenue: Record<HedgeVenue, number>;
  /** cents kept on RFQ fills versus the book walk */
  rfqSavedCents: number;
  /** what one-price fills at the top of book would have saved across every hedge */
  bookWalkPenaltyCents: number;
  /** hedge cost as booked, cents */
  costCents: number;
  simulated: number;
  fallbackReasons: Record<string, number>;
  /** the live path: what the rails held, what was built and not sent, what reached the venue */
  live: {
    /** hedges a rail refused (then simulated) */
    refused: number;
    byRail: Record<string, number>;
    /** orders built under dry run and not sent */
    dryRun: number;
    /** orders that reached the venue */
    sent: number;
    /** sent orders that filled, in full or part */
    filled: number;
    partial: number;
    /** units sent to the venue, milli */
    sentUnitsMilli: number;
    /** all-in cents paid on live fills */
    costCents: number;
  };
}

export function summarizeHedgeReceipts(receipts: HedgeReceipt[]): HedgeReceiptSummary {
  const s: HedgeReceiptSummary = {
    receipts: receipts.length,
    byOutcome: { filled_rfq: 0, filled_book: 0, filled_live: 0, unfilled: 0 },
    byVenue: { kalshi: 0, polymarket: 0, prophetx: 0, novig: 0 },
    rfqSavedCents: 0,
    bookWalkPenaltyCents: 0,
    costCents: 0,
    simulated: 0,
    fallbackReasons: {},
    live: { refused: 0, byRail: {}, dryRun: 0, sent: 0, filled: 0, partial: 0, sentUnitsMilli: 0, costCents: 0 },
  };
  for (const r of receipts) {
    s.byOutcome[r.outcome] = (s.byOutcome[r.outcome] ?? 0) + 1;
    s.byVenue[r.intent.venue] = (s.byVenue[r.intent.venue] ?? 0) + 1;
    s.bookWalkPenaltyCents += r.bookWalkPenaltyCents ?? 0;
    if (r.fill) {
      s.costCents += r.fill.costCents;
      if (r.fill.simulated) s.simulated += 1;
      if (r.outcome === "filled_rfq") s.rfqSavedCents += r.fill.vsBookCents;
    }
    for (const a of r.attempts) {
      if (a.strategy !== "live") continue;
      if (a.step === "rails" && !a.ok) {
        s.live.refused += 1;
        const rail = a.rail ?? "unknown";
        s.live.byRail[rail] = (s.live.byRail[rail] ?? 0) + 1;
      } else if (a.step === "dry_run") {
        s.live.dryRun += 1;
      } else if (a.step === "order") {
        s.live.sent += 1;
        s.live.sentUnitsMilli += r.intent.unitsMilli;
      }
    }
    if (r.outcome === "filled_live" && r.fill) {
      s.live.filled += 1;
      s.live.costCents += r.fill.costCents;
      if (r.fill.unitsMilli < r.intent.unitsMilli) s.live.partial += 1;
    }
    if (r.fallbackReason) {
      // group by the reason's head so one summary line covers a family of quotes
      const key = r.fallbackReason.split(":")[0].replace(/quote \S+ /, "quote ").trim();
      s.fallbackReasons[key] = (s.fallbackReasons[key] ?? 0) + 1;
    }
  }
  return s;
}
